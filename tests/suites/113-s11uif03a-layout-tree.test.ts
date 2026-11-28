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
  MIN_SPLIT_RATIO,
  clampLayoutRatio,
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
