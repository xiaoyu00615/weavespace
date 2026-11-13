/**
 * S11-A1-G2-R1：打开流程的异步安全（确定性时序，真实 Host）。
 *
 * 这组用例**直接驱动 `DocumentActionsContext` 使用的编排器**
 * （`state/open-document.ts` 的 `createDocumentOpener`）：
 * - 客户端是真实 `createLiveClient`，服务端是真实 G1 Multi Host（端口 0）；
 * - 状态用真实 `workspaceReducer` 承接，和 Provider 里 `dispatch` 的行为一致；
 * - "响应迟到"通过一个受控 Promise 精确制造，不依赖 sleep / 随机时序。
 *
 * 覆盖三件事：旧读取不得覆盖新编辑、重复打开不得泄漏服务端 View、
 * 模式切换后在途响应不得写进新工作区。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createShellServer } from '../../apps/server/src/server.ts';
import {
  createLiveClient,
  type WeaveSpaceClient,
} from '../../apps/shell/src/client/client-api.ts';
import { hasUnsavedDrafts } from '../../apps/shell/src/state/doc-identity.ts';
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

const NODE_A: ResourceNodeState = {
  id: 'doc:project-a/a.md',
  name: 'a.md',
  kind: 'file',
  extension: '.md',
  path: 'a.md',
};

const NODE_A2: ResourceNodeState = {
  id: 'doc:project-a/docs/only-a.md',
  name: 'only-a.md',
  kind: 'file',
  extension: '.md',
  path: 'docs/only-a.md',
};

const NODE_NOTES: ResourceNodeState = {
  id: 'doc:project-a/notes.md',
  name: 'notes.md',
  kind: 'file',
  extension: '.md',
  path: 'notes.md',
};

const NODE_B: ResourceNodeState = {
  id: 'doc:project-b/a.md',
  name: 'a.md',
  kind: 'file',
  extension: '.md',
  path: 'a.md',
};

interface OpenCall {
  path: string;
  projectId?: string;
}

interface SeenView {
  sessionId: string;
  viewId: string;
}

interface Harness {
  state: WorkspaceState;
  /** 夹具目录（断言语磁盘时必须用真实路径，不允许猜）。 */
  rootA: string;
  rootB: string;
  opener: DocumentOpener;
  /** 被观测/可挂起的客户端（编排器实际使用的那一个）。 */
  client: WeaveSpaceClient;
  /** 直连客户端：只用于读取服务端真实状态做断言，不参与业务流程。 */
  inner: WeaveSpaceClient;
  calls: OpenCall[];
  views: SeenView[];
  dispatch(action: WorkspaceAction): void;
  setMode(mode: ClientMode): void;
  /** 挂起下一次 openDocument 的**响应**（请求本身照常发出）。返回放行函数。 */
  holdNextOpen(): () => void;
}

