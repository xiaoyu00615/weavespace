/**
 * UX-02B-05-02：项目管理连续操作（Host 侧，真实持久化）。
 *
 * 一条连续操作链：添加 A → 添加 B → 改名 A → 展开多级目录 → 移除 A →
 * 再添加 C → 重启 Host → 重新连接。断言：
 * - projectId 唯一且不复用（A 移除后重新添加同一目录会拿到**新** id）；
 * - 改名只改显示名，磁盘目录名与内容不变；
 * - 重复根 / 嵌套根被拒绝；
 * - 已撤销项目重启后不复活；
 * - 每次结构变化都会换 workspaceKey；
 * - 其它项目的文件内容与 SHA-256 不受影响。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';

const ACK = 'browse-subtree';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function sha(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

interface Ctx {
  url: string;
  token: string;
  get(path: string): Promise<{ status: number; body: any }>;
  post(path: string, body: unknown): Promise<{ status: number; body: any }>;
}

function makeCtx(server: ShellServer, token: string): Ctx {
  const origin = new URL(server.url).origin;
  return {
    url: server.url,
    token,
    get: async (path) => {
      const res = await fetch(`${server.url}${path}`, { headers: { 'x-ws-token': token } });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    post: async (path, body) => {
      const res = await fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ws-token': token, origin },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
  };
}

/** 走真实的 T1/T2/T3 添加流程（picker 是自动化选择器，见测试说明）。 */
async function addVia(ctx: Ctx, name?: string) {
  const bootRes = await fetch(`${ctx.url}/api/session-token`);
  const boot = (await bootRes.json()) as {
    token?: string;
    intent?: { intentId?: string } | null;
  };
  const token = boot.token ?? ctx.token;
  const intentId = boot.intent?.intentId;
  const view: Ctx = { ...ctx, token };
  const start = await view.post('/api/projects/pick', {
    intentId,
    acknowledgeScope: ACK,
    ...(name ? { name } : {}),
  });
  if (start.status !== 202) return { kind: 'start-rejected' as const, ...start };
  const requestId = String(start.body.requestId ?? '');
  for (let i = 0; i < 80; i += 1) {
    const q = await view.get(`/api/projects/pick?requestId=${encodeURIComponent(requestId)}`);
    if (q.body.status === 'PENDING') {
      await sleep(25);
      continue;
    }
    return { kind: q.body.status === 'APPLIED' ? ('applied' as const) : ('rejected' as const), ...q };
  }
  throw new Error('picker 轮询超时');
}

async function listProjects(ctx: Ctx): Promise<Array<{ projectId: string; name: string; status: string }>> {
  const res = await ctx.get('/api/projects');
  return (res.body.projects ?? []) as Array<{ projectId: string; name: string; status: string }>;
}

async function healthKey(ctx: Ctx): Promise<string | null> {
  const res = await ctx.get('/api/health');
  return (res.body.workspaceKey as string | undefined) ?? null;
}

interface Fixture {
  base: string;
  rootA: string;
  rootB: string;
  rootC: string;
  storeDir: string;
}

async function makeFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux05-02-'));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  const rootC = join(base, 'project-c');
  await mkdir(join(rootA, 'docs', 'deep'), { recursive: true });
  await mkdir(join(rootA, 'src'), { recursive: true });
  await mkdir(join(rootB, 'docs'), { recursive: true });
  await mkdir(join(rootC, 'docs'), { recursive: true });
  await writeFile(join(rootA, 'readme.md'), '# A\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'notes.md'), '# A notes\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'deep', 'leaf.txt'), 'a-leaf\n', 'utf8');
  await writeFile(join(rootA, 'src', 'index.js'), 'console.log(1)\n', 'utf8');
  await writeFile(join(rootB, 'readme.md'), '# B\n', 'utf8');
  await writeFile(join(rootB, 'docs', 'notes.md'), '# B notes\n', 'utf8');
  await writeFile(join(rootC, 'readme.md'), '# C\n', 'utf8');
  await writeFile(join(rootC, 'docs', 'notes.md'), '# C notes\n', 'utf8');
  const storeDir = join(base, 'store');
  await mkdir(storeDir, { recursive: true });
  return { base, rootA, rootB, rootC, storeDir };
}

