/**
 * CT-09：非授权 actor 写入 —— 服务端拒绝并记录审计。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHarness, writeProjectFile } from '../helpers.ts';

test('CT-09 无写权限的 actor 保存 → REJECTED，磁盘不变，审计含 actorId', async () => {
  const h = await createHarness({
    grants: [
      { actorId: 'agent-x', action: 'read', scope: '' },
      { actorId: 'user-a', action: 'read', scope: '' },
      { actorId: 'user-a', action: 'write', scope: '' },
    ],
  });
  try {
    await writeProjectFile(h.root, 'secret.md', 'v1\n');
    // user-a 打开会话
    const opened = await h.bus.dispatch(
      {
        commandId: 'cmd-p1',
        type: 'document.open',
        payload: { resourceId: 'res-p', path: 'secret.md', providerId: 'local' },
      },
      { actorId: 'user-a' },
    );
    const { sessionId } = opened.result as { sessionId: string };
    const base = h.document.getSession(sessionId)!.baseVersion!;
    h.document.applyEdit(sessionId, 'hacked\n');

    // agent-x 只有读权限，尝试保存
    const denied = await h.bus.dispatch(
      {
        commandId: 'cmd-p2',
        type: 'document.save',
        expectedVersion: base,
        payload: { sessionId },
      },
      { actorId: 'agent-x' },
    );

    assert.equal(denied.status, 'REJECTED');
    assert.equal(denied.errorCode, 'ERR_PERMISSION_DENIED');
    assert.equal(await readFile(join(h.root, 'secret.md'), 'utf8'), 'v1\n', '拒绝后不得有持久化副作用');

    const audit = h.auditSink.records.filter((r) => r.event === 'PERMISSION_DECIDED');
    assert.ok(audit.length >= 1, '授权判定必须落审计');
    const last = audit.at(-1)!;
    assert.equal(last.actorId, 'agent-x');
    assert.equal(last.result, 'DENIED');
    assert.equal(last.errorCode, 'ERR_PERMISSION_DENIED');
    assert.match(String(last.timestamp), /Z$/, '审计必须有 UTC 时间戳');
  } finally {
    await h.cleanup();
  }
});

test('CT-09b 匿名 actor（空 actorId）一律拒绝，不把匿名视为可信', async () => {
  const h = await createHarness({
    grants: [{ actorId: '', action: 'write', scope: '' }],
  });
  try {
    await writeProjectFile(h.root, 'anon.md', 'v1\n');
    const result = await h.bus.dispatch(
      {
        commandId: 'cmd-anon',
        type: 'document.open',
        payload: { resourceId: 'res-anon', path: 'anon.md', providerId: 'local' },
      },
      { actorId: '' },
    );
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.errorCode, 'ERR_PERMISSION_DENIED');
  } finally {
    await h.cleanup();
  }
});

test('CT-09c 授权范围按目录前缀生效，范围外路径被拒绝（不越权到整项目）', async () => {
  const h = await createHarness({
    grants: [{ actorId: 'writer', action: 'write', scope: 'docs' }],
  });
  try {
    await writeProjectFile(h.root, 'docs/ok.md', 'a\n');
    await writeProjectFile(h.root, 'docsx/nope.md', 'b\n');

    const inside = await h.permission.authorize({ actorId: 'writer', action: 'write', resourcePath: 'docs/ok.md' });
    assert.equal(inside.allowed, true);

    const sibling = await h.permission.authorize({ actorId: 'writer', action: 'write', resourcePath: 'docsx/nope.md' });
    assert.equal(sibling.allowed, false, 'docs 授权不得覆盖 docsx');

    const outside = await h.permission.authorize({ actorId: 'writer', action: 'write', resourcePath: 'other/file.md' });
    assert.equal(outside.allowed, false);
  } finally {
    await h.cleanup();
  }
});

test('CT-09d 撤销授权后立即失效', async () => {
  const h = await createHarness({
    grants: [{ actorId: 'writer', action: 'write', scope: '' }],
  });
  try {
    assert.equal((await h.permission.authorize({ actorId: 'writer', action: 'write', resourcePath: 'a.md' })).allowed, true);
    h.permission.revoke({ actorId: 'writer', action: 'write', scope: '' });
    assert.equal((await h.permission.authorize({ actorId: 'writer', action: 'write', resourcePath: 'a.md' })).allowed, false);
    assert.deepEqual(h.permission.grantsOf('writer'), []);
  } finally {
    await h.cleanup();
  }
});
