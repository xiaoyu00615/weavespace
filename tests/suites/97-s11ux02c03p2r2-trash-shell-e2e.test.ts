/**
 * UX-02C-03-P2-02：回收区 Shell 链路（真实 Host + 真实 FileProjectStore + 真实磁盘 + 真实 HTTP）。
 *
 * 与 87–94 的分工：
 * - 87–94 证明**后端**语义（事务、CAS、对账、安全）；
 * - 本套件证明**Shell 用的那条客户端链路**真的接上了这些能力：`createLiveClient`
 *   发出的请求、回执形状、以及"回收 → 文件树消失 → 列表出现 → 恢复 → 文件树回来"。
 *
 * 不 mock fetch、不 mock 磁盘：断言的是文件真的被移动/移回，字节真的没变。
 */
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { serializeConfig, type ConfigTrashEntry } from '../../apps/server/src/store/config.ts';
import {
  createLiveClient,
  type TrashEntryDto,
  type TrashSendGate,
  type WeaveSpaceClient,
} from '../../apps/shell/src/client/client-api.ts';
import { createTrashController, type TrashHost } from '../../apps/shell/src/state/trash.ts';
import {
  createInlineCoordination,
  createTrashLedgerStore,
  type TrashPendingRecord,
} from '../../apps/shell/src/state/trash-ledger.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import { rootTokenOf } from '../../packages/storage/path-safety.ts';

const PROJ_A = 'project-a';
const PROJ_B = 'project-b';
const OP = 'op-p202-e2e-0001';

/**
 * 本套件证明的是**传输链路**（真实 Host + 真实磁盘 + 真实 HTTP），不是授权本身。
 * R1-H1 之后 `restoreTrash()` 的 gate 是必填参数，这里统一给一个"永远允许"的裁决，
 * 让这一层不参与判定；授权本身由套件 100 的 H1-T01～T08 覆盖。
 */
const allowGate: TrashSendGate = () => ({ ok: true });

interface Ctx {
  rootA: string;
  rootB: string;
  server: ShellServer;
  client: WeaveSpaceClient;
}

