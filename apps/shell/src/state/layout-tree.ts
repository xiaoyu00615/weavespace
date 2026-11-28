/**
 * 工作区布局树（UI-F03-A）：**纯结构模型**，不依赖 React / DOM / 磁盘 / Host。
 *
 * 为什么要有它：现有工作区只能表达 `single` 与 `vertical` 两窗格
 * （`types.ts:8` 的 `LayoutMode`、`types.ts:14` 的 `PaneId`），
 * 上下分屏、嵌套分屏、多个独立视图组都写不出来。本模块先把"布局可以被表达、
 * 被校验、被序列化"这件事做成可测试的确定性，再让未来的 WorkspaceState 接上它。
 *
 * 三条纪律，违反任意一条都会让后续重构失去支点：
 *
 * 1. **只做结构**。这里不知道文档、不知道未保存修改、不做授权判断。
 *    "关掉这个视图会不会丢草稿"是 ViewGroup / DocumentSession 管理层的事。
 * 2. **身份由调用方注入**。`nodeId` / `groupId` 一律从参数来，模块内部
 *    绝不使用随机数、时间戳或任何浏览器 API 生成。这样同一份输入永远得到
 *    同一棵树，测试与恢复流程都能逐字节比对。
 * 3. **fail-closed**。非法输入一律返回明确错误码，不"尽力修复"、不静默钳制。
 *    布局是后续所有视图的骨架，宁可拒绝，也不能生成一棵看起来正常但语义错误的树。
 */
/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/**
 * 分屏方向。
 *
 * **特意与旧 `LayoutMode` 的命名相反，这是有意的**：旧代码的
 * `layout === 'vertical'` 指的是"分隔条竖着"，也就是**左右**分屏
 * （`SplitWorkspace.tsx:126-133` 的 `gridTemplateColumns`）。
 * 新模型按更自然的读法命名：
 *
 * - `horizontal` → 左右并排，`ratio` = **第一个子节点的宽度**占比；
 * - `vertical`   → 上下堆叠，`ratio` = **第一个子节点的高度**占比。
 *
 * 从 V1 转换时必须显式把 `'vertical'` 映成 `'horizontal'`，
 * 不能同名搬运（见 `layoutTreeFromV1`）。
 */
export type LayoutOrientation = 'horizontal' | 'vertical';

/** 叶子节点：一个视图组占一个窗格。`groupId` 指向未来的 ViewGroup。 */
export interface PaneNode {
  readonly type: 'pane';
  readonly nodeId: string;
  readonly groupId: string;
}

/**
 * 分支节点：**恰好两个**子节点。
 *
 * 只用二叉树，是因为任意 n 叉分屏都能由两次二叉分屏表达，而二叉的不变量
 * （比例、深度、塌陷）最容易被穷举测试钉住。多叉留给 UI 层做视觉分组，
 * 不进模型。
 */
export interface SplitNode {
  readonly type: 'split';
  readonly nodeId: string;
  readonly orientation: LayoutOrientation;
  readonly ratio: number;
  readonly children: readonly [LayoutNode, LayoutNode];
}

export type LayoutNode = PaneNode | SplitNode;

export interface LayoutTree {
  readonly version: typeof LAYOUT_TREE_VERSION;
  readonly root: LayoutNode;
}

/**
 * 错误码。
 *
 * 分两类：`invalid-*` / `duplicate-*` / `empty-identity` / `cyclic-tree` /
 * `depth-exceeded` / `pane-limit-exceeded` 是**数据非法**（校验失败）；
 * `node-not-found` / `split-not-found` / `pane-not-found` / `last-pane` 是
 * **操作无法执行**（数据本身没问题）。调用方据此决定是"拒绝这份数据"
 * 还是"告诉用户换个目标"。
 */
