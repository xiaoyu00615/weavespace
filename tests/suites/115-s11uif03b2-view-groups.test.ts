/**
 * UI-F03-B2：ViewGroup 运行时状态与旧 Pane 兼容桥（先红后绿）。
 *
 * 这一组钉的是"结构归结构、内容归内容"这条边界真的立起来了：
 *
 * - `LayoutTree` 决定**哪些组在什么位置**，`PaneNode.groupId` 是组的身份；
 * - 组自己管组内标签集合、当前活动文档与展示模式；
 * - `tabs` 仍然是文档本体的唯一副本（缓冲 / 会话 / 版本），组里只存 `docId` 引用；
 * - `panes` / `focusedPane` 退化成**投影**，由组状态反算，不再是第二个真相来源。
 *
 * 三处最容易写错、也最容易被"看起来对"掩盖的地方：
 *
 * 1. 打开文档时的归属是**焦点组**，不是 primary——分屏后把文档塞进左边、用户却在
 *    看右边，是最典型的错位；
 * 2. 关闭 / 移除项目要清理**所有组**的引用，只清当前组会留下悬空引用；
 * 3. 休眠组（单视图时的 secondary）保留状态但**不能获得焦点**，否则下一次打开
 *    的文档会落进一个看不见的窗格。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listPanes, validateLayoutTree } from '../../apps/shell/src/state/layout-tree.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import {
  activeDocIdInGroup,
  docIdsInGroup,
  viewGroupProblems,
  visibleGroupIds,
} from '../../apps/shell/src/state/workspace-view-groups.ts';
import { viewInstanceProblems } from '../../apps/shell/src/state/workspace-view-instances.ts';
import type { DocTab, WorkspaceState } from '../../apps/shell/src/state/types.ts';
import {
  MemoryStorage,
  makeHarness,
  makeRoots,
  nodeOf,
  startHost,
  waitFor,
} from '../helpers/s11c-harness.ts';

const PRIMARY = 'legacy-group:primary';
const SECONDARY = 'legacy-group:secondary';
const PRIMARY_PANE = 'legacy-pane:primary';
const SECONDARY_PANE = 'legacy-pane:secondary';

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

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

const open = (state: WorkspaceState, docId: string, path = `${docId}.md`): WorkspaceState =>
  workspaceReducer(state, { type: 'OPEN_TAB', tab: tab({ docId, path }) });

const openBackground = (state: WorkspaceState, docId: string): WorkspaceState =>
  workspaceReducer(state, {
    type: 'OPEN_TAB_BACKGROUND',
    tab: tab({ docId, path: `${docId}.md` }),
  });

const split = (state: WorkspaceState): WorkspaceState =>
  workspaceReducer(state, { type: 'SET_LAYOUT', layout: 'vertical' });

const unsplit = (state: WorkspaceState): WorkspaceState =>
  workspaceReducer(state, { type: 'SET_LAYOUT', layout: 'single' });

const group = (state: WorkspaceState, groupId: string) => state.viewGroups[groupId];

/**
 * 组内的文档（按组内顺序）。
 *
 * B3 起组里存的是**视图实例**身份（同一份文档可以在两个组里各有一格），
 * 因此断言"组里有哪些文档"必须经过实例表解析，不能直接读组字段。
 */
const docsIn = (state: WorkspaceState, groupId: string): readonly string[] =>
  docIdsInGroup(state.viewGroups, state.viewInstances, groupId);

/** 组的活动文档（同样经过实例解析）。 */
const activeDocIn = (state: WorkspaceState, groupId: string): string | null =>
  activeDocIdInGroup(state.viewGroups, state.viewInstances, groupId);

/** 三个标签都开在 primary，并进入分屏（secondary 也指向 a）。 */
function splitWithThreeTabs(): WorkspaceState {
  let state = liveState();
  state = open(state, 'a');
  state = open(state, 'b');
  state = open(state, 'c');
  return split(state);
}

/**
 * 每次操作后都要成立的一组事实：组不变量、投影一致、焦点合法、结构不带文档身份。
 */
