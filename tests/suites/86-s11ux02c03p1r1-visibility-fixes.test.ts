/**
 * UX-02C-03-P1-R1：三项复审缺陷的定点回归（hiddenCount 装载链 / rebound 重绑 / 条件提交）。
 *
 * 为什么单独成套件：82–85 已分别证明"Host 语义""分页语义""菜单判定""草稿保护"，
 * 但它们都**没有**覆盖本轮修复的三个断点：
 * - `page.hiddenCount` 从 Host 一路到 `TreeLevelState` 再进工具栏计数；
 * - 保存时"能否证明本次提交仍是原隐藏对象"的判定（不得盲绑路径上的新对象）；
 * - 身份刷新必须是 update-only + CAS（不得把用户刚取消的隐藏记录重新创建出来）。
 *
 * 取证方式：真实 Host + 真实 `FileProjectStore` + 真实 LocalProvider + 真实临时磁盘；
 * Shell 侧用真实 `createLiveClient` + 真实 `createTreeLevelLoader` 驱动真实 reducer。
 * 只有"计数展示"这一跳用纯函数（`countHiddenInLoadedLevels`）+ 浏览器验证补齐。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { decideHiddenRefresh } from '../../apps/server/src/hidden-refresh.ts';
import { serializeConfig } from '../../apps/server/src/store/config.ts';
import { createFileProjectStore } from '../../apps/server/src/store/index.ts';
import { createNodeStoreIo, type StoreIo } from '../../apps/server/src/store/io.ts';
import { createLiveClient, type WeaveSpaceClient } from '../../apps/shell/src/client/client-api.ts';
import {
  countHiddenInLoadedLevels,
  emptyLevels,
  ROOT_LEVEL,
  type TreeLevels,
} from '../../apps/shell/src/components/tree-model.ts';
import { createTreeLevelLoader } from '../../apps/shell/src/state/tree-load.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import type { WorkspaceAction, WorkspaceState } from '../../apps/shell/src/state/types.ts';
import { createLocalProvider, rootTokenOf } from '../../packages/storage/index.ts';

const PROJ_A = 'project-a';
const PROJ_B = 'project-b';

interface ApiResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  status: number;
}

interface Driver {
  /** 真实链路：client → loader → action → reducer。 */
  load(projectId: string, dir?: string, append?: boolean): Promise<string>;
  levels(projectId: string): TreeLevels;
  level(projectId: string, dir?: string): TreeLevels[string] | undefined;
  count(projectId: string): number;
  /** 切换"显示隐藏项"视图（下一次请求带 includeHidden=1）。 */
  setShowHidden(value: boolean): void;
  /** 强制每页条数（用于分页断言）。 */
  setLimit(value: number | undefined): void;
  invalidate(projectId: string): void;
}

interface Ctx {
  base: string;
  rootA: string;
  rootB: string;
  storeDir: string;
  server: ShellServer;
  client: WeaveSpaceClient;
  driver: Driver;
  api: {
    post(path: string, body: unknown): Promise<ApiResponse>;
    get(path: string): Promise<ApiResponse>;
    hide(projectId: string, path: string): Promise<ApiResponse>;
    unhide(projectId: string, path: string): Promise<ApiResponse>;
    hidden(projectId: string): Promise<ApiResponse>;
    tree(projectId: string, dir?: string, includeHidden?: boolean): Promise<ApiResponse>;
    openSave(projectId: string, path: string, buffer: string): Promise<ApiResponse>;
  };
  diagnostics: { type: string; projectId: string; path: string; result: string; reason?: string }[];
  /** 让下一次配置原子提交（workspace.json 的 rename）失败。 */
  setConfigWriteFailure(value: boolean): void;
  restart(): Promise<void>;
}

function makeStoreIo(): { io: StoreIo; failure: { config: boolean } } {
  const real = createNodeStoreIo();
  const failure = { config: false };
  const io: StoreIo = {
    ...real,
    rename(from, to) {
      if (failure.config && String(to).endsWith('workspace.json')) {
        throw new Error('rename 失败（测试注入）');
      }
      real.rename(from, to);
    },
  };
  return { io, failure };
}