export type LayoutErrorCode =
  | 'invalid-tree'
  | 'invalid-node'
  | 'invalid-orientation'
  | 'invalid-split'
  | 'invalid-ratio'
  | 'duplicate-node-id'
  | 'duplicate-group-id'
  | 'empty-identity'
  | 'cyclic-tree'
  | 'depth-exceeded'
  | 'pane-limit-exceeded'
  | 'node-not-found'
  | 'split-not-found'
  | 'pane-not-found'
  | 'last-pane'
  | 'invalid-v1';

export interface LayoutProblem {
  readonly error: LayoutErrorCode;
  /**
   * 技术描述（不是给用户看的文案）。
   *
   * 模型层不产出中文提示：错误码 → 文案属于 UI 的职责，写在这里会让
   * 未来换措辞时改动穿透到测试里。
   */
  readonly detail: string;
}

/**
 * 结果类型。
 *
 * 与工程既有风格一致（`add-project.ts:507-508`、`add-project.ts:681`
 * 都用 `{ ok: true } | { ok: false }` 判别联合），但多带一个错误码：
 * 布局失败的原因远多于"名称不合法"一种。
 */
export type LayoutResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LayoutErrorCode; readonly detail: string };

/* ------------------------------------------------------------------ */
/* 常量：边界集中在这里，调用方不要再抄一份                            */
/* ------------------------------------------------------------------ */

export const LAYOUT_TREE_VERSION = 1 as const;

/**
 * 比例边界。
 *
 * 比旧 reducer 的 `25%~75%`（`workspace-reducer.ts:22-23`）更宽，因为旧边界是
 * **UI 拖动的手感限制**，不是结构限制；模型层放宽到 10%~90%，避免把
 * "结构不允许"和"拖动不好用"混成同一条规则。V1 的 25~75 映射过来是
 * 0.25~0.75，天然落在本区间内，转换不会失败。
 */
export const MIN_SPLIT_RATIO = 0.1;
export const MAX_SPLIT_RATIO = 0.9;
export const DEFAULT_SPLIT_RATIO = 0.5;

/**
 * 模型保护上限（不是 UI 展示上限）。
 *
 * 深度 8 意味着最多 7 层嵌套 split；Pane 16 片。两者都只为"挡住损坏数据把
 * 渲染拖垮"，不表示界面必须同时显示这么多窗格。
 */
export const MAX_LAYOUT_DEPTH = 8;
export const MAX_LAYOUT_PANES = 16;

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

function fail<T>(error: LayoutErrorCode, detail: string): LayoutResult<T> {
  return { ok: false, error, detail };
}

/** 身份：必须是 trim 后仍非空的字符串。 */
function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isRatio(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_SPLIT_RATIO &&
    value <= MAX_SPLIT_RATIO
  );
}

function isOrientation(value: unknown): value is LayoutOrientation {
  return value === 'horizontal' || value === 'vertical';
}

/**
 * 供 UI 拖动时使用的钳制工具。
 *
 * 模型 API 自己**不**钳制（非法值直接拒绝，见 `setSplitRatio`）：
 * 静默改小/改大会让调用方以为设置成功了。拖动过程需要连续手感，才用这个，
 * 且边界仍从本模块取，不在组件里再写一遍 0.1 / 0.9。
 */
export function clampLayoutRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPLIT_RATIO;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value));
}

/**
 * 递归校验一个节点。
 *
 * `seen` 用**对象引用**判环：不可变构造不会产生环，但损坏的持久化数据可能
 * 把同一个对象塞进两个分支（DAG），也可能真的自引用。两者都会让遍历无限
 * 或让"一片 Pane"被算两次，必须 fail-closed。
 *
 * `groupIds` 同时承担"Pane 计数"：`groupId` 已被保证唯一，所以它的大小
 * 就是 Pane 数量。
 */
