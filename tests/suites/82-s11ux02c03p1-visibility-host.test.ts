/**
 * UX-02C-03-P1：从文件树隐藏 / 取消隐藏（Host 侧）与隐藏记录持久化。
 *
 * 取证方式：真实 `FileProjectStore`（托管 Multi）+ 真实 LocalProvider + 真实临时磁盘；
 * 断言同时看「HTTP 状态 + 响应体 + 磁盘字节/SHA-256 + 工作区配置版本 + 重启后的树」。
 *
 * 关键纪律（本套件就是在钉这些）：
 * - 隐藏只改工作台配置，**磁盘内容与结构零变更**（逐字节 SHA 比对）；
 * - 隐藏记录绝不改变 `workspaceKey` 派生（`/api/health` 前后一致）；
 * - 同一路径重复隐藏是幂等操作（不重复写配置、不涨 commitSeq）；
 * - 不存在 / 越界 / 未授权的路径不得被登记；
 * - 配置写入失败必须如实报错，且内存里的隐藏集合不得"看起来成功"。
 *
 * 先红后绿：实现前这两个端点返回 501、`ConfigState` 也没有隐藏集合，因此
 * P1-01a…P1-01n 全红；实现后转绿（见 docs/evidence/ux-02c-03-p1/green/test-log.txt）。
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { parseConfig, serializeConfig } from '../../apps/server/src/store/config.ts';
import { createFileProjectStore, type StoreIo } from '../../apps/server/src/store/index.ts';
import { createNodeStoreIo } from '../../apps/server/src/store/io.ts';
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
  token: string;
  api(path: string, init?: RequestInit): Promise<ApiResponse>;
  post(path: string, body: unknown, opts?: { token?: boolean; origin?: boolean }): Promise<ApiResponse>;
  get(path: string, opts?: { token?: boolean }): Promise<ApiResponse>;
  hide(projectId: string, path: string, opts?: { token?: boolean; origin?: boolean }): Promise<ApiResponse>;
  unhide(projectId: string, path: string, opts?: { token?: boolean; origin?: boolean }): Promise<ApiResponse>;
  hidden(projectId: string): Promise<ApiResponse>;
  tree(projectId: string, dir?: string, includeHidden?: boolean): Promise<ApiResponse>;
  /** 读磁盘上的工作区配置（原始 JSON + 解析结果）。 */
  configFile(): Promise<{ raw: any; parsed: ReturnType<typeof parseConfig> }>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

