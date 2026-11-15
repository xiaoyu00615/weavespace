/**
 * UX-02B-04B-R1-03：移除后的 `workspaceKey` 同步。
 *
 * 为什么必须有这一步：Host 的 `workspaceKey()` 是按**当前项目集合**重算的摘要，
 * 所以"成功移除"之后摘要一定变了。如果 Shell 继续用旧摘要保存，就会把
 * "新项目列表 + 旧摘要"写成一条**看起来有效**的恢复记录：下次启动按健康检查
 * 拿到新摘要，这条记录既匹配不上（丢标签），又可能被当成"新工作区的旧记录"
 * 认领（更糟）。
 *
 * 本套件用 deferred 端口确定性覆盖：
 * - 摘要变化 → 写入新摘要 + 清掉旧摘要记录；
 * - 健康检查失败 → 进入"待同步"（摘要置空，序列化拒绝落盘，不伪造）；
 * - 切换工作区期间响应迟到 → 一律不回填；
 * - 摘要未变 / 形状非法 → 有明确结论，绝不写一个猜出来的摘要。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkspaceIdentity } from '../../apps/shell/src/client/client-api.ts';
import {
  createWorkspaceIdentitySync,
  type IdentitySyncOutcome,
  type WorkspaceIdentitySyncHost,
} from '../../apps/shell/src/state/workspace-identity-sync.ts';
import { serializeWorkspace } from '../../apps/shell/src/state/workspace-persistence.ts';
import { INITIAL_STATE } from '../../apps/shell/src/state/workspace-reducer.ts';

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

const OLD_KEY = 'a'.repeat(64);
const NEW_KEY = 'b'.repeat(64);

interface Harness {
  sync: ReturnType<typeof createWorkspaceIdentitySync>;
  epoch: { value: number };
  keyWrites: Array<string | null>;
  dropped: string[];
  probe(): Deferred<WorkspaceIdentity>;
  getProbeCalls(): number;
}

function makeHarness(currentKey: string | null = OLD_KEY): Harness {
  const epoch = { value: 1 };
  const keyWrites: Array<string | null> = [];
  const dropped: string[] = [];
  const probes: Deferred<WorkspaceIdentity>[] = [];
  let calls = 0;
  const host: WorkspaceIdentitySyncHost = {
    port: {
      workspaceIdentity: () => {
        calls += 1;
        const d = deferred<WorkspaceIdentity>();
        probes.push(d);
        return d.promise;
      },
    },
    currentKey: () => currentKey,
    isCurrent: (value) => epoch.value === value,
    onWorkspaceKey: (key) => keyWrites.push(key),
    onDropRecord: (key) => dropped.push(key),
  };
  return {
    sync: createWorkspaceIdentitySync(host),
    epoch,
    keyWrites,
    dropped,
    probe: () => probes[probes.length - 1],
    getProbeCalls: () => calls,
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/* ------------------------------------------------------------------ */

test('R1-03-01 摘要变化：写入新摘要，并清掉旧摘要记录（不让新列表挂在旧记录上）', async () => {
  const h = makeHarness();
  const p = h.sync.refresh(1);
  h.probe().resolve({ workspaceMode: 'multi', workspaceKey: NEW_KEY });
  const out: IdentitySyncOutcome = await p;

  assert.equal(out.status, 'updated');
  assert.deepEqual(h.keyWrites, [NEW_KEY], '必须写入 Host 给出的新摘要');
  assert.deepEqual(h.dropped, [OLD_KEY], '旧摘要记录不再代表本工作区，必须清理');
  assert.equal(h.getProbeCalls(), 1, '只探测一次，不轮询');
});

test('R1-03-02 健康检查失败：进入待同步（摘要置空），不伪造新摘要、也不删旧记录', async () => {
  const h = makeHarness();
  const p = h.sync.refresh(1);
  h.probe().reject(new Error('health 502'));
  const out = await p;

  assert.equal(out.status, 'pending');
  assert.deepEqual(h.keyWrites, [null], '无法确认身份时摘要必须置空，不能沿用旧摘要');
  assert.deepEqual(h.dropped, [], '不知道新摘要时不能删旧记录（可能还有别的实例在用）');
});

