/**
 * UX-02B-04B-R2E：两个连续操作边界。
 *
 * E-01「移除最后一个项目 → 再添加项目」：
 * 空项目集合下 Host 没有 `workspaceKey`（`/api/health` 不返回该字段），
 * `identitySync` 据此进入**待同步**并合上写入门禁——这是对的（不能凭空伪造
 * 一个空工作区摘要）。问题是 04A 的添加流程拿到新摘要后**没有释放**这扇门：
 * 新项目加进来了，自动保存却永远停摆，刷新后恢复记录一条都没有。
 *
 * E-02「单飞必须覆盖身份同步阶段」：
 * 第一次 remove 已经拿到 Host `APPLIED`，但新摘要的健康检查还 pending。
 * 这段窗口属于**同一次操作**；若此时再确认一次，不得再发第二个 remove、
 * 不得再生成第二个 opId、不得重复清理状态。
 *
 * 本套件复刻 `DocumentActionsProvider` 的真实装配（同一批模块、同一条顺序），
 * 不单独 new 一个编排器。
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

const OLD_KEY = 'a'.repeat(64);
const NEW_KEY = 'b'.repeat(64);

const P_A: ProjectSummary = { projectId: 'p-a', name: 'A', status: 'READY' };
const P_NEW: ProjectSummary = { projectId: 'p-new', name: 'New', status: 'READY' };

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
 * 复刻 `DocumentActionsProvider` 的装配：门禁 → 自动保存 → 身份同步 → 编排器 → reducer。
 *
 * 关键点：`onRemoved` 的顺序与 Provider 一致（**先** `holdIdentity()`，**再**派发
 * `PROJECT_REMOVED`）；`applyWorkspaceKey` 是添加 / 重新读取共用的摘要落地路径。
 */
