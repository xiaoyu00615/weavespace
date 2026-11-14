/**
 * ProjectRuntime（UX-02B-01）：托管模式下项目身份的**唯一**运行期权威。
 *
 * 为什么需要它：静态 `ProjectRegistry` 在构造时一次性读配置、建 Provider、发 grant，
 * 并把 workspaceKey 固化成闭包（`server.ts` 旧实现）。只要项目集合能在运行期变化，
 * 这四样东西就必须由**同一个**对象协调，否则会出现"Registry 说没有、providers 表里还有"
 * 这类互不一致的两套真相。本模块就是那个唯一协调器（ADR-022 §2）。
 *
 * 边界（必须原样保留的既有安全语义）：
 * - 根身份每次访问都重新确认；一旦变化即永久 UNAVAILABLE，**不自动 adopt、不重建根**；
 * - READY 才有 Provider；UNAVAILABLE 一律没有 Provider，因此不存在"缺失即创建"的路径；
 * - 对外 `ProjectSummary` 不含 rootDir / canonicalRoot / rootToken / Provider；
 * - `projectId` 一旦签发（含已撤销）永不复用，避免旧会话/旧快照"碰巧命中"新项目。
 *
 * 本轮**没有**持久化：`ProjectStore` 只有内存实现，撤销跑在 fake 提交点上。
 * 真实的配置 v2、墓碑日志、checksum、备份与崩溃恢复属于 UX-02B-02；因此
 * 默认情况下（`store.durability === 'memory'`）`removeProject` 直接拒绝，
 * 只有显式 `allowEphemeralRevocation: true`（仅测试）才会执行，
 * 生产托管模式不存在能绕过持久化的撤销入口。
 */
import { createHash, randomUUID } from 'node:crypto';
import { ERROR_CODES, type ErrorCode } from '../../../packages/contracts/index.ts';
import type { DocumentService } from '../../../packages/document/index.ts';
import type { PermissionService } from '../../../packages/permission/index.ts';
import { createLocalProvider, type StorageProvider } from '../../../packages/storage/index.ts';
import {
  inspectProjectRoot,
  type ProjectHandle,
  type ProjectSummary,
  type ProjectUnavailableReason,
  type RootInspection,
} from '../../../packages/project-registry/index.ts';

/** 项目在运行期的状态（ADR-023 §3）。 */
export type ProjectLifecycle = 'ACTIVE' | 'QUIESCING' | 'REMOVING' | 'REMOVED' | 'UNAVAILABLE';

/** 持久化条目（只含身份与显示名；不含任何授权令牌的副本）。 */
export interface StoredProject {
  readonly projectId: string;
  readonly name: string;
  readonly rootDir: string;
}

/**
 * 最小持久化端口（UX-02B-01 只有 fake）。
 *
 * 刻意不定义 `commitSeq` / 墓碑 / 备份：把它们塞进端口而不实现，会让"调用顺序对了"
 * 看起来像"持久化安全已经做完"。02B-02 会以同样的顺序接入真实实现。
 */
export interface ProjectStore {
  /**
   * `memory` = 仅本轮测试用；`durable` = 具备提交点语义的持久化（02B-02）。
   * 运行时据此决定是否允许撤销，见 `allowEphemeralRevocation`。
   */
  readonly durability: 'memory' | 'durable';
  load(): readonly StoredProject[];
  commitAdd(entry: StoredProject & { readonly opId: string }): Promise<void>;
  commitRename(input: { projectId: string; name: string; opId: string }): Promise<void>;
  commitRevoke(input: { projectId: string; opId: string }): Promise<void>;
}

export interface ProjectRuntimeDeps {
  actorId: string;
  document: DocumentService;
  permission: PermissionService;
  store: ProjectStore;
  /** 仅测试注入：替换 Provider 构造（默认 `createLocalProvider`）。 */
  providerFactory?: (input: {
    projectId: string;
    providerId: string;
    rootDir: string;
  }) => StorageProvider;
  /** 仅测试注入：替换根探测（默认 `inspectProjectRoot`）。 */
  inspectRoot?: (rootDir: string) => RootInspection;
  /**
   * 允许在 `memory` store 上执行撤销。仅测试可置 true；
   * 生产托管模式必须为 false（否则等于绕过 02B-02 的持久化提交点）。
   */
  allowEphemeralRevocation?: boolean;
  /** 排空在途磁盘操作的等待上限；超时即 abort（零变更）。 */
  quiesceTimeoutMs?: number;
}

