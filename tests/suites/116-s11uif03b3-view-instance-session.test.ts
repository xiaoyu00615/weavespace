/**
 * UI-F03-B3：ViewInstance 与 DocumentSession 分离（先红后绿）。
 *
 * 这一组钉的是 B2 遗留的那个临时状态：`LayoutTree → ViewGroup → DocTab` 里，
 * 一份文档只有一个 `viewId`，于是"左右两格看同一份文档"实际上是**一个 Host View
 * 被两处显示**。关掉左边，右边跟着失效；改右边，左边看到的是同一份草稿——看起来
 * 正常，直到有人关标签或改文件名。
 *
 * B3 的模型是四层：
 *
 * ```
 * LayoutTree → ViewGroup → ViewInstance(自己的 hostViewId) → 共享 DocumentSession
 * ```
 *
 * 因此这里要证明的全是"同一份文档、两个视图"的边界：
 *
 * 1. 两个实例各有自己的 Host View（Live），**绝不共用**；
 * 2. 两个实例共享同一条文档记录（缓冲 / revision / dirty 只有一份）；
 * 3. 关掉一格不动另一格；全部关掉才清理文档记录；
 * 4. 最后一个脏视图仍受 Host 的 `ERR_DOCUMENT_DIRTY` 保护；
 * 5. 迟到响应落到**发起时**的那个组，且它建的 View 必须有人认领。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WeaveSpaceClient } from '../../apps/shell/src/client/client-api.ts';
import { validateLayoutTree } from '../../apps/shell/src/state/layout-tree.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import { createViewInstanceActions } from '../../apps/shell/src/state/view-instance-actions.ts';
import {
  activeDocIdInGroup,
  activeInstanceIdInGroup,
  docIdsInGroup,
  viewGroupProblems,
  visibleGroupIds,
} from '../../apps/shell/src/state/workspace-view-groups.ts';
import {
  hostViewIdForDoc,
  instanceFor,
  instancesOfDoc,
  viewInstanceProblems,
} from '../../apps/shell/src/state/workspace-view-instances.ts';
import type { DocTab, WorkspaceAction, WorkspaceState } from '../../apps/shell/src/state/types.ts';
import { resetPageInstanceCache, setPageInstanceForTest } from '../../apps/shell/src/client/client-api.ts';
import { createHarness, writeProjectFile } from '../helpers.ts';
import { MemoryStorage, makeHarness, makeRoots, nodeOf, startHost } from '../helpers/s11c-harness.ts';

const PRIMARY = 'legacy-group:primary';
const SECONDARY = 'legacy-group:secondary';

/* ================================================================== */
/* 夹具                                                                */
/* ================================================================== */

function tab(overrides: Partial<DocTab> & Pick<DocTab, 'docId' | 'path'>): DocTab {
  return {
    projectId: null,
    title: overrides.path,
    extension: '.md',
    buffer: `# ${overrides.path}\n`,
    dirty: false,
    mode: 'live',
    sessionId: `session-${overrides.docId}`,
    viewId: `view-${overrides.docId}`,
    baseVersion: 'sha256:aaa',
    revision: 0,
    documentState: 'CLEAN',
    saving: false,
    lastStatus: null,
    errorCode: null,
    ...overrides,
  };
}

const liveState = (): WorkspaceState =>
  workspaceReducer(INITIAL_STATE, { type: 'SET_MODE', mode: 'live' });

const open = (state: WorkspaceState, docId: string): WorkspaceState =>
  workspaceReducer(state, { type: 'OPEN_TAB', tab: tab({ docId, path: `${docId}.md` }) });

const split = (state: WorkspaceState): WorkspaceState =>
  workspaceReducer(state, { type: 'SET_LAYOUT', layout: 'vertical' });

const group = (state: WorkspaceState, groupId: string) => state.viewGroups[groupId];

const docsIn = (state: WorkspaceState, groupId: string): readonly string[] =>
  docIdsInGroup(state.viewGroups, state.viewInstances, groupId);

const activeDocIn = (state: WorkspaceState, groupId: string): string | null =>
  activeDocIdInGroup(state.viewGroups, state.viewInstances, groupId);

const instancesOf = (state: WorkspaceState, docId: string) =>
  instancesOfDoc(state.viewInstances, docId);

