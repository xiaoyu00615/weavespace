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

/** 目标父层重取的真实结果（与 `StructureCheckOutcome` 同义，这里不重复定义）。 */
export type MoveTargetRefresh = 'idle' | 'pending' | 'done' | 'failed';

export interface MoveTargetReconfirmInput {
  /** Host 回过 `ERR_ENTRY_TARGET_CHANGED`：冻结锚已过期。 */
  readonly targetStale: boolean;
  readonly targetRefresh: MoveTargetRefresh;
  /** 对话框里冻结的那一个锚（用户当初选中的目标）。 */
  readonly frozenAnchor: string | null;
  /** 当前层表里的锚（`targetIdentityOf` 现读）。 */
  readonly currentAnchor: string | null;
}

export const MOVE_TARGET_UNREFRESHED =
  '还没有读到目标文件夹的最新状态：请刷新文件树后再点「重新确认目标」';

/**
 * "重新确认目标"能不能放行（UX-02C-02-R2.2-PATCH / P02）。
 *
 * 背景：目标被外部删除重建后，Host 会回 `ERR_ENTRY_TARGET_CHANGED`，
 * 对话框进而重取**目标所属父层**。可是重取可能失败（`failed`）、可能同层还有
 * 在途请求（`skipped-inflight`）、可能世界已经切走（`stale`）——那时层表里
 * 仍是**旧锚**。若把旧锚当"磁盘当前身份"交给用户确认，用户会拿着同一个过期锚
 * 再撞一次同样的墙，而且这一次界面还说"已重新确认"。
 *
 * 放行条件只有两个，都要求"层表里的锚真的换了"：
 * 1. 本次重取明确成功（`done`）；
 * 2. 或者锚本身已经变了（用户手工刷新过文件树）。
 * 其余情况一律拒绝，并如实说明"还没读到最新状态"。
 */
export function moveTargetReconfirmProblem(input: MoveTargetReconfirmInput): string | null {
  if (!input.targetStale) return null;
  if (input.currentAnchor === null) return null;
  if (input.targetRefresh === 'done') return null;
  if (input.currentAnchor !== input.frozenAnchor) return null;
  return MOVE_TARGET_UNREFRESHED;
}
