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
