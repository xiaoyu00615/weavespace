/**
 * 文件树命令的**唯一语义与可用性来源**（UX-02C-05，纯 TS，不碰 React / DOM / 磁盘）。
 *
 * 为什么单独成模块：`.tsx` 无法被 `node:test` import（没有 JSX 变换），而这一轮要钉的
 * 恰好是"哪个入口在什么上下文里给出哪条命令、为什么不能点、点了会不会执行一条已经
 * 失效的命令"。把这些判定留在组件里，只能靠读 JSX 相信它是对的。
 *
 * 边界（刻意不扩张）：
 * - **不是** Command Registry：没有插件、没有动态注册、没有权限模型；
 * - **不复制**任何业务判定：隐藏 / 标注 / 回收的可用性继续由各自的纯模块回答，
 *   这里只做汇总与统一措辞，避免三处各写一份"能不能点"；
 * - **不做 IO**：不发请求、不读磁盘、不认识绝对路径与令牌；
 * - 不新增持久化：菜单身份、焦点与仲裁窗口都是内存里的瞬时状态。
 *
 * 与既有模块的关系：
 * - 目标目录规则仍然只有 `create-entry.ts::resolveCreateTarget` 一份（菜单与工具栏共用）；
 * - 改名/移动的业务链路仍然只有 `structure-change.ts::createStructureRunner` 一份；
 * - 这里新增的只有"矩阵 + 失效检测 + 键盘意图 + 菜单几何/身份 + 点击仲裁"。
 */
import { normalizeDir } from './create-entry.ts';
import { metadataCommandState } from './resource-metadata.ts';
import { trashDeleteCommandState } from './trash.ts';
import { visibilityCommandState } from './visibility.ts';

export type TreeCommandOrigin = 'file' | 'folder' | 'project-root' | 'blank' | 'link' | 'toolbar';

/**
 * 命令上下文：菜单、工具栏、键盘三条入口都用**同一个**形状描述"对什么动手"。
 *
 * `nodeAnchor` 只是"打开菜单那一刻"的身份快照（UX-02C-04-R1 的页级资源锚），
 * 用来在执行前判断"这一行还是不是当初那一行"。它不作身份、不作授权。
 */
export interface TreeCommandTarget {
  readonly origin: TreeCommandOrigin;
  readonly projectId: string | null;
  readonly nodePath?: string | null;
  readonly entryKind?: 'file' | 'directory' | 'link';
  readonly nodeHidden?: boolean;
  readonly nodeAnchor?: string | null;
  /**
   * 打开菜单那一刻这一行的**身份状态**（UX-02C-05-R1.1）。
   *
   * 必须有它才能区分"Provider 明确没有身份能力"（按路径身份降级）与
   * "身份探测失败 / 对象已消失"（无法确认，必须拒绝）。只靠 `nodeAnchor === undefined`
   * 会把这两种情况混成一种，于是本地真实项目缺锚时被当成"路径相同"放行。
   *
   * 缺省（旧调用者）= 未声明：有锚视为 `verified`，无锚按 `unverified` 处理（fail-closed）。
   */
  readonly nodeIdentity?: IdentityVerification;
}

/** 环境：与目标无关、只与"当前模式和项目状态"有关的信息。 */
export interface TreeCommandEnv {
  /** live + multi + 该项目 READY。与创建/改名/隐藏/回收的 `isSupported` 同一个值。 */
  readonly supported: boolean;
  /** 已支持的扩展文件种类数（二级菜单）；0 时"创建扩展文件"禁用并说明原因。 */
  readonly supportedExtensionCount: number;
}

export const TREE_COMMAND_IDS = [
  'rename',
  'move',
  'hide',
  'unhide',
  'trash',
  'meta-alias',
  'meta-tags',
  'meta-color',
  'new-file',
  'new-folder',
  'new-supported',
  'refresh',
  'rename-project',
  'remove-project',
] as const;

export type TreeCommandId = (typeof TREE_COMMAND_IDS)[number];

export interface TreeCommandState {
  /** 是否渲染。`false` = 当前上下文完全不适用（不是"禁用"）。 */
  readonly visible: boolean;
  readonly disabled: boolean;
  /** 禁用原因（渲染成 hint / tooltip）。可点时为 undefined。 */
  readonly hint?: string;
}

