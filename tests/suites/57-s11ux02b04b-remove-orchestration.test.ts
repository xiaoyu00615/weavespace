/**
 * UX-02B-04B：Shell 移除编排（`remove-project.ts`）—— opId 链路与结果恢复。
 *
 * 用 deferred 端口精确制造"超时 / 结果未知"，证明：
 * - opId 在**提交前**落定并随 remove 发出；
 * - remove 结果不确定时**不再重发 remove**，改为按 opId 查永久证据；
 * - 命中 `revoked` → 移除生效；`unknown` → 只读刷新列表 + 提示人工核对；
 * - 工作区切走后迟到结果不回填（不清缓存、不刷新列表）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ProjectSummary,
  RemoveProjectOutcome,
  RemovalOpOutcome,
  RemovalPrecheckOutcome,
} from '../../apps/shell/src/client/client-api.ts';
import {
  createProjectRemover,
  type ProjectRemover,
  type RemoveProjectHost,
  type RemoveProjectPort,
  type RemoveUiResult,
} from '../../apps/shell/src/state/remove-project.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import { emptyLevels } from '../../apps/shell/src/components/tree-model.ts';

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

interface Harness {
  remover: ProjectRemover;
  identity: { mode: 'demo' | 'live'; epoch: number };
  removeCalls: Array<{ projectId: string; opId: string }>;
  precheckCalls: string[];
  queryCalls: string[];
  getListCalls(): number;
  removed: string[];
  appliedProjects: ProjectSummary[][];
  removeDeferred(): Deferred<RemoveProjectOutcome>;
  queryDeferred(): Deferred<RemovalOpOutcome>;
  listDeferred(): Deferred<ProjectSummary[]>;
  precheckDeferred(): Deferred<RemovalPrecheckOutcome>;
}

function makeHarness(): Harness {
  const identity = { mode: 'live' as const, epoch: 1 };
  const removeCalls: Harness['removeCalls'] = [];
  const precheckCalls: string[] = [];
  const queryCalls: string[] = [];
  const removed: string[] = [];
  const appliedProjects: ProjectSummary[][] = [];
  let listCalls = 0;
  const removeDs: Deferred<RemoveProjectOutcome>[] = [];
  const queryDs: Deferred<RemovalOpOutcome>[] = [];
  const listDs: Deferred<ProjectSummary[]>[] = [];
  const precheckDs: Deferred<RemovalPrecheckOutcome>[] = [];

  const port: RemoveProjectPort = {
    removalPrecheck: (pid) => {
      precheckCalls.push(pid);
      const d = deferred<RemovalPrecheckOutcome>();
      precheckDs.push(d);
      return d.promise;
    },
    removeProject: (pid, opId) => {
      removeCalls.push({ projectId: pid, opId });
      const d = deferred<RemoveProjectOutcome>();
      removeDs.push(d);
      return d.promise;
    },
    queryRemovalOp: (opId) => {
      queryCalls.push(opId);
      const d = deferred<RemovalOpOutcome>();
      queryDs.push(d);
      return d.promise;
    },
    listProjects: () => {
      listCalls += 1;
      const d = deferred<ProjectSummary[]>();
      listDs.push(d);
      return d.promise;
    },
  };

  const host: RemoveProjectHost = {
    port,
    newOpId: () => 'op-fixed-0001',
    identity: () => ({ ...identity }),
    isCurrent: (epoch) => identity.epoch === epoch,
    onRemoved: (pid) => removed.push(pid),
    onProjects: (projects) => appliedProjects.push(projects),
  };

  return {
    remover: createProjectRemover(host),
    identity,
    removeCalls,
    precheckCalls,
    queryCalls,
    getListCalls: () => listCalls,
    removed,
    appliedProjects,
    removeDeferred: () => removeDs[removeDs.length - 1],
    queryDeferred: () => queryDs[queryDs.length - 1],
    listDeferred: () => listDs[listDs.length - 1],
    precheckDeferred: () => precheckDs[precheckDs.length - 1],
  };
}

/** 让已排队的微任务推进（deferred 链）。 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/* ------------------------------------------------------------------ */

test('PB-06-01 APPLIED：opId 提交前落定、只发一次 remove、命中即移除', async () => {
  const h = makeHarness();
  const p = h.remover.remove('p-a');
  assert.equal(h.removeCalls.length, 1, '必须发一次 remove');
  assert.equal(h.removeCalls[0].opId, 'op-fixed-0001', 'opId 必须在提交前落定并随请求发出');
  h.removeDeferred().resolve({ status: 'APPLIED', projectId: 'p-a', opId: 'op-fixed-0001', configPersisted: true });
  const result = await p;
  assert.equal(result.kind, 'removed');
  assert.deepEqual(h.removed, ['p-a']);
  assert.equal(h.queryCalls.length, 0, '成功时不需要查询');
});

