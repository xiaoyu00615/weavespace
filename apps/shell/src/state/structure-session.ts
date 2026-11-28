/**
 * 会话状态的写入守卫（UX-02C-02-R2.2 / F03 后半）。
 *
 * 为什么不是"提交前判一次就够了"：结果回来时界面可能已经换了会话——
 * 用户关掉了移动对话框、又对另一行打开了新的；或者干脆切去改别的文件名了。
 * 旧实现先用 ref 读一次"当前是不是还是我"，再调 `setState(null)` /
 * `setState({...submitting:false})`。两次读之间隔着 React 的批处理，
 * 而且 ref 只在渲染时更新：新会话已经挂上、ref 还没刷新时，
 * 旧结果就会把**新会话**的错误位、提交状态甚至"是否打开"改掉。
 *
 * 正确做法是把票据核验放进**函数式状态更新器内部**：更新器拿到的是那一刻
 * 真正的 current，门票不符就原样返回。这里把它抽成纯函数，既让两条会话
 * （行内改名 / 移动对话框）共用同一实现，也让它可被 `node:test` 直接断言
 * （`.tsx` 不能被 import）。
 *
 * 不建立第二套会话框架：票据仍是 `StructureIntent.sessionId`，
 * 判据仍是 `structureSessionApplies`（= 同一张票据且会话未收起）。
 */
import { structureSessionApplies } from './structure-intent.ts';

/**
 * 只有当前会话仍属于这条票据时，才执行 `update`。
 *
 * - `current === null`：会话已收起。旧结果不能把它复活。
 * - 票据不符：这是**别人的会话**（新的），一个字段都不许改。
 * - 票据相符：才执行真正的更新；`update` 返回 `null` 表示收起会话。
 */
export function updateSessionIfOwned<S>(
  current: S | null,
  sessionId: number,
  sessionIdOf: (state: S) => number | null,
  update: (state: S) => S | null,
): S | null {
  if (current === null) return null;
  if (!structureSessionApplies({ sessionId, currentSessionId: sessionIdOf(current) })) return current;
  return update(current);
}
