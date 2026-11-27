/**
 * UX-02C-04-R1：资源元数据身份一致性（Host 侧）。
 *
 * 与套件 101 的分工：101 钉"元数据本身能用"，这里钉"身份不一致时绝不复用"。
 * 四个修复点各自对应一组用例：
 * - A 组（R1-01）：同名不同身份各自留记录，B 不继承 A 的标注，A 的历史不丢；
 * - B 组（R1-02）：迁移只处理**真实移动的那个对象**，失效记录与原位历史都不动；
 * - C 组（R1-03）：编辑会话的"资源身份预期"只能是 Host 比对的前置条件；
 * - D 组（R1-04）：结构变更响应里的 `metadataMigration` / `metadataMoved` 是真的。
 *
 * 取证方式与 101 一致：真实 `FileProjectStore` + 真实 LocalProvider + 真实磁盘 + 真实 HTTP。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { parseConfig, serializeConfig } from '../../apps/server/src/store/config.ts';
import { rootTokenOf } from '../../packages/storage/path-safety.ts';

interface ApiResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

const PROJ_A = 'project-a';
const PROJ_B = 'project-b';

interface Ctx {
  base: string;
  storeDir: string;
  rootA: string;
  rootB: string;
  server: ShellServer;
  post(path: string, body: unknown): Promise<ApiResponse>;
  get(path: string): Promise<ApiResponse>;
  set(projectId: string, path: string, payload: Record<string, unknown>, anchor?: string): Promise<ApiResponse>;
  clear(
    projectId: string,
    path: string,
    extra?: { anchor?: string; scope?: 'object' | 'stale' },
  ): Promise<ApiResponse>;
  list(projectId: string): Promise<ApiResponse>;
  tree(projectId: string, dir?: string): Promise<ApiResponse>;
  config(): Promise<{ raw: any; parsed: ReturnType<typeof parseConfig> }>;
  save(projectId: string, path: string, buffer: string): Promise<ApiResponse>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

async function withHost(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-meta-r1-'));
  const storeDir = join(base, 'store');
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(storeDir, { recursive: true });
  await mkdir(join(rootA, 'docs', 'sub'), { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');
  await writeFile(join(rootA, 'b.md'), '# B\n', 'utf8');
  await writeFile(join(rootA, 'x.md'), '# X\n', 'utf8');
  await writeFile(join(rootA, 'y.md'), '# Y\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'guide.md'), '# guide\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'sub', 'deep.md'), '# deep\n', 'utf8');
  await writeFile(join(rootB, 'a.md'), '# B a\n', 'utf8');

  const entry = (projectId: string, name: string, rootDir: string) => ({
    projectId,
    name,
    rootDir,
    canonicalRoot: realpathSync(rootDir),
    rootToken: rootTokenOf(rootDir),
    grantedAt: '2026-11-27T00:00:00.000Z',
    grantSource: 'os-dialog',
  });

  const projects = [entry(PROJ_A, '项目 A', rootA), entry(PROJ_B, '项目 B', rootB)];
  await writeFile(
    join(storeDir, 'workspace.json'),
    serializeConfig({
      version: 4,
      commitSeq: 0,
      issuedIds: [PROJ_A, PROJ_B],
      revoked: [],
      projects,
      hidden: [],
      trash: [],
    }),
    'utf8',
  );

  let server = await createShellServer({
    port: 0,
    managedStore: { dir: storeDir, picker: createFakePicker([]) },
  });

  const api = async (path: string, init?: RequestInit): Promise<ApiResponse> => {
    const res = await fetch(`${server.url}${path}`, init);
    const text = await res.text();
    return { status: res.status, body: text === '' ? null : JSON.parse(text) };
  };

  let token = ((await api('/api/session-token')).body as { token?: string }).token ?? '';

  const get = (path: string): Promise<ApiResponse> => api(path, { headers: { 'x-ws-token': token } });
  const post = (path: string, body: unknown): Promise<ApiResponse> =>
    api(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ws-token': token,
        origin: server.url,
      },
      body: JSON.stringify(body),
    });

  const ctx: Ctx = {
    base,
    storeDir,
    rootA,
    rootB,
    server,
    post,
    get,
    set: (projectId, path, payload, anchor) =>
      post('/api/metadata/set', { projectId, path, ...payload, ...(anchor ? { anchor } : {}) }),
    clear: (projectId, path, extra = {}) =>
      post('/api/metadata/clear', {
        projectId,
        path,
        ...(extra.anchor ? { anchor: extra.anchor } : {}),
        ...(extra.scope ? { scope: extra.scope } : {}),
      }),
    list: (projectId) => get(`/api/metadata?projectId=${encodeURIComponent(projectId)}`),
    tree: (projectId, dir = '') =>
      get(
        `/api/tree?projectId=${encodeURIComponent(projectId)}${dir ? `&dir=${encodeURIComponent(dir)}` : ''}`,
      ),
    async config() {
      const raw = await readFile(join(storeDir, 'workspace.json'), 'utf8');
      return { raw: JSON.parse(raw), parsed: parseConfig(raw) };
    },
    async save(projectId, path, buffer) {
      const opened = await post('/api/open', { projectId, path });
      if (opened.status !== 200) return opened;
      const { sessionId, viewId, baseVersion } = opened.body.document;
      const edited = await post('/api/edit', { sessionId, viewId, buffer, expectedVersion: baseVersion });
      if (edited.status !== 200) return edited;
      return post('/api/save', { sessionId, viewId, expectedVersion: edited.body.document.baseVersion });
    },
    async restart() {
      await server.close();
      server = await createShellServer({
        port: 0,
        managedStore: { dir: storeDir, picker: createFakePicker([]) },
      });
      ctx.server = server;
      token = ((await api('/api/session-token')).body as { token?: string }).token ?? '';
    },
    async close() {
      await server.close();
    },
  };

  try {
    await fn(ctx);
  } finally {
    await server.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

function nodeOf(body: any, name: string): any {
  return ((body?.entries ?? []) as any[]).find((entry) => entry.name === name);
}

/**
 * 取某一行/某个条目的资源锚。
 *
 * 锚在**层级的锚表**里（`body.anchors[relPath]`），不在条目上：条目是"这一层有哪些
 * 东西"，锚是"那一行此刻是哪个对象"。混在一起会让普通保存（换 inode）也改变条目集合。
 */
