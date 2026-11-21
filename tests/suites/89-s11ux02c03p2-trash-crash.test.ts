/**
 * UX-02C-03-P2-01：事务中断与重启对账。
 *
 * 这里**不用 mock 证明原子性**：每个用例都在真实磁盘上制造中断（注入配置原子的
 * `rename` 失败、真删真写回收区对象、真起第二个进程），然后断言"磁盘事实"与
 * "配置事实"是否一致，以及重启后对账把状态收敛到哪一格。
 */
import assert from 'node:assert/strict';
import { lstatSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { serializeConfig } from '../../apps/server/src/store/config.ts';
import { createNodeStoreIo, type StoreIo } from '../../apps/server/src/store/io.ts';
import { createLocalProvider, rootTokenOf } from '../../packages/storage/index.ts';

const PROJ = 'project-a';

interface ApiResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  status: number;
}

interface Harness {
  root: string;
  storeDir: string;
  server: ShellServer;
  api: {
    post(path: string, body: unknown): Promise<ApiResponse>;
    get(path: string): Promise<ApiResponse>;
  };
  /** 让"从此刻起的第 offset 次 workspace.json 提交"失败（offset 从 1 开始）。 */
  failConfigCommit(offset: number): void;
  clearFaults(): void;
  config(): Promise<{ trash: TrashRow[]; commitSeq: number; version: number }>;
  payloadPath(opId: string): string;
  restart(): Promise<void>;
}

interface TrashRow {
  opId: string;
  state: string;
  originalPath: string;
  identity: string;
  projectId: string;
  rootToken: string;
}

function makeStoreIo(): {
  io: StoreIo;
  commits: () => number;
  failAt: (offset: number) => void;
  clear: () => void;
} {
  const real = createNodeStoreIo();
  let commits = 0;
  let target: number | null = null;
  const io: StoreIo = {
    ...real,
    rename(from, to) {
      if (String(to).endsWith('workspace.json')) {
        commits += 1;
        if (target !== null && commits === target) {
          target = null;
          throw new Error('注入：workspace.json 原子提交失败');
        }
      }
      real.rename(from, to);
    },
  };
  return {
    io,
    commits: () => commits,
    failAt: (offset) => {
      target = commits + offset;
    },
    clear: () => {
      target = null;
    },
  };
}

