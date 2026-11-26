/**
 * UX-02C-03-P2-03-R1-02：**真实发送链路**上的最终授权检查。
 *
 * 与套件 96 的分工：
 * - 96 用假端口证明编排时序（预留、结算、在途、归属）；
 * - 这里用**真实** `createTrashController` + **真实** `createLiveClient` + 真实
 *   `sessionToken()` await + 真实 `fetch()` 调用，只把 `globalThis.fetch` 换成一个
 *   可控的桩，用来精确制造"会话令牌在途"这个窗口。
 *
 * 为什么必须这样：缺陷的窗口就在 `restoreTrash()` 内部——
 * `await sessionToken()` 之后才发 POST。任何"假端口"测试都无法复现这一点，
 * 因为假端口把整段发送链路压成了一个函数调用。
 *
 * 控制的确定性：不用随机 sleep。令牌响应是一个由测试显式放行的 deferred，
 * "请求已经发出"用计数器确认，绝不用时间猜。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createDemoClient,
  createLiveClient,
  TRASH_SEND_GATE_MESSAGES,
  type TrashActionOutcome,
  type TrashEntryDto,
  type TrashListOutcome,
  type TrashOpQueryOutcome,
  type TrashSendGate,
  type WeaveSpaceClient,
} from '../../apps/shell/src/client/client-api.ts';
import {
  createTrashController,
  type TrashHost,
  type TrashIdentity,
} from '../../apps/shell/src/state/trash.ts';
import {
  createInlineCoordination,
  createTrashLedgerStore,
  MAX_TRASH_PENDING,
  type TrashPendingRecord,
} from '../../apps/shell/src/state/trash-ledger.ts';
import type { StorageLike } from '../../apps/shell/src/state/workspace-persistence.ts';

const PROJ = 'project-a';
const OTHER = 'project-b';
const OP = 'op-send-0001';
const WORKSPACE = 'a1b2c3d4e5f60718';

function entry(overrides: Partial<TrashEntryDto> = {}): TrashEntryDto {
  return {
    opId: OP,
    path: 'docs/guide.md',
    entryKind: 'file',
    size: 12,
    deletedAt: '2026-11-27T00:00:00.000Z',
    state: 'stored',
    canRestore: true,
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 让出一轮宏任务：台账预留要拿锁、写两层存储，POST 一定在它之后。 */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** 反复让出，直到条件成立（有上限，失败时给出真实计数而不是超时）。 */
async function until(predicate: () => boolean, label: string, rounds = 200): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`等待超时：${label}`);
}

function memoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

interface FetchHarness {
  /** 按发生顺序记录的事件，用来证明"令牌 → 最终裁决 → POST"的调用顺序。 */
  events: string[];
  /** 已发出的 restore POST 数（请求级计数，不是"按钮点了没"）。 */
  posts: number;
  restoreBodies: Array<{ projectId?: unknown; opId?: unknown }>;
  tokenRequests: number;
  /** 暂停下一次 session-token 响应；返回放行函数。 */
  pauseNextToken(): () => void;
  restore(): void;
}

/**
 * 把 `globalThis.fetch` 换成一个只认识三个端点的桩。
 *
 * 关键点：`/api/session-token` 的响应可以停在 deferred 上——这正是真实浏览器里
 * "令牌请求在途"的那个窗口，而且完全确定（不存在"运气好没撞上"）。
 */
function installFetch(options: { restoreStatus?: number } = {}): FetchHarness {
  const events: string[] = [];
  let tokenGate: Promise<void> | null = null;
  const harness: FetchHarness = {
    events,
    posts: 0,
    restoreBodies: [],
    tokenRequests: 0,
    pauseNextToken() {
      const gate = deferred<void>();
      tokenGate = gate.promise;
      return () => {
        tokenGate = null;
        gate.resolve(undefined);
      };
    },
    restore() {
      tokenGate = null;
    },
  };

  const json = (body: unknown, status: number) => ({
    status,
    json: async () => body,
  });

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/session-token')) {
      harness.tokenRequests += 1;
      events.push('token:request');
      // 只暂停"这一次"：放行后清空，后续请求不再被拦住
      const gate = tokenGate;
      if (gate) await gate;
      events.push('token:resolve');
      return json({ status: 'APPLIED', token: 'test-token' }, 200);
    }
    if (url.endsWith('/api/trash/restore')) {
      harness.posts += 1;
      events.push('post:restore');
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      harness.restoreBodies.push({ projectId: body.projectId, opId: body.opId });
      const status = options.restoreStatus ?? 200;
      return json(
        {
          status: 'APPLIED',
          projectId: body.projectId,
          opId: body.opId,
          entry: entry({ opId: String(body.opId), state: 'restored', canRestore: false }),
          replayed: false,
        },
        status,
      );
    }
    if (url.includes('/api/trash/op')) {
      events.push('query:op');
      return json({ status: 'APPLIED', outcome: 'restored', state: 'restored' }, 200);
    }
    events.push(`unexpected:${method}:${url}`);
    return json({ status: 'REJECTED', errorCode: 'ERR_COMMAND_INVALID', message: '未预期的请求' }, 400);
  }) as typeof fetch;

  return harness;
}