function assertConsistent(state: WorkspaceState, label: string): void {
  const docIds = new Set(state.tabs.map((item) => item.docId));
  assert.deepEqual(
    viewGroupProblems(state.viewGroups, state.viewInstances, docIds),
    [],
    `${label}：组与实例的引用一致`,
  );
  assert.deepEqual(viewInstanceProblems(state.viewInstances, docIds), [], `${label}：实例不变量`);

  const primary = state.viewGroups[PRIMARY];
  const secondary = state.viewGroups[SECONDARY];
  assert.ok(primary, `${label}：primary 组必须一直存在`);
  assert.ok(secondary, `${label}：secondary 组必须一直存在（休眠也要保留）`);

  // 投影 = 组状态，不允许任何一处自己漂移
  assert.equal(state.panes.primary.docId, activeDocIn(state, PRIMARY), `${label}：primary 投影的文档`);
  assert.equal(state.panes.primary.mode, primary.mode, `${label}：primary 投影的模式`);
  assert.equal(state.panes.secondary.docId, activeDocIn(state, SECONDARY), `${label}：secondary 投影的文档`);
  assert.equal(state.panes.secondary.mode, secondary.mode, `${label}：secondary 投影的模式`);

  const visible = visibleGroupIds(state.layoutTree);
  assert.ok(visible.includes(state.focusedGroupId), `${label}：焦点必须是可见组`);
  assert.equal(
    state.focusedPane,
    state.focusedGroupId === SECONDARY ? 'secondary' : 'primary',
    `${label}：焦点投影`,
  );

  // 可见组都必须有对应的组状态（结构不能指向一个不存在的组）
  for (const groupId of visible) {
    assert.ok(state.viewGroups[groupId], `${label}：可见组 ${groupId} 必须有状态`);
  }

  const json = JSON.stringify(state.layoutTree);
  for (const forbidden of ['doc:', 'docId', 'sessionId', 'viewId', 'buffer']) {
    assert.equal(json.includes(forbidden), false, `${label}：布局树不得包含 ${forbidden}`);
  }
}

/* ================================================================== */
/* A. 初始化与身份                                                     */
/* ================================================================== */

test('B2-A01 初始状态：两个组都存在，primary 可见、secondary 休眠', () => {
  const state = liveState();
  assert.deepEqual(Object.keys(state.viewGroups).sort(), [PRIMARY, SECONDARY], '两个保留组必须都在');
  assert.equal(state.viewGroups[PRIMARY].groupId, PRIMARY);
  assert.equal(state.viewGroups[SECONDARY].groupId, SECONDARY);
  assert.notEqual(PRIMARY, SECONDARY, '组身份必须唯一');

  assert.equal(state.viewGroups[PRIMARY].mode, 'editor', 'primary 默认源码');
  assert.equal(state.viewGroups[SECONDARY].mode, 'preview', 'secondary 默认预览');
  assert.deepEqual(docsIn(state, PRIMARY), [], '初始没有标签');
  assert.equal(activeDocIn(state, PRIMARY), null);

  assert.deepEqual(visibleGroupIds(state.layoutTree), [PRIMARY], '单视图只有 primary 可见');
  assert.equal(state.focusedGroupId, PRIMARY, '初始焦点在 primary');
  assertConsistent(state, '初始状态');
});

test('B2-A02 休眠组可以保留：合并后 secondary 仍在，标签与模式不丢', () => {
  let state = splitWithThreeTabs(); // primary [a,b,c] 活动 c；secondary 分屏时接管 c
  state = workspaceReducer(state, { type: 'SET_PANE_TAB', pane: 'secondary', docId: 'b' });
  state = workspaceReducer(state, { type: 'SET_PANE_MODE', pane: 'secondary', mode: 'editor' });
  const before = group(state, SECONDARY);

  const merged = unsplit(state);
  assert.deepEqual(visibleGroupIds(merged.layoutTree), [PRIMARY], '单视图只剩 primary 可见');
  assert.equal(merged.viewGroups[SECONDARY], before, '休眠组必须原样保留（同一引用）');
  assert.deepEqual(docsIn(merged, SECONDARY), ['c', 'b'], '组内实例保留');
  assert.equal(activeDocIn(merged, SECONDARY), 'b', '活动文档保留');
  assert.equal(merged.viewGroups[SECONDARY].mode, 'editor', '模式保留');
  assertConsistent(merged, '合并后');
});

