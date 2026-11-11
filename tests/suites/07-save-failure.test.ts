/**
 * CT-05 / CT-06：保存失败与结果未知。
 * - 权限/IO 失败：不得有持久化副作用，错误码可追踪。
 * - 已落盘但确认丢失：必须报 UNKNOWN，禁止伪装成功或失败。
 */
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHarness, writeProjectFile } from '../helpers.ts';

test('CT-06 写盘前 IO 异常 → FAILED / ERR_STORAGE_IO，磁盘不变，dirty 保留', async () => {
  const h = await createHarness({
    faults: {
      beforeCommit() {
        throw Object.assign(new Error('模拟磁盘故障'), { code: 'EIO' });
      },
    },
  });
  try {
    await writeProjectFile(h.root, 'io.md', 'orig\n');
    const v = await h.document.openSession({ resourceId: 'res-io', path: 'io.md', provider: h.provider });
    h.document.applyEdit(v.sessionId, 'new\n');

    const saved = await h.document.save(v.sessionId, (b) => b);
    assert.equal(saved.status, 'FAILED');
    assert.equal(saved.errorCode, 'ERR_STORAGE_IO');
    assert.equal(await readFile(join(h.root, 'io.md'), 'utf8'), 'orig\n', '失败不得改动磁盘');
    assert.equal(h.document.getSession(v.sessionId)?.dirty, true);

    const failedEvent = h.document.drainEvents().find((e) => e.type === 'SAVE_FAILED');
    assert.equal(failedEvent?.errorCode, 'ERR_STORAGE_IO');
  } finally {
    await h.cleanup();
  }
});

test('CT-05 权限拒绝 → 无持久化副作用，错误码 ERR_PERMISSION_DENIED', async () => {
  const h = await createHarness({
    faults: {
      beforeCommit() {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    },
  });
  try {
    await writeProjectFile(h.root, 'locked.md', 'readonly\n');
    const v = await h.document.openSession({ resourceId: 'res-locked', path: 'locked.md', provider: h.provider });
    h.document.applyEdit(v.sessionId, 'attempt\n');

    const saved = await h.document.save(v.sessionId, (b) => b);
    assert.equal(saved.status, 'FAILED');
    assert.equal(saved.errorCode, 'ERR_PERMISSION_DENIED', 'EACCES 必须映射为权限错误码而非泛化 IO');
    assert.equal(await readFile(join(h.root, 'locked.md'), 'utf8'), 'readonly\n');
    assert.equal(h.document.getSession(v.sessionId)?.dirty, true);
  } finally {
    await h.cleanup();
  }
});

test('CT-05b 真实文件系统只读属性：保存要么成功要么给出权限错误，不得静默', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'ro.md', 'v1\n');
    const full = join(h.root, 'ro.md');
    // Windows: 只读属性会阻止 rename 覆盖（MoveFileEx 语义）；其他平台此调用可能无效
    const { chmod } = await import('node:fs/promises');
    let readOnlyApplied = false;
    try {
      await chmod(full, 0o444);
      readOnlyApplied = (await stat(full)).mode > 0;
    } catch {
      readOnlyApplied = false;
    }

    const v = await h.document.openSession({ resourceId: 'res-ro', path: 'ro.md', provider: h.provider });
    h.document.applyEdit(v.sessionId, 'v2\n');
    const saved = await h.document.save(v.sessionId, (b) => b);

    // 无论 OS 允许与否，都不允许"报告成功但磁盘没变"这种不一致
    if (saved.status === 'COMMITTED') {
      assert.equal(await readFile(full, 'utf8'), 'v2\n', '报告 COMMITTED 时磁盘必须真的变了');
    } else {
      assert.equal(saved.status, 'FAILED');
      assert.ok(
        saved.errorCode === 'ERR_PERMISSION_DENIED' || saved.errorCode === 'ERR_STORAGE_IO',
        `失败必须有稳定错误码，实际 ${saved.errorCode}`,
      );
      assert.equal(await readFile(full, 'utf8'), 'v1\n', '失败时磁盘不得变化');
    }
    h.logger.info('CT-05B_OBSERVED', {
      result: saved.status,
      errorCode: saved.errorCode,
      readOnlyApplied,
      platform: process.platform,
    });
  } finally {
    await h.cleanup();
  }
});

test('CT-06b 已落盘但确认丢失 → UNKNOWN，不自动标 CLEAN，reconcile 判定 APPLIED', async () => {
  const h = await createHarness({
    faults: {
      afterCommit() {
        throw new Error('模拟确认链中断');
      },
    },
  });
  try {
    await writeProjectFile(h.root, 'unknown.md', 'v1\n');
    const v = await h.document.openSession({ resourceId: 'res-unknown', path: 'unknown.md', provider: h.provider });
    h.document.applyEdit(v.sessionId, 'v2\n');

    const saved = await h.document.save(v.sessionId, (b) => b);
    assert.equal(saved.status, 'UNKNOWN');
    assert.equal(saved.errorCode, 'ERR_OUTCOME_UNKNOWN');
    assert.equal(h.document.getSession(v.sessionId)?.state, 'OUTCOME_UNKNOWN');
    assert.equal(h.document.getSession(v.sessionId)?.dirty, true, 'UNKNOWN 不得标为 CLEAN');

    // 磁盘实际已更新（副作用真实发生）
    assert.equal(await readFile(join(h.root, 'unknown.md'), 'utf8'), 'v2\n');

    const reconciled = await h.document.reconcile(v.sessionId, (b) => b);
    assert.equal(reconciled.outcome, 'APPLIED');
    assert.equal(h.document.getSession(v.sessionId)?.dirty, false);
    assert.equal(h.document.getSession(v.sessionId)?.state, 'CLEAN');
  } finally {
    await h.cleanup();
  }
});

test('CT-06c 经 Command Bus 的 UNKNOWN 不写幂等收据（避免错误重放）', async () => {
  const h = await createHarness({
    faults: {
      afterCommit() {
        throw new Error('模拟确认链中断');
      },
    },
  });
  try {
    h.permission.grant({ actorId: 'user-a', action: 'read', scope: '' });
    h.permission.grant({ actorId: 'user-a', action: 'write', scope: '' });
    await writeProjectFile(h.root, 'u2.md', 'v1\n');
    const opened = await h.bus.dispatch(
      {
        commandId: 'cmd-u1',
        type: 'document.open',
        payload: { resourceId: 'res-u2', path: 'u2.md', providerId: 'local' },
      },
      { actorId: 'user-a' },
    );
    const { sessionId } = opened.result as { sessionId: string };
    const base = h.document.getSession(sessionId)!.baseVersion!;
    h.document.applyEdit(sessionId, 'v2\n');

    const saved = await h.bus.dispatch(
      {
        commandId: 'cmd-u2',
        type: 'document.save',
        idempotencyKey: 'idem-unknown-1',
        expectedVersion: base,
        payload: { sessionId },
      },
      { actorId: 'user-a' },
    );
    assert.equal(saved.status, 'UNKNOWN');
    assert.equal(h.bus.getResult('idem-unknown-1'), undefined, 'UNKNOWN 不得被收据缓存');
    assert.equal(h.bus.receiptCount(), 0);
  } finally {
    await h.cleanup();
  }
});
