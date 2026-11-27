/**
 * 提交结束后"该不该把焦点还回去"（UX-02C-02-R2.1 / E）。
 *
 * 为什么值得单独一个模块：`.tsx` 不能被 `node:test` import，而焦点这件事的
 * 全部难点都在**判定**上——什么时候该还、什么时候绝不能抢。剩下的
 * `focus()` / `setSelectionRange()` 只是一行 DOM 调用，真实浏览器负责验证。
 *
 * 背景（既有缺陷，R2 复审已记入 docs/33 §8 R2-R4）：提交期间输入框被 `disabled`，
 * 浏览器会把焦点扔到 `body`；结果回来、`disabled` 解除之后**没有人**再把焦点还回去。
 * 于是用户在"改名被拒"之后按 Escape / Enter 毫无反应——不是快捷键坏了，
 * 是那两下按在 `body` 上。
 *
 * 三条纪律（违反任何一条都会变成"抢焦点"的新缺陷）：
 * 1. 只还给自己：焦点原本在别处（正文编辑器、另一个对话框）时不碰；
 * 2. 只在请求真的结束那一帧还：不因为重渲染反复抢；
 * 3. 只还给**同一个会话**：旧请求回来时新会话已经打开/已经收起，就不还。
 */

/** 焦点此刻在哪：本输入框 / 无处（body）/ 别处。 */
export type FocusWhere = 'self' | 'body' | 'elsewhere';

/**
 * 把 DOM 的事实折算成三态。
 *
 * `own` 是本组件的输入框（或对话框里的主按钮）；`active` 是 `document.activeElement`。
 * 两者都是 `null` 时按 `body` 处理——"没有任何元素有焦点"正是我们要还回去的场景。
 */
export function focusWhereOf(
  active: { readonly tagName?: string } | null,
  own: { readonly tagName?: string } | null,
): FocusWhere {
  if (active === null || active.tagName === 'BODY' || active.tagName === undefined) return 'body';
  if (own !== null && active === own) return 'self';
  return 'elsewhere';
}

export interface FocusRestoreInput {
  /** 提交刚刚结束（`submitting` 由 true 变 false 的那一次渲染）。 */
  readonly ended: boolean;
  /** 这次提交的票据仍属于当前会话（会话没被收起、也没被顶替）。 */
  readonly sessionCurrent: boolean;
  /** 提交开始那一刻焦点在哪。 */
  readonly atStart: FocusWhere;
  /** 此刻焦点在哪。 */
  readonly now: FocusWhere;
}

/**
 * 是否把焦点还回去。
 *
 * 允许的两种情形：
 * - 提交开始时焦点就在本输入框里（用户按了 Enter / 点了 ✓）；
 * - 提交开始时**没有任何焦点**（`disabled` 已经先一步把焦点扔掉了）。
 *
 * 不允许：用户已经点了别处（编辑正文、切到另一个对话框）。那种情况下
 * 程序化 `focus()` 会把他正在写的东西打断——比"Escape 不灵"更糟。
 */
export function shouldRestoreFocus(input: FocusRestoreInput): boolean {
  if (!input.ended) return false;
  if (!input.sessionCurrent) return false;
  if (input.atStart === 'elsewhere') return false;
  if (input.now === 'elsewhere') return false;
  return true;
}
