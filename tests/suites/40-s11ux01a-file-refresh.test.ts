/**
 * S11-UX-01A：已打开文件的安全手动刷新（真实 Host + 真实 reducer + 真实文件）。
 *
 * 被测对象是**生产链路本身**：`state/refresh-project.ts` 的 `refreshProject()`
 * 就是 `DocumentActionsContext.reloadResources` 内部调用的那一个函数；
 * 它再调用 `createDocumentOpener().refreshOpenTabs()`（同样是 Provider 用的实现）。
 * 客户端是真实 `createLiveClient`，服务端是真实 Host（端口 0），状态由真实
 * `workspaceReducer` 承接。
 *
 * 时序纪律（UX-01A-R1）：
 * - 每个挂起门禁都提供 `entered` 信号，表示**请求真的发出去了**；
 *   测试必须先 `await gate.entered`，再做交错动作，不允许用 sleep / 事件循环赌时序。
 * - `open` 有两段门禁：`entered`（请求已发）与 `afterOpenResponse`
 *   （响应已到手、服务端临时 View 已存在），后者用来验证"View 已建之后再取消"的释放路径。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createShellServer } from '../../apps/server/src/server.ts';
import {
  createLiveClient,
  type WeaveSpaceClient,
} from '../../apps/shell/src/client/client-api.ts';
import {
  createDocumentOpener,
  createEditEpochs,
  type DocumentOpener,
} from '../../apps/shell/src/state/open-document.ts';
import {
  refreshProject,
  type RefreshProjectResult,
} from '../../apps/shell/src/state/refresh-project.ts';
import { createLoadEpoch, loadProjectResources } from '../../apps/shell/src/state/workspace-load.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import type {
  ClientMode,
  ResourceNodeState,
  WorkspaceAction,
  WorkspaceState,
} from '../../apps/shell/src/state/types.ts';
import type { WorkspaceConfig } from '../../packages/project-registry/index.ts';

function nodeOf(projectId: string | null, path: string): ResourceNodeState {
  const name = path.split('/').pop() ?? path;
  return {
    id: projectId ? `doc:${projectId}/${path}` : path,
    name,
    kind: 'file',
    extension: '.md',
    path,
  };
}

/** 一次性挂起门禁：`entered` 表示"已进入请求阶段"，`release()` 放行。 */
class Gate {
  readonly entered: Promise<void>;
  readonly released: Promise<void>;
  private enterResolve!: () => void;
  private releaseResolve!: () => void;

  constructor() {
    this.entered = new Promise<void>((resolve) => {
      this.enterResolve = resolve;
    });
    this.released = new Promise<void>((resolve) => {
      this.releaseResolve = resolve;
    });
  }

  enter(): void {
    this.enterResolve();
  }

  release(): void {
    this.releaseResolve();
  }
}

/** 门禁槽位：`arm()` 只对**下一次**调用生效，取走即失效。 */
class GateSlot {
  private next: Gate | null = null;

  arm(): Gate {
    const gate = new Gate();
    this.next = gate;
    return gate;
  }

  take(): Gate | null {
    const gate = this.next;
    this.next = null;
    return gate;
  }
}

interface SeenView {
  sessionId: string;
  viewId: string;
}

interface Harness {
  state: WorkspaceState;
  rootA: string;
  rootB: string;
  opener: DocumentOpener;
  client: WeaveSpaceClient;
  inner: WeaveSpaceClient;
  views: SeenView[];
  counts: { open: number; reload: number; disk: number; close: number };
  /** 生产实现：与 `DocumentActionsContext.reloadResources` 调用的是同一个函数。 */
  refresh(projectId?: string): Promise<RefreshProjectResult>;
  dispatch(action: WorkspaceAction): void;
  /** 与 Provider 的 `switchMode` 同序：先推进代次，再同步模式，最后派发。 */
  setMode(mode: ClientMode): void;
  /** 模拟重新连接 / 工作区身份变化。 */
  reconnect(workspaceKey: string): void;
  /** 模拟 S11-C 恢复开始新的一代，返回该代的取消检查。 */
  startEpoch(): () => boolean;
  gates: {
    listResources: GateSlot;
    open: GateSlot;
    /** 响应已到手、临时 View 已建之后挂起。 */
    afterOpenResponse: GateSlot;
    readDisk: GateSlot;
  };
}