test('PB-01-01 ABORTED：返回 blocked + blockedBy，且不清缓存', async () => {
  const h = makeHarness();
  const p = h.remover.remove('p-a');
  h.removeDeferred().resolve({ status: 'ABORTED', projectId: 'p-a', blockedBy: ['ACTIVE_VIEWS'] });
  const result = await p;
  assert.equal(result.kind, 'blocked');
  assert.deepEqual(result.kind === 'blocked' ? result.blockedBy : [], ['ACTIVE_VIEWS']);
  assert.deepEqual(h.removed, [], '被拒时不得移除');
});

test('PB-06-02 超时(REJECTED) → 按 opId 查证据命中 revoked：判为已移除（不重发 remove）', async () => {
  const h = makeHarness();
  const p = h.remover.remove('p-a');
  h.removeDeferred().resolve({ status: 'REJECTED', errorCode: 'ERR_OUTCOME_UNKNOWN', message: 'timeout', httpStatus: 0 });
  await flush();
  assert.equal(h.removeCalls.length, 1, '超时后绝不自动重发 remove');
  assert.equal(h.queryCalls.length, 1, '必须按 opId 查询持久证据');
  assert.equal(h.queryCalls[0], 'op-fixed-0001');
  h.queryDeferred().resolve({ status: 'APPLIED', opId: 'op-fixed-0001', outcome: 'revoked', projectId: 'p-a' });
  const result = await p;
  assert.equal(result.kind, 'removed');
  assert.deepEqual(h.removed, ['p-a']);
});

test('PB-06-03 超时 → 查询 unknown：只读刷新列表 + 提示人工核对，且不自动重试', async () => {
  const h = makeHarness();
  const p = h.remover.remove('p-a');
  h.removeDeferred().resolve({ status: 'REJECTED', errorCode: null, message: 'timeout', httpStatus: 0 });
  await flush();
  h.queryDeferred().resolve({ status: 'APPLIED', opId: 'op-fixed-0001', outcome: 'unknown', projectId: null });
  await flush();
  assert.equal(h.getListCalls(), 1, '结果不确定时必须只读刷新项目列表');
  h.listDeferred().resolve([{ projectId: 'p-a', name: 'A', status: 'READY' }]);
  const result: RemoveUiResult = await p;
  assert.equal(result.kind, 'unknown');
  assert.match(result.kind === 'unknown' ? result.message : '', /核对|不确定|重试/, '必须说明结果仍需核对且不自动重试');
  assert.deepEqual(h.removed, [], '结果不确定时不得在本地移除项目');
  assert.equal(h.removeCalls.length, 1, '始终只有一次 remove（绝不自动重试）');
});

test('PB-06-04 查询端点本身失败 → 仍不重试 remove，刷新列表后 unknown', async () => {
  const h = makeHarness();
  const p = h.remover.remove('p-a');
  h.removeDeferred().resolve({ status: 'REJECTED', errorCode: 'ERR_STORAGE_IO', message: 'e', httpStatus: 502 });
  await flush();
  h.queryDeferred().resolve({ status: 'REJECTED', errorCode: 'ERR_COMMAND_UNSUPPORTED', message: 'op 501', httpStatus: 501 });
  await flush();
  assert.equal(h.getListCalls(), 1);
  h.listDeferred().reject(new Error('list failed'));
  const result = await p;
  assert.equal(result.kind, 'unknown');
  assert.equal(h.removeCalls.length, 1, '不得自动重试');
});

test('PB-05-03 501 → unsupported（Demo/静态/Legacy），不发查询也不刷新', async () => {
  const h = makeHarness();
  const p = h.remover.remove('p-a');
  h.removeDeferred().resolve({ status: 'REJECTED', errorCode: 'ERR_COMMAND_UNSUPPORTED', message: '不支持', httpStatus: 501 });
  const result = await p;
  assert.equal(result.kind, 'unsupported');
  assert.equal(h.queryCalls.length, 0);
  assert.equal(h.getListCalls(), 0);
});

