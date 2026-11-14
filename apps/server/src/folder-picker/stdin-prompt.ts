/**
 * 终端交互式选择器（UX-02B-03 / ADR-021 §3.3）。
 *
 * 只用于"没有 GUI 但终端可交互"的环境：Host 在终端里向**本机操作者**索取一次路径。
 * 因此只有在 `stdin.isTTY === true` 时才有意义；非 TTY（管道/CI/被重定向）一律
 * 返回 `unavailable`，避免把"从管道读到的字符串"当成人工确认。
 *
 * 安全边界与 Windows 对话框一致：返回的路径仍要经过 `inspectProjectRoot()` 与
 * 重复/嵌套检查，才可能变成授权。
 */
import type { FolderPicker, PickOutcome } from './types.ts';

export type ReadLineImpl = (prompt: string) => Promise<string | null>;

export interface StdinPickerOptions {
  /** 缺省读取 `process.stdin.isTTY`；测试可注入。 */
  readonly isTTY?: boolean;
  /** 测试可注入：返回 null 表示 EOF（视为取消）。 */
  readonly readLine?: ReadLineImpl;
}

/** 默认读一行：仅在 TTY 上可用，EOF/中断按取消处理。 */
async function defaultReadLine(prompt: string): Promise<string | null> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(prompt);
    return answer;
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

export function createStdinFolderPicker(options: StdinPickerOptions = {}): FolderPicker {
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
  const readLine = options.readLine ?? defaultReadLine;

  return {
    kind: 'stdin-prompt',
    async pick(): Promise<PickOutcome> {
      if (!isTTY) {
        return { status: 'unavailable', detail: 'stdin 不是交互式终端' };
      }
      const answer = await readLine('请输入要添加的项目目录（直接回车取消）: ');
      if (answer === null || answer.trim() === '') return { status: 'cancelled' };
      return { status: 'picked', folder: { absolutePath: answer.trim() } };
    },
  };
}
