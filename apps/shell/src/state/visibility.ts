/**
 * 文件树可见性命令的**判定与文案**（UX-02C-03-P1）。
 *
 * 为什么单独成模块：`.tsx` 无法被 `node:test` import（没有 JSX 变换），而
 * "右键这一行到底该给『隐藏』还是『取消隐藏』、什么时候禁用、为什么禁用"
 * 是产品的可见行为，必须能被直接断言，而不是靠读 JSX 猜。
 *
 * 这里**不做 IO、不判权限、不认识磁盘**：`supported` 由调用方按
 * 模式 / 项目状态算好（与创建、改名用的是同一个 `isSupported`）。
 */

export type VisibilityOrigin =
  | 'file'
  | 'folder'
  | 'link'
  | 'project-root'
  | 'blank'
  | 'toolbar';

export interface VisibilityTargetLike {
  readonly origin: VisibilityOrigin;
  readonly projectId: string | null;
  readonly nodePath?: string | null;
  /** 该行自身是否已有隐藏记录（只有"显示隐藏项"打开时才可能为 true）。 */
  readonly nodeHidden?: boolean;
}

export type VisibilityAction = 'hide' | 'unhide';

export interface VisibilityCommandState {
  /** 是否渲染这一项。`false` = 当前上下文根本不适用（不是"禁用"）。 */
  readonly visible: boolean;
  /** 渲染时执行的动作；`visible: false` 时为 null。 */
  readonly action: VisibilityAction | null;
  readonly disabled: boolean;
  /** 禁用原因；正常可用时为 undefined。 */
  readonly hint?: string;
}

const UNSUPPORTED_HINT = '当前模式或项目不支持工作台隐藏（需要已授权项目）';

/**
 * 计算菜单项状态。
 *
 * 规则（P1 范围）：
 * - 文件 / 文件夹 → 可隐藏；
 * - 链接 → **不提供**：链接节点与"路径经过重解析点"共用同一条边界，
 *   Host 会以 `ERR_PATH_OUTSIDE_ROOT` 拒绝（见 `apps/server/src/hidden.ts`）；
 * - 项目根 / 空白区 / 工具栏 → 不提供（移除项目是另一条链路）；
 * - 已隐藏的行 → 只给"取消隐藏"。
 */
export function visibilityCommandState(input: {
  target: VisibilityTargetLike;
  supported: boolean;
}): VisibilityCommandState {
  const { target, supported } = input;
  const path = (target.nodePath ?? '').replace(/\\/g, '/');
  const applicable =
    target.projectId !== null &&
    path !== '' &&
    (target.origin === 'file' || target.origin === 'folder');
  if (!applicable) return { visible: false, action: null, disabled: true };
  const action: VisibilityAction = target.nodeHidden === true ? 'unhide' : 'hide';
  return supported
    ? { visible: true, action, disabled: false }
    : { visible: true, action, disabled: true, hint: UNSUPPORTED_HINT };
}

/**
 * 结果提示。
 *
 * 隐藏必须把"文件没被删除"说清楚：这是本功能最容易被误解的一点，
 * 只说"已隐藏"会让用户担心数据没了。
 */
export function visibilityNotice(path: string, hidden: boolean): string {
  if (hidden) {
    return `已从文件树隐藏「${path}」（磁盘文件未删除、内容未改动；可用「显示隐藏项」找回）`;
  }
  return `已取消隐藏「${path}」：文件树恢复显示（磁盘内容自始至终未改动）`;
}

/** 幂等命中（`changed: false`）时的提示：不能假装"刚刚隐藏了"。 */
export function visibilityNoopNotice(path: string, hidden: boolean): string {
  return hidden
    ? `「${path}」本来就已经隐藏，未做任何改动`
    : `「${path}」本来就没有隐藏，未做任何改动`;
}

/** 结果未确认（网络中断）时的提示：只能让用户核对，不能宣布成功。 */
export function visibilityUnknownNotice(): string {
  return '隐藏状态未确认：已刷新该目录，请人工核对（不会自动重试）';
}