interface Harness {
  host: TrashHost;
  controller: ReturnType<typeof createTrashController>;
  /** 真实 live client（H1-T02～T04 要直接驱动它的发送链路）。 */
  client: WeaveSpaceClient;
  net: FetchHarness;
  calls: { list: number; restore: number; query: number };
  actions: string[];
  notices: string[];
  identity: TrashIdentity;
  setIdentity(patch: Partial<TrashIdentity>): void;
  ledger(): readonly TrashPendingRecord[];
  prefillLedger(n: number): Promise<void>;
  externalDelete(): boolean;
  gate(): string | null;
  uninstall(): void;
}

interface HarnessOptions {
  /** 第 N 次 `verifyPending()` 抛异常（1-based）：构造"最终裁决内部炸了"的真实链路。 */
  readonly verifyThrowsOnCall?: number;
  /** 适配层把 gate 换掉（模拟漏传/错传的旧适配层）。 */
  readonly gateOverride?: TrashSendGate;
}

/**
 * 真实 Controller + 真实 Client API 的最小装配。
 *
 * 只有三处是假的：列表读取、只读核对、以及 `fetch` 本身。发送链路是真的：
 * `postTrashAction` → `sessionToken()`（真实 await）→ 最终裁决 → `request()` → `fetch()`。
 */