test('R1-03-03 切换工作区期间响应迟到：一律不回填（不写摘要、不删记录）', async () => {
  const h = makeHarness();
  const p = h.sync.refresh(1);
  h.epoch.value = 2; // 切模式 / 重连 / 换工作区
  h.probe().resolve({ workspaceMode: 'multi', workspaceKey: NEW_KEY });
  const out = await p;

  assert.equal(out.status, 'stale');
  assert.deepEqual(h.keyWrites, [], '迟到结果不得写进新工作区');
  assert.deepEqual(h.dropped, []);
});

test('R1-03-04 探测失败但期间已切走：同样按 stale 处理，不置空新工作区的摘要', async () => {
  const h = makeHarness();
  const p = h.sync.refresh(1);
  h.epoch.value = 2;
  h.probe().reject(new Error('health down'));
  const out = await p;

  assert.equal(out.status, 'stale');
  assert.deepEqual(h.keyWrites, [], '切走后的失败不能把新工作区的摘要清掉');
});

test('R1-03-05 摘要未变：不重复写入（避免无意义的持久化抖动）', async () => {
  const h = makeHarness(OLD_KEY);
  const p = h.sync.refresh(1);
  h.probe().resolve({ workspaceMode: 'multi', workspaceKey: OLD_KEY });
  const out = await p;

  assert.equal(out.status, 'unchanged');
  assert.deepEqual(h.keyWrites, [], '摘要没变就不该触发一次写入');
  assert.deepEqual(h.dropped, []);
});

test('R1-03-06 摘要形状非法：按待同步处理，绝不写入猜出来的值', async () => {
  const h = makeHarness();
  const p = h.sync.refresh(1);
  h.probe().resolve({ workspaceMode: 'multi', workspaceKey: 'not-a-key' });
  const out = await p;

  assert.equal(out.status, 'pending');
  assert.equal(out.status === 'pending' ? out.reason : '', 'invalid-key');
  assert.deepEqual(h.keyWrites, [null]);
  assert.deepEqual(h.dropped, []);
});

test('R1-03-07 Host 没有工作区身份（空工作区）：按待同步处理', async () => {
  const h = makeHarness();
  const p = h.sync.refresh(1);
  h.probe().resolve({ workspaceMode: 'multi', workspaceKey: null });
  const out = await p;

  assert.equal(out.status, 'pending');
  assert.equal(out.status === 'pending' ? out.reason : '', 'identity-absent');
  assert.deepEqual(h.keyWrites, [null]);
});

test('R1-03-08 摘要为 null 时不产生任何恢复记录（serialize 拒绝落盘）', () => {
  const state = {
    ...INITIAL_STATE,
    mode: 'live' as const,
    workspaceMode: 'multi' as const,
    projects: [{ projectId: 'p-b', name: 'B', status: 'READY' as const }],
  };
  assert.equal(serializeWorkspace(state, { workspaceKey: null }), null, '待同步状态不得写出记录');
  const withKey = serializeWorkspace(state, { workspaceKey: NEW_KEY });
  assert.notEqual(withKey, null);
  assert.equal(withKey?.workspaceKey, NEW_KEY);
});

test('R1-03-09 连续两次刷新：第二次以第一次的结果为基线，不重复清理', async () => {
  let current: string | null = OLD_KEY;
  const epoch = { value: 1 };
  const keyWrites: Array<string | null> = [];
  const dropped: string[] = [];
  const probes: Deferred<WorkspaceIdentity>[] = [];
  const sync = createWorkspaceIdentitySync({
    port: {
      workspaceIdentity: () => {
        const d = deferred<WorkspaceIdentity>();
        probes.push(d);
        return d.promise;
      },
    },
    currentKey: () => current,
    isCurrent: (value) => epoch.value === value,
    onWorkspaceKey: (key) => {
      keyWrites.push(key);
      current = key;
    },
    onDropRecord: (key) => dropped.push(key),
  });

  const first = sync.refresh(1);
  probes[0].resolve({ workspaceMode: 'multi', workspaceKey: NEW_KEY });
  assert.equal((await first).status, 'updated');

  const second = sync.refresh(1);
  probes[1].resolve({ workspaceMode: 'multi', workspaceKey: NEW_KEY });
  assert.equal((await second).status, 'unchanged');
  assert.deepEqual(keyWrites, [NEW_KEY], '只在真正变化时写一次');
  assert.deepEqual(dropped, [OLD_KEY]);
});