async function withMulti(fn: (h: Harness) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-g2r1-'));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await mkdir(join(rootB, 'docs'), { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'only-a.md'), '# only A\n', 'utf8');
  await writeFile(join(rootA, 'notes.md'), '# notes\n', 'utf8');
  await writeFile(join(rootB, 'a.md'), '# B\n', 'utf8');

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

  const calls: OpenCall[] = [];
  const views: SeenView[] = [];

  let gate: Promise<void> | null = null;
  let releaseGate: (() => void) | null = null;

  const client: WeaveSpaceClient = {
    ...inner,
    async openDocument(path: string, projectId?: string) {
      calls.push(projectId ? { path, projectId } : { path });
      const pending = inner.openDocument(path, projectId);
      const held = gate;
      if (held) {
        // 只挂起**这一次**响应：等待期间用户打开别的文件必须能正常完成
        gate = null;
        await held;
      }
      const outcome = await pending;
      if (outcome.document?.viewId) {
        views.push({ sessionId: outcome.document.sessionId, viewId: outcome.document.viewId });
      }
      return outcome;
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

  const h: Harness = {
    get state() {
      return state;
    },
    rootA,
    rootB,
    opener,
    client,
    inner,
    calls,
    views,
    dispatch,
    setMode(next) {
      // 与 Provider 的 switchMode 顺序一致：先同步模式，再派发
      mode = next;
      dispatch({ type: 'SET_MODE', mode: next });
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
  } as Harness;

  try {
    await fn(h);
  } finally {
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

/** 服务端是否仍承认这个 View（已释放的 View 会被 `/api/document` 拒绝）。 */
async function viewAccepted(h: Harness, view: SeenView): Promise<boolean> {
  const outcome = await h.inner.readDocument(view.sessionId, view.viewId);
  return outcome.status === 'APPLIED';
}

// ---------------------------------------------------------------------------
// R1-01 旧读取结果不得覆盖请求期间的新编辑
// ---------------------------------------------------------------------------
test('R1-01 重新打开期间发生本地编辑：旧响应不得覆盖缓冲、dirty 与 revision', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(NODE_A, 'project-a');
    const original = h.state.tabs[0];
    assert.ok(original, '首次打开必须建立标签');
    assert.equal(original.buffer, '# A\n');
    assert.equal(original.dirty, false);

    // 挂起"再次点击"触发的刷新响应（走的是已有干净标签的路径）
    const release = h.holdNextOpen();
    const refresh = h.opener.openNode(NODE_A, 'project-a');

    // 请求期间用户继续输入：真实调用链 = noteLocalEdit + EDIT_DOC + Core applyEdit
    h.opener.noteLocalEdit(original.docId);
    h.dispatch({ type: 'EDIT_DOC', docId: original.docId, text: '# typed during refresh\n' });
    const edited = await h.client.applyEdit(
      original.sessionId as string,
      '# typed during refresh\n',
      original.baseVersion,
      original.viewId,
    );
    assert.equal(edited.status, 'APPLIED');
    const revisionAfterEdit = edited.document?.revision as number;
    // 与队列同步成功后的真实行为一致：只回写 revision / 状态，不回写内容
    h.dispatch({
      type: 'TAB_PATCH',
      docId: original.docId,
      patch: {
        revision: revisionAfterEdit,
        documentState: edited.document?.documentState ?? 'EDITING_DIRTY',
      },
    });

    release();
    await refresh;

    const tab = h.state.tabs[0];
    assert.equal(tab.buffer, '# typed during refresh\n', '旧读取结果不得覆盖新编辑');
    assert.equal(tab.dirty, true, '不得把 dirty 错误地重置为 false');
    assert.equal(tab.revision, revisionAfterEdit, '不得用旧响应回退 revision');
    assert.equal(tab.baseVersion, original.baseVersion, '不得回退 baseVersion');
    assert.equal(tab.sessionId, original.sessionId, 'Core 归属不得改变');
    assert.equal(tab.viewId, original.viewId, '标签的 viewId 不得被临时 View 顶替');

    // Core 里仍是用户的新内容：旧响应不能把会话拉回磁盘旧版本
    const core = await h.inner.readDocument(original.sessionId as string, original.viewId);
    assert.equal(core.status, 'APPLIED');
    assert.equal(core.document?.content, '# typed during refresh\n');
    assert.equal(core.document?.dirty, true);
  });
});

// ---------------------------------------------------------------------------
// R1-02 正常情况下仍允许合法的磁盘刷新
// ---------------------------------------------------------------------------
test('R1-02 无本地编辑时，干净标签仍能同步磁盘变化（且临时 View 被释放）', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(NODE_A, 'project-a');
    const tab = h.state.tabs[0];
    const before = tab.baseVersion;

    // 外部程序改写磁盘
    await writeFile(join(h.rootA, 'a.md'), '# A from disk\n', 'utf8');

    await h.opener.openNode(NODE_A, 'project-a');

    const after = h.state.tabs[0];
    assert.equal(after.buffer, '# A from disk\n', '干净标签应同步磁盘最新内容');
    assert.equal(after.dirty, false);
    assert.notEqual(after.baseVersion, before, 'baseVersion 必须推进');
    assert.equal(h.state.tabs.length, 1);

    // 刷新用的临时 View 必须已被释放，标签自己的 View 仍可用
    assert.equal(h.views.length, 2, '一次新建 + 一次刷新临时 View');
    assert.equal(after.viewId, h.views[0].viewId);
    assert.equal(await viewAccepted(h, h.views[1]), false, '临时 View 必须释放');
    assert.equal(await viewAccepted(h, { sessionId: after.sessionId as string, viewId: after.viewId as string }), true);
  });
});

