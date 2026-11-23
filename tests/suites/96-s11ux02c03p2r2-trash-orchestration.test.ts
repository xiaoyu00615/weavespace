/**
 * UX-02C-03-P2-02：回收区编排器（`state/trash.ts#createTrashController`）。
 *
 * 全部用**真实编排器 + 假端口**：这里要证明的是时序纪律，不是磁盘行为
 * （磁盘行为由套件 97 用真实 Host 证明）。断言的三条底线：
 * 1. 单飞——同一行连点两次只发一个请求；
 * 2. UNKNOWN 只做一次只读核对，绝不重发副作用；
 * 3. 迟到响应（切项目 / 切模式 / 换工作区）不写回任何桶、也不弹提示。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  TrashActionOutcome,
  TrashEntryDto,
  TrashListOutcome,
  TrashOpQueryOutcome,
} from '../../apps/shell/src/client/client-api.ts';
import {
  createTrashController,
  TRASH_FULL_MESSAGE,
  TRASH_TARGET_EXISTS_MESSAGE,
  TRASH_UNKNOWN_MESSAGE,
  type TrashActionResult,
  type TrashHost,
  type TrashIdentity,
  type TrashPort,
} from '../../apps/shell/src/state/trash.ts';
import {
  dialogBelongsTo,
  openTrashDelete,
  submitTrashDelete,
} from '../../apps/shell/src/state/trash-dialog.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import { trashPanelView } from '../../apps/shell/src/state/trash.ts';
import type { WorkspaceAction } from '../../apps/shell/src/state/types.ts';

const PROJ = 'project-a';
const OTHER = 'project-b';
const OP = 'op-p202-0001';

function entry(overrides: Partial<TrashEntryDto> = {}): TrashEntryDto {
  return {
    opId: OP,
    path: 'docs/guide.md',
    entryKind: 'file',
    size: 12,
    deletedAt: '2026-11-23T04:05:06.000Z',
    state: 'stored',
    canRestore: true,
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  host: TrashHost;
  controller: ReturnType<typeof createTrashController>;
  actions: WorkspaceAction[];
  notices: string[];
  calls: { list: number; remove: number; restore: number; query: number };
  refreshes: string[];
  setIdentity(patch: Partial<TrashIdentity>): void;
  setBlockers(codes: readonly string[]): void;
  setSupported(value: boolean): void;
  setProjectReady(value: boolean): void;
  opIds: string[];
}

function makeHarness(port: Partial<TrashPort> = {}): Harness {
  let identity: TrashIdentity = {
    mode: 'live',
    workspaceMode: 'multi',
    workspaceKey: 'ws-key-0000000000001',
    activeProjectId: PROJ,
    epoch: 1,
  };
  let blockers: readonly string[] = [];
  let supported = true;
  let projectReady = true;
  const actions: WorkspaceAction[] = [];
  const notices: string[] = [];
  const refreshes: string[] = [];
  const opIds: string[] = [];
  const calls = { list: 0, remove: 0, restore: 0, query: 0 };

  /**
   * 端口分两层：`rawPort` 是行为，`wrapped` 只负责计数。
   * 绝不能让包装层再调用 `host.port.*`——那会调用自己，直接无限递归。
   */
  const rawPort: TrashPort = {
    list: port.list ?? (async (): Promise<TrashListOutcome> => ({ status: 'APPLIED', projectId: PROJ, count: 0, entries: [] })),
      remove:
        port.remove ??
        (async (projectId, path, opId): Promise<TrashActionOutcome> => ({
          status: 'APPLIED',
          projectId,
          opId,
          entry: entry({ path }),
          replayed: false,
        })),
      restore:
        port.restore ??
        (async (projectId, opId): Promise<TrashActionOutcome> => ({
          status: 'APPLIED',
          projectId,
          opId,
          entry: entry({ state: 'restored', canRestore: false }),
          replayed: false,
        })),
      query:
        port.query ??
        (async (projectId, opId): Promise<TrashOpQueryOutcome> => ({
          status: 'APPLIED',
          opId,
          outcome: 'trashed',
          state: 'stored',
        })),
  };

  const wrapped: TrashPort = {
    list: async (projectId) => {
      calls.list += 1;
      return rawPort.list(projectId);
    },
    remove: async (projectId, path, opId) => {
      calls.remove += 1;
      return rawPort.remove(projectId, path, opId);
    },
    restore: async (projectId, opId) => {
      calls.restore += 1;
      return rawPort.restore(projectId, opId);
    },
    query: async (projectId, opId) => {
      calls.query += 1;
      return rawPort.query(projectId, opId);
    },
  };

  const host: TrashHost = {
    port: wrapped,
    identity: () => identity,
    dispatch: (action) => actions.push(action),
    newOpId: () => {
      const id = `op-test-${String(opIds.length + 1).padStart(4, '0')}`;
      opIds.push(id);
      return id;
    },
    notify: (message) => notices.push(message),
    supported: () => supported,
    /**
     * 真实 Host 的发送前闸：live + multi + activeProjectId 一致 + 项目 READY。
     * 测试通过 `setProjectReady(false)` 模拟"项目此刻不可用"。
     */
    preflight: (projectId) => {
      if (identity.mode !== 'live' || identity.workspaceMode !== 'multi') {
        return { ok: false, kind: 'stale' as const };
      }
      if (identity.activeProjectId !== projectId) return { ok: false, kind: 'stale' as const };
      if (!projectReady) {
        return { ok: false, kind: 'blocked' as const, message: '项目当前不可用，请稍后重试。' };
      }
      return { ok: true as const };
    },
    blockers: () => blockers,
    refreshAfterRemoval: async (projectId, path) => {
      refreshes.push(`remove:${projectId}:${path}`);
    },
    refreshAfterRestore: async (projectId, path) => {
      refreshes.push(`restore:${projectId}:${path}`);
    },
  };

  return {
    host,
    controller: createTrashController(host),
    actions,
    notices,
    calls,
    refreshes,
    setIdentity(patch) {
      identity = { ...identity, ...patch };
    },
    setBlockers(codes) {
      blockers = codes;
    },
    setSupported(value) {
      supported = value;
    },
    setProjectReady(value) {
      projectReady = value;
    },
    opIds,
  };
}

