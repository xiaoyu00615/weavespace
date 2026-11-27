/**
 * UX-02C-03-P2-01：保留命名空间守卫 + 会话屏障。
 *
 * 两件事必须同时成立，缺一即等于把内部回收区暴露给普通 `open`/`create`/`move`：
 * 1. **展示层**看不到 `.weavespace`（树、递归清单）；
 * 2. **全部公开入口**都拒绝该项目内路径（不是靠"路径不在授权范围内"间接拒绝）。
 *
 * 会话屏障复用改名/移动那套：只要有活动 View 或未保存草稿，删除一律拒绝，
 * 且草稿不得被丢弃。
 */
import assert from 'node:assert/strict';
import { lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { serializeConfig } from '../../apps/server/src/store/config.ts';
import { rootTokenOf } from '../../packages/storage/index.ts';

const PROJ = 'project-a';

interface ApiResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  status: number;
}

interface Ctx {
  root: string;
  api: {
    post(path: string, body: unknown): Promise<ApiResponse>;
    get(path: string): Promise<ApiResponse>;
    open(path: string): Promise<ApiResponse>;
  };
}

async function withHost(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-p2-guard-'));
  const storeDir = join(base, 'store');
  const root = join(base, 'project-a');
  await mkdir(storeDir, { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'a.md'), '# a\n', 'utf8');
  await writeFile(join(root, 'docs', 'guide.md'), '# g\n', 'utf8');

  writeFileSync(
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
          grantedAt: '2026-11-22T00:00:00.000Z',
          grantSource: 'os-dialog',
        },
      ],
    }),
    'utf8',
  );

  const server: ShellServer = await createShellServer({
    port: 0,
    managedStore: { dir: storeDir, picker: createFakePicker([]) },
  });
  const token = ((await (await fetch(`${server.url}/api/session-token`)).json()) as { token?: string }).token ?? '';

  const api = {
    async post(path: string, body: unknown): Promise<ApiResponse> {
      const res = await fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ws-token': token, origin: server.url },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    async get(path: string): Promise<ApiResponse> {
      const res = await fetch(`${server.url}${path}`, { headers: { 'x-ws-token': token } });
      return { status: res.status, body: await res.json() };
    },
    open(path: string) {
      return api.post('/api/open', { projectId: PROJ, path });
    },
  };

  try {
    await fn({ root, api });
  } finally {
    await server.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

/** 先做一次正常回收，让 `.weavespace` 真正存在于磁盘上（否则"守卫生效"可能只是恰好不存在）。 */
async function seedTrash(api: Ctx['api']): Promise<void> {
  const res = await api.post('/api/trash/entry', { projectId: PROJ, path: 'a.md', opId: 'op-guard-0001' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

test('P2-01k 保留目录不出现在文件树与递归清单里（total / 快照都不含它）', async () => {
  await withHost(async (h) => {
    await seedTrash(h.api);
    assert.equal(lstatSync(join(h.root, '.weavespace')).isDirectory(), true, '前置：内部目录确实存在');

    const tree = await h.api.get(`/api/tree?projectId=${PROJ}`);
    const names = (tree.body.entries as { name: string }[]).map((entry) => entry.name);
    assert.ok(!names.includes('.weavespace'));
    assert.equal(tree.body.page.total, names.length, 'total 不得把内部目录算进去');

    const again = await h.api.get(`/api/tree?projectId=${PROJ}`);
    assert.equal(again.body.page.snapshot, tree.body.page.snapshot, '过滤后快照必须稳定');

    // 递归清单（`/api/resources`）走 provider.list()：内部目录必须在那里被跳过。
    // 特地在内部目录里放一个"看起来可以打开"的文本，否则这个断言会因为
    // "payload 没有扩展名、本来就不进清单"而变成空转。
    writeFileSync(join(h.root, '.weavespace', 'note.md'), '# internal\n', 'utf8');
    const resources = await h.api.get(`/api/resources?projectId=${PROJ}`);
    assert.equal(resources.status, 200, JSON.stringify(resources.body));
    const collect = (nodes: Array<{ name: string; path?: string; children?: unknown[] }>): string[] =>
      nodes.flatMap((node) => [
        node.name,
        ...(node.path ? [node.path] : []),
        ...collect((node.children ?? []) as Array<{ name: string; path?: string; children?: unknown[] }>),
      ]);
    const exposed = collect(resources.body.nodes as Array<{ name: string; path?: string; children?: unknown[] }>);
    assert.ok(!exposed.includes('.weavespace'), '递归清单不得包含内部目录');
    assert.ok(!exposed.some((name) => name.includes('.weavespace/')), '递归清单不得包含内部文件');
  });
});

test('P2-01l 保留路径在全部公开入口都被拒绝（不是靠"越界"间接拒绝）', async () => {
  await withHost(async (h) => {
    await seedTrash(h.api);
    const reserved = '.weavespace/trash/op-guard-0001/payload';

    const cases: Array<{ name: string; res: ApiResponse }> = [];
    cases.push({ name: 'open', res: await h.api.post('/api/open', { projectId: PROJ, path: reserved }) });
    cases.push({
      name: 'create.parent',
      res: await h.api.post('/api/files/create', {
        projectId: PROJ,
        parentDir: '.weavespace/trash',
        name: 'x.md',
      }),
    });
    cases.push({
      name: 'create.name',
      res: await h.api.post('/api/directories/create', { projectId: PROJ, parentDir: '', name: '.weavespace' }),
    });
    /*
     * 结构变更现在要求源身份预期（UX-02C-02-R2）。这两条要验的是"保留路径守卫"，
     * 所以身份字段必须**形状合法**，否则会被更早的形状校验挡在 400，测不到 403。
     * 保留路径不在树里、取不到真锚，这里用一个合法形状的占位锚即可：
     * 授权在"读源身份"之前，锚内容根本不会被用到。
     */
    const wellFormedAnchor = 'a'.repeat(32);
    // 目标目录同样是形状合法的占位（保留路径守卫在前，锚内容不会被用到）
    const wellFormedTargetAnchor = 'b'.repeat(32);
    cases.push({
      name: 'move.source',
      res: await h.api.post('/api/files/move', {
        projectId: PROJ,
        sourcePath: reserved,
        targetParentDir: '',
        name: 'stolen.md',
        sourceAnchor: wellFormedAnchor,
        targetAnchor: wellFormedTargetAnchor,
      }),
    });
    const guideAnchor = ((await h.api.get(`/api/tree?projectId=${PROJ}&dir=docs`)).body as {
      anchors?: Record<string, string>;
    }).anchors?.['docs/guide.md'];
    assert.equal(typeof guideAnchor, 'string', '夹具取不到 docs/guide.md 的锚');
    cases.push({
      name: 'move.target',
      res: await h.api.post('/api/files/move', {
        projectId: PROJ,
        sourcePath: 'docs/guide.md',
        targetParentDir: '.weavespace/trash',
        name: 'guide.md',
        sourceAnchor: guideAnchor,
        targetAnchor: wellFormedTargetAnchor,
      }),
    });
    cases.push({
      name: 'hide',
      res: await h.api.post('/api/workspace/hide', { projectId: PROJ, path: reserved }),
    });
    cases.push({ name: 'tree.dir', res: await h.api.get(`/api/tree?projectId=${PROJ}&dir=.weavespace`) });
    cases.push({ name: 'trash.source', res: await h.api.post('/api/trash/entry', { projectId: PROJ, path: reserved, opId: 'op-guard-0002' }) });

    for (const item of cases) {
      assert.equal(item.res.status, 403, `${item.name} 必须 403，实际 ${item.res.status} ${JSON.stringify(item.res.body)}`);
      assert.equal(item.res.body.errorCode, 'ERR_PATH_RESERVED', `${item.name} 必须使用专用错误码`);
    }

    // 零副作用：内部 payload 未被移动，普通文件未被改动
    assert.equal(await readFile(join(h.root, '.weavespace', 'trash', 'op-guard-0001', 'payload'), 'utf8'), '# a\n');
    assert.equal(await readFile(join(h.root, 'docs', 'guide.md'), 'utf8'), '# g\n');
  });
});

test('P2-01m 有活动 View 时拒绝回收：409 + blockedBy，文件与草稿都不动', async () => {
  await withHost(async (h) => {
    const opened = await h.api.open('a.md');
    assert.equal(opened.status, 200, JSON.stringify(opened.body));

    const res = await h.api.post('/api/trash/entry', { projectId: PROJ, path: 'a.md', opId: 'op-guard-0003' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_STRUCTURE_SESSION_BUSY');
    assert.deepEqual(res.body.blockedBy, ['ACTIVE_VIEWS']);
    assert.equal(await readFile(join(h.root, 'a.md'), 'utf8'), '# a\n');
    assert.equal((await h.api.get(`/api/trash?projectId=${PROJ}`)).body.entries.length, 0);
  });
});

test('P2-01n 有未保存草稿时拒绝回收：草稿保留、状态可查', async () => {
  await withHost(async (h) => {
    const opened = await h.api.open('a.md');
    const { sessionId, viewId, baseVersion } = opened.body.document;
    const edited = await h.api.post('/api/edit', {
      sessionId,
      viewId,
      buffer: '# DRAFT NOT SAVED\n',
      expectedVersion: baseVersion,
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));

    const res = await h.api.post('/api/trash/entry', { projectId: PROJ, path: 'a.md', opId: 'op-guard-0004' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_STRUCTURE_SESSION_BUSY');
    assert.ok((res.body.blockedBy as string[]).includes('DIRTY'), JSON.stringify(res.body.blockedBy));
    assert.ok((res.body.blockedBy as string[]).includes('ACTIVE_VIEWS'));

    // 草稿仍然在，磁盘正文没有被改写，也没有被移入回收区
    const doc = await h.api.get(`/api/document?sessionId=${sessionId}&viewId=${viewId}`);
    assert.equal(doc.body.document.content, '# DRAFT NOT SAVED\n');
    assert.equal(await readFile(join(h.root, 'a.md'), 'utf8'), '# a\n');
    assert.equal((await h.api.get(`/api/trash?projectId=${PROJ}`)).body.entries.length, 0);
  });
});
