/**
 * UX-02C-04：资源标注名 / 标签 / 行颜色（Host 侧契约、持久化、身份与生命周期）。
 *
 * 取证方式与可见性套件（82）一致：真实 `FileProjectStore`（托管 Multi）+ 真实
 * LocalProvider + 真实临时磁盘 + 真实 HTTP。断言同时看「HTTP 状态 + 响应体 +
 * 磁盘字节 SHA-256 + 工作区配置版本 + 重启后的树」。
 *
 * 本套件钉的纪律：
 * - 元数据只写工作台配置，**文件字节、扩展名、目录结构零变更**；
 * - 身份是 `projectId + rootToken + identity(dev:ino)`，不是文件名：
 *   同名文件不共享、换了对象不继承、跨项目不串；
 * - 真实改名 / 移动后路径随迁移；失败与 UNKNOWN 不迁移；
 * - 回收不丢标注，恢复后按身份重新生效，同名新文件不继承；
 * - 配置 v1–v4 只读兼容，写入时升到 v5 且校验和仍然自洽。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { parseConfig, serializeConfig } from '../../apps/server/src/store/config.ts';
import { createFileProjectStore } from '../../apps/server/src/store/index.ts';
import { createNodeStoreIo } from '../../apps/server/src/store/io.ts';
import { rootTokenOf } from '../../packages/storage/path-safety.ts';
import { normalizeTags } from '../../apps/server/src/metadata.ts';

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
  token: string;
  post(path: string, body: unknown, opts?: { token?: boolean; origin?: boolean }): Promise<ApiResponse>;
  get(path: string, opts?: { token?: boolean }): Promise<ApiResponse>;
  set(projectId: string, path: string, payload: Record<string, unknown>): Promise<ApiResponse>;
  clear(projectId: string, path: string): Promise<ApiResponse>;
  list(projectId: string): Promise<ApiResponse>;
  tree(projectId: string, dir?: string): Promise<ApiResponse>;
  configFile(): Promise<{ raw: any; parsed: ReturnType<typeof parseConfig> }>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

interface Options {
  /** 用指定版本的配置启动（验证只读兼容与升版写入）。 */
  configVersion?: 1 | 2 | 3 | 4;
}

function shaOfFile(path: string): Promise<string> {
  return readFile(path).then((buf) => createHash('sha256').update(buf).digest('hex'));
}

