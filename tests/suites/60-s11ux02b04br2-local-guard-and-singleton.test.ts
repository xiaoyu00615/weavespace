/**
 * UX-02B-04B-R2-02 / R2-03：本地草稿守卫 + 编排器生命周期。
 *
 * R2-02：Host 的 `activeViews` 只反映**服务端**还活着的 View。Host 重启后它归零，
 * 而界面里可能还握着一份从未落盘的 buffer；这时 Host 前检会返回 allowed=true，
 * 但那绝不等于"可以丢草稿"。Shell 必须在**发请求之前**自己拒绝。
 *
 * R2-03：单飞必须真的生效。`createRemoveProjectAction` 是 Provider 用来装配
 * `actions.removeProject` 的**同一个**函数——本套件走这条路径，而不是单独 new
 * 一个 `createProjectRemover`，否则测不到"每次调用都重建实例"这个缺陷。
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
  createRemoveProjectAction,
  localRemovalBlockers,
  type LocalDraftTab,
  type RemoveProjectAction,
} from '../../apps/shell/src/state/remove-project.ts';
import type { IdentitySyncOutcome } from '../../apps/shell/src/state/workspace-identity-sync.ts';

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

function tab(overrides: Partial<LocalDraftTab> & { projectId: string | null }): LocalDraftTab {
  return {
    dirty: false,
    saving: false,
    documentState: 'CLEAN',
    lastStatus: 'COMMITTED',
    ...overrides,
  };
}

interface Harness {
  action: RemoveProjectAction;
  removeCalls: Array<{ projectId: string; opId: string }>;
  precheckCalls: string[];
  opCalls: string[];
  removed: string[];
  notices: string[];
  opIdCalls: number;
  syncCalls: number;
  removeDeferred(): Deferred<RemoveProjectOutcome>;
  /** 最近一次**指定项目**的 remove 闸门（不同项目并发时用）。 */
  removeDeferredFor(projectId: string): Deferred<RemoveProjectOutcome>;
  syncDeferred(): Deferred<IdentitySyncOutcome>;
  /** 打开一个新的 syncIdentity 闸门（每次移除各一次）。 */
  syncGate(): void;
}

