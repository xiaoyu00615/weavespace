/**
 * UX-02B-04B：移除项目 Host API（removal-precheck / remove / op）与安全验收。
 *
 * 取证方式：真实 `FileProjectStore`（托管模式）+ 真实 DocumentService/Permission，
 * 断言同时看「HTTP 状态 + 响应体 + 真实磁盘字节 + 重启后列表」。
 * 覆盖 docs/26 PB-01…PB-09 中可在 Host 侧证明的部分，以及 ADR-022/023 的撤销语义。
 *
 * 先红后绿：在实现前，三个端点分别是 501 —— 本套件的 PB-01/04/05/06 会因此变红；
 * 实现后才转绿（`remove` 的确认字段、只读前检、op 证据匹配、磁盘字节不变、重启不复活）。
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { serializeConfig } from '../../apps/server/src/store/config.ts';
import { rootTokenOf } from '../../packages/storage/path-safety.ts';

interface ApiResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

interface RemovalCtx {
  base: string;
  storeDir: string;
  rootA: string;
  rootB: string;
  server: ShellServer;
  token: string;
  api(path: string, init?: RequestInit): Promise<ApiResponse>;
  post(path: string, body: unknown, opts?: { token?: boolean; origin?: boolean }): Promise<ApiResponse>;
  get(path: string, opts?: { token?: boolean }): Promise<ApiResponse>;
}

const PROJ_A = 'proj-a';
const PROJ_B = 'proj-b';

function sha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function makeStore(
  base: string,
  rootA: string,
  rootB: string,
  /** R1-02：让某个项目带上"添加事务"的 opId（`createdByOp`），用于跨事务复用测试。 */
  opts: { createdByOp?: string } = {},
): Promise<string> {
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
    ...(projectId === PROJ_B && opts.createdByOp ? { createdByOp: opts.createdByOp } : {}),
  });
  const file = serializeConfig({
    version: 2,
    // 冷启动：commitSeq=0 且无撤销 → 日志缺失视为"尚未发生变更"，正常可写
    commitSeq: 0,
    issuedIds: [PROJ_A, PROJ_B],
    revoked: [],
    projects: [mk(PROJ_A, '项目A', rootA), mk(PROJ_B, '项目B', rootB)],
  });
  await writeFile(join(storeDir, 'workspace.json'), file, 'utf8');
  return storeDir;
}

async function withRemoval(
  fn: (ctx: RemovalCtx) => Promise<void>,
  opts: { createdByOp?: string } = {},
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux04b-'));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(rootA, 'readme.md'), '# A readme\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'guide.md'), '# guide\n', 'utf8');
  await writeFile(join(rootB, 'readme.md'), '# B readme\n', 'utf8');

  const storeDir = await makeStore(base, rootA, rootB, opts);
  let server = await createShellServer({
    port: 0,
    managedStore: { dir: storeDir, picker: createFakePicker([{ status: 'cancelled' }]) },
  });
  const url = (): string => server.url;
  const api = async (path: string, init?: RequestInit): Promise<ApiResponse> => {
    const res = await fetch(`${url()}${path}`, init);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  };
  const getToken = async (): Promise<string> => {
    const res = await api('/api/session-token');
    return (res.body as { token?: string }).token ?? '';
  };
  let token = await getToken();
  const get = (path: string, opts: { token?: boolean } = {}): Promise<ApiResponse> =>
    api(path, { headers: opts.token === false ? {} : { 'x-ws-token': token } });
  const post = (
    path: string,
    body: unknown,
    opts: { token?: boolean; origin?: boolean } = {},
  ): Promise<ApiResponse> =>
    api(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.token === false ? {} : { 'x-ws-token': token }),
        // 必须与 Host 实际 origin 一致（服务端按 Host 头收紧来源）
        ...(opts.origin === false ? {} : { origin: new URL(server.url).origin }),
      },
      body: JSON.stringify(body),
    });

  try {
    await fn({ base, storeDir, rootA, rootB, server, token, api, post, get });
  } finally {
    // 先关服务（释放 store 锁与监听），再删临时目录；顺序反了会留下打开的文件句柄
    try {
      await server.close();
    } catch {
      /* 已关闭（例如 PB-07 中途重启过）*/
    }
    await rm(base, { recursive: true, force: true });
  }
}

/* ------------------------------ PB-05 / 校验 ------------------------------ */