function buildHarness(args: {
  inner: WeaveSpaceClient;
  roots: { rootA: string; rootB: string };
  initialState: WorkspaceState;
}): Harness {
  let state = args.initialState;
  let mode: ClientMode = 'live';
  const counts = { open: 0, reload: 0, disk: 0, close: 0 };
  const views: SeenView[] = [];
  const loadEpoch = createLoadEpoch();
  const gates = {
    listResources: new GateSlot(),
    open: new GateSlot(),
    afterOpenResponse: new GateSlot(),
    readDisk: new GateSlot(),
  };

  const inner = args.inner;
  const client: WeaveSpaceClient = {
    ...inner,
    async listResources(projectId?: string) {
      const gate = gates.listResources.take();
      if (!gate) return inner.listResources(projectId);
      const pending = inner.listResources(projectId);
      gate.enter();
      await gate.released;
      return pending;
    },
    /**
     * UX-02B-TREE：加载器现在走逐层 `listTree`。
     * 复用 `gates.listResources` 这个"资源加载"闸门，让既有的挂起/取消用例
     * 仍然精确地拦在资源请求上（断言与时序语义不变）。
     */
    async listTree(projectId, dir, cursor, limit) {
      const gate = gates.listResources.take();
      if (!gate) return inner.listTree(projectId, dir, cursor, limit);
      const pending = inner.listTree(projectId, dir, cursor, limit);
      gate.enter();
      await gate.released;
      return pending;
    },
    async openDocument(path: string, projectId?: string) {
      counts.open += 1;
      const pre = gates.open.take();
      const post = gates.afterOpenResponse.take();
      let outcome;
      if (pre) {
        const pending = inner.openDocument(path, projectId);
        pre.enter();
        await pre.released;
        outcome = await pending;
      } else {
        outcome = await inner.openDocument(path, projectId);
      }
      if (outcome.document?.viewId) {
        views.push({ sessionId: outcome.document.sessionId, viewId: outcome.document.viewId });
      }
      if (post) {
        // 此刻服务端临时 View 已存在，但 opener 还没拿到返回值
        post.enter();
        await post.released;
      }
      return outcome;
    },
    async readDisk(sessionId: string, viewId?: string | null) {
      counts.disk += 1;
      const gate = gates.readDisk.take();
      if (!gate) return inner.readDisk(sessionId, viewId);
      const pending = inner.readDisk(sessionId, viewId);
      gate.enter();
      await gate.released;
      return pending;
    },
    async reloadDocument(sessionId: string, viewId: string) {
      counts.reload += 1;
      return inner.reloadDocument(sessionId, viewId);
    },
    async closeDocument(sessionId: string, viewId: string) {
      counts.close += 1;
      return inner.closeDocument(sessionId, viewId);
    },
  };

  const dispatch = (action: WorkspaceAction): void => {
    state = workspaceReducer(state, action);
  };

  const opener = createDocumentOpener({
    getState: () => state,
    getMode: () => mode,
    dispatch,
    clientFor: (target) => {
      if (target !== 'live') throw new Error(`测试不应使用 ${target} 客户端`);
      return client;
    },
    editEpochs: createEditEpochs(),
  });

  return {
    get state() {
      return state;
    },
    rootA: args.roots.rootA,
    rootB: args.roots.rootB,
    opener,
    client,
    inner,
    views,
    counts,
    refresh: (projectId?: string) =>
      refreshProject(
        {
          getState: () => state,
          getMode: () => mode,
          dispatch,
          clientFor: () => client,
          refreshOpenTabs: (target) => opener.refreshOpenTabs(target),
          loadToken: () => loadEpoch.current(),
          isTokenCurrent: (token) => loadEpoch.isCurrent(token),
        },
        projectId,
      ),
    dispatch,
    setMode(next) {
      // 与 Provider 的 switchMode 一致：先让在途加载失效，再同步模式，最后派发
      loadEpoch.cancel();
      mode = next;
      dispatch({ type: 'SET_MODE', mode: next });
    },
    reconnect(workspaceKey) {
      loadEpoch.cancel();
      dispatch({ type: 'SET_WORKSPACE_KEY', workspaceKey });
    },
    startEpoch: () => loadEpoch.start(),
    gates,
  };
}

