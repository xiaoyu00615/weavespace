/**
 * 工作区布局树（UI-F03-A）：**纯结构模型**，不依赖 React / DOM / 磁盘 / Host。
 *
 * 为什么要有它：现有工作区只能表达 `single` 与 `vertical` 两窗格
 * （`types.ts:8` 的 `LayoutMode`、`types.ts:14` 的 `PaneId`），
 * 上下分屏、嵌套分屏、多个独立视图组都写不出来。本模块先把"布局可以被表达、
 * 被校验、被序列化"这件事做成可测试的确定性，再让未来的 WorkspaceState 接上它。
 *
 * 四条纪律，违反任意一条都会让后续重构失去支点：
 *
 * 1. **只做结构**。这里不知道文档、不知道未保存修改、不做授权判断。
 *    "关掉这个视图会不会丢草稿"是 ViewGroup / DocumentSession 管理层的事。
 * 2. **身份由调用方注入**。`nodeId` / `groupId` 一律从参数来，模块内部
 *    绝不使用随机数、时间戳或任何浏览器 API 生成。这样同一份输入永远得到
 *    同一棵树，测试与恢复流程都能逐字节比对。
 * 3. **fail-closed**。非法输入一律返回明确错误码，不"尽力修复"、不静默钳制。
 *    布局是后续所有视图的骨架，宁可拒绝，也不能生成一棵看起来正常但语义错误的树。
 * 4. **封闭结构**。根对象、PaneNode、SplitNode 各有**显式字段白名单**，
 *    多一个字段就是 `unexpected-field`。布局树不该携带文档/会话身份，
 *    所以外部对象里混进来的 `docId` / `sessionId` / `path` / `viewId`
 *    不能跟着树一起被序列化、被恢复。`parseLayoutTree` 通过校验后仍会重建，
 *    返回值与入参不共享任何引用。
 *
 * 比例有两套区间，**不要混用**（见 `MIN_SPLIT_RATIO` 与 `MIN_UI_SPLIT_RATIO`）：
 * 结构上允许 10%~90%，用户拖动只能到 25%~75%。
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
 * 分三类：
 * - **数据非法**：`invalid-*` / `duplicate-*` / `empty-identity` / `cyclic-tree` /
 *   `depth-exceeded` / `pane-limit-exceeded` / `unexpected-field`——"这份数据不能当布局用"；
 * - **操作参数非法**：`invalid-position`——"这个动作说不通"；
 * - **操作无法执行**：`node-not-found` / `split-not-found` / `pane-not-found` / `last-pane`
 *   ——数据本身没问题，只是这个动作在当前结构上做不到。
 *
 * 调用方据此决定是"拒绝这份数据"还是"告诉用户换个目标"。
 */
export type LayoutErrorCode =
  | 'invalid-tree'
  | 'invalid-node'
  | 'invalid-orientation'
  | 'invalid-split'
  | 'invalid-ratio'
  | 'invalid-position'
  | 'unexpected-field'
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

/**
 * UI **拖动**的比例区间（25%~75%）。
 *
 * 与上面的模型结构区间是两件事，不能混用：
 * - 结构区间 0.1~0.9 回答"这个布局能不能成立"——低于 10% 的窗格实际上已经不可用；
 * - 拖动区间 0.25~0.75 回答"用户能把分隔条拖到哪"——沿用旧 reducer 的 25/75
 *   （`workspace-reducer.ts:22-23`），保证新界面拖动起来与既有界面手感一致。
 *
 * 所以"结构上允许 0.15"和"拖动到不了 0.15"可以同时成立，这是有意的。
 */
export const MIN_UI_SPLIT_RATIO = 0.25;
export const MAX_UI_SPLIT_RATIO = 0.75;

/**
 * 旧持久化（V1）里 `splitRatio` 的真实取值域：**25~75 的整数百分比**。
 *
 * 两个常量 + 整数判定缺一不可：旧 reducer 的 `clampRatio`
 * （`workspace-reducer.ts:71-74`）先 `Math.round` 再钳进 25~75，所以
 * `25.5` / `20` / `80` 从来不是 V1 里会出现的合法值。转换时把非法旧值
 * "凑成能用的样子"，等于替一份损坏的存档编造布局。
 */
