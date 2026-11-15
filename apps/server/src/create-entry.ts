/**
 * 真实条目创建：请求形状校验 + Host 侧编排（UX-02C-01）。
 *
 * 职责单一：**不做 HTTP、不直接碰磁盘、不渲染菜单**。
 * - 请求体只接受 `projectId / parentDir / name`，其余一律不接受；
 * - 所有路径都在 StorageProvider 的固定 `RootBoundary` 内解析，浏览器无法提交
 *   绝对路径 / rootDir / rootToken / providerId；
 * - 项目级写授权与 G-DISK 门禁在这里串起来，由调用方注入（server.ts 负责接线）；
 * - 结果原样保留 `CREATED / REJECTED / UNKNOWN`：副作用已发生但无法确认时
 *   **不**改写成失败或成功，客户端据此只读核对、绝不自动重发。
 */
import { ERROR_CODES, type ErrorCode } from '../../../packages/contracts/errors.ts';
import type { PermissionService } from '../../../packages/permission/index.ts';
import {
  entryRelativePath,
  validateEntryName,
  validateParentDir,
  type CreateEntryKind,
  type CreateEntryResult,
  type StorageProvider,
} from '../../../packages/storage/index.ts';

/** 创建种类由 StorageProvider 定义；这里转出，让 HTTP 层只依赖本模块。 */
export type { CreateEntryKind } from '../../../packages/storage/index.ts';

/** 创建请求禁止携带的字段：任何一条都意味着客户端在自述路径或授权。 */
export const CREATE_FORBIDDEN_FIELDS = [
  'path',
  'absolutePath',
  'absolute',
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
] as const;

export interface CreateEntryRequest {
  readonly projectId: string;
  readonly parentDir: string;
  readonly name: string;
  readonly kind: CreateEntryKind;
}

export type ParseCreateEntryResult =
  | { ok: true; request: CreateEntryRequest }
  | { ok: false; errorCode: ErrorCode; message: string };

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * 解析创建请求。所有形状判定都在**零 IO**的前提下完成，且错误文案不含任何
 * 本机路径（PUBLIC_ERROR_MESSAGES 由调用方按错误码查表）。
 */
export function parseCreateEntryBody(
  body: Record<string, unknown>,
  kind: CreateEntryKind,
): ParseCreateEntryResult {
  for (const field of CREATE_FORBIDDEN_FIELDS) {
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
  const dir = validateParentDir(body.parentDir);
  if (!dir.ok) return { ok: false, errorCode: dir.errorCode, message: dir.message };
  const name = validateEntryName(body.name);
  if (!name.ok) return { ok: false, errorCode: name.errorCode, message: name.message };
  return {
    ok: true,
    request: {
      projectId: rawProjectId,
      parentDir: dir.value,
      name: name.value,
      kind,
    },
  };
}

export interface CreateEntryDeps {
  readonly request: CreateEntryRequest;
  readonly provider: StorageProvider;
  /** 授权维度：托管 Multi 为 `local:<projectId>`，由 Host 的项目句柄给出。 */
  readonly providerId: string;
  readonly permission: PermissionService;
  readonly actorId: string;
  /** G-DISK 门禁：托管 Multi 的 `runtime.withDiskOp`（准入 + 计数 + 屏障）。 */
  withDiskOp<T>(fn: () => Promise<T>): Promise<T>;
}

export type ManagedCreateOutcome =
  | { status: 'APPLIED'; relativePath: string; kind: CreateEntryKind }
  | { status: 'REJECTED'; errorCode: ErrorCode }
  | { status: 'UNKNOWN'; errorCode: 'ERR_OUTCOME_UNKNOWN' };

function asKnownCode(raw: unknown): ErrorCode | undefined {
  return typeof raw === 'string' && raw in ERROR_CODES ? (raw as ErrorCode) : undefined;
}

/**
 * 执行创建：写授权 → G-DISK 门禁 → Provider 的排他创建。
 *
 * 顺序即安全顺序：授权判定在 `withDiskOp` **之前**，因此一个没有写权限的请求
 * 连磁盘操作计数都不会进入；`withDiskOp` 负责 QUIESCING/REMOVING 期间拒绝准入。
 */
export async function createManagedEntry(deps: CreateEntryDeps): Promise<ManagedCreateOutcome> {
  const { request, provider, providerId, permission, actorId } = deps;
  if (typeof provider.createEntry !== 'function') {
    return { status: 'REJECTED', errorCode: 'ERR_COMMAND_UNSUPPORTED' };
  }

  const relativePath = entryRelativePath(request.parentDir, request.name);
  const decision = permission.authorize({
    actorId,
    action: 'write',
    resourcePath: relativePath,
    providerId,
  });
  if (!decision.allowed) {
    return {
      status: 'REJECTED',
      errorCode: asKnownCode(decision.errorCode) ?? 'ERR_PERMISSION_DENIED',
    };
  }

  let result: CreateEntryResult;
  try {
    result = await deps.withDiskOp(() =>
      provider.createEntry!(request.parentDir, request.name, request.kind),
    );
  } catch (err) {
    return {
      status: 'REJECTED',
      errorCode: asKnownCode((err as { errorCode?: unknown }).errorCode) ?? 'ERR_STORAGE_IO',
    };
  }
  if (result.status === 'UNKNOWN') return { status: 'UNKNOWN', errorCode: 'ERR_OUTCOME_UNKNOWN' };
  if (result.status === 'REJECTED') {
    return {
      status: 'REJECTED',
      errorCode: asKnownCode(result.errorCode) ?? 'ERR_STORAGE_IO',
    };
  }
  return { status: 'APPLIED', relativePath: result.relativePath, kind: result.kind };
}
