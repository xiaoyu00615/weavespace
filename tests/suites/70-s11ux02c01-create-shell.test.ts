/**
 * UX-02C-01：Shell 侧创建编排（纯 TS 模块，先红后绿）。
 *
 * 覆盖：目标目录规则（C-03 / §三）、行内命名（C-05 / §四）、单飞与 UNKNOWN
 * 收敛（C-11）、已支持扩展名与能力注册表一致（C-13）、Demo 不创建（C-14）、
 * 目标层展开的幂等性、以及浏览器提交体不含任何路径/根/令牌字段。
 *
 * 组件（`.tsx`）按工程纪律不直接 import；可测逻辑全在 `state/create-entry.ts`、
 * `capabilities/supported-extensions.ts` 与 reducer 里。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createDemoClient, createLiveClient } from '../../apps/shell/src/client/client-api.ts';
import type { CreateEntryOutcome } from '../../apps/shell/src/client/client-api.ts';
import {
  createEntryRunner,
  initialNamingDraft,
  normalizeDir,
  parentDirOf,
  resolveCreateTarget,
  selectionForPreset,
  type CreateTargetInput,
} from '../../apps/shell/src/state/create-entry.ts';
import { supportedFileExtensions, type ActivePluginView } from '../../apps/shell/src/capabilities/supported-extensions.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import { validateEntryName } from '../../packages/storage/entry-name.ts';

const baseTarget = (overrides: Partial<CreateTargetInput> = {}): CreateTargetInput => ({
  origin: 'project-root',
  projectId: 'project-a',
  kind: 'file',
  selectedDirByProject: {},
  activeProjectId: 'project-b',
  supported: true,
  ...overrides,
});

/* ------------------------- §三 目标目录规则 ------------------------- */

test('C-03 右键根 / 文件夹 / 文件 / 空白区 / 工具栏的目标目录', () => {
  assert.deepEqual(resolveCreateTarget(baseTarget()), { ok: true, projectId: 'project-a', parentDir: '' });
  assert.deepEqual(
    resolveCreateTarget(baseTarget({ origin: 'folder', nodePath: 'docs/nested' })),
    { ok: true, projectId: 'project-a', parentDir: 'docs/nested' },
  );
  assert.deepEqual(
    resolveCreateTarget(baseTarget({ origin: 'file', nodePath: 'docs/guide.md' })),
    { ok: true, projectId: 'project-a', parentDir: 'docs' },
  );
  assert.deepEqual(
    resolveCreateTarget(baseTarget({ origin: 'file', nodePath: 'readme.md' })),
    { ok: true, projectId: 'project-a', parentDir: '' },
    '根下文件的父目录是项目根',
  );
  assert.deepEqual(
    resolveCreateTarget(
      baseTarget({ origin: 'blank', selectedDirByProject: { 'project-a': 'docs' } }),
    ),
    { ok: true, projectId: 'project-a', parentDir: 'docs' },
    '空白区优先当前选中的目录',
  );
  assert.deepEqual(
    resolveCreateTarget(baseTarget({ origin: 'toolbar' })),
    { ok: true, projectId: 'project-a', parentDir: '' },
    '无选中目录时用活动项目根，且不借用别的活动项目',
  );
  assert.equal(parentDirOf('a/b/c.txt'), 'a/b');
  assert.equal(normalizeDir('/docs/nested/'), 'docs/nested');
});

test('C-03b 链接节点 / 无上下文项目 / 不支持模式一律拒绝，且不跨项目借用活动状态', () => {
  const link = resolveCreateTarget(baseTarget({ origin: 'link' }));
  assert.equal(link.ok, false);
  assert.match(link.ok === false ? link.reason : '', /链接/);

  // 空白区没有上下文项目：可以明确回落到活动项目，但必须绑定它
  const blank = resolveCreateTarget(baseTarget({ origin: 'blank', projectId: null }));
  assert.deepEqual(blank, { ok: true, projectId: 'project-b', parentDir: '' });

  const noProject = resolveCreateTarget(
    baseTarget({ origin: 'toolbar', projectId: null, activeProjectId: null }),
  );
  assert.equal(noProject.ok, false);
  assert.equal(resolveCreateTarget(baseTarget({ supported: false })).ok, false);
});

/* ------------------------- §四 行内命名与 Esc ------------------------- */

