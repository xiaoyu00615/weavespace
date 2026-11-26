/**
 * 回收区「待核对」记录的跨重启台账（UX-02C-03-P2-02-R1.1 / R1.2）。
 *
 * 为什么要单独持久化：`unconfirmedOpIds` 只在内存里，重启后如果 Host 的对账还没跑完、
 * 列表仍返回 `stored`，界面就会重新给出「恢复」按钮——而那次恢复其实可能已经动过盘。
 * 恢复是不可逆的磁盘动作，"重启"绝不能成为解除门禁的理由。
 *
 * 存储纪律（与工作区快照同一套思路，但**独立**存放，不改 `PersistedUi` 的语义）：
 * - 显式版本号 + 白名单字段 + 数量/长度上限；任何一项不符都判定为 `corrupt`，
 *   **绝不**静默当成空集合（那等于把所有待核对记录重新开放）；
 * - 只存"哪个工作区的哪个项目里，哪个 opId 还没有结论" + 创建时间：
 *   不存正文、不存绝对路径、不存 rootToken、不存身份 `dev:ino`；
 * - 读取失败 / 存储不可用 → `unavailable`；两种情况都由调用方按 fail-closed 处理。
 *
 * R1.2 起台账是一个**单一真相**的小 store（`createTrashLedgerStore`）：
 * React 的 `setState` 是异步批处理的，若每次追加都从渲染快照起算，两条 UNKNOWN 在
 * 同一次提交里到达时，后一条会基于旧快照把前一条覆盖掉。因此"当前记录"只存在于
 * store 内部的 `current`，调用方读到的永远是**写入后**的最新值。
 *
 * R1.2.1 起再加两道边界：
 * - **跨标签页互斥**：多个标签页共享同一份 localStorage，各自的 store 只记得自己的
 *   快照。因此每次读改写都在 `navigator.locks` 的同一把锁内**重新读取**再校验/写盘，
 *   否则两个标签页会各写一份 64 条、后写覆盖先写，丢掉一次已经发出的恢复。
 *   浏览器不提供 Web Locks 时**不得退回**不安全的写法，而是整体 fail-closed。
 * - **字节数**：上限按 UTF-8 实际字节（`TextEncoder`）而不是 JavaScript 的 UTF-16
 *   码元长度判定，读与写用同一规则。
 *
 * R1.2.1-R1 再补两类"外部把台账弄没了"的情况：
 * - **外部删除 / 清空**：`removeItem` 与 `localStorage.clear()` 都会让持久层看起来
 *   像"干净的首次使用"。已经打开的页面**不能**把这个空读成"没有待核对"——那等于
 *   把所有 UNKNOWN 重新开放。因此 `storage` 事件必须区分"首次没有"与"被删掉了"：
 *   后者进入页面级失效保护（`invalidated`），保留内存记录、关闭恢复、不重建，
 *   并在本页生命周期内不再解除。
 * - **镜像一致性**：store 是唯一真相，React 只是订阅者。每次异步操作结束（无论
 *   `reserved` / `exists` / `full` / `write-failed` / `changed` / `unchanged`）都要
 *   发布一次快照，否则"锁内重读拿到了别的页面的记录、界面却还显示可恢复"。
 */
import type { TrashEntryDto } from '../client/client-api.ts';
import type { TrashGuardRead, TrashGuardStorage } from './trash-ledger-guard.ts';
import { TRASH_TERMINAL_STATES } from './types.ts';
import type { StorageLike } from './workspace-persistence.ts';

export const TRASH_LEDGER_VERSION = 1 as const;
/** 独立命名空间：与 `ws:workspace:v1:*` 分开，互不影响解析与清理。 */
export const TRASH_LEDGER_KEY = 'ws:trash-pending:v1';
/**
 * 容量上限。达到上限**不淘汰任何记录**：一条待核对记录背后是一次可能已经动过盘的
 * 恢复，"腾位置"等于把最早的那次未知副作用从账本上抹掉。满了就停止发起新的恢复。
 */
export const MAX_TRASH_PENDING = 64;
/** 单条记录上限：超过就是损坏，不做截断（截断会丢掉真正的待核对项）。 */
export const MAX_TRASH_LEDGER_BYTES = 16 * 1024;
/**
 * 跨标签页台账锁名（R1.2.1-02）。
 *
 * 固定且带版本：同源的所有标签页必须抢同一把锁；将来若改变台账协议，换名字而不是
 * 复用旧名，避免新旧版本在同一次操作里互不阻塞。
 */
export const TRASH_LEDGER_LOCK = 'weavespace-trash-ledger-v1';

const utf8 = new TextEncoder();
/** UTF-8 实际字节数（`String.length` 是 UTF-16 码元数，非 ASCII 会少算）。 */
function byteLengthOf(value: string): number {
  return utf8.encode(value).byteLength;
}

