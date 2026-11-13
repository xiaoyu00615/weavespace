/**
 * S10-A：能力注册、依赖校验、插件启停与故障隔离的边界测试。
 *
 * 测试范围说明（必须如实）：
 * - 这里验证的是**能力契约与注册表**（`packages/plugin-runtime`，纯 TS 可被 Node 加载）。
 *   查看器的 React 实现（各插件的 viewer.tsx）无法在 Node 里 import（TSX），
 *   因此其「视觉替换」由 Chrome 端到端验证，本套件只做**接线静态断言**；
 *   不使用断言假装覆盖了渲染结果。
 * - 全部在临时目录/内存中进行，不接触真实用户文件。
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  createPluginRuntime,
  DEFAULT_CORE_DEPENDENCIES,
  parseCapabilityRef,
  type PluginModule,
} from '../../packages/plugin-runtime/index.ts';
import type { PluginManifest, ViewerCapability } from '../../packages/contracts/types.ts';
import { createHarness } from '../helpers.ts';

const ROOT = process.cwd();

async function readManifest(relPath: string): Promise<PluginManifest> {
  return JSON.parse(await readFile(resolve(ROOT, relPath), 'utf8')) as PluginManifest;
}

/** 测试用查看器：只记录调用并返回可比较的字符串，不涉及 React。 */
interface FakeViewer extends ViewerCapability {
  calls: number;
}

function fakeViewer(extensions: string[], marker: string): FakeViewer {
  const viewer: FakeViewer = {
    apiVersion: '1',
    extensions,
    calls: 0,
    render: (input) => {
      viewer.calls += 1;
      // 避免 `}:` 紧邻的模板插值：Node 的类型剥离器会把 `:` 误判为类型注解
      return marker + ':' + input.content;
    },
  };
  return viewer;
}

function moduleWith(viewer: ViewerCapability): PluginModule {
  return { capabilities: { 'file.viewer': viewer } };
}

async function buildTwoViewers() {
  const runtime = createPluginRuntime();
  const md = await readManifest('plugins/markdown/manifest.json');
  const txt = await readManifest('plugins/plaintext/manifest.json');
  const mdViewer = fakeViewer(['.md', '.markdown'], 'markdown');
  const txtViewer = fakeViewer(['.md', '.markdown', '.txt'], 'plaintext');

  assert.equal(runtime.register(md, moduleWith(mdViewer)).ok, true);
  assert.equal(runtime.register(txt, moduleWith(txtViewer)).ok, true);
  await runtime.activate(md.id);
  await runtime.activate(txt.id);
  return { runtime, md, txt, mdViewer, txtViewer };
}

// ---------------------------------------------------------------------------
// S10A-01：能力注册与按接口发现
// ---------------------------------------------------------------------------
test('S10A-01 能力注册后可被发现，并能按能力名 + 扩展名解析', async () => {
  const { runtime, md } = await buildTwoViewers();

  const providers = runtime.providersOf('file.viewer');
  assert.equal(providers.length, 2, '两个插件都应提供 file.viewer');
  assert.deepEqual(
    providers.map((r) => r.pluginId).sort(),
    ['weavespace.markdown', 'weavespace.plaintext'],
  );

  const listed = runtime.capabilities().find((c) => c.capability === 'file.viewer');
  assert.ok(listed, 'capabilities() 必须列出 file.viewer');
  assert.equal(listed?.providers, 2);
  assert.equal(listed?.active, 2);

  const resolved = runtime.resolveCapability<ViewerCapability>('file.viewer', { extension: '.md' });
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    // 注册顺序即优先级：Markdown 先注册，正常情况下由它胜出
    assert.equal(resolved.provider.pluginId, md.id);
    assert.match(String(resolved.value.render({ content: 'x', path: 'a.md' })), /^markdown:/);
  }
});

test('S10A-01b 能力标识支持主版本后缀，解析结果稳定', () => {
  assert.deepEqual(parseCapabilityRef('file.viewer'), {
    name: 'file.viewer',
    major: 1,
    raw: 'file.viewer',
  });
  assert.equal(parseCapabilityRef('file.viewer@1')?.major, 1);
  assert.equal(parseCapabilityRef('file.viewer@9')?.major, 9);
  assert.equal(parseCapabilityRef('file viewer'), null);
  assert.equal(parseCapabilityRef('file.viewer@x'), null);

  // 缺失依赖时 requireCapability 必须抛可识别错误，而不是返回空实现
  const runtime = createPluginRuntime();
  assert.throws(
    () => runtime.requireCapability('file.viewer'),
    (err: { errorCode?: string }) => err.errorCode === 'ERR_CAPABILITY_MISSING',
  );
});