function makeHarness(tokenPaused: boolean, options: HarnessOptions = {}): Harness {
  const originalFetch = globalThis.fetch;
  const net = installFetch();
  const release = tokenPaused ? net.pauseNextToken() : () => undefined;

  const storage = memoryStorage();
  const ledgerStore = createTrashLedgerStore(storage, { status: 'ok', records: [] }, createInlineCoordination());
  /**
   * 身份必须是**可变绑定**，不能是"同一个对象就地改字段"。
   *
   * 编排器在发起时会 `capture()` 一份快照；如果 `setIdentity` 用 `Object.assign` 改同一个对象，
   * 快照会被一起改掉，`owned()` 永远为真——那样这条用例就成了"无论怎么切都通过"的假绿。
   * 真实界面里 `state` 每次都是新对象，这里必须同构。
   */
  let identity: TrashIdentity = {
    mode: 'live',
    workspaceMode: 'multi',
    workspaceKey: WORKSPACE,
    activeProjectId: PROJ,
    epoch: 1,
  };
  const calls = { list: 0, restore: 0, query: 0 };
  const actions: string[] = [];
  const notices: string[] = [];
  const client = createLiveClient('http://host.test');
  /** 只用于 H1-T06：让**最终裁决内部**（而不是早先那次复核）抛异常。 */
  let verifyCalls = 0;

  const host: TrashHost = {
    port: {
      list: async (): Promise<TrashListOutcome> => {
        calls.list += 1;
        return {
          status: 'APPLIED',
          projectId: PROJ,
          count: 1,
          entries: [entry({ state: 'restored', canRestore: false })],
        };
      },
      remove: async (projectId, _path, opId): Promise<TrashActionOutcome> => ({
        status: 'APPLIED',
        projectId,
        opId,
        entry: entry({ opId }),
        replayed: false,
      }),
      // 真实发送链路：gate 会被 client-api 在令牌之后同步调用
      restore: (projectId, opId, gate: TrashSendGate) => {
        calls.restore += 1;
        return client.restoreTrash(projectId, opId, options.gateOverride ?? gate);
      },
      query: async (projectId, opId): Promise<TrashOpQueryOutcome> => {
        calls.query += 1;
        return { status: 'APPLIED', opId, outcome: 'restored', state: 'restored' };
      },
    },
    identity: () => {
      net.events.push('gate:identity');
      return identity;
    },
    dispatch: (action) => actions.push(action.type),
    newOpId: () => 'op-new-00000001',
    notify: (message) => notices.push(message),
    supported: () => true,
    restoreGate: () => ledgerStore.blockMessage(),
    reservePending: async (target) => {
      const outcome = await ledgerStore.reserve({ ...target, createdAt: '2026-11-27T00:00:00.000Z' });
      if (outcome.status === 'reserved') return { ok: true as const };
      if (outcome.status === 'exists') {
        return { ok: false as const, message: '这条记录上一次恢复的结果还没有确认，已取消本次恢复（不会重复发送操作）。' };
      }
      if (outcome.status === 'write-failed') {
        return { ok: false as const, message: '本机存储写入失败，已取消（未发送请求）。' };
      }
      return { ok: false as const, message: ledgerStore.blockMessage() ?? '本机的「待核对」记录已满，恢复已关闭。' };
    },
    verifyPending: (target) => {
      verifyCalls += 1;
      net.events.push('gate:verify');
      if (options.verifyThrowsOnCall === verifyCalls) throw new Error('注入：台账读取抛出异常');
      return ledgerStore.verifyPending(target);
    },
    releasePending: async (target) => {
      await ledgerStore.release({ ...target, opIds: [target.opId] });
    },
    preflight: (projectId) => {
      if (identity.mode !== 'live' || identity.workspaceMode !== 'multi') {
        return { ok: false, kind: 'stale' as const };
      }
      if (identity.activeProjectId !== projectId) return { ok: false, kind: 'stale' as const };
      return { ok: true as const };
    },
    blockers: () => [],
    refreshAfterRemoval: async () => undefined,
    refreshAfterRestore: async () => undefined,
  };

  const controller = createTrashController(host);
  // 令牌响应必须由测试放行：把放行函数挂在 net 上，供用例在"切身份之后"调用
  (net as FetchHarness & { releaseToken: () => void }).releaseToken = release;

  return {
    host,
    controller,
    client,
    net,
    calls,
    actions,
    notices,
    identity,
    setIdentity(patch) {
      // 换**新对象**：编排器手里的快照必须保持"发起时"的样子
      identity = { ...identity, ...patch };
    },
    ledger: () => ledgerStore.records(),
    async prefillLedger(n) {
      for (let i = 0; i < n; i += 1) {
        await ledgerStore.reserve({
          workspaceKey: WORKSPACE,
          projectId: PROJ,
          opId: `op-fill-${String(i).padStart(8, '0')}`,
          createdAt: '2026-11-27T00:00:00.000Z',
        });
      }
    },
    externalDelete() {
      storage.removeItem('ws:trash-pending:v1');
      return ledgerStore.applyExternalEvent({ key: 'ws:trash-pending:v1', newValue: null });
    },
    gate: () => ledgerStore.blockMessage(),
    uninstall() {
      globalThis.fetch = originalFetch;
    },
  };
}

const releaseToken = (h: Harness): void => {
  (h.net as FetchHarness & { releaseToken: () => void }).releaseToken();
};

/* ================================================================== */
/* A. 令牌在途时切换项目 → 零 POST                                      */
/* ================================================================== */

test('R1-02A 会话令牌在途时切换项目：零恢复 POST，静默返回 stale', async () => {
  const h = makeHarness(true);
  try {
    const pending = h.controller.restore(PROJ, entry());
    // 等到"令牌请求已经发出、响应还没回来"的那一刻
    await until(() => h.net.tokenRequests === 1, '会话令牌请求已发出');
    assert.equal(h.net.posts, 0, '前提：此刻还没有 POST');

    h.setIdentity({ activeProjectId: OTHER });
    releaseToken(h);

    const result = await pending;
    assert.equal(result.status, 'stale', '归属已变：静默丢弃');
    assert.equal(h.net.posts, 0, '真实恢复 POST 必须是 0（不是"按钮被禁用"）');
    assert.equal(h.calls.restore, 1, '编排层确实尝试过一次发送');
    assert.deepEqual(h.notices, [], '不能给旧项目弹任何提示');
    assert.deepEqual(h.ledger(), [], '零副作用：这次预留可以安全结算');
  } finally {
    h.uninstall();
  }
});

