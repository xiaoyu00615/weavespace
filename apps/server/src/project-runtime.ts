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
 *
 * 提交点失败只承认两种形态（ADR-022 §3.1.1）：**显式确认未写入**才可回滚；
 * 其余（含未声明的异常）一律按"可能已落盘"处理，进入 `REVOKE_UNKNOWN` 并切断磁盘权限。
 * 这不是真实恢复能力——证据核对仍属于 UX-02B-02。
 */
import { createHash, randomUUID } from 'node:crypto';
import { ERROR_CODES, type ErrorCode } from '../../../packages/contracts/index.ts';
import type { DocumentService } from '../../../packages/document/index.ts';
import type { PermissionService } from '../../../packages/permission/index.ts';
import { createLocalProvider, type StorageProvider } from '../../../packages/storage/index.ts';
import type { OpOutcome, StoreLoadState, StoreRevokeReceipt, StoredProjectRecord } from './store/types.ts';
import {
  inspectProjectRoot,
  type ProjectHandle,
  type ProjectSummary,
  type ProjectUnavailableReason,
  type RootInspection,
} from '../../../packages/project-registry/index.ts';

/** 项目在运行期的状态（ADR-023 §3 + ADR-022 §3.1.1）。 */
export type ProjectLifecycle =
  | 'ACTIVE'
  | 'QUIESCING'
  | 'REMOVING'
  /**
   * 撤销提交点的写入结果不确定（ADR-022 §3.1.1）：既不能当"已撤销"提交，
   * 也不能当"未发生"回滚。磁盘权限已切断，条目保留等待持久证据核对（02B-02）。
   */
  | 'REVOKE_UNKNOWN'
  | 'REMOVED'
  | 'UNAVAILABLE';

/**
 * 持久化条目：身份 + 显示名 + 授权时确认的根身份。
 *
 * `canonicalRoot` / `rootToken` 来自配置 v2；加载时必须与当前 inspect 结果比对，
 * 不一致即 UNAVAILABLE（**不 adopt、不改写配置**，ADR-022 §3.2）。
 */
export type StoredProject = StoredProjectRecord;

/**
 * `commit*` 的失败契约（ADR-022 §3.1.1）。
 *
 * **只有**显式声明 `not-committed` 的异常才允许被当作"持久化没有发生"；
 * `unknown` 或**未声明**一律视为"无法排除已落盘"——因为 fsync 报错并不等于没写进去。
 */
export type StoreCommitState = 'not-committed' | 'unknown';

/**
 * 持久化端口（UX-02B-02 起有真实实现 `store/file-store.ts`）。
 *
 * 除提交点外还暴露三件"只有真实 Store 才知道"的事实：
 * - `loadState()`：撤销集合是否可证 → 决定能不能发任何 G-DISK 授权；
 * - `queryOp()`：`opId` 的持久证据（只读磁盘）；
 * - `markDegraded()`：墓碑已生效但配置补写失败。
 * 三者都是可选的，fake Store 缺省视为"完全可信"，因此 UX-02B-01 的既有测试不受影响。
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
  /**
   * 撤销提交点。失败时**必须**尽量带上 `commitState`：
   * - `'not-committed'`：可以断言没有写入（打开失败 / 0 字节写入）；
   * - `'unknown'` 或缺省：无法排除已落盘 → Runtime 按已撤销保守处理。
   *
   * 成功时返回回执：`configPersisted === false` 表示墓碑已生效但配置补写失败
   * （`REVOKED_PENDING_CONFIG`）——项目已不可访问，**不得回滚、不得重新授权**。
   */
  commitRevoke(input: { projectId: string; opId: string }): Promise<void | StoreRevokeReceipt>;
  /** 加载时的完整性与受限状态；缺省视为 `diskTrusted: true`。 */
  loadState?(): StoreLoadState;
  /** `opId` 的最终结果（只读磁盘；证据缺失即 `unknown`）。 */
  queryOp?(opId: string): OpOutcome;
  /**
   * 已签发过的 id（含已撤销）。Runtime 启动时**必须**继承它，
   * 否则重启后会把旧 id 当成"从未签发"而重新分配（P0-02）。
   */
  issuedIds?(): readonly string[];
  markDegraded?(reason: string): void;
  close?(): void;
}