test('迟到（提交期间 epoch 变）→ 结果不回填、不清缓存', async () => {
  const h = makeHarness();
  const p = h.remover.remove('p-a');
  h.identity.epoch = 2; // 切模式 / 重连
  h.removeDeferred().resolve({ status: 'APPLIED', projectId: 'p-a', opId: 'op-fixed-0001', configPersisted: true });
  const result = await p;
  assert.equal(result.kind, 'unknown');
  assert.deepEqual(h.removed, [], '切走后不得把结果写进新工作区');
});

test('Demo 模式直接 unsupported（不触碰端口）', async () => {
  const h = makeHarness();
  h.identity.mode = 'demo';
  const result = await h.remover.remove('p-a');
  assert.equal(result.kind, 'unsupported');
  assert.equal(h.removeCalls.length, 0);
});

test('removalPrecheck 透传端口（只读）', async () => {
  const h = makeHarness();
  const p = h.remover.precheck('p-a');
  h.precheckDeferred().resolve({ status: 'APPLIED', projectId: 'p-a', allowed: false, blockedBy: ['DIRTY'], state: 'ACTIVE' });
  const pre = await p;
  assert.equal(pre.status, 'APPLIED');
  assert.deepEqual(pre.status === 'APPLIED' ? pre.blockedBy : [], ['DIRTY']);
});

/* ---------------- R1-01 · 真实网络异常（Promise reject / AbortError）---------------- */

test('R1-01-01 remove 端口 reject（断线 / Abort）→ 收敛为 unknown：一次 op 查询 + 一次只读刷新，绝不重发', async () => {
  const h = makeHarness();
  const p = h.remover.remove('p-a');
  assert.equal(h.removeCalls.length, 1);
  h.removeDeferred().reject(Object.assign(new Error('network down'), { name: 'TypeError' }));
  await flush();

  assert.equal(h.queryCalls.length, 1, '必须保留原 opId 并只查一次持久证据');
  assert.equal(h.queryCalls[0], 'op-fixed-0001', '查询必须用提交前落定的原 opId');
  h.queryDeferred().resolve({ status: 'APPLIED', opId: 'op-fixed-0001', outcome: 'unknown', projectId: null });
  await flush();

  assert.equal(h.getListCalls(), 1, '无证据时必须只读刷新项目列表');
  h.listDeferred().resolve([{ projectId: 'p-a', name: 'A', status: 'READY' }]);
  const result = await p;

  assert.equal(result.kind, 'unknown', '端口 reject 不能把异常抛给界面（否则模态永久停在 removing）');
  assert.equal(h.removeCalls.length, 1, '绝不自动重发 remove');
  assert.deepEqual(h.removed, [], '结果不明时不得在本地移除项目');
});

test('R1-01-02 remove 端口 reject，但 op 证据命中本次 opId → 判为已移除', async () => {
  const h = makeHarness();
  const p = h.remover.remove('p-a');
  h.removeDeferred().reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  await flush();
  h.queryDeferred().resolve({ status: 'APPLIED', opId: 'op-fixed-0001', outcome: 'revoked', projectId: 'p-a' });
  const result = await p;

  assert.equal(result.kind, 'removed', '持久证据优先于丢失的响应');
  assert.deepEqual(h.removed, ['p-a']);
  assert.equal(h.removeCalls.length, 1);
});

test('R1-01-03 同一项目的重复确认不得并发发出多个 remove（共享同一次提交）', async () => {
  const h = makeHarness();
  const first = h.remover.remove('p-a');
  const second = h.remover.remove('p-a');
  assert.equal(h.removeCalls.length, 1, '并发确认必须复用同一次提交');

  h.removeDeferred().resolve({ status: 'APPLIED', projectId: 'p-a', opId: 'op-fixed-0001', configPersisted: true });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.kind, 'removed');
  assert.equal(b.kind, 'removed', '两次确认必须得到同一个结论');
  assert.deepEqual(h.removed, ['p-a'], '不得重复清理/重复派发');
});

test('R1-01-04 查询端点自身 reject → 仍返回 unknown（不抛出、不重发 remove）', async () => {
  const h = makeHarness();
  const p = h.remover.remove('p-a');
  h.removeDeferred().reject(new Error('offline'));
  await flush();
  h.queryDeferred().reject(new Error('op endpoint down'));
  await flush();
  assert.equal(h.getListCalls(), 1);
  h.listDeferred().reject(new Error('list down'));
  const result = await p;
  assert.equal(result.kind, 'unknown');
  assert.equal(h.removeCalls.length, 1);
});

/* ---------------- R1-02-05 · 证据归属：A 的 opId 不能被 B 认领 ---------------- */