async function withHost(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-p1r1-'));
  const storeDir = join(base, 'store');
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(storeDir, { recursive: true });
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await mkdir(rootB, { recursive: true });
  for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) {
    await writeFile(join(rootA, name), `# ${name}\n`, 'utf8');
  }
  await writeFile(join(rootA, 'docs', 'guide.md'), '# guide\n', 'utf8');
  await writeFile(join(rootB, 'other.md'), '# other\n', 'utf8');

  const project = (projectId: string, name: string, rootDir: string) => ({
    projectId,
    name,
    rootDir,
    canonicalRoot: realpathSync(rootDir),
    rootToken: rootTokenOf(rootDir),
    grantedAt: '2026-11-18T00:00:00.000Z',
    grantSource: 'os-dialog',
  });

  await writeFile(
    join(storeDir, 'workspace.json'),
    serializeConfig({
      version: 2,
      commitSeq: 0,
      issuedIds: [PROJ_A, PROJ_B],
      revoked: [],
      projects: [project(PROJ_A, '项目 A', rootA), project(PROJ_B, '项目 B', rootB)],
    }),
    'utf8',
  );

  const { io, failure } = makeStoreIo();
  const diagnostics: Ctx['diagnostics'] = [];
  let server = await createShellServer({
    port: 0,
    managedStore: { dir: storeDir, picker: createFakePicker([]), storeIo: io },
    diagnostics: (event) => diagnostics.push(event as never),
  });
  let token = ((await (await fetch(`${server.url}/api/session-token`)).json()) as { token?: string }).token ?? '';

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
    hide: (projectId: string, path: string) => api.post('/api/workspace/hide', { projectId, path }),
    unhide: (projectId: string, path: string) => api.post('/api/workspace/unhide', { projectId, path }),
    hidden: (projectId: string) => api.get(`/api/workspace/hidden?projectId=${projectId}`),
    tree: (projectId: string, dir = '', includeHidden = false) =>
      api.get(
        `/api/tree?projectId=${encodeURIComponent(projectId)}${dir ? `&dir=${encodeURIComponent(dir)}` : ''}${
          includeHidden ? '&includeHidden=1' : ''
        }`,
      ),
    /** 打开 → 编辑 → 保存（真实会话）。 */
    async openSave(projectId: string, path: string, buffer: string): Promise<ApiResponse> {
      const opened = await api.post('/api/open', { projectId, path });
      if (opened.status !== 200) return opened;
      const { sessionId, viewId, baseVersion } = opened.body.document;
      const edited = await api.post('/api/edit', { sessionId, viewId, buffer, expectedVersion: baseVersion });
      if (edited.status !== 200) return edited;
      return api.post('/api/save', { sessionId, viewId, expectedVersion: edited.body.document.baseVersion });
    },
  };

  // ---- 真实 Shell 链路：client → tree-load → reducer ----
  let state: WorkspaceState = { ...INITIAL_STATE, mode: 'live' };
  let showHidden = false;
  let limit: number | undefined;
  let epoch = 1;
  let workspaceKey = 'ws-key';
  let client = createLiveClient(server.url);
  const host = {
    identity: () => ({ mode: 'live' as const, syncMode: 'live' as const, workspaceKey, epoch, activeProjectId: PROJ_A }),
    levels: (key: string) => state.treeByProject[key] ?? emptyLevels(),
    listTree: (request: { projectId: string | null; dir: string; cursor: string | null; snapshot: string | null }) =>
      client.listTree(request.projectId, request.dir, request.cursor, limit, request.snapshot, { includeHidden: showHidden }),
    dispatch: (action: WorkspaceAction) => {
      state = workspaceReducer(state, action);
    },
  };
  const loader = createTreeLevelLoader(host);

  const driver: Driver = {
    load: (projectId, dir = '', append = false) => loader.load(projectId, dir, append),
    levels: (projectId) => state.treeByProject[projectId] ?? emptyLevels(),
    level: (projectId, dir = '') => state.treeByProject[projectId]?.[dir],
    count: (projectId) => countHiddenInLoadedLevels(state.treeByProject[projectId] ?? emptyLevels()),
    setShowHidden(value) {
      showHidden = value;
      loader.invalidateProject(PROJ_A);
      state = workspaceReducer(state, { type: 'TREE_RESET', projectId: PROJ_A });
    },
    setLimit(value) {
      limit = value;
    },
    invalidate(projectId) {
      loader.invalidateProject(projectId);
      state = workspaceReducer(state, { type: 'TREE_RESET', projectId });
    },
  };

  const ctx: Ctx = {
    base,
    rootA,
    rootB,
    storeDir,
    server,
    client,
    driver,
    api,
    diagnostics,
    setConfigWriteFailure(value) {
      failure.config = value;
    },
    async restart() {
      await server.close();
      server = await createShellServer({
        port: 0,
        managedStore: { dir: storeDir, picker: createFakePicker([]), storeIo: io },
        diagnostics: (event) => diagnostics.push(event as never),
      });
      ctx.server = server;
      token = ((await (await fetch(`${server.url}/api/session-token`)).json()) as { token?: string }).token ?? '';
      // 重启后工作区身份必然变化：让票据与之一致，避免迟到响应被误判为 stale
      epoch += 1;
      workspaceKey = `ws-key-${epoch}`;
      // 端口已变：客户端必须指向新实例，否则会打到已经关闭的旧端口
      client = createLiveClient(server.url);
      ctx.client = client;
    },
  };

  try {
    await fn(ctx);
  } finally {
    await server.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

/* ================================================================== */
/* R1-01：hiddenCount 全链路                                            */
/* ================================================================== */

test('R1-01a 真实链路：Host 有 1 个隐藏项时，层表与工具栏计数都是 1', async () => {
  await withHost(async (h) => {
    assert.equal((await h.driver.load(PROJ_A)).toString(), 'applied');
    assert.equal(h.driver.level(PROJ_A)?.hiddenCount, 0);

    assert.equal((await h.api.hide(PROJ_A, 'a.md')).status, 200);

    // 模拟"刷新"：作废后重新取根层（与用户点刷新、或隐藏后重取走同一条链）
    h.driver.invalidate(PROJ_A);
    assert.equal((await h.driver.load(PROJ_A)).toString(), 'applied');

    assert.equal(h.driver.level(PROJ_A)?.hiddenCount, 1, 'Host 报告 1，层表也必须是 1');
    assert.equal(h.driver.count(PROJ_A), 1, '工具栏计数（已加载层合计）必须是 1');
    // 默认视图里确实看不到这一条
    assert.deepEqual(
      (h.driver.level(PROJ_A)?.entries ?? []).map((entry) => entry.name).sort(),
      ['b.md', 'c.md', 'd.md', 'docs'],
    );
  });
});

test('R1-01b 切换"显示隐藏项"后计数保持 1（视图开关不改变计数语义）', async () => {
  await withHost(async (h) => {
    assert.equal((await h.api.hide(PROJ_A, 'a.md')).status, 200);
    h.driver.setShowHidden(true);
    assert.equal((await h.driver.load(PROJ_A)).toString(), 'applied');

    assert.equal(h.driver.level(PROJ_A)?.hiddenCount, 1);
    assert.equal(h.driver.count(PROJ_A), 1);
    assert.ok((h.driver.level(PROJ_A)?.entries ?? []).some((entry) => entry.name === 'a.md'));
    assert.equal(
      (h.driver.level(PROJ_A)?.entries ?? []).find((entry) => entry.name === 'a.md')?.hidden,
      true,
      '显示隐藏项时条目必须带 hidden 标记',
    );

    // 关掉视图开关：计数不能因此变成 0 或翻倍
    h.driver.setShowHidden(false);
    assert.equal((await h.driver.load(PROJ_A)).toString(), 'applied');
    assert.equal(h.driver.count(PROJ_A), 1);
  });
});

test('R1-01c 展开子目录：每一层各自计数，合计等于各层隐藏条目之和（不是"全项目数"）', async () => {
  await withHost(async (h) => {
    assert.equal((await h.api.hide(PROJ_A, 'a.md')).status, 200);
    assert.equal((await h.api.hide(PROJ_A, 'docs')).status, 200);

    assert.equal((await h.driver.load(PROJ_A)).toString(), 'applied');
    assert.equal(h.driver.level(PROJ_A)?.hiddenCount, 2, '根层：a.md + docs');

    assert.equal((await h.driver.load(PROJ_A, 'docs')).toString(), 'applied');
    assert.equal(h.driver.level(PROJ_A, 'docs')?.hiddenCount, 1, 'docs 层：guide.md 随上级隐藏');
    assert.equal(h.driver.count(PROJ_A), 3, '已加载层合计 = 根层 2 + docs 层 1');

    // 合计是"已加载层"的口径：没加载过的层不会被凭空算进来
    h.driver.invalidate(PROJ_A);
    assert.equal((await h.driver.load(PROJ_A)).toString(), 'applied');
    assert.equal(h.driver.count(PROJ_A), 2, '只加载根层时只统计根层');
  });
});

test('R1-01d 分页追加不丢计数：每一页都带同一层的真实值', async () => {
  await withHost(async (h) => {
    assert.equal((await h.api.hide(PROJ_A, 'a.md')).status, 200);
    h.driver.setLimit(2);

    assert.equal((await h.driver.load(PROJ_A)).toString(), 'applied');
    const first = h.driver.level(PROJ_A);
    assert.equal(first?.hiddenCount, 1);
    assert.equal(first?.nextCursor !== null, true, '夹具必须真的分成两页');

    assert.equal((await h.driver.load(PROJ_A, ROOT_LEVEL, true)).toString(), 'applied');
    const second = h.driver.level(PROJ_A);
    assert.equal(second?.hiddenCount, 1, '续页不得把计数重置为 0');
    assert.equal(h.driver.count(PROJ_A), 1, '续页不应把同一层的计数累加');
  });
});

test('R1-01e 0 与"字段缺失"必须区分：缺失保留旧值，0 覆盖为 0', async () => {
  const { applyPage } = await import('../../apps/shell/src/components/tree-model.ts');
  const base: TreeLevels = applyPage(emptyLevels(), ROOT_LEVEL, {
    entries: [],
    cursor: null,
    nextCursor: null,
    total: 0,
    snapshot: null,
    hiddenCount: 3,
  });
  assert.equal(base[ROOT_LEVEL].hiddenCount, 3);

  // 旧版服务端不返回该字段 → 保留上一次已知值（不能当成 0）
  const kept = applyPage(base, ROOT_LEVEL, { entries: [], cursor: null, nextCursor: null, total: 0, snapshot: null });
  assert.equal(kept[ROOT_LEVEL].hiddenCount, 3, '字段缺失 ≠ 0');

  // 明确返回 0 → 必须归零（这里用 `??` 或 truthy 判断都会错）
  const zero = applyPage(base, ROOT_LEVEL, {
    entries: [],
    cursor: null,
    nextCursor: null,
    total: 0,
    snapshot: null,
    hiddenCount: 0,
  });
  assert.equal(zero[ROOT_LEVEL].hiddenCount, 0);
});

test('R1-01f 取消隐藏后计数归零；重启后仍然正确（值来自 Host，不是本地推算）', async () => {
  await withHost(async (h) => {
    assert.equal((await h.api.hide(PROJ_A, 'a.md')).status, 200);
    assert.equal((await h.driver.load(PROJ_A)).toString(), 'applied');
    assert.equal(h.driver.count(PROJ_A), 1);

    assert.equal((await h.api.unhide(PROJ_A, 'a.md')).status, 200);
    h.driver.invalidate(PROJ_A);
    assert.equal((await h.driver.load(PROJ_A)).toString(), 'applied');
    assert.equal(h.driver.count(PROJ_A), 0);

    assert.equal((await h.api.hide(PROJ_A, 'b.md')).status, 200);
    await h.restart();
    h.driver.invalidate(PROJ_A);
    assert.equal((await h.driver.load(PROJ_A)).toString(), 'applied');
    assert.equal(h.driver.count(PROJ_A), 1, '重启后计数必须来自 Host 的真实记录');
  });
});

/* ================================================================== */
/* R1-02：保存不得把 rebound 对象重新绑定                                */
/* ================================================================== */

test('R1-02a 正常隐藏文件保存后仍隐藏，保存响应报告 refreshed', async () => {
  await withHost(async (h) => {
    assert.equal((await h.api.hide(PROJ_A, 'a.md')).status, 200);
    const saved = await h.api.openSave(PROJ_A, 'a.md', '# EDITED\n');
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.status, 'COMMITTED');
    assert.equal(saved.body.hiddenRefresh, 'refreshed', '正常延续必须刷新身份');

    const hidden = await h.api.hidden(PROJ_A);
    assert.equal(hidden.body.entries[0].state, 'active');
    const tree = await h.api.tree(PROJ_A);
    assert.ok(!(tree.body.entries as { name: string }[]).some((entry) => entry.name === 'a.md'));
    assert.equal(tree.body.page.hiddenCount, 1);
  });
});