/**
 * 规范 ISO 8601 UTC 时间（`YYYY-MM-DDTHH:mm:ss.sssZ`）。
 *
 * 不用宽松的 `Date.parse` 单独判定：`'2026-02-30T00:00:00.000Z'` 会被解析成 3 月 2 日，
 * 而 `'2026-11-24 00:00:00'` 这类非规范写法也能过。要求"回写结果与原文完全一致"，
 * 才能同时挡住越界日期与不规范格式。
 */
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function isCanonicalIsoUtc(value: string): boolean {
  if (!ISO_UTC_RE.test(value)) return false;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return false;
  try {
    return new Date(time).toISOString() === value;
  } catch {
    return false;
  }
}

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** 与 Host 的 opId 目录名规则一致：小写字母/数字开头，允许 `-` 与 `_`。 */
const OP_ID_RE = /^[a-z0-9][a-z0-9_-]{7,63}$/;
const WORKSPACE_KEY_RE = /^[a-f0-9]{16,128}$/;

/** 一条"还没有结论"的恢复。字段刻意最小化。 */
export interface TrashPendingRecord {
  readonly workspaceKey: string;
  readonly projectId: string;
  readonly opId: string;
  /** 仅诊断用（用于排查），不参与任何判定。 */
  readonly createdAt: string;
}

/**
 * 台账状态。
 *
 * `full` 不是"读坏了"，而是"容量用尽"：两者都让恢复保持关闭，但原因与处理方式不同
 * （前者要核对已有记录，后者要处理存储本身）。放在同一个枚举里，是为了让
 * "能不能恢复"只有一个判断入口。
 */
export type TrashLedgerStatus =
  | 'ok'
  | 'full'
  | 'corrupt'
  | 'unavailable'
  | 'invalidated'
  /** 保护记录（IndexedDB）还没读完：此时一律按"不能恢复"处理（R2-01）。 */
  | 'initializing';

export type TrashLedgerRead =
  | { readonly status: 'ok'; readonly records: readonly TrashPendingRecord[] }
  /** 解析不了 / 版本不认识 / 字段非法 / 超限：**不采用**，由调用方 fail-closed。 */
  | { readonly status: 'corrupt' }
  /** 没有存储能力（隐私模式、策略禁用）：读不到也就无法证明"没有待核对"。 */
  | { readonly status: 'unavailable' };

/** 三种非 ok 状态都必须让恢复保持关闭，文案区分原因，处理方式相同。 */
export function trashLedgerBlockMessage(status: TrashLedgerStatus): string | null {
  if (status === 'ok') return null;
  if (status === 'full') {
    return `本机的「待核对」记录已满（${MAX_TRASH_PENDING} 条），为避免再产生无法追踪的恢复，恢复操作暂时关闭。请先刷新回收区核对已有记录，等它们有了结论再试。`;
  }
  if (status === 'corrupt') {
    /*
     * R1.2-05：**不能**建议用户"清除本应用数据"。
     *
     * 那会把台账一起删掉，下次启动读到"没有这条记录"就当成首次使用的空台账——
     * 恰好绕过了这里想守住的 fail-closed。原始字节必须留着，等可靠对账或专门的修复流程。
     */
    return '本机的「待核对」记录已损坏，无法确认哪些恢复还没有结论；为避免重复恢复，回收区的恢复操作暂时关闭。请不要重置或删除本站数据（会连同这条保护一起删除），等待后续的核对与修复流程。';
  }
  if (status === 'initializing') {
    return '正在确认本机「待核对」保护记录，回收区的恢复操作暂时关闭（通常只需几十毫秒）。';
  }
  if (status === 'invalidated') {
    /*
     * R1.2.1-R1：本页打开期间台账被另一个页面删除或清空。
     *
     * 不能把它解释成"没有待核对"：那正是外部删除最危险的地方。本页内存里的记录
     * 仍然有效（界面继续显示为待核对），恢复保持关闭；也不建议用户"清理数据"，
     * 那只会让下一次启动同样读到空台账。
     */
    return '本页打开期间，本机的「待核对」记录被其他页面删除或清空，已无法确认哪些恢复还没有结论；为避免重复恢复，本页的恢复操作保持关闭（本页不会自动重建台账）。请刷新页面重新核对。';
  }
  return '本机存储不可用，无法记录「待核对」状态；为避免重复恢复，回收区的恢复操作暂时关闭。';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseTrashPendingRecord(raw: unknown): TrashPendingRecord | null {
  const row = asRecord(raw);
  if (!row) return null;
  const { workspaceKey, projectId, opId, createdAt } = row;
  if (typeof workspaceKey !== 'string' || !WORKSPACE_KEY_RE.test(workspaceKey)) return null;
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return null;
  if (typeof opId !== 'string' || !OP_ID_RE.test(opId)) return null;
  if (typeof createdAt !== 'string' || !isCanonicalIsoUtc(createdAt)) return null;
  return { workspaceKey, projectId, opId, createdAt };
}

function recordKey(record: TrashPendingRecord): string {
  return `${record.workspaceKey}\u0000${record.projectId}\u0000${record.opId}`;
}

/**
 * 读取台账。
 *
 * 注意 `null` 原始值不是"损坏"：第一次运行时本来就没有这条记录。
 * 只有"有值但读不懂"或"存储本身不可用"才是需要 fail-closed 的情况。
 */
export function readTrashLedger(storage: StorageLike | null): TrashLedgerRead {
  if (!storage) return { status: 'unavailable' };
  let raw: string | null;
  try {
    raw = storage.getItem(TRASH_LEDGER_KEY);
  } catch {
    return { status: 'unavailable' };
  }
  return parseTrashLedgerValue(raw);
}

/**
 * 解析"给定的一份台账文本"（R2-02）。
 *
 * `storage` 事件必须用它来读**事件自己的 newValue**：事件排队期间持久层可能已经
 * 又被改过一次，回读当前值就会把"先写后删"里的那次写入读成空台账，从而丢掉 UNKNOWN。
 */
export function parseTrashLedgerValue(raw: string | null): TrashLedgerRead {
  if (raw === null) return { status: 'ok', records: [] };
  // 读与写用同一把尺子：按 UTF-8 实际字节，而不是字符串长度
  if (byteLengthOf(raw) > MAX_TRASH_LEDGER_BYTES) return { status: 'corrupt' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'corrupt' };
  }
  const body = asRecord(parsed);
  if (!body || body.version !== TRASH_LEDGER_VERSION) return { status: 'corrupt' };
  if (!Array.isArray(body.records) || body.records.length > MAX_TRASH_PENDING) {
    return { status: 'corrupt' };
  }
  const records: TrashPendingRecord[] = [];
  const seen = new Set<string>();
  for (const item of body.records) {
    const record = parseTrashPendingRecord(item);
    // 一条非法就整份判损坏：静默丢掉"看不懂的那条"等于把它重新开放
    if (!record) return { status: 'corrupt' };
    const key = recordKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(record);
  }
  return { status: 'ok', records };
}