const types = (actions: WorkspaceAction[]): string[] => actions.map((action) => action.type);

/** 打开确认框（带身份）：真实组件会把"打开那一刻"的 workspaceKey/epoch 记进去。 */
function openDialog(input: {
  path: string;
  reasons: readonly string[];
  workspaceKey?: string | null;
  epoch?: number;
}) {
  return openTrashDelete({
    projectId: PROJ,
    path: input.path,
    reasons: input.reasons,
    workspaceKey: input.workspaceKey === undefined ? 'ws-key-0000000000001' : input.workspaceKey,
    epoch: input.epoch ?? 1,
  });
}

/** 把控制器派发的动作灌进真实 reducer，得到一个可断言的界面状态。 */
function stateOf(h: Harness, entries: readonly TrashEntryDto[] = [entry()], upto = h.actions.length) {
  let state = workspaceReducer(INITIAL_STATE, {
    type: 'TRASH_LOADED',
    projectId: PROJ,
    entries,
    count: entries.length,
  });
  for (const action of h.actions.slice(0, upto)) state = workspaceReducer(state, action);
  return state;
}

/** 面板上某一行当前长什么样（走真实视图模型，而不是自己再判一遍）。 */
function rowOfState(state: ReturnType<typeof stateOf>, opId: string = OP) {
  const view = trashPanelView({
    mode: 'live',
    workspaceMode: 'multi',
    projectId: PROJ,
    state: state.trashByProject[PROJ],
  });
  if (view.kind !== 'list') return null;
  return view.rows.find((row) => row.opId === opId) ?? null;
}

/* ================================================================== */
/* 读取                                                                 */
/* ================================================================== */

test('P2-02 读取：BEGIN → LOADED，数量与记录来自 Host 回执', async () => {
  const h = makeHarness({
    list: async () => ({ status: 'APPLIED', projectId: PROJ, count: 1, entries: [entry()] }),
  });
  await h.controller.load(PROJ);

  assert.deepEqual(types(h.actions), ['TRASH_LOAD_BEGIN', 'TRASH_LOADED']);
  const loaded = h.actions[1] as Extract<WorkspaceAction, { type: 'TRASH_LOADED' }>;
  assert.equal(loaded.count, 1);
  assert.equal(loaded.entries[0].path, 'docs/guide.md');
});

test('P2-02 读取：单飞——并发两次只发一个请求', async () => {
  const gate = deferred<TrashListOutcome>();
  const h = makeHarness({ list: () => gate.promise });

  const first = h.controller.load(PROJ);
  const second = h.controller.load(PROJ);
  assert.equal(h.calls.list, 1, '第二次调用必须复用第一次的在途请求');

  gate.resolve({ status: 'APPLIED', projectId: PROJ, count: 0, entries: [] });
  await Promise.all([first, second]);
  assert.equal(h.calls.list, 1);
  assert.equal(types(h.actions).filter((type) => type === 'TRASH_LOADED').length, 1);
});

