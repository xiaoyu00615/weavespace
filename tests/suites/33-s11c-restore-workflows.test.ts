/**
 * S11-C 恢复工作流（PC-07…PC-23）。
 *
 * 与套件 30 同一思路：**真实 Host + 真实 reducer + 真实打开编排器**，
 * 只有"上一轮会话"是手工构造的（用序列化结果当作浏览器存储里的记录）。
 * "刷新浏览器"= 丢掉 WorkspaceState、保留 storage、重新走一遍启动恢复。
 *
 * 迟到响应用受控 Promise 制造，不依赖 sleep。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createShellServer } from '../../apps/server/src/server.ts';
import { createLiveClient, type WeaveSpaceClient } from '../../apps/shell/src/client/client-api.ts';
import { createDocumentOpener, createEditEpochs } from '../../apps/shell/src/state/open-document.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import { loadWorkspace } from '../../apps/shell/src/state/workspace-load.ts';
import { createWorkspaceRestorer, type RestoreReport } from '../../apps/shell/src/state/workspace-restore.ts';
import {
  createWorkspaceStore,
  serializeWorkspace,
  storageKeyFor,
  type PersistedWorkspaceV1,
  type StorageLike,
} from '../../apps/shell/src/state/workspace-persistence.ts';
import type {
  ClientMode,
  DocTab,
  ResourceNodeState,
  WorkspaceAction,
  WorkspaceState,
} from '../../apps/shell/src/state/types.ts';
import type { WorkspaceConfig } from '../../packages/project-registry/index.ts';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

interface Roots {
  base: string;
  rootA: string;
  rootB: string;
  /** 故意不创建：Multi 里它是 UNAVAILABLE。 */
  rootC: string;
  cleanup(): Promise<void>;
}

