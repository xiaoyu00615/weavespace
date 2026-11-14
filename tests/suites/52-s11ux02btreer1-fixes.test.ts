/**
 * S11-UX-02B-TREE-R1：GPT 独立复审提出的四项边界缺陷（先红后绿）。
 *
 * R1-01 Legacy 懒加载/分页下的标签恢复：未完整枚举的目录不得判 file-missing；
 * R1-02 逐层加载的异步归属：迟到响应不得回填新层表（纯 TS 确定性 deferred）；
 * R1-03 深目录物化：固定 64 层上限会把 70+ 层目录显示成空文件夹；
 * R1-04 跨页目录变化：数字偏移游标无法保证集合一致，必须有快照标识。
 *
 * 纪律：服务端部分经真实 HTTP 驱动真实 Host；Shell 部分全部走纯 `.ts` 模块，
 * 不依赖 React 运行时，也不用源码字符串冒充行为验证。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { buildTreePage } from '../../apps/server/src/tree.ts';
import type { TreeEntry, TreeQueryOutcome } from '../../apps/shell/src/client/client-api.ts';
import {
  applyPage,
  beginLevel,
  emptyLevels,
  hasMore,
  materializeTree,
  type TreeLevels,
} from '../../apps/shell/src/components/tree-model.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import {
  createWorkspaceRestorer,
  resolveRestorableNode,
} from '../../apps/shell/src/state/workspace-restore.ts';
import type { OpenNodeResult } from '../../apps/shell/src/state/open-document.ts';
import type { WorkspaceAction, WorkspaceState } from '../../apps/shell/src/state/types.ts';
import type { PersistedWorkspaceV1, WorkspaceStore } from '../../apps/shell/src/state/workspace-persistence.ts';
import {
  createTreeLevelLoader,
  type TreeLevelLoader,
  type TreeListRequest,
  type TreeLoadIdentity,
} from '../../apps/shell/src/state/tree-load.ts';

const ROOT = resolve(process.cwd());

/* ------------------------------- 通用夹具 ------------------------------- */

function entry(name: string, kind: TreeEntry['kind'] = 'file', dir = ''): TreeEntry {
  const relPath = dir ? `${dir}/${name}` : name;
  const prefix = kind === 'folder' ? 'dir' : kind === 'link' ? 'link' : 'doc';
  return {
    id: `${prefix}:${relPath}`,
    name,
    kind,
    extension: kind === 'file' && name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '',
    relPath,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let settle: (value: T) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    settle = res;
    fail = rej;
  });
  return { promise, resolve: settle, reject: fail };
}

async function withLegacy(rootDir: string, fn: (server: ShellServer) => Promise<void>): Promise<void> {
  const server = await createShellServer({ rootDir, port: 0 });
  try {
    await fn(server);
  } finally {
    await server.close().catch(() => {});
  }
}

