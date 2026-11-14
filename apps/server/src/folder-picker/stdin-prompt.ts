/**
 * 终端交互式选择器（UX-02B-03 / ADR-021 §3.3）。
 *
 * 只用于"没有 GUI 但终端可交互"的环境：Host 在终端里向**本机操作者**索取一次路径。
 * 因此只有在 `stdin.isTTY === true` 时才有意义；非 TTY（管道/CI/被重定向）一律
 * 返回 `unavailable`，避免把"从管道读到的字符串"当成人工确认。
 *
 * 安全边界与 Windows 对话框一致：返回的路径仍要经过 `inspectProjectRoot()` 与
 * 重复/嵌套检查，才可能变成授权。
 *
 * **超时（UX-02B-03-R1）**：`PickOptions.timeoutMs` 必须真正生效。终端的"没人打字"
 * 是常态（用户走开了、进程被挂起），不能让它无限占用选择器单飞状态。超时语义：
 * - 立即返回 `{status:'timeout'}`，**不等待**迟到的输入；
 * - 同时 abort，让读行实现自己关掉 readline（移除 input 监听器），不留悬挂句柄；
 * - 迟到输入只落在已被丢弃的 promise 上，不可能再触发 addProject。
 */
import type { FolderPicker, PickOptions, PickOutcome } from './types.ts';

/**
 * 读一行。
 *
 * `signal` 用于取消：实现必须在 abort 后释放输入资源。返回值 `null` 表示
 * EOF/中断/读取失败（按取消处理）——但**超时判定权在 pick()**，不由实现决定，
 * 否则"读得太慢"与"用户取消"会被混为一谈。
 */
export type ReadLineImpl = (prompt: string, signal: AbortSignal) => Promise<string | null>;

/** 可注入的最小 readline 面（只为测试能断言"超时后确实关闭了"）。 */
export interface ReadlineLike {
  question(prompt: string): Promise<string>;
  close(): void;
}

export type ReadlineFactory = () => Promise<ReadlineLike>;

export type TimerHandle = unknown;

export interface StdinPickerOptions {
  /** 缺省读取 `process.stdin.isTTY`；测试可注入。 */
  readonly isTTY?: boolean;
  /** 测试可注入：返回 null 表示 EOF（视为取消）。 */
  readonly readLine?: ReadLineImpl;
  /** 测试可注入：默认动态 import `node:readline/promises`。 */
  readonly createInterface?: ReadlineFactory;
  /** 测试可注入时钟：默认 `setTimeout`。 */
  readonly setTimer?: (handler: () => void, timeoutMs: number) => TimerHandle;
  /** 测试可注入时钟：默认 `clearTimeout`。 */
  readonly clearTimer?: (handle: TimerHandle) => void;
  /** 提示语；不含路径，不含任何外部输入。 */
  readonly prompt?: string;
}

const DEFAULT_PROMPT = '请输入要添加的项目目录（直接回车取消）: ';

/** 默认 readline 工厂：唯一真实终端入口。 */
const defaultCreateInterface: ReadlineFactory = async () => {
  const { createInterface } = await import('node:readline/promises');
  return createInterface({ input: process.stdin, output: process.stdout });
};

/**
 * 默认读行实现：abort 时关闭 readline 并让 await 尽快结束。
 *
 * `rl.close()` 会移除挂在 `process.stdin` 上的 `data` / `keypress` 监听器，
 * 因此超时之后不会遗留输入监听器（否则进程可能因 stdin 未解除引用而不退出，
 * 且迟到的一行会被下一个对话框读到）。
 */
function makeReadLine(factory: ReadlineFactory): ReadLineImpl {
  return async (prompt, signal) => {
    if (signal.aborted) return null;
    const rl = await factory();
    const onAbort = (): void => {
      try {
        rl.close();
      } catch {
        /* 已经关闭：幂等 */
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await rl.question(prompt);
    } catch {
      return null;
    } finally {
      signal.removeEventListener('abort', onAbort);
      try {
        rl.close();
      } catch {
        /* 已经关闭：幂等 */
      }
    }
  };
}

export function createStdinFolderPicker(options: StdinPickerOptions = {}): FolderPicker {
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
  const readLine = options.readLine ?? makeReadLine(options.createInterface ?? defaultCreateInterface);
  const setTimer =
    options.setTimer ?? ((handler: () => void, ms: number): TimerHandle => setTimeout(handler, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: TimerHandle): void => clearTimeout(handle as NodeJS.Timeout));
  const prompt = options.prompt ?? DEFAULT_PROMPT;

  return {
    kind: 'stdin-prompt',
    async pick({ timeoutMs }: PickOptions): Promise<PickOutcome> {
      if (!isTTY) {
        return { status: 'unavailable', detail: 'stdin 不是交互式终端' };
      }

      // 负数/NaN/Infinity 一律按"立即超时"处理，避免 setTimeout 的隐式 1ms 语义
      const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
      const controller = new AbortController();
      let timedOut = false;
      let handle: TimerHandle;

      // race：谁先落定谁说了算。超时分支**先**置标记再 resolve，因此即使读行实现
      // 在同一 tick 内返回，也不会被误判成 picked。
      const answered = new Promise<{ value: string | null; timedOut: boolean }>((resolve) => {
        handle = setTimer(() => {
          timedOut = true;
          // 先中止（关掉 readline / 移除监听器），再结束等待；迟到的输入无人接收。
          controller.abort();
          resolve({ value: null, timedOut: true });
        }, limit);
        readLine(prompt, controller.signal).then(
          (value) => resolve({ value, timedOut: false }),
          () => resolve({ value: null, timedOut: false }),
        );
      });

      let result: { value: string | null; timedOut: boolean };
      try {
        result = await answered;
      } finally {
        clearTimer(handle!);
      }

      if (timedOut || result.timedOut) return { status: 'timeout' };
      const answer = result.value;
      if (answer === null || answer.trim() === '') return { status: 'cancelled' };
      return { status: 'picked', folder: { absolutePath: answer.trim() } };
    },
  };
}
