/**
 * UI-F03-B1：LayoutTree 接入 WorkspaceState（先红后绿）。
 *
 * 本轮是**状态层接线**，不接 UI：`layoutTree` 成为布局结构的权威模型，
 * `layout` / `splitRatio` / `panes` / `focusedPane` 降级为旧 UI 的兼容投影。
 *
 * 五条要钉住的事实：
 *
 * 1. **方向命名相反**。旧 `layout === 'vertical'` 指的是"分隔条竖着"，也就是
 *    **左右**分屏（`SplitWorkspace.tsx:128` 的 `gridTemplateColumns`）；
 *    新模型 `orientation === 'horizontal'` 才是左右。字符串同名映射会把方向翻过来，
 *    所以这里逐个断言 `root.orientation === 'horizontal'`。
 * 2. **比例单位不同**。旧 `splitRatio` 是 25~75 的整数百分比，新 `ratio` 是 0.25~0.75 的
 *    小数。少除以 100 会让窗格宽度变成 5000%。
 * 3. **身份必须确定**。`legacy-pane:primary` / `legacy-group:primary` /
 *    `legacy-split:root` / `legacy-pane:secondary` / `legacy-group:secondary`
 *    是兼容桥的保留身份，reducer 不得生成随机值，否则每次分屏都得到一棵"新树"。
 * 4. **结构与内容分离**。布局树只描述结构：docId / sessionId / 路径 / 缓冲区
 *    一个字都不能进去。文档操作（打开、关闭、切换、移除项目）不得改布局树。
 * 5. **不半更新**。结构操作失败时整体不生效，绝不留下"旧字段说分屏、新树说单窗格"的
 *    中间状态：每次结构操作后都要 `validateLayoutTree(state.layoutTree) === null`，
 *    且投影（layout / splitRatio）与树本身一致。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  listPanes,
  listSplits,
  validateLayoutTree,
  type LayoutNode,
  type LayoutTree,
  type SplitNode,
} from '../../apps/shell/src/state/layout-tree.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import type { DocTab, PaneId, WorkspaceAction, WorkspaceState } from '../../apps/shell/src/state/types.ts';

/* ------------------------------------------------------------------ */
/* 兼容桥的保留身份（刻意在测试里写字面值：reducer 改了就该红）          */
/* ------------------------------------------------------------------ */

const PRIMARY = { nodeId: 'legacy-pane:primary', groupId: 'legacy-group:primary' } as const;
const SECONDARY = { nodeId: 'legacy-pane:secondary', groupId: 'legacy-group:secondary' } as const;
const SPLIT_ID = 'legacy-split:root';

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

