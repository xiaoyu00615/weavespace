/**
 * UX-02B-05-E：移除与添加交错时的身份归属（只验证时序，不重做项目管理）。
 *
 * 复现路径（全部走真实生产模块：writeGate / identitySync / removeAction /
 * projectAdder / autosave / reducer）：
 *
 * 1. 项目 A、B，摘要 `keyAB`；
 * 2. 移除 A 成功 → `identitySync.refresh()` 发出健康检查，**暂不返回**；
 * 3. 添加 C 成功 → 04A 的收尾调用 `applyWorkspaceKey` 写入 `keyBC`；
 * 4. 旧身份检查**随后**才返回 `keyB`（"只剩 B"那一刻的结构）。
 *
 * `refresh()` 现有的失效机制是「代次 + 本次同步的 issued 序号」：
 * - 04A 添加流程**不推进** `loadEpoch`（它只登记项目、更新摘要），代次判定为真；
 * - 添加流程也**不经过** `refresh()`，`issued` 不增长，序号判定为真。
 * 于是旧探测被当成"当前结构"，把已经确认的 `keyBC` 覆盖回 `keyB`——界面里是
 * `{B,C}` 两个项目，恢复记录却挂在"只剩 B"的摘要上，下次启动必然认错工作区。
 *
 * 第二条同源缺口是异常分支：探测**抛错**时会把摘要置 `null`（待同步），
 * 即使添加流程刚刚确认过 `keyBC`。
 *
 * 归属规则必须是"最后一次**落定的身份**说了算"，而不是"最后一次**发起的探测**"。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ProjectSummary,
  RemoveProjectOutcome,
  RemovalOpOutcome,
  RemovalPrecheckOutcome,
  WorkspaceIdentity,
} from '../../apps/shell/src/client/client-api.ts';
import { createProjectAdder } from '../../apps/shell/src/state/add-project.ts';
import {
  createRemoveProjectAction,
  type RemoveProjectAction,
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

/** 三个不同项目集合的摘要：A+B、只剩 B、B+C。 */
const KEY_AB = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_BC = 'c'.repeat(64);

const P_A: ProjectSummary = { projectId: 'p-a', name: 'A', status: 'READY' };
const P_B: ProjectSummary = { projectId: 'p-b', name: 'B', status: 'READY' };
const P_C: ProjectSummary = { projectId: 'p-c', name: 'C', status: 'READY' };

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

/** 手动定时器：`tick()` 只跑**当前已排**的回调（模拟"400ms 到了"）。 */
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
 * 复刻 `DocumentActionsProvider` 的装配（同一批模块、同一条顺序）：
 * 门禁 → 自动保存 → 身份同步（含身份修订号）→ 摘要落地 → 移除编排 → reducer。
 */