test('P2-02 读取：切到别的项目后，迟到的列表不得落地', async () => {
  const gate = deferred<TrashListOutcome>();
  const h = makeHarness({ list: () => gate.promise });

  const pending = h.controller.load(PROJ);
  // 用户切到项目 B：A 的响应已经不属于当前界面
  h.setIdentity({ activeProjectId: OTHER });
  gate.resolve({ status: 'APPLIED', projectId: PROJ, count: 9, entries: [entry()] });
  await pending;

  assert.equal(
    types(h.actions).includes('TRASH_LOADED'),
    false,
    '迟到响应不得写进任何桶（否则以后切回 A 会看到脏数据）',
  );
});

test('P2-02 读取：切到 Demo 后，迟到的列表不得落地', async () => {
  const gate = deferred<TrashListOutcome>();
  const h = makeHarness({ list: () => gate.promise });

  const pending = h.controller.load(PROJ);
  h.setIdentity({ mode: 'demo', epoch: 2 });
  gate.resolve({ status: 'APPLIED', projectId: PROJ, count: 3, entries: [entry()] });
  await pending;

  assert.equal(types(h.actions).includes('TRASH_LOADED'), false);
});

test('P2-02 读取：失败写 LOAD_ERROR（带可读文案），不当成空列表', async () => {
  const h = makeHarness({
    list: async () => ({ status: 'REJECTED', errorCode: 'ERR_STORAGE_IO', message: '磁盘读取失败', httpStatus: 500 }),
  });
  await h.controller.load(PROJ);

  assert.deepEqual(types(h.actions), ['TRASH_LOAD_BEGIN', 'TRASH_LOAD_ERROR']);
  const failed = h.actions[1] as Extract<WorkspaceAction, { type: 'TRASH_LOAD_ERROR' }>;
  assert.equal(failed.errorCode, 'ERR_STORAGE_IO');
  assert.match(failed.message, /磁盘|读取/);
});

/* ================================================================== */
/* 回收                                                                 */
/* ================================================================== */

test('P2-02 回收：成功后刷新父层、刷新列表并提示"未永久删除"', async () => {
  const h = makeHarness();
  const result = await h.controller.remove(PROJ, 'docs/guide.md');

  assert.equal(result.status, 'applied');
  assert.equal(h.calls.remove, 1);
  assert.match(h.opIds[0], /^[a-z0-9][a-z0-9-]{7,63}$/, 'opId 必须符合 Host 的目录名规则');
  assert.deepEqual(h.refreshes, [`remove:${PROJ}:docs/guide.md`]);
  assert.ok(h.notices.some((message) => /移入回收区/.test(message)));
  assert.ok(h.notices.some((message) => /未永久删除/.test(message)));
  // 成功后自动重读列表（计数要跟着变）
  assert.ok(h.calls.list >= 1);
  assert.ok(types(h.actions).includes('TRASH_LOADED'));
});

test('P2-02 回收：UNKNOWN 只做一次只读核对，绝不重发移动', async () => {
  const h = makeHarness({
    remove: async (projectId, _path, opId) => ({
      status: 'UNKNOWN',
      projectId,
      opId,
      message: '超时',
      httpStatus: 0,
    }),
  });

  const result = await h.controller.remove(PROJ, 'a.md');
  assert.equal(result.status, 'unknown');
  assert.equal(h.calls.remove, 1, '绝不重发副作用请求');
  assert.equal(h.calls.query, 1, '只允许一次只读核对');
  assert.ok(h.notices.includes(TRASH_UNKNOWN_MESSAGE));
  assert.ok(h.refreshes.length === 1, '仍要刷新列表与父层，但没有宣布成功');
  assert.equal(
    h.notices.some((message) => /已把「a\.md」移入回收区/.test(message)),
    false,
    'UNKNOWN 不得显示成功文案',
  );
});

test('P2-02 回收：本地有活动标签/草稿时直接阻断，不发请求', async () => {
  const h = makeHarness();
  h.setBlockers(['ACTIVE_VIEWS', 'DIRTY']);

  const result = await h.controller.remove(PROJ, 'a.md');
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.status === 'blocked' ? result.reasons : [], ['ACTIVE_VIEWS', 'DIRTY']);
  assert.equal(h.calls.remove, 0, '被阻断时零请求、零磁盘副作用');
  assert.equal(h.notices.length, 0, '阻断原因由调用方展示，不重复提示');
});

test('P2-02 回收：回收区满时使用产品规定的提示', async () => {
  const h = makeHarness({
    remove: async (projectId, _path, opId) => ({
      status: 'REJECTED',
      projectId,
      opId,
      errorCode: 'ERR_TRASH_FULL',
      message: '服务端文案',
      httpStatus: 409,
    }),
  });

  const result = await h.controller.remove(PROJ, 'a.md');
  assert.equal(result.status, 'rejected');
  assert.ok(h.notices.includes(TRASH_FULL_MESSAGE));
});