// ---------------------------------------------------------------------------
// S10A-02：重复注册 / 不兼容注册被拒绝
// ---------------------------------------------------------------------------
test('S10A-02 重复 id 与不兼容能力版本都被明确拒绝', async () => {
  const runtime = createPluginRuntime();
  const md = await readManifest('plugins/markdown/manifest.json');

  assert.equal(runtime.register(md, moduleWith(fakeViewer(['.md'], 'm'))).ok, true);
  const dup = runtime.register({ ...md, version: '9.9.9' });
  assert.equal(dup.ok, false);
  assert.equal(dup.errorCode, 'ERR_PLUGIN_DUPLICATE_ID');
  assert.equal(runtime.status(md.id)?.version, md.version, '重复注册不得覆盖已有记录');

  for (const bad of ['file.viewer@9', 'file view', '']) {
    const incompatible = runtime.register(
      { ...md, id: `probe.bad${bad.replace(/\W/g, '') || 'empty'}`, provides: [bad] },
      moduleWith(fakeViewer(['.md'], 'bad')),
    );
    assert.equal(incompatible.ok, false, `${JSON.stringify(bad)} 必须被拒绝`);
    assert.equal(incompatible.errorCode, 'ERR_CAPABILITY_INCOMPATIBLE');
    assert.equal(incompatible.record?.status, 'BLOCKED_DEPENDENCY');
  }
});

// ---------------------------------------------------------------------------
// S10A-03：缺少必需能力时不得假装启动
// ---------------------------------------------------------------------------
test('S10A-03 依赖缺失 → BLOCKED_DEPENDENCY，且模块 activate 不会被调用', async () => {
  const runtime = createPluginRuntime();
  const md = await readManifest('plugins/markdown/manifest.json');
  let activated = false;

  const result = runtime.register(
    { ...md, id: 'probe.needs-missing', requires: [md.id] },
    {
      activate() {
        activated = true;
      },
      capabilities: { 'file.viewer': fakeViewer(['.md'], 'never') },
    },
  );
  assert.equal(result.ok, true, '注册阶段只校验清单，不校验依赖');

  const record = await runtime.activate('probe.needs-missing');
  assert.equal(record?.status, 'BLOCKED_DEPENDENCY');
  assert.equal(record?.lastErrorCode, 'ERR_PLUGIN_DEPENDENCY_MISSING');
  assert.match(String(record?.lastErrorMessage), /weavespace\.markdown/);
  assert.equal(activated, false, '依赖缺失时绝不能执行插件初始化');
  assert.equal(runtime.providersOf('file.viewer').length, 0, '未启动的插件不提供能力');

  // 补齐依赖后可以正常启动（依赖校验不是一次性死锁）
  assert.equal(runtime.register(md, moduleWith(fakeViewer(['.md'], 'ok'))).ok, true);
  await runtime.activate(md.id);
  assert.equal(runtime.status(md.id)?.status, 'ACTIVE');
  const retried = await runtime.activate('probe.needs-missing');
  assert.equal(retried?.status, 'ACTIVE', '依赖补齐后应可启动');
  assert.equal(activated, true);
});

test('S10A-03b Core 侧可信模块不要求有对应插件', async () => {
  const runtime = createPluginRuntime();
  const md = await readManifest('plugins/markdown/manifest.json');
  // manifest.requires 目前是 weavespace.document / weavespace.storage（Core 模块）
  for (const dep of md.requires) {
    assert.ok(DEFAULT_CORE_DEPENDENCIES.includes(dep), `${dep} 应属于 Core 可信模块`);
  }
  assert.equal(runtime.register(md, moduleWith(fakeViewer(['.md'], 'm'))).ok, true);
  await runtime.activate(md.id);
  assert.equal(runtime.status(md.id)?.status, 'ACTIVE');
});

