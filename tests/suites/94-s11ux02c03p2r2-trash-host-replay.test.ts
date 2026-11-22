/**
 * UX-02C-03-P2-01-R2：Host 层重放身份核验与 UNKNOWN 的落库语义。
 *
 * 取证方式：真实 `createShellServer` + 真实 `FileProjectStore` + 真实磁盘 + 真实 HTTP。
 * 故障注入走 `managedProviderFaults`（真实 Provider + 真实磁盘），不用 mock。
 *
 * 对应缺陷：
 * - R2-01：`/api/trash/entry` 的快速重放只比 projectId + path，漏了 `rootToken`；
 * - R2-02：占位 `close` 失败必须是 UNKNOWN，且**不得**让记录被写成 stored/trashed
 *   （回收方向）或回退成 stored（恢复方向）。
 */
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createShellServer } from '../../apps/server/src/server.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { serializeConfig, type ConfigTrashEntry } from '../../apps/server/src/store/config.ts';
import { createFileProjectStore } from '../../apps/server/src/store/index.ts';
import { createNodeStoreIo } from '../../apps/server/src/store/io.ts';
import { rootTokenOf, type StorageFaultHooks } from '../../packages/storage/index.ts';

const PROJ = 'project-r2';
const OP = 'op-r2-host-0001';

interface ApiResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  status: number;
}

interface TrashRow {
  opId: string;
  projectId: string;
  rootToken: string;
  originalPath: string;
  state: string;
  identity: string;
}

interface Ctx {
  root: string;
  base: string;
  api: {
    post(path: string, body: unknown): Promise<ApiResponse>;
    get(path: string): Promise<ApiResponse>;
    trash(path: string, opId?: string): Promise<ApiResponse>;
    restore(opId?: string): Promise<ApiResponse>;
  };
  config(): Promise<{ trash: TrashRow[]; commitSeq: number }>;
  /** 在 Provider 的占位步骤注入故障（真实磁盘）。 */
  setReserveFault(fn: ((stage: 'beforeStat' | 'beforeClose', attempt: 1 | 2) => void) | null): void;
  payloadPath(opId?: string): string;
}

const RESERVE_STATE = { hook: null as null | ((stage: 'beforeStat' | 'beforeClose', attempt: 1 | 2) => void) };

async function withHost(
  fn: (ctx: Ctx) => Promise<void>,
  options: {
    /** 在服务启动**之前**准备回收区夹具（真实磁盘 + 真实配置），返回值写进 `trash[]`。 */
    seed?: (info: { root: string; rootToken: string }) => Promise<ConfigTrashEntry[]>;
  } = {},
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-p2r2-host-'));
  const storeDir = join(base, 'store');
  const root = join(base, 'project');
  await mkdir(storeDir, { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'a.md'), '# A a\n', 'utf8');

  const canonical = realpathSync(root);
  const rootToken = rootTokenOf(root);
  const project = {
    projectId: PROJ,
    name: '项目 R2',
    rootDir: root,
    canonicalRoot: canonical,
    rootToken,
    grantedAt: '2026-11-22T00:00:00.000Z',
    grantSource: 'os-dialog',
  };

  const seeded = options.seed ? await options.seed({ root, rootToken }) : [];

  await writeFile(
    join(storeDir, 'workspace.json'),
    serializeConfig({
      version: 4,
      commitSeq: 0,
      issuedIds: [PROJ],
      revoked: [],
      projects: [project],
      hidden: [],
      trash: seeded,
    }),
    'utf8',
  );

  const faults: StorageFaultHooks = {
    reserveFault: (stage, attempt) => RESERVE_STATE.hook?.(stage, attempt),
  };
  const server = await createShellServer({
    port: 0,
    managedStore: { dir: storeDir, picker: createFakePicker([]), storeIo: createNodeStoreIo() },
    managedProviderFaults: faults,
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
    trash(path: string, opId = OP) {
      return api.post('/api/trash/entry', { projectId: PROJ, path, opId });
    },
    restore(opId = OP) {
      return api.post('/api/trash/restore', { projectId: PROJ, opId });
    },
  };

  const ctx: Ctx = {
    root,
    base,
    api,
    async config() {
      return JSON.parse(await readFile(join(storeDir, 'workspace.json'), 'utf8')) as {
        trash: TrashRow[];
        commitSeq: number;
      };
    },
    setReserveFault(fn) {
      RESERVE_STATE.hook = fn;
    },
    payloadPath: (opId = OP) => join(root, '.weavespace', 'trash', opId, 'payload'),
  };

  try {
    await fn(ctx);
  } finally {
    RESERVE_STATE.hook = null;
    await server.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

/* ================================================================== */
/* R2-01：快速重放必须核对 rootToken                                    */
/* ================================================================== */

test('R2-01a 记录属于旧的 rootToken：快速重放必须 409，不得返回 APPLIED', async () => {
  await withHost(
    async (h) => {
      const before = await h.config();
      assert.equal(before.trash.length, 1, '夹具必须真的种下一条记录');
      // 启动对账可能已把"旧根令牌"的记录标成 conflicted（那是另一条独立保护）；
      // 本用例只关心**这一次请求**是否把它当成当前项目的有效重放。
      assert.ok(
        ['stored', 'conflicted'].includes(before.trash[0].state),
        `夹具状态异常：${before.trash[0].state}`,
      );
      const payloadBytes = readFileSync(h.payloadPath(), 'utf8');

      const res = await h.api.trash('a.md');
      // 修复前：这条旧记录被当成当前项目的有效重放 → 200 APPLIED（谎报"已经删过了"）
      assert.equal(res.status, 409, `必须拒绝：${JSON.stringify(res.body)}`);
      assert.equal(res.body.errorCode, 'ERR_OP_ID_CONFLICT');
      assert.notEqual(res.body.status, 'APPLIED');
      assert.notEqual(res.body.replayed, true);

      // 原记录一字不改
      const after = await h.config();
      assert.deepEqual(after.trash, before.trash, '旧记录不得被改写');
      assert.equal(after.commitSeq, before.commitSeq, '被拒绝的重放不得推进提交序号');
      // 源文件仍在原处，回收区对象逐字节不变（既没被搬走，也没被再删一次）
      assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# A a\n');
      assert.equal(readFileSync(h.payloadPath(), 'utf8'), payloadBytes);
    },
    {
      seed: async ({ root }) => {
        // 磁盘上真实存在一个"旧授权时期"的回收对象，记录也真实指向它
        const dir = join(root, '.weavespace', 'trash', OP);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'payload'), '# A a\n', 'utf8');
        const info = lstatSync(join(dir, 'payload'));
        return [
          {
            opId: OP,
            projectId: PROJ,
            // 与当前项目 handle 的 rootToken 不同：模拟"重新授权/根变化"后的旧记录
            rootToken: 'tok-from-an-older-grant',
            originalPath: 'a.md',
            entryKind: 'file',
            identity: `${info.dev}:${info.ino}`,
            size: 6,
            deletedAt: '2026-11-22T00:00:00.000Z',
            state: 'stored',
          },
        ];
      },
    },
  );
});

test('R2-01b 归属完全一致的重放：仍然幂等，不重复移动磁盘对象', async () => {
  await withHost(async (h) => {
    const first = await h.api.trash('a.md');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const configAfterFirst = await h.config();
    const payloadIdentity = configAfterFirst.trash[0].identity;

    const replay = await h.api.trash('a.md');
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.status, 'APPLIED');
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.opId, OP);

    const after = await h.config();
    assert.equal(after.commitSeq, configAfterFirst.commitSeq, '重放不得推进提交序号');
    assert.equal(after.trash.length, 1);
    assert.equal(after.trash[0].identity, payloadIdentity, '记录身份不得变化');
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# A a\n', '磁盘对象只移动过一次');
    assert.equal(existsSync(join(h.root, 'a.md')), false);
  });
});

