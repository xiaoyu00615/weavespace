/**
 * UX-02C-03-P1：隐藏对**分页/快照**的影响，以及树级别的可见性语义。
 *
 * 与套件 82 的分工：82 证明"隐藏记录与 API 语义"，本套件证明"过滤发生在分页之前"——
 * 否则用户会看到 `total` 与真实可见条数不符，或者翻到一页全是隐藏项的空页。
 *
 * 关键不变量：
 * - 过滤必须发生在 `buildTreePage` 之前，`total / nextCursor / snapshot` 三者一致；
 * - 隐藏集合变化 → 该层快照变化 → 旧游标续页必须 409（ERR_DIR_CHANGED），
 *   不能让客户端把"少了一页"当成"读完了"；
 * - `hiddenCount` 在 includeHidden=0 时仍然给出，界面才有"此目录有 N 个隐藏项"的入口；
 * - 项目根自身不是可隐藏对象（隐藏一个项目根的语义是"移除项目"，不是 P1 的范围）。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { serializeConfig } from '../../apps/server/src/store/config.ts';
import { rootTokenOf } from '../../packages/storage/path-safety.ts';

const PROJ = 'project-a';

interface ApiResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  status: number;
}

interface Ctx {
  base: string;
  root: string;
  server: ShellServer;
  token: string;
  get(path: string): Promise<ApiResponse>;
  post(path: string, body: unknown): Promise<ApiResponse>;
  tree(query: Record<string, string | number | boolean | undefined>): Promise<ApiResponse>;
  close(): Promise<void>;
}

/** 造 30 个文件 + 1 个链接，便于用 limit 做多页。 */
async function withTreeHost(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-p1-tree-'));
  const root = join(base, 'project-a');
  const storeDir = join(base, 'store');
  await mkdir(root, { recursive: true });
  await mkdir(storeDir, { recursive: true });
  for (let i = 0; i < 30; i += 1) {
    await writeFile(join(root, `f${String(i).padStart(2, '0')}.md`), `# ${i}\n`, 'utf8');
  }
  await mkdir(join(root, 'nested'), { recursive: true });
  await writeFile(join(root, 'nested', 'inner.md'), '# inner\n', 'utf8');
  await symlink(join(root, 'nested'), join(root, 'linked'), 'junction').catch(() => undefined);

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
  const api = async (path: string, init?: RequestInit): Promise<ApiResponse> => {
    const res = await fetch(`${server.url}${path}`, init);
    const text = await res.text();
    return { status: res.status, body: text === '' ? null : JSON.parse(text) };
  };
  const token = ((await api('/api/session-token')).body as { token?: string }).token ?? '';
  const get = (path: string): Promise<ApiResponse> =>
    api(path, { headers: { 'x-ws-token': token } });
  const post = (path: string, body: unknown): Promise<ApiResponse> =>
    api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ws-token': token, origin: server.url },
      body: JSON.stringify(body),
    });
  const tree = (query: Record<string, string | number | boolean | undefined>): Promise<ApiResponse> => {
    const params = new URLSearchParams({ projectId: PROJ });
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === false) continue;
      params.set(key, value === true ? '1' : String(value));
    }
    return get(`/api/tree?${params.toString()}`);
  };

  try {
    await fn({
      base,
      root,
      server,
      token,
      get,
      post,
      tree,
      close: () => server.close(),
    });
  } finally {
    await server.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

test('P1-02a 过滤先于分页：total / nextCursor 与可见条数一致，不会翻到"全隐藏"的空页', async () => {
  await withTreeHost(async (h) => {
    const first = await h.tree({ limit: 10 });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const totalBefore = first.body.page.total as number;
    assert.ok(totalBefore >= 32, `夹具应有多于 32 个条目，实际 ${totalBefore}`);

    // 隐藏第 2 页的第一条（按服务端排序：目录/链接在前，其余按名称）
    const second = await h.tree({ limit: 10, cursor: first.body.page.nextCursor });
    assert.equal(second.status, 200);
    const victim = second.body.entries[0].relPath as string;
    assert.equal((await h.post('/api/workspace/hide', { projectId: PROJ, path: victim })).status, 200);

    const after = await h.tree({ limit: 10 });
    assert.equal(after.body.page.total, totalBefore - 1, '可见总数必须只减少隐藏的那一条');
    assert.equal(after.body.page.hiddenCount, 1);

    // 用旧游标续页：集合已经变了，必须显式失败而不是漏项
    const stale = await h.tree({ limit: 10, cursor: first.body.page.nextCursor, snapshot: first.body.page.snapshot });
    assert.equal(stale.status, 409, '隐藏改变了该层集合，旧游标续页必须 409');
    assert.equal(stale.body.errorCode, 'ERR_DIR_CHANGED');
  });
});

test('P1-02b 逐页遍历不会因为隐藏而漏项或重复', async () => {
  await withTreeHost(async (h) => {
    for (const path of ['f03.md', 'f10.md', 'nested']) {
      assert.equal((await h.post('/api/workspace/hide', { projectId: PROJ, path })).status, 200);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let snapshot: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await h.tree({
        limit: 7,
        ...(cursor ? { cursor } : {}),
        ...(snapshot ? { snapshot } : {}),
      });
      assert.equal(page.status, 200, JSON.stringify(page.body));
      for (const entry of page.body.entries as { relPath: string }[]) seen.push(entry.relPath);
      snapshot = page.body.page.snapshot;
      cursor = page.body.page.nextCursor;
      if (cursor === null) break;
    }
    assert.equal(new Set(seen).size, seen.length, '不得重复');
    assert.ok(!seen.includes('f03.md') && !seen.includes('f10.md') && !seen.includes('nested'));
    assert.equal(seen.length, (await h.tree({})).body.page.total);
  });
});

test('P1-02c includeHidden=1 时隐藏项回来，hiddenCount 仍然表示隐藏条数', async () => {
  await withTreeHost(async (h) => {
    assert.equal((await h.post('/api/workspace/hide', { projectId: PROJ, path: 'f01.md' })).status, 200);
    const shown = await h.tree({ includeHidden: true });
    assert.equal(shown.status, 200);
    const hidden = (shown.body.entries as { relPath: string; hidden?: boolean }[]).find(
      (entry) => entry.relPath === 'f01.md',
    );
    assert.ok(hidden);
    assert.equal(hidden?.hidden, true);
    assert.equal(shown.body.page.hiddenCount, 1, '显示隐藏项不等于"隐藏记录消失"');
  });
});

test('P1-02d 链接节点不支持隐藏：与"打不开链接"同一条边界（路径经过重解析点）', async () => {
  await withTreeHost(async (h) => {
    const root = await h.tree({});
    const link = (root.body.entries as { kind: string; relPath: string }[]).find(
      (entry) => entry.kind === 'link',
    );
    if (!link) return; // 无符号链接权限（非管理员）时跳过：不伪造"已验证"
    const res = await h.post('/api/workspace/hide', { projectId: PROJ, path: link.relPath });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_PATH_OUTSIDE_ROOT');
    const query = await h.get(`/api/workspace/hidden?projectId=${PROJ}`);
    assert.deepEqual(query.body.entries, [], '被拒绝的链接不得留下记录');
    const after = await h.tree({});
    assert.ok((after.body.entries as { relPath: string }[]).some((entry) => entry.relPath === link.relPath));
  });
});

test('P1-02e 项目根自身不可隐藏（那是"移除项目"的语义，属于另一个能力）', async () => {
  await withTreeHost(async (h) => {
    const res = await h.post('/api/workspace/hide', { projectId: PROJ, path: '' });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.notEqual(res.body?.status, 'APPLIED');
    const query = await h.get(`/api/workspace/hidden?projectId=${PROJ}`);
    assert.deepEqual(query.body.entries, []);
  });
});

test('P1-02f 隐藏记录查询需要令牌与合法项目', async () => {
  await withTreeHost(async (h) => {
    const noToken = await h.get(`/api/tree?projectId=${PROJ}`);
    assert.equal(noToken.status, 200, '/api/tree 本来就是只读端点，不要求令牌');

    const hiddenNoToken = await fetch(`${h.server.url}/api/workspace/hidden?projectId=${PROJ}`);
    // 该端点只返回路径列表（不含正文），仍按"工作台状态"要求令牌，避免任意本机进程枚举
    assert.equal(hiddenNoToken.status, 403);

    const ghost = await h.get('/api/workspace/hidden?projectId=project-ghost');
    assert.equal(ghost.status, 404);
  });
});