function anchorOf(body: any, name: string, dir = ''): string {
  const relPath = dir ? `${dir}/${name}` : name;
  const anchor = (body?.anchors ?? {})[relPath];
  assert.equal(typeof anchor, 'string', `${relPath} 应当带资源锚：${JSON.stringify(body).slice(0, 400)}`);
  assert.match(anchor as string, /^[0-9a-f]{32}$/);
  return anchor as string;
}

function recordsAt(config: { parsed: ReturnType<typeof parseConfig> }, path: string): any[] {
  return (config.parsed?.state.metadata ?? []).filter((record) => record.path === path);
}

/* ================================================================== */
/* A 组：同名不同身份                                                   */
/* ================================================================== */

test('R1-A01 同名不同身份：B 只设颜色，不继承 A 的标注名与标签，A 的记录仍在', async () => {
  await withHost(async (ctx) => {
    const anchorA = anchorOf((await ctx.tree(PROJ_A)).body, 'a.md');
    await ctx.set(PROJ_A, 'a.md', { alias: 'A 的标注', tags: ['A 标签'], color: 'red' }, anchorA);

    const trashed = await ctx.post('/api/trash/entry', {
      projectId: PROJ_A,
      path: 'a.md',
      opId: 'r1-op-0001',
    });
    assert.equal(trashed.status, 200, JSON.stringify(trashed.body));

    // 原位置出现另一个对象：路径相同、身份不同
    await writeFile(join(ctx.rootA, 'a.md'), '# 全新文件\n', 'utf8');
    const treeB = await ctx.tree(PROJ_A);
    const anchorB = anchorOf(treeB.body, 'a.md');
    assert.notEqual(anchorB, anchorA, '换了对象，资源锚必须不同');
    assert.equal(nodeOf(treeB.body, 'a.md').meta, undefined, '新对象不得显示 A 的标注');

    const res = await ctx.set(PROJ_A, 'a.md', { color: 'blue' }, anchorB);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.metadata.alias, undefined, 'B 不得继承 A 的标注名');
    assert.deepEqual(res.body.metadata.tags, [], 'B 不得继承 A 的标签');
    assert.equal(res.body.metadata.color, 'blue');

    const after = await ctx.tree(PROJ_A);
    const node = nodeOf(after.body, 'a.md');
    assert.equal(node.meta.color, 'blue');
    assert.equal(node.meta.alias, undefined);
    assert.deepEqual(node.meta.tags, []);

    // 两个身份各有一条记录：A 的历史没有被 B 的写入覆盖
    const config = await ctx.config();
    const records = recordsAt(config, 'a.md');
    assert.equal(records.length, 2, '同一路径的两个身份必须各有记录');
    const identities = new Set(records.map((record) => record.identity));
    assert.equal(identities.size, 2, '两条记录的身份必须不同');
    const legacy = records.find((record) => record.alias === 'A 的标注');
    assert.ok(legacy, 'A 的历史标注必须保留');
    assert.deepEqual(legacy.tags, ['A 标签']);
    assert.equal(legacy.color, 'red');
    assert.ok(config.parsed, '多身份记录仍必须通过校验和自检');
  });
});

