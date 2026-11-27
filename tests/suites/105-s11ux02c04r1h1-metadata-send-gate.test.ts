/**
 * UX-02C-04-R1-H1：元数据发送的**最终边界**（Shell 侧）。
 *
 * 钉的是一个时序窗口：`MetadataRunner` 在调用 Client API 之前核过归属，但 Client API
 * 内部还要 `await sessionToken()`。用户完全可以在这段窗口里切工作区 / 让对象被替换——
 * 那时早先的核验已经通过，POST 会照发，旧草稿就落到别人的工作区（或写到已被替换的对象）上。
 *
 * 所以这里驱动的必须是**真实调用链**：
 *   真实 `createMetadataRunner` → 真实 `createLiveClient` → 受控 `fetch`（令牌响应可挂起）。
 * 断言的对象是"有没有真的发出 `metadata/set` / `metadata/clear`"，不是最终 Port 的返回值。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLiveClient, type WeaveSpaceClient } from '../../apps/shell/src/client/client-api.ts';
import {
  createMetadataRunner,
  metadataSessionKeyOf,
  type MetadataRunnerHost,
  type MetadataSessionBinding,
} from '../../apps/shell/src/state/metadata-session.ts';

const PROJ = 'project-a';
const ANCHOR_A = 'a'.repeat(32);
const ANCHOR_B = 'b'.repeat(32);

const KEY_1 = metadataSessionKeyOf({ mode: 'live', workspaceMode: 'multi', workspaceKey: 'wk-1', epoch: 0 });
const KEY_2 = metadataSessionKeyOf({ mode: 'live', workspaceMode: 'multi', workspaceKey: 'wk-2', epoch: 1 });

function binding(overrides: Partial<MetadataSessionBinding> = {}): MetadataSessionBinding {
  return { key: KEY_1, projectId: PROJ, path: 'a.md', anchor: ANCHOR_A, ...overrides };
}

interface Captured {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

interface Net {
  /** 除令牌之外真正发出去的请求（按发生顺序）。 */
  readonly posts: Captured[];
  /** 令牌请求确实已经发出：用来确认"前置核验已经通过，我们正处在那个窗口里"。 */
  tokenStarted(): Promise<void>;
  /** 放行令牌响应。 */
  releaseToken(): void;
  restore(): void;
}

/**
 * 受控网络：`/api/session-token` 必须显式放行，其余请求立即成功并记账。
 *
 * 令牌可以被挂起，正是这里要复现的窗口；`request()` 的其余部分保持真实。
 */
function installNet(): Net {
  const original = globalThis.fetch;
  const posts: Captured[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = () => resolve();
  });
  let requested = false;

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/session-token')) {
      if (!requested) {
        requested = true;
        markStarted();
      }
      await released;
      return { status: 200, json: async () => ({ status: 'APPLIED', token: 't1' }) };
    }
    posts.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    return {
      status: 200,
      json: async () => ({
        status: 'APPLIED',
        projectId: PROJ,
        path: 'a.md',
        changed: true,
        metadata: { tags: [] },
      }),
    };
  }) as typeof fetch;

  return {
    posts,
    tokenStarted: () => started,
    releaseToken: () => release(),
    restore() {
      globalThis.fetch = original;
    },
  };
}

interface Harness {
  readonly runner: ReturnType<typeof createMetadataRunner>;
  readonly state: { key: string; target: { present: boolean; anchor: string | null } };
  readonly notices: string[];
  readonly refreshes: string[];
}

/**
 * 组装真实调用链：runner 的端口直接落到真实 Client API。
 *
 * 端口故意**不**自己做任何归属判断——最终裁决必须发生在 Client API 里，
 * 否则这段测试就变成了"检查我自己刚写的 if"。
 */
function harness(client: WeaveSpaceClient): Harness {
  const notices: string[] = [];
  const refreshes: string[] = [];
  const state = { key: KEY_1, target: { present: true, anchor: ANCHOR_A } };
  const host: MetadataRunnerHost = {
    identityKey: () => state.key,
    targetState: () => state.target,
    set: (projectId, path, patch, anchor, gate) =>
      client.setResourceMetadata(projectId, path, patch, anchor === null ? undefined : { anchor }, gate),
    clear: (projectId, path, anchor, gate) =>
      client.clearResourceMetadata(projectId, path, anchor === null ? undefined : { anchor }, undefined, gate),
    refresh: async (projectId, path) => {
      refreshes.push(`${projectId}:${path}`);
    },
    notice: (message) => {
      notices.push(message);
    },
  };
  return { runner: createMetadataRunner(host), state, notices, refreshes };
}

function metadataPosts(net: Net, endpoint: '/api/metadata/set' | '/api/metadata/clear'): Captured[] {
  return net.posts.filter((call) => call.url.endsWith(endpoint));
}

/* ================================================================== */
/* H1-A：最终发送边界                                                   */
/* ================================================================== */