async function withMulti(fn: (h: Harness) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux01a-'));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await mkdir(join(rootB, 'docs'), { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');
  await writeFile(join(rootA, 'readme.md'), '# A readme\n', 'utf8');
  await writeFile(join(rootB, 'readme.md'), '# B readme\n', 'utf8');

  const workspace: WorkspaceConfig = {
    version: 1,
    projects: [
      { projectId: 'project-a', name: '项目 A', rootDir: rootA },
      { projectId: 'project-b', name: '项目 B', rootDir: rootB },
    ],
  };
  const server = await createShellServer({ workspace, port: 0 });
  const inner = createLiveClient(server.url);

  const harness = buildHarness({
    inner,
    roots: { rootA, rootB },
    initialState: {
      ...INITIAL_STATE,
      mode: 'live',
      workspaceMode: 'multi',
      workspaceKey: 'ws-1',
      projects: [
        { projectId: 'project-a', name: '项目 A', status: 'READY' },
        { projectId: 'project-b', name: '项目 B', status: 'READY' },
      ],
      activeProjectId: 'project-a',
      notice: '',
    },
  });

  try {
    await fn(harness);
  } finally {
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

/** Legacy 单项目：标签的 projectId 为 null。 */
async function withLegacy(fn: (h: Harness) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux01a-legacy-'));
  const root = join(base, 'root');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'a.md'), '# legacy A\n', 'utf8');

  const server = await createShellServer({ rootDir: root, port: 0 });
  const inner = createLiveClient(server.url);

  const harness = buildHarness({
    inner,
    roots: { rootA: root, rootB: root },
    initialState: {
      ...INITIAL_STATE,
      mode: 'live',
      workspaceMode: 'legacy',
      workspaceKey: 'ws-legacy',
      notice: '',
    },
  });

  try {
    await fn(harness);
  } finally {
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

async function viewAccepted(h: Harness, view: SeenView): Promise<boolean> {
  const outcome = await h.inner.readDocument(view.sessionId, view.viewId);
  return outcome.status === 'APPLIED';
}

function tabOf(h: Harness, projectId: string | null, path: string) {
  const docId = projectId ? `doc:${projectId}/${path}` : path;
  return h.state.tabs.find((tab) => tab.docId === docId);
}

// ---------------------------------------------------------------------------
// A. 外部修改 + 干净标签
// ---------------------------------------------------------------------------
test('A-01 外部修改后刷新：干净标签同步磁盘内容与版本基线，仍是干净状态', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(nodeOf('project-a', 'a.md'), 'project-a');
    const before = tabOf(h, 'project-a', 'a.md');
    assert.ok(before);
    assert.equal(before.buffer, '# A\n');
    assert.equal(before.dirty, false);

    await writeFile(join(h.rootA, 'a.md'), '# A edited externally\n', 'utf8');

    const result = await h.refresh('project-a');
    assert.equal(result.report?.updated, 1, '应同步 1 个文件');

    const after = tabOf(h, 'project-a', 'a.md');
    assert.ok(after);
    assert.equal(after.buffer, '# A edited externally\n', '正文必须反映磁盘变化');
    assert.notEqual(after.baseVersion, before.baseVersion, '版本基线必须更新');
    assert.equal(after.dirty, false, '同步后仍是干净状态');
    assert.equal(after.sessionId, before.sessionId, '沿用同一会话，不重建身份');
    assert.equal(after.viewId, before.viewId, '标签的 viewId 不得被临时 View 顶替');
  });
});

test('A-02 磁盘没有变化时不刷新：不建临时 View、不产生多余重载', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(nodeOf('project-a', 'a.md'), 'project-a');
    const before = tabOf(h, 'project-a', 'a.md');
    assert.ok(before);
    const opensBefore = h.counts.open;

    const result = await h.refresh('project-a');
    assert.equal(result.report?.updated, 0);
    assert.equal(h.counts.open, opensBefore, '无变化时不得调用 open（否则每次刷新都多一个 View）');

    const after = tabOf(h, 'project-a', 'a.md');
    assert.equal(after?.buffer, before.buffer);
    assert.equal(after?.revision, before.revision);
    assert.equal(after?.baseVersion, before.baseVersion);
    assert.equal(after?.dirty, false);
  });
});

test('A-03 刷新不改变活动文档、焦点窗格与分屏结构', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(nodeOf('project-a', 'a.md'), 'project-a');
    await h.opener.openNode(nodeOf('project-b', 'readme.md'), 'project-b');
    h.dispatch({ type: 'SET_LAYOUT', layout: 'vertical' });
    h.dispatch({ type: 'FOCUS_PANE', pane: 'secondary' });
    const panesBefore = JSON.stringify(h.state.panes);
    const focusedBefore = h.state.focusedPane;
    const layoutBefore = h.state.layout;

    await writeFile(join(h.rootA, 'a.md'), '# A changed\n', 'utf8');
    await h.refresh('project-a');

    assert.equal(JSON.stringify(h.state.panes), panesBefore, '窗格指向不得变化');
    assert.equal(h.state.focusedPane, focusedBefore, '焦点窗格不得变化');
    assert.equal(h.state.layout, layoutBefore, '分屏结构不得变化');
  });
});

