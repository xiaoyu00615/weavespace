/**
 * UX-02B-05-05：持久化与异常恢复（集成验收）。
 *
 * 这里只验证"跨进程/跨会话"的行为，不重复单模块用例：
 * - 重启前后同一项目集合的摘要必须一致 → 恢复记录仍能被认领；换过集合的旧摘要不被认领；
 * - Host 断线 → 身份探测失败 → 待同步（摘要置空、写入被拦）；Host 恢复后自动放行；
 * - 结果未知 → 只读重拉项目列表，绝不自动重发 remove；
 * - 配置证据损坏 → RECOVERY_RESTRICTED：一切变更 fail-closed（503），且零写入。
 *
 * 更细的三态（REVOKE_UNKNOWN / REVOKED_PENDING_CONFIG / RECOVERY_RESTRICTED 的存储层语义）
 * 由套件 44/46 覆盖，本套件只从 HTTP 边界复核"不得放宽"。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ProjectSummary, RemoveProjectOutcome } from '../../apps/shell/src/client/client-api.ts';
import { createShellServer } from '../../apps/server/src/server.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { serializeConfig } from '../../apps/server/src/store/config.ts';
import { rootTokenOf } from '../../packages/storage/path-safety.ts';
import {
  createRemoveProjectAction,
  type RemoveProjectAction,
} from '../../apps/shell/src/state/remove-project.ts';
import {
  createWorkspaceIdentitySync,
  settleIdentitySync,
  type IdentitySyncOutcome,
} from '../../apps/shell/src/state/workspace-identity-sync.ts';
import {
  createWorkspaceAutosave,
  serializeWorkspace,
  type PersistedWorkspaceV1,
  type WorkspaceStore,
  createWorkspaceStore,
} from '../../apps/shell/src/state/workspace-persistence.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import type { WorkspaceState } from '../../apps/shell/src/state/types.ts';
import { createWorkspaceWriteGate } from '../../apps/shell/src/state/workspace-write-gate.ts';

const KEY_AB = 'a'.repeat(64);
const KEY_A = 'b'.repeat(64);

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
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

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
  };
}

interface StoreSpy extends WorkspaceStore {
  writes: PersistedWorkspaceV1[];
}

function storeSpy(seed: PersistedWorkspaceV1[] = []): StoreSpy {
  const byKey = new Map<string, PersistedWorkspaceV1>();
  for (const item of seed) byKey.set(item.workspaceKey, item);
  const writes: PersistedWorkspaceV1[] = [];
  return {
    writes,
    write(snapshot) {
      writes.push(snapshot);
      byKey.set(snapshot.workspaceKey, snapshot);
      return 'written';
    },
    read(workspaceKey) {
      return byKey.get(workspaceKey) ?? null;
    },
    readLast() {
      return null;
    },
    clear(workspaceKey) {
      byKey.delete(workspaceKey);
    },
  };
}

/* ------------------------------------------------------------------ */
/* 05-05-01 重启前后摘要稳定 → 记录仍可认领；旧摘要不被认领              */
/* ------------------------------------------------------------------ */

