/**
 * UX-02B-04B-R2-01：身份同步窗口内禁止错误快照。
 *
 * 现场：`PROJECT_REMOVED` 是**同步**派发的，而新的 `workspaceKey` 要等一次异步
 * 健康检查。这中间状态已经属于"新项目集合"，摘要还是旧的：
 * - 自动保存 400ms 到了 → 写成"新列表 + 旧摘要"；
 * - 用户在这期间关掉页面 → `pagehide` flush 走同一条路。
 * 两种都会产出一条看起来有效、启动后却认错工作区的记录。
 *
 * 本套件用**可控定时器**把这段时间拉开，断言：
 * PROJECT_REMOVED → 健康检查 pending → 400ms / pagehide 都不写 →
 * 健康检查完成 → 只有新摘要一条记录。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkspaceIdentity } from '../../apps/shell/src/client/client-api.ts';
import {
  createWorkspaceIdentitySync,
  settleIdentitySync,
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
 * 复刻 `DocumentActionsProvider` 的装配（同一条序列、同一套规则）：
 * 门禁 → 自动保存 → 身份同步 → reducer。
 */
function assemble() {
  const gate = createWorkspaceWriteGate();
  const store = storeSpy();
  const timers = manualTimers();
  const prods: Deferred<WorkspaceIdentity>[] = [];
  const epoch = { value: 1 };

  let state: WorkspaceState = {
    ...INITIAL_STATE,
    mode: 'live',
    workspaceMode: 'multi',
    workspaceKey: OLD_KEY,
    projects: [
      { projectId: 'p-a', name: 'A', status: 'READY' },
      { projectId: 'p-b', name: 'B', status: 'READY' },
    ],
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
        prods.push(d);
        return d.promise;
      },
    },
    currentKey: () => state.workspaceKey,
    isCurrent: (value) => epoch.value === value,
    onWorkspaceKey: (workspaceKey) => {
      state = workspaceReducer(state, { type: 'SET_WORKSPACE_KEY', workspaceKey });
    },
    onDropRecord: (workspaceKey) => store.clear(workspaceKey),
  });

  return {
    gate,
    store,
    timers,
    autosave,
    identitySync,
    epoch,
    probe: () => prods[prods.length - 1],
    getState: () => state,
    /** `onRemoved` 的真实顺序：先同步合上门禁，再派发 PROJECT_REMOVED。 */
    applyRemoval(projectId = 'p-a') {
      gate.holdIdentity();
      state = workspaceReducer(state, { type: 'PROJECT_REMOVED', projectId });
      autosave.schedule();
    },
    /** `syncIdentity` 的真实规则 + 之后的重新排程。 */
    async sync(epochValue = 1) {
      const outcome = await identitySync.refresh(epochValue);
      if (settleIdentitySync(gate, outcome) === 'released') autosave.schedule();
      return outcome;
    },
  };
}

/* ------------------------------------------------------------------ */

test('R2-01-01 移除后身份 pending：400ms 到点与 pagehide flush 都写不出旧摘要记录', async () => {
  const h = assemble();
  // 更早的一次界面变化已经排了 400ms 保存（真实竞态：定时器在移除之前就存在）
  h.autosave.schedule();
  assert.equal(h.timers.pending(), 1);

  h.applyRemoval('p-a');

  // 状态里已经是"只剩 p-b"，但摘要还是旧的
  assert.deepEqual(h.getState().projects.map((p) => p.projectId), ['p-b']);
  assert.equal(h.getState().workspaceKey, OLD_KEY);

  // 到点回调确实跑了，但被门禁拦住 → 一个字节都没写
  assert.equal(h.timers.tick(), 1, '已经排好的定时器仍会到点');
  assert.equal(h.store.writes.length, 0, '身份待同步期间不得写任何记录');

  // 用户此时关页面 → pagehide flush 走的是同一条判定
  const flushed = h.autosave.flush();
  assert.equal(flushed, 'held', 'flush 必须被门禁拦住');
  assert.equal(h.store.writes.length, 0, 'pagehide 也不得写出旧摘要记录');

  // 待同步期间连新定时器都不排：避免反复空转
  h.autosave.schedule();
  assert.equal(h.timers.pending(), 0, '被拦住时不该再排定时器');
  assert.equal(h.gate.identityPending(), true);
});

