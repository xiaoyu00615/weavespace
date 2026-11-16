/**
 * 真实改名 / 移动：请求形状校验 + Host 侧编排（UX-02C-02）。
 *
 * 职责单一：**不做 HTTP、不直接碰磁盘、不渲染菜单**。与 `create-entry.ts` 并列，
 * 但多了一层本阶段最高优先级的门禁——编辑会话保护。
 *
 * 安全顺序（不可交换）：
 *  1. 请求形状（零 IO）：浏览器只给 `projectId + 项目内相对路径 + 单段名称`；
 *  2. 项目级写授权（源与目标两条路径都授权）；
 *  3. `runtime.withStructureChange`：按项目置**准入独占**标记 → 排空在途 G-DISK 操作；
 *  4. 屏障内重新枚举 DocumentService 内部会话：源路径（目录则含全部后代）
 *     有活动 View / dirty / SAVING / OUTCOME_UNKNOWN / CONFLICT / FAILED 一律拒绝；
 *  5. `runtime.withDiskOp` → StorageProvider 的排他 `moveEntry`；
 *  6. 结果原样保留 `MOVED / REJECTED / UNKNOWN`，副作用已发生但无法确认时只读核对，
 *     **绝不自动重发、绝不自行回滚或删除**。
 *
 * 为什么第 3 步不可省：只做"检查无会话"再直接执行磁盘变更，检查与执行之间
 * 新来的 `/api/open` 会创建绑定到旧路径的 View。屏障让所有新准入在
 * `assertUsable` / `isAcceptingViews` 处被拒，已在途的由 `waitForZeroOps` 排空。
 * 它**不**复用、也不放宽项目撤销状态机（不进入 QUIESCING/REMOVING）。
 *
 * Shell 自述的"已关闭/无草稿"一概不采信：Host 只认 DocumentService 内部状态。
 * Shell 另有本地标签/草稿阻断（第二道门，防 Host 重启后的状态脱节）。
 */
import { ERROR_CODES, type ErrorCode } from '../../../packages/contracts/errors.ts';
import type { PermissionService } from '../../../packages/permission/index.ts';
import type { SessionGuardView } from '../../../packages/document/index.ts';
import type { StructureChangeCapability } from './project-runtime.ts';
import {
  entryRelativePath,
  parentDirOfEntry,
  validateEntryName,
  validateParentDir,
  type CreateEntryKind,
  type MoveEntryResult,
  type StorageProvider,
} from '../../../packages/storage/index.ts';

export type StructureKind = 'rename' | 'move';

/** 结构变更请求禁止携带的字段：任何一条都意味着客户端在自述路径或授权。 */
export const STRUCTURE_FORBIDDEN_FIELDS = [
  'path',
  'absolutePath',
  'absolute',
  'sourceAbsolutePath',
  'targetAbsolutePath',
  'rootDir',
  'root',
  'rootToken',
  'canonicalRoot',
  'providerId',
  'grantSource',
  'actorId',
  'content',
  'text',
  'expectedVersion',
  'sourceRoot',
  'targetRoot',
] as const;

export interface StructureChangeRequest {
  readonly projectId: string;
  readonly kind: StructureKind;
  readonly sourcePath: string;
  readonly targetParentDir: string;
  readonly targetName: string;
}

export type ParseStructureResult =
  | { ok: true; request: StructureChangeRequest }
  | { ok: false; errorCode: ErrorCode; message: string };

export type StructureBlockerCode =
  | 'ACTIVE_VIEWS'
  | 'DIRTY'
  | 'SAVING'
  | 'OUTCOME_UNKNOWN'
  | 'CONFLICT';

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * 解析结构变更请求。所有形状判定在**零 IO**的前提下完成。
 *
 * - `rename` 的目标父目录由 Host 从 `sourcePath` 派生，**不接受**客户端指定，
 *   因此改名端点不可能被当作移动端点用；
 * - `move` 必须显式给出目标父目录（空串 = 项目根）；
 * - 两者都只接受单段 `name`，不接受完整路径。
 */
export function parseStructureBody(
  body: Record<string, unknown>,
  kind: StructureKind,
): ParseStructureResult {
  for (const field of STRUCTURE_FORBIDDEN_FIELDS) {
    if (field in body) {
      return {
        ok: false,
        errorCode: 'ERR_COMMAND_INVALID',
        message: `不接受客户端提供的 ${field}`,
      };
    }
  }
  const rawProjectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  if (rawProjectId === '' || !PROJECT_ID_RE.test(rawProjectId)) {
    return { ok: false, errorCode: 'ERR_COMMAND_INVALID', message: '缺少或非法的 projectId' };
  }
  const source = validateParentDir(body.sourcePath);
  if (!source.ok || source.value === '') {
    return {
      ok: false,
      errorCode: 'ERR_ENTRY_SOURCE_INVALID',
      message: '缺少或非法的源相对路径',
    };
  }
  const name = validateEntryName(body.name);
  if (!name.ok) return { ok: false, errorCode: name.errorCode, message: name.message };

  let targetParentDir: string;
  if (kind === 'rename') {
    // 目标目录完全由服务端派生：浏览器无法借改名端点偷偷换目录
    if ('targetParentDir' in body && body.targetParentDir !== parentDirOfEntry(source.value)) {
      return {
        ok: false,
        errorCode: 'ERR_COMMAND_INVALID',
        message: '改名不允许改变所在目录',
      };
    }
    targetParentDir = parentDirOfEntry(source.value);
  } else {
    const dir = validateParentDir(body.targetParentDir);
    if (!dir.ok) return { ok: false, errorCode: dir.errorCode, message: dir.message };
    targetParentDir = dir.value;
  }

  return {
    ok: true,
    request: {
      projectId: rawProjectId,
      kind,
      sourcePath: source.value,
      targetParentDir,
      targetName: name.value,
    },
  };
}

