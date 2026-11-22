/**
 * 回收区支持的对象长度（UX-02C-03-P2-01-R2-Supplement-R1 / R1-02）。
 *
 * 为什么需要单独一条约束：回收记录、`manifest.json`、恢复时的三方核对都建立在
 * "`size` 能被 Number 精确表示"这个前提上。一旦长度超过 2^53-1，`stats.size` 本身就
 * 已经失真，写进记录的就是一条**注定恢复不了**的回收记录——既删不掉也没法还原。
 *
 * 因此把"可接受的长度"收敛成**唯一一处**判定，Provider（写入侧）与 Store（读配置侧）
 * 共用它：两边对"什么长度合法"的理解必须完全一致，否则会出现"写得进、读不回"
 * 或者"读得回、恢复不了"的组合。
 */
export const MAX_TRASH_BYTES = Number.MAX_SAFE_INTEGER;

/** 长度是否在本阶段支持的范围内（非负安全整数）。 */
export function isTrashSizeSupported(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
