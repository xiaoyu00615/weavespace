/**
 * UX-02C-04-R1：编辑会话归属 + 响应契约（Shell 侧）。
 *
 * 两类断言：
 * - **纯编排**（`metadata-session.ts`）：打开对话框后换了工作区 / 换了对象 / 对象消失，
 *   提交必须零请求；在途结果回来时归属已变，则一个刷新、一条提示都不许发。
 * - **客户端形状**（`client-api.ts`）：资源锚只作为前置条件随请求发送；
 *   结构变更响应里的 `metadataMigration` / `metadataMoved` 必须逐字段校验后如实传递。
 *
 * 全部是纯函数或可控 `fetch`，不启 Host（Host 侧在套件 103）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createMetadataRunner,
  metadataOwnershipOf,
  metadataSessionKeyOf,
  type MetadataRunnerHost,
  type MetadataSessionBinding,
} from '../../apps/shell/src/state/metadata-session.ts';
import {
  metadataStaleNotice,
  METADATA_STALE_REASONS,
} from '../../apps/shell/src/state/resource-metadata.ts';
import { structureChangeNotice, structureMetadataNote } from '../../apps/shell/src/state/structure-change.ts';
import { createLiveClient } from '../../apps/shell/src/client/client-api.ts';
import type { MetadataOutcome } from '../../apps/shell/src/client/client-api.ts';

const PROJ = 'project-a';

/**
 * 结构变更必须带源身份预期（UX-02C-02-R2）。本套件只验响应到界面语义的映射，
 * fetch 是桩，锚在这里只是满足契约形状的一个合法值（32 位小写十六进制）。
 */
const TEST_ANCHOR = '0123456789abcdef0123456789abcdef';
const ANCHOR_A = 'a'.repeat(32);
const ANCHOR_B = 'b'.repeat(32);

function binding(overrides: Partial<MetadataSessionBinding> = {}): MetadataSessionBinding {
  return {
    key: metadataSessionKeyOf({ mode: 'live', workspaceMode: 'multi', workspaceKey: 'wk-1', epoch: 0 }),
    projectId: PROJ,
    path: 'a.md',
    anchor: ANCHOR_A,
    ...overrides,
  };
}

/* ================================================================== */
/* C 组：归属判定（纯函数）                                              */
/* ================================================================== */

test('R1-C07 归属判定：同一身份 + 同一锚 = 可以提交', () => {
  const b = binding();
  assert.equal(
    metadataOwnershipOf({ binding: b, currentKey: b.key, target: { present: true, anchor: ANCHOR_A } }),
    'current',
  );
});

test('R1-C08 归属判定：工作区身份变了 → switched（优先于一切）', () => {
  const b = binding();
  const nextKey = metadataSessionKeyOf({
    mode: 'live',
    workspaceMode: 'multi',
    workspaceKey: 'wk-2',
    epoch: 1,
  });
  assert.equal(
    metadataOwnershipOf({ binding: b, currentKey: nextKey, target: { present: true, anchor: ANCHOR_A } }),
    'switched',
    '换了工作区时，即使路径与锚都相同也必须判 switched',
  );
});

test('R1-C09 归属判定：同路径换了对象 → target-changed；对象消失 → target-missing；无锚 → unverified', () => {
  const b = binding();
  assert.equal(
    metadataOwnershipOf({ binding: b, currentKey: b.key, target: { present: true, anchor: ANCHOR_B } }),
    'target-changed',
  );
  assert.equal(
    metadataOwnershipOf({ binding: b, currentKey: b.key, target: { present: false, anchor: null } }),
    'target-missing',
  );
  assert.equal(
    metadataOwnershipOf({ binding: b, currentKey: b.key, target: { present: true, anchor: null } }),
    'unverified',
    '旧版 Host 没有锚时只能拒绝提交，不能拿路径当身份',
  );
});

test('R1-C10 会话键包含模式 / 工作区 / 代次：换回同一工作区也不算同一个会话（代次只增）', () => {
  const a = metadataSessionKeyOf({ mode: 'live', workspaceMode: 'multi', workspaceKey: 'wk-1', epoch: 0 });
  const b = metadataSessionKeyOf({ mode: 'live', workspaceMode: 'multi', workspaceKey: 'wk-1', epoch: 2 });
  const demo = metadataSessionKeyOf({ mode: 'demo', workspaceMode: 'multi', workspaceKey: 'wk-1', epoch: 2 });
  assert.notEqual(a, b);
  assert.notEqual(b, demo);
});