test('P2-02 回收：同一路径并发提交只发一次（单飞）', async () => {
  const gate = deferred<TrashActionOutcome>();
  const h = makeHarness({ remove: () => gate.promise });

  const first = h.controller.remove(PROJ, 'a.md');
  const second = h.controller.remove(PROJ, 'a.md');
  assert.equal(h.calls.remove, 1, '双击不能变成两次移动');

  gate.resolve({ status: 'APPLIED', projectId: PROJ, opId: OP, entry: entry({ path: 'a.md' }), replayed: false });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 'applied');
  assert.equal(b.status, 'applied', '两个调用方拿到同一个结论');
  assert.equal(h.calls.remove, 1);
});

test('P2-02 回收：结果回来时已切走项目 → stale，且不弹提示', async () => {
  const gate = deferred<TrashActionOutcome>();
  const h = makeHarness({ remove: () => gate.promise });

  const pending = h.controller.remove(PROJ, 'a.md');
  h.setIdentity({ activeProjectId: OTHER });
  gate.resolve({ status: 'APPLIED', projectId: PROJ, opId: OP, entry: entry(), replayed: false });

  const result = await pending;
  assert.equal(result.status, 'stale');
  assert.equal(h.notices.length, 0, '迟到结果不得在当前项目里宣布成功');
  assert.deepEqual(h.refreshes, [], '也不得去刷新旧项目的目录层');
});

/* ================================================================== */
/* 恢复                                                                 */
/* ================================================================== */

test('P2-02 恢复：stored 才可恢复；成功后刷新原父层并提示', async () => {
  const h = makeHarness();
  const result = await h.controller.restore(PROJ, entry());

  assert.equal(result.status, 'applied');
  assert.equal(h.calls.restore, 1);
  assert.deepEqual(h.refreshes, [`restore:${PROJ}:docs/guide.md`]);
  assert.ok(h.notices.some((message) => /已把「docs\/guide\.md」恢复到原位置/.test(message)));
  // busy 先置位、确认后才解除（R1-01）：最后一个动作必须是同一个 opId 的 busy=false
  const busy = h.actions.filter((action) => action.type === 'TRASH_BUSY') as Array<
    Extract<WorkspaceAction, { type: 'TRASH_BUSY' }>
  >;
  assert.equal(busy[0].opId, OP);
  assert.equal(busy[0].busy, true);
  assert.equal(busy[busy.length - 1].opId, OP);
  assert.equal(busy[busy.length - 1].busy, false, '无论成败都必须解除这一条的在途标记');
});

test('P2-02 恢复：非 stored 状态一律拒绝，且不发请求', async () => {
  for (const state of ['pending', 'restoring', 'restored', 'aborted', 'conflicted', 'missing'] as const) {
    const h = makeHarness();
    const result = await h.controller.restore(PROJ, entry({ state, canRestore: false }));
    assert.equal(result.status, 'rejected', `${state} 不得发起恢复`);
    assert.equal(h.calls.restore, 0, `${state} 必须零请求`);
  }
});

test('P2-02 恢复：原位置同名文件 → 用规定文案提示，不覆盖', async () => {
  const h = makeHarness({
    restore: async (projectId, opId) => ({
      status: 'REJECTED',
      projectId,
      opId,
      errorCode: 'ERR_ENTRY_EXISTS',
      message: '目标已存在',
      httpStatus: 409,
    }),
  });

  const result = await h.controller.restore(PROJ, entry());
  assert.equal(result.status, 'rejected');
  assert.ok(h.notices.includes(TRASH_TARGET_EXISTS_MESSAGE));
  assert.equal(h.calls.query, 0, '明确的 409 不需要核对');
  assert.deepEqual(h.refreshes, [], '失败不得刷新成"已恢复"的样子');
});

test('P2-02 恢复：UNKNOWN 只核对一次、不重发、busy 必须解除', async () => {
  const h = makeHarness({
    restore: async (projectId, opId) => ({
      status: 'UNKNOWN',
      projectId,
      opId,
      message: '超时',
      httpStatus: 202,
    }),
  });

  const result = await h.controller.restore(PROJ, entry());
  assert.equal(result.status, 'unknown');
  assert.equal(h.calls.restore, 1);
  assert.equal(h.calls.query, 1);
  assert.ok(h.notices.includes(TRASH_UNKNOWN_MESSAGE));
  const busy = h.actions.filter((action) => action.type === 'TRASH_BUSY') as Array<
    Extract<WorkspaceAction, { type: 'TRASH_BUSY' }>
  >;
  assert.equal(busy[busy.length - 1].busy, false);
});