/* ================================================================== */
/* R2-02（Host 侧）：UNKNOWN 不能被写成 stored / trashed / 回退 stored   */
/* ================================================================== */

test('R2-02c 回收占位 close 失败：202 UNKNOWN，记录不得变成 stored', async () => {
  await withHost(async (h) => {
    let fired = 0;
    h.setReserveFault((stage) => {
      if (stage !== 'beforeClose') return;
      fired += 1;
      throw new Error('注入：占位句柄关闭失败');
    });
    const res = await h.api.trash('a.md');
    h.setReserveFault(null);

    assert.equal(fired, 1);
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.status, 'UNKNOWN');
    assert.notEqual(res.body.status, 'APPLIED');

    const config = await h.config();
    assert.equal(config.trash.length, 1);
    assert.equal(config.trash[0].state, 'pending', '不确定的结果只能停在 pending，交给对账');
    assert.notEqual(config.trash[0].state, 'stored');
    // 源文件必须还在：没有 rename 就没有"回收完成"
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# A a\n');

    // 查询接口（只读、不自行对账）必须把这个结果报成"未确认"，而不是"已回收"
    const op = await h.api.get(`/api/trash/op?opId=${OP}&projectId=${PROJ}`);
    assert.equal(op.status, 202, JSON.stringify(op.body));
    assert.equal(op.body.outcome, 'unknown', `不得谎报已回收：${JSON.stringify(op.body)}`);
    assert.notEqual(op.body.outcome, 'trashed');
    assert.equal(op.body.state, 'pending');
  });
});

test('R2-02d 恢复占位 close 失败：202 UNKNOWN，记录不得被回退成 stored', async () => {
  await withHost(async (h) => {
    const trashed = await h.api.trash('a.md');
    assert.equal(trashed.status, 200, JSON.stringify(trashed.body));

    let fired = 0;
    h.setReserveFault((stage) => {
      if (stage !== 'beforeClose') return;
      fired += 1;
      throw new Error('注入：目标占位关闭失败');
    });
    const res = await h.api.restore();
    h.setReserveFault(null);

    assert.equal(fired, 1);
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.status, 'UNKNOWN');

    // 关键：不能因为"磁盘没动"就把状态写回 stored（那是把不确定当成已确认）
    const config = await h.config();
    assert.equal(config.trash[0].state, 'restoring', '必须停在 restoring，等待对账核对磁盘事实');
    assert.notEqual(config.trash[0].state, 'stored');
    // 回收区对象原样保留
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# A a\n');
    if (existsSync(join(h.root, 'a.md'))) {
      assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '', '目标位置只能是 0 字节占位');
    }

    const op = await h.api.get(`/api/trash/op?opId=${OP}&projectId=${PROJ}`);
    assert.equal(op.status, 202, JSON.stringify(op.body));
    assert.equal(op.body.outcome, 'unknown', `不得谎报恢复完成：${JSON.stringify(op.body)}`);
    assert.equal(op.body.state, 'restoring');
  });
});