test('R1-02b rebound 对象保存后不得恢复 active（新对象不被旧记录吞掉）', async () => {
  await withHost(async (h) => {
    assert.equal((await h.api.hide(PROJ_A, 'a.md')).status, 200);
    // 外部删除 + 重建：同名路径换成了另一个对象
    await unlink(join(h.rootA, 'a.md'));
    await writeFile(join(h.rootA, 'a.md'), '# REPLACED\n', 'utf8');
    assert.equal((await h.api.hidden(PROJ_A)).body.entries[0].state, 'rebound');

    const saved = await h.api.openSave(PROJ_A, 'a.md', '# EDITED-BY-USER\n');
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.status, 'COMMITTED');
    assert.equal(saved.body.hiddenRefresh, 'skipped');
    assert.equal(saved.body.hiddenRefreshReason, 'rebound');

    assert.equal((await h.api.hidden(PROJ_A)).body.entries[0].state, 'rebound', '不得升级为 active');
    const tree = await h.api.tree(PROJ_A);
    assert.ok(
      (tree.body.entries as { name: string }[]).some((entry) => entry.name === 'a.md'),
      '新对象必须保持可见',
    );
  });
});

test('R1-02c Provider 的提交身份可证明：正常保存等于磁盘对象，提交后被替换则不等', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-p1r1-prov-'));
  try {
    let replaceAfterCommit = false;
    const provider = createLocalProvider({
      rootDir: base,
      providerId: 'local:probe',
      faults: {
        afterCommit: () => {
          if (!replaceAfterCommit) return;
          const target = join(base, 'a.md');
          unlinkSync(target);
          writeFileSync(target, 'REPLACED-BY-SOMEONE-ELSE\n', 'utf8');
        },
      },
    });
    await writeFile(join(base, 'a.md'), 'ORIGINAL\n', 'utf8');
    const before = await provider.stat('a.md');

    const ok = await provider.writeConditional('a.md', 'FIRST\n', before.contentVersion);
    assert.equal(ok.status, 'COMMITTED');
    assert.equal(typeof ok.identity, 'string', '提交结果必须携带写入对象的身份');
    assert.equal(ok.identity, await provider.identityOf!('a.md'), '正常提交：证据与磁盘对象一致');

    const second = await provider.stat('a.md');
    replaceAfterCommit = true;
    const raced = await provider.writeConditional('a.md', 'SECOND\n', second.contentVersion);
    assert.equal(raced.status, 'COMMITTED');
    assert.notEqual(
      raced.identity,
      await provider.identityOf!('a.md'),
      '提交对象已被替换：证据与路径上的对象必须不一致（调用方据此跳过刷新）',
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('R1-02d 判定表：只有能证明"原对象延续"才允许刷新', () => {
  const record = { identity: '1:100', rootToken: 'tok' };
  const decide = (input: Partial<Parameters<typeof decideHiddenRefresh>[0]>) =>
    decideHiddenRefresh({
      record,
      rootToken: 'tok',
      providerSupportsIdentity: true,
      preIdentity: '1:100',
      savedIdentity: '1:200',
      postIdentity: '1:200',
      ...input,
    });
  const reasonOf = (input: Partial<Parameters<typeof decideHiddenRefresh>[0]>): string => {
    const decision = decide(input);
    assert.equal(decision.action, 'skip', `期望 skip，实际 ${JSON.stringify(decision)}`);
    return decision.action === 'skip' ? decision.reason : '';
  };

  const allowed = decide({});
  assert.equal(allowed.action, 'update');
  assert.equal(allowed.action === 'update' ? allowed.identity : '', '1:200');

  assert.equal(reasonOf({ record: undefined }), 'no-record');
  assert.equal(reasonOf({ providerSupportsIdentity: false }), 'provider-unsupported');
  assert.equal(reasonOf({ rootToken: 'tok-2' }), 'root-changed');
  assert.equal(reasonOf({ preIdentity: null }), 'missing');
  assert.equal(reasonOf({ preReadFailed: true }), 'pre-read-failed');
  assert.equal(reasonOf({ preIdentity: '1:999' }), 'rebound');
  assert.equal(reasonOf({ savedIdentity: null }), 'no-save-identity');
  assert.equal(reasonOf({ postIdentity: null }), 'post-missing');
  assert.equal(reasonOf({ postIdentity: '1:999' }), 'post-mismatch');
});

/* ================================================================== */
/* R1-03：update-only + CAS                                            */
/* ================================================================== */

async function withStore(fn: (ctx: {
  store: ReturnType<typeof createFileProjectStore>;
  dir: string;
  failure: { config: boolean };
  readConfig(): Promise<{ hidden: { path: string; identity: string }[]; commitSeq: number }>;
}) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-p1r1-store-'));
  const dir = join(base, 'store');
  await mkdir(dir, { recursive: true });
  const { io, failure } = makeStoreIo();
  const store = createFileProjectStore({ dir, io });
  try {
    await store.commitAdd({
      projectId: PROJ_A,
      name: 'A',
      rootDir: base,
      canonicalRoot: base,
      rootToken: 'tok',
      grantedAt: '2026-11-18T00:00:00.000Z',
      grantSource: 'os-dialog',
      opId: 'op-add',
    });
    await fn({
      store,
      dir,
      failure,
      async readConfig() {
        return JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8'));
      },
    });
  } finally {
    store.close();
    await rm(base, { recursive: true, force: true });
  }
}

test('R1-03a 保存期间用户取消隐藏：旧刷新不得重新创建记录', async () => {
  await withStore(async ({ store, readConfig }) => {
    await store.commitHidden({ projectId: PROJ_A, path: 'a.md', rootToken: 'tok', identity: '1:100', hidden: true });
    const expectIdentity = store.hiddenOf(PROJ_A)[0].identity;
    const seqBefore = (await readConfig()).commitSeq;

    // 用户在刷新等待期间点了"取消隐藏"
    await store.commitHidden({ projectId: PROJ_A, path: 'a.md', hidden: false });
    const seqAfterUnhide = (await readConfig()).commitSeq;

    const result = await store.commitHiddenUpdate({
      projectId: PROJ_A,
      path: 'a.md',
      rootToken: 'tok',
      identity: '1:200',
      expectIdentity,
    });

    assert.equal(result.outcome, 'skipped-missing');
    assert.equal(result.changed, false);
    assert.deepEqual(store.hiddenOf(PROJ_A), [], '绝不能凭空重建记录');
    const config = await readConfig();
    assert.deepEqual(config.hidden, []);
    assert.equal(config.commitSeq, seqAfterUnhide, '被跳过的刷新不得推进事务序号');
    assert.ok(config.commitSeq >= seqBefore);
  });
});

test('R1-03b 取消隐藏后又重新隐藏：旧刷新不得覆盖新记录', async () => {
  await withStore(async ({ store, readConfig }) => {
    await store.commitHidden({ projectId: PROJ_A, path: 'a.md', rootToken: 'tok', identity: '1:100', hidden: true });
    const staleExpect = store.hiddenOf(PROJ_A)[0].identity;

    await store.commitHidden({ projectId: PROJ_A, path: 'a.md', hidden: false });
    await store.commitHidden({ projectId: PROJ_A, path: 'a.md', rootToken: 'tok', identity: '1:300', hidden: true });

    const result = await store.commitHiddenUpdate({
      projectId: PROJ_A,
      path: 'a.md',
      rootToken: 'tok',
      identity: '1:200',
      expectIdentity: staleExpect,
    });

    assert.equal(result.outcome, 'skipped-conflict');
    assert.equal(store.hiddenOf(PROJ_A)[0].identity, '1:300', '新记录必须原样保留');
    assert.equal((await readConfig()).hidden[0].identity, '1:300');
  });
});

test('R1-03c 条件提交写盘失败：内存与磁盘保持一致，不产生半更新状态', async () => {
  await withStore(async ({ store, failure, readConfig }) => {
    await store.commitHidden({ projectId: PROJ_A, path: 'a.md', rootToken: 'tok', identity: '1:100', hidden: true });
    const before = await readConfig();

    failure.config = true;
    await assert.rejects(
      () =>
        store.commitHiddenUpdate({
          projectId: PROJ_A,
          path: 'a.md',
          rootToken: 'tok',
          identity: '1:200',
          expectIdentity: '1:100',
        }),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PERSIST_FAILED',
    );
    failure.config = false;

    assert.equal(store.hiddenOf(PROJ_A)[0].identity, '1:100', '内存里不得出现新身份');
    assert.deepEqual(await readConfig(), before, '磁盘字节也不得变化');
  });
});

test('R1-03d 条件提交与其它配置提交交错时不丢状态（记录集合按预期合并）', async () => {
  await withStore(async ({ store, readConfig }) => {
    const seqBefore = (await readConfig()).commitSeq;
    await store.commitHidden({ projectId: PROJ_A, path: 'a.md', rootToken: 'tok', identity: '1:100', hidden: true });
    await store.commitHidden({ projectId: PROJ_A, path: 'b.md', rootToken: 'tok', identity: '1:200', hidden: true });

    const updated = await store.commitHiddenUpdate({
      projectId: PROJ_A,
      path: 'a.md',
      rootToken: 'tok',
      identity: '1:300',
      expectIdentity: '1:100',
    });
    assert.equal(updated.outcome, 'updated');

    // 刷新之后又发生一次普通隐藏：两者都不能覆盖对方
    await store.commitHidden({ projectId: PROJ_A, path: 'c.md', rootToken: 'tok', identity: '1:400', hidden: true });

    const config = await readConfig();
    assert.deepEqual(
      config.hidden.map((entry) => `${entry.path}=${entry.identity}`).sort(),
      ['a.md=1:300', 'b.md=1:200', 'c.md=1:400'],
      '三次提交必须全部落盘，不得出现"后写覆盖前写"',
    );
    assert.equal(config.commitSeq, seqBefore + 4, '四次真实变更各推进一个序号');
  });
});

/* ================================================================== */
/* R1-04：保存成功但元数据刷新失败                                       */
test('R1-04a 保存成功但隐藏元数据刷新失败：正文 COMMITTED + failed + 诊断事件', async () => {
  await withHost(async (h) => {
    assert.equal((await h.api.hide(PROJ_A, 'a.md')).status, 200);
    h.setConfigWriteFailure(true);
    const saved = await h.api.openSave(PROJ_A, 'a.md', '# SAVED-BUT-META-FAILED\n');
    h.setConfigWriteFailure(false);

    assert.equal(saved.status, 200, '正文已落盘：不得因为元数据失败而报保存失败');
    assert.equal(saved.body.status, 'COMMITTED');
    assert.equal(saved.body.hiddenRefresh, 'failed');
    assert.equal(await readFile(join(h.rootA, 'a.md'), 'utf8'), '# SAVED-BUT-META-FAILED\n');

    // 记录仍是旧身份 → 状态可观察，不是"悄悄成功"
    assert.equal((await h.api.hidden(PROJ_A)).body.entries[0].state, 'rebound');
    const event = h.diagnostics.find((item) => item.type === 'hidden-refresh');
    assert.ok(event, '刷新失败必须留下诊断事件');
    assert.equal(event?.result, 'failed');
    assert.equal(event?.path, 'a.md', '诊断事件不得包含本机绝对路径');
  });
});

test('R1-04b 刷新被跳过时同样可诊断（reason 明确），且不改变保存结论', async () => {
  await withHost(async (h) => {
    assert.equal((await h.api.hide(PROJ_A, 'a.md')).status, 200);
    await unlink(join(h.rootA, 'a.md'));
    await writeFile(join(h.rootA, 'a.md'), '# NEW OBJECT\n', 'utf8');

    const saved = await h.api.openSave(PROJ_A, 'a.md', '# NEW OBJECT EDITED\n');
    assert.equal(saved.body.status, 'COMMITTED');
    assert.equal(saved.body.hiddenRefresh, 'skipped');
    assert.equal(saved.body.hiddenRefreshReason, 'rebound');
    const event = h.diagnostics.find((item) => item.type === 'hidden-refresh');
    assert.equal(event?.result, 'skipped');
    assert.equal(event?.reason, 'rebound');
  });
});

/* ================================================================== */
/* R1-10：影响面                                                        */
/* ================================================================== */

test('R1-10a 一个项目保存/刷新隐藏身份不影响另一个项目与其会话', async () => {
  await withHost(async (h) => {
    assert.equal((await h.api.hide(PROJ_A, 'a.md')).status, 200);
    // B 项目里同名文件：先建好再取基线，避免把"我自己刚建的文件"当成变化
    await writeFile(join(h.rootB, 'a.md'), '# B a\n', 'utf8');
    const bTreeBefore = await h.api.tree(PROJ_B);

    const bSave = await h.api.openSave(PROJ_B, 'a.md', '# B a edited\n');
    assert.equal(bSave.body.status, 'COMMITTED');
    assert.equal(bSave.body.hiddenRefresh, 'none', 'B 项目没有隐藏记录：不得产生刷新动作');
    assert.equal(await readFile(join(h.rootB, 'a.md'), 'utf8'), '# B a edited\n');

    const aSaved = await h.api.openSave(PROJ_A, 'a.md', '# A edited\n');
    assert.equal(aSaved.body.hiddenRefresh, 'refreshed');

    assert.deepEqual((await h.api.tree(PROJ_B)).body.entries, bTreeBefore.body.entries, 'B 的树不得变化');
    assert.deepEqual(await h.api.hidden(PROJ_B).then((r) => r.body.entries), [], 'B 仍然没有隐藏记录');
    // A 的记录仍只有一条，且身份已刷新
    const aHidden = await h.api.hidden(PROJ_A);
    assert.equal(aHidden.body.entries.length, 1);
    assert.equal(aHidden.body.entries[0].state, 'active');
  });
});