export const V1_MIN_SPLIT_RATIO = 25;
export const V1_MAX_SPLIT_RATIO = 75;

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
 * 新 Pane 的落位。
 *
 * 类型上只有两个值，运行时仍要显式校验：调用方可能是 `JSON.parse` 的结果、
 * 恢复流程里的旧记录，或者一段被改坏的代码。落位非法的后果是"新窗格出现在
 * 没被预期的位置"，而且不会报错——这种静默错位比抛异常难查得多。
 */
function isPosition(value: unknown): value is 'first' | 'second' {
  return value === 'first' || value === 'second';
}

/**
 * 结构钳制：把任意数值收敛到模型允许的 0.1~0.9。
 *
 * 模型 API 自己**不**钳制（非法值直接拒绝，见 `setSplitRatio`）：
 * 静默改小/改大会让调用方以为设置成功了。这个函数只给"必须得到一个能进模型的数"
 * 的场合用，边界从本模块取，调用方不要再写一遍 0.1 / 0.9。
 */
export function clampLayoutRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPLIT_RATIO;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value));
}

/**
 * 拖动钳制：把指针位置收敛到 UI 允许的 25%~75%。
 *
 * 与 `clampLayoutRatio` **不是一个函数**：那个回答"结构能不能成立"，这个回答
 * "用户能拖到哪"。拖动时用它，用户永远拖不出一个结构上合法但视觉上不可用的
 * 极窄窗格；程序化设置（恢复、测试）走 `setSplitRatio`，可以用到 0.1~0.9 全区间。
 */
export function clampUiSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPLIT_RATIO;
  return Math.min(MAX_UI_SPLIT_RATIO, Math.max(MIN_UI_SPLIT_RATIO, value));
}

/**
 * 字段白名单。
 *
 * 布局树是**封闭**结构：多一个字段就说明这份对象不是我们的数据。只校验
 * "必需字段在不在"是不够的——外部对象里混进来的 `docId` / `sessionId` /
 * `path` / `viewId` 会跟着树一起被序列化、被恢复、被当成布局的一部分，
 * 而布局树按设计**不该**携带任何文档或会话身份（见模块头注释）。
 */
const ROOT_FIELDS: readonly string[] = ['version', 'root'];
const PANE_FIELDS: readonly string[] = ['type', 'nodeId', 'groupId'];
const SPLIT_FIELDS: readonly string[] = ['type', 'nodeId', 'orientation', 'ratio', 'children'];

/** 第一个不在白名单里的**自有可枚举**字段（原型上的不算，`JSON.parse` 也只有自有字段）。 */
function firstUnexpectedField(
  record: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) return key;
  }
  return null;
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
  const unexpected = firstUnexpectedField(record, type === 'pane' ? PANE_FIELDS : SPLIT_FIELDS);
  if (unexpected !== null) {
    return { error: 'unexpected-field', detail: `${type} 节点不允许字段：${unexpected}` };
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
  const unexpected = firstUnexpectedField(record, ROOT_FIELDS);
  if (unexpected !== null) {
    return { error: 'unexpected-field', detail: `根对象不允许字段：${unexpected}` };
  }
  if (!('root' in record)) {
    return { error: 'invalid-tree', detail: '缺少 root' };
  }
  return checkNode(record.root, 1, new Set<object>(), new Set<string>(), new Set<string>());
}

/**
 * 构造完成前的最后一道闸门。
 *
 * 顺序是"**先验输入、再动手、最后兜底**"：
 * 1. 每个修改入口先 `validateLayoutTree(tree)`——损坏输入（环、非法节点、超限）
 *    在进入递归**之前**就被拒绝，不会栈溢出，也不会抛异常；
 * 2. 按操作语义改树（局部检查给出更准确的"操作类"错误码，如找不到节点）；
 * 3. 结果整棵再校验一次——少写一个边界就是非法树，这里当场拦住，不会流到 UI。
 */