function checkNode(
  value: unknown,
  depth: number,
  seen: Set<object>,
  nodeIds: Set<string>,
  groupIds: Set<string>,
): LayoutProblem | null {
  if (depth > MAX_LAYOUT_DEPTH) {
    return { error: 'depth-exceeded', detail: `嵌套深度超过 ${MAX_LAYOUT_DEPTH}` };
  }
  if (typeof value !== 'object' || value === null) {
    return { error: 'invalid-node', detail: '节点不是对象' };
  }
  if (seen.has(value)) {
    return { error: 'cyclic-tree', detail: '同一个节点对象在树中被引用了两次（环或 DAG）' };
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type !== 'pane' && type !== 'split') {
    return { error: 'invalid-node', detail: `未知节点类型：${String(type)}` };
  }

  const nodeId = record.nodeId;
  if (!isIdentity(nodeId)) {
    return { error: 'empty-identity', detail: 'nodeId 为空' };
  }
  if (nodeIds.has(nodeId)) {
    return { error: 'duplicate-node-id', detail: `nodeId 重复：${nodeId}` };
  }
  nodeIds.add(nodeId);

  if (type === 'pane') {
    const groupId = record.groupId;
    if (!isIdentity(groupId)) {
      return { error: 'empty-identity', detail: `Pane ${nodeId} 的 groupId 为空` };
    }
    if (groupIds.has(groupId)) {
      return { error: 'duplicate-group-id', detail: `groupId 重复：${groupId}` };
    }
    if (groupIds.size + 1 > MAX_LAYOUT_PANES) {
      return { error: 'pane-limit-exceeded', detail: `Pane 数量超过 ${MAX_LAYOUT_PANES}` };
    }
    groupIds.add(groupId);
    return null;
  }

  if (!isOrientation(record.orientation)) {
    return { error: 'invalid-orientation', detail: `未知方向：${String(record.orientation)}` };
  }
  if (!isRatio(record.ratio)) {
    return {
      error: 'invalid-ratio',
      detail: `比例必须是 ${MIN_SPLIT_RATIO}~${MAX_SPLIT_RATIO} 的有限数值，实际：${String(record.ratio)}`,
    };
  }
  const children = record.children;
  if (!Array.isArray(children) || children.length !== 2) {
    return { error: 'invalid-split', detail: 'split 必须恰好有两个子节点' };
  }
  const first = checkNode(children[0], depth + 1, seen, nodeIds, groupIds);
  if (first !== null) return first;
  return checkNode(children[1], depth + 1, seen, nodeIds, groupIds);
}

/**
 * 统一验证入口：`null` = 合法。
 *
 * 参数是 `unknown`（不是 `LayoutTree`），因为它同时用于校验**外部来的**数据：
 * 浏览器存储、测试里的手写对象、未来的 Host 下发。用强类型参数会让
 * "非法输入"根本无法表达，只能靠 `as any` 绕过，那是自欺。
 */
export function validateLayoutTree(value: unknown): LayoutProblem | null {
  if (typeof value !== 'object' || value === null) {
    return { error: 'invalid-tree', detail: '不是对象' };
  }
  const record = value as Record<string, unknown>;
  if (record.version !== LAYOUT_TREE_VERSION) {
    return { error: 'invalid-tree', detail: `不支持的版本：${String(record.version)}` };
  }
  if (!('root' in record)) {
    return { error: 'invalid-tree', detail: '缺少 root' };
  }
  return checkNode(record.root, 1, new Set<object>(), new Set<string>(), new Set<string>());
}

/**
 * 构造完成前的最后一道闸门。
 *
 * 每个修改函数都走这里：先按操作语义改树，再整棵校验。局部检查只负责给出
 * 更准确的"操作类"错误码（找不到节点等），**结构不变量一律由这里兜底**——
 * 少写一个边界就是非法树，这里会当场拦住，不会流到 UI。
 */
function commit(tree: LayoutTree): LayoutResult<LayoutTree> {
  const problem = validateLayoutTree(tree);
  if (problem !== null) return { ok: false, error: problem.error, detail: problem.detail };
  return { ok: true, value: tree };
}

