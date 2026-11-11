/**
 * CT-03：保存成功 —— SAVE_COMMITTED + 内容/版本正确，且日志不得替代事实。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHarness, writeProjectFile, withTrace } from '../helpers.ts';
import { contentVersionOf } from '../../packages/storage/index.ts';

test('CT-03 保存提交：磁盘内容与版本正确，会话回到 CLEAN', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'draft.md', '# 初稿\n');
    const v = await h.document.openSession({ resourceId: 'res-draft', path: 'draft.md', provider: h.provider });
    const before = h.document.getSession(v.sessionId);
    assert.equal(before?.dirty, false);
    assert.match(String(before?.baseVersion), /^sha256:/);

    h.document.applyEdit(v.sessionId, '# 二稿\n正文\n');
    const saved = await h.document.save(v.sessionId, (b) => b);

    assert.equal(saved.status, 'COMMITTED');
    assert.equal(saved.contentVersion, contentVersionOf('# 二稿\n正文\n'));
    const after = h.document.getSession(v.sessionId);
    assert.equal(after?.dirty, false);
    assert.equal(after?.state, 'CLEAN');
    assert.equal(after?.baseVersion, saved.contentVersion);

    const disk = await readFile(join(h.root, 'draft.md'), 'utf8');
    assert.equal(disk, '# 二稿\n正文\n');
  } finally {
    await h.cleanup();
  }
});

test('CT-03b 保存事件序列为 SAVE_STARTED → SAVE_COMMITTED，并带 UTC 时间与耗时', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'seq.md', 'a\n');
    await withTrace(h, async (traceId) => {
      const v = await h.document.openSession({ resourceId: 'res-seq', path: 'seq.md', provider: h.provider });
      h.document.applyEdit(v.sessionId, 'b\n');
      await h.document.save(v.sessionId, (x) => x);

      const events = h.document.drainEvents();
      const started = events.findIndex((e) => e.type === 'SAVE_STARTED');
      const committed = events.findIndex((e) => e.type === 'SAVE_COMMITTED');
      assert.ok(started >= 0 && committed > started, '必须先 STARTED 后 COMMITTED');
      assert.equal(events[committed].errorCode, undefined, '成功不应带 errorCode');
      assert.ok(events[committed].traceId === traceId, 'traceId 必须贯穿保存事件');
      assert.match(String(events[committed].occurredAt), /Z$/);
      const durationMs = (events[committed].detail as { durationMs?: number }).durationMs;
      assert.equal(typeof durationMs, 'number');
    });
  } finally {
    await h.cleanup();
  }
});

test('CT-03c 通过 Command Bus 保存（含权限）返回 APPLIED 与 resultingVersion', async () => {
  const h = await createHarness();
  try {
    h.permission.grant({ actorId: 'user-a', action: 'read', scope: '' });
    h.permission.grant({ actorId: 'user-a', action: 'write', scope: '' });
    await writeProjectFile(h.root, 'cmd.md', 'one\n');

    const opened = await h.bus.dispatch(
      {
        commandId: 'cmd-c1',
        type: 'document.open',
        payload: { resourceId: 'res-cmd', path: 'cmd.md', providerId: 'local' },
      },
      { actorId: 'user-a' },
    );
    const { sessionId } = opened.result as { sessionId: string };

    const edited = await h.bus.dispatch(
      {
        commandId: 'cmd-c2',
        type: 'document.applyEdit',
        expectedVersion: 'rev-0',
        payload: { sessionId, buffer: 'two\n' },
      },
      { actorId: 'user-a' },
    );
    assert.equal(edited.status, 'APPLIED');

    const saved = await h.bus.dispatch(
      {
        commandId: 'cmd-c3',
        type: 'document.save',
        expectedVersion: h.document.getSession(sessionId)!.baseVersion!,
        payload: { sessionId },
      },
      { actorId: 'user-a' },
    );
    assert.equal(saved.status, 'APPLIED');
    assert.equal(saved.resultingVersion, contentVersionOf('two\n'));
    assert.equal(await readFile(join(h.root, 'cmd.md'), 'utf8'), 'two\n');
  } finally {
    await h.cleanup();
  }
});

test('CT-03e 经 Command Bus 的保存事件携带请求 traceId（可端到端排障）', async () => {
  const h = await createHarness();
  try {
    h.permission.grant({ actorId: 'user-a', action: 'read', scope: '' });
    h.permission.grant({ actorId: 'user-a', action: 'write', scope: '' });
    await writeProjectFile(h.root, 'traced.md', 'v1\n');

    const opened = await h.bus.dispatch(
      {
        commandId: 'cmd-t1',
        type: 'document.open',
        payload: { resourceId: 'res-traced', path: 'traced.md', providerId: 'local' },
      },
      { actorId: 'user-a', traceId: 'trace-e2e-001' },
    );
    const { sessionId } = opened.result as { sessionId: string };
    const base = h.document.getSession(sessionId)!.baseVersion!;
    h.document.applyEdit(sessionId, 'v2\n');

    await h.bus.dispatch(
      {
        commandId: 'cmd-t2',
        type: 'document.save',
        expectedVersion: base,
        payload: { sessionId },
      },
      { actorId: 'user-a', traceId: 'trace-e2e-001' },
    );

    const committed = h.document.drainEvents().find((e) => e.type === 'SAVE_COMMITTED');
    assert.equal(committed?.traceId, 'trace-e2e-001', 'document 事件必须继承命令的 traceId');

    const audit = h.auditSink.records.filter((r) => r.traceId === 'trace-e2e-001');
    assert.ok(audit.length >= 2, '同一条 traceId 应能覆盖多个审计记录');
  } finally {
    await h.cleanup();
  }
});

test('CT-03d 日志不是成功来源：无保存动作时不得出现 SAVE_COMMITTED', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'noop.md', 'k\n');
    const v = await h.document.openSession({ resourceId: 'res-noop', path: 'noop.md', provider: h.provider });
    h.document.applyEdit(v.sessionId, 'k2\n');
    assert.equal(
      h.memorySink.records.some((r) => r.event === 'SAVE_COMMITTED'),
      false,
    );
  } finally {
    await h.cleanup();
  }
});
