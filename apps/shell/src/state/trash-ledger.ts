/**
 * 回收区「待核对」记录的跨重启台账（UX-02C-03-P2-02-R1.1）。
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
 */
import type { TrashEntryDto } from '../client/client-api.ts';
import { TRASH_TERMINAL_STATES } from './types.ts';
import type { StorageLike } from './workspace-persistence.ts';

export const TRASH_LEDGER_VERSION = 1 as const;
/** 独立命名空间：与 `ws:workspace:v1:*` 分开，互不影响解析与清理。 */
export const TRASH_LEDGER_KEY = 'ws:trash-pending:v1';
/** 体量护栏：这是"待核对"清单，不是历史记录；超过上限说明有人手工改过。 */
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
  /** 仅诊断用（用于按时间淘汰），不参与任何判定。 */
  readonly createdAt: string;
}

export type TrashLedgerStatus = 'ok' | 'corrupt' | 'unavailable';

export type TrashLedgerRead =
  | { readonly status: 'ok'; readonly records: readonly TrashPendingRecord[] }
  /** 解析不了 / 版本不认识 / 字段非法 / 超限：**不采用**，由调用方 fail-closed。 */
  | { readonly status: 'corrupt' }
  /** 没有存储能力（隐私模式、策略禁用）：读不到也就无法证明"没有待核对"。 */
  | { readonly status: 'unavailable' };

/** 两种非 ok 状态都必须让恢复保持关闭，文案区分原因，处理方式相同。 */
export function trashLedgerBlockMessage(status: TrashLedgerStatus): string | null {
  if (status === 'ok') return null;
  return status === 'corrupt'
    ? '本机的「待核对」记录已损坏，为避免重复恢复，回收区的恢复操作暂时关闭。请在浏览器设置里清除本应用的数据后再试。'
    : '本机存储不可用，无法记录「待核对」状态；为避免重复恢复，回收区的恢复操作暂时关闭。';
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

/** 写入；返回 false 表示"这次没能落盘"（调用方必须让用户知道保护已降级）。 */
export function writeTrashLedger(storage: StorageLike | null, records: readonly TrashPendingRecord[]): boolean {
  if (!storage) return false;
  try {
    storage.setItem(TRASH_LEDGER_KEY, encodeTrashLedger(records));
    return true;
  } catch {
    return false;
  }
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

/** 追加一条（已存在则不重复）；超过上限按创建时间淘汰最旧的。 */
export function addTrashPending(
  records: readonly TrashPendingRecord[],
  record: TrashPendingRecord,
): readonly TrashPendingRecord[] {
  const key = recordKey(record);
  if (records.some((item) => recordKey(item) === key)) return records;
  const next = [...records, record];
  return next.length > MAX_TRASH_PENDING ? next.slice(next.length - MAX_TRASH_PENDING) : next;
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
