/**
 * CT-07：重复命令 idempotencyKey 不重复产生副作用。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHarness, writeProjectFile } from '../helpers.ts';

async function openSession(h: Awaited<ReturnType<typeof createHarness>>, path: string, resourceId: string) {
  const opened = await h.bus.dispatch(
    {
      commandId: `cmd-open-${resourceId}`,
      type: 'document.open',
      payload: { resourceId, path, providerId: 'local' },
    },
    { actorId: 'user-a' },
  );
  return (opened.result as { sessionId: string }).sessionId;
}

test('CT-07 同一 idempotencyKey 重复保存 → 只产生一次副作用，第二次返回原收据', async () => {
  const h = await createHarness();
  try {
    h.permission.grant({ actorId: 'user-a', action: 'read', scope: '' });
    h.permission.grant({ actorId: 'user-a', action: 'write', scope: '' });
    await writeProjectFile(h.root, 'idem.md', 'v1\n');
    const sessionId = await openSession(h, 'idem.md', 'res-idem');
    h.document.applyEdit(sessionId, 'v2\n');
    const base = h.document.getSession(sessionId)!.baseVersion!;

    const first = await h.bus.dispatch(
      {
        commandId: 'cmd-i1',
        type: 'document.save',
        idempotencyKey: 'idem-key-1',
        expectedVersion: base,
        payload: { sessionId },
      },
      { actorId: 'user-a' },
    );
    assert.equal(first.status, 'APPLIED');

    // 完全相同语义的重试（新 commandId、同幂等键）：应命中收据，不重新写盘
    const second = await h.bus.dispatch(
      {
        commandId: 'cmd-i2',
        type: 'document.save',
        idempotencyKey: 'idem-key-1',
        expectedVersion: base,
        payload: { sessionId },
      },
      { actorId: 'user-a' },
    );
    assert.equal(second.status, 'APPLIED');
    assert.equal(second.deduplicated, true, '必须标记为幂等命中');
    assert.equal(second.resultingVersion, first.resultingVersion, '返回同一收据结果');

    assert.equal(await readFile(join(h.root, 'idem.md'), 'utf8'), 'v2\n', '磁盘内容只能被写一次');
    assert.equal(h.bus.receiptCount(), 1);

    // S8-F02 起：幂等指纹覆盖待保存缓冲，缓冲变了就不再是「同一个请求」→ 必须拒绝，
    // 不能再用旧收据谎报成功（旧行为已按安全要求收紧）。
    h.document.applyEdit(sessionId, 'v3\n');
    const reused = await h.bus.dispatch(
      {
        commandId: 'cmd-i3',
        type: 'document.save',
        idempotencyKey: 'idem-key-1',
        expectedVersion: base,
        payload: { sessionId },
      },
      { actorId: 'user-a' },
    );
    assert.equal(reused.status, 'REJECTED');
    assert.equal(reused.errorCode, 'ERR_COMMAND_INVALID');
    assert.equal(await readFile(join(h.root, 'idem.md'), 'utf8'), 'v2\n', '拒绝时不得写盘');
  } finally {
    await h.cleanup();
  }
});

test('CT-07b 不同 actor 使用相同 idempotencyKey 不会互相吞并', async () => {
  const h = await createHarness();
  try {
    for (const actor of ['user-a', 'user-b']) {
      h.permission.grant({ actorId: actor, action: 'read', scope: '' });
      h.permission.grant({ actorId: actor, action: 'write', scope: '' });
    }
    await writeProjectFile(h.root, 'idem2.md', 'v1\n');
    const sessionId = await openSession(h, 'idem2.md', 'res-idem2');
    h.document.applyEdit(sessionId, 'v2\n');
    const base = h.document.getSession(sessionId)!.baseVersion!;

    const a = await h.bus.dispatch(
      {
        commandId: 'cmd-a1',
        type: 'document.save',
        idempotencyKey: 'shared-key',
        expectedVersion: base,
        payload: { sessionId },
      },
      { actorId: 'user-a' },
    );
    assert.equal(a.status, 'APPLIED');

    const b = await h.bus.dispatch(
      {
        commandId: 'cmd-b1',
        type: 'document.save',
        idempotencyKey: 'shared-key',
        expectedVersion: base,
        payload: { sessionId },
      },
      { actorId: 'user-b' },
    );
    assert.equal(b.deduplicated, undefined, '收据必须按 actor 隔离');
    assert.equal(h.bus.receiptCount(), 2);
  } finally {
    await h.cleanup();
  }
});

test('CT-07c 重复 commandId 被拒绝（幂等必须显式使用 idempotencyKey）', async () => {
  const h = await createHarness();
  try {
    h.permission.grant({ actorId: 'user-a', action: 'read', scope: '' });
    await writeProjectFile(h.root, 'cid.md', 'v1\n');
    const envelope = {
      commandId: 'cmd-same',
      type: 'document.open',
      payload: { resourceId: 'res-cid', path: 'cid.md', providerId: 'local' },
    };
    const first = await h.bus.dispatch(envelope, { actorId: 'user-a' });
    assert.equal(first.status, 'APPLIED');
    const second = await h.bus.dispatch(envelope, { actorId: 'user-a' });
    assert.equal(second.status, 'REJECTED');
    assert.equal(second.errorCode, 'ERR_COMMAND_INVALID');
    assert.ok((second.violations ?? []).some((v) => v.field === 'commandId'));
  } finally {
    await h.cleanup();
  }
});
