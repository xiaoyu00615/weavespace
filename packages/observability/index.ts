/**
 * observability 模块唯一公开入口。
 * 职责：UTC 时间戳、trace/operation 上下文、单调耗时、JSONL 日志。
 * 不拥有业务状态，不作为保存成功等事实依据。
 */
export {
  createLogger,
  createMemorySink,
  createJsonlFileSink,
  type Logger,
  type LoggerOptions,
  type LogFields,
  type LogSink,
} from './logger.ts';
export {
  currentTrace,
  newOperationId,
  newTraceId,
  runWithOperation,
  runWithTrace,
  startMonotonic,
  utcNow,
  type TraceContext,
} from './trace.ts';