export type TreeCommandMatrix = Readonly<Record<TreeCommandId, TreeCommandState>>;

const HIDDEN: TreeCommandState = Object.freeze({ visible: false, disabled: true });
const UNSUPPORTED_HINT = '当前模式或项目不支持（需要已授权的真实项目）';

/**
 * `hint` 是**禁用原因**，不是说明文字：可点的项一律不带 hint，
 * 否则菜单上会出现"能点却写着不支持"的自相矛盾。
 */
function state(visible: boolean, disabled: boolean, hint?: string): TreeCommandState {
  if (!visible) return HIDDEN;
  if (!disabled) return { visible, disabled: false };
  return hint ? { visible, disabled, hint } : { visible, disabled };
}

/**
 * 所有入口共享的命令矩阵。
 *
 * 四类目标（文件 / 文件夹 / 项目根 / 空白区）与两类特殊上下文（链接 / 工具栏）
 * 在这里一次算完：菜单按顺序渲染，工具栏取其中三项，键盘取 `rename` 的可用性。
 */
export function treeCommandMatrix(target: TreeCommandTarget, env: TreeCommandEnv): TreeCommandMatrix {
  const path = normalizeDir(target.nodePath ?? '');
  const link = target.origin === 'link' || target.entryKind === 'link';
  /** 是不是"某一行真实对象"的上下文（链接行不算：它没有可改名的磁盘条目）。 */
  const rowTarget =
    (target.origin === 'file' || target.origin === 'folder') &&
    path !== '' &&
    (target.entryKind === 'file' || target.entryKind === 'directory');
  const supported = env.supported;
  const rootTarget = target.origin === 'project-root' && target.projectId !== null;

  const visibility = visibilityCommandState({ target, supported });
  const metadata = metadataCommandState({
    origin: target.origin,
    entryKind: target.entryKind,
    supported,
  });
  const trash = trashDeleteCommandState({
    origin: target.origin === 'link' ? 'link' : target.origin,
    entryKind: target.entryKind,
    supported,
  });

  /*
   * 创建类：链接行一律拒绝（绝不沿链接创建）；其余上下文在"没有可用项目"时
   * **显示但禁用**并说明原因——藏起来会让用户以为功能不存在。
   * 空白区 / 工具栏没有明确项目时，原因必须说"先选中一个项目"，
   * 而不是含糊的"模式不支持"：那会诱导用户去翻模式开关。
   */
  const noProject = target.projectId === null && target.origin !== 'project-root';
  const createDisabled = link || !supported;
  const createHint = link
    ? '链接节点不能创建文件或文件夹（避免越过项目根）'
    : noProject
      ? '没有明确的项目：请先选中一个项目'
      : supported
        ? undefined
        : UNSUPPORTED_HINT;

  return {
    rename: state(rowTarget, !supported, UNSUPPORTED_HINT),
    move: state(rowTarget, !supported, UNSUPPORTED_HINT),
    hide: state(visibility.visible && visibility.action !== 'unhide', visibility.disabled, visibility.hint),
    unhide: state(visibility.visible && visibility.action === 'unhide', visibility.disabled, visibility.hint),
    /*
     * 回收只对磁盘条目有意义：文件夹与链接保留"可见但禁用 + 原因"（用户看得到
     * 功能存在、也知道为什么现在不能用），**项目根不在其列**——根不是条目，
     * 它的"移除"是 `remove-project`（解除注册），不是把目录扔进回收区。
     */
    trash: state(
      trash.visible && target.origin !== 'project-root',
      trash.disabled,
      trash.hint,
    ),
    'meta-alias': state(metadata.visible, metadata.disabled, metadata.hint),
    'meta-tags': state(metadata.visible, metadata.disabled, metadata.hint),
    'meta-color': state(metadata.visible, metadata.disabled, metadata.hint),
    'new-file': state(true, createDisabled, createHint),
    'new-folder': state(true, createDisabled, createHint),
    /*
     * 与相邻的「新建文件/新建文件夹」用**同一句原因**：同一个菜单里两条创建命令
     * 对同一种"没有项目"给出两种说法，用户会以为它们是两个不同的限制。
     */
    'new-supported': state(
      true,
      createDisabled || env.supportedExtensionCount === 0,
      createDisabled
        ? createHint
        : env.supportedExtensionCount === 0
          ? '暂无已支持的扩展文件类型（没有激活的查看能力）'
          : undefined,
    ),
    /*
     * 刷新：链接没有可刷新的层；其余上下文给入口，不能用时说明原因
     * （空白区没有明确项目时"刷新"不应该假装成功）。
     */
    refresh: state(
      !link,
      !supported,
      noProject ? '没有明确的项目：请先选中一个项目' : supported ? undefined : '当前模式或项目不支持刷新真实目录',
    ),
    /*
     * 项目根专有：显示名与磁盘目录名是两件事，移除项目更不是删除磁盘目录。
     * 这两个命令只对**真实托管项目的根行**出现，Demo / Legacy 根没有 projectId。
     */
    'rename-project': state(rootTarget, !supported, '当前模式或项目不支持修改显示名称'),
    'remove-project': state(rootTarget, !supported, '当前模式或项目不支持移除项目'),
  };
}

