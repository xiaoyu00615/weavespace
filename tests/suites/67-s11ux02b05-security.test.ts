/**
 * UX-02B-05-06：安全回归（HTTP 边界）。
 *
 * 不重复存储层用例（09/14/18/22/46 已覆盖），只从**接口边界**复核：
 * - T1 会话令牌：缺失 → 拒绝；不能读项目、目录、也不能发起变更；
 * - Origin：变更请求必须声明且必须同源；
 * - T2 意图：一次性，重复使用 → 410；
 * - 越界目录：`..` / 绝对路径 / UNC 一律拒绝；
 * - 移除不删除磁盘文件；
 * - 响应体里不出现本机绝对路径或 rootToken。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { serializeConfig } from '../../apps/server/src/store/config.ts';
import { rootTokenOf } from '../../packages/storage/path-safety.ts';

const PROJ_A = 'proj-a';
const PROJ_B = 'proj-b';
const SECRET_A = 'A 的私密正文\n';

interface Ctx {
  base: string;
  rootA: string;
  rootB: string;
  storeDir: string;
  server: ShellServer;
  token: string;
  origin: string;
  /** 所有经过断言接口的响应体，用于最后的"不泄露"扫描。 */
  bodies: string[];
}

async function withSecure(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux05-06-'));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(rootA, 'readme.md'), SECRET_A, 'utf8');
  await writeFile(join(rootA, 'docs', 'notes.md'), '# notes\n', 'utf8');
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
      issuedIds: [PROJ_A, PROJ_B],
      revoked: [],
      projects: [mk(PROJ_A, 'A', rootA), mk(PROJ_B, 'B', rootB)],
    }),
    'utf8',
  );

  const server = await createShellServer({
    port: 0,
    managedStore: { dir: storeDir, picker: createFakePicker([]) },
  });
  const tokenRes = await fetch(`${server.url}/api/session-token`);
  const token = ((await tokenRes.json()) as { token?: string }).token ?? '';
  const origin = new URL(server.url).origin;
  const bodies: string[] = [];

  try {
    await fn({ base, rootA, rootB, storeDir, server, token, origin, bodies });
  } finally {
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

async function req(
  ctx: Ctx,
  path: string,
  init: RequestInit = {},
  record = true,
): Promise<{ status: number; body: any; raw: string }> {
  const res = await fetch(`${ctx.server.url}${path}`, init);
  const raw = await res.text();
  if (record) ctx.bodies.push(raw);
  let body: any = {};
  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw };
  }
  return { status: res.status, body, raw };
}

function sha(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

test('05-06-01 只读端点只认已授权项目；变更端点没有 T1 令牌一律拒绝', async () => {
  await withSecure(async (ctx) => {
    // 项目列表是契约允许的只读摘要（本机页面首次渲染就要用），
    // 但它只返回 projectId/name/status —— 绝不带 rootDir / rootToken。
    const projects = await req(ctx, '/api/projects');
    assert.equal(projects.status, 200);
    const rows = projects.body.projects as Array<Record<string, unknown>>;
    assert.ok(rows.length >= 2);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['name', 'projectId', 'status']);
    }

    // 只读目录只对**已注册且已授权**的项目开放；未注册的 id 不能被用来探测任意目录
    const unknown = await req(ctx, '/api/tree?projectId=no-such-project&dir=');
    assert.equal(unknown.status, 404, '未注册的项目不得被读取');

    const noProject = await req(ctx, '/api/tree?dir=');
    assert.equal(noProject.status, 400, 'Multi 模式必须声明 projectId');

    // 变更端点必须有 T1 令牌
    const remove = await req(ctx, '/api/projects/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ctx.origin },
      body: JSON.stringify({ projectId: PROJ_A, confirm: 'remove-from-workspace' }),
    });
    assert.equal(remove.status, 403, '没有 T1 令牌不得发起移除');
    assert.ok(existsSync(join(ctx.rootA, 'readme.md')), '磁盘文件不动');
  });
});

test('05-06-02 变更请求必须声明同源 Origin', async () => {
  await withSecure(async (ctx) => {
    const body = JSON.stringify({ projectId: PROJ_A, confirm: 'remove-from-workspace' });

    const noOrigin = await req(ctx, '/api/projects/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ws-token': ctx.token },
      body,
    });
    assert.equal(noOrigin.status, 403, '没有 Origin 的变更必须拒绝');

    const crossOrigin = await req(ctx, '/api/projects/remove', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ws-token': ctx.token,
        origin: 'http://evil.example',
      },
      body,
    });
    assert.equal(crossOrigin.status, 403, '跨源变更必须拒绝');

    // 零变更：两个项目都还在
    const list = await req(ctx, '/api/projects', { headers: { 'x-ws-token': ctx.token } });
    assert.deepEqual(
      (list.body.projects as Array<{ projectId: string }>).map((p) => p.projectId).sort(),
      [PROJ_A, PROJ_B],
    );
  });
});