/** 每次操作后都要成立的一组事实。 */
function assertConsistent(state: WorkspaceState, label: string): void {
  const docIds = new Set(state.tabs.map((item) => item.docId));
  assert.deepEqual(
    viewGroupProblems(state.viewGroups, state.viewInstances, docIds),
    [],
    `${label}：组与实例的引用一致`,
  );
  assert.deepEqual(viewInstanceProblems(state.viewInstances, docIds), [], `${label}：实例不变量`);
  // 投影 = 组状态（实例解析后），不允许自己漂移
  assert.equal(state.panes.primary.docId, activeDocIn(state, PRIMARY), `${label}：primary 投影`);
  assert.equal(state.panes.secondary.docId, activeDocIn(state, SECONDARY), `${label}：secondary 投影`);
  assert.ok(
    visibleGroupIds(state.layoutTree).includes(state.focusedGroupId),
    `${label}：焦点必须是可见组`,
  );
  const json = JSON.stringify(state.layoutTree);
  for (const forbidden of ['doc:', 'docId', 'sessionId', 'viewId', 'buffer']) {
    assert.equal(json.includes(forbidden), false, `${label}：布局树不得包含 ${forbidden}`);
  }
}

/** 让两个组各有一格同一份文档，并给第二格绑一个**不同的** Host View。 */
function twoViewsOfSameDoc(): WorkspaceState {
  let state = open(liveState(), 'a');
  state = split(state);
  const second = instanceFor(state.viewInstances, SECONDARY, 'a');
  assert.ok(second, '前提：分屏后右侧应接管同一份文档');
  return workspaceReducer(state, {
    type: 'REGISTER_VIEW_INSTANCE',
    docId: 'a',
    groupId: SECONDARY,
    viewInstanceId: second.viewInstanceId,
    hostViewId: 'view-a--secondary',
    activate: true,
  });
}

/** 只实现被测动作需要的部分，其余一律抛错（防止悄悄调用未预期的接口）。 */
function fakeClient(input: {
  closeDocument?: (sessionId: string, viewId: string) => Promise<unknown>;
  openDocument?: (path: string, projectId?: string) => Promise<unknown>;
}): WeaveSpaceClient {
  const unexpected = (name: string) => () => {
    throw new Error(`测试不应调用 ${name}`);
  };
  return {
    closeDocument:
      input.closeDocument ??
      (async () => {
        throw new Error('测试不应调用 closeDocument');
      }),
    openDocument:
      input.openDocument ??
      (async () => {
        throw new Error('测试不应调用 openDocument');
      }),
    readDocument: unexpected('readDocument'),
    applyEdit: unexpected('applyEdit'),
    saveDocument: unexpected('saveDocument'),
    readDisk: unexpected('readDisk'),
    reloadDocument: unexpected('reloadDocument'),
    reclaimPageViews: unexpected('reclaimPageViews'),
  } as unknown as WeaveSpaceClient;
}

function actionsOver(initial: WorkspaceState, client: WeaveSpaceClient) {
  let state = initial;
  const actions = createViewInstanceActions({
    getState: () => state,
    getMode: () => 'live',
    dispatch: (action: WorkspaceAction) => {
      state = workspaceReducer(state, action);
    },
    clientFor: () => client,
  });
  return { actions, current: () => state };
}

/* ================================================================== */
/* A. Host 真实契约                                                     */
/* ================================================================== */

test('B3-A01 同一 resource 两次 open：同一 Session、两个 View、共享 dirty 与 revision', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'scene.md', '# 场景\n');
    const first = await h.document.openSession({
      resourceId: 'res-scene',
      path: 'scene.md',
      provider: h.provider,
    });
    const second = await h.document.openSession({
      resourceId: 'res-scene',
      path: 'scene.md',
      provider: h.provider,
    });

    assert.equal(first.sessionId, second.sessionId, '同一资源必须复用同一会话');
    assert.notEqual(first.viewId, second.viewId, '两个视图必须各有身份');
    assert.equal(h.document.getSession(first.sessionId)?.views, 2, 'Host 侧应当有两个视图');

    const edited = h.document.applyEdit(first.sessionId, '# 场景\n改过\n');
    assert.equal(edited.dirty, true);
    assert.equal(edited.revision, 1);
    assert.equal(h.document.getSession(second.sessionId)?.revision, 1, 'revision 只有一份');
    assert.equal(h.document.getBuffer(second.sessionId), '# 场景\n改过\n', '缓冲只有一份');
  } finally {
    await h.cleanup();
  }
});

test('B3-A02 关闭一个视图：另一个继续有效，草稿不丢', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'shot.md', 'a\n');
    const first = await h.document.openSession({
      resourceId: 'res-shot',
      path: 'shot.md',
      provider: h.provider,
    });
    const second = await h.document.openSession({
      resourceId: 'res-shot',
      path: 'shot.md',
      provider: h.provider,
    });
    h.document.applyEdit(first.sessionId, 'b\n');

    const closed = await h.document.closeView(first.viewId);
    assert.equal(closed.closed, true);
    assert.equal(h.document.getSession(second.sessionId)?.views, 1, '只关掉一个视图');
    assert.equal(h.document.getBuffer(second.sessionId), 'b\n', '草稿随会话保留');
  } finally {
    await h.cleanup();
  }
});