// ---------------------------------------------------------------------------
// S10A-04：Markdown 通过能力机制打开并预览（接线 + 解析）
// ---------------------------------------------------------------------------
test('S10A-04 Markdown 插件的查看能力可解析，且其解析器支持真实内容', async () => {
  const { runtime, mdViewer } = await buildTwoViewers();
  const resolved = runtime.requireCapability<ViewerCapability>('file.viewer', { extension: '.md' });
  assert.equal(resolved.provider.pluginId, 'weavespace.markdown');
  assert.deepEqual([...resolved.value.extensions], ['.md', '.markdown']);

  // 解析器本身可被 Core/测试直接使用（纯函数，无 React）
  const { parseMarkdown } = await import('../../plugins/markdown/blocks.ts');
  const blocks = parseMarkdown('# 标题\n\n- 项目\n');
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['heading', 'list'],
  );

  // 能力实现的 render 被调用一次即产生一次结果（宿主每帧渲染一条）
  const before = mdViewer.calls;
  const out = resolved.value.render({ content: '# 标题\n', path: 'a.md' });
  assert.equal(mdViewer.calls, before + 1);
  assert.match(String(out), /^markdown:/);

  // 接线静态断言：插件客户端入口确实把 viewer 注册为 file.viewer（Node 无法 import TSX）
  const client = await readFile(resolve(ROOT, 'plugins/markdown/client.tsx'), 'utf8');
  assert.match(client, /'file\.viewer'/);
  assert.match(client, /createMarkdownViewer/);
  const manifest = await readManifest('plugins/markdown/manifest.json');
  assert.equal(manifest.entrypoints.client, './client.tsx');
});

// ---------------------------------------------------------------------------
// S10A-05：停用 Markdown 后的安全回退
// ---------------------------------------------------------------------------
test('S10A-05 停用 Markdown → .md 由通用文本能力接管；树与 Core 不受影响', async () => {
  const { runtime, md, txt } = await buildTwoViewers();

  const off = await runtime.deactivate(md.id);
  assert.equal(off.ok, true);
  assert.equal(runtime.status(md.id)?.status, 'INACTIVE');

  const fallback = runtime.resolveCapability<ViewerCapability>('file.viewer', { extension: '.md' });
  assert.equal(fallback.ok, true, '停用 Markdown 后 .md 仍必须有可用查看器');
  if (fallback.ok) assert.equal(fallback.provider.pluginId, txt.id);

  // 通用文本插件仍只暴露只读查看能力
  const txtRecord = runtime.status(txt.id);
  assert.deepEqual(txtRecord?.capabilities, ['file.viewer']);

  // 未声明 file.viewer 的扩展名不会被"顺手"接管
  const unknown = runtime.resolveCapability('file.viewer', { extension: '.psd' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ok ? '' : unknown.errorCode, 'ERR_CAPABILITY_MISSING');
});

test('S10A-05b 存在未保存内容时停用被拒绝（不丢草稿）', async () => {
  const runtime = createPluginRuntime({ hasDirtyState: (id) => id === 'weavespace.markdown' });
  const md = await readManifest('plugins/markdown/manifest.json');
  runtime.register(md, moduleWith(fakeViewer(['.md'], 'm')));
  await runtime.activate(md.id);

  const blocked = await runtime.deactivate(md.id);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errorCode, 'ERR_PLUGIN_DEACTIVATE_BLOCKED');
  assert.equal(runtime.status(md.id)?.status, 'ACTIVE', '拒绝后插件必须保持可用');

  const forced = await runtime.deactivate(md.id, { force: true });
  assert.equal(forced.ok, true, '显式 force 才允许停用');
});