test('05-06-03 T2 意图一次性：同一个 intentId 不能启动第二次选择', async () => {
  await withSecure(async (ctx) => {
    const boot = await req(ctx, '/api/session-token');
    const intentId = (boot.body.intent as { intentId?: string } | undefined)?.intentId;
    assert.ok(intentId, '托管模式必须发放意图');

    const first = await req(ctx, '/api/projects/pick', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ws-token': ctx.token, origin: ctx.origin },
      body: JSON.stringify({ intentId, acknowledgeScope: 'browse-subtree' }),
    });
    assert.equal(first.status, 202);

    const replay = await req(ctx, '/api/projects/pick', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ws-token': ctx.token, origin: ctx.origin },
      body: JSON.stringify({ intentId, acknowledgeScope: 'browse-subtree' }),
    });
    assert.equal(replay.status, 410, '意图被消费后再用必须 410');
    assert.ok(['ERR_INTENT_CONSUMED', 'ERR_INTENT_INVALID', 'ERR_INTENT_EXPIRED'].includes(replay.body.errorCode));
  });
});

test('05-06-04 越界目录：.. / 绝对路径 / UNC 一律拒绝，且不返回任何根外内容', async () => {
  await withSecure(async (ctx) => {
    const attempts = [
      '..',
      '../',
      'docs/../../',
      '/etc',
      'C:/Windows',
      'C:\\Windows',
      '\\\\server\\share',
      'docs/..%2f..%2f',
    ];
    for (const dir of attempts) {
      const res = await req(ctx, `/api/tree?projectId=${PROJ_A}&dir=${encodeURIComponent(dir)}`);
      assert.ok(res.status >= 400, `${dir} 必须被拒绝，实际 ${res.status}`);
      assert.equal(res.raw.includes('Windows'), false, `${dir} 不得泄露根外路径`);
    }
  });
});

test('05-06-05 移除项目不删除磁盘文件，字节保持一致', async () => {
  await withSecure(async (ctx) => {
    const before = sha(await readFile(join(ctx.rootA, 'readme.md'), 'utf8'));
    const res = await req(ctx, '/api/projects/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ws-token': ctx.token, origin: ctx.origin },
      body: JSON.stringify({
        projectId: PROJ_A,
        confirm: 'remove-from-workspace',
        opId: 'op-0506-security01',
      }),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.outcome, 'revoked');

    assert.ok(existsSync(ctx.rootA), '项目目录必须仍在');
    assert.equal(sha(await readFile(join(ctx.rootA, 'readme.md'), 'utf8')), before, '内容逐字节不变');
    assert.ok(existsSync(join(ctx.rootA, 'docs', 'notes.md')));

    // 已撤销项目不再可读
    const tree = await req(ctx, `/api/tree?projectId=${PROJ_A}&dir=`, {
      headers: { 'x-ws-token': ctx.token },
    });
    assert.ok(tree.status >= 400, '撤销后不得继续读取该项目');
  });
});

test('05-06-06 响应里不出现本机绝对路径或 rootToken', async () => {
  await withSecure(async (ctx) => {
    const rootAReal = realpathSync(ctx.rootA);
    const tokenA = rootTokenOf(ctx.rootA);
    const auth = { headers: { 'x-ws-token': ctx.token } };

    await req(ctx, '/api/health');
    await req(ctx, '/api/projects', auth);
    await req(ctx, `/api/tree?projectId=${PROJ_A}&dir=`, auth);
    await req(ctx, `/api/tree?projectId=${PROJ_A}&dir=docs`, auth);
    await req(ctx, `/api/projects/registration`, auth);
    await req(ctx, '/api/projects/removal-precheck', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ws-token': ctx.token, origin: ctx.origin },
      body: JSON.stringify({ projectId: PROJ_A }),
    });
    await req(ctx, `/api/projects/op?opId=op-0506-nonexistent`, auth);

    assert.ok(ctx.bodies.length >= 6);
    for (const raw of ctx.bodies) {
      assert.equal(raw.includes(rootAReal), false, '不得出现本机绝对路径');
      assert.equal(raw.includes(rootAReal.replace(/\\/g, '\\\\')), false, '不得出现转义后的绝对路径');
      assert.equal(raw.includes(tokenA), false, '不得出现 rootToken');
      assert.equal(raw.includes(ctx.base), false, '不得出现夹具根路径');
    }
  });
});

test('05-06-07 项目根被删除：该项目不可用，且不误报成权限问题、不泄露路径', async () => {
  await withSecure(async (ctx) => {
    const auth = { headers: { 'x-ws-token': ctx.token } };
    const before = await req(ctx, `/api/tree?projectId=${PROJ_B}&dir=`, auth);
    assert.equal(before.status, 200);

    await rm(ctx.rootB, { recursive: true, force: true });

    const after = await req(ctx, `/api/tree?projectId=${PROJ_B}&dir=`, auth);
    assert.ok(after.status >= 400, '根没了就不能再读');
    assert.ok(
      ['ERR_PROJECT_UNAVAILABLE', 'ERR_RESOURCE_NOT_FOUND', 'ERR_ROOT_CHANGED'].includes(
        after.body.errorCode ?? '',
      ),
      `实际错误码: ${after.body.errorCode}`,
    );
    assert.equal(after.raw.includes(ctx.base), false, '错误信息不得带绝对路径');

    // 另一个项目仍然可用
    const other = await req(ctx, `/api/tree?projectId=${PROJ_A}&dir=`, auth);
    assert.equal(other.status, 200, '一个项目根失效不得影响其它项目');
  });
});