test('R1-A02 移走 B → 恢复 A：A 拿回原标注，B 在新位置仍是自己的标注', async () => {
  await withHost(async (ctx) => {
    const anchorA = anchorOf((await ctx.tree(PROJ_A)).body, 'a.md');
    await ctx.set(PROJ_A, 'a.md', { alias: 'A 的标注', tags: ['A 标签'], color: 'red' }, anchorA);
    const trashed = await ctx.post('/api/trash/entry', {
      projectId: PROJ_A,
      path: 'a.md',
      opId: 'r1-op-0002',
    });
    assert.equal(trashed.status, 200, JSON.stringify(trashed.body));

    await writeFile(join(ctx.rootA, 'a.md'), '# 全新文件\n', 'utf8');
    const anchorB = anchorOf((await ctx.tree(PROJ_A)).body, 'a.md');
    await ctx.set(PROJ_A, 'a.md', { color: 'blue' }, anchorB);

    // B 改名挪走：它自己的记录跟着走
    const renamed = await ctx.post('/api/files/rename', {
      projectId: PROJ_A,
      sourcePath: 'a.md',
      name: 'moved.md',
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.metadataMigration, 'moved');
    assert.equal(renamed.body.metadataMoved, 1, '只迁移真实移动的那一个对象');

    // 恢复 A
    const restored = await ctx.post('/api/trash/restore', {
      projectId: PROJ_A,
      opId: 'r1-op-0002',
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));

    const tree = await ctx.tree(PROJ_A);
    const a = nodeOf(tree.body, 'a.md');
    assert.equal(a.meta.alias, 'A 的标注', 'A 恢复后必须拿回自己的标注');
    assert.deepEqual(a.meta.tags, ['A 标签']);
    assert.equal(a.meta.color, 'red');

    const moved = nodeOf(tree.body, 'moved.md');
    assert.equal(moved.meta.color, 'blue', 'B 在新位置保留自己的标注');
    assert.equal(moved.meta.alias, undefined, 'B 不得因为恢复 A 而拿到 A 的标注');
    assert.deepEqual(moved.meta.tags, []);
  });
});

test('R1-A03 多身份记录重启后仍按身份生效', async () => {
  await withHost(async (ctx) => {
    const anchorA = anchorOf((await ctx.tree(PROJ_A)).body, 'a.md');
    await ctx.set(PROJ_A, 'a.md', { alias: '旧对象', color: 'green' }, anchorA);
    await rm(join(ctx.rootA, 'a.md'));
    await writeFile(join(ctx.rootA, 'a.md'), '# 新对象\n', 'utf8');
    const anchorB = anchorOf((await ctx.tree(PROJ_A)).body, 'a.md');
    await ctx.set(PROJ_A, 'a.md', { alias: '新对象', color: 'purple' }, anchorB);

    const config = await ctx.config();
    assert.equal(recordsAt(config, 'a.md').length, 2);
    assert.equal(config.raw.version, 5);

    await ctx.restart();

    const tree = await ctx.tree(PROJ_A);
    const node = nodeOf(tree.body, 'a.md');
    assert.equal(node.meta.alias, '新对象', '重启后只显示身份核验通过的那一条');
    assert.equal(node.meta.color, 'purple');

    const list = await ctx.list(PROJ_A);
    const states = (list.body.entries as any[]).map((item) => item.state).sort();
    assert.deepEqual(states, ['active', 'rebound'], '两条记录各自如实报告状态');
  });
});

test('R1-A04 内容保存换了 inode：标注仍然成立（身份再绑定），且不是无条件跟随', async () => {
  await withHost(async (ctx) => {
    const anchorA = anchorOf((await ctx.tree(PROJ_A)).body, 'a.md');
    await ctx.set(PROJ_A, 'a.md', { alias: '要活过保存', tags: ['doc'], color: 'green' }, anchorA);

    // 保存是"临时文件 + rename"：必然换 inode，锚因此一定会变
    const saved = await ctx.save(PROJ_A, 'a.md', '# A edited\n');
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const afterSave = await ctx.tree(PROJ_A);
    const anchorAfter = anchorOf(afterSave.body, 'a.md');
    assert.notEqual(anchorAfter, anchorA, '保存换了对象身份，锚必须跟着变');
    assert.equal(nodeOf(afterSave.body, 'a.md').meta.alias, '要活过保存', '标注必须活过一次普通保存');
    assert.deepEqual(nodeOf(afterSave.body, 'a.md').meta.tags, ['doc']);

    // 记录只有一条：再绑定是"改身份"，不是"新建一条历史记录"
    const config = await ctx.config();
    const records = recordsAt(config, 'a.md');
    assert.equal(records.length, 1);
    assert.equal(records[0]?.alias, '要活过保存');
    // 磁盘内容真的变了，而记录里的身份与当前对象一致
    assert.equal(await readFile(join(ctx.rootA, 'a.md'), 'utf8'), '# A edited\n');
    assert.equal(nodeOf((await ctx.tree(PROJ_A)).body, 'a.md').meta.color, 'green');
  });
});

test('R1-A05 保存前对象已被替换：保存成功但标注不得绑到新对象上', async () => {
  await withHost(async (ctx) => {
    const anchorA = anchorOf((await ctx.tree(PROJ_A)).body, 'a.md');
    await ctx.set(PROJ_A, 'a.md', { alias: '旧对象' }, anchorA);

    // 外部替换：保存前那一刻路径上已经不是记录里的对象
    await rm(join(ctx.rootA, 'a.md'));
    await writeFile(join(ctx.rootA, 'a.md'), '# 外部新对象\n', 'utf8');

    const saved = await ctx.save(PROJ_A, 'a.md', '# 被编辑\n');
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    // 旧记录保持原样（它不成立），新对象不会因为"保存过"就继承旧标注
    const config = await ctx.config();
    assert.equal(recordsAt(config, 'a.md').length, 1);
    assert.equal(recordsAt(config, 'a.md')[0]?.alias, '旧对象');
    assert.equal(nodeOf((await ctx.tree(PROJ_A)).body, 'a.md').meta, undefined, '新对象不得继承旧标注');
  });
});

test('R1-A06 既有 v5 配置（每路径一条记录）的校验和仍可复算，不触发迁移或重写', () => {
  // 手写一份"R1 之前的代码写出来的"配置：canonical body 里的 metadata 只可能按
  // projectId → path 排序（那时唯一性就是这两维）。校验和在这里独立复算，
  // 不复用 serializeConfig —— 否则等于用被测实现证明自己。
  const legacyState = {
    version: 5 as const,
    commitSeq: 7,
    issuedIds: [PROJ_A],
    revoked: [],
    projects: [{ projectId: PROJ_A, name: 'A', rootDir: 'C:\\ws-a', rootToken: 'root-1' }],
    hidden: [],
    trash: [],
    metadata: [
      {
        projectId: PROJ_A,
        path: 'a.md',
        rootToken: 'root-1',
        identity: 'dev:1:2',
        alias: '旧标注',
        tags: ['重要'],
        color: 'blue',
        updatedAt: '2026-11-27T00:00:00.000Z',
      },
    ],
  };
  const legacyCanonical = JSON.stringify({
    version: 5,
    commitSeq: 7,
    issuedIds: [PROJ_A],
    revoked: [],
    // 旧实现的 project 投影把可选字段写成 undefined（JSON 里等同缺省）
    projects: [
      {
        projectId: PROJ_A,
        name: 'A',
        rootDir: 'C:\\ws-a',
        canonicalRoot: undefined,
        rootToken: 'root-1',
        grantedAt: undefined,
        grantSource: undefined,
        createdByOp: undefined,
      },
    ],
    hidden: [],
    trash: [],
    metadata: legacyState.metadata,
  });
  const checksum = createHash('sha256').update(legacyCanonical).digest('hex');
  const text = `${JSON.stringify({ ...legacyState, checksum }, null, 2)}\n`;

  const parsed = parseConfig(text);
  assert.ok(parsed, '既有的合法 v5 配置不得因为唯一性判据变化而被判损坏');
  assert.equal(parsed?.state.metadata[0]?.alias, '旧标注');
  assert.equal(parsed?.state.metadata[0]?.color, 'blue');
  // 逐字节一致：读取不需要"修复性重写"，也就不会产生一次配置变更
  assert.equal(serializeConfig(parsed!.state), text);
});

/* ================================================================== */
/* B 组：迁移                                                           */
/* ================================================================== */

test('R1-B01 旧对象已回收：同名新对象改名，旧记录不跟随', async () => {
  await withHost(async (ctx) => {
    const anchorA = anchorOf((await ctx.tree(PROJ_A)).body, 'a.md');
    await ctx.set(PROJ_A, 'a.md', { alias: '旧对象的标注' }, anchorA);
    await ctx.post('/api/trash/entry', { projectId: PROJ_A, path: 'a.md', opId: 'r1-op-0003' });
    await writeFile(join(ctx.rootA, 'a.md'), '# 全新文件\n', 'utf8');

    const renamed = await ctx.post('/api/files/rename', {
      projectId: PROJ_A,
      sourcePath: 'a.md',
      name: 'renamed.md',
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.metadataMigration, 'none', '没有真实对象的记录可迁移');
    assert.equal(renamed.body.metadataMoved, undefined);

    const tree = await ctx.tree(PROJ_A);
    assert.equal(nodeOf(tree.body, 'renamed.md').meta, undefined, '旧记录绝不能跟到新对象上');

    const config = await ctx.config();
    assert.equal(recordsAt(config, 'renamed.md').length, 0);
    assert.equal(recordsAt(config, 'a.md').length, 1, '旧记录留在原位，身份已经不匹配');
    assert.equal(recordsAt(config, 'a.md')[0]?.alias, '旧对象的标注');
  });
});

test('R1-B02 目录移动：失效的子记录不迁移，只迁移真实对象', async () => {
  await withHost(async (ctx) => {
    const root = await ctx.tree(PROJ_A);
    await ctx.set(PROJ_A, 'docs', { alias: '文档目录' }, anchorOf(root.body, 'docs'));
    await ctx.set(
      PROJ_A,
      'docs/guide.md',
      { alias: '指南' },
      anchorOf((await ctx.tree(PROJ_A, 'docs')).body, 'guide.md', 'docs'),
    );

    // 外部把 guide.md 换成另一个对象：记录还在，但已经不成立
    await rm(join(ctx.rootA, 'docs', 'guide.md'));
    await writeFile(join(ctx.rootA, 'docs', 'guide.md'), '# 新指南\n', 'utf8');

    const renamed = await ctx.post('/api/files/rename', {
      projectId: PROJ_A,
      sourcePath: 'docs',
      name: 'manual',
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.metadataMigration, 'moved');
    assert.equal(renamed.body.metadataMoved, 1, '只迁移目录自身（子文件已不是同一个对象）');

    const tree = await ctx.tree(PROJ_A);
    assert.equal(nodeOf(tree.body, 'manual').meta.alias, '文档目录');
    const inner = await ctx.tree(PROJ_A, 'manual');
    assert.equal(nodeOf(inner.body, 'guide.md').meta, undefined, '失效记录不得被当成已迁移');

    const config = await ctx.config();
    assert.equal(recordsAt(config, 'manual/guide.md').length, 0);
    assert.equal(recordsAt(config, 'docs/guide.md').length, 1, '失效记录留在原位，不冒充已迁移');
  });
});

test('R1-B03 目标路径已有另一身份的历史记录：不覆盖、不丢弃', async () => {
  await withHost(async (ctx) => {
    const anchorX = anchorOf((await ctx.tree(PROJ_A)).body, 'x.md');
    await ctx.set(PROJ_A, 'x.md', { alias: 'X 的历史' }, anchorX);
    await ctx.post('/api/trash/entry', { projectId: PROJ_A, path: 'x.md', opId: 'r1-op-0004' });

    const anchorY = anchorOf((await ctx.tree(PROJ_A)).body, 'y.md');
    await ctx.set(PROJ_A, 'y.md', { alias: 'Y 的标注' }, anchorY);

    const moved = await ctx.post('/api/files/move', {
      projectId: PROJ_A,
      sourcePath: 'y.md',
      targetParentDir: '',
      name: 'x.md',
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.metadataMigration, 'moved');
    assert.equal(moved.body.metadataMoved, 1);

    const tree = await ctx.tree(PROJ_A);
    assert.equal(nodeOf(tree.body, 'x.md').meta.alias, 'Y 的标注', '移动过来的对象显示自己的标注');

    const config = await ctx.config();
    const records = recordsAt(config, 'x.md');
    assert.equal(records.length, 2, '占位的历史记录必须保留');
    const aliases = records.map((record) => record.alias).sort();
    assert.deepEqual(aliases, ['X 的历史', 'Y 的标注']);
  });
});

test('R1-B04 被拒绝的改名：元数据零变更', async () => {
  await withHost(async (ctx) => {
    const anchor = anchorOf((await ctx.tree(PROJ_A)).body, 'a.md');
    await ctx.set(PROJ_A, 'a.md', { alias: '不该丢' }, anchor);
    const before = await ctx.config();

    const res = await ctx.post('/api/files/rename', { projectId: PROJ_A, sourcePath: 'a.md', name: 'b.md' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.metadataMigration, undefined);

    const after = await ctx.config();
    assert.deepEqual(after.parsed?.state.metadata, before.parsed?.state.metadata);
    assert.equal(nodeOf((await ctx.tree(PROJ_A)).body, 'a.md').meta.alias, '不该丢');
  });
});

/* ================================================================== */
/* C 组：会话身份（Host 侧比对）                                         */
/* ================================================================== */

test('R1-C01 过期的资源锚：设置被拒绝且零写入', async () => {
  await withHost(async (ctx) => {
    const anchorA = anchorOf((await ctx.tree(PROJ_A)).body, 'a.md');
    await ctx.set(PROJ_A, 'a.md', { alias: '原对象' }, anchorA);
    await rm(join(ctx.rootA, 'a.md'));
    await writeFile(join(ctx.rootA, 'a.md'), '# 新对象\n', 'utf8');

    const res = await ctx.set(PROJ_A, 'a.md', { alias: '写错对象' }, anchorA);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_METADATA_TARGET_CHANGED');

    const config = await ctx.config();
    assert.equal(recordsAt(config, 'a.md').length, 1, '被拒绝的写入不得留下任何记录');
    assert.equal(recordsAt(config, 'a.md')[0]?.alias, '原对象');
    assert.equal(nodeOf((await ctx.tree(PROJ_A)).body, 'a.md').meta, undefined, '新对象仍然没有标注');
  });
});

test('R1-C02 过期的资源锚：清除被拒绝，不删任何记录', async () => {
  await withHost(async (ctx) => {
    const anchorA = anchorOf((await ctx.tree(PROJ_A)).body, 'a.md');
    await ctx.set(PROJ_A, 'a.md', { alias: '原对象' }, anchorA);
    await rm(join(ctx.rootA, 'a.md'));
    await writeFile(join(ctx.rootA, 'a.md'), '# 新对象\n', 'utf8');

    const res = await ctx.clear(PROJ_A, 'a.md', { anchor: anchorA });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_METADATA_TARGET_CHANGED');
    assert.equal(recordsAt(await ctx.config(), 'a.md').length, 1);
  });
});

test('R1-C03 清除当前对象不影响同路径其它身份的历史记录', async () => {
  await withHost(async (ctx) => {
    const anchorA = anchorOf((await ctx.tree(PROJ_A)).body, 'a.md');
    await ctx.set(PROJ_A, 'a.md', { alias: '旧对象' }, anchorA);
    await rm(join(ctx.rootA, 'a.md'));
    await writeFile(join(ctx.rootA, 'a.md'), '# 新对象\n', 'utf8');
    const anchorB = anchorOf((await ctx.tree(PROJ_A)).body, 'a.md');
    await ctx.set(PROJ_A, 'a.md', { color: 'blue' }, anchorB);
    assert.equal(recordsAt(await ctx.config(), 'a.md').length, 2);

    const res = await ctx.clear(PROJ_A, 'a.md', { anchor: anchorB });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.changed, true);
    assert.equal(res.body.scope, 'object');

    const config = await ctx.config();
    const records = recordsAt(config, 'a.md');
    assert.equal(records.length, 1, '只删当前对象那一条');
    assert.equal(records[0]?.alias, '旧对象');
    assert.equal(nodeOf((await ctx.tree(PROJ_A)).body, 'a.md').meta, undefined);
  });
});

test('R1-C04 scope=stale：显式清理失效记录，当前对象的记录保留', async () => {
  await withHost(async (ctx) => {
    const anchorA = anchorOf((await ctx.tree(PROJ_A)).body, 'a.md');
    await ctx.set(PROJ_A, 'a.md', { alias: '旧对象' }, anchorA);
    await rm(join(ctx.rootA, 'a.md'));
    await writeFile(join(ctx.rootA, 'a.md'), '# 新对象\n', 'utf8');
    const anchorB = anchorOf((await ctx.tree(PROJ_A)).body, 'a.md');
    await ctx.set(PROJ_A, 'a.md', { color: 'blue' }, anchorB);

    const res = await ctx.clear(PROJ_A, 'a.md', { anchor: anchorB, scope: 'stale' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.scope, 'stale');
    assert.equal(res.body.changed, true);

    const config = await ctx.config();
    const records = recordsAt(config, 'a.md');
    assert.equal(records.length, 1, '只清失效记录');
    assert.equal(records[0]?.color, 'blue', '当前对象的记录必须还在');
    assert.equal(nodeOf((await ctx.tree(PROJ_A)).body, 'a.md').meta.color, 'blue');
  });
});

test('R1-C05 对象缺失时带锚清除：明确 409，不静默删历史', async () => {
  await withHost(async (ctx) => {
    const anchor = anchorOf((await ctx.tree(PROJ_A)).body, 'a.md');
    await ctx.set(PROJ_A, 'a.md', { alias: '会被删掉' }, anchor);
    await rm(join(ctx.rootA, 'a.md'));

    const res = await ctx.clear(PROJ_A, 'a.md', { anchor });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_METADATA_TARGET_CHANGED');
    assert.equal(recordsAt(await ctx.config(), 'a.md').length, 1, '记录必须留着，由用户显式清理');

    // 不带锚 = 显式清理失效记录（保持既有契约：文件不存在时也能清干净）
    const cleaned = await ctx.clear(PROJ_A, 'a.md');
    assert.equal(cleaned.status, 200, JSON.stringify(cleaned.body));
    assert.equal(cleaned.body.changed, true);
    assert.equal(cleaned.body.scope, 'stale');
    assert.equal(recordsAt(await ctx.config(), 'a.md').length, 0);
  });
});

test('R1-C06 资源锚形状非法 / 客户端自述身份：一律 400 且零写入', async () => {
  await withHost(async (ctx) => {
    for (const body of [
      { projectId: PROJ_A, path: 'a.md', alias: 'x', anchor: 'not-a-hash' },
      { projectId: PROJ_A, path: 'a.md', alias: 'x', anchor: 42 },
      { projectId: PROJ_A, path: 'a.md', alias: 'x', identity: 'dev:1:2' },
      { projectId: PROJ_A, path: 'a.md', alias: 'x', rootToken: 'forged' },
    ]) {
      const res = await ctx.post('/api/metadata/set', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.errorCode, 'ERR_COMMAND_INVALID');
    }
    assert.equal(recordsAt(await ctx.config(), 'a.md').length, 0);

    const badScope = await ctx.post('/api/metadata/clear', { projectId: PROJ_A, path: 'a.md', scope: 'all' });
    assert.equal(badScope.status, 400, JSON.stringify(badScope.body));
  });
});

/* ================================================================== */
/* D 组：响应契约                                                       */
/* ================================================================== */

test('R1-D01 结构变更响应带真实的迁移条数', async () => {
  await withHost(async (ctx) => {
    const root = await ctx.tree(PROJ_A);
    await ctx.set(PROJ_A, 'docs', { alias: '目录' }, anchorOf(root.body, 'docs'));
    await ctx.set(PROJ_A, 'docs/guide.md', { alias: '指南' }, anchorOf((await ctx.tree(PROJ_A, 'docs')).body, 'guide.md', 'docs'));

    const res = await ctx.post('/api/files/rename', { projectId: PROJ_A, sourcePath: 'docs', name: 'manual' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.metadataMigration, 'moved');
    assert.equal(res.body.metadataMoved, 2, '目录与仍在原对象上的子文件各一条');
  });
});

test('R1-D02 树的行与项目根都带资源锚，且换对象后锚跟着变（锚不进条目）', async () => {
  await withHost(async (ctx) => {
    const first = await ctx.tree(PROJ_A);
    const rootAnchor = first.body.projectAnchor;
    assert.equal(typeof rootAnchor, 'string');
    assert.match(rootAnchor, /^[0-9a-f]{32}$/);
    assert.equal(anchorOf(first.body, 'a.md'), anchorOf((await ctx.tree(PROJ_A)).body, 'a.md'), '同一对象锚稳定');

    /*
     * 锚**不得**混进条目：条目是"这一层有哪些东西"，锚是"那一行此刻是哪个对象"。
     * 保存文件会换 inode，若锚在条目上，任何一次普通保存都会让"条目集合"变化，
     * 于是"别的操作不该影响这棵树"这类比较会变成假失败。
     */
    assert.equal(nodeOf(first.body, 'a.md').anchor, undefined, '资源锚不得混进条目');

    const sub = await ctx.tree(PROJ_A, 'docs');
    assert.equal(typeof anchorOf(sub.body, 'guide.md', 'docs'), 'string');

    await rm(join(ctx.rootA, 'a.md'));
    await writeFile(join(ctx.rootA, 'a.md'), '# 新对象\n', 'utf8');
    const after = await ctx.tree(PROJ_A);
    assert.notEqual(anchorOf(after.body, 'a.md'), anchorOf(first.body, 'a.md'));

    // 子层不带 projectAnchor：根锚不能串到子目录
    assert.equal(sub.body.projectAnchor, undefined);
  });
});