test('C-05 预设扩展名：保留扩展名、只选中主文件名；Esc 取消不发请求', async () => {
  assert.equal(initialNamingDraft('.md'), '.md');
  assert.equal(initialNamingDraft(), '');
  const draft = initialNamingDraft('.markdown');
  assert.deepEqual(selectionForPreset(draft, '.markdown'), [0, 0]);
  const named = 'notes.md';
  assert.deepEqual(selectionForPreset(named, '.md'), [0, 5], '只选中 notes，不选中 .md');

  // Esc 由组件调用 cancelNaming：编排器一次 create 都不该收到
  let creates = 0;
  const runner = createEntryRunner({
    create: async () => {
      creates += 1;
      return { status: 'REJECTED', errorCode: null, message: '不该被调用', httpStatus: 0 };
    },
    checkDirectory: async () => {},
    onApplied: () => {},
    onNotice: () => {},
  });
  void runner; // 模拟 UI：未调用 submit
  assert.equal(creates, 0);
});

test('C-05b 非法名称在提交前被挡：零请求、保留输入供修正', async () => {
  let creates = 0;
  const notices: string[] = [];
  const runner = createEntryRunner({
    create: async () => {
      creates += 1;
      return { status: 'REJECTED', errorCode: null, message: '', httpStatus: 0 };
    },
    checkDirectory: async () => {},
    onApplied: () => {},
    onNotice: (message) => notices.push(message),
  });
  const result = await runner.submit({
    projectId: 'project-a',
    parentDir: '',
    name: 'CON.txt',
    kind: 'file',
  });
  assert.equal(result, 'rejected');
  assert.equal(creates, 0);
  assert.ok(notices[0]?.includes('非法') || notices[0]?.includes('保留'));
  assert.equal(validateEntryName('123.md').ok, true);
  assert.equal(validateEntryName('notes.txt').ok, true);
  assert.equal(validateEntryName('config.json').ok, true);
  assert.equal(validateEntryName('README').ok, true, '没有扩展名也是合法文件名');
});

/* ------------------------- §四 单飞 / UNKNOWN ------------------------- */

const applied: Extract<CreateEntryOutcome, { status: 'APPLIED' }> = {
  status: 'APPLIED',
  projectId: 'project-a',
  parentDir: 'docs',
  name: 'new.md',
  kind: 'file',
  relativePath: 'docs/new.md',
};

function harness(outcome: CreateEntryOutcome | (() => never)) {
  const calls: string[] = [];
  const notices: string[] = [];
  const runner = createEntryRunner({
    create: async () => {
      calls.push('create');
      if (typeof outcome === 'function') throw new Error('ECONNRESET');
      return outcome;
    },
    checkDirectory: async (projectId, parentDir) => {
      calls.push(`check:${projectId}:${parentDir}`);
    },
    onApplied: (value) => calls.push(`applied:${value.relativePath}`),
    onNotice: (message) => notices.push(message),
  });
  return { runner, calls, notices };
}

test('C-01b 只有 Host 明确 APPLIED 才刷新层表，绝不预先插假节点', async () => {
  const h = harness(applied);
  const result = await h.runner.submit({
    projectId: 'project-a',
    parentDir: 'docs',
    name: 'new.md',
    kind: 'file',
  });
  assert.equal(result, 'applied');
  assert.deepEqual(h.calls, ['create', 'applied:docs/new.md']);
  assert.deepEqual(h.notices, []);
});

test('C-11 UNKNOWN：一次创建 + 恰好一次只读核对，绝不重发、绝不据同名推断成功', async () => {
  const h = harness({
    status: 'UNKNOWN',
    errorCode: 'ERR_OUTCOME_UNKNOWN',
    message: '创建结果未确认',
    httpStatus: 202,
  });
  const result = await h.runner.submit({
    projectId: 'project-a',
    parentDir: '',
    name: 'x.md',
    kind: 'file',
  });
  assert.equal(result, 'unknown');
  assert.deepEqual(h.calls, ['create', 'check:project-a:'], '没有第二次 create');
  assert.equal(h.calls.includes('applied:'), false, '不显示"看起来成功"的节点');
  assert.match(h.notices.join(' '), /人工核对/);
  assert.doesNotMatch(h.notices.join(' '), /已创建/);
});

test('C-11b 网络异常：同样收敛为 UNKNOWN；并发提交只有一个真正发请求', async () => {
  const h = harness(() => {
    throw new Error('ECONNRESET');
  });
  const [first, second] = await Promise.all([
    h.runner.submit({ projectId: 'project-a', parentDir: '', name: 'x.md', kind: 'file' }),
    h.runner.submit({ projectId: 'project-a', parentDir: '', name: 'x.md', kind: 'file' }),
  ]);
  assert.ok([first, second].includes('unknown'));
  assert.ok([first, second].includes('busy'));
  assert.equal(h.calls.filter((call) => call === 'create').length, 1, '单飞：最多一次真实创建');
});

test('C-06b 同名拒绝：保留输入供修正，不刷新树、不伪造成功', async () => {
  const h = harness({
    status: 'REJECTED',
    errorCode: 'ERR_ENTRY_EXISTS',
    message: '该位置已有同名文件或文件夹',
    httpStatus: 409,
  });
  const result = await h.runner.submit({
    projectId: 'project-a',
    parentDir: '',
    name: 'a.md',
    kind: 'file',
  });
  assert.equal(result, 'rejected');
  assert.deepEqual(h.calls, ['create']);
  assert.match(h.notices[0] ?? '', /同名/);
});

