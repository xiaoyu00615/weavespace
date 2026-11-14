/**
 * S11-UX-02B-TREE-R2：最后两项集成边界（先红后绿）。
 *
 * R2-01 根目录刷新竞争：`loadProjectResources()` 的根层读取只看 `isCancelled()`
 * （基于只读的 loadToken），连续两次刷新同一项目时两次 token 完全相同，
 * 于是「旧请求晚于新请求返回」会把新层表、loading / error 状态整份覆盖。
 * 这里用确定性 deferred 复现「B 先返回、A 后返回」，并逐条检查 dispatch。
 *
 * R2-02 链接路径预检：`readDir()` 在 `resolveInBoundary()` 之前对**完整字面路径**
 * 执行 lstat；当父级是 junction/symlink 时，这会先沿链接访问根外 `child` 的元数据。
 * 仅断言 HTTP 400/403 不足以证明这一点，因此注入 `lstatImpl` 探针：
 * 记录每一次元数据读取，并用父目录 realpath 判定它是否已经跑到根外。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat as realLstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createLocalProvider, type LstatImpl } from '../../packages/storage/index.ts';
import type { StorageFaultHooks } from '../../packages/storage/index.ts';
import type { TreeQueryOutcome, WeaveSpaceClient } from '../../apps/shell/src/client/client-api.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import { loadProjectResources, type WorkspaceLoadDeps } from '../../apps/shell/src/state/workspace-load.ts';
import { refreshProject, type RefreshProjectDeps } from '../../apps/shell/src/state/refresh-project.ts';
import { createTreeOwnershipGuard } from '../../apps/shell/src/state/tree-load.ts';
import type { WorkspaceAction, WorkspaceState } from '../../apps/shell/src/state/types.ts';

/* ------------------------------- 通用夹具 ------------------------------- */

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let settle: (value: T) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    settle = res;
    fail = rej;
  });
  return { promise, resolve: settle, reject: fail };
}

function appliedPage(names: readonly string[], snapshot = 'S'): TreeQueryOutcome {
  return {
    status: 'APPLIED',
    level: '',
    entries: names.map((name) => ({
      id: `doc:project-a/${name}`,
      name,
      kind: 'file' as const,
      extension: '.md',
      relPath: name,
    })),
    page: { limit: 200, cursor: null, nextCursor: null, total: names.length, snapshot },
  };
}

const PROJECTS = [
  { projectId: 'project-a', name: 'A', status: 'READY' as const },
  { projectId: 'project-b', name: 'B', status: 'READY' as const },
];

interface RootHarness {
  deps: WorkspaceLoadDeps;
  refreshDeps: RefreshProjectDeps;
  calls: Array<{ projectId: string | null; dir: string; d: Deferred<TreeQueryOutcome> }>;
  actions: WorkspaceAction[];
  dispatch(action: WorkspaceAction): void;
  state(): WorkspaceState;
  guard: ReturnType<typeof createTreeOwnershipGuard>;
}

function makeRootHarness(workspaceMode: 'multi' | 'legacy' = 'multi'): RootHarness {
  const guard = createTreeOwnershipGuard(() => ({
    mode: 'live' as const,
    syncMode: 'live' as const,
    workspaceKey: 'ws-r2-key',
    epoch: 1,
  }));
  const calls: RootHarness['calls'] = [];
  const client = {
    listTree(projectId: string | null, dir: string) {
      const d = deferred<TreeQueryOutcome>();
      calls.push({ projectId, dir, d });
      return d.promise;
    },
    listProjects: async () => PROJECTS,
  } as unknown as WeaveSpaceClient;

  let state: WorkspaceState = {
    ...INITIAL_STATE,
    mode: 'live',
    workspaceMode,
    workspaceKey: 'ws-r2-key',
    projects: PROJECTS,
    activeProjectId: 'project-a',
  };
  const actions: WorkspaceAction[] = [];
  const dispatch = (action: WorkspaceAction): void => {
    actions.push(action);
    state = workspaceReducer(state, action);
  };
  const clientFor = (): WeaveSpaceClient => client;
  const deps: WorkspaceLoadDeps = {
    getState: () => state,
    dispatch,
    clientFor,
    treeOwnership: guard,
    preserveLoadingOnCancel: true,
  };
  const refreshDeps: RefreshProjectDeps = {
    getState: () => state,
    getMode: () => 'live',
    dispatch,
    clientFor,
    refreshOpenTabs: async () => ({
      projectId: null,
      checked: 0,
      updated: 0,
      dirtyChanged: [],
      failed: [],
    }),
    // 关键：loadToken() 只读，不推进代次；两次刷新拿到完全相同的 token
    loadToken: () => 1,
    isTokenCurrent: () => true,
    treeOwnership: guard,
  };
  return { deps, refreshDeps, calls, actions, dispatch, state: () => state, guard };
}