export interface RemoveOutcome {
  readonly outcome: 'revoked';
  readonly projectId: string;
  readonly opId: string;
}

export interface RemoveBlocked {
  readonly outcome: 'aborted';
  readonly blockedBy: readonly RemoveBlocker[];
}

export type RemoveBlocker =
  | 'ACTIVE_VIEWS'
  | 'DIRTY'
  | 'SAVING'
  | 'OUTCOME_UNKNOWN'
  | 'CONFLICT'
  | 'IN_FLIGHT_DISK_OPS'
  | 'DRAIN_TIMEOUT';

/** 仅供诊断：不含路径与令牌。 */
export interface RuntimeDiagnostics {
  readonly revision: number;
  readonly mutating: boolean;
  readonly projects: readonly {
    readonly projectId: string;
    readonly state: ProjectLifecycle;
    readonly activeDiskOps: number;
  }[];
}

export interface ProjectRuntime {
  /** 当前项目列表（会顺带复核根身份；不含任何路径/令牌）。 */
  list(): readonly ProjectSummary[];
  /** 项目级 G-DISK 门禁：状态 + 根身份 + 屏障；不通过即抛错。 */
  assertUsable(projectId: string): ProjectHandle;
  /**
   * 把一个 G-DISK 操作纳入计数（屏障要等它结束）。
   * 进入前先判屏障：一旦 QUIESCING 就**不再准入**新操作。
   */
  withDiskOp<T>(projectId: string, fn: () => Promise<T> | T): Promise<T>;
  /** 项目是否仍可继续创建 View（供 open 的晚到校验）。 */
  isAcceptingViews(projectId: string): boolean;
  providerOf(providerId: string): StorageProvider | undefined;
  /** 工作区摘要；项目集合/根身份变化即变化。 */
  workspaceKey(): string | undefined;
  /** 变更代数（与静态 Registry 的 `version()===1` 无关）。 */
  revision(): number;
  stateOf(projectId: string): ProjectLifecycle | 'ABSENT';

  addProject(input: { name: string; rootDir: string }): Promise<ProjectSummary>;
  renameProject(projectId: string, name: string): Promise<ProjectSummary>;
  removeProject(projectId: string): Promise<RemoveOutcome | RemoveBlocked>;

  /** 手动进入/退出屏障（仅用于并发测试与未来的 UI 预检；移除流程内部自会调用）。 */
  beginQuiesce(projectId: string): void;
  endQuiesce(projectId: string): void;

  diagnostics(): RuntimeDiagnostics;
}

const MAX_PROJECT_ID_LENGTH = 32;
const MAX_NAME_LENGTH = 64;
const DEFAULT_QUIESCE_TIMEOUT_MS = 2_000;
const WINDOWS = process.platform === 'win32';

function domainError(errorCode: ErrorCode, message: string, extra?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { errorCode, ...extra });
}

/** Windows 大小写不敏感；其他平台保持敏感，避免把一个真实不同的目录判成重复。 */
function foldForCompare(path: string): string {
  const unified = path.replace(/\\/g, '/');
  return WINDOWS ? unified.toLowerCase() : unified;
}