test('R2-01-02 健康检查完成后：写入的是新摘要，且旧摘要记录被清掉', async () => {
  const h = assemble();
  h.applyRemoval('p-a');
  h.timers.tick();

  const pending = h.sync(1);
  h.probe().resolve({ workspaceMode: 'multi', workspaceKey: NEW_KEY });
  const outcome = await pending;

  assert.equal(outcome.status, 'updated');
  assert.equal(h.gate.identityPending(), false, '拿到新摘要后必须放开自动保存');
  assert.equal(h.getState().workspaceKey, NEW_KEY);

  // 放开后重新排程 → 到点写一条
  h.timers.tick();
  assert.equal(h.store.writes.length, 1);
  assert.equal(h.store.writes[0].workspaceKey, NEW_KEY, '只能写新摘要');
  assert.equal(h.store.writes[0].activeProjectId, 'p-b', '活动项目回退到剩下的项目');
  assert.deepEqual(h.store.writes[0].tabs, [], '没有打开标签时快照里也不该有');
  assert.deepEqual(h.store.cleared, [OLD_KEY], '旧摘要的本地记录必须清掉');
});

test('R2-01-03 健康检查失败：摘要置空并保持待同步，flush 与到点都不写', async () => {
  const h = assemble();
  h.applyRemoval('p-a');

  const pending = h.sync(1);
  h.probe().reject(new Error('health 502'));
  const outcome = await pending;

  assert.equal(outcome.status, 'pending');
  assert.equal(h.getState().workspaceKey, null, '不能继续用旧摘要（那就是伪造身份）');
  assert.equal(h.gate.identityPending(), true, '待同步期间写入必须继续被拦住');

  h.timers.tick();
  assert.equal(h.autosave.flush(), 'held');
  assert.equal(h.store.writes.length, 0, '没有有效摘要就一条记录都不写');
});

test('R2-01-04 身份探测迟到（切换工作区）：不恢复旧身份、不写任何记录', async () => {
  const h = assemble();
  h.applyRemoval('p-a');

  const pending = h.sync(1);
  h.epoch.value = 2; // 用户切走
  h.probe().resolve({ workspaceMode: 'multi', workspaceKey: NEW_KEY });
  const outcome = await pending;

  assert.equal(outcome.status, 'stale');
  assert.equal(h.getState().workspaceKey, OLD_KEY, '迟到结果不得把摘要改成新工作区拿到的值');
  assert.equal(h.gate.identityPending(), true, '门禁仍由切换点收尾，这里不解锁');

  h.timers.tick();
  assert.equal(h.store.writes.length, 0, '旧摘要不得被写回');
});

test('R2-01-05 切到 Demo 后：即使门禁被放开，也不会写出旧身份的记录', () => {
  const h = assemble();
  h.applyRemoval('p-a');

  // switchMode 的真实顺序：先释放身份轴，再派发 SET_MODE（会清空 workspaceKey）
  h.gate.releaseIdentity();
  const demo = workspaceReducer(h.getState(), { type: 'SET_MODE', mode: 'demo' });
  assert.equal(demo.workspaceKey, null, '切模式必须丢掉旧摘要');

  assert.equal(serializeWorkspace(demo, { workspaceKey: demo.workspaceKey }), null);
  // 门禁不再拦，但快照本身拒绝落盘：两条防线都成立
  assert.equal(h.gate.allowsWrite(), true);
});

test('R2-01-06 移除被拒（abort）时不合上门禁：正常自动保存不受影响', () => {
  const h = assemble();
  // 复用真实顺序里"没有 onRemoved"的分支：只是排一次普通保存
  h.autosave.schedule();
  h.timers.tick();
  assert.equal(h.store.writes.length, 1);
  assert.equal(h.store.writes[0].workspaceKey, OLD_KEY, '没换工作区就该用当前摘要');
  assert.equal(h.gate.identityPending(), false);
});

test('R2-01-07 恢复门禁与身份门禁互不影响：各自放行才允许写入', () => {
  const gate = createWorkspaceWriteGate();
  gate.hold(); // 恢复开始
  gate.holdIdentity(); // 移除后的身份窗口
  assert.equal(gate.allowsWrite(), false);

  gate.release(); // 恢复终态
  assert.equal(gate.allowsWrite(), false, '身份还没确认，仍然不许写');
  assert.equal(gate.identityPending(), true);

  gate.releaseIdentity();
  assert.equal(gate.allowsWrite(), true, '两轴都放行才写');

  // 反向：身份窗口不会把恢复拦成"已放行"
  gate.hold();
  assert.equal(gate.allowsWrite(), false);
  gate.holdIdentity();
  gate.releaseIdentity();
  assert.equal(gate.allowsWrite(), false, '恢复仍持有写入');
});