/**
 * 把 `targetId` 那个节点替换成 `make(原节点)`，并只重建**从根到它的路径**。
 *
 * 未修改的分支保持**同一对象引用**（结构化共享）：这让"只调了内层比例"可以被
 * 测试用 `===` 证明外层没被重写，也让未来的 React memo 能真正生效。
 */
function replaceNode(
  node: LayoutNode,
  targetId: string,
  make: (target: LayoutNode) => LayoutNode,
): LayoutNode | null {
  if (node.nodeId === targetId) return make(node);
  if (node.type === 'pane') return null;
  const left = replaceNode(node.children[0], targetId, make);
  if (left !== null) return { ...node, children: [left, node.children[1]] };
  const right = replaceNode(node.children[1], targetId, make);
  if (right !== null) return { ...node, children: [node.children[0], right] };
  return null;
}

/**
 * 移除指定视图组的 Pane；返回 `null` 表示"这个节点就是要被删的那个"。
 *
 * 关键在于**在每一层重新组装**：直接父 split 因为少了一个孩子而自动塌陷
 * （剩下那个孩子顶上来），更上层的结构原样保留。不需要"先找父节点再改父的父"。
 */
function removePane(node: LayoutNode, groupId: string): LayoutNode | null {
  if (node.type === 'pane') return node.groupId === groupId ? null : node;
  const left = removePane(node.children[0], groupId);
  const right = removePane(node.children[1], groupId);
  if (left === null && right === null) return node; // groupId 唯一，理论上不可达
  if (left === null) return right; // 左子被删 → 右子顶上来
  if (right === null) return left; // 右子被删 → 左子顶上来
  if (left === node.children[0] && right === node.children[1]) return node; // 本支没动
  return { ...node, children: [left, right] };
}

/** 深度优先、左 → 右。这个顺序就是屏幕上的视觉顺序，测试据此断言。 */
function walk(node: LayoutNode, visit: (node: LayoutNode, depth: number) => void, depth = 1): void {
  visit(node, depth);
  if (node.type === 'split') {
    walk(node.children[0], visit, depth + 1);
    walk(node.children[1], visit, depth + 1);
  }
}

/* ------------------------------------------------------------------ */
/* 3.1 初始化                                                          */
/* ------------------------------------------------------------------ */

/**
 * 创建单窗格布局。身份由调用方给（不从路径推导、不生成）。
 */
export function createLayoutTree(identity: {
  readonly nodeId: string;
  readonly groupId: string;
}): LayoutResult<LayoutTree> {
  const pane: PaneNode = { type: 'pane', nodeId: identity.nodeId, groupId: identity.groupId };
  return commit({ version: LAYOUT_TREE_VERSION, root: pane });
}

/* ------------------------------------------------------------------ */
/* 3.2 分屏                                                            */
/* ------------------------------------------------------------------ */

export interface SplitPaneInput {
  /** 在哪个 Pane 上分屏（该 Pane 的身份会被原样保留，成为一个子节点）。 */
  readonly paneNodeId: string;
  /** 新 split 的节点身份。 */
  readonly splitNodeId: string;
  /** 新 Pane 的节点身份。 */
  readonly newPaneNodeId: string;
  /** 新 Pane 所属的视图组身份。 */
  readonly newGroupId: string;
  readonly orientation: LayoutOrientation;
  /** 新 Pane 落在第一还是第二个子位。 */
  readonly position: 'first' | 'second';
  /** 缺省 `DEFAULT_SPLIT_RATIO`；始终表示**第一个子节点**的比例。 */
  readonly ratio?: number;
}

/**
 * 在指定 Pane 上分屏。
 *
 * 语义细节（三条都影响后续合并的正确性）：
 * - 被分屏的那个 Pane **保留** `nodeId` 与 `groupId`，只是从叶子变成 split 的一个孩子；
 * - `ratio` 永远指第一个子节点，与 `position` 无关，避免"比例跟着新窗格走"的歧义；
 * - 新 split 的 `nodeId` 必须由调用方指定，模块不生成。
 */
