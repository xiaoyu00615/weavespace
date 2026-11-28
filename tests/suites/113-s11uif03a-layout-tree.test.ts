/**
 * UI-F03-A：Workspace Layout Tree 纯模型（先红后绿）。
 *
 * 这一组钉的是"布局可以被表达、校验、序列化"这件事本身，**不碰任何 React / DOM / 磁盘**：
 * - 旧模型只能表达 `single | vertical` 两窗格（`types.ts:8`、`types.ts:14`），
 *   上下分屏、嵌套分屏、多组标签都写不出来；
 * - 旧 `splitRatio` 是 25~75 的百分比整数（`workspace-reducer.ts:22-23`），
 *   与新模型的 0.1~0.9 比例不是同一个单位，转换时不能直接搬运；
 * - 旧 `LayoutMode = 'vertical'` 指的是"分隔条竖着"，也就是**左右**分屏
 *   （`SplitWorkspace.tsx:126-133` 的 `gridTemplateColumns`）。新模型的
 *   `orientation: 'horizontal'` 才表示左右。两者**命名相反、语义对应**，
 *   转换里写错就会把方向翻过来。
 *
 * 模型层只做结构：它不知道文档、不知道未保存修改、不做授权判断。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_SPLIT_RATIO,
  MAX_LAYOUT_DEPTH,
  MAX_LAYOUT_PANES,
  MAX_SPLIT_RATIO,
  MAX_UI_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  MIN_UI_SPLIT_RATIO,
  V1_MAX_SPLIT_RATIO,
  V1_MIN_SPLIT_RATIO,
  clampLayoutRatio,
  clampUiSplitRatio,
  createLayoutTree,
  findLayoutNode,
  findPaneByGroup,
  layoutPaneCount,
  layoutTreeDepth,
  layoutTreeFromV1,
  listPanes,
  listSplits,
  mergePane,
  parseLayoutTree,
  serializeLayoutTree,
  setSplitRatio,
  splitPane,
  validateLayoutTree,
  type LayoutNode,
  type LayoutTree,
  type PaneNode,
  type SplitNode,
} from '../../apps/shell/src/state/layout-tree.ts';

/* ================================================================== */
/* 夹具                                                                */
/* ================================================================== */

/** 取出成功结果；失败时把错误码带进断言消息，便于定位。 */
function ok<T>(result: { ok: true; value: T } | { ok: false; error: string; detail: string }): T {
  if (!result.ok) assert.fail(`期望成功，实际失败：${result.error}（${result.detail}）`);
  return result.value;
}

/** 取出失败的错误码。 */
function err(result: { ok: true; value: unknown } | { ok: false; error: string; detail: string }): string {
  if (result.ok) assert.fail('期望失败，实际成功');
  return result.error;
}

/**
 * 断言并收窄成 split / pane。
 *
 * 用 `throw` 而不是 `assert.fail`：后者的 `never` 返回在复合条件
 * （`a.type !== 'x' || b.type !== 'x'`）与嵌套属性访问下不一定驱动 TS 窄化，
 * 结果是测试能跑但 `tsc` 报"属性不存在"。
 */
function asSplit(node: LayoutNode): SplitNode {
  if (node.type === 'split') return node;
  throw new Error('期望 split 节点，实际是 pane');
}

function asPane(node: LayoutNode): PaneNode {
  if (node.type === 'pane') return node;
  throw new Error('期望 pane 节点，实际是 split');
}

/** 每片 Pane 的深度（根 = 1）。用来挑"最浅的叶子"做平衡分屏，避免先撞深度上限。 */
function paneDepths(tree: LayoutTree): Array<{ pane: PaneNode; depth: number }> {
  const out: Array<{ pane: PaneNode; depth: number }> = [];
  const walk = (node: LayoutNode, depth: number): void => {
    if (node.type === 'pane') {
      out.push({ pane: node, depth });
      return;
    }
    walk(node.children[0], depth + 1);
    walk(node.children[1], depth + 1);
  };
  walk(tree.root, 1);
  return out;
}

/**
 * 身份生成器：测试里显式给，模型自己绝不生成（不用随机数/时间）。
 *
 * 前缀刻意与手工夹具里的 `p1` / `g1` 区分开：这些用例会在初始单窗格上循环
 * 分屏，若生成器也从 `g1` 起步就会撞上初始身份，测的就不是深度/数量上限了。
 */
function namer(): { node: () => string; group: () => string; split: () => string } {
  let n = 0;
  let g = 0;
  let s = 0;
  return {
    node: () => `gn${(n += 1)}`,
    group: () => `gg${(g += 1)}`,
    split: () => `gs${(s += 1)}`,
  };
}

/* ================================================================== */
/* LTA-01 ~ LTA-05：初始化与分屏                                        */
/* ================================================================== */

test('LTA-01 创建单窗格：身份由调用方注入，版本固定为 1', () => {
  const tree = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  assert.equal(tree.version, 1);
  assert.deepEqual(tree.root, { type: 'pane', nodeId: 'p1', groupId: 'g1' });
  assert.equal(layoutPaneCount(tree), 1);
  assert.equal(layoutTreeDepth(tree), 1);
  assert.equal(validateLayoutTree(tree), null);
});

test('LTA-02 左右分屏：horizontal + ratio 表示第一个子节点的宽度', () => {
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  const tree = ok(
    splitPane(base, {
      paneNodeId: 'p1',
      splitNodeId: 's1',
      newPaneNodeId: 'p2',
      newGroupId: 'g2',
      orientation: 'horizontal',
      position: 'second',
    }),
  );
  assert.deepEqual(tree.root, {
    type: 'split',
    nodeId: 's1',
    orientation: 'horizontal',
    ratio: DEFAULT_SPLIT_RATIO,
    children: [
      { type: 'pane', nodeId: 'p1', groupId: 'g1' },
      { type: 'pane', nodeId: 'p2', groupId: 'g2' },
    ],
  });
  // 原窗格身份必须保留：nodeId 与 groupId 都不会被重新分配
  const left = findLayoutNode(tree, 'p1');
  assert.deepEqual(left, { type: 'pane', nodeId: 'p1', groupId: 'g1' });
  assert.equal(layoutPaneCount(tree), 2);
  assert.equal(layoutTreeDepth(tree), 2);
});

test('LTA-03 上下分屏：vertical + position=first 时新窗格占第一子位', () => {
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  const tree = ok(
    splitPane(base, {
      paneNodeId: 'p1',
      splitNodeId: 's1',
      newPaneNodeId: 'p2',
      newGroupId: 'g2',
      orientation: 'vertical',
      position: 'first',
    }),
  );
  const root = asSplit(tree.root);
  assert.equal(root.orientation, 'vertical');
  assert.deepEqual(
    root.children.map((node) => (node.type === 'pane' ? node.groupId : null)),
    ['g2', 'g1'],
  );
});

test('LTA-04 多层嵌套：在分屏后的子窗格上继续分屏', () => {
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  const two = ok(
    splitPane(base, {
      paneNodeId: 'p1',
      splitNodeId: 's1',
      newPaneNodeId: 'p2',
      newGroupId: 'g2',
      orientation: 'horizontal',
      position: 'second',
    }),
  );
  const three = ok(
    splitPane(two, {
      paneNodeId: 'p2',
      splitNodeId: 's2',
      newPaneNodeId: 'p3',
      newGroupId: 'g3',
      orientation: 'vertical',
      position: 'second',
      ratio: 0.3,
    }),
  );
  assert.equal(layoutPaneCount(three), 3);
  assert.equal(layoutTreeDepth(three), 3);
  assert.equal(listSplits(three).length, 2);
  assert.deepEqual(
    listSplits(three).map((node) => `${node.nodeId}:${node.orientation}:${node.ratio}`),
    ['s1:horizontal:0.5', 's2:vertical:0.3'],
  );
  assert.equal(validateLayoutTree(three), null);
});

test('LTA-05 指定 Pane 分屏：只改目标那一支，另一支原样保留', () => {
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  const two = ok(
    splitPane(base, {
      paneNodeId: 'p1',
      splitNodeId: 's1',
      newPaneNodeId: 'p2',
      newGroupId: 'g2',
      orientation: 'horizontal',
      position: 'second',
    }),
  );
  const edited = ok(
    splitPane(two, {
      paneNodeId: 'p1',
      splitNodeId: 's2',
      newPaneNodeId: 'p3',
      newGroupId: 'g3',
      orientation: 'vertical',
      position: 'first',
    }),
  );
  const editedRoot = asSplit(edited.root);
  const twoRoot = asSplit(two.root);
  // 右支是同一个对象引用：结构化共享，未修改的子树不重建
  assert.equal(editedRoot.children[1], twoRoot.children[1]);
  assert.notEqual(editedRoot.children[0], twoRoot.children[0]);
  assert.deepEqual(listPanes(edited).map((pane) => pane.groupId), ['g3', 'g1', 'g2']);
});

test('LTA-06 修改指定 Split 比例：深层 split 可单独调整，其余节点不动', () => {
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  const two = ok(
    splitPane(base, {
      paneNodeId: 'p1',
      splitNodeId: 's1',
      newPaneNodeId: 'p2',
      newGroupId: 'g2',
      orientation: 'horizontal',
      position: 'second',
    }),
  );
  const three = ok(
    splitPane(two, {
      paneNodeId: 'p2',
      splitNodeId: 's2',
      newPaneNodeId: 'p3',
      newGroupId: 'g3',
      orientation: 'vertical',
      position: 'second',
    }),
  );
  const tuned = ok(setSplitRatio(three, { splitNodeId: 's2', ratio: 0.75 }));
  assert.deepEqual(
    listSplits(tuned).map((node) => `${node.nodeId}:${node.ratio}`),
    ['s1:0.5', 's2:0.75'],
  );
  // 外层 split 没被重写，兄弟子树仍是同一引用
  const tunedRoot = asSplit(tuned.root);
  asPane(tunedRoot.children[0]);
  assert.equal(tunedRoot.children[0], asSplit(three.root).children[0], '未修改的左支必须保持同一对象');
  assert.equal(ok(setSplitRatio(three, { splitNodeId: 's1', ratio: 0.35 })).root.type, 'split');
});

