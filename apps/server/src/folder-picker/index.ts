/**
 * FolderPicker 唯一生产入口（UX-02B-03）。
 *
 * 平台 → 适配器：
 * - Windows：`windows-powershell`（系统 FolderBrowserDialog，ADR-021 §3.4）；
 * - 非 Windows 且终端可交互：`stdin-prompt`；
 * - 其余：`unavailable`（**fail-closed**，绝不退化成"网页里输入路径"）。
 *
 * 本文件**不** import fake 适配器：生产构建里不存在"假选择器"这条路径。
 */
import { createStdinFolderPicker } from './stdin-prompt.ts';
import { createWindowsFolderPicker, type ExecFileImpl } from './windows-powershell.ts';
import { createUnavailablePicker, type FolderPicker } from './types.ts';

export interface HostPickerOptions {
  readonly platform?: NodeJS.Platform;
  readonly stdinIsTTY?: boolean;
  /** 仅测试：替换进程调用（真实对话框需要人工验证，见报告）。 */
  readonly execFileImpl?: ExecFileImpl;
}

export function createHostFolderPicker(options: HostPickerOptions = {}): FolderPicker {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    return createWindowsFolderPicker(
      options.execFileImpl ? { execFileImpl: options.execFileImpl } : {},
    );
  }
  const stdinIsTTY = options.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  if (stdinIsTTY) return createStdinFolderPicker({ isTTY: true });
  return createUnavailablePicker(
    '当前环境没有可用的目录选择器（非 Windows 且终端不可交互），请改用 --workspace 静态配置',
  );
}

export { createStdinFolderPicker, createWindowsFolderPicker, createUnavailablePicker };
/** 仅用于测试断言"脚本是常量、参数固定"：生产代码不需要读这两个值。 */
export { PICK_SCRIPT_SOURCE, decodePickedPath } from './windows-powershell.ts';
export type { ExecFileImpl } from './windows-powershell.ts';
export type { FolderPicker, PickOutcome, PickedFolder, PickerKind } from './types.ts';