/** 工具栏的上下文：只有"当前活动项目"，没有具体行。 */
export function toolbarTargetOf(activeProjectId: string | null): TreeCommandTarget {
  return { origin: 'toolbar', projectId: activeProjectId };
}

/**
 * 菜单顺序（产品行为，导出后可被直接断言）。
 *
 * 项目根是"创建 → 显示名 → 标注 → 刷新 → 移除"，其余上下文是
 * "对这一个条目动手 → 标注 → 创建 → 刷新"：同名命令在不同上下文里的位置
 * 不同是**刻意**的——根行没有改名/移动/回收这些"磁盘条目"命令。
 */
export const ROOT_MENU_ORDER: readonly TreeCommandId[] = [
  'new-file',
  'new-folder',
  'new-supported',
  'rename-project',
  'meta-alias',
  'meta-tags',
  'meta-color',
  'refresh',
  'remove-project',
];

export const ENTRY_MENU_ORDER: readonly TreeCommandId[] = [
  'rename',
  'move',
  'hide',
  'unhide',
  'trash',
  'meta-alias',
  'meta-tags',
  'meta-color',
  'new-file',
  'new-folder',
  'new-supported',
  'refresh',
];

export function menuOrderOf(origin: TreeCommandOrigin): readonly TreeCommandId[] {
  return origin === 'project-root' ? ROOT_MENU_ORDER : ENTRY_MENU_ORDER;
}

/** 工具栏按钮的可用性（与菜单同一份矩阵，不另写一套）。 */
export function toolbarCommandState(
  matrix: TreeCommandMatrix,
  id: 'new-file' | 'new-folder' | 'refresh',
): TreeCommandState {
  return matrix[id];
}

/**
 * 两条身份相关的拒绝文案（UX-02C-05-R1.2）。
 *
 * 必须分开：`UNCONFIRMED` 是"我们不知道它是不是原来那个"，
 * `IDENTITY_STATE_CHANGED` 是"两边给出的身份声明互相矛盾 / 已经换了一种状态"。
 * 合成一句会让用户以为只是又探测失败了一次，而实际上这一行可能已经被替换。
 */
const UNCONFIRMED = '无法确认这一行的身份，命令没有执行';
const IDENTITY_STATE_CHANGED = '这一行的身份状态已经变化，命令没有执行';

/**
 * 执行前的**失效检测**：菜单打开之后，目标可能已经被移除、项目可能已经不可用、
 * 文件可能已经被同名新对象替换。三者都不能执行旧命令。
 *
 * 这里只做"界面认为还在不在"的判断：权威仍然是 Host。
 */
