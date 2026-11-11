/**
 * contracts 模块唯一公开入口。
 * 只包含类型、错误码与协议常量；不依赖任何具体实现（ENG-002）。
 * 状态：P0 草案，冻结前保持 DRAFT（docs/18 RSK-01/02）。
 */
export { ALL_ERROR_CODES, ERROR_CODES, type ErrorCode } from './errors.ts';
export type {
  CommandEnvelope,
  CommandResult,
  CommandStatus,
  DocumentState,
  DocumentStateView,
  EventEnvelope,
  LogLevel,
  LogRecord,
  PluginManifest,
  PluginStatus,
  ResourceRef,
  SaveResult,
  SaveStatus,
} from './types.ts';