test('B3-A03 最后一个脏视图仍被 Host 拒绝关闭（DATA-002）', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'note.md', 'x\n');
    const only = await h.document.openSession({
      resourceId: 'res-note',
      path: 'note.md',
      provider: h.provider,
    });
    h.document.applyEdit(only.sessionId, 'y\n');

    const blocked = await h.document.closeView(only.viewId);
    assert.equal(blocked.closed, false);
    assert.equal(blocked.protectedDirty, true, '最后一个脏视图必须被保护');
    assert.equal(h.document.getBuffer(only.sessionId), 'y\n', '拒绝时内容原样保留');
  } finally {
    await h.cleanup();
  }
});

/* ================================================================== */
/* B. Shell 状态                                                        */
/* ================================================================== */

test('B3-B01 打开文档：一条文档记录 + 一个实例，实例带上 Host View', () => {
  const state = open(liveState(), 'a');
  assert.equal(state.tabs.length, 1, '文档记录只有一条');
  const instances = instancesOf(state, 'a');
  assert.equal(instances.length, 1, '一格 = 一个实例');
  assert.equal(instances[0].groupId, PRIMARY);
  assert.equal(instances[0].hostViewId, 'view-a', '实例必须记住 Host View');
  assert.equal(activeDocIn(state, PRIMARY), 'a');
  assertConsistent(state, '打开后');
});

test('B3-B02 同一文档可以有两个实例，各有自己的 Host View，文档记录仍只有一条', () => {
  const state = twoViewsOfSameDoc();
  const instances = instancesOf(state, 'a');
  assert.equal(instances.length, 2, '两个组各一格');
  assert.deepEqual(
    instances.map((instance) => instance.groupId).sort(),
    [PRIMARY, SECONDARY],
    '两个实例分属两个组',
  );
  const hostViews = instances.map((instance) => instance.hostViewId);
  assert.equal(new Set(hostViews).size, 2, '两个实例绝不能共用一个 Host View');
  assert.equal(state.tabs.length, 1, '文档记录仍然只有一条（共享缓冲与会话）');
  assert.equal(state.tabs[0].buffer, '# a.md\n', '只有一份缓冲');
  assertConsistent(state, '双视图同文档');
});

test('B3-B03 一个实例最多属于一个组：收养不复制、也不从别的组抢', () => {
  let state = split(liveState()); // 空树分屏
  state = open(state, 'a'); // 焦点在 primary
  state = workspaceReducer(state, { type: 'FOCUS_GROUP', groupId: SECONDARY });
  state = workspaceReducer(state, { type: 'SET_PANE_TAB', pane: 'secondary', docId: 'a' });

  const instances = instancesOf(state, 'a');
  assert.equal(instances.length, 2, '第二组需要自己的实例（不是搬走第一组的）');
  assert.deepEqual(
    instances.map((instance) => instance.groupId).sort(),
    [PRIMARY, SECONDARY],
  );
  assert.deepEqual(
    instances.map((instance) => instance.hostViewId),
    ['view-a', null],
    '第二个实例不得复制第一个的 viewId（应为"待绑定"）',
  );
  assertConsistent(state, '跨组同一文档');
});

test('B3-B04 组的活动实例必须属于该组；关闭活动实例后组内自动改选', () => {
  let state = twoViewsOfSameDoc();
  state = open(state, 'b');
  // primary 现在 [a, b]，活动 b
  assert.equal(activeDocIn(state, PRIMARY), 'b');
  const primaryIds = group(state, PRIMARY).viewInstanceIds;
  const bInstance = primaryIds.find((id) => state.viewInstances[id].docId === 'b');
  assert.ok(bInstance);

  const closed = workspaceReducer(state, { type: 'CLOSE_VIEW_INSTANCE', viewInstanceId: bInstance });
  assert.equal(activeDocIn(closed, PRIMARY), 'a', '同组内改选到还剩的那一格');
  assert.equal(activeInstanceIdInGroup(closed.viewGroups, PRIMARY), group(closed, PRIMARY).viewInstanceIds[0]);
  assertConsistent(closed, '关闭活动实例后');
});

test('B3-B05 不会出现悬空 hostViewId：同一 viewId 只能挂一个实例', () => {
  let state = twoViewsOfSameDoc();
  // 试图把第二格的 viewId 再绑一次（指向不存在的实例）——必须被拒绝
  state = workspaceReducer(state, {
    type: 'REGISTER_VIEW_INSTANCE',
    docId: 'a',
    groupId: 'legacy-group:ghost',
    viewInstanceId: 'vi:ghost|a',
    hostViewId: 'view-a--secondary',
    activate: true,
  });
  // 幽灵组不存在 → 实例挂在幽灵组名下但没人引用，hostViewId 冲突必须被降级为 null
  const ghost = instancesOf(state, 'a').find((instance) => instance.groupId === 'legacy-group:ghost');
  assert.ok(ghost, '实例本身可以被登记（组不存在时由调用方负责）');
  assert.equal(ghost.hostViewId, null, '已被占用的 viewId 不得再挂到第二个实例上');
  assert.deepEqual(
    viewInstanceProblems(state.viewInstances, new Set(state.tabs.map((item) => item.docId))),
    [],
    '实例不变量仍成立',
  );
});