async function call(server: ShellServer, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${server.url}${path}`);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

function pageOf(body: Record<string, unknown>): Record<string, unknown> {
  const page = body.page;
  assert.ok(page && typeof page === 'object', `响应缺少 page: ${JSON.stringify(body)}`);
  return page as Record<string, unknown>;
}

/* ====================================================================== *
 * R1-01 · Legacy 懒加载标签恢复
 * ====================================================================== */

/** 用真实 reducer 造一份 Legacy 层表（键为 ''），避免手写状态漂移。 */
function legacyState(rootEntries: readonly TreeEntry[], nextCursor: string | null, total: number): WorkspaceState {
  let state: WorkspaceState = {
    ...INITIAL_STATE,
    mode: 'live',
    workspaceMode: 'legacy',
    workspaceKey: 'ws-r1-key',
  };
  state = workspaceReducer(state, {
    type: 'TREE_LEVEL_PAGE',
    projectId: '',
    dir: '',
    entries: rootEntries,
    cursor: null,
    nextCursor,
    total,
  });
  return state;
}

test('R1-01-01 Legacy 嵌套目录：父层未加载 → 合成候选交给 Host，不判 file-missing', () => {
  const state = legacyState([entry('docs', 'folder'), entry('a.md')], null, 2);
  const node = resolveRestorableNode(state, 'docs/notes.md', null);
  assert.ok(node, '未加载的子目录里的标签不得被判成 file-missing');
  assert.equal(node?.kind, 'file');
  assert.equal(node?.path, 'docs/notes.md');
  assert.equal(node?.id, 'doc:docs/notes.md', 'Legacy 的 id 不带项目命名空间');
  assert.equal(node?.extension, '.md');
});

test('R1-01-02 Legacy 根层只加载第一页 → 后续页里的文件仍是候选', () => {
  const state = legacyState([entry('a.md')], '1', 5);
  const node = resolveRestorableNode(state, 'z-late.md', null);
  assert.ok(node, '第一页之外的文件不得被判成不存在');
  assert.equal(node?.path, 'z-late.md');
  // 已在第一页里、且确实没有的另一个名字，只要本层还没翻完，也同样不能下结论
  assert.ok(resolveRestorableNode(state, 'maybe.md', null));
});

test('R1-01-03 Legacy 完全加载且确认不存在 → 仍按既有规则判 file-missing', () => {
  let state = legacyState([entry('docs', 'folder'), entry('a.md')], null, 2);
  state = workspaceReducer(state, {
    type: 'TREE_LEVEL_PAGE',
    projectId: '',
    dir: 'docs',
    entries: [entry('deep.md', 'file', 'docs')],
    cursor: null,
    nextCursor: null,
    total: 1,
  });
  assert.equal(resolveRestorableNode(state, 'docs/nope.md', null), null);
  assert.equal(resolveRestorableNode(state, 'nope.md', null), null);
  assert.ok(resolveRestorableNode(state, 'docs/deep.md', null));
  // 无层表（旧式完整树）沿用既有判定
  assert.equal(resolveRestorableNode({ ...INITIAL_STATE }, 'nope.md', null), null);
  // 非法路径 fail-closed
  assert.equal(resolveRestorableNode(state, '../escape.md', null), null);
  assert.equal(resolveRestorableNode(state, 'C:/abs.md', null), null);
});

test('R1-01-04 集成：Legacy 恢复真的把嵌套标签与分页标签交给 Host 验证', async () => {
  const state = legacyState([entry('docs', 'folder'), entry('a.md')], '2', 5);
  const snapshot: PersistedWorkspaceV1 = {
    version: 1,
    workspaceKey: 'ws-r1-key',
    savedAt: new Date().toISOString(),
    ui: {
      navCollapsed: INITIAL_STATE.navCollapsed,
      navKey: INITIAL_STATE.navKey,
      treeCollapsed: INITIAL_STATE.treeCollapsed,
      auxCollapsed: INITIAL_STATE.auxCollapsed,
      auxTab: INITIAL_STATE.auxTab,
      layout: INITIAL_STATE.layout,
      splitRatio: INITIAL_STATE.splitRatio,
      focusedPane: INITIAL_STATE.focusedPane,
    },
    activeProjectId: null,
    expandedByProject: {},
    tabs: [
      { projectId: null, path: 'docs/notes.md', mode: 'live', hadUnsavedChanges: false },
      { projectId: null, path: 'z-late.md', mode: 'live', hadUnsavedChanges: false },
    ],
    panes: {
      primary: { tabIndex: null, mode: 'editor' },
      secondary: { tabIndex: null, mode: 'editor' },
    },
  };
  const store: WorkspaceStore = {
    write: () => 'written',
    read: () => snapshot,
    readLast: () => snapshot,
    clear: () => {},
  };
  const opened: string[] = [];
  const restorer = createWorkspaceRestorer({
    getState: () => state,
    getMode: () => 'live',
    dispatch: () => {},
    store,
    connectLive: async () => ({ workspaceKey: 'ws-r1-key', workspaceMode: 'legacy' }),
    openInBackground: (node): Promise<OpenNodeResult> => {
      opened.push(node.path ?? node.id);
      return Promise.resolve({ ok: false, docId: node.id, errorCode: 'ERR_RESOURCE_NOT_FOUND' });
    },
  });
  const report = await restorer.restore();
  assert.equal(report.workspaceKeyMatched, true, '工作区身份验证仍必须生效');
  assert.deepEqual(opened, ['docs/notes.md', 'z-late.md'], '两个候选都必须交给 Host 判定');
  assert.equal(
    report.skipped.every((item) => item.reason === 'open-rejected'),
    true,
    '由 Host 拒绝，而不是在 Shell 里谎称 file-missing',
  );
});

/* ====================================================================== *
 * R1-02 · 异步归属与代次隔离（纯 TS 确定性迟到响应）
 * ====================================================================== */

interface LoaderHarness {
  loader: TreeLevelLoader;
  actions: WorkspaceAction[];
  requests: TreeListRequest[];
  pending: Deferred<TreeQueryOutcome>[];
  levels: () => TreeLevels;
  setIdentity(next: Partial<TreeLoadIdentity>): void;
  setLevels(next: TreeLevels): void;
}

function appliedPage(names: readonly string[], snapshot = 'S1'): TreeQueryOutcome {
  return {
    status: 'APPLIED',
    level: '',
    entries: names.map((name) => entry(name)),
    page: { limit: 200, cursor: null, nextCursor: null, total: names.length, snapshot },
  };
}

function makeLoader(): LoaderHarness {
  const actions: WorkspaceAction[] = [];
  const requests: TreeListRequest[] = [];
  const pending: Deferred<TreeQueryOutcome>[] = [];
  let identity: TreeLoadIdentity = {
    mode: 'live',
    syncMode: 'live',
    workspaceKey: 'ws-r1-key',
    epoch: 1,
    activeProjectId: 'project-a',
  };
  let levels: TreeLevels = emptyLevels();

  const apply = (action: WorkspaceAction): void => {
    actions.push(action);
    if (action.type === 'TREE_LEVEL_BEGIN') {
      levels = beginLevel(levels, action.dir, action.append);
    } else if (action.type === 'TREE_LEVEL_PAGE') {
      levels = applyPage(levels, action.dir, {
        entries: action.entries,
        cursor: action.cursor,
        nextCursor: action.nextCursor,
        total: action.total,
        snapshot: action.snapshot ?? null,
      });
    } else if (action.type === 'TREE_RESET') {
      levels = emptyLevels();
    }
  };

  const loader = createTreeLevelLoader({
    identity: () => identity,
    levels: () => levels,
    listTree: (request) => {
      requests.push(request);
      const d = deferred<TreeQueryOutcome>();
      pending.push(d);
      return d.promise;
    },
    dispatch: apply,
  });

  return {
    loader,
    actions,
    requests,
    pending,
    levels: () => levels,
    setIdentity: (next) => {
      identity = { ...identity, ...next };
    },
    setLevels: (next) => {
      levels = next;
    },
  };
}

test('R1-02-01 Demo→Live 之后，上一代迟到响应一个 dispatch 都不能发', async () => {
  const h = makeLoader();
  const first = h.loader.load('project-a', '', false);
  assert.equal(h.pending.length, 1);
  const beginCount = h.actions.length;

  // 用户切到 Demo，再切回 Live：模式又变回 live，但代次已经推进
  h.setIdentity({ mode: 'demo', syncMode: 'demo' });
  h.setIdentity({ mode: 'live', syncMode: 'live', epoch: 2 });

  h.pending[0].resolve(appliedPage(['old.md']));
  const outcome = await first;
  assert.equal(outcome, 'stale', '旧请求必须识别为过期');
  assert.equal(h.actions.length, beginCount, '不得回填层表，也不得覆盖 loading/error/ready');
});

test('R1-02-02 重新连接（同一工作区、新代次）旧响应不回填', async () => {
  const h = makeLoader();
  const first = h.loader.load('project-a', '', false);
  const beginCount = h.actions.length;
  h.setIdentity({ epoch: 2 });
  h.pending[0].resolve(appliedPage(['stale.md']));
  assert.equal(await first, 'stale');
  assert.equal(h.actions.length, beginCount);
  assert.equal(
    h.actions.some((action) => action.type === 'TREE_LEVEL_PAGE' || action.type === 'TREE_LEVEL_ERROR'),
    false,
    '旧响应不得回填条目，也不得改写层状态',
  );
  assert.equal(h.levels()['']?.entries.length ?? 0, 0, '层表里没有旧数据');
});

test('R1-02-07 旧代次遗留的 loading 不得把新一代请求挡在门外', async () => {
  const h = makeLoader();
  const old = h.loader.load('project-a', '', false);
  // 重新连接：代次推进 + 全局作废，但旧请求发起时的 BEGIN 仍留在层表里
  h.setIdentity({ epoch: 2 });
  h.loader.invalidateAll();
  const next = h.loader.load('project-a', '', false);
  assert.equal(h.pending.length, 2, '新一代必须能在旧 loading 之上重新发起');

  h.pending[1].resolve(appliedPage(['fresh.md'], 'S2'));
  h.pending[0].resolve(appliedPage(['old.md'], 'S1'));
  assert.equal(await old, 'stale');
  assert.equal(await next, 'applied');
  assert.deepEqual(h.levels()['']?.entries.map((n) => n.name), ['fresh.md']);
});

test('R1-02-03 刷新同项目：旧请求不得覆盖新请求写入的层表', async () => {
  const h = makeLoader();
  const oldLoad = h.loader.load('project-a', '', false);

  // 刷新项目 A：作废该项目所有在途层，并把层表清空（与 TREE_RESET 一致）
  h.loader.invalidateProject('project-a');
  h.setLevels(emptyLevels());
  const newLoad = h.loader.load('project-a', '', false);
  assert.equal(h.pending.length, 2, '刷新后新请求必须能发出');

  h.pending[1].resolve(appliedPage(['new.md'], 'S2'));
  assert.equal(await newLoad, 'applied');

  h.pending[0].resolve(appliedPage(['old.md'], 'S1'));
  assert.equal(await oldLoad, 'stale', '旧请求迟于新请求返回，必须丢弃');
  assert.deepEqual(h.levels()['']?.entries.map((n) => n.name), ['new.md']);
  assert.equal(h.levels()['']?.snapshot, 'S2');
});

test('R1-02-04 旧请求的失败结果不得把新请求的层写成 error', async () => {
  const h = makeLoader();
  const oldLoad = h.loader.load('project-a', '', false);
  h.loader.invalidateProject('project-a');
  h.setLevels(emptyLevels());
  const newLoad = h.loader.load('project-a', '', false);

  h.pending[0].resolve({ status: 'REJECTED', errorCode: 'ERR_DIR_UNREADABLE' });
  assert.equal(await oldLoad, 'stale');
  h.pending[1].resolve(appliedPage(['new.md']));
  assert.equal(await newLoad, 'applied');

  assert.equal(
    h.actions.some((action) => action.type === 'TREE_LEVEL_ERROR'),
    false,
    '过期请求连 error 都不能派发',
  );
  assert.equal(h.levels()['']?.status, 'ready');
});

test('R1-02-05 其它项目刷新 / 切换焦点不应取消当前项目的有效加载', async () => {
  const h = makeLoader();
  const load = h.loader.load('project-a', '', false);
  h.loader.invalidateProject('project-b');
  h.setIdentity({ activeProjectId: 'project-b' });
  h.pending[0].resolve(appliedPage(['a.md']));
  assert.equal(await load, 'applied');
  assert.deepEqual(h.levels()['']?.entries.map((n) => n.name), ['a.md']);
});

test('R1-02-06 同层并发单飞；续页原样回传快照；刷新不动标签与草稿', async () => {
  const h = makeLoader();
  const first = h.loader.load('project-a', '', false);
  assert.equal(await h.loader.load('project-a', '', false), 'skipped-inflight');
  assert.equal(h.requests.length, 1, '同一目录不得并发发两次');
  h.pending[0].resolve({
    status: 'APPLIED',
    level: '',
    entries: [entry('a.md')],
    page: { limit: 1, cursor: null, nextCursor: '1', total: 2, snapshot: 'SNAP' },
  });
  assert.equal(await first, 'applied');

  const more = h.loader.load('project-a', '', true);
  assert.equal(h.requests[1].cursor, '1');
  assert.equal(h.requests[1].snapshot, 'SNAP', '续页必须带上本轮快照');
  h.pending[1].resolve(appliedPage(['b.md'], 'SNAP'));
  assert.equal(await more, 'applied');

  let state: WorkspaceState = workspaceReducer(INITIAL_STATE, {
    type: 'OPEN_TAB',
    tab: {
      docId: 'doc:project-a/a.md',
      projectId: 'project-a',
      path: 'a.md',
      title: 'a.md',
      extension: '.md',
      buffer: '# 草稿',
      dirty: true,
      mode: 'live',
      sessionId: 's1',
      viewId: 'v1',
      baseVersion: 'v0',
      revision: 0,
      documentState: 'EDITING_DIRTY',
      saving: false,
      lastStatus: null,
      errorCode: null,
    },
  });
  state = workspaceReducer(state, { type: 'TREE_RESET', projectId: 'project-a' });
  assert.equal(state.tabs.length, 1, '刷新不得清除标签');
  assert.equal(state.tabs[0].dirty, true, '刷新不得清除草稿');
});

/* ====================================================================== *
 * R1-03 · 深目录物化（不得用固定深度静默丢弃）
 * ====================================================================== */

function deepLevels(depth: number): TreeLevels {
  let levels = emptyLevels();
  for (let i = 0; i < depth; i += 1) {
    const dir = Array.from({ length: i }, (_, j) => `d${j}`).join('/');
    const name = `d${i}`;
    const relPath = dir ? `${dir}/${name}` : name;
    levels = applyPage(levels, dir, {
      entries: [{ id: `dir:${relPath}`, name, kind: 'folder', extension: '', relPath }],
      cursor: null,
      nextCursor: null,
      total: 1,
    });
  }
  const deepest = Array.from({ length: depth }, (_, j) => `d${j}`).join('/');
  levels = applyPage(levels, deepest, {
    entries: [{ id: `doc:${deepest}/leaf.md`, name: 'leaf.md', kind: 'file', extension: '.md', relPath: `${deepest}/leaf.md` }],
    cursor: null,
    nextCursor: null,
    total: 1,
  });
  return levels;
}

test('R1-03-01 74 层真实目录全部可见，末层文件不得显示成空文件夹', () => {
  const depth = 74;
  const levels = deepLevels(depth);
  let nodes = materializeTree(levels);
  for (let i = 0; i < depth; i += 1) {
    const folder = nodes.find((n) => n.name === `d${i}`);
    assert.ok(folder, `第 ${i} 层目录必须存在（固定深度上限会把它截断）`);
    nodes = folder?.children ?? [];
  }
  assert.deepEqual(nodes.map((n) => n.name), ['leaf.md'], '末层文件必须可见');
});

test('R1-03-02 自指/回边数据按路径身份终止，不无限递归', () => {
  let levels = emptyLevels();
  levels = applyPage(levels, '', {
    entries: [{ id: 'dir:a', name: 'a', kind: 'folder', extension: '', relPath: 'a' }],
    cursor: null,
    nextCursor: null,
    total: 1,
  });
  // a 层里的子目录把 path 指回 a：按路径身份必须断掉这条回边
  levels = applyPage(levels, 'a', {
    entries: [{ id: 'dir:a', name: 'a', kind: 'folder', extension: '', relPath: 'a' }],
    cursor: null,
    nextCursor: null,
    total: 1,
  });
  const tree = materializeTree(levels);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].children?.[0].children, undefined, '回边不得继续展开');
});

/* ====================================================================== *
 * R1-04 · 分页期间目录变化检测
 * ====================================================================== */

test('R1-04-01 buildTreePage：静态目录跨页快照一致；条目集合变化则快照变化', () => {
  const base = [entry('a.md'), entry('b.md'), entry('c.md'), entry('d.md')].map((e) => ({
    name: e.name,
    kind: e.kind as 'folder' | 'file' | 'link',
  }));
  const first = buildTreePage(base, { dir: '', limit: 2 });
  const second = buildTreePage(base, { dir: '', cursor: 2, limit: 2 });
  const snapshotOf = (p: { page: unknown }): string | undefined =>
    (p.page as { snapshot?: string }).snapshot;
  assert.ok(snapshotOf(first), '每一页都必须带目录快照标识');
  assert.equal(snapshotOf(first), snapshotOf(second), '同一份目录的两页必须共用同一个快照');
  assert.equal(snapshotOf(buildTreePage(base, { dir: '', cursor: 2, limit: 1 })), snapshotOf(first), 'limit 变化不影响快照');

  const changed = buildTreePage([...base, { name: 'e.md', kind: 'file' as const }], { dir: '', limit: 2 });
  assert.notEqual(snapshotOf(changed), snapshotOf(first), '新增条目必须改变快照');
  const renamed = buildTreePage(base.map((e) => (e.name === 'c.md' ? { ...e, name: 'c2.md' } : e)), { dir: '', limit: 2 });
  assert.notEqual(snapshotOf(renamed), snapshotOf(first), '重命名必须改变快照');
});

test('R1-04-02 HTTP：第一页后插入文件 → 409 ERR_DIR_CHANGED，不返回可能遗漏的第二页', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-r1-insert-'));
  try {
    const root = join(base, 'root');
    await mkdir(root, { recursive: true });
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) await writeFile(join(root, name), 'x');
    await withLegacy(root, async (server) => {
      const first = await call(server, '/api/tree?limit=2');
      assert.equal(first.status, 200);
      const snapshot = pageOf(first.body).snapshot as string;
      assert.ok(snapshot);
      await writeFile(join(root, 'aa-new.md'), 'x');
      const changed = await call(server, `/api/tree?cursor=2&limit=2&snapshot=${snapshot}`);
      assert.equal(changed.status, 409, '目录变了不能当成正常续页');
      assert.equal(changed.body.errorCode, 'ERR_DIR_CHANGED');
      assert.match(String(changed.body.message ?? ''), /目录已变化/);
    });
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

test('R1-04-03 HTTP：删除与重命名同样被检测为目录变化', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-r1-delete-'));
  try {
    const root = join(base, 'root');
    await mkdir(root, { recursive: true });
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) await writeFile(join(root, name), 'x');
    await withLegacy(root, async (server) => {
      const first = await call(server, '/api/tree?limit=2');
      const snapshot = pageOf(first.body).snapshot as string;
      await unlink(join(root, 'd.md'));
      assert.equal((await call(server, `/api/tree?cursor=2&limit=2&snapshot=${snapshot}`)).body.errorCode, 'ERR_DIR_CHANGED');

      const again = await call(server, '/api/tree?limit=2');
      const snapshot2 = pageOf(again.body).snapshot as string;
      await rename(join(root, 'c.md'), join(root, 'z-renamed.md'));
      assert.equal((await call(server, `/api/tree?cursor=2&limit=2&snapshot=${snapshot2}`)).body.errorCode, 'ERR_DIR_CHANGED');
    });
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

test('R1-04-04 HTTP：静态目录保留正常分页、去重、排序与全量遍历', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-r1-static-'));
  try {
    const root = join(base, 'root');
    await mkdir(root, { recursive: true });
    const expected = Array.from({ length: 23 }, (_, i) => `f${String(i).padStart(2, '0')}.md`);
    for (const name of expected) await writeFile(join(root, name), 'x');
    await withLegacy(root, async (server) => {
      const names: string[] = [];
      let cursor: string | null = null;
      let snapshot: string | null = null;
      let guard = 0;
      do {
        const query = new URLSearchParams({ limit: '7' });
        if (cursor !== null) query.set('cursor', cursor);
        if (snapshot !== null) query.set('snapshot', snapshot);
        const res = await call(server, `/api/tree?${query.toString()}`);
        assert.equal(res.status, 200, `第 ${guard + 1} 页必须成功`);
        const page = pageOf(res.body);
        for (const item of res.body.entries as Array<{ name: string }>) names.push(item.name);
        snapshot = (page.snapshot as string) ?? null;
        cursor = (page.nextCursor as string | null) ?? null;
        guard += 1;
      } while (cursor !== null && guard < 20);
      assert.equal(guard, 4, '23 项 / 每页 7 项 = 4 页');
      assert.equal(new Set(names).size, names.length, '不得重复');
      assert.deepEqual(names, expected, '不得遗漏且顺序稳定');
    });
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

test('R1-04-05 Shell：目录变化错误不得被当成"全部加载完成"', async () => {
  let state: WorkspaceState = workspaceReducer(INITIAL_STATE, {
    type: 'TREE_LEVEL_PAGE',
    projectId: 'project-a',
    dir: '',
    entries: [entry('a.md')],
    cursor: null,
    nextCursor: '1',
    total: 3,
    snapshot: 'S1',
  });
  state = workspaceReducer(state, {
    type: 'TREE_LEVEL_ERROR',
    projectId: 'project-a',
    dir: '',
    errorCode: 'ERR_DIR_CHANGED',
  });
  const level = state.treeByProject['project-a'][''];
  assert.equal(level.status, 'error', '不得变成 ready');
  assert.equal(level.errorCode, 'ERR_DIR_CHANGED');
  assert.equal(level.nextCursor, null, '旧游标必须作废，不能继续按偏移追加');
  assert.equal(level.snapshot, null, '旧快照必须作废');
  assert.deepEqual(level.entries, [], '变化前那一页不得冒充完整结果继续显示');
  assert.equal(hasMore(state.treeByProject['project-a'], ''), false);

  const source = await readFile(resolve(ROOT, 'apps/shell/src/components/TreeBranch.tsx'), 'utf8');
  assert.match(source, /目录已变化/, 'UI 必须给出明确的"目录已变化，请刷新"状态');
  assert.match(source, /ERR_DIR_CHANGED/);
});

test('R1-04-06 非法 snapshot 参数零 IO 拒绝；不传 snapshot 的旧客户端仍可正常分页', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-r1-bad-snapshot-'));
  try {
    const root = join(base, 'root');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'a.md'), 'x');
    await writeFile(join(root, 'b.md'), 'x');
    await writeFile(join(root, 'c.md'), 'x');
    await withLegacy(root, async (server) => {
      const bad = await call(server, '/api/tree?cursor=1&limit=1&snapshot=not-a-hash!');
      assert.equal(bad.status, 400);
      assert.equal(bad.body.errorCode, 'ERR_COMMAND_INVALID');
      const legacy = await call(server, '/api/tree?cursor=1&limit=1');
      assert.equal(legacy.status, 200, '不带快照的既有请求形状保持兼容');
    });
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});