async function makeRoots(prefix: string): Promise<Roots> {
  const base = await mkdtemp(join(tmpdir(), prefix));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  const rootC = join(base, 'project-c');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await mkdir(join(rootB, 'x'), { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'notes.md'), '# notes\n', 'utf8');
  await writeFile(join(rootB, 'a.md'), '# B\n', 'utf8');
  await writeFile(join(rootB, 'x', 'deep.md'), '# deep\n', 'utf8');
  return {
    base,
    rootA,
    rootB,
    rootC,
    async cleanup() {
      await rm(base, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

type HostKind = 'multi' | 'legacy';

interface Host {
  url: string;
  close(): Promise<void>;
}

async function startHost(roots: Roots, kind: HostKind): Promise<Host> {
  if (kind === 'legacy') {
    const server = await createShellServer({ rootDir: roots.rootA, port: 0 });
    return { url: server.url, close: () => server.close() };
  }
  const workspace: WorkspaceConfig = {
    version: 1,
    projects: [
      { projectId: 'project-a', name: '项目 A', rootDir: roots.rootA },
      { projectId: 'project-b', name: '项目 B', rootDir: roots.rootB },
      // 根不存在 → UNAVAILABLE（恢复流程必须跳过它，且不得创建任何文件）
      { projectId: 'project-c', name: '项目 C', rootDir: roots.rootC },
    ],
  };
  const server = await createShellServer({ workspace, port: 0 });
  return { url: server.url, close: () => server.close() };
}

/** 内存 Storage（模拟 localStorage）。 */
class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

interface SeenView {
  sessionId: string;
  viewId: string;
}

interface Call {
  name: string;
  path?: string;
  projectId?: string;
}

interface Harness {
  readonly state: WorkspaceState;
  readonly opener: ReturnType<typeof createDocumentOpener>;
  readonly restorer: ReturnType<typeof createWorkspaceRestorer>;
  readonly store: ReturnType<typeof createWorkspaceStore>;
  readonly storage: MemoryStorage;
  readonly inner: WeaveSpaceClient;
  readonly calls: Call[];
  readonly views: SeenView[];
  mode(): ClientMode;
  dispatch(action: WorkspaceAction): void;
  /** 模拟"上一轮会话"：连接 Host 并加载项目/资源（不触发恢复）。 */
  bootLive(): Promise<void>;
  /** 把当前状态写成存储记录（= 离开页面前的那次 flush）。 */
  saveSnapshot(): PersistedWorkspaceV1;
  /** 挂起下一次 openDocument 的响应；返回放行函数。 */
  holdNextOpen(): () => void;
  /** 等到下一次 openDocument 真的发出去（而不是等到响应）。 */
  nextOpenStarted(): Promise<void>;
  setMode(mode: ClientMode): void;
  restore(): Promise<RestoreReport>;
}

function makeHarness(url: string, storage: MemoryStorage): Harness {
  let state: WorkspaceState = { ...INITIAL_STATE };
  let mode: ClientMode = 'demo';

  const calls: Call[] = [];
  const views: SeenView[] = [];
  const inner = createLiveClient(url);
  const store = createWorkspaceStore(storage);

  let gate: Promise<void> | null = null;
  let releaseGate: (() => void) | null = null;
  let openStarted: (() => void) | null = null;

  const client: WeaveSpaceClient = {
    ...inner,
    async workspaceIdentity() {
      calls.push({ name: 'workspaceIdentity' });
      return inner.workspaceIdentity();
    },
    async workspaceMode() {
      calls.push({ name: 'workspaceMode' });
      return inner.workspaceMode();
    },
    async listProjects() {
      calls.push({ name: 'listProjects' });
      return inner.listProjects();
    },
    async listResources(projectId?: string) {
      calls.push(projectId ? { name: 'listResources', projectId } : { name: 'listResources' });
      return inner.listResources(projectId);
    },
    async openDocument(path: string, projectId?: string) {
      calls.push(projectId ? { name: 'openDocument', path, projectId } : { name: 'openDocument', path });
      const started = openStarted;
      openStarted = null;
      started?.();
      const pending = inner.openDocument(path, projectId);
      const held = gate;
      if (held) {
        // 只挂起这一次响应：恢复期间用户打开别的文件必须能正常完成
        gate = null;
        await held;
      }
      const outcome = await pending;
      if (outcome.document?.viewId) {
        views.push({ sessionId: outcome.document.sessionId, viewId: outcome.document.viewId });
      }
      return outcome;
    },
    async readDocument(sessionId: string, viewId?: string | null) {
      calls.push({ name: 'readDocument' });
      return inner.readDocument(sessionId, viewId);
    },
    async applyEdit(sessionId: string, buffer: string, expected?: string | null, viewId?: string | null) {
      calls.push({ name: 'applyEdit' });
      return inner.applyEdit(sessionId, buffer, expected, viewId);
    },
    async saveDocument(sessionId: string, expected: string, viewId?: string | null) {
      calls.push({ name: 'saveDocument' });
      return inner.saveDocument(sessionId, expected, viewId);
    },
    async closeDocument(sessionId: string, viewId: string) {
      calls.push({ name: 'closeDocument' });
      return inner.closeDocument(sessionId, viewId);
    },
    async readDisk(sessionId: string, viewId?: string | null) {
      calls.push({ name: 'readDisk' });
      return inner.readDisk(sessionId, viewId);
    },
    async reloadDocument(sessionId: string, viewId: string) {
      calls.push({ name: 'reloadDocument' });
      return inner.reloadDocument(sessionId, viewId);
    },
  };

  const clientFor = (target: ClientMode): WeaveSpaceClient => {
    if (target !== 'live') throw new Error(`测试不应使用 ${target} 客户端`);
    return client;
  };

  const dispatch = (action: WorkspaceAction): void => {
    state = workspaceReducer(state, action);
  };

  const opener = createDocumentOpener({
    getState: () => state,
    getMode: () => mode,
    dispatch,
    clientFor,
    editEpochs: createEditEpochs(),
  });

  const restorer = createWorkspaceRestorer({
    getState: () => state,
    getMode: () => mode,
    dispatch,
    store,
    async connectLive() {
      // 与 Provider 完全一致：先探测 Host，连不上就不切进 live
      const probe = await client.workspaceIdentity().catch(() => null);
      if (!probe) return null;
      if (mode !== 'live') {
        // 与 Provider 的 switchMode 顺序一致：先同步模式，再派发
        mode = 'live';
        dispatch({ type: 'SET_MODE', mode: 'live' });
      }
      const loaded = await loadWorkspace({ getState: () => state, dispatch, clientFor });
      return loaded ? { workspaceKey: loaded.workspaceKey, workspaceMode: loaded.workspaceMode } : null;
    },
    openInBackground: (node, projectId) => opener.openNode(node, projectId, { background: true }),
  });

  return {
    get state() {
      return state;
    },
    opener,
    restorer,
    store,
    storage,
    inner,
    calls,
    views,
    mode: () => mode,
    dispatch,
    async bootLive() {
      mode = 'live';
      dispatch({ type: 'SET_MODE', mode: 'live' });
      const loaded = await loadWorkspace({ getState: () => state, dispatch, clientFor });
      assert.ok(loaded, '夹具前提：Host 必须可连接');
    },
    saveSnapshot() {
      const snapshot = serializeWorkspace(state, { workspaceKey: state.workspaceKey });
      assert.ok(snapshot, '夹具前提：live 且身份已知时必须能序列化');
      assert.equal(store.write(snapshot), 'written');
      return snapshot;
    },
    holdNextOpen() {
      gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      return () => {
        gate = null;
        releaseGate?.();
        releaseGate = null;
      };
    },
    nextOpenStarted() {
      return new Promise<void>((resolve) => {
        openStarted = resolve;
      });
    },
    setMode(next) {
      mode = next;
      restorer.noteInteraction();
      dispatch({ type: 'SET_MODE', mode: next });
    },
    restore() {
      return restorer.restore();
    },
  };
}

function nodeOf(path: string, projectId: string | null): ResourceNodeState {
  const id = projectId ? `doc:${projectId}/${path}` : `doc:${path}`;
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return {
    id,
    name,
    kind: 'file',
    extension: dot > 0 ? name.slice(dot).toLowerCase() : '',
    path,
  };
}

function tabOf(overrides: Partial<DocTab> & Pick<DocTab, 'docId' | 'path'>): DocTab {
  return {
    projectId: null,
    title: overrides.path,
    extension: '.md',
    buffer: '# x\n',
    dirty: false,
    mode: 'live',
    sessionId: 'session-x',
    viewId: 'view-x',
    baseVersion: 'sha256:x',
    revision: 1,
    documentState: 'CLEAN',
    saving: false,
    lastStatus: null,
    errorCode: null,
    ...overrides,
  };
}

function paneDocId(h: Harness): string | null {
  return h.state.panes[h.state.focusedPane]?.docId ?? null;
}

async function viewAccepted(h: Harness, view: SeenView): Promise<boolean> {
  const outcome = await h.inner.readDocument(view.sessionId, view.viewId);
  return outcome.status === 'APPLIED';
}

// ---------------------------------------------------------------------------
// PC-07 布局与分屏比例恢复
// ---------------------------------------------------------------------------
test('PC-07 布局、分屏比例、查看模式与当前项目都按记录恢复', async () => {
  const roots = await makeRoots('ws-s11c-07-');
  const host = await startHost(roots, 'multi');
  try {
    const storage = new MemoryStorage();
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    await first.opener.openNode(nodeOf('a.md', 'project-b'), 'project-b');

    first.dispatch({ type: 'SET_LAYOUT', layout: 'vertical' });
    first.dispatch({ type: 'SET_SPLIT_RATIO', ratio: 68 });
    first.dispatch({ type: 'SET_PANE_MODE', pane: 'secondary', mode: 'editor' });
    first.dispatch({ type: 'TOGGLE_NAV' });
    first.dispatch({ type: 'SET_AUX_TAB', tab: 'tasks' });
    first.dispatch({ type: 'SET_ACTIVE_PROJECT', projectId: 'project-b' });
    const snapshot = first.saveSnapshot();
    // 指针里也存一份（Provider 的 autosave 行为）
    assert.equal(snapshot.tabs.length, 2);

    const second = makeHarness(host.url, storage);
    const report = await second.restore();

    assert.equal(report.status, 'restored');
    assert.equal(second.state.layout, 'vertical');
    assert.equal(second.state.splitRatio, 68);
    assert.equal(second.state.navCollapsed, true);
    assert.equal(second.state.auxTab, 'tasks');
    assert.equal(second.state.auxCollapsed, false, 'SET_AUX_TAB 会展开辅助面板');
    assert.equal(second.state.activeProjectId, 'project-b', '当前项目必须恢复');
    assert.equal(second.state.panes.primary.mode, 'editor');
    assert.equal(second.state.panes.secondary.mode, 'editor', '查看模式必须恢复');
    assert.equal(paneDocId(second), 'doc:project-b/a.md', '焦点窗格指回原来的文档');
    assert.equal(report.tabsRestored, 2);
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// PC-08 项目展开状态独立恢复
// ---------------------------------------------------------------------------
test('PC-08 各项目的展开状态独立恢复，且只保留真实存在的目录', async () => {
  const roots = await makeRoots('ws-s11c-08-');
  const host = await startHost(roots, 'multi');
  try {
    const storage = new MemoryStorage();
    const first = makeHarness(host.url, storage);
    await first.bootLive();

    // 默认一级目录展开；把 A 的 docs 收起、B 的 x 保持展开
    first.dispatch({ type: 'TOGGLE_PROJECT_NODE', projectId: 'project-a', path: 'dir:project-a/docs' });
    assert.equal(first.state.expandedByProject['project-a']['dir:project-a/docs'], false);
    // 手工塞一个"已删除目录"的键：恢复时必须被裁掉
    first.state.expandedByProject['project-a']['dir:project-a/deleted'] = true;
    first.saveSnapshot();

    const second = makeHarness(host.url, storage);
    const report = await second.restore();

    assert.equal(report.status, 'restored');
    assert.equal(second.state.expandedByProject['project-a']['dir:project-a/docs'], false, 'A 的收起状态恢复');
    assert.equal(second.state.expandedByProject['project-a']['dir:project-a/deleted'], undefined, '不存在的目录必须剔除');
    assert.equal(second.state.expandedByProject['project-b']['dir:project-b/x'], true, 'B 的展开状态独立保留');
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// PC-09 不同工作区身份拒绝互相恢复
// ---------------------------------------------------------------------------
test('PC-09 换了工作区（项目组合不同）时只恢复界面，不发任何文件请求', async () => {
  const roots = await makeRoots('ws-s11c-09a-');
  const otherRoots = await makeRoots('ws-s11c-09b-');
  const host = await startHost(roots, 'multi');
  const otherHost = await startHost(otherRoots, 'multi');
  try {
    const storage = new MemoryStorage();
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    first.dispatch({ type: 'SET_SPLIT_RATIO', ratio: 61 });
    first.saveSnapshot();

    // 第二个工作区：项目根完全不同 → 摘要不同
    const leaked = makeHarness(otherHost.url, storage);
    const report = await leaked.restore();

    assert.equal(report.status, 'ui-only');
    assert.equal(report.reason, 'workspace-mismatch');
    assert.equal(report.workspaceKeyMatched, false);
    assert.equal(report.tabsRestored, 0);
    assert.equal(leaked.state.tabs.length, 0, '不得恢复任何标签');
    assert.equal(leaked.state.splitRatio, 61, '界面布局仍然恢复');
    assert.equal(
      leaked.calls.some((call) => call.name === 'openDocument'),
      false,
      '身份不匹配时不得发出任何打开请求',
    );
    assert.match(report.notice, /仅恢复界面布局/);
  } finally {
    await host.close();
    await otherHost.close();
    await roots.cleanup();
    await otherRoots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// PC-10 根被替换不允许静默恢复标签
// ---------------------------------------------------------------------------
test('PC-10 同一个项目 id 但根目录被替换：摘要变化，拒绝静默恢复', async () => {
  const roots = await makeRoots('ws-s11c-10-');
  const replacement = await makeRoots('ws-s11c-10r-');
  const host = await startHost(roots, 'multi');
  try {
    const storage = new MemoryStorage();
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    first.saveSnapshot();

    // 用另一份内容拷贝"同名项目"重新起一个 Host：projectId / 路径完全一样
    const movedHost = await startHost(replacement, 'multi');
    try {
      const second = makeHarness(movedHost.url, storage);
      const report = await second.restore();
      assert.equal(report.status, 'ui-only');
      assert.equal(report.reason, 'workspace-mismatch');
      assert.equal(second.state.tabs.length, 0);
      assert.equal(
        second.calls.some((call) => call.name === 'openDocument'),
        false,
        '根被替换后不得自动打开同名文件',
      );
    } finally {
      await movedHost.close();
    }
  } finally {
    await host.close();
    await roots.cleanup();
    await replacement.cleanup();
  }
});

// ---------------------------------------------------------------------------
// PC-11 干净标签重新建立真实 Session/View（Host 重启后仍可匹配）
// ---------------------------------------------------------------------------
test('PC-11 Host 重启后身份仍匹配，标签用新的 Session/View 重建', async () => {
  const roots = await makeRoots('ws-s11c-11-');
  const storage = new MemoryStorage();
  const host1 = await startHost(roots, 'multi');
  let oldSessionId = '';
  try {
    const first = makeHarness(host1.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    oldSessionId = first.state.tabs[0].sessionId as string;
    first.saveSnapshot();
  } finally {
    await host1.close();
  }

  // 同一个根、同一个 Host 进程模型 → 摘要不变
  const host2 = await startHost(roots, 'multi');
  try {
    const second = makeHarness(host2.url, storage);
    const report = await second.restore();
    assert.equal(report.status, 'restored');
    assert.equal(report.workspaceKeyMatched, true);
    assert.equal(second.state.tabs.length, 1);

    const tab = second.state.tabs[0];
    assert.equal(tab.docId, 'doc:project-a/a.md');
    assert.equal(tab.buffer, '# A\n');
    assert.equal(tab.dirty, false);
    assert.notEqual(tab.sessionId, oldSessionId, 'Session 必须由本次 Host 新建，不能沿用记录里的身份');
    assert.equal(
      await viewAccepted(second, { sessionId: tab.sessionId as string, viewId: tab.viewId as string }),
      true,
      '恢复出来的 View 必须是服务端认可的有效 View',
    );
    assert.equal(second.views.length, 1, '一个标签只应产生一个受管 View');
  } finally {
    await host2.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// PC-11b 恢复只读、不写：不触碰 edit/save/reload
// ---------------------------------------------------------------------------
test('PC-11b 恢复过程只调用 open/list，不调用 edit/save/reload', async () => {
  const roots = await makeRoots('ws-s11c-11b-');
  const host = await startHost(roots, 'multi');
  try {
    const storage = new MemoryStorage();
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    first.saveSnapshot();

    const second = makeHarness(host.url, storage);
    await second.restore();

    const names = new Set(second.calls.map((call) => call.name));
    for (const forbidden of ['applyEdit', 'saveDocument', 'reloadDocument', 'closeDocument']) {
      assert.equal(names.has(forbidden), false, `恢复不得调用 ${forbidden}`);
    }
    assert.equal(names.has('openDocument'), true);
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// PC-12 Legacy 正常恢复
// ---------------------------------------------------------------------------
test('PC-12 Legacy 工作区（无项目身份）也能恢复标签', async () => {
  const roots = await makeRoots('ws-s11c-12-');
  const host = await startHost(roots, 'legacy');
  try {
    const storage = new MemoryStorage();
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    assert.equal(first.state.workspaceMode, 'legacy');
    await first.opener.openNode(nodeOf('a.md', null));
    const snapshot = first.saveSnapshot();
    assert.equal(snapshot.tabs[0].projectId, null, 'Legacy 记录没有项目身份');

    const second = makeHarness(host.url, storage);
    const report = await second.restore();
    assert.equal(report.status, 'restored');
    assert.equal(report.tabsRestored, 1);
    assert.equal(second.state.tabs.length, 1);
    assert.equal(second.state.tabs[0].docId, 'a.md');
    assert.equal(second.state.tabs[0].projectId, null);
    assert.equal(second.state.tabs[0].buffer, '# A\n');
    assert.equal(
      await viewAccepted(second, {
        sessionId: second.state.tabs[0].sessionId as string,
        viewId: second.state.tabs[0].viewId as string,
      }),
      true,
    );
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// PC-13 Multi A/B 同名文件独立恢复
// ---------------------------------------------------------------------------
test('PC-13 A/a.md 与 B/a.md 恢复成两个互不影响文档', async () => {
  const roots = await makeRoots('ws-s11c-13-');
  const host = await startHost(roots, 'multi');
  try {
    const storage = new MemoryStorage();
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    await first.opener.openNode(nodeOf('a.md', 'project-b'), 'project-b');
    first.saveSnapshot();

    const second = makeHarness(host.url, storage);
    const report = await second.restore();
    assert.equal(report.tabsRestored, 2);

    const a = second.state.tabs.find((tab) => tab.docId === 'doc:project-a/a.md');
    const b = second.state.tabs.find((tab) => tab.docId === 'doc:project-b/a.md');
    assert.ok(a && b, '两个项目的同名文件必须是两个标签');
    assert.equal(a?.buffer, '# A\n');
    assert.equal(b?.buffer, '# B\n');
    assert.notEqual(a?.sessionId, b?.sessionId, '两个文档的会话必须彼此独立');
    assert.equal(a?.projectId, 'project-a');
    assert.equal(b?.projectId, 'project-b');
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// PC-14/15/16 UNAVAILABLE 项目、缺失文件、不影响其他文件
// ---------------------------------------------------------------------------
test('PC-14 记录指向 UNAVAILABLE 项目时不读盘、不建会话、不创建文件', async () => {
  const roots = await makeRoots('ws-s11c-14-');
  const host = await startHost(roots, 'multi');
  try {
    const storage = new MemoryStorage();
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    // 模拟"上次会话曾经打开过 project-c 的文件"（现在这个项目根已经不存在）
    first.dispatch({
      type: 'OPEN_TAB',
      tab: tabOf({ docId: 'doc:project-c/x.md', projectId: 'project-c', path: 'x.md' }),
    });
    first.saveSnapshot();

    const second = makeHarness(host.url, storage);
    const report = await second.restore();

    const skipped = report.skipped.find((item) => item.projectId === 'project-c');
    assert.ok(skipped, '必须记录未恢复的文件');
    assert.equal(skipped?.reason, 'project-unavailable');
    assert.equal(
      second.calls.some((call) => call.name === 'openDocument' && call.projectId === 'project-c'),
      false,
      '不可用项目不得发出打开请求',
    );
    await assert.rejects(stat(join(roots.rootC, 'x.md')), '不得因为恢复而创建文件');
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

test('PC-15/16 文件不存在只跳过它，其他文件照常恢复且不新建文件', async () => {
  const roots = await makeRoots('ws-s11c-15-');
  const host = await startHost(roots, 'multi');
  try {
    const storage = new MemoryStorage();
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    // 第二个标签指向一个从未存在的文件
    first.dispatch({
      type: 'OPEN_TAB',
      tab: tabOf({ docId: 'doc:project-a/missing.md', projectId: 'project-a', path: 'missing.md' }),
    });
    first.saveSnapshot();

    const second = makeHarness(host.url, storage);
    const report = await second.restore();

    assert.equal(report.tabsRestored, 1, '存在的文件必须恢复');
    assert.equal(second.state.tabs.length, 1);
    assert.equal(second.state.tabs[0].docId, 'doc:project-a/a.md');
    const missing = report.skipped.find((item) => item.path === 'missing.md');
    assert.equal(missing?.reason, 'file-missing');
    assert.equal(
      second.calls.some((call) => call.name === 'openDocument' && call.path === 'missing.md'),
      false,
      '不存在的文件不得尝试打开',
    );
    await assert.rejects(stat(join(roots.rootA, 'missing.md')), '不得自动创建缺失文件');
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// PC-17 dirty 元数据不被当作已保存草稿
// ---------------------------------------------------------------------------
test('PC-17 只有 hadUnsavedChanges 标记时不得宣称草稿已恢复', async () => {
  const roots = await makeRoots('ws-s11c-17-');
  const host = await startHost(roots, 'multi');
  try {
    const storage = new MemoryStorage();
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    // 上一次会话里这个文件有未保存修改（磁盘上是干净的）
    first.dispatch({ type: 'EDIT_DOC', docId: 'doc:project-a/a.md', text: '# 未保存的草稿\n' });
    const snapshot = first.saveSnapshot();
    assert.equal(snapshot.tabs[0].hadUnsavedChanges, true);
    assert.equal(JSON.stringify(snapshot).includes('未保存的草稿'), false, '草稿正文不得写进存储');

    // 让 Core 侧回到干净状态：换一个 Host 进程（旧会话不存在了）
    await host.close();
    const restarted = await startHost(roots, 'multi');
    try {
      const second = makeHarness(restarted.url, storage);
      const report = await second.restore();
      const tab = second.state.tabs[0];
      assert.equal(tab.buffer, '# A\n', '只能拿到磁盘内容');
      assert.equal(tab.dirty, false, '不得凭空变成 dirty');
      assert.equal(report.draftsLost, 1, '必须如实报告未恢复的内容');
      assert.equal(report.draftsRecovered, 0);
      assert.match(report.notice, /未保存内容未自动恢复/);
      assert.equal(report.notice.includes('草稿已恢复'), false);
    } finally {
      await restarted.close();
    }
  } finally {
    await roots.cleanup();
  }
});

test('PC-17b Core 仍持有草稿时如实报告"由服务端会话重新取得"', async () => {
  const roots = await makeRoots('ws-s11c-17b-');
  const host = await startHost(roots, 'multi');
  try {
    const storage = new MemoryStorage();
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    const tab = first.state.tabs[0];
    // 真实的未保存修改同时进 Core（模拟编辑队列已同步）
    first.dispatch({ type: 'EDIT_DOC', docId: tab.docId, text: '# 保存在 Core 里的草稿\n' });
    const applied = await first.inner.applyEdit(
      tab.sessionId as string,
      '# 保存在 Core 里的草稿\n',
      tab.baseVersion,
      tab.viewId,
    );
    assert.equal(applied.status, 'APPLIED');
    first.saveSnapshot();

    // 刷新浏览器：Host 进程没变，会话与草稿都还在
    const second = makeHarness(host.url, storage);
    const report = await second.restore();
    const restored = second.state.tabs[0];
    assert.equal(restored.buffer, '# 保存在 Core 里的草稿\n', '内容来自服务端会话，不是存储');
    assert.equal(restored.dirty, true);
    assert.equal(report.draftsRecovered, 1);
    assert.equal(report.draftsLost, 0);
    assert.match(report.notice, /由服务端会话重新取得/);
    assert.equal(JSON.stringify(storage.map.get(storageKeyFor(second.state.workspaceKey as string))).includes('核心草稿'), false);
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// PC-19 恢复途中切模式：迟到响应不得回填
// ---------------------------------------------------------------------------
test('PC-19 恢复途中切到 Demo：迟到的 live 打开结果被丢弃且 View 被释放', async () => {
  const roots = await makeRoots('ws-s11c-19-');
  const host = await startHost(roots, 'multi');
  try {
    const storage = new MemoryStorage();
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    first.saveSnapshot();

    const second = makeHarness(host.url, storage);
    const release = second.holdNextOpen();
    const opened = second.nextOpenStarted();
    const pending = second.restore();
    await opened;

    // 用户切到 Demo（demo 不需要 Host）
    second.setMode('demo');
    assert.equal(second.mode(), 'demo');

    release();
    const report = await pending;

    assert.equal(second.state.mode, 'demo');
    assert.equal(second.state.tabs.length, 0, 'Demo 工作区不得出现 live 标签');
    assert.equal(report.tabsRestored, 0);
    const lateView = second.views[0];
    assert.ok(lateView, '前提：服务端确实创建过一个 View');
    assert.equal(await viewAccepted(second, lateView), false, '迟到响应的 View 必须被释放');
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// PC-20 恢复途中用户打开别的文档：不抢焦点
// ---------------------------------------------------------------------------
test('PC-20 恢复途中用户打开 B/a.md：恢复的标签只能后台登记', async () => {
  const roots = await makeRoots('ws-s11c-20-');
  const host = await startHost(roots, 'multi');
  try {
    const storage = new MemoryStorage();
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    first.saveSnapshot();

    const second = makeHarness(host.url, storage);
    const release = second.holdNextOpen();
    const opened = second.nextOpenStarted();
    const pending = second.restore();
    await opened;

    // 用户在恢复途中切到项目 B 并打开 B/a.md
    second.dispatch({ type: 'SET_ACTIVE_PROJECT', projectId: 'project-b' });
    second.restorer.noteInteraction();
    await second.opener.openNode(nodeOf('a.md', 'project-b'), 'project-b');
    assert.equal(paneDocId(second), 'doc:project-b/a.md');

    release();
    await pending;

    const restored = second.state.tabs.find((tab) => tab.docId === 'doc:project-a/a.md');
    assert.ok(restored, '恢复的标签仍然出现（后台登记）');
    assert.equal(paneDocId(second), 'doc:project-b/a.md', '不得抢走用户当前文档');
    assert.equal(second.state.activeProjectId, 'project-b');
    assert.equal(second.state.tabs.length, 2);
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// PC-21 重复恢复 / StrictMode 不多建 View
// ---------------------------------------------------------------------------
test('PC-21 重复调用 restore 只执行一次，同一文档只有一个 View', async () => {
  const roots = await makeRoots('ws-s11c-21-');
  const host = await startHost(roots, 'multi');
  try {
    const storage = new MemoryStorage();
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    await first.opener.openNode(nodeOf('docs/notes.md', 'project-a'), 'project-a');
    first.saveSnapshot();

    const second = makeHarness(host.url, storage);
    // StrictMode：effect 会连续跑两次
    const p1 = second.restore();
    const p2 = second.restore();
    assert.equal(p1, p2, '重复调用必须复用同一个 Promise');

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, r2);
    assert.equal(second.state.tabs.length, 2);
    assert.equal(
      second.calls.filter((call) => call.name === 'openDocument').length,
      2,
      '每个文档只应打开一次',
    );
    for (const view of second.views) {
      assert.equal(await viewAccepted(second, view), true);
    }
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// PC-22 Quick File 不进入持久化
// ---------------------------------------------------------------------------
test('PC-22 存储里只有工作区记录，没有任何 Quick File / 草稿数据', async () => {
  const roots = await makeRoots('ws-s11c-22-');
  const host = await startHost(roots, 'multi');
  try {
    const storage = new MemoryStorage();
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    // 模拟用户此时选了一个 Quick File（它只活在 QuickFileProvider 里，不进 WorkspaceState）
    const snapshot = first.saveSnapshot();

    const keys = [...storage.map.keys()].sort();
    assert.equal(keys.length, 2, '只允许"记录 + 指针"两个键');
    assert.equal(keys.some((key) => /quick|draft|file:/i.test(key)), false);
    for (const value of storage.map.values()) {
      assert.equal(/quick/i.test(value), false, '存储内容里不得出现 Quick File');
      assert.equal(/notes-found-only-in-quick/i.test(value), false);
    }
    assert.deepEqual(
      Object.keys(snapshot).sort(),
      ['activeProjectId', 'expandedByProject', 'panes', 'savedAt', 'tabs', 'ui', 'version', 'workspaceKey'],
    );

    const second = makeHarness(host.url, storage);
    await second.restore();
    // 刷新后 Quick File 是空态：恢复流程不产生任何"当前文件"
    assert.equal(
      second.state.tabs.some((tab) => tab.mode !== 'live'),
      false,
      '恢复出的标签必须全部是真实文件',
    );
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// PC-23 Host 不在线：只恢复安全 UI 状态
// ---------------------------------------------------------------------------
test('PC-23 Host 不在线时仅恢复界面，不发出任何文件请求', async () => {
  const roots = await makeRoots('ws-s11c-23-');
  const host = await startHost(roots, 'multi');
  const storage = new MemoryStorage();
  try {
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    first.dispatch({ type: 'SET_SPLIT_RATIO', ratio: 72 });
    first.dispatch({ type: 'TOGGLE_TREE' });
    first.saveSnapshot();
  } finally {
    await host.close();
  }

  try {
    // 端口已关闭：连接必然失败
    const offline = makeHarness('http://127.0.0.1:9', storage);
    const report = await offline.restore();
    assert.equal(report.status, 'ui-only');
    assert.equal(report.reason, 'host-unavailable');
    assert.equal(report.tabsRestored, 0);
    assert.equal(offline.state.splitRatio, 72, '安全界面状态仍要恢复');
    assert.equal(offline.state.treeCollapsed, true);
    assert.equal(offline.state.tabs.length, 0);
    assert.match(report.notice, /无法连接本地服务/);
  } finally {
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 没有记录：启动保持原样
// ---------------------------------------------------------------------------
test('PC-07b 没有任何记录时恢复流程什么都不做', async () => {
  const roots = await makeRoots('ws-s11c-07b-');
  const host = await startHost(roots, 'multi');
  try {
    const storage = new MemoryStorage();
    const h = makeHarness(host.url, storage);
    const report = await h.restore();
    assert.equal(report.status, 'empty');
    assert.equal(report.reason, 'no-snapshot');
    assert.equal(h.mode(), 'demo', '没有记录时不应自动连 Host');
    assert.equal(h.calls.length, 0);
    assert.equal(h.state.tabs.length, 0);
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 目录展开状态不会被旧快照"复活"成不存在的树
// ---------------------------------------------------------------------------
test('PC-08b 旧快照里的项目已不存在时，它的展开状态被整体丢弃', async () => {
  const roots = await makeRoots('ws-s11c-08b-');
  const host = await startHost(roots, 'multi');
  try {
    const storage = new MemoryStorage();
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    const snapshot = first.saveSnapshot();
    const tampered: PersistedWorkspaceV1 = {
      ...snapshot,
      expandedByProject: {
        ...snapshot.expandedByProject,
        'project-zzz': { 'dir:project-zzz/docs': true },
      },
    };
    assert.equal(createWorkspaceStore(storage).write(tampered), 'written');

    const second = makeHarness(host.url, storage);
    await second.restore();
    assert.equal(second.state.expandedByProject['project-zzz'], undefined, '不存在的项目不得出现在状态里');
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 文件读取结果与磁盘一致（恢复不是"猜内容"）
// ---------------------------------------------------------------------------
test('PC-11c 恢复出来的内容就是磁盘内容（不是快照里的旧内容）', async () => {
  const roots = await makeRoots('ws-s11c-11c-');
  const host = await startHost(roots, 'multi');
  try {
    const storage = new MemoryStorage();
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    first.saveSnapshot();

    // 关闭标签后外部改写磁盘
    await writeFile(join(roots.rootA, 'a.md'), '# A updated on disk\n', 'utf8');

    const second = makeHarness(host.url, storage);
    await second.restore();
    assert.equal(second.state.tabs[0].buffer, '# A updated on disk\n');
    assert.equal(await readFile(join(roots.rootA, 'a.md'), 'utf8'), '# A updated on disk\n', '恢复不得写盘');
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// PC-23b 代理/Host 返回 5xx 时不得被误判为"旧版服务端"
// ---------------------------------------------------------------------------
test('PC-23b /api/health 非 200 时按"Host 不可用"降级，而不是当成旧版服务端', async () => {
  const roots = await makeRoots('ws-s11c-23b-');
  const host = await startHost(roots, 'multi');
  const storage = new MemoryStorage();
  try {
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    first.saveSnapshot();
  } finally {
    await host.close();
  }

  // 开发代理在 Host 未启动时的典型行为：所有请求都是 5xx（body 不是 JSON）
  const broken = createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('proxy error');
  });
  await new Promise<void>((resolve) => broken.listen(0, '127.0.0.1', resolve));
  const address = broken.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const offline = makeHarness(`http://127.0.0.1:${port}`, storage);
    const report = await offline.restore();
    assert.equal(report.status, 'ui-only');
    assert.equal(report.reason, 'host-unavailable');
    assert.equal(offline.state.tabs.length, 0);
    assert.equal(offline.mode(), 'demo', 'Host 不可用时不得切进 live');
    assert.equal(offline.calls.some((call) => call.name === 'openDocument'), false);
  } finally {
    await new Promise<void>((resolve) => broken.close(() => resolve()));
    await roots.cleanup();
  }
});
