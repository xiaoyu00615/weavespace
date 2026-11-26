/**
 * 回收区「待核对」台账的**独立持久化保护记录**（UX-02C-03-P2-02-R1.2.1-R2）。
 *
 * 为什么需要第二层：主台账存在 `localStorage` 里，任何页面都能 `removeItem` 或
 * `clear()` 把它抹掉，抹掉之后读回来与"首次使用的空台账"完全同形。只靠主台账，
 * 刷新一次就等于把 UNKNOWN 重新开放——这正是 R2 要堵的洞。
 *
 * 这一层用 IndexedDB（同源、按 origin 隔离、与 localStorage 的清除路径不同）：
 * - `records`：已经确认写入、还没有结论的待核对记录（耐久真相）；
 * - `invalidated`：本机台账曾被外部删除 / 清空，恢复必须保持关闭。
 *
 * 纪律：
 * 1. 写入顺序是**保护记录先、主台账后**：只有保护记录落盘，才可能授权 POST；
 * 2. 保护记录读不出来 → 上层按 `unavailable` 处理（fail-closed），绝不猜；
 * 3. 这里只负责"存/取"，不做业务判断（判断在 `trash-ledger.ts` 的 store 里）。
 */
import { parseTrashPendingRecord, type TrashPendingRecord } from './trash-ledger.ts';

export const TRASH_GUARD_VERSION = 1 as const;
/** 固定库名 + 表名：同源所有标签页共用同一份保护记录。 */
export const TRASH_GUARD_DB = 'weavespace-trash-guard-v1';
export const TRASH_GUARD_STORE = 'guard';
const TRASH_GUARD_KEY = 'current';

export interface TrashGuardRecord {
  readonly version: 1;
  readonly records: readonly TrashPendingRecord[];
  /** true = 主台账曾被外部删除 / 清空；此标记一旦落盘，重开页面也不解除。 */
  readonly invalidated: boolean;
}

/** 保护记录的存取接口（浏览器用 IndexedDB，测试用内存假件）。 */
export interface TrashGuardStorage {
  read(): Promise<TrashGuardRecord | null>;
  write(record: TrashGuardRecord): Promise<boolean>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 解析保护记录；任何一项不符都返回 null（调用方按"读不懂"处理，不猜）。
 *
 * 与主台账同一套记录校验（`parseTrashPendingRecord`），避免两层对"什么是一条合法
 * 待核对记录"有不同口径。
 */
export function decodeTrashGuard(raw: unknown): TrashGuardRecord | null {
  const row = asRecord(raw);
  if (!row) return null;
  if (row.version !== TRASH_GUARD_VERSION) return null;
  if (typeof row.invalidated !== 'boolean') return null;
  if (!Array.isArray(row.records)) return null;
  const records: TrashPendingRecord[] = [];
  const seen = new Set<string>();
  for (const item of row.records) {
    const parsed = parseTrashPendingRecord(item);
    if (!parsed) return null;
    const key = `${parsed.workspaceKey}\u0000${parsed.projectId}\u0000${parsed.opId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(parsed);
  }
  return { version: TRASH_GUARD_VERSION, records, invalidated: row.invalidated };
}

/** IndexedDB 的最小形状（不引入 DOM 类型依赖，也便于测试注入）。 */
interface IdbRequestLike<T> {
  readonly result: T;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}
interface GuardObjectStoreLike {
  get(key: string): IdbRequestLike<unknown>;
  put(value: unknown, key: string): IdbRequestLike<unknown>;
}
interface IdbTransactionLike {
  objectStore(name: string): GuardObjectStoreLike;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}
interface IdbDatabaseLike {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(name: string, mode: 'readonly' | 'readwrite'): IdbTransactionLike;
  close(): void;
}
interface IdbFactoryLike {
  open(name: string, version?: number): {
    readonly result: IdbDatabaseLike;
    onupgradeneeded: (() => void) | null;
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
    onblocked: (() => void) | null;
  };
}

/**
 * 浏览器实现：一条记录存在专用库里。
 *
 * 库版本固定为 1，只建一个 `guard` 表；升级策略是"新版本换库名"，与台账锁同名同思路——
 * 不复用旧结构，避免两个版本的标签页互相覆盖语义。
 */
export function createIndexedDbGuardStorage(factory?: IdbFactoryLike | null): TrashGuardStorage {
  const scope = globalThis as { indexedDB?: IdbFactoryLike };
  const idb = factory ?? scope.indexedDB ?? null;

  let opening: Promise<IdbDatabaseLike> | null = null;

  const open = (): Promise<IdbDatabaseLike> => {
    if (opening) return opening;
    opening = new Promise<IdbDatabaseLike>((resolve, reject) => {
      if (!idb) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      let request: ReturnType<IdbFactoryLike['open']>;
      try {
        request = idb.open(TRASH_GUARD_DB, 1);
      } catch (err) {
        reject(err);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(TRASH_GUARD_STORE)) db.createObjectStore(TRASH_GUARD_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('IndexedDB open failed'));
      request.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
    // 打开失败不要缓存失败结果：下一次操作允许重试
    opening.catch(() => {
      opening = null;
    });
    return opening;
  };

  /** 在一个事务里跑完：事务 `complete` 才算成功（`put` 的回调早于真正落盘）。 */
  const withStore = async <T>(
    mode: 'readonly' | 'readwrite',
    run: (store: GuardObjectStoreLike) => { request: IdbRequestLike<unknown>; map?: (value: unknown) => T },
  ): Promise<T> => {
    const db = await open();
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      let result: T;
      let tx: IdbTransactionLike;
      try {
        tx = db.transaction(TRASH_GUARD_STORE, mode);
      } catch (err) {
        reject(err);
        return;
      }
      const { request, map } = run(tx.objectStore(TRASH_GUARD_STORE));
      request.onsuccess = () => {
        result = map ? map(request.result) : (request.result as T);
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        reject(new Error(message));
      };
      request.onerror = () => fail('IndexedDB request failed');
      tx.onerror = () => fail('IndexedDB transaction failed');
      tx.onabort = () => fail('IndexedDB transaction aborted');
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
    });
  };

  return {
    async read() {
      const raw = await withStore<unknown>('readonly', (store) => ({ request: store.get(TRASH_GUARD_KEY) }));
      if (raw === undefined || raw === null) return null;
      return decodeTrashGuard(raw);
    },
    async write(record) {
      try {
        await withStore<unknown>('readwrite', (store) => ({
          request: store.put({ ...record, version: TRASH_GUARD_VERSION }, TRASH_GUARD_KEY),
        }));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * 存储不可用时的替身：读必定失败 → 上层判 `unavailable`（恢复整体关闭）。
 *
 * 用于"浏览器没有 IndexedDB / 被策略禁用"：**不能**退回 R1 的"只有主台账"。
 */
export function createUnavailableGuardStorage(reason = 'IndexedDB unavailable'): TrashGuardStorage {
  return {
    read: () => Promise.reject(new Error(reason)),
    write: () => Promise.resolve(false),
  };
}
