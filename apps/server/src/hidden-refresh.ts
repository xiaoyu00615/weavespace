/**
 * 保存成功后"是否允许刷新隐藏记录身份"的**纯判定**（UX-02C-03-P1-R1）。
 *
 * 为什么单独成模块：这是本轮最容易被"看起来对"骗过去的一步。
 * 保存的实现是 `临时文件 + rename`，**必然换 inode**；因此保存后同路径的
 * `identityOf()` 与记录里的身份永远不同。如果据此直接回写新身份，就等于
 * "谁现在占着这个路径，就把谁当成用户当初隐藏的那个对象"——
 * 外部删掉再重建的新文件会因此被旧记录吞掉（复审 R1-02 缺陷）。
 *
 * 判定需要的三份证据（缺一不可）：
 * 1. **保存前**：路径上的对象身份必须仍等于记录里的身份（记录仍是 `active`）；
 * 2. **提交侧**：Provider 必须回报本次写入对象的身份（`SaveResult.identity`，
 *    由 rename 前的临时文件取得，见 `local-provider.ts` 的 `writeEstablished`）；
 * 3. **保存后**：路径上的对象身份必须正好等于提交侧回报的身份。
 *
 * 第 3 条是"本次保存确实落在该路径上"的证据：外部进程在提交之后替换了目标，
 * 第 3 条就不成立 → 必须跳过，保留 `rebound` 让用户看见，而不是把替换对象绑上。
 *
 * 任何一条不成立都只返回 `skip` + 明确原因，由调用方记诊断、不重试。
 */
export interface HiddenRefreshRecordLike {
  readonly identity: string;
  readonly rootToken: string;
}

export type HiddenRefreshSkipReason =
  /** 该路径没有隐藏记录（本来就不需要刷新）。 */
  | 'no-record'
  /** Provider 没有对象身份能力，无法核验"还是不是同一个对象"。 */
  | 'provider-unsupported'
  /** 记录属于另一个项目根：旧根的记录不得作用于新根里的同名路径。 */
  | 'root-changed'
  /** 保存前该路径已经不存在。 */
  | 'missing'
  /** 保存前的身份读取失败（IO/根漂移）：无法证明"还是同一个对象"。 */
  | 'pre-read-failed'
  /** 保存前路径上的对象已经不是记录里的对象（外部替换）。 */
  | 'rebound'
  /** Provider 的保存结果没有携带提交身份，无法证明归属。 */
  | 'no-save-identity'
  /** 保存后该路径不存在（被并发删除）。 */
  | 'post-missing'
  /** 保存后路径上的对象不是本次提交写入的对象（提交后被替换）。 */
  | 'post-mismatch';

export type HiddenRefreshDecision =
  | { readonly action: 'skip'; readonly reason: HiddenRefreshSkipReason }
  | { readonly action: 'update'; readonly identity: string };

export interface HiddenRefreshInput {
  readonly record: HiddenRefreshRecordLike | undefined;
  /** 当前项目根的令牌（来自 Host 的 handle，不是客户端声明）。 */
  readonly rootToken: string;
  readonly providerSupportsIdentity: boolean;
  /** 保存**之前**读到的路径身份；`null` = 路径不存在。 */
  readonly preIdentity: string | null;
  /** 保存前的身份读取本身失败（不是"不存在"）。 */
  readonly preReadFailed?: boolean;
  /** Provider 回报的"本次写入对象"的身份；`null`/缺失 = 无证据。 */
  readonly savedIdentity: string | null;
  /** 保存**之后**读到的路径身份；`null` = 路径不存在。 */
  readonly postIdentity: string | null;
}

export function decideHiddenRefresh(input: HiddenRefreshInput): HiddenRefreshDecision {
  if (!input.record) return { action: 'skip', reason: 'no-record' };
  if (!input.providerSupportsIdentity) return { action: 'skip', reason: 'provider-unsupported' };
  if (input.record.rootToken !== input.rootToken) return { action: 'skip', reason: 'root-changed' };

  // 保存前必须是"同一个对象"，否则这次保存写的不是用户当初隐藏的东西
  if (input.preReadFailed) return { action: 'skip', reason: 'pre-read-failed' };
  if (input.preIdentity === null) return { action: 'skip', reason: 'missing' };
  if (input.preIdentity !== input.record.identity) return { action: 'skip', reason: 'rebound' };

  // 没有提交侧证据 → 不得用"保存后同路径身份"顶替（那正是 R1-02 的错误）
  if (input.savedIdentity === null) return { action: 'skip', reason: 'no-save-identity' };
  if (input.postIdentity === null) return { action: 'skip', reason: 'post-missing' };
  if (input.postIdentity !== input.savedIdentity) return { action: 'skip', reason: 'post-mismatch' };

  return { action: 'update', identity: input.postIdentity };
}