// ---------------------------------------------------------------------------
// B. 外部修改 + 未保存草稿
// ---------------------------------------------------------------------------
test('B-01 有草稿时检测到外部修改：只提示，草稿与版本一律不动，且不调用 reload', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(nodeOf('project-a', 'a.md'), 'project-a');
    const tab = tabOf(h, 'project-a', 'a.md');
    assert.ok(tab);

    h.opener.noteLocalEdit(tab.docId);
    h.dispatch({ type: 'EDIT_DOC', docId: tab.docId, text: '# my draft\n' });
    const edited = await h.client.applyEdit(
      tab.sessionId as string,
      '# my draft\n',
      tab.baseVersion,
      tab.viewId,
    );
    assert.equal(edited.status, 'APPLIED');
    h.dispatch({
      type: 'TAB_PATCH',
      docId: tab.docId,
      patch: { revision: edited.document?.revision as number, documentState: 'EDITING_DIRTY' },
    });

    const draftTab = tabOf(h, 'project-a', 'a.md');
    assert.ok(draftTab);
    assert.equal(draftTab.dirty, true);

    await writeFile(join(h.rootA, 'a.md'), '# disk version\n', 'utf8');
    const reloadsBefore = h.counts.reload;

    const result = await h.refresh('project-a');
    assert.deepEqual(result.report?.dirtyChanged, ['a.md'], '必须明确报告该文件存在外部修改');
    assert.equal(result.report?.updated, 0, '有草稿的文件绝不自动同步');
    assert.equal(h.counts.reload, reloadsBefore, '不得调用会丢弃草稿的 reload');

    const after = tabOf(h, 'project-a', 'a.md');
    assert.equal(after?.buffer, '# my draft\n', '草稿必须完整保留');
    assert.equal(after?.dirty, true, 'dirty 必须保留');
    assert.equal(after?.baseVersion, draftTab.baseVersion, '版本基线不得被改写');
    assert.equal(after?.revision, draftTab.revision, 'revision 不得被推进');
    assert.equal(after?.sessionId, draftTab.sessionId);
    assert.equal(after?.lastStatus, draftTab.lastStatus, '不得伪造一次保存结论');
    assert.equal(after?.errorCode, draftTab.errorCode);
  });
});

test('B-02 有草稿但磁盘未变：不误报外部修改', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(nodeOf('project-a', 'a.md'), 'project-a');
    const tab = tabOf(h, 'project-a', 'a.md');
    assert.ok(tab);
    h.opener.noteLocalEdit(tab.docId);
    h.dispatch({ type: 'EDIT_DOC', docId: tab.docId, text: '# local only\n' });

    const result = await h.refresh('project-a');
    assert.deepEqual(
      result.report?.dirtyChanged,
      [],
      '磁盘没变时不得把"草稿与磁盘不同"误报成外部修改',
    );
    assert.equal(tabOf(h, 'project-a', 'a.md')?.buffer, '# local only\n');
  });
});

test('B-03 外部修改与草稿并存时保存：得到 CONFLICT，不静默覆盖磁盘', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(nodeOf('project-a', 'a.md'), 'project-a');
    const tab = tabOf(h, 'project-a', 'a.md');
    assert.ok(tab);
    h.opener.noteLocalEdit(tab.docId);
    h.dispatch({ type: 'EDIT_DOC', docId: tab.docId, text: '# mine\n' });
    const edited = await h.client.applyEdit(
      tab.sessionId as string,
      '# mine\n',
      tab.baseVersion,
      tab.viewId,
    );
    assert.equal(edited.status, 'APPLIED');

    await writeFile(join(h.rootA, 'a.md'), '# theirs\n', 'utf8');
    await h.refresh('project-a');

    const outcome = await h.client.saveDocument(
      tab.sessionId as string,
      tab.baseVersion as string,
      tab.viewId,
    );
    assert.equal(outcome.status, 'CONFLICT', '必须走既有条件保存的冲突路径');
    assert.equal(await readFile(join(h.rootA, 'a.md'), 'utf8'), '# theirs\n', '磁盘不得被覆盖');
    assert.equal(tabOf(h, 'project-a', 'a.md')?.buffer, '# mine\n', '草稿仍保留');
  });
});

