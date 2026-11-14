/**
 * Windows 系统目录选择器（UX-02B-03 / ADR-021 §3.4）。
 *
 * 进程调用规则（不可放宽）：
 * - `child_process.execFile`，**不是** `exec`；
 * - 固定参数数组、`shell: false`、`windowsHide: true`；
 * - 脚本是**代码内常量**，不含任何用户输入插值（不拼接路径、不拼接名称）；
 * - `timeout` + `maxBuffer` 双限制，避免对话框挂死或输出爆量。
 *
 * 为什么用 `-Command` 而不是临时 `.ps1`：临时文件会引入"脚本内容可被替换"的
 * 中间态，还要处理执行策略与编码；常量脚本没有这些面。
 *
 * 输出编码：`SelectedPath` 先 UTF-8 字节再 Base64，规避控制台代码页导致的
 * 非 ASCII 路径乱码（中文目录名是常态）。
 */
import { execFile } from 'node:child_process';
import type { FolderPicker, PickOutcome } from './types.ts';

/**
 * 固定脚本（**不得**插值任何外部输入）。
 *
 * 退出码语义：0 = 已选择；1 = 用户取消；2 = 选择器异常。
 */
const PICK_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  Add-Type -AssemblyName System.Windows.Forms | Out-Null',
  '  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  "  $dialog.Description = 'Select a folder to add to WeaveSpace'",
  '  $dialog.ShowNewFolderButton = $false',
  '  $result = $dialog.ShowDialog()',
  '  if ($result -ne [System.Windows.Forms.DialogResult]::OK) { exit 1 }',
  '  $bytes = [System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)',
  '  [Console]::Out.Write([Convert]::ToBase64String($bytes))',
  '  exit 0',
  '} catch {',
  '  exit 2',
  '}',
].join('\n');

export interface ExecFileOptions {
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly windowsHide: boolean;
  readonly encoding: 'utf8';
  readonly shell: false;
}

export type ExecFileImpl = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
) => Promise<{ readonly stdout: string }>;

/** 默认实现：唯一真实进程入口。测试通过注入替换，**不**在生产可配置。 */
const defaultExecFile: ExecFileImpl = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], options, (err, stdout) => {
      if (err) {
        reject(Object.assign(err, { stdout: typeof stdout === 'string' ? stdout : '' }));
        return;
      }
      resolve({ stdout: typeof stdout === 'string' ? stdout : '' });
    });
  });

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** 把 stdout 的 Base64 解成路径；不合法返回 undefined（绝不"猜"一个路径）。 */
export function decodePickedPath(stdout: string): string | undefined {
  const text = stdout.trim();
  if (text === '') return undefined;
  if (!BASE64_RE.test(text) || text.length % 4 !== 0) return undefined;
  const decoded = Buffer.from(text, 'base64').toString('utf8');
  if (decoded.trim() === '' || decoded.includes('\0')) return undefined;
  return decoded;
}

export interface WindowsPickerOptions {
  /** 仅测试：替换进程调用。生产不传。 */
  readonly execFileImpl?: ExecFileImpl;
  /** 默认 `powershell.exe`（PATH 解析），不接受调用方传任意可执行文件。 */
  readonly powershellPath?: string;
}

export function createWindowsFolderPicker(options: WindowsPickerOptions = {}): FolderPicker {
  const run = options.execFileImpl ?? defaultExecFile;
  const exe = options.powershellPath ?? 'powershell.exe';

  return {
    kind: 'windows-powershell',
    async pick({ timeoutMs }): Promise<PickOutcome> {
      const args = [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        PICK_SCRIPT,
      ];
      let stdout: string;
      try {
        const result = await run(exe, args, {
          timeout: timeoutMs,
          maxBuffer: 64_000,
          windowsHide: true,
          encoding: 'utf8',
          shell: false,
        });
        stdout = result.stdout;
      } catch (err) {
        const raw = err as { killed?: boolean; code?: unknown };
        if (raw.killed === true) return { status: 'timeout' };
        if (raw.code === 1) return { status: 'cancelled' };
        if (raw.code === 'ENOENT') {
          return { status: 'unavailable', detail: '找不到 powershell.exe' };
        }
        // 退出码 2、非零数字、被信号杀死、其它异常：一律"不可用"，绝不当成已选择
        return { status: 'unavailable', detail: `选择器进程失败（code=${String(raw.code ?? 'unknown')}）` };
      }

      const picked = decodePickedPath(stdout);
      if (!picked) return { status: 'unavailable', detail: '选择器没有返回可解析的路径' };
      return { status: 'picked', folder: { absolutePath: picked } };
    },
  };
}

/** 仅供测试断言脚本形态：确认参数固定且不含插值占位。 */
export const PICK_SCRIPT_SOURCE = PICK_SCRIPT;