test('LTA-07 比例边界：0.1~0.9 闭区间，NaN/Infinity/越界一律拒绝', () => {
  assert.equal(MIN_SPLIT_RATIO, 0.1);
  assert.equal(MAX_SPLIT_RATIO, 0.9);
  assert.equal(DEFAULT_SPLIT_RATIO, 0.5);

  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  const two = ok(
    splitPane(base, {
      paneNodeId: 'p1',
      splitNodeId: 's1',
      newPaneNodeId: 'p2',
      newGroupId: 'g2',
      orientation: 'horizontal',
      position: 'second',
    }),
  );

  assert.equal(ok(setSplitRatio(two, { splitNodeId: 's1', ratio: 0.1 })).root.type, 'split');
  assert.equal(ok(setSplitRatio(two, { splitNodeId: 's1', ratio: 0.9 })).root.type, 'split');
  assert.equal(err(setSplitRatio(two, { splitNodeId: 's1', ratio: 0.0999 })), 'invalid-ratio');
  assert.equal(err(setSplitRatio(two, { splitNodeId: 's1', ratio: 0.9001 })), 'invalid-ratio');
  assert.equal(err(setSplitRatio(two, { splitNodeId: 's1', ratio: Number.NaN })), 'invalid-ratio');
  assert.equal(err(setSplitRatio(two, { splitNodeId: 's1', ratio: Number.POSITIVE_INFINITY })), 'invalid-ratio');
  assert.equal(
    err(setSplitRatio(two, { splitNodeId: 's1', ratio: '0.4' as unknown as number })),
    'invalid-ratio',
  );
  // 分屏时显式传参同样受同一套边界约束
  assert.equal(
    err(
      splitPane(base, {
        paneNodeId: 'p1',
        splitNodeId: 's9',
        newPaneNodeId: 'p9',
        newGroupId: 'g9',
        orientation: 'horizontal',
        position: 'second',
        ratio: 0.95,
      }),
    ),
    'invalid-ratio',
  );
  // 供 UI 拖动使用的钳制工具：边界集中在这里，调用方不要再抄一份
  assert.equal(clampLayoutRatio(Number.NaN), DEFAULT_SPLIT_RATIO);
  assert.equal(clampLayoutRatio(0), MIN_SPLIT_RATIO);
  assert.equal(clampLayoutRatio(2), MAX_SPLIT_RATIO);
  assert.equal(clampLayoutRatio(0.42), 0.42);
});

/* ================================================================== */
/* LTA-08 ~ LTA-10：合并窗格                                            */
/* ================================================================== */

test('LTA-08 合并根层 Pane：父 split 消失，兄弟提升为根', () => {
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  const two = ok(
    splitPane(base, {
      paneNodeId: 'p1',
      splitNodeId: 's1',
      newPaneNodeId: 'p2',
      newGroupId: 'g2',
      orientation: 'horizontal',
      position: 'second',
    }),
  );
  const merged = ok(mergePane(two, { groupId: 'g1' }));
  assert.deepEqual(merged, { version: 1, root: { type: 'pane', nodeId: 'p2', groupId: 'g2' } });
  assert.equal(layoutTreeDepth(merged), 1);
});

test('LTA-09 合并嵌套 Pane：只塌陷直接父 split，其他分屏结构保留', () => {
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  const two = ok(
    splitPane(base, {
      paneNodeId: 'p1',
      splitNodeId: 's1',
      newPaneNodeId: 'p2',
      newGroupId: 'g2',
      orientation: 'horizontal',
      position: 'second',
    }),
  );
  const three = ok(
    splitPane(two, {
      paneNodeId: 'p2',
      splitNodeId: 's2',
      newPaneNodeId: 'p3',
      newGroupId: 'g3',
      orientation: 'vertical',
      position: 'second',
      ratio: 0.6,
    }),
  );
  // 合并 g3：s2 塌陷，p2 顶到 s2 原来的位置（s1 的右子）
  const merged = ok(mergePane(three, { groupId: 'g3' }));
  assert.deepEqual(merged.root, {
    type: 'split',
    nodeId: 's1',
    orientation: 'horizontal',
    ratio: 0.5,
    children: [
      { type: 'pane', nodeId: 'p1', groupId: 'g1' },
      { type: 'pane', nodeId: 'p2', groupId: 'g2' },
    ],
  });
  assert.equal(findLayoutNode(merged, 's2'), null);
  assert.equal(findLayoutNode(merged, 's1')?.type, 'split');

  // 合并中间层：g2 塌陷后 s1 只剩 p1 与 p3 之外的结构不被误伤
  const mergedMid = ok(mergePane(three, { groupId: 'g2' }));
  const mergedMidRoot = asSplit(mergedMid.root);
  assert.equal(mergedMidRoot.children[1].type, 'pane');
  assert.deepEqual(listPanes(mergedMid).map((pane) => pane.groupId), ['g1', 'g3']);
});

test('LTA-10 禁止删除最后一个 Pane', () => {
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  assert.equal(err(mergePane(base, { groupId: 'g1' })), 'last-pane');
  assert.equal(err(mergePane(base, { groupId: 'nope' })), 'pane-not-found');
});

/* ================================================================== */
/* LTA-11 ~ LTA-16：不变量                                              */
/* ================================================================== */

const PANE = (nodeId: string, groupId: string): PaneNode => ({ type: 'pane', nodeId, groupId });

test('LTA-11 重复 nodeId 拒绝（pane 与 split 共用同一命名空间）', () => {
  assert.equal(
    validateLayoutTree({
      version: 1,
      root: {
        type: 'split',
        nodeId: 'same',
        orientation: 'horizontal',
        ratio: 0.5,
        children: [PANE('same', 'g1'), PANE('p2', 'g2')],
      },
    })?.error,
    'duplicate-node-id',
  );
  assert.equal(
    validateLayoutTree({ version: 1, root: { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.5, children: [PANE('p1', 'g1'), PANE('p1', 'g2')] } })
      ?.error,
    'duplicate-node-id',
  );
  // 通过公开入口分屏时同样拦住
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  assert.equal(
    err(
      splitPane(base, {
        paneNodeId: 'p1',
        splitNodeId: 's1',
        newPaneNodeId: 'p1',
        newGroupId: 'g2',
        orientation: 'horizontal',
        position: 'second',
      }),
    ),
    'duplicate-node-id',
  );
});

test('LTA-12 重复 groupId 拒绝（同一视图组不能出现在两个 Pane）', () => {
  assert.equal(
    validateLayoutTree({
      version: 1,
      root: {
        type: 'split',
        nodeId: 's1',
        orientation: 'vertical',
        ratio: 0.5,
        children: [PANE('p1', 'same'), PANE('p2', 'same')],
      },
    })?.error,
    'duplicate-group-id',
  );
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  assert.equal(
    err(
      splitPane(base, {
        paneNodeId: 'p1',
        splitNodeId: 's1',
        newPaneNodeId: 'p2',
        newGroupId: 'g1',
        orientation: 'horizontal',
        position: 'second',
      }),
    ),
    'duplicate-group-id',
  );
});

test('LTA-13 非法节点与非法身份拒绝：null / 未知 type / 子节点数不为 2 / 空身份 / 版本不对', () => {
  assert.equal(validateLayoutTree(null)?.error, 'invalid-tree');
  assert.equal(validateLayoutTree('x')?.error, 'invalid-tree');
  assert.equal(validateLayoutTree({})?.error, 'invalid-tree');
  assert.equal(validateLayoutTree({ version: 2, root: PANE('p1', 'g1') })?.error, 'invalid-tree');
  assert.equal(
    validateLayoutTree({ version: 1, root: { type: 'grid', nodeId: 'x' } })?.error,
    'invalid-node',
  );
  assert.equal(
    validateLayoutTree({
      version: 1,
      root: { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.5, children: [PANE('p1', 'g1')] },
    })?.error,
    'invalid-split',
  );
  assert.equal(
    validateLayoutTree({
      version: 1,
      root: { type: 'split', nodeId: 's1', orientation: 'diagonal', ratio: 0.5, children: [PANE('p1', 'g1'), PANE('p2', 'g2')] },
    })?.error,
    'invalid-orientation',
  );
  assert.equal(validateLayoutTree({ version: 1, root: PANE('', 'g1') })?.error, 'empty-identity');
  assert.equal(validateLayoutTree({ version: 1, root: PANE('p1', '  ') })?.error, 'empty-identity');
  // 创建入口同样拒绝空身份
  assert.equal(err(createLayoutTree({ nodeId: '', groupId: 'g1' })), 'empty-identity');
  assert.equal(err(createLayoutTree({ nodeId: 'p1', groupId: '' })), 'empty-identity');
});

test('LTA-14 非法比例拒绝：NaN / Infinity / 缺失 / 字符串 / 越界', () => {
  const split = (ratio: unknown): unknown => ({
    version: 1,
    root: { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio, children: [PANE('p1', 'g1'), PANE('p2', 'g2')] },
  });
  assert.equal(validateLayoutTree(split(Number.NaN))?.error, 'invalid-ratio');
  assert.equal(validateLayoutTree(split(Number.NEGATIVE_INFINITY))?.error, 'invalid-ratio');
  assert.equal(validateLayoutTree(split(undefined))?.error, 'invalid-ratio');
  assert.equal(validateLayoutTree(split('0.5'))?.error, 'invalid-ratio');
  assert.equal(validateLayoutTree(split(0.05))?.error, 'invalid-ratio');
  assert.equal(validateLayoutTree(split(0.95))?.error, 'invalid-ratio');
  assert.equal(validateLayoutTree(split(0.9)), null);
  assert.equal(validateLayoutTree(split(0.1)), null);
});