test('P2-02 恢复：同一 opId 并发只发一次；不同 opId 互不阻塞', async () => {
  const gates = new Map<string, ReturnType<typeof deferred<TrashActionOutcome>>>();
  const h = makeHarness({
    restore: async (projectId, opId) => {
      const gate = deferred<TrashActionOutcome>();
      gates.set(opId, gate);
      const outcome = await gate.promise;
      return outcome;
    },
  });

  const first = h.controller.restore(PROJ, entry({ opId: 'op-aaaa-0001' }));
  const second = h.controller.restore(PROJ, entry({ opId: 'op-aaaa-0001' }));
  const other = h.controller.restore(PROJ, entry({ opId: 'op-bbbb-0002', path: 'b.md' }));
  assert.equal(h.calls.restore, 2, '同 opId 复用，不同 opId 各发一次');

  for (const [opId, gate] of gates) {
    gate.resolve({ status: 'APPLIED', projectId: PROJ, opId, entry: entry({ state: 'restored', canRestore: false }), replayed: false });
  }
  const [a, b, c] = await Promise.all([first, second, other]);
  assert.equal(a.status, 'applied');
  assert.equal(b.status, 'applied');
  assert.equal(c.status, 'applied');
});

test('P2-02 恢复：结果回来时已切模式 → stale，不宣布成功', async () => {
  const gate = deferred<TrashActionOutcome>();
  const h = makeHarness({ restore: () => gate.promise });

  const pending = h.controller.restore(PROJ, entry());
  h.setIdentity({ mode: 'demo', epoch: 9 });
  gate.resolve({ status: 'APPLIED', projectId: PROJ, opId: OP, entry: entry(), replayed: false });

  const result = await pending;
  assert.equal(result.status, 'stale');
  assert.equal(h.notices.length, 0);
  assert.deepEqual(h.refreshes, []);
});

/* ================================================================== */
/* 二段确认（`state/trash-dialog.ts`）                                   */
/* ================================================================== */

test('P2-02 确认框：打开时不发请求；有阻断原因就直接进 blocked（不给确认按钮）', async () => {
  const ready = openDialog({ path: 'docs/guide.md', reasons: [] });
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.name, 'guide.md', '标题用原文件名');

  const blocked = openDialog({ path: 'docs/guide.md', reasons: ['有未保存的修改'] });
  assert.equal(blocked.phase, 'blocked');
  assert.deepEqual(blocked.reasons, ['有未保存的修改']);

  let calls = 0;
  const submit = async (): Promise<TrashActionResult> => {
    calls += 1;
    return { status: 'applied', opId: OP };
  };
  const result = await submitTrashDelete(blocked, submit);
  assert.equal(result.outcome, null);
  assert.equal(calls, 0, '被阻断时一次请求都不发');
});

test('P2-02 确认框：取消 = 状态置空，一个请求都不发（零磁盘修改）', async () => {
  const dialog = openDialog({ path: 'a.md', reasons: [] });
  let calls = 0;
  const submit = async (): Promise<TrashActionResult> => {
    calls += 1;
    return { status: 'applied', opId: OP };
  };

  // 用户点「取消」：组件只是把状态清空，不会调用 submit
  const cancelled: typeof dialog | null = null;
  const result = await submitTrashDelete(cancelled, submit);
  assert.equal(result.next, null);
  assert.equal(result.outcome, null);
  assert.equal(calls, 0, '取消必须零请求');
});

test('P2-02 确认框：ready 时恰好提交一次，成功落到"可在回收区恢复"', async () => {
  const dialog = openDialog({ path: 'docs/guide.md', reasons: [] });
  const seen: Array<[string, string]> = [];
  const submit = async (projectId: string, path: string): Promise<TrashActionResult> => {
    seen.push([projectId, path]);
    return { status: 'applied', opId: OP };
  };

  const result = await submitTrashDelete(dialog, submit);
  assert.deepEqual(seen, [[PROJ, 'docs/guide.md']]);
  assert.equal(result.next?.phase, 'result');
  assert.equal(result.next?.result?.tone, 'ok');
  assert.match(result.next?.result?.body ?? '', /可在回收区恢复/);
  assert.match(result.next?.result?.body ?? '', /guide\.md/);
});

test('P2-02 确认框：UNKNOWN 落到 warn（不宣布成功）；REJECTED 落到 error', async () => {
  const dialog = openDialog({ path: 'a.md', reasons: [] });

  const unknown = await submitTrashDelete(dialog, async () => ({
    status: 'unknown',
    opId: OP,
    message: '超时',
  }));
  assert.equal(unknown.next?.phase, 'result');
  assert.equal(unknown.next?.result?.tone, 'warn');
  assert.match(unknown.next?.result?.body ?? '', /未确认/);
  assert.match(unknown.next?.result?.body ?? '', /不会自动重发/);

  const rejected = await submitTrashDelete(dialog, async () => ({
    status: 'rejected',
    message: TRASH_FULL_MESSAGE,
  }));
  assert.equal(rejected.next?.result?.tone, 'error');
  assert.equal(rejected.next?.result?.body, TRASH_FULL_MESSAGE);
});