function tab(overrides: Partial<DocTab> & Pick<DocTab, 'docId' | 'path'>): DocTab {
  return {
    projectId: null,
    title: overrides.path,
    extension: '.md',
    buffer: '# x\n',
    dirty: false,
    mode: 'live',
    sessionId: 'session-1',
    viewId: 'view-1',
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

/** 开两个标签，并把主窗格指向第一个（模拟真实的"已打开文档"状态）。 */
function withTwoTabs(): WorkspaceState {
  let state = liveState();
  state = workspaceReducer(state, {
    type: 'OPEN_TAB',
    tab: tab({ docId: 'doc:a.md', path: 'a.md', title: 'a.md' }),
  });
  state = workspaceReducer(state, {
    type: 'OPEN_TAB_BACKGROUND',
    tab: tab({ docId: 'doc:b.md', path: 'b.md', title: 'b.md' }),
  });
  return state;
}

const rootOf = (tree: LayoutTree): SplitNode => {
  assert.equal(tree.root.type, 'split', '这一步之后根必须是 split');
  return tree.root as SplitNode;
};

/**
 * 每次结构操作后都要成立的三件事：树合法、投影与树一致、树里没有视图内容。
 */
function assertConsistent(state: WorkspaceState, label: string): void {
  const tree = state.layoutTree;
  assert.equal(validateLayoutTree(tree), null, `${label}：布局树必须合法`);

  const panes = listPanes(tree);
  const splits = listSplits(tree);

  if (state.layout === 'single') {
    assert.equal(tree.root.type, 'pane', `${label}：单视图的根必须是 Pane`);
    assert.equal(panes.length, 1, `${label}：单视图只有一个 Pane`);
    assert.equal(splits.length, 0, `${label}：单视图没有 Split`);
    assert.equal(panes[0].nodeId, PRIMARY.nodeId, `${label}：单视图保留 primary 身份`);
    assert.equal(panes[0].groupId, PRIMARY.groupId, `${label}：groupId 与身份绑定`);
  } else {
    assert.equal(state.layout, 'vertical', `${label}：旧投影只有 vertical 一种分屏`);
    const root = rootOf(tree);
    assert.equal(root.nodeId, SPLIT_ID, `${label}：split 使用保留身份`);
    // 旧 'vertical' = 分隔条竖着 = 左右；新模型写作 horizontal
    assert.equal(root.orientation, 'horizontal', `${label}：旧 vertical 必须映射为 horizontal`);
    assert.equal(splits.length, 1, `${label}：兼容投影只允许单层分屏`);
    assert.deepEqual(
      panes.map((pane) => pane.nodeId),
      [PRIMARY.nodeId, SECONDARY.nodeId],
      `${label}：左 primary / 右 secondary`,
    );
    assert.deepEqual(
      panes.map((pane) => pane.groupId),
      [PRIMARY.groupId, SECONDARY.groupId],
      `${label}：groupId 顺序与 Pane 顺序一致`,
    );
    assert.equal(
      state.splitRatio,
      Math.round(root.ratio * 100),
      `${label}：splitRatio 必须等于树的 ratio × 100`,
    );
  }

  assert.ok(state.splitRatio >= 25 && state.splitRatio <= 75, `${label}：splitRatio 必须落在 25~75`);
  assert.equal(Number.isInteger(state.splitRatio), true, `${label}：splitRatio 必须是整数百分比`);

  // 结构与内容分离：树里不允许出现任何视图身份
  const json = JSON.stringify(tree);
  for (const forbidden of ['docId', 'sessionId', 'viewId', 'buffer', 'path', 'dirty']) {
    assert.equal(json.includes(forbidden), false, `${label}：布局树不得包含 ${forbidden}`);
  }
}

/** 结构指纹：用于证明"某次操作没有动布局树"。 */
function treeFingerprint(tree: LayoutTree): string {
  return JSON.stringify(tree);
}

/* ================================================================== */
/* A. 初始状态                                                         */
/* ================================================================== */

test('B1-A01 初始状态就是一棵合法的单 Pane 布局树，身份是保留值', () => {
  const tree = INITIAL_STATE.layoutTree;
  assert.equal(validateLayoutTree(tree), null, '初始布局树必须合法');
  assert.equal(tree.root.type, 'pane');
  assert.equal(tree.root.nodeId, PRIMARY.nodeId);
  assert.equal(tree.root.groupId, PRIMARY.groupId);
  assert.equal(listPanes(tree).length, 1, '初始只有一个 Pane');
  assert.deepEqual(listSplits(tree), [], '初始没有 Split');
  assert.equal(INITIAL_STATE.layout, 'single', '兼容投影初始为单视图');
  assert.equal(INITIAL_STATE.splitRatio, 50, '初始比例偏好 50%');
  assertConsistent(INITIAL_STATE, '初始状态');
});

test('B1-A02 身份稳定且唯一：多次构造得到同一棵树，groupId 与 nodeId 不重复', () => {
  const a = liveState();
  const b = liveState();
  assert.equal(treeFingerprint(a.layoutTree), treeFingerprint(b.layoutTree), '同一操作序列必须得到同一棵树');

  let split = workspaceReducer(withTwoTabs(), { type: 'SET_LAYOUT', layout: 'vertical' });
  const panes = listPanes(split.layoutTree);
  const nodeIds = panes.map((pane) => pane.nodeId);
  const groupIds = panes.map((pane) => pane.groupId);
  assert.equal(new Set(nodeIds).size, nodeIds.length, 'nodeId 不得重复');
  assert.equal(new Set(groupIds).size, groupIds.length, 'groupId 不得重复');
  assert.notEqual(PRIMARY.groupId, SECONDARY.groupId, '两个视图组身份必须不同');
  assert.notEqual(PRIMARY.nodeId, SECONDARY.nodeId, '两个 Pane 身份必须不同');

  // 反复分屏/合并不产生新身份（reducer 不得生成随机值）
  split = workspaceReducer(split, { type: 'SET_LAYOUT', layout: 'single' });
  split = workspaceReducer(split, { type: 'SET_LAYOUT', layout: 'vertical' });
  assert.deepEqual(
    listPanes(split.layoutTree).map((pane) => pane.nodeId),
    [PRIMARY.nodeId, SECONDARY.nodeId],
    '重新分屏必须复用保留身份',
  );
  assertConsistent(split, '反复分屏后');
});

/* ================================================================== */
/* B. 分屏                                                             */
/* ================================================================== */

test('B1-B01 单视图 → 分屏：horizontal 方向、primary 身份保留、secondary 身份唯一', () => {
  const before = withTwoTabs();
  assert.equal(before.layout, 'single');
  const split = workspaceReducer(before, { type: 'SET_LAYOUT', layout: 'vertical' });

  assert.equal(split.layout, 'vertical');
  const root = rootOf(split.layoutTree);
  assert.equal(root.orientation, 'horizontal', "旧 'vertical' 表示左右分屏，必须映射成 horizontal");
  assert.equal(root.nodeId, SPLIT_ID);

  const panes = listPanes(split.layoutTree);
  assert.equal(panes.length, 2);
  assert.equal(panes[0].nodeId, PRIMARY.nodeId, '原 Pane 身份必须保留');
  assert.equal(panes[0].groupId, PRIMARY.groupId);
  assert.equal(panes[1].nodeId, SECONDARY.nodeId);
  assert.equal(panes[1].groupId, SECONDARY.groupId);
  assertConsistent(split, '分屏后');
});

test('B1-B02 分屏沿用旧版 anchor 与 secondary 复用行为', () => {
  const opened = withTwoTabs(); // primary 指向 doc:a.md，另有 doc:b.md
  const state = workspaceReducer(opened, { type: 'SET_LAYOUT', layout: 'vertical' });
  assert.equal(state.panes.primary.docId, 'doc:a.md', 'primary 原有指向保留');
  assert.equal(state.panes.secondary.docId, 'doc:a.md', 'secondary 缺省复用一个可用文档（旧版 anchor 行为）');
  assert.equal(state.panes.secondary.mode, 'preview', '旧版把右侧设为预览');

  // 已有 secondary 指向时不得被 anchor 覆盖
  const pointed = workspaceReducer(state, {
    type: 'SET_PANE_TAB',
    pane: 'secondary',
    docId: 'doc:b.md',
  });
  const again = workspaceReducer(pointed, { type: 'SET_LAYOUT', layout: 'vertical' });
  assert.equal(again.panes.secondary.docId, 'doc:b.md', '已存在的 secondary 指向必须复用');
  assert.equal(treeFingerprint(again.layoutTree), treeFingerprint(pointed.layoutTree), '重复分屏不得嵌套新 split');
  assertConsistent(again, '重复分屏后');
});

test('B1-B03 分屏比例来自当前 splitRatio，百分比换成 0~1', () => {
  const wide = workspaceReducer(withTwoTabs(), { type: 'SET_SPLIT_RATIO', ratio: 68 });
  const split = workspaceReducer(wide, { type: 'SET_LAYOUT', layout: 'vertical' });
  assert.equal(rootOf(split.layoutTree).ratio, 0.68, '68% 必须变成 0.68，而不是 68');
  assert.equal(split.splitRatio, 68);
  assertConsistent(split, '带比例分屏后');

  // 反向也成立：分屏状态下改比例，树与投影同步
  const narrowed = workspaceReducer(split, { type: 'SET_SPLIT_RATIO', ratio: 30 });
  assert.equal(rootOf(narrowed.layoutTree).ratio, 0.3);
  assert.equal(narrowed.splitRatio, 30);
  assertConsistent(narrowed, '分屏改比例后');
});

/* ================================================================== */
/* C. 合并                                                             */
/* ================================================================== */

test('B1-C01 分屏 → 单视图：用 mergePane 塌陷，保留 primary 与隐藏的 secondary 文档指向', () => {
  let state = workspaceReducer(withTwoTabs(), { type: 'SET_LAYOUT', layout: 'vertical' });
  state = workspaceReducer(state, { type: 'SET_PANE_TAB', pane: 'secondary', docId: 'doc:b.md' });
  const hiddenSecondary = state.panes.secondary;

  const merged = workspaceReducer(state, { type: 'SET_LAYOUT', layout: 'single' });
  assert.equal(merged.layout, 'single');
  assert.equal(merged.layoutTree.root.type, 'pane', '父 split 必须塌陷，兄弟顶上来');
  assert.equal(merged.layoutTree.root.nodeId, PRIMARY.nodeId, '保留的是 primary');
  assert.deepEqual(listSplits(merged.layoutTree), [], '合并后没有 Split');
  assert.equal(merged.focusedPane, 'primary');
  assert.deepEqual(merged.panes.secondary, hiddenSecondary, '不得删除 secondary 的隐藏文档指向');
  assert.equal(merged.splitRatio, state.splitRatio, '单视图保留比例偏好');
  assertConsistent(merged, '合并后');
});

test('B1-C02 不能删除最后一个 Pane：单视图再点单视图仍然合法且幂等', () => {
  const before = withTwoTabs();
  const after = workspaceReducer(before, { type: 'SET_LAYOUT', layout: 'single' });
  assert.equal(treeFingerprint(after.layoutTree), treeFingerprint(before.layoutTree), '单视图上再合并不得改树');
  assert.equal(after.layout, 'single');
  assert.equal(after.focusedPane, 'primary');
  assertConsistent(after, '单视图重复合并后');

  // 合并后重新分屏，结构与比例偏好都回到原样
  const split = workspaceReducer(workspaceReducer(after, { type: 'SET_SPLIT_RATIO', ratio: 64 }), {
    type: 'SET_LAYOUT',
    layout: 'vertical',
  });
  assert.equal(rootOf(split.layoutTree).ratio, 0.64, '单视图期间记录的比例偏好必须被用上');
  assertConsistent(split, '重新分屏后');
});

/* ================================================================== */
/* D. 比例                                                             */
/* ================================================================== */

test('B1-D01 比例边界 25 / 50 / 75 与越界钳制，树与投影同步', () => {
  const base = workspaceReducer(withTwoTabs(), { type: 'SET_LAYOUT', layout: 'vertical' });
  const cases: ReadonlyArray<readonly [number, number]> = [
    [25, 25],
    [50, 50],
    [75, 75],
    [20, 25],
    [80, 75],
    [0, 25],
    [100, 75],
  ];
  for (const [input, expected] of cases) {
    const next = workspaceReducer(base, { type: 'SET_SPLIT_RATIO', ratio: input });
    assert.equal(next.splitRatio, expected, `拖动 ${input} 必须收敛到 ${expected}`);
    assert.equal(rootOf(next.layoutTree).ratio, expected / 100, `树的比例必须是 ${expected / 100}`);
    assertConsistent(next, `比例 ${input}`);
  }
});

test('B1-D02 异常输入：NaN / Infinity 不产生非法树', () => {
  const base = workspaceReducer(withTwoTabs(), { type: 'SET_LAYOUT', layout: 'vertical' });
  /*
   * 非有限值一律收敛到默认 50%，与 `clampUiSplitRatio` 的语义一致：
   * 一个无法解释的数值不该被读成"用户想要最宽/最窄"。指针事件不会产生 Infinity，
   * 这条只是挡住手写的异常输入。
   */
  for (const [input, expected] of [
    [Number.NaN, 50],
    [Number.POSITIVE_INFINITY, 50],
    [Number.NEGATIVE_INFINITY, 50],
  ] as const) {
    const next = workspaceReducer(base, { type: 'SET_SPLIT_RATIO', ratio: input });
    assert.equal(next.splitRatio, expected, `${String(input)} 必须收敛到 ${expected}`);
    assert.equal(Number.isFinite(rootOf(next.layoutTree).ratio), true, '树的比例必须是有限数');
    assertConsistent(next, `异常比例 ${String(input)}`);
  }
});

test('B1-D03 拖动产生的小数百分比：树保留精度，投影仍是整数', () => {
  const base = workspaceReducer(withTwoTabs(), { type: 'SET_LAYOUT', layout: 'vertical' });
  const next = workspaceReducer(base, { type: 'SET_SPLIT_RATIO', ratio: 43.7 });
  // 用 43.7 / 100 而不是字面量 0.437：要钉的是"除以 100"，不是十进制的精确表示
  assert.equal(rootOf(next.layoutTree).ratio, 43.7 / 100, '0~1 的小数保留拖动精度');
  assert.equal(next.splitRatio, 44, '旧投影沿用整数百分比');
  assertConsistent(next, '小数拖动后');
});

test('B1-D04 改比例不影响其他节点，未修改的分支保持引用', () => {
  const base = workspaceReducer(withTwoTabs(), { type: 'SET_LAYOUT', layout: 'vertical' });
  const beforeRoot = rootOf(base.layoutTree);
  const next = workspaceReducer(base, { type: 'SET_SPLIT_RATIO', ratio: 70 });
  const afterRoot = rootOf(next.layoutTree);

  assert.equal(afterRoot.children[0], beforeRoot.children[0], '左子节点必须保持同一引用');
  assert.equal(afterRoot.children[1], beforeRoot.children[1], '右子节点必须保持同一引用');
  assert.equal(afterRoot.nodeId, beforeRoot.nodeId);
  assert.equal(afterRoot.orientation, beforeRoot.orientation);
  assert.notEqual(afterRoot, beforeRoot, '改比例必须产生新的根对象（不可变更新）');
  assert.equal(afterRoot.ratio, 0.7);
});

test('B1-D05 单视图改比例只更新旧版偏好，不凭空创建 split', () => {
  const single = withTwoTabs();
  const next = workspaceReducer(single, { type: 'SET_SPLIT_RATIO', ratio: 33 });
  assert.equal(next.splitRatio, 33);
  assert.equal(next.layoutTree, single.layoutTree, '单视图下布局树必须保持同一引用');
  assert.equal(next.layoutTree.root.type, 'pane');
  assertConsistent(next, '单视图改比例后');
});

/* ================================================================== */
/* E. 恢复（HYDRATE_UI）                                               */
/* ================================================================== */

const uiOf = (overrides: Partial<WorkspaceState> & { layout: 'single' | 'vertical'; splitRatio: number }) => ({
  navCollapsed: overrides.navCollapsed ?? false,
  navKey: overrides.navKey ?? ('projects' as const),
  treeCollapsed: overrides.treeCollapsed ?? false,
  auxCollapsed: overrides.auxCollapsed ?? true,
  auxTab: overrides.auxTab ?? ('ai' as const),
  layout: overrides.layout,
  splitRatio: overrides.splitRatio,
  focusedPane: overrides.focusedPane ?? ('primary' as PaneId),
});

test('B1-E01 V1 单视图恢复：重建单 Pane，焦点被收敛到 primary', () => {
  const state = workspaceReducer(withTwoTabs(), {
    type: 'HYDRATE_UI',
    ui: uiOf({ layout: 'single', splitRatio: 55, focusedPane: 'secondary' }),
  });
  assert.equal(state.layout, 'single');
  assert.equal(state.layoutTree.root.type, 'pane');
  assert.equal(state.layoutTree.root.nodeId, PRIMARY.nodeId);
  assert.equal(state.focusedPane, 'primary', '单视图不接受"焦点在副窗格"');
  assert.equal(state.splitRatio, 55, '单视图也保留记录的比例偏好');
  assertConsistent(state, 'HYDRATE 单视图');
});

test('B1-E02 V1 左右分屏恢复：vertical → horizontal，ratio 来自 splitRatio', () => {
  const state = workspaceReducer(INITIAL_STATE, {
    type: 'HYDRATE_UI',
    ui: uiOf({ layout: 'vertical', splitRatio: 68, focusedPane: 'secondary' }),
  });
  assert.equal(state.layout, 'vertical');
  const root = rootOf(state.layoutTree);
  assert.equal(root.orientation, 'horizontal');
  assert.equal(root.ratio, 0.68);
  assert.equal(state.splitRatio, 68);
  assert.equal(state.focusedPane, 'secondary', '分屏恢复保留记录的焦点');
  assertConsistent(state, 'HYDRATE 分屏');
});

test('B1-E03 恢复不碰 tabs / panes：窗格指向由后续 SET_PANE_TAB 决定', () => {
  const opened = withTwoTabs();
  const state = workspaceReducer(opened, {
    type: 'HYDRATE_UI',
    ui: uiOf({ layout: 'vertical', splitRatio: 40 }),
  });
  assert.equal(state.tabs, opened.tabs, '标签必须保持原引用');
  assert.deepEqual(state.panes, opened.panes, '窗格指向不得被 HYDRATE_UI 改动');

  const pointed = workspaceReducer(state, {
    type: 'SET_PANE_TAB',
    pane: 'secondary',
    docId: 'doc:b.md',
    mode: 'editor',
  });
  assert.equal(pointed.panes.secondary.docId, 'doc:b.md');
  assert.equal(pointed.panes.secondary.mode, 'editor');
  assert.deepEqual(
    listPanes(pointed.layoutTree).map((pane) => pane.groupId),
    [PRIMARY.groupId, SECONDARY.groupId],
    '设置窗格文档不得改变 groupId',
  );
  assert.equal(
    treeFingerprint(pointed.layoutTree),
    treeFingerprint(state.layoutTree),
    '设置窗格文档不得改布局树',
  );
});

test('B1-E04 非法恢复数据不产生部分布局：布局整块不套用，其余界面字段照常', () => {
  const base = workspaceReducer(withTwoTabs(), {
    type: 'HYDRATE_UI',
    ui: uiOf({ layout: 'vertical', splitRatio: 60 }),
  });
  const snapshotBefore = treeFingerprint(base.layoutTree);

  for (const badRatio of [96, 20, 43.7, Number.NaN]) {
    const next = workspaceReducer(base, {
      type: 'HYDRATE_UI',
      ui: { ...uiOf({ layout: 'single', splitRatio: badRatio }), navCollapsed: true, auxTab: 'tasks' },
    });
    assert.equal(treeFingerprint(next.layoutTree), snapshotBefore, `非法比例 ${badRatio} 不得产生新布局`);
    assert.equal(next.layout, 'vertical', '布局投影必须与树保持一致，不得半套用');
    assert.equal(next.splitRatio, 60, '非法比例不得被夹紧后当成有效值');
    // 与布局无关的界面字段仍然生效
    assert.equal(next.navCollapsed, true);
    assert.equal(next.auxTab, 'tasks');
    assertConsistent(next, `非法恢复 ${badRatio}`);
  }
});

/* ================================================================== */
/* F. 文档操作隔离                                                     */
/* ================================================================== */

test('B1-F01 打开 / 关闭 / 激活标签都不改变布局树', () => {
  const split = workspaceReducer(withTwoTabs(), { type: 'SET_LAYOUT', layout: 'vertical' });
  const before = treeFingerprint(split.layoutTree);
  const beforeRef = split.layoutTree;

  const steps: ReadonlyArray<[string, WorkspaceState]> = [
    [
      'OPEN_TAB',
      workspaceReducer(split, { type: 'OPEN_TAB', tab: tab({ docId: 'doc:c.md', path: 'c.md' }) }),
    ],
    [
      'OPEN_TAB_BACKGROUND',
      workspaceReducer(split, {
        type: 'OPEN_TAB_BACKGROUND',
        tab: tab({ docId: 'doc:d.md', path: 'd.md' }),
      }),
    ],
    ['ACTIVATE_TAB', workspaceReducer(split, { type: 'ACTIVATE_TAB', docId: 'doc:b.md' })],
    ['CLOSE_TAB', workspaceReducer(split, { type: 'CLOSE_TAB', docId: 'doc:b.md' })],
    [
      'SET_PANE_TAB',
      workspaceReducer(split, { type: 'SET_PANE_TAB', pane: 'secondary', docId: 'doc:b.md' }),
    ],
    ['SET_PANE_MODE', workspaceReducer(split, { type: 'SET_PANE_MODE', pane: 'primary', mode: 'preview' })],
    ['FOCUS_PANE', workspaceReducer(split, { type: 'FOCUS_PANE', pane: 'secondary' })],
    ['TAB_PATCH', workspaceReducer(split, { type: 'TAB_PATCH', docId: 'doc:a.md', patch: { dirty: true } })],
    ['EDIT_DOC', workspaceReducer(split, { type: 'EDIT_DOC', docId: 'doc:a.md', text: '# 改过了\n' })],
  ];

  for (const [label, next] of steps) {
    assert.equal(next.layoutTree, beforeRef, `${label} 必须保持布局树原引用`);
    assert.equal(treeFingerprint(next.layoutTree), before, `${label} 不得改布局结构`);
    assertConsistent(next, label);
  }
});

test('B1-F02 移除项目：只收标签与窗格指向，不动布局结构', () => {
  let state = workspaceReducer(INITIAL_STATE, { type: 'SET_MODE', mode: 'live' });
  state = workspaceReducer(state, { type: 'SET_WORKSPACE_MODE', workspaceMode: 'multi' });
  state = workspaceReducer(state, {
    type: 'SET_PROJECTS',
    projects: [
      { projectId: 'project-a', name: '项目 A', status: 'READY' },
      { projectId: 'project-b', name: '项目 B', status: 'READY' },
    ],
  });
  state = workspaceReducer(state, {
    type: 'OPEN_TAB',
    tab: tab({ docId: 'doc:project-a/a.md', path: 'a.md', projectId: 'project-a' }),
  });
  state = workspaceReducer(state, {
    type: 'OPEN_TAB_BACKGROUND',
    tab: tab({ docId: 'doc:project-b/b.md', path: 'b.md', projectId: 'project-b' }),
  });
  state = workspaceReducer(state, { type: 'SET_LAYOUT', layout: 'vertical' });
  const before = treeFingerprint(state.layoutTree);

  const removed = workspaceReducer(state, { type: 'PROJECT_REMOVED', projectId: 'project-a' });
  assert.equal(treeFingerprint(removed.layoutTree), before, '移除项目不得改布局结构');
  assert.deepEqual(
    listPanes(removed.layoutTree).map((pane) => pane.groupId),
    [PRIMARY.groupId, SECONDARY.groupId],
    '视图组身份不得随项目移除而变化',
  );
  assert.equal(removed.layout, 'vertical', '分屏状态保持');
  assertConsistent(removed, '移除项目后');
});

test('B1-F03 编辑缓冲 / dirty / sessionId 不进入布局树', () => {
  let state = workspaceReducer(withTwoTabs(), { type: 'SET_LAYOUT', layout: 'vertical' });
  state = workspaceReducer(state, { type: 'EDIT_DOC', docId: 'doc:a.md', text: '# 草稿\n' });
  state = workspaceReducer(state, {
    type: 'TAB_PATCH',
    docId: 'doc:a.md',
    patch: { sessionId: 'session-xyz', viewId: 'view-xyz', buffer: '# 更长的草稿\n' },
  });

  const json = JSON.stringify(state.layoutTree);
  for (const forbidden of ['session-xyz', 'view-xyz', '草稿', 'doc:a.md', 'a.md']) {
    assert.equal(json.includes(forbidden), false, `布局树不得出现 ${forbidden}`);
  }
  // 树的字段集合是封闭的：只允许白名单
  const keys = new Set<string>();
  const walk = (node: LayoutNode): void => {
    for (const key of Object.keys(node)) keys.add(key);
    if (node.type === 'split') {
      walk(node.children[0]);
      walk(node.children[1]);
    }
  };
  walk(state.layoutTree.root);
  assert.deepEqual(
    [...keys].sort(),
    ['children', 'groupId', 'nodeId', 'orientation', 'ratio', 'type'],
    '布局树只允许模型定义过的字段',
  );
  assertConsistent(state, '编辑后');
});

/* ================================================================== */
/* G. 状态一致性                                                       */
/* ================================================================== */

test('B1-G01 每一次结构操作后树都合法，且旧投影与树完全一致（连续执行）', () => {
  /*
   * 注意：这些操作是**连续**作用在同一条状态上的（UI-F03-B2 修正）。
   *
   * 旧版本每个操作都用同一个闭包里的初始 `state`，于是只能证明"每个动作单独看
   * 没错"，证明不了"连续迁移不会累积漂移"——而后者才是状态机真正的风险：
   * 前一步把树改成分屏、后一步按单视图假设去改，才会炸。
   */
  let state = withTwoTabs();
  assertConsistent(state, '起点');

  const ops: ReadonlyArray<readonly [string, WorkspaceAction]> = [
    ['分屏', { type: 'SET_LAYOUT', layout: 'vertical' }],
    ['改比例 30', { type: 'SET_SPLIT_RATIO', ratio: 30 }],
    ['改比例 75', { type: 'SET_SPLIT_RATIO', ratio: 75 }],
    ['合并', { type: 'SET_LAYOUT', layout: 'single' }],
    ['恢复分屏', { type: 'HYDRATE_UI', ui: uiOf({ layout: 'vertical', splitRatio: 58 }) }],
    ['恢复单视图', { type: 'HYDRATE_UI', ui: uiOf({ layout: 'single', splitRatio: 44 }) }],
  ];

  const trail: string[] = [];
  for (const [label, action] of ops) {
    state = workspaceReducer(state, action);
    trail.push(label);
    const where = `连续迁移 @ ${trail.join(' → ')}`;
    assertConsistent(state, where);
    // 旧 UI 能表达的两种形状都要能被树解释：不允许"投影说有 split、树里没有"
    assert.equal(state.layout === 'single', state.layoutTree.root.type === 'pane', `${where}：投影与树同形`);
  }
});

/* ================================================================== */
/* H. 不可变性                                                         */
/* ================================================================== */

test('B1-H01 结构操作不修改入参状态', () => {
  const base = workspaceReducer(withTwoTabs(), { type: 'SET_LAYOUT', layout: 'vertical' });
  const snapshot = JSON.stringify(base);

  workspaceReducer(base, { type: 'SET_SPLIT_RATIO', ratio: 30 });
  workspaceReducer(base, { type: 'SET_LAYOUT', layout: 'single' });
  workspaceReducer(base, { type: 'HYDRATE_UI', ui: uiOf({ layout: 'single', splitRatio: 50 }) });

  assert.equal(JSON.stringify(base), snapshot, 'reducer 不得就地修改入参');
});

test('B1-H02 失败的结构操作不产生半更新', () => {
  // 造一棵"没有 secondary 视图组"的树：合并必须被模型拒绝
  const split = workspaceReducer(withTwoTabs(), { type: 'SET_LAYOUT', layout: 'vertical' });
  const tampered: LayoutTree = {
    version: 1,
    root: {
      type: 'split',
      nodeId: SPLIT_ID,
      orientation: 'horizontal',
      ratio: 0.5,
      children: [
        { type: 'pane', nodeId: PRIMARY.nodeId, groupId: PRIMARY.groupId },
        { type: 'pane', nodeId: 'pane:foreign', groupId: 'group:foreign' },
      ],
    },
  };
  const broken: WorkspaceState = { ...split, layoutTree: tampered };

  const next = workspaceReducer(broken, { type: 'SET_LAYOUT', layout: 'single' });
  assert.equal(next, broken, '被模型拒绝的合并必须整体不生效');
  assert.equal(next.layoutTree, tampered, '布局树不得被裁剪或篡改');
  assert.equal(next.layout, 'vertical', '旧投影不得单独改成 single');
  assert.equal(validateLayoutTree(next.layoutTree), null, '树本身仍然合法（只是不是兼容形状）');
});

test('B1-H03 reducer 不产生随机身份：同一序列两次执行完全一致', () => {
  const run = (): string => {
    let state = workspaceReducer(withTwoTabs(), { type: 'SET_LAYOUT', layout: 'vertical' });
    state = workspaceReducer(state, { type: 'SET_SPLIT_RATIO', ratio: 62 });
    state = workspaceReducer(state, { type: 'SET_LAYOUT', layout: 'single' });
    state = workspaceReducer(state, { type: 'SET_LAYOUT', layout: 'vertical' });
    return JSON.stringify(state.layoutTree);
  };
  assert.equal(run(), run(), '同一操作序列必须得到逐字节相同的布局树');
});