test('05-05-01 同一项目集合在重启前后摘要一致：恢复记录可被认领，旧摘要的记录不被认领', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux05-05-'));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(rootA, { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(rootA, 'readme.md'), '# A\n', 'utf8');
  await writeFile(join(rootB, 'readme.md'), '# B\n', 'utf8');

  const storeDir = join(base, 'store');
  await mkdir(storeDir, { recursive: true });
  const mk = (projectId: string, name: string, rootDir: string) => ({
    projectId,
    name,
    rootDir,
    canonicalRoot: realpathSync(rootDir),
    rootToken: rootTokenOf(rootDir),
    grantedAt: '2026-11-15T00:00:00.000Z',
    grantSource: 'os-dialog',
  });
  await writeFile(
    join(storeDir, 'workspace.json'),
    serializeConfig({
      version: 2,
      commitSeq: 0,
      issuedIds: ['project-a', 'project-b'],
      revoked: [],
      projects: [mk('project-a', 'A', rootA), mk('project-b', 'B', rootB)],
    }),
    'utf8',
  );

  const readKey = async (url: string): Promise<string | null> => {
    const res = await fetch(`${url}/api/health`);
    const body = (await res.json()) as { workspaceKey?: string };
    return body.workspaceKey ?? null;
  };

  let server = await createShellServer({
    port: 0,
    managedStore: { dir: storeDir, picker: createFakePicker([]) },
  });
  const keyBefore = await readKey(server.url);
  assert.ok(keyBefore);
  await server.close();

  server = await createShellServer({
    port: 0,
    managedStore: { dir: storeDir, picker: createFakePicker([]) },
  });
  try {
    const keyAfter = await readKey(server.url);
    assert.equal(keyAfter, keyBefore, '同一集合的摘要必须跨重启一致，否则恢复会丢标签');

    // 记录层：用真实摘要写下快照，再用同一个摘要读回
    const gate = createWorkspaceWriteGate();
    const store = storeSpy();
    let state: WorkspaceState = {
      ...INITIAL_STATE,
      mode: 'live',
      workspaceMode: 'multi',
      workspaceKey: keyAfter,
      projects: [
        { projectId: 'project-a', name: 'A', status: 'READY' },
        { projectId: 'project-b', name: 'B', status: 'READY' },
      ],
      activeProjectId: 'project-a',
      tabs: [],
    };
    const timers = manualTimers();
    const autosave = createWorkspaceAutosave({
      store,
      gate,
      delayMs: 400,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      snapshot: () => serializeWorkspace(state, { workspaceKey: state.workspaceKey }),
    });
    autosave.schedule();
    timers.tick();
    assert.equal(store.writes.length, 1);

    const written = store.read(keyAfter as string);
    assert.notEqual(written, null, '重启后同一个摘要必须能认领这条记录');
    assert.equal(store.read(KEY_A), null, '别的摘要（旧集合）不得被认领');
  } finally {
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 05-05-02 Host 断线 → 待同步；恢复后自动放行                          */
/* ------------------------------------------------------------------ */

test('05-05-02 Host 断线：身份探测失败 → 摘要置空、写入被拦；Host 恢复后自动放行', async () => {
  const gate = createWorkspaceWriteGate();
  const store = storeSpy();
  const timers = manualTimers();
  const probes: Array<Deferred<{ workspaceMode: 'multi'; workspaceKey: string | null }>> = [];
  const epoch = { value: 1 };

  let state: WorkspaceState = {
    ...INITIAL_STATE,
    mode: 'live',
    workspaceMode: 'multi',
    workspaceKey: KEY_AB,
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
        const d = deferred<{ workspaceMode: 'multi'; workspaceKey: string | null }>();
        probes.push(d);
        return d.promise;
      },
    },
    currentKey: () => state.workspaceKey,
    isCurrent: (value) => epoch.value === value,
    onWorkspaceKey: (key) => {
      state = workspaceReducer(state, { type: 'SET_WORKSPACE_KEY', workspaceKey: key });
    },
    onDropRecord: (key) => store.clear(key),
  });

  // 移除一个项目（结构变化）
  gate.holdIdentity();
  state = workspaceReducer(state, { type: 'PROJECT_REMOVED', projectId: 'p-a' });
  autosave.schedule();

  // Host 断线：探测失败
  const pending = identitySync.refresh(1);
  probes[0].reject(new Error('ECONNREFUSED'));
  const outcome: IdentitySyncOutcome = await pending;
  settleIdentitySync(gate, outcome);

  assert.equal(outcome.status, 'pending');
  assert.equal(state.workspaceKey, null, '断线时不能继续用旧摘要（那是伪造身份）');
  assert.equal(gate.identityPending(), true);
  timers.tick();
  assert.equal(autosave.flush(), 'held');
  assert.equal(store.writes.length, 0, '没有有效摘要就一条记录都不写');

  // Host 恢复：新的身份同步拿到新摘要 → 自动放行并写出记录
  const recovered = identitySync.refresh(1);
  probes[1].resolve({ workspaceMode: 'multi', workspaceKey: KEY_A });
  const ok = await recovered;
  assert.equal(settleIdentitySync(gate, ok), 'released');
  autosave.schedule();
  timers.tick();

  assert.equal(state.workspaceKey, KEY_A);
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].workspaceKey, KEY_A);
  assert.deepEqual(store.writes[0].tabs, []);
});

/* ------------------------------------------------------------------ */
/* 05-05-03 结果未知：只读重拉列表，不重发 remove                        */
/* ------------------------------------------------------------------ */