test('P2-02 确认框：提交时已切走工作区 → 直接关闭，不宣布任何结论', async () => {
  const dialog = openDialog({ path: 'a.md', reasons: [] });
  const result = await submitTrashDelete(dialog, async () => ({ status: 'stale' }));
  assert.equal(result.next, null);
});

test('P2-02 确认框：确认框打开后用户又打开了该文件 → 提交时回到 blocked', async () => {
  const dialog = openDialog({ path: 'a.md', reasons: [] });
  const result = await submitTrashDelete(dialog, async () => ({
    status: 'blocked',
    reasons: ['ACTIVE_VIEWS'],
  }));
  assert.equal(result.next?.phase, 'blocked');
  assert.deepEqual(result.next?.reasons, ['ACTIVE_VIEWS']);
});

/* ================================================================== */
/* R1-01：恢复在途 / 待核对的两段状态                                    */
/* ================================================================== */

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

test('P2-02-R1 恢复：列表确认之前不解除在途（延迟 GET）', async () => {
  const gate = deferred<TrashListOutcome>();
  const h = makeHarness({ list: () => gate.promise });

  const pending = h.controller.restore(PROJ, entry());
  await flush();

  // POST 已经返回 APPLIED，但对列表的那次确认性读取还没回来
  assert.equal(h.calls.restore, 1);
  assert.equal(h.calls.list, 1, '必须发一次确认性读取');
  const busyNow = h.actions.filter((action) => action.type === 'TRASH_BUSY') as Array<
    Extract<WorkspaceAction, { type: 'TRASH_BUSY' }>
  >;
  assert.equal(busyNow.length, 1, '列表没回来之前不得解除在途');
  assert.equal(busyNow[0].busy, true);

  const midRow = rowOfState(stateOf(h));
  assert.ok(midRow, '这一行仍在列表里');
  assert.equal(midRow!.busy, true);
  assert.equal(midRow!.canRestore, false, '延迟窗口内恢复按钮必须禁用');
  assert.equal(midRow!.stateLabel, '恢复中');

  gate.resolve({
    status: 'APPLIED',
    projectId: PROJ,
    count: 1,
    entries: [entry({ state: 'restored', canRestore: false })],
  });
  const result = await pending;
  assert.equal(result.status, 'applied');

  const finalRow = rowOfState(stateOf(h, [entry({ state: 'restored', canRestore: false })]));
  assert.equal(finalRow!.busy, false, '确认之后才解除在途');
  assert.equal(finalRow!.canRestore, false, '已恢复的记录不能再恢复');
  assert.equal(finalRow!.stateLabel, '已恢复');
});

test('P2-02-R1 恢复：列表刷新失败 → 旧 stored 不得重新开放恢复', async () => {
  const h = makeHarness({
    list: async () => ({ status: 'REJECTED', errorCode: 'ERR_STORAGE_IO', message: '读取失败', httpStatus: 500 }),
  });

  const result = await h.controller.restore(PROJ, entry());
  assert.equal(result.status, 'applied', 'Host 已确认恢复成功，结论仍是 applied');
  assert.ok(h.notices.some((message) => /列表没能刷新/.test(message)), '必须说明"没能确认到"');
  assert.equal(
    h.notices.some((message) => /已把「docs\/guide\.md」恢复到原位置$/.test(message)),
    false,
    '刷新失败时不能只报"已恢复"就结束',
  );

  const row = rowOfState(stateOf(h));
  assert.equal(row!.unconfirmed, true, '转入"待核对"');
  assert.equal(row!.canRestore, false, '刷新失败不构成"可以再试一次"的依据');
  assert.equal(row!.stateLabel, '待核对');
  assert.equal(h.calls.restore, 1, '绝不重发恢复');
});

test('P2-02-R1 恢复：列表仍是 stored（Host 尚未提交）→ 继续保持禁用', async () => {
  const h = makeHarness({
    list: async () => ({ status: 'APPLIED', projectId: PROJ, count: 1, entries: [entry()] }),
  });

  const result = await h.controller.restore(PROJ, entry());
  assert.equal(result.status, 'applied');
  assert.ok(h.notices.some((message) => /列表没能刷新/.test(message)));

  const row = rowOfState(stateOf(h));
  assert.equal(row!.unconfirmed, true);
  assert.equal(row!.canRestore, false, 'stored 不是终态：不能当作"恢复没发生"就放开');
  assert.equal(h.calls.restore, 1);
});