/* ================================================================== */
/* C. 编辑与保存                                                        */
/* ================================================================== */

test('B3-C01 编辑只改文档记录：两个实例看到的仍是同一份草稿', () => {
  const state = workspaceReducer(twoViewsOfSameDoc(), {
    type: 'EDIT_DOC',
    docId: 'a',
    text: '# 新草稿\n',
  });
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].buffer, '# 新草稿\n');
  assert.equal(state.tabs[0].dirty, true);
  assert.equal(instancesOf(state, 'a').length, 2, '编辑不得影响视图实例');
  for (const instance of instancesOf(state, 'a')) {
    assert.equal(instance.docId, 'a');
  }
  assertConsistent(state, '编辑后');
});

test('B3-C02 保存结论只落在文档记录上，不新建第二份会话状态', () => {
  const before = twoViewsOfSameDoc();
  const after = workspaceReducer(before, {
    type: 'SAVE_RESULT',
    docId: 'a',
    status: 'COMMITTED',
    errorCode: null,
    dirty: false,
    documentState: 'CLEAN',
    baseVersion: 'sha256:bbb',
    revision: 7,
    notice: '已保存',
  });
  assert.equal(after.tabs.length, 1, '保存不产生第二份记录');
  assert.equal(after.tabs[0].revision, 7);
  assert.equal(after.tabs[0].baseVersion, 'sha256:bbb');
  assert.equal(after.viewInstances, before.viewInstances, '保存不得触碰视图实例');
  assertConsistent(after, '保存后');
});

test('B3-C03 文档级操作取的 Host View 必须属于这份文档', () => {
  const state = twoViewsOfSameDoc();
  const viewId = hostViewIdForDoc(state.viewInstances, 'a');
  assert.ok(viewId);
  assert.ok(
    instancesOf(state, 'a').some((instance) => instance.hostViewId === viewId),
    '选出来的 viewId 必须真的挂在这份文档的实例上',
  );
  assert.equal(hostViewIdForDoc(state.viewInstances, 'missing'), null, '没有实例就没有 viewId');
});

/* ================================================================== */
/* D. 生命周期                                                          */
/* ================================================================== */

test('B3-D01 关闭一格不关闭另一格：Host 只收到一个 close', async () => {
  const state = twoViewsOfSameDoc();
  const calls: string[] = [];
  const client = fakeClient({
    closeDocument: async (_sessionId, viewId) => {
      calls.push(viewId);
      return { status: 'APPLIED' };
    },
  });
  const { actions, current } = actionsOver(state, client);

  const target = instancesOf(state, 'a').find((instance) => instance.groupId === SECONDARY);
  assert.ok(target);
  const outcome = await actions.closeInstance(target.viewInstanceId);
  assert.equal(outcome.status, 'closed');
  assert.deepEqual(calls, ['view-a--secondary'], '只关掉被点的那一格');
  assert.equal(instancesOf(current(), 'a').length, 1, '另一格必须还在');
  assert.equal(instancesOf(current(), 'a')[0].hostViewId, 'view-a');
  assert.equal(current().tabs.length, 1, '文档记录必须保留');
  assertConsistent(current(), '关闭一格后');
});

test('B3-D02 关闭全部干净实例后，文档记录随之清理', async () => {
  const state = twoViewsOfSameDoc();
  const closed: string[] = [];
  const client = fakeClient({
    closeDocument: async (_sessionId, viewId) => {
      closed.push(viewId);
      return { status: 'APPLIED' };
    },
  });
  const { actions, current } = actionsOver(state, client);

  const outcome = await actions.closeDoc('a');
  assert.equal(outcome.status, 'closed');
  assert.equal(outcome.closed, 2, '两个实例都要关掉');
  assert.deepEqual(closed.sort(), ['view-a', 'view-a--secondary']);
  assert.equal(current().tabs.length, 0, '没有视图的文档记录必须清理');
  assert.deepEqual(current().viewInstances, {}, '实例也要清空');
  assert.deepEqual(docsIn(current(), PRIMARY), []);
  assert.deepEqual(docsIn(current(), SECONDARY), []);
});

