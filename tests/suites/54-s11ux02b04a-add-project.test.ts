/**
 * S11-UX-02B-04A：添加项目、信任确认与显示名称管理。
 *
 * 覆盖 docs/26 §7 的 PA-01…PA-10：
 *   PA-01 / PA-02  信任模态只做披露，打开与取消都零请求、零副作用
 *   PA-03          确认后才 bootstrap（session-token）→ startPick
 *   PA-04          acknowledgeScope 缺失/错误 → 400，且在消费 intentId **之前**、不弹窗
 *   PA-05          系统对话框取消 → CANCELLED，项目数不变
 *   PA-06          选择器不可用 → 501，零副作用，不回落文本路径
 *   PA-07          成功添加 → 项目表出现 READY + 根层可读（无需重启）
 *   PA-08 / PA-09  重命名只改显示名：projectId / workspaceKey / 树 / 磁盘目录名不变
 *   PA-10          新增项目不影响其它项目的层表
 *
 * PA-11（模态文案）与 PA-12（真实 Windows 弹窗）是人工项，本套件**不**声称通过。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createDeferredFakePicker, createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import type { ProjectSummary } from '../../apps/shell/src/client/client-api.ts';
import { createLiveClient } from '../../apps/shell/src/client/client-api.ts';
import {
  ACKNOWLEDGE_SCOPE,
  createAddProjectFlow,
  createProjectAdder,
  validateProjectName,
  type AddProjectPort,
  type AddProjectResult,
  type PickQueryOutcome,
  type PickStartOutcome,
} from '../../apps/shell/src/state/add-project.ts';
import { workspaceReducer, INITIAL_STATE } from '../../apps/shell/src/state/workspace-reducer.ts';
import { applyPage, emptyLevels } from '../../apps/shell/src/components/tree-model.ts';

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

async function newDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** 造一个可被 inspectProjectRoot 接受的目录（含一个 .md 与一个子目录）。 */
async function newRoot(prefix: string): Promise<string> {
  const dir = await newDir(prefix);
  await mkdir(join(dir, 'docs'), { recursive: true });
  await writeFile(join(dir, 'readme.md'), '# hello\n', 'utf8');
  await writeFile(join(dir, 'docs', 'guide.md'), '# guide\n', 'utf8');
  return dir;
}

interface ApiResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function call(server: ShellServer, path: string, init: RequestInit = {}): Promise<ApiResponse> {
  const res = await fetch(`${server.url}${path}`, init);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function bootManaged(
  storeDir: string,
  picker: ReturnType<typeof createFakePicker>,
): Promise<ShellServer> {
  return createShellServer({ port: 0, managedStore: { dir: storeDir, picker } });
}

async function credentials(server: ShellServer): Promise<{ token: string; intentId: string }> {
  const res = await call(server, '/api/session-token');
  assert.equal(res.status, 200, `session-token 失败: ${JSON.stringify(res.body)}`);
  const intent = res.body.intent as { intentId?: string } | undefined;
  return { token: String(res.body.token), intentId: String(intent?.intentId ?? '') };
}

interface PickBody {
  readonly token: string;
  readonly intentId?: string;
  readonly acknowledgeScope?: unknown;
  readonly omitAck?: boolean;
  readonly extra?: Record<string, unknown>;
}

async function postPick(server: ShellServer, body: PickBody): Promise<ApiResponse> {
  // 缺省给形状正确的披露标记；显式传值（含 null）原样发出，omitAck 表示完全不带该字段
  const ackField =
    body.omitAck === true
      ? {}
      : body.acknowledgeScope === undefined
        ? { acknowledgeScope: 'browse-subtree' }
        : { acknowledgeScope: body.acknowledgeScope };
  const payload: Record<string, unknown> = {
    ...ackField,
    ...(body.intentId !== undefined ? { intentId: body.intentId } : {}),
    ...(body.extra ?? {}),
  };
  return call(server, '/api/projects/pick', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: server.url,
      'x-ws-token': body.token,
    },
    body: JSON.stringify(payload),
  });
}

async function waitSettled(server: ShellServer, requestId: string, token: string): Promise<ApiResponse> {
  let last: ApiResponse = await call(server, `/api/projects/pick?requestId=${encodeURIComponent(requestId)}`, {
    headers: { 'x-ws-token': token },
  });
  for (let i = 0; i < 200 && last.body.status === 'PENDING'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    last = await call(server, `/api/projects/pick?requestId=${encodeURIComponent(requestId)}`, {
      headers: { 'x-ws-token': token },
    });
  }
  return last;
}

async function projectList(server: ShellServer): Promise<ProjectSummary[]> {
  const res = await call(server, '/api/projects');
  return (res.body.projects as ProjectSummary[] | undefined) ?? [];
}

/* ------------------------------------------------------------------ */
/* PA-04 acknowledgeScope：形状校验先于意图消费                        */
/* ------------------------------------------------------------------ */