async function startServer(fx: Fixture, picks: string[]): Promise<ShellServer> {
  return createShellServer({
    port: 0,
    managedStore: {
      dir: fx.storeDir,
      picker: createFakePicker(picks.map((absolutePath) => ({ status: 'picked' as const, folder: { absolutePath } }))),
    },
  });
}

async function tokenOf(server: ShellServer): Promise<string> {
  const res = await fetch(`${server.url}/api/session-token`);
  return ((await res.json()) as { token?: string }).token ?? '';
}

test('05-02 连续操作链：添加 / 改名 / 多级展开 / 移除 / 再添加 / 重启', async () => {
  const fx = await makeFixture();
  const before = {
    aNotes: sha(await readFile(join(fx.rootA, 'docs', 'notes.md'), 'utf8')),
    bNotes: sha(await readFile(join(fx.rootB, 'docs', 'notes.md'), 'utf8')),
    cNotes: sha(await readFile(join(fx.rootC, 'docs', 'notes.md'), 'utf8')),
  };

  // 选择器队列与下面的操作顺序严格对应（自动化选择器，非人工弹窗）
  let server = await startServer(fx, [
    fx.rootA, // 1 添加 A
    fx.rootB, // 2 添加 B
    fx.rootA, // 3 重复根（应被拒）
    join(fx.rootB, 'docs'), // 4 嵌套根（应被拒）
    fx.rootC, // 5 添加 C
    fx.rootA, // 6 A 移除后重新添加（必须新 id）
  ]);
  try {
    let ctx = makeCtx(server, await tokenOf(server));

    // --- 1/2. 添加 A、B ---
    const addA = await addVia(ctx, '项目A');
    assert.equal(addA.kind, 'applied', JSON.stringify(addA));
    const addB = await addVia(ctx, '项目B');
    assert.equal(addB.kind, 'applied', JSON.stringify(addB));

    let projects = await listProjects(ctx);
    assert.equal(projects.length, 2);
    const idA = projects.find((p) => p.name === '项目A')?.projectId ?? '';
    const idB = projects.find((p) => p.name === '项目B')?.projectId ?? '';
    assert.ok(idA && idB);
    assert.notEqual(idA, idB, 'projectId 必须唯一');

    const keyAb = await healthKey(ctx);
    assert.ok(keyAb, '两个项目时应给出 workspaceKey');

    // --- 3. 改名 A：只改显示名 ---
    const renamed = await ctx.post('/api/projects/rename', { projectId: idA, name: '项目A-重命名' });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.project?.name, '项目A-重命名');
    assert.equal(renamed.body.project?.projectId, idA, '改名不得换 projectId');
    assert.ok(existsSync(fx.rootA), '磁盘目录名不受显示名影响');
    assert.equal(basename(fx.rootA), 'project-a', '磁盘目录名保持原样');
    assert.equal(await healthKey(ctx), keyAb, '改名不改变项目集合，摘要保持不变');

    // --- 4. 展开多级目录 ---
    const rootA = await ctx.get(`/api/tree?projectId=${encodeURIComponent(idA)}&dir=`);
    assert.equal(rootA.status, 200);
    assert.deepEqual(
      (rootA.body.entries as Array<{ name: string }>).map((e) => e.name).sort(),
      ['docs', 'readme.md', 'src'],
    );
    const docsA = await ctx.get(`/api/tree?projectId=${encodeURIComponent(idA)}&dir=docs`);
    assert.deepEqual(
      (docsA.body.entries as Array<{ name: string }>).map((e) => e.name).sort(),
      ['deep', 'notes.md'],
    );
    const deepA = await ctx.get(`/api/tree?projectId=${encodeURIComponent(idA)}&dir=docs/deep`);
    assert.deepEqual(
      (deepA.body.entries as Array<{ name: string }>).map((e) => e.name),
      ['leaf.txt'],
    );

    // B 的同名相对路径属于另一个项目（各自独立）
    const docsB = await ctx.get(`/api/tree?projectId=${encodeURIComponent(idB)}&dir=docs`);
    assert.deepEqual(
      (docsB.body.entries as Array<{ name: string }>).map((e) => e.name),
      ['notes.md'],
    );

    // --- 5. 重复根 / 嵌套根：都在 A 仍存在时验证 ---
    const dup = await addVia(ctx);
    assert.equal(dup.kind, 'rejected', JSON.stringify(dup));
    assert.equal(dup.body.errorCode, 'ERR_PROJECT_DUPLICATE_ROOT');

    const nested = await addVia(ctx);
    assert.equal(nested.kind, 'rejected', JSON.stringify(nested));
    assert.equal(nested.body.errorCode, 'ERR_PROJECT_NESTED_ROOT');

    // 被拒的两次不得改变项目集合
    assert.equal((await listProjects(ctx)).length, 2);
    assert.equal(await healthKey(ctx), keyAb, '被拒的添加不得改变摘要');

    // --- 6. 移除 A ---
    const removeA = await ctx.post('/api/projects/remove', {
      projectId: idA,
      confirm: 'remove-from-workspace',
      opId: 'op-0502-remove-a',
    });
    assert.equal(removeA.status, 200, JSON.stringify(removeA.body));
    assert.equal(removeA.body.outcome, 'revoked');

    projects = await listProjects(ctx);
    assert.deepEqual(projects.map((p) => p.projectId), [idB], '只剩 B');

    // --- 7. B 的文件树与内容不受影响 ---
    const treeB = await ctx.get(`/api/tree?projectId=${encodeURIComponent(idB)}&dir=`);
    assert.equal(treeB.status, 200, 'B 的树仍可读');
    const keyOnlyB = await healthKey(ctx);
    assert.ok(keyOnlyB && keyOnlyB !== keyAb, '项目集合变化后摘要必须换');

    // --- 8. 再添加 C ---
    const addC = await addVia(ctx, '项目C');
    assert.equal(addC.kind, 'applied', JSON.stringify(addC));
    projects = await listProjects(ctx);
    assert.equal(projects.length, 2);
    const idC = projects.find((p) => p.name === '项目C')?.projectId ?? '';
    assert.ok(idC && idC !== idA && idC !== idB, 'C 是新 id');
    const keyBc = await healthKey(ctx);
    assert.ok(keyBc && keyBc !== keyOnlyB, '再加一个项目摘要必须换');

    // --- 9. A 移除后重新添加同一目录：必须是新 projectId ---
    const readdA = await addVia(ctx, '项目A2');
    assert.equal(readdA.kind, 'applied', JSON.stringify(readdA));
    const idA2 = String(readdA.body.project?.projectId ?? '');
    assert.ok(idA2 && idA2 !== idA, '已撤销项目的 id 不得复用');
    projects = await listProjects(ctx);
    assert.deepEqual(
      projects.map((p) => p.projectId).sort(),
      [idB, idC, idA2].sort(),
    );

    // --- 10. 重启 Host：撤销不复活，id 与摘要稳定 ---
    const keyBeforeRestart = await healthKey(ctx);
    await server.close();
    server = await startServer(fx, []);
    ctx = makeCtx(server, await tokenOf(server));

    projects = await listProjects(ctx);
    assert.deepEqual(
      projects.map((p) => p.projectId).sort(),
      [idB, idC, idA2].sort(),
      '重启后项目集合与 id 必须一致（A 不复活）',
    );
    assert.equal(await healthKey(ctx), keyBeforeRestart, '同一集合的摘要在重启后必须一致');

    // --- 11. 磁盘字节一致性（重命名、移除、重启都不碰文件） ---
    assert.equal(sha(await readFile(join(fx.rootA, 'docs', 'notes.md'), 'utf8')), before.aNotes);
    assert.equal(sha(await readFile(join(fx.rootB, 'docs', 'notes.md'), 'utf8')), before.bNotes);
    assert.equal(sha(await readFile(join(fx.rootC, 'docs', 'notes.md'), 'utf8')), before.cNotes);
    assert.ok(existsSync(join(fx.rootA, 'docs', 'deep', 'leaf.txt')));
  } finally {
    await server.close();
    await rm(fx.base, { recursive: true, force: true });
  }
});