// ---------------------------------------------------------------------------
// C. 多项目隔离
// ---------------------------------------------------------------------------
test('C-01 刷新项目 A 只动 A：B 的同名 readme.md 不受影响', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(nodeOf('project-a', 'readme.md'), 'project-a');
    await h.opener.openNode(nodeOf('project-b', 'readme.md'), 'project-b');
    const bBefore = tabOf(h, 'project-b', 'readme.md');
    assert.ok(bBefore);

    await writeFile(join(h.rootA, 'readme.md'), '# A readme v2\n', 'utf8');
    await writeFile(join(h.rootB, 'readme.md'), '# B readme v2\n', 'utf8');

    const result = await h.refresh('project-a');
    assert.equal(result.report?.updated, 1);

    assert.equal(tabOf(h, 'project-a', 'readme.md')?.buffer, '# A readme v2\n');
    assert.equal(
      tabOf(h, 'project-b', 'readme.md')?.buffer,
      '# B readme\n',
      'B 的内容不得被 A 的刷新改写',
    );
    assert.equal(tabOf(h, 'project-b', 'readme.md')?.baseVersion, bBefore.baseVersion);
    assert.equal(tabOf(h, 'project-b', 'readme.md')?.sessionId, bBefore.sessionId);
  });
});

test('C-02 Legacy 单项目：projectId 为 null 的标签同样能被刷新', async () => {
  await withLegacy(async (h) => {
    await h.opener.openNode(nodeOf(null, 'a.md'), null);
    const before = tabOf(h, null, 'a.md');
    assert.ok(before);
    assert.equal(before.buffer, '# legacy A\n');

    await writeFile(join(h.rootA, 'a.md'), '# legacy A v2\n', 'utf8');
    const result = await h.refresh();
    assert.equal(result.report?.updated, 1);
    assert.equal(tabOf(h, null, 'a.md')?.buffer, '# legacy A v2\n');
  });
});

// ---------------------------------------------------------------------------
// D. 异步安全（文档层）
// ---------------------------------------------------------------------------
test('D-01 刷新未返回时用户输入：旧结果被拒，草稿不被覆盖', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(nodeOf('project-a', 'a.md'), 'project-a');
    const tab = tabOf(h, 'project-a', 'a.md');
    assert.ok(tab);
    await writeFile(join(h.rootA, 'a.md'), '# from disk\n', 'utf8');

    const gate = h.gates.open.arm();
    const refresh = h.refresh('project-a');
    await gate.entered; // 确定性：open 请求已发出

    h.opener.noteLocalEdit(tab.docId);
    h.dispatch({ type: 'EDIT_DOC', docId: tab.docId, text: '# typed while refreshing\n' });
    await h.client.applyEdit(
      tab.sessionId as string,
      '# typed while refreshing\n',
      tab.baseVersion,
      tab.viewId,
    );

    gate.release();
    await refresh;

    const after = tabOf(h, 'project-a', 'a.md');
    assert.equal(after?.buffer, '# typed while refreshing\n', '旧刷新结果不得覆盖输入');
    assert.equal(after?.dirty, true);
  });
});

test('D-02 刷新未返回时用户保存：保存结果不被刷新回退', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(nodeOf('project-a', 'a.md'), 'project-a');
    const tab = tabOf(h, 'project-a', 'a.md');
    assert.ok(tab);

    const gate = h.gates.readDisk.arm();
    const refresh = h.refresh('project-a');
    await gate.entered; // 磁盘读取已发出（读到的是保存之前的状态）

    h.opener.noteLocalEdit(tab.docId);
    h.dispatch({ type: 'EDIT_DOC', docId: tab.docId, text: '# saved while refreshing\n' });
    const edited = await h.client.applyEdit(
      tab.sessionId as string,
      '# saved while refreshing\n',
      tab.baseVersion,
      tab.viewId,
    );
    assert.equal(edited.status, 'APPLIED');
    const saved = await h.client.saveDocument(
      tab.sessionId as string,
      tab.baseVersion as string,
      tab.viewId,
    );
    assert.equal(saved.status, 'COMMITTED');
    h.dispatch({
      type: 'TAB_PATCH',
      docId: tab.docId,
      patch: {
        baseVersion: saved.document?.baseVersion ?? null,
        revision: saved.document?.revision ?? tab.revision,
        dirty: false,
      },
    });
    const savedTab = tabOf(h, 'project-a', 'a.md');
    assert.ok(savedTab);
    const savedVersion = savedTab.baseVersion;
    const savedRevision = savedTab.revision;

    gate.release();
    await refresh;

    const after = tabOf(h, 'project-a', 'a.md');
    assert.equal(after?.buffer, '# saved while refreshing\n', '刷新不得用保存前的磁盘内容覆盖编辑器');
    assert.equal(after?.baseVersion, savedVersion, '刷新不得回退保存后的版本基线');
    assert.equal(after?.revision, savedRevision, '刷新不得回退 revision');
    assert.equal(after?.dirty, false);
  });
});