test('LTA-15 超过最大嵌套深度拒绝：模型保护上限 8', () => {
  assert.equal(MAX_LAYOUT_DEPTH, 8);
  const namer0 = namer();
  let tree = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  let leaf = 'p1';
  // 深度 1 → 2 → ... → 8：七次分屏都用同一个叶子，深度线性增长
  for (let index = 0; index < MAX_LAYOUT_DEPTH - 1; index += 1) {
    const newPane = namer0.node();
    tree = ok(
      splitPane(tree, {
        paneNodeId: leaf,
        splitNodeId: namer0.split(),
        newPaneNodeId: newPane,
        newGroupId: namer0.group(),
        orientation: 'vertical',
        position: 'second',
      }),
    );
    leaf = newPane;
  }
  assert.equal(layoutTreeDepth(tree), MAX_LAYOUT_DEPTH);
  assert.equal(err(
    splitPane(tree, {
      paneNodeId: leaf,
      splitNodeId: 's-overflow',
      newPaneNodeId: 'n-overflow',
      newGroupId: 'g-overflow',
      orientation: 'horizontal',
      position: 'second',
    }),
  ), 'depth-exceeded');
  // 手写一份"深度 9"的树也必须被校验拦住
  let deep: LayoutNode = PANE('leaf', 'gleaf');
  for (let level = 0; level < MAX_LAYOUT_DEPTH; level += 1) {
    deep = {
      type: 'split',
      nodeId: `sd${level}`,
      orientation: 'horizontal',
      ratio: 0.5,
      children: [deep, PANE(`pd${level}`, `gd${level}`)],
    };
  }
  assert.equal(validateLayoutTree({ version: 1, root: deep })?.error, 'depth-exceeded');
});

test('LTA-16 超过 Pane 上限拒绝：模型保护上限 16', () => {
  assert.equal(MAX_LAYOUT_PANES, 16);
  const namer0 = namer();
  let tree = ok(createLayoutTree({ nodeId: 'n1', groupId: 'g1' }));
  // 每次挑"最浅的叶子"分屏，得到平衡树（深度 ~5，不会先撞深度上限）
  while (layoutPaneCount(tree) < MAX_LAYOUT_PANES) {
    const depths = paneDepths(tree);
    const shallowest = depths.reduce((best, item) => (item.depth < best.depth ? item : best));
    tree = ok(
      splitPane(tree, {
        paneNodeId: shallowest.pane.nodeId,
        splitNodeId: namer0.split(),
        newPaneNodeId: namer0.node(),
        newGroupId: namer0.group(),
        orientation: 'horizontal',
        position: 'second',
      }),
    );
  }
  assert.equal(layoutPaneCount(tree), MAX_LAYOUT_PANES);
  assert.ok(layoutTreeDepth(tree) <= MAX_LAYOUT_DEPTH, '平衡构造不应触发深度上限');
  const depths = paneDepths(tree);
  const shallowest = depths.reduce((best, item) => (item.depth < best.depth ? item : best));
  assert.equal(
    err(
      splitPane(tree, {
        paneNodeId: shallowest.pane.nodeId,
        splitNodeId: 's-overflow',
        newPaneNodeId: 'n-overflow',
        newGroupId: 'g-overflow',
        orientation: 'horizontal',
        position: 'second',
      }),
    ),
    'pane-limit-exceeded',
  );
});

/* ================================================================== */
/* LTA-17 ~ LTA-19：V1 兼容转换                                         */
/* ================================================================== */

test('LTA-17 V1 单视图转换：single → 单 Pane，不携带任何文档身份', () => {
  const tree = ok(
    layoutTreeFromV1(
      { ui: { layout: 'single', splitRatio: 50 }, panes: { primary: { tabIndex: 0 }, secondary: { tabIndex: null } } },
      { primary: { nodeId: 'p1', groupId: 'g1' } },
    ),
  );
  assert.deepEqual(tree, { version: 1, root: { type: 'pane', nodeId: 'p1', groupId: 'g1' } });
  // 树上只有结构：没有 docId / viewId / sessionId / tabIndex 之类残留
  const text = ok(serializeLayoutTree(tree));
  for (const forbidden of ['docId', 'viewId', 'sessionId', 'tabIndex', 'path']) {
    assert.equal(text.includes(forbidden), false, `布局树不得包含 ${forbidden}`);
  }
});

test('LTA-18 V1 双视图转换：旧 vertical 是左右分屏，ratio 从百分比换成比例', () => {
  const tree = ok(
    layoutTreeFromV1(
      { ui: { layout: 'vertical', splitRatio: 62 }, panes: { primary: { tabIndex: 0 }, secondary: { tabIndex: 1 } } },
      {
        primary: { nodeId: 'p1', groupId: 'g1' },
        secondary: { nodeId: 'p2', groupId: 'g2' },
        splitNodeId: 's1',
      },
    ),
  );
  assert.deepEqual(tree.root, {
    type: 'split',
    // 关键：V1 的 'vertical' → 新模型的 'horizontal'（左右）
    nodeId: 's1',
    orientation: 'horizontal',
    ratio: 0.62,
    children: [
      { type: 'pane', nodeId: 'p1', groupId: 'g1' },
      { type: 'pane', nodeId: 'p2', groupId: 'g2' },
    ],
  });
  // 边界值也要能通过（25 / 75 是旧 reducer 的钳制区间）
  const narrow = ok(
    layoutTreeFromV1(
      { ui: { layout: 'vertical', splitRatio: 25 }, panes: { primary: { tabIndex: 0 }, secondary: { tabIndex: 1 } } },
      { primary: { nodeId: 'a', groupId: 'ga' }, secondary: { nodeId: 'b', groupId: 'gb' }, splitNodeId: 's' },
    ),
  );
  assert.equal(narrow.root.type === 'split' ? narrow.root.ratio : null, 0.25);
});

test('LTA-19 非法 V1 输入拒绝：未知 layout / 非法比例 / 缺结构 / 缺身份', () => {
  const identity = {
    primary: { nodeId: 'p1', groupId: 'g1' },
    secondary: { nodeId: 'p2', groupId: 'g2' },
    splitNodeId: 's1',
  };
  const panes = { primary: { tabIndex: 0 }, secondary: { tabIndex: 1 } };

  assert.equal(
    err(layoutTreeFromV1({ ui: { layout: 'horizontal', splitRatio: 50 }, panes }, identity)),
    'invalid-v1',
  );
  assert.equal(
    err(layoutTreeFromV1({ ui: { layout: 'vertical', splitRatio: Number.NaN }, panes }, identity)),
    'invalid-ratio',
  );
  assert.equal(
    err(layoutTreeFromV1({ ui: { layout: 'vertical', splitRatio: 5 }, panes }, identity)),
    'invalid-ratio',
  );
  assert.equal(err(layoutTreeFromV1(null, identity)), 'invalid-v1');
  assert.equal(err(layoutTreeFromV1({ ui: { layout: 'single', splitRatio: 50 } }, identity)), 'invalid-v1');
  // 双视图缺 secondary / splitNodeId 身份：明确报错，不静默编一个
  assert.equal(
    err(
      layoutTreeFromV1(
        { ui: { layout: 'vertical', splitRatio: 50 }, panes },
        { primary: { nodeId: 'p1', groupId: 'g1' } },
      ),
    ),
    'empty-identity',
  );
  assert.equal(
    err(
      layoutTreeFromV1(
        { ui: { layout: 'single', splitRatio: 50 }, panes },
        { primary: { nodeId: '', groupId: 'g1' } },
      ),
    ),
    'empty-identity',
  );
  // 旧 splitRatio 即使越界也不得被静默钳制成一个"看起来正常"的布局
  assert.equal(
    err(layoutTreeFromV1({ ui: { layout: 'vertical', splitRatio: 96 }, panes }, identity)),
    'invalid-ratio',
  );
});

/* ================================================================== */
/* LTA-20 ~ LTA-22：不可变、结构一致、序列化                             */
/* ================================================================== */

test('LTA-20 原对象不可变性：所有操作返回新树，入参一个字节都不变', () => {
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  const baseText = JSON.stringify(base);
  const baseRoot = base.root;

  const two = ok(
    splitPane(base, {
      paneNodeId: 'p1',
      splitNodeId: 's1',
      newPaneNodeId: 'p2',
      newGroupId: 'g2',
      orientation: 'horizontal',
      position: 'second',
    }),
  );
  assert.equal(JSON.stringify(base), baseText);
  assert.equal(base.root, baseRoot);

  const twoText = JSON.stringify(two);
  const tuned = ok(setSplitRatio(two, { splitNodeId: 's1', ratio: 0.7 }));
  assert.equal(JSON.stringify(two), twoText);

  const merged = ok(mergePane(two, { groupId: 'g1' }));
  assert.equal(JSON.stringify(two), twoText);

  // 失败路径同样不得改动入参
  const before = JSON.stringify(tuned);
  err(setSplitRatio(tuned, { splitNodeId: 's1', ratio: 5 }));
  err(mergePane(tuned, { groupId: 'missing' }));
  assert.equal(JSON.stringify(tuned), before);
  assert.notEqual(merged, two);
});

test('LTA-21 分屏后合并的结构一致性：split(p) → merge 得到与 p 等价的结构', () => {
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));

  // 单窗格：分屏再造一个新窗格，合并新窗格 → 回到原始单窗格
  const two = ok(
    splitPane(base, {
      paneNodeId: 'p1',
      splitNodeId: 's1',
      newPaneNodeId: 'p2',
      newGroupId: 'g2',
      orientation: 'horizontal',
      position: 'second',
    }),
  );
  assert.deepEqual(ok(mergePane(two, { groupId: 'g2' })), base);

  // 三层：在 p2 上分屏再合并，回到两层结构
  const three = ok(
    splitPane(two, {
      paneNodeId: 'p2',
      splitNodeId: 's2',
      newPaneNodeId: 'p3',
      newGroupId: 'g3',
      orientation: 'vertical',
      position: 'first',
      ratio: 0.4,
    }),
  );
  assert.deepEqual(ok(mergePane(three, { groupId: 'g3' })), two);

  // 上下 → 左右交替后合并，方向与比例都不串位
  const mixed = ok(
    splitPane(two, {
      paneNodeId: 'p1',
      splitNodeId: 's2',
      newPaneNodeId: 'p3',
      newGroupId: 'g3',
      orientation: 'vertical',
      position: 'first',
      ratio: 0.25,
    }),
  );
  const back = ok(mergePane(mixed, { groupId: 'g1' }));
  const backRoot = asSplit(back.root);
  assert.equal(backRoot.orientation, 'horizontal');
  assert.equal(backRoot.ratio, 0.5);
  assert.deepEqual(
    backRoot.children.map((node) => (node.type === 'pane' ? node.groupId : 'split')),
    ['g3', 'g2'],
  );
});