function isNested(a: string, b: string): boolean {
  const left = foldForCompare(a);
  const right = foldForCompare(b);
  if (left === right) return false;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

interface Entry {
  readonly projectId: string;
  name: string;
  readonly rootDir: string;
  state: ProjectLifecycle;
  reason?: ProjectUnavailableReason;
  handle?: ProjectHandle;
}

export function createProjectRuntime(deps: ProjectRuntimeDeps): ProjectRuntime {
  const inspect = deps.inspectRoot ?? inspectProjectRoot;
  const factory =
    deps.providerFactory ??
    ((input: { providerId: string; rootDir: string }) =>
      createLocalProvider({ rootDir: input.rootDir, providerId: input.providerId }));
  const timeoutMs = deps.quiesceTimeoutMs ?? DEFAULT_QUIESCE_TIMEOUT_MS;

  const entries = new Map<string, Entry>();
  const providers = new Map<string, StorageProvider>();
  /** 已签发过的 id（含已撤销）：永不复用。 */
  const issuedIds = new Set<string>();
  /** 已撤销的记录，仅用于诊断与测试断言（不含路径）。 */
  const removed = new Set<string>();

  let revision = 0;
  let mutating = false;

  // ---- 在途磁盘操作计数（屏障的 drain 对象）----
  const activeOps = new Map<string, number>();
  const zeroWaiters = new Map<string, Array<() => void>>();

  function enterDiskOp(projectId: string): void {
    activeOps.set(projectId, (activeOps.get(projectId) ?? 0) + 1);
  }

  function leaveDiskOp(projectId: string): void {
    const next = (activeOps.get(projectId) ?? 1) - 1;
    if (next > 0) {
      activeOps.set(projectId, next);
      return;
    }
    activeOps.delete(projectId);
    const waiters = zeroWaiters.get(projectId);
    if (waiters) {
      zeroWaiters.delete(projectId);
      for (const resolve of waiters) resolve();
    }
  }

  function waitForZeroOps(projectId: string): Promise<void> {
    if ((activeOps.get(projectId) ?? 0) === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(domainError(ERROR_CODES.ERR_PROJECT_BUSY, '等待在途磁盘操作超时', { blockedBy: 'DRAIN_TIMEOUT' }));
      }, timeoutMs);
      const list = zeroWaiters.get(projectId) ?? [];
      list.push(() => {
        clearTimeout(timer);
        resolve();
      });
      zeroWaiters.set(projectId, list);
    });
  }

  // ---- 条目与根身份 ----

  /** 重新确认根身份；变化即永久降级（与静态 Registry 完全同一条判定）。 */
  function refreshEntry(entry: Entry): void {
    if (entry.state !== 'ACTIVE' && entry.state !== 'QUIESCING' && entry.state !== 'REMOVING') return;
    if (!entry.handle) return;
    const inspection = inspect(entry.rootDir);
    if (inspection.status !== 'READY') {
      entry.state = 'UNAVAILABLE';
      entry.reason = inspection.reason;
      entry.handle = undefined;
      providers.delete(`local:${entry.projectId}`);
      return;
    }
    if (inspection.canonicalRoot !== entry.handle.canonicalRoot) {
      entry.state = 'UNAVAILABLE';
      entry.reason = 'CANONICAL_CHANGED';
      entry.handle = undefined;
      providers.delete(`local:${entry.projectId}`);
      return;
    }
    if (inspection.rootToken !== entry.handle.rootToken) {
      entry.state = 'UNAVAILABLE';
      entry.reason = 'ROOT_TOKEN_CHANGED';
      entry.handle = undefined;
      providers.delete(`local:${entry.projectId}`);
    }
  }

  function unavailableError(projectId: string, reason: ProjectUnavailableReason | undefined): Error {
    return domainError(
      ERROR_CODES.ERR_PROJECT_UNAVAILABLE,
      `项目不可用: ${projectId}${reason ? `（${reason}）` : ''}`,
      { reason },
    );
  }

  function grantProject(projectId: string): void {
    const providerId = `local:${projectId}`;
    deps.permission.grant({ actorId: deps.actorId, action: 'read', scope: '', providerId });
    deps.permission.grant({ actorId: deps.actorId, action: 'write', scope: '', providerId });
  }

  function revokeProject(projectId: string): void {
    const providerId = `local:${projectId}`;
    deps.permission.revoke({ actorId: deps.actorId, action: 'read', scope: '', providerId });
    deps.permission.revoke({ actorId: deps.actorId, action: 'write', scope: '', providerId });
  }

  /** 构造一个 READY 条目；根不可用时返回 UNAVAILABLE 条目且**不建 Provider**。 */
  function buildEntry(input: { projectId: string; name: string; rootDir: string }): Entry {
    const inspection = inspect(input.rootDir);
    if (inspection.status !== 'READY') {
      return {
        projectId: input.projectId,
        name: input.name,
        rootDir: input.rootDir,
        state: 'UNAVAILABLE',
        reason: inspection.reason,
      };
    }
    let provider: StorageProvider;
    try {
      provider = factory({
        projectId: input.projectId,
        providerId: `local:${input.projectId}`,
        rootDir: input.rootDir,
      });
    } catch {
      return {
        projectId: input.projectId,
        name: input.name,
        rootDir: input.rootDir,
        state: 'UNAVAILABLE',
        reason: 'IO_ERROR',
      };
    }
    const handle: ProjectHandle = {
      projectId: input.projectId,
      providerId: `local:${input.projectId}`,
      rootDir: input.rootDir,
      canonicalRoot: inspection.canonicalRoot,
      rootToken: inspection.rootToken,
      provider,
    };
    return { ...input, state: 'ACTIVE', handle };
  }

  // ---- 启动装载（唯一一次读 store）----
  for (const stored of deps.store.load()) {
    issuedIds.add(stored.projectId);
    const entry = buildEntry(stored);
    entries.set(entry.projectId, entry);
    if (entry.state === 'ACTIVE' && entry.handle) {
      providers.set(entry.handle.providerId, entry.handle.provider);
      grantProject(entry.projectId);
    }
  }

  // ---- 身份签发 ----

  function slugify(name: string): string {
    const ascii = name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_PROJECT_ID_LENGTH);
    return ascii === '' ? 'project' : ascii;
  }

  /** 只在 `issuedIds` 之外签发；已撤销的 id 也不复用。 */
  function issueProjectId(name: string): string {
    const base = slugify(name);
    if (!issuedIds.has(base)) return base;
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${base}-${n}`;
      if (!issuedIds.has(candidate)) return candidate;
    }
    // 理论不可达：仍要 fail-closed，不能悄悄复用
    throw domainError(ERROR_CODES.ERR_PROJECT_BUSY, '无法签发新的 projectId');
  }

  function assertName(name: string): string {
    const trimmed = name.trim();
    if (trimmed === '') {
      throw domainError(ERROR_CODES.ERR_COMMAND_INVALID, '项目名不能为空');
    }
    if (trimmed.length > MAX_NAME_LENGTH) {
      throw domainError(ERROR_CODES.ERR_COMMAND_INVALID, '项目名过长');
    }
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
      throw domainError(ERROR_CODES.ERR_COMMAND_INVALID, '项目名包含控制字符');
    }
    return trimmed;
  }

  /** 重复/嵌套判定：只与现存（非 REMOVED）条目比较。 */
  function assertRootAdmissible(canonicalRoot: string, ignoreProjectId?: string): void {
    for (const entry of entries.values()) {
      if (entry.projectId === ignoreProjectId) continue;
      const existing = entry.handle?.canonicalRoot;
      if (!existing) continue;
      if (foldForCompare(existing) === foldForCompare(canonicalRoot)) {
        throw domainError(ERROR_CODES.ERR_PROJECT_DUPLICATE_ROOT, '该目录已作为项目注册');
      }
      if (isNested(existing, canonicalRoot)) {
        throw domainError(ERROR_CODES.ERR_PROJECT_NESTED_ROOT, '项目根不能与已注册项目互相嵌套');
      }
    }
  }

  /**
   * 移除前置条件（ADR-023 §3.2）。全部取自 Host 自身状态：
   * `ProjectSessionStats` 源自 DocumentService 的 sessions/views，不读客户端上报。
   */
  function blockersOf(projectId: string): RemoveBlocker[] {
    const stats = deps.document.projectSessionStats(projectId);
    const blocked: RemoveBlocker[] = [];
    if (stats.activeViews > 0) blocked.push('ACTIVE_VIEWS');
    if (stats.dirty > 0) blocked.push('DIRTY');
    if (stats.saving > 0) blocked.push('SAVING');
    if (stats.unknown > 0) blocked.push('OUTCOME_UNKNOWN');
    if (stats.conflicted > 0) blocked.push('CONFLICT');
    if ((activeOps.get(projectId) ?? 0) > 0) blocked.push('IN_FLIGHT_DISK_OPS');
    return blocked;
  }

  const summaryOf = (entry: Entry): ProjectSummary =>
    Object.freeze({
      projectId: entry.projectId,
      name: entry.name,
      // QUIESCING/REMOVING 对外仍是 READY：屏障是内部串行化，不是"项目坏了"
      status: entry.state === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'READY',
      ...(entry.state === 'UNAVAILABLE' && entry.reason ? { reason: entry.reason } : {}),
    });

  return {
    list() {
      for (const entry of entries.values()) refreshEntry(entry);
      return Object.freeze([...entries.values()].map(summaryOf));
    },

    assertUsable(projectId) {
      const entry = entries.get(projectId);
      if (!entry) {
        throw domainError(ERROR_CODES.ERR_PROJECT_NOT_FOUND, `未注册的项目: ${projectId}`);
      }
      if (entry.state === 'QUIESCING' || entry.state === 'REMOVING') {
        throw domainError(ERROR_CODES.ERR_PROJECT_QUIESCING, '项目正在移除中，磁盘操作被拒绝');
      }
      if (entry.state !== 'ACTIVE' || !entry.handle) {
        throw unavailableError(projectId, entry.reason);
      }
      refreshEntry(entry);
      if (entry.state !== 'ACTIVE' || !entry.handle) {
        throw unavailableError(projectId, entry.reason);
      }
      return entry.handle;
    },

    async withDiskOp(projectId, fn) {
      // 准入判定与计数在同一同步块内完成：不存在"判完到 +1 之间被插队"的窗口
      const entry = entries.get(projectId);
      if (!entry) throw domainError(ERROR_CODES.ERR_PROJECT_NOT_FOUND, `未注册的项目: ${projectId}`);
      if (entry.state === 'QUIESCING' || entry.state === 'REMOVING') {
        throw domainError(ERROR_CODES.ERR_PROJECT_QUIESCING, '项目正在移除中，磁盘操作被拒绝');
      }
      enterDiskOp(projectId);
      try {
        return await fn();
      } finally {
        leaveDiskOp(projectId);
      }
    },

    isAcceptingViews(projectId) {
      const entry = entries.get(projectId);
      return entry !== undefined && entry.state === 'ACTIVE';
    },

    providerOf(providerId) {
      return providers.get(providerId);
    },

    workspaceKey() {
      if (entries.size === 0) return undefined;
      try {
        const lines = [...entries.values()].map((entry) =>
          entry.handle
            ? `multi\u0000${entry.projectId}\u0000${entry.handle.canonicalRoot}\u0000${entry.handle.rootToken}`
            : `multi\u0000${entry.projectId}\u0000unavailable`,
        );
        return createHash('sha256').update(lines.sort().join('\n')).digest('hex');
      } catch {
        return undefined;
      }
    },

    revision: () => revision,

    stateOf(projectId) {
      const entry = entries.get(projectId);
      if (entry) return entry.state;
      return removed.has(projectId) ? 'REMOVED' : 'ABSENT';
    },

    async addProject(input) {
      if (mutating) throw domainError(ERROR_CODES.ERR_PROJECT_BUSY, '已有变更事务在执行');
      const name = assertName(input.name);
      // 根形态不合法（UNC/重解析点/不存在/ino 不可用）在 inspect 里收敛为具体 reason
      const inspection = inspect(input.rootDir);
      if (inspection.status !== 'READY') {
        throw domainError(ERROR_CODES.ERR_PROJECT_CONFIG_INVALID, '目录不能作为项目根', {
          reason: inspection.reason,
        });
      }
      assertRootAdmissible(inspection.canonicalRoot);

      const projectId = issueProjectId(name);
      const opId = `op-${randomUUID()}`;
      mutating = true;
      try {
        // 提交点：先持久化，再让内存生效（添加是"多给一份权限"，必须先有证据）
        await deps.store.commitAdd({ projectId, name, rootDir: inspection.literalRoot, opId });
        const entry = buildEntry({ projectId, name, rootDir: inspection.literalRoot });
        entries.set(projectId, entry);
        issuedIds.add(projectId);
        if (entry.state === 'ACTIVE' && entry.handle) {
          providers.set(entry.handle.providerId, entry.handle.provider);
          grantProject(projectId);
        }
        revision += 1;
        return summaryOf(entry);
      } finally {
        mutating = false;
      }
    },

    async renameProject(projectId, name) {
      if (mutating) throw domainError(ERROR_CODES.ERR_PROJECT_BUSY, '已有变更事务在执行');
      const entry = entries.get(projectId);
      if (!entry) throw domainError(ERROR_CODES.ERR_PROJECT_NOT_FOUND, `未注册的项目: ${projectId}`);
      const next = assertName(name);
      const opId = `op-${randomUUID()}`;
      mutating = true;
      try {
        await deps.store.commitRename({ projectId, name: next, opId });
        entry.name = next;
        revision += 1;
        return summaryOf(entry);
      } finally {
        mutating = false;
      }
    },

    async removeProject(projectId) {
      // 没有真实持久化时不允许撤销：否则"内存删掉 = 撤销完成"会绕过 02B-02 的提交点
      if (deps.store.durability !== 'durable' && deps.allowEphemeralRevocation !== true) {
        throw domainError(
          ERROR_CODES.ERR_COMMAND_UNSUPPORTED,
          '当前 Store 不具备持久化提交点，拒绝执行项目撤销（等待 UX-02B-02）',
        );
      }
      if (mutating) throw domainError(ERROR_CODES.ERR_PROJECT_BUSY, '已有变更事务在执行');
      const entry = entries.get(projectId);
      if (!entry) throw domainError(ERROR_CODES.ERR_PROJECT_NOT_FOUND, `未注册的项目: ${projectId}`);

      mutating = true;
      try {
        // ---- 屏障：先关门，再等在途操作结束 ----
        const previousState = entry.state;
        entry.state = 'QUIESCING';

        let drainFailure: RemoveBlocker | undefined;
        try {
          await waitForZeroOps(projectId);
        } catch (err) {
          drainFailure = (err as { blockedBy?: RemoveBlocker }).blockedBy ?? 'DRAIN_TIMEOUT';
        }
        const blockedBy: RemoveBlocker[] = drainFailure ? [drainFailure] : blockersOf(projectId);

        if (blockedBy.length > 0) {
          // abort：Provider、grants、正文、revision 一律不动；恢复到进入前的状态
          entry.state = previousState === 'QUIESCING' ? 'QUIESCING' : 'ACTIVE';
          return { outcome: 'aborted', blockedBy };
        }

        // ---- 提交点（本轮是 fake；02B-02 换成墓碑 fsync）----
        entry.state = 'REMOVING';
        const opId = `op-${randomUUID()}`;
        await deps.store.commitRevoke({ projectId, opId });

        // ---- 同步提交：立即切断访问权 ----
        entries.delete(projectId);
        removed.add(projectId);
        revokeProject(projectId);
        providers.delete(`local:${projectId}`);
        deps.document.markProjectStale(projectId, 'PROJECT_REMOVED');
        revision += 1;
        return { outcome: 'revoked', projectId, opId };
      } finally {
        mutating = false;
      }
    },

    beginQuiesce(projectId) {
      const entry = entries.get(projectId);
      if (!entry) throw domainError(ERROR_CODES.ERR_PROJECT_NOT_FOUND, `未注册的项目: ${projectId}`);
      if (entry.state === 'ACTIVE') entry.state = 'QUIESCING';
    },

    endQuiesce(projectId) {
      const entry = entries.get(projectId);
      if (entry?.state === 'QUIESCING') entry.state = 'ACTIVE';
    },

    diagnostics() {
      return {
        revision,
        mutating,
        projects: [...entries.values()].map((entry) => ({
          projectId: entry.projectId,
          state: entry.state,
          activeDiskOps: activeOps.get(entry.projectId) ?? 0,
        })),
      };
    },
  };
}