test('R1-02A 会话令牌在途时换工作区（同项目 id、代次 +1）：零恢复 POST', async () => {
  const h = makeHarness(true);
  try {
    const pending = h.controller.restore(PROJ, entry());
    await until(() => h.net.tokenRequests === 1, '会话令牌请求已发出');

    /*
     * 刻意**只**改工作区身份，不动 mode / activeProjectId：
     * `preflight` 看不到 workspaceKey 与 epoch，因此只有最终裁决里的 `owned()`
     * 能拦住这次发送。用 mode 切换来构造这条用例是不成立的——那会被 preflight
     * 提前挡下，等于没测到"最终裁决"本身。
     */
    h.setIdentity({ workspaceKey: 'b1b2c3d4e5f60718', epoch: 2 });
    releaseToken(h);

    const result = await pending;
    assert.equal(result.status, 'stale');
    assert.equal(h.net.posts, 0, '换工作区后旧身份的任何 POST 都不许发出');
    assert.deepEqual(h.ledger(), [], '零副作用：这次预留可以安全结算');
  } finally {
    h.uninstall();
  }
});

/* ================================================================== */
/* B. 令牌在途时台账失效 → 零 POST，记录保守保留                          */
/* ================================================================== */

test('R1-02B 会话令牌在途时台账被外部删除：零恢复 POST，待核对记录保留', async () => {
  const h = makeHarness(true);
  try {
    const pending = h.controller.restore(PROJ, entry());
    await until(() => h.net.tokenRequests === 1, '会话令牌请求已发出');
    assert.equal(h.net.posts, 0, '前提：此刻还没有 POST');
    assert.deepEqual(h.ledger().map((record) => record.opId), [OP], '前提：预留已经落盘');

    // 另一个标签页 removeItem + storage 事件（newValue === null）
    assert.equal(h.externalDelete(), true);
    releaseToken(h);

    const result = await pending;
    assert.equal(result.status, 'rejected', '授权已失效：明确拒绝，不发请求');
    assert.equal(h.net.posts, 0, '平台失效之后不许再发真实 POST');
    assert.deepEqual(
      h.ledger().map((record) => record.opId),
      [OP],
      '失效时不得强行清除这条待核对记录（它背后可能有一次已经发出的恢复）',
    );
    assert.notEqual(h.gate(), null, '界面必须看到关闭原因');
    assert.equal(h.net.events.includes('post:restore'), false);
  } finally {
    h.uninstall();
  }
});

/* ================================================================== */
/* C. 正常控制组：恰好一次 POST                                          */
/* ================================================================== */

test('R1-02C 身份不变、台账有效：恰好一次恢复 POST，且请求体只带项目内相对身份', async () => {
  const h = makeHarness(false);
  try {
    const result = await h.controller.restore(PROJ, entry());

    assert.equal(result.status, 'applied');
    assert.equal(h.net.posts, 1, '恰好一次');
    assert.deepEqual(h.net.restoreBodies, [{ projectId: PROJ, opId: OP }]);
    assert.equal(h.calls.query, 0, '明确的 200 APPLIED 不需要只读核对');
  } finally {
    h.uninstall();
  }
});

test('R1-02C 调用顺序：令牌请求 → 最终裁决 → 真实 POST', async () => {
  const h = makeHarness(false);
  try {
    await h.controller.restore(PROJ, entry());

    const order = h.net.events.filter((event) =>
      event === 'token:request' || event === 'token:resolve' || event === 'gate:verify' || event === 'post:restore',
    );
    /*
     * 顺序即证据：
     * - 两道门都在（早先的"快速失败"没有被最终裁决取代）；
     * - 最后一道裁决发生在**令牌解析之后**（否则窗口没被覆盖）；
     * - 紧接着才是真实 POST（否则等于没检查）。
     */
    assert.equal(order.filter((event) => event === 'gate:verify').length, 2, '早先检查 + 最终裁决，两道门');
    assert.deepEqual(order.slice(-3), ['token:resolve', 'gate:verify', 'post:restore']);
  } finally {
    h.uninstall();
  }
});

/* ================================================================== */
/* D. 第 64 格：最终复核不得因为"满了"拒绝已获得的授权                     */
/* ================================================================== */

test('R1-02D 预留恰好占满第 64 格：最终复核仍然放行，POST 恰好一次', async () => {
  const h = makeHarness(false);
  try {
    await h.prefillLedger(MAX_TRASH_PENDING - 1);
    assert.equal(h.ledger().length, MAX_TRASH_PENDING - 1);

    const result = await h.controller.restore(PROJ, entry());

    assert.equal(result.status, 'applied', '第 64 格是合法授权');
    assert.equal(h.net.posts, 1, '必须真的发出去（不是"满了所以拒绝"）');
    assert.equal(h.ledger().length, MAX_TRASH_PENDING);
  } finally {
    h.uninstall();
  }
});