function pagesOf(actions: readonly WorkspaceAction[]): string[] {
  return actions.flatMap((action) =>
    action.type === 'TREE_LEVEL_PAGE' ? action.entries.map((entry) => entry.name) : [],
  );
}

/* ====================================================================== *
 * R2-01 · 根目录刷新竞争
 * ====================================================================== */

test('R2-01-01 连续两次刷新同一项目：B 先返回、A 后返回，旧响应不得覆盖新层表', async () => {
  const h = makeRootHarness();
  const a = refreshProject(h.refreshDeps, 'project-a');
  const b = refreshProject(h.refreshDeps, 'project-a');
  assert.equal(h.calls.length, 2, '两次刷新都必须真的发出根层请求');

  // 后发起的 B 先返回（新结果），先发起的 A 后返回（旧结果）
  h.calls[1].d.resolve(appliedPage(['new.md'], 'S-new'));
  const resultB = await b;
  h.calls[0].d.resolve(appliedPage(['old.md'], 'S-old'));
  const resultA = await a;

  assert.equal(resultB.cancelled, false, '新请求必须正常完成');
  assert.equal(resultA.cancelled, false);
  assert.deepEqual(pagesOf(h.actions), ['new.md'], 'A 的迟到成功响应一个 PAGE 都不能派发');
  assert.deepEqual(h.state().treeByProject['project-a']?.['']?.entries.map((n) => n.name), ['new.md']);
  assert.equal(
    h.actions.filter((action) => action.type === 'TREE_RESET').length,
    1,
    '旧请求不得再作废新层表',
  );
  assert.equal(
    h.actions.filter((action) => action.type === 'SET_PROJECTS').length,
    1,
    '旧请求的 refreshProjectStatuses 也不得回写项目表',
  );
  assert.equal(
    h.actions.filter((action) => action.type === 'NOTICE' && /已刷新项目/.test(action.message)).length,
    1,
    '旧请求不得再发一条刷新成功提示',
  );
  assert.equal(
    h.actions.filter((action) => action.type === 'SET_PROJECT_LOADING' && action.loading === false).length,
    1,
    '旧请求的 finally 不得清理掉新请求的 loading 标记',
  );
  assert.equal(h.state().treeByProject['project-a']?.['']?.status, 'ready');
});

test('R2-01-02 旧请求失败迟到：不得写 error / NOTICE，不得覆盖新请求的 ready', async () => {
  const h = makeRootHarness();
  const a = refreshProject(h.refreshDeps, 'project-a');
  const b = refreshProject(h.refreshDeps, 'project-a');

  h.calls[1].d.resolve(appliedPage(['new.md'], 'S-new'));
  await b;
  h.calls[0].d.resolve({ status: 'REJECTED', errorCode: 'ERR_DIR_UNREADABLE' });
  await a;

  assert.equal(
    h.actions.some((action) => action.type === 'TREE_LEVEL_ERROR'),
    false,
    '旧请求失败不得把新层写成 error',
  );
  assert.equal(
    h.actions.some((action) => action.type === 'NOTICE' && /读取失败|无法连接/.test(action.message)),
    false,
    '旧请求失败不得弹新工作区的提示',
  );
  assert.equal(h.state().treeByProject['project-a']?.['']?.status, 'ready');
  assert.deepEqual(h.state().treeByProject['project-a']?.['']?.entries.map((n) => n.name), ['new.md']);
});