test('B2-A03 焦点必须落在可见组：合并时焦点在 secondary 会被收敛回 primary', () => {
  let state = splitWithThreeTabs();
  state = workspaceReducer(state, { type: 'FOCUS_GROUP', groupId: SECONDARY });
  assert.equal(state.focusedGroupId, SECONDARY);
  assert.equal(state.focusedPane, 'secondary');

  const merged = unsplit(state);
  assert.equal(merged.focusedGroupId, PRIMARY, 'secondary 休眠后不能再持有焦点');
  assert.equal(merged.focusedPane, 'primary');
  assertConsistent(merged, '合并收敛焦点后');
});

/* ================================================================== */
/* B. 标签管理                                                         */
/* ================================================================== */

test('B2-B01 OPEN_TAB 归属焦点组：分屏后打开落在右组，左组不动', () => {
  let state = splitWithThreeTabs();
  state = workspaceReducer(state, { type: 'FOCUS_GROUP', groupId: SECONDARY });
  const primaryBefore = group(state, PRIMARY);

  const opened = open(state, 'd');
  assert.equal(activeDocIn(opened, SECONDARY), 'd', '新文档进入焦点组');
  assert.deepEqual(docsIn(opened, SECONDARY), ['c', 'd'], '焦点组引用被建立');
  assert.equal(group(opened, PRIMARY), primaryBefore, '非焦点组必须保持同一引用');
  assert.equal(activeDocIn(opened, PRIMARY), 'c', '非焦点组的活动文档不变');
  assertConsistent(opened, '焦点在右组时打开');
});

test('B2-B02 OPEN_TAB 在单视图下归属 primary（焦点组就是 primary）', () => {
  let state = open(liveState(), 'a');
  state = workspaceReducer(state, { type: 'FOCUS_PANE', pane: 'secondary' });
  // 单视图下 secondary 休眠：这次聚焦必须被忽略
  assert.equal(state.focusedGroupId, PRIMARY);

  const opened = open(state, 'b');
  assert.deepEqual(docsIn(opened, PRIMARY), ['a', 'b']);
  assert.deepEqual(docsIn(opened, SECONDARY), [], '休眠组不得被自动塞入标签');
  assertConsistent(opened, '单视图打开');
});

test('B2-B03 OPEN_TAB_BACKGROUND 只登记标签，不分配活动组也不抢焦点', () => {
  const state = splitWithThreeTabs();
  const groupsBefore = state.viewGroups;
  const panesBefore = state.panes;

  const background = openBackground(state, 'bg');
  assert.deepEqual(background.tabs.map((item) => item.docId), ['a', 'b', 'c', 'bg']);
  assert.equal(background.viewGroups, groupsBefore, '后台登记不得改任何组（同一引用）');
  assert.deepEqual(background.panes, panesBefore, '投影也不得变化');
  assert.equal(background.focusedGroupId, state.focusedGroupId);
  assertConsistent(background, '后台登记后');
});

test('B2-B04 ACTIVATE_TAB 只改目标组，其他组活动文档不受影响', () => {
  let state = splitWithThreeTabs(); // primary 活动 c；secondary 分屏时也接管 c
  state = workspaceReducer(state, { type: 'SET_PANE_TAB', pane: 'secondary', docId: 'a' });
  state = workspaceReducer(state, { type: 'FOCUS_GROUP', groupId: PRIMARY });
  const secondaryBefore = group(state, SECONDARY);

  const activated = workspaceReducer(state, { type: 'ACTIVATE_TAB', docId: 'a' });
  assert.equal(activeDocIn(activated, PRIMARY), 'a', '焦点组切到 a');
  assert.equal(group(activated, SECONDARY), secondaryBefore, '右组必须保持同一引用');
  assert.equal(activeDocIn(activated, SECONDARY), 'a', '右组本来就看着 a，不因此改变');
  assertConsistent(activated, '激活后');

  // 焦点在右侧时激活 b：只改右侧
  let other = workspaceReducer(activated, { type: 'FOCUS_GROUP', groupId: SECONDARY });
  const primaryBefore = group(other, PRIMARY);
  other = workspaceReducer(other, { type: 'ACTIVATE_TAB', docId: 'b' });
  assert.equal(activeDocIn(other, SECONDARY), 'b');
  assert.deepEqual(docsIn(other, SECONDARY), ['c', 'a', 'b'], '激活会建立组内引用');
  assert.equal(group(other, PRIMARY), primaryBefore, '左组保持不变');
  assertConsistent(other, '在右组激活后');
});

