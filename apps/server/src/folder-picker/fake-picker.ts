/**
 * 测试专用选择器（UX-02B-03）。
 *
 * **生产代码不得 import 本文件**：`folder-picker/index.ts` 的工厂里没有它的分支，
 * Host 也无法通过启动参数启用它。唯一入口是测试显式构造后传给
 * `createShellServer({ managedStore: { picker } })`。
 *
 * 它存在的意义是把"用户点了确定/取消"这一外部事件变成可编程序列，从而确定性地
 * 复现 S-01…S-16；它**不能**作为 Windows 真实弹窗的替代证据。
 */
import type { FolderPicker, PickOutcome } from './types.ts';

export interface FakePicker extends FolderPicker {
  readonly kind: 'fake';
  /** 被调用次数：用于断言"拒绝时根本没弹对话框"。 */
  readonly calls: number;
}

/** 按顺序返回预置结局；用完后重复最后一个。 */
export function createFakePicker(outcomes: readonly PickOutcome[]): FakePicker {
  const queue = [...outcomes];
  let calls = 0;
  const last: PickOutcome = outcomes.at(-1) ?? { status: 'cancelled' };
  return {
    kind: 'fake',
    get calls() {
      return calls;
    },
    async pick() {
      calls += 1;
      return queue.length > 0 ? (queue.shift() as PickOutcome) : last;
    },
  };
}

export interface DeferredFakePicker extends FakePicker {
  /** 等待第 n 次调用已发生（测试用来制造"对话框还开着"的确定状态）。 */
  waitForCall(): Promise<void>;
  /** 结束当前（最后一次）调用。 */
  resolve(outcome: PickOutcome): void;
}

/** 永远不自己返回的选择器：用来制造并发/重启场景。 */
export function createDeferredFakePicker(): DeferredFakePicker {
  let calls = 0;
  let pending: ((outcome: PickOutcome) => void) | undefined;
  const waiters: Array<() => void> = [];
  return {
    kind: 'fake',
    get calls() {
      return calls;
    },
    pick() {
      calls += 1;
      for (const waiter of waiters.splice(0)) waiter();
      return new Promise<PickOutcome>((resolve) => {
        pending = resolve;
      });
    },
    waitForCall() {
      if (calls > 0 && pending) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    resolve(outcome) {
      const settle = pending;
      pending = undefined;
      settle?.(outcome);
    },
  };
}