// ---------------------------------------------------------------------------
// R1-03 有草稿的标签不刷新（既有语义）
// ---------------------------------------------------------------------------
test('R1-03 有未保存草稿的标签再次点击：不发起读取、不被覆盖', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(NODE_A, 'project-a');
    const tab = h.state.tabs[0];
    h.opener.noteLocalEdit(tab.docId);
    h.dispatch({ type: 'EDIT_DOC', docId: tab.docId, text: '# draft\n' });

    await h.opener.openNode(NODE_A, 'project-a');

    assert.equal(h.calls.length, 1, '有草稿时不应再发起 open（避免无意义的新 View）');
    assert.equal(h.state.tabs[0].buffer, '# draft\n');
    assert.equal(h.state.tabs[0].dirty, true);
  });
});

// ---------------------------------------------------------------------------
// R1-04（V-01）重复打开不泄漏 View
// ---------------------------------------------------------------------------
test('R1-04 连续点击同一文件：一个标签、一个受管 View，临时 View 已释放', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(NODE_A, 'project-a');
    await h.opener.openNode(NODE_A, 'project-a');

    assert.equal(h.state.tabs.length, 1, 'UI 只能有一个标签');
    const tab = h.state.tabs[0];
    assert.equal(h.views.length, 2);

    // 除标签自己的 View 外，其余必须已被服务端释放
    const managed = { sessionId: tab.sessionId as string, viewId: tab.viewId as string };
    for (const view of h.views) {
      if (view.viewId === managed.viewId) continue;
      assert.equal(await viewAccepted(h, view), false, `未受管的 View 必须释放: ${view.viewId}`);
    }
    assert.equal(await viewAccepted(h, managed), true, '标签自己的 View 必须仍有效');

    // 原有 viewId 仍可编辑与保存
    const edited = await h.client.applyEdit(
      managed.sessionId,
      '# saved after reopen\n',
      tab.baseVersion,
      managed.viewId,
    );
    assert.equal(edited.status, 'APPLIED');
    const saved = await h.client.saveDocument(
      managed.sessionId,
      (edited.document?.baseVersion ?? tab.baseVersion) as string,
      managed.viewId,
    );
    assert.equal(saved.status, 'COMMITTED');
    assert.equal(await readFile(join(h.rootA, 'a.md'), 'utf8'), '# saved after reopen\n');
  });
});

// ---------------------------------------------------------------------------
// R1-05（V-02）并发首次打开
// ---------------------------------------------------------------------------
test('R1-05 两个并发的首次打开：只产生一个受管 View，无悬挂 View', async () => {
  await withMulti(async (h) => {
    await Promise.all([
      h.opener.openNode(NODE_A, 'project-a'),
      h.opener.openNode(NODE_A, 'project-a'),
    ]);

    assert.equal(h.state.tabs.length, 1);
    assert.equal(h.views.length, 1, '并发打开必须合并为一次，不能在服务端多建 View');
    assert.equal(h.calls.length, 1);
    const tab = h.state.tabs[0];
    assert.equal(tab.viewId, h.views[0].viewId);
    assert.equal(await viewAccepted(h, h.views[0]), true);

    const read = await h.client.readDocument(tab.sessionId as string, tab.viewId);
    assert.equal(read.status, 'APPLIED');
    assert.equal(read.document?.content, '# A\n');
  });
});