export function encodeTrashLedger(records: readonly TrashPendingRecord[]): string {
  return JSON.stringify({ version: TRASH_LEDGER_VERSION, records });
}

/**
 * 写入；返回 false 表示"这次没能落盘"（调用方必须让用户知道保护已降级）。
 *
 * 写之前先按**实际编码字节数**校验：否则可能写进去一份下次读必然判 `corrupt` 的数据，
 * 那等于把所有人（包括以后真正的待核对记录）一起锁死。
 */
export function writeTrashLedger(storage: StorageLike | null, records: readonly TrashPendingRecord[]): boolean {
  if (!storage) return false;
  let encoded: string;
  try {
    encoded = encodeTrashLedger(records);
  } catch {
    return false;
  }
  if (byteLengthOf(encoded) > MAX_TRASH_LEDGER_BYTES) return false;
  try {
    storage.setItem(TRASH_LEDGER_KEY, encoded);
    return true;
  } catch {
    return false;
  }
}

/** 还能再放多少条（只对"读成功"的台账有意义）。 */
export function trashLedgerRemaining(records: readonly TrashPendingRecord[]): number {
  return Math.max(0, MAX_TRASH_PENDING - records.length);
}

export type TrashReserveResult =
  | { readonly status: 'reserved'; readonly records: readonly TrashPendingRecord[] }
  /** 这条已经记过了：重复预留是幂等的，不占新位置。 */
  | { readonly status: 'exists'; readonly records: readonly TrashPendingRecord[] }
  /** 容量用尽：**不淘汰**任何已有记录。 */
  | { readonly status: 'full'; readonly records: readonly TrashPendingRecord[] };

/**
 * 预留一条待核对记录（R1.2-02）。
 *
 * 纯粹的"判断 + 生成新数组"：不写盘、不动全局状态，因此可以被并发/重启测试直接驱动。
 * 满仓时原样返回传入的记录，绝不丢弃最旧的一条。
 */
export function reserveTrashPending(
  records: readonly TrashPendingRecord[],
  record: TrashPendingRecord,
): TrashReserveResult {
  const key = recordKey(record);
  if (records.some((item) => recordKey(item) === key)) {
    return { status: 'exists', records };
  }
  if (records.length >= MAX_TRASH_PENDING) return { status: 'full', records };
  return { status: 'reserved', records: [...records, record] };
}

/** 追加一条（已存在则不重复）；满仓时原样返回，**不淘汰**。 */
export function addTrashPending(
  records: readonly TrashPendingRecord[],
  record: TrashPendingRecord,
): readonly TrashPendingRecord[] {
  return reserveTrashPending(records, record).records;
}

/** 移除指定 opId（只影响这一条）。 */
export function removeTrashPending(
  records: readonly TrashPendingRecord[],
  target: { workspaceKey: string; projectId: string; opIds: readonly string[] },
): readonly TrashPendingRecord[] {
  if (target.opIds.length === 0) return records;
  const drop = new Set(target.opIds);
  const next = records.filter(
    (record) =>
      !(
        record.workspaceKey === target.workspaceKey &&
        record.projectId === target.projectId &&
        drop.has(record.opId)
      ),
  );
  return next.length === records.length ? records : next;
}

