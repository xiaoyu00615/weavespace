/**
 * S11-UX-02B-03：本机目录选择与授权信任边界（ADR-021 S-01…S-16）。
 *
 * 这套测试的目标不是"UI 能点"，而是**证明浏览器无法凭请求内容获得任何目录权限**：
 *   T1 令牌只证明请求来自本机页面；
 *   T2 intentId 只证明这次意图没被重放；
 *   T3（Host 内部选择器 + inspectProjectRoot）才是唯一的目录确认证据。
 *
 * 全部用 fake picker 驱动（确定性）；真实 Windows 弹窗必须人工验证，
 * fake 的成功**不能**当作真实弹窗的证据（见报告）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createDeferredFakePicker, createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { StartupArgsError, parseStartup, type StartupArgsErrorCode } from '../../apps/server/src/startup-args.ts';
import type { PickOutcome } from '../../apps/server/src/folder-picker/types.ts';

/* ------------------------------- 夹具 ------------------------------- */

interface BootOptions {
  readonly dir: string;
  readonly picker?: ReturnType<typeof createFakePicker> | ReturnType<typeof createDeferredFakePicker>;
  readonly intentTtlMs?: number;
  readonly pickerTimeoutMs?: number;
  readonly now?: () => number;
}

async function boot(options: BootOptions): Promise<ShellServer> {
  return createShellServer({
    port: 0,
    managedStore: {
      dir: options.dir,
      ...(options.picker ? { picker: options.picker } : {}),
      ...(options.intentTtlMs !== undefined ? { intentTtlMs: options.intentTtlMs } : {}),
      ...(options.pickerTimeoutMs !== undefined ? { pickerTimeoutMs: options.pickerTimeoutMs } : {}),
      ...(options.now ? { now: options.now } : {}),
    },
  });
}

interface ApiResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function call(server: ShellServer, path: string, init: RequestInit = {}): Promise<ApiResponse> {
  const res = await fetch(`${server.url}${path}`, init);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

interface Credentials {
  readonly token: string;
  readonly intentId: string;
  readonly expiresAt: string;
}

/** 取一次 T1 令牌 + T2 意图（两者都必须，但证明力互不替代）。 */
async function credentials(server: ShellServer): Promise<Credentials> {
  const res = await call(server, '/api/session-token');
  assert.equal(res.status, 200, `session-token 失败: ${JSON.stringify(res.body)}`);
  const intent = res.body.intent as { intentId: string; expiresAt: string };
  assert.ok(intent?.intentId, '托管模式必须同时发放一次性意图');
  return { token: String(res.body.token), intentId: intent.intentId, expiresAt: intent.expiresAt };
}

interface PickCallOptions {
  readonly token?: string;
  readonly intentId?: string;
  readonly name?: string;
  readonly extra?: Record<string, unknown>;
  /** 缺省同源；显式 `null` 表示完全不发送 Origin（S-02）。 */
  readonly origin?: string | null;
  readonly site?: string;
}

async function postPick(server: ShellServer, options: PickCallOptions): Promise<ApiResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== undefined) headers['x-ws-token'] = options.token;
  const origin = options.origin === undefined ? server.url : options.origin;
  if (origin !== null) headers.origin = origin;
  if (options.site !== undefined) headers['sec-fetch-site'] = options.site;
  return call(server, '/api/projects/pick', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...(options.intentId !== undefined ? { intentId: options.intentId } : {}),
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.extra ?? {}),
    }),
  });
}

async function getPick(server: ShellServer, requestId: string, token: string): Promise<ApiResponse> {
  return call(server, `/api/projects/pick?requestId=${encodeURIComponent(requestId)}`, {
    headers: { 'x-ws-token': token },
  });
}

/** 等选择任务落定（fake 立即返回时通常一轮就够）。 */
async function waitSettled(server: ShellServer, requestId: string, token: string): Promise<ApiResponse> {
  let last: ApiResponse = await getPick(server, requestId, token);
  for (let i = 0; i < 200 && last.body.status === 'PENDING'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    last = await getPick(server, requestId, token);
  }
  return last;
}

async function newDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function newRoot(prefix: string, file = 'readme.md'): Promise<string> {
  const dir = await newDir(prefix);
  await writeFile(join(dir, file), '# hello\n', 'utf8');
  await mkdir(join(dir, 'docs'), { recursive: true });
  await writeFile(join(dir, 'docs', 'guide.md'), '# guide\n', 'utf8');
  return dir;
}

