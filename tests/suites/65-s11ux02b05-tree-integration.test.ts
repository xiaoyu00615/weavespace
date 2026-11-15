/**
 * UX-02B-05-04：文件树集成（真实 Host 目录 + Shell 归属层）。
 *
 * 验收要点：
 * - 多项目的根 / 子目录 / 文件正确展示，多种文件类型都可见；
 * - 空目录、目录不存在、路径不是目录三态**严格区分**（不得把"读不出来"渲染成空）；
 * - 分页完整：不静默截断、不重复、不漏项；
 * - 目录在两页之间变化 → `ERR_DIR_CHANGED`；
 * - 折叠再展开复用缓存（同一层不会重新请求）；
 * - 刷新 / 移除 A 只作用于 A：B 的层表与在途票据不受影响；
 * - 移除 A 之后迟到的目录响应不得重建 A 的节点；
 * - junction 不被跟随，根外内容不泄露。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { TreeQueryOutcome } from '../../apps/shell/src/client/client-api.ts';
import { createLiveClient } from '../../apps/shell/src/client/client-api.ts';
import { createShellServer } from '../../apps/server/src/server.ts';
import { emptyLevels } from '../../apps/shell/src/components/tree-model.ts';
import {
  createTreeLevelLoader,
  createTreeOwnershipGuard,
  type TreeLoadIdentity,
} from '../../apps/shell/src/state/tree-load.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import type { WorkspaceAction, WorkspaceState } from '../../apps/shell/src/state/types.ts';
import type { WorkspaceConfig } from '../../packages/project-registry/index.ts';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let ok: (v: T) => void = () => {};
  let no: (e: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    ok = res;
    no = rej;
  });
  return { promise, resolve: ok, reject: no };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function applied(outcome: TreeQueryOutcome): Extract<TreeQueryOutcome, { status: 'APPLIED' }> {
  if (outcome.status !== 'APPLIED') throw new Error(`期望 APPLIED，实际: ${JSON.stringify(outcome)}`);
  return outcome;
}

function appliedPage(names: readonly string[], snapshot = 'S'): TreeQueryOutcome {
  return {
    status: 'APPLIED',
    level: '',
    entries: names.map((name) => ({
      id: `doc:x/${name}`,
      name,
      kind: 'file' as const,
      extension: '.md',
      relPath: name,
    })),
    page: { limit: 200, cursor: null, nextCursor: null, total: names.length, snapshot },
  };
}

/* ------------------------------------------------------------------ */
/* 真实 Host：树的事实与分页                                            */
/* ------------------------------------------------------------------ */

interface TreeCtx {
  rootA: string;
  rootB: string;
  client: ReturnType<typeof createLiveClient>;
}

