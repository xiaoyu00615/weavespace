/**
 * P0 测试共用装配（测试专用，不属于任何生产模块）。
 * 所有测试在**进程内**执行：本机沙箱禁止子进程管道（EPERM），故用单进程多套件装载。
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createLocalProvider,
  type LocalProviderOptions,
  type StorageProvider,
} from '../packages/storage/index.ts';
import {
  createJsonlFileSink,
  createLogger,
  createMemorySink,
  runWithTrace,
  type Logger,
  type LogSink,
} from '../packages/observability/index.ts';
import { createDocumentService, type DocumentService } from '../packages/document/index.ts';
import { createPermissionService, type GrantEntry, type PermissionService } from '../packages/permission/index.ts';
import { createCommandBus, type CommandBus } from '../packages/command/index.ts';
import { createPluginRuntime, type PluginRuntime } from '../packages/plugin-runtime/index.ts';
import type { LogRecord } from '../packages/contracts/types.ts';

export const RUN_ID = `run-p0-${Date.now()}`;
export const LOG_DIR = resolve(process.cwd(), 'logs/p0');

export interface Harness {
  root: string;
  provider: StorageProvider;
  logger: Logger;
  memorySink: LogSink & { records: LogRecord[]; clear(): void };
  auditSink: LogSink & { records: LogRecord[]; clear(): void };
  document: DocumentService;
  permission: PermissionService;
  bus: CommandBus;
  plugins: PluginRuntime;
  logPath: string;
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  faults?: LocalProviderOptions['faults'];
  grants?: GrantEntry[];
  hasDirtyState?: (pluginId: string) => boolean;
}

/** 建一个真实临时项目目录 + 完整 P0 装配。 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ws-p0-'));
  const provider = createLocalProvider({ rootDir: root, faults: options.faults });

  const memorySink = createMemorySink();
  const logPath = join(LOG_DIR, `p0-${RUN_ID}.jsonl`);
  const auditPath = join(LOG_DIR, `audit-${RUN_ID}.jsonl`);
  await mkdir(LOG_DIR, { recursive: true });
  const fileSink = createJsonlFileSink(logPath);
  const auditFileSink = createJsonlFileSink(auditPath);

  // 审计与运行日志分流（docs/09：Audit Records 独立保留策略），filesink 仍全量落盘。
  const auditRecords: LogRecord[] = [];
  const auditSink = {
    name: 'audit',
    records: auditRecords,
    write(record: LogRecord) {
      if (record.kind !== 'AUDIT') return;
      auditRecords.push(record);
      auditFileSink.write(record);
    },
    clear() {
      auditRecords.length = 0;
    },
  };

  const logger = createLogger({
    module: 'test.harness',
    runId: RUN_ID,
    sinks: [fileSink, memorySink, auditSink],
  });

  const document = createDocumentService({ logger: logger.child('document') });
  const permission = createPermissionService(options.grants ?? []);
  const bus = createCommandBus({
    document,
    permission,
    logger: logger.child('command'),
    resolveProvider: (id) => (id === 'local' ? provider : undefined),
  });
  const plugins = createPluginRuntime({
    logger: logger.child('plugin-runtime'),
    hasDirtyState: options.hasDirtyState ?? (() => false),
  });

  return {
    root,
    provider,
    logger,
    memorySink,
    auditSink,
    document,
    permission,
    bus,
    plugins,
    logPath,
    async cleanup() {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** 在带 trace 的上下文中执行一段逻辑，便于断言 traceId 贯穿。 */
export function withTrace<T>(harness: Harness, fn: (traceId: string) => Promise<T>): Promise<T> {
  const traceId = `trace-${Math.random().toString(16).slice(2, 10)}`;
  return runWithTrace({ runId: RUN_ID, traceId }, () => fn(traceId));
}

export async function writeProjectFile(root: string, relPath: string, content: string): Promise<void> {
  const full = join(root, relPath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf8');
}

export function eventsByType(records: LogRecord[], event: string): LogRecord[] {
  return records.filter((r) => r.event === event);
}

export const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