export function splitPane(tree: LayoutTree, input: SplitPaneInput): LayoutResult<LayoutTree> {
  const target = findLayoutNode(tree, input.paneNodeId);
  if (target === null || target.type !== 'pane') {
    return fail('node-not-found', `找不到可分的 pane：${input.paneNodeId}`);
  }
  const ratio = input.ratio === undefined ? DEFAULT_SPLIT_RATIO : input.ratio;
  const newPane: PaneNode = {
    type: 'pane',
    nodeId: input.newPaneNodeId,
    groupId: input.newGroupId,
  };
  const split: SplitNode = {
    type: 'split',
    nodeId: input.splitNodeId,
    orientation: input.orientation,
    ratio,
    children: input.position === 'first' ? [newPane, target] : [target, newPane],
  };
  const root = replaceNode(tree.root, input.paneNodeId, () => split);
  if (root === null) return fail('node-not-found', `找不到可分的 pane：${input.paneNodeId}`);
  return commit({ version: LAYOUT_TREE_VERSION, root });
}

/* ------------------------------------------------------------------ */
/* 3.3 调整比例                                                        */
/* ------------------------------------------------------------------ */

export interface SetSplitRatioInput {
  readonly splitNodeId: string;
  readonly ratio: number;
}

/**
 * 只改指定 split 的比例，其他分屏一动不动。
 *
 * 不做 `Math.round`（旧 reducer 为百分比整数才舍入，见 `workspace-reducer.ts:73`）：
 * 新模型存 0~1 的小数，舍入会丢掉拖动精度。
 */
export function setSplitRatio(tree: LayoutTree, input: SetSplitRatioInput): LayoutResult<LayoutTree> {
  const target = findLayoutNode(tree, input.splitNodeId);
  if (target === null || target.type !== 'split') {
    return fail('split-not-found', `找不到分屏节点：${input.splitNodeId}`);
  }
  const root = replaceNode(tree.root, input.splitNodeId, (node) =>
    node.type === 'split' ? { ...node, ratio: input.ratio } : node,
  );
  if (root === null) return fail('split-not-found', `找不到分屏节点：${input.splitNodeId}`);
  return commit({ version: LAYOUT_TREE_VERSION, root });
}

/* ------------------------------------------------------------------ */
/* 3.4 合并窗格                                                        */
/* ------------------------------------------------------------------ */

export interface MergePaneInput {
  /** 按视图组定位：同一时刻一个视图组只占一个 Pane。 */
  readonly groupId: string;
}

/**
 * 合并（关闭）一个 Pane：删掉它，让它的直接父 split 塌陷，兄弟顶到父的位置。
 *
 * **不判断文档是否有未保存修改**：那是 ViewGroup / DocumentSession 管理层的事。
 * 模型只回答"结构上能不能删"，答案只有"能"（>=2 片）与"不能"（最后一片）。
 */
export function mergePane(tree: LayoutTree, input: MergePaneInput): LayoutResult<LayoutTree> {
  if (findPaneByGroup(tree, input.groupId) === null) {
    return fail('pane-not-found', `找不到视图组对应的 pane：${input.groupId}`);
  }
  if (tree.root.type === 'pane') {
    // 唯一一片：删掉就没有工作区了
    return fail('last-pane', '不能删除最后一个 Pane');
  }
  const root = removePane(tree.root, input.groupId);
  if (root === null) return fail('last-pane', '不能删除最后一个 Pane');
  return commit({ version: LAYOUT_TREE_VERSION, root });
}

/* ------------------------------------------------------------------ */
/* 3.5 查询（只读）                                                    */
/* ------------------------------------------------------------------ */