test('R2-01-03 旧请求抛异常迟到：catch 与 finally 都不得留下痕迹', async () => {
  const h = makeRootHarness();
  const a = refreshProject(h.refreshDeps, 'project-a');
  const b = refreshProject(h.refreshDeps, 'project-a');

  h.calls[1].d.resolve(appliedPage(['new.md'], 'S-new'));
  await b;
  const before = h.actions.length;
  h.calls[0].d.reject(new Error('network gone'));
  await a;

  assert.equal(h.actions.length, before, '旧请求抛异常后一个 dispatch 都不能发');
  assert.equal(h.state().treeByProject['project-a']?.['']?.status, 'ready');
});

test('R2-01-04 刷新项目 A 不取消项目 B 的有效请求', async () => {
  const h = makeRootHarness();
  const b = loadProjectResources(h.deps, 'project-b');
  const a1 = loadProjectResources(h.deps, 'project-a');
  // 真实刷新入口会作废目标项目的层；B 不该被牵连
  h.guard.invalidateProject('project-a');
  const a2 = loadProjectResources(h.deps, 'project-a');

  assert.equal(h.calls.length, 3);
  h.calls[2].d.resolve(appliedPage(['a2.md'], 'S-a2'));
  h.calls[0].d.resolve(appliedPage(['b.md'], 'S-b'));
  h.calls[1].d.resolve(appliedPage(['a1.md'], 'S-a1'));

  const results = await Promise.all([a1, a2, b]);
  assert.deepEqual(results, [false, true, true], 'A 的第一次被作废；A 的新请求与 B 都正常完成');
  assert.deepEqual(h.state().treeByProject['project-b']?.['']?.entries.map((n) => n.name), ['b.md']);
  assert.deepEqual(h.state().treeByProject['project-a']?.['']?.entries.map((n) => n.name), ['a2.md']);
});

test('R2-01-06 Legacy 根层连续两次刷新：B 先返回、A 后返回同样不得覆盖', async () => {
  const h = makeRootHarness('legacy');
  const a = refreshProject(h.refreshDeps);
  const b = refreshProject(h.refreshDeps);
  assert.equal(h.calls.length, 2, 'Legacy 根层也必须真的发出两次请求');

  h.calls[1].d.resolve(appliedPage(['new.md'], 'S-new'));
  await b;
  h.calls[0].d.resolve(appliedPage(['old.md'], 'S-old'));
  await a;

  assert.deepEqual(pagesOf(h.actions), ['new.md'], 'Legacy 旧响应不得覆盖新层表');
  assert.deepEqual(h.state().treeByProject['']?.['']?.entries.map((n) => n.name), ['new.md']);
  assert.equal(
    h.actions.filter((action) => action.type === 'TREE_RESET').length,
    1,
    'Legacy 旧请求不得再作废层表',
  );
  assert.equal(
    h.actions.filter((action) => action.type === 'SET_LOADING_RESOURCES' && action.loading === false).length,
    1,
    'Legacy 旧请求的 finally 不得清理新请求的 loading',
  );
});

test('R2-01-05 刷新竞争修复不改变标签、草稿与已打开文档', async () => {
  const h = makeRootHarness();
  const tab = {
    docId: 'doc:project-a/notes.md',
    projectId: 'project-a',
    path: 'notes.md',
    title: 'notes.md',
    extension: '.md',
    buffer: '# 未保存草稿',
    dirty: true,
    mode: 'live' as const,
    sessionId: 's1',
    viewId: 'v1',
    baseVersion: 'v0',
    revision: 0,
    documentState: 'EDITING_DIRTY',
    saving: false,
    lastStatus: null,
    errorCode: null,
  };
  // 通过真实 dispatch 注入已打开的脏标签（会同时更新 harness 的 state）
  h.dispatch({ type: 'OPEN_TAB', tab });

  const a = refreshProject(h.refreshDeps, 'project-a');
  const b = refreshProject(h.refreshDeps, 'project-a');
  h.calls[1].d.resolve(appliedPage(['new.md']));
  await b;
  h.calls[0].d.resolve(appliedPage(['old.md']));
  await a;

  assert.equal(h.state().tabs.length, 1);
  assert.equal(h.state().tabs[0].dirty, true);
  assert.equal(h.state().tabs[0].buffer, '# 未保存草稿');
});