async function withHarness(
  fn: (h: Harness) => Promise<void>,
  options: { prepare?: (root: string) => Promise<void>; seed?: (root: string, storeDir: string) => void } = {},
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-p2-crash-'));
  const storeDir = join(base, 'store');
  const root = join(base, 'project-a');
  await mkdir(storeDir, { recursive: true });
  await mkdir(root, { recursive: true });
  for (const name of ['a.md', 'b.md']) await writeFile(join(root, name), `# ${name}\n`, 'utf8');
  if (options.prepare) await options.prepare(root);

  const project = {
    projectId: PROJ,
    name: '项目 A',
    rootDir: root,
    canonicalRoot: realpathSync(root),
    rootToken: rootTokenOf(root),
    grantedAt: '2026-11-22T00:00:00.000Z',
    grantSource: 'os-dialog',
  };
  writeFileSync(
    join(storeDir, 'workspace.json'),
    serializeConfig({
      version: 2,
      commitSeq: 0,
      issuedIds: [PROJ],
      revoked: [],
      projects: [project],
    }),
    'utf8',
  );
  if (options.seed) options.seed(root, storeDir);

  const { io, failAt, clear } = makeStoreIo();
  let server = await createShellServer({
    port: 0,
    managedStore: { dir: storeDir, picker: createFakePicker([]), storeIo: io },
  });
  let token = ((await (await fetch(`${server.url}/api/session-token`)).json()) as { token?: string }).token ?? '';

  const api = {
    async post(path: string, body: unknown): Promise<ApiResponse> {
      const res = await fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ws-token': token, origin: server.url },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    async get(path: string): Promise<ApiResponse> {
      const res = await fetch(`${server.url}${path}`, { headers: { 'x-ws-token': token } });
      return { status: res.status, body: await res.json() };
    },
  };

  const h: Harness = {
    root,
    storeDir,
    server,
    api,
    failConfigCommit: failAt,
    clearFaults: clear,
    async config() {
      return JSON.parse(await readFile(join(storeDir, 'workspace.json'), 'utf8'));
    },
    payloadPath: (opId) => join(root, '.weavespace', 'trash', opId, 'payload'),
    async restart() {
      await server.close();
      server = await createShellServer({
        port: 0,
        managedStore: { dir: storeDir, picker: createFakePicker([]), storeIo: io },
      });
      h.server = server;
      token = ((await (await fetch(`${server.url}/api/session-token`)).json()) as { token?: string }).token ?? '';
    },
  };

  try {
    await fn(h);
  } finally {
    await server.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

/* ================================================================== */
/* 删除事务                                                            */
/* ================================================================== */

test('P2-01o 配置意图写入失败：拒绝且零磁盘副作用（文件未移动、无回收区目录）', async () => {
  await withHarness(async (h) => {
    h.failConfigCommit(1);
    const res = await h.api.post('/api/trash/entry', { projectId: PROJ, path: 'a.md', opId: 'op-crash-0001' });
    h.clearFaults();

    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_PERSIST_FAILED');
    assert.equal(await readFile(join(h.root, 'a.md'), 'utf8'), '# a.md\n', '正文必须留在原处');
    assert.throws(() => lstatSync(join(h.root, '.weavespace')), '不得创建回收区目录');
    assert.deepEqual((await h.config()).trash ?? [], [], '不得留下意图记录');
  });
});

test('P2-01p 移动成功但状态提交失败：202 UNKNOWN，重启后对账提升为 stored，可恢复', async () => {
  await withHarness(async (h) => {
    h.failConfigCommit(2); // 1 = beginTrash，2 = commitStored
    const res = await h.api.post('/api/trash/entry', { projectId: PROJ, path: 'a.md', opId: 'op-crash-0002' });
    h.clearFaults();

    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.status, 'UNKNOWN');

    // 磁盘事实：源已经没了、payload 在；配置事实：仍是 pending
    assert.throws(() => lstatSync(join(h.root, 'a.md')));
    assert.equal(await readFile(h.payloadPath('op-crash-0002'), 'utf8'), '# a.md\n');
    const pending = (await h.config()).trash.find((row) => row.opId === 'op-crash-0002');
    assert.equal(pending?.state, 'pending', '未确认时不得写 stored');

    await h.restart();
    const list = await h.api.get(`/api/trash?projectId=${PROJ}`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.entries[0].state, 'stored', '对账必须据磁盘事实提升');
    assert.equal((await h.config()).trash[0].state, 'stored', '提升必须落盘，不只是内存视图');

    const restore = await h.api.post('/api/trash/restore', { projectId: PROJ, opId: 'op-crash-0002' });
    assert.equal(restore.status, 200, JSON.stringify(restore.body));
    assert.equal(await readFile(join(h.root, 'a.md'), 'utf8'), '# a.md\n');
  });
});

test('P2-01q 意图已写但文件从未移动（崩溃在移动之前）：重启对账判 aborted，文件不动', async () => {
  await withHarness(
    async (h) => {
      // 不发起任何请求：模拟"意图落盘后进程立刻消失"
      const list = await h.api.get(`/api/trash?projectId=${PROJ}`);
      assert.equal(list.body.entries[0].state, 'aborted');
      assert.equal(await readFile(join(h.root, 'a.md'), 'utf8'), '# a.md\n');
      assert.deepEqual(
        (await h.config()).trash.map((row) => row.state),
        ['aborted'],
        'aborted 必须落盘（不是只改内存）',
      );
      assert.throws(() => lstatSync(h.payloadPath('op-crash-0003')), '不得凭空造出 payload');
    },
    {
      seed(root, storeDir) {
        const ino = lstatSync(join(root, 'a.md'));
        writeFileSync(
          join(storeDir, 'workspace.json'),
          serializeConfig({
            version: 4,
            commitSeq: 0,
            issuedIds: [PROJ],
            revoked: [],
            projects: [
              {
                projectId: PROJ,
                name: '项目 A',
                rootDir: root,
                canonicalRoot: realpathSync(root),
                rootToken: rootTokenOf(root),
                grantedAt: '2026-11-22T00:00:00.000Z',
                grantSource: 'os-dialog',
              },
            ],
            hidden: [],
            trash: [
              {
                opId: 'op-crash-0003',
                projectId: PROJ,
                rootToken: rootTokenOf(root),
                originalPath: 'a.md',
                entryKind: 'file',
                identity: `${ino.dev}:${ino.ino}`,
                size: 6,
                deletedAt: '2026-11-22T00:00:00.000Z',
                state: 'pending',
              },
            ],
          }),
          'utf8',
        );
      },
    },
  );
});

/* ================================================================== */
/* 恢复事务                                                            */
/* ================================================================== */

test('P2-01r 恢复中断（已移回、状态未提交）：重启对账提升 restored，不重复移动', async () => {
  await withHarness(async (h) => {
    assert.equal(
      (await h.api.post('/api/trash/entry', { projectId: PROJ, path: 'a.md', opId: 'op-crash-0004' })).status,
      200,
    );
    h.failConfigCommit(2); // 1 = restoring，2 = restored
    const res = await h.api.post('/api/trash/restore', { projectId: PROJ, opId: 'op-crash-0004' });
    h.clearFaults();

    assert.equal(res.status, 202, JSON.stringify(res.body));
    // 磁盘事实：文件已经回到原位置；配置事实：restoring
    assert.equal(await readFile(join(h.root, 'a.md'), 'utf8'), '# a.md\n');
    assert.equal((await h.config()).trash[0].state, 'restoring');
    assert.throws(() => lstatSync(h.payloadPath('op-crash-0004')), 'payload 已经移出');

    await h.restart();
    const list = await h.api.get(`/api/trash?projectId=${PROJ}`);
    assert.equal(list.body.entries[0].state, 'restored');
    assert.equal((await h.config()).trash[0].state, 'restored');
    assert.equal(await readFile(join(h.root, 'a.md'), 'utf8'), '# a.md\n', '不得再动一次文件');
  });
});

/* ================================================================== */
/* 外部干预                                                            */
/* ================================================================== */

test('P2-01s 回收区对象被外部替换：判 conflicted（不是 missing），恢复被拒绝', async () => {
  await withHarness(async (h) => {
    assert.equal(
      (await h.api.post('/api/trash/entry', { projectId: PROJ, path: 'a.md', opId: 'op-crash-0005' })).status,
      200,
    );
    const payload = h.payloadPath('op-crash-0005');
    unlinkSync(payload);
    writeFileSync(payload, 'SOMEONE ELSE\n', 'utf8');

    const list = await h.api.get(`/api/trash?projectId=${PROJ}`);
    assert.equal(list.body.entries[0].state, 'conflicted', '身份不匹配必须进 conflicted');
    assert.equal(list.body.entries[0].canRestore, false);

    const restore = await h.api.post('/api/trash/restore', { projectId: PROJ, opId: 'op-crash-0005' });
    assert.equal(restore.status, 409, JSON.stringify(restore.body));
    assert.equal(restore.body.errorCode, 'ERR_TRASH_STATE_CONFLICT');
    assert.equal(await readFile(payload, 'utf8'), 'SOMEONE ELSE\n', '外部对象必须原样保留');
    assert.throws(() => lstatSync(join(h.root, 'a.md')), '不得把外部对象搬回原位置');
  });
});

test('P2-01t 删除前源对象被替换：Provider 按 expectedIdentity 拒绝，替换对象毫发无损', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-p2-prov-'));
  try {
    const provider = createLocalProvider({ rootDir: base, providerId: 'local:probe' });
    assert.equal(typeof provider.trashEntry, 'function', 'Provider 必须提供 trashEntry');

    await writeFile(join(base, 'a.md'), '# ORIGINAL\n', 'utf8');
    const stale = await provider.identityOf!('a.md');
    assert.ok(stale);

    // 外部进程删掉再重建同名对象（新 inode）
    await unlink(join(base, 'a.md'));
    await writeFile(join(base, 'a.md'), '# REPLACED\n', 'utf8');

    const res = await provider.trashEntry!('op-prov-0001', 'a.md', stale!);
    assert.equal(res.status, 'REJECTED');
    assert.equal(res.errorCode, 'ERR_ENTRY_SOURCE_CHANGED');
    assert.equal(await readFile(join(base, 'a.md'), 'utf8'), '# REPLACED\n', '替换对象不得被移走');
    assert.throws(() => lstatSync(join(base, '.weavespace', 'trash', 'op-prov-0001', 'payload')));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