// ---------------------------------------------------------------------------
// S10A-06：替换查看实现，不修改 Shell / Core
// ---------------------------------------------------------------------------
test('S10A-06 第三方查看器可接管 .md，Shell 不 import 任何插件实现', async () => {
  const { runtime, md } = await buildTwoViewers();
  const replacementViewer = fakeViewer(['.md'], 'replacement');

  const registered = runtime.register(
    {
      id: 'test.viewer',
      version: '1.0.0',
      apiVersion: '0.1',
      fileExtensions: ['.md'],
      provides: ['file.viewer'],
      requires: ['weavespace.document'],
      requestedPermissions: ['workspace.read'],
      activationEvents: ['onFileExtension:.md'],
      entrypoints: { client: './index.ts' },
    },
    moduleWith(replacementViewer),
  );
  assert.equal(registered.ok, true);

  // Markdown 仍激活时，注册顺序优先 → 仍是 Markdown
  let resolved = runtime.resolveCapability<ViewerCapability>('file.viewer', { extension: '.md' });
  assert.equal(resolved.ok && resolved.provider.pluginId, md.id);

  await runtime.activate('test.viewer');
  // 显式指定首选即可替换显示实现
  resolved = runtime.resolveCapability<ViewerCapability>('file.viewer', {
    extension: '.md',
    preferPluginId: 'test.viewer',
  });
  assert.equal(resolved.ok && resolved.provider.pluginId, 'test.viewer');

  // 停用两个内置查看器后，替代实现自然接管（注册顺序在它之前的都已不可用）
  await runtime.deactivate(md.id);
  await runtime.deactivate('weavespace.plaintext');
  resolved = runtime.resolveCapability<ViewerCapability>('file.viewer', { extension: '.md' });
  assert.equal(resolved.ok && resolved.provider.pluginId, 'test.viewer');

  // Shell 核心组件不得直接依赖插件目录；组合根是唯一例外
  for (const rel of [
    'apps/shell/src/components/DocumentViews.tsx',
    'apps/shell/src/components/ProjectTree.tsx',
    'apps/shell/src/layout/ShellLayout.tsx',
    'apps/shell/src/state/DocumentActionsContext.tsx',
  ]) {
    const src = await readFile(resolve(ROOT, rel), 'utf8');
    assert.equal(/from\s+['"][^'"]*\/plugins\//.test(src), false, `${rel} 不得 import 插件实现`);
  }
});

// ---------------------------------------------------------------------------
// S10A-07：插件不能绕过权限与条件保存
// ---------------------------------------------------------------------------
test('S10A-07 通过插件查看的文档，保存仍受权限与版本条件约束', async () => {
  const h = await createHarness({
    grants: [
      { actorId: 'user', action: 'read', scope: '' },
      { actorId: 'user', action: 'write', scope: '' },
    ],
  });
  try {
    const md = await readManifest('plugins/markdown/manifest.json');
    // 插件声明解析/查看/编辑/序列化，但没有任何「越过 Core 写盘」的能力
    assert.equal(md.provides.includes('file.viewer'), true);
    assert.equal(md.provides.some((p) => /writer|fs|storage-secret/.test(p)), false);

    // 真实文件 → 经命令总线打开（与插件无关，仍走 Permission + Document）
    await writeFile(join(h.root, 'note.md'), '# 原始\n', 'utf8');
    const opened = await h.bus.dispatch(
      {
        commandId: 'c-s10a-open',
        type: 'document.open',
        payload: { resourceId: 'r-md', path: 'note.md', providerId: 'local' },
      },
      { actorId: 'user' },
    );
    assert.equal(opened.status, 'APPLIED');
    const sessionId = (opened.result as { sessionId: string }).sessionId;
    const baseVersion = h.document.getSession(sessionId)?.baseVersion;
    assert.ok(baseVersion, '打开后应有版本基线');

    const edited = await h.bus.dispatch(
      {
        commandId: 'c-s10a-edit',
        type: 'document.applyEdit',
        expectedVersion: 'rev-0',
        payload: { sessionId, buffer: '# 改过\n' },
      },
      { actorId: 'user' },
    );
    assert.equal(edited.status, 'APPLIED');

    // 撤销写权限 → 保存被拒绝，磁盘不变
    h.permission.revoke({ actorId: 'user', action: 'write', scope: '' });
    const denied = await h.bus.dispatch(
      {
        commandId: 'c-s10a-save-denied',
        type: 'document.save',
        expectedVersion: baseVersion,
        payload: { sessionId },
      },
      { actorId: 'user' },
    );
    assert.equal(denied.status, 'REJECTED');
    assert.equal(denied.errorCode, 'ERR_PERMISSION_DENIED');
    assert.equal(await readFile(join(h.root, 'note.md'), 'utf8'), '# 原始\n', '拒绝时不得写盘');

    // 恢复权限后，条件保存仍按版本判定：基线不符 → CONFLICT，不覆盖
    h.permission.grant({ actorId: 'user', action: 'write', scope: '' });
    const stale = await h.bus.dispatch(
      {
        commandId: 'c-s10a-save-stale',
        type: 'document.save',
        expectedVersion: 'sha256:stale',
        payload: { sessionId },
      },
      { actorId: 'user' },
    );
    // 命令层把版本冲突表达为 REJECTED + ERR_DOCUMENT_VERSION_CONFLICT
    // （DocumentService 的 save() 才返回 status='CONFLICT'；这里验证的是插件无法绕过的命令链路）
    assert.equal(stale.status, 'REJECTED');
    assert.equal(stale.errorCode, 'ERR_DOCUMENT_VERSION_CONFLICT');
    // 命令层在授权/版本预检阶段就拒绝，会话仍保持 dirty（工作区未因拒绝被改动）
    assert.equal(h.document.getSession(sessionId)?.dirty, true);
    assert.equal(h.document.getSession(sessionId)?.state, 'EDITING_DIRTY');
    assert.equal(await readFile(join(h.root, 'note.md'), 'utf8'), '# 原始\n', '冲突不得覆盖磁盘');
  } finally {
    await h.cleanup();
  }
});

test('S10A-07b 插件源码不直接访问文件系统 / 网络', async () => {
  for (const rel of [
    'plugins/markdown/index.ts',
    'plugins/markdown/blocks.ts',
    'plugins/markdown/client.tsx',
    'plugins/markdown/viewer.tsx',
    'plugins/plaintext/client.tsx',
    'plugins/plaintext/viewer.tsx',
  ]) {
    const src = await readFile(resolve(ROOT, rel), 'utf8');
    assert.equal(/from\s+['"](node:)?fs/.test(src), false, `${rel} 不得直接读文件系统`);
    assert.equal(/from\s+['"](node:)?(http|https|net|dgram)/.test(src), false, `${rel} 不得开网络`);
  }
});

// ---------------------------------------------------------------------------
// S10A-08：插件故障局部化
// ---------------------------------------------------------------------------
test('S10A-08 查看器渲染抛错被收敛为错误码，不向上抛出', async () => {
  const { renderViewerSafely } = await import('../../apps/shell/src/capabilities/safe-render.ts');
  const broken: ViewerCapability = {
    apiVersion: '1',
    extensions: ['.md'],
    render() {
      throw new Error('viewer exploded');
    },
  };

  const failed = renderViewerSafely(broken, { content: '# x', path: 'a.md' });
  assert.equal(failed.ok, false);
  assert.equal(failed.ok ? '' : failed.errorCode, 'ERR_PLUGIN_CRASHED');
  assert.match(failed.ok ? '' : failed.message, /viewer exploded/);

  const healthy = renderViewerSafely(fakeViewer(['.md'], 'ok'), { content: 'x', path: 'a.md' });
  assert.equal(healthy.ok, true);
});

test('S10A-08b 插件激活抛错 → QUARANTINED，其他插件与 Core 不受影响', async () => {
  const runtime = createPluginRuntime();
  const md = await readManifest('plugins/markdown/manifest.json');

  runtime.register(md, moduleWith(fakeViewer(['.md'], 'm')));
  runtime.register(
    {
      ...md,
      id: 'probe.crasher',
      provides: ['file.viewer'],
      requires: [],
    },
    {
      activate() {
        throw new Error('boom on activate');
      },
      capabilities: { 'file.viewer': fakeViewer(['.md'], 'crash') },
    },
  );

  await runtime.activate('probe.crasher');
  const crashed = runtime.status('probe.crasher');
  assert.equal(crashed?.status, 'QUARANTINED');
  assert.equal(crashed?.lastErrorCode, 'ERR_PLUGIN_CRASHED');

  await runtime.activate(md.id);
  assert.equal(runtime.status(md.id)?.status, 'ACTIVE', '另一个插件必须仍可正常启动');

  const resolved = runtime.resolveCapability<ViewerCapability>('file.viewer', { extension: '.md' });
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.provider.pluginId, md.id, '崩溃插件不得被选中');
});

test('S10A-08c 插件面板读取的是真实 Runtime 状态', async () => {
  const panel = await readFile(resolve(ROOT, 'apps/shell/src/components/PluginPanel.tsx'), 'utf8');
  assert.match(panel, /registry\.list\(\)/, '面板必须来自注册表而不是硬编码列表');
  assert.match(panel, /toggle\(/, '面板必须能启用/停用');
  assert.equal(/插件中心（后续阶段）/.test(panel), false);
});
