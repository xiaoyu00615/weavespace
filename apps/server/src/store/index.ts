/**
 * ProjectStore v2 模块唯一公开入口（UX-02B-02）。
 *
 * 职责：工作区配置 v2 的持久化与恢复、撤销墓碑日志、单实例锁、`opId` 结果查询。
 * 不负责：Provider / grant / 会话状态（那是 ProjectRuntime），也不提供任何 HTTP 入口。
 */
export {
  BACKUP_FILE,
  CONFIG_FILE,
  LOCK_FILE,
  LOG_FILE,
  StoreIoError,
  createNodeStoreIo,
  type StoreIo,
} from './io.ts';
export { createFileProjectStore, type FileProjectStore, type FileStoreOptions } from './file-store.ts';
export { checksumOf, parseConfig, serializeConfig, PROJECT_ID_RE, type ConfigState } from './config.ts';
export { LOG_HEAD_HASH, readLog, type LogReadResult, type RevocationEntry } from './revocation-log.ts';
export type {
  ConfigSource,
  OpOutcome,
  StoreIntegrity,
  StoreLoadState,
  StoreLogStatus,
  StoreRevokeReceipt,
  StoredProjectRecord,
} from './types.ts';