test('LTA-22 序列化与解析后的模型一致性：round-trip 等价且再次校验通过', () => {
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  const two = ok(
    splitPane(base, {
      paneNodeId: 'p1',
      splitNodeId: 's1',
      newPaneNodeId: 'p2',
      newGroupId: 'g2',
      orientation: 'horizontal',
      position: 'second',
      ratio: 0.35,
    }),
  );
  const three = ok(
    splitPane(two, {
      paneNodeId: 'p2',
      splitNodeId: 's2',
      newPaneNodeId: 'p3',
      newGroupId: 'g3',
      orientation: 'vertical',
      position: 'second',
      ratio: 0.65,
    }),
  );

  const text = ok(serializeLayoutTree(three));
  const revived = ok(parseLayoutTree(JSON.parse(text)));
  assert.deepEqual(revived, three);
  assert.equal(validateLayoutTree(revived), null);
  // 再序列化一次必须逐字节相同（稳定输出，便于比对与去重）
  assert.equal(ok(serializeLayoutTree(revived)), text);

  // 解析入口 fail-closed：形状不对就拒绝，不做"尽力修复"
  assert.equal(err(parseLayoutTree('not a tree')), 'invalid-tree');
  assert.equal(err(parseLayoutTree({ version: 9, root: PANE('p1', 'g1') })), 'invalid-tree');
  assert.equal(err(serializeLayoutTree({ version: 1, root: PANE('', 'g1') } as LayoutTree)), 'empty-identity');
});

/* ================================================================== */
/* LTA-23：查询入口                                                     */
/* ================================================================== */

test('LTA-23 查询：按 nodeId / groupId 定位，Pane 与 Split 列表按左→右顺序', () => {
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  const two = ok(
    splitPane(base, {
      paneNodeId: 'p1',
      splitNodeId: 's1',
      newPaneNodeId: 'p2',
      newGroupId: 'g2',
      orientation: 'horizontal',
      position: 'second',
    }),
  );
  const three = ok(
    splitPane(two, {
      paneNodeId: 'p2',
      splitNodeId: 's2',
      newPaneNodeId: 'p3',
      newGroupId: 'g3',
      orientation: 'vertical',
      position: 'second',
    }),
  );

  assert.equal(findLayoutNode(three, 's1')?.type, 'split');
  assert.equal(findLayoutNode(three, 'missing'), null);
  assert.deepEqual(findPaneByGroup(three, 'g3'), { type: 'pane', nodeId: 'p3', groupId: 'g3' });
  assert.equal(findPaneByGroup(three, 'missing'), null);
  assert.deepEqual(listPanes(three).map((pane) => pane.nodeId), ['p1', 'p2', 'p3']);
  assert.deepEqual(listSplits(three).map((node) => node.nodeId), ['s1', 's2']);
  assert.equal(layoutPaneCount(three), 3);
  assert.equal(layoutTreeDepth(three), 3);
  // 只读：查询不得改动树
  assert.equal(JSON.stringify(three).includes('"nodeId":"p1"'), true);
  assert.equal(findLayoutNode(three, 's1') === findLayoutNode(three, 's1'), true);
});

/* ================================================================== */
/* LTA-24：循环引用（损坏数据）                                          */
/* ================================================================== */

test('LTA-24 循环引用拒绝：同一节点对象被复用成 DAG / 真环都 fail-closed', () => {
  const leaf = PANE('p1', 'g1');
  const cyclic: { type: string; nodeId: string; orientation: string; ratio: number; children: unknown[] } = {
    type: 'split',
    nodeId: 's1',
    orientation: 'horizontal',
    ratio: 0.5,
    children: [leaf, leaf],
  };
  // 同一个对象当两个子节点：既是重复 nodeId，也是结构复用
  assert.notEqual(validateLayoutTree({ version: 1, root: cyclic }), null);

  const self: Record<string, unknown> = { type: 'split', nodeId: 's2', orientation: 'horizontal', ratio: 0.5 };
  self.children = [PANE('p2', 'g2'), self];
  const problem = validateLayoutTree({ version: 1, root: self });
  assert.notEqual(problem, null);
  assert.equal(problem?.error, 'cyclic-tree');
});

/* ================================================================== */
/* LTA-25 ~ LTA-29：严格字段白名单（R1 / P1）                            */
/*                                                                     */
/* 只校验"必需字段在不在"是不够的：外部对象里混进来的 `docId` /          */
/* `sessionId` / `path` / `viewId` 会跟着树一起被序列化、被恢复、被当成  */
/* 布局的一部分。布局树必须是**封闭**的——多一个字段就拒绝。              */
/* ================================================================== */

test('LTA-25 根对象只允许 version 与 root，多一个字段就拒绝', () => {
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  assert.equal(validateLayoutTree(base), null);

  assert.equal(validateLayoutTree({ ...base, docId: 'd1' })?.error, 'unexpected-field');
  assert.equal(validateLayoutTree({ ...base, workspaceKey: 'wk' })?.error, 'unexpected-field');
  assert.equal(validateLayoutTree({ ...base, savedAt: '2026-01-01' })?.error, 'unexpected-field');
  // 拒绝就是拒绝：不返回一棵"已经丢掉多余字段"的树
  assert.equal(err(parseLayoutTree({ ...base, sessionId: 's1' })), 'unexpected-field');
});

test('LTA-26 PaneNode 只允许 type / nodeId / groupId', () => {
  const pane = { type: 'pane', nodeId: 'p1', groupId: 'g1' };
  assert.equal(validateLayoutTree({ version: 1, root: pane }), null);

  for (const extra of ['docId', 'sessionId', 'path', 'viewId', 'anchor', 'tabIndex']) {
    assert.equal(
      validateLayoutTree({ version: 1, root: { ...pane, [extra]: 'x' } })?.error,
      'unexpected-field',
      `Pane 不应接受字段 ${extra}`,
    );
  }
});

test('LTA-27 SplitNode 只允许 type / nodeId / orientation / ratio / children', () => {
  const split = {
    type: 'split',
    nodeId: 's1',
    orientation: 'horizontal',
    ratio: 0.5,
    children: [PANE('p1', 'g1'), PANE('p2', 'g2')],
  };
  assert.equal(validateLayoutTree({ version: 1, root: split }), null);

  for (const extra of ['docId', 'viewId', 'panes', 'activeTabId', 'groupId']) {
    assert.equal(
      validateLayoutTree({ version: 1, root: { ...split, [extra]: 'x' } })?.error,
      'unexpected-field',
      `Split 不应接受字段 ${extra}`,
    );
  }
});

test('LTA-28 parseLayoutTree 与外部对象彻底脱钩：不是原引用，改原对象不影响解析结果', () => {
  const source = { version: 1, root: { type: 'pane', nodeId: 'p1', groupId: 'g1' } };
  const parsed = ok(parseLayoutTree(source));
  assert.deepEqual(parsed, source);
  // 必须是重建出来的新对象：共享引用会让"解析"变成一句空话
  assert.notEqual(parsed, source);
  assert.notEqual(parsed.root, source.root);

  (source.root as { nodeId: string }).nodeId = 'hacked';
  assert.equal(parsed.root.type === 'pane' ? parsed.root.nodeId : null, 'p1');

  // 嵌套同样要脱钩
  const nested = {
    version: 1,
    root: {
      type: 'split',
      nodeId: 's1',
      orientation: 'horizontal',
      ratio: 0.5,
      children: [PANE('p1', 'g1'), PANE('p2', 'g2')],
    },
  };
  const parsedNested = ok(parseLayoutTree(nested));
  const sourceRoot = nested.root as { children: Array<{ nodeId: string }> };
  assert.notEqual(parsedNested.root, nested.root);
  sourceRoot.children[0].nodeId = 'hacked';
  const revivedRoot = parsedNested.root;
  assert.equal(
    revivedRoot.type === 'split' && revivedRoot.children[0].type === 'pane'
      ? revivedRoot.children[0].nodeId
      : null,
    'p1',
  );
});

test('LTA-29 serializeLayoutTree 只输出白名单字段', () => {
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  const text = ok(serializeLayoutTree(base));
  assert.deepEqual(Object.keys(JSON.parse(text) as object).sort(), ['root', 'version']);
  assert.deepEqual(
    Object.keys((JSON.parse(text) as { root: object }).root).sort(),
    ['groupId', 'nodeId', 'type'],
  );

  // 带额外字段的树不许被"照原样"序列化出去
  assert.equal(
    err(serializeLayoutTree({ ...base, docId: 'd1' } as unknown as LayoutTree)),
    'unexpected-field',
  );
});

/* ================================================================== */
/* LTA-30 ~ LTA-31：修改入口对损坏输入的防护（R1 / P2）                  */
/*                                                                     */
/* `replaceNode` / `removePane` 是**无保护递归**：环状输入在 validate 之前 */
/* 进入递归就是栈溢出。三个入口必须"先验证、后动手"。                    */
/* ================================================================== */

/** 环状输入：根 split 的第二个孩子指回自己。 */
function cyclicLayout(): LayoutTree {
  const self: Record<string, unknown> = {
    type: 'split',
    nodeId: 'cyc-s',
    orientation: 'horizontal',
    ratio: 0.5,
  };
  self.children = [PANE('cyc-p', 'cyc-g'), self];
  return { version: 1, root: self as unknown as LayoutNode };
}

test('LTA-30 三个修改入口遇到循环引用都返回 cyclic-tree（不递归、不抛异常）', () => {
  assert.equal(
    err(
      splitPane(cyclicLayout(), {
        paneNodeId: 'cyc-p',
        splitNodeId: 'new-s',
        newPaneNodeId: 'new-p',
        newGroupId: 'new-g',
        orientation: 'vertical',
        position: 'second',
      }),
    ),
    'cyclic-tree',
  );
  assert.equal(err(setSplitRatio(cyclicLayout(), { splitNodeId: 'cyc-s', ratio: 0.6 })), 'cyclic-tree');
  assert.equal(err(mergePane(cyclicLayout(), { groupId: 'cyc-p' })), 'cyclic-tree');
});