/** fake Store（无 store 元数据）时的默认判定：与 02B-01 的行为完全一致。 */
const TRUSTED_STORE_STATE: StoreLoadState = {
  integrity: 'OK',
  diskTrusted: true,
  mutationsAllowed: true,
  log: 'ok',
  configSource: 'primary',
  commitSeq: 0,
  notes: [],
};

/**
 * 唯一可信的授权来源。
 *
 * 02B-03 的本机选择器才会写出这个值；本轮没有任何生产路径能产生它，
 * 因此"托管模式里出现可读项目"只可能来自测试注入或未来的选择器确认。
 */
export const TRUSTED_GRANT_SOURCE = 'os-dialog';

/** 允许落盘的授权来源；其余一律视为非法配置（不进入可信集合）。 */
const KNOWN_GRANT_SOURCES: readonly string[] = [TRUSTED_GRANT_SOURCE, 'unspecified'];

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
  /**
   * 本次运行期签发的授权来源。
   *
   * 缺省 `'unspecified'`：条目照常登记，但**不发放任何 G-DISK 授权**。
   * 只有本机选择器（02B-03）确认过的 `'os-dialog'` 才会写入可信凭据。
   * 这是防止"内存里加一个项目就等于授权"的最后一道口子。
   */
  grantSource?: string;
}

export interface RemoveOutcome {
  readonly outcome: 'revoked';
  readonly projectId: string;
  readonly opId: string;
  /**
   * 墓碑 + 配置都落盘 = true；墓碑已生效但配置补写失败 = false
   * （`REVOKED_PENDING_CONFIG`：项目已不可访问，重启后按墓碑补齐）。
   * fake Store 不返回回执时按 true 处理。
   */
  readonly configPersisted?: boolean;
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

  /**
   * 添加项目。
   *
   * `grantSource` 只能由 Host 内部的 T3 路径（本机选择器成功结果）逐次给出；
   * 缺省回落到构造期的 `deps.grantSource`（缺省 `unspecified` = 只登记不授权）。
   * 逐次传入而**不是**只靠构造期开关，是为了让"这一次添加确实经过选择器"
   * 成为可断言的调用事实，而不是进程级的一个常量。
   */
  addProject(input: {
    name: string;
    rootDir: string;
    grantSource?: string;
  }): Promise<ProjectSummary>;
  renameProject(projectId: string, name: string): Promise<ProjectSummary>;
  removeProject(projectId: string): Promise<RemoveOutcome | RemoveBlocked>;

  /** 手动进入/退出屏障（仅用于并发测试与未来的 UI 预检；移除流程内部自会调用）。 */
  beginQuiesce(projectId: string): void;
  endQuiesce(projectId: string): void;

  diagnostics(): RuntimeDiagnostics;
}

const MAX_PROJECT_ID_LENGTH = 32;
/**
 * 与 `packages/project-registry/config.ts` 的 `PROJECT_ID_RE` 保持一致：
 * 运行期签发的 id 会被持久化，并在下次启动时用同一条正则重新校验。
 */
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
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
  /**
   * 注册时确认过的根身份。**不可用后仍然保留**：身份占用与身份摘要都不能因为
   * "根暂时读不到"而释放，否则同一目录会被注册成第二个项目（见 `occupancyOf`）。
   */
  canonicalRoot?: string;
  rootToken?: string;
  handle?: ProjectHandle;
}

/**
 * 该项目占用中的根身份。
 *
 * 优先用注册时确认的规范根；启动即不可用的项目没有规范根，退化为配置里的字面根
 * （已 resolve，不含占位符），仍然足以拒绝"同一路径/父目录/子目录"的重复注册。
 */
