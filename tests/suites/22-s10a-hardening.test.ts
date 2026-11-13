/**
 * S10-A-R1 插件边界回归测试（**测试先行**）。
 *
 * 本套件在基线 `6af1b22` 上**故意保持红色**：其中 R01 / R02-A / R02-B / R03c / R04
 * 复现的是当前实现的缺陷，修复前必须失败。**禁止**为了让套件变绿而放宽断言或删除用例。
 *
 * 标注约定（对应任务第 7 条，不伪造覆盖）：
 * - `[运行时]`：被测对象是纯 TS 模块，Node 可直接执行，断言的是真实行为。
 * - `[静态]`：被测对象含 TSX（Node 无法加载），只能断言源码结构；它证明"接线缺失"，
 *   但**不能**证明运行时表现，真实交互另需浏览器 E2E。
 * - `[E2E 待验证]`：需浏览器才能观测，本轮不声称覆盖。
 *
 * 测试只读源码与内存对象：不写用户文件、不改生产代码、不依赖网络。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  createPluginRuntime,
  type PluginModule,
} from '../../packages/plugin-runtime/index.ts';
import type { PluginManifest, ViewerCapability } from '../../packages/contracts/types.ts';

const ROOT = process.cwd();

/**
 * 可控 Promise：由测试自己决定何时放行初始化/销毁，不靠 sleep 赌时序。
 * 不用 `!` 断言赋值，避免类型剥离器处理 definite assignment。
 */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | undefined;
  let rejectFn: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return {
    promise,
    resolve: (value) => resolveFn?.(value),
    reject: (reason) => rejectFn?.(reason),
  };
}

/** 让出事件循环一轮：只为让已发起的异步流程跑到下一个等待点，不是计时竞态。 */
const yieldToEventLoop = () => new Promise<void>((r) => setTimeout(r, 0));

