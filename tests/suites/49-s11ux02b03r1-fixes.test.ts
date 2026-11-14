/**
 * S11-UX-02B-03-R1：定点复审修复的聚焦测试。
 *
 * 三处修复各有独立证据：
 * - R1（stdin 超时）：`PickOptions.timeoutMs` 必须真正生效，超时后不再占用单飞、
 *   迟到输入不得注册项目、读行资源必须关闭（不留输入监听器）。
 * - R2（监听失败）：`createShellServer()` 在 listen 失败时必须释放本次创建的
 *   存储锁，否则同进程"换端口重试"会被自己的锁挡住。
 * - R3（HTTP 语义）：`ERR_COMMAND_INVALID` 是客户端输入错误 → 400，
 *   不是 500/422；且必须零副作用、不回传本机路径、不影响其他错误码。
 *
 * 时钟与输入全部可控（注入 setTimer/clearTimer/readLine/createInterface），
 * 因此超时用例是确定性的，不依赖真实等待。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import {
  createStdinFolderPicker,
  type ReadlineLike,
} from '../../apps/server/src/folder-picker/stdin-prompt.ts';
import { createFileProjectStore } from '../../apps/server/src/store/file-store.ts';
import type { FolderPicker } from '../../apps/server/src/folder-picker/types.ts';

/* ------------------------------- 夹具 ------------------------------- */

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
}

async function credentials(server: ShellServer): Promise<Credentials> {
  const res = await call(server, '/api/session-token');
  assert.equal(res.status, 200, `session-token 失败: ${JSON.stringify(res.body)}`);
  const intent = res.body.intent as { intentId: string } | undefined;
  assert.ok(intent?.intentId, '托管模式必须同时发放一次性意图');
  return { token: String(res.body.token), intentId: intent.intentId };
}

async function postPick(
  server: ShellServer,
  options: { token: string; intentId: string; name?: string },
): Promise<ApiResponse> {
  return call(server, '/api/projects/pick', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ws-token': options.token,
      origin: server.url,
    },
    body: JSON.stringify({
      intentId: options.intentId,
      ...(options.name !== undefined ? { name: options.name } : {}),
    }),
  });
}

async function getPick(server: ShellServer, requestId: string, token: string): Promise<ApiResponse> {
  return call(server, `/api/projects/pick?requestId=${encodeURIComponent(requestId)}`, {
    headers: { 'x-ws-token': token },
  });
}

async function waitSettled(server: ShellServer, requestId: string, token: string): Promise<ApiResponse> {
  let last: ApiResponse = await getPick(server, requestId, token);
  for (let i = 0; i < 200 && last.body.status === 'PENDING'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    last = await getPick(server, requestId, token);
  }
  return last;
}

/**
 * 给"可能永远不落定"的 promise 加一个**真实**截止时间。
 *
 * 基线（未修复）会让 pick() 永远等输入；没有这个截止时间，测试进程只是挂住、
 * 不会变红——红测必须"失败"而不是"卡住"。
 */