function occupancyOf(entry: Entry): string | undefined {
  return entry.canonicalRoot ?? entry.rootDir;
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
  /**
   * 重启后先继承持久化的已签发 id（P0-02）。
   *
   * 只从"当前活动项目"重建会让已撤销的 id 看起来从未存在，重启后同名目录
   * 会拿到同一个 id —— 旧会话、旧快照、旧墓碑都可能因此"碰巧命中"新项目。
   * 这里**不猜测**：只认 Store 交出的账本，fake Store 没有该方法时退化为旧行为。
   */
  for (const id of deps.store.issuedIds?.() ?? []) issuedIds.add(id);
  /** 已撤销的记录，仅用于诊断与测试断言（不含路径）。 */
  const removed = new Set<string>();
  /**
   * 内存级拒盘黑名单（ADR-022 §4.4 最危险的一格）。
   *
   * 用于"墓碑已持久化、但运行期 COMMIT 抛错"：此时不能假定授权已经收回，
   * 因此直接把该项目拉黑，任何 G-DISK 一律拒绝，直到进程重启。
   */
  const diskDenied = new Set<string>();

  // ---- 持久化的可信度（真实 Store 才提供；fake 缺省 = 完全可信）----
  let storeState: StoreLoadState = deps.store.loadState?.() ?? TRUSTED_STORE_STATE;

  function refreshStoreState(): StoreLoadState {
    const next = deps.store.loadState?.();
    if (next) storeState = next;
    return storeState;
  }

  /**
   * 变更前必须确认存储仍然可写：`RECOVERY_RESTRICTED` / `DEGRADED` 一律拒绝。
   * 这道门与"项目级"无关，因此放在签发 id / 触碰磁盘之前。
   */
  function assertStoreWritable(): void {
    const current = refreshStoreState();
    if (!current.diskTrusted || !current.mutationsAllowed) {
      throw domainError(
        ERROR_CODES.ERR_STORE_RESTRICTED,
        '存储处于受限状态（撤销集合不可证或需重启），拒绝一切变更',
        { integrity: current.integrity, notes: current.notes },
      );
    }
  }

  /**
   * 全局磁盘门禁（P0-01）：Store 的 `diskTrusted` 一旦为 false，**所有**项目都拒绝。
   *
   * 每次准入都重新读取（而不是只在启动时读一次）：运行期日志被删除/截断/断裂后，
   * 已经发出的 grant 仍然存在，若只靠启动快照就会成为绕过门禁的路径。
   */
  function assertGlobalDiskTrust(): void {
    if (refreshStoreState().diskTrusted) return;
    throw domainError(
      ERROR_CODES.ERR_STORE_RESTRICTED,
      '工作区存储的撤销集合不可证，拒绝全部磁盘访问（草稿仍可读）',
      { integrity: storeState.integrity },
    );
  }

  /**
   * 授权凭据是否完整可信（P0-04）。
   *
   * 只有本机选择器确认过的记录才允许发 G-DISK：`grantSource === 'os-dialog'`，
   * 且 `grantedAt` / `canonicalRoot` / `rootToken` 齐备。缺任何一项都按"未授权"处理，
   * 不允许用"看起来像项目"来替代授权证据（ADR-021 §5）。
   */
  function isTrustedGrant(record: StoredProject): boolean {
    return (
      record.grantSource === TRUSTED_GRANT_SOURCE &&
      typeof record.grantedAt === 'string' &&
      record.grantedAt !== '' &&
      typeof record.canonicalRoot === 'string' &&
      record.canonicalRoot !== '' &&
      typeof record.rootToken === 'string' &&
      record.rootToken !== ''
    );
  }

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
      downgrade(entry, inspection.reason);
      return;
    }
    if (inspection.canonicalRoot !== entry.handle.canonicalRoot) {
      downgrade(entry, 'CANONICAL_CHANGED');
      return;
    }
    if (inspection.rootToken !== entry.handle.rootToken) {
      downgrade(entry, 'ROOT_TOKEN_CHANGED');
    }
  }

  /**
   * 永久降级：释放 Provider，但**保留** `canonicalRoot` / `rootToken`。
   *
   * 保留身份证据是本轮修复的重点：只丢 `handle` 会让一次"根暂时读不到"
   * 顺带释放掉目录占用，于是同一路径可以再注册一个新项目——那等于在项目身份
   * 不确定的时候放开第二个身份。降级后不自动恢复（也不改写原始身份）。
   */
  function downgrade(entry: Entry, reason: ProjectUnavailableReason): void {
    entry.state = 'UNAVAILABLE';
    entry.reason = reason;
    entry.handle = undefined;
    providers.delete(`local:${entry.projectId}`);
  }

  /** 无具体原因的拒盘（配置层面自相矛盾，例如两个项目抢同一个根）。 */
  function denyEntry(entry: Entry): void {
    entry.state = 'UNAVAILABLE';
    entry.reason = undefined;
    entry.handle = undefined;
    providers.delete(`local:${entry.projectId}`);
  }

  function unavailableError(projectId: string, reason: ProjectUnavailableReason | undefined): Error {
    return domainError(
      ERROR_CODES.ERR_PROJECT_UNAVAILABLE,
      `项目不可用: ${projectId}${reason ? `（${reason}）` : ''}`,
      { reason },
    );
  }

  /** 撤销结果不可证：既不能读盘，也不能据"再来一次"伪造第二条证据。 */
  function revokeUnknownError(projectId: string): Error {
    return domainError(
      ERROR_CODES.ERR_PROJECT_REVOKE_UNKNOWN,
      `项目撤销结果待核对，磁盘访问被拒绝: ${projectId}`,
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

  /**
   * 构造一个条目：只有"存储可信 + 授权凭据完整 + 根可用"三者同时成立才是 ACTIVE。
   *
   * `UNAVAILABLE` 的三种来源必须区分清楚，但对外都只是"不能碰磁盘"：
   * - 存储不可信（撤销集合不可证）→ P0-01 的全局拒盘；
   * - 授权凭据缺失/来源不可信（P0-04）→ 没有证据就不发权限；
   * - 根身份不可用 → 沿用原有的 reason。
   */
  function buildEntry(record: StoredProject, trustDisk = true): Entry {
    const base = { projectId: record.projectId, name: record.name, rootDir: record.rootDir };
    if (!trustDisk) {
      // 撤销集合不可证：条目保留用于诊断与草稿救援，但不建 Provider、不发 grant
      return { ...base, state: 'UNAVAILABLE' };
    }
    if (!isTrustedGrant(record)) {
      // 缺 grantSource/grantedAt/canonicalRoot/rootToken 或来源不可信：一律不发权限
      return { ...base, state: 'UNAVAILABLE' };
    }
    const inspection = inspect(record.rootDir);
    if (inspection.status !== 'READY') {
      return { ...base, state: 'UNAVAILABLE', reason: inspection.reason };
    }
    let provider: StorageProvider;
    try {
      provider = factory({
        projectId: record.projectId,
        providerId: `local:${record.projectId}`,
        rootDir: record.rootDir,
      });
    } catch {
      return { ...base, state: 'UNAVAILABLE', reason: 'IO_ERROR' };
    }
    const handle: ProjectHandle = {
      projectId: record.projectId,
      providerId: `local:${record.projectId}`,
      rootDir: record.rootDir,
      canonicalRoot: inspection.canonicalRoot,
      rootToken: inspection.rootToken,
      provider,
    };
    return {
      ...base,
      state: 'ACTIVE',
      canonicalRoot: inspection.canonicalRoot,
      rootToken: inspection.rootToken,
      handle,
    };
  }

  // ---- 启动装载（唯一一次读 store）----
  //
  // `diskTrusted === false` 时一律不建 Provider、不发 grant（ADR-022 §3.2）：
  // 配置里有这个项目不能证明它没被撤销过。
  const loaded = deps.store.load();
  for (const stored of loaded) {
    issuedIds.add(stored.projectId);
    const entry = buildEntry(stored, storeState.diskTrusted);
    entries.set(entry.projectId, entry);

    // 持久化的根身份与当前 inspect 结果必须一致：不一致即 UNAVAILABLE，
    // 不 adopt、不改写配置（这正是"根被移动过"与"新目录同名"的区分点）。
    if (entry.state === 'ACTIVE' && entry.handle) {
      if (stored.canonicalRoot && stored.canonicalRoot !== entry.handle.canonicalRoot) {
        downgrade(entry, 'CANONICAL_CHANGED');
      } else if (stored.rootToken && stored.rootToken !== entry.handle.rootToken) {
        downgrade(entry, 'ROOT_TOKEN_CHANGED');
      }
    }
  }

  // ---- 加载期根独立性（P1）----
  //
  // 配置可能自带重复根/嵌套根（v1 手写、v2 被外部改写）。运行期 add 有
  // `assertRootAdmissible` 拦着，装载期却会全部授权 —— 那等于让"一个目录两个项目"
  // 各自拿到读写权限。这里按**配置顺序**取第一个，后续冲突条目一律降级为 UNAVAILABLE。
  const occupiedRoots: string[] = [];
  for (const entry of entries.values()) {
    if (entry.state !== 'ACTIVE' || !entry.handle) continue;
    const root = entry.handle.canonicalRoot;
    const conflicts = occupiedRoots.some(
      (other) => foldForCompare(other) === foldForCompare(root) || isNested(other, root),
    );
    if (conflicts) {
      // 不是"根变了"，而是"配置里两个项目抢同一个根"：不给 reason 以免误报原因
      denyEntry(entry);
      continue;
    }
    occupiedRoots.push(root);
  }

  for (const entry of entries.values()) {
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

  /**
   * 只在 `issuedIds` 之外签发；已撤销的 id 也不复用。
   *
   * 长度是硬约束：`projectId` 会被写进持久化配置并在加载时用
   * `PROJECT_ID_RE`（≤32 字符）再校验一次。直接拼 `${base}-${n}` 会让 32 字符的
   * 词干变成 34 字符的 id —— 本次能签发、重启后无法加载。因此**截断词干**、
   * 保留完整序号，并对每个候选做一次正则校验。
   */
  function issueProjectId(name: string): string {
    const base = slugify(name);
    if (!issuedIds.has(base) && PROJECT_ID_RE.test(base)) return base;
    for (let n = 2; n < 1000; n += 1) {
      const suffix = `-${n}`;
      const stem =
        base.slice(0, Math.max(1, MAX_PROJECT_ID_LENGTH - suffix.length)).replace(/[-_]+$/, '') || 'project';
      const candidate = `${stem}${suffix}`;
      if (issuedIds.has(candidate)) continue;
      if (!PROJECT_ID_RE.test(candidate)) continue;
      return candidate;
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

  /**
   * 重复/嵌套判定：与**所有仍有身份的**条目比较，包括 `UNAVAILABLE` / `REVOKE_UNKNOWN`。
   *
   * 只看 `entry.handle` 会漏掉"根暂时读不到"的项目，从而允许把同一目录（或它的
   * 父/子目录）注册成第二个项目——那会在项目身份不可证的时候凭空多出一个身份。
   * 占用证据用 `occupancyOf`（注册时确认的规范根，退化到字面根），且不因降级而清除。
   */
  function assertRootAdmissible(canonicalRoot: string, ignoreProjectId?: string): void {
    for (const entry of entries.values()) {
      if (entry.projectId === ignoreProjectId) continue;
      const existing = occupancyOf(entry);
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

  /**
   * 提交点失败的两分支处理（ADR-022 §3.1.1）。
   *
   * 关键点是**不能把"抛错"当成"没写"**：fsync 报错时内核可能已经落盘，也可能
   * 只落了半行。因此：
   * - `commitState === 'not-committed'`（唯一可断言的形态）→ 零变更、回原状态、可重试；
   * - `'unknown'` 或未声明 → 按"已撤销"保守处理：立即切断磁盘权限、保留条目、
   *   进入 `REVOKE_UNKNOWN`，等待持久证据核对（02B-02）。
   *
   * 后者不删除条目、不置 REMOVED：撤销是否生效尚未可证，两者都不能宣称。
   */
  function applyCommitFailure(
    entry: Entry,
    projectId: string,
    previousState: ProjectLifecycle,
    err: unknown,
  ): Error {
    const commitState = (err as { commitState?: StoreCommitState } | undefined)?.commitState;
    // 提交前的可信性复核失败（日志缺失/断裂/无法核对）：零变更，
    // 但**必须**把 Store 的受限结论原样抛给调用方，不能降级成"可重试的持久化失败"。
    if ((err as { errorCode?: string } | undefined)?.errorCode === ERROR_CODES.ERR_STORE_RESTRICTED) {
      entry.state = previousState;
      return err instanceof Error ? err : domainError(ERROR_CODES.ERR_STORE_RESTRICTED, '存储处于受限状态');
    }
    if (commitState === 'not-committed') {
      entry.state = previousState;
      return domainError(
        ERROR_CODES.ERR_PERSIST_FAILED,
        '撤销未被持久化（确认未写入），状态与授权均未变化，可重试',
        { commitState, projectId },
      );
    }
    entry.state = 'REVOKE_UNKNOWN';
    entry.reason = undefined;
    entry.handle = undefined;
    // 无法证明撤销未发生 → 不再授予任何磁盘权限（fail-closed）
    revokeProject(projectId);
    providers.delete(`local:${projectId}`);
    deps.document.markProjectStale(projectId, 'REVOKE_UNKNOWN');
    revision += 1;
    return domainError(
      ERROR_CODES.ERR_PROJECT_REVOKE_UNKNOWN,
      '撤销提交结果不确定，已按已撤销保守处理：磁盘访问被拒绝，等待证据核对',
      { commitState: commitState ?? 'unknown', projectId },
    );
  }

  const summaryOf = (entry: Entry): ProjectSummary =>
    Object.freeze({
      projectId: entry.projectId,
      name: entry.name,
      // QUIESCING/REMOVING 对外仍是 READY：屏障是内部串行化，不是"项目坏了"。
      // REVOKE_UNKNOWN 不是 READY：磁盘权限已切断，且撤销是否生效尚不可证。
      status:
        entry.state === 'UNAVAILABLE' || entry.state === 'REVOKE_UNKNOWN' ? 'UNAVAILABLE' : 'READY',
      ...(entry.state === 'UNAVAILABLE' && entry.reason ? { reason: entry.reason } : {}),
    });

  return {
    list() {
      for (const entry of entries.values()) refreshEntry(entry);
      return Object.freeze([...entries.values()].map(summaryOf));
    },

    assertUsable(projectId) {
      // 全局可信优先：撤销集合一旦不可证，任何项目都不许再碰磁盘，
      // 已发出的 grant 也不能成为绕过这道门的路径（ADR-022 §3.2）。
      assertGlobalDiskTrust();
      const entry = entries.get(projectId);
      if (!entry) {
        throw domainError(ERROR_CODES.ERR_PROJECT_NOT_FOUND, `未注册的项目: ${projectId}`);
      }
      // 撤销结果不可证优先于"不可用"：告诉调用方真正的原因，而不是笼统的根失效
      if (entry.state === 'REVOKE_UNKNOWN' || diskDenied.has(projectId)) throw revokeUnknownError(projectId);
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
      assertGlobalDiskTrust();
      const entry = entries.get(projectId);
      if (!entry) throw domainError(ERROR_CODES.ERR_PROJECT_NOT_FOUND, `未注册的项目: ${projectId}`);
      if (entry.state === 'REVOKE_UNKNOWN' || diskDenied.has(projectId)) throw revokeUnknownError(projectId);
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
        // 身份摘要必须**按请求重算**：`/api/health` 是恢复记录匹配的唯一入口，
        // 若只在 `list()` 里复核根身份，"删掉根之后先问健康检查"就会继续拿到
        // 旧的 READY 摘要，客户端会据此认领一份已经不可用的恢复记录。
        for (const entry of entries.values()) refreshEntry(entry);
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
      assertStoreWritable();
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
      const grantSource = input.grantSource ?? deps.grantSource ?? 'unspecified';
      if (!KNOWN_GRANT_SOURCES.includes(grantSource)) {
        throw domainError(ERROR_CODES.ERR_COMMAND_INVALID, `非法的授权来源: ${grantSource}`);
      }
      // 授权凭据与记录一起写入：缺任何一项，重启后该条目都不会拿到 G-DISK（P0-04）
      const record: StoredProject = {
        projectId,
        name,
        rootDir: inspection.literalRoot,
        canonicalRoot: inspection.canonicalRoot,
        rootToken: inspection.rootToken,
        grantedAt: new Date().toISOString(),
        grantSource,
        createdByOp: opId,
      };
      mutating = true;
      try {
        // 提交点：先持久化，再让内存生效（添加是"多给一份权限"，必须先有证据）。
        // 持久化失败时这里抛错，下面三行（entries / provider / grant）都不会执行。
        await deps.store.commitAdd({ ...record, opId });
        const entry = buildEntry(record, refreshStoreState().diskTrusted);
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
      assertStoreWritable();
      const entry = entries.get(projectId);
      if (!entry) throw domainError(ERROR_CODES.ERR_PROJECT_NOT_FOUND, `未注册的项目: ${projectId}`);
      // 撤销结果不可证的项目不再接受任何变更：连显示名都不改，
      // 避免留下"看起来还活着的项目"这种第二套真相。
      if (entry.state === 'REVOKE_UNKNOWN') throw revokeUnknownError(projectId);
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
      assertStoreWritable();
      const entry = entries.get(projectId);
      if (!entry) throw domainError(ERROR_CODES.ERR_PROJECT_NOT_FOUND, `未注册的项目: ${projectId}`);
      // 上一次撤销的提交结果还不可证：不允许再提交一次（会伪造第二条持久证据）
      if (entry.state === 'REVOKE_UNKNOWN') throw revokeUnknownError(projectId);

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
          // abort：Provider、grants、正文、revision 一律不动；精确恢复到进入前的状态。
          // 不能一律回 ACTIVE —— 一个根不可用的项目会因此被凭空"复活"出根身份。
          entry.state = previousState;
          return { outcome: 'aborted', blockedBy };
        }

        // ---- 提交点：墓碑 fsync（真实 Store）；fake Store 只有内存提交 ----
        entry.state = 'REMOVING';
        const opId = `op-${randomUUID()}`;
        let receipt: StoreRevokeReceipt | undefined;
        try {
          const result = await deps.store.commitRevoke({ projectId, opId });
          if (result) receipt = result;
        } catch (err) {
          throw applyCommitFailure(entry, projectId, previousState, err);
        }

        // ---- 同步提交（无 await）：立即切断访问权 ----
        // §4.4 最危险的一格：墓碑已生效但这里抛错，绝不能留下"磁盘已撤销、内存仍授权"。
        // 兜底顺序：拉黑 → 删条目 → 删 Provider → 强制重试 revoke → DEGRADED。
        try {
          entries.delete(projectId);
          removed.add(projectId);
          revokeProject(projectId);
          providers.delete(`local:${projectId}`);
          deps.document.markProjectStale(projectId, 'PROJECT_REMOVED');
          revision += 1;
        } catch {
          diskDenied.add(projectId);
          entries.delete(projectId);
          providers.delete(`local:${projectId}`);
          try {
            revokeProject(projectId);
          } catch {
            // 仍失败：黑名单已经是最后一道门，任何 G-DISK 都会在 assertUsable 处被拒
          }
          deps.store.markDegraded?.('运行期提交失败：该项目已按内存黑名单拒绝磁盘访问');
          throw revokeUnknownError(projectId);
        }

        if (receipt && receipt.configPersisted === false) {
          // 墓碑已生效，配置补写失败：项目已不可访问，不回滚也不重新授权
          deps.store.markDegraded?.('REVOKED_PENDING_CONFIG：撤销已生效但配置补写失败');
        }
        return {
          outcome: 'revoked',
          projectId,
          opId,
          ...(receipt ? { configPersisted: receipt.configPersisted } : {}),
        };
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