// ---------------------------------------------------------------------------
// R1-06 模式切换：在途 live 响应不得写进 Demo
// ---------------------------------------------------------------------------
test('R1-06 打开期间切换到 Demo：旧响应不插入标签、不改资源树、临时 View 释放', async () => {
  await withMulti(async (h) => {
    const release = h.holdNextOpen();
    const opening = h.opener.openNode(NODE_A2, 'project-a');

    // 用户在请求返回前切到 Demo（真实入口是 toolbar 的 switchMode）
    h.setMode('demo');
    const afterSwitch = h.state;
    const noticeAfterSwitch = afterSwitch.notice;
    assert.equal(afterSwitch.mode, 'demo');

    release();
    await opening;

    assert.equal(h.state.mode, 'demo', '模式不得被旧响应改回 live');
    assert.equal(h.state.tabs.length, 0, '旧 live 响应不得向 Demo 工作区插入标签');
    assert.deepEqual(h.state.resources, [], 'Demo 资源树不得被改动');
    assert.deepEqual(h.state.resourcesByProject, {});
    assert.equal(h.state.panes.primary.docId, null, '焦点不得被旧响应改写');
    assert.equal(h.state.panes.secondary.docId, null);
    assert.equal(h.state.notice, noticeAfterSwitch, '旧响应不得覆盖 Demo 的提示');

    // 已经创建但不再被使用的远端 View 必须释放
    assert.equal(h.views.length, 1);
    assert.equal(await viewAccepted(h, h.views[0]), false, '切走后临时 View 必须释放');
  });
});

// ---------------------------------------------------------------------------
// R1-07 项目切换：旧响应可以建档，但不得抢走焦点
// ---------------------------------------------------------------------------
test('R1-07 打开 A 期间切到 B：A 的标签可以出现，但焦点留在 B', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(NODE_B, 'project-b');
    const bDocId = h.state.tabs[0].docId;
    assert.equal(h.state.panes.primary.docId, bDocId);

    const release = h.holdNextOpen();
    const opening = h.opener.openNode(NODE_A2, 'project-a');

    h.dispatch({ type: 'SET_ACTIVE_PROJECT', projectId: 'project-b' });

    release();
    await opening;

    assert.equal(h.state.tabs.length, 2, '已经取回内容的文件仍应出现在标签栏');
    assert.ok(h.state.tabs.some((tab) => tab.docId === 'doc:project-a/docs/only-a.md'));
    assert.equal(h.state.activeProjectId, 'project-b', '不得把当前项目改回 A');
    assert.equal(h.state.panes.primary.docId, bDocId, '不得抢走用户当前的焦点');
  });
});

// ---------------------------------------------------------------------------
// R1-08 未保存草稿仍阻止模式切换（守卫未放宽）
// ---------------------------------------------------------------------------
test('R1-08 未保存草稿的模式切换守卫保持有效', () => {
  assert.equal(hasUnsavedDrafts([{ dirty: false }, { dirty: false }]), false);
  assert.equal(hasUnsavedDrafts([{ dirty: false }, { dirty: true }]), true);
});