test('D-03 刷新未返回时关闭标签：不复活标签，临时 View 必须释放', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(nodeOf('project-a', 'a.md'), 'project-a');
    const tab = tabOf(h, 'project-a', 'a.md');
    assert.ok(tab);
    await writeFile(join(h.rootA, 'a.md'), '# disk v2\n', 'utf8');

    const gate = h.gates.open.arm();
    const refresh = h.refresh('project-a');
    await gate.entered;

    await h.client.closeDocument(tab.sessionId as string, tab.viewId as string);
    h.opener.forget(tab.docId);
    h.dispatch({ type: 'CLOSE_TAB', docId: tab.docId });

    gate.release();
    await refresh;

    assert.equal(h.state.tabs.length, 0, '刷新不得复活已关闭的标签');
    for (const view of h.views) {
      assert.equal(await viewAccepted(h, view), false, '临时 View 不得泄漏');
    }
  });
});

test('D-04 刷新未返回时切换模式：结果不得写回（也不得复活 live 标签）', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(nodeOf('project-a', 'a.md'), 'project-a');
    assert.equal(h.state.tabs.length, 1);
    await writeFile(join(h.rootA, 'a.md'), '# disk v3\n', 'utf8');

    const gate = h.gates.open.arm();
    const refresh = h.refresh('project-a');
    await gate.entered;
    // 切模式会清空该工作区的标签（SET_MODE 归约），迟到的刷新绝不能把它们写回来
    h.setMode('demo');
    gate.release();
    const result = await refresh;

    assert.equal(result.cancelled, true, '切走之后这次刷新必须被判定为取消');
    assert.equal(h.state.mode, 'demo');
    assert.equal(h.state.tabs.length, 0, '迟到的刷新结果不得复活上一个工作区的标签');
  });
});

test('D-05 连续点击刷新同一项目：不重复建临时 View，最终内容正确', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(nodeOf('project-a', 'a.md'), 'project-a');
    await writeFile(join(h.rootA, 'a.md'), '# disk v4\n', 'utf8');
    const opensBefore = h.counts.open;

    const [r1, r2] = await Promise.all([h.refresh('project-a'), h.refresh('project-a')]);

    const updated = (r1.report?.updated ?? 0) + (r2.report?.updated ?? 0);
    assert.equal(updated >= 1, true, '至少有一轮完成同步');
    assert.equal(
      h.counts.open - opensBefore <= 1,
      true,
      `无变化后不应再建 View，实际 open=${h.counts.open - opensBefore}`,
    );
    assert.equal(tabOf(h, 'project-a', 'a.md')?.buffer, '# disk v4\n');
  });
});

test('D-06 磁盘文件被删除：只记失败，标签与草稿保持不变', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(nodeOf('project-a', 'a.md'), 'project-a');
    const tab = tabOf(h, 'project-a', 'a.md');
    assert.ok(tab);
    h.opener.noteLocalEdit(tab.docId);
    h.dispatch({ type: 'EDIT_DOC', docId: tab.docId, text: '# keep me\n' });

    await unlink(join(h.rootA, 'a.md'));

    const result = await h.refresh('project-a');
    assert.equal(result.report?.updated, 0);
    assert.equal(
      (result.report?.failed.length ?? 0) >= 1,
      true,
      '读取失败必须被记录，而不是静默成功',
    );

    const after = tabOf(h, 'project-a', 'a.md');
    assert.equal(after?.buffer, '# keep me\n', '草稿不得因刷新失败丢失');
    assert.equal(after?.dirty, true);
  });
});

test('D-07 刷新未返回时切换项目：活动项目不被夺回，B 不受影响', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(nodeOf('project-a', 'a.md'), 'project-a');
    await h.opener.openNode(nodeOf('project-b', 'readme.md'), 'project-b');
    const bBefore = tabOf(h, 'project-b', 'readme.md');
    assert.ok(bBefore);
    await writeFile(join(h.rootA, 'a.md'), '# A during switch\n', 'utf8');

    const gate = h.gates.open.arm();
    const refresh = h.refresh('project-a');
    await gate.entered;
    h.dispatch({ type: 'SET_ACTIVE_PROJECT', projectId: 'project-b' });
    gate.release();
    await refresh;

    assert.equal(h.state.activeProjectId, 'project-b', '迟到的刷新不得把活动项目夺回 A');
    assert.equal(tabOf(h, 'project-b', 'readme.md')?.buffer, bBefore.buffer, 'B 不得被 A 的结果改写');
    assert.equal(tabOf(h, 'project-a', 'a.md')?.buffer, '# A during switch\n');
  });
});

