/**
 * S11-UX-01A：已打开文件的安全手动刷新（真实 Host + 真实 reducer）。
 *
 * 缺口（修复前）：项目刷新按钮只重载**文件树**（`reloadResources`），
 * 已打开文档完全不会检查磁盘——外部编辑器改完 a.md 再点刷新，标签里还是旧内容。
 *
 * 这组用例直接驱动 Provider 实际使用的编排器（`createDocumentOpener`），
 * 客户端是真实 `createLiveClient`，服务端是真实 Host（端口 0），状态由真实
 * `workspaceReducer` 承接；不测"模拟函数返回值"。
 *
 * 纪律（与 S11-C / G2-R1 一致）：
 * - 草稿绝不被刷新覆盖；外部变化只提示，不自动 reload；
 * - 刷新不得改变活动文档 / 焦点窗格 / 分屏结构；
 * - 临时 View 必须释放；迟到响应不得复活已关闭标签或写进另一个工作区；
 * - A/B 项目同名文件绝不混淆。
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
  /** 直连客户端：只用于断言服务端真实状态。 */
  inner: WeaveSpaceClient;
  views: SeenView[];
  /** 统计：openDocument 调用次数 / reload 调用次数 / readDisk 调用次数。 */
  counts: { open: number; reload: number; disk: number };
  dispatch(action: WorkspaceAction): void;
  setMode(mode: ClientMode): void;
  /** 挂起下一次 openDocument 的**响应**（请求照常发出）。返回放行函数。 */
  holdNextOpen(): () => void;
  /** 挂起下一次 readDisk 的**响应**。返回放行函数。 */
  holdNextDisk(): () => void;
}

function makeClientHooks(inner: WeaveSpaceClient, counts: Harness['counts'], views: SeenView[]) {
  const gates: { open: (() => void) | null; disk: (() => void) | null } = { open: null, disk: null };
  let openGate: Promise<void> | null = null;
  let diskGate: Promise<void> | null = null;

  const client: WeaveSpaceClient = {
    ...inner,
    async openDocument(path: string, projectId?: string) {
      counts.open += 1;
      const pending = inner.openDocument(path, projectId);
      const held = openGate;
      if (held) {
        openGate = null;
        await held;
      }
      const outcome = await pending;
      if (outcome.document?.viewId) {
        views.push({ sessionId: outcome.document.sessionId, viewId: outcome.document.viewId });
      }
      return outcome;
    },
    async readDisk(sessionId: string, viewId?: string | null) {
      counts.disk += 1;
      const pending = inner.readDisk(sessionId, viewId);
      const held = diskGate;
      if (held) {
        diskGate = null;
        await held;
      }
      return pending;
    },
    async reloadDocument(sessionId: string, viewId: string) {
      counts.reload += 1;
      return inner.reloadDocument(sessionId, viewId);
    },
  };

  return {
    client,
    holdNextOpen() {
      openGate = new Promise<void>((resolve) => {
        gates.open = resolve;
      });
      return () => {
        openGate = null;
        gates.open?.();
        gates.open = null;
      };
    },
    holdNextDisk() {
      diskGate = new Promise<void>((resolve) => {
        gates.disk = resolve;
      });
      return () => {
        diskGate = null;
        gates.disk?.();
        gates.disk = null;
      };
    },
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

  let state: WorkspaceState = {
    ...INITIAL_STATE,
    mode: 'live',
    workspaceMode: 'multi',
    projects: [
      { projectId: 'project-a', name: '项目 A', status: 'READY' },
      { projectId: 'project-b', name: '项目 B', status: 'READY' },
    ],
    activeProjectId: 'project-a',
    notice: '',
  };
  let mode: ClientMode = 'live';

  const counts = { open: 0, reload: 0, disk: 0 };
  const views: SeenView[] = [];
  const hooks = makeClientHooks(inner, counts, views);

  const dispatch = (action: WorkspaceAction): void => {
    state = workspaceReducer(state, action);
  };

  const opener = createDocumentOpener({
    getState: () => state,
    getMode: () => mode,
    dispatch,
    clientFor: (target) => {
      if (target !== 'live') throw new Error(`测试不应使用 ${target} 客户端`);
      return hooks.client;
    },
    editEpochs: createEditEpochs(),
  });

  try {
    await fn({
      get state() {
        return state;
      },
      rootA,
      rootB,
      opener,
      client: hooks.client,
      inner,
      views,
      counts,
      dispatch,
      setMode(next) {
        mode = next;
        dispatch({ type: 'SET_MODE', mode: next });
      },
      holdNextOpen: hooks.holdNextOpen,
      holdNextDisk: hooks.holdNextDisk,
    });
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

  let state: WorkspaceState = {
    ...INITIAL_STATE,
    mode: 'live',
    workspaceMode: 'legacy',
    notice: '',
  };
  let mode: ClientMode = 'live';
  const counts = { open: 0, reload: 0, disk: 0 };
  const views: SeenView[] = [];
  const hooks = makeClientHooks(inner, counts, views);
  const dispatch = (action: WorkspaceAction): void => {
    state = workspaceReducer(state, action);
  };
  const opener = createDocumentOpener({
    getState: () => state,
    getMode: () => mode,
    dispatch,
    clientFor: (target) => {
      if (target !== 'live') throw new Error(`测试不应使用 ${target} 客户端`);
      return hooks.client;
    },
    editEpochs: createEditEpochs(),
  });

  try {
    await fn({
      get state() {
        return state;
      },
      rootA: root,
      rootB: root,
      opener,
      client: hooks.client,
      inner,
      views,
      counts,
      dispatch,
      setMode(next) {
        mode = next;
        dispatch({ type: 'SET_MODE', mode: next });
      },
      holdNextOpen: hooks.holdNextOpen,
      holdNextDisk: hooks.holdNextDisk,
    });
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

    const report = await h.opener.refreshOpenTabs('project-a');
    assert.equal(report.updated, 1, '应同步 1 个文件');

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
    const noticeBefore = h.state.notice;

    const report = await h.opener.refreshOpenTabs('project-a');
    assert.equal(report.updated, 0);
    assert.equal(h.counts.open, opensBefore, '无变化时不得调用 open（否则每次刷新都多一个 View）');

    const after = tabOf(h, 'project-a', 'a.md');
    assert.equal(after?.buffer, before.buffer);
    assert.equal(after?.revision, before.revision);
    assert.equal(after?.baseVersion, before.baseVersion);
    assert.equal(h.state.notice, noticeBefore, '无变化时不应打扰用户');
  });
});