async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: 超过 ${ms}ms 仍未落定（超时未被处理）`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 可注入时钟：手动触发超时，不做任何真实等待。 */
interface ManualClock {
  readonly setTimer: (handler: () => void, timeoutMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  fire(): void;
  readonly lastDelay: number;
  readonly cleared: number;
}

function manualClock(): ManualClock {
  let handler: (() => void) | undefined;
  let delay = -1;
  let cleared = 0;
  return {
    setTimer: (fn, ms) => {
      handler = fn;
      delay = ms;
      return Symbol('timer');
    },
    clearTimer: () => {
      cleared += 1;
    },
    fire: () => {
      const fn = handler;
      handler = undefined;
      assert.ok(fn, '超时定时器尚未注册：pick() 可能忽略了 timeoutMs');
      fn();
    },
    get lastDelay() {
      return delay;
    },
    get cleared() {
      return cleared;
    },
  };
}

async function newDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function newRoot(prefix: string): Promise<string> {
  const dir = await newDir(prefix);
  await writeFile(join(dir, 'readme.md'), '# hello\n', 'utf8');
  await mkdir(join(dir, 'docs'), { recursive: true });
  return dir;
}

/** 读取 Store 的配置，用来断言"零写入"（不是只看接口返回）。 */
async function storedProjectIds(dir: string): Promise<string[]> {
  const raw = await readFile(join(dir, 'workspace.json'), 'utf8');
  const config = JSON.parse(raw) as { projects?: Array<{ projectId: string }> };
  return (config.projects ?? []).map((p) => p.projectId);
}

/**
 * 把本机路径转成"在 JSON 文本里出现时的形态"。
 *
 * 直接 `text.includes(root)` 在 Windows 上永远为 false —— JSON 会把 `\` 转义成 `\\`，
 * 这样的断言是假绿。必须比对转义后的字符串。
 */
function jsonEscaped(path: string): string {
  return JSON.stringify(path).slice(1, -1);
}

/* ================================================================== */
/* R1 · stdin 选择器超时                                               */
/* ================================================================== */

test('R1-01 stdin 超时不等待输入：返回 timeout，且传入的 timeoutMs 被真正使用', async () => {
  const clock = manualClock();
  let received: AbortSignal | undefined;
  const picker = createStdinFolderPicker({
    isTTY: true,
    // 永不落定：模拟"用户在终端里走开了"
    readLine: (_prompt, signal) => {
      received = signal;
      return new Promise<string | null>(() => {});
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  const pending = picker.pick({ timeoutMs: 750 });
  clock.fire();
  const outcome = await withDeadline(pending, 2_000, 'R1-01');

  assert.equal(outcome.status, 'timeout', `超时必须是 timeout，实际 ${outcome.status}`);
  assert.equal(clock.lastDelay, 750, '必须使用调用方给的 timeoutMs');
  assert.equal(clock.cleared, 1, '定时器必须被清理，不能留下悬挂回调');
  assert.equal(received?.aborted, true, '超时后必须 abort，让读行实现释放输入资源');
});

test('R1-02 超时后迟到输入不再产生结果（迟到的 reply 被丢弃）', async () => {
  const clock = manualClock();
  let lateResolve: ((value: string | null) => void) | undefined;
  const picker = createStdinFolderPicker({
    isTTY: true,
    readLine: (_prompt, signal) =>
      new Promise<string | null>((resolve) => {
        lateResolve = resolve;
        signal.addEventListener('abort', () => resolve(null), { once: true });
      }),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  const pending = picker.pick({ timeoutMs: 50 });
  clock.fire();
  const outcome = await withDeadline(pending, 2_000, 'R1-02');
  assert.equal(outcome.status, 'timeout');

  // 迟到的输入：此时选择器早已落定为 timeout
  lateResolve?.('C:\\迟到的目录');
  await new Promise((resolve) => setImmediate(resolve));

  // promise 已结算，值不会改变（若实现"等迟到输入"就会变成 picked）
  const same = await pending;
  assert.equal(same.status, 'timeout', '迟到输入不得把结果改成 picked');
});

test('R1-03 超时后关闭 readline（移除输入监听器），不遗留句柄', async () => {
  const clock = manualClock();
  let closeCalls = 0;
  let rejectQuestion: ((err: Error) => void) | undefined;
  let created = 0;

  const fakeRl: ReadlineLike = {
    question: () =>
      new Promise<string>((_resolve, reject) => {
        rejectQuestion = reject;
      }),
    close: () => {
      closeCalls += 1;
      // 真实 readline 在 close 时会让挂起的 question 失败
      rejectQuestion?.(new Error('closed'));
    },
  };

  const picker = createStdinFolderPicker({
    isTTY: true,
    createInterface: async () => {
      created += 1;
      return fakeRl;
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  const pending = picker.pick({ timeoutMs: 30 });
  await new Promise((resolve) => setImmediate(resolve)); // 让工厂完成
  assert.equal(created, 1, '必须走注入的 readline 工厂');
  clock.fire();
  const outcome = await withDeadline(pending, 2_000, 'R1-03');

  assert.equal(outcome.status, 'timeout');
  assert.ok(closeCalls >= 1, `超时后必须关闭 readline（实际 close ${closeCalls} 次）`);
});

test('R1-04 超时在 HTTP 层：501 + 单飞释放 + 迟到输入不注册项目', async () => {
  const dir = await newDir('ws-r1-04-');
  const root = await newRoot('ws-r1-04-root-');
  const clock = manualClock();
  let lateResolve: ((value: string | null) => void) | undefined;

  const picker: FolderPicker = createStdinFolderPicker({
    isTTY: true,
    readLine: (_prompt, signal) =>
      new Promise<string | null>((resolve) => {
        lateResolve = resolve;
        signal.addEventListener('abort', () => resolve(null), { once: true });
      }),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  const server = await createShellServer({
    port: 0,
    managedStore: { dir, picker, pickerTimeoutMs: 100 },
  });
  try {
    const first = await credentials(server);
    const started = await postPick(server, { token: first.token, intentId: first.intentId });
    assert.equal(started.status, 202);
    const requestId = String(started.body.requestId);

    assert.equal((await getPick(server, requestId, first.token)).body.status, 'PENDING');
    clock.fire();
    const settled = await withDeadline(
      waitSettled(server, requestId, first.token),
      3_000,
      'R1-04 settle',
    );
    assert.equal(settled.body.status, 'REJECTED');
    assert.equal(settled.status, 501, `超时应映射为 501，实际 ${settled.status}`);
    assert.equal(settled.body.errorCode, 'ERR_PICKER_UNAVAILABLE');
    assert.equal(settled.body.reason, 'timeout');

    // 迟到输入：不得注册项目
    lateResolve?.(root);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const projects = await call(server, '/api/projects');
    assert.deepEqual(projects.body.projects, [], '超时后的迟到输入不得产生项目');
    assert.deepEqual(await storedProjectIds(dir), [], '不得写入配置');

    // 单飞已释放：第二次请求不应被 409 挡住
    const second = await credentials(server);
    const again = await postPick(server, { token: second.token, intentId: second.intentId });
    assert.equal(again.status, 202, `超时后单飞状态必须释放: ${JSON.stringify(again.body)}`);
    clock.fire();
    await waitSettled(server, String(again.body.requestId), second.token);
  } finally {
    await server.close();
  }
});

/* ================================================================== */
/* R2 · 监听失败后的锁清理                                             */
/* ================================================================== */

test('R2-01 端口被占用 → 托管 Host 启动失败，但同进程内 Store 能重新打开', async () => {
  const dir = await newDir('ws-r2-01-');

  const blocker: Server = createServer((_req, res) => res.end());
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', () => resolve());
  });
  const occupied = (blocker.address() as AddressInfo).port;

  try {
    await assert.rejects(
      () => createShellServer({ port: occupied, managedStore: { dir } }),
      (err: unknown) => (err as { code?: string }).code === 'EADDRINUSE',
      '占用端口必须让启动失败（EADDRINUSE）',
    );

    // 失败的那次启动不得留下锁：同进程内必须能立刻重新打开
    const reopened = createFileProjectStore({ dir });
    reopened.close();

    // 也不得删除任何持久化文件
    const files = await readdir(dir);
    assert.ok(files.includes('workspace.json'), `配置必须保留: ${files.join(',')}`);
    assert.equal(files.includes('workspace.lock'), false, '失败启动必须释放锁文件');

    // 不影响占用端口的其他服务
    assert.equal(blocker.listening, true, '失败启动不得关掉别人的监听');
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test('R2-02 监听失败后可以换端口正常启动，并保留原有项目', async () => {
  const dir = await newDir('ws-r2-02-');
  const root = await newRoot('ws-r2-02-root-');

  // 先正常起一次并加一个项目，证明存储里有内容
  const first = await createShellServer({
    port: 0,
    managedStore: { dir, picker: createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]) },
  });
  try {
    const cred = await credentials(first);
    const started = await postPick(first, { token: cred.token, intentId: cred.intentId, name: 'keepme' });
    assert.equal(started.status, 202);
    const settled = await waitSettled(first, String(started.body.requestId), cred.token);
    assert.equal(settled.body.status, 'APPLIED', JSON.stringify(settled.body));
  } finally {
    await first.close();
  }

  // 占一个端口，让下一次启动失败
  const blocker: Server = createServer((_req, res) => res.end());
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', () => resolve());
  });
  const occupied = (blocker.address() as AddressInfo).port;
  try {
    await assert.rejects(
      () => createShellServer({ port: occupied, managedStore: { dir } }),
      (err: unknown) => (err as { code?: string }).code === 'EADDRINUSE',
    );
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }

  // 换端口重试：必须成功，且项目还在
  const retried = await createShellServer({ port: 0, managedStore: { dir } });
  try {
    const projects = await call(retried, '/api/projects');
    const list = projects.body.projects as Array<{ name: string; status: string }>;
    assert.equal(list.length, 1, `失败启动后重试必须恢复原项目: ${JSON.stringify(projects.body)}`);
    assert.equal(list[0].name, 'keepme');
    assert.equal(list[0].status, 'READY');
  } finally {
    await retried.close();
  }
});

/* ================================================================== */
/* R3 · ERR_COMMAND_INVALID → 400                                      */
/* ================================================================== */

test('R3-01 项目名过长 → 400 ERR_COMMAND_INVALID，且零副作用', async () => {
  const dir = await newDir('ws-r3-01-');
  const root = await newRoot('ws-r3-01-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await createShellServer({ port: 0, managedStore: { dir, picker } });
  try {
    const cred = await credentials(server);
    const started = await postPick(server, {
      token: cred.token,
      intentId: cred.intentId,
      name: 'x'.repeat(65),
    });
    assert.equal(started.status, 202);
    const settled = await waitSettled(server, String(started.body.requestId), cred.token);

    assert.equal(settled.status, 400, `输入不合法必须是 400，实际 ${settled.status}`);
    assert.equal(settled.body.errorCode, 'ERR_COMMAND_INVALID');
    assert.equal(settled.body.status, 'REJECTED');

    // 零副作用：没有项目、没有配置写入、没有 grant
    const projects = await call(server, '/api/projects');
    assert.deepEqual(projects.body.projects, []);
    assert.deepEqual(await storedProjectIds(dir), [], '不得写入配置');

    // 没有路径泄漏（响应是 JSON，反斜杠被转义，所以要按"转义后"的形态比对）
    const text = JSON.stringify(settled.body);
    assert.equal(text.includes(jsonEscaped(root)), false, `响应不得包含本机路径: ${text}`);
  } finally {
    await server.close();
  }
});

test('R3-02 项目名含控制字符 → 400，且选择器只被调用一次', async () => {
  const dir = await newDir('ws-r3-02-');
  const root = await newRoot('ws-r3-02-root-');
  const picker = createFakePicker([{ status: 'picked', folder: { absolutePath: root } }]);
  const server = await createShellServer({ port: 0, managedStore: { dir, picker } });
  try {
    const cred = await credentials(server);
    const started = await postPick(server, {
      token: cred.token,
      intentId: cred.intentId,
      name: 'bad\u0001name',
    });
    const settled = await waitSettled(server, String(started.body.requestId), cred.token);

    assert.equal(settled.status, 400);
    assert.equal(settled.body.errorCode, 'ERR_COMMAND_INVALID');
    assert.equal(picker.calls, 1, '选择器只应被调用一次（不重试、不轮询）');
    assert.deepEqual(await storedProjectIds(dir), []);
    assert.equal(JSON.stringify(settled.body).includes(jsonEscaped(root)), false);
  } finally {
    await server.close();
  }
});

test('R3-03 同名错误码在两条映射路径上一致：422 只留给"无法处理"，其他码不变', async () => {
  const dir = await newDir('ws-r3-03-');
  const outer = await newRoot('ws-r3-03-outer-');
  const nested = join(outer, 'inner');
  await mkdir(nested, { recursive: true });

  const picker = createFakePicker([
    { status: 'picked', folder: { absolutePath: outer } },
    { status: 'picked', folder: { absolutePath: nested } },
  ]);
  const server = await createShellServer({ port: 0, managedStore: { dir, picker } });
  try {
    // 第一个成功
    const a = await credentials(server);
    const firstStart = await postPick(server, { token: a.token, intentId: a.intentId, name: 'outer' });
    const firstSettled = await waitSettled(server, String(firstStart.body.requestId), a.token);
    assert.equal(firstSettled.body.status, 'APPLIED', JSON.stringify(firstSettled.body));

    // 嵌套根仍是 422（不得被本次修改带成 400/500）
    const b = await credentials(server);
    const secondStart = await postPick(server, { token: b.token, intentId: b.intentId, name: 'inner' });
    const secondSettled = await waitSettled(server, String(secondStart.body.requestId), b.token);
    assert.equal(secondSettled.status, 422, `嵌套根必须仍是 422，实际 ${secondSettled.status}`);
    assert.equal(secondSettled.body.errorCode, 'ERR_PROJECT_NESTED_ROOT');

    // 意图类仍是 410
    const reused = await postPick(server, { token: b.token, intentId: b.intentId, name: 'again' });
    assert.equal(reused.status, 410, '已消费意图必须仍是 410');

    // 缺 intentId 仍是 400（不是 500）
    const c = await credentials(server);
    const missing = await call(server, '/api/projects/pick', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ws-token': c.token, origin: server.url },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);
  } finally {
    await server.close();
  }
});