/* ================================================================== */
/* H1（R1-H1）：最终发送授权强制化 + gate 异常的隔离                     */
/* ================================================================== */
/*
 * R1 之后 gate 仍然是可选参数：任何一个模块只要写 `restoreTrash(projectId, opId)`，
 * 就能绕过最终授权直接发一次真实恢复；而 gate 自己抛异常时，异常会一路冒到 Controller
 * 的 catch，被当成"网络中断"记成 UNKNOWN——一笔根本没发出去的恢复进了「待核对」。
 *
 * 下面八条按 H1-T01～T08 编号，全部走真实 Client API（`postTrashAction` →
 * `sessionToken()` → 裁决 → `fetch()`），只有 `fetch` 是桩。
 */

test('H1-T01 正常传入有效 gate：恢复成功，恰好一次 POST', async () => {
  const h = makeHarness(false);
  try {
    const result = await h.controller.restore(PROJ, entry());
    assert.equal(result.status, 'applied');
    assert.equal(h.net.posts, 1, '恰好一次');
    assert.deepEqual(h.net.restoreBodies, [{ projectId: PROJ, opId: OP }]);
    /*
     * 成功路径**不**在这里释放预留：控制器只负责"这次请求有没有发出去、结论可不可用"，
     * 台账的收敛由 Provider 在"一次成功的列表读取"之后做（reconcile）。
     * 这里只断言它没有被标成待核对。
     */
    assert.equal(h.actions.includes('TRASH_UNCONFIRMED'), false);
  } finally {
    h.uninstall();
  }
});

test('H1-T02 运行时缺少 gate（JS 调用方/旧适配层）：NOT_SENT，零恢复 POST', async () => {
  const h = makeHarness(false);
  try {
    // 类型必须要求 gate；这里刻意用类型断言绕过，模拟"运行时真的漏传"
    const outcome = await h.client.restoreTrash(PROJ, OP, undefined as unknown as TrashSendGate);
    assert.equal(outcome.status, 'NOT_SENT', JSON.stringify(outcome));
    if (outcome.status !== 'NOT_SENT') return;
    assert.equal(outcome.reason, 'blocked', 'fail-closed：与"没有授权"同性质');
    assert.equal(outcome.message, TRASH_SEND_GATE_MESSAGES.unavailable);
    assert.equal(h.net.posts, 0, '零恢复 POST（不是"发了但失败了"）');
    assert.equal(h.net.tokenRequests, 1, '令牌先取到：保护发生在真正的 POST 边界上');
    assert.equal(h.net.events.includes('post:restore'), false);
  } finally {
    h.uninstall();
  }
});

test('H1-T02b 运行时 gate 不是函数：同样 NOT_SENT，零恢复 POST', async () => {
  const h = makeHarness(false);
  try {
    const outcome = await h.client.restoreTrash(PROJ, OP, 'not-a-function' as unknown as TrashSendGate);
    assert.equal(outcome.status, 'NOT_SENT');
    if (outcome.status !== 'NOT_SENT') return;
    assert.equal(outcome.reason, 'blocked');
    assert.equal(outcome.message, TRASH_SEND_GATE_MESSAGES.unavailable);
    assert.equal(h.net.posts, 0);
  } finally {
    h.uninstall();
  }
});

test('H1-T03 gate 抛出异常：NOT_SENT（不是 UNKNOWN），零恢复 POST', async () => {
  const h = makeHarness(false);
  try {
    const outcome = await h.client.restoreTrash(PROJ, OP, () => {
      throw new Error('注入：凭证服务炸了');
    });
    assert.equal(outcome.status, 'NOT_SENT', '绝不能变成 UNKNOWN——那会触发只读核对并留下待核对');
    if (outcome.status !== 'NOT_SENT') return;
    assert.equal(outcome.reason, 'blocked');
    assert.equal(outcome.message, TRASH_SEND_GATE_MESSAGES.threw);
    assert.equal(h.net.posts, 0);
    assert.equal(h.net.events.includes('post:restore'), false);
    assert.equal(h.net.events.includes('query:op'), false, '没有 UNKNOWN，就没有只读核对');
  } finally {
    h.uninstall();
  }
});