test('B2-B05 同一 docId 可以被两个组引用，但文档本体只有一份', () => {
  let state = splitWithThreeTabs();
  state = workspaceReducer(state, { type: 'SET_PANE_TAB', pane: 'primary', docId: 'b' });
  const tabsBefore = state.tabs;
  state = workspaceReducer(state, { type: 'SET_PANE_TAB', pane: 'secondary', docId: 'b' });

  assert.ok(docsIn(state, PRIMARY).includes('b'));
  assert.ok(docsIn(state, SECONDARY).includes('b'), '两个组可以同时引用同一文档');
  assert.equal(state.tabs, tabsBefore, '不得为第二个引用复制 DocTab');
  assert.equal(state.tabs.filter((item) => item.docId === 'b').length, 1, '全局只有一份');
  assertConsistent(state, '双组共享文档');
});

test('B2-B06 CLOSE_TAB 清理所有组的引用，并按组内顺序选替代项', () => {
  let state = splitWithThreeTabs(); // primary [a,b,c] 活动 c；secondary [a] 活动 a
  state = workspaceReducer(state, { type: 'SET_PANE_TAB', pane: 'primary', docId: 'b' });
  state = workspaceReducer(state, { type: 'SET_PANE_TAB', pane: 'secondary', docId: 'b' });

  const closed = workspaceReducer(state, { type: 'CLOSE_TAB', docId: 'b' });
  assert.equal(
    closed.tabs.some((item) => item.docId === 'b'),
    false,
    '全局标签被移除',
  );
  for (const groupState of Object.values(closed.viewGroups)) {
    assert.equal(
      docsIn(closed, groupState.groupId).includes('b'),
      false,
      `${groupState.groupId} 不得残留已关闭文档的引用`,
    );
  }
  // 左组：b 是中间项，右邻 c 顶上来
  assert.equal(activeDocIn(closed, PRIMARY), 'c', '按组内顺序取右邻');
  assert.equal(activeDocIn(closed, SECONDARY), 'c', '右组同样取右邻');
  assertConsistent(closed, '关闭标签后');
});

test('B2-B07 关闭组内最后一个引用时，右邻优先、其次左邻、都没有才留空', () => {
  // primary 只有 a（活动），另有 c 在别的组：用来验证"不跨组乱接管"
  let state = liveState();
  state = open(state, 'a');
  state = openBackground(state, 'c');
  state = workspaceReducer(state, { type: 'SET_PANE_TAB', pane: 'primary', docId: 'a' });

  const closed = workspaceReducer(state, { type: 'CLOSE_TAB', docId: 'a' });
  assert.equal(closed.tabs.length, 1);
  // 组内引用被清空后，沿用旧版"接管还开着的第一个标签"的行为（不留下空白窗格）
  assert.equal(activeDocIn(closed, PRIMARY), 'c');
  assert.deepEqual(docsIn(closed, PRIMARY), ['c']);
  assertConsistent(closed, '关闭唯一引用后');
});

/* ================================================================== */
/* C. 焦点管理                                                         */
/* ================================================================== */

test('B2-C01 FOCUS_PANE 映射到组身份', () => {
  const state = splitWithThreeTabs();
  const focused = workspaceReducer(state, { type: 'FOCUS_PANE', pane: 'secondary' });
  assert.equal(focused.focusedGroupId, SECONDARY, 'secondary 窗格 = secondary 组');
  assert.equal(focused.focusedPane, 'secondary');
  const back = workspaceReducer(focused, { type: 'FOCUS_PANE', pane: 'primary' });
  assert.equal(back.focusedGroupId, PRIMARY);
  assertConsistent(back, 'FOCUS_PANE');
});

test('B2-C02 FOCUS_GROUP 是通用焦点接口，不存在的组被忽略', () => {
  const state = splitWithThreeTabs();
  const focused = workspaceReducer(state, { type: 'FOCUS_GROUP', groupId: SECONDARY });
  assert.equal(focused.focusedGroupId, SECONDARY);

  const unknown = workspaceReducer(focused, { type: 'FOCUS_GROUP', groupId: 'group:ghost' });
  assert.equal(unknown, focused, '不存在的组不得获得焦点（整条动作被忽略）');
  assertConsistent(unknown, 'FOCUS_GROUP 未知组');
});

