/**
 * 编辑请求串行队列（S9-B）。
 *
 * 问题：编辑器每次按键都发一次 applyEdit，HTTP 响应顺序不保证；若让「旧响应」覆盖
 * 新输入，或让多个请求并发乱序到达 Core，缓冲就会回退。
 *
 * 规则（与 DATA-002 一致：Core 是权威，UI 不得伪造）：
 * - **同一时刻最多一个在途请求**，因此到达 Core 的顺序 == 用户输入顺序；
 * - 在途期间产生的新输入只保留**最新一份**（中间态无意义，Core 只关心最终缓冲）；
 * - 队列不把服务端返回的内容写回编辑器，因此不存在「回填覆盖用户输入」的路径；
 * - **失败必须能被保存流程看见**：`apply` 一旦抛错（业务拒绝或网络异常），
 *   `flush()` 返回 `ok:false`，调用方不得据此认为草稿已同步（S9B-F01）。
 */

/** `flush()` 的结论：是否「最新草稿已成功落到 Core」。 */
export type EditFlushResult =
  | { ok: true; lastSynced: string }
  | { ok: false; error: unknown; lastSynced: string | null };

export interface EditQueue {
  /** 提交一份新缓冲（同步返回，内部串行发送）。 */
  schedule(text: string): void;
  /** 等待当前及排队的编辑完成，并报告最终是否同步成功。 */
  flush(): Promise<EditFlushResult>;
  /** 是否仍有在途或排队中的编辑。 */
  pending(): boolean;
  /** 最近一次 apply 的错误（成功后清空）。 */
  lastError(): unknown;
  /** 最后一次**成功**同步到 Core 的缓冲；从未成功时为 null。 */
  lastSynced(): string | null;
}

/**
 * `apply` 必须以「抛错」表达失败（业务拒绝 / 网络异常）：
 * 队列无法从返回值判断业务成败，因此要求调用方显式区分。
 */
export function createEditQueue<T>(apply: (text: string) => Promise<T>): EditQueue {
  let inflight = false;
  let next: string | null = null;
  let lastError: unknown = null;
  let synced: string | null = null;
  let waiters: Array<(result: EditFlushResult) => void> = [];

  const snapshot = (): EditFlushResult =>
    lastError === null && synced !== null
      ? { ok: true, lastSynced: synced }
      : { ok: false, error: lastError, lastSynced: synced };

  const settleWaiters = (): void => {
    const pending = waiters;
    waiters = [];
    const value = snapshot();
    for (const resolve of pending) resolve(value);
  };

  const drain = async (): Promise<void> => {
    if (inflight) return;
    inflight = true;
    try {
      while (next !== null) {
        const text = next;
        next = null;
        try {
          await apply(text);
          // 只有成功才推进「已同步」指针；失败保留旧值，便于调用方发现落后
          synced = text;
          lastError = null;
        } catch (err) {
          // 单个编辑失败不终止队列（后续输入仍需提交），但必须留下失败状态
          lastError = err;
        }
      }
    } finally {
      inflight = false;
      settleWaiters();
    }
  };

  const queue: EditQueue = {
    schedule(text: string): void {
      next = text;
      void drain();
    },
    pending(): boolean {
      return inflight || next !== null;
    },
    flush(): Promise<EditFlushResult> {
      if (!queue.pending()) return Promise.resolve(snapshot());
      return new Promise<EditFlushResult>((resolve) => {
        waiters.push(resolve);
      });
    },
    lastError(): unknown {
      return lastError;
    },
    lastSynced(): string | null {
      return synced;
    },
  };

  return queue;
}

/**
 * 确认「当前编辑器缓冲」已经同步到 Core。
 *
 * `flush()` 只保证**排队时**的草稿已处理；若期间又出现新输入，需要再提交一次最新缓冲。
 * 这里做「最多两轮」的收敛：仍不一致就返回失败，由保存流程阻止写盘
 * （绝不能把旧内容写盘后把新草稿标记成已保存）。
 */
export async function flushLatest(queue: EditQueue, latest: string): Promise<EditFlushResult> {
  const first = await queue.flush();
  if (first.ok && first.lastSynced === latest) return first;

  if (first.ok || queue.lastSynced() !== null) {
    queue.schedule(latest);
    const second = await queue.flush();
    if (second.ok && second.lastSynced === latest) return second;
    return {
      ok: false,
      error: second.ok ? new Error('最终缓冲尚未同步到 Core') : second.error,
      lastSynced: queue.lastSynced(),
    };
  }

  return first;
}