test('A-03 刷新不改变活动文档、焦点窗格与分屏结构', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(nodeOf('project-a', 'a.md'), 'project-a');
    await h.opener.openNode(nodeOf('project-b', 'readme.md'), 'project-b');
    // 焦点停在 B 的文件上，A 的 a.md 仍在后台打开
    h.dispatch({ type: 'SET_LAYOUT', layout: 'vertical' });
    h.dispatch({ type: 'FOCUS_PANE', pane: 'secondary' });
    const panesBefore = JSON.stringify(h.state.panes);
    const focusedBefore = h.state.focusedPane;
    const layoutBefore = h.state.layout;

    await writeFile(join(h.rootA, 'a.md'), '# A changed\n', 'utf8');
    await h.opener.refreshOpenTabs('project-a');

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

    // 用户改动（真实调用链：noteLocalEdit + EDIT_DOC + Core applyEdit）
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

    // 外部也改了
    await writeFile(join(h.rootA, 'a.md'), '# disk version\n', 'utf8');
    const reloadsBefore = h.counts.reload;

    const report = await h.opener.refreshOpenTabs('project-a');
    assert.deepEqual(report.dirtyChanged, ['a.md'], '必须明确报告该文件存在外部修改');
    assert.equal(report.updated, 0, '有草稿的文件绝不自动同步');
    assert.equal(h.counts.reload, reloadsBefore, '不得调用会丢弃草稿的 reload');

    const after = tabOf(h, 'project-a', 'a.md');
    assert.equal(after?.buffer, '# my draft\n', '草稿必须完整保留');
    assert.equal(after?.dirty, true, 'dirty 必须保留');
    assert.equal(after?.baseVersion, draftTab.baseVersion, '版本基线不得被改写');
    assert.equal(after?.revision, draftTab.revision, 'revision 不得被推进');
    assert.equal(after?.sessionId, draftTab.sessionId);
    // 不能伪造"保存已冲突"
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

    const report = await h.opener.refreshOpenTabs('project-a');
    assert.deepEqual(
      report.dirtyChanged,
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
    await h.opener.refreshOpenTabs('project-a');

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

    const report = await h.opener.refreshOpenTabs('project-a');
    assert.equal(report.updated, 1);

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
    const report = await h.opener.refreshOpenTabs(null);
    assert.equal(report.updated, 1);
    assert.equal(tabOf(h, null, 'a.md')?.buffer, '# legacy A v2\n');
  });
});