async function withHost(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-p202-e2e-'));
  const storeDir = join(base, 'store');
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(storeDir, { recursive: true });
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');
  await writeFile(join(rootA, 'b.md'), '# B\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'guide.md'), '# guide\n', 'utf8');
  await writeFile(join(rootB, 'z.md'), '# Z\n', 'utf8');

  const project = (projectId: string, name: string, rootDir: string) => ({
    projectId,
    name,
    rootDir,
    canonicalRoot: realpathSync(rootDir),
    rootToken: rootTokenOf(rootDir),
    grantedAt: '2026-11-23T00:00:00.000Z',
    grantSource: 'os-dialog',
  });

  await writeFile(
    join(storeDir, 'workspace.json'),
    serializeConfig({
      version: 4,
      commitSeq: 0,
      issuedIds: [PROJ_A, PROJ_B],
      revoked: [],
      projects: [project(PROJ_A, '项目 A', rootA), project(PROJ_B, '项目 B', rootB)],
      hidden: [],
      trash: [],
    }),
    'utf8',
  );

  const server = await createShellServer({
    port: 0,
    managedStore: { dir: storeDir, picker: createFakePicker([]) },
  });
  const client = createLiveClient(server.url);
  const restoreFetch = installBrowserOrigin(server.url);
  try {
    await fn({ rootA, rootB, server, client });
  } finally {
    restoreFetch();
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
}

/**
 * 复现浏览器的 `Origin` 行为。
 *
 * 浏览器对**同源 POST** 一定会带 `Origin`；Node 的 `fetch` 不会。Host 的变更类端点
 * 要求显式 Origin（防 CSRF），所以在 Node 里跑真实客户端时必须补上这一层，
 * 否则测到的只是"Node 不发 Origin"，而不是 Shell 的行为。
 *
 * 只影响同一个 server 的请求，且不覆盖调用方已经给出的 Origin（越权用例仍可构造）。
 */
function installBrowserOrigin(base: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (!url.startsWith(base)) return original(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') return original(input, init);
    const headers = new Headers(init?.headers ?? {});
    if (!headers.has('origin')) headers.set('origin', base);
    return original(input, { ...init, headers });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function payloadOf(root: string, opId = OP): string {
  return join(root, '.weavespace', 'trash', opId, 'payload');
}

/* ================================================================== */
/* 一、回收 → 树里消失 → 列表出现                                        */
/* ================================================================== */

test('P2-02 回收：真实移动文件，列表出现记录，文件树里不再有它', async () => {
  await withHost(async ({ rootA, client }) => {
    const before = await client.listTrash(PROJ_A);
    assert.equal(before.status, 'APPLIED');
    assert.equal(before.status === 'APPLIED' ? before.count : -1, 0, '初始回收区为空');

    const removed = await client.trashEntry(PROJ_A, 'a.md', OP);
    assert.equal(removed.status, 'APPLIED', JSON.stringify(removed));
    if (removed.status !== 'APPLIED') return;

    assert.equal(removed.entry.path, 'a.md');
    assert.equal(removed.entry.state, 'stored');
    assert.equal(removed.entry.canRestore, true);
    assert.equal(removed.entry.size, Buffer.byteLength('# A\n'));

    // 磁盘：原位置没了、回收区里有、字节一致
    assert.equal(exists(join(rootA, 'a.md')), false, '原文件必须已离开原位置');
    assert.equal(readFileSync(payloadOf(rootA), 'utf8'), '# A\n', '回收区里必须是同一份内容');

    // 文件树：根层不再列出 a.md（Host 的真实目录读取）
    const tree = await client.listTree(PROJ_A, '');
    assert.equal(tree.status, 'APPLIED');
    const names = tree.status === 'APPLIED' ? tree.entries.map((entry) => entry.name) : [];
    assert.deepEqual(names.sort(), ['b.md', 'docs'], '文件树必须立刻反映"文件已不在"');

    // 列表：出现一条 stored
    const after = await client.listTrash(PROJ_A);
    assert.equal(after.status, 'APPLIED');
    if (after.status !== 'APPLIED') return;
    assert.equal(after.count, 1);
    assert.equal(after.entries[0].opId, OP);
    assert.equal(after.entries[0].state, 'stored');
  });
});

/* ================================================================== */
/* 二、恢复 → 树里回来                                                   */
/* ================================================================== */

test('P2-02 恢复：文件回到原路径，字节一致，状态变 restored', async () => {
  await withHost(async ({ rootA, client }) => {
    assert.equal((await client.trashEntry(PROJ_A, 'docs/guide.md', OP)).status, 'APPLIED');

    const restored = await client.restoreTrash(PROJ_A, OP, allowGate);
    assert.equal(restored.status, 'APPLIED', JSON.stringify(restored));
    if (restored.status !== 'APPLIED') return;
    assert.equal(restored.entry.state, 'restored');
    assert.equal(restored.entry.canRestore, false, '已恢复的记录不能再给恢复按钮');

    assert.equal(readFileSync(join(rootA, 'docs', 'guide.md'), 'utf8'), '# guide\n');
    assert.equal(exists(payloadOf(rootA)), false, '回收区里不应再有 payload');

    const tree = await client.listTree(PROJ_A, 'docs');
    const names = tree.status === 'APPLIED' ? tree.entries.map((entry) => entry.name) : [];
    assert.deepEqual(names, ['guide.md'], '恢复后原目录重新出现该文件');

    const list = await client.listTrash(PROJ_A);
    assert.equal(list.status, 'APPLIED');
    if (list.status !== 'APPLIED') return;
    // 记录保留（终态），但不再可恢复
    assert.equal(list.count, 1);
    assert.equal(list.entries[0].state, 'restored');
    assert.equal(list.entries[0].canRestore, false);
  });
});

/* ================================================================== */
/* 三、恢复冲突：绝不覆盖                                                */
/* ================================================================== */

test('P2-02 恢复冲突：原位置已有同名文件 → 409，双方内容都不变', async () => {
  await withHost(async ({ rootA, client }) => {
    assert.equal((await client.trashEntry(PROJ_A, 'a.md', OP)).status, 'APPLIED');
    // 用户又在原位置建了一个同名文件（内容不同）
    await writeFile(join(rootA, 'a.md'), '# 新文件\n', 'utf8');

    const conflict = await client.restoreTrash(PROJ_A, OP, allowGate);
    assert.equal(conflict.status, 'REJECTED', JSON.stringify(conflict));
    if (conflict.status !== 'REJECTED') return;
    assert.equal(conflict.errorCode, 'ERR_ENTRY_EXISTS');
    assert.equal(conflict.httpStatus, 409);

    // 谁都没被覆盖：原位置是新内容，回收区里仍是旧内容
    assert.equal(readFileSync(join(rootA, 'a.md'), 'utf8'), '# 新文件\n', '原位置不得被覆盖');
    assert.equal(readFileSync(payloadOf(rootA), 'utf8'), '# A\n', '回收区内容不得被改动');

    // 记录保持可恢复（stored），用户改名/移走后仍可再试
    const list = await client.listTrash(PROJ_A);
    assert.equal(list.status, 'APPLIED');
    if (list.status !== 'APPLIED') return;
    assert.equal(list.entries[0].state, 'stored');
    assert.equal(list.entries[0].canRestore, true);
  });
});

/* ================================================================== */
/* 四、项目隔离                                                          */
/* ================================================================== */

test('P2-02 项目隔离：A 的回收记录不会出现在 B，reducer 也按桶存放', async () => {
  await withHost(async ({ rootB, client }) => {
    assert.equal((await client.trashEntry(PROJ_A, 'a.md', OP)).status, 'APPLIED');

    const listB = await client.listTrash(PROJ_B);
    assert.equal(listB.status, 'APPLIED');
    if (listB.status !== 'APPLIED') return;
    assert.equal(listB.count, 0, 'B 的回收区必须是空的');
    assert.deepEqual(listB.entries, []);
    assert.equal(exists(join(rootB, '.weavespace')), false, 'B 的项目目录里不该出现回收区');

    // reducer：两个桶互不影响
    let state = workspaceReducer(INITIAL_STATE, { type: 'TRASH_LOADED', projectId: PROJ_A, entries: [
      { opId: OP, path: 'a.md', entryKind: 'file' as const, size: 4, deletedAt: '2026-11-23T00:00:00.000Z', state: 'stored' as const, canRestore: true },
    ], count: 1 });
    state = workspaceReducer(state, { type: 'TRASH_LOADED', projectId: PROJ_B, entries: [], count: 0 });
    assert.equal(state.trashByProject[PROJ_A].count, 1);
    assert.equal(state.trashByProject[PROJ_B].count, 0);
  });
});

/* ================================================================== */
/* 五、七种状态：Host 返回什么，界面就照着显示                            */
/* ================================================================== */

test('P2-02 七种状态：不可恢复的四类原样回传，且 canRestore 一律 false', async () => {
  // 用真实配置直接种下终态记录（aborted / conflicted / missing / restored）
  const base = await mkdtemp(join(tmpdir(), 'ws-p202-states-'));
  const storeDir = join(base, 'store');
  const root = join(base, 'project-a');
  await mkdir(storeDir, { recursive: true });
  await mkdir(root, { recursive: true });

  const mk = (opId: string, state: ConfigTrashEntry['state']): ConfigTrashEntry => ({
    opId,
    projectId: PROJ_A,
    rootToken: rootTokenOf(root),
    originalPath: `${opId}.md`,
    entryKind: 'file',
    identity: '1:2',
    size: 4,
    deletedAt: '2026-11-23T00:00:00.000Z',
    state,
  });

  await writeFile(
    join(storeDir, 'workspace.json'),
    serializeConfig({
      version: 4,
      commitSeq: 0,
      issuedIds: [PROJ_A],
      revoked: [],
      projects: [{
        projectId: PROJ_A,
        name: '项目 A',
        rootDir: root,
        canonicalRoot: realpathSync(root),
        rootToken: rootTokenOf(root),
        grantedAt: '2026-11-23T00:00:00.000Z',
        grantSource: 'os-dialog',
      }],
      hidden: [],
      trash: [
        mk('op-state-aborted1', 'aborted'),
        mk('op-state-conflict', 'conflicted'),
        mk('op-state-missing1', 'missing'),
        mk('op-state-restored', 'restored'),
      ],
    }),
    'utf8',
  );

  const server = await createShellServer({
    port: 0,
    managedStore: { dir: storeDir, picker: createFakePicker([]) },
  });
  try {
    const client = createLiveClient(server.url);
    const list = await client.listTrash(PROJ_A);
    assert.equal(list.status, 'APPLIED');
    if (list.status !== 'APPLIED') return;

    const byState = new Map(list.entries.map((entry) => [entry.state, entry]));
    for (const state of ['aborted', 'conflicted', 'missing', 'restored'] as const) {
      const row = byState.get(state);
      assert.ok(row, `必须回传 ${state} 记录`);
      assert.equal(row!.canRestore, false, `${state} 不得允许恢复`);
    }
    assert.equal(list.count, 4);
  } finally {
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});

/* ================================================================== */
/* 六、按 opId 只读核对                                                  */
/* ================================================================== */

test('P2-02 opId 核对：已回收→trashed，无记录→none，跨项目→拒绝', async () => {
  await withHost(async ({ client }) => {
    assert.equal((await client.trashEntry(PROJ_A, 'a.md', OP)).status, 'APPLIED');

    const known = await client.queryTrashOp(PROJ_A, OP);
    assert.equal(known.status, 'APPLIED', JSON.stringify(known));
    if (known.status !== 'APPLIED') return;
    assert.equal(known.outcome, 'trashed');
    assert.equal(known.state, 'stored');

    const unknownOp = await client.queryTrashOp(PROJ_A, 'op-does-not-exist');
    assert.equal(unknownOp.status, 'APPLIED');
    assert.equal(unknownOp.status === 'APPLIED' ? unknownOp.outcome : null, 'none');

    // 跨项目查询不得确认"这个 opId 在别处存在"
    const cross = await client.queryTrashOp(PROJ_B, OP);
    assert.equal(cross.status, 'REJECTED');
    assert.equal(cross.status === 'REJECTED' ? cross.errorCode : null, 'ERR_TRASH_RECORD_NOT_FOUND');
  });
});

/* ================================================================== */
/* 七、客户端形状纪律                                                    */
/* ================================================================== */

test('P2-02 客户端：回收请求不带任何路径/身份字段，恢复请求没有 targetPath', async () => {
  await withHost(async ({ server }) => {
    const token = ((await (await fetch(`${server.url}/api/session-token`)).json()) as { token?: string }).token ?? '';
    const sent: unknown[] = [];

    // 直接观察请求体：证明客户端没有"自述身份"
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (typeof init?.body === 'string') sent.push(JSON.parse(init.body));
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const client = createLiveClient(server.url);
      void token;
      await client.trashEntry(PROJ_A, 'a.md', OP);
      await client.restoreTrash(PROJ_A, OP, allowGate);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(sent.length, 2);
    const [del, restore] = sent as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(del).sort(), ['opId', 'path', 'projectId']);
    assert.deepEqual(Object.keys(restore).sort(), ['opId', 'projectId']);
    for (const body of [del, restore]) {
      for (const forbidden of ['rootDir', 'rootToken', 'identity', 'absolutePath', 'providerId', 'targetPath']) {
        assert.equal(forbidden in body, false, `不得携带 ${forbidden}`);
      }
    }
  });
});

/* ================================================================== */
/* 八、客户端收敛：APPLIED 读不懂 ≠ 被拒绝（R1-03）                        */
/* ================================================================== */

interface StubCall {
  readonly method: string;
  readonly path: string;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 用构造好的 HTTP 回执驱动**真实客户端**（不打桩它的判断逻辑，只替换传输层）。 */
async function withStubFetch(
  handler: (call: StubCall) => Response,
  fn: () => Promise<void>,
): Promise<StubCall[]> {
  const calls: StubCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const parsed = new URL(raw, 'http://stub.local');
    const call = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: `${parsed.pathname}${parsed.search}`,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return calls;
}

const RESTORED_DTO = {
  opId: OP,
  path: 'a.md',
  entryKind: 'file',
  size: 4,
  deletedAt: '2026-11-23T00:00:00.000Z',
  state: 'restored',
  canRestore: false,
};

/** 回放宿主 + 台账访问器：让"预留 / 收敛"能在真实 HTTP 链路上被断言。 */
interface PlaybackHost extends TrashHost {
  ledgerRecords(): readonly TrashPendingRecord[];
  /** 模拟 Provider 用一次成功列表收敛台账，返回 store 的结论。 */
  reconcilePending(entries: readonly TrashEntryDto[]): Promise<string>;
}

const PLAYBACK_WORKSPACE_KEY = 'a1b2c3d4e5f60718';

function playbackHost(client: WeaveSpaceClient, notices: string[]): PlaybackHost {
  // 台账用真实 store（内存 StorageLike）：97 证明的是 HTTP 契约，但预留在链路上必须真实存在
  const data = new Map<string, string>();
  const store = createTrashLedgerStore(
    {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    },
    { status: 'ok', records: [] },
    createInlineCoordination(),
  );
  return {
    port: {
      list: (projectId) => client.listTrash(projectId),
      remove: (projectId, path, opId) => client.trashEntry(projectId, path, opId),
      // 适配层必须**转发** gate：漏传在运行时会被 Client API 判为 fail-closed（R1-H1）
      restore: (projectId, opId, gate) => client.restoreTrash(projectId, opId, gate),
      query: (projectId, opId) => client.queryTrashOp(projectId, opId),
    },
    identity: () => ({
      mode: 'live',
      workspaceMode: 'multi',
      workspaceKey: PLAYBACK_WORKSPACE_KEY,
      activeProjectId: PROJ_A,
      epoch: 1,
    }),
    dispatch: () => undefined,
    newOpId: () => OP,
    notify: (message) => notices.push(message),
    supported: () => true,
    preflight: () => ({ ok: true }),
    restoreGate: () => store.blockMessage(),
    reservePending: async (target) => {
      const outcome = await store.reserve({ ...target, createdAt: '2026-11-24T00:00:00.000Z' });
      // 只有 reserved 是授权；exists = 这条还有一次没有结论的恢复
      return outcome.status === 'reserved'
        ? { ok: true as const }
        : { ok: false as const, message: `台账拒绝预留（${outcome.status}）` };
    },
    verifyPending: (target) => store.verifyPending(target),
    releasePending: async (target) => {
      await store.release({ ...target, opIds: [target.opId] });
    },
    blockers: () => [],
    refreshAfterRemoval: async () => undefined,
    refreshAfterRestore: async () => undefined,
    ledgerRecords: () => store.records(),
    reconcilePending: async (entries) =>
      (
        await store.reconcile({
          workspaceKey: PLAYBACK_WORKSPACE_KEY,
          projectId: PROJ_A,
          entries,
          loaded: true,
        })
      ).status,
  };
}

test('P2-02-R1 客户端：APPLIED 但没有 entry → UNKNOWN（不报被拒绝）', async () => {
  const calls = await withStubFetch(
    (call) => {
      if (call.path === '/api/session-token') return jsonResponse(200, { token: 'stub' });
      // Host 说成功，但回执里没有可验证的记录
      return jsonResponse(200, { status: 'APPLIED', projectId: PROJ_A, opId: OP });
    },
    async () => {
      const client = createLiveClient('http://stub.local');
      const outcome = await client.restoreTrash(PROJ_A, OP, allowGate);
      assert.equal(outcome.status, 'UNKNOWN', '不能把"读不懂的回执"报成被拒绝（那会诱导用户再点一次）');
      assert.equal(outcome.status === 'UNKNOWN' ? outcome.opId : null, OP, '必须保留 opId 才能核对');
    },
  );
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
});

test('P2-02-R1 编排：客户端给出 UNKNOWN 时只核对一次、绝不重发', async () => {
  const notices: string[] = [];
  const calls = await withStubFetch(
    (call) => {
      if (call.path === '/api/session-token') return jsonResponse(200, { token: 'stub' });
      if (call.path === '/api/trash/restore') {
        // 第一次（也是唯一一次）POST 就返回"读不懂的 APPLIED"
        return jsonResponse(200, { status: 'APPLIED', projectId: PROJ_A, opId: OP });
      }
      if (call.path.startsWith('/api/trash/op')) {
        return jsonResponse(200, { status: 'APPLIED', outcome: 'restored', state: 'restored' });
      }
      if (call.path.startsWith('/api/trash?')) {
        return jsonResponse(200, { status: 'APPLIED', projectId: PROJ_A, count: 1, entries: [RESTORED_DTO] });
      }
      return jsonResponse(404, { status: 'REJECTED', errorCode: 'ERR_NOT_FOUND' });
    },
    async () => {
      const client = createLiveClient('http://stub.local');
      const controller = createTrashController(playbackHost(client, notices));
      const result = await controller.restore(PROJ_A, {
        opId: OP,
        path: 'a.md',
        entryKind: 'file',
        size: 4,
        deletedAt: '2026-11-23T00:00:00.000Z',
        state: 'stored',
        canRestore: true,
      });
      assert.equal(result.status, 'unknown', '结果未确认：既不宣布成功，也不宣布失败');
    },
  );

  const posts = calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 1, '副作用请求绝不允许重发');
  assert.equal(calls.filter((call) => call.path.startsWith('/api/trash/op')).length, 1, '只读核对恰好一次');
  assert.ok(notices.some((message) => /未确认/.test(message)), '要告诉用户结果没确认');
});

test('P2-02-R1 客户端：APPLIED 但 entry 非法 → UNKNOWN，不重发', async () => {
  const calls = await withStubFetch(
    (call) => {
      if (call.path === '/api/session-token') return jsonResponse(200, { token: 'stub' });
      if (call.path === '/api/trash/entry') {
        return jsonResponse(200, {
          status: 'APPLIED',
          projectId: PROJ_A,
          opId: OP,
          entry: { opId: OP, path: 'a.md', entryKind: 'file', size: -1, deletedAt: 'x', state: 'weird', canRestore: true },
        });
      }
      return jsonResponse(404, { status: 'REJECTED', errorCode: 'ERR_NOT_FOUND' });
    },
    async () => {
      const client = createLiveClient('http://stub.local');
      const outcome = await client.trashEntry(PROJ_A, 'a.md', OP);
      assert.equal(outcome.status, 'UNKNOWN');
    },
  );
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
});

test('P2-02-R1 客户端：500 可能已有副作用 → UNKNOWN；409 才是明确拒绝', async () => {
  await withStubFetch(
    (call) => {
      if (call.path === '/api/session-token') return jsonResponse(200, { token: 'stub' });
      // 5xx：可能发生在"正文已移动、状态没提交"之后，不能按"什么都没发生"处理
      if (call.path === '/api/trash/restore') {
        return jsonResponse(500, { status: 'REJECTED', errorCode: 'ERR_STORAGE_IO', message: '内部错误' });
      }
      return jsonResponse(404, { status: 'REJECTED', errorCode: 'ERR_NOT_FOUND' });
    },
    async () => {
      const client = createLiveClient('http://stub.local');
      const outcome = await client.restoreTrash(PROJ_A, OP, allowGate);
      assert.equal(outcome.status, 'UNKNOWN', '5xx 不得当成零副作用的拒绝');
    },
  );

  await withStubFetch(
    (call) => {
      if (call.path === '/api/session-token') return jsonResponse(200, { token: 'stub' });
      return jsonResponse(409, { status: 'REJECTED', errorCode: 'ERR_ENTRY_EXISTS', message: '同名' });
    },
    async () => {
      const client = createLiveClient('http://stub.local');
      const outcome = await client.restoreTrash(PROJ_A, OP, allowGate);
      assert.equal(outcome.status, 'REJECTED');
      assert.equal(outcome.status === 'REJECTED' ? outcome.errorCode : null, 'ERR_ENTRY_EXISTS');
    },
  );
});

test('P2-02-R1 客户端：503 项目不可用是前置拒绝，不进入"未确认"', async () => {
  await withStubFetch(
    (call) => {
      if (call.path === '/api/session-token') return jsonResponse(200, { token: 'stub' });
      return jsonResponse(503, { status: 'REJECTED', errorCode: 'ERR_PROJECT_UNAVAILABLE', message: '项目不可用' });
    },
    async () => {
      const client = createLiveClient('http://stub.local');
      const outcome = await client.trashEntry(PROJ_A, 'a.md', OP);
      assert.equal(outcome.status, 'REJECTED', '前置拒绝不该被误判成"可能已生效"');
    },
  );
});

/* ================================================================== */
/* 九、R1.2：真实链路上的预留与收敛                                         */
/* ================================================================== */

test('P2-02-R1.2 真实链路：恢复前预留，成功后等列表终态才释放', async () => {
  await withHost(async ({ client }) => {
    const notices: string[] = [];
    const host = playbackHost(client, notices);
    const controller = createTrashController(host);

    const opId = 'op-p202-r12-0001';
    const removed = await client.trashEntry(PROJ_A, 'a.md', opId);
    assert.equal(removed.status, 'APPLIED', '先真的把文件移进回收区');

    const listed = await client.listTrash(PROJ_A);
    assert.equal(listed.status, 'APPLIED');
    const record = listed.status === 'APPLIED' ? listed.entries.find((item) => item.opId === opId) : undefined;
    assert.ok(record, '回收区里必须有这条记录');

    const result = await controller.restore(PROJ_A, record!);
    assert.equal(result.status, 'applied');
    // 磁盘已经恢复成功，但台账里这条仍在：要等一次**成功的列表**给出终态才算有结论
    assert.deepEqual(host.ledgerRecords().map((item) => item.opId), [opId]);

    const after = await client.listTrash(PROJ_A);
    assert.equal(after.status, 'APPLIED');
    const settled = after.status === 'APPLIED' ? after.entries : [];
    assert.equal(
      settled.find((item) => item.opId === opId)?.state,
      'restored',
      'Host 必须已经把它标成 restored',
    );
    assert.equal(await host.reconcilePending(settled), 'changed');
    assert.deepEqual(host.ledgerRecords(), [], '终态确认后才释放');
  });
});

test('P2-02-R1.2 真实链路：不存在的记录 → 明确拒绝并释放预留', async () => {
  await withHost(async ({ client }) => {
    const host = playbackHost(client, []);
    const controller = createTrashController(host);

    const result = await controller.restore(PROJ_A, {
      opId: 'op-p202-r12-0009',
      path: 'a.md',
      entryKind: 'file',
      size: 6,
      deletedAt: '2026-11-23T00:00:00.000Z',
      state: 'stored',
      canRestore: true,
    });
    assert.equal(result.status, 'rejected', '0 副作用的明确拒绝');
    assert.deepEqual(host.ledgerRecords(), [], '拒绝之后不留占位');
  });
});
