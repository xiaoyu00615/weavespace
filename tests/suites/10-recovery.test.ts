/**
 * CT-10：重启恢复 —— 依据真实提交状态恢复，不猜测、不用日志当事实。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHarness, writeProjectFile } from '../helpers.ts';
import { createLocalProvider } from '../../packages/storage/index.ts';
import { createDocumentService } from '../../packages/document/index.ts';

test('CT-10 提交后重启：新服务实例从磁盘读回已提交内容与版本', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'persist.md', 'v1\n');
    const v = await h.document.openSession({ resourceId: 'res-persist', path: 'persist.md', provider: h.provider });
    h.document.applyEdit(v.sessionId, 'v2 committed\n');
    const saved = await h.document.save(v.sessionId, (b) => b);
    assert.equal(saved.status, 'COMMITTED');

    // 模拟重启：全新 provider + 全新 document service（内存状态全部丢失）
    const provider2 = createLocalProvider({ rootDir: h.root });
    const doc2 = createDocumentService();
    const v2 = await doc2.openSession({ resourceId: 'res-persist', path: 'persist.md', provider: provider2 });

    assert.equal(doc2.getBuffer(v2.sessionId), 'v2 committed\n');
    assert.equal(doc2.getSession(v2.sessionId)?.dirty, false, '重启后应为 CLEAN（无草稿恢复区）');
    assert.equal(doc2.getSession(v2.sessionId)?.baseVersion, saved.contentVersion);
  } finally {
    await h.cleanup();
  }
});

test('CT-10b 未提交的编辑不在磁盘：重启后不得被误认为已保存', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'dirty.md', 'disk truth\n');
    const v = await h.document.openSession({ resourceId: 'res-dirty', path: 'dirty.md', provider: h.provider });
    h.document.applyEdit(v.sessionId, 'unsaved edit\n');
    assert.equal(h.document.getSession(v.sessionId)?.dirty, true);

    // 未保存即"崩溃"：内存丢失
    const provider2 = createLocalProvider({ rootDir: h.root });
    const doc2 = createDocumentService();
    const v2 = await doc2.openSession({ resourceId: 'res-dirty', path: 'dirty.md', provider: provider2 });

    assert.equal(doc2.getBuffer(v2.sessionId), 'disk truth\n', '恢复必须来自真实提交状态');
    assert.equal(doc2.getSession(v2.sessionId)?.dirty, false);
    assert.equal(await readFile(join(h.root, 'dirty.md'), 'utf8'), 'disk truth\n');
  } finally {
    await h.cleanup();
  }
});

test('CT-10c 失败保存后重启：磁盘仍是旧版本，不出现"半成品"', async () => {
  const h = await createHarness({
    faults: {
      beforeCommit() {
        throw new Error('磁盘故障');
      },
    },
  });
  try {
    await writeProjectFile(h.root, 'half.md', 'stable\n');
    const v = await h.document.openSession({ resourceId: 'res-half', path: 'half.md', provider: h.provider });
    h.document.applyEdit(v.sessionId, 'broken\n');
    const saved = await h.document.save(v.sessionId, (b) => b);
    assert.equal(saved.status, 'FAILED');

    const provider2 = createLocalProvider({ rootDir: h.root });
    const doc2 = createDocumentService();
    const v2 = await doc2.openSession({ resourceId: 'res-half', path: 'half.md', provider: provider2 });
    assert.equal(doc2.getBuffer(v2.sessionId), 'stable\n');

    const listed = await provider2.list();
    assert.deepEqual(listed, ['half.md'], '不得遗留临时文件');
  } finally {
    await h.cleanup();
  }
});

test('CT-10d 已提交会话再次保存不需要变更基线（版本链连续）', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'chain.md', 'v1\n');
    const v = await h.document.openSession({ resourceId: 'res-chain', path: 'chain.md', provider: h.provider });
    h.document.applyEdit(v.sessionId, 'v2\n');
    const s1 = await h.document.save(v.sessionId, (b) => b);
    assert.equal(s1.status, 'COMMITTED');

    h.document.applyEdit(v.sessionId, 'v3\n');
    const s2 = await h.document.save(v.sessionId, (b) => b);
    assert.equal(s2.status, 'COMMITTED', '第二次保存应基于上次提交的版本自动继续');
    assert.equal(await readFile(join(h.root, 'chain.md'), 'utf8'), 'v3\n');
    assert.equal(h.document.getSession(v.sessionId)?.baseVersion, s2.contentVersion);
  } finally {
    await h.cleanup();
  }
});
