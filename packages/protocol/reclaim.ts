/**
 * "回收本页面遗留 View" 的协议常量与分批规则（UX-02C-02-R1.3）。
 *
 * 这个上限属于**协议边界**而不是某一侧的实现细节：Host 用它拒绝超大批次，
 * 客户端必须按同一个数字切分，否则一旦待回收路径超过上限，整批会被 400 拒绝
 * ——那等于"一条都没回收"，而且失败点离用户很远（改名时才发现 409）。
 *
 * 因此常量放在两侧都能引用的地方，避免两边各写一个"看起来一样"的数字。
 */

/** `POST /api/views/reclaim` 单次最多接受的路径数。 */
export const MAX_RECLAIM_PATHS = 64;

/**
 * 按协议上限把路径切成若干批。
 *
 * 只做切分：**不排序、不去重、不改写**路径。顺序与调用方给出的完全一致，
 * 因此"第 i 条路径属于哪一批"是确定的，失败时也能如实报出规模。
 * 去重由调用方负责（它才知道"重复"对业务意味着什么）。
 */
export function chunkReclaimPaths(
  paths: readonly string[],
  limit: number = MAX_RECLAIM_PATHS,
): string[][] {
  if (!Number.isInteger(limit) || limit <= 0) {
    // 内部不变量：调用方只该传协议常量或测试用的正数
    throw new Error(`分批上限必须是正整数，收到 ${String(limit)}`);
  }
  const chunks: string[][] = [];
  for (let start = 0; start < paths.length; start += limit) {
    chunks.push(paths.slice(start, start + limit));
  }
  return chunks;
}