function assemble(options: { tabs?: LocalDraftTab[]; withSync?: boolean } = {}): Harness {
  const tabs: LocalDraftTab[] = options.tabs ?? [];
  const removeCalls: Harness['removeCalls'] = [];
  const precheckCalls: string[] = [];
  const opCalls: string[] = [];
  const removed: string[] = [];
  const notices: string[] = [];
  const removeDs: Deferred<RemoveProjectOutcome>[] = [];
  let syncDs: Deferred<IdentitySyncOutcome>[] = [];
  let opIdCalls = 0;
  let syncCalls = 0;
  let seq = 0;

  const action = createRemoveProjectAction({
    port: {
      removalPrecheck: (pid) => {
        precheckCalls.push(pid);
        const payload: RemovalPrecheckOutcome = {
          status: 'APPLIED',
          projectId: pid,
          // 关键：Host 侧"允许"（重启后 activeViews 归零）
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
        opCalls.push(opId);
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
      seq += 1;
      return `op-fixed-${String(seq).padStart(4, '0')}`;
    },
    identity: () => ({ mode: 'live', epoch: 1 }),
    isCurrent: (value) => value === 1,
    localBlockers: (pid) => localRemovalBlockers(tabs, pid),
    onRemoved: (pid) => removed.push(pid),
    onProjects: () => undefined,
    syncIdentity: options.withSync
      ? () => {
          syncCalls += 1;
          const d = deferred<IdentitySyncOutcome>();
          syncDs.push(d);
          return d.promise;
        }
      : undefined,
    notify: (message) => notices.push(message),
  });

  return {
    action,
    removeCalls,
    precheckCalls,
    opCalls,
    removed,
    notices,
    get opIdCalls() {
      return opIdCalls;
    },
    get syncCalls() {
      return syncCalls;
    },
    removeDeferred: () => removeDs[removeDs.length - 1],
    removeDeferredFor: (projectId) => {
      for (let i = removeCalls.length - 1; i >= 0; i -= 1) {
        if (removeCalls[i].projectId === projectId) return removeDs[i];
      }
      throw new Error(`没有 ${projectId} 的 remove 闸门`);
    },
    syncDeferred: () => syncDs[syncDs.length - 1],
    syncGate: () => {
      syncDs = [];
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/* ------------------------------- R2-02 ------------------------------- */

test('R2-02-01 本地阻断判定：没有标签不阻断，干净标签只算"还开着"', () => {
  assert.deepEqual(localRemovalBlockers([], 'p-a'), []);
  assert.deepEqual(localRemovalBlockers([tab({ projectId: 'p-a' })], 'p-a'), ['ACTIVE_VIEWS']);
  assert.deepEqual(
    localRemovalBlockers([tab({ projectId: 'p-b', dirty: true })], 'p-a'),
    [],
    '别的项目的草稿不影响本项目',
  );
});

test('R2-02-02 本地阻断判定：dirty / saving / 未知结果 / 冲突逐项命中且去重', () => {
  assert.deepEqual(localRemovalBlockers([tab({ projectId: 'p-a', dirty: true })], 'p-a'), [
    'ACTIVE_VIEWS',
    'DIRTY',
  ]);
  assert.deepEqual(localRemovalBlockers([tab({ projectId: 'p-a', saving: true })], 'p-a'), [
    'ACTIVE_VIEWS',
    'SAVING',
  ]);
  assert.deepEqual(
    localRemovalBlockers([tab({ projectId: 'p-a', documentState: 'OUTCOME_UNKNOWN' })], 'p-a'),
    ['ACTIVE_VIEWS', 'OUTCOME_UNKNOWN'],
  );
  assert.deepEqual(
    localRemovalBlockers([tab({ projectId: 'p-a', lastStatus: 'UNKNOWN' })], 'p-a'),
    ['ACTIVE_VIEWS', 'OUTCOME_UNKNOWN'],
  );
  assert.deepEqual(
    localRemovalBlockers([tab({ projectId: 'p-a', documentState: 'CONFLICT' })], 'p-a'),
    ['ACTIVE_VIEWS', 'CONFLICT'],
  );
  // 两个标签的同类原因只出现一次
  assert.deepEqual(
    localRemovalBlockers(
      [tab({ projectId: 'p-a', dirty: true }), tab({ projectId: 'p-a', dirty: true, saving: true })],
      'p-a',
    ),
    ['ACTIVE_VIEWS', 'DIRTY', 'SAVING'],
  );
});

test('R2-02-03 Host 重启后 activeViews=0 但本地有 dirty 标签：拒绝移除、零请求、草稿原样', async () => {
  const draft = { buffer: '没有保存过的内容', dirty: true };
  const h = assemble({
    tabs: [tab({ projectId: 'p-a', dirty: true, documentState: 'EDITING_DIRTY' })],
  });

  const pre = await h.action.precheck('p-a');
  assert.equal(pre.status, 'APPLIED');
  assert.equal(pre.status === 'APPLIED' ? pre.allowed : null, true, 'Host 侧是放行的');

  const result = await h.action.remove('p-a');
  assert.equal(result.kind, 'blocked');
  assert.deepEqual(result.kind === 'blocked' ? result.blockedBy : [], ['ACTIVE_VIEWS', 'DIRTY']);
  assert.equal(result.kind === 'blocked' ? result.state : '', 'LOCAL');

  assert.equal(h.removeCalls.length, 0, '不得发出 remove 请求');
  assert.equal(h.opIdCalls, 0, '连 opId 都不该生成（零副作用）');
  assert.deepEqual(h.removed, [], '不得清理标签');
  assert.equal(draft.buffer, '没有保存过的内容', '草稿字节必须原样保留');
  assert.equal(draft.dirty, true, '不得替用户清掉未保存标记');
  assert.deepEqual(h.notices, [], '被本地拦住时不需要"结果待核对"这类提示');
});

test('R2-02-04 草稿处理干净之后可以正常移除（Host 门禁仍是权威）', async () => {
  const h = assemble({ tabs: [tab({ projectId: 'p-a' })] });
  const blocked = await h.action.remove('p-a');
  assert.equal(blocked.kind, 'blocked', '还有标签打开时不允许移除');

  const clean = assemble();
  const p = clean.action.remove('p-a');
  assert.equal(clean.removeCalls.length, 1);
  clean.removeDeferred().resolve({
    status: 'APPLIED',
    projectId: 'p-a',
    opId: clean.removeCalls[0].opId,
    configPersisted: true,
  });
  const result = await p;
  assert.equal(result.kind, 'removed');
  assert.deepEqual(clean.removed, ['p-a']);
});

/* ------------------------------- R2-03 ------------------------------- */

test('R2-03-01 同一装配实例并发确认：只发出一次 remove（单飞真的生效）', async () => {
  const h = assemble();
  const first = h.action.remove('p-a');
  const second = h.action.remove('p-a');

  assert.equal(h.removeCalls.length, 1, '并发确认必须复用同一次提交');
  h.removeDeferred().resolve({
    status: 'APPLIED',
    projectId: 'p-a',
    opId: h.removeCalls[0].opId,
    configPersisted: true,
  });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.kind, 'removed');
  assert.equal(b.kind, 'removed');
  assert.deepEqual(h.removed, ['p-a'], '只能清理一次');
});

test('R2-03-02 事务结束后不会被缓存：下一次确认是新操作，重新提交', async () => {
  const h = assemble();
  const first = h.action.remove('p-a');
  h.removeDeferred().resolve({
    status: 'APPLIED',
    projectId: 'p-a',
    opId: h.removeCalls[0].opId,
    configPersisted: true,
  });
  await first;

  const second = h.action.remove('p-a');
  assert.equal(h.removeCalls.length, 2, '已完成的结论不得被当成"仍在执行"');
  h.removeDeferred().resolve({
    status: 'ABORTED',
    projectId: 'p-a',
    blockedBy: ['ACTIVE_VIEWS'],
  });
  const result = await second;
  assert.equal(result.kind, 'blocked', '第二次是独立的一次事务，拿到的是自己的结论');
});

test('R2-03-03 不同项目并发：各发一次（跨项目串行化交给 Host mutationLock）', async () => {
  const h = assemble();
  const a = h.action.remove('p-a');
  const b = h.action.remove('p-b');
  assert.equal(h.removeCalls.length, 2, '不同项目不得被客户端单飞拦住');
  assert.deepEqual(h.removeCalls.map((c) => c.projectId), ['p-a', 'p-b']);

  h.removeDeferredFor('p-b').resolve({ status: 'ABORTED', projectId: 'p-b', blockedBy: ['DIRTY'] });
  const blocked = await b;
  assert.equal(blocked.kind, 'blocked');

  h.removeDeferredFor('p-a').resolve({
    status: 'APPLIED',
    projectId: 'p-a',
    opId: h.removeCalls[0].opId,
    configPersisted: true,
  });
  const removed = await a;
  assert.equal(removed.kind, 'removed');
  assert.deepEqual(h.removed, ['p-a']);
});

test('R2-03-04 成功提示在身份同步之后发出；待同步时明确标注', async () => {
  const h = assemble({ withSync: true });
  const p = h.action.remove('p-a');
  h.removeDeferred().resolve({
    status: 'APPLIED',
    projectId: 'p-a',
    opId: h.removeCalls[0].opId,
    configPersisted: true,
  });
  await flush();

  assert.equal(h.syncCalls, 1, '移除成功后必须同步工作区身份');
  assert.deepEqual(h.notices, [], '摘要还没回来，先不要发"已完成"的提示');

  h.syncDeferred().resolve({ status: 'pending', reason: 'probe-failed' });
  await p;
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /已从工作台移除/);
  assert.match(h.notices[0], /工作区身份待同步/, '待同步必须写进提示，不能假装一切就绪');
});

test('R2-03-05 移除被阻断时不做身份同步（工作区没变，摘要不该动）', async () => {
  const h = assemble({ withSync: true });
  const p = h.action.remove('p-a');
  h.removeDeferred().resolve({ status: 'ABORTED', projectId: 'p-a', blockedBy: ['SAVING'] });
  const result = await p;

  assert.equal(result.kind, 'blocked');
  assert.equal(h.syncCalls, 0, '工作区没变就不该探测新摘要');
  assert.deepEqual(h.notices, []);
});