async function withTree(fn: (ctx: TreeCtx) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux05-04-'));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await mkdir(join(rootA, 'empty'), { recursive: true });
  await mkdir(join(rootA, 'many'), { recursive: true });
  await mkdir(rootB, { recursive: true });

  await writeFile(join(rootA, 'readme.md'), '# A\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'notes.md'), '# notes\n', 'utf8');
  await writeFile(join(rootA, 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  await writeFile(join(rootA, 'spec.pdf'), Buffer.from('%PDF-1.4\n', 'utf8'));
  await writeFile(join(rootA, 'app.js'), 'console.log(1)\n', 'utf8');
  await writeFile(join(rootA, 'data.json'), '{}\n', 'utf8');
  await writeFile(join(rootA, 'note.txt'), 'text\n', 'utf8');
  await writeFile(join(rootB, 'readme.md'), '# B\n', 'utf8');
  for (let i = 0; i < 25; i += 1) {
    await writeFile(join(rootA, 'many', `f${String(i).padStart(2, '0')}.md`), `# ${i}\n`, 'utf8');
  }

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

test('05-04-01 多项目根与子目录：条目与文件类型都正确可见', async () => {
  await withTree(async ({ client }) => {
    const rootA = applied(await client.listTree('project-a', ''));
    const names = rootA.entries!.map((e) => e.name).sort();
    assert.deepEqual(names, [
      'app.js',
      'data.json',
      'docs',
      'empty',
      'many',
      'note.txt',
      'pixel.png',
      'readme.md',
      'spec.pdf',
    ]);
    const byName = new Map(rootA.entries!.map((e) => [e.name, e]));
    assert.equal(byName.get('docs')?.kind, 'folder');
    assert.equal(byName.get('pixel.png')?.kind, 'file');
    assert.equal(byName.get('pixel.png')?.extension, '.png');
    assert.equal(byName.get('spec.pdf')?.extension, '.pdf');
    assert.equal(byName.get('app.js')?.extension, '.js');

    const docs = applied(await client.listTree('project-a', 'docs'));
    assert.deepEqual(docs.entries.map((e) => e.name), ['notes.md']);

    const rootB = applied(await client.listTree('project-b', ''));
    assert.deepEqual(rootB.entries.map((e) => e.name), ['readme.md'], 'B 只有自己的文件');
  });
});

test('05-04-02 空目录 / 不存在 / 不是目录：三态严格区分', async () => {
  await withTree(async ({ client }) => {
    const empty = applied(await client.listTree('project-a', 'empty'));
    assert.deepEqual(empty.entries, [], '空目录必须是"成功且为空"，不能是错误');

    const missing = await client.listTree('project-a', 'no-such-dir');
    assert.equal(missing.status, 'REJECTED');
    assert.equal(missing.errorCode, 'ERR_RESOURCE_NOT_FOUND', '不存在与"空"必须区分');

    const notDir = await client.listTree('project-a', 'readme.md');
    assert.equal(notDir.status, 'REJECTED');
    assert.equal(notDir.errorCode, 'ERR_RESOURCE_NOT_FOUND', '路径是文件时同样是"取不到目录"');
  });
});

test('05-04-03 分页完整：不截断、不重复、不漏项', async () => {
  await withTree(async ({ client }) => {
    const first = applied(await client.listTree('project-a', 'many', null, 10));
    assert.equal(first.page.total, 25);
    assert.equal(first.entries!.length, 10);
    assert.ok(first.page.nextCursor, '还有下一页时 nextCursor 不能为空');
    const snapshot = first.page.snapshot;

    const second = applied(
      await client.listTree('project-a', 'many', first.page.nextCursor, 10, snapshot),
    );
    assert.equal(second.entries.length, 10);

    const third = applied(
      await client.listTree('project-a', 'many', second.page.nextCursor, 10, snapshot),
    );
    assert.equal(third.entries.length, 5);
    assert.equal(third.page.nextCursor, null, '最后一页必须显式收尾');

    const seen = [...first.entries, ...second.entries, ...third.entries].map((e) => e.name);
    assert.equal(new Set(seen).size, 25, '不得重复');
    assert.deepEqual(
      [...seen].sort(),
      Array.from({ length: 25 }, (_, i) => `f${String(i).padStart(2, '0')}.md`).sort(),
      '不得漏项',
    );
  });
});

test('05-04-04 目录在两页之间变化 → ERR_DIR_CHANGED（不静默漏项）', async () => {
  await withTree(async ({ rootA, client }) => {
    const first = applied(await client.listTree('project-a', 'many', null, 10));
    const snapshot = first.page.snapshot;

    // 在第一页之后插入一个排在很前面的文件
    await writeFile(join(rootA, 'many', 'f00a-new.md'), '# new\n', 'utf8');

    const next = await client.listTree('project-a', 'many', first.page.nextCursor, 10, snapshot);
    assert.equal(next.status, 'REJECTED');
    assert.equal(next.errorCode, 'ERR_DIR_CHANGED', '集合已变时必须让客户端刷新整层');
  });
});

test('05-04-05 junction 不被跟随：以 link 呈现且展开被拒绝，根外内容不泄露', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux05-04-link-'));
  const outside = join(base, 'outside');
  const root = join(base, 'project-a');
  await mkdir(outside, { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(join(outside, 'secret.txt'), 'TOP-SECRET\n', 'utf8');
  await writeFile(join(root, 'readme.md'), '# A\n', 'utf8');

  let junctionOk = true;
  try {
    await symlink(outside, join(root, 'escape'), 'junction');
  } catch {
    junctionOk = false;
  }
  if (!junctionOk) {
    await rm(base, { recursive: true, force: true });
    return; // 环境不支持 junction：由套件 14 的 storage 级用例兜底
  }

  const workspace: WorkspaceConfig = {
    version: 1,
    projects: [{ projectId: 'project-a', name: 'A', rootDir: root }],
  };
  const server = await createShellServer({ workspace, port: 0 });
  const client = createLiveClient(server.url);
  try {
    const rootPage = applied(await client.listTree('project-a', ''));
    const escape = rootPage.entries.find((e) => e.name === 'escape');
    assert.ok(escape, '链接本身可以作为条目出现');
    assert.equal(escape?.kind, 'link', 'junction 必须以 link 呈现，而不是 folder');

    const into = await client.listTree('project-a', 'escape');
    assert.equal(into.status, 'REJECTED', '不得进入链接');
    assert.ok(
      ['ERR_DIR_IS_LINK', 'ERR_PATH_OUTSIDE_ROOT', 'ERR_DIR_UNREADABLE'].includes(
        into.errorCode ?? '',
      ),
      `实际错误码: ${into.errorCode}`,
    );
    assert.equal(
      JSON.stringify(into).includes('TOP-SECRET'),
      false,
      '响应里绝不能出现根外内容',
    );
  } finally {
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

/* ------------------------------------------------------------------ */
/* Shell 归属层：刷新/移除只作用于一个项目                               */
/* ------------------------------------------------------------------ */

function makeLevelHarness() {
  const identity: TreeLoadIdentity = {
    mode: 'live',
    syncMode: 'live',
    workspaceKey: 'K1',
    epoch: 1,
    activeProjectId: 'p1',
  };
  const asIdentity = (): TreeLoadIdentity => ({ ...identity });
  const guard = createTreeOwnershipGuard(asIdentity);

  let state: WorkspaceState = {
    ...INITIAL_STATE,
    mode: 'live',
    workspaceMode: 'multi',
    workspaceKey: 'K1',
    projects: [
      { projectId: 'p1', name: 'P1', status: 'READY' },
      { projectId: 'p2', name: 'P2', status: 'READY' },
    ],
    activeProjectId: 'p1',
  };
  const actions: WorkspaceAction[] = [];
  const dispatch = (action: WorkspaceAction): void => {
    actions.push(action);
    state = workspaceReducer(state, action);
  };

  const calls: Array<{ projectId: string | null; dir: string; d: Deferred<TreeQueryOutcome> }> = [];
  const loader = createTreeLevelLoader(
    {
      identity: asIdentity,
      levels: (projectKey) => state.treeByProject[projectKey] ?? emptyLevels(),
      listTree: (request) => {
        const d = deferred<TreeQueryOutcome>();
        calls.push({ projectId: request.projectId, dir: request.dir, d });
        return d.promise;
      },
      dispatch,
    },
    guard,
  );

  return { identity, loader, guard, calls, actions, dispatch, state: () => state };
}

test('05-04-06 刷新 A 不清 B：作废与重载只作用于目标项目', async () => {
  const h = makeLevelHarness();

  // 两个项目各自的根层都加载好
  const loadA = h.loader.load('p1', '', false);
  h.calls[0].d.resolve(appliedPage(['a.md'], 'SA'));
  await loadA;
  const loadB = h.loader.load('p2', '', false);
  h.calls[1].d.resolve(appliedPage(['b.md'], 'SB'));
  await loadB;

  const bLevelBefore = h.state().treeByProject.p2[''];
  assert.equal(bLevelBefore?.status, 'ready');

  // 刷新 A（Provider 的真实顺序：先作废该项目在途票据，再重载根层）
  h.loader.invalidateProject('p1');
  const reloadA = h.loader.load('p1', '', false);
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].projectId, 'p1');
  h.calls[2].d.resolve(appliedPage(['a.md', 'a2.md'], 'SA2'));
  await reloadA;

  assert.equal(
    h.state().treeByProject.p2[''],
    bLevelBefore,
    'B 的层对象必须原样保留（不被重建、不被清空）',
  );
  assert.deepEqual(
    h.state().treeByProject.p2['']?.entries?.map((e) => e.name),
    ['b.md'],
  );
});

test('05-04-07 移除 A 后迟到的目录响应：不再回填，也不会重建 A 的节点', async () => {
  const h = makeLevelHarness();

  const late = h.loader.load('p1', 'docs', false);
  assert.equal(h.calls.length, 1);

  // 移除 A：Provider 先 invalidateProject，再派发 PROJECT_REMOVED
  h.loader.invalidateProject('p1');
  h.dispatch({ type: 'PROJECT_REMOVED', projectId: 'p1' });
  const afterRemove = h.state().treeByProject.p1;
  assert.equal(afterRemove, undefined, '移除后该项目的层表必须清空');

  const actionCount = h.actions.length;
  h.calls[0].d.resolve(appliedPage(['secret.md'], 'SA'));
  const outcome = await late;

  assert.equal(outcome, 'stale', '迟到的响应属于已移除项目，必须作废');
  assert.equal(h.actions.length, actionCount, '作废的响应不得派发任何动作');
  assert.equal(h.state().treeByProject.p1, undefined, '不得把已移除项目的节点重新长出来');
});

test('05-04-08 折叠再展开：展开状态变化不触碰层表，因此复用缓存', async () => {
  const h = makeLevelHarness();
  const first = h.loader.load('p1', 'docs', false);
  h.calls[0].d.resolve(appliedPage(['x.md']));
  await first;

  const before = h.state().treeByProject.p1['docs'];
  assert.equal(before?.status, 'ready');

  // 折叠 / 展开只改 expandedByProject（纯界面状态），不得使层清空或重读
  h.dispatch({ type: 'TOGGLE_NODE', path: 'docs' });
  h.dispatch({ type: 'TOGGLE_NODE', path: 'docs' });

  assert.equal(
    h.state().treeByProject.p1['docs'],
    before,
    '层对象必须保持同一引用（折叠/展开不产生重读）',
  );
  assert.equal(h.calls.length, 1, '全程只有最初那一次请求');
});