/* ================================================================== */
/* R1-02：多个 opId 的在途状态                                          */
/* ================================================================== */

test('P2-02-R1 并发恢复：A 完成只解除 A，B 保持；刷新也不清 B', async () => {
  const gates = new Map<string, ReturnType<typeof deferred<TrashActionOutcome>>>();
  let listEntries: TrashEntryDto[] = [entry({ opId: 'op-A' }), entry({ opId: 'op-B', path: 'b.md' })];

  const h = makeHarness({
    list: async () => ({ status: 'APPLIED', projectId: PROJ, count: listEntries.length, entries: listEntries }),
    restore: async (_projectId, opId) => {
      const gate = deferred<TrashActionOutcome>();
      gates.set(opId, gate);
      return gate.promise;
    },
  });

  const a = h.controller.restore(PROJ, entry({ opId: 'op-A' }));
  await flush();
  const b = h.controller.restore(PROJ, entry({ opId: 'op-B', path: 'b.md' }));
  await flush();

  const busyIds = (): string[] =>
    (stateOf(h, listEntries).trashByProject[PROJ]?.busyOpIds ?? []).slice().sort();
  assert.deepEqual(busyIds(), ['op-A', 'op-B'], '两条都在途');
  assert.equal(rowOfState(stateOf(h, listEntries), 'op-A')!.busy, true);
  assert.equal(rowOfState(stateOf(h, listEntries), 'op-B')!.busy, true);

  // A 完成：列表里 A 已是 restored，B 仍是 stored
  listEntries = [entry({ opId: 'op-A', state: 'restored', canRestore: false }), entry({ opId: 'op-B', path: 'b.md' })];
  gates.get('op-A')!.resolve({
    status: 'APPLIED',
    projectId: PROJ,
    opId: 'op-A',
    entry: entry({ opId: 'op-A', state: 'restored', canRestore: false }),
    replayed: false,
  });
  assert.equal((await a).status, 'applied');

  const afterA = stateOf(h, listEntries);
  assert.deepEqual((afterA.trashByProject[PROJ]?.busyOpIds ?? []).slice(), ['op-B'], 'A 完成不得清掉 B');
  assert.equal(rowOfState(afterA, 'op-A')!.busy, false);
  assert.equal(rowOfState(afterA, 'op-B')!.busy, true);

  // 手动刷新一次：在途集合不因刷新而清空
  await h.controller.load(PROJ);
  assert.deepEqual((stateOf(h, listEntries).trashByProject[PROJ]?.busyOpIds ?? []).slice(), ['op-B']);

  // B 完成：两条都不在途
  gates.get('op-B')!.resolve({
    status: 'APPLIED',
    projectId: PROJ,
    opId: 'op-B',
    entry: entry({ opId: 'op-B', path: 'b.md', state: 'restored', canRestore: false }),
    replayed: false,
  });
  assert.equal((await b).status, 'applied');
  listEntries = [
    entry({ opId: 'op-A', state: 'restored', canRestore: false }),
    entry({ opId: 'op-B', path: 'b.md', state: 'restored', canRestore: false }),
  ];
  const afterB = stateOf(h, listEntries);
  assert.deepEqual(afterB.trashByProject[PROJ]?.busyOpIds, [], '两条都结束');
  assert.equal(afterB.trashByProject[PROJ]?.count, 2);
});

/* ================================================================== */
/* R1-04：REJECTED 也要核对归属                                          */
/* ================================================================== */

test('P2-02-R1 回收：切走项目后收到 REJECTED → stale，不提示、不刷新', async () => {
  const gate = deferred<TrashActionOutcome>();
  const h = makeHarness({ remove: () => gate.promise });

  const pending = h.controller.remove(PROJ, 'a.md');
  h.setIdentity({ activeProjectId: OTHER });
  gate.resolve({
    status: 'REJECTED',
    projectId: PROJ,
    opId: OP,
    errorCode: 'ERR_TRASH_FULL',
    message: '满了',
    httpStatus: 409,
  });

  const result = await pending;
  assert.equal(result.status, 'stale');
  assert.equal(h.notices.length, 0, '旧项目的错误不得显示到当前界面');
  assert.deepEqual(h.refreshes, [], '也不得刷新旧项目');
});

test('P2-02-R1 恢复：切走项目后收到 REJECTED → stale，不提示、不解除别人的界面', async () => {
  const gate = deferred<TrashActionOutcome>();
  const h = makeHarness({ restore: () => gate.promise });

  const pending = h.controller.restore(PROJ, entry());
  h.setIdentity({ activeProjectId: OTHER });
  gate.resolve({
    status: 'REJECTED',
    projectId: PROJ,
    opId: OP,
    errorCode: 'ERR_ENTRY_EXISTS',
    message: '同名',
    httpStatus: 409,
  });

  const result = await pending;
  assert.equal(result.status, 'stale');
  assert.equal(h.notices.length, 0);
  assert.deepEqual(h.refreshes, []);
});

