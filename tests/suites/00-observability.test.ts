/**
 * CT-12 / TIME-001：日志必须可机器解析，且带 UTC 时间戳与 traceId/operationId。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createHarness, ISO_UTC_RE, withTrace } from '../helpers.ts';
import { runWithOperation, startMonotonic } from '../../packages/observability/index.ts';

test('CT-12 日志记录包含 UTC 时间戳、traceId、operationId、module、errorCode', async () => {
  const h = await createHarness();
  try {
    await withTrace(h, async (traceId) => {
      runWithOperation('op-save-1', () => {
        h.logger.error('DOCUMENT_SAVE_FAILED', {
          module: undefined as never,
          resourceId: 'res-1',
          actorId: 'user-a',
          errorCode: 'ERR_DOCUMENT_VERSION_CONFLICT',
          result: 'REJECTED',
          durationMs: 12,
        });
      });
      const last = h.memorySink.records.at(-1);
      assert.ok(last, '应写入日志');
      assert.match(String(last.timestamp), ISO_UTC_RE, 'timestamp 必须是 UTC ISO 8601（Z 结尾）');
      assert.equal(last.level, 'ERROR');
      assert.equal(last.module, 'test.harness');
      assert.equal(last.event, 'DOCUMENT_SAVE_FAILED');
      assert.equal(last.runId, h.logger.runId);
      assert.equal(last.traceId, traceId, 'traceId 必须来自当前追踪上下文');
      assert.equal(last.operationId, 'op-save-1');
      assert.equal(last.resourceId, 'res-1');
      assert.equal(last.actorId, 'user-a');
      assert.equal(last.errorCode, 'ERR_DOCUMENT_VERSION_CONFLICT');
      assert.equal(last.result, 'REJECTED');
      assert.equal(last.durationMs, 12);
    });
  } finally {
    await h.cleanup();
  }
});

test('CT-12 日志文件为逐行 JSONL，可被外部工具解析', async () => {
  const h = await createHarness();
  try {
    h.logger.info('PROBE_JSONL', { result: 'OK' });
    const raw = await readFile(h.logPath, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1, '日志文件应有至少一行');
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      assert.match(String(parsed.timestamp), ISO_UTC_RE);
      assert.equal(typeof parsed.event, 'string');
      assert.equal(typeof parsed.level, 'string');
    }
  } finally {
    await h.cleanup();
  }
});

test('CT-12 耗时使用单调计时器且非负', () => {
  const elapsed = startMonotonic();
  const ms = elapsed();
  assert.ok(Number.isFinite(ms) && ms >= 0, `durationMs 必须为非负有限值，实际 ${ms}`);
});