test('B3-D03 最后一个脏视图被拒绝：Shell 状态一个字段都不许变', async () => {
  let state = open(liveState(), 'a');
  state = workspaceReducer(state, { type: 'EDIT_DOC', docId: 'a', text: '# 草稿\n' });
  const before = state;
  const client = fakeClient({
    closeDocument: async () => ({ status: 'REJECTED', errorCode: 'ERR_DOCUMENT_DIRTY' }),
  });
  const { actions, current } = actionsOver(state, client);

  const only = instancesOf(state, 'a')[0];
  const outcome = await actions.closeInstance(only.viewInstanceId);
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.errorCode, 'ERR_DOCUMENT_DIRTY');
  assert.equal(current(), before, '被拒绝时不得产生任何半更新');
  assert.equal(current().tabs[0].dirty, true, '草稿必须还在');
});

test('B3-D04 部分关闭失败不产生分叉：关掉的那些已摘除，被拒的那格原样保留', async () => {
  const state = twoViewsOfSameDoc();
  const client = fakeClient({
    closeDocument: async (_sessionId, viewId) => {
      if (viewId === 'view-a--secondary') {
        return { status: 'REJECTED', errorCode: 'ERR_DOCUMENT_DIRTY' };
      }
      return { status: 'APPLIED' };
    },
  });
  const { actions, current } = actionsOver(state, client);

  const outcome = await actions.closeDoc('a');
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.closed, 1, '先关掉的那一格要被如实计数');
  const left = instancesOf(current(), 'a');
  assert.equal(left.length, 1, '只剩被拒绝的那一格');
  assert.equal(left[0].hostViewId, 'view-a--secondary');
  assert.equal(current().tabs.length, 1, '文档记录必须保留（它还有视图）');
  assertConsistent(current(), '部分关闭后');
});

/* ================================================================== */
/* E. 异步                                                              */
/* ================================================================== */

test('B3-E01 同一文档向两个组并发打开：两个 Host View、一条会话', async () => {
  const roots = await makeRoots('ws-b3-e01-');
  const host = await startHost(roots, 'multi');
  try {
    const h = makeHarness(host.url, new MemoryStorage());
    await h.bootLive();
    h.dispatch({ type: 'SET_LAYOUT', layout: 'vertical' });

    const release = h.holdNextOpen();
    const started = h.nextOpenStarted();
    const first = h.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a', {
      targetGroupId: PRIMARY,
    });
    await started;
    // 第一格还在途，用户（或恢复流程）已经在右组打开同一份文件
    const second = h.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a', {
      targetGroupId: SECONDARY,
    });
    release();
    await Promise.all([first, second]);

    const docId = 'doc:project-a/a.md';
    assert.equal(h.state.tabs.length, 1, '同一份文档只有一条记录');
    const instances = instancesOfDoc(h.state.viewInstances, docId);
    assert.equal(instances.length, 2, '两个组各一格');
    assert.equal(h.views.length, 2, 'Host 侧应当真的有两个 View');
    assert.equal(
      new Set(instances.map((instance) => instance.hostViewId)).size,
      2,
      '两个实例不得共用同一个 Host View',
    );
    assert.deepEqual(
      viewInstanceProblems(h.state.viewInstances, new Set(h.state.tabs.map((item) => item.docId))),
      [],
    );
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