/** 兜底：任何等待超过 2s 都视为测试自身缺陷，避免整个套件挂起。 */
async function withDeadline<T>(promise: Promise<T>, label: string, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`测试内部等待超时（${ms}ms）：${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readSource(relPath: string): Promise<string> {
  return readFile(resolve(ROOT, relPath), 'utf8');
}

async function readManifest(relPath: string): Promise<PluginManifest> {
  return JSON.parse(await readSource(relPath)) as PluginManifest;
}

/** 最小合法清单；每个用例按需要覆盖字段。 */
function manifestOf(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'test.r1',
    version: '1.0.0',
    apiVersion: '0.1',
    fileExtensions: ['.md'],
    provides: ['file.viewer'],
    requires: [],
    requestedPermissions: ['workspace.read'],
    activationEvents: ['onFileExtension:.md'],
    entrypoints: { host: './index.ts' },
    ...overrides,
  };
}

const viewer: ViewerCapability = {
  apiVersion: '1',
  extensions: ['.md'],
  render: () => null,
};

// ---------------------------------------------------------------------------
// R01：ViewerBoundary 必须在 docId / providerId 改变时重置
// ---------------------------------------------------------------------------
test('R01 [静态] ViewerBoundary 必须带 key（docId + providerId），否则错误状态跨文档残留', async () => {
  const src = await readSource('apps/shell/src/components/DocumentViews.tsx');

  const tagMatch = src.match(/<ViewerBoundary\b[\s\S]*?>/);
  assert.ok(tagMatch, 'DocumentViews 必须使用 ViewerBoundary 包裹查看器输出');

  const tag = tagMatch[0];
  // 现状：<ViewerBoundary providerId={viewer.providerId}> —— 无 key。
  // React 会复用同一个边界实例，state.message 一旦被置位，切换到另一篇文档
  // （或换用另一个查看器）后仍然显示"查看器渲染失败"，属于跨文档的状态污染。
  // 本用例只断言源码结构，**不**声称浏览器中的重置行为已验证（见文件末尾 E2E 待验证）。
  assert.match(
    tag,
    /key=\{/,
    '必须提供 key，使边界在文档/提供者变化时重新挂载（否则错误状态会残留到下一篇文档）',
  );
  assert.match(tag, /docId/, 'key 必须包含 docId：不同文档必须是不同边界实例');
  assert.match(tag, /providerId/, 'key 必须包含 providerId：替换查看器后必须重置');
});

// ---------------------------------------------------------------------------
// R02-A：并发 activate 只执行一次初始化
// ---------------------------------------------------------------------------
test('R02-A [运行时] 并发 activate 只执行一次初始化', async () => {
  const runtime = createPluginRuntime();
  const gate = deferred<void>();
  let inits = 0;

  const module: PluginModule = {
    async activate() {
      inits += 1;
      await gate.promise; // 初始化被测试卡住，直到显式放行
    },
    capabilities: { 'file.viewer': viewer },
  };

  assert.equal(runtime.register(manifestOf(), module).ok, true);

  // 同一同步执行内发起两个请求：第一个已进入初始化，第二个必须复用同一个
  // in-flight 过程。计数器在 await 之前自增，因此放行前就已确定，无时序竞态。
  const first = runtime.activate('test.r1');
  const second = runtime.activate('test.r1');

  gate.resolve();

  const [firstRecord, secondRecord] = await withDeadline(
    Promise.all([first, second]),
    '两个并发 activate',
  );

  assert.equal(inits, 1, `并发激活必须只初始化一次，实际执行了 ${inits} 次`);
  assert.equal(firstRecord?.status, 'ACTIVE');
  assert.equal(secondRecord?.status, 'ACTIVE');
});

// ---------------------------------------------------------------------------
// R02-B：activate 期间 deactivate 必须串行化
// ---------------------------------------------------------------------------
test('R02-B [运行时] activate 期间的 deactivate 必须排队等待，不得并行执行销毁', async () => {
  const runtime = createPluginRuntime();
  const gate = deferred<void>();
  const order: string[] = [];

  const module: PluginModule = {
    async activate() {
      order.push('init:start');
      await gate.promise;
      order.push('init:end');
    },
    async deactivate() {
      order.push('deinit');
    },
    capabilities: { 'file.viewer': viewer },
  };

  assert.equal(runtime.register(manifestOf(), module).ok, true);

  const activating = runtime.activate('test.r1');
  // 初始化卡在 gate 上时请求停用：正确实现应排队，等初始化结束再销毁
  const deactivating = runtime.deactivate('test.r1');

  // 给停用请求一个执行机会：当前实现会在这里直接返回失败（不排队、不销毁）
  await yieldToEventLoop();
  const orderWhileBlocked = order.join(',');

  gate.resolve();

  const [, deactivated] = await withDeadline(
    Promise.all([activating, deactivating]),
    'activate 与 deactivate 串行完成',
  );

  // 汇总断言：顺序、返回值、最终状态一次比较完。
  // 前一项不满足也能在 actual 里同时看到后两项，不会因 fail-fast 丢掉信息。
  const snapshot = {
    order: order.join(','),
    ok: deactivated.ok,
    finalStatus: runtime.status('test.r1')?.status,
  };
  assert.deepEqual(
    snapshot,
    { order: 'init:start,init:end,deinit', ok: true, finalStatus: 'INACTIVE' },
    `串行化不满足（卡住期间 order=${orderWhileBlocked}）：期望"初始化结束后才销毁、停用成功、最终 INACTIVE"`,
  );
});

// ---------------------------------------------------------------------------
// R03：注册表创建无启动副作用；StrictMode effect replay 不重复激活
// ---------------------------------------------------------------------------
test('R03a [运行时] 注册与构造不产生激活副作用', async () => {
  const runtime = createPluginRuntime();
  let inits = 0;

  const registered = runtime.register(manifestOf(), {
    activate() {
      inits += 1;
    },
    capabilities: { 'file.viewer': viewer },
  });

  assert.equal(registered.ok, true);
  assert.equal(registered.record?.status, 'REGISTERED');
  await yieldToEventLoop();
  assert.equal(inits, 0, '注册阶段不得执行插件初始化');
  assert.equal(runtime.providersOf('file.viewer').length, 0, '未激活的插件不得提供能力');
});

test('R03b [运行时] 已 ACTIVE 后重复 activate 幂等（不构成 StrictMode 的 E2E 证据）', async () => {
  const runtime = createPluginRuntime();
  let inits = 0;

  runtime.register(manifestOf(), {
    async activate() {
      inits += 1;
    },
    capabilities: { 'file.viewer': viewer },
  });

  // 只验证一条运行时性质：已 ACTIVE 后再次 activate 不会重复初始化。
  // 它**不是** StrictMode 双挂载的端到端证据——真实 effect 重放需在浏览器观测。
  await runtime.activate('test.r1');
  await runtime.activate('test.r1');
  await runtime.activate('test.r1');

  assert.equal(inits, 1, `重复激活不得重复初始化，实际 ${inits} 次`);
  assert.equal(runtime.status('test.r1')?.status, 'ACTIVE');
});

test('R03c [静态] Shell 注册表构造时必须无启动副作用（不得在构造期发起 activate）', async () => {
  const src = await readSource('apps/shell/src/capabilities/registry.ts');

  const start = src.indexOf('export function createShellCapabilityRegistry');
  assert.ok(start >= 0, '未找到 createShellCapabilityRegistry');
  const returnAt = src.indexOf('return {', start);
  assert.ok(returnAt > start, '未找到构造函数体');

  const ctorBody = src.slice(start, returnAt);

  // 现状：构造函数里 `pending.push(runtime.activate(...))` 会立即启动插件。
  // 后果：StrictMode 下 useState 初始化器/组件体被调用两次时会产生两次启动，
  // 且"创建注册表"这个动作本身带了不可回滚的副作用（无法在构造阶段被丢弃）。
  // 同理：只断言构造段文本，**不**声称 StrictMode 双挂载已被浏览器验证。
  assert.equal(
    /runtime\.activate\(/.test(ctorBody),
    false,
    '构造注册表时不得发起激活；激活应作为显式步骤（如 start()）由宿主在受控时机调用一次',
  );
});

// ---------------------------------------------------------------------------
// R04：客户端 Manifest 的 provides 必须与实际注册的能力一致
// ---------------------------------------------------------------------------
interface ClientCapabilityDeclaration {
  pluginId: string;
  declared: string[];
  registered: string[];
}

/** 从 client.tsx 源码中提取 `capabilities: { ... }` 的能力名。 */
function parseRegisteredCapabilities(source: string): string[] {
  const mapMatch = source.match(/capabilities:\s*\{([\s\S]*?)\n\s*\}/);
  if (!mapMatch) return [];
  const names: string[] = [];
  const re = /['"]([^'"]+)['"]\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(mapMatch[1])) !== null) names.push(m[1]);
  return names;
}

/** 去掉能力名上的主版本后缀，便于与运行时记录比较。 */
function stripVersion(raw: string): string {
  const at = raw.lastIndexOf('@');
  return at === -1 ? raw : raw.slice(0, at);
}

async function declarationOf(manifestPath: string, clientPath: string, pluginId: string) {
  const manifest = await readManifest(manifestPath);
  const client = await readSource(clientPath);
  return {
    pluginId,
    declared: manifest.provides.map(stripVersion).sort(),
    registered: parseRegisteredCapabilities(client).sort(),
  } satisfies ClientCapabilityDeclaration;
}

test('R04 [静态] 各插件 client 注册的能力必须与 manifest.provides 完全一致', async () => {
  const declarations = [
    await declarationOf(
      'plugins/markdown/manifest.json',
      'plugins/markdown/client.tsx',
      'weavespace.markdown',
    ),
    await declarationOf(
      'plugins/plaintext/manifest.json',
      'plugins/plaintext/client.tsx',
      'weavespace.plaintext',
    ),
  ];

  const mismatched = declarations.filter(
    (d) => JSON.stringify(d.declared) !== JSON.stringify(d.registered),
  );

  assert.deepEqual(
    mismatched,
    [],
    `声明与实注册不一致：${mismatched
      .map((d) => `${d.pluginId} 声明=[${d.declared}] 实注册=[${d.registered}]`)
      .join('；')}。声明了却没注册的能力，resolveCapability 会返回 ERR_CAPABILITY_MISSING，` +
      '调用方会以为"插件装好了但能力不可用"。',
  );
});

test('R04b [运行时] 声明与注册不一致时，能力解析表现为"已声明但不可解析"', async () => {
  const runtime = createPluginRuntime();

  // 复刻 markdown 插件的现状：manifest 声明 4 项，客户端只注册了 file.viewer
  const declared = ['file.parser', 'file.editor', 'file.viewer', 'file.serializer'];
  runtime.register(
    manifestOf({ id: 'test.split-brain', provides: declared }),
    { capabilities: { 'file.viewer': viewer } },
  );
  await runtime.activate('test.split-brain');

  const viewerOk = runtime.resolveCapability('file.viewer');
  assert.equal(viewerOk.ok, true, '已注册的能力应当可解析');

  const parserMissing = runtime.resolveCapability('file.parser');
  assert.equal(parserMissing.ok, false);
  assert.equal(parserMissing.ok ? '' : parserMissing.errorCode, 'ERR_CAPABILITY_MISSING');
  // 区分"根本没人声明"与"声明了但没实现"：后者提示应指向提供者未实注册
  assert.match(parserMissing.ok ? '' : parserMissing.reason, /提供者均未激活/);
});

// 说明：R01 的运行时表现（错误状态是否真的被重置）与 R03 的 StrictMode 双挂载行为
// 需要浏览器才能观测，本轮**未覆盖**，标记为 [E2E 待验证]：
//   1) 打开 A.md → 让查看器抛错 → 切到 B.md，预览应正常渲染（当前会残留错误面板）。
//   2) React StrictMode 下首屏只应发生一次插件初始化（可通过插件初始化日志计数验证）。