/** 由 Host 内存会话快照算出阻断原因；空数组表示可以放行。 */
export function structureSessionBlockers(
  views: readonly SessionGuardView[],
): StructureBlockerCode[] {
  const out: StructureBlockerCode[] = [];
  const push = (code: StructureBlockerCode): void => {
    if (!out.includes(code)) out.push(code);
  };
  for (const view of views) {
    // 任何活动 View（哪怕内容干净）都绑定着旧路径，首版一律阻断
    if (view.activeViews > 0) push('ACTIVE_VIEWS');
    if (view.dirty) push('DIRTY');
    if (view.state === 'SAVING') push('SAVING');
    if (view.state === 'OUTCOME_UNKNOWN') push('OUTCOME_UNKNOWN');
    if (view.state === 'CONFLICT' || view.state === 'FAILED') push('CONFLICT');
  }
  return out;
}

export interface StructureChangeDeps {
  readonly request: StructureChangeRequest;
  readonly provider: StorageProvider;
  /** 授权维度：托管 Multi 为 `local:<projectId>`，由 Host 的项目句柄给出。 */
  readonly providerId: string;
  readonly permission: PermissionService;
  readonly actorId: string;
  /** 只读枚举会话（DocumentService 内部状态，不采信 Shell）。 */
  sessionsUnder(projectId: string, pathPrefix: string): readonly SessionGuardView[];
  /**
   * 结构变更专用磁盘通道：runtime.withStructureDiskOp（UX-02C-02-R1.1）。
   *
   * 必须带上 `withStructureChange` 交出的能力凭据；没有凭据（或凭据已过期）
   * 一律拒绝，因此它不能被用来绕过屏障。
   */
  withStructureDiskOp<T>(
    capability: StructureChangeCapability,
    fn: () => Promise<T>,
  ): Promise<T>;
  /** 结构变更准入独占 + 排空在途磁盘操作：runtime.withStructureChange。 */
  withStructureChange<T>(fn: (capability: StructureChangeCapability) => Promise<T>): Promise<T>;
}

export type ManagedStructureOutcome =
  | {
      status: 'APPLIED';
      sourcePath: string;
      targetPath: string;
      targetParentDir: string;
      targetName: string;
      kind: CreateEntryKind;
      contentSha256: string | null;
    }
  | { status: 'REJECTED'; errorCode: ErrorCode; blockedBy?: StructureBlockerCode[] }
  | { status: 'UNKNOWN'; errorCode: 'ERR_OUTCOME_UNKNOWN' };

function asKnownCode(raw: unknown): ErrorCode | undefined {
  return typeof raw === 'string' && raw in ERROR_CODES ? (raw as ErrorCode) : undefined;
}

function reject(errorCode: ErrorCode): ManagedStructureOutcome {
  return { status: 'REJECTED', errorCode };
}

/**
 * 执行一次结构变更。授权在屏障之外、会话检查在屏障之内、磁盘操作在 G-DISK 之内。
 * 屏障窗口内任何异常都不会留下"半开门"状态（finally 清除）。
 */
export async function runManagedStructureChange(
  deps: StructureChangeDeps,
): Promise<ManagedStructureOutcome> {
  const { request, provider, providerId, permission, actorId } = deps;
  if (typeof provider.moveEntry !== 'function') {
    return reject('ERR_COMMAND_UNSUPPORTED');
  }
  const targetPath = entryRelativePath(request.targetParentDir, request.targetName);

  // 项目级写授权：源与目标两条路径都要允许写，缺一不可
  for (const resourcePath of [request.sourcePath, targetPath]) {
    const decision = permission.authorize({ actorId, action: 'write', resourcePath, providerId });
    if (!decision.allowed) {
      return reject(asKnownCode(decision.errorCode) ?? 'ERR_PERMISSION_DENIED');
    }
  }

  try {
    return await deps.withStructureChange(async (capability) => {
      // 屏障内重新问一次 Host 自己的会话表：目录按路径前缀覆盖全部后代文件
      const sessions = deps.sessionsUnder(request.projectId, request.sourcePath);
      const blockedBy = structureSessionBlockers(sessions);
      if (blockedBy.length > 0) {
        return {
          status: 'REJECTED' as const,
          errorCode: 'ERR_STRUCTURE_SESSION_BUSY' as const,
          blockedBy,
        };
      }

      let result: MoveEntryResult;
      try {
        result = await deps.withStructureDiskOp(capability, () =>
          provider.moveEntry!(request.sourcePath, request.targetParentDir, request.targetName),
        );
      } catch (err) {
        return reject(asKnownCode((err as { errorCode?: unknown }).errorCode) ?? 'ERR_STORAGE_IO');
      }
      if (result.status === 'UNKNOWN') {
        return { status: 'UNKNOWN' as const, errorCode: 'ERR_OUTCOME_UNKNOWN' as const };
      }
      if (result.status === 'REJECTED') {
        return reject(asKnownCode(result.errorCode) ?? 'ERR_STORAGE_IO');
      }
      return {
        status: 'APPLIED' as const,
        sourcePath: result.sourcePath,
        targetPath: result.targetPath,
        targetParentDir: request.targetParentDir,
        targetName: request.targetName,
        kind: result.kind,
        contentSha256: result.contentSha256,
      };
    });
  } catch (err) {
    // 屏障准入失败（ERR_PROJECT_BUSY / QUIESCING / UNAVAILABLE / 排空超时）：
    // 此刻零磁盘副作用，按明确拒绝返回，绝不落到 UNKNOWN。
    return reject(asKnownCode((err as { errorCode?: unknown }).errorCode) ?? 'ERR_STORAGE_IO');
  }
}