/** 当前工作区 + 项目下仍待核对的 opId。 */
export function pendingIdsOf(
  records: readonly TrashPendingRecord[],
  workspaceKey: string | null,
  projectId: string | null,
): readonly string[] {
  if (!workspaceKey || !projectId) return [];
  return records
    .filter((record) => record.workspaceKey === workspaceKey && record.projectId === projectId)
    .map((record) => record.opId);
}

/**
 * 用一次**成功的**列表读取收敛台账。
 *
 * 只有两种结论能解除：记录已到终态，或记录已不在列表里（没有可点的行了）。
 * `stored` / `pending` / `restoring` 一律保留——它们正是"可能还没做完"的三种形态。
 * 读取失败时调用方不应调用本函数（`loaded=false` 时这里也直接原样返回）。
 */
export function reconcileTrashPending(
  records: readonly TrashPendingRecord[],
  input: {
    workspaceKey: string | null;
    projectId: string | null;
    entries: readonly TrashEntryDto[];
    loaded: boolean;
  },
): readonly TrashPendingRecord[] {
  if (!input.loaded || !input.workspaceKey || !input.projectId) return records;
  const { workspaceKey, projectId, entries } = input;
  const settled = new Set(
    entries
      .filter((entry) => TRASH_TERMINAL_STATES.has(entry.state))
      .map((entry) => entry.opId),
  );
  const seen = new Set(entries.map((entry) => entry.opId));
  const remaining = records.filter((record) => {
    if (record.workspaceKey !== workspaceKey || record.projectId !== projectId) return true;
    if (!seen.has(record.opId)) return false;
    return !settled.has(record.opId);
  });
  return remaining.length === records.length ? records : remaining;
}

/* ================================================================== */
/* 跨标签页互斥                                                         */
/* ================================================================== */

/**
 * 台账的跨标签页互斥能力（R1.2.1-02）。
 *
 * 只暴露"能不能"和"在互斥区里跑"，不暴露锁的实现：浏览器用 `navigator.locks`，
 * 测试用进程内串行队列，两者对 store 的语义完全相同（临界区里重新读、校验、写盘）。
 */
export interface TrashLedgerCoordination {
  /** false = 无法保证跨标签页互斥 → 恢复整体关闭（fail-closed）。 */
  readonly supported: boolean;
  runExclusive<T>(task: () => T | Promise<T>): Promise<T>;
}

/** `navigator.locks` 的最小形状（不引入 DOM 类型依赖，也便于测试注入）。 */
export interface LockManagerLike {
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T> | T): Promise<T>;
}