function assemble(options: { projects?: ProjectSummary[] } = {}) {
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
  let opIdCalls = 0;

  let state: WorkspaceState = {
    ...INITIAL_STATE,
    mode: 'live',
    workspaceMode: 'multi',
    workspaceKey: OLD_KEY,
    projects: options.projects ?? [P_A],
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
    identitySync,
    epoch,
    action,
    removed,
    notices,
    removeCalls,
    probes,
    get opIdCalls() {
      return opIdCalls;
    },
    /** 最近一次身份探测的闸门。 */
    probe: () => probes[probes.length - 1],
    removeDeferred: () => removeDs[removeDs.length - 1],
    getState: () => state,
    /** 添加 / 重新读取路径的摘要落地：走生产实现（与 Provider 同一函数）。 */
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

/* ------------------------------------------------------------------ */
/* E-01：移除最后一个项目 → 再添加项目                                   */
/* ------------------------------------------------------------------ */

test('E-01-01 移除最后一个项目：空集合没有摘要 → 待同步、零写入（不伪造空工作区身份）', async () => {
  const h = assemble();

  const removing = h.action.remove('p-a');
  h.removeDeferred().resolve({
    status: 'APPLIED',
    projectId: 'p-a',
    opId: h.removeCalls[0].opId,
    configPersisted: true,
  });
  await flush();

  assert.deepEqual(h.getState().projects, [], '项目集合已经空了');
  assert.equal(h.gate.identityPending(), true, '新摘要还没拿到，写入必须先合上');

  h.probe().resolve({ workspaceMode: 'multi', workspaceKey: null });
  const result = await removing;

  assert.equal(result.kind, 'removed');
  assert.equal(h.getState().workspaceKey, null, '空集合不能凭空造一个摘要');
  assert.equal(h.gate.identityPending(), true, '待同步：继续保持拦住');
  assert.match(h.notices[0] ?? '', /工作区身份待同步/);

  h.timers.tick();
  assert.equal(h.autosave.flush(), 'held');
  assert.equal(h.store.writes.length, 0, '没有有效摘要就一条恢复记录都不写');
});

test('E-01-02 再添加一个项目、拿到有效摘要：写入资格自动恢复，写出的是新摘要', async () => {
  const h = assemble();

  // ---- 先移除最后一个项目，进入待同步 ----
  const removing = h.action.remove('p-a');
  h.removeDeferred().resolve({
    status: 'APPLIED',
    projectId: 'p-a',
    opId: h.removeCalls[0].opId,
    configPersisted: true,
  });
  await flush();
  h.probe().resolve({ workspaceMode: 'multi', workspaceKey: null });
  await removing;
  assert.equal(h.gate.identityPending(), true);

  // ---- 04A 添加流程成功：项目表回填 + 新摘要落地 ----
  h.setProjects([P_NEW]);
  h.applyWorkspaceKey(NEW_KEY);

  assert.equal(h.gate.identityPending(), false, '有效摘要到手后必须放开写入');
  assert.equal(h.getState().workspaceKey, NEW_KEY);

  assert.equal(h.timers.tick(), 1, '放开后应重新排一次自动保存');
  assert.equal(h.store.writes.length, 1);
  assert.equal(h.store.writes[0].workspaceKey, NEW_KEY, '只能写新摘要');
  assert.equal(h.store.writes[0].activeProjectId, 'p-new', '活动项目指向新加的项目');
  assert.match(
    h.notices[h.notices.length - 1] ?? '',
    /身份已同步/,
    '从"待同步"回到确定身份时要给出提示，别让状态栏继续挂着"待同步"',
  );
});

test('E-01-03 添加成功但摘要取不到：继续待同步，绝不伪造', async () => {
  const h = assemble();
  const removing = h.action.remove('p-a');
  h.removeDeferred().resolve({
    status: 'APPLIED',
    projectId: 'p-a',
    opId: h.removeCalls[0].opId,
    configPersisted: true,
  });
  await flush();
  h.probe().resolve({ workspaceMode: 'multi', workspaceKey: null });
  await removing;

  h.setProjects([P_NEW]);
  // 添加流程里 `workspaceKey()` 失败 → 不调用 onWorkspaceKey；等价于落地一个 null
  h.applyWorkspaceKey(null);

  assert.equal(h.gate.identityPending(), true, 'Host 身份不可确认时必须继续禁止写入');
  h.timers.tick();
  assert.equal(h.autosave.flush(), 'held');
  assert.equal(h.store.writes.length, 0);
});

test('E-01-04 旧请求迟到（代次已推进）：不得释放新工作区的门禁', async () => {
  const h = assemble();

  // 先把门禁推进"待同步"（移除最后一个项目、空集合没有摘要）
  const removing = h.action.remove('p-a');
  h.removeDeferred().resolve({
    status: 'APPLIED',
    projectId: 'p-a',
    opId: h.removeCalls[0].opId,
    configPersisted: true,
  });
  await flush();
  h.probe().resolve({ workspaceMode: 'multi', workspaceKey: null });
  await removing;
  assert.equal(h.gate.identityPending(), true, '前置条件：身份待同步');

  // 添加流程发起时是代次 1
  let keyPromise: Deferred<string | null> = deferred<string | null>();
  const adder = createProjectAdder({
    port: {
      bootstrap: () => Promise.resolve({ token: 't', intentId: 'i' }),
      startPick: () =>
        Promise.resolve({ status: 'PENDING' as const, requestId: 'r1', httpStatus: 200 }),
      queryPick: () =>
        Promise.resolve({ status: 'APPLIED' as const, project: P_NEW, httpStatus: 200 }),
      listProjects: () => Promise.resolve([P_NEW]),
      workspaceKey: () => keyPromise.promise,
    },
    identity: () => ({ mode: 'live', workspaceKey: h.getState().workspaceKey, epoch: h.epoch.value }),
    onProjects: (projects) => h.setProjects(projects),
    onWorkspaceKey: (key) => h.applyWorkspaceKey(key),
    loadRoot: () => Promise.resolve(),
  });

  const adding = adder.add();
  await flush();
  // 摘要请求还在飞的时候，用户切走了（代次推进）
  h.epoch.value = 2;
  keyPromise.resolve(NEW_KEY);
  const result = await adding;

  assert.equal(result.kind, 'stale', '旧代次的添加结果必须作废');
  assert.equal(h.gate.identityPending(), true, '迟到结果不得释放新工作区的门禁');
  assert.equal(h.getState().workspaceKey, null, '也不得把旧摘要写进新工作区');
  h.timers.tick();
  assert.equal(h.store.writes.length, 0, '仍然一条记录都不写');
});

test('E-01-05 刷新恢复：新摘要下的记录可被读取，且指向新项目', async () => {
  const h = assemble();

  const removing = h.action.remove('p-a');
  h.removeDeferred().resolve({
    status: 'APPLIED',
    projectId: 'p-a',
    opId: h.removeCalls[0].opId,
    configPersisted: true,
  });
  await flush();
  h.probe().resolve({ workspaceMode: 'multi', workspaceKey: null });
  await removing;

  h.setProjects([P_NEW]);
  h.applyWorkspaceKey(NEW_KEY);
  h.timers.tick();

  const last = h.store.readLast();
  assert.notEqual(last, null);
  assert.equal(last?.workspaceKey, NEW_KEY);
  assert.equal(last?.activeProjectId, 'p-new');

  // 页面刷新后：Host 给出同一个摘要 → 恢复流程按摘要读到这份记录
  const restored = h.store.read(NEW_KEY);
  assert.notEqual(restored, null, '新摘要必须能匹配到记录，否则刷新就丢工作区');
  assert.equal(restored?.workspaceKey, NEW_KEY);
  assert.equal(h.store.read(OLD_KEY), null, '旧摘要的记录不再被认领（空集合时已清掉或从未写入）');
});

test('E-01-06 门禁本来就没合上：添加流程不产生多余提示', () => {
  const h = assemble();
  assert.equal(h.gate.identityPending(), false);

  h.setProjects([P_NEW]);
  h.applyWorkspaceKey(NEW_KEY);

  assert.equal(h.gate.identityPending(), false);
  assert.equal(h.getState().workspaceKey, NEW_KEY);
  assert.deepEqual(h.notices, [], '正常添加不需要"身份已同步"这类补丁提示');
});

/* ------------------------------------------------------------------ */
/* E-02：单飞覆盖身份同步阶段                                           */
/* ------------------------------------------------------------------ */
test('E-02-01 身份同步 pending 期间再次确认：不发第二个 remove、不生成第二个 opId、不重复清理', async () => {
  const h = assemble();

  const first = h.action.remove('p-a');
  assert.equal(h.removeCalls.length, 1);
  assert.equal(h.opIdCalls, 1);

  h.removeDeferred().resolve({
    status: 'APPLIED',
    projectId: 'p-a',
    opId: h.removeCalls[0].opId,
    configPersisted: true,
  });
  await flush();

  // 此刻：Host 已 APPLIED，摘要健康检查仍 pending —— 属于同一次操作
  assert.equal(h.gate.identityPending(), true);
  assert.equal(h.probes.length, 1, '已经进入身份同步阶段');

  const second = h.action.remove('p-a');
  assert.equal(h.removeCalls.length, 1, '不得产生第二个 Host remove');
  assert.equal(h.opIdCalls, 1, '不得生成第二个 opId');
  assert.deepEqual(h.removed, ['p-a'], '不得重复执行移除后的状态清理');

  h.probe().resolve({ workspaceMode: 'multi', workspaceKey: NEW_KEY });
  const [a, b] = await Promise.all([first, second]);

  assert.equal(a.kind, 'removed');
  assert.equal(b.kind, 'removed', '第二次确认复用同一次操作的结果');
  assert.deepEqual(h.removed, ['p-a'], '整个操作只清理一次');
  h.timers.tick();
  assert.equal(h.store.writes.length, 1, '只写一条新摘要记录');
});

test('E-02-02 整笔操作结束后（含身份同步）：新的确认仍是新操作', async () => {
  const h = assemble();

  const first = h.action.remove('p-a');
  h.removeDeferred().resolve({
    status: 'APPLIED',
    projectId: 'p-a',
    opId: h.removeCalls[0].opId,
    configPersisted: true,
  });
  await flush();
  h.probe().resolve({ workspaceMode: 'multi', workspaceKey: NEW_KEY });
  await first;

  const second = h.action.remove('p-a');
  assert.equal(h.removeCalls.length, 2, '已完成的事务不得被当成"仍在执行"');
  assert.equal(h.opIdCalls, 2, '新操作必须有自己的 opId');

  h.removeDeferred().resolve({ status: 'ABORTED', projectId: 'p-a', blockedBy: ['ACTIVE_VIEWS'] });
  const result = await second;
  assert.equal(result.kind, 'blocked', '第二次是独立的一次事务，拿到的是自己的结论');
});
