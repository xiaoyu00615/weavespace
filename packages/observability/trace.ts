/**
 * 追踪上下文：traceId / operationId 通过 AsyncLocalStorage 传递，
 * 避免每个函数显式穿参，又不引入全局可变状态。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface TraceContext {
  traceId: string;
  operationId?: string;
  runId: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

export function newTraceId(): string {
  return `trace-${randomUUID()}`;
}

export function newOperationId(): string {
  return `op-${randomUUID()}`;
}

/** 在当前上下文缺失时创建新的 TraceContext。 */
export function currentTrace(): TraceContext | undefined {
  return storage.getStore();
}

/** 在指定追踪上下文中执行 fn；无 trace 时生成一个新的。 */
export function runWithTrace<T>(trace: Partial<TraceContext> & { runId: string }, fn: () => T): T {
  const ctx: TraceContext = {
    traceId: trace.traceId ?? newTraceId(),
    operationId: trace.operationId,
    runId: trace.runId,
  };
  return storage.run(ctx, fn);
}

/** 派生一个带新 operationId 的子作用域，保留 traceId/runId。 */
export function runWithOperation<T>(operationId: string, fn: () => T): T {
  const parent = currentTrace();
  if (!parent) {
    throw new Error('runWithOperation 必须在 runWithTrace 内调用');
  }
  return storage.run({ ...parent, operationId }, fn);
}

/** 单调计时器（毫秒），用于耗时统计，避免墙钟回拨影响。 */
export function startMonotonic(): () => number {
  const t0 = performance.now();
  return () => Math.round((performance.now() - t0) * 1000) / 1000;
}

/** 当前 UTC 时间戳，ISO 8601 带 Z。 */
export function utcNow(clock: () => Date = () => new Date()): string {
  return clock().toISOString();
}