function commit(tree: LayoutTree): LayoutResult<LayoutTree> {
  const problem = validateLayoutTree(tree);
  if (problem !== null) return { ok: false, error: problem.error, detail: problem.detail };
  return { ok: true, value: tree };
}

/**
 * 修改入口的**前置**闸门。
 *
 * 为什么不能只靠 `commit`：`replaceNode` / `removePane` 是递归函数，环状输入
 * 在"改完再校验"之前就已经把栈打爆了。校验必须发生在递归之前。
 */
function rejectBrokenInput(tree: LayoutTree): LayoutResult<LayoutTree> | null {
  const problem = validateLayoutTree(tree);
  if (problem === null) return null;
  return { ok: false, error: problem.error, detail: `输入布局不合法：${problem.detail}` };
}

/**
 * 把 `targetId` 那个节点替换成 `make(原节点)`，并只重建**从根到它的路径**。
 *
 * 未修改的分支保持**同一对象引用**（结构化共享）：这让"只调了内层比例"可以被
 * 测试用 `===` 证明外层没被重写，也让未来的 React memo 能真正生效。
 *
 * `depth` 是兜底：入口都已验过树，合法树走不到上限；这里只是为了"万一有人绕过
 * 前置校验"时不至于无限递归。
 */
function replaceNode(
  node: LayoutNode,
  targetId: string,
  make: (target: LayoutNode) => LayoutNode,
  depth = 1,
): LayoutNode | null {
  if (depth > MAX_LAYOUT_DEPTH) return null;
  if (node.nodeId === targetId) return make(node);
  if (node.type === 'pane') return null;
  const left = replaceNode(node.children[0], targetId, make, depth + 1);
  if (left !== null) return { ...node, children: [left, node.children[1]] };
  const right = replaceNode(node.children[1], targetId, make, depth + 1);
  if (right !== null) return { ...node, children: [node.children[0], right] };
  return null;
}

/**
 * 移除指定视图组的 Pane；返回 `null` 表示"这个节点就是要被删的那个"。
 *
 * 关键在于**在每一层重新组装**：直接父 split 因为少了一个孩子而自动塌陷
 * （剩下那个孩子顶上来），更上层的结构原样保留。不需要"先找父节点再改父的父"。
 */
function removePane(node: LayoutNode, groupId: string, depth = 1): LayoutNode | null {
  if (depth > MAX_LAYOUT_DEPTH) return node; // 兜底：同 replaceNode，合法树走不到
  if (node.type === 'pane') return node.groupId === groupId ? null : node;
  const left = removePane(node.children[0], groupId, depth + 1);
  const right = removePane(node.children[1], groupId, depth + 1);
  if (left === null && right === null) return node; // groupId 唯一，理论上不可达
  if (left === null) return right; // 左子被删 → 右子顶上来
  if (right === null) return left; // 右子被删 → 左子顶上来
  if (left === node.children[0] && right === node.children[1]) return node; // 本支没动
  return { ...node, children: [left, right] };
}