/* ------------------------------------------------------------------ */
/* S-01 跨源页面 POST /api/projects/pick                                */
/* ------------------------------------------------------------------ */

test('S-01 跨源 pick 请求 403，且不弹出选择器', async () => {
  const dir = await newDir('ws-03-s01-');
  const root = await newRoot('ws-03-s01-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await boot({ dir, picker });
  try {
    const { token, intentId } = await credentials(server);
    const res = await postPick(server, { token, intentId, origin: 'http://evil.example' });
    assert.equal(res.status, 403);
    assert.equal(res.body.errorCode, 'ERR_PERMISSION_DENIED');
    assert.equal(picker.calls, 0, '被拒绝的请求不得启动选择器进程');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* S-02 无 Origin 的变更请求                                            */
/* ------------------------------------------------------------------ */

test('S-02 变更类请求缺少 Origin 时 403（不依赖 token 兜底）', async () => {
  const dir = await newDir('ws-03-s02-');
  const root = await newRoot('ws-03-s02-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await boot({ dir, picker });
  try {
    const { token, intentId } = await credentials(server);
    const res = await postPick(server, { token, intentId, origin: null });
    assert.equal(res.status, 403, `实际 ${res.status}/${JSON.stringify(res.body)}`);
    assert.equal(picker.calls, 0);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* S-03 Origin: null / cross-site                                       */
/* ------------------------------------------------------------------ */

test('S-03 Origin: null 与 cross-site 一律 403', async () => {
  const dir = await newDir('ws-03-s03-');
  const root = await newRoot('ws-03-s03-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await boot({ dir, picker });
  try {
    const { token, intentId } = await credentials(server);
    const nullOrigin = await postPick(server, { token, intentId, origin: 'null' });
    assert.equal(nullOrigin.status, 403);

    const fresh = await credentials(server);
    const crossSite = await postPick(server, {
      token: fresh.token,
      intentId: fresh.intentId,
      site: 'cross-site',
    });
    assert.equal(crossSite.status, 403);
    assert.equal(picker.calls, 0);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* S-04 伪造 / 缺失 / 已淘汰令牌                                        */
/* ------------------------------------------------------------------ */

test('S-04 伪造或缺失 X-WS-Token 一律 403，且不弹对话框', async () => {
  const dir = await newDir('ws-03-s04-');
  const root = await newRoot('ws-03-s04-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await boot({ dir, picker });
  try {
    const { intentId } = await credentials(server);

    const missing = await postPick(server, { intentId });
    assert.equal(missing.status, 403);

    const forged = await postPick(server, { token: 'not-a-real-token', intentId });
    assert.equal(forged.status, 403);

    // 查询端点同样要求令牌（否则 requestId 会变成可探测面）
    const queryNoToken = await call(server, '/api/projects/pick?requestId=pick-x');
    assert.equal(queryNoToken.status, 403);

    assert.equal(picker.calls, 0);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* S-05 intentId 重放                                                   */
/* ------------------------------------------------------------------ */

test('S-05 已消费的 intentId 再次使用 → 410，且只弹一次对话框', async () => {
  const dir = await newDir('ws-03-s05-');
  const root = await newRoot('ws-03-s05-root-');
  const picker = createFakePicker([{ status: 'cancelled' }]);
  const server = await boot({ dir, picker });
  try {
    const { token, intentId } = await credentials(server);

    const first = await postPick(server, { token, intentId });
    assert.equal(first.status, 202);
    await waitSettled(server, String(first.body.requestId), token);

    const replay = await postPick(server, { token, intentId });
    assert.equal(replay.status, 410);
    assert.equal(replay.body.errorCode, 'ERR_INTENT_CONSUMED');
    assert.equal(picker.calls, 1, '重放不得再启动选择器');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* S-06 intentId 过期                                                   */
/* ------------------------------------------------------------------ */

test('S-06 意图超过 TTL（120s）后 → 410 ERR_INTENT_EXPIRED', async () => {
  const dir = await newDir('ws-03-s06-');
  const root = await newRoot('ws-03-s06-root-');
  const picker = createFakePicker([{ status: 'cancelled' }]);
  let clock = 1_000_000;
  const server = await boot({ dir, picker, intentTtlMs: 120_000, now: () => clock });
  try {
    const { token, intentId } = await credentials(server);
    clock += 120_001; // 越过 TTL
    const res = await postPick(server, { token, intentId });
    assert.equal(res.status, 410);
    assert.equal(res.body.errorCode, 'ERR_INTENT_EXPIRED');
    assert.equal(picker.calls, 0);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* S-07 选择器单飞                                                      */
/* ------------------------------------------------------------------ */

test('S-07 并发 pick：第二次 409 ERR_PICKER_BUSY，只创建一个选择器', async () => {
  const dir = await newDir('ws-03-s07-');
  const root = await newRoot('ws-03-s07-root-');
  const picker = createDeferredFakePicker();
  const server = await boot({ dir, picker });
  try {
    const first = await credentials(server);
    const started = await postPick(server, { token: first.token, intentId: first.intentId });
    assert.equal(started.status, 202);
    await picker.waitForCall();

    const second = await credentials(server);
    const busy = await postPick(server, { token: second.token, intentId: second.intentId });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.errorCode, 'ERR_PICKER_BUSY');
    assert.equal(picker.calls, 1, '同一时刻只允许一个系统对话框');

    picker.resolve({ status: 'cancelled' });
    const settled = await waitSettled(server, String(started.body.requestId), first.token);
    assert.equal(settled.status, 200);
    assert.equal(settled.body.status, 'CANCELLED');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* S-08 用户取消                                                        */
/* ------------------------------------------------------------------ */

test('S-08 取消 → 200 CANCELLED，配置与内存零变化', async () => {
  const dir = await newDir('ws-03-s08-');
  const root = await newRoot('ws-03-s08-root-');
  const picker = createFakePicker([{ status: 'cancelled' }]);
  const server = await boot({ dir, picker });
  try {
    const { token, intentId } = await credentials(server);
    const before = await call(server, '/api/projects');
    const started = await postPick(server, { token, intentId });
    const settled = await waitSettled(server, String(started.body.requestId), token);

    assert.equal(settled.status, 200);
    assert.equal(settled.body.status, 'CANCELLED');
    assert.equal(settled.body.errorCode, undefined);

    const after = await call(server, '/api/projects');
    assert.deepEqual(after.body, before.body, '取消不得改变项目集合');
    assert.deepEqual(after.body.projects, []);
  } finally {
    await server.close();
  }

  // 磁盘上也不应出现任何项目记录（关掉 Host 释放锁后再读）
  const reopened = await boot({ dir });
  try {
    assert.deepEqual((await call(reopened, '/api/projects')).body.projects, []);
  } finally {
    await reopened.close();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* S-09 选择器不可用 / 超时                                             */
/* ------------------------------------------------------------------ */

test('S-09 选择器不可用或超时 → 501 ERR_PICKER_UNAVAILABLE，零副作用', async () => {
  const dir = await newDir('ws-03-s09-');
  const root = await newRoot('ws-03-s09-root-');
  const outcomes: PickOutcome[] = [
    { status: 'unavailable', detail: '找不到 powershell.exe' },
    { status: 'timeout' },
  ];
  const picker = createFakePicker(outcomes);
  const server = await boot({ dir, picker });
  try {
    for (const expectedReason of ['unavailable', 'timeout']) {
      const { token, intentId } = await credentials(server);
      const started = await postPick(server, { token, intentId });
      assert.equal(started.status, 202);
      const settled = await waitSettled(server, String(started.body.requestId), token);
      assert.equal(settled.status, 501, `实际 ${settled.status}/${JSON.stringify(settled.body)}`);
      assert.equal(settled.body.errorCode, 'ERR_PICKER_UNAVAILABLE');
      assert.equal(settled.body.reason, expectedReason);
      // 响应不得泄漏任何本机路径
      assert.equal(JSON.stringify(settled.body).includes(root), false);
    }
    assert.deepEqual((await call(server, '/api/projects')).body.projects, []);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* S-10 请求体夹带路径或授权字段                                        */
/* ------------------------------------------------------------------ */

test('S-10 body 携带 rootDir/path/canonicalRoot/rootToken/grantSource 一律 400 且零 IO', async () => {
  const dir = await newDir('ws-03-s10-');
  const root = await newRoot('ws-03-s10-root-');
  const picker = createFakePicker([{ status: 'cancelled' }]);
  const server = await boot({ dir, picker });
  try {
    const forbidden: Array<Record<string, unknown>> = [
      { rootDir: root },
      { root: root },
      { path: root },
      { directory: root },
      { canonicalRoot: root },
      { rootToken: 'dev:1:1' },
      { grantSource: 'os-dialog' },
      { actorId: 'someone-else' },
    ];
    for (const extra of forbidden) {
      const { token, intentId } = await credentials(server);
      const res = await postPick(server, { token, intentId, extra });
      const field = Object.keys(extra)[0];
      assert.equal(res.status, 400, `${field} 必须被拒绝，实际 ${res.status}/${JSON.stringify(res.body)}`);
      assert.equal(res.body.errorCode, 'ERR_COMMAND_INVALID');
    }
    assert.equal(picker.calls, 0, '夹带可信字段的请求不得启动选择器');
    assert.deepEqual((await call(server, '/api/projects')).body.projects, []);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* S-11 目录形态不合法                                                  */
/* ------------------------------------------------------------------ */

test('S-11 选中文件 / 不存在的目录 / UNC 路径 → 422 且零写入', async () => {
  const dir = await newDir('ws-03-s11-');
  const root = await newRoot('ws-03-s11-root-');
  const filePath = join(root, 'readme.md');
  const missing = join(root, 'no-such-dir');
  const unc = '\\\\server\\share\\folder';

  const picker = createFakePicker([
    { status: 'picked', folder: { absolutePath: filePath } },
    { status: 'picked', folder: { absolutePath: missing } },
    { status: 'picked', folder: { absolutePath: unc } },
  ]);
  const server = await boot({ dir, picker });
  try {
    const expectedReasons = ['NOT_DIRECTORY', 'MISSING', 'UNC_UNSUPPORTED'];
    for (const reason of expectedReasons) {
      const { token, intentId } = await credentials(server);
      const started = await postPick(server, { token, intentId });
      const settled = await waitSettled(server, String(started.body.requestId), token);
      assert.equal(settled.status, 422, `${reason}: 实际 ${settled.status}/${JSON.stringify(settled.body)}`);
      assert.equal(settled.body.errorCode, 'ERR_PROJECT_CONFIG_INVALID');
      assert.equal(settled.body.reason, reason);
    }
    assert.deepEqual((await call(server, '/api/projects')).body.projects, [], '零写入：不得留下部分登记');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* S-12 重复根 / 嵌套根                                                 */
/* ------------------------------------------------------------------ */

test('S-12 选择重复根 → 409，选择子目录（嵌套）→ 422，均零写入', async () => {
  const dir = await newDir('ws-03-s12-');
  const rootA = await newRoot('ws-03-s12-a-');
  const nested = join(rootA, 'docs');

  const picker = createFakePicker([
    { status: 'picked', folder: { absolutePath: rootA } },
    { status: 'picked', folder: { absolutePath: rootA } },
    { status: 'picked', folder: { absolutePath: nested } },
  ]);
  const server = await boot({ dir, picker });
  try {
    // 第一次成功注册
    const first = await credentials(server);
    const started = await postPick(server, { token: first.token, intentId: first.intentId });
    const added = await waitSettled(server, String(started.body.requestId), first.token);
    assert.equal(added.status, 200, `实际 ${added.status}/${JSON.stringify(added.body)}`);
    assert.equal(added.body.status, 'APPLIED');

    // 同一根再来一次
    const second = await credentials(server);
    const dup = await postPick(server, { token: second.token, intentId: second.intentId });
    const dupSettled = await waitSettled(server, String(dup.body.requestId), second.token);
    assert.equal(dupSettled.status, 409);
    assert.equal(dupSettled.body.errorCode, 'ERR_PROJECT_DUPLICATE_ROOT');

    // 子目录：嵌套
    const third = await credentials(server);
    const nest = await postPick(server, { token: third.token, intentId: third.intentId });
    const nestSettled = await waitSettled(server, String(nest.body.requestId), third.token);
    assert.equal(nestSettled.status, 422);
    assert.equal(nestSettled.body.errorCode, 'ERR_PROJECT_NESTED_ROOT');

    const projects = (await call(server, '/api/projects')).body.projects as readonly unknown[];
    assert.equal(projects.length, 1, '失败的准入不得登记项目');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(rootA, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* S-13 选择器未返回时 Host 重启                                        */
/* ------------------------------------------------------------------ */

test('S-13 选择器未返回时重启 → 旧 requestId 410，且无半成品配置', async () => {
  const dir = await newDir('ws-03-s13-');
  const root = await newRoot('ws-03-s13-root-');
  const picker = createDeferredFakePicker();
  const first = await boot({ dir, picker });
  let requestId = '';
  try {
    const { token, intentId } = await credentials(first);
    const started = await postPick(first, { token, intentId });
    assert.equal(started.status, 202);
    requestId = String(started.body.requestId);
    await picker.waitForCall();
  } finally {
    // 模拟 Host 在对话框还开着时被重启
    await first.close();
  }

  // 选择器之后才返回：Host 已关闭，结果必须被丢弃（不得写入 Store）
  picker.resolve({ status: 'picked', folder: { absolutePath: root } });

  const second = await boot({ dir });
  try {
    const { token } = await credentials(second);
    const stale = await getPick(second, requestId, token);
    assert.equal(stale.status, 410, `实际 ${stale.status}/${JSON.stringify(stale.body)}`);
    assert.equal(stale.body.errorCode, 'ERR_PICK_REQUEST_GONE');

    // 关键：重启后磁盘上没有半成品项目
    assert.deepEqual((await call(second, '/api/projects')).body.projects, []);
    assert.equal((await call(second, '/api/health')).status, 200);
  } finally {
    await second.close();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* S-14 响应不泄漏路径 / 令牌 / providerId                              */
/* ------------------------------------------------------------------ */

test('S-14 添加后 /api/projects 与 /api/health 不含任何绝对路径、rootToken、providerId', async () => {
  const dir = await newDir('ws-03-s14-');
  const root = await newRoot('ws-03-s14-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await boot({ dir, picker });
  try {
    const { token, intentId } = await credentials(server);
    const started = await postPick(server, { token, intentId, name: '资料库' });
    const settled = await waitSettled(server, String(started.body.requestId), token);
    assert.equal(settled.status, 200);

    const projects = await call(server, '/api/projects');
    const health = await call(server, '/api/health');
    const pickBody = JSON.stringify(settled.body);
    for (const body of [JSON.stringify(projects.body), JSON.stringify(health.body), pickBody]) {
      assert.equal(body.includes(root), false, '不得回传本机绝对路径');
      assert.equal(body.includes('rootToken'), false, '不得回传根身份令牌');
      assert.equal(body.includes('providerId'), false, '不得回传 providerId');
      assert.equal(body.includes('canonicalRoot'), false);
      assert.equal(body.includes('grantSource'), false);
    }
    // Summary 只保留可展示字段
    const list = projects.body.projects as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(list[0]).sort(), ['name', 'projectId', 'status']);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* S-15 Legacy / 静态 Multi 调变更端点                                  */
/* ------------------------------------------------------------------ */

test('S-15 Legacy 与静态 Multi 的变更端点 501，且既有行为不变', async () => {
  const legacyRoot = await newRoot('ws-03-s15-legacy-');
  const legacy = await createShellServer({ rootDir: legacyRoot, port: 0 });
  try {
    const pick = await call(legacy, '/api/projects/pick', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: legacy.url },
      body: JSON.stringify({}),
    });
    assert.equal(pick.status, 501);
    assert.equal(pick.body.errorCode, 'ERR_COMMAND_UNSUPPORTED');

    const remove = await call(legacy, '/api/projects/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: legacy.url },
      body: JSON.stringify({ projectId: 'x' }),
    });
    assert.equal(remove.status, 501);

    // Legacy 的项目列表仍然 404（与改动前一致）
    const projects = await call(legacy, '/api/projects');
    assert.equal(projects.status, 404);
    assert.equal((await call(legacy, '/api/health')).body.workspaceMode, 'legacy');
  } finally {
    await legacy.close();
    await rm(legacyRoot, { recursive: true, force: true });
  }

  const staticRoot = await newRoot('ws-03-s15-static-');
  const workspaceFile = join(await newDir('ws-03-s15-ws-'), 'workspace.json');
  await writeFile(
    workspaceFile,
    JSON.stringify({
      version: 1,
      projects: [{ projectId: 'project-a', name: '项目 A', rootDir: staticRoot }],
    }),
    'utf8',
  );
  const multi = await createShellServer({ workspacePath: workspaceFile, port: 0 });
  try {
    const pick = await call(multi, '/api/projects/pick', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: multi.url },
      body: JSON.stringify({}),
    });
    assert.equal(pick.status, 501);

    const projects = await call(multi, '/api/projects');
    assert.equal(projects.status, 200);
    assert.deepEqual(
      (projects.body.projects as Array<Record<string, unknown>>).map((p) => p.projectId),
      ['project-a'],
      '静态 Multi 的项目集合不得因新端点变化',
    );
    // 静态 Multi 不提供意图（没有选择器）
    const token = await call(multi, '/api/session-token');
    assert.equal(token.status, 200);
    assert.equal(token.body.intent, undefined);
  } finally {
    await multi.close();
    await rm(staticRoot, { recursive: true, force: true });
    await rm(workspaceFile, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* S-16 添加后立即可读（无需重启）                                      */
/* ------------------------------------------------------------------ */

test('S-16 选择成功后 /api/resources 立即 200 并返回目录树', async () => {
  const dir = await newDir('ws-03-s16-');
  const root = await newRoot('ws-03-s16-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await boot({ dir, picker });
  try {
    const { token, intentId } = await credentials(server);
    const started = await postPick(server, { token, intentId, name: 'Docs' });
    const settled = await waitSettled(server, String(started.body.requestId), token);
    assert.equal(settled.status, 200, `实际 ${settled.status}/${JSON.stringify(settled.body)}`);
    const project = settled.body.project as { projectId: string; status: string };
    assert.equal(project.status, 'READY');
    assert.match(project.projectId, /^[a-z0-9][a-z0-9_-]{0,31}$/);

    const tree = await call(server, `/api/resources?projectId=${project.projectId}`);
    assert.equal(tree.status, 200, `实际 ${tree.status}/${JSON.stringify(tree.body)}`);
    const nodes = tree.body.nodes as Array<{ name?: string; path?: string }>;
    const names = JSON.stringify(nodes);
    assert.ok(names.includes('readme.md'), '必须返回该目录的真实内容');
    assert.ok(names.includes('docs'));

    // 打开文件也立即可用（Provider 已建立）
    const opened = await call(server, '/api/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({ projectId: project.projectId, path: 'docs/guide.md' }),
    });
    assert.equal(opened.status, 200, `实际 ${opened.status}/${JSON.stringify(opened.body)}`);
    assert.equal((opened.body.document as { content: string }).content, '# guide\n');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* S-17 重启后授权仍有效（授权记录含真实根身份）                        */
/* ------------------------------------------------------------------ */

test('S-17 关闭并重启 Host 后，已授权的项目仍然可读（凭据已持久化）', async () => {
  const dir = await newDir('ws-03-s17-');
  const root = await newRoot('ws-03-s17-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const first = await boot({ dir, picker });
  let projectId = '';
  let keyBefore = '';
  try {
    const { token, intentId } = await credentials(first);
    const started = await postPick(first, { token, intentId });
    const settled = await waitSettled(first, String(started.body.requestId), token);
    assert.equal(settled.status, 200);
    projectId = (settled.body.project as { projectId: string }).projectId;
    keyBefore = String((await call(first, '/api/health')).body.workspaceKey);
    assert.ok(keyBefore.length === 64, 'workspaceKey 必须是摘要');
  } finally {
    await first.close();
  }

  const second = await boot({ dir });
  try {
    const list = await call(second, '/api/projects');
    const ids = (list.body.projects as Array<{ projectId: string; status: string }>).map((p) => ({
      projectId: p.projectId,
      status: p.status,
    }));
    assert.deepEqual(ids, [{ projectId, status: 'READY' }], '重启后凭据完整才会 READY');

    const tree = await call(second, `/api/resources?projectId=${projectId}`);
    assert.equal(tree.status, 200, '持久化的 os-dialog 授权必须仍然有效');

    // 根身份未变 → workspaceKey 稳定（可用于恢复记录匹配）
    assert.equal((await call(second, '/api/health')).body.workspaceKey, keyBefore);
  } finally {
    await second.close();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* X-01 启动参数：--workspace-store                                     */
/* ------------------------------------------------------------------ */

test('X-01 --workspace-store 解析为托管模式，且与 --workspace 互斥', () => {
  const managed = parseStartup(['--workspace-store', 'D:/ws-store']);
  assert.equal(managed.mode, 'managed');
  assert.equal(managed.mode === 'managed' ? managed.storeDir : '', 'D:/ws-store');
  assert.equal(managed.port, 5177);

  const inline = parseStartup(['--workspace-store=D:/ws-store', '5188']);
  assert.equal(inline.mode, 'managed');
  assert.equal(inline.mode === 'managed' ? inline.storeDir : '', 'D:/ws-store');
  assert.equal(inline.port, 5188);

  const codeOf = (argv: readonly string[]): StartupArgsErrorCode => {
    try {
      parseStartup(argv);
    } catch (err) {
      assert.ok(err instanceof StartupArgsError);
      return (err as StartupArgsError).code;
    }
    throw new Error('应当抛出 StartupArgsError');
  };

  assert.equal(
    codeOf(['--workspace', 'ws.json', '--workspace-store', 'D:/store']),
    'ERR_STARTUP_MODE_CONFLICT',
    '两套项目权威不得同时存在',
  );
  assert.equal(codeOf(['--workspace-store']), 'ERR_STARTUP_WORKSPACE_STORE_MISSING_VALUE');
  assert.equal(codeOf(['--workspace-store=']), 'ERR_STARTUP_WORKSPACE_STORE_MISSING_VALUE');
  assert.equal(
    codeOf(['--workspace-store', 'D:/s1', '--workspace-store', 'D:/s2']),
    'ERR_STARTUP_MODE_CONFLICT',
  );
  assert.equal(codeOf(['D:/root', '--workspace-store', 'D:/store']), 'ERR_STARTUP_MODE_CONFLICT');
});

/* ------------------------------------------------------------------ */
/* X-02 存储目录单实例锁                                                */
/* ------------------------------------------------------------------ */

test('X-02 同一存储目录的第二个 Host 启动失败（ERR_STORE_LOCKED），第一个不受影响', async () => {
  const dir = await newDir('ws-03-x02-');
  const first = await boot({ dir });
  try {
    await assert.rejects(
      () => boot({ dir }),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_STORE_LOCKED',
      '双实例必须被单实例锁挡住',
    );
    // 第一个仍然可用
    assert.equal((await call(first, '/api/health')).status, 200);
  } finally {
    await first.close();
    // 释放后可以再次启动（锁已收回）
    const again = await boot({ dir });
    await again.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* X-03 选择器返回的路径才是唯一授权来源（项目内相对路径不受影响）      */
/* ------------------------------------------------------------------ */

test('X-03 /api/open 的项目内相对 path 不被 pick 的禁字段规则误伤', async () => {
  const dir = await newDir('ws-03-x03-');
  const root = await newRoot('ws-03-x03-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await boot({ dir, picker });
  try {
    const { token, intentId } = await credentials(server);
    const started = await postPick(server, { token, intentId });
    const settled = await waitSettled(server, String(started.body.requestId), token);
    const projectId = (settled.body.project as { projectId: string }).projectId;

    // 相对 path 属于另一类参数：既要能用，又不得越界
    const ok = await call(server, '/api/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({ projectId, path: 'readme.md' }),
    });
    assert.equal(ok.status, 200);

    const escape = await call(server, '/api/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({ projectId, path: '../outside.md' }),
    });
    assert.equal(escape.status, 400, '相对路径仍然受越界检查约束');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* X-04 授权来源不可由请求伪造                                          */
/* ------------------------------------------------------------------ */

test('X-04 HTTP 无法指定 grantSource：只有选择器成功结果才产生可信授权', async () => {
  const dir = await newDir('ws-03-x04-');
  const root = await newRoot('ws-03-x04-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await boot({ dir, picker });
  try {
    const { token, intentId } = await credentials(server);
    // 夹带 grantSource 直接被拒（不可能"自述为已授权"）
    const spoof = await postPick(server, { token, intentId, extra: { grantSource: 'os-dialog' } });
    assert.equal(spoof.status, 400);

    // 正常路径则确实写出了 os-dialog 来源（重启后仍授权，见 S-17）
    const fresh = await credentials(server);
    const started = await postPick(server, { token: fresh.token, intentId: fresh.intentId });
    const settled = await waitSettled(server, String(started.body.requestId), fresh.token);
    assert.equal(settled.status, 200);
    assert.equal(picker.calls, 1, '被拒绝的伪造请求不得消耗选择器调用');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