// ---------------------------------------------------------------------------
// R2-01（F-01）旧项目请求不得覆盖后来打开的文档焦点
// ---------------------------------------------------------------------------
test('R2-01 迟到的 A/notes.md 不得把焦点从 B/a.md 抢回去', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(NODE_A, 'project-a');
    const aDocId = h.state.tabs[0].docId;
    assert.equal(paneDocId(h), aDocId, '前提：当前显示 A/a.md');

    // A/notes.md 的响应被挂起
    const release = h.holdNextOpen();
    const pending = h.opener.openNode(NODE_NOTES, 'project-a');

    // 用户切到项目 B 并打开 B/a.md（切换项目 = 点项目标题，打开文件 = 点文件）
    h.dispatch({ type: 'SET_ACTIVE_PROJECT', projectId: 'project-b' });
    await h.opener.openNode(NODE_B, 'project-b');
    const bDocId = 'doc:project-b/a.md';
    assert.equal(h.state.activeProjectId, 'project-b');
    assert.equal(paneDocId(h), bDocId, '前提：当前窗格已指向 B/a.md');

    release();
    await pending;

    const notes = h.state.tabs.find((tab) => tab.docId === 'doc:project-a/notes.md');
    assert.ok(notes, 'A/notes.md 允许出现在标签栏');
    assert.equal(paneDocId(h), bDocId, '旧请求不得覆盖用户后来打开的文档焦点');
    assert.equal(h.state.activeProjectId, 'project-b', '不得把当前项目改回 A');

    // 不激活不等于释放：新建文档的受管 View 必须保留
    assert.equal(
      await viewAccepted(h, {
        sessionId: notes.sessionId as string,
        viewId: notes.viewId as string,
      }),
      true,
      '未激活的新标签仍必须持有有效 View',
    );
  });
});

// ---------------------------------------------------------------------------
// R2-02（F-02）并发合并的等待方不能重新抢焦点
// ---------------------------------------------------------------------------
test('R2-02 合并请求的等待方不得在旧响应后抢回焦点', async () => {
  await withMulti(async (h) => {
    await h.opener.openNode(NODE_A, 'project-a');

    const release = h.holdNextOpen();
    const first = h.opener.openNode(NODE_NOTES, 'project-a');
    const second = h.opener.openNode(NODE_NOTES, 'project-a');

    h.dispatch({ type: 'SET_ACTIVE_PROJECT', projectId: 'project-b' });
    await h.opener.openNode(NODE_B, 'project-b');
    const bDocId = 'doc:project-b/a.md';
    assert.equal(paneDocId(h), bDocId);

    release();
    await Promise.all([first, second]);

    assert.equal(paneDocId(h), bDocId, '两个请求结束后焦点仍必须是 B/a.md');
    assert.equal(h.state.activeProjectId, 'project-b');
    assert.equal(
      h.calls.filter((call) => call.path === 'notes.md').length,
      1,
      '并发打开必须合并为一次请求',
    );
    const notes = h.state.tabs.find((tab) => tab.docId === 'doc:project-a/notes.md');
    assert.ok(notes, 'A/notes.md 仍应被登记');
    assert.equal(
      await viewAccepted(h, {
        sessionId: notes.sessionId as string,
        viewId: notes.viewId as string,
      }),
      true,
      'A 只产生一个受管理 View，且必须有效',
    );
    assert.equal(
      h.views.filter((view) => view.sessionId === notes.sessionId).length,
      1,
      'A/notes.md 只允许一个 View',
    );
  });
});

// ---------------------------------------------------------------------------
// R2-03（F-03）没有旧活动文档时也不能抢焦点
// ---------------------------------------------------------------------------
test('R2-03 窗格为空时切到 B：迟到的 A 响应只能后台登记', async () => {
  await withMulti(async (h) => {
    assert.equal(h.state.tabs.length, 0, '前提：一开始没有任何标签');
    assert.equal(paneDocId(h), null, '前提：当前窗格为空');

    const release = h.holdNextOpen();
    const pending = h.opener.openNode(NODE_NOTES, 'project-a');

    // 用户切到项目 B，窗格仍是空的
    h.dispatch({ type: 'SET_ACTIVE_PROJECT', projectId: 'project-b' });
    assert.equal(paneDocId(h), null);

    release();
    await pending;

    assert.equal(h.state.tabs.length, 1, 'A/notes.md 可以后台登记标签');
    assert.equal(paneDocId(h), null, '不得自动成为当前窗格的活动文档');
    assert.equal(h.state.activeProjectId, 'project-b', '当前项目仍是 B');
  });
});

/** 当前焦点窗格里的文档 id（用户"正在看的"那个）。 */
function paneDocId(h: Harness): string | null {
  return h.state.panes[h.state.focusedPane]?.docId ?? null;
}
