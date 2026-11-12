/**
 * 编辑请求串行队列（S9-B）。
 *
 * 问题：编辑器每次按键都发一次 applyEdit，HTTP 响应顺序不保证；若让「旧响应」覆盖
 * 新输入，或让多个请求并发乱序到达 Core，缓冲就会回退。
 *
 * 规则（与 docs 的 DATA-002 一致：Core 是权威，UI 不得伪造）：
 * - **同一时刻最多一个在途请求**，因此请求到达 Core 的顺序 == 用户输入顺序；
 * - 在途期间产生的新输入只保留**最新一份**（中间态无意义，Core 只关心最终缓冲）；
 * - 队列不把服务端返回的内容写回编辑器，因此不存在「回填覆盖用户输入」的路径；
 * - `flush()` 用于保存前确认所有编辑都已提交。
 */

export interface EditQueue {
  /** 提交一份新缓冲（同步返回，内部串行发送）。 */
  schedule(text: string): void;
  /** 等待当前及排队的编辑全部完成。 */
  flush(): Promise<void>;
  /** 是否仍有在途或排队中的编辑。 */
  pending(): boolean;
  /** 最近一次 apply 的错误（供调用方展示；成功后清空）。 */
  lastError(): unknown;
}

export function createEditQueue<T>(apply: (text: string) => Promise<T>): EditQueue {
  let inflight = false;
  let next: string | null = null;
  let lastError: unknown = null;
  let waiters: Array<() => void> = [];

  const settleWaiters = (): void => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
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
          lastError = null;
        } catch (err) {
          // 单个编辑失败不终止队列（后续输入仍需提交），错误留给调用方读取
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
    flush(): Promise<void> {
      if (!queue.pending()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    lastError(): unknown {
      return lastError;
    },
  };

  return queue;
}
