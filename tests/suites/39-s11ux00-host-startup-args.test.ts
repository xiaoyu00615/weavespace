/**
 * S11-UX-00：Host 启动参数解析回归测试。
 *
 * 背景（修复前的真实缺陷）：`--workspace <file>` **不带端口**时无法启动——
 * 旧实现只在「同时存在位置参数」时才承认 `--workspace`，于是工区路径被静默丢弃，
 * 落到 Legacy 分支后因缺少项目根而打印用法并 `exit 2`。
 *
 * 覆盖范围：
 * - 合法：Legacy / Multi 两模式、`--workspace=file` 等价写法、端口优先级、端口 0；
 * - 非法：无目标、`--workspace` 缺值、模式冲突（含重复指定）、未知选项、端口非法。
 *
 * 纪律：不建服务、不读文件系统、不 spawn 子进程（沙箱禁止），只覆盖纯解析。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_PORT,
  USAGE,
  parseStartup,
  type StartupArgsErrorCode,
} from '../../apps/server/src/startup-args.ts';

function codeOf(argv: readonly string[], env: { WS_PORT?: string } = {}): StartupArgsErrorCode {
  try {
    parseStartup(argv, env);
    return 'NO_ERROR' as StartupArgsErrorCode;
  } catch (err) {
    const code = (err as { code?: StartupArgsErrorCode }).code;
    assert.ok(code, `应抛出带 code 的 StartupArgsError，实际: ${String(err)}`);
    return code;
  }
}

// ---------------------------------------------------------------------------
// 合法参数
// ---------------------------------------------------------------------------
test('U-01 Legacy 只给项目根：进入 legacy，端口取默认值', () => {
  const args = parseStartup(['D:/demo']);
  assert.equal(args.mode, 'legacy');
  assert.equal(args.rootDir, 'D:/demo');
  assert.equal('workspacePath' in args, false, 'Legacy 不得带 workspacePath');
  assert.equal(args.port, DEFAULT_PORT);
});

test('U-02 Legacy 给项目根与端口', () => {
  const args = parseStartup(['D:/demo', '5188']);
  assert.equal(args.mode, 'legacy');
  assert.equal(args.rootDir, 'D:/demo');
  assert.equal(args.port, 5188);
});

test('U-03 Multi 只给 --workspace、不带端口：必须进入 multi 并使用默认端口（修复目标）', () => {
  const args = parseStartup(['--workspace', 'ws.json']);
  assert.equal(args.mode, 'multi');
  assert.equal(args.workspacePath, 'ws.json');
  assert.equal('rootDir' in args, false, 'Multi 不得带项目根');
  assert.equal(args.port, DEFAULT_PORT);
});

test('U-04 Multi 给 --workspace 与端口', () => {
  const args = parseStartup(['--workspace', 'ws.json', '5188']);
  assert.equal(args.mode, 'multi');
  assert.equal(args.workspacePath, 'ws.json');
  assert.equal(args.port, 5188);
});

test('U-05 Multi 使用 --workspace=<file> 等价写法（不带端口）', () => {
  const args = parseStartup(['--workspace=ws.json']);
  assert.equal(args.mode, 'multi');
  assert.equal(args.workspacePath, 'ws.json');
  assert.equal(args.port, DEFAULT_PORT);
});

test('U-06 Multi 使用 --workspace=<file> 并带端口', () => {
  const args = parseStartup(['--workspace=ws.json', '5189']);
  assert.equal(args.mode, 'multi');
  assert.equal(args.workspacePath, 'ws.json');
  assert.equal(args.port, 5189);
});

test('U-07 Multi 允许端口写在 --workspace 之前', () => {
  const args = parseStartup(['5188', '--workspace', 'ws.json']);
  assert.equal(args.mode, 'multi');
  assert.equal(args.workspacePath, 'ws.json');
  assert.equal(args.port, 5188);
});

test('U-08 端口优先级：命令行 > WS_PORT > 默认', () => {
  assert.equal(parseStartup(['D:/demo'], { WS_PORT: '6000' }).port, 6000);
  assert.equal(parseStartup(['D:/demo', '6001'], { WS_PORT: '6000' }).port, 6001);
  assert.equal(parseStartup(['--workspace', 'ws.json'], { WS_PORT: '6002' }).port, 6002);
  assert.equal(parseStartup(['--workspace', 'ws.json', '6003'], { WS_PORT: '6002' }).port, 6003);
  assert.equal(parseStartup(['D:/demo']).port, DEFAULT_PORT);
});

test('U-09 端口 0 合法（交给系统分配临时端口）', () => {
  assert.equal(parseStartup(['D:/demo', '0']).port, 0);
  assert.equal(parseStartup(['--workspace', 'ws.json', '0']).port, 0);
});

// ---------------------------------------------------------------------------
// 非法参数
// ---------------------------------------------------------------------------
test('I-01 既无项目根也无 --workspace：报无目标并附带用法', () => {
  assert.equal(codeOf([]), 'ERR_STARTUP_NO_TARGET');
  try {
    parseStartup([]);
  } catch (err) {
    assert.equal((err as Error).message, USAGE.trimEnd(), '无目标时必须给出完整用法');
  }
});

test('I-02 --workspace 后没有值：明确报缺值，而不是退化成通用用法', () => {
  assert.equal(codeOf(['--workspace']), 'ERR_STARTUP_WORKSPACE_MISSING_VALUE');
});

test('I-03 --workspace 后是空字符串或纯空白：报缺值', () => {
  assert.equal(codeOf(['--workspace', '']), 'ERR_STARTUP_WORKSPACE_MISSING_VALUE');
  assert.equal(codeOf(['--workspace', '   ']), 'ERR_STARTUP_WORKSPACE_MISSING_VALUE');
});

test('I-04 --workspace= 后为空：报缺值', () => {
  assert.equal(codeOf(['--workspace=']), 'ERR_STARTUP_WORKSPACE_MISSING_VALUE');
});

test('I-05 --workspace 的值是另一个选项：按缺值拒绝（不把选项当路径）', () => {
  assert.equal(codeOf(['--workspace', '--workspace=ws.json']), 'ERR_STARTUP_WORKSPACE_MISSING_VALUE');
});

test('I-06 同时给项目根与 --workspace：报模式冲突，且不得把根当端口', () => {
  assert.equal(codeOf(['D:/demo', '--workspace', 'ws.json']), 'ERR_STARTUP_MODE_CONFLICT');
});

test('I-07 重复指定 --workspace：报冲突（不静默取最后一个）', () => {
  assert.equal(codeOf(['--workspace', 'a.json', '--workspace', 'b.json']), 'ERR_STARTUP_MODE_CONFLICT');
  assert.equal(codeOf(['--workspace=a.json', '--workspace', 'b.json']), 'ERR_STARTUP_MODE_CONFLICT');
});

test('I-08 Multi 多给一个位置参数：报模式冲突', () => {
  assert.equal(codeOf(['--workspace', 'ws.json', '5177', 'extra']), 'ERR_STARTUP_MODE_CONFLICT');
});

test('I-09 端口不是数字：报端口非法', () => {
  assert.equal(codeOf(['D:/demo', 'abc']), 'ERR_STARTUP_INVALID_PORT');
  assert.equal(codeOf(['D:/demo', '51.77']), 'ERR_STARTUP_INVALID_PORT');
  assert.equal(codeOf(['D:/demo', '-1']), 'ERR_STARTUP_INVALID_PORT');
});

test('I-10 端口越界：报端口非法', () => {
  assert.equal(codeOf(['D:/demo', '65536']), 'ERR_STARTUP_INVALID_PORT');
  assert.equal(codeOf(['D:/demo', '99999']), 'ERR_STARTUP_INVALID_PORT');
  assert.equal(codeOf(['--workspace', 'ws.json', '65536']), 'ERR_STARTUP_INVALID_PORT');
});

test('I-11 WS_PORT 本身非法：报端口非法', () => {
  assert.equal(codeOf(['D:/demo'], { WS_PORT: 'abc' }), 'ERR_STARTUP_INVALID_PORT');
  assert.equal(codeOf(['D:/demo'], { WS_PORT: '' }), 'ERR_STARTUP_INVALID_PORT');
});

test('I-12 未知选项：报未知选项，不把它当成项目根', () => {
  assert.equal(codeOf(['--nope', 'D:/demo']), 'ERR_STARTUP_UNKNOWN_OPTION');
  assert.equal(codeOf(['--workpace=ws.json']), 'ERR_STARTUP_UNKNOWN_OPTION');
});

test('I-13 错误对象带稳定 code 与可读文案', () => {
  try {
    parseStartup(['--workspace']);
    assert.fail('应当抛出');
  } catch (err) {
    const e = err as { code?: string; name?: string; message?: string };
    assert.equal(e.name, 'StartupArgsError');
    assert.equal(e.code, 'ERR_STARTUP_WORKSPACE_MISSING_VALUE');
    assert.ok((e.message ?? '').includes('--workspace'));
  }
});

// ---------------------------------------------------------------------------
// R1（GPT 审查发现）：Legacy 模式的多余位置参数必须 fail-closed
//
// 修复前：Legacy 只读 `positional[0]` 与 `positional[1]`，第三个及之后的参数被
// 静默忽略，`['D:/demo', '5177', 'unexpected']` 会当成一次正常启动——
// 调用方拼错命令却得不到任何反馈，属于"看起来成功、实际没按意图执行"。
// ---------------------------------------------------------------------------
test('R1-01 Legacy 项目根 + 端口 + 一个多余参数：必须拒绝', () => {
  assert.equal(
    codeOf(['D:/demo', '5177', 'unexpected']),
    'ERR_STARTUP_UNEXPECTED_POSITIONAL',
  );
});

test('R1-02 Legacy 项目根 + 两个多余参数：必须拒绝', () => {
  assert.equal(
    codeOf(['D:/demo', '5177', 'unexpected', 'more']),
    'ERR_STARTUP_UNEXPECTED_POSITIONAL',
  );
});

test('R1-03 Legacy 多余参数即使是数字也要拒绝（不能只靠端口校验兜底）', () => {
  assert.equal(codeOf(['D:/demo', '5177', '5178']), 'ERR_STARTUP_UNEXPECTED_POSITIONAL');
  assert.equal(codeOf(['D:/demo', '5177', '0']), 'ERR_STARTUP_UNEXPECTED_POSITIONAL');
});

test('R1-04 多余参数的拒绝先于端口校验：结构错误优先报告', () => {
  // 端口本身非法，但同时还有多余参数 → 报参数数量问题（更接近真实原因）
  assert.equal(codeOf(['D:/demo', 'abc', 'x']), 'ERR_STARTUP_UNEXPECTED_POSITIONAL');
});

test('R1-05 Legacy 原有合法形式继续通过：无端口 / 带端口', () => {
  const noPort = parseStartup(['D:/demo']);
  assert.equal(noPort.mode, 'legacy');
  assert.equal(noPort.rootDir, 'D:/demo');
  assert.equal(noPort.port, DEFAULT_PORT);

  const withPort = parseStartup(['D:/demo', '5177']);
  assert.equal(withPort.mode, 'legacy');
  assert.equal(withPort.rootDir, 'D:/demo');
  assert.equal(withPort.port, 5177);
});

test('R1-06 Multi 原有数量限制继续通过：一个位置参数=端口，两个即冲突', () => {
  const single = parseStartup(['--workspace', 'ws.json', '5188']);
  assert.equal(single.mode, 'multi');
  assert.equal(single.port, 5188);

  // Multi 多出位置参数仍报模式冲突（保持既有语义，不改成数量错误码）
  assert.equal(
    codeOf(['--workspace', 'ws.json', '5188', 'extra']),
    'ERR_STARTUP_MODE_CONFLICT',
  );
});

test('R1-07 多余位置参数的文案指出数量与被拒的第一个多余值', () => {
  try {
    parseStartup(['D:/demo', '5177', 'typo-root', 'x']);
    assert.fail('应当抛出');
  } catch (err) {
    const e = err as { code?: string; message?: string };
    assert.equal(e.code, 'ERR_STARTUP_UNEXPECTED_POSITIONAL');
    assert.ok((e.message ?? '').includes('2'), '应给出多余参数个数');
    assert.ok((e.message ?? '').includes('typo-root'), '应给出第一个多余值，便于定位');
  }
});
