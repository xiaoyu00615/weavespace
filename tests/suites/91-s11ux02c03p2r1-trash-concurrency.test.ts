/**
 * UX-02C-03-P2-01-R1：跨项目 opId 冲突、Store 条件提交、查询授权与重放语义。
 *
 * 取证方式：真实 `createShellServer` + 真实 `FileProjectStore` + 真实磁盘 + 真实 HTTP。
 * 两个项目同时提交同一个 opId 的用例是真正的并发请求（`Promise.all`），不是顺序模拟。
 */
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { serializeConfig } from '../../apps/server/src/store/config.ts';
import { createFileProjectStore } from '../../apps/server/src/store/index.ts';
import { createNodeStoreIo, type StoreIo } from '../../apps/server/src/store/io.ts';
import { trashOutcomeOf } from '../../apps/server/src/trash.ts';
import { rootTokenOf, type StorageFaultHooks } from '../../packages/storage/index.ts';

const PROJ_A = 'project-a';
const PROJ_B = 'project-b';
const OP = 'op-r1-shared-0001';

interface ApiResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  status: number;
}

interface Ctx {
  base: string;
  rootA: string;
  rootB: string;
  storeDir: string;
  api: {
    post(path: string, body: unknown): Promise<ApiResponse>;
    get(path: string): Promise<ApiResponse>;
    trash(projectId: string, path: string, opId?: string): Promise<ApiResponse>;
    restore(projectId: string, opId?: string): Promise<ApiResponse>;
  };
  config(): Promise<{
    trash: { opId: string; projectId: string; originalPath: string; state: string }[];
    commitSeq: number;
  }>;
  failConfigCommit(offset: number): void;
  clearFaults(): void;
  payloadA(opId?: string): string;
  payloadB(opId?: string): string;
}

function makeStoreIo(): {
  io: StoreIo;
  failAt: (offset: number) => void;
  clear: () => void;
} {
  const real = createNodeStoreIo();
  let commits = 0;
  let target: number | null = null;
  const io: StoreIo = {
    ...real,
    rename(from, to) {
      if (String(to).endsWith('workspace.json')) {
        commits += 1;
        if (target !== null && commits === target) {
          target = null;
          throw new Error('注入：workspace.json 原子提交失败');
        }
      }
      real.rename(from, to);
    },
  };
  return {
    io,
    failAt: (offset) => {
      target = commits + offset;
    },
    clear: () => {
      target = null;
    },
  };
}