// ---------------------------------------------------------------------------
// R1（GPT 审查阻断项）：刷新生命周期取消
// ---------------------------------------------------------------------------
test('R1-M01 Multi 树读取在途切 Demo：放行后不得污染新工作区', async () => {
  await withMulti(async (h) => {
    const gate = h.gates.listResources.arm();
    const refresh = h.refresh('project-a');
    await gate.entered; // 资源树请求已发出

    h.setMode('demo');
    const noticeAfterSwitch = h.state.notice;

    gate.release();
    const result = await refresh;

    assert.equal(result.cancelled, true, '切走之后必须判定为取消');
    assert.equal(h.state.mode, 'demo');
    assert.deepEqual(h.state.resourcesByProject, {}, '不得写入旧工作区的项目资源树');
    assert.deepEqual(h.state.loadingByProject, {}, '不得留下旧工作区的加载标记');
    assert.deepEqual(h.state.projects, [], '不得把旧项目表写回 Demo 工作区');
    assert.equal(h.state.notice, noticeAfterSwitch, '不得用旧刷新的提示覆盖当前提示');
  });
});

test('R1-L02 Legacy 树读取在途切 Demo：放行后不得更新资源树或旧提示', async () => {
  await withLegacy(async (h) => {
    const gate = h.gates.listResources.arm();
    const refresh = h.refresh();
    await gate.entered;

    h.setMode('demo');
    const noticeAfterSwitch = h.state.notice;
    assert.equal(h.state.loadingResources, true, '请求在途时确实处于加载中');

    gate.release();
    const result = await refresh;

    assert.equal(result.cancelled, true);
    assert.deepEqual(h.state.resources, [], '不得把旧工作区的资源树写进 Demo');
    assert.equal(h.state.notice, noticeAfterSwitch, '不得发出旧工作区的刷新提示');
  });
});

test('R1-E03 Demo→Live 快速往返：模式相同但旧代次，仍必须丢弃', async () => {
  await withMulti(async (h) => {
    const gate = h.gates.listResources.arm();
    const refresh = h.refresh('project-a');
    await gate.entered;

    // 切走再切回：模式最终仍是 live，但请求已属于上一代
    h.setMode('demo');
    h.setMode('live');
    h.reconnect('ws-2');
    const noticeAfterReturn = h.state.notice;

    gate.release();
    const result = await refresh;

    assert.equal(result.cancelled, true, '模式相同也不能让旧代次的结果生效');
    assert.deepEqual(h.state.resourcesByProject, {}, '旧代次不得写入资源树');
    assert.equal(h.state.notice, noticeAfterReturn, '旧代次不得写提示');
  });
});

test('R1-V04 open 已发出且临时 View 已建，随后关闭标签：View 必须被释放', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(nodeOf('project-a', 'a.md'), 'project-a');
    const tab = tabOf(h, 'project-a', 'a.md');
    assert.ok(tab);
    await writeFile(join(h.rootA, 'a.md'), '# disk for view\n', 'utf8');
    const viewsBefore = h.views.length;

    const gate = h.gates.afterOpenResponse.arm();
    const refresh = h.refresh('project-a');
    await gate.entered; // 信号：open 响应已到手，临时 View 已存在

    const created = h.views.slice(viewsBefore);
    assert.equal(created.length, 1, '刷新确实新建了一个临时 View');

    // 此刻关掉标签：临时 View 仍然必须被释放
    await h.client.closeDocument(tab.sessionId as string, tab.viewId as string);
    h.opener.forget(tab.docId);
    h.dispatch({ type: 'CLOSE_TAB', docId: tab.docId });

    gate.release();
    await refresh;

    assert.equal(await viewAccepted(h, created[0]), false, '临时 View 必须在取消路径上释放');
    assert.equal(h.state.tabs.length, 0, '不得复活标签');
  });
});

test('R1-V05 open 已发出且临时 View 已建，随后切模式：View 释放且不写回', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(nodeOf('project-a', 'a.md'), 'project-a');
    await writeFile(join(h.rootA, 'a.md'), '# disk for mode\n', 'utf8');
    const viewsBefore = h.views.length;

    const gate = h.gates.afterOpenResponse.arm();
    const refresh = h.refresh('project-a');
    await gate.entered;

    const created = h.views.slice(viewsBefore);
    assert.equal(created.length, 1);

    h.setMode('demo');
    gate.release();
    const result = await refresh;

    assert.equal(result.cancelled, true);
    assert.equal(await viewAccepted(h, created[0]), false, '切模式后临时 View 仍须释放');
    assert.equal(h.state.tabs.length, 0, '不得把 live 标签写回 Demo 工作区');
  });
});