test('PB-05 缺 confirm → 400 且零变更（项目仍在、字节不变）', async () => {
  await withRemoval(async (h) => {
    const before = sha(await readFile(join(h.rootA, 'readme.md')));
    const res = await h.post('/api/projects/remove', { projectId: PROJ_A });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_COMMAND_INVALID');

    const list = await h.get('/api/projects');
    assert.deepEqual(
      (list.body.projects as { projectId: string }[]).map((p) => p.projectId).sort(),
      [PROJ_A, PROJ_B],
      '缺 confirm 不得移除项目',
    );
    assert.equal(sha(await readFile(join(h.rootA, 'readme.md'))), before, '磁盘字节必须不变');
  });
});

test('PB-05b 错误 confirm / 缺 Origin / 缺令牌 都被拒绝（零变更）', async () => {
  await withRemoval(async (h) => {
    const wrong = await h.post('/api/projects/remove', { projectId: PROJ_A, confirm: 'yes' });
    assert.equal(wrong.status, 400);

    const noOrigin = await h.post('/api/projects/remove', { projectId: PROJ_A, confirm: 'remove-from-workspace' }, { origin: false });
    assert.equal(noOrigin.status, 403, '变更类请求必须声明 Origin');

    const noToken = await h.post('/api/projects/remove', { projectId: PROJ_A, confirm: 'remove-from-workspace' }, { token: false });
    assert.equal(noToken.status, 403, '必须带会话令牌');

    const list = await h.get('/api/projects');
    assert.equal((list.body.projects as unknown[]).length, 2, '以上失败都不得移除项目');
  });
});

/* --------------------------- 前置检查（只读） --------------------------- */

test('PB-01 只读前置检查：有活动视图时 allowed=false / ACTIVE_VIEWS，且不改状态', async () => {
  await withRemoval(async (h) => {
    const opened = await h.post('/api/open', { projectId: PROJ_A, path: 'readme.md' });
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;

    const pre = await h.post('/api/projects/removal-precheck', { projectId: PROJ_A });
    assert.equal(pre.status, 200, JSON.stringify(pre.body));
    assert.equal(pre.body.allowed, false);
    assert.deepEqual(pre.body.blockedBy, ['ACTIVE_VIEWS']);

    // 只读：项目仍是 READY，视图仍可读
    const list = await h.get('/api/projects');
    assert.equal((list.body.projects as { projectId: string; status: string }[]).find((p) => p.projectId === PROJ_A)?.status, 'READY');
    const doc = await h.api(`/api/document?sessionId=${sessionId}&viewId=${viewId}`);
    assert.equal(doc.status, 200);

    // 关掉干净视图后：前检放行
    await h.post('/api/close', { sessionId, viewId });
    const pre2 = await h.post('/api/projects/removal-precheck', { projectId: PROJ_A });
    assert.equal(pre2.body.allowed, true, JSON.stringify(pre2.body));
    assert.deepEqual(pre2.body.blockedBy, []);
  });
});