test('B3-E02 同一组重复打开仍然合并：只建一个 View、一个实例', async () => {
  const roots = await makeRoots('ws-b3-e02-');
  const host = await startHost(roots, 'multi');
  try {
    const h = makeHarness(host.url, new MemoryStorage());
    await h.bootLive();
    await Promise.all([
      h.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a'),
      h.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a'),
    ]);
    assert.equal(h.views.length, 1, '同一组内的并发打开必须合并');
    assert.equal(instancesOfDoc(h.state.viewInstances, 'doc:project-a/a.md').length, 1);
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

test('B3-E03 用户在请求期间切组：迟到响应落回发起组，且不抢显示', async () => {
  const roots = await makeRoots('ws-b3-e03-');
  const host = await startHost(roots, 'multi');
  try {
    const h = makeHarness(host.url, new MemoryStorage());
    await h.bootLive();
    await h.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    h.dispatch({ type: 'SET_LAYOUT', layout: 'vertical' });
    h.dispatch({ type: 'FOCUS_GROUP', groupId: SECONDARY });
    const activeBefore = activeInstanceIdInGroup(h.state.viewGroups, SECONDARY);

    const release = h.holdNextOpen();
    const started = h.nextOpenStarted();
    const pending = h.opener.openNode(nodeOf('docs/notes.md', 'project-a'), 'project-a', {
      targetGroupId: SECONDARY,
    });
    await started;
    h.dispatch({ type: 'FOCUS_GROUP', groupId: PRIMARY });
    release();
    await pending;

    // 迟到的那一格仍在发起组里、且**不是**活动实例：显示没有被抢走
    assert.equal(
      activeInstanceIdInGroup(h.state.viewGroups, SECONDARY),
      activeBefore,
      '迟到响应不得改写发起组的活动实例',
    );
    const late = instancesOfDoc(h.state.viewInstances, 'doc:project-a/docs/notes.md');
    assert.equal(late.length, 1, '迟到响应的 Host View 必须被记录（不能留孤儿）');
    assert.equal(late[0].groupId, SECONDARY, '记录在发起时那一组');
    assert.notEqual(
      activeInstanceIdInGroup(h.state.viewGroups, SECONDARY),
      late[0].viewInstanceId,
      '它不能成为任何组的活动视图',
    );
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

test('B3-E04 用户编辑期间第二个视图返回旧内容：不得覆盖草稿', async () => {
  let state = open(liveState(), 'a');
  state = workspaceReducer(state, { type: 'EDIT_DOC', docId: 'a', text: '# 正在写\n' });
  const dirtyBefore = state.tabs[0];

  const client = fakeClient({
    openDocument: async () => ({
      status: 'APPLIED',
      document: {
        sessionId: 'session-a',
        viewId: 'view-a--stale',
        resourceId: 'a',
        path: 'a.md',
        content: '# 旧内容\n',
        baseVersion: 'sha256:old',
        revision: 0,
        dirty: false,
        documentState: 'CLEAN',
      },
    }),
  });
  const { actions, current } = actionsOver(state, client);

  const outcome = await actions.openInGroup('a', SECONDARY);
  assert.equal(outcome.status, 'created', '视图本身要建起来');
  assert.equal(current().tabs[0].buffer, dirtyBefore.buffer, '草稿绝不能被旧响应覆盖');
  assert.equal(current().tabs[0].dirty, true, 'dirty 也不得被重置');
  assert.equal(current().tabs[0].baseVersion, dirtyBefore.baseVersion, '基线不得回退');
  assert.equal(instancesOf(current(), 'a').length, 2, '第二格仍然建立');
  assert.equal(
    instancesOf(current(), 'a').find((instance) => instance.groupId === SECONDARY)?.hostViewId,
    'view-a--stale',
    '新视图身份必须记录下来',
  );
});

/* ================================================================== */
/* F. 恢复                                                              */
/* ================================================================== */

test('B3-F01 V1 单视图恢复：一条记录一个实例，休眠的 secondary 也从记录里回来', async () => {
  const roots = await makeRoots('ws-b3-f01-');
  const host = await startHost(roots, 'multi');
  try {
    const storage = new MemoryStorage();
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    await first.opener.openNode(nodeOf('docs/notes.md', 'project-a'), 'project-a');
    first.dispatch({ type: 'SET_LAYOUT', layout: 'vertical' });
    // 右格指向另一份文档，然后合并 → 快照里 layout=single、secondary.tabIndex 仍非空
    first.dispatch({
      type: 'SET_PANE_TAB',
      pane: 'secondary',
      docId: 'doc:project-a/a.md',
    });
    first.dispatch({ type: 'SET_LAYOUT', layout: 'single' });
    const snapshot = first.saveSnapshot();
    assert.equal(snapshot.ui.layout, 'single');
    assert.notEqual(snapshot.panes.secondary.tabIndex, null, '前提：单视图快照仍记着右格');

    const second = makeHarness(host.url, storage);
    const report = await second.restore();
    assert.equal(report.status, 'restored');
    assert.equal(second.state.layout, 'single', '布局按记录恢复为单视图');
    assert.equal(second.state.tabs.length, 2);
    assert.deepEqual(
      docsIn(second.state, SECONDARY),
      ['doc:project-a/a.md'],
      '休眠组必须从 V1 的 secondary 记录恢复（B2-R2）',
    );
    assert.equal(second.state.panes.secondary.docId, 'doc:project-a/a.md');
    assert.deepEqual(
      visibleGroupIds(second.state.layoutTree),
      [PRIMARY],
      '休眠组不可见',
    );
    for (const item of second.state.tabs) {
      assert.equal(instancesOfDoc(second.state.viewInstances, item.docId).length, 1);
    }
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

test('B3-F02 V1 双视图恢复（不同文档）：两格各有自己的 Host View', async () => {
  const roots = await makeRoots('ws-b3-f02-');
  const host = await startHost(roots, 'multi');
  try {
    const storage = new MemoryStorage();
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    await first.opener.openNode(nodeOf('docs/notes.md', 'project-a'), 'project-a');
    first.dispatch({ type: 'SET_LAYOUT', layout: 'vertical' });
    first.dispatch({ type: 'SET_PANE_TAB', pane: 'primary', docId: 'doc:project-a/a.md' });
    first.dispatch({
      type: 'SET_PANE_TAB',
      pane: 'secondary',
      docId: 'doc:project-a/docs/notes.md',
      mode: 'editor',
    });
    first.saveSnapshot();

    const second = makeHarness(host.url, storage);
    await second.restore();
    assert.equal(second.state.layout, 'vertical');
    assert.equal(activeDocIn(second.state, PRIMARY), 'doc:project-a/a.md');
    assert.equal(activeDocIn(second.state, SECONDARY), 'doc:project-a/docs/notes.md');
    assert.equal(group(second.state, SECONDARY).mode, 'editor', '记录里的模式要生效');
    const hostViews = Object.values(second.state.viewInstances)
      .map((instance) => instance.hostViewId)
      .filter((viewId): viewId is string => typeof viewId === 'string');
    assert.equal(new Set(hostViews).size, hostViews.length, '恢复出来的视图不得共用 Host View');
    assert.equal(
      viewInstanceProblems(second.state.viewInstances, new Set(second.state.tabs.map((t) => t.docId))).length,
      0,
    );
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

test('B3-F03 两个 Pane 指向同一 docId：两个不同 Host View、一个 DocumentSession', async () => {
  const roots = await makeRoots('ws-b3-f03-');
  const host = await startHost(roots, 'multi');
  try {
    const storage = new MemoryStorage();
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    // 分屏：两格都看同一份文档（旧版 anchor 行为），然后存快照
    first.dispatch({ type: 'SET_LAYOUT', layout: 'vertical' });
    assert.equal(
      first.state.panes.primary.docId,
      first.state.panes.secondary.docId,
      '前提：两格指向同一份文档',
    );
    first.saveSnapshot();

    const second = makeHarness(host.url, storage);
    await second.restore();
    const docId = 'doc:project-a/a.md';
    assert.equal(second.state.tabs.length, 1, '仍然只有一条文档记录（一个会话）');
    const instances = instancesOfDoc(second.state.viewInstances, docId);
    assert.equal(instances.length, 2, '两个 Pane 必须各有实例');
    assert.deepEqual(
      instances.map((instance) => instance.groupId).sort(),
      [PRIMARY, SECONDARY],
    );
    const hostViews = instances.map((instance) => instance.hostViewId);
    assert.ok(hostViews.every((viewId) => typeof viewId === 'string' && viewId !== ''), '两格都必须有 Host View');
    assert.notEqual(hostViews[0], hostViews[1], '不允许复用同一个 viewId');
    // 两个 View 都是服务端认可的有效视图
    for (const viewId of hostViews) {
      const read = await second.inner.readDocument(second.state.tabs[0].sessionId as string, viewId);
      assert.equal(read.status, 'APPLIED', `恢复出来的 View 必须有效：${viewId}`);
    }
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

/* ================================================================== */
/* G. 回归                                                              */
/* ================================================================== */

test('B3-G01 布局树仍然合法且不含任何文档身份', () => {
  let state = twoViewsOfSameDoc();
  state = open(state, 'b');
  state = workspaceReducer(state, { type: 'SET_SPLIT_RATIO', ratio: 42 });
  assert.equal(validateLayoutTree(state.layoutTree), null);
  assertConsistent(state, '连续操作后');
});

test('B3-G02 连续迁移：组、实例、文档三者始终自洽', () => {
  const log: string[] = [];
  let state = liveState();
  const step = (label: string, action: WorkspaceAction): void => {
    state = workspaceReducer(state, action);
    log.push(label);
    assertConsistent(state, `连续迁移 @ ${log.join(' → ')}`);
  };

  step('打开 a', { type: 'OPEN_TAB', tab: tab({ docId: 'a', path: 'a.md' }) });
  step('打开 b', { type: 'OPEN_TAB', tab: tab({ docId: 'b', path: 'b.md' }) });
  step('分屏', { type: 'SET_LAYOUT', layout: 'vertical' });
  step('焦点右组', { type: 'FOCUS_GROUP', groupId: SECONDARY });
  step('右组切到 b', { type: 'SET_PANE_TAB', pane: 'secondary', docId: 'b' });
  step('右组切到 a', { type: 'SET_PANE_TAB', pane: 'secondary', docId: 'a' });
  step('关闭 b', { type: 'CLOSE_TAB', docId: 'b' });
  step('合并', { type: 'SET_LAYOUT', layout: 'single' });
  step('再分屏', { type: 'SET_LAYOUT', layout: 'vertical' });
  step('切模式', { type: 'SET_MODE', mode: 'demo' });

  assert.deepEqual(state.tabs, []);
  assert.deepEqual(state.viewInstances, {}, '切模式必须清空实例（旧 Host View 身份不得残留）');
});

test('B3-G03 移除项目只影响该项目的实例，其他项目的视图原样保留', () => {
  let state = liveState();
  state = workspaceReducer(state, { type: 'SET_WORKSPACE_MODE', workspaceMode: 'multi' });
  state = workspaceReducer(state, {
    type: 'SET_PROJECTS',
    projects: [
      { projectId: 'project-a', name: 'A', status: 'READY' },
      { projectId: 'project-b', name: 'B', status: 'READY' },
    ],
  });
  state = workspaceReducer(state, {
    type: 'OPEN_TAB',
    tab: tab({ docId: 'doc:project-a/a.md', path: 'a.md', projectId: 'project-a' }),
  });
  state = split(state);
  state = workspaceReducer(state, { type: 'FOCUS_GROUP', groupId: SECONDARY });
  state = workspaceReducer(state, {
    type: 'OPEN_TAB',
    tab: tab({ docId: 'doc:project-b/b.md', path: 'b.md', projectId: 'project-b' }),
  });
  const bBefore = instancesOf(state, 'doc:project-b/b.md');

  const removed = workspaceReducer(state, { type: 'PROJECT_REMOVED', projectId: 'project-a' });
  assert.deepEqual(removed.tabs.map((item) => item.docId), ['doc:project-b/b.md']);
  /*
   * B 原来那一格必须**原样**保留（身份与 Host View 都不变）。
   * 左组因为这次移除空掉了，会按旧版行为接管 B——那是**新增**的一格，
   * 不是把原来那一格搬过去，因此这里按身份比对而不是整表比对。
   */
  for (const instance of bBefore) {
    assert.deepEqual(
      instancesOf(removed, 'doc:project-b/b.md').find(
        (item) => item.viewInstanceId === instance.viewInstanceId,
      ),
      instance,
      'B 原有实例必须原样保留',
    );
  }
  assert.ok(
    instancesOf(removed, 'doc:project-b/b.md').length >= bBefore.length,
    '不允许因为移除别的项目而丢掉 B 的实例',
  );
  assert.deepEqual(instancesOf(removed, 'doc:project-a/a.md'), [], 'A 的实例必须清空');
  assert.equal(removed.layout, 'vertical', '布局结构不受影响');
  assertConsistent(removed, '移除项目后');
});

test('B3-G04 遗留 View 回收必须保留**全部**实例的 Host View', async () => {
  const roots = await makeRoots('ws-b3-g04-');
  const host = await startHost(roots, 'multi');
  // Node 里没有 sessionStorage：不注入页面身份，Host 会整批拒绝"回收"（等于没测到）
  setPageInstanceForTest('page-b3-g04');
  try {
    const h = makeHarness(host.url, new MemoryStorage());
    await h.bootLive();
    await h.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    h.dispatch({ type: 'SET_LAYOUT', layout: 'vertical' });

    // 分屏时右侧拿到的是"待绑定"实例（hostViewId 为 null）→ 真开一个
    const pending = instanceFor(h.state.viewInstances, SECONDARY, 'doc:project-a/a.md');
    assert.ok(pending);
    assert.equal(pending.hostViewId, null, '前提：分屏接管的第二格还没有自己的 View');
    const opened = await h.viewActions.openInGroup('doc:project-a/a.md', SECONDARY);
    assert.equal(opened.status, 'created', '需要时补一个真正属于第二格的 Host View');
    const before = instancesOfDoc(h.state.viewInstances, 'doc:project-a/a.md');
    assert.equal(before.length, 2, '补 View 不新增实例');
    const sessionId = h.state.tabs[0].sessionId as string;
    const hostViews = before
      .map((instance) => instance.hostViewId)
      .filter((viewId): viewId is string => typeof viewId === 'string');
    assert.equal(hostViews.length, 2, '两格各有一个 Host View');

    /*
     * 对**同一路径**回收"本页上一轮遗留的 View"：这正是危险的一种调用——
     * keep 列表如果只按"每条文档一个 viewId"算（B2 的行为），第二格会被顺手关掉，
     * 而 Shell 里那一格还在，于是两边分叉：界面显示着，Host 已经没有了。
     */
    const summary = await h.opener.reclaimStaleViews([{ projectId: 'project-a', path: 'a.md' }]);
    assert.equal(summary.failed, 0, '回收请求本身必须成功（否则这条用例什么也没证明）');
    assert.equal(summary.closed, 0, '两个 View 都在被使用，一个都不能关');

    for (const viewId of hostViews) {
      const read = await h.inner.readDocument(sessionId, viewId);
      assert.equal(read.status, 'APPLIED', `实例的 View 必须仍然有效：${viewId}`);
    }
    assert.equal(
      instancesOfDoc(h.state.viewInstances, 'doc:project-a/a.md').length,
      2,
      '回收不得改动现有实例',
    );
  } finally {
    setPageInstanceForTest(null);
    resetPageInstanceCache();
    await host.close();
    await roots.cleanup();
  }
});