/* ================================================================== */
/* C 组：在途结果归属（编排层）                                          */
/* ================================================================== */

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  host: MetadataRunnerHost;
  calls: string[];
  notices: string[];
  sets: Array<{ projectId: string; path: string; patch: unknown; anchor: string | null }>;
  clears: Array<{ projectId: string; path: string; anchor: string | null }>;
  state: { key: string; target: { present: boolean; anchor: string | null } };
  nextOutcome: MetadataOutcome;
  gate: Deferred<MetadataOutcome> | null;
  refreshGate: Deferred<void> | null;
}

function harness(overrides: Partial<Harness> = {}): Harness {
  const h: Harness = {
    calls: [],
    notices: [],
    sets: [],
    clears: [],
    state: { key: binding().key, target: { present: true, anchor: ANCHOR_A } },
    nextOutcome: { status: 'APPLIED', projectId: PROJ, path: 'a.md', changed: true, metadata: { tags: [] } },
    gate: null,
    refreshGate: null,
    ...overrides,
    host: undefined as unknown as MetadataRunnerHost,
  };
  h.host = {
    identityKey: () => h.state.key,
    targetState: () => h.state.target,
    async set(projectId, path, patch, anchor) {
      h.calls.push('set');
      h.sets.push({ projectId, path, patch, anchor });
      if (h.gate) return h.gate.promise;
      return h.nextOutcome;
    },
    async clear(projectId, path, anchor) {
      h.calls.push('clear');
      h.clears.push({ projectId, path, anchor });
      if (h.gate) return h.gate.promise;
      return h.nextOutcome;
    },
    async refresh(projectId, path) {
      h.calls.push(`refresh:${projectId}:${path}`);
      if (h.refreshGate) return h.refreshGate.promise;
    },
    notice(message) {
      h.notices.push(message);
    },
  };
  return h;
}

test('R1-C11 提交前工作区已切换：零请求、零刷新，只给明确提示', async () => {
  const h = harness();
  h.state.key = metadataSessionKeyOf({ mode: 'live', workspaceMode: 'multi', workspaceKey: 'wk-2', epoch: 1 });
  const runner = createMetadataRunner(h.host);
  const result = await runner.submit(binding(), { color: 'blue' });
  assert.equal(result.kind, 'stale');
  assert.deepEqual(h.calls, [], '一个请求都不许发');
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0] ?? '', /工作区/);
});

test('R1-C12 提交前对象已被替换 / 已消失 / 无法确认：零请求', async () => {
  const replaced = harness();
  replaced.state.target = { present: true, anchor: ANCHOR_B };
  assert.equal((await createMetadataRunner(replaced.host).submit(binding(), { color: 'blue' })).kind, 'stale');
  assert.deepEqual(replaced.calls, []);

  const missing = harness();
  missing.state.target = { present: false, anchor: null };
  assert.equal((await createMetadataRunner(missing.host).submit(binding(), { color: 'blue' })).kind, 'stale');
  assert.deepEqual(missing.calls, []);

  const unverified = harness();
  unverified.state.target = { present: true, anchor: null };
  assert.equal((await createMetadataRunner(unverified.host).submit(binding(), { color: 'blue' })).kind, 'stale');
  assert.deepEqual(unverified.calls, []);
});

test('R1-C13 正常提交：带上会话捕获的锚；成功后刷新该层并提示', async () => {
  const h = harness();
  h.nextOutcome = {
    status: 'APPLIED',
    projectId: PROJ,
    path: 'a.md',
    changed: true,
    metadata: { alias: '架构', tags: [] },
  };
  const result = await createMetadataRunner(h.host).submit(binding(), { alias: '架构' });
  assert.equal(result.kind, 'saved');
  assert.deepEqual(h.sets, [{ projectId: PROJ, path: 'a.md', patch: { alias: '架构' }, anchor: ANCHOR_A }]);
  assert.deepEqual(h.calls, ['set', `refresh:${PROJ}:a.md`]);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0] ?? '', /架构/);
});

test('R1-C14 请求在途时切换工作区：结果被丢弃（零刷新、零提示）', async () => {
  const h = harness();
  h.gate = deferred<MetadataOutcome>();
  const runner = createMetadataRunner(h.host);
  const pending = runner.submit(binding(), { color: 'blue' });

  // 请求已发出，用户切走了
  h.state.key = metadataSessionKeyOf({ mode: 'live', workspaceMode: 'multi', workspaceKey: 'wk-2', epoch: 1 });
  h.gate.resolve({
    status: 'APPLIED',
    projectId: PROJ,
    path: 'a.md',
    changed: true,
    metadata: { color: 'blue', tags: [] },
  });

  const result = await pending;
  assert.equal(result.kind, 'stale');
  assert.deepEqual(h.calls, ['set'], '旧结果不得刷新新工作区');
  assert.deepEqual(h.notices, [], '旧结果不得在新工作区弹提示');
});