test('LTA-31 三个修改入口对结构非法的输入返回输入本身的错误码', () => {
  const broken = {
    version: 1,
    root: {
      type: 'split',
      nodeId: 's1',
      orientation: 'horizontal',
      ratio: 5,
      children: [PANE('p1', 'g1'), PANE('p2', 'g2')],
    },
  } as unknown as LayoutTree;
  assert.equal(
    err(
      splitPane(broken, {
        paneNodeId: 'p1',
        splitNodeId: 's2',
        newPaneNodeId: 'p3',
        newGroupId: 'g3',
        orientation: 'vertical',
        position: 'second',
      }),
    ),
    'invalid-ratio',
  );
  assert.equal(err(setSplitRatio(broken, { splitNodeId: 's1', ratio: 0.5 })), 'invalid-ratio');
  assert.equal(err(mergePane(broken, { groupId: 'g1' })), 'invalid-ratio');

  // 未知节点类型
  const unknown = { version: 1, root: { type: 'grid', nodeId: 'x' } } as unknown as LayoutTree;
  assert.equal(err(mergePane(unknown, { groupId: 'g' })), 'invalid-node');
});

/* ================================================================== */
/* LTA-32：V1 比例必须合旧版真实规则（R1 / P2）                          */
/*                                                                     */
/* 旧 reducer 把 `splitRatio` 当**百分比整数**并钳在 25~75             */
/* （workspace-reducer.ts:22-23,71-74）。20 / 80 / 25.5 从来不是合法的   */
/* 旧值，转换时不能"四舍五入成能用的样子"。                             */
/* ================================================================== */

test('LTA-32 V1 splitRatio 只接受 25~75 的整数', () => {
  const identity = {
    primary: { nodeId: 'p1', groupId: 'g1' },
    secondary: { nodeId: 'p2', groupId: 'g2' },
    splitNodeId: 's1',
  };
  const panes = { primary: { tabIndex: 0 }, secondary: { tabIndex: 1 } };
  const at = (splitRatio: unknown) => ({ ui: { layout: 'vertical', splitRatio }, panes });

  for (const bad of [20, 80, 0, 100, 25.5, 50.0001, 24, 76, -50, 1000]) {
    assert.equal(err(layoutTreeFromV1(at(bad), identity)), 'invalid-ratio', `应拒绝 ${String(bad)}`);
  }
  for (const good of [25, 26, 50, 74, 75]) {
    const tree = ok(layoutTreeFromV1(at(good), identity));
    assert.equal(tree.root.type, 'split');
    assert.equal(tree.root.type === 'split' ? tree.root.ratio : null, good / 100);
  }
  // 常量与旧 reducer 的钳制区间一致，且不等于模型的 0.1~0.9
  assert.equal(V1_MIN_SPLIT_RATIO, 25);
  assert.equal(V1_MAX_SPLIT_RATIO, 75);
  assert.equal(V1_MIN_SPLIT_RATIO / 100, MIN_UI_SPLIT_RATIO);
  assert.equal(V1_MAX_SPLIT_RATIO / 100, MAX_UI_SPLIT_RATIO);
});

/* ================================================================== */
/* LTA-33：分屏位置必须显式校验（R1 / P2）                               */
/* ================================================================== */

test('LTA-33 splitPane 的 position 只接受 first / second', () => {
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  const make = (position: unknown) =>
    splitPane(base, {
      paneNodeId: 'p1',
      splitNodeId: 's1',
      newPaneNodeId: 'p2',
      newGroupId: 'g2',
      orientation: 'horizontal',
      position: position as 'first',
    });

  assert.equal(ok(make('first')).root.type, 'split');
  assert.equal(ok(make('second')).root.type, 'split');
  for (const bad of ['third', '', 'FIRST', null, 0, undefined]) {
    assert.equal(err(make(bad)), 'invalid-position', `应拒绝 ${String(bad)}`);
  }
});

/* ================================================================== */
/* LTA-34：模型结构比例与 UI 拖动比例是两件事（R1 / E）                  */
/* ================================================================== */

test('LTA-34 结构区间 0.1~0.9 与 UI 拖动区间 0.25~0.75 分别定义，互不替代', () => {
  // 模型：只在结构上防止窗格被压成 0
  assert.equal(MIN_SPLIT_RATIO, 0.1);
  assert.equal(MAX_SPLIT_RATIO, 0.9);
  // UI：沿用旧 reducer 的 25~75，保证拖动手感与既有界面一致
  assert.equal(MIN_UI_SPLIT_RATIO, 0.25);
  assert.equal(MAX_UI_SPLIT_RATIO, 0.75);

  assert.equal(clampLayoutRatio(0.05), MIN_SPLIT_RATIO);
  assert.equal(clampLayoutRatio(0.95), MAX_SPLIT_RATIO);
  assert.equal(clampLayoutRatio(0.42), 0.42);

  assert.equal(clampUiSplitRatio(0.05), MIN_UI_SPLIT_RATIO);
  assert.equal(clampUiSplitRatio(0.95), MAX_UI_SPLIT_RATIO);
  assert.equal(clampUiSplitRatio(0.5), 0.5);

  // 结构接受 0.15，但 UI 拖动不会把它拖到那儿
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  const two = ok(
    splitPane(base, {
      paneNodeId: 'p1',
      splitNodeId: 's1',
      newPaneNodeId: 'p2',
      newGroupId: 'g2',
      orientation: 'horizontal',
      position: 'second',
      ratio: 0.15,
    }),
  );
  assert.equal(two.root.type === 'split' ? two.root.ratio : null, 0.15);
  assert.equal(clampUiSplitRatio(0.15), MIN_UI_SPLIT_RATIO);
});

/* ================================================================== */
/* LTA-35 ~ LTA-37：查询入口防御（R2）                                   */
/*                                                                     */
/* 两个查询函数会被 UI 在渲染期高频调用，输入却不一定是 `validateLayoutTree` */
/* 放行过的树（恢复流程、调试面板、测试夹具都能直接递进来）。这里钉的是：    */
/* **查询不得有崩溃面**——未知类型不能穿透，损坏的 children 不能遍历，       */
/* 也不能把损坏节点当成查询结果。                                          */
/* ================================================================== */

/** 把任意（可能损坏的）节点当成树的 root。 */
const asTree = (root: unknown): LayoutTree => ({ version: 1, root }) as unknown as LayoutTree;

test('LTA-35 未知节点类型既不能遍历、也不能作为查询结果', () => {
  const tree = asTree({
    type: 'grid',
    nodeId: 'grid-root',
    children: [PANE('p1', 'g1'), PANE('p2', 'g2')],
  });

  // 不得穿透未知类型去返回它内部的 Pane
  assert.equal(findPaneByGroup(tree, 'g1'), null, 'grid 内部的 Pane 不得被找到');
  assert.equal(findPaneByGroup(tree, 'g2'), null, 'grid 内部的 Pane 不得被找到');
  // 未知类型本身也不是有效节点，哪怕 nodeId 命中
  assert.equal(findLayoutNode(tree, 'grid-root'), null, 'grid 不得作为查询结果');
  // 更不得借用它的 children 找到内部节点
  assert.equal(findLayoutNode(tree, 'p1'), null, 'grid 的子节点不得被遍历');
  assert.equal(findLayoutNode(tree, 'p2'), null, 'grid 的子节点不得被遍历');
});

test('LTA-36 Split 的 children 损坏：不抛异常、不遍历、不返回', () => {
  const brokenSplits: ReadonlyArray<readonly [string, unknown]> = [
    ['缺失 children', { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.5 }],
    [
      'children 长度为 1',
      { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.5, children: [PANE('p1', 'g1')] },
    ],
    [
      'children 长度为 3',
      {
        type: 'split',
        nodeId: 's1',
        orientation: 'horizontal',
        ratio: 0.5,
        children: [PANE('p1', 'g1'), PANE('p2', 'g2'), PANE('p3', 'g3')],
      },
    ],
    [
      'children 含 null',
      { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.5, children: [PANE('p1', 'g1'), null] },
    ],
    [
      'children 含 undefined',
      { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.5, children: [undefined, PANE('p2', 'g2')] },
    ],
    [
      'children 含基本类型',
      { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.5, children: ['p1', PANE('p2', 'g2')] },
    ],
    [
      'children 不是数组',
      {
        type: 'split',
        nodeId: 's1',
        orientation: 'horizontal',
        ratio: 0.5,
        children: { 0: PANE('p1', 'g1'), 1: PANE('p2', 'g2') },
      },
    ],
  ];

  for (const [label, root] of brokenSplits) {
    const tree = asTree(root);
    // 损坏的 split 自己不是有效结果
    assert.equal(findLayoutNode(tree, 's1'), null, `${label}：损坏 split 不得作为结果`);
    // 也不得穿越它去找（哪怕合法的）子节点
    assert.equal(findLayoutNode(tree, 'p1'), null, `${label}：不得遍历 children`);
    assert.equal(findLayoutNode(tree, 'p2'), null, `${label}：不得遍历 children`);
    assert.equal(findPaneByGroup(tree, 'g1'), null, `${label}：不得遍历 children`);
    assert.equal(findPaneByGroup(tree, 'g2'), null, `${label}：不得遍历 children`);
  }

  // 入口本身损坏（root 缺失 / 不是对象）也不得抛
  assert.equal(findLayoutNode(asTree(null), 'x'), null);
  assert.equal(findLayoutNode(asTree(undefined), 'x'), null);
  assert.equal(findLayoutNode(asTree('root'), 'x'), null);
  assert.equal(findPaneByGroup(asTree(null), 'x'), null);
  assert.equal(findPaneByGroup(asTree(42), 'x'), null);
});