/**
 * 按 `nodeId` 找节点（pane 与 split 共用命名空间）。
 *
 * 走显式栈而不是递归，是为了即使拿到一棵（不该出现的）环状对象也只返回
 * `null` 而不是爆栈——查询函数会被 UI 在渲染期高频调用，不该有崩溃面。
 */
export function findLayoutNode(tree: LayoutTree, nodeId: string): LayoutNode | null {
  const seen = new Set<object>();
  const stack: LayoutNode[] = [tree.root];
  while (stack.length > 0) {
    const node = stack.pop() as LayoutNode;
    if (seen.has(node)) continue;
    seen.add(node);
    if (node.nodeId === nodeId) return node;
    if (node.type === 'split') {
      stack.push(node.children[1], node.children[0]); // 先压右再压左 → 弹出时左先
    }
  }
  return null;
}

export function findPaneByGroup(tree: LayoutTree, groupId: string): PaneNode | null {
  const seen = new Set<object>();
  const stack: LayoutNode[] = [tree.root];
  while (stack.length > 0) {
    const node = stack.pop() as LayoutNode;
    if (seen.has(node)) continue;
    seen.add(node);
    if (node.type === 'pane') {
      if (node.groupId === groupId) return node;
      continue;
    }
    stack.push(node.children[1], node.children[0]);
  }
  return null;
}

/** 所有 Pane，按屏幕从左到右 / 从上到下（深度优先先左后右）的顺序。 */
export function listPanes(tree: LayoutTree): readonly PaneNode[] {
  const out: PaneNode[] = [];
  walk(tree.root, (node) => {
    if (node.type === 'pane') out.push(node);
  });
  return out;
}

/** 所有 Split，先序（父在子前），同一层左先右后。 */
export function listSplits(tree: LayoutTree): readonly SplitNode[] {
  const out: SplitNode[] = [];
  walk(tree.root, (node) => {
    if (node.type === 'split') out.push(node);
  });
  return out;
}

/** 树的最大深度（只有一个 Pane 时为 1）。 */
export function layoutTreeDepth(tree: LayoutTree): number {
  let max = 0;
  walk(tree.root, (_node, depth) => {
    if (depth > max) max = depth;
  });
  return max;
}

export function layoutPaneCount(tree: LayoutTree): number {
  return listPanes(tree).length;
}

/* ------------------------------------------------------------------ */
/* 4. 序列化                                                           */
/* ------------------------------------------------------------------ */

/**
 * 序列化：先校验再输出，非法树不产出字符串。
 *
 * 输出是稳定的（键序由对象构造决定），所以"序列化 → 解析 → 再序列化"
 * 必须逐字节相同，测试据此断言 round-trip 无损。
 */
export function serializeLayoutTree(tree: LayoutTree): LayoutResult<string> {
  const problem = validateLayoutTree(tree);
  if (problem !== null) return { ok: false, error: problem.error, detail: problem.detail };
  return { ok: true, value: JSON.stringify(tree) };
}

/**
 * 解析外部数据（`JSON.parse` 的结果或任何 `unknown`）为布局树。
 *
 * 不做"尽力修复"：形状不对、版本不对、比例越界都直接拒绝。布局是后续所有
 * 视图的骨架，修复出一棵"看起来能用"的树比报错危险得多。
 */
export function parseLayoutTree(value: unknown): LayoutResult<LayoutTree> {
  const problem = validateLayoutTree(value);
  if (problem !== null) return { ok: false, error: problem.error, detail: problem.detail };
  return { ok: true, value: value as LayoutTree };
}

/* ------------------------------------------------------------------ */
/* 5. V1 兼容转换（纯函数，不接入真实恢复流程）                        */
/* ------------------------------------------------------------------ */

/**
 * V1 转换需要的身份。
 *
 * 全部由调用方提供：`nodeId` / `groupId` 不能从文档路径推导（那会把
 * "哪一行"和"哪个窗格"绑死），更不能在这里生成随机值。
 */