function assemble(options: { projects?: ProjectSummary[] } = {}) {
  const gate = createWorkspaceWriteGate();
  const store = storeSpy();
  const timers = manualTimers();
  const probes: Deferred<WorkspaceIdentity>[] = [];
  const epoch = { value: 1 };
  const removed: string[] = [];
  const notices: string[] = [];
  const removeCalls: Array<{ projectId: string; opId: string }> = [];
  const removeDs: Deferred<RemoveProjectOutcome>[] = [];
  let opIdCalls = 0;

  let state: WorkspaceState = {
    ...INITIAL_STATE,
    mode: 'live',
    workspaceMode: 'multi',
    workspaceKey: KEY_AB,
    projects: options.projects ?? [P_A, P_B],
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

  /** 身份修订号：**任何**一处在界面里落定摘要（添加 / 移除后的同步 / 只读 resync）都推进。 */
  const revision = createWorkspaceKeyRevision();

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

  /** Provider 的 `applyWorkspaceKey`：添加流程与只读 resync 共用的摘要落地入口。 */
  const applier = createWorkspaceKeyApplier({
    revision,
    gate,
    setKey: (workspaceKey) => {
      state = workspaceReducer(state, { type: 'SET_WORKSPACE_KEY', workspaceKey });
    },
    schedule: () => autosave.schedule(),
    onIdentityRecovered: () => notices.push('工作区身份已同步，自动保存已恢复'),
  });

  /** Provider 的 `syncIdentity`：规则走共享纯函数，放开后重新排程。 */
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
      queryRemovalOp: () => {
        const payload: RemovalOpOutcome = {
          status: 'REJECTED',
          errorCode: null,
          message: '不该被调用',
          httpStatus: 0,
        };
        return Promise.resolve(payload);
      },
      listProjects: () => Promise.resolve([] as ProjectSummary[]),
    },
    newOpId: () => {
      opIdCalls += 1;
      return `op-e01-${opIdCalls}`;
    },
    identity: () => ({ mode: 'live', epoch: epoch.value }),
    isCurrent: (value) => epoch.value === value,
    localBlockers: () => [],
    onRemoved: (pid) => {
      // 真实顺序：先同步合上旧身份下的写入资格，再派发 PROJECT_REMOVED
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

  return {
    gate,
    store,
    timers,
    autosave,
    identitySync,
    revision,
    applier,
    epoch,
    action,
    removed,
    notices,
    removeCalls,
    probes,
    get opIdCalls() {
      return opIdCalls;
    },
    probe: () => probes[probes.length - 1],
    removeDeferred: () => removeDs[removeDs.length - 1],
    getState: () => state,
    /** Provider 的 `applyWorkspaceKey`。 */
    applyWorkspaceKey(key: string | null) {
      applier.apply(key);
    },
    setProjects(projects: ProjectSummary[]) {
      state = workspaceReducer(state, { type: 'SET_PROJECTS', projects });
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** 走真实的 04A 添加流程登记 C：项目表回填 + 末尾 `onWorkspaceKey(keyBC)`。 */
function addProjectC(h: ReturnType<typeof assemble>): Promise<unknown> {
  const keyPromise = deferred<string | null>();
  const adder = createProjectAdder({
    port: {
      bootstrap: () => Promise.resolve({ token: 't', intentId: 'i' }),
      startPick: () =>
        Promise.resolve({ status: 'PENDING' as const, requestId: 'r-c', httpStatus: 200 }),
      queryPick: () =>
        Promise.resolve({ status: 'APPLIED' as const, project: P_C, httpStatus: 200 }),
      listProjects: () => Promise.resolve([P_B, P_C]),
      workspaceKey: () => keyPromise.promise,
    },
    // 与 Provider 一致：添加流程读的是实时状态；本例故意**不推进** loadEpoch
    identity: () => ({ mode: 'live' as const, workspaceKey: h.getState().workspaceKey, epoch: h.epoch.value }),
    onProjects: (projects) => h.setProjects(projects),
    onWorkspaceKey: (key) => h.applyWorkspaceKey(key),
    loadRoot: () => Promise.resolve(),
  });

  const adding = adder.add('C');
  // 等添加流程走到"取摘要"这一步，再把 keyBC 交回去
  return (async () => {
    for (let i = 0; i < 20 && h.getState().projects.length !== 2; i += 1) await flush();
    keyPromise.resolve(KEY_BC);
    return adding;
  })();
}

/* ------------------------------------------------------------------ */
/* E-01：移除与添加交错                                                 */
/* ------------------------------------------------------------------ */

test('E-01-01 旧身份检查在添加成功后返回 keyB：不得覆盖已确认的 keyBC', async () => {
  const h = assemble();

  // ---- 移除 A：Host APPLIED，身份检查发出但暂不返回 ----
  const removing = h.action.remove('p-a');
  h.removeDeferred().resolve({
    status: 'APPLIED',
    projectId: 'p-a',
    opId: h.removeCalls[0].opId,
    configPersisted: true,
  });
  await flush();

  assert.deepEqual(
    h.getState().projects.map((p) => p.projectId),
    ['p-b'],
    '前置条件：A 已移除，此刻只剩 B',
  );
  assert.equal(h.probes.length, 1, '前置条件：移除后的身份检查已经在飞');
  assert.equal(h.gate.identityPending(), true, '前置条件：新摘要未知，写入先合上');

  // ---- 添加 C 成功：applyWorkspaceKey 写入 keyBC ----
  await addProjectC(h);
  assert.equal(h.getState().workspaceKey, KEY_BC, '前置条件：添加流程已确认 keyBC');
  assert.equal(h.gate.identityPending(), false, '前置条件：有效摘要到手，写入已放开');

  // ---- 旧身份检查（"只剩 B"那一刻）随后才返回 ----
  h.probe().resolve({ workspaceMode: 'multi', workspaceKey: KEY_B });
  await removing;

  assert.equal(
    h.getState().workspaceKey,
    KEY_BC,
    '旧探测属于已被取代的结构：不得把摘要改回"只剩 B"',
  );
  assert.equal(h.store.read(KEY_B), null, '不得为旧结构写恢复记录');

  h.timers.tick();
  const written = h.store.writes.map((w) => w.workspaceKey);
  assert.ok(
    written.every((key) => key === KEY_BC),
    `自动保存只能使用已确认的 keyBC，实际写入：${JSON.stringify(written)}`,
  );
  // 刷新后 Host 给出的就是 keyBC：记录必须能按它读到，否则等于丢工作区
  assert.notEqual(h.store.read(KEY_BC), null, 'keyBC 下的记录可被下次启动认领');
  assert.equal(h.store.read(KEY_B), null, '不得留下"只剩 B"的恢复记录');
});

test('E-01-02 旧身份检查在添加成功后抛错：不得把已确认的 keyBC 置回 null', async () => {
  const h = assemble();

  const removing = h.action.remove('p-a');
  h.removeDeferred().resolve({
    status: 'APPLIED',
    projectId: 'p-a',
    opId: h.removeCalls[0].opId,
    configPersisted: true,
  });
  await flush();
  assert.equal(h.probes.length, 1);

  await addProjectC(h);
  assert.equal(h.getState().workspaceKey, KEY_BC);

  // ---- 旧身份检查失败（Host 重启 / 超时都会这样）----
  h.probe().reject(new Error('ECONNRESET'));
  await removing;

  assert.equal(
    h.getState().workspaceKey,
    KEY_BC,
    '失败的是已被取代的探测：不能据此把已确认的身份打回"待同步"',
  );
  assert.equal(h.gate.identityPending(), false, '写入门禁保持放开');

  h.timers.tick();
  const written = h.store.writes.map((w) => w.workspaceKey);
  assert.deepEqual(written, [KEY_BC], '自动保存只能写 keyBC');
});