test('LTA-37 合法查询行为不变：定位、顺序、引用一致、未命中为 null', () => {
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  const two = ok(
    splitPane(base, {
      paneNodeId: 'p1',
      splitNodeId: 's1',
      newPaneNodeId: 'p2',
      newGroupId: 'g2',
      orientation: 'horizontal',
      position: 'second',
    }),
  );
  const three = ok(
    splitPane(two, {
      paneNodeId: 'p2',
      splitNodeId: 's2',
      newPaneNodeId: 'p3',
      newGroupId: 'g3',
      orientation: 'vertical',
      position: 'second',
      ratio: 0.6,
    }),
  );

  const root = asSplit(three.root);
  const right = asSplit(root.children[1]);

  // 引用一致：返回的就是树里那一个节点，不做任何复制
  assert.equal(findLayoutNode(three, 's1'), root);
  assert.equal(findLayoutNode(three, 'p1'), root.children[0]);
  assert.equal(findLayoutNode(three, 's2'), right);
  assert.equal(findLayoutNode(three, 'p3'), right.children[1]);
  assert.equal(findPaneByGroup(three, 'g1'), root.children[0]);
  assert.equal(findPaneByGroup(three, 'g2'), right.children[0]);
  assert.equal(findPaneByGroup(three, 'g3'), right.children[1]);

  // 未命中一律 null
  assert.equal(findLayoutNode(three, 'nope'), null);
  assert.equal(findPaneByGroup(three, 'nope'), null);

  // split 的 nodeId 与 pane 共用命名空间：都能查到
  assert.equal(findLayoutNode(three, 's1')?.type, 'split');
  assert.equal(findLayoutNode(three, 's2')?.type, 'split');

  /*
   * R4 契约变更（架构裁决，不是为了通过测试而放宽断言）：
   *
   * 旧版本用"两个 Pane 共用同一个 groupId"的**非法**树去分辨左右顺序，断言
   * `findPaneByGroup` 返回左支那一个。这与 R4 统一的 fail-closed 读取契约直接
   * 冲突——重复 `groupId` 破坏模型不变量（`duplicate-group-id`），而"把重复
   * 身份里的第一个当成可信结果"正是本轮明令禁止的行为。所以改为：该树被整体
   * 拒绝，顺序改由**合法**树的 `listPanes` / `listSplits` 钉住。
   */
  const duplicated = asTree({
    type: 'split',
    nodeId: 's-dup',
    orientation: 'horizontal',
    ratio: 0.5,
    children: [PANE('left', 'same'), PANE('right', 'same')],
  });
  assert.equal(validateLayoutTree(duplicated)?.error, 'duplicate-group-id');
  assert.equal(findPaneByGroup(duplicated, 'same'), null, '重复身份不得返回"第一个"');
  assert.equal(findLayoutNode(duplicated, 'left'), null, '非法树不得被部分查询');
  assert.equal(findLayoutNode(duplicated, 'right'), null, '非法树不得被部分查询');
  assert.equal(findLayoutNode(duplicated, 's-dup'), null, '非法树不得被部分查询');

  // 左优先顺序在合法树上验证：Pane 从左到右、Split 父先于子
  assert.deepEqual(listPanes(three).map((pane) => pane.nodeId), ['p1', 'p2', 'p3']);
  assert.deepEqual(listSplits(three).map((node) => node.nodeId), ['s1', 's2']);
});

/* ================================================================== */
/* LTA-38 ~ LTA-40：查询节点的**字段完整性**（R3）                        */
/*                                                                     */
/* `type` 对不代表是个节点。`{type:'pane'}` 缺 `groupId`、`{type:'split'} `*/
/* 缺 `nodeId`/`orientation`/`ratio` 时，它仍是"对象"，但作为 `LayoutNode`  */
/* 是残废的：返回给调用方，下一次读 `groupId` 就是 `undefined`。           */
/* 类型守卫必须证明**必要字段齐备**，而不是只认一个标签。                   */
/* ================================================================== */

test('LTA-38 Pane 缺少 nodeId / groupId 或身份为空时必须被拒绝', () => {
  const brokenPanes: ReadonlyArray<readonly [string, unknown]> = [
    ['缺 nodeId', { type: 'pane', groupId: 'g1' }],
    ['缺 groupId', { type: 'pane', nodeId: 'p1' }],
    ['nodeId 为空串', { type: 'pane', nodeId: '', groupId: 'g1' }],
    ['nodeId 全空白', { type: 'pane', nodeId: '   ', groupId: 'g1' }],
    ['groupId 为空串', { type: 'pane', nodeId: 'p1', groupId: '' }],
    ['groupId 全空白', { type: 'pane', nodeId: 'p1', groupId: '\t\n' }],
    ['nodeId 不是字符串', { type: 'pane', nodeId: 1, groupId: 'g1' }],
    ['groupId 不是字符串', { type: 'pane', nodeId: 'p1', groupId: null }],
  ];

  for (const [label, root] of brokenPanes) {
    const tree = asTree(root);
    // 既是"不作为结果"，也是"不作为入口"
    assert.equal(findLayoutNode(tree, 'p1'), null, `${label}：不得返回残废 Pane`);
    assert.equal(findPaneByGroup(tree, 'g1'), null, `${label}：不得返回残废 Pane`);
    assert.equal(findLayoutNode(tree, ''), null, `${label}：空 nodeId 查询也不得命中`);
  }
});

test('LTA-39 Split 缺少 nodeId / 非法方向 / 比例越界时必须被拒绝', () => {
  const children = [PANE('p1', 'g1'), PANE('p2', 'g2')];
  const brokenSplits: ReadonlyArray<readonly [string, unknown]> = [
    ['缺 nodeId', { type: 'split', orientation: 'horizontal', ratio: 0.5, children }],
    ['nodeId 为空串', { type: 'split', nodeId: '', orientation: 'horizontal', ratio: 0.5, children }],
    ['缺 orientation', { type: 'split', nodeId: 's1', ratio: 0.5, children }],
    ['未知方向', { type: 'split', nodeId: 's1', orientation: 'diagonal', ratio: 0.5, children }],
    ['缺 ratio', { type: 'split', nodeId: 's1', orientation: 'horizontal', children }],
    ['ratio 低于下界', { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.05, children }],
    ['ratio 高于上界', { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.95, children }],
    ['ratio 为 NaN', { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: Number.NaN, children }],
    ['ratio 为 Infinity', { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: Number.POSITIVE_INFINITY, children }],
    ['ratio 是字符串', { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: '0.5', children }],
    ['children 长度为 1', { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.5, children: [PANE('p1', 'g1')] }],
  ];

  for (const [label, root] of brokenSplits) {
    const tree = asTree(root);
    // 结构非法的 split 不得作为结果
    assert.equal(findLayoutNode(tree, 's1'), null, `${label}：不得返回非法 Split`);
    // 也不得借它穿透到（本身合法的）子 Pane
    assert.equal(findPaneByGroup(tree, 'g1'), null, `${label}：不得穿透`);
    assert.equal(findLayoutNode(tree, 'p1'), null, `${label}：不得穿透`);
  }
});

test('LTA-40 Split 含字段不完整的子节点：不穿透、不返回损坏节点', () => {
  const halfPanes: ReadonlyArray<readonly [string, unknown]> = [
    ['子节点缺 groupId', { type: 'pane', nodeId: 'p2' }],
    ['子节点缺 nodeId', { type: 'pane', groupId: 'g2' }],
    ['子节点 groupId 为空', { type: 'pane', nodeId: 'p2', groupId: '' }],
    ['子节点是未知类型', { type: 'grid', nodeId: 'p2', groupId: 'g2' }],
    ['子节点为 null', null],
  ];

  for (const [label, brokenChild] of halfPanes) {
    const tree = asTree({
      type: 'split',
      nodeId: 's1',
      orientation: 'horizontal',
      ratio: 0.5,
      children: [PANE('p1', 'g1'), brokenChild],
    });
    // 整棵树被判定为不可用：左支那一个本来合法的 Pane 也不能被"顺手"找到
    assert.equal(findPaneByGroup(tree, 'g1'), null, `${label}：不得穿过损坏子节点`);
    assert.equal(findLayoutNode(tree, 'p1'), null, `${label}：不得穿过损坏子节点`);
    assert.equal(findLayoutNode(tree, 's1'), null, `${label}：父 split 也因残缺子节点而不可用`);
  }

  // 更深一层：孙节点残缺同样不得穿透
  const nested = asTree({
    type: 'split',
    nodeId: 's1',
    orientation: 'horizontal',
    ratio: 0.5,
    children: [
      PANE('p1', 'g1'),
      {
        type: 'split',
        nodeId: 's2',
        orientation: 'vertical',
        ratio: 0.4,
        children: [PANE('p2', 'g2'), { type: 'pane', nodeId: 'p3' }],
      },
    ],
  });
  assert.equal(findPaneByGroup(nested, 'g2'), null, '孙节点残缺：整树不可用');
  assert.equal(findLayoutNode(nested, 's2'), null, '孙节点残缺：中间 split 也不可用');
});

/* ================================================================== */
/* LTA-41 ~ LTA-45：读取层统一（R4）                                     */
/*                                                                     */
/* 六个公开读取函数共用 `validateLayoutTree` 作为**唯一**合法性权威入口：   */
/* 合法树 → 完整结果；非法树 → `null` / `[]` / `0`。既不抛异常，也不返回   */
/* 部分结果，更不把"重复身份里的第一个"当成可信答案。                       */
/*                                                                     */
/* `null` / `[]` / `0` 是"读不到"，不代表存在一个合法但零窗格的布局：Pane   */
/* 是树的最小单位，`mergePane` 也不允许删到最后一片。需要区分损坏原因的调用  */
/* 方走 `validateLayoutTree`，它给出具体错误码。                          */
/* ================================================================== */

/**
 * 包一层 try：读取入口对普通损坏数据抛异常，本身就是契约违背，
 * 而且要能报出是哪个入口、哪条夹具。
 */
function readSafely<T>(label: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    assert.fail(`${label}：读取入口不得因普通损坏数据抛异常，实际抛出 ${String(error)}`);
  }
}