export interface LayoutV1Identity {
  readonly primary: { readonly nodeId: string; readonly groupId: string };
  /** 仅双视图需要。 */
  readonly secondary?: { readonly nodeId: string; readonly groupId: string };
  /** 仅双视图需要：新 split 的节点身份。 */
  readonly splitNodeId?: string;
}

/**
 * V1 快照 → 布局树。
 *
 * V1 的真实语义（已核对源码，不是按名字猜的）：
 *
 * | V1 字段 | 真实含义 | 依据 |
 * |---|---|---|
 * | `ui.layout === 'single'` | 单窗格 | `types.ts:8` + `SplitWorkspace.tsx:116-122` |
 * | `ui.layout === 'vertical'` | **左右**分屏（`gridTemplateColumns`） | `SplitWorkspace.tsx:124-147` |
 * | `ui.splitRatio` | 左侧宽度**百分比**整数，reducer 钳在 25~75 | `workspace-reducer.ts:22-23,71-74` |
 * | `panes.primary/secondary.tabIndex` | 窗格指向哪个标签（下标） | `workspace-persistence.ts:66-69` |
 *
 * 所以映射是：`'vertical'` → `orientation: 'horizontal'`，`splitRatio / 100` → `ratio`。
 * `tabIndex` / `docId` / `sessionId` 一概不进新树——布局树只描述结构。
 *
 * 单视图时只要求 `primary` 身份；双视图时 `secondary` 与 `splitNodeId` 缺一即报
 * `empty-identity`，绝不自造一个。
 */
export function layoutTreeFromV1(input: unknown, identity: LayoutV1Identity): LayoutResult<LayoutTree> {
  if (typeof input !== 'object' || input === null) {
    return fail('invalid-v1', 'V1 快照不是对象');
  }
  const record = input as Record<string, unknown>;

  const ui = record.ui;
  if (typeof ui !== 'object' || ui === null) {
    return fail('invalid-v1', '缺少 ui');
  }
  const uiRecord = ui as Record<string, unknown>;

  const panes = record.panes;
  if (typeof panes !== 'object' || panes === null) {
    return fail('invalid-v1', '缺少 panes');
  }
  const panesRecord = panes as Record<string, unknown>;
  if (typeof panesRecord.primary !== 'object' || panesRecord.primary === null) {
    return fail('invalid-v1', '缺少 panes.primary');
  }

  const layout = uiRecord.layout;

  if (layout === 'single') {
    const pane: PaneNode = {
      type: 'pane',
      nodeId: identity.primary.nodeId,
      groupId: identity.primary.groupId,
    };
    return commit({ version: LAYOUT_TREE_VERSION, root: pane });
  }

  if (layout !== 'vertical') {
    return fail('invalid-v1', `未知 layout：${String(layout)}`);
  }

  if (typeof panesRecord.secondary !== 'object' || panesRecord.secondary === null) {
    return fail('invalid-v1', '缺少 panes.secondary');
  }

  const splitRatio = uiRecord.splitRatio;
  if (typeof splitRatio !== 'number' || !Number.isFinite(splitRatio)) {
    return fail('invalid-ratio', `splitRatio 不是有限数值：${String(splitRatio)}`);
  }

  const secondary = identity.secondary;
  const splitNodeId = identity.splitNodeId;
  if (secondary === undefined || splitNodeId === undefined) {
    return fail('empty-identity', '双视图转换缺少 secondary / splitNodeId 身份');
  }

  const split: SplitNode = {
    type: 'split',
    nodeId: splitNodeId,
    // 旧 'vertical' = 分隔条竖着 = 左右分屏
    orientation: 'horizontal',
    ratio: splitRatio / 100,
    children: [
      { type: 'pane', nodeId: identity.primary.nodeId, groupId: identity.primary.groupId },
      { type: 'pane', nodeId: secondary.nodeId, groupId: secondary.groupId },
    ],
  };
  return commit({ version: LAYOUT_TREE_VERSION, root: split });
}
