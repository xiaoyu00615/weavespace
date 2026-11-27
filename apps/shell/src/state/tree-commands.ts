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
}): string | null {
  const { target } = input;
  if (target.origin === 'blank' || target.origin === 'toolbar' || target.origin === 'link') return null;
  if (target.projectId === null) return null;
  if (!input.projectExists) return '该项目已不在工作区里，这个菜单已经失效';
  if (!input.projectReady) return '项目当前不可用，命令没有执行';
  if (target.origin === 'project-root') return null;
  if (!input.entryPresent) return '这一行已经被移除或替换，命令没有执行';
  if (target.nodeAnchor && input.currentAnchor && target.nodeAnchor !== input.currentAnchor) {
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
/* 单击 / 双击仲裁                                                     */
/* ------------------------------------------------------------------ */

export interface ActivationArbiter {
  /** 单击（`detail` 由浏览器给出：0 = 键盘触发，1 = 第一次点击，≥2 = 连击）。 */
  click(detail: number): void;
  /** 双击（`dblclick` 事件）。 */
  doubleClick(): void;
  /** 取消在途的单击（关闭菜单、组件卸载、会话失效时调用）。 */
  cancel(): void;
  isPending(): boolean;
}

/**
 * 名称区域"单击还是双击"的判别窗口（毫秒）。
 *
 * 取 200ms：低于常见双击间隔（180ms 左右的两连击仍能命中），又短到单击打开
 * 不会明显变慢。窗口只作用于**名称文字**上的点击，图标与行内空白仍是立即激活。
 */
export const NAME_DOUBLE_CLICK_WINDOW = 200;

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
 */
export function createActivationArbiter(input: {
  readonly delay: number;
  readonly setTimer: (fn: () => void, delay: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly onSingle: () => void;
  readonly onDouble: () => void;
}): ActivationArbiter {
  let pending: unknown = null;

  const clear = (): void => {
    if (pending === null) return;
    input.clearTimer(pending);
    pending = null;
  };

  return {
    click(detail) {
      // 键盘触发（Enter/Space 合成的 click）没有"等一下看是不是双击"的必要
      if (detail === 0) {
        clear();
        input.onSingle();
        return;
      }
      // 连击的第二下：交给 doubleClick，绝不在这里再激活一次
      if (detail >= 2) {
        clear();
        return;
      }
      clear();
      pending = input.setTimer(() => {
        pending = null;
        input.onSingle();
      }, input.delay);
    },
    doubleClick() {
      clear();
      input.onDouble();
    },
    cancel: clear,
    isPending: () => pending !== null,
  };
}