test('H1-A01 设置：令牌在途时切换工作区 → metadata/set 零 POST，也不刷新新工作区', async () => {
  const net = installNet();
  try {
    const h = harness(createLiveClient('http://host.test'));
    const pending = h.runner.submit(binding(), { color: 'blue' });

    // 令牌请求已经发出 ⇒ runner 的前置归属核验已经通过，我们正处在那个窗口里
    await net.tokenStarted();
    h.state.key = KEY_2;
    net.releaseToken();

    const result = await pending;
    assert.equal(metadataPosts(net, '/api/metadata/set').length, 0, '身份已变：一个 metadata/set 都不许发');
    assert.equal(result.kind, 'stale');
    if (result.kind === 'stale') assert.equal(result.reason, 'workspace-switched');
    assert.deepEqual(h.refreshes, [], '旧操作不得刷新新工作区');
    assert.deepEqual(h.notices, [], '旧操作不得在新工作区弹提示');
  } finally {
    net.restore();
  }
});

test('H1-A02 清除：同样制造令牌等待窗口 → metadata/clear 零 POST', async () => {
  const net = installNet();
  try {
    const h = harness(createLiveClient('http://host.test'));
    const pending = h.runner.clear(binding());

    await net.tokenStarted();
    h.state.key = KEY_2;
    net.releaseToken();

    const result = await pending;
    assert.equal(metadataPosts(net, '/api/metadata/clear').length, 0, '身份已变：一个 metadata/clear 都不许发');
    assert.equal(result.kind, 'stale');
    if (result.kind === 'stale') assert.equal(result.reason, 'workspace-switched');
    assert.deepEqual(h.refreshes, []);
    assert.deepEqual(h.notices, []);
  } finally {
    net.restore();
  }
});

test('H1-A03 身份不变：正常设置与清除各放行一次 POST；显式清理失效记录仍可用', async () => {
  const net = installNet();
  try {
    const client = createLiveClient('http://host.test');
    net.releaseToken();

    const h = harness(client);
    const saved = await h.runner.submit(binding(), { color: 'blue' });
    assert.equal(saved.kind, 'saved');
    assert.equal(metadataPosts(net, '/api/metadata/set').length, 1);
    assert.deepEqual(metadataPosts(net, '/api/metadata/set')[0]?.body, {
      projectId: PROJ,
      path: 'a.md',
      color: 'blue',
      anchor: ANCHOR_A,
    });

    const cleared = await h.runner.clear(binding());
    assert.equal(cleared.kind, 'saved');
    assert.equal(metadataPosts(net, '/api/metadata/clear').length, 1);
    assert.deepEqual(metadataPosts(net, '/api/metadata/clear')[0]?.body, {
      projectId: PROJ,
      path: 'a.md',
      anchor: ANCHOR_A,
    });

    // "明确清理失效记录"是另一件事：同一个 gate 通过时照常发送，scope 如实带上
    const stale = await client.clearResourceMetadata(
      PROJ,
      'a.md',
      { anchor: ANCHOR_A },
      'stale',
      () => ({ ok: true }),
    );
    assert.equal(stale.status, 'APPLIED');
    assert.equal(metadataPosts(net, '/api/metadata/clear').length, 2);
    assert.deepEqual(metadataPosts(net, '/api/metadata/clear')[1]?.body, {
      projectId: PROJ,
      path: 'a.md',
      anchor: ANCHOR_A,
      scope: 'stale',
    });
  } finally {
    net.restore();
  }
});

test('H1-A04 发送前拒绝不是 UNKNOWN、不是成功：零 POST、零刷新、只给"没保存"的提示', async () => {
  const net = installNet();
  try {
    const h = harness(createLiveClient('http://host.test'));
    const pending = h.runner.submit(binding(), { alias: '架构' });

    await net.tokenStarted();
    // 同一个工作区里对象被替换：前置核验通过之后、令牌到手之前发生
    h.state.target = { present: true, anchor: ANCHOR_B };
    net.releaseToken();

    const result = await pending;
    assert.equal(metadataPosts(net, '/api/metadata/set').length, 0);
    assert.equal(result.kind, 'stale', '发送前拒绝必须收敛为 stale，不能混进 unknown/rejected');
    if (result.kind === 'stale') assert.equal(result.reason, 'target-changed');
    assert.deepEqual(h.refreshes, [], '没有发出请求，也就没有任何"真实结果"需要核对');
    assert.equal(h.notices.length, 1, '同一工作区内要明确告诉用户"没保存"');
    assert.doesNotMatch(h.notices[0] ?? '', /未确认/, '这不是 UNKNOWN');
    assert.doesNotMatch(h.notices[0] ?? '', /已保存/, '更不能给出成功提示');
    assert.match(h.notices[0] ?? '', /没有被替换|已被替换/);
  } finally {
    net.restore();
  }
});

test('H1-A05 gate 自身不可用时 fail-closed：零 POST，且不冒充 UNKNOWN', async () => {
  const net = installNet();
  try {
    net.releaseToken();
    const client = createLiveClient('http://host.test');
    // JS 调用方 / 旧适配层漏传 gate：宁可拒绝，也不能"假装检查过"
    const outcome = await client.setResourceMetadata(PROJ, 'a.md', { color: 'blue' }, undefined, undefined as never);
    assert.equal(outcome.status, 'NOT_SENT');
    assert.equal(metadataPosts(net, '/api/metadata/set').length, 0);
  } finally {
    net.restore();
  }
});