test('B2-C03 休眠组不能获得焦点（单视图下的 secondary）', () => {
  const state = open(liveState(), 'a');
  assert.deepEqual(visibleGroupIds(state.layoutTree), [PRIMARY]);

  const viaGroup = workspaceReducer(state, { type: 'FOCUS_GROUP', groupId: SECONDARY });
  assert.equal(viaGroup, state, 'FOCUS_GROUP 对休眠组必须无效');

  const viaPane = workspaceReducer(state, { type: 'FOCUS_PANE', pane: 'secondary' });
  assert.equal(viaPane, state, 'FOCUS_PANE 对休眠窗格必须无效');
  assert.equal(viaPane.focusedPane, 'primary');
});

test('B2-C04 切组不改变任何组的活动文档', () => {
  let state = splitWithThreeTabs();
  state = workspaceReducer(state, { type: 'SET_PANE_TAB', pane: 'secondary', docId: 'a' });
  const before = state.viewGroups;
  const switched = workspaceReducer(state, { type: 'FOCUS_GROUP', groupId: SECONDARY });
  assert.equal(switched.viewGroups, before, '切焦点不得触碰组状态');
  assert.equal(activeDocIn(switched, PRIMARY), 'c');
  assert.equal(activeDocIn(switched, SECONDARY), 'a');
  assertConsistent(switched, '切组后');
});

/* ================================================================== */
/* D. 模式管理                                                         */
/* ================================================================== */

test('B2-D01 SET_PANE_MODE 只改对应组，两组模式互相独立', () => {
  let state = splitWithThreeTabs();
  state = workspaceReducer(state, { type: 'SET_PANE_MODE', pane: 'secondary', mode: 'editor' });
  assert.equal(group(state, SECONDARY).mode, 'editor');
  assert.equal(group(state, PRIMARY).mode, 'editor', 'primary 本来就是 editor');
  assert.equal(state.panes.secondary.mode, 'editor', '投影同步');

  state = workspaceReducer(state, { type: 'SET_PANE_MODE', pane: 'primary', mode: 'preview' });
  assert.equal(group(state, PRIMARY).mode, 'preview');
  assert.equal(group(state, SECONDARY).mode, 'editor', '改 primary 不影响 secondary');
  assertConsistent(state, '模式独立');
});

test('B2-D02 重新分屏恢复 secondary 组的原有模式', () => {
  let state = splitWithThreeTabs();
  state = workspaceReducer(state, { type: 'SET_PANE_MODE', pane: 'secondary', mode: 'editor' });
  state = unsplit(state);
  assert.equal(group(state, SECONDARY).mode, 'editor', '休眠期间模式保留');

  const again = split(state);
  assert.equal(group(again, SECONDARY).mode, 'editor', '重新分屏必须沿用休眠组的模式');
  assert.equal(again.panes.secondary.mode, 'editor');
  assertConsistent(again, '重新分屏后');
});

test('B2-D03 SET_MODE 清空文档引用、保留组身份、模式复位', () => {
  let state = splitWithThreeTabs();
  state = workspaceReducer(state, { type: 'SET_PANE_MODE', pane: 'secondary', mode: 'editor' });
  state = workspaceReducer(state, { type: 'SET_MODE', mode: 'demo' });

  assert.deepEqual(Object.keys(state.viewGroups).sort(), [PRIMARY, SECONDARY], '组身份必须保留');
  for (const groupState of Object.values(state.viewGroups)) {
    assert.deepEqual(docsIn(state, groupState.groupId), [], `${groupState.groupId} 不得残留旧工作区的引用`);
    assert.equal(groupState.activeViewInstanceId, null);
  }
  assert.equal(state.viewGroups[PRIMARY].mode, 'editor', '模式复位到默认');
  assert.equal(state.viewGroups[SECONDARY].mode, 'preview');
  assert.equal(state.focusedGroupId, PRIMARY);
  assert.equal(state.tabs.length, 0, '标签也随工作区清空');
  assertConsistent(state, '切模式后');
});

/* ================================================================== */
/* E. 关闭与项目移除                                                   */
/* ================================================================== */