test('R1-C15 刷新过程中切换工作区：提示不许发出去', async () => {
  const h = harness();
  h.refreshGate = deferred<void>();
  const runner = createMetadataRunner(h.host);
  const pending = runner.submit(binding(), { color: 'blue' });
  // 等 set 完成、refresh 挂起
  await Promise.resolve();
  await Promise.resolve();
  h.state.key = metadataSessionKeyOf({ mode: 'live', workspaceMode: 'multi', workspaceKey: 'wk-9', epoch: 3 });
  h.refreshGate.resolve();
  const result = await pending;
  assert.equal(result.kind, 'stale');
  assert.deepEqual(h.notices, []);
});

test('R1-C16 未确认（UNKNOWN）：刷新核对 + 明确提示，不自动重发', async () => {
  const h = harness();
  h.nextOutcome = { status: 'UNKNOWN', message: '网络中断' };
  const result = await createMetadataRunner(h.host).submit(binding(), { color: 'blue' });
  assert.equal(result.kind, 'unknown');
  assert.deepEqual(h.calls, ['set', `refresh:${PROJ}:a.md`], '只刷新核对，不发第二个请求');
  assert.match(h.notices[0] ?? '', /未确认/);
});

test('R1-C17 Host 判定目标已变（409）：不刷新、不重试，给明确提示', async () => {
  const h = harness();
  h.nextOutcome = {
    status: 'REJECTED',
    errorCode: 'ERR_METADATA_TARGET_CHANGED',
    message: '目标资源已被替换',
    httpStatus: 409,
  };
  const result = await createMetadataRunner(h.host).submit(binding(), { color: 'blue' });
  assert.equal(result.kind, 'stale');
  assert.deepEqual(h.calls, ['set'], '不得刷新、不得重发');
  assert.equal(h.notices.length, 1);
});

test('R1-C18 清除：带锚清除当前对象；归属已变时零请求', async () => {
  const ok = harness();
  const cleared = await createMetadataRunner(ok.host).clear(binding());
  assert.equal(cleared.kind, 'saved');
  assert.deepEqual(ok.clears, [{ projectId: PROJ, path: 'a.md', anchor: ANCHOR_A }]);

  const stale = harness();
  stale.state.target = { present: true, anchor: ANCHOR_B };
  const blocked = await createMetadataRunner(stale.host).clear(binding());
  assert.equal(blocked.kind, 'stale');
  assert.deepEqual(stale.calls, []);
});

test('R1-C19 四种 stale 原因都有可读文案，且与"失败"区分', () => {
  for (const reason of METADATA_STALE_REASONS) {
    const save = metadataStaleNotice(reason, 'save');
    const clear = metadataStaleNotice(reason, 'clear');
    assert.ok(save.length > 0);
    assert.ok(clear.length > 0);
    assert.notEqual(save, clear, '保存与清除的提示不能混用同一句话');
    assert.doesNotMatch(save, /失败/, '归属变化不是"保存失败"');
  }
});

/* ================================================================== */
/* D 组：客户端请求 / 响应契约                                          */
/* ================================================================== */