/** 进程内串行：单标签页 / 测试用，保证同一 store 的临界区不交错。 */
export function createInlineCoordination(): TrashLedgerCoordination {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    supported: true,
    runExclusive(task) {
      const next = tail.then(() => task());
      // 前一次失败不阻塞后一次
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}

/**
 * 浏览器全局面板锁。
 *
 * 传 `null`（旧浏览器 / 被策略禁用）时返回 `supported: false`：调用方必须整体关闭
 * 恢复，**不能**退回"各写各的 localStorage"，那正是本项要修掉的丢事务场景。
 */
export function createWebLockCoordination(locks: LockManagerLike | null): TrashLedgerCoordination {
  if (!locks) {
    return {
      supported: false,
      runExclusive: () => Promise.reject(new Error('Web Locks unavailable')),
    };
  }
  return {
    supported: true,
    runExclusive: (task) => locks.request(TRASH_LEDGER_LOCK, { mode: 'exclusive' }, () => task()),
  };
}

/* ================================================================== */
/* 原子 store：ledger 的唯一真相                                         */
/* ================================================================== */

export type TrashReserveOutcome =
  /** 本次真的占到了一个位置（已写盘）：**只有它可以授权新的恢复 POST**。 */
  | { readonly status: 'reserved' }
  /**
   * 台账里已经有同一个 (workspaceKey, projectId, opId)。
   *
   * 含义是"这次恢复的结果还没有结论"，**不是**"可以再试一次"。调用方必须拒绝，
   * 绝不能把它当成授权（R1.2.1-01）。
   */
  | { readonly status: 'exists' }
  | { readonly status: 'full' }
  /** 无跨标签页协调能力 / 存储不可读 / 台账损坏：一律不能继续。 */
  | { readonly status: 'unavailable' }
  /** 记录形状非法（例如工作区键不是 Host 的摘要格式）：绝不写进台账。 */
  | { readonly status: 'invalid' }
  /**
   * 落盘失败：这次追加**没有**生效。没有持久化保护就不能发副作用请求——
   * 否则页面一关，这次恢复就从账本上消失了。
   */
  | { readonly status: 'write-failed' };

/**
 * 预留结论是否**授权**本次新的恢复 POST（R1.2.1-01）。
 *
 * 只有 `reserved`（这一次真的占到了位置并已落盘）才是授权。
 * `exists` 表示"同一个 opId 还有一次没有结论的恢复"——把它当成授权就是第二次
 * 真实的磁盘移动，而这条记录正是靠台账才被禁用的；`full` / `write-failed` /
 * `unavailable` / `invalid` 更显然都不能继续。
 *
 * 抽成函数只为一件事：让"授权表"能被单元测试逐项钉住，而不是散落在 JSX 的 if 里。
 */
export function trashReserveAuthorizes(outcome: TrashReserveOutcome): boolean {
  return outcome.status === 'reserved';
}

export type TrashMutationOutcome =
  /** 内存与存储都已更新。 */
  | { readonly status: 'changed' }
  | { readonly status: 'unchanged' }
  /** 内存已更新，但落盘失败：本次会话内有效，重启后可能回到旧台账（安全方向）。 */
  | { readonly status: 'write-failed' }
  /** 读都读不了 / 无协调能力：不写，避免覆盖未知内容。 */
  | { readonly status: 'unavailable' };

/**
 * 一条外部存储事件（只取用得到的两个字段）。
 *
 * `key === null` 是 `localStorage.clear()` 的形状；`key === TRASH_LEDGER_KEY &&
 * newValue === null` 是 `removeItem` 的形状。两者都必须按"被删掉了"处理，
 * 而不是"台账是空的"。
 */
export interface TrashExternalStorageEvent {
  readonly key: string | null;
  readonly newValue: string | null;
}

/**
 * 对外发布的只读快照（R1.2.1-R1）。
 *
 * `version` 每次"状态或记录"真的变化时 +1：React 用 `useSyncExternalStore` 订阅它，
 * 因此不需要（也不允许）在各处手写"成功才同步"的逻辑。`blockMessage` 一并放进快照，
 * 避免渲染时再读一遍 store 造成同一帧内两份口径。
 */
export interface TrashLedgerSnapshot {
  readonly status: TrashLedgerStatus;
  readonly records: readonly TrashPendingRecord[];
  readonly blockMessage: string | null;
  readonly version: number;
}

/**
 * store 的可选装配（R2-01）。
 *
 * `guard` 是**独立于 localStorage** 的保护记录（浏览器里是 IndexedDB）。
 * 不传 = 退回 R1 的单层行为：只有主台账，外部删除后刷新就无从判断。
 * 生产装配必须传；只有"这一层已经被别处证明"的单元测试才允许省略。
 */
export interface TrashLedgerStoreOptions {
  readonly guard?: TrashGuardStorage;
}

export interface TrashLedgerStore {
  /** 等保护记录初始化完成（没传 guard 时立即完成）。 */
  ready(): Promise<void>;
  /** 当前状态（含容量用尽 / 无协调能力 / 被外部删除）。 */
  status(): TrashLedgerStatus;
  records(): readonly TrashPendingRecord[];
  /** 当前快照（引用稳定：只有真的变化时才换新对象）。 */
  snapshot(): TrashLedgerSnapshot;
  /** 订阅快照变化；返回取消订阅。 */
  subscribe(listener: () => void): () => void;
  /** 非空 = 此刻不能恢复；文案已可直接展示。 */
  blockMessage(): string | null;
  /** 本页的保护是否已被外部删除 / 清空锁死（写进保护记录后跨刷新也不解除）。 */
  isInvalidated(): boolean;
  /**
   * 处理一个 `storage` 事件（R1.2.1-R1）。
   *
   * 返回 true 表示本页的镜像或状态变了（需要重画）。无关 key 返回 false。
   * **删除 / 清空**：标记失效、保留内存记录、不写盘、不重建；
   * **外部写入**：按 `refresh()` 的规则采纳（读不懂 → corrupt，记录保留）。
   */
  applyExternalEvent(event: TrashExternalStorageEvent): boolean;
  /**
   * 预留一个位置。**异步**：必须先拿到跨标签页锁、在锁内重读最新台账再判断/写盘。
   * 返回 `reserved` 才是授权；其余一律拒绝。
   */
  reserve(record: TrashPendingRecord): Promise<TrashReserveOutcome>;
  release(target: { workspaceKey: string; projectId: string; opIds: readonly string[] }): Promise<TrashMutationOutcome>;
  reconcile(input: {
    workspaceKey: string | null;
    projectId: string | null;
    entries: readonly TrashEntryDto[];
    loaded: boolean;
  }): Promise<TrashMutationOutcome>;
  /**
   * 用持久化内容刷新内存镜像（别的标签页写了台账时用）。
   *
   * 只动镜像、不写盘：镜像天生可以落后，真正的判断永远在锁内重读。
   * 返回 true 表示镜像**或状态**确实变了（R1.2.1-R1：不能只比记录签名，
   * 否则 ok → corrupt 的变化不会通知界面）。
   */
  refresh(): boolean;
}

/**
 * 建一个台账 store。
 *
 * 纪律（R1.2 / R1.2.1 / R1.2.1-R1 / R2）：
 * 1. **每次读改写都在锁内重新读取**：本地 `current` 可能已经被别的标签页写旧了；
 * 2. 传了 `guard`（独立保护记录）时，**先写保护记录、再写主台账**，
 *    两者都成功才可能授权 POST；
 * 3. 保护记录说"还有待核对"，而主台账却读成空 → 这不是"首次使用"，是**被删掉了**：
 *    进入 `invalidated`，保留记录、不写盘、不重建；
 * 4. 保护记录读不出来 → `unavailable`（fail-closed），绝不退回单层写法；
 * 5. 读失败（corrupt / unavailable）时永不写盘，但**保留**内存里已知的记录；
 * 6. 每次操作结束都 `publish()`：界面是订阅者，不是"成功分支的副产品"。
 */
export function createTrashLedgerStore(
  storage: StorageLike | null,
  initial: TrashLedgerRead,
  coordination: TrashLedgerCoordination,
  options: TrashLedgerStoreOptions = {},
): TrashLedgerStore {
  const guard = options.guard ?? null;
  let readStatus: TrashLedgerStatus = coordination.supported ? initial.status : 'unavailable';
  let current: readonly TrashPendingRecord[] = initial.status === 'ok' ? initial.records : [];
  /** 页面级失效（R1.2.1-R1 / R2-01）：一旦为 true，本页不再跟随持久层，写操作全关。 */
  let invalidated = false;
  /** 保护记录是否已经读过（没有保护记录时视为立即就绪）。 */
  let guardReady = guard === null;

  const status = (): TrashLedgerStatus => {
    if (!coordination.supported) return 'unavailable';
    if (!guardReady) return 'initializing';
    if (invalidated) return 'invalidated';
    if (readStatus !== 'ok') return readStatus;
    return current.length >= MAX_TRASH_PENDING ? 'full' : 'ok';
  };

  const blockMessageText = (): string | null =>
    coordination.supported
      ? trashLedgerBlockMessage(status())
      : '当前浏览器没有提供跨标签页的数据协调能力（Web Locks），无法安全地记录「待核对」状态；为避免重复恢复，回收区的恢复操作暂时关闭。请使用较新的浏览器。';

  /** 缓存键用来判断"镜像是否真的变了"（记录数 ≤64，代价可忽略）。 */
  const signatureOf = (records: readonly TrashPendingRecord[]): string =>
    records.map((record) => recordKey(record)).join('|');

  /**
   * 合并两组记录，**只增不减**。
   *
   * 用于"外部写入"与"保护记录读取"：任何一层说某条还没结论，就不能因为另一层没有
   * 它就当作已经结清。结清只有一条合法路径：`release` / `reconcile` 拿到结论后
   * 显式移除，并把两层都写成新的集合。
   */
  const unionRecords = (
    base: readonly TrashPendingRecord[],
    extra: readonly TrashPendingRecord[],
  ): readonly TrashPendingRecord[] => {
    const seen = new Set(base.map((record) => recordKey(record)));
    const added = extra.filter((record) => !seen.has(recordKey(record)));
    return added.length === 0 ? base : [...base, ...added];
  };

  let version = 0;
  let publishedStatus: TrashLedgerStatus = status();
  let publishedSignature = signatureOf(current);
  let snapshotCache: TrashLedgerSnapshot = {
    status: publishedStatus,
    records: current,
    blockMessage: blockMessageText(),
    version,
  };
  const listeners = new Set<() => void>();

  const publish = (): boolean => {
    const nextStatus = status();
    const nextSignature = signatureOf(current);
    if (nextStatus === publishedStatus && nextSignature === publishedSignature) return false;
    publishedStatus = nextStatus;
    publishedSignature = nextSignature;
    version += 1;
    snapshotCache = { status: nextStatus, records: current, blockMessage: blockMessageText(), version };
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // 忽略：界面重画失败不应该反过来打断台账写路径
      }
    }
    return true;
  };

  /** 读保护记录：异常一律折算成 `unavailable`（调用方只需判断四态）。 */
  const readGuard = async (): Promise<TrashGuardRead> => {
    if (!guard) return { status: 'missing' };
    try {
      return await guard.read();
    } catch {
      return { status: 'unavailable' };
    }
  };

  /**
   * 把"失效"写进保护记录（R2.1-02）。
   *
   * 必须在锁内**重读**再合并：
   * - 另一个页面可能刚预留了新记录，本页的 `current` 是旧快照，直接写会把它抹掉；
   * - 读不到 / 读不懂时**一个字节都不写**：宁可少写一次，也不能拿过期快照覆盖持久层；
   * - 永远只写 `invalidated: true`，不存在"把失效写回正常"的分支；
   * - 合并后超过容量时不写（绝不淘汰未核对记录）。
   */
  const mergeInvalidationLocked = async (): Promise<void> => {
    if (!guard) return;
    const state = await readGuard();
    if (state.status === 'unavailable' || state.status === 'corrupt') return;
    const existing = state.status === 'valid' ? state.record.records : [];
    const merged = unionRecords(existing, current);
    // 内存先跟上耐久真相（即使这一笔不写，本页也不该比保护记录更旧）
    current = merged;
    if (merged.length > MAX_TRASH_PENDING) return;
    if (state.status === 'valid' && state.record.invalidated && merged.length === existing.length) return;
    try {
      await guard.write({ version: 1, records: merged, invalidated: true });
    } catch {
      // 忽略：内存标记已经生效，下次操作会再试
    }
  };

  const persistInvalidation = async (): Promise<void> => {
    if (!guard) return;
    try {
      // 锁是不可重入的：这里在锁外，可以自己取锁
      await coordination.runExclusive(() => mergeInvalidationLocked());
    } catch {
      // 忽略：同上
    }
  };

  /** 两层都写：保护记录先，主台账后；任一失败都不算"已保护"。 */
  const persist = async (next: readonly TrashPendingRecord[]): Promise<boolean> => {
    // 超过容量绝不写盘：写进去下次读会被判 corrupt，等于把所有人一起锁死
    if (next.length > MAX_TRASH_PENDING) return false;
    if (guard) {
      if (!(await guard.write({ version: 1, records: next, invalidated }))) return false;
    }
    return writeTrashLedger(storage, next);
  };

  /**
   * 初始化：读保护记录，并与主台账对账（R2-01）。
   *
   * 规则就是任务书那张表：
   * - 两层都没有 → 首次使用，写一份空保护记录；
   * - 主台账有、保护记录没有 → **迁移**（R1 升级），一条都不许丢；
   * - 保护记录有记录、主台账却是空/缺失 → 被外部删掉了 → `invalidated`；
   * - 主台账损坏 → 保持 fail-closed，只把保护记录里的记录读进内存；
   * - 保护记录读不出来 → `unavailable`。
   */
  const initFromGuard = async (): Promise<void> => {
    try {
      await coordination.runExclusive(async () => {
        const main = readTrashLedger(storage);
        readStatus = main.status;
        const state = await readGuard();
        if (state.status === 'unavailable') {
          readStatus = 'unavailable';
          return;
        }
        if (state.status === 'corrupt') {
          /*
           * 有数据但读不懂：**不许**当成"首次使用"去初始化一份新的空记录——
           * 那会把损坏的原始数据连同其中的待核对记录一起覆盖掉（R2.1-03）。
           */
          readStatus = 'corrupt';
          return;
        }
        if (state.status === 'missing') {
          // 首次使用（或 R1 台账）：把当前已知记录迁进保护记录
          if (readStatus !== 'ok') return;
          const ok = await guard!.write({ version: 1, records: current, invalidated: false });
          if (!ok) readStatus = 'unavailable';
          return;
        }
        const record = state.record;
        if (record.invalidated) invalidated = true;
        const mainRecords = main.status === 'ok' ? main.records : current;
        current = unionRecords(mainRecords, record.records);
        if (main.status === 'ok' && main.records.length === 0 && current.length > 0) {
          // 保护记录里还有待核对，主台账却是空的：被删掉了，不是"首次使用"
          invalidated = true;
          if (!record.invalidated) {
            await mergeInvalidationLocked();
          }
        }
      });
    } catch {
      readStatus = 'unavailable';
    } finally {
      guardReady = true;
      publish();
    }
  };

  let readyPromise: Promise<void> | null = null;
  const ensureReady = (): Promise<void> => {
    if (!guard) return Promise.resolve();
    if (!readyPromise) readyPromise = initFromGuard();
    return readyPromise;
  };

  /**
   * 锁内对账两层（所有写操作的公共前置）。
   *
   * 返回 false 表示"此刻无法证明安全"：读不到、读坏了、或者发现异常缺失。
   * **异常缺失**（保护记录里还有记录、主台账却是空）会当场落到 `invalidated`，
   * 这是 R2-03 要求的统一规则：三个写路径一视同仁。
   */
  const syncFromLayers = async (): Promise<boolean> => {
    /** null = 没有独立保护记录（单层模式）；否则就是保护记录里的记录。 */
    let guardRecords: readonly TrashPendingRecord[] | null = null;
    if (guard) {
      const state = await readGuard();
      if (state.status === 'unavailable') return false;
      if (state.status === 'corrupt') {
        // 读不懂就不写、不判"缺失"，整体 fail-closed（R2.1-03）
        readStatus = 'corrupt';
        return false;
      }
      if (state.status === 'valid') {
        current = unionRecords(current, state.record.records);
        if (state.record.invalidated) {
          /*
           * R2.1-01：持久化失效是**结论**，不是提示。
           * 之前这里只把内存标记翻成 true 就继续往下走，主台账仍有合法数据时
           * 还会 `return true`，于是 reserve 照常写盘并返回 reserved —— 等于授权。
           */
          invalidated = true;
          return false;
        }
        guardRecords = state.record.records;
      } else {
        // 保护记录还没有（R1 升级途中 / 被别人清掉）：不构成"缺失"的证据
        guardRecords = [];
      }
    }

    const main = readTrashLedger(storage);
    readStatus = main.status;
    if (main.status !== 'ok') return false;

    if (guardRecords !== null) {
      if (main.records.length === 0 && guardRecords.length === 0 && current.length > 0) {
        /*
         * 两层都空，本页却还记着：这是**另一页面正常结清**（它把两层都写成了空）。
         * 与"被删除"的区别就在这里——删除动不到保护记录。
         */
        current = [];
        return true;
      }
      if (main.records.length === 0 && guardRecords.length > 0) {
        // 保护记录里还有待核对，主台账却是空：异常缺失
        invalidated = true;
        current = unionRecords(current, guardRecords);
        await mergeInvalidationLocked();
        return false;
      }
      current = unionRecords(main.records, guardRecords);
      return true;
    }

    // 单层模式（R1 兼容）：主台账就是唯一真相
    if (main.records.length === 0 && current.length > 0) {
      invalidated = true;
      await mergeInvalidationLocked();
      return false;
    }
    current = main.records;
    return true;
  };

  // 自动开始初始化：Provider 不必记得调用，守卫就绪时会自己 publish 一次
  void ensureReady();

  return {
    status,
    records: () => current,
    snapshot: () => snapshotCache,
    blockMessage: blockMessageText,
    isInvalidated: () => invalidated,
    ready: ensureReady,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /**
     * 外部 `storage` 事件（R1.2.1-R1 / R2-02）。
     *
     * **只用事件自己携带的 `newValue`**：事件排队期间持久层可能又被改过一次，
     * 回读当前值会把"先写入"读成"已经删除"，从而先清空内存再进入失效。
     */
    applyExternalEvent(event) {
      if (event.key !== null && event.key !== TRASH_LEDGER_KEY) return false;
      if (!coordination.supported) return false;
      if (invalidated) return false;
      if (event.key === null || event.newValue === null) {
        invalidated = true;
        void persistInvalidation();
        return publish();
      }
      const parsed = parseTrashLedgerValue(event.newValue);
      if (parsed.status !== 'ok') {
        readStatus = parsed.status;
        return publish();
      }
      readStatus = 'ok';
      // 外部写入只做并集：别的页面少了一条，不能当成"已经结清"
      current = unionRecords(current, parsed.records);
      return publish();
    },

    refresh() {
      if (!coordination.supported || invalidated) return false;
      const parsed = readTrashLedger(storage);
      readStatus = parsed.status;
      if (parsed.status === 'ok') {
        if (parsed.records.length === 0 && current.length > 0) {
          invalidated = true;
          void persistInvalidation();
          return publish();
        }
        current = unionRecords(current, parsed.records);
      }
      return publish();
    },

    async reserve(record) {
      if (!coordination.supported) return { status: 'unavailable' };
      if (!parseTrashPendingRecord(record)) return { status: 'invalid' };
      await ensureReady();
      if (invalidated) return { status: 'unavailable' };
      let outcome: TrashReserveOutcome;
      try {
        outcome = await coordination.runExclusive(async (): Promise<TrashReserveOutcome> => {
          if (invalidated) return { status: 'unavailable' };
          if (!(await syncFromLayers())) return { status: 'unavailable' };
          const result = reserveTrashPending(current, record);
          if (result.status === 'exists') return { status: 'exists' };
          if (result.status === 'full') return { status: 'full' };
          if (!(await persist(result.records))) return { status: 'write-failed' };
          current = result.records;
          return { status: 'reserved' };
        });
      } catch {
        outcome = { status: 'unavailable' };
      }
      publish();
      return outcome;
    },

    async release(target) {
      if (!coordination.supported) return { status: 'unavailable' };
      await ensureReady();
      if (invalidated) return { status: 'unavailable' };
      let outcome: TrashMutationOutcome;
      try {
        outcome = await coordination.runExclusive(async (): Promise<TrashMutationOutcome> => {
          if (invalidated) return { status: 'unavailable' };
          if (!(await syncFromLayers())) return { status: 'unavailable' };
          const next = removeTrashPending(current, target);
          if (next === current) return { status: 'unchanged' };
          if (!(await persist(next))) return { status: 'write-failed' };
          current = next;
          return { status: 'changed' };
        });
      } catch {
        outcome = { status: 'unavailable' };
      }
      publish();
      return outcome;
    },

    async reconcile(input) {
      if (!coordination.supported) return { status: 'unavailable' };
      await ensureReady();
      if (invalidated) return { status: 'unavailable' };
      let outcome: TrashMutationOutcome;
      try {
        outcome = await coordination.runExclusive(async (): Promise<TrashMutationOutcome> => {
          if (invalidated) return { status: 'unavailable' };
          if (!(await syncFromLayers())) return { status: 'unavailable' };
          const next = reconcileTrashPending(current, input);
          if (next === current) return { status: 'unchanged' };
          if (!(await persist(next))) return { status: 'write-failed' };
          current = next;
          return { status: 'changed' };
        });
      } catch {
        outcome = { status: 'unavailable' };
      }
      publish();
      return outcome;
    },
  };
}