interface Options {
  /** 用 v1 配置启动（没有 commitSeq / issuedIds / checksum）。 */
  configVersion?: 1 | 2;
}

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function withHost(fn: (ctx: Ctx) => Promise<void>, options: Options = {}): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-p1-'));
  const storeDir = join(base, 'store');
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(storeDir, { recursive: true });
  await mkdir(join(rootA, 'docs', 'sub'), { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');
  await writeFile(join(rootA, 'b.md'), '# B\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'guide.md'), '# guide\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'sub', 'deep.md'), '# deep\n', 'utf8');
  await writeFile(join(rootB, 'other.md'), '# other\n', 'utf8');

  const entry = (projectId: string, name: string, rootDir: string) => ({
    projectId,
    name,
    rootDir,
    canonicalRoot: realpathSync(rootDir),
    rootToken: rootTokenOf(rootDir),
    grantedAt: '2026-11-18T00:00:00.000Z',
    grantSource: 'os-dialog',
  });

  const version = options.configVersion ?? 2;
  const file =
    version === 1
      ? { version: 1 as const, projects: [entry(PROJ_A, '项目 A', rootA), entry(PROJ_B, '项目 B', rootB)] }
      : serializeConfig({
          version: 2,
          commitSeq: 0,
          issuedIds: [PROJ_A, PROJ_B],
          revoked: [],
          projects: [entry(PROJ_A, '项目 A', rootA), entry(PROJ_B, '项目 B', rootB)],
        });
  await writeFile(
    join(storeDir, 'workspace.json'),
    typeof file === 'string' ? file : JSON.stringify(file),
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
    api,
    post,
    get,
    hide: (projectId, path, opts) => post('/api/workspace/hide', { projectId, path }, opts),
    unhide: (projectId, path, opts) => post('/api/workspace/unhide', { projectId, path }, opts),
    hidden: (projectId) => get(`/api/workspace/hidden?projectId=${encodeURIComponent(projectId)}`),
    tree: (projectId, dir = '', includeHidden = false) =>
      get(
        `/api/tree?projectId=${encodeURIComponent(projectId)}${dir ? `&dir=${encodeURIComponent(dir)}` : ''}${
          includeHidden ? '&includeHidden=1' : ''
        }`,
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

function names(body: any): string[] {
  return ((body?.entries ?? []) as { name: string }[]).map((entry) => entry.name);
}

function entryOf(body: any, name: string): any {
  return ((body?.entries ?? []) as any[]).find((entry) => entry.name === name);
}

/* ------------------------------------------------------------------ */
/* P1-01a 单文件：隐藏只改视图，磁盘字节零变更                          */
/* ------------------------------------------------------------------ */

test('P1-01a 隐藏单个文件：默认树不再显示，磁盘内容与目录结构零变更', async () => {
  await withHost(async (h) => {
    const before = await readFile(join(h.rootA, 'a.md'), 'utf8');
    const beforeTree = await h.tree(PROJ_A);
    assert.equal(beforeTree.status, 200, JSON.stringify(beforeTree.body));
    assert.ok(names(beforeTree.body).includes('a.md'));

    const res = await h.hide(PROJ_A, 'a.md');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'APPLIED');
    assert.equal(res.body.hidden, true);
    assert.equal(res.body.changed, true, '首次隐藏必须报告 changed=true');
    assert.equal(res.body.path, 'a.md');

    // 磁盘：内容、mtime 之外的一切都没变；文件仍在
    assert.equal(existsSync(join(h.rootA, 'a.md')), true, '隐藏绝不允许删除磁盘文件');
    assert.equal(await readFile(join(h.rootA, 'a.md'), 'utf8'), before);
    assert.equal(sha(await readFile(join(h.rootA, 'a.md'), 'utf8')), sha(before));

    // 默认树：不再出现
    const afterTree = await h.tree(PROJ_A);
    assert.equal(afterTree.status, 200);
    assert.deepEqual(names(afterTree.body), ['docs', 'b.md'], '默认视图只剩未隐藏的条目');
    assert.equal(afterTree.body.page.hiddenCount, 1, '默认视图必须报告本层隐藏条目数');

    // 显示隐藏项：回来，并带明显标记
    const shown = await h.tree(PROJ_A, '', true);
    const a = entryOf(shown.body, 'a.md');
    assert.ok(a, '显示隐藏项后该文件必须回到树里');
    assert.equal(a.hidden, true, '隐藏项必须带 hidden 标记，不能和普通条目长得一模一样');
    assert.equal(a.relPath, 'a.md');
  });
});

/* ------------------------------------------------------------------ */
/* P1-01b 幂等                                                         */
/* ------------------------------------------------------------------ */

test('P1-01b 同一路径重复隐藏是幂等的：不重复写配置、不涨 commitSeq', async () => {
  await withHost(async (h) => {
    const first = await h.hide(PROJ_A, 'a.md');
    assert.equal(first.status, 200);
    const afterFirst = await h.configFile();
    const seqAfterFirst = afterFirst.raw.commitSeq;
    const recordsAfterFirst = afterFirst.raw.hidden.length;

    const second = await h.hide(PROJ_A, 'a.md');
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.changed, false, '重复隐藏必须明确报告"没有变化"');
    const afterSecond = await h.configFile();
    assert.equal(afterSecond.raw.commitSeq, seqAfterFirst, '幂等操作不得推进事务序号');
    assert.equal(afterSecond.raw.hidden.length, recordsAfterFirst, '不得产生第二条重复记录');
  });
});

/* ------------------------------------------------------------------ */
/* P1-01c 取消隐藏                                                     */
/* ------------------------------------------------------------------ */

test('P1-01c 取消隐藏恢复显示；对未隐藏的路径取消隐藏同样是幂等 no-op', async () => {
  await withHost(async (h) => {
    assert.equal((await h.hide(PROJ_A, 'a.md')).status, 200);
    assert.ok(!names((await h.tree(PROJ_A)).body).includes('a.md'));

    const back = await h.unhide(PROJ_A, 'a.md');
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.hidden, false);
    assert.equal(back.body.changed, true);
    assert.ok(names((await h.tree(PROJ_A)).body).includes('a.md'), '取消隐藏后必须恢复正常显示');

    const again = await h.unhide(PROJ_A, 'a.md');
    assert.equal(again.status, 200);
    assert.equal(again.body.changed, false, '取消一个本来没隐藏的路径：明确 no-op，而不是报错');

    const query = await h.hidden(PROJ_A);
    assert.equal(query.status, 200);
    assert.deepEqual(query.body.entries, []);
  });
});

/* ------------------------------------------------------------------ */
/* P1-01d 目录隐藏：子孙从默认视图消失，但读取能力与内容不变             */
/* ------------------------------------------------------------------ */

test('P1-01d 隐藏目录：整棵子树从默认视图消失，子层读取与磁盘内容不变', async () => {
  await withHost(async (h) => {
    const guideBefore = await readFile(join(h.rootA, 'docs', 'guide.md'), 'utf8');
    const res = await h.hide(PROJ_A, 'docs');
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const root = await h.tree(PROJ_A);
    assert.deepEqual(names(root.body), ['a.md', 'b.md'], '默认视图不再显示被隐藏的目录');

    // 隐藏不是封锁：已展开/已打开的路径仍然可读（标签与草稿不受影响）
    const child = await h.tree(PROJ_A, 'docs', true);
    assert.equal(child.status, 200, JSON.stringify(child.body));
    assert.deepEqual(names(child.body), ['sub', 'guide.md']);
    assert.equal(child.body.entries[0].hiddenBy, 'docs', '子孙必须标明"被上级隐藏"，而不是被当成自身隐藏');

    // 默认视图下请求被隐藏的子层：子条目同样不显示
    const childDefault = await h.tree(PROJ_A, 'docs', false);
    assert.equal(childDefault.status, 200);
    assert.deepEqual(names(childDefault.body), [], '上级被隐藏时，默认视图不显示其子条目');

    assert.equal(await readFile(join(h.rootA, 'docs', 'guide.md'), 'utf8'), guideBefore);
    assert.equal(existsSync(join(h.rootA, 'docs', 'sub', 'deep.md')), true);
  });
});

/* ------------------------------------------------------------------ */
/* P1-01e 父子隐藏状态独立                                             */
/* ------------------------------------------------------------------ */

test('P1-01e 父目录与子文件的隐藏记录互相独立：取消父目录不会顺手清掉子记录', async () => {
  await withHost(async (h) => {
    assert.equal((await h.hide(PROJ_A, 'docs/sub')).status, 200);
    assert.equal((await h.hide(PROJ_A, 'docs')).status, 200);

    // 取消父目录：docs 回来，docs/sub 仍然是隐藏的
    assert.equal((await h.unhide(PROJ_A, 'docs')).status, 200);
    const shown = await h.tree(PROJ_A, 'docs', true);
    const sub = entryOf(shown.body, 'sub');
    assert.ok(sub);
    assert.equal(sub.hidden, true, 'docs/sub 自身的隐藏记录必须仍然生效');

    const defaultView = await h.tree(PROJ_A, 'docs', false);
    assert.deepEqual(names(defaultView.body), ['guide.md'], '默认视图里 docs/sub 仍然不可见');

    const query = await h.hidden(PROJ_A);
    assert.deepEqual(
      query.body.entries.map((item: { path: string }) => item.path),
      ['docs/sub'],
      '取消父目录只能删掉父目录那一条记录',
    );
  });
});

/* ------------------------------------------------------------------ */
/* P1-01f 项目隔离                                                     */
/* ------------------------------------------------------------------ */

test('P1-01f 项目隔离：A 项目的隐藏记录不影响 B 项目，记录按 projectId 作用域', async () => {
  await withHost(async (h) => {
    assert.equal((await h.hide(PROJ_A, 'a.md')).status, 200);
    const treeB = await h.tree(PROJ_B);
    assert.equal(treeB.status, 200);
    assert.deepEqual(names(treeB.body), ['other.md'], 'B 项目不受 A 项目隐藏影响');
    assert.equal(treeB.body.page.hiddenCount, 0);

    const queryB = await h.hidden(PROJ_B);
    assert.deepEqual(queryB.body.entries, [], 'B 项目没有任何隐藏记录');

    // 同名路径在 B 项目里照样可见
    await writeFile(join(h.rootB, 'a.md'), '# B a\n', 'utf8');
    const treeB2 = await h.tree(PROJ_B);
    assert.ok(names(treeB2.body).includes('a.md'), '同名路径的隐藏记录不得跨项目生效');
  });
});

/* ------------------------------------------------------------------ */
/* P1-01g 越界 / 非法 / 根路径 → 零登记                                 */
/* ------------------------------------------------------------------ */

test('P1-01g 越界与非法路径一律拒绝，且不留下任何隐藏记录', async () => {
  await withHost(async (h) => {
    const bad: [string, number][] = [
      ['', 400],
      ['../outside.md', 400],
      ['docs/../../outside.md', 400],
      ['docs\\guide.md', 400],
      ['C:/Windows/win.ini', 400],
      ['/etc/passwd', 400],
      ['docs//guide.md', 400],
    ];
    for (const [path, expected] of bad) {
      const res = await h.hide(PROJ_A, path);
      assert.equal(res.status, expected, `路径 ${JSON.stringify(path)} 必须被拒绝: ${JSON.stringify(res.body)}`);
      assert.notEqual(res.body?.status, 'APPLIED');
    }
    const query = await h.hidden(PROJ_A);
    assert.deepEqual(query.body.entries, [], '被拒绝的路径绝不能登记成隐藏记录');
  });
});

/* ------------------------------------------------------------------ */
/* P1-01h 不存在的路径 / 不存在的项目                                   */
/* ------------------------------------------------------------------ */

test('P1-01h 不存在或不属于该项目的路径不得登记', async () => {
  await withHost(async (h) => {
    const ghost = await h.hide(PROJ_A, 'ghost.md');
    assert.equal(ghost.status, 404, JSON.stringify(ghost.body));
    assert.notEqual(ghost.body?.status, 'APPLIED');

    // 另一个项目里存在的路径，在 A 项目里不存在 → 404，且两边的记录都不受影响
    const cross = await h.hide(PROJ_A, 'other.md');
    assert.equal(cross.status, 404, JSON.stringify(cross.body));
    assert.deepEqual((await h.hidden(PROJ_A)).body.entries, []);
    assert.deepEqual((await h.hidden(PROJ_B)).body.entries, []);

    const unknownProject = await h.hide('project-ghost', 'a.md');
    assert.equal(unknownProject.status, 404, JSON.stringify(unknownProject.body));
  });
});

/* ------------------------------------------------------------------ */
/* P1-01i 令牌 / Origin 门禁                                            */
/* ------------------------------------------------------------------ */

test('P1-01i 隐藏与取消隐藏都必须通过 T1 令牌与显式 Origin', async () => {
  await withHost(async (h) => {
    const noToken = await h.hide(PROJ_A, 'a.md', { token: false });
    assert.equal(noToken.status, 403);
    const noOrigin = await h.hide(PROJ_A, 'a.md', { origin: false });
    assert.equal(noOrigin.status, 403);
    assert.deepEqual((await h.hidden(PROJ_A)).body.entries, []);

    assert.equal((await h.hide(PROJ_A, 'a.md')).status, 200);
    assert.equal((await h.unhide(PROJ_A, 'a.md', { token: false })).status, 403);
    const stillHidden = await h.tree(PROJ_A);
    assert.ok(!names(stillHidden.body).includes('a.md'), '被拒绝的取消隐藏不得生效');
  });
});

/* ------------------------------------------------------------------ */
/* P1-01j 重启保持                                                     */
/* ------------------------------------------------------------------ */

test('P1-01j 重启后隐藏状态仍然有效（配置 v4 + 校验和自洽）', async () => {
  await withHost(async (h) => {
    assert.equal((await h.hide(PROJ_A, 'a.md')).status, 200);
    assert.equal((await h.hide(PROJ_A, 'docs')).status, 200);
    const { raw, parsed } = await h.configFile();
    assert.equal(raw.version, 4, '发生变更后必须写成当前版本 v4');
    assert.ok(parsed, 'checksum 必须可复算，否则下次启动会整份配置不可用');
    assert.equal(parsed?.state.hidden.length, 2);

    await h.restart();
    const tree = await h.tree(PROJ_A);
    assert.equal(tree.status, 200);
    assert.deepEqual(names(tree.body), ['b.md'], '重启后隐藏状态必须保持');

    const query = await h.hidden(PROJ_A);
    assert.deepEqual(query.body.entries.map((item: { path: string }) => item.path).sort(), ['a.md', 'docs']);
    assert.ok(query.body.entries.every((item: { state: string }) => item.state === 'active'));
  });
});

/* ------------------------------------------------------------------ */
/* P1-01k v2 → v4 迁移                                                 */
/* ------------------------------------------------------------------ */

test('P1-01k v2 配置可以直接使用；发生变更时升级到 v4 且保留原有项目表', async () => {
  await withHost(async (h) => {
    const initial = await h.configFile();
    assert.equal(initial.raw.version, 2, '夹具是 v2');
    assert.equal((await h.tree(PROJ_A)).status, 200, 'v2 配置必须仍然可用（只读兼容）');

    assert.equal((await h.hide(PROJ_A, 'a.md')).status, 200);
    const { raw, parsed } = await h.configFile();
    assert.equal(raw.version, 4);
    assert.equal(raw.projects.length, 2, '迁移不得丢项目');
    assert.deepEqual(raw.issuedIds.slice().sort(), [PROJ_A, PROJ_B]);
    assert.equal(raw.hidden.length, 1);
    assert.ok(parsed, 'v4 校验和必须自洽');
    assert.equal(parsed?.state.projects.length, 2);
  });
});

test('P1-01k2 v1 配置同样可用：升级后仍能隐藏，写回 v4', async () => {
  await withHost(
    async (h) => {
      assert.equal((await h.tree(PROJ_A)).status, 200);
      assert.equal((await h.hide(PROJ_A, 'b.md')).status, 200);
      const { raw, parsed } = await h.configFile();
      assert.equal(raw.version, 4);
      assert.ok(parsed, 'v1 → v4 后的校验和必须自洽');
      assert.deepEqual(parsed?.state.hidden.map((item) => item.path), ['b.md']);
    },
    { configVersion: 1 },
  );
});

/* ------------------------------------------------------------------ */
/* P1-01l workspaceKey 不变                                            */
/* ------------------------------------------------------------------ */

test('P1-01l 隐藏不改变 workspaceKey：恢复记录不会因此失配', async () => {
  await withHost(async (h) => {
    const keyOf = async (): Promise<string | null> => {
      const res = await h.api('/api/health');
      return (res.body as { workspaceKey?: string }).workspaceKey ?? null;
    };
    const before = await keyOf();
    assert.ok(before);

    assert.equal((await h.hide(PROJ_A, 'a.md')).status, 200);
    assert.equal(await keyOf(), before, '隐藏是工作台视图状态，绝不能进入摘要派生');
    assert.equal((await h.hide(PROJ_A, 'docs')).status, 200);
    assert.equal(await keyOf(), before);

    await h.restart();
    assert.equal(await keyOf(), before, '重启后摘要仍然一致');
  });
});

/* ------------------------------------------------------------------ */
/* P1-01m 路径失效（外部删除 / 外部重建）                               */
/* ------------------------------------------------------------------ */

test('P1-01m 隐藏记录遇到"路径被重新使用"时不得错误隐藏新对象', async () => {
  await withHost(async (h) => {
    assert.equal((await h.hide(PROJ_A, 'a.md')).status, 200);
    // 外部删除后重建同名文件：这是一个全新的对象
    await unlink(join(h.rootA, 'a.md'));
    await writeFile(join(h.rootA, 'a.md'), '# A replaced\n', 'utf8');

    const query = await h.hidden(PROJ_A);
    const record = query.body.entries.find((item: { path: string }) => item.path === 'a.md');
    assert.ok(record, '记录本身保留（不擅自删记录）');
    assert.equal(record.state, 'rebound', '身份不一致必须明确报告 rebound');

    const tree = await h.tree(PROJ_A);
    assert.ok(
      names(tree.body).includes('a.md'),
      '新对象不得被旧隐藏记录吞掉：必须先核对身份才允许隐藏',
    );

    // 取消隐藏可以照常清理这条失效记录
    const cleanup = await h.unhide(PROJ_A, 'a.md');
    assert.equal(cleanup.status, 200);
    assert.deepEqual((await h.hidden(PROJ_A)).body.entries, []);
  });
});

test('P1-01m2 隐藏的文件被外部删除：记录标记 missing，不影响其它条目', async () => {
  await withHost(async (h) => {
    assert.equal((await h.hide(PROJ_A, 'b.md')).status, 200);
    await unlink(join(h.rootA, 'b.md'));

    const query = await h.hidden(PROJ_A);
    assert.equal(query.body.entries[0].state, 'missing');
    const tree = await h.tree(PROJ_A);
    assert.equal(tree.status, 200);
    assert.deepEqual(names(tree.body), ['docs', 'a.md']);
  });
});

/* ------------------------------------------------------------------ */
/* P1-01n Windows 大小写差异                                           */
/* ------------------------------------------------------------------ */

test('P1-01n 隐藏后按大小写不敏感匹配（Windows 语义），且只保留一条记录', async () => {
  await withHost(async (h) => {
    await writeFile(join(h.rootA, 'Case.md'), '# case\n', 'utf8');
    assert.equal((await h.hide(PROJ_A, 'Case.md')).status, 200);

    // 磁盘上真实名字是 Case.md；这里用不同大小写再隐藏一次，不得产生第二条记录
    const second = await h.hide(PROJ_A, 'case.md');
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const { raw } = await h.configFile();
    assert.equal(raw.hidden.length, 1, '同一路径的不同大小写只能算一条记录');
    assert.equal(second.body.changed, false);

    assert.ok(!names((await h.tree(PROJ_A)).body).includes('Case.md'));
  });
});

/* ------------------------------------------------------------------ */
/* P1-01o 配置写入失败必须如实报告                                     */
/* ------------------------------------------------------------------ */

test('P1-01o 配置写入失败：抛出持久化错误，内存隐藏集合不得"看起来成功"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-p1-store-'));
  try {
    const real = createNodeStoreIo();
    let failRename = false;
    const io: StoreIo = {
      ...real,
      rename(from, to) {
        if (failRename) throw new Error('rename 失败（测试注入）');
        real.rename(from, to);
      },
    };
    const store = createFileProjectStore({ dir, io });
    try {
      await store.commitAdd({
        projectId: PROJ_A,
        name: '项目 A',
        rootDir: realpathSync(dir),
        canonicalRoot: realpathSync(dir),
        rootToken: rootTokenOf(dir),
        grantedAt: '2026-11-18T00:00:00.000Z',
        grantSource: 'os-dialog',
        opId: 'op-add-a',
      });

      failRename = true;
      await assert.rejects(
        () =>
          store.commitHidden({
            projectId: PROJ_A,
            path: 'a.md',
            rootToken: rootTokenOf(dir),
            identity: '1:1',
            hidden: true,
          }),
        (err: { errorCode?: string }) => err.errorCode === 'ERR_PERSIST_FAILED',
        '配置写入失败必须是明确的持久化错误',
      );
      assert.deepEqual(store.hiddenOf(PROJ_A), [], '写盘失败后内存集合不得出现这条记录');
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