export function treeTargetProblemOf(input: {
  readonly target: TreeCommandTarget;
  readonly projectExists: boolean;
  readonly projectReady: boolean;
  /** 该相对路径是否仍在**已加载**的层表里（根行不算磁盘条目，传 true）。 */
  readonly entryPresent: boolean;
  /** 当前层表里这一行的资源锚；拿不到传 null。 */
  readonly currentAnchor: string | null;
  /** 当前这一行的身份状态；缺省由 `currentAnchor` 推导（有锚 = 已核验）。 */
  readonly currentIdentity?: IdentityVerification;
}): string | null {
  const { target } = input;
  if (target.origin === 'blank' || target.origin === 'toolbar' || target.origin === 'link') return null;
  if (target.projectId === null) return null;
  if (!input.projectExists) return '该项目已不在工作区里，这个菜单已经失效';
  if (!input.projectReady) return '项目当前不可用，命令没有执行';
  if (target.origin === 'project-root') return null;
  if (!input.entryPresent) return '这一行已经被移除或替换，命令没有执行';

  /*
   * 身份核验必须 fail-closed，并且**两侧对称**（UX-02C-05-R1.2）。
   *
   * R1.1 只判了目标侧：目标声称 `unsupported` 就直接放行。于是"目标说没有身份能力"
   * 与"当前这一行已经有锚"之间的矛盾被忽略了——而能力声明本身是会变的（Provider
   * 换了、首屏整层被替换、节点重新探测过）。路径相同并不能说明是同一个对象，
   * 把能力变化解释成对象一致，正是"缺锚误放行"的下一个变种。
   *
   * 现在只有**两侧都是明确的 `unsupported`，且双方都没有任何锚信息**，才允许这条
   * 唯一被批准的路径身份降级。其余组合一律拒绝：
   * - `unsupported → unverified`：当前无法确认 → 拒绝；
   * - `unsupported → verified`：当前有锚、目标声称无能力 → 状态矛盾 → 拒绝；
   * - `verified → unsupported`：目标有锚、当前声明无能力 → 状态矛盾 → 拒绝；
   * - `verified → unverified`：当前无法确认 → 拒绝；
   * - `verified → verified`：锚必须完全一致，否则对象已经变化。
   */
  const targetIdentity =
    target.nodeIdentity ?? (target.nodeAnchor ? 'verified' : 'unverified');
  if (targetIdentity === 'unverified') return UNCONFIRMED;
  const currentIdentity =
    input.currentIdentity ?? (input.currentAnchor ? 'verified' : 'unverified');

  if (targetIdentity === 'unsupported') {
    // 自称没有身份能力却带着锚：声明自相矛盾，不能当成"按路径降级"的凭据
    if (target.nodeAnchor) return IDENTITY_STATE_CHANGED;
    if (currentIdentity === 'unverified') return UNCONFIRMED;
    if (currentIdentity !== 'unsupported') return IDENTITY_STATE_CHANGED;
    // 当前侧同样不能有任何锚信息，否则"无能力"与"有锚"互相矛盾
    if (input.currentAnchor) return IDENTITY_STATE_CHANGED;
    return null;
  }
  // 声称已验证却拿不到锚：不是"没有锚所以不用比"，而是"我们无法证明还是它"
  if (!target.nodeAnchor) return UNCONFIRMED;
  if (currentIdentity === 'unsupported') return IDENTITY_STATE_CHANGED;
  if (currentIdentity !== 'verified' || !input.currentAnchor) return UNCONFIRMED;
  if (target.nodeAnchor !== input.currentAnchor) {
    return '这一行对应的对象已经变化，命令没有执行';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 键盘意图                                                            */
/* ------------------------------------------------------------------ */

export type TreeKeyIntent = 'rename' | 'context-menu' | 'escape';

/**
 * 树范围内的按键 → 意图。
 *
 * 三条"不劫持"的硬约束：
 * 1. `inEditable`（输入框 / textarea / contenteditable / 正文编辑器）一律返回 null，
 *    树**不**抢任何按键；
 * 2. 没有当前焦点目标时不给意图（F2 不该对"空气"动手）；
 * 3. 只认 F2 / Shift+F10 / 菜单键 / Escape —— 不新增 Delete 等破坏性快捷键。
 */
export function treeKeyIntentOf(input: {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly inEditable: boolean;
  readonly hasTarget: boolean;
}): TreeKeyIntent | null {
  if (input.inEditable || !input.hasTarget) return null;
  if (input.key === 'F2') return 'rename';
  if (input.key === 'Escape') return 'escape';
  if (input.key === 'ContextMenu') return 'context-menu';
  if (input.shiftKey === true && input.key === 'F10') return 'context-menu';
  return null;
}

/* ------------------------------------------------------------------ */
/* 菜单几何与身份                                                      */
/* ------------------------------------------------------------------ */

export interface MenuPosition {
  readonly left: number;
  readonly top: number;
}

/**
 * 把菜单夹进视口：靠近右/下边缘时向左/上翻转，最小留 `edge` 的边距。
 * 纯函数，便于断言"不会超出视口"。
 */
export function menuPositionOf(input: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly edge?: number;
}): MenuPosition {
  const edge = input.edge ?? 8;
  const maxLeft = Math.max(edge, input.viewportWidth - input.width - edge);
  const maxTop = Math.max(edge, input.viewportHeight - input.height - edge);
  return {
    left: Math.max(edge, Math.min(input.x, maxLeft)),
    top: Math.max(edge, Math.min(input.y, maxTop)),
  };
}

/**
 * 菜单所属的"世界"：模式 + 工作区模式 + 工作区摘要 + 当前项目。
 *
 * 任一变化都意味着这个菜单里的命令已经不属于当前界面（切了模式、切了工作区、
 * 切了项目），必须关掉——绝不把旧操作发到新工作区。
 * 刻意**不**包含逐层加载代次：那会在用户刚打开菜单时因为一次分页刷新就把菜单关掉。
 */
export function menuIdentityOf(input: {
  readonly mode: string;
  readonly workspaceMode: string;
  readonly workspaceKey: string | null;
  readonly activeProjectId: string | null;
}): string {
  return [
    input.mode,
    input.workspaceMode,
    input.workspaceKey ?? '',
    input.activeProjectId ?? '',
  ].join('\u0000');
}

/* ------------------------------------------------------------------ */
/* 资源身份（单击 / 双击必须绑定"发起时的那一个对象"）                   */
/* ------------------------------------------------------------------ */

/**
 * Provider 的身份核验能力（由 Host 在页级显式声明，**不**由"锚缺失"推导）。
 *
 * - `supported`：能给出对象身份；某一行缺锚就只能是 `unverified`；
 * - `unsupported`：明确不具备身份能力（Demo / 无身份能力的 Provider）。
 */
export type IdentitySupport = 'supported' | 'unsupported';

/**
 * 一行的身份状态（UX-02C-05-R1.1）。
 *
 * 三种状态必须分开，否则 `anchor === null` 会同时表示两件性质完全不同的事：
 * - `verified`：身份已核验，有效锚存在；
 * - `unsupported`：Provider **明确**没有身份能力——唯一被批准的降级是按路径身份；
 * - `unverified`：探测失败 / 对象消失 / 无法确认——必须 fail-closed。
 *
 * 不变量：`unsupported` 只能来自 Host 的能力声明，绝不因为一次异常自动出现。
 */
export type IdentityVerification = 'verified' | 'unsupported' | 'unverified';

/** 由"锚 + Provider 能力"得到身份状态。缺省能力声明一律按 `unverified`（fail-closed）。 */
export function identityVerificationOf(input: {
  readonly anchor?: string | null;
  readonly support?: IdentitySupport | null;
}): IdentityVerification {
  if (typeof input.anchor === 'string' && input.anchor !== '') return 'verified';
  if (input.support === 'unsupported') return 'unsupported';
  return 'unverified';
}

/**
 * 一行的资源身份。
 *
 * 为什么不是 React `key`：同一个路径的文件被替换时，`key` 保持不变、组件实例被复用，
 * 于是"上一次点击"会顺理成章地落到**新对象**上。锚（UX-02C-04-R1）由对象身份派生，
 * 同路径替换必然改变它；工作区 + 项目 + 路径把"别的世界里的同名文件"也排除掉。
 *
 * `verification` 是身份的一部分，不是附注：把"无法确认"从等式里拿掉，
 * 就会退化成"路径相同即同一行"——那正是同路径替换识别不出来的原因。
 */
export interface ActivationIdentity {
  /** 工作区身份：切换工作区后，旧的在途点击不得执行。 */
  readonly workspaceKey: string | null;
  readonly projectId: string | null;
  /** 归一化后的相对路径；项目根为 ''。 */
  readonly path: string;
  /** 资源锚；拿不到为 null（此时只能靠 `verification` 决定能不能动手）。 */
  readonly anchor: string | null;
  /** 身份状态：`unverified` 时任何延迟意图都不执行。 */
  readonly verification: IdentityVerification;
}

export function activationIdentityOf(input: {
  readonly workspaceKey: string | null;
  readonly projectId: string | null;
  readonly path?: string | null;
  readonly anchor?: string | null;
  /** 这一行所在层声明的 Provider 身份能力。 */
  readonly support?: IdentitySupport | null;
}): ActivationIdentity {
  const anchor = input.anchor ?? null;
  return {
    workspaceKey: input.workspaceKey,
    projectId: input.projectId,
    path: normalizeDir(input.path ?? ''),
    anchor,
    verification: identityVerificationOf({ anchor, support: input.support }),
  };
}

function activationKeyOf(identity: ActivationIdentity): string {
  return [
    identity.workspaceKey ?? '',
    identity.projectId ?? '',
    identity.path,
    identity.anchor ?? '',
    identity.verification,
  ].join('\u0000');
}

/** 稳定字符串键：只用于 React 依赖数组，不参与业务判断。 */
export function activationIdentityKey(identity: ActivationIdentity | null | undefined): string {
  return identity ? activationKeyOf(identity) : '';
}

/** 两次交互是不是**同一个资源**。任一项不同都不算——包括"锚从有到无"。 */
export function sameActivationResource(a: ActivationIdentity, b: ActivationIdentity): boolean {
  return activationKeyOf(a) === activationKeyOf(b);
}

/* ------------------------------------------------------------------ */
/* 单击 / 双击仲裁                                                     */
/* ------------------------------------------------------------------ */

export interface ActivationArbiter {
  /** 单击（`detail` 由浏览器给出：0 = 键盘触发，1 = 第一次点击，≥2 = 连击）。 */
  click(detail: number, identity: ActivationIdentity): void;
  /** 双击（`dblclick` 事件），`identity` 是第二次点击所在的资源。 */
  doubleClick(identity: ActivationIdentity): void;
  /** 取消在途的单击（关闭菜单、组件卸载、会话失效时调用）。 */
  cancel(): void;
  isPending(): boolean;
}

/**
 * 名称区域"单击还是双击"的判别窗口（毫秒）。
 *
 * UX-02C-05-R1 把 200 提到 500：200ms 只覆盖"电竞式"双击，普通用户 300–450ms 的
 * 连击会掉进单击分支——第一下已经把文件打开，第二下再改名就被自己的会话保护挡住。
 * 500ms 是常见双击阈值（Windows/Chrome 默认 `GetDoubleClickTime()`）的上界，
 * 代价是名称区域的单击打开最多晚 500ms；图标与行内空白仍然立即激活。
 */
export const NAME_DOUBLE_CLICK_WINDOW = 500;

/**
 * 单击 / 双击仲裁（双击名称改名用）。
 *
 * 为什么必须仲裁：文件树单击打开文件会立刻把文件放进活动 View，而改名保护
 * （UX-02C-02）要求"还有打开的标签就不能改名"。若不区分单击与双击，
 * 双击的第一下已经把文件打开，改名必然被自己的保护挡住。
 *
 * 因此：名称区域的单击**延后一个短窗口**再执行，窗口内发生第二次点击就取消
 * 单击、只执行改名。窗口只作用于名称区域，且只有"这一行确实能改名"时才装配，
 * 图标/空白处的单击仍然是立即的；键盘触发的 click（detail=0）也立即执行。
 *
 * 每一次点击都带着**发起时的资源身份**：定时器到点与双击落槌之前都要和
 * `currentIdentity()` 再核一次。同路径文件被替换（锚变）、切了项目、切了工作区、
 * 或者身份已经无法确认时，这一下**什么都不做**——绝不把旧点击重新绑定到新对象。
 *
 * R1.1 补的两处：
 * - `detail >= 2` **必须**有本仲裁器自己收到的第一次点击（`armed`）。组件因身份变化
 *   重建仲裁器后，浏览器仍可能把下一下报成连击（`detail=2`）；旧实现会把它当成
 *   "新一次双击的起点"，于是旧手势的残响给新对象改了名；
 * - `unverified` 不参与任何"相等"推断：路径相同、锚都拿不到，只能是"无法确认"。
 */
export function createActivationArbiter(input: {
  readonly delay: number;
  readonly setTimer: (fn: () => void, delay: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  /** 这一行**现在**指向谁；拿不到（已卸载 / 身份未知）返回 null。 */
  readonly currentIdentity: () => ActivationIdentity | null;
  readonly onSingle: () => void;
  readonly onDouble: () => void;
}): ActivationArbiter {
  let pending: unknown = null;
  /** 发起时的那一个资源：单击定时器与双击都必须拿它做核对。 */
  let armed: ActivationIdentity | null = null;

  const clear = (): void => {
    if (pending === null) return;
    input.clearTimer(pending);
    pending = null;
  };
  /**
   * 身份仍然指向同一个资源。
   *
   * `unverified` 一律视为"不是"：这不是"没变化"，而是"我们无法证明它没变"。
   * 只有 `unsupported`（Provider 明确无身份能力）才按路径身份降级。
   */
  const stillSame = (identity: ActivationIdentity): boolean => {
    if (identity.verification === 'unverified') return false;
    const current = input.currentIdentity();
    if (current === null) return false;
    if (current.verification === 'unverified') return false;
    return sameActivationResource(identity, current);
  };

  return {
    click(detail, identity) {
      // 键盘触发（Enter/Space 合成的 click）没有"等一下看是不是双击"的必要
      if (detail === 0) {
        clear();
        armed = null;
        if (stillSame(identity)) input.onSingle();
        return;
      }
      // 连击的第二下：必须和**本仲裁器收到的**第一次点击属于同一个资源
      if (detail >= 2) {
        /*
         * 没有第一次点击 = 这段手势不是从这里开始的（典型：身份变化后仲裁器刚重建，
         * 浏览器还在数上一段的连击）。不能把它当成新一次双击的起点，更不能借它
         * 把新身份"武装"给随后的 dblclick。
         */
        if (armed === null) {
          clear();
          return;
        }
        if (!sameActivationResource(armed, identity)) {
          clear();
          armed = null;
          return;
        }
        // 同一个资源：只撤掉在途单击，保留 armed 供 dblclick 落槌（绝不改写成 identity）
        clear();
        return;
      }
      clear();
      armed = identity;
      pending = input.setTimer(() => {
        pending = null;
        const target = armed;
        armed = null;
        // 到点再核一次：这 500ms 里对象可能已经被刷新/替换掉
        if (target === null || !stillSame(target)) return;
        input.onSingle();
      }, input.delay);
    },
    doubleClick(identity) {
      // 没有可核对的第一次点击：不猜，直接不动
      if (armed === null) return;
      if (!sameActivationResource(armed, identity)) {
        clear();
        armed = null;
        return;
      }
      clear();
      armed = null;
      if (!stillSame(identity)) return;
      input.onDouble();
    },
    cancel() {
      clear();
      armed = null;
    },
    isPending: () => pending !== null,
  };
}

/* ------------------------------------------------------------------ */
/* 项目显示名编辑会话的归属                                            */
/* ------------------------------------------------------------------ */

/**
 * "世界"范围：模式 + 工作区模式 + 工作区摘要（**不含**当前项目）。
 *
 * 项目改名会话属于某一个世界；世界一变，未提交的会话必须失效，
 * 否则旧工作区的草稿会提交到新工作区里。
 */
export function workspaceScopeOf(input: {
  readonly mode: string;
  readonly workspaceMode: string;
  readonly workspaceKey: string | null;
}): string {
  return [input.mode, input.workspaceMode, input.workspaceKey ?? ''].join('\u0000');
}

export type ProjectRenameGate =
  | 'ok'
  | 'scope-changed'
  | 'active-project-changed'
  | 'project-missing'
  | 'unsupported';

/**
 * 提交前的归属复核。
 *
 * 顺序是产品语义：先确认"这个会话还属于当前世界"，再确认"还属于当前这一屏"，
 * 最后才说项目还在不在、能不能改。旧世界的会话即使在新世界里能找到同名项目，
 * 也**不是**同一个会话。
 *
 * `activeProjectAtStart` 与当前活动项目必须同步核验（R2.1 / A01）：
 * 会话的清理是 `useEffect`，而提交是事件回调——两者之间有一个窗口，
 * 切换当前项目后的第一次 Enter 会落在旧会话上。不能只靠 effect 收尸。
 *
 * 注意**不能**直接比较 `session.projectId` 与 `activeProjectId`：右键菜单可以给
 * **非当前项目**改显示名，那种会话的 `projectId` 本来就不等于活动项目。
 * 要比的是"打开会话那一刻的活动项目"与"现在的活动项目"。
 */
export function projectRenameGateOf(input: {
  readonly sessionScope: string;
  readonly currentScope: string;
  readonly activeProjectAtStart: string | null;
  readonly currentActiveProject: string | null;
  readonly projectExists: boolean;
  readonly projectSupported: boolean;
}): ProjectRenameGate {
  if (input.sessionScope !== input.currentScope) return 'scope-changed';
  if (input.activeProjectAtStart !== input.currentActiveProject) return 'active-project-changed';
  if (!input.projectExists) return 'project-missing';
  if (!input.projectSupported) return 'unsupported';
  return 'ok';
}

export function projectRenameGateMessage(gate: ProjectRenameGate): string | null {
  switch (gate) {
    case 'ok':
      return null;
    case 'scope-changed':
      return '工作区或模式已经改变，旧的改名会话已失效';
    case 'active-project-changed':
      return '当前项目已经切换，旧的改名会话已失效（没有发出任何修改）';
    case 'project-missing':
      return '该项目已不在工作区里';
    case 'unsupported':
      return '只有已授权的真实项目可以修改显示名称';
  }
}

export type ProjectRenameResultEffect = 'close' | 'keep-error' | 'notice-only';

/**
 * 请求回来之后怎么落地。
 *
 * `notice-only` 的存在理由：请求**已经发出去了**，不能因为会话在此期间被收起，
 * 就把结果丢掉、假装"什么都没发生"，更不能自动重发一次。
 */
export function projectRenameResultEffect(input: {
  readonly applied: boolean;
  readonly sessionStillCurrent: boolean;
}): ProjectRenameResultEffect {
  if (!input.sessionStillCurrent) return 'notice-only';
  return input.applied ? 'close' : 'keep-error';
}

/** 项目改名会话的归属票据：请求回来时用来核对"这条结果还属于当前界面吗"。 */
export interface ProjectRenameSessionTicket {
  readonly sessionId: number;
  /** 打开会话时所属的世界（模式 + 工作区模式 + 工作区摘要）。 */
  readonly scope: string;
  /** 打开会话时**当前活动项目**：活动项目一变，这个会话就不再属于当前界面。 */
  readonly activeProjectAtStart: string | null;
}

/**
 * 在途结果的同步归属核对（UX-02C-05-R1.1）。
 *
 * 为什么不能只看 `sessionId`：切换项目/工作区后，会话的清理是 `useEffect`，
 * 而 fetch 的回调是微任务——它完全可能先于 effect 跑，此时 `renameRef` 里还是旧会话、
 * `sessionId` 也还对得上。只比票据会把"上次那个世界的结果"写进看起来还当前的界面。
 *
 * 所以三条一起核：票据、世界、活动项目。任何一条不成立都只能 `notice-only`：
 * 已发出的请求不伪装成未发送，不写回编辑会话，也不自动重试。
 */
export function projectRenameSessionStillCurrent(input: {
  readonly session: ProjectRenameSessionTicket | null;
  readonly sessionId: number;
  readonly currentScope: string;
  readonly activeProjectId: string | null;
}): boolean {
  const { session } = input;
  if (session === null) return false;
  if (session.sessionId !== input.sessionId) return false;
  if (session.scope !== input.currentScope) return false;
  return session.activeProjectAtStart === input.activeProjectId;
}
