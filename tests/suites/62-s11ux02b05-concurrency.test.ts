/**
 * UX-02B-05-01：跨项目并发与 workspaceKey。
 *
 * 本套件只做**集成验收**，不引入新功能。两个层面：
 *
 * 1) Shell 装配层（deferred + 可控定时器）：两个项目同时/交错移除时，
 *    提交、单飞、身份同步、写入门禁必须保持一致；
 * 2) 真实 Host：并发 remove 必须服从 Host 既有的全局事务互斥——
 *    不允许两个项目"同时撤销成功"，也不允许同一项目出现第二条墓碑。
 *
 * 关键不变量：
 * - 同一项目的单飞继续有效（跨项目并发不得把它打散）；
 * - 不同项目并发由 Host 的 `mutating` 全局锁裁决（409 ERR_PROJECT_BUSY），
 *   客户端不得绕过，也不得把 busy 说成成功；
 * - 结构变化未确认前，新项目集合不能写到旧 workspaceKey；
 * - **迟到的健康检查不得覆盖当前工作区身份**（乱序返回）。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type {
  ProjectSummary,
  RemoveProjectOutcome,
  RemovalOpOutcome,
  RemovalPrecheckOutcome,
  WorkspaceIdentity,
} from '../../apps/shell/src/client/client-api.ts';
import { createShellServer } from '../../apps/server/src/server.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { serializeConfig } from '../../apps/server/src/store/config.ts';
import { rootTokenOf } from '../../packages/storage/path-safety.ts';
import {
  createRemoveProjectAction,
  type RemoveProjectAction,
  type RemoveUiResult,
} from '../../apps/shell/src/state/remove-project.ts';
import {
  createWorkspaceIdentitySync,
  createWorkspaceKeyApplier,
  createWorkspaceKeyRevision,
  settleIdentitySync,
  type IdentitySyncOutcome,
} from '../../apps/shell/src/state/workspace-identity-sync.ts';
import {
  createWorkspaceAutosave,
  serializeWorkspace,
  type PersistedWorkspaceV1,
  type WorkspaceStore,
} from '../../apps/shell/src/state/workspace-persistence.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import type { WorkspaceState } from '../../apps/shell/src/state/types.ts';
import { createWorkspaceWriteGate } from '../../apps/shell/src/state/workspace-write-gate.ts';

const KEY_AB = 'a'.repeat(64);
const KEY_A = 'b'.repeat(64);
const KEY_B = 'c'.repeat(64);

const P_A: ProjectSummary = { projectId: 'p-a', name: 'A', status: 'READY' };
const P_B: ProjectSummary = { projectId: 'p-b', name: 'B', status: 'READY' };

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

function manualTimers() {
  const queue: Array<{ id: number; fn: () => void }> = [];
  let next = 1;
  return {
    setTimer: (fn: () => void): number => {
      const id = next;
      next += 1;
      queue.push({ id, fn });
      return id;
    },
    clearTimer: (handle: unknown): void => {
      const index = queue.findIndex((item) => item.id === handle);
      if (index >= 0) queue.splice(index, 1);
    },
    tick(): number {
      const due = queue.splice(0);
      for (const item of due) item.fn();
      return due.length;
    },
    pending: (): number => queue.length,
  };
}

interface StoreSpy extends WorkspaceStore {
  writes: PersistedWorkspaceV1[];
  cleared: string[];
}

function storeSpy(): StoreSpy {
  const byKey = new Map<string, PersistedWorkspaceV1>();
  const writes: PersistedWorkspaceV1[] = [];
  const cleared: string[] = [];
  return {
    writes,
    cleared,
    write(snapshot) {
      writes.push(snapshot);
      byKey.set(snapshot.workspaceKey, snapshot);
      return 'written';
    },
    read(workspaceKey) {
      return byKey.get(workspaceKey) ?? null;
    },
    readLast() {
      return writes.length > 0 ? writes[writes.length - 1] : null;
    },
    clear(workspaceKey) {
      cleared.push(workspaceKey);
      byKey.delete(workspaceKey);
    },
  };
}

/**
 * 复刻 Provider 装配：门禁 → 自动保存 → 身份同步 → 移除编排器 → reducer。
 * 移除端口用 deferred 控制，便于把"在途 / 身份检查未回"拉成可断言的窗口。
 */