async function withTwoProjects(
  fn: (ctx: Ctx) => Promise<void>,
  options: {
    seed?: (rootA: string, rootB: string, storeDir: string) => Promise<void>;
    /** 仅测试注入：托管模式的 Provider 故障钩子（真实磁盘，不是 mock）。 */
    faults?: StorageFaultHooks;
    /** 仅测试注入：`beginTrash` 之前的同步屏障（R2-06）。 */
    barrier?: (info: { projectId: string; opId: string }) => Promise<void> | void;
  } = {},
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-p2r1-two-'));
  const storeDir = join(base, 'store');
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(storeDir, { recursive: true });
  await mkdir(rootA, { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A a\n', 'utf8');
  await writeFile(join(rootB, 'b.md'), '# B b\n', 'utf8');

  const project = (projectId: string, root: string, name: string) => ({
    projectId,
    name,
    rootDir: root,
    canonicalRoot: realpathSync(root),
    rootToken: rootTokenOf(root),
    grantedAt: '2026-11-22T00:00:00.000Z',
    grantSource: 'os-dialog',
  });

  await writeFile(
    join(storeDir, 'workspace.json'),
    serializeConfig({
      version: 2,
      commitSeq: 0,
      issuedIds: [PROJ_A, PROJ_B],
      revoked: [],
      projects: [project(PROJ_A, rootA, '项目 A'), project(PROJ_B, rootB, '项目 B')],
    }),
    'utf8',
  );
  if (options.seed) await options.seed(rootA, rootB, storeDir);

  const { io, failAt, clear } = makeStoreIo();
  const server = await createShellServer({
    port: 0,
    managedStore: { dir: storeDir, picker: createFakePicker([]), storeIo: io },
    ...(options.faults ? { managedProviderFaults: options.faults } : {}),
    ...(options.barrier ? { managedTrashBarrier: options.barrier } : {}),
  });
  const token = ((await (await fetch(`${server.url}/api/session-token`)).json()) as { token?: string }).token ?? '';

  const api = {
    async post(path: string, body: unknown): Promise<ApiResponse> {
      const res = await fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ws-token': token, origin: server.url },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    async get(path: string): Promise<ApiResponse> {
      const res = await fetch(`${server.url}${path}`, { headers: { 'x-ws-token': token } });
      return { status: res.status, body: await res.json() };
    },
    trash(projectId: string, path: string, opId = OP) {
      return api.post('/api/trash/entry', { projectId, path, opId });
    },
    restore(projectId: string, opId = OP) {
      return api.post('/api/trash/restore', { projectId, opId });
    },
  };

  const ctx: Ctx = {
    base,
    rootA,
    rootB,
    storeDir,
    api,
    failConfigCommit: failAt,
    clearFaults: clear,
    async config() {
      return JSON.parse(await readFile(join(storeDir, 'workspace.json'), 'utf8'));
    },
    payloadA: (opId = OP) => join(rootA, '.weavespace', 'trash', opId, 'payload'),
    payloadB: (opId = OP) => join(rootB, '.weavespace', 'trash', opId, 'payload'),
  };

  try {
    await fn(ctx);
  } finally {
    await server.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/* ================================================================== */
/* P1-03：跨项目 opId 并发冲突                                          */
/* ================================================================== */

test('R1-03a 两个项目同时提交同一 opId：只有一个成功，另一个在磁盘移动之前被拒绝', async () => {
  await withTwoProjects(async (h) => {
    const [resA, resB] = await Promise.all([h.api.trash(PROJ_A, 'a.md'), h.api.trash(PROJ_B, 'b.md')]);
    const results = [
      { projectId: PROJ_A, res: resA },
      { projectId: PROJ_B, res: resB },
    ];
    const winner = results.find((row) => row.res.status === 200);
    const loser = results.find((row) => row.res.status !== 200);

    assert.ok(winner, `必须恰好一个成功：${JSON.stringify([resA, resB])}`);
    assert.ok(loser, '另一个必须被拒绝');
    assert.equal(loser!.res.status, 409, JSON.stringify(loser!.res.body));
    assert.equal(loser!.res.body.errorCode, 'ERR_OP_ID_CONFLICT');

    // 未获胜项目：源文件原样、没有 payload、也没有回收区目录
    const loserRoot = loser!.projectId === PROJ_A ? h.rootA : h.rootB;
    const loserFile = loser!.projectId === PROJ_A ? 'a.md' : 'b.md';
    assert.equal(readFileSync(join(loserRoot, loserFile), 'utf8'), loser!.projectId === PROJ_A ? '# A a\n' : '# B b\n');
    assert.equal(exists(join(loserRoot, '.weavespace')), false, '被拒绝的项目不得出现回收区');

    // 获胜项目：恰好一条记录、属于自己
    const config = await h.config();
    assert.equal(config.trash.length, 1);
    assert.equal(config.trash[0].projectId, winner!.projectId);
    assert.equal(config.trash[0].opId, OP);

    // 一条记录只能对应一个 payload
    assert.equal(exists(h.payloadA()), winner!.projectId === PROJ_A);
    assert.equal(exists(h.payloadB()), winner!.projectId === PROJ_B);

    // 恢复只能恢复获胜项目的文件
    const wrongRestore = await h.api.restore(loser!.projectId);
    assert.equal(wrongRestore.status, 404, JSON.stringify(wrongRestore.body));
    const okRestore = await h.api.restore(winner!.projectId);
    assert.equal(okRestore.status, 200, JSON.stringify(okRestore.body));
    const winnerRoot = winner!.projectId === PROJ_A ? h.rootA : h.rootB;
    assert.equal(exists(join(winnerRoot, winner!.projectId === PROJ_A ? 'a.md' : 'b.md')), true);
  });
});

test('R2-06 屏障保证两个并发请求都已越过重放检查，再同时进入 Store 提交', async () => {
  let arrivals = 0;
  const waiting: (() => void)[] = [];
  const barrier = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      arrivals += 1;
      if (arrivals >= 2) {
        // 两个请求都到了提交前：同时放行，让真实 Store 面对真实并发
        for (const release of waiting) release();
        waiting.length = 0;
        resolve();
        return;
      }
      // 若另一个请求始终没到（例如屏障被移除），不能无限挂起，直接失败
      const timer = setTimeout(() => reject(new Error('屏障超时：另一个请求没有到达提交前位置')), 5000);
      waiting.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });

  await withTwoProjects(
    async (h) => {
      const [resA, resB] = await Promise.all([h.api.trash(PROJ_A, 'a.md'), h.api.trash(PROJ_B, 'b.md')]);
      const rows = [
        { projectId: PROJ_A, path: 'a.md', body: '# A a\n', res: resA },
        { projectId: PROJ_B, path: 'b.md', body: '# B b\n', res: resB },
      ];
      const winners = rows.filter((row) => row.res.status === 200);
      const losers = rows.filter((row) => row.res.status !== 200);

      assert.equal(winners.length, 1, `必须恰好一个成功：${JSON.stringify([resA.body, resB.body])}`);
      assert.equal(losers.length, 1, '另一个必须被拒绝');
      const loser = losers[0];
      assert.equal(loser.res.status, 409, JSON.stringify(loser.res.body));
      assert.equal(loser.res.body.errorCode, 'ERR_OP_ID_CONFLICT');
      assert.notEqual(loser.res.body.replayed, true, '失败方不得被当成"成功重放"');
      assert.notEqual(loser.res.body.status, 'APPLIED');

      // 失败方：源文件逐字节正确、没有 payload、没有回收区目录
      const loserRoot = loser.projectId === PROJ_A ? h.rootA : h.rootB;
      assert.equal(readFileSync(join(loserRoot, loser.path), 'utf8'), loser.body);
      assert.equal(exists(join(loserRoot, '.weavespace')), false, '失败方不得留下回收区');

      // 胜方：恰好一条记录、payload 内容逐字节正确
      const winner = winners[0];
      const config = await h.config();
      assert.equal(config.trash.length, 1, '同一 opId 只能有一条记录');
      assert.equal(config.trash[0].projectId, winner.projectId);
      const winnerRoot = winner.projectId === PROJ_A ? h.rootA : h.rootB;
      assert.equal(exists(join(winnerRoot, '.weavespace', 'trash', OP, 'payload')), true);
      assert.equal(readFileSync(join(winnerRoot, '.weavespace', 'trash', OP, 'payload'), 'utf8'), winner.body);
      assert.equal(exists(join(winnerRoot, winner.path)), false);
    },
    { barrier },
  );

  assert.equal(arrivals, 2, '两个请求都必须真的到达提交前屏障（否则并发窗口没有被证明重叠）');
});

test('R1-03b GET /api/trash/op 跨项目查询不泄露路径，同项目查询正常返回', async () => {
  await withTwoProjects(async (h) => {
    assert.equal((await h.api.trash(PROJ_A, 'a.md')).status, 200);

    const cross = await h.api.get(`/api/trash/op?opId=${OP}&projectId=${PROJ_B}`);
    assert.equal(cross.status, 404, JSON.stringify(cross.body));
    assert.equal(cross.body.errorCode, 'ERR_TRASH_RECORD_NOT_FOUND');
    assert.equal(cross.body.path, undefined, '拒绝时不得回传原路径');
    assert.equal(cross.body.projectId, undefined, '拒绝时不得回传项目归属');

    const own = await h.api.get(`/api/trash/op?opId=${OP}&projectId=${PROJ_A}`);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.outcome, 'trashed');
    assert.equal(own.body.path, 'a.md');
    assert.equal(own.body.projectId, PROJ_A);
  });
});

test('R1-03c 不存在的 opId 仍返回空结果（不泄露任何信息）', async () => {
  await withTwoProjects(async (h) => {
    const res = await h.api.get(`/api/trash/op?opId=op-does-not-exist&projectId=${PROJ_A}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.outcome, 'none');
    assert.equal(res.body.state, null);
    assert.equal(res.body.path, undefined);
  });
});

test('R1-03d 项目已撤销：查询回收事务不得泄露记录详情', async () => {
  await withTwoProjects(async (h) => {
    assert.equal((await h.api.trash(PROJ_A, 'a.md')).status, 200);
    const removed = await h.api.post('/api/projects/remove', {
      projectId: PROJ_A,
      confirm: 'remove-from-workspace',
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));

    const res = await h.api.get(`/api/trash/op?opId=${OP}&projectId=${PROJ_A}`);
    assert.ok(res.status === 403 || res.status === 404, `必须是明确拒绝：${res.status}`);
    assert.equal(res.body.path, undefined, '不得泄露原路径');
    assert.notEqual(res.body.projectId, PROJ_A, '不得以记录归属回应');
  });
});

/* ================================================================== */
/* P1-03：Store 条件提交                                               */
/* ================================================================== */

async function withStore(fn: (ctx: {
  store: ReturnType<typeof createFileProjectStore>;
  dir: string;
  readConfig(): Promise<{ trash: { opId: string; state: string }[]; commitSeq: number }>;
}) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-p2r1-store-'));
  const dir = join(base, 'store');
  await mkdir(dir, { recursive: true });
  const store = createFileProjectStore({ dir });
  try {
    await fn({
      store,
      dir,
      async readConfig() {
        return JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8'));
      },
    });
  } finally {
    store.close();
    await rm(base, { recursive: true, force: true });
  }
}

test('R1-03e beginTrash 重放：同项目同路径同身份才重放；任一不符一律 ERR_OP_ID_CONFLICT', async () => {
  await withStore(async ({ store, readConfig }) => {
    const entry = {
      opId: OP,
      projectId: PROJ_A,
      rootToken: 'tok-A',
      originalPath: 'a.md',
      entryKind: 'file' as const,
      identity: '1:100',
      size: 6,
      deletedAt: '2026-11-22T00:00:00.000Z',
      state: 'pending' as const,
    };

    const first = await store.beginTrash(entry);
    assert.equal(first.replayed, false);
    assert.equal(first.changed, true);
    assert.equal(first.record.opId, OP);
    const seqAfterFirst = (await readConfig()).commitSeq;

    const replay = await store.beginTrash(entry);
    assert.equal(replay.replayed, true, '完全相同的意图才算重放');
    assert.equal(replay.changed, false);
    assert.equal(replay.record.projectId, PROJ_A, '重放必须交出已有记录，供调用方核对归属');
    assert.equal((await readConfig()).commitSeq, seqAfterFirst, '重放不得推进序号');

    for (const [label, patch] of [
      ['其它项目', { projectId: PROJ_B }],
      ['其它路径', { originalPath: 'b.md' }],
      ['其它身份', { identity: '9:999' }],
      ['其它根令牌', { rootToken: 'tok-other' }],
    ] as const) {
      await assert.rejects(
        () => store.beginTrash({ ...entry, ...patch }),
        (err: { errorCode?: string }) => err.errorCode === 'ERR_OP_ID_CONFLICT',
        `${label}必须冲突`,
      );
    }
    assert.equal((await readConfig()).trash.length, 1, '冲突时零写入');
  });
});

test('R1-03f commitTrashState 必须同时匹配项目、根令牌、路径与身份，否则 skipped-conflict', async () => {
  await withStore(async ({ store, readConfig }) => {
    await store.beginTrash({
      opId: OP,
      projectId: PROJ_A,
      rootToken: 'tok-A',
      originalPath: 'a.md',
      entryKind: 'file',
      identity: '1:100',
      size: 6,
      deletedAt: '2026-11-22T00:00:00.000Z',
      state: 'pending',
    });
    const seq = (await readConfig()).commitSeq;

    const ok = await store.commitTrashState({
      opId: OP,
      projectId: PROJ_A,
      rootToken: 'tok-A',
      originalPath: 'a.md',
      expectIdentity: '1:100',
      expect: ['pending'],
      next: 'stored',
    });
    assert.equal(ok.outcome, 'updated');

    // 状态已不在 expect 内
    const wrongState = await store.commitTrashState({
      opId: OP,
      projectId: PROJ_A,
      rootToken: 'tok-A',
      originalPath: 'a.md',
      expectIdentity: '1:100',
      expect: ['pending'],
      next: 'aborted',
    });
    assert.equal(wrongState.outcome, 'skipped-conflict');

    for (const [label, patch] of [
      ['项目不符', { projectId: PROJ_B }],
      ['根令牌不符', { rootToken: 'tok-other' }],
      ['路径不符', { originalPath: 'b.md' }],
      ['身份不符', { expectIdentity: '2:200' }],
    ] as const) {
      const res = await store.commitTrashState({
        opId: OP,
        projectId: PROJ_A,
        rootToken: 'tok-A',
        originalPath: 'a.md',
        expectIdentity: '1:100',
        expect: ['stored'],
        next: 'conflicted',
        ...patch,
      });
      assert.equal(res.outcome, 'skipped-conflict', `${label}必须被条件提交拦住`);
      assert.equal(res.changed, false);
    }

    const config = await readConfig();
    assert.equal(config.trash[0].state, 'stored', '被拒绝的条件提交不得改动记录');
    assert.equal(config.commitSeq, seq + 1, '只有一次真实变更');
  });
});

test('R1-03g commitTrashState 找不到 opId 时不得"顺手"更新别人的记录', async () => {
  await withStore(async ({ store }) => {
    await store.beginTrash({
      opId: OP,
      projectId: PROJ_A,
      rootToken: 'tok-A',
      originalPath: 'a.md',
      entryKind: 'file',
      identity: '1:100',
      size: 6,
      deletedAt: '2026-11-22T00:00:00.000Z',
      state: 'pending',
    });
    const res = await store.commitTrashState({
      opId: 'op-unknown-0002',
      projectId: PROJ_A,
      rootToken: 'tok-A',
      originalPath: 'a.md',
      expectIdentity: '1:100',
      expect: ['pending'],
      next: 'stored',
    });
    assert.equal(res.outcome, 'skipped-missing');
    assert.equal(store.trashByOp(OP)?.state, 'pending');
  });
});

/* ================================================================== */
/* P2-03 / P2-04：UNKNOWN 与重放语义                                    */
/* ================================================================== */

test('R1-04a trashOutcomeOf 状态映射表：pending/restoring 一律 unknown，绝不报 trashed', () => {
  const table = [
    ['stored', 'trashed'],
    ['restored', 'restored'],
    ['aborted', 'aborted'],
    ['conflicted', 'conflicted'],
    ['missing', 'missing'],
    ['pending', 'unknown'],
    ['restoring', 'unknown'],
    [null, 'none'],
  ] as const;
  for (const [state, expected] of table) {
    assert.equal(trashOutcomeOf(state), expected, `${String(state)} 必须映射为 ${expected}`);
  }
});

test('R1-04b 回收结果未确认（pending）时用同一 opId 重试：202 UNKNOWN，不再移动一次', async () => {
  await withTwoProjects(async (h) => {
    h.failConfigCommit(2); // 1 = beginTrash，2 = commitStored
    const first = await h.api.trash(PROJ_A, 'a.md');
    h.clearFaults();
    assert.equal(first.status, 202, JSON.stringify(first.body));

    const replay = await h.api.trash(PROJ_A, 'a.md');
    assert.equal(replay.status, 202, `未确认的回收不得报成功：${JSON.stringify(replay.body)}`);
    assert.equal(replay.body.status, 'UNKNOWN');
    assert.equal(replay.body.opId, OP);

    // 只移动了一次：源已不在、payload 只有一份、记录仍是 pending
    assert.equal(exists(join(h.rootA, 'a.md')), false);
    assert.equal(readFileSync(h.payloadA(), 'utf8'), '# A a\n');
    assert.equal((await h.config()).trash[0].state, 'pending');
  });
});

test('R1-04c aborted / conflicted / missing 记录重放：一律 409，不虚报回收成功', async () => {
  await withTwoProjects(
    async (h) => {
      for (const state of ['aborted', 'conflicted', 'missing']) {
        const opId = `op-replay-${state}`;
        const res = await h.api.trash(PROJ_A, `src-${state}.md`, opId);
        assert.equal(res.status, 409, `${state}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.errorCode, 'ERR_TRASH_STATE_CONFLICT');
        assert.notEqual(res.body.status, 'APPLIED');
      }
      // 三个源文件都没有被移动
      for (const state of ['aborted', 'conflicted', 'missing']) {
        assert.equal(exists(join(h.rootA, `src-${state}.md`)), true);
      }
    },
    {
      async seed(rootA, _rootB, storeDir) {
        for (const state of ['aborted', 'conflicted', 'missing']) {
          await writeFile(join(rootA, `src-${state}.md`), `# ${state}\n`, 'utf8');
        }
        const raw = JSON.parse(await readFile(join(storeDir, 'workspace.json'), 'utf8'));
        const rows = (['aborted', 'conflicted', 'missing'] as const).map((state) => ({
          opId: `op-replay-${state}`,
          projectId: PROJ_A,
          rootToken: rootTokenOf(rootA),
          originalPath: `src-${state}.md`,
          entryKind: 'file' as const,
          identity: '1:999',
          size: 8,
          deletedAt: '2026-11-22T00:00:00.000Z',
          state,
        }));
        await writeFile(
          join(storeDir, 'workspace.json'),
          serializeConfig({
            version: 4,
            commitSeq: raw.commitSeq,
            issuedIds: raw.issuedIds,
            revoked: raw.revoked,
            projects: raw.projects,
            hidden: [],
            trash: rows,
          }),
          'utf8',
        );
      },
    },
  );
});

