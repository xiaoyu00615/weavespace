/**
 * 目录树"祖先连接线"计算（S11-UX-02A-R1）。
 *
 * 为什么单独成模块：
 * - 一条竖线是否延续，取决于**该层的祖先在同一层是否还有后续兄弟节点**，
 *   而不是取决于缩进宽度。这条规则必须在
 *   `TreeLevel → TreeItem → TreeRow → TreeIndent` 之间显式传递；
 * - 组件是 `.tsx`，Node 测试无法 import（无 JSX 变换），纯函数才能被
 *   `tests/suites` 覆盖，从而锁住"末项祖先不再画线"这一行为。
 *
 * 层级约定与组件一致：`depth` 0 = 项目根，1 = 项目根的直接子项，依次递归。
 * 一行在 `depth` 层占用 `depth` 个缩进列：前 `depth-1` 个是祖先列的延续线，
 * 最后一个是自己的连接线（├ / └）。
 */
/** 一个节点上方各层的"是否还有后续兄弟"标记：index 0 ↔ 第 1 层祖先。 */
export type TreeTrails = readonly boolean[];

/**
 * 进入下一层：把当前节点"是否还有后续兄弟"追加进祖先标记。
 *
 * 只有还有后续兄弟时，后代才需要在这条列上继续画竖线；
 * 末项（`last`）之后不该再有任何线，否则会拖出一条悬空尾巴。
 */
export function descend(trails: TreeTrails, last: boolean): TreeTrails {
  return [...trails, !last];
}

/** 缩进列中某一格的形态：`line` 画竖线，`blank` 只占位（保持对齐）。 */
export type TreeGuide = 'line' | 'blank';

/**
 * `depth` 层的一行需要的前 `depth-1` 个祖先列形态。
 *
 * 祖先还有后续兄弟 → `line`；祖先已是本层末项 → `blank`（占位但不画线）。
 */
export function ancestorGuides(trails: TreeTrails, depth: number): TreeGuide[] {
  const guides: TreeGuide[] = [];
  for (let level = 1; level < depth; level += 1) {
    // trails 缺失（未接线）时按"有后续兄弟"处理，宁可多画线也不让层级断掉
    guides.push(trails[level - 1] === false ? 'blank' : 'line');
  }
  return guides;
}