/* ================================================================== */
/* R1-05：发送前的身份闸                                                */
/* ================================================================== */

test('P2-02-R1 回收：项目已切走 → 零 POST、零刷新', async () => {
  const h = makeHarness();
  h.setIdentity({ activeProjectId: OTHER });

  const result = await h.controller.remove(PROJ, 'a.md');
  assert.equal(result.status, 'stale');
  assert.equal(h.calls.remove, 0, '归属不符时一个请求都不发');
  assert.deepEqual(h.refreshes, []);
  assert.equal(h.notices.length, 0);
});

test('P2-02-R1 回收：项目不可用 → 明确阻断，零 POST', async () => {
  const h = makeHarness();
  h.setProjectReady(false);

  const result = await h.controller.remove(PROJ, 'a.md');
  assert.equal(result.status, 'rejected');
  assert.match(result.status === 'rejected' ? result.message : '', /项目当前不可用/);
  assert.equal(h.calls.remove, 0);
});

test('P2-02-R1 恢复：切走项目 → 零 POST（不能只看 entry.state）', async () => {
  const h = makeHarness();
  h.setIdentity({ activeProjectId: OTHER });

  const result = await h.controller.restore(PROJ, entry());
  assert.equal(result.status, 'stale');
  assert.equal(h.calls.restore, 0, '恢复同样要过身份闸');
  assert.deepEqual(h.refreshes, []);
});

test('P2-02-R1 恢复：项目不可用 → 明确阻断，零 POST', async () => {
  const h = makeHarness();
  h.setProjectReady(false);

  const result = await h.controller.restore(PROJ, entry());
  assert.equal(result.status, 'rejected');
  assert.equal(h.calls.restore, 0);
});

test('P2-02-R1 恢复：工作区身份变了（同项目 id）→ stale，不落地', async () => {
  const gate = deferred<TrashActionOutcome>();
  const h = makeHarness({ restore: () => gate.promise });

  const pending = h.controller.restore(PROJ, entry());
  h.setIdentity({ workspaceKey: 'ws-key-0000000000002', epoch: 2 });
  gate.resolve({
    status: 'APPLIED',
    projectId: PROJ,
    opId: OP,
    entry: entry({ state: 'restored', canRestore: false }),
    replayed: false,
  });

  const result = await pending;
  assert.equal(result.status, 'stale');
  assert.equal(
    types(h.actions).includes('TRASH_LOADED'),
    false,
    '换了工作区：列表结果不得写进新工作区的桶',
  );
  assert.equal(h.notices.length, 0);
});

/* ================================================================== */
/* R1-05：确认框的归属判定（纯函数，`.tsx` 只留一行调用）                  */
/* ================================================================== */

test('P2-02-R1 确认框：切项目 / 换工作区 / 换代次 → 不属于当前界面', () => {
  const dialog = openDialog({ path: 'a.md', reasons: [], workspaceKey: 'key-A', epoch: 3 });
  const base = { workspaceKey: 'key-A', epoch: 3, activeProjectId: PROJ };

  assert.equal(dialogBelongsTo(dialog, base), true);

  assert.equal(
    dialogBelongsTo(dialog, { ...base, activeProjectId: OTHER }),
    false,
    '切到别的项目后，A 的命令不再属于当前界面',
  );
  assert.equal(
    dialogBelongsTo(dialog, { ...base, workspaceKey: 'key-B' }),
    false,
    '换工作区（即使项目 id 相同）也不属于',
  );
  assert.equal(dialogBelongsTo(dialog, { ...base, epoch: 4 }), false, '切模式/重连后作废');
});

test('P2-02-R1 确认框：归属不符时确认 = 零 POST、零磁盘修改', async () => {
  const h = makeHarness();
  const dialog = openDialog({ path: 'a.md', reasons: [] });

  // 用户打开确认框后切到项目 B
  h.setIdentity({ activeProjectId: OTHER });

  let posts = 0;
  const submit = async (projectId: string, path: string): Promise<TrashActionResult> => {
    posts += 1;
    return h.controller.remove(projectId, path);
  };

  // 组件里的真实顺序：先判归属，通过了才提交
  if (dialogBelongsTo(dialog, h.host.identity())) {
    await submitTrashDelete(dialog, submit);
  }

  assert.equal(posts, 0, '归属不符时一次都不提交');
  assert.equal(h.calls.remove, 0, '控制器同样不会发请求');
  assert.equal(h.notices.length, 0);
});