test('R1-04d 已回收（stored）记录重放：200 APPLIED，不产生第二次移动', async () => {
  await withTwoProjects(async (h) => {
    assert.equal((await h.api.trash(PROJ_A, 'a.md')).status, 200);
    const replay = await h.api.trash(PROJ_A, 'a.md');
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.entry.state, 'stored');
    assert.equal(readFileSync(h.payloadA(), 'utf8'), '# A a\n');
  });
});

test('R1-04e GET /api/trash/op 按真实状态返回（pending 不得报 trashed）', async () => {
  await withTwoProjects(async (h) => {
    h.failConfigCommit(2);
    assert.equal((await h.api.trash(PROJ_A, 'a.md')).status, 202);
    h.clearFaults();

    const res = await h.api.get(`/api/trash/op?opId=${OP}&projectId=${PROJ_A}`);
    assert.equal(res.status, 202, `未确认状态必须用 202 表达：${JSON.stringify(res.body)}`);
    assert.equal(res.body.status, 'UNKNOWN');
    assert.equal(res.body.outcome, 'unknown');
    assert.equal(res.body.state, 'pending');
    assert.equal(res.body.opId, OP);
  });
});

/* ================================================================== */
/* P1-01：Host 层不得覆盖外部对象（真实 HTTP + 真实磁盘）                 */
/* ================================================================== */