/** 深度优先、左 → 右。这个顺序就是屏幕上的视觉顺序，测试据此断言。 */
function walk(node: LayoutNode, visit: (node: LayoutNode, depth: number) => void, depth = 1): void {
  if (depth > MAX_LAYOUT_DEPTH) return; // 兜底：损坏数据不得把查询拖进无限递归
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
  const broken = rejectBrokenInput(tree);
  if (broken !== null) return broken;
  if (!isPosition(input.position)) {
    return fail(
      'invalid-position',
      `position 只能是 first 或 second，实际：${String(input.position)}`,
    );
  }
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
  const broken = rejectBrokenInput(tree);
  if (broken !== null) return broken;
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
  const broken = rejectBrokenInput(tree);
  if (broken !== null) return broken;
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

/** 普通对象（非 null、非数组）：布局节点只能是这种形状。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 这个值能不能当**布局节点**看待：必须是对象，且 `type` 是 pane / split。
 *
 * 查询函数用它做唯一的准入判定。未知类型（`grid`、`tree`、拼错的 `pnae`）
 * 一律不算节点——既不能作为结果返回，也不能成为遍历的跳板。
 */
function isLayoutNode(value: unknown): value is LayoutNode {
  if (!isRecord(value)) return false;
  return value.type === 'pane' || value.type === 'split';
}

/**
 * 取出一个 split 的**合法**两个孩子；结构不合格时返回 `null`。
 *
 * 合格 = 自身是 split + `children` 是长度恰好 2 的数组 + 两个子节点都是合法节点。
 * 任一条不满足就返回 `null`，调用方据此**整支跳过**：不遍历、也不把它当成结果。
 * 宁可少查一个损坏分支，也不能让 `null.nodeId` 这样的读取把渲染打崩。
 */
function splitChildrenOf(node: LayoutNode): readonly [LayoutNode, LayoutNode] | null {
  if (node.type !== 'split') return null;
  const children: unknown = node.children;
  if (!Array.isArray(children) || children.length !== 2) return null;
  const first: unknown = children[0];
  const second: unknown = children[1];
  if (!isLayoutNode(first) || !isLayoutNode(second)) return null;
  return [first, second];
}

/**
 * 取 root：树本身或 root 损坏时返回 `null`。
 *
 * 两个查询入口都从这里开始，所以"入口检查"只有一处实现。
 */
function rootOf(tree: unknown): LayoutNode | null {
  if (!isRecord(tree)) return null;
  const root = tree.root;
  return isLayoutNode(root) ? root : null;
}

/**
 * 按 `nodeId` 找节点（pane 与 split 共用命名空间）。
 *
 * 走显式栈而不是递归，是因为查询函数会被 UI 在渲染期高频调用，不该有递归
 * 深度上限或崩溃面。三条防御：
 *
 * - 未知类型的节点既不入栈、也不作为结果（否则 `{type:'grid', children:[...]}`
 *   会被当成合法节点返回，调用方读它的字段就踩空）；
 * - split 的 `children` 必须先通过 `splitChildrenOf` 的结构检查，才允许
 *   "它自己算命中"并把子节点入栈——顺序是**先验结构、再判命中**，因为
 *   一个 children 缺失的 split 交给调用方，等于把崩溃点往后挪；
 * - `seen` 按对象引用去重，环状输入不会无限循环。
 *
 * 返回的是树里那**一个**节点（引用相等），不做任何复制。
 */
export function findLayoutNode(tree: LayoutTree, nodeId: string): LayoutNode | null {
  const root = rootOf(tree);
  if (root === null) return null;

  const seen = new Set<object>();
  const stack: LayoutNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as LayoutNode;
    if (seen.has(node)) continue;
    seen.add(node);

    if (node.type === 'pane') {
      if (node.nodeId === nodeId) return node;
      continue;
    }

    const children = splitChildrenOf(node);
    if (children === null) continue;
    if (node.nodeId === nodeId) return node;
    stack.push(children[1], children[0]); // 先压右再压左 → 弹出时左先
  }
  return null;
}

/**
 * 按 `groupId` 找 Pane。
 *
 * 与 `findLayoutNode` 共用同一套准入判定（`isLayoutNode` / `splitChildrenOf`）：
 * 未知类型不穿透、损坏的 split 不遍历，因此 `{type:'grid', children:[pane]}` 里
 * 的 Pane 不会被"顺手"找到——它不在任何合法的视图结构里。
 *
 * 遍历顺序仍是深度优先、左优先：同一 `groupId` 出现两次（损坏数据）时，
 * 返回左边那一个。
 */