test('H1-T03b gate 返回无法识别的形状：fail-closed，零恢复 POST', async () => {
  const h = makeHarness(false);
  try {
    const outcome = await h.client.restoreTrash(PROJ, OP, () => undefined as unknown as { ok: true });
    assert.equal(outcome.status, 'NOT_SENT');
    if (outcome.status !== 'NOT_SENT') return;
    assert.equal(outcome.reason, 'blocked');
    assert.equal(outcome.message, TRASH_SEND_GATE_MESSAGES.invalid);
    assert.equal(h.net.posts, 0);
  } finally {
    h.uninstall();
  }
});

test('H1-T04 gate 明确拒绝：NOT_SENT 带原样原因，零恢复 POST', async () => {
  const h = makeHarness(false);
  try {
    const outcome = await h.client.restoreTrash(PROJ, OP, () => ({
      ok: false,
      kind: 'blocked',
      message: '注入：权限已撤销',
    }));
    assert.equal(outcome.status, 'NOT_SENT');
    if (outcome.status !== 'NOT_SENT') return;
    assert.equal(outcome.reason, 'blocked');
    assert.equal(outcome.message, '注入：权限已撤销', 'gate 给出的原因必须原样上抛');
    assert.equal(h.net.posts, 0);
  } finally {
    h.uninstall();
  }
});

test('H1-T05 gate 拒绝后不进入 UNKNOWN 核对，也不标"待核对"', async () => {
  // 适配层把 gate 换成一个总是拒绝的实现（"错传 gate"的真实形态）
  const h = makeHarness(false, {
    gateOverride: () => ({ ok: false, kind: 'blocked', message: '注入：拒绝发送' }),
  });
  try {
    const result = await h.controller.restore(PROJ, entry());

    assert.equal(result.status, 'rejected', JSON.stringify(result));
    assert.equal(h.net.posts, 0);
    assert.equal(h.calls.query, 0, 'NOT_SENT 不是 UNKNOWN：不许做只读核对');
    assert.equal(h.actions.includes('TRASH_UNCONFIRMED'), false, '不许把记录标成待核对');
    assert.deepEqual(h.ledger(), [], '零副作用 → 预留正常释放');
  } finally {
    h.uninstall();
  }
});

test('H1-T06 最终裁决内部抛异常：预留正常释放，不遗留待核对', async () => {
  // 第 2 次 verifyPending 是"最终裁决"里的那次（第 1 次是发 POST 之前的快速失败）
  const h = makeHarness(false, { verifyThrowsOnCall: 2 });
  try {
    const result = await h.controller.restore(PROJ, entry());

    assert.equal(result.status, 'rejected', JSON.stringify(result));
    assert.equal(result.message, TRASH_SEND_GATE_MESSAGES.threw);
    assert.equal(h.net.posts, 0, '异常不等于已发送');
    assert.equal(h.calls.query, 0, '不许进入 UNKNOWN 核对');
    assert.equal(h.actions.includes('TRASH_UNCONFIRMED'), false);
    assert.deepEqual(h.ledger().map((record) => record.opId), [], '预留必须被释放');
    assert.equal(h.gate(), null, '台账仍然可用（没有被这次异常污染）');
  } finally {
    h.uninstall();
  }
});

test('H1-T07 Demo 恢复：仍返回不支持，零请求、零磁盘副作用', async () => {
  const h = makeHarness(false);
  try {
    const demo = createDemoClient([], {});
    const outcome = await demo.restoreTrash(PROJ, OP, () => ({ ok: true }));
    assert.equal(outcome.status, 'REJECTED', JSON.stringify(outcome));
    if (outcome.status !== 'REJECTED') return;
    assert.equal(outcome.errorCode, 'ERR_COMMAND_UNSUPPORTED');
    assert.equal(outcome.httpStatus, 501);
    assert.equal(h.net.posts, 0, '演示模式不发真实恢复请求');
    assert.equal(h.net.tokenRequests, 0, '连会话令牌都不取');
  } finally {
    h.uninstall();
  }
});

test('H1-T08 最终发送顺序仍是：令牌 → 裁决 → POST', async () => {
  const h = makeHarness(false);
  try {
    await h.controller.restore(PROJ, entry());
    const order = h.net.events.filter(
      (event) =>
        event === 'token:request' || event === 'token:resolve' || event === 'gate:verify' || event === 'post:restore',
    );
    // 早先那次快速失败 + 最终裁决 = 两次；最后三件事必须是 令牌解析 → 最终裁决 → POST
    assert.equal(order.filter((event) => event === 'gate:verify').length, 2);
    assert.deepEqual(order.slice(-3), ['token:resolve', 'gate:verify', 'post:restore']);
  } finally {
    h.uninstall();
  }
});