/** 非法树在六个读取入口上的统一安全结果（外加"权威校验必须拒绝"）。 */
function expectSafeReject(input: unknown, label: string): void {
  const tree = input as LayoutTree;
  assert.equal(readSafely(label, () => findLayoutNode(tree, 'p1')), null, `${label}：findLayoutNode(pane) 必须为 null`);
  assert.equal(readSafely(label, () => findLayoutNode(tree, 's1')), null, `${label}：findLayoutNode(split) 必须为 null`);
  assert.equal(readSafely(label, () => findPaneByGroup(tree, 'g1')), null, `${label}：findPaneByGroup 必须为 null`);
  assert.deepEqual(readSafely(label, () => listPanes(tree)), [], `${label}：listPanes 必须为空数组`);
  assert.deepEqual(readSafely(label, () => listSplits(tree)), [], `${label}：listSplits 必须为空数组`);
  assert.equal(readSafely(label, () => layoutTreeDepth(tree)), 0, `${label}：layoutTreeDepth 必须为 0`);
  assert.equal(readSafely(label, () => layoutPaneCount(tree)), 0, `${label}：layoutPaneCount 必须为 0`);
  // 安全返回值不等于"合法"：权威校验必须给出非空结论
  assert.notEqual(validateLayoutTree(input), null, `${label}：validateLayoutTree 必须拒绝`);
}

/** 测试侧独立实现的左优先先序（不复用被测实现，避免"用被测代码验证被测代码"）。 */
function referencePanes(root: LayoutNode): PaneNode[] {
  const out: PaneNode[] = [];
  const dfs = (node: LayoutNode): void => {
    if (node.type === 'pane') {
      out.push(node);
      return;
    }
    dfs(node.children[0]);
    dfs(node.children[1]);
  };
  dfs(root);
  return out;
}

/** 测试侧独立实现：父节点先于子节点、同层左先右后。 */
function referenceSplits(root: LayoutNode): SplitNode[] {
  const out: SplitNode[] = [];
  const dfs = (node: LayoutNode): void => {
    if (node.type !== 'split') return;
    out.push(node);
    dfs(node.children[0]);
    dfs(node.children[1]);
  };
  dfs(root);
  return out;
}

/** 合法树上的完整读取契约：顺序、数量、深度、引用一致、只读。 */
function expectCompleteReads(tree: LayoutTree, label: string): void {
  assert.equal(validateLayoutTree(tree), null, `${label}：夹具本身必须是合法树`);
  const before = JSON.stringify(tree);

  const panes = referencePanes(tree.root);
  const splits = referenceSplits(tree.root);
  const maxDepth = Math.max(...paneDepths(tree).map((item) => item.depth));

  assert.deepEqual(listPanes(tree), panes, `${label}：listPanes 必须是左优先先序`);
  assert.deepEqual(listSplits(tree), splits, `${label}：listSplits 必须父先于子`);
  assert.equal(layoutPaneCount(tree), panes.length, `${label}：Pane 数量`);
  assert.equal(layoutTreeDepth(tree), maxDepth, `${label}：最大深度`);

  // 引用一致：查到的就是树里那一个节点，不是副本
  for (const pane of panes) {
    assert.equal(findLayoutNode(tree, pane.nodeId), pane, `${label}：findLayoutNode(${pane.nodeId}) 引用一致`);
    assert.equal(findPaneByGroup(tree, pane.groupId), pane, `${label}：findPaneByGroup(${pane.groupId}) 引用一致`);
  }
  for (const split of splits) {
    assert.equal(findLayoutNode(tree, split.nodeId), split, `${label}：findLayoutNode(${split.nodeId}) 引用一致`);
  }
  assert.equal(findLayoutNode(tree, 'no-such-node'), null, `${label}：未命中为 null`);
  assert.equal(findPaneByGroup(tree, 'no-such-group'), null, `${label}：未命中为 null`);

  // 只读：六次查询前后输入一个字节都不变
  assert.equal(JSON.stringify(tree), before, `${label}：查询不得改动输入`);
}

/* ------------------------------ 夹具 ------------------------------ */

/** 非法夹具：结构损坏（null / 缺 root / 未知类型 / children 形状 / 字段残缺）。 */
const BROKEN_STRUCTURE_FIXTURES: ReadonlyArray<readonly [string, unknown, string]> = [
  ['整树为 null', null, 'invalid-tree'],
  ['整树为 undefined', undefined, 'invalid-tree'],
  ['整树是字符串', 'layout', 'invalid-tree'],
  ['整树是数组', [], 'invalid-tree'],
  ['缺少 root', { version: 1 }, 'invalid-tree'],
  ['root 为 null', { version: 1, root: null }, 'invalid-node'],
  ['未知节点类型', { version: 1, root: { type: 'grid', nodeId: 'p1', groupId: 'g1' } }, 'invalid-node'],
  [
    'split 缺少 children',
    { version: 1, root: { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.5 } },
    'invalid-split',
  ],
  [
    'children 长度为 1',
    { version: 1, root: { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.5, children: [PANE('p1', 'g1')] } },
    'invalid-split',
  ],
  [
    'children 长度为 3',
    {
      version: 1,
      root: {
        type: 'split',
        nodeId: 's1',
        orientation: 'horizontal',
        ratio: 0.5,
        children: [PANE('p1', 'g1'), PANE('p2', 'g2'), PANE('p3', 'g3')],
      },
    },
    'invalid-split',
  ],
  [
    'children 不是数组',
    {
      version: 1,
      root: {
        type: 'split',
        nodeId: 's1',
        orientation: 'horizontal',
        ratio: 0.5,
        children: { 0: PANE('p1', 'g1'), 1: PANE('p2', 'g2') },
      },
    },
    'invalid-split',
  ],
  [
    'children 含 null',
    { version: 1, root: { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.5, children: [PANE('p1', 'g1'), null] } },
    'invalid-node',
  ],
  [
    'children 含 undefined',
    { version: 1, root: { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.5, children: [undefined, PANE('p2', 'g2')] } },
    'invalid-node',
  ],
  [
    'children 含基本类型',
    { version: 1, root: { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.5, children: ['p1', PANE('p2', 'g2')] } },
    'invalid-node',
  ],
  [
    '子节点字段残缺',
    {
      version: 1,
      root: { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.5, children: [PANE('p1', 'g1'), { type: 'pane', nodeId: 'p2' }] },
    },
    'empty-identity',
  ],
  [
    '孙节点字段残缺',
    {
      version: 1,
      root: {
        type: 'split',
        nodeId: 's1',
        orientation: 'horizontal',
        ratio: 0.5,
        children: [
          PANE('p1', 'g1'),
          {
            type: 'split',
            nodeId: 's2',
            orientation: 'vertical',
            ratio: 0.4,
            children: [PANE('p2', 'g2'), { type: 'pane', nodeId: 'p3' }],
          },
        ],
      },
    },
    'empty-identity',
  ],
];

/** 根 split 的第二个孩子指回自己。 */
function selfReferencingTree(): unknown {
  const self: Record<string, unknown> = { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.5 };
  self.children = [PANE('p1', 'g1'), self];
  return { version: 1, root: self };
}

/** 两个 split 互相引用：a → b → a。 */
function mutuallyReferencingTree(): unknown {
  const a: Record<string, unknown> = { type: 'split', nodeId: 'sa', orientation: 'horizontal', ratio: 0.5 };
  const b: Record<string, unknown> = { type: 'split', nodeId: 'sb', orientation: 'vertical', ratio: 0.5 };
  a.children = [PANE('p1', 'g1'), b];
  b.children = [PANE('p2', 'g2'), a];
  return { version: 1, root: a };
}

/** 同一个 Pane 对象被两个分支复用（DAG，不是树）。 */
function sharedNodeTree(): unknown {
  const shared = PANE('p1', 'g1');
  return {
    version: 1,
    root: { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.5, children: [shared, shared] },
  };
}

/** 循环 / 复用夹具：延迟构造，因为要先生成对象再互相引用。 */
const CYCLIC_CASES: ReadonlyArray<readonly [string, () => unknown]> = [
  ['根节点自引用', selfReferencingTree],
  ['多层循环引用', mutuallyReferencingTree],
  ['同一节点对象被两个分支复用', sharedNodeTree],
];

/** 非法夹具：模型不变量（身份唯一、版本、白名单、比例、深度、数量）。 */
const INVARIANT_FIXTURES: ReadonlyArray<readonly [string, unknown, string]> = [
  [
    '重复 nodeId',
    { version: 1, root: { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.5, children: [PANE('dup', 'g1'), PANE('dup', 'g2')] } },
    'duplicate-node-id',
  ],
  [
    '重复 groupId',
    { version: 1, root: { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.5, children: [PANE('p1', 'dup'), PANE('p2', 'dup')] } },
    'duplicate-group-id',
  ],
  ['版本非法', { version: 2, root: PANE('p1', 'g1') }, 'invalid-tree'],
  ['版本缺失', { root: PANE('p1', 'g1') }, 'invalid-tree'],
  ['根对象注入额外字段', { version: 1, root: PANE('p1', 'g1'), savedAt: '2026-01-01' }, 'unexpected-field'],
  ['Pane 注入额外字段', { version: 1, root: { type: 'pane', nodeId: 'p1', groupId: 'g1', docId: 'd1' } }, 'unexpected-field'],
  [
    'Split 注入额外字段',
    {
      version: 1,
      root: {
        type: 'split',
        nodeId: 's1',
        orientation: 'horizontal',
        ratio: 0.5,
        children: [PANE('p1', 'g1'), PANE('p2', 'g2')],
        viewId: 'v1',
      },
    },
    'unexpected-field',
  ],
  ['空 nodeId', { version: 1, root: PANE('', 'g1') }, 'empty-identity'],
  ['nodeId 全空白', { version: 1, root: PANE('   ', 'g1') }, 'empty-identity'],
  ['空 groupId', { version: 1, root: PANE('p1', '') }, 'empty-identity'],
  [
    '比例越界',
    { version: 1, root: { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: 0.95, children: [PANE('p1', 'g1'), PANE('p2', 'g2')] } },
    'invalid-ratio',
  ],
  [
    '比例为 NaN',
    { version: 1, root: { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: Number.NaN, children: [PANE('p1', 'g1'), PANE('p2', 'g2')] } },
    'invalid-ratio',
  ],
  [
    '比例是字符串',
    { version: 1, root: { type: 'split', nodeId: 's1', orientation: 'horizontal', ratio: '0.5', children: [PANE('p1', 'g1'), PANE('p2', 'g2')] } },
    'invalid-ratio',
  ],
  [
    '方向非法',
    { version: 1, root: { type: 'split', nodeId: 's1', orientation: 'diagonal', ratio: 0.5, children: [PANE('p1', 'g1'), PANE('p2', 'g2')] } },
    'invalid-orientation',
  ],
  ['超出最大深度', { version: 1, root: deepTreeWithDepth(MAX_LAYOUT_DEPTH + 1) }, 'depth-exceeded'],
  ['超出最大 Pane 数量', { version: 1, root: balancedTreeWithPanes(MAX_LAYOUT_PANES + 1) }, 'pane-limit-exceeded'],
];

