/**
 * UX-02B-05-03：多项目文件编辑与保存（真实 Host + 客户端，同名相对路径）。
 *
 * 现场：A 与 B 各有一个 `docs/notes.md`。相对路径相同、内容不同，
 * 它们必须是**两个完全不同的文档**：docId、会话、版本基线、草稿备份键都要分开，
 * A 的编辑/保存绝不能落到 B 上。
 *
 * 覆盖：
 * - 身份分离（docId / 草稿键）；
 * - 编辑 A 不回填 B（服务端会话内容 + 磁盘字节双向确认）；
 * - 交错保存不串写（先改 A、再改 B，按相反顺序保存）；
 * - 版本冲突保守处理（外部改动后保存 → CONFLICT，且不覆盖别人的内容）；
 * - 保存流程的失败/未知分支（草稿未同步不写盘、传输异常报 UNKNOWN 并保留草稿）。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createShellServer } from '../../apps/server/src/server.ts';
import { createLiveClient } from '../../apps/shell/src/client/client-api.ts';
import { runSaveFlow } from '../../apps/shell/src/client/save-flow.ts';
import { draftBackupKey, makeDocId } from '../../apps/shell/src/state/doc-identity.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import type { WorkspaceState } from '../../apps/shell/src/state/types.ts';
import type { WorkspaceConfig } from '../../packages/project-registry/index.ts';

const A_TEXT = '# A notes\n\nA 的正文\n';
const B_TEXT = '# B notes\n\nB 的正文\n';

function sha(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

interface Ctx {
  rootA: string;
  rootB: string;
  client: ReturnType<typeof createLiveClient>;
}

async function withEdit(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux05-03-'));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await mkdir(join(rootB, 'docs'), { recursive: true });
  await writeFile(join(rootA, 'docs', 'notes.md'), A_TEXT, 'utf8');
  await writeFile(join(rootB, 'docs', 'notes.md'), B_TEXT, 'utf8');

  const workspace: WorkspaceConfig = {
    version: 1,
    projects: [
      { projectId: 'project-a', name: '项目 A', rootDir: rootA },
      { projectId: 'project-b', name: '项目 B', rootDir: rootB },
    ],
  };
  const server = await createShellServer({ workspace, port: 0 });
  const client = createLiveClient(server.url);
  try {
    await fn({ rootA, rootB, client });
  } finally {
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

test('05-03-01 同名相对路径的两个文件身份互不相同', () => {
  const docA = makeDocId('project-a', 'docs/notes.md');
  const docB = makeDocId('project-b', 'docs/notes.md');
  assert.notEqual(docA, docB, 'docId 必须带项目命名空间');
  assert.equal(docA, 'doc:project-a/docs/notes.md');
  assert.equal(docB, 'doc:project-b/docs/notes.md');
  assert.notEqual(
    draftBackupKey('project-a', 'docs/notes.md'),
    draftBackupKey('project-b', 'docs/notes.md'),
    '草稿备份键必须区分项目，否则 A 的草稿会覆盖 B 的',
  );
});

test('05-03-02 打开两个同名文件：会话独立，编辑 A 不回填 B', async () => {
  await withEdit(async ({ rootA, rootB, client }) => {
    const openA = await client.openDocument('docs/notes.md', 'project-a');
    const openB = await client.openDocument('docs/notes.md', 'project-b');
    assert.equal(openA.status, 'APPLIED');
    assert.equal(openB.status, 'APPLIED');
    const docA = openA.document!;
    const docB = openB.document!;

    assert.notEqual(docA.sessionId, docB.sessionId, '两个文件的会话必须独立');
    assert.notEqual(docA.viewId, docB.viewId, '两个文件的视图必须独立');
    assert.equal(docA.projectId, 'project-a');
    assert.equal(docB.projectId, 'project-b');
    assert.equal(docA.content, A_TEXT);
    assert.equal(docB.content, B_TEXT);

    const editedA = '# A notes\n\nA 的正文\nA 追加一行\n';
    const edit = await client.applyEdit(docA.sessionId, editedA, docA.baseVersion, docA.viewId);
    assert.equal(edit.status, 'APPLIED', JSON.stringify(edit));

    // B 的服务端会话内容不受影响
    const rereadB = await client.readDocument(docB.sessionId, docB.viewId);
    assert.equal(rereadB.status, 'APPLIED');
    assert.equal(rereadB.document?.content, B_TEXT, 'B 的缓冲不得被 A 的编辑改写');

    // 磁盘也都没变（还没保存）
    assert.equal(sha(await readFile(join(rootA, 'docs', 'notes.md'), 'utf8')), sha(A_TEXT));
    assert.equal(sha(await readFile(join(rootB, 'docs', 'notes.md'), 'utf8')), sha(B_TEXT));
  });
});

test('05-03-03 交错保存不串写：改 A → 改 B → 先保存 B → 再保存 A', async () => {
  await withEdit(async ({ rootA, rootB, client }) => {
    const docA = (await client.openDocument('docs/notes.md', 'project-a')).document!;
    const docB = (await client.openDocument('docs/notes.md', 'project-b')).document!;

    const textA = `${A_TEXT}A 的第二版\n`;
    const textB = `${B_TEXT}B 的第二版\n`;

    const e1 = await client.applyEdit(docA.sessionId, textA, docA.baseVersion, docA.viewId);
    assert.equal(e1.status, 'APPLIED');
    const e2 = await client.applyEdit(docB.sessionId, textB, docB.baseVersion, docB.viewId);
    assert.equal(e2.status, 'APPLIED');

    // 先保存 B
    const saveB = await client.saveDocument(
      docB.sessionId,
      e2.document?.baseVersion ?? docB.baseVersion ?? '',
      docB.viewId,
    );
    assert.equal(saveB.status, 'COMMITTED', JSON.stringify(saveB));
    assert.equal(await readFile(join(rootB, 'docs', 'notes.md'), 'utf8'), textB);
    assert.equal(
      await readFile(join(rootA, 'docs', 'notes.md'), 'utf8'),
      A_TEXT,
      '保存 B 不得把 A 的内容写出去',
    );

    // 再保存 A
    const saveA = await client.saveDocument(
      docA.sessionId,
      e1.document?.baseVersion ?? docA.baseVersion ?? '',
      docA.viewId,
    );
    assert.equal(saveA.status, 'COMMITTED', JSON.stringify(saveA));
    assert.equal(await readFile(join(rootA, 'docs', 'notes.md'), 'utf8'), textA);
    assert.equal(
      await readFile(join(rootB, 'docs', 'notes.md'), 'utf8'),
      textB,
      '保存 A 不得覆盖 B 的落盘内容',
    );
  });
});

test('05-03-04 未保存草稿不因切换项目消失（reducer 层的标签态）', () => {
  const buffer = '# A notes\n\n未保存的编辑\n';
  const state: WorkspaceState = {
    ...INITIAL_STATE,
    mode: 'live',
    workspaceMode: 'multi',
    projects: [
      { projectId: 'project-a', name: 'A', status: 'READY' },
      { projectId: 'project-b', name: 'B', status: 'READY' },
    ],
    activeProjectId: 'project-a',
    tabs: [
      {
        docId: 'doc:project-a/docs/notes.md',
        projectId: 'project-a',
        path: 'docs/notes.md',
        title: 'notes.md',
        mode: 'live',
        buffer,
        dirty: true,
        saving: false,
        sessionId: 's-a',
        viewId: 'v-a',
        baseVersion: 'v1',
        revision: 1,
        documentState: 'EDITING_DIRTY',
        lastStatus: 'COMMITTED',
        errorCode: null,
        extension: '.md',
      },
    ],
    panes: {
      primary: { mode: 'editor', docId: 'doc:project-a/docs/notes.md' },
      secondary: { mode: 'editor', docId: null },
    },
    focusedPane: 'primary',
  };

  const after = workspaceReducer(state, { type: 'SET_ACTIVE_PROJECT', projectId: 'project-b' });
  assert.equal(after.tabs.length, 1, '切换项目不得关闭标签');
  assert.equal(after.tabs[0].buffer, buffer, '草稿必须逐字节保留');
  assert.equal(after.tabs[0].dirty, true, '未保存标记不得被清掉');
  assert.equal(after.tabs[0].projectId, 'project-a', '标签的项目归属不变');
});

test('05-03-05 外部改动后再保存：冲突被识别且不覆盖别人的内容', async () => {
  await withEdit(async ({ rootA, client }) => {
    const docA = (await client.openDocument('docs/notes.md', 'project-a')).document!;
    const edited = `${A_TEXT}A 的编辑\n`;
    const applied = await client.applyEdit(docA.sessionId, edited, docA.baseVersion, docA.viewId);
    assert.equal(applied.status, 'APPLIED');

    // 模拟外部程序改盘
    const external = '# A notes\n\n外部写入的内容\n';
    await writeFile(join(rootA, 'docs', 'notes.md'), external, 'utf8');

    const saved = await client.saveDocument(docA.sessionId, docA.baseVersion ?? '', docA.viewId);
    assert.notEqual(saved.status, 'COMMITTED', '版本基线已过期时绝不能报成功');
    assert.ok(['CONFLICT', 'UNKNOWN'].includes(saved.status), `实际: ${saved.status}`);
    assert.equal(
      await readFile(join(rootA, 'docs', 'notes.md'), 'utf8'),
      external,
      '冲突时不得用客户端内容覆盖别人的写入',
    );
  });
});

test('05-03-06 保存流程：草稿未同步不写盘，传输异常报 UNKNOWN 且保留草稿', async () => {
  let attempted = 0;

  const notSynced = await runSaveFlow({
    buffer: 'x',
    sync: async () => ({ ok: false, error: new Error('core 落后'), lastSynced: null }),
    commit: async () => {
      attempted += 1;
      throw new Error('不该调用');
    },
  });
  assert.equal(notSynced.status, 'FAILED');
  assert.equal(notSynced.attempted, false);
  assert.equal(attempted, 0, '草稿没进 Core 时不得发起写盘');
  assert.equal(notSynced.dirty, true, '失败也必须保留草稿');

  const transport = await runSaveFlow({
    buffer: 'y',
    sync: async () => ({ ok: true, lastSynced: 'y' }),
    commit: async () => {
      throw new Error('socket hang up');
    },
  });
  assert.equal(transport.status, 'UNKNOWN', '传输异常只能报未知，不能报成功');
  assert.equal(transport.dirty, true, '未知结果必须保留草稿');
  assert.equal(transport.documentState, 'OUTCOME_UNKNOWN');
});
