/**
 * CT-02：同一文件两个视图共享唯一权威 Session —— 不丢状态、不产生两份缓冲。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness, writeProjectFile } from '../helpers.ts';
import { createLocalProvider } from '../../packages/storage/index.ts';
import { createDocumentService } from '../../packages/document/index.ts';

test('CT-02 两个视图共享同一 Session，编辑只产生一份缓冲', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'scene.md', '# 场景一\n原始内容\n');

    const v1 = await h.document.openSession({ resourceId: 'res-scene', path: 'scene.md', provider: h.provider });
    const v2 = await h.document.openSession({ resourceId: 'res-scene', path: 'scene.md', provider: h.provider });

    assert.equal(v1.sessionId, v2.sessionId, '同一 resourceId 必须复用同一 Session');
    assert.notEqual(v1.viewId, v2.viewId, '视图实例必须彼此独立');
    assert.equal(h.document.getSession(v1.sessionId)?.views, 2);

    const updated = h.document.applyEdit(v1.sessionId, '# 场景一\n新的内容\n');
    assert.equal(updated.revision, 1);
    assert.equal(updated.dirty, true);
    assert.equal(h.document.getBuffer(v2.sessionId), '# 场景一\n新的内容\n', '两个视图看到同一缓冲');
    assert.equal(h.document.getSession(v2.sessionId)?.revision, 1, '不应出现第二份 revision');
  } finally {
    await h.cleanup();
  }
});

test('CT-02b 关闭一个视图不影响另一个视图与未保存缓冲', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'shot.md', 'a\n');
    const v1 = await h.document.openSession({ resourceId: 'res-shot', path: 'shot.md', provider: h.provider });
    const v2 = await h.document.openSession({ resourceId: 'res-shot', path: 'shot.md', provider: h.provider });
    h.document.applyEdit(v1.sessionId, 'b\n');

    const closed = await h.document.closeView(v1.viewId);
    assert.equal(closed.closed, true);
    assert.equal(h.document.getSession(v2.sessionId)?.views, 1);
    assert.equal(h.document.getBuffer(v2.sessionId), 'b\n', '缓冲不得因关闭视图丢失');
    assert.equal(h.document.getSession(v2.sessionId)?.dirty, true);
  } finally {
    await h.cleanup();
  }
});

test('CT-02c 关闭最后一个带未保存内容的视图被拒绝（DATA-002）', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'note.md', 'x\n');
    const v = await h.document.openSession({ resourceId: 'res-note', path: 'note.md', provider: h.provider });
    h.document.applyEdit(v.sessionId, 'y\n');

    const blocked = await h.document.closeView(v.viewId);
    assert.equal(blocked.closed, false);
    assert.equal(blocked.protectedDirty, true);
    assert.equal(h.document.getBuffer(v.sessionId), 'y\n', '拒绝关闭时内容必须保留');

    const events = h.document.drainEvents();
    assert.ok(events.some((e) => e.type === 'CLOSE_BLOCKED_DIRTY'));
  } finally {
    await h.cleanup();
  }
});

test('CT-02d 不同 resourceId 即使是同一路径也各自独立会话（单会话按资源划分）', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'dup.md', 'z\n');
    const a = await h.document.openSession({ resourceId: 'res-a', path: 'dup.md', provider: h.provider });
    const b = await h.document.openSession({ resourceId: 'res-b', path: 'dup.md', provider: h.provider });
    assert.notEqual(a.sessionId, b.sessionId);
  } finally {
    await h.cleanup();
  }
});

test('CT-02e 独立 DocumentService 实例（模拟另一客户端）不共享内存会话', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'isolation.md', 'orig\n');
    const other = createDocumentService();
    const p = createLocalProvider({ rootDir: h.root });
    const v1 = await h.document.openSession({ resourceId: 'r', path: 'isolation.md', provider: h.provider });
    const v2 = await other.openSession({ resourceId: 'r', path: 'isolation.md', provider: p });
    assert.notEqual(v1.sessionId, v2.sessionId);
    h.document.applyEdit(v1.sessionId, 'changed\n');
    assert.equal(other.getBuffer(v2.sessionId), 'orig\n', '会话不跨服务实例共享（单主机权威尚未实现）');
  } finally {
    await h.cleanup();
  }
});
