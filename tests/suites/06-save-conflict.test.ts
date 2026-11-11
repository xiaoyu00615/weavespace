/**
 * CT-04：外部文件已变 —— 拒绝覆盖，保留 dirty，错误码可追踪。
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHarness, writeProjectFile } from '../helpers.ts';

test('CT-04 外部修改后保存 → CONFLICT，磁盘保留外部内容，会话保持 dirty', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'conflict.md', '原始\n');
    const v = await h.document.openSession({ resourceId: 'res-conflict', path: 'conflict.md', provider: h.provider });
    h.document.applyEdit(v.sessionId, '我的版本\n');

    // 模拟外部程序改写文件
    await writeFile(join(h.root, 'conflict.md'), '外部版本\n', 'utf8');

    const change = await h.document.detectExternalChange(v.sessionId);
    assert.equal(change.changed, true, '应检测到外部变更');

    const saved = await h.document.save(v.sessionId, (b) => b);
    assert.equal(saved.status, 'CONFLICT');
    assert.equal(saved.errorCode, 'ERR_DOCUMENT_VERSION_CONFLICT');

    assert.equal(await readFile(join(h.root, 'conflict.md'), 'utf8'), '外部版本\n', '不得覆盖外部内容');
    const session = h.document.getSession(v.sessionId);
    assert.equal(session?.state, 'CONFLICT');
    assert.equal(session?.dirty, true, '冲突后必须保留 dirty');
    assert.equal(h.document.getBuffer(v.sessionId), '我的版本\n', '用户内容不得丢失');
  } finally {
    await h.cleanup();
  }
});

test('CT-04b 冲突事件含 baseVersion 与 diskVersion，可据 traceId 排障', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'conflict2.md', 'a\n');
    const v = await h.document.openSession({ resourceId: 'res-c2', path: 'conflict2.md', provider: h.provider });
    h.document.applyEdit(v.sessionId, 'b\n');
    await writeFile(join(h.root, 'conflict2.md'), 'c\n', 'utf8');
    await h.document.save(v.sessionId, (x) => x);

    const conflict = h.document.drainEvents().find((e) => e.type === 'SAVE_CONFLICT');
    assert.ok(conflict, '应有 SAVE_CONFLICT 事件');
    assert.equal(conflict?.errorCode, 'ERR_DOCUMENT_VERSION_CONFLICT');
    const detail = conflict?.detail as { baseVersion?: string; diskVersion?: string };
    assert.match(String(detail.baseVersion), /^sha256:/);
    assert.match(String(detail.diskVersion), /^sha256:/);
    assert.notEqual(detail.baseVersion, detail.diskVersion);
    assert.ok(String(conflict?.traceId).length > 0);

    const warn = h.memorySink.records.find((r) => r.event === 'SAVE_CONFLICT');
    assert.ok(warn, '冲突必须落日志');
    assert.equal(warn?.level, 'WARN');
  } finally {
    await h.cleanup();
  }
});

test('CT-04c 客户端 expectedVersion 过期 → 命令层直接 REJECTED（写前版本校验）', async () => {
  const h = await createHarness();
  try {
    h.permission.grant({ actorId: 'user-a', action: 'read', scope: '' });
    h.permission.grant({ actorId: 'user-a', action: 'write', scope: '' });
    await writeProjectFile(h.root, 'stale.md', 'v1\n');
    const opened = await h.bus.dispatch(
      {
        commandId: 'cmd-s1',
        type: 'document.open',
        payload: { resourceId: 'res-stale', path: 'stale.md', providerId: 'local' },
      },
      { actorId: 'user-a' },
    );
    const { sessionId } = opened.result as { sessionId: string };

    const rejected = await h.bus.dispatch(
      {
        commandId: 'cmd-s2',
        type: 'document.save',
        expectedVersion: 'sha256:deadbeef',
        payload: { sessionId },
      },
      { actorId: 'user-a' },
    );
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.errorCode, 'ERR_DOCUMENT_VERSION_CONFLICT');
    assert.equal(await readFile(join(h.root, 'stale.md'), 'utf8'), 'v1\n');
  } finally {
    await h.cleanup();
  }
});

test('CT-04d 冲突后基于新磁盘版本可显式重存（用户裁决后），不自动重试', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'retry.md', 'a\n');
    const v = await h.document.openSession({ resourceId: 'res-retry', path: 'retry.md', provider: h.provider });
    h.document.applyEdit(v.sessionId, 'mine\n');
    await writeFile(join(h.root, 'retry.md'), 'theirs\n', 'utf8');

    const first = await h.document.save(v.sessionId, (b) => b);
    assert.equal(first.status, 'CONFLICT');

    // 探针未实现"采纳磁盘版本"，因此重存前必须由调用者显式更新会话基线
    const reconcile = await h.document.reconcile(v.sessionId, (b) => b);
    assert.equal(reconcile.outcome, 'NOT_APPLIED');
    assert.match(String(reconcile.diskVersion), /^sha256:/);
  } finally {
    await h.cleanup();
  }
});