test('R1-S06 readDisk 迟到且期间已保存：不得据过期快照报"外部修改"或多建 View', async () => {  await withMulti(async (h) => {
    await h.opener.openNode(nodeOf('project-a', 'a.md'), 'project-a');
    const tab = tabOf(h, 'project-a', 'a.md');
    assert.ok(tab);

    const gate = h.gates.readDisk.arm();
    const refresh = h.refresh('project-a');
    await gate.entered; // 快照已读（此刻 baseVersion 仍是旧值）

    // 在途期间用户改并保存：基线推进，磁盘内容变成用户自己的内容
    h.opener.noteLocalEdit(tab.docId);
    h.dispatch({ type: 'EDIT_DOC', docId: tab.docId, text: '# mine\n' });
    await h.client.applyEdit(tab.sessionId as string, '# mine\n', tab.baseVersion, tab.viewId);
    const saved = await h.client.saveDocument(
      tab.sessionId as string,
      tab.baseVersion as string,
      tab.viewId,
    );
    assert.equal(saved.status, 'COMMITTED');
    h.dispatch({
      type: 'TAB_PATCH',
      docId: tab.docId,
      patch: {
        baseVersion: saved.document?.baseVersion ?? null,
        revision: saved.document?.revision ?? tab.revision,
        dirty: false,
      },
    });
    const opensBefore = h.counts.open;

    gate.release();
    const result = await refresh;

    assert.deepEqual(result.report?.dirtyChanged, [], '过期快照不得用来断言"存在外部修改"');
    assert.equal(result.report?.updated, 0, '也不得据此同步（用户刚保存的内容就是磁盘内容）');
    assert.equal(h.counts.open, opensBefore, '过期快照不得触发多余的 open / 临时 View');
    assert.equal(tabOf(h, 'project-a', 'a.md')?.buffer, '# mine\n');
  });
});

test('R1-C07 手动刷新不推进 load 代次：不得误取消进行中的恢复', async () => {
  await withMulti(async (h) => {
    // 模拟 S11-C 恢复刚开启的一代：刷新只能"读令牌"，不能推进或作废它
    const cancelledByRestore = h.startEpoch();
    await h.refresh('project-a');
    assert.equal(cancelledByRestore(), false, '刷新不得让恢复的在途检查失效');
  });
});

test('R1-L08 Legacy 文档刷新在途切 Demo：返回后不得写提示或资源树', async () => {
  await withLegacy(async (h) => {
    await h.opener.openNode(nodeOf(null, 'a.md'), null);
    await writeFile(join(h.rootA, 'a.md'), '# legacy v2\n', 'utf8');

    const gate = h.gates.readDisk.arm();
    const refresh = h.refresh();
    await gate.entered; // 文件树已回填，文档层已发出 readDisk

    h.setMode('demo');
    const noticeAfterSwitch = h.state.notice;

    gate.release();
    const result = await refresh;

    assert.equal(result.cancelled, true, '文档刷新返回后也要重新校验，不能只看请求发出时');
    assert.deepEqual(h.state.resources, [], '不得把旧资源树写回 Demo');
    assert.equal(h.state.notice, noticeAfterSwitch, '不得覆盖当前提示');
  });
});

test('R2-01 旧刷新的 finally 不得清除新一代同项目的加载标记', async () => {
  await withMulti(async (h) => {
    // 旧一代手动刷新：卡在资源树请求上
    const oldGate = h.gates.listResources.arm();
    const oldRefresh = h.refresh('project-a');
    await oldGate.entered;

    // 推进代次（Demo → Live 往返），并真的发起一次新的同项目加载
    h.setMode('demo');
    h.setMode('live');
    const newGate = h.gates.listResources.arm();
    const newLoad = loadProjectResources(
      { getState: () => h.state, dispatch: h.dispatch, clientFor: () => h.client },
      'project-a',
    );
    await newGate.entered;
    assert.equal(h.state.loadingByProject['project-a'], true, '新一代已处于加载中');

    // 放行旧请求：它已过期，绝不能把新一代的标记改回 false
    oldGate.release();
    await oldRefresh;
    assert.equal(
      h.state.loadingByProject['project-a'],
      true,
      '旧请求不得清除新一代的加载标记（否则 spinner 被提前关掉）',
    );

    // 新一代自己收尾
    newGate.release();
    await newLoad;
    assert.equal(h.state.loadingByProject['project-a'], false, '新一代加载结束后自己清理');
  });
});
