/**
 * ProjectStore v2 的契约类型（UX-02B-02）。
 *
 * 单独成文件是为了让 `project-runtime.ts` 只以 `import type` 依赖它，
 * 避免 Store ↔ Runtime 的运行时循环依赖。
 */

/** 加载后的完整性判定（ADR-022 §3.2）。 */
export type StoreIntegrity = 'OK' | 'DEGRADED' | 'RECOVERY_RESTRICTED';

/** 撤销日志的实际状态；`created` = 本次启动补写了日志头。 */
export type StoreLogStatus = 'ok' | 'created' | 'missing' | 'broken';

export type ConfigSource = 'primary' | 'backup' | 'none';

/**
 * 加载报告。
 *
 * `diskTrusted === false` 时 Runtime **一份 G-DISK 授权都不能发**：
 * 撤销集合不可证（日志缺失/断裂/序号无法解释），此时"配置里有这个项目"
 * 不能证明它没被撤销过。
 */
export interface StoreLoadState {
  readonly integrity: StoreIntegrity;
  readonly diskTrusted: boolean;
  readonly mutationsAllowed: boolean;
  readonly log: StoreLogStatus;
  readonly configSource: ConfigSource;
  readonly commitSeq: number;
  readonly notes: readonly string[];
}

/** `opId` 查询结果：只认与本次 opId 精确匹配的持久证据（ADR-022 §7.1）。 */
export type OpOutcome = 'created' | 'revoked' | 'aborted' | 'unknown';

/**
 * 撤销提交回执。
 *
 * `configPersisted === false` 表示墓碑已生效但配置补写失败
 * （`REVOKED_PENDING_CONFIG`）：项目**已经**不可访问，不得回滚、不得重新授权。
 */
export interface StoreRevokeReceipt {
  readonly configPersisted: boolean;
}

/** 持久化条目（不含任何授权令牌副本以外的运行时对象）。 */
export interface StoredProjectRecord {
  readonly projectId: string;
  readonly name: string;
  readonly rootDir: string;
  readonly canonicalRoot?: string;
  readonly rootToken?: string;
  readonly grantedAt?: string;
  readonly grantSource?: string;
  readonly createdByOp?: string;
}
