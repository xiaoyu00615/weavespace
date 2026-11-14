/**
 * S11-UX-02B-03：选择器适配器契约（ADR-021 §3.3 / §3.4）。
 *
 * 为什么单列一套：真实系统对话框需要人在桌面上点"确定"，自动化会话无法提供，
 * 也无法在此沙箱里拉起外部进程（安全策略拦截）。因此这里把**可以确定的事实**
 * 全部钉死：
 * - 进程调用形态（execFile、固定参数数组、shell:false、无插值）；
 * - 退出码/异常 → picked / cancelled / unavailable / timeout 的映射；
 * - 非 TTY、非 Windows 一律 fail-closed（绝不退化成"网页输入路径"）。
 *
 * 这些断言**不能**替代"真实弹窗成功"的证据；报告里明确标注未验证。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHostFolderPicker,
  createStdinFolderPicker,
  createWindowsFolderPicker,
  decodePickedPath,
  PICK_SCRIPT_SOURCE,
} from '../../apps/server/src/folder-picker/index.ts';

test('W-01 Windows 适配器：execFile + 固定参数数组 + shell:false，脚本是常量无插值', async () => {
  const calls: Array<{
    file: string;
    args: readonly string[];
    options: Record<string, unknown>;
  }> = [];

  const picker = createWindowsFolderPicker({
    execFileImpl: async (file, args, options) => {
      calls.push({ file, args, options: options as unknown as Record<string, unknown> });
      return { stdout: Buffer.from('C:\\项目\\资料', 'utf8').toString('base64') };
    },
  });

  const outcome = await picker.pick({ timeoutMs: 120_000 });
  assert.equal(outcome.status, 'picked');
  assert.equal(
    outcome.status === 'picked' ? outcome.folder.absolutePath : '',
    'C:\\项目\\资料',
    'Base64 必须按 UTF-8 解回（规避控制台代码页导致的乱码）',
  );

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.file, 'powershell.exe', '只允许固定可执行文件名，不接受调用方传任意程序');
  assert.deepEqual(
    call.args.slice(0, 6),
    ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command'],
    '参数表必须固定',
  );
  assert.equal(call.args.length, 7, '不得追加任何用户输入作为参数');
  assert.equal(call.options.shell, false, '绝不能走 shell：否则引号/注入面重新出现');
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.maxBuffer, 64_000);
  assert.equal(call.options.timeout, 120_000);

  const script = PICK_SCRIPT_SOURCE;
  assert.ok(script.includes('FolderBrowserDialog'), '必须使用系统目录对话框');
  assert.ok(script.includes('ShowNewFolderButton = $false'));
  assert.equal(/[`$]\{/.test(script), false, '脚本不得含插值占位');
  assert.equal(script.includes('C:\\'), false, '脚本不得含任何本机路径');
  assert.equal(script.includes('RootDir'), false);
});

test('W-02 Windows 适配器：取消/异常/找不到/超时都不产生路径', async () => {
  const cancel = createWindowsFolderPicker({
    execFileImpl: async () => {
      throw Object.assign(new Error('exit 1'), { code: 1 });
    },
  });
  assert.equal((await cancel.pick({ timeoutMs: 1000 })).status, 'cancelled');

  const broken = createWindowsFolderPicker({
    execFileImpl: async () => {
      throw Object.assign(new Error('exit 2'), { code: 2 });
    },
  });
  assert.equal((await broken.pick({ timeoutMs: 1000 })).status, 'unavailable');

  const missing = createWindowsFolderPicker({
    execFileImpl: async () => {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    },
  });
  assert.equal((await missing.pick({ timeoutMs: 1000 })).status, 'unavailable');

  const killed = createWindowsFolderPicker({
    execFileImpl: async () => {
      throw Object.assign(new Error('killed'), { killed: true, code: null });
    },
  });
  assert.equal((await killed.pick({ timeoutMs: 1000 })).status, 'timeout');

  const empty = createWindowsFolderPicker({ execFileImpl: async () => ({ stdout: '' }) });
  assert.equal((await empty.pick({ timeoutMs: 1000 })).status, 'unavailable');

  const garbage = createWindowsFolderPicker({
    execFileImpl: async () => ({ stdout: 'not base64!!' }),
  });
  assert.equal((await garbage.pick({ timeoutMs: 1000 })).status, 'unavailable');

  // 解码器本身：空串 / 非法 Base64 → undefined（绝不"猜"一个路径）
  assert.equal(decodePickedPath(''), undefined);
  assert.equal(decodePickedPath('%%%'), undefined);
  assert.equal(decodePickedPath(Buffer.from('D:\\a', 'utf8').toString('base64')), 'D:\\a');
});

test('W-03 非 TTY 与非 Windows 一律 fail-closed，绝不退化成"网页输入路径"', async () => {
  const stdinPicker = createStdinFolderPicker({ isTTY: false });
  const stdinOutcome = await stdinPicker.pick({ timeoutMs: 1000 });
  assert.equal(stdinOutcome.status, 'unavailable');
  assert.ok(
    (stdinOutcome as { detail: string }).detail.includes('终端'),
    '必须说明原因：stdin 不是交互式终端',
  );

  // 非 Windows + 无 TTY → 没有可用选择器，只能改用静态模式
  const hostPicker = createHostFolderPicker({ platform: 'linux', stdinIsTTY: false });
  assert.equal(hostPicker.kind, 'unavailable');
  assert.equal((await hostPicker.pick({ timeoutMs: 1000 })).status, 'unavailable');

  // Windows → 一定是系统对话框适配器（既不是 stdin，也不是 fake）
  const winPicker = createHostFolderPicker({ platform: 'win32' });
  assert.equal(winPicker.kind, 'windows-powershell');

  // 非 Windows 但有 TTY → stdin 适配器（人工在终端输入，仍属 T3 本机确认）
  const ttyPicker = createHostFolderPicker({
    platform: 'linux',
    stdinIsTTY: true,
  });
  assert.equal(ttyPicker.kind, 'stdin-prompt');
});