function assemble() {
  const gate = createWorkspaceWriteGate();
  /** 身份修订号：与身份同步共用（UX-02B-05-E）。 */
  const revision = createWorkspaceKeyRevision();
  const store = storeSpy();
  const timers = manualTimers();
  const probes: Deferred<WorkspaceIdentity>[] = [];
  const epoch = { value: 1 };
  const removed: string[] = [];
  const notices: string[] = [];
  const removeCalls: Array<{ projectId: string; opId: string }> = [];
  const removeDs: Deferred<RemoveProjectOutcome>[] = [];
  const opQueries: string[] = [];
  let opIdCalls = 0;

  let state: WorkspaceState = {
    ...INITIAL_STATE,
    mode: 'live',
    workspaceMode: 'multi',
    workspaceKey: KEY_AB,
    projects: [P_A, P_B],
    activeProjectId: 'p-a',
    tabs: [],
  };

  const autosave = createWorkspaceAutosave({
    store,
    gate,
    delayMs: 400,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    snapshot: () => serializeWorkspace(state, { workspaceKey: state.workspaceKey }),
  });

  const identitySync = createWorkspaceIdentitySync({
    port: {
      workspaceIdentity: () => {
        const d = deferred<WorkspaceIdentity>();
        probes.push(d);
        return d.promise;
      },
    },
    currentKey: () => state.workspaceKey,
    isCurrent: (value) => epoch.value === value,
    revision,
    onWorkspaceKey: (workspaceKey) => {
      state = workspaceReducer(state, { type: 'SET_WORKSPACE_KEY', workspaceKey });
    },
    onDropRecord: (workspaceKey) => store.clear(workspaceKey),
  });

  const syncIdentity = async (value: number): Promise<IdentitySyncOutcome> => {
    const outcome = await identitySync.refresh(value);
    if (settleIdentitySync(gate, outcome) === 'released') autosave.schedule();
    return outcome;
  };

  const action: RemoveProjectAction = createRemoveProjectAction({
    port: {
      removalPrecheck: (pid) => {
        const payload: RemovalPrecheckOutcome = {
          status: 'APPLIED',
          projectId: pid,
          allowed: true,
          blockedBy: [],
          state: 'ACTIVE',
        };
        return Promise.resolve(payload);
      },
      removeProject: (pid, opId) => {
        removeCalls.push({ projectId: pid, opId });
        const d = deferred<RemoveProjectOutcome>();
        removeDs.push(d);
        return d.promise;
      },
      queryRemovalOp: (opId) => {
        opQueries.push(opId);
        const payload: RemovalOpOutcome = {
          status: 'APPLIED',
          opId,
          outcome: 'unknown',
          projectId: null,
        };
        return Promise.resolve(payload);
      },
      listProjects: () =>
        Promise.resolve(state.projects.filter((p) => p.status === 'READY')),
    },
    newOpId: () => {
      opIdCalls += 1;
      return `op-c-${opIdCalls}`;
    },
    identity: () => ({ mode: 'live', epoch: epoch.value }),
    isCurrent: (value) => epoch.value === value,
    localBlockers: () => [],
    onRemoved: (pid) => {
      gate.holdIdentity();
      removed.push(pid);
      state = workspaceReducer(state, { type: 'PROJECT_REMOVED', projectId: pid });
    },
    onProjects: (projects) => {
      state = workspaceReducer(state, { type: 'SET_PROJECTS', projects });
    },
    syncIdentity,
    notify: (message) => notices.push(message),
  });

  /** 摘要落地：生产实现（`createWorkspaceKeyApplier`），与 Provider 共用同一条规则。 */
  const applier = createWorkspaceKeyApplier({
    revision,
    gate,
    setKey: (key) => {
      state = workspaceReducer(state, { type: 'SET_WORKSPACE_KEY', workspaceKey: key });
    },
    schedule: () => autosave.schedule(),
    onIdentityRecovered: () => notices.push('工作区身份已同步，自动保存已恢复'),
  });

  return {
    gate,
    store,
    timers,
    autosave,
    epoch,
    action,
    removed,
    notices,
    removeCalls,
    probes,
    opQueries,
    get opIdCalls() {
      return opIdCalls;
    },
    probe: (index: number) => probes[index],
    lastProbe: () => probes[probes.length - 1],
    removeDeferredFor: (projectId: string): Deferred<RemoveProjectOutcome> => {
      for (let i = removeCalls.length - 1; i >= 0; i -= 1) {
        if (removeCalls[i].projectId === projectId) return removeDs[i];
      }
      throw new Error(`没有 ${projectId} 的 remove 闸门`);
    },
    getState: () => state,
    applyWorkspaceKey(key: string | null) {
      applier.apply(key);
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

const APPLIED = (projectId: string, opId: string): RemoveProjectOutcome => ({
  status: 'APPLIED',
  projectId,
  opId,
  configPersisted: true,
});

/* ------------------------------------------------------------------ */
/* 05-01-01：A 在途时 B 发起移除                                        */
/* ------------------------------------------------------------------ */

test('05-01-01 A 在途时 B 也发起移除：两个请求都发出，B 被 Host 全局锁拒绝且不算成功', async () => {
  const h = assemble();

  const a = h.action.remove('p-a');
  const b = h.action.remove('p-b');

  assert.equal(h.removeCalls.length, 2, '跨项目并发不得被客户端单飞拦住');
  assert.deepEqual(
    h.removeCalls.map((c) => c.projectId),
    ['p-a', 'p-b'],
  );
  assert.notEqual(h.removeCalls[0].opId, h.removeCalls[1].opId, '每次操作各有自己的 opId');

  const busyResult: RemoveProjectOutcome = {
    status: 'REJECTED',
    errorCode: 'ERR_PROJECT_BUSY',
    message: '已有变更事务在执行',
    httpStatus: 409,
  };
  h.removeDeferredFor('p-b').resolve(busyResult);

  const bOutcome = await b;
  assert.equal(bOutcome.kind, 'failed', '被 Host 锁拒绝不是成功，也不是"结果未知"');
  assert.match(bOutcome.kind === 'failed' ? bOutcome.message : '', /已有变更事务/);
  assert.deepEqual(h.removed, [], 'B 没有发生撤销，不得清理任何状态');
  assert.equal(h.opQueries.length, 0, '明确的零变更拒绝不需要查证据');

  h.removeDeferredFor('p-a').resolve(APPLIED('p-a', h.removeCalls[0].opId));
  await flush();
  // 身份同步的探测此时才发出：先放行，再等操作收敛
  h.probe(0).resolve({ workspaceMode: 'multi', workspaceKey: KEY_B });
  const aOutcome = await a;
  assert.equal(aOutcome.kind, 'removed');
  assert.deepEqual(h.removed, ['p-a'], '只有 A 被撤销');

  assert.equal(h.getState().workspaceKey, KEY_B);
  assert.deepEqual(h.getState().projects.map((p) => p.projectId), ['p-b']);
});

/* ------------------------------------------------------------------ */
/* 05-01-02：A 已撤销、身份检查未返回时 B 移除                           */
/* ------------------------------------------------------------------ */

test('05-01-02 A 已撤销但身份检查未回时 B 移除：B 照常提交，最终身份以最后一次同步为准', async () => {
  const h = assemble();

  const a = h.action.remove('p-a');
  h.removeDeferredFor('p-a').resolve(APPLIED('p-a', h.removeCalls[0].opId));
  await flush();
  assert.equal(h.gate.identityPending(), true, 'A 的摘要还在探测中');
  assert.equal(h.probes.length, 1);

  // A 的身份检查还挂着，用户立刻移除 B
  const b = h.action.remove('p-b');
  assert.equal(h.removeCalls.length, 2, 'B 的提交不被 A 的身份同步阻塞');
  h.removeDeferredFor('p-b').resolve(APPLIED('p-b', h.removeCalls[1].opId));
  await flush();
  assert.equal(h.probes.length, 2, 'B 也发起了自己的身份检查');
  assert.equal(h.gate.identityPending(), true, '结构变化仍未确认，写入继续被拦住');

  // 先返回的是 B（最新一次）：空集合
  h.probe(1).resolve({ workspaceMode: 'multi', workspaceKey: null });
  await flush();
  assert.equal(h.getState().workspaceKey, null);

  // 再返回 A 的（属于更早的结构变化）
  h.probe(0).resolve({ workspaceMode: 'multi', workspaceKey: KEY_B });
  const [aOutcome, bOutcome] = await Promise.all([a, b]);

  assert.equal(aOutcome.kind, 'removed');
  assert.equal(bOutcome.kind, 'removed');
  assert.equal(h.getState().workspaceKey, null, '迟到结果不得覆盖当前身份');
  assert.deepEqual(h.getState().projects, []);

  h.timers.tick();
  assert.equal(h.store.writes.length, 0, '没有有效摘要就一条记录都不写');
});

/* ------------------------------------------------------------------ */
/* 05-01-03：健康检查乱序返回                                           */
/* ------------------------------------------------------------------ */

test('05-01-03 只读健康检查乱序返回：旧的那次不得改写摘要，也不得放开写入门禁', async () => {
  const h = assemble();

  const a = h.action.remove('p-a');
  h.removeDeferredFor('p-a').resolve(APPLIED('p-a', h.removeCalls[0].opId));
  await flush();

  const b = h.action.remove('p-b');
  h.removeDeferredFor('p-b').resolve(APPLIED('p-b', h.removeCalls[1].opId));
  await flush();
  assert.equal(h.probes.length, 2);

  // 乱序：新的先回（只剩… 假设用户又加回了一个项目，摘要为 KEY_A）
  h.probe(1).resolve({ workspaceMode: 'multi', workspaceKey: KEY_A });
  await flush();
  assert.equal(h.getState().workspaceKey, KEY_A);
  assert.equal(h.gate.identityPending(), false, '最新一次的结论已经确定身份');
  assert.deepEqual(h.store.cleared, [KEY_AB], '旧摘要的记录按最新结论清理');

  // 旧的迟到（它是"移除 A 之后、移除 B 之前"那一刻的摘要）
  h.probe(0).resolve({ workspaceMode: 'multi', workspaceKey: KEY_B });
  await Promise.all([a, b]);

  assert.equal(h.getState().workspaceKey, KEY_A, '迟到结果绝不能覆盖当前工作区身份');
  assert.deepEqual(h.store.cleared, [KEY_AB], '迟到结果也不得再清理别的记录');

  h.timers.tick();
  assert.equal(h.store.writes.length, 1);
  assert.equal(h.store.writes[0].workspaceKey, KEY_A, '写入只允许用当前身份');
});

/* ------------------------------------------------------------------ */
/* 05-01-04：移除期间自动保存 / pagehide / 刷新                         */
/* ------------------------------------------------------------------ */

test('05-01-04 移除期间 400ms 到点与 pagehide flush：都写不出旧摘要记录', async () => {
  const h = assemble();
  h.autosave.schedule();
  assert.equal(h.timers.pending(), 1);

  const a = h.action.remove('p-a');
  h.removeDeferredFor('p-a').resolve(APPLIED('p-a', h.removeCalls[0].opId));
  await flush();

  assert.equal(h.getState().workspaceKey, KEY_AB, '摘要还没换');
  assert.deepEqual(h.getState().projects.map((p) => p.projectId), ['p-b']);

  assert.equal(h.timers.tick(), 1, '定时器照常到点');
  assert.equal(h.store.writes.length, 0, '旧摘要一条都不写');
  assert.equal(h.autosave.flush(), 'held', 'pagehide flush 同样被拦住');

  h.probe(0).resolve({ workspaceMode: 'multi', workspaceKey: KEY_B });
  await a;
  h.timers.tick();
  assert.equal(h.store.writes.length, 1);
  assert.equal(h.store.writes[0].workspaceKey, KEY_B);
});

/* ------------------------------------------------------------------ */
/* 05-01-05：结果未知时不伪造成功、不自动重发                           */
/* ------------------------------------------------------------------ */

test('05-01-05 A 的响应丢失：只查一次证据、不重发、返回 UNKNOWN', async () => {
  const h = assemble();

  const a = h.action.remove('p-a');
  h.removeDeferredFor('p-a').reject(new Error('socket hang up'));
  await flush();
  // 结果不确定 → 编排器仍会做一次身份同步；这里放行它，才能观察最终结论
  h.probe(0).resolve({ workspaceMode: 'multi', workspaceKey: KEY_B });
  const outcome = await a;

  assert.equal(outcome.kind, 'unknown', '没有可靠证据时只能说结果未知');
  assert.equal(h.opQueries.length, 1, '只做一次只读证据查询');
  assert.equal(h.removeCalls.length, 1, '绝不自动重发 remove');
  assert.deepEqual(h.removed, [], '没有证据就不清理状态');
  assert.deepEqual(h.getState().projects.map((p) => p.projectId), ['p-a', 'p-b']);
});

/* ------------------------------------------------------------------ */
/* 05-01-06：跨项目并发下，同一项目的单飞仍然有效                        */
/* ------------------------------------------------------------------ */

test('05-01-06 跨项目并发时同一项目的单飞仍有效：A 只提交一次', async () => {
  const h = assemble();

  const a1 = h.action.remove('p-a');
  const a2 = h.action.remove('p-a');
  const b = h.action.remove('p-b');

  assert.equal(h.removeCalls.filter((c) => c.projectId === 'p-a').length, 1, 'A 只发一次');
  assert.equal(h.removeCalls.filter((c) => c.projectId === 'p-b').length, 1, 'B 各自独立');

  h.removeDeferredFor('p-b').resolve({
    status: 'REJECTED',
    errorCode: 'ERR_PROJECT_BUSY',
    message: '已有变更事务在执行',
    httpStatus: 409,
  });
  await b;

  h.removeDeferredFor('p-a').resolve(APPLIED('p-a', h.removeCalls[0].opId));
  await flush();
  h.probe(0).resolve({ workspaceMode: 'multi', workspaceKey: KEY_B });
  const [r1, r2] = await Promise.all([a1, a2]);
  assert.equal(r1.kind, 'removed');
  assert.equal(r2.kind, 'removed', '两次确认复用同一次操作');
  assert.deepEqual(h.removed, ['p-a'], '只清理一次');
});

/* ------------------------------------------------------------------ */
/* 05-01-07：真实 Host 的全局事务互斥                                   */
/* ------------------------------------------------------------------ */

const PROJ_A = 'proj-a';
const PROJ_B = 'proj-b';

test('05-01-07 真实 Host：并发 remove 服从全局事务锁（不双重撤销、不伪造成功）', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux05-'));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(rootA, 'readme.md'), '# A\n', 'utf8');
  await writeFile(join(rootB, 'readme.md'), '# B\n', 'utf8');

  const storeDir = join(base, 'store');
  await mkdir(storeDir, { recursive: true });
  const mk = (projectId: string, name: string, rootDir: string) => ({
    projectId,
    name,
    rootDir,
    canonicalRoot: realpathSync(rootDir),
    rootToken: rootTokenOf(rootDir),
    grantedAt: '2026-11-15T00:00:00.000Z',
    grantSource: 'os-dialog',
  });
  await writeFile(
    join(storeDir, 'workspace.json'),
    serializeConfig({
      version: 2,
      commitSeq: 0,
      issuedIds: [PROJ_A, PROJ_B],
      revoked: [],
      projects: [mk(PROJ_A, 'A', rootA), mk(PROJ_B, 'B', rootB)],
    }),
    'utf8',
  );

  const server = await createShellServer({
    port: 0,
    managedStore: { dir: storeDir, picker: createFakePicker([{ status: 'cancelled' }]) },
  });
  try {
    const tokenRes = await fetch(`${server.url}/api/session-token`);
    const token = ((await tokenRes.json()) as { token?: string }).token ?? '';
    const origin = new URL(server.url).origin;
    const remove = async (projectId: string, opId: string) => {
      const res = await fetch(`${server.url}/api/projects/remove`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ws-token': token, origin },
        body: JSON.stringify({ projectId, confirm: 'remove-from-workspace', opId }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    // 同时发出两个移除：Host 的 mutating 锁必须裁决，而不是两边都成功
    const [ra, rb] = await Promise.all([remove(PROJ_A, 'op-0501-aaaaaaaa'), remove(PROJ_B, 'op-0501-bbbbbbbb')]);
    const codes = [ra, rb].map((r) => ({ status: r.status, errorCode: r.body.errorCode ?? null }));
    for (const item of codes) {
      assert.ok(
        item.status === 200 || (item.status === 409 && item.errorCode === 'ERR_PROJECT_BUSY'),
        `并发移除只允许"成功"或"被事务锁拒绝"，实际: ${JSON.stringify(item)}`,
      );
    }

    // 项目列表必须与成功的那几次一致；不可能两个都失败（至少一个拿到锁）
    const listRes = await fetch(`${server.url}/api/projects`);
    const list = (await listRes.json()) as { projects?: { projectId: string }[] };
    const left = (list.projects ?? []).map((p) => p.projectId).sort();
    const applied = [ra, rb].filter((r) => r.status === 200).length;
    assert.equal(left.length, 2 - applied, '列表必须与成功次数一致');
    assert.ok(applied >= 1, '至少有一次移除真正提交（锁不会把两边都拒掉）');

    // 墓碑：每个项目最多一条，且只属于成功的那次 opId
    const log = await readFile(join(storeDir, 'revocations.jsonl'), 'utf8').catch(() => '');
    const tombstones = log
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { type?: string; projectId?: string; opId?: string })
      .filter((entry) => entry.type !== 'header');
    const perProject = new Map<string, number>();
    for (const tomb of tombstones) {
      perProject.set(tomb.projectId ?? '', (perProject.get(tomb.projectId ?? '') ?? 0) + 1);
    }
    for (const [, count] of perProject) assert.equal(count, 1, '同一项目不得出现第二条墓碑');
    assert.equal(tombstones.length, applied, '墓碑条数必须等于成功次数');

    // 被拒的那次零变更：它的 opId 不得留下任何证据
    const rejectedOp = [ra, rb].find((r) => r.status === 409);
    if (rejectedOp) {
      const used = tombstones.some((t) => t.opId === 'op-0501-aaaaaaaa' || t.opId === 'op-0501-bbbbbbbb');
      assert.ok(used, '成功那次的 opId 必须落了证据');
      const successOpIds = [ra, rb]
        .filter((r) => r.status === 200)
        .map((r) => (r.body as { opId?: string }).opId)
        .filter(Boolean);
      for (const tomb of tombstones) {
        if (successOpIds.length > 0) {
          assert.ok(
            successOpIds.includes(tomb.opId ?? ''),
            `墓碑 opId(${tomb.opId}) 必须来自成功响应`,
          );
        }
      }
    }
  } finally {
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});