/** 造一棵深度恰为 `depth` 的链式树（叶子在最后一层）。 */
function deepTreeWithDepth(depth: number): LayoutNode {
  let node: LayoutNode = PANE('dp-leaf', 'dg-leaf');
  for (let level = 1; level < depth; level += 1) {
    node = {
      type: 'split',
      nodeId: `ds${level}`,
      orientation: 'horizontal',
      ratio: 0.5,
      children: [node, PANE(`dp${level}`, `dg${level}`)],
    };
  }
  return node;
}

/** 造一棵有 `count` 片 Pane 的平衡树：深度 ~log2，先撞数量上限而不是深度上限。 */
function balancedTreeWithPanes(count: number): LayoutNode {
  let serial = 0;
  const build = (size: number): LayoutNode => {
    serial += 1;
    const id = serial;
    if (size === 1) return PANE(`bw-n${id}`, `bw-g${id}`);
    const leftSize = Math.floor(size / 2);
    return {
      type: 'split',
      nodeId: `bw-s${id}`,
      orientation: 'horizontal',
      ratio: 0.5,
      children: [build(leftSize), build(size - leftSize)],
    };
  };
  return build(count);
}

/* --------------------------- 合法夹具 ----------------------------- */

/** 单窗格。 */
function singleLegalTree(): LayoutTree {
  return ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
}

/** 左右分屏：p1 | p2。 */
function horizontalLegalTree(): LayoutTree {
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  return ok(
    splitPane(base, {
      paneNodeId: 'p1',
      splitNodeId: 's1',
      newPaneNodeId: 'p2',
      newGroupId: 'g2',
      orientation: 'horizontal',
      position: 'second',
    }),
  );
}

/** 上下分屏，新窗格占第一子位：g2 在上、g1 在下。 */
function verticalLegalTree(): LayoutTree {
  const base = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  return ok(
    splitPane(base, {
      paneNodeId: 'p1',
      splitNodeId: 's1',
      newPaneNodeId: 'p2',
      newGroupId: 'g2',
      orientation: 'vertical',
      position: 'first',
      ratio: 0.35,
    }),
  );
}

/** 三层嵌套：s1(p1, s2(p2, p3))。 */
function nestedLegalTree(): LayoutTree {
  const three = ok(
    splitPane(horizontalLegalTree(), {
      paneNodeId: 'p2',
      splitNodeId: 's2',
      newPaneNodeId: 'p3',
      newGroupId: 'g3',
      orientation: 'vertical',
      position: 'second',
      ratio: 0.6,
    }),
  );
  return three;
}

/** 深度正好到模型上限：沿同一片叶子连续分屏，Pane 数同时等于深度。 */
function deepestLegalTree(): LayoutTree {
  const namer0 = namer();
  let tree = ok(createLayoutTree({ nodeId: 'p1', groupId: 'g1' }));
  let leaf = 'p1';
  for (let index = 0; index < MAX_LAYOUT_DEPTH - 1; index += 1) {
    const newPane = namer0.node();
    tree = ok(
      splitPane(tree, {
        paneNodeId: leaf,
        splitNodeId: namer0.split(),
        newPaneNodeId: newPane,
        newGroupId: namer0.group(),
        orientation: 'vertical',
        position: 'second',
      }),
    );
    leaf = newPane;
  }
  return tree;
}

/** Pane 数量正好到模型上限：每次分最浅的叶子，构成平衡树。 */
function widestLegalTree(): LayoutTree {
  const namer0 = namer();
  let tree = ok(createLayoutTree({ nodeId: 'n1', groupId: 'g1' }));
  while (layoutPaneCount(tree) < MAX_LAYOUT_PANES) {
    const depths = paneDepths(tree);
    const shallowest = depths.reduce((best, item) => (item.depth < best.depth ? item : best));
    tree = ok(
      splitPane(tree, {
        paneNodeId: shallowest.pane.nodeId,
        splitNodeId: namer0.split(),
        newPaneNodeId: namer0.node(),
        newGroupId: namer0.group(),
        orientation: 'horizontal',
        position: 'second',
      }),
    );
  }
  return tree;
}

function legalFixtures(): ReadonlyArray<readonly [string, LayoutTree]> {
  return [
    ['单窗格', singleLegalTree()],
    ['左右分屏', horizontalLegalTree()],
    ['上下分屏', verticalLegalTree()],
    ['多层嵌套', nestedLegalTree()],
    ['合法最大深度', deepestLegalTree()],
    ['合法最大 Pane 数量', widestLegalTree()],
  ];
}

/* ------------------------------ 用例 ------------------------------ */

test('LTA-41 损坏结构统一拒绝：六个读取入口一律安全失败，不抛异常也不返回部分结果', () => {
  for (const [label, tree, code] of BROKEN_STRUCTURE_FIXTURES) {
    assert.equal(validateLayoutTree(tree)?.error, code, `${label}：权威校验错误码`);
    expectSafeReject(tree, label);
  }
});

test('LTA-42 循环与重复对象统一拒绝：自引用 / 多层环 / 同一对象复用', () => {
  for (const [label, build] of CYCLIC_CASES) {
    const tree = build();
    assert.equal(validateLayoutTree(tree)?.error, 'cyclic-tree', `${label}：环与 DAG 一律判为 cyclic-tree`);
    expectSafeReject(tree, label);
  }
});

test('LTA-43 模型不变量统一拒绝：读取入口不得接受校验已拒绝的布局', () => {
  for (const [label, tree, code] of INVARIANT_FIXTURES) {
    assert.equal(validateLayoutTree(tree)?.error, code, `${label}：权威校验错误码`);
    expectSafeReject(tree, label);
  }
});

test('LTA-44 合法布局读取一致：引用一致、左优先、深度与数量准确、查询不改输入', () => {
  for (const [label, tree] of legalFixtures()) {
    expectCompleteReads(tree, label);
  }

  // 边界夹具的边界值本身要被钉住，否则"最大深度"可能根本不是 8
  const deep = deepestLegalTree();
  assert.equal(layoutTreeDepth(deep), MAX_LAYOUT_DEPTH);
  assert.equal(layoutPaneCount(deep), MAX_LAYOUT_DEPTH);
  const wide = widestLegalTree();
  assert.equal(layoutPaneCount(wide), MAX_LAYOUT_PANES);
  assert.ok(layoutTreeDepth(wide) <= MAX_LAYOUT_DEPTH, '平衡构造不应触发深度上限');

  // 顺序的三个具体形状：单窗格 / 左右 / 上下（新窗格在上）
  assert.deepEqual(listPanes(singleLegalTree()).map((pane) => pane.groupId), ['g1']);
  assert.deepEqual(listPanes(horizontalLegalTree()).map((pane) => pane.groupId), ['g1', 'g2']);
  assert.deepEqual(listPanes(verticalLegalTree()).map((pane) => pane.groupId), ['g2', 'g1']);
  assert.deepEqual(listSplits(nestedLegalTree()).map((node) => node.nodeId), ['s1', 's2']);
});

test('LTA-45 完整校验与读取契约一致：校验拒绝则读取全拒，校验通过则读取完整', () => {
  // 1) 所有非法夹具：校验拒绝 ⇒ 六个入口全部安全拒绝
  for (const [label, tree] of [...BROKEN_STRUCTURE_FIXTURES, ...INVARIANT_FIXTURES]) {
    assert.notEqual(validateLayoutTree(tree), null, `${label}：校验必须拒绝`);
    expectSafeReject(tree, label);
  }
  for (const [label, build] of CYCLIC_CASES) {
    const tree = build();
    assert.notEqual(validateLayoutTree(tree), null, `${label}：校验必须拒绝`);
    expectSafeReject(tree, label);
  }

  // 2) 所有合法夹具：校验通过 ⇒ 读取完整、自洽、非空
  for (const [label, tree] of legalFixtures()) {
    assert.equal(validateLayoutTree(tree), null, `${label}：校验必须通过`);
    const panes = listPanes(tree);
    const splits = listSplits(tree);
    const count = layoutPaneCount(tree);
    const depth = layoutTreeDepth(tree);

    // "安全失败值"不会出现在合法树上：0 / [] 只表示读不到，不表示零窗格
    assert.ok(count > 0, `${label}：合法树不可能零窗格`);
    assert.ok(depth > 0, `${label}：合法树深度至少为 1`);
    assert.equal(panes.length, count, `${label}：listPanes 长度与数量一致`);
    assert.equal(panes.length, referencePanes(tree.root).length, `${label}：Pane 集合完整`);
    assert.equal(splits.length, referenceSplits(tree.root).length, `${label}：Split 集合完整`);
    assert.equal(depth, Math.max(...paneDepths(tree).map((item) => item.depth)), `${label}：深度与结构一致`);
    // 每个 Pane 都能按 nodeId 与 groupId 定位回同一引用
    for (const pane of panes) {
      assert.equal(findLayoutNode(tree, pane.nodeId), pane, `${label}：${pane.nodeId} 可定位`);
      assert.equal(findPaneByGroup(tree, pane.groupId), pane, `${label}：${pane.groupId} 可定位`);
    }
  }
});