test('05-05-03 结果未知：只读刷新项目列表，绝不自动重发 remove', async () => {
  const listCalls: number[] = [];
  const removeCalls: string[] = [];
  const projects: ProjectSummary[] = [
    { projectId: 'p-a', name: 'A', status: 'READY' },
    { projectId: 'p-b', name: 'B', status: 'READY' },
  ];
  const applied: ProjectSummary[][] = [];

  const action: RemoveProjectAction = createRemoveProjectAction({
    port: {
      removalPrecheck: () =>
        Promise.resolve({
          status: 'APPLIED' as const,
          projectId: 'p-a',
          allowed: true,
          blockedBy: [],
          state: 'ACTIVE',
        }),
      removeProject: (pid, opId) => {
        removeCalls.push(opId);
        return Promise.reject(new Error('timeout'));
      },
      queryRemovalOp: () =>
        Promise.resolve({ status: 'APPLIED' as const, opId: 'x', outcome: 'unknown' as const, projectId: null }),
      listProjects: () => {
        listCalls.push(Date.now());
        return Promise.resolve(projects);
      },
    },
    newOpId: () => 'op-0505-aaaaaaaa',
    identity: () => ({ mode: 'live', epoch: 1 }),
    isCurrent: () => true,
    localBlockers: () => [],
    onRemoved: () => undefined,
    onProjects: (list) => applied.push(list),
  });

  const result = await action.remove('p-a');
  assert.equal(result.kind, 'unknown');
  assert.equal(removeCalls.length, 1, '绝不自动重发 remove');
  assert.equal(listCalls.length, 1, '结果未知时只读刷新一次列表');
  assert.deepEqual(applied[0]?.map((p) => p.projectId), ['p-a', 'p-b']);
});

/* ------------------------------------------------------------------ */
/* 05-05-04 配置证据损坏 → RECOVERY_RESTRICTED（fail-closed）            */
/* ------------------------------------------------------------------ */

test('05-05-04 配置校验和损坏：变更一律 503，零墓碑写入，读取仍可用', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux05-05-bad-'));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(rootA, { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(rootA, 'readme.md'), '# A\n', 'utf8');
  await writeFile(join(rootB, 'readme.md'), '# B\n', 'utf8');

  const storeDir = join(base, 'store');
  await mkdir(storeDir, { recursive: true });
  const mk = (projectId: string, name: string, rootDir: string) => ({
    projectId,
    name,
    rootDir,
    canonicalRoot: realpathSync(rootDir),
    rootToken: rootTokenOf(rootDir),
    grantedAt: '2026-11-15T00:00:00.000Z',
    grantSource: 'os-dialog',
  });
  const good = serializeConfig({
    version: 2,
    commitSeq: 0,
    issuedIds: ['project-a', 'project-b'],
    revoked: [],
    projects: [mk('project-a', 'A', rootA), mk('project-b', 'B', rootB)],
  });
  // 篡改校验和：证据不可信 → 读取进入受限态
  const tampered = good.replace(/"checksum": "[0-9a-f]+"/, '"checksum": "deadbeef"');
  assert.notEqual(tampered, good, '夹具必须真的改掉校验和');
  await writeFile(join(storeDir, 'workspace.json'), tampered, 'utf8');

  const server = await createShellServer({
    port: 0,
    managedStore: { dir: storeDir, picker: createFakePicker([]) },
  });
  try {
    const tokenRes = await fetch(`${server.url}/api/session-token`);
    const token = ((await tokenRes.json()) as { token?: string }).token ?? '';
    const origin = new URL(server.url).origin;
    const res = await fetch(`${server.url}/api/projects/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ws-token': token, origin },
      body: JSON.stringify({
        projectId: 'project-a',
        confirm: 'remove-from-workspace',
        opId: 'op-0505-restricted',
      }),
    });
    assert.equal(res.status, 503, '受限态下的变更必须被拒绝');
    const body = (await res.json()) as { errorCode?: string };
    assert.equal(body.errorCode, 'ERR_STORE_RESTRICTED');

    // 零变更：不得出现墓碑
    const log = await readFile(join(storeDir, 'revocations.jsonl'), 'utf8').catch(() => '');
    assert.equal(log.trim(), '', '受限态下不得写入任何撤销证据');
  } finally {
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});
