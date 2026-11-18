/**
 * UX-02C-03-P1：隐藏**不得**影响编辑会话与草稿（P1-04），以及路径失效的真实语义（P1-05）。
 *
 * 这里是本阶段最容易"看起来对、其实错"的地方：如果隐藏走了结构变更那条路
 * （关视图 / 拦保存 / 断会话），用户只是想让文件从树里消失，却把正在写的东西弄丢了。
 * 因此本套件用**真实 Host + 真实会话 + 真实磁盘**证明：
 * 隐藏期间标签照常可读、可编辑、可保存，磁盘字节只在保存时变化。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { serializeConfig } from '../../apps/server/src/store/config.ts';
import { rootTokenOf } from '../../packages/storage/path-safety.ts';

const PROJ = 'project-a';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;

interface Ctx {
  root: string;
  server: ShellServer;
  token: string;
  post(path: string, body: unknown): Promise<{ status: number; body: Body }>;
  get(path: string): Promise<{ status: number; body: Body }>;
}

async function withDraftHost(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-p1-draft-'));
  const root = join(base, 'project-a');
  const storeDir = join(base, 'store');
  await mkdir(root, { recursive: true });
  await mkdir(storeDir, { recursive: true });
  await writeFile(join(root, 'note.md'), 'ORIGINAL\n', 'utf8');
  await writeFile(join(root, 'other.md'), 'OTHER\n', 'utf8');
  await writeFile(
    join(storeDir, 'workspace.json'),
    serializeConfig({
      version: 2,
      commitSeq: 0,
      issuedIds: [PROJ],
      revoked: [],
      projects: [
        {
          projectId: PROJ,
          name: '项目 A',
          rootDir: root,
          canonicalRoot: realpathSync(root),
          rootToken: rootTokenOf(root),
          grantedAt: '2026-11-18T00:00:00.000Z',
          grantSource: 'os-dialog',
        },
      ],
    }),
    'utf8',
  );

  const server = await createShellServer({
    port: 0,
    managedStore: { dir: storeDir, picker: createFakePicker([]) },
  });
  const token = ((await (await fetch(`${server.url}/api/session-token`)).json()) as { token?: string }).token ?? '';
  const origin = new URL(server.url).origin;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${server.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ws-token': token, origin },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Body };
  };
  const get = async (path: string) => {
    const res = await fetch(`${server.url}${path}`, { headers: { 'x-ws-token': token, origin } });
    return { status: res.status, body: (await res.json()) as Body };
  };

  try {
    await fn({ root, server, token, post, get });
  } finally {
    await server.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

test('P1-04a 隐藏正在编辑的文件：会话与草稿不受影响，保存照常落盘', async () => {
  await withDraftHost(async (h) => {
    const opened = await h.post('/api/open', { projectId: PROJ, path: 'note.md' });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;

    const edited = await h.post('/api/edit', {
      sessionId,
      viewId,
      buffer: 'UNSAVED DRAFT\n',
      expectedVersion: undefined,
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));

    // 隐藏：只改工作台可见性
    const hidden = await h.post('/api/workspace/hide', { projectId: PROJ, path: 'note.md' });
    assert.equal(hidden.status, 200, JSON.stringify(hidden.body));

    // 会话仍在、草稿仍在、视图仍然有效
    const doc = await h.get(`/api/document?sessionId=${sessionId}&viewId=${viewId}`);
    assert.equal(doc.status, 200, JSON.stringify(doc.body));
    assert.equal(doc.body.document.content, 'UNSAVED DRAFT\n', '隐藏绝不能清掉草稿');
    assert.equal(doc.body.document.dirty, true);

    // 保存仍然成功，磁盘只在这一次写入时变化
    const saved = await h.post('/api/save', {
      sessionId,
      viewId,
      expectedVersion: doc.body.document.baseVersion,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(await readFile(join(h.root, 'note.md'), 'utf8'), 'UNSAVED DRAFT\n');
  });
});

test('P1-04b 隐藏不影响"另一个文件"的会话；也不会顺手关闭任何视图', async () => {
  await withDraftHost(async (h) => {
    const a = await h.post('/api/open', { projectId: PROJ, path: 'note.md' });
    const b = await h.post('/api/open', { projectId: PROJ, path: 'other.md' });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);

    assert.equal((await h.post('/api/workspace/hide', { projectId: PROJ, path: 'other.md' })).status, 200);

    for (const [doc, name] of [
      [a, 'note.md'],
      [b, 'other.md'],
    ] as const) {
      const read = await h.get(`/api/document?sessionId=${doc.body.document.sessionId}&viewId=${doc.body.document.viewId}`);
      assert.equal(read.status, 200, `${name} 的视图必须仍然有效`);
    }
  });
});

test('P1-04c 隐藏后保存：保存换了 inode，但隐藏记录必须跟着刷新（文件不得"复活"）', async () => {
  await withDraftHost(async (h) => {
    assert.equal((await h.post('/api/workspace/hide', { projectId: PROJ, path: 'note.md' })).status, 200);
    const before = await h.get(`/api/workspace/hidden?projectId=${PROJ}`);
    assert.equal(before.body.entries[0].state, 'active');

    const opened = await h.post('/api/open', { projectId: PROJ, path: 'note.md' });
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;
    const edited = await h.post('/api/edit', {
      sessionId,
      viewId,
      buffer: 'SAVED-WHILE-HIDDEN\n',
      expectedVersion: undefined,
    });
    const saved = await h.post('/api/save', {
      sessionId,
      viewId,
      expectedVersion: edited.body.document.baseVersion,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const after = await h.get(`/api/workspace/hidden?projectId=${PROJ}`);
    assert.equal(after.body.entries[0].state, 'active', '保存必须刷新记录身份，不能变成 rebound');

    const tree = await h.get(`/api/tree?projectId=${PROJ}`);
    assert.ok(
      !(tree.body.entries as { name: string }[]).some((entry) => entry.name === 'note.md'),
      '保存之后文件必须仍然隐藏（默认视图不显示）',
    );
    assert.equal(tree.body.page.hiddenCount, 1);
  });
});

test('P1-05a 隐藏后在工作台内改名：旧记录失效但不影响新名字，改名不被记录拦住', async () => {
  await withDraftHost(async (h) => {
    assert.equal((await h.post('/api/workspace/hide', { projectId: PROJ, path: 'note.md' })).status, 200);

    // 没有活动会话：改名必须成功（隐藏记录不是结构变更阻断）
    const renamed = await h.post('/api/files/rename', {
      projectId: PROJ,
      sourcePath: 'note.md',
      name: 'renamed.md',
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));

    const tree = await h.get(`/api/tree?projectId=${PROJ}`);
    const names = (tree.body.entries as { name: string }[]).map((entry) => entry.name);
    assert.ok(names.includes('renamed.md'), '改名后的文件必须是可见的（旧记录只作用于旧路径）');

    const query = await h.get(`/api/workspace/hidden?projectId=${PROJ}`);
    assert.deepEqual(query.body.entries, [{ path: 'note.md', state: 'missing' }]);

    // 记录可以被清掉，且清理不影响任何磁盘文件
    assert.equal((await h.post('/api/workspace/unhide', { projectId: PROJ, path: 'note.md' })).status, 200);
    assert.equal(await readFile(join(h.root, 'renamed.md'), 'utf8'), 'ORIGINAL\n');
  });
});

test('P1-05b 隐藏目录里新增文件：新文件不会因为父目录的记录而被当成旧对象', async () => {
  await withDraftHost(async (h) => {
    await mkdir(join(h.root, 'docs'), { recursive: true });
    await writeFile(join(h.root, 'docs', 'a.md'), '# a\n', 'utf8');
    assert.equal((await h.post('/api/workspace/hide', { projectId: PROJ, path: 'docs/a.md' })).status, 200);

    // 外部删掉再建一个同路径的新文件
    await rm(join(h.root, 'docs', 'a.md'));
    await writeFile(join(h.root, 'docs', 'a.md'), '# brand new\n', 'utf8');

    const shown = await h.get(`/api/tree?projectId=${PROJ}&dir=docs&includeHidden=1`);
    const entry = (shown.body.entries as { relPath: string; hidden?: boolean }[]).find(
      (item) => item.relPath === 'docs/a.md',
    );
    assert.ok(entry);
    assert.notEqual(entry?.hidden, true, '新对象不得继承旧记录的隐藏状态');

    const query = await h.get(`/api/workspace/hidden?projectId=${PROJ}`);
    assert.equal(query.body.entries[0].state, 'rebound');
  });
});