test('B2-E01 移除项目：只摘该项目的引用，其他组与草稿原样保留', () => {
  let state = workspaceReducer(INITIAL_STATE, { type: 'SET_MODE', mode: 'live' });
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
    tab: tab({ docId: 'doc:project-a/a.md', path: 'a.md', projectId: 'project-a', dirty: true }),
  });
  state = split(state);
  state = workspaceReducer(state, { type: 'FOCUS_GROUP', groupId: SECONDARY });
  state = workspaceReducer(state, {
    type: 'OPEN_TAB',
    tab: tab({ docId: 'doc:project-b/b.md', path: 'b.md', projectId: 'project-b', dirty: true }),
  });
  const removed = workspaceReducer(state, { type: 'PROJECT_REMOVED', projectId: 'project-a' });
  assert.deepEqual(removed.tabs.map((item) => item.docId), ['doc:project-b/b.md']);
  assert.equal(removed.tabs[0].buffer, '# b.md\n', '其他项目的缓冲不得被改动');
  assert.equal(removed.tabs[0].dirty, true, '未保存标记不得被清掉');
  /*
   * 右组的**活动文档**必须原样保留（它本来就看着 b），只是 a 的引用要摘掉——
   * 引用集合变了，所以这里比的是"内容"而不是对象引用。
   */
  assert.equal(
    activeDocIn(removed, SECONDARY),
    'doc:project-b/b.md',
    '未被移除项目的组不得改变活动文档',
  );
  assert.deepEqual(
    docsIn(removed, SECONDARY),
    ['doc:project-b/b.md'],
    '被移除项目的引用必须从所有组摘掉',
  );
  assert.equal(
    docsIn(removed, PRIMARY).includes('doc:project-a/a.md'),
    false,
    '被移除项目的引用必须摘掉',
  );
  assertConsistent(removed, '移除项目后');
});

test('B2-E02 移除项目不影响布局结构', () => {
  const state = splitWithThreeTabs();
  const before = JSON.stringify(state.layoutTree);
  const removed = workspaceReducer(state, { type: 'PROJECT_REMOVED', projectId: 'project-a' });
  assert.equal(JSON.stringify(removed.layoutTree), before, '没有项目标签时移除不该动结构');
  assert.equal(removed.layout, 'vertical');
  assertConsistent(removed, '无标签项目移除后');
});

/* ================================================================== */
/* F. 恢复                                                             */
/* ================================================================== */

const ui = (layout: 'single' | 'vertical', splitRatio: number, focusedPane: 'primary' | 'secondary' = 'primary') => ({
  navCollapsed: false,
  navKey: 'projects' as const,
  treeCollapsed: false,
  auxCollapsed: true,
  auxTab: 'ai' as const,
  layout,
  splitRatio,
  focusedPane,
});

test('B2-F01 V1 单视图恢复：组被保留，随后由 SET_PANE_TAB 恢复活动文档', () => {
  let state = openBackground(liveState(), 'a');
  state = openBackground(state, 'b');
  state = workspaceReducer(state, { type: 'HYDRATE_UI', ui: ui('single', 55) });

  assert.deepEqual(Object.keys(state.viewGroups).sort(), [PRIMARY, SECONDARY], '恢复布局要保证组存在');
  assert.deepEqual(visibleGroupIds(state.layoutTree), [PRIMARY]);
  assert.deepEqual(docsIn(state, PRIMARY), [], 'HYDRATE 不因恢复布局而塞入标签');

  state = workspaceReducer(state, { type: 'SET_PANE_TAB', pane: 'primary', docId: 'a' });
  assert.equal(activeDocIn(state, PRIMARY), 'a');
  assert.deepEqual(docsIn(state, PRIMARY), ['a']);
  assertConsistent(state, '单视图恢复后');
});

test('B2-F02 V1 双视图恢复：两个组都在，各自恢复活动文档与模式', () => {
  let state = openBackground(liveState(), 'a');
  state = openBackground(state, 'b');
  state = workspaceReducer(state, { type: 'HYDRATE_UI', ui: ui('vertical', 68, 'secondary') });
  assert.deepEqual(visibleGroupIds(state.layoutTree), [PRIMARY, SECONDARY]);
  assert.equal(state.focusedGroupId, SECONDARY, '焦点按记录恢复到右组');

  state = workspaceReducer(state, { type: 'SET_PANE_TAB', pane: 'primary', docId: 'a' });
  state = workspaceReducer(state, {
    type: 'SET_PANE_TAB',
    pane: 'secondary',
    docId: 'b',
    mode: 'editor',
  });
  assert.equal(activeDocIn(state, PRIMARY), 'a');
  assert.equal(group(state, PRIMARY).mode, 'editor');
  assert.equal(activeDocIn(state, SECONDARY), 'b');
  assert.equal(group(state, SECONDARY).mode, 'editor', '记录里的模式必须生效');
  assertConsistent(state, '双视图恢复后');
});