test('R1-01e Host 恢复：目标占位被同名 0 字节外部文件替换 → 409，外部文件与 payload 都完好', async () => {
  const hook: { run: (() => void) | null } = { run: null };
  await withTwoProjects(
    async (h) => {
      assert.equal((await h.api.trash(PROJ_A, 'a.md')).status, 200);

      hook.run = () => {
        // 目标占位已建立：外部进程删掉它并放一个同样 0 字节的文件
        lstatSync(join(h.rootA, 'a.md'));
        unlinkSync(join(h.rootA, 'a.md'));
        writeFileSync(join(h.rootA, 'a.md'), '', 'utf8');
      };

      const res = await h.api.restore(PROJ_A);
      hook.run = null;

      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.errorCode, 'ERR_ENTRY_EXISTS');
      assert.equal(readFileSync(join(h.rootA, 'a.md'), 'utf8'), '', '外部 0 字节文件必须原样保留');
      assert.equal(readFileSync(h.payloadA(), 'utf8'), '# A a\n', '回收区对象不得被消费');
      assert.equal((await h.config()).trash[0].state, 'stored', '记录仍可恢复');
    },
    { faults: { afterMoveReserve: () => hook.run?.() } },
  );
});

test('R1-01f Host 回收：payload 占位被外部对象替换 → 409，外部对象不被覆盖、源文件留在原处', async () => {
  const hook: { run: (() => void) | null } = { run: null };
  await withTwoProjects(
    async (h) => {
      hook.run = () => {
        const payload = h.payloadA();
        unlinkSync(payload);
        writeFileSync(payload, 'FOREIGN\n', 'utf8');
      };

      const res = await h.api.trash(PROJ_A, 'a.md');
      hook.run = null;

      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.errorCode, 'ERR_ENTRY_EXISTS');
      assert.equal(readFileSync(h.payloadA(), 'utf8'), 'FOREIGN\n', '外部对象必须原样保留');
      assert.equal(readFileSync(join(h.rootA, 'a.md'), 'utf8'), '# A a\n', '源文件不得被移走');
      assert.equal((await h.config()).trash[0].state, 'aborted', '未发生移动必须收敛成 aborted');
    },
    { faults: { afterMoveReserve: () => hook.run?.() } },
  );
});
