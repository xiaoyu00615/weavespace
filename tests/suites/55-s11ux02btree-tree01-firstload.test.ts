/**
 * TREE-01 真实首次加载修复（先红后绿）。
 *
 * 现场故障：向托管工作区添加项目后，自动展开的子目录一直停在「正在加载…」，
 * 手动刷新根目录才恢复。
 *
 * 根因：添加项目时 `settleApplied` 先 `loadRoot`（根层），根层落定后
 * `withInitialExpansion` 让一级目录展开，`TreeBranch` 的 effect 随即用**当前**
 * （旧的、尚未更新的）`workspaceKey` 发起子目录请求；随后 `onWorkspaceKey`
 * 合法地把工作区摘要更新成新值。等子目录响应回来，`TreeOwnershipGuard.isCurrent`
 * 发现 `workspaceKey` 不等，判为 stale —— 一个 dispatch 都不发，层就永久停在
 * `loading`。刷新根目录会 `invalidateProject` 推进项目代次并重发子层，所以能恢复。
 *
 * 修复：区分「同一会话内仅 workspaceKey 变化（自己提交）」与「真正切走」。
 * 前者用新 key **重发一次**（有上界），绝不把层留在"正在加载…"；后者维持 stale，
 * 由切模式 / 重连各自的层表重置负责，不误发。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { TreeQueryOutcome } from '../../apps/shell/src/client/client-api.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import { emptyLevels } from '../../apps/shell/src/components/tree-model.ts';
import {
  createTreeLevelLoader,
  createTreeOwnershipGuard,
  type TreeLoadIdentity,
} from '../../apps/shell/src/state/tree-load.ts';
import type { WorkspaceAction, WorkspaceState } from '../../apps/shell/src/state/types.ts';

/* ------------------------------- 夹具 ------------------------------- */

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

/** 让已排队的微任务/重发链推进到下一次 listTree 调用。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function appliedPage(names: readonly string[], snapshot = 'S'): TreeQueryOutcome {
  return {
    status: 'APPLIED',
    level: '',
    entries: names.map((name) => ({
      id: `doc:p1/${name}`,
      name,
      kind: 'file' as const,
      extension: '.md',
      relPath: name,
    })),
    page: { limit: 200, cursor: null, nextCursor: null, total: names.length, snapshot },
  };
}

interface LevelHarness {
  identity: { mode: 'live' | 'demo'; syncMode: 'live' | 'demo'; workspaceKey: string | null; epoch: number; activeProjectId: string | null };
  loader: ReturnType<typeof createTreeLevelLoader>;
  guard: ReturnType<typeof createTreeOwnershipGuard>;
  calls: Array<{ projectId: string | null; dir: string; d: Deferred<TreeQueryOutcome> }>;
  actions: WorkspaceAction[];
  state(): WorkspaceState;
}

/**
 * 用真实 `workspaceReducer` + 真实 `TreeOwnershipGuard` + 真实 `TreeLevelLoader`
 * 组装：identity 可变，listTree 由测试逐次放行，dispatch 落到真实 reducer 上，
 * 因此可以断言"层最终是 ready 还是永久 loading"。
 */
function makeLevelHarness(): LevelHarness {
  const identity: LevelHarness['identity'] = {
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
    projects: [{ projectId: 'p1', name: 'P1', status: 'READY' }],
    activeProjectId: 'p1',
  };
  const actions: WorkspaceAction[] = [];
  const dispatch = (action: WorkspaceAction): void => {
    actions.push(action);
    state = workspaceReducer(state, action);
  };

  const calls: LevelHarness['calls'] = [];
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

  return { identity, loader, guard, calls, actions, state: () => state };
}

/* ====================================================================== *
 * 核心：自己更新 workspaceKey 之后，子目录请求不得永久卡在 loading
 * ====================================================================== */

test('TREE-01-01 子目录在途时 workspaceKey 合法变化（添加项目）：必须用新 key 重发取回，不得卡在正在加载', async () => {
  const h = makeLevelHarness();
  const pending = h.loader.load('p1', 'docs', false);

  assert.equal(h.calls.length, 1, '首次必须真的发出子目录请求');
  assert.equal(h.state().treeByProject['p1']?.['docs']?.status, 'loading', 'BEGIN 之后层应为 loading');

  // 模拟 onWorkspaceKey：添加项目后工作区摘要**合法地**变化（epoch 不变）
  h.identity.workspaceKey = 'K2';
  // 第一个请求返回：此时票据因 workspaceKey 变化被判 stale（旧实现到此为止，层永久 loading）
  h.calls[0].d.resolve(appliedPage(['a.md']));

  await flush();
  assert.equal(h.calls.length, 2, '同一会话内仅 key 变化 → 必须重发，而不是把层留在 loading');

  h.calls[1].d.resolve(appliedPage(['a.md', 'b.md']));
  const outcome = await pending;

  assert.equal(outcome, 'applied', '重发成功后必须落到 applied');
  const level = h.state().treeByProject['p1']?.['docs'];
  assert.equal(level?.status, 'ready', '层最终必须是 ready，不能再停在 loading');
  assert.deepEqual(level?.entries.map((n) => n.name), ['a.md', 'b.md'], '必须展示新 key 取回的内容');
});

