/**
 * 核心数据类型（P0 草案，非最终 SDK）。
 * 与 docs/04 的伪 TypeScript 对齐；字段只增不改，冻结前保持 DRAFT。
 */
import type { ErrorCode } from './errors.ts';

export type CommandStatus = 'APPLIED' | 'REJECTED' | 'FAILED' | 'UNKNOWN';
export type SaveStatus = 'COMMITTED' | 'CONFLICT' | 'FAILED' | 'UNKNOWN';
export type DocumentState =
  | 'CLEAN'
  | 'EDITING_DIRTY'
  | 'SAVING'
  | 'CONFLICT'
  | 'FAILED'
  | 'OUTCOME_UNKNOWN';
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type PluginStatus =
  | 'DISCOVERED'
  | 'VALIDATED'
  | 'REGISTERED'
  | 'ACTIVATING'
  | 'ACTIVE'
  | 'DEACTIVATING'
  | 'INACTIVE'
  | 'BLOCKED_DEPENDENCY'
  | 'DENIED_PERMISSION'
  | 'FAILED'
  | 'QUARANTINED';

export interface ResourceRef {
  resourceId: string;
  uri: string;
  providerId: string;
  contentVersion?: string;
}

export interface DocumentStateView {
  sessionId: string;
  resourceId: string;
  baseVersion: string | null;
  revision: number;
  dirty: boolean;
  state: DocumentState;
  views: number;
  /**
   * 会话失效标记（G1）。与六态状态机**正交**：不改变 `state`，只表示"所属项目根
   * 已不可用，磁盘访问被拒绝"。草稿与 revision/baseVersion 一律保持原值。
   */
  stale?: {
    reason: string;
    since: string;
  };
}

export interface CommandEnvelope<T = unknown> {
  commandId: string;
  idempotencyKey?: string;
  type: string;
  expectedVersion?: string;
  target?: ResourceRef;
  payload: T;
}

export interface CommandResult<T = unknown> {
  commandId: string;
  status: CommandStatus;
  result?: T;
  errorCode?: ErrorCode;
  resultingVersion?: string;
}

export interface EventEnvelope<T = unknown> {
  eventId: string;
  streamId: string;
  sequence: number;
  occurredAt: string;
  traceId: string;
  type: string;
  data: T;
}

export interface SaveResult {
  status: SaveStatus;
  errorCode?: ErrorCode;
  contentVersion?: string;
  durationMs?: number;
}

export interface PluginManifest {
  id: string;
  version: string;
  apiVersion: string;
  fileExtensions: string[];
  provides: string[];
  requires: string[];
  requestedPermissions: string[];
  activationEvents: string[];
  entrypoints: { host?: string; client?: string };
}

/**
 * 查看器能力契约（能力标识 `file.viewer`，S10-A）。
 *
 * 插件只提供「如何把内容变成可显示节点」，**不**接触存储、会话或保存链路；
 * 宿主负责渲染与回退。返回值对 contracts 而言是不透明节点（`unknown`），
 * 由宿主按其渲染运行时解释，避免 contracts 反向依赖具体 UI 实现（ENG-002）。
 */
export interface ViewerRenderInput {
  content: string;
  path: string;
}

export interface ViewerCapability {
  /** 契约版本，与宿主 `CAPABILITY_API_MAJOR` 对齐。 */
  readonly apiVersion: string;
  /** 该实现可处理的扩展名（小写、含点）；由宿主据此选择实现。 */
  readonly extensions: readonly string[];
  render(input: ViewerRenderInput): unknown;
}

/** 结构化日志记录（docs/09 必填字段）。 */
export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  module: string;
  event: string;
  runId: string;
  traceId: string;
  operationId?: string;
  resourceId?: string;
  actorId?: string;
  result?: string;
  errorCode?: ErrorCode;
  durationMs?: number;
  [extra: string]: unknown;
}