test('B2-F03 恢复后的后台登记不抢焦点、不分配组', () => {
  let state = workspaceReducer(liveState(), { type: 'HYDRATE_UI', ui: ui('vertical', 50) });
  state = workspaceReducer(state, { type: 'SET_PANE_TAB', pane: 'primary', docId: 'a' });
  const groupsBefore = state.viewGroups;

  const restored = openBackground(state, 'later');
  assert.equal(restored.viewGroups, groupsBefore, '后台恢复不得改任何组');
  assert.equal(restored.focusedGroupId, PRIMARY);
  assertConsistent(restored, '后台恢复后');
});

test('B2-F04 打开请求期间用户切组：迟到响应不得把文档塞进新组', async () => {
  const roots = await makeRoots('ws-b2-f04-');
  const host = await startHost(roots, 'multi');
  const storage = new MemoryStorage();
  try {
    const h = makeHarness(host.url, storage);
    await h.bootLive();
    await h.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    h.dispatch({ type: 'SET_LAYOUT', layout: 'vertical' });
    h.dispatch({ type: 'FOCUS_GROUP', groupId: SECONDARY });
    // 右组先看着 a
    h.dispatch({ type: 'SET_PANE_TAB', pane: 'secondary', docId: 'doc:project-a/a.md' });
    assert.equal(h.state.focusedGroupId, SECONDARY);

    const release = h.holdNextOpen();
    const started = h.nextOpenStarted();
    const pending = h.opener.openNode(nodeOf('docs/notes.md', 'project-a'), 'project-a');
    await started;

    // 请求在途时用户切回左组
    h.dispatch({ type: 'FOCUS_GROUP', groupId: PRIMARY });
    release();
    const outcome = await pending;
    assert.equal(outcome.ok, true, '文件本身还是要打开的');

    // 迟到的响应只能后台登记：右组（发起时的组）活动文档不得被改写
    assert.equal(
      activeDocIn(h.state, SECONDARY),
      'doc:project-a/a.md',
      '迟到响应不得改写发起组的活动文档',
    );
    assert.equal(
      docsIn(h.state, PRIMARY).includes('doc:project-a/docs/notes.md'),
      false,
      '更不得跨组把文档塞进当前组',
    );
    assert.ok(
      h.state.tabs.some((item) => item.docId === 'doc:project-a/docs/notes.md'),
      '标签仍然必须登记（不能丢）',
    );
    const docIds = new Set(h.state.tabs.map((item) => item.docId));
    assert.deepEqual(
      viewGroupProblems(h.state.viewGroups, h.state.viewInstances, docIds),
      [],
      '组状态不变量',
    );
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

test('B2-F05 打开请求期间用户在同一组里切了文档：迟到响应只后台登记', async () => {
  const roots = await makeRoots('ws-b2-f05-');
  const host = await startHost(roots, 'multi');
  const storage = new MemoryStorage();
  try {
    const h = makeHarness(host.url, storage);
    await h.bootLive();
    await h.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');

    const release = h.holdNextOpen();
    const started = h.nextOpenStarted();
    const pending = h.opener.openNode(nodeOf('docs/notes.md', 'project-a'), 'project-a');
    await started;

    // 同一组里，用户把活动文档换成别的标签
    h.dispatch({ type: 'OPEN_TAB_BACKGROUND', tab: {
      ...h.state.tabs[0],
      docId: 'doc:project-a/other.md',
      path: 'other.md',
    } });
    h.dispatch({ type: 'SET_PANE_TAB', pane: 'primary', docId: 'doc:project-a/other.md' });
    release();
    await pending;

    assert.equal(
      activeDocIn(h.state, PRIMARY),
      'doc:project-a/other.md',
      '用户的新选择必须保留',
    );
    assert.ok(
      h.state.tabs.some((item) => item.docId === 'doc:project-a/docs/notes.md'),
      '迟到响应仍然登记标签',
    );
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

/* ================================================================== */
/* G. 不可变性与一致性                                                 */
/* ================================================================== */

test('B2-G01 组更新不修改原状态，未涉及的组保持同一引用', () => {
  const state = splitWithThreeTabs();
  const snapshot = JSON.stringify(state);
  const secondaryBefore = group(state, SECONDARY);

  workspaceReducer(state, { type: 'OPEN_TAB', tab: tab({ docId: 'd', path: 'd.md' }) });
  workspaceReducer(state, { type: 'CLOSE_TAB', docId: 'a' });
  workspaceReducer(state, { type: 'SET_PANE_MODE', pane: 'primary', mode: 'preview' });
  workspaceReducer(state, { type: 'FOCUS_GROUP', groupId: SECONDARY });

  assert.equal(JSON.stringify(state), snapshot, 'reducer 不得就地修改入参');
  assert.equal(group(state, SECONDARY), secondaryBefore);
});

test('B2-G02 关闭文档不改变布局结构', () => {
  const state = splitWithThreeTabs();
  const before = JSON.stringify(state.layoutTree);
  const closed = workspaceReducer(state, { type: 'CLOSE_TAB', docId: 'b' });
  assert.equal(JSON.stringify(closed.layoutTree), before, '关标签不得动结构');
  assert.equal(closed.layoutTree, state.layoutTree, '结构保持同一引用');
});

test('B2-G03 布局树合法且不含文档身份（每次结构操作后）', () => {
  let state = liveState();
  const steps: ReadonlyArray<readonly [string, () => WorkspaceState]> = [
    ['打开', () => open(state, 'a')],
    ['分屏', () => split(state)],
    ['改模式', () => workspaceReducer(state, { type: 'SET_PANE_MODE', pane: 'secondary', mode: 'editor' })],
    ['关标签', () => workspaceReducer(state, { type: 'CLOSE_TAB', docId: 'a' })],
    ['合并', () => unsplit(state)],
  ];
  for (const [label, run] of steps) {
    const next = run();
    assert.equal(validateLayoutTree(next.layoutTree), null, `${label}：布局树必须合法`);
    assert.ok(listPanes(next.layoutTree).length >= 1, `${label}：至少一个 Pane`);
    assertConsistent(next, label);
  }
});

test('B2-G04 连续状态迁移：每一步都自洽（不是各自从同一初始状态出发）', () => {
  /*
   * 这条取代 B1-G01 里"每个操作都基于同一个初始状态"的写法：那种写法只能证明
   * "每个 action 单独看没错"，证明不了"连续迁移不会累积漂移"。
   */
  const log: string[] = [];
  let state = liveState();

  const step = (label: string, action: Parameters<typeof workspaceReducer>[1]): void => {
    state = workspaceReducer(state, action);
    log.push(label);
    assertConsistent(state, `连续迁移 @ ${log.join(' → ')}`);
  };

  step('打开 a', { type: 'OPEN_TAB', tab: tab({ docId: 'a', path: 'a.md' }) });
  step('打开 b', { type: 'OPEN_TAB', tab: tab({ docId: 'b', path: 'b.md' }) });
  step('分屏', { type: 'SET_LAYOUT', layout: 'vertical' });
  step('焦点右组', { type: 'FOCUS_GROUP', groupId: SECONDARY });
  step('右组打开 c', { type: 'OPEN_TAB', tab: tab({ docId: 'c', path: 'c.md' }) });
  step('右组切预览', { type: 'SET_PANE_MODE', pane: 'secondary', mode: 'editor' });
  step('右组活动 b', { type: 'SET_PANE_TAB', pane: 'secondary', docId: 'b' });
  step('关闭 b', { type: 'CLOSE_TAB', docId: 'b' });
  step('合并', { type: 'SET_LAYOUT', layout: 'single' });
  step('再分屏', { type: 'SET_LAYOUT', layout: 'vertical' });
  step('切模式', { type: 'SET_MODE', mode: 'demo' });

  // 终态仍然自洽，且所有引用都指向真实存在的标签
  assertConsistent(state, '连续迁移终态');
  assert.deepEqual(state.tabs, [], '切模式后没有标签');
  assert.deepEqual(docsIn(state, PRIMARY), []);
  assert.deepEqual(group(state, SECONDARY).mode, 'preview', '切模式后模式复位');
});