export function findPaneByGroup(tree: LayoutTree, groupId: string): PaneNode | null {
  const root = rootOf(tree);
  if (root === null) return null;

  const seen = new Set<object>();
  const stack: LayoutNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as LayoutNode;
    if (seen.has(node)) continue;
    seen.add(node);

    if (node.type === 'pane') {
      if (node.groupId === groupId) return node;
      continue;
    }

    const children = splitChildrenOf(node);
    if (children === null) continue;
    stack.push(children[1], children[0]);
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
 * 把一棵**已通过校验**的树重建为只含白名单字段的规范树。
 *
 * 为什么"校验通过还要重建"：校验与使用之间隔着别人的代码。返回值若是原对象
 * 引用，调用方（或任何持有同一对象的代码）之后给某个节点挂一个 `docId`，
 * 这棵"已解析"的树就悄悄变了——而 `parse` 的语义是"这是我要用的那份数据"。
 * 重建一次，代价是 O(节点数)，换来的是"解析结果与世界脱钩"。
 *
 * 属性顺序固定（`version` → `root`；`type` → ... ），所以序列化输出稳定。
 */
function normalizeNode(node: LayoutNode): LayoutNode {
  if (node.type === 'pane') {
    return { type: 'pane', nodeId: node.nodeId, groupId: node.groupId };
  }
  return {
    type: 'split',
    nodeId: node.nodeId,
    orientation: node.orientation,
    ratio: node.ratio,
    children: [normalizeNode(node.children[0]), normalizeNode(node.children[1])],
  };
}

function normalizeLayoutTree(tree: LayoutTree): LayoutTree {
  return { version: LAYOUT_TREE_VERSION, root: normalizeNode(tree.root) };
}

/**
 * 序列化：先校验、再规范化、然后输出。
 *
 * 两道保险都必要：`validateLayoutTree` 拦住"多字段的树"，`normalizeLayoutTree`
 * 保证即使将来校验被放宽或绕过，落盘的字节里也只有模型定义过的字段。
 * 输出稳定（键序由 `normalizeNode` 固定），所以"序列化 → 解析 → 再序列化"
 * 必须逐字节相同，测试据此断言 round-trip 无损。
 */
export function serializeLayoutTree(tree: LayoutTree): LayoutResult<string> {
  const problem = validateLayoutTree(tree);
  if (problem !== null) return { ok: false, error: problem.error, detail: problem.detail };
  return { ok: true, value: JSON.stringify(normalizeLayoutTree(tree)) };
}

/**
 * 解析外部数据（`JSON.parse` 的结果或任何 `unknown`）为布局树。
 *
 * 不做"尽力修复"：形状不对、版本不对、比例越界、多出一个字段都直接拒绝。
 * 布局是后续所有视图的骨架，修复出一棵"看起来能用"的树比报错危险得多。
 *
 * 通过校验后仍然**重建**：返回的是新对象，与入参不共享任何引用。
 */
export function parseLayoutTree(value: unknown): LayoutResult<LayoutTree> {
  const problem = validateLayoutTree(value);
  if (problem !== null) return { ok: false, error: problem.error, detail: problem.detail };
  return { ok: true, value: normalizeLayoutTree(value as LayoutTree) };
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
 * **`splitRatio` 必须满足旧版的真实规则**：`Number.isInteger` 且落在
 * `V1_MIN_SPLIT_RATIO`~`V1_MAX_SPLIT_RATIO`（25~75）。`25.5` / `20` / `80`
 * 都不是 V1 会产生的值，一律 `invalid-ratio`——不四舍五入、不钳制、不"凑成
 * 能用的样子"。
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
  /**
   * 旧值必须是 **25~75 的整数百分比**。
   *
   * 旧 reducer 的 `clampRatio`（`workspace-reducer.ts:71-74`）先 `Math.round`
   * 再钳进 25~75，所以 V1 里根本不会出现 `25.5` / `20` / `80`。这些值只可能
   * 来自被手工改过或写坏了的存档——此时若"顺手 除以 100 再算合法"，等于替
   * 一份损坏的记录编造一个布局，用户下次打开会看到一个自己从没设过的分屏。
   */
  if (!Number.isInteger(splitRatio)) {
    return fail('invalid-ratio', `splitRatio 必须是整数百分比：${splitRatio}`);
  }
  if (splitRatio < V1_MIN_SPLIT_RATIO || splitRatio > V1_MAX_SPLIT_RATIO) {
    return fail(
      'invalid-ratio',
      `splitRatio 必须在 ${V1_MIN_SPLIT_RATIO}~${V1_MAX_SPLIT_RATIO} 之间：${splitRatio}`,
    );
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