async function withHost(fn: (ctx: Ctx) => Promise<void>, options: Options = {}): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-meta-'));
  const storeDir = join(base, 'store');
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(storeDir, { recursive: true });
  await mkdir(join(rootA, 'docs', 'sub'), { recursive: true });
  await mkdir(join(rootA, 'other'), { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');
  await writeFile(join(rootA, 'b.md'), '# B\n', 'utf8');
  await writeFile(join(rootA, 'same.md'), '# A same\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'guide.md'), '# guide\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'sub', 'deep.md'), '# deep\n', 'utf8');
  await writeFile(join(rootB, 'same.md'), '# B same\n', 'utf8');
  await writeFile(join(rootB, 'other.md'), '# other\n', 'utf8');

  const entry = (projectId: string, name: string, rootDir: string) => ({
    projectId,
    name,
    rootDir,
    canonicalRoot: realpathSync(rootDir),
    rootToken: rootTokenOf(rootDir),
    grantedAt: '2026-11-27T00:00:00.000Z',
    grantSource: 'os-dialog',
  });

  const version = options.configVersion ?? 4;
  const projects = [entry(PROJ_A, '项目 A', rootA), entry(PROJ_B, '项目 B', rootB)];
  const file =
    version === 1
      ? JSON.stringify({ version: 1, projects })
      : serializeConfig({
          version,
          commitSeq: 0,
          issuedIds: [PROJ_A, PROJ_B],
          revoked: [],
          projects,
          hidden: [],
          ...(version >= 4 ? { trash: [] } : {}),
        });
  await writeFile(join(storeDir, 'workspace.json'), file, 'utf8');

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

  const get = (path: string, opts: { token?: boolean } = {}): Promise<ApiResponse> =>
    api(path, { headers: opts.token === false ? {} : { 'x-ws-token': token } });

  const post = (
    path: string,
    body: unknown,
    opts: { token?: boolean; origin?: boolean } = {},
  ): Promise<ApiResponse> =>
    api(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.token === false ? {} : { 'x-ws-token': token }),
        ...(opts.origin === false ? {} : { origin: server.url }),
      },
      body: JSON.stringify(body),
    });

  const ctx: Ctx = {
    base,
    storeDir,
    rootA,
    rootB,
    server,
    token,
    post,
    get,
    set: (projectId, path, payload) => post('/api/metadata/set', { projectId, path, ...payload }),
    clear: (projectId, path) => post('/api/metadata/clear', { projectId, path }),
    list: (projectId) => get(`/api/metadata?projectId=${encodeURIComponent(projectId)}`),
    tree: (projectId, dir = '') =>
      get(
        `/api/tree?projectId=${encodeURIComponent(projectId)}${dir ? `&dir=${encodeURIComponent(dir)}` : ''}`,
      ),
    async configFile() {
      const raw = await readFile(join(storeDir, 'workspace.json'), 'utf8');
      return { raw: JSON.parse(raw), parsed: parseConfig(raw) };
    },
    async restart() {
      await server.close();
      server = await createShellServer({
        port: 0,
        managedStore: { dir: storeDir, picker: createFakePicker([]) },
      });
      ctx.server = server;
      token = ((await api('/api/session-token')).body as { token?: string }).token ?? '';
      ctx.token = token;
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

function entryOf(body: any, name: string): any {
  return ((body?.entries ?? []) as any[]).find((entry) => entry.name === name);
}

/* ================================================================== */
/* A 组：数据与持久化                                                   */
/* ================================================================== */

test('M-A01 设置标注名：树里出现 meta.alias，真实文件名与字节零变更', async () => {
  await withHost(async (ctx) => {
    const before = await shaOfFile(join(ctx.rootA, 'a.md'));
    const res = await ctx.set(PROJ_A, 'a.md', { alias: '核心架构' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'APPLIED');
    assert.equal(res.body.changed, true);
    assert.equal(res.body.metadata.alias, '核心架构');

    const tree = await ctx.tree(PROJ_A);
    const node = entryOf(tree.body, 'a.md');
    assert.equal(node.name, 'a.md', '真实名称不变');
    assert.equal(node.meta.alias, '核心架构');

    assert.equal(await shaOfFile(join(ctx.rootA, 'a.md')), before, '文件字节零变更');
    assert.equal(existsSync(join(ctx.rootA, 'a.md')), true);
  });
});

test('M-A02 幂等写入：内容没变时不写盘、不推进 commitSeq', async () => {
  await withHost(async (ctx) => {
    await ctx.set(PROJ_A, 'a.md', { alias: '标注' });
    const first = await ctx.configFile();
    const seq = first.parsed?.state.commitSeq;

    const again = await ctx.set(PROJ_A, 'a.md', { alias: '标注' });
    assert.equal(again.status, 200);
    assert.equal(again.body.changed, false, '同一份内容不重复写盘');

    const second = await ctx.configFile();
    assert.equal(second.parsed?.state.commitSeq, seq, 'commitSeq 不应推进');
  });
});

test('M-A03 只改颜色不清掉已有的标注名与标签', async () => {
  await withHost(async (ctx) => {
    await ctx.set(PROJ_A, 'a.md', { alias: '架构', tags: ['重要', '架构'] });
    const res = await ctx.set(PROJ_A, 'a.md', { color: 'blue' });
    assert.equal(res.status, 200);
    assert.equal(res.body.metadata.alias, '架构', '未传 alias 时保持原值');
    assert.deepEqual(res.body.metadata.tags, ['重要', '架构']);
    assert.equal(res.body.metadata.color, 'blue');
  });
});

test('M-A04 标注名与颜色可单独清除，其余字段保留', async () => {
  await withHost(async (ctx) => {
    await ctx.set(PROJ_A, 'a.md', { alias: '架构', tags: ['重要'], color: 'red' });
    const res = await ctx.set(PROJ_A, 'a.md', { alias: null, color: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.metadata.alias, undefined, 'null 表示清除');
    assert.equal(res.body.metadata.color, undefined);
    assert.deepEqual(res.body.metadata.tags, ['重要'], '标签不受影响');

    const tree = await ctx.tree(PROJ_A);
    const node = entryOf(tree.body, 'a.md');
    assert.equal(node.meta.alias, undefined);
    assert.deepEqual(node.meta.tags, ['重要']);
  });
});

test('M-A05 三个字段全清后整条记录被删除（不保留空壳）', async () => {
  await withHost(async (ctx) => {
    await ctx.set(PROJ_A, 'a.md', { alias: '架构', tags: ['重要'], color: 'green' });
    let config = await ctx.configFile();
    assert.equal(config.parsed?.state.metadata.length, 1);

    const res = await ctx.set(PROJ_A, 'a.md', { alias: null, tags: [], color: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.changed, true);
    assert.deepEqual(res.body.metadata, { tags: [] });

    config = await ctx.configFile();
    assert.equal(config.parsed?.state.metadata.length, 0, '空记录必须被删除');
    const tree = await ctx.tree(PROJ_A);
    assert.equal(entryOf(tree.body, 'a.md').meta, undefined);
  });
});

test('M-A06 标签规范化：trim、丢空、大小写不敏感去重并保留首次写法', async () => {
  await withHost(async (ctx) => {
    const res = await ctx.set(PROJ_A, 'a.md', { tags: ['  重要 ', '', 'Arch', 'arch', 'ARCH', '  '] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.metadata.tags, ['重要', 'Arch']);

    const tree = await ctx.tree(PROJ_A);
    assert.deepEqual(entryOf(tree.body, 'a.md').meta.tags, ['重要', 'Arch']);
  });
});

test('M-A07 标签上限与非法输入：明确的 400 且零写入', async () => {
  await withHost(async (ctx) => {
    const tooMany = await ctx.set(PROJ_A, 'a.md', {
      tags: Array.from({ length: 17 }, (_, i) => `t${i}`),
    });
    assert.equal(tooMany.status, 400, JSON.stringify(tooMany.body));
    assert.equal(tooMany.body.errorCode, 'ERR_COMMAND_INVALID');

    const tooLong = await ctx.set(PROJ_A, 'a.md', { tags: ['x'.repeat(25)] });
    assert.equal(tooLong.status, 400);

    const notArray = await ctx.set(PROJ_A, 'a.md', { tags: '重要' });
    assert.equal(notArray.status, 400);

    const badAlias = await ctx.set(PROJ_A, 'a.md', { alias: 'x'.repeat(81) });
    assert.equal(badAlias.status, 400);

    const newlineAlias = await ctx.set(PROJ_A, 'a.md', { alias: 'a\nb' });
    assert.equal(newlineAlias.status, 400);

    const nothing = await ctx.set(PROJ_A, 'a.md', {});
    assert.equal(nothing.status, 400, '至少要提供一个字段');

    const config = await ctx.configFile();
    assert.equal(config.parsed?.state.metadata.length, 0, '所有拒绝都是零写入');
  });
});

test('M-A08 颜色只接受预设 token，任意 CSS 字符串被拒绝', async () => {
  await withHost(async (ctx) => {
    const bad = await ctx.set(PROJ_A, 'a.md', { color: '#ff0000' });
    assert.equal(bad.status, 400);
    const inject = await ctx.set(PROJ_A, 'a.md', { color: 'red; background: url(x)' });
    assert.equal(inject.status, 400);

    const good = await ctx.set(PROJ_A, 'a.md', { color: 'purple' });
    assert.equal(good.status, 200);
    assert.equal(good.body.metadata.color, 'purple');
  });
});

test('M-A09 客户端不能自述身份：rootToken / identity / updatedAt 字段一律 400', async () => {
  await withHost(async (ctx) => {
    for (const payload of [
      { alias: 'x', rootToken: 'forged' },
      { alias: 'x', identity: 'dev:0:0' },
      { alias: 'x', updatedAt: '2000-01-01T00:00:00.000Z' },
      { alias: 'x', absolutePath: 'C:/Windows' },
    ]) {
      const res = await ctx.set(PROJ_A, 'a.md', payload);
      assert.equal(res.status, 400, JSON.stringify(payload));
      assert.equal(res.body.errorCode, 'ERR_COMMAND_INVALID');
    }
  });
});

test('M-A10 保留路径与越界路径不能标注', async () => {
  await withHost(async (ctx) => {
    const reserved = await ctx.set(PROJ_A, '.weavespace/trash', { alias: 'x' });
    assert.equal(reserved.status, 403);
    assert.equal(reserved.body.errorCode, 'ERR_PATH_RESERVED');

    const traversal = await ctx.set(PROJ_A, '../project-b/same.md', { alias: 'x' });
    assert.equal(traversal.status, 400);

    const absolute = await ctx.set(PROJ_A, 'C:/Windows/win.ini', { alias: 'x' });
    assert.equal(absolute.status, 400);
  });
});

test('M-A11 目标不存在 → 404，不登记看不见的标注', async () => {
  await withHost(async (ctx) => {
    const res = await ctx.set(PROJ_A, 'nope.md', { alias: 'x' });
    assert.equal(res.status, 404);
    assert.equal(res.body.errorCode, 'ERR_RESOURCE_NOT_FOUND');
    const config = await ctx.configFile();
    assert.equal(config.parsed?.state.metadata.length, 0);
  });
});

test('M-A12 缺少令牌 / Origin / 未授权项目：分别 403 与 404', async () => {
  await withHost(async (ctx) => {
    const noToken = await ctx.post('/api/metadata/set', { projectId: PROJ_A, path: 'a.md', alias: 'x' }, { token: false });
    assert.equal(noToken.status, 403);

    const noOrigin = await ctx.post('/api/metadata/set', { projectId: PROJ_A, path: 'a.md', alias: 'x' }, { origin: false });
    assert.equal(noOrigin.status, 403);

    const unknownProject = await ctx.set('project-zzz', 'a.md', { alias: 'x' });
    assert.ok(unknownProject.status === 404 || unknownProject.status === 403, String(unknownProject.status));
  });
});

test('M-A13 重启 Host 后元数据仍在，且树里仍然生效', async () => {
  await withHost(async (ctx) => {
    await ctx.set(PROJ_A, 'a.md', { alias: '重启后仍在', tags: ['持久'], color: 'orange' });
    const before = await ctx.configFile();
    assert.equal(before.raw.version, 5, '写入后配置升到 v5');

    await ctx.restart();

    const tree = await ctx.tree(PROJ_A);
    const node = entryOf(tree.body, 'a.md');
    assert.equal(node.meta.alias, '重启后仍在');
    assert.deepEqual(node.meta.tags, ['持久']);
    assert.equal(node.meta.color, 'orange');
  });
});

test('M-A14 从 v4 配置启动：只读兼容，写入后升到 v5 且保留旧字段', async () => {
  await withHost(
    async (ctx) => {
      const tree = await ctx.tree(PROJ_A);
      assert.equal(tree.status, 200);
      assert.equal(entryOf(tree.body, 'a.md').meta, undefined, 'v4 没有元数据，读取必须正常');

      const res = await ctx.set(PROJ_A, 'a.md', { alias: '升级后' });
      assert.equal(res.status, 200);

      const after = await ctx.configFile();
      assert.equal(after.raw.version, 5);
      assert.ok(after.parsed, 'v5 文件必须能通过自身校验和');
      assert.equal(after.parsed?.state.metadata.length, 1);
      assert.deepEqual(after.parsed?.state.trash, [], '旧字段原样保留');
      assert.deepEqual(after.parsed?.state.hidden, []);
    },
    { configVersion: 4 },
  );
});

test('M-A15 v1 配置（无校验和）也能读到元数据端点，写入后成为 v5', async () => {
  await withHost(
    async (ctx) => {
      const res = await ctx.set(PROJ_A, 'a.md', { alias: 'v1 升级' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const after = await ctx.configFile();
      assert.equal(after.raw.version, 5);
      assert.equal(after.parsed?.state.metadata[0]?.alias, 'v1 升级');
    },
    { configVersion: 1 },
  );
});

test('M-A16 校验和覆盖元数据：手改 alias 不更新校验和 → 整份配置被判损坏', async () => {
  await withHost(async (ctx) => {
    await ctx.set(PROJ_A, 'a.md', { alias: '原始' });
    const raw = await readFile(join(ctx.storeDir, 'workspace.json'), 'utf8');
    const tampered = raw.replace('"alias": "原始"', '"alias": "篡改"');
    assert.notEqual(tampered, raw);
    const parsed = parseConfig(tampered);
    assert.equal(parsed, undefined, '元数据参与校验和，手改必须被发现');
  });
});

/* ================================================================== */
/* B 组：资源身份                                                       */
/* ================================================================== */

test('M-B01 跨项目隔离：A 的 same.md 与 B 的 same.md 互不影响', async () => {
  await withHost(async (ctx) => {
    await ctx.set(PROJ_A, 'same.md', { alias: 'A 的同名文件', color: 'red' });
    const treeB = await ctx.tree(PROJ_B);
    assert.equal(entryOf(treeB.body, 'same.md').meta, undefined, 'B 不得看到 A 的标注');

    await ctx.set(PROJ_B, 'same.md', { alias: 'B 的同名文件', color: 'green' });
    const treeA = await ctx.tree(PROJ_A);
    assert.equal(entryOf(treeA.body, 'same.md').meta.alias, 'A 的同名文件');

    const listA = await ctx.list(PROJ_A);
    assert.deepEqual(
      listA.body.entries.map((item: any) => item.path),
      ['same.md'],
    );
  });
});

test('M-B02 同一项目不同目录的同名文件互不影响', async () => {
  await withHost(async (ctx) => {
    await ctx.set(PROJ_A, 'docs/guide.md', { alias: '指南' });
    const tree = await ctx.tree(PROJ_A);
    assert.equal(entryOf(tree.body, 'docs').meta, undefined, '父目录不该被染色');
    const docs = await ctx.tree(PROJ_A, 'docs');
    assert.equal(entryOf(docs.body, 'guide.md').meta.alias, '指南');
    assert.equal(entryOf(tree.body, 'a.md').meta, undefined);
  });
});

test('M-B03 文件夹也能标注，且不影响子项', async () => {
  await withHost(async (ctx) => {
    const res = await ctx.set(PROJ_A, 'docs', { alias: '文档', color: 'gray' });
    assert.equal(res.status, 200);
    const tree = await ctx.tree(PROJ_A);
    const docs = entryOf(tree.body, 'docs');
    assert.equal(docs.meta.alias, '文档');
    assert.equal(docs.meta.color, 'gray');

    const inner = await ctx.tree(PROJ_A, 'docs');
    assert.equal(entryOf(inner.body, 'guide.md').meta, undefined, '不继承目录标注');
  });
});

test('M-B04 真实改名后元数据跟随（旧路径不再显示）', async () => {
  await withHost(async (ctx) => {
    await ctx.set(PROJ_A, 'a.md', { alias: '原名标注', tags: ['迁移'], color: 'blue' });
    const res = await ctx.post('/api/files/rename', { projectId: PROJ_A, sourcePath: 'a.md', name: 'renamed.md' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.metadataMigration, 'moved');

    const tree = await ctx.tree(PROJ_A);
    assert.equal(entryOf(tree.body, 'renamed.md').meta.alias, '原名标注');
    assert.deepEqual(entryOf(tree.body, 'renamed.md').meta.tags, ['迁移']);
    assert.equal(existsSync(join(ctx.rootA, 'a.md')), false);

    const list = await ctx.list(PROJ_A);
    assert.deepEqual(list.body.entries.map((item: any) => item.path), ['renamed.md']);
  });
});

test('M-B05 真实移动到其他目录后元数据跟随', async () => {
  await withHost(async (ctx) => {
    await ctx.set(PROJ_A, 'b.md', { alias: '要搬走', color: 'yellow' });
    const res = await ctx.post('/api/files/move', {
      projectId: PROJ_A,
      sourcePath: 'b.md',
      targetParentDir: 'other',
      name: 'b.md',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.metadataMigration, 'moved');

    const other = await ctx.tree(PROJ_A, 'other');
    assert.equal(entryOf(other.body, 'b.md').meta.alias, '要搬走');
    const root = await ctx.tree(PROJ_A);
    assert.equal(entryOf(root.body, 'b.md'), undefined);
  });
});

test('M-B06 目录改名：子资源元数据按前缀迁移', async () => {
  await withHost(async (ctx) => {
    await ctx.set(PROJ_A, 'docs/guide.md', { alias: '指南' });
    await ctx.set(PROJ_A, 'docs/sub/deep.md', { alias: '深处' });
    await ctx.set(PROJ_A, 'docs', { alias: '文档目录' });

    const res = await ctx.post('/api/files/rename', { projectId: PROJ_A, sourcePath: 'docs', name: 'manual' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.metadataMigration, 'moved');

    const list = await ctx.list(PROJ_A);
    const byPath = new Map<string, any>(
      (list.body.entries as any[]).map((item): [string, any] => [item.path, item]),
    );
    assert.equal(byPath.get('manual')?.alias, '文档目录');
    assert.equal(byPath.get('manual/guide.md')?.alias, '指南');
    assert.equal(byPath.get('manual/sub/deep.md')?.alias, '深处');
    assert.equal(byPath.has('docs/guide.md'), false);
  });
});

test('M-B07 改名被拒绝（同名已存在）：元数据不动', async () => {
  await withHost(async (ctx) => {
    await ctx.set(PROJ_A, 'a.md', { alias: '不该丢' });
    const res = await ctx.post('/api/files/rename', { projectId: PROJ_A, sourcePath: 'a.md', name: 'b.md' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.metadataMigration, undefined);

    const list = await ctx.list(PROJ_A);
    assert.deepEqual(list.body.entries.map((item: any) => item.path), ['a.md']);
    const tree = await ctx.tree(PROJ_A);
    assert.equal(entryOf(tree.body, 'a.md').meta.alias, '不该丢');
  });
});

test('M-B08 原位置被外部换成新对象：旧标注不继承（rebound）', async () => {
  await withHost(async (ctx) => {
    await ctx.set(PROJ_A, 'a.md', { alias: '老对象', color: 'red' });
    // 外部删除后重建：路径相同，对象不同（新的 inode）
    await rm(join(ctx.rootA, 'a.md'));
    await writeFile(join(ctx.rootA, 'a.md'), '# 新内容\n', 'utf8');

    const tree = await ctx.tree(PROJ_A);
    const node = entryOf(tree.body, 'a.md');
    assert.equal(node.name, 'a.md');
    assert.equal(node.meta, undefined, '新对象不得继承旧标注');

    const list = await ctx.list(PROJ_A);
    assert.equal(list.body.entries[0].state, 'rebound', '记录本身保留，状态如实报告');
    assert.equal(list.body.entries[0].alias, '老对象');
  });
});

test('M-B09 文件被外部删除：记录保留但标为 missing，不再显示', async () => {
  await withHost(async (ctx) => {
    await ctx.set(PROJ_A, 'b.md', { alias: '会被删掉' });
    await rm(join(ctx.rootA, 'b.md'));
    const tree = await ctx.tree(PROJ_A);
    assert.equal(entryOf(tree.body, 'b.md'), undefined);
    const list = await ctx.list(PROJ_A);
    assert.equal(list.body.entries[0].state, 'missing');
  });
});

test('M-B10 项目根展示项：用项目身份标注，出现在 tree 的 projectMeta', async () => {
  await withHost(async (ctx) => {
    const res = await ctx.set(PROJ_A, '', { alias: '主项目', color: 'purple' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const root = await ctx.tree(PROJ_A);
    assert.equal(root.body.projectMeta.alias, '主项目');
    assert.equal(root.body.projectMeta.color, 'purple');

    // 子层不重复带 projectMeta
    const docs = await ctx.tree(PROJ_A, 'docs');
    assert.equal(docs.body.projectMeta, undefined);

    // 另一个项目不受影响
    const other = await ctx.tree(PROJ_B);
    assert.equal(other.body.projectMeta, undefined);
  });
});

test('M-B11 项目根标注不能借此改任何磁盘对象（文件集合与字节零变更）', async () => {
  await withHost(async (ctx) => {
    const beforeTree = await ctx.tree(PROJ_A);
    const beforeSha = await shaOfFile(join(ctx.rootA, 'a.md'));
    await ctx.set(PROJ_A, '', { alias: '主项目', color: 'blue' });
    const afterTree = await ctx.tree(PROJ_A);
    assert.deepEqual(
      afterTree.body.entries.map((item: any) => item.name),
      beforeTree.body.entries.map((item: any) => item.name),
    );
    assert.equal(await shaOfFile(join(ctx.rootA, 'a.md')), beforeSha);
    assert.equal(existsSync(join(ctx.rootA, 'docs', 'guide.md')), true);
  });
});

/* ================================================================== */
/* C 组：回收区兼容                                                     */
/* ================================================================== */

test('M-C01 回收后标注不丢；同名新文件不继承；恢复后重新生效', async () => {
  await withHost(async (ctx) => {
    await ctx.set(PROJ_A, 'a.md', { alias: '要回收', tags: ['重要'], color: 'green' });
    const payloadSha = await shaOfFile(join(ctx.rootA, 'a.md'));

    const trashed = await ctx.post('/api/trash/entry', {
      projectId: PROJ_A,
      path: 'a.md',
      opId: 'op-metadata-0001',
    });
    assert.equal(trashed.status, 200, JSON.stringify(trashed.body));

    // 记录仍在配置里（回收不丢元数据）
    let config = await ctx.configFile();
    assert.equal(config.parsed?.state.metadata.length, 1, '标注不得随回收消失');
    assert.equal(config.parsed?.state.metadata[0]?.alias, '要回收');

    // 树里已经没有这个条目；同名新文件不继承
    await writeFile(join(ctx.rootA, 'a.md'), '# 全新文件\n', 'utf8');
    const tree = await ctx.tree(PROJ_A);
    assert.equal(entryOf(tree.body, 'a.md').meta, undefined, '同名新文件不得继承');
    const list = await ctx.list(PROJ_A);
    assert.equal(list.body.entries[0].state, 'rebound');

    // 把新文件删掉，恢复原文件 → 标注重新生效
    await rm(join(ctx.rootA, 'a.md'));
    const restored = await ctx.post('/api/trash/restore', {
      projectId: PROJ_A,
      opId: 'op-metadata-0001',
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(await shaOfFile(join(ctx.rootA, 'a.md')), payloadSha, '恢复的是同一份内容');

    const afterRestore = await ctx.tree(PROJ_A);
    assert.equal(entryOf(afterRestore.body, 'a.md').meta.alias, '要回收');
    assert.deepEqual(entryOf(afterRestore.body, 'a.md').meta.tags, ['重要']);

    config = await ctx.configFile();
    assert.equal(config.parsed?.state.metadata.length, 1);
  });
});

test('M-C02 回收失败（目录）不产生任何元数据变更', async () => {
  await withHost(async (ctx) => {
    await ctx.set(PROJ_A, 'docs', { alias: '文档目录' });
    const before = await ctx.configFile();
    const seq = before.parsed?.state.commitSeq;

    const res = await ctx.post('/api/trash/entry', {
      projectId: PROJ_A,
      path: 'docs',
      opId: 'op-metadata-0002',
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_TRASH_KIND_UNSUPPORTED');

    const after = await ctx.configFile();
    assert.equal(after.parsed?.state.commitSeq, seq, '失败的回收不得改配置');
    assert.equal(after.parsed?.state.metadata.length, 1);
  });
});

test('M-C03 清除整条记录：文件不存在时也能清（不留孤儿）', async () => {
  await withHost(async (ctx) => {
    await ctx.set(PROJ_A, 'a.md', { alias: '将被清掉' });
    await rm(join(ctx.rootA, 'a.md'));

    const res = await ctx.clear(PROJ_A, 'a.md');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.changed, true);

    const config = await ctx.configFile();
    assert.equal(config.parsed?.state.metadata.length, 0);

    const again = await ctx.clear(PROJ_A, 'a.md');
    assert.equal(again.status, 200);
    assert.equal(again.body.changed, false, '重复清除是幂等的');
  });
});

/* ================================================================== */
/* D 组：纯函数边界（不启 Host）                                        */
/* ================================================================== */

test('M-D01 normalizeTags：保持顺序、大小写不敏感去重、丢弃空白项', () => {
  const result = normalizeTags(['b', ' A ', 'a', '', 'B', 'C']);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.tags, ['b', 'A', 'C']);
});

test('M-D02 配置序列化往返：v5 元数据字段顺序稳定、校验和可复算', () => {
  const text = serializeConfig({
    version: 5,
    commitSeq: 3,
    issuedIds: [PROJ_A],
    revoked: [],
    projects: [
      { projectId: PROJ_A, name: 'A', rootDir: 'C:\\ws-a', rootToken: 'root-1' },
    ],
    hidden: [],
    trash: [],
    metadata: [
      {
        projectId: PROJ_A,
        path: 'a.md',
        rootToken: 'root-1',
        identity: 'dev:1:2',
        alias: '标注',
        tags: ['重要'],
        color: 'blue',
        updatedAt: '2026-11-27T00:00:00.000Z',
      },
    ],
  });
  const parsed = parseConfig(text);
  assert.ok(parsed, '自洽的 v5 配置必须能解析');
  assert.equal(parsed?.state.metadata[0]?.alias, '标注');
  assert.equal(parsed?.state.metadata[0]?.color, 'blue');
  // 再序列化一次必须逐字节一致（确定性）
  assert.equal(serializeConfig(parsed!.state), text);
});

test('M-D03 配置里出现空壳元数据（三字段全空）即判损坏', () => {
  const text = serializeConfig({
    version: 5,
    commitSeq: 1,
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
        tags: [],
        updatedAt: '2026-11-27T00:00:00.000Z',
      } as never,
    ],
  });
  assert.equal(parseConfig(text), undefined);
});