// ---------------------------------------------------------------------------
// D. 异步安全
// ---------------------------------------------------------------------------
test('D-01 刷新未返回时用户输入：旧结果被拒，草稿不被覆盖', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(nodeOf('project-a', 'a.md'), 'project-a');
    const tab = tabOf(h, 'project-a', 'a.md');
    assert.ok(tab);
    await writeFile(join(h.rootA, 'a.md'), '# from disk\n', 'utf8');

    const release = h.holdNextOpen();
    const refresh = h.opener.refreshOpenTabs('project-a');

    // 请求在途：用户开始输入
    h.opener.noteLocalEdit(tab.docId);
    h.dispatch({ type: 'EDIT_DOC', docId: tab.docId, text: '# typed while refreshing\n' });
    await h.client.applyEdit(
      tab.sessionId as string,
      '# typed while refreshing\n',
      tab.baseVersion,
      tab.viewId,
    );

    release();
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

    // 挂起磁盘读取的**响应**（请求已发出，读到的是保存之前的磁盘状态）
    const release = h.holdNextDisk();
    const refresh = h.opener.refreshOpenTabs('project-a');

    // 在途期间用户改动并保存（磁盘此前未变，因此条件保存应成功）
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

    release();
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

    const release = h.holdNextOpen();
    const refresh = h.opener.refreshOpenTabs('project-a');

    // 在途期间用户关闭标签（真实调用链：关闭会话视图 + CLOSE_TAB）
    await h.client.closeDocument(tab.sessionId as string, tab.viewId as string);
    h.opener.forget(tab.docId);
    h.dispatch({ type: 'CLOSE_TAB', docId: tab.docId });

    release();
    await refresh;

    assert.equal(h.state.tabs.length, 0, '刷新不得复活已关闭的标签');
    // 标签自己的 View 在关闭时已释放；临时 View 也必须释放掉
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

    const release = h.holdNextOpen();
    const refresh = h.opener.refreshOpenTabs('project-a');
    // 切模式会清空该工作区的标签（SET_MODE 归约），迟到的刷新绝不能把它们写回来
    h.setMode('demo');
    release();
    await refresh;

    assert.equal(h.state.mode, 'demo');
    assert.equal(h.state.tabs.length, 0, '迟到的刷新结果不得复活上一个工作区的标签');
  });
});

test('D-05 连续点击刷新同一项目：不重复建临时 View，最终内容正确', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(nodeOf('project-a', 'a.md'), 'project-a');
    await writeFile(join(h.rootA, 'a.md'), '# disk v4\n', 'utf8');
    const opensBefore = h.counts.open;

    const [r1, r2] = await Promise.all([
      h.opener.refreshOpenTabs('project-a'),
      h.opener.refreshOpenTabs('project-a'),
    ]);

    assert.equal(r1.updated + r2.updated >= 1, true, '至少有一轮完成同步');
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

    const report = await h.opener.refreshOpenTabs('project-a');
    assert.equal(report.updated, 0);
    assert.equal(report.failed.length >= 1, true, '读取失败必须被记录，而不是静默成功');

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

    const release = h.holdNextOpen();
    const refresh = h.opener.refreshOpenTabs('project-a');
    // 在途期间用户切到项目 B
    h.dispatch({ type: 'SET_ACTIVE_PROJECT', projectId: 'project-b' });
    release();
    await refresh;

    assert.equal(h.state.activeProjectId, 'project-b', '迟到的刷新不得把活动项目夺回 A');
    assert.equal(tabOf(h, 'project-b', 'readme.md')?.buffer, bBefore.buffer, 'B 不得被 A 的结果改写');
    assert.equal(tabOf(h, 'project-a', 'a.md')?.buffer, '# A during switch\n');
  });
});