test('PB-01b 有活动视图时 remove → 409 aborted + blockedBy ACTIVE_VIEWS（零变更）', async () => {
  await withRemoval(async (h) => {
    const opened = await h.post('/api/open', { projectId: PROJ_A, path: 'readme.md' });
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;
    const before = sha(await readFile(join(h.rootA, 'readme.md')));

    const res = await h.post('/api/projects/remove', { projectId: PROJ_A, confirm: 'remove-from-workspace' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.outcome, 'aborted');
    assert.deepEqual(res.body.blockedBy, ['ACTIVE_VIEWS']);

    const doc = await h.api(`/api/document?sessionId=${sessionId}&viewId=${viewId}`);
    assert.equal(doc.status, 200, '视图必须保持可读');
    assert.equal(sha(await readFile(join(h.rootA, 'readme.md'))), before);
  });
});

/* ------------------------------- 成功移除 ------------------------------- */

test('PB-04 干净后移除成功：项目消失、/api/tree 404、磁盘字节逐字节不变', async () => {
  await withRemoval(async (h) => {
    const before = sha(await readFile(join(h.rootA, 'docs', 'guide.md')));

    const res = await h.post('/api/projects/remove', {
      projectId: PROJ_A,
      confirm: 'remove-from-workspace',
      opId: 'op-test-remove-a-0001',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.outcome, 'revoked');
    assert.equal(res.body.opId, 'op-test-remove-a-0001', '必须沿用调用方在提交前落定的 opId');

    const list = await h.get('/api/projects');
    assert.deepEqual(
      (list.body.projects as { projectId: string }[]).map((p) => p.projectId),
      [PROJ_B],
      '只剩另一个项目',
    );

    const tree = await h.get(`/api/tree?projectId=${PROJ_A}`);
    assert.equal(tree.status, 404, '移除后 /api/tree 必须 404');

    const disk = await h.api(`/api/resources?projectId=${PROJ_A}`);
    assert.notEqual(disk.status, 200, 'G-DISK 必须拒绝');

    assert.equal(sha(await readFile(join(h.rootA, 'docs', 'guide.md'))), before, '磁盘内容必须逐字节不变');
    assert.equal(existsSync(join(h.rootA, 'readme.md')), true, '文件仍在磁盘上');
  });
});

test('PB-09 响应 / 文案不含绝对路径（项目内相对 path 允许）', async () => {
  await withRemoval(async (h) => {
    const pre = await h.post('/api/projects/removal-precheck', { projectId: PROJ_A });
    const remove = await h.post('/api/projects/remove', { projectId: PROJ_A, confirm: 'remove-from-workspace' });
    const payload = JSON.stringify(pre.body) + JSON.stringify(remove.body);
    assert.equal(payload.includes(h.base), false, '响应不得出现本机绝对根');
    assert.equal(payload.toLowerCase().includes('roottoken'), false, '响应不得出现根令牌字段');
  });
});

/* ------------------------------ opId 结果查询 ------------------------------ */

test('PB-06 op 查询按证据匹配：撤销后 revoked，未发生 unknown，绝不按 projectId 猜', async () => {
  await withRemoval(async (h) => {
    const res = await h.post('/api/projects/remove', {
      projectId: PROJ_A,
      confirm: 'remove-from-workspace',
      opId: 'op-evidence-0001',
    });
    assert.equal(res.body.outcome, 'revoked');

    const hit = await h.get(`/api/projects/op?opId=op-evidence-0001`);
    assert.equal(hit.status, 200);
    assert.equal(hit.body.outcome, 'revoked', '墓碑命中本次 opId → revoked');

    const miss = await h.get(`/api/projects/op?opId=op-never-happened-9999`);
    assert.equal(miss.status, 200);
    assert.equal(miss.body.outcome, 'unknown', '无匹配证据 → unknown（绝不因项目不存在就猜 revoked/aborted）');

    // op 查询必须带令牌
    const noToken = await h.get(`/api/projects/op?opId=op-evidence-0001`, { token: false });
    assert.equal(noToken.status, 403);

    const empty = await h.get(`/api/projects/op`, { token: true });
    assert.equal(empty.status, 400, '缺 opId → 400');
  });
});

/* ------------------------------ 重启不复活 ------------------------------ */

test('PB-07 重启 Host 后：已移除项目不复活，另一个项目仍在', async () => {
  await withRemoval(async (h) => {
    // 先移除 PROJ_A
    const res = await h.post('/api/projects/remove', { projectId: PROJ_A, confirm: 'remove-from-workspace' });
    assert.equal(res.body.outcome, 'revoked');

    // 关闭后用同一 store 重启（显式关闭，避免泄漏句柄）
    await h.server.close();
    const restarted = await createShellServer({
      port: 0,
      managedStore: { dir: h.storeDir, picker: createFakePicker([{ status: 'cancelled' }]) },
    });
    try {
      const res2 = await fetch(`${restarted.url}/api/projects`);
      const body = (await res2.json()) as { projects?: { projectId: string }[] };
      const ids = (body.projects ?? []).map((p) => p.projectId);
      assert.deepEqual(ids, [PROJ_B], '已移除项目在重启后不得复活（墓碑胜出）');

      // 重启后空 opId 仍 400（端点行为一致，不因重启伪造结果）
      const tokenRes = await fetch(`${restarted.url}/api/session-token`);
      const token = ((await tokenRes.json()) as { token?: string }).token ?? '';
      const op = await fetch(`${restarted.url}/api/projects/op?opId=`, {
        headers: { 'x-ws-token': token },
      });
      assert.equal(op.status, 400, '空 opId → 400');
    } finally {
      await restarted.close();
    }
    // h.server 已关闭；withRemoval 的 finally 对二次 close 容错
  });
});

/* --------------------------- R1-02 · opId 唯一归属 --------------------------- */

test('R1-02-01 同一 opId 不得用于另一个项目的撤销（409 + 零变更 + 只有一条墓碑）', async () => {
  await withRemoval(async (h) => {
    const first = await h.post('/api/projects/remove', {
      projectId: PROJ_A,
      confirm: 'remove-from-workspace',
      opId: 'op-shared-0001',
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.outcome, 'revoked');

    // 复用同一个 opId 去撤销另一个项目：必须被拒，且不能写入第二条墓碑
    const second = await h.post('/api/projects/remove', {
      projectId: PROJ_B,
      confirm: 'remove-from-workspace',
      opId: 'op-shared-0001',
    });
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body.errorCode, 'ERR_OP_ID_CONFLICT');

    const list = await h.get('/api/projects');
    assert.deepEqual(
      (list.body.projects as { projectId: string }[]).map((p) => p.projectId),
      [PROJ_B],
      '被拒的项目必须仍然存在',
    );
    assert.equal(existsSync(join(h.rootB, 'readme.md')), true);

    const log = await readFile(join(h.storeDir, 'revocations.jsonl'), 'utf8').catch(() => '');
    const hits = log.split('\n').filter((line) => line.includes('op-shared-0001'));
    assert.equal(hits.length, 1, '同一个 opId 只能有一条撤销证据');

    // 证据归属仍是 A：不能被 B 认领
    const op = await h.get('/api/projects/op?opId=op-shared-0001');
    assert.equal(op.body.outcome, 'revoked');
    assert.equal(op.body.projectId, PROJ_A, 'op 证据必须带归属项目');
  });
});

test('R1-02-02 op 查询返回证据归属：未知 opId 的归属必须为 null', async () => {
  await withRemoval(async (h) => {
    const res = await h.post('/api/projects/remove', {
      projectId: PROJ_A,
      confirm: 'remove-from-workspace',
      opId: 'op-owner-0001',
    });
    assert.equal(res.body.outcome, 'revoked');

    const hit = await h.get('/api/projects/op?opId=op-owner-0001');
    assert.equal(hit.body.outcome, 'revoked');
    assert.equal(hit.body.projectId, PROJ_A);

    const miss = await h.get('/api/projects/op?opId=op-owner-never-0002');
    assert.equal(miss.body.outcome, 'unknown');
    assert.equal(miss.body.projectId, null, '没有证据时不得给出任何归属');
  });
});

test('R1-02-03 已被"添加事务"使用的 opId 不得再用于撤销（409 + 项目与证据都不变）', async () => {
  await withRemoval(
    async (h) => {
      const res = await h.post('/api/projects/remove', {
        projectId: PROJ_A,
        confirm: 'remove-from-workspace',
        opId: 'op-add-b-0001',
      });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.errorCode, 'ERR_OP_ID_CONFLICT');

      const list = await h.get('/api/projects');
      assert.equal((list.body.projects as unknown[]).length, 2, '两个项目都必须还在');

      const op = await h.get('/api/projects/op?opId=op-add-b-0001');
      assert.equal(op.body.outcome, 'created', '证据仍是那次添加事务');
      assert.equal(op.body.projectId, PROJ_B);
    },
    { createdByOp: 'op-add-b-0001' },
  );
});

test('R1-02-04 重启后重复使用同一 opId 仍被拒（持久证据优先于进程内状态）', async () => {
  await withRemoval(async (h) => {
    const first = await h.post('/api/projects/remove', {
      projectId: PROJ_A,
      confirm: 'remove-from-workspace',
      opId: 'op-restart-0001',
    });
    assert.equal(first.body.outcome, 'revoked');

    await h.server.close();
    const restarted = await createShellServer({
      port: 0,
      managedStore: { dir: h.storeDir, picker: createFakePicker([{ status: 'cancelled' }]) },
    });
    h.server = restarted;
    try {
      const tokenRes = await fetch(`${restarted.url}/api/session-token`);
      const token = ((await tokenRes.json()) as { token?: string }).token ?? '';
      const again = await fetch(`${restarted.url}/api/projects/remove`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ws-token': token,
          origin: new URL(restarted.url).origin,
        },
        body: JSON.stringify({
          projectId: PROJ_B,
          confirm: 'remove-from-workspace',
          opId: 'op-restart-0001',
        }),
      });
      assert.equal(again.status, 409, '重启后仍必须识别出这个 opId 已被使用');
      const body = (await again.json()) as { errorCode?: string };
      assert.equal(body.errorCode, 'ERR_OP_ID_CONFLICT');

      const listRes = await fetch(`${restarted.url}/api/projects`);
      const listBody = (await listRes.json()) as { projects?: { projectId: string }[] };
      assert.deepEqual((listBody.projects ?? []).map((p) => p.projectId), [PROJ_B]);
    } finally {
      await restarted.close();
    }
  });
});