test('R1-02-05 op 证据属于另一个项目 → 不得认领为"本项目已移除"', async () => {
  const h = makeHarness();
  const p = h.remover.remove('p-a');
  h.removeDeferred().resolve({ status: 'REJECTED', errorCode: null, message: 'timeout', httpStatus: 0 });
  await flush();
  // 这个 opId 的持久证据其实属于另一个项目
  h.queryDeferred().resolve({ status: 'APPLIED', opId: 'op-fixed-0001', outcome: 'revoked', projectId: 'p-other' });
  await flush();
  assert.equal(h.getListCalls(), 1, '归属不符 → 只能按未知处理并刷新列表');
  h.listDeferred().resolve([{ projectId: 'p-a', name: 'A', status: 'READY' }]);
  const result = await p;

  assert.equal(result.kind, 'unknown', '不得把别的项目的撤销证据算成本次移除');
  assert.deepEqual(h.removed, [], '不得在本地移除 p-a');
});

test('R1-03-07 PROJECT_REMOVED 收掉被移除项目的标签，其它项目的标签/草稿原样保留', () => {
  const tab = (docId: string, projectId: string | null, buffer: string, dirty: boolean) => ({
    docId,
    projectId,
    path: `${docId}.md`,
    title: docId,
    extension: '.md',
    buffer,
    dirty,
    mode: 'live' as const,
    sessionId: `s-${docId}`,
    viewId: `v-${docId}`,
    baseVersion: 'v1',
    revision: 1,
    documentState: dirty ? 'EDITING_DIRTY' : 'CLEAN',
    saving: false,
    lastStatus: (dirty ? 'UNKNOWN' : 'COMMITTED') as 'COMMITTED' | 'UNKNOWN',
    errorCode: null,
  });
  const before = {
    ...INITIAL_STATE,
    mode: 'live' as const,
    workspaceMode: 'multi' as const,
    projects: [
      { projectId: 'p-a', name: 'A', status: 'READY' as const },
      { projectId: 'p-b', name: 'B', status: 'READY' as const },
    ],
    tabs: [tab('a1', 'p-a', 'draft-a', true), tab('b1', 'p-b', 'draft-b', true)],
    panes: { primary: { docId: 'a1', mode: 'editor' as const }, secondary: { docId: null, mode: 'preview' as const } },
  };
  const next = workspaceReducer(before, { type: 'PROJECT_REMOVED', projectId: 'p-a' });

  assert.deepEqual(next.tabs.map((t) => t.docId), ['b1'], '被移除项目的标签必须收掉');
  assert.equal(next.tabs[0].buffer, 'draft-b', '其它项目的草稿内容不得被改动');
  assert.equal(next.tabs[0].dirty, true, '其它项目的未保存状态不得被清掉');
  assert.notEqual(next.panes.primary.docId, 'a1', '窗格不得继续指向已经不存在的标签');
  assert.equal(next.panes.primary.docId, 'b1');
});

test('PROJECT_REMOVED 只清被移除项目：其它项目树/展开/选中引用不变，活动项目回退', () => {
  const projects: ProjectSummary[] = [
    { projectId: 'p-a', name: 'A', status: 'READY' },
    { projectId: 'p-b', name: 'B', status: 'READY' },
  ];
  const treeB = emptyLevels();
  const before = {
    ...INITIAL_STATE,
    mode: 'live' as const,
    workspaceMode: 'multi' as const,
    projects,
    activeProjectId: 'p-a',
    treeByProject: { 'p-a': emptyLevels(), 'p-b': treeB },
    expandedByProject: { 'p-a': { x: true }, 'p-b': { y: true } },
    selectedByProject: { 'p-a': 'a/x', 'p-b': 'b/y' },
    loadingByProject: { 'p-a': true, 'p-b': false },
  };
  const next = workspaceReducer(before, { type: 'PROJECT_REMOVED', projectId: 'p-a' });
  assert.deepEqual(next.projects.map((p) => p.projectId), ['p-b']);
  assert.equal(next.activeProjectId, 'p-b', '活动项目应回退到剩余 READY 项目');
  assert.equal('p-a' in next.treeByProject, false, '被移除项目的树缓存必须清空');
  assert.equal('p-a' in next.expandedByProject, false);
  assert.equal('p-a' in next.selectedByProject, false);
  assert.equal('p-a' in next.loadingByProject, false);
  assert.equal(next.treeByProject['p-b'], treeB, '其它项目树引用必须原样保留');
  assert.deepEqual(next.expandedByProject['p-b'], { y: true });
});

