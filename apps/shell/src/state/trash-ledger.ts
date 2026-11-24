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
 * R1.2 起台账是一个**同步、单一真相**的小 store（`createTrashLedgerStore`）：
 * React 的 `setState` 是异步批处理的，若每次追加都从渲染快照起算，两条 UNKNOWN 在
 * 同一次提交里到达时，后一条会基于旧快照把前一条覆盖掉。因此"当前记录"只存在于
 * store 内部的 `current`，调用方读到的永远是**写入后**的最新值。
 */
import type { TrashEntryDto } from '../client/client-api.ts';
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
export type TrashLedgerStatus = 'ok' | 'full' | 'corrupt' | 'unavailable';

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
  return '本机存储不可用，无法记录「待核对」状态；为避免重复恢复，回收区的恢复操作暂时关闭。';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseRecord(raw: unknown): TrashPendingRecord | null {
  const row = asRecord(raw);
  if (!row) return null;
  const { workspaceKey, projectId, opId, createdAt } = row;
  if (typeof workspaceKey !== 'string' || !WORKSPACE_KEY_RE.test(workspaceKey)) return null;
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return null;
  if (typeof opId !== 'string' || !OP_ID_RE.test(opId)) return null;
  if (typeof createdAt !== 'string' || createdAt.length > 40) return null;
  if (Number.isNaN(Date.parse(createdAt))) return null;
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
  if (raw === null) return { status: 'ok', records: [] };
  if (raw.length > MAX_TRASH_LEDGER_BYTES) return { status: 'corrupt' };
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
    const record = parseRecord(item);
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
  if (encoded.length > MAX_TRASH_LEDGER_BYTES) return false;
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
/* 原子 store：唯一的同步真相                                            */
/* ================================================================== */

export type TrashReserveOutcome =
  | { readonly status: 'reserved' }
  /** 已经有了（重复预留 / 重试）：可以继续，不需要再写一次。 */
  | { readonly status: 'exists' }
  | { readonly status: 'full' }
  | { readonly status: 'unavailable' }
  /** 记录形状非法（例如工作区键不是 Host 的摘要格式）：绝不写进台账。 */
  | { readonly status: 'invalid' }
  /**
   * 落盘失败：内存里的这次追加已**回滚**。没有持久化保护就不能发副作用请求——
   * 否则页面一关，这次恢复就从账本上消失了。
   */
  | { readonly status: 'write-failed' };

export type TrashMutationOutcome =
  /** 内存与存储都已更新。 */
  | { readonly status: 'changed' }
  | { readonly status: 'unchanged' }
  /** 内存已更新，但落盘失败：本次会话内有效，重启后可能回到旧台账（安全方向）。 */
  | { readonly status: 'write-failed' }
  /** 读都读不了：不写，避免覆盖未知内容。 */
  | { readonly status: 'unavailable' };

export interface TrashLedgerStore {
  /** 当前状态（含容量用尽）。 */
  status(): TrashLedgerStatus;
  records(): readonly TrashPendingRecord[];
  /** 非空 = 此刻不能恢复；文案已可直接展示。 */
  blockMessage(): string | null;
  reserve(record: TrashPendingRecord): TrashReserveOutcome;
  release(target: { workspaceKey: string; projectId: string; opIds: readonly string[] }): TrashMutationOutcome;
  reconcile(input: {
    workspaceKey: string | null;
    projectId: string | null;
    entries: readonly TrashEntryDto[];
    loaded: boolean;
  }): TrashMutationOutcome;
}

/**
 * 建一个台账 store。
 *
 * `current` 是唯一真相：`reserve` / `release` / `reconcile` 都在它上面同步串行地算，
 * 因此"同一 tick 连续两条 UNKNOWN"不会互相覆盖（React 的渲染快照根本不参与决策）。
 * `initial` 读失败时（corrupt / unavailable）**永不写盘**：原字节留着才有机会修复。
 */
export function createTrashLedgerStore(
  storage: StorageLike | null,
  initial: TrashLedgerRead,
): TrashLedgerStore {
  const readStatus: TrashLedgerStatus = initial.status;
  let current: readonly TrashPendingRecord[] = initial.status === 'ok' ? initial.records : [];

  const status = (): TrashLedgerStatus => {
    if (readStatus !== 'ok') return readStatus;
    return current.length >= MAX_TRASH_PENDING ? 'full' : 'ok';
  };

  const commit = (next: readonly TrashPendingRecord[]): boolean => {
    current = next;
    if (readStatus !== 'ok') return false;
    return writeTrashLedger(storage, next);
  };

  return {
    status,
    records: () => current,
    blockMessage: () => trashLedgerBlockMessage(status()),

    reserve(record) {
      if (readStatus !== 'ok') return { status: 'unavailable' };
      // 写进去就读不回来的记录（键格式非法）一律拒绝：否则下次启动会整份判 corrupt
      if (!parseRecord(record)) return { status: 'invalid' };
      const result = reserveTrashPending(current, record);
      if (result.status === 'full') return { status: 'full' };
      if (result.status === 'exists') return { status: 'exists' };
      const before = current;
      if (!commit(result.records)) {
        // 回滚：没落盘就等于没有保护，不能假装成功
        current = before;
        return { status: 'write-failed' };
      }
      return { status: 'reserved' };
    },

    release(target) {
      if (readStatus !== 'ok') return { status: 'unavailable' };
      const next = removeTrashPending(current, target);
      if (next === current) return { status: 'unchanged' };
      /*
       * 释放与预留的失败语义不同：这里是"结论已经有了"（终态 / 明确拒绝），
       * 内存解除是安全的；落盘失败只会让重启后多拦一次，方向安全。
       */
      return commit(next) ? { status: 'changed' } : { status: 'write-failed' };
    },

    reconcile(input) {
      if (readStatus !== 'ok') return { status: 'unavailable' };
      const next = reconcileTrashPending(current, input);
      if (next === current) return { status: 'unchanged' };
      return commit(next) ? { status: 'changed' } : { status: 'write-failed' };
    },
  };
}