test('TREE-01-02 两个项目各自子目录都被自己更新 key 波及：两层都必须取回', async () => {
  const h = makeLevelHarness();
  // 先让 p1/docs 在途
  const docs = h.loader.load('p1', 'docs', false);
  // 再来 p1/src（仍在同一个旧 key 会话内）
  const src = h.loader.load('p1', 'src', false);
  assert.equal(h.calls.length, 2);

  // onWorkspaceKey：key 变化
  h.identity.workspaceKey = 'K2';
  h.calls[0].d.resolve(appliedPage(['guide.md']));
  h.calls[1].d.resolve(appliedPage(['index.js']));
  await flush();

  // 两层都必须各重发一次
  assert.equal(h.calls.length, 4, '每个受影响的层都要各自重发一次');
  h.calls[2].d.resolve(appliedPage(['guide.md']));
  h.calls[3].d.resolve(appliedPage(['index.js']));

  assert.equal(await docs, 'applied');
  assert.equal(await src, 'applied');
  assert.equal(h.state().treeByProject['p1']?.['docs']?.status, 'ready');
  assert.equal(h.state().treeByProject['p1']?.['src']?.status, 'ready');
});

/* ====================================================================== *
 * 边界：真正切走（代次 / 全局作废变化）不得重发，保持既有语义
 * ====================================================================== */

test('TREE-01-03 真正切走（epoch 推进）：旧子目录请求作废且不重发，不污染新会话', async () => {
  const h = makeLevelHarness();
  const pending = h.loader.load('p1', 'docs', false);
  assert.equal(h.calls.length, 1);

  // 切模式 / 重连：推进 epoch（不是自己更新 key）
  h.identity.epoch = 2;
  h.calls[0].d.resolve(appliedPage(['a.md']));

  const outcome = await pending;
  assert.equal(outcome, 'stale', '真正切走必须判 stale');
  assert.equal(h.calls.length, 1, '真正切走不得重发（避免把旧会话的数据带进新会话）');
});

test('TREE-01-04 invalidateAll（重新连接）同样不被当作"仅 key 变化"重发', async () => {
  const h = makeLevelHarness();
  const pending = h.loader.load('p1', 'docs', false);
  h.guard.invalidateAll(); // 模拟 connectWorkspace / switchMode 的全局作废
  // 只改 key 不够：作废序号变了，不属于"同一会话仅 key 变化"
  h.identity.workspaceKey = 'K2';
  h.calls[0].d.resolve(appliedPage(['a.md']));

  const outcome = await pending;
  assert.equal(outcome, 'stale');
  assert.equal(h.calls.length, 1, '全局作废之后不得重发');
});

/* ====================================================================== *
 * 上界：连续 key 抖动有次数上限，收敛为 stale，不无限重试
 * ====================================================================== */

test('TREE-01-05 连续 key 抖动有上界：最多重发有限次后收敛，不会无限打转', async () => {
  const h = makeLevelHarness();
  const pending = h.loader.load('p1', 'docs', false);

  // 每收到一次响应就把 key 改掉一次，制造"永远是我自己人但永远在变"的极端情形
  let guard = 0;
  const pump = async (): Promise<void> => {
    while (guard < 10) {
      await flush();
      const idx = h.calls.length - 1;
      if (idx < 0) return;
      const call = h.calls[idx];
      // 已放过的调用不再重复放
      const already = (call as unknown as { done?: boolean }).done;
      if (already) return;
      (call as unknown as { done?: boolean }).done = true;
      h.identity.workspaceKey = `K${guard + 2}`;
      call.d.resolve(appliedPage([`f${guard}.md`]));
      guard += 1;
    }
  };
  await pump();
  await flush();
  const outcome = await pending;

  // 无论重发多少次，都必须收敛（不是永远 loading），且调用次数有上限
  assert.ok(outcome === 'applied' || outcome === 'stale', `必须收敛，实际=${outcome}`);
  assert.ok(h.calls.length <= 1 + 2 + 1, `重发必须有上界，实际发出 ${h.calls.length} 次`);
  assert.notEqual(h.state().treeByProject['p1']?.['docs']?.status, 'loading', '最终不得停在 loading');
});