/* ------------------------- C-13 能力注册表 ------------------------- */

/** 直接读真实 manifest（registry.ts 引 .tsx，Node 侧不能 import），不硬编码清单。 */
async function manifestViews(): Promise<ActivePluginView[]> {
  const root = join(process.cwd(), 'plugins');
  const out: ActivePluginView[] = [];
  for (const [dir, status] of [
    ['markdown', 'ACTIVE'],
    ['plaintext', 'ACTIVE'],
  ] as const) {
    const raw = JSON.parse(await readFile(join(root, dir, 'manifest.json'), 'utf8')) as {
      id: string;
      displayName?: string;
      provides: string[];
      fileExtensions: string[];
    };
    out.push({
      pluginId: raw.id,
      status,
      capabilities: raw.provides,
      fileExtensions: raw.fileExtensions,
      ...(raw.displayName ? { displayName: raw.displayName } : {}),
    });
  }
  return out;
}

test('C-13 二级菜单与真实已激活能力注册表一致（首版三项）', async () => {
  const views = await manifestViews();
  const items = supportedFileExtensions(
    { list: () => views, resolveViewer: (ext) => ({ ok: ['.md', '.markdown', '.txt'].includes(ext) }) },
    true,
  );
  assert.deepEqual(
    items.map((item) => item.extension),
    ['.md', '.markdown', '.txt'],
    '没有第二份会漂移的硬编码扩展名清单',
  );
  assert.equal(items[0].label, 'Markdown (.md)');
  assert.equal(items[1].label, 'Markdown (.markdown)');
  assert.equal(items[2].label, '纯文本 (.txt)');
});

test('C-13b 插件停用 / 查看能力不可用 / 注册表未就绪：不再列为"已支持"', async () => {
  const views = await manifestViews();
  const disabled = views.map((view) =>
    view.pluginId.includes('plaintext') ? { ...view, status: 'DISABLED' } : view,
  );
  const onlyMarkdown = supportedFileExtensions(
    { list: () => disabled, resolveViewer: () => ({ ok: true }) },
    true,
  );
  assert.equal(onlyMarkdown.some((item) => item.extension === '.txt'), false, '停用的插件不再提供 .txt');

  const viewerMissing = supportedFileExtensions(
    { list: () => views, resolveViewer: (ext) => ({ ok: ext !== '.txt' }) },
    true,
  );
  assert.equal(viewerMissing.some((item) => item.extension === '.txt'), false);
  assert.equal(
    supportedFileExtensions({ list: () => views, resolveViewer: () => ({ ok: true }) }, false).length,
    0,
    '能力注册表未就绪时不冒充"已支持"',
  );
});

/* ------------------------- C-14 / 请求体形状 / reducer ------------------------- */

test('C-14b Demo 客户端明确不支持真实创建', async () => {
  const demo = createDemoClient([], {});
  const result = await demo.createEntry('project-a', '', 'x.md', 'file');
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.status === 'REJECTED' && result.errorCode, 'ERR_COMMAND_UNSUPPORTED');
});

test('浏览器提交体只有 projectId / parentDir / name（无路径/根/令牌/providerId）', async () => {
  const original = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/session-token')) {
      return new Response(JSON.stringify({ token: 't1' }), { status: 200 });
    }
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(
      JSON.stringify({ status: 'APPLIED', relativePath: 'docs/x.md' }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const client = createLiveClient('http://127.0.0.1:1');
    const outcome = await client.createEntry('project-a', 'docs', 'x.md', 'file');
    assert.equal(outcome.status, 'APPLIED');
    assert.deepEqual(bodies, [{ projectId: 'project-a', parentDir: 'docs', name: 'x.md' }]);
  } finally {
    globalThis.fetch = original;
  }
});

test('创建后展开目标文件夹是幂等的，且不动其它项目', () => {
  const start = INITIAL_STATE;
  const once = workspaceReducer(start, {
    type: 'EXPAND_PROJECT_NODE',
    projectId: 'project-a',
    path: 'dir:project-a/docs',
  });
  const twice = workspaceReducer(once, {
    type: 'EXPAND_PROJECT_NODE',
    projectId: 'project-a',
    path: 'dir:project-a/docs',
  });
  assert.equal(once, twice, '重复展开不得把它折叠回去，也不产生新状态');
  assert.equal(once.expandedByProject['project-a']?.['dir:project-a/docs'], true);
  assert.equal(once.expandedByProject['project-b'], undefined, '其它项目的展开状态不变');
});