test('PA-04-01 缺失 acknowledgeScope → 400，且选择器一次都没被调用', async () => {
  const store = await newDir('ws-04a-pa0401-');
  const root = await newRoot('ws-04a-pa0401-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await bootManaged(store, picker);
  try {
    const { token, intentId } = await credentials(server);
    const res = await postPick(server, { token, intentId, omitAck: true });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_COMMAND_INVALID');
    assert.equal(picker.calls, 0, '缺字段时不得启动系统对话框');
    assert.deepEqual(await projectList(server), [], '不得产生任何项目');
  } finally {
    await server.close();
    await rm(store, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('PA-04-02 acknowledgeScope 取值不对（含空串 / true / 近似值）→ 400，不弹窗', async () => {
  const store = await newDir('ws-04a-pa0402-');
  const root = await newRoot('ws-04a-pa0402-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await bootManaged(store, picker);
  try {
    for (const bad of ['', 'browse-root', 'BROWSE-SUBTREE', true, 1, null, { scope: 'browse-subtree' }]) {
      const { token, intentId } = await credentials(server);
      const res = await postPick(server, { token, intentId, acknowledgeScope: bad });
      assert.equal(res.status, 400, `acknowledgeScope=${JSON.stringify(bad)} 必须 400，实际 ${res.status}`);
      assert.equal(res.body.errorCode, 'ERR_COMMAND_INVALID');
    }
    assert.equal(picker.calls, 0);
    assert.deepEqual(await projectList(server), []);
  } finally {
    await server.close();
    await rm(store, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('PA-04-03 校验顺序：先 400 再谈意图（已用 intent 缺 ack 仍是 400 而非 410）', async () => {
  const store = await newDir('ws-04a-pa0403-');
  const root = await newRoot('ws-04a-pa0403-root-');
  const picker = createFakePicker([
    { status: 'cancelled' },
    { status: 'picked', folder: { absolutePath: root } },
  ]);
  const server = await bootManaged(store, picker);
  try {
    // 先用掉一个 intent（取消，零副作用）
    const first = await credentials(server);
    const started = await postPick(server, { token: first.token, intentId: first.intentId });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const settled = await waitSettled(server, String(started.body.requestId), first.token);
    assert.equal(settled.body.status, 'CANCELLED');

    // 同一个（已消费的）intent 再配一个坏 ack：必须是 400（形状）而不是 410（已用）
    const reused = await postPick(server, {
      token: first.token,
      intentId: first.intentId,
      acknowledgeScope: 'nope',
    });
    assert.equal(reused.status, 400, '形状校验必须发生在意图消费之前');
    assert.equal(reused.body.errorCode, 'ERR_COMMAND_INVALID');
    assert.equal(picker.calls, 1, '400 那次不得触发第二次弹窗');
  } finally {
    await server.close();
    await rm(store, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('PA-04-04 坏 ack 不占用单飞状态：紧接着的合法请求仍是 202 而不是 409', async () => {
  const store = await newDir('ws-04a-pa0404-');
  const root = await newRoot('ws-04a-pa0404-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await bootManaged(store, picker);
  try {
    const bad = await credentials(server);
    const rejected = await postPick(server, { token: bad.token, intentId: bad.intentId, omitAck: true });
    assert.equal(rejected.status, 400);

    const good = await credentials(server);
    const ok = await postPick(server, { token: good.token, intentId: good.intentId });
    assert.equal(ok.status, 202, JSON.stringify(ok.body));
    const settled = await waitSettled(server, String(ok.body.requestId), good.token);
    assert.equal(settled.body.status, 'APPLIED');
  } finally {
    await server.close();
    await rm(store, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* PA-03 / PA-07 成功添加与"立即可用"                                  */
/* ------------------------------------------------------------------ */

test('PA-07-01 选择成功 → 项目 READY、根层可读，响应不含绝对路径', async () => {
  const store = await newDir('ws-04a-pa0701-');
  const root = await newRoot('ws-04a-pa0701-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await bootManaged(store, picker);
  try {
    const { token, intentId } = await credentials(server);
    const started = await postPick(server, { token, intentId, acknowledgeScope: 'browse-subtree' });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const settled = await waitSettled(server, String(started.body.requestId), token);
    assert.equal(settled.body.status, 'APPLIED', JSON.stringify(settled.body));

    const projects = await projectList(server);
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.status, 'READY');

    // 无需重启：立刻就能读根层，且能展开到子目录
    const tree = await call(server, `/api/tree?projectId=${projects[0]!.projectId}`);
    assert.equal(tree.status, 200, JSON.stringify(tree.body));
    const names = (tree.body.entries as Array<{ name: string }>).map((entry) => entry.name).sort();
    assert.deepEqual(names, ['docs', 'readme.md']);

    const sub = await call(server, `/api/tree?projectId=${projects[0]!.projectId}&dir=docs`);
    assert.equal(sub.status, 200);
    assert.deepEqual((sub.body.entries as Array<{ name: string }>).map((e) => e.name), ['guide.md']);

    const dumped = JSON.stringify([started.body, settled.body, projects, tree.body]);
    assert.equal(dumped.includes(root), false, '任何响应都不得回传本机绝对路径');
    assert.equal(/[A-Za-z]:[\\/]/.test(dumped), false, '不得出现盘符路径');
  } finally {
    await server.close();
    await rm(store, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('PA-05-01 系统对话框取消 → CANCELLED，项目数不变', async () => {
  const store = await newDir('ws-04a-pa0501-');
  const root = await newRoot('ws-04a-pa0501-root-');
  const picker = createFakePicker([{ status: 'cancelled' }]);
  const server = await bootManaged(store, picker);
  try {
    const { token, intentId } = await credentials(server);
    const started = await postPick(server, { token, intentId });
    const settled = await waitSettled(server, String(started.body.requestId), token);
    assert.equal(settled.body.status, 'CANCELLED');
    assert.deepEqual(await projectList(server), []);
    assert.equal(picker.calls, 1);
    assert.equal(JSON.stringify(settled.body).includes(root), false);
  } finally {
    await server.close();
    await rm(store, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('PA-06-01 选择器不可用 → REJECTED 501，零副作用', async () => {
  const store = await newDir('ws-04a-pa0601-');
  const root = await newRoot('ws-04a-pa0601-root-');
  const picker = createFakePicker([{ status: 'unavailable', detail: 'no-dialog' }]);
  const server = await bootManaged(store, picker);
  try {
    const { token, intentId } = await credentials(server);
    const started = await postPick(server, { token, intentId });
    const settled = await waitSettled(server, String(started.body.requestId), token);
    assert.equal(settled.body.status, 'REJECTED');
    assert.equal(settled.body.errorCode, 'ERR_PICKER_UNAVAILABLE');
    assert.equal(settled.status, 501);
    assert.deepEqual(await projectList(server), []);
  } finally {
    await server.close();
    await rm(store, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* PA-08 / PA-09 重命名                                                */
/* ------------------------------------------------------------------ */

test('PA-08-01 重命名只改显示名：projectId / 树 / 磁盘目录名不变', async () => {
  const store = await newDir('ws-04a-pa0801-');
  const parent = await newDir('ws-04a-pa0801-parent-');
  const root = join(parent, '原始目录名');
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'readme.md'), '# hello\n', 'utf8');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await bootManaged(store, picker);
  try {
    const { token, intentId } = await credentials(server);
    const started = await postPick(server, { token, intentId });
    await waitSettled(server, String(started.body.requestId), token);
    const before = (await projectList(server))[0]!;
    const keyBefore = (await call(server, '/api/health')).body.workspaceKey;

    const renamed = await call(server, '/api/projects/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url, 'x-ws-token': token },
      body: JSON.stringify({ projectId: before.projectId, name: '  我的笔记本  ' }),
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal((renamed.body.project as ProjectSummary).name, '我的笔记本', '服务端必须 trim');
    assert.equal((renamed.body.project as ProjectSummary).projectId, before.projectId, 'projectId 不能变');

    const after = (await projectList(server))[0]!;
    assert.equal(after.name, '我的笔记本');
    assert.equal(after.status, 'READY');
    assert.equal(
      (await call(server, '/api/health')).body.workspaceKey,
      keyBefore,
      '重命名不改变工作区身份（否则恢复记录会失配）',
    );

    const tree = await call(server, `/api/tree?projectId=${before.projectId}`);
    assert.equal(tree.status, 200);
    assert.deepEqual(
      (tree.body.entries as Array<{ name: string }>).map((e) => e.name).sort(),
      ['docs', 'readme.md'],
      '文件树不受重命名影响',
    );

    // 磁盘上的目录名一个字节都没动
    assert.deepEqual(await readdir(parent), ['原始目录名']);
  } finally {
    await server.close();
    await rm(store, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('PA-09-01 名称空白 / 超长 / 含控制字符 → 400，名称保持原样', async () => {
  const store = await newDir('ws-04a-pa0901-');
  const root = await newRoot('ws-04a-pa0901-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await bootManaged(store, picker);
  try {
    const { token, intentId } = await credentials(server);
    const started = await postPick(server, { token, intentId });
    await waitSettled(server, String(started.body.requestId), token);
    const project = (await projectList(server))[0]!;

    const badNames = ['', '   ', '\t\n ', 'x'.repeat(65), 'bad\u0000name', 'bad\u001fname', 'bad\u007fname'];
    for (const name of badNames) {
      const res = await call(server, '/api/projects/rename', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: server.url, 'x-ws-token': token },
        body: JSON.stringify({ projectId: project.projectId, name }),
      });
      assert.equal(res.status, 400, `name=${JSON.stringify(name)} 必须 400，实际 ${res.status}`);
      assert.equal(res.body.errorCode, 'ERR_COMMAND_INVALID');
      assert.equal(res.body.message?.toString().includes(root) ?? false, false, '错误响应不得含绝对路径');
    }
    assert.equal((await projectList(server))[0]!.name, project.name, '失败的改名不得落库');
  } finally {
    await server.close();
    await rm(store, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('PA-09-02 不存在的项目 → 404；缺 projectId / name 非字符串 → 400', async () => {
  const store = await newDir('ws-04a-pa0902-');
  const root = await newRoot('ws-04a-pa0902-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await bootManaged(store, picker);
  try {
    const { token, intentId } = await credentials(server);
    const started = await postPick(server, { token, intentId });
    await waitSettled(server, String(started.body.requestId), token);

    const headers = { 'content-type': 'application/json', origin: server.url, 'x-ws-token': token };
    const missing = await call(server, '/api/projects/rename', {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectId: 'no-such-project', name: 'x' }),
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.errorCode, 'ERR_PROJECT_NOT_FOUND');

    const noId = await call(server, '/api/projects/rename', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(noId.status, 400);

    const badName = await call(server, '/api/projects/rename', {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectId: 'no-such-project', name: 42 }),
    });
    assert.equal(badName.status, 400);
  } finally {
    await server.close();
    await rm(store, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('PA-09-03 重命名端点需要 T1 令牌（无令牌 → 403）', async () => {
  const store = await newDir('ws-04a-pa0903-');
  const root = await newRoot('ws-04a-pa0903-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await bootManaged(store, picker);
  try {
    const { token, intentId } = await credentials(server);
    const started = await postPick(server, { token, intentId });
    await waitSettled(server, String(started.body.requestId), token);
    const project = (await projectList(server))[0]!;

    const res = await call(server, '/api/projects/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({ projectId: project.projectId, name: 'hijack' }),
    });
    assert.equal(res.status, 403);
    assert.equal((await projectList(server))[0]!.name, project.name);
  } finally {
    await server.close();
    await rm(store, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 注册能力探测 + 静态模式仍拒绝                                       */
/* ------------------------------------------------------------------ */

test('PA-03-01 能力探测：托管 / 静态 Multi / Legacy 三种答案', async () => {
  const store = await newDir('ws-04a-pa0301-');
  const root = await newRoot('ws-04a-pa0301-root-');
  const picker = createFakePicker([]);
  const managed = await bootManaged(store, picker);
  try {
    const res = await call(managed, '/api/projects/registration');
    assert.equal(res.status, 200);
    assert.equal(res.body.supported, true);
    assert.equal(res.body.mode, 'managed');
  } finally {
    await managed.close();
  }

  const legacyRoot = await newRoot('ws-04a-pa0301-legacy-');
  const legacy = await createShellServer({ rootDir: legacyRoot, port: 0 });
  try {
    const res = await call(legacy, '/api/projects/registration');
    assert.equal(res.status, 200);
    assert.equal(res.body.supported, false);
    assert.equal(res.body.mode, 'legacy');
  } finally {
    await legacy.close();
    await rm(store, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    await rm(legacyRoot, { recursive: true, force: true });
  }
});

test('PA-09-04 Legacy 与静态 Multi 的 rename 仍 501（不出现半实现）', async () => {
  const legacyRoot = await newRoot('ws-04a-pa0904-legacy-');
  const legacy = await createShellServer({ rootDir: legacyRoot, port: 0 });
  try {
    const res = await call(legacy, '/api/projects/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: legacy.url },
      body: JSON.stringify({ projectId: 'x', name: 'y' }),
    });
    assert.equal(res.status, 501);
    assert.equal(res.body.errorCode, 'ERR_COMMAND_UNSUPPORTED');
  } finally {
    await legacy.close();
    await rm(legacyRoot, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Shell 编排（纯 TS，确定性 port 替身）                                */
/* ------------------------------------------------------------------ */

interface FakePort extends AddProjectPort {
  readonly calls: string[];
  readonly startPayloads: Array<Record<string, unknown>>;
}

function makePort(options: {
  intentId?: string | null;
  start?: PickStartOutcome;
  queries?: PickQueryOutcome[];
  projects?: ProjectSummary[];
}): FakePort {
  const calls: string[] = [];
  const startPayloads: Array<Record<string, unknown>> = [];
  const queries = [...(options.queries ?? [])];
  const port: FakePort = {
    calls,
    startPayloads,
    async bootstrap() {
      calls.push('bootstrap');
      return { token: 'tok-1', intentId: options.intentId === undefined ? 'intent-1' : options.intentId };
    },
    async startPick(input) {
      calls.push('startPick');
      startPayloads.push({ ...input });
      return options.start ?? { status: 'PENDING', requestId: 'req-1', httpStatus: 202 };
    },
    async queryPick() {
      calls.push('queryPick');
      return queries.shift() ?? { status: 'PENDING', httpStatus: 200 };
    },
    async listProjects() {
      calls.push('listProjects');
      return options.projects ?? [];
    },
    async workspaceKey() {
      calls.push('workspaceKey');
      return 'a'.repeat(64);
    },
  };
  return port;
}

function makeFlow(port: FakePort, overrides: Partial<{ support: 'managed' | 'static' | 'legacy' | 'demo' }> = {}) {
  const applied: ProjectSummary[][] = [];
  const loaded: string[] = [];
  /** 界面副作用的发生顺序：用于锁住"先读根层、再改摘要"这个不可交换的顺序。 */
  const order: string[] = [];
  let key: string | null = null;
  let clock = 0;
  const identity = { mode: 'live' as const, workspaceKey: 'a'.repeat(64) };
  const adder = createProjectAdder({
    port,
    identity: () => identity,
    onProjects: (projects) => {
      applied.push(projects);
      order.push('onProjects');
    },
    onWorkspaceKey: (next) => {
      key = next;
      order.push('onWorkspaceKey');
    },
    loadRoot: async (projectId) => {
      loaded.push(projectId);
      order.push('loadRoot');
    },
    wait: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    pollIntervalMs: 10,
    timeoutMs: 1_000,
  });
  const states: string[] = [];
  const flow = createAddProjectFlow({
    adder,
    support: () => overrides.support ?? 'managed',
    onChange: (state) => states.push(state.phase),
  });
  return { flow, applied, loaded, order, states, identity, key: () => key };
}

test('PA-01-01 打开信任模态不发出任何请求', async () => {
  const port = makePort({});
  const { flow, states } = makeFlow(port);
  flow.open();
  assert.equal(flow.state().phase, 'disclosure');
  assert.deepEqual(states, ['disclosure']);
  assert.deepEqual(port.calls, [], '点"添加项目"只打开模态');
});

test('PA-02-01 取消模态：零请求、零副作用', async () => {
  const port = makePort({});
  const { flow, applied, loaded } = makeFlow(port);
  flow.open();
  flow.cancel();
  assert.equal(flow.state().phase, 'closed');
  assert.deepEqual(port.calls, []);
  assert.deepEqual(applied, []);
  assert.deepEqual(loaded, []);
});

test('PA-03-02 确认后顺序：bootstrap → startPick（带 acknowledgeScope），再轮询', async () => {
  const port = makePort({
    queries: [{ status: 'CANCELLED', httpStatus: 200 }],
  });
  const { flow } = makeFlow(port);
  flow.open();
  const result = await flow.confirm();
  assert.equal(result.kind, 'cancelled');
  assert.deepEqual(port.calls, ['bootstrap', 'startPick', 'queryPick']);
  assert.equal(port.startPayloads[0]?.intentId, 'intent-1');
  assert.equal(port.startPayloads[0]?.acknowledgeScope, 'browse-subtree');
  assert.equal(port.startPayloads[0]?.token, 'tok-1');
});

test('PA-01-02 重复确认不会弹第二个选择器（单飞）', async () => {
  const port = makePort({
    queries: [{ status: 'CANCELLED', httpStatus: 200 }, { status: 'CANCELLED', httpStatus: 200 }],
  });
  const { flow } = makeFlow(port);
  flow.open();
  const first = flow.confirm();
  const second = flow.confirm(); // 仍在 picking
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.kind, 'cancelled');
  assert.equal(b.kind, 'busy');
  assert.equal(port.startPayloads.length, 1);
});

test('PA-05-02 选择器取消：结果只报一次，不自动重试', async () => {
  const port = makePort({ queries: [{ status: 'CANCELLED', httpStatus: 200 }] });
  const { flow, applied } = makeFlow(port);
  flow.open();
  const result = await flow.confirm();
  assert.equal(result.kind, 'cancelled');
  assert.equal(flow.state().phase, 'done');
  assert.equal(port.startPayloads.length, 1, '取消不得自动重试');
  assert.deepEqual(applied, []);
});

test('PA-06-02 选择器不可用 → rejected，且不回落任何文本路径注册', async () => {
  const port = makePort({
    queries: [
      { status: 'REJECTED', errorCode: 'ERR_PICKER_UNAVAILABLE', httpStatus: 501, reason: 'unavailable' },
    ],
  });
  const { flow, applied } = makeFlow(port);
  flow.open();
  const result = await flow.confirm();
  assert.equal(result.kind, 'rejected');
  assert.equal(result.kind === 'rejected' ? result.errorCode : null, 'ERR_PICKER_UNAVAILABLE');
  assert.equal(port.startPayloads.length, 1);
  assert.deepEqual(applied, []);
  const dumped = JSON.stringify(port.startPayloads);
  for (const forbidden of ['rootDir', 'path', 'grantSource', 'canonicalRoot']) {
    assert.equal(dumped.includes(forbidden), false, `请求体不得包含 ${forbidden}`);
  }
});

test('PA-07-02 APPLIED → 重取项目表 + 加载新项目根层 + 刷新工作区摘要', async () => {
  const project: ProjectSummary = { projectId: 'p-new', name: '新项目', status: 'READY' };
  const port = makePort({
    queries: [{ status: 'APPLIED', httpStatus: 200, project }],
    projects: [project],
  });
  const { flow, applied, loaded, order, key } = makeFlow(port);
  flow.open();
  const result = await flow.confirm();
  assert.equal(result.kind, 'applied');
  assert.deepEqual(applied, [[project]], '必须用 Host 返回的项目表刷新界面');
  assert.deepEqual(loaded, ['p-new'], '必须立刻读新项目的根层');
  assert.equal(key(), 'a'.repeat(64), '工作区摘要要跟着 Host 更新');
  /**
   * 添加项目一定会改变 workspaceKey，而逐层加载的归属票据要比对它。
   * 顺序反了（先改摘要再读根层）时，根层响应的票据立即过期并被丢弃，
   * 界面就会"项目加进来了，点开却是空的"。
   */
  assert.deepEqual(order, ['onProjects', 'loadRoot', 'onWorkspaceKey'], '必须先读根层，再更新工作区摘要');
  assert.equal(flow.state().phase, 'done');
});

test('PA-07-03 工作区在等待期间变化 → 迟到结果一律丢弃', async () => {
  const project: ProjectSummary = { projectId: 'p-new', name: '新项目', status: 'READY' };
  const port = makePort({
    queries: [
      { status: 'PENDING', httpStatus: 200 },
      { status: 'APPLIED', httpStatus: 200, project },
    ],
    projects: [project],
  });
  const { flow, applied, loaded, identity, key } = makeFlow(port);
  flow.open();
  const pending = flow.confirm();
  // 模拟"用户切走再切回 / 重新连接"：身份摘要变了
  identity.workspaceKey = 'b'.repeat(64);
  const result = await pending;
  assert.equal(result.kind, 'stale');
  assert.deepEqual(applied, [], '旧工作区的项目表不得回填');
  assert.deepEqual(loaded, []);
  assert.equal(key(), null, '不得把旧响应的工作区摘要写进新界面');
});

test('PA-06-03 Host 不发意图（降级）→ 直接 unsupported，且不发 pick 请求', async () => {
  // 正常流程会先按 support() 判定；这里验证的是防御路径：能力探测之后 Host 才降级
  const port = makePort({ intentId: null });
  const applied: ProjectSummary[][] = [];
  const adder = createProjectAdder({
    port,
    identity: () => ({ mode: 'live' as const, workspaceKey: 'a'.repeat(64) }),
    onProjects: (projects) => applied.push(projects),
    onWorkspaceKey: () => undefined,
    loadRoot: async () => undefined,
    wait: async () => undefined,
    now: () => 0,
  });
  const result = await adder.add();
  assert.equal(result.kind, 'unsupported');
  assert.deepEqual(port.calls, ['bootstrap'], '没有意图就绝不尝试 POST pick');
  assert.deepEqual(applied, []);
});

test('PA-03-03 非托管模式下点确认直接给说明，不发任何请求', async () => {
  const port = makePort({});
  const { flow } = makeFlow(port, { support: 'legacy' });
  flow.open();
  const result = await flow.confirm();
  assert.equal(result.kind, 'unsupported');
  assert.deepEqual(port.calls, []);
  assert.equal(flow.state().phase, 'done');
});

test('PA-09-05 名称校验与 Host 同规则（trim / 64 字 / 控制字符）', () => {
  assert.deepEqual(validateProjectName('  我的项目  '), { ok: true, name: '我的项目' });
  assert.equal(validateProjectName('').ok, false);
  assert.equal(validateProjectName('   ').ok, false);
  assert.equal(validateProjectName('x'.repeat(64)).ok, true);
  assert.equal(validateProjectName('x'.repeat(65)).ok, false);
  assert.equal(validateProjectName('a\u0000b').ok, false);
  assert.equal(validateProjectName('a\u001fb').ok, false);
  assert.equal(validateProjectName('a\u007fb').ok, false);
  // 中文按字符计，不按字节
  assert.equal(validateProjectName('中'.repeat(64)).ok, true);
  assert.equal(validateProjectName('中'.repeat(65)).ok, false);
});

/* ------------------------------------------------------------------ */
/* PA-10 新项目不得冲掉其它项目的层表                                   */
/* ------------------------------------------------------------------ */

test('PA-10-01 SET_PROJECTS 只更新项目表：其它项目的层表与展开状态原样保留', async () => {
  const seeded = workspaceReducer(INITIAL_STATE, {
    type: 'TREE_LEVEL_PAGE',
    projectId: 'project-a',
    dir: '',
    entries: [
      { id: 'dir:project-a/docs', name: 'docs', kind: 'folder', relPath: 'docs' },
    ] as never,
    cursor: null,
    nextCursor: null,
    total: 1,
    snapshot: null,
  });
  const before = seeded.treeByProject['project-a'];
  assert.ok(before);

  const next = workspaceReducer(seeded, {
    type: 'SET_PROJECTS',
    projects: [
      { projectId: 'project-a', name: '项目 A', status: 'READY' },
      { projectId: 'project-b', name: '项目 B', status: 'READY' },
    ],
  });
  assert.equal(next.treeByProject['project-a'], before, '已有项目的层表引用必须完全不变');
  assert.equal(next.treeByProject['project-b'], undefined);
});

test('PA-10-02 分页合并按目录追加，不会把别的项目拖进来', () => {
  const levels = applyPage(emptyLevels(), '', {
    entries: [{ id: 'doc:a/x.md', name: 'x.md', kind: 'file', relPath: 'x.md' }] as never,
    cursor: null,
    nextCursor: '1',
    total: 2,
    snapshot: 's1',
  });
  const more = applyPage(levels, '', {
    entries: [{ id: 'doc:a/y.md', name: 'y.md', kind: 'file', relPath: 'y.md' }] as never,
    cursor: '1',
    nextCursor: null,
    total: 2,
    snapshot: 's1',
  });
  assert.deepEqual(more['']?.entries.map((entry) => entry.name), ['x.md', 'y.md']);
});

/* ------------------------------------------------------------------ */
/* 真实客户端接线（PA-03 / PA-06 / PA-08 的线上形状）                   */
/* ------------------------------------------------------------------ */

/**
 * 浏览器对所有 POST 都会自动带 `Origin`（Host 据此拒绝非浏览器客户端），Node 的
 * fetch 不会。这里只补这一个头，其余请求原样透传：目的是让**真实客户端代码**
 * 在 Node 里跑在与浏览器相同的协议条件下，而不是放宽 Host 的校验。
 */
async function withBrowserOrigin<T>(origin: string, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = new Headers(init?.headers);
    if (!headers.has('origin')) headers.set('origin', origin);
    return original(input, { ...init, headers });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('PA-03-04 真实客户端：bootstrap → startPick → queryPick 落成 READY 项目，且不带任何路径字段', async () => {
  const store = await newDir('ws-04a-pa0304-');
  const root = await newRoot('ws-04a-pa0304-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await bootManaged(store, picker);
  try {
    const client = createLiveClient(server.url);
    const registration = await client.registrationSupport();
    assert.equal(registration.support, 'managed');

    const boot = await client.bootstrapPick();
    assert.ok(boot.token.length > 0);
    assert.ok(boot.intentId, '托管模式必须发放一次性意图');

    const started = await withBrowserOrigin(server.url, () =>
      client.startPick({
        token: boot.token,
        intentId: boot.intentId as string,
        acknowledgeScope: ACKNOWLEDGE_SCOPE,
      }),
    );
    assert.equal(started.status, 'PENDING', JSON.stringify(started));
    assert.ok(started.requestId);

    let settled = await client.queryPick({ token: boot.token, requestId: started.requestId as string });
    for (let i = 0; i < 200 && settled.status === 'PENDING'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      settled = await client.queryPick({ token: boot.token, requestId: started.requestId as string });
    }
    assert.equal(settled.status, 'APPLIED', JSON.stringify(settled));
    assert.equal(picker.calls, 1, '一次确认只能弹一次窗口');

    const projects = await client.listProjects();
    const added = projects.find((project) => project.projectId === settled.project?.projectId);
    assert.ok(added, '新项目必须出现在 /api/projects');
    assert.equal(added.status, 'READY');
    // 项目摘要不得泄露本机路径
    assert.equal(JSON.stringify(added).includes(root), false);
  } finally {
    await server.close();
    await rm(store, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('PA-06-04 真实客户端：非托管 Host 的能力探测不得报 managed', async () => {
  const legacyRoot = await newRoot('ws-04a-pa0604-legacy-');
  const legacy = await createShellServer({ rootDir: legacyRoot, port: 0 });
  try {
    const client = createLiveClient(legacy.url);
    const registration = await client.registrationSupport();
    assert.equal(registration.support, 'legacy');
    // 没有意图时客户端必须能表达"不发放"，编排层据此零请求收手
    const boot = await client.bootstrapPick();
    assert.equal(boot.intentId, null);
  } finally {
    await legacy.close();
    await rm(legacyRoot, { recursive: true, force: true });
  }
});

test('PA-08-02 真实客户端重命名：只改显示名，磁盘目录名与 projectId 不变', async () => {
  const store = await newDir('ws-04a-pa0802-');
  const root = await newRoot('ws-04a-pa0802-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await bootManaged(store, picker);
  try {
    const client = createLiveClient(server.url);
    const added = await withBrowserOrigin(server.url, async () => {
      const boot = await client.bootstrapPick();
      const started = await client.startPick({
        token: boot.token,
        intentId: boot.intentId as string,
        acknowledgeScope: ACKNOWLEDGE_SCOPE,
      });
      let settled = await client.queryPick({
        token: boot.token,
        requestId: started.requestId as string,
      });
      for (let i = 0; i < 200 && settled.status === 'PENDING'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        settled = await client.queryPick({ token: boot.token, requestId: started.requestId as string });
      }
      return settled;
    });
    const projectId = added.project?.projectId as string;
    assert.ok(projectId, JSON.stringify(added));

    const renamed = await client.renameProject(projectId, '  研发文档  ');
    assert.equal(renamed.status, 'APPLIED', JSON.stringify(renamed));
    assert.equal(renamed.status === 'APPLIED' && renamed.project.name, '研发文档', 'Host 必须回传 trim 之后的名字');
    assert.equal(renamed.status === 'APPLIED' && renamed.project.projectId, projectId, 'projectId 不得改变');

    const projects = await client.listProjects();
    const current = projects.find((project) => project.projectId === projectId);
    assert.equal(current?.name, '研发文档');
    // 磁盘上的目录名与文件树都不动：名称只是显示属性
    assert.equal((await readdir(root)).includes('readme.md'), true, '原目录必须还在原位置');
    const siblings = await readdir(join(root, '..'));
    assert.equal(siblings.includes('研发文档'), false, '重命名不得在磁盘上创建目录');
    const tree = await client.listTree(projectId, '');
    assert.equal(tree.status, 'APPLIED');
    assert.equal(tree.status === 'APPLIED' && tree.entries.some((entry) => entry.name === 'readme.md'), true);
  } finally {
    await server.close();
    await rm(store, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('PA-09-06 真实客户端重命名：空名被 Host 拒绝，名称保持原样', async () => {
  const store = await newDir('ws-04a-pa0906-');
  const root = await newRoot('ws-04a-pa0906-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await bootManaged(store, picker);
  try {
    const client = createLiveClient(server.url);
    const added = await withBrowserOrigin(server.url, async () => {
      const boot = await client.bootstrapPick();
      const started = await client.startPick({
        token: boot.token,
        intentId: boot.intentId as string,
        acknowledgeScope: ACKNOWLEDGE_SCOPE,
      });
      let settled = await client.queryPick({
        token: boot.token,
        requestId: started.requestId as string,
      });
      for (let i = 0; i < 200 && settled.status === 'PENDING'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        settled = await client.queryPick({ token: boot.token, requestId: started.requestId as string });
      }
      return settled;
    });
    const projectId = added.project?.projectId as string;
    const before = added.project?.name as string;

    const rejected = await client.renameProject(projectId, '   ');
    assert.equal(rejected.status, 'REJECTED');
    const after = (await client.listProjects()).find((project) => project.projectId === projectId);
    assert.equal(after?.name, before, '失败必须保留原名');
  } finally {
    await server.close();
    await rm(store, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('PA-10-03 PROJECT_RENAMED 只替换那一行：层表、当前项目与其它项目原样保留', () => {
  let state = workspaceReducer(INITIAL_STATE, {
    type: 'TREE_LEVEL_PAGE',
    projectId: 'project-a',
    dir: '',
    entries: [{ id: 'dir:docs', name: 'docs', kind: 'folder', relPath: 'docs' }] as never,
    cursor: null,
    nextCursor: null,
    total: 1,
    snapshot: null,
  });
  state = workspaceReducer(state, {
    type: 'SET_PROJECTS',
    projects: [
      { projectId: 'project-a', name: '项目 A', status: 'READY' },
      { projectId: 'project-b', name: '项目 B', status: 'READY' },
    ],
  });
  const levelsBefore = state.treeByProject['project-a'];
  const activeBefore = state.activeProjectId;

  const next = workspaceReducer(state, {
    type: 'PROJECT_RENAMED',
    project: { projectId: 'project-a', name: '研发文档', status: 'READY' },
  });
  assert.equal(next.projects[0].name, '研发文档');
  assert.equal(next.projects[1].name, '项目 B', '其它项目不得被改动');
  assert.equal(next.activeProjectId, activeBefore, '重命名不是"切换项目"');
  assert.equal(next.treeByProject['project-a'], levelsBefore, '层表引用必须完全不变');
});

test('PA-05-03 系统窗口仍打开时轮询必须是 PENDING（Host 返回 202，不是错误）', async () => {
  const store = await newDir('ws-04a-pa0503-');
  const root = await newRoot('ws-04a-pa0503-root-');
  const deferred = createDeferredFakePicker();
  const server = await createShellServer({ port: 0, managedStore: { dir: store, picker: deferred } });
  try {
    const client = createLiveClient(server.url);
    const boot = await client.bootstrapPick();
    const started = await withBrowserOrigin(server.url, () =>
      client.startPick({
        token: boot.token,
        intentId: boot.intentId as string,
        acknowledgeScope: ACKNOWLEDGE_SCOPE,
      }),
    );
    assert.equal(started.status, 'PENDING', JSON.stringify(started));
    const requestId = started.requestId as string;
    await deferred.waitForCall();

    /**
     * 关键点：PENDING 记录的 HTTP 状态是 **202**（"已受理、尚未完成"），不是 200。
     * 客户端若只把 200 当结果，就会把"用户还在系统窗口里挑"误读成失败并停止轮询。
     */
    const stillOpen = await client.queryPick({ token: boot.token, requestId });
    assert.equal(stillOpen.status, 'PENDING', `系统窗口还开着时必须继续等，实际 ${JSON.stringify(stillOpen)}`);

    deferred.resolve({ status: 'cancelled' });
    let settled = await client.queryPick({ token: boot.token, requestId });
    for (let i = 0; i < 200 && settled.status === 'PENDING'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      settled = await client.queryPick({ token: boot.token, requestId });
    }
    assert.equal(settled.status, 'CANCELLED');
    assert.deepEqual(await projectList(server), [], '取消不得留下任何项目');
  } finally {
    await server.close();
    await rm(store, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
