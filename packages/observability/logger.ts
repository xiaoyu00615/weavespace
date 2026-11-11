/**
 * 结构化 JSONL 日志（docs/09 Operational Logs）。
 * - 每条记录必须带 UTC ISO 8601 `timestamp`（以 Z 结尾）。
 * - 日志不是业务事实源：不用于推断保存成功。
 * - 写入失败必须降级为 stderr 提示，不得阻塞业务流程（docs/09 日志 IO 失败受控降级）。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ErrorCode } from '../contracts/errors.ts';
import type { LogLevel, LogRecord } from '../contracts/types.ts';
import { currentTrace, utcNow } from './trace.ts';

export interface LogSink {
  readonly name: string;
  write(record: LogRecord): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

/** 内存 sink：测试断言用。 */
export function createMemorySink(): LogSink & { records: LogRecord[]; clear(): void } {
  const records: LogRecord[] = [];
  return {
    name: 'memory',
    records,
    write(record: LogRecord) {
      records.push(record);
    },
    clear() {
      records.length = 0;
    },
  };
}

/** JSONL 文件 sink：一行一条记录。写入异常不会抛出到业务调用方。 */
export function createJsonlFileSink(filePath: string): LogSink {
  mkdirSync(dirname(filePath), { recursive: true });
  return {
    name: 'jsonl-file',
    write(record: LogRecord) {
      try {
        appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
      } catch (err) {
        process.stderr.write(
          `[weavespace.observability] log sink write failed: ${(err as Error).message}\n`,
        );
      }
    },
  };
}

export interface LoggerOptions {
  module: string;
  runId: string;
  sinks: LogSink[];
  minLevel?: LogLevel;
  clock?: () => Date;
}

export interface LogFields {
  event: string;
  level?: LogLevel;
  traceId?: string;
  operationId?: string;
  resourceId?: string;
  actorId?: string;
  result?: string;
  /** 必须是错误码注册表中的稳定码（contracts/errors.ts），不接受任意字符串。 */
  errorCode?: ErrorCode;
  durationMs?: number;
  [extra: string]: unknown;
}

export interface Logger {
  readonly module: string;
  readonly runId: string;
  log(fields: LogFields): LogRecord;
  debug(event: string, fields?: Omit<LogFields, 'event' | 'level'>): LogRecord;
  info(event: string, fields?: Omit<LogFields, 'event' | 'level'>): LogRecord;
  warn(event: string, fields?: Omit<LogFields, 'event' | 'level'>): LogRecord;
  error(event: string, fields?: Omit<LogFields, 'event' | 'level'>): LogRecord;
  child(module: string): Logger;
}

export function createLogger(options: LoggerOptions): Logger {
  const { module, runId, sinks } = options;
  const minLevel = options.minLevel ?? 'INFO';
  const clock = options.clock ?? (() => new Date());

  function log(fields: LogFields): LogRecord {
    const trace = currentTrace();
    const level = fields.level ?? 'INFO';
    const record: LogRecord = {
      ...fields,
      timestamp: utcNow(clock),
      level,
      module,
      event: fields.event,
      runId,
      traceId: fields.traceId ?? trace?.traceId ?? 'trace-unbound',
    };
    if (record.operationId === undefined && trace?.operationId) {
      record.operationId = trace.operationId;
    }
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) {
      return record;
    }
    for (const sink of sinks) {
      sink.write(record);
    }
    return record;
  }

  const at =
    (level: LogLevel) =>
    (event: string, fields: Omit<LogFields, 'event' | 'level'> = {}): LogRecord =>
      log({ ...fields, event, level });

  return {
    module,
    runId,
    log,
    debug: at('DEBUG'),
    info: at('INFO'),
    warn: at('WARN'),
    error: at('ERROR'),
    child(childModule: string) {
      return createLogger({ module: childModule, runId, sinks, minLevel, clock });
    },
  };
}