/* ====================================================================== *
 * R2-02 · 链接路径预检：拒绝前不得读取越界元数据
 * ====================================================================== */

interface LinkFixture {
  base: string;
  root: string;
  outside: string;
  hasJunction: boolean;
}

async function makeLinkFixture(): Promise<LinkFixture> {
  const base = await mkdtemp(join(tmpdir(), 'ws-r2-link-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  await mkdir(join(root, 'docs', 'sub'), { recursive: true });
  await mkdir(join(outside, 'child'), { recursive: true });
  await writeFile(join(outside, 'child', 'secret.txt'), 'secret', 'utf8');
  await writeFile(join(root, 'a.md'), 'a', 'utf8');
  await writeFile(join(root, 'docs', 'sub', 'deep.md'), 'deep', 'utf8');

  let hasJunction = false;
  try {
    await symlink(outside, join(root, 'linked-out'), 'junction');
    hasJunction = true;
  } catch {
    await symlink(outside, join(root, 'linked-out'), 'dir').catch(() => {});
  }
  // 悬空链接：目标不存在
  await symlink(join(base, 'nowhere'), join(root, 'dangling'), 'dir').catch(() => {});
  return { base, root, outside, hasJunction };
}

/** 记录每次 lstat；「父目录 realpath 已在根外」即判定为沿链接访问了根外目标元数据。 */
function metadataProbe(canonicalRoot: string) {
  const probed: string[] = [];
  const outsideReads: string[] = [];
  const impl: LstatImpl = async (absolutePath: string) => {
    probed.push(absolutePath);
    try {
      const parentReal = realpathSync.native(dirname(absolutePath));
      const rel = relative(canonicalRoot, parentReal);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        outsideReads.push(absolutePath);
      }
    } catch {
      // 父目录不存在：不算越界读取，交由正式链路判定
    }
    return realLstat(absolutePath);
  };
  return { probed, outsideReads, impl };
}

function errorCodeOf(err: unknown): string | null {
  return ((err as { errorCode?: string } | undefined)?.errorCode ?? null) as string | null;
}

test('R2-02-01 dir=link 保持明确的链接拒绝语义；探针确实被接上', async () => {
  const f = await makeLinkFixture();
  try {
    const canonical = realpathSync.native(f.root);
    const probe = metadataProbe(canonical);
    const provider = createLocalProvider({
      rootDir: f.root,
      faults: { lstatImpl: probe.impl } satisfies StorageFaultHooks,
    });
    const err = await provider.readDir('linked-out').then(() => null, (e: unknown) => e);
    assert.equal(errorCodeOf(err), 'ERR_DIR_IS_LINK');
    assert.ok(probe.probed.length > 0, '探针必须真的观测到元数据读取（否则测试没有判别力）');
    assert.deepEqual(probe.outsideReads, [], '只读链接条目自身，不得沿它读根外目标');
  } finally {
    await rm(f.base, { recursive: true, force: true }).catch(() => {});
  }
});

test('R2-02-01b Windows junction 兜底：lstat 认不出链接时仍报 ERR_DIR_IS_LINK', async () => {
  const f = await makeLinkFixture();
  try {
    // Windows 的 lstatSync().isSymbolicLink() 对部分 junction 返回 false
    // （见 path-safety.ts 顶部说明）。注入"盲" lstat 模拟该平台差异，
    // 验证 realpath 比对仍会给出明确的链接拒绝，而不是含糊的越界错误。
    const blind: LstatImpl = async () => ({
      isSymbolicLink: () => false,
      isDirectory: () => true,
    });
    const provider = createLocalProvider({ rootDir: f.root, faults: { lstatImpl: blind } });
    const err = await provider.readDir('linked-out').then(() => null, (e: unknown) => e);
    assert.equal(errorCodeOf(err), 'ERR_DIR_IS_LINK');

    const childErr = await provider.readDir('linked-out/child').then(() => null, (e: unknown) => e);
    assert.ok(childErr, '即使 lstat 认不出链接，link/child 也必须 fail-closed 拒绝');
  } finally {
    await rm(f.base, { recursive: true, force: true }).catch(() => {});
  }
});

test('R2-02-02 dir=link/child 必须拒绝，且不得先沿链接访问根外 child（探针判定）', async () => {
  const f = await makeLinkFixture();
  try {
    const canonical = realpathSync.native(f.root);
    const probe = metadataProbe(canonical);
    const provider = createLocalProvider({
      rootDir: f.root,
      faults: { lstatImpl: probe.impl } satisfies StorageFaultHooks,
    });
    const err = await provider.readDir('linked-out/child').then(() => null, (e: unknown) => e);
    assert.ok(err, 'dir=link/child 必须被拒绝，不能当成空目录或正常目录');
    assert.deepEqual(
      probe.outsideReads,
      [],
      '拒绝之前不得有任何一次「父目录已解析到根外」的元数据读取',
    );
    assert.equal(
      probe.probed.some((p) => p.includes(join('linked-out', 'child'))),
      false,
      '不得对 link/child 这个路径本身执行 lstat',
    );
  } finally {
    await rm(f.base, { recursive: true, force: true }).catch(() => {});
  }
});

test('R2-02-03 普通嵌套目录仍正常读取；悬空链接与非法相对路径全部 fail-closed', async () => {
  const f = await makeLinkFixture();
  try {
    const canonical = realpathSync.native(f.root);
    const probe = metadataProbe(canonical);
    const provider = createLocalProvider({
      rootDir: f.root,
      faults: { lstatImpl: probe.impl } satisfies StorageFaultHooks,
    });

    const nested = await provider.readDir('docs/sub');
    assert.deepEqual(nested.map((e) => e.name), ['deep.md']);

    for (const bad of ['dangling', 'dangling/child', '../escape', '/absolute', 'C:/drive', 'a//b', 'a/./b', 'a/../b']) {
      const err = await provider.readDir(bad).then(() => null, (e: unknown) => e);
      assert.ok(err, `${bad} 必须 fail-closed 拒绝`);
    }
    assert.deepEqual(probe.outsideReads, [], '所有拒绝路径都不得产生越界元数据读取');
    assert.equal(
      probe.probed.some((p) => p.includes(join('dangling', 'child')) || p.includes(join('linked-out', 'child'))),
      false,
      '悬空链接之下 / 链接之下的路径都不该被 lstat',
    );
  } finally {
    await rm(f.base, { recursive: true, force: true }).catch(() => {});
  }
});

test('R2-02-04 HTTP 层：dir=link/child 被拒且不泄露根外内容，越界探针仍为零', async () => {
  const f = await makeLinkFixture();
  try {
    const canonical = realpathSync.native(f.root);
    const probe = metadataProbe(canonical);
    const server: ShellServer = await createShellServer({
      rootDir: f.root,
      port: 0,
      providerFaults: { lstatImpl: probe.impl } satisfies StorageFaultHooks,
    });
    try {
      const link = await fetch(`${server.url}/api/tree?dir=linked-out`);
      assert.equal(link.status, 400, 'dir=link 维持明确的链接拒绝语义');
      assert.equal((await link.json() as { errorCode: string }).errorCode, 'ERR_DIR_IS_LINK');

      const before = probe.outsideReads.length;
      const child = await fetch(`${server.url}/api/tree?dir=linked-out%2Fchild`);
      const body = (await child.json()) as Record<string, unknown>;
      assert.notEqual(child.status, 200, 'dir=link/child 不得返回 200');
      assert.equal(
        JSON.stringify(body).includes('secret.txt'),
        false,
        '不得泄露根外内容',
      );
      assert.equal(
        JSON.stringify(body).includes(f.outside.replace(/\\/g, '/')),
        false,
        '响应不得含本机绝对路径',
      );
      assert.equal(probe.outsideReads.length, before, 'HTTP 到 storage 全链路都不得越界读元数据');
    } finally {
      await server.close().catch(() => {});
    }
  } finally {
    await rm(f.base, { recursive: true, force: true }).catch(() => {});
  }
});