interface Captured {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/**
 * 发送前裁决恒通过：这一组钉的是请求/响应**形状**，裁决本身在套件 105
 * （那边用真实的令牌窗口驱动同一个调用链）。
 */
const allowSend = () => ({ ok: true as const });

function installFetch(reply: () => { status: number; body: unknown }): {
  calls: Captured[];
  restore(): void;
} {
  const original = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/session-token')) {
      return { status: 200, json: async () => ({ status: 'APPLIED', token: 't1' }) };
    }
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    const { status, body } = reply();
    return { status, json: async () => body };
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test('R1-D03 资源锚只作为前置条件随请求发送（不额外自述身份）', async () => {
  const net = installFetch(() => ({
    status: 200,
    body: { status: 'APPLIED', projectId: PROJ, path: 'a.md', changed: true, metadata: { color: 'blue', tags: [] } },
  }));
  try {
    const client = createLiveClient('http://host.test');
    await client.setResourceMetadata(PROJ, 'a.md', { color: 'blue' }, { anchor: ANCHOR_A }, allowSend);
    assert.deepEqual(net.calls[0]?.body, { projectId: PROJ, path: 'a.md', color: 'blue', anchor: ANCHOR_A });
    assert.equal('identity' in (net.calls[0]?.body ?? {}), false);
    assert.equal('rootToken' in (net.calls[0]?.body ?? {}), false);
  } finally {
    net.restore();
  }
});

test('R1-D04 410/409 错误原样传递：清除冲突可见', async () => {
  const net = installFetch(() => ({
    status: 409,
    body: { status: 'REJECTED', errorCode: 'ERR_METADATA_TARGET_CHANGED', message: '目标资源已被替换' },
  }));
  try {
    const client = createLiveClient('http://host.test');
    const outcome = await client.clearResourceMetadata(PROJ, 'a.md', { anchor: ANCHOR_A }, undefined, allowSend);
    assert.equal(outcome.status, 'REJECTED');
    if (outcome.status !== 'REJECTED') return;
    assert.equal(outcome.errorCode, 'ERR_METADATA_TARGET_CHANGED');
    assert.equal(outcome.httpStatus, 409);
    assert.deepEqual(net.calls[0]?.body, { projectId: PROJ, path: 'a.md', anchor: ANCHOR_A });
  } finally {
    net.restore();
  }
});

test('R1-D05 结构变更响应：moved / metadataMoved 正确传递', async () => {
  const net = installFetch(() => ({
    status: 200,
    body: {
      status: 'APPLIED',
      projectId: PROJ,
      kind: 'rename',
      sourcePath: 'a.md',
      targetPath: 'b.md',
      targetParentDir: '',
      targetName: 'b.md',
      entryKind: 'file',
      contentSha256: 'sha',
      metadataMigration: 'moved',
      metadataMoved: 2,
    },
  }));
  try {
    const client = createLiveClient('http://host.test');
    const outcome = await client.renameEntry(PROJ, 'a.md', 'b.md', TEST_ANCHOR);
    assert.equal(outcome.status, 'APPLIED');
    if (outcome.status !== 'APPLIED') return;
    assert.equal(outcome.metadataMigration, 'moved');
    assert.equal(outcome.metadataMoved, 2);
  } finally {
    net.restore();
  }
});

test('R1-D06 结构变更响应：failed 不改磁盘成功语义；非法字段不被信任', async () => {
  const failed = installFetch(() => ({
    status: 200,
    body: {
      status: 'APPLIED',
      projectId: PROJ,
      kind: 'rename',
      sourcePath: 'a.md',
      targetPath: 'b.md',
      targetParentDir: '',
      targetName: 'b.md',
      entryKind: 'file',
      contentSha256: 'sha',
      metadataMigration: 'failed',
      metadataMoved: 0,
    },
  }));
  try {
    const client = createLiveClient('http://host.test');
    const outcome = await client.renameEntry(PROJ, 'a.md', 'b.md', TEST_ANCHOR);
    assert.equal(outcome.status, 'APPLIED', '标注迁移失败不等于磁盘失败');
    if (outcome.status !== 'APPLIED') return;
    assert.equal(outcome.metadataMigration, 'failed');
    assert.equal(outcome.metadataMoved, undefined, '0 条不返回该字段');
  } finally {
    failed.restore();
  }

  const junk = installFetch(() => ({
    status: 200,
    body: {
      status: 'APPLIED',
      projectId: PROJ,
      kind: 'rename',
      sourcePath: 'a.md',
      targetPath: 'b.md',
      targetParentDir: '',
      targetName: 'b.md',
      entryKind: 'file',
      contentSha256: null,
      metadataMigration: 'weird',
      metadataMoved: '2',
    },
  }));
  try {
    const client = createLiveClient('http://host.test');
    const outcome = await client.renameEntry(PROJ, 'a.md', 'b.md', TEST_ANCHOR);
    assert.equal(outcome.status, 'APPLIED');
    if (outcome.status !== 'APPLIED') return;
    assert.equal(outcome.metadataMigration, 'none', '未知取值按"没有迁移"处理，不伪造结论');
    assert.equal(outcome.metadataMoved, undefined);
  } finally {
    junk.restore();
  }
});

test('R1-D07 界面提示：迁移失败必须说"文件已移动，但资源标注未能随文件迁移"', () => {
  const failed = structureMetadataNote('failed');
  assert.match(failed, /文件已移动，但资源标注未能随文件迁移/);
  assert.match(structureChangeNotice({ sourcePath: 'a.md', targetPath: 'b.md', metadataMigration: 'failed' }), /文件已移动，但资源标注未能随文件迁移/);

  assert.match(structureChangeNotice({ sourcePath: 'a.md', targetPath: 'b.md', metadataMigration: 'moved' }), /标注已随文件迁移/);
  const none = structureChangeNotice({ sourcePath: 'a.md', targetPath: 'b.md', metadataMigration: 'none' });
  assert.doesNotMatch(none, /标注/);
  assert.match(none, /a\.md/);
});
