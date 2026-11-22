/**
 * UX-02C-03-P2-01-R1：对账必须区分"不存在"与"看不清 / 类型异常"。
 *
 * 两类取证：
 * - 表驱动：直接喂 `reconcileTrash` 纯函数，逐格断言判定表（这是"崩溃后能收敛"的唯一依据）；
 * - 真磁盘：把 payload 换成链接 / 目录 / 别的文件、把父目录换成链接，再走真实
 *   `GET /api/trash` 触发对账，断言状态与落盘结果。
 *
 * 铁律：身份不可信一律 `conflicted`，**绝不能**落到 `missing`（那会让用户以为文件丢了）。
 */
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createShellServer } from '../../apps/server/src/server.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { serializeConfig } from '../../apps/server/src/store/config.ts';
import { reconcileTrash, type TrashEvidence, type TrashProbe } from '../../apps/server/src/trash.ts';
import { rootTokenOf } from '../../packages/storage/index.ts';

const PROJ = 'project-a';
const OP = 'op-r1-reconcile-0001';

const present = (identity: string): TrashProbe => ({ state: 'present', identity });
const missing: TrashProbe = { state: 'missing' };
const unsafe: TrashProbe = { state: 'unsafe' };
const failed: TrashProbe = { state: 'failed' };

function record(state: 'pending' | 'stored' | 'restoring', identity = '1:100') {
  return {
    opId: OP,
    projectId: PROJ,
    rootToken: 'tok',
    originalPath: 'a.md',
    entryKind: 'file' as const,
    identity,
    size: 6,
    deletedAt: '2026-11-22T00:00:00.000Z',
    state,
  };
}

function evidence(patch: Partial<TrashEvidence>): TrashEvidence {
  return { source: missing, payload: missing, target: missing, ...patch };
}

/* ================================================================== */
/* 判定表（纯函数）                                                     */
/* ================================================================== */

test('R1-06a 表驱动：pending 的六种磁盘事实', () => {
  const cases: [string, TrashEvidence, string][] = [
    ['payload 身份匹配', evidence({ payload: present('1:100') }), 'stored'],
    ['payload 身份不符', evidence({ payload: present('9:999') }), 'conflicted'],
    ['payload 不可信', evidence({ payload: unsafe }), 'conflicted'],
    ['payload 探测失败', evidence({ payload: failed }), 'conflicted'],
    ['源身份匹配', evidence({ source: present('1:100') }), 'aborted'],
    ['源是别的对象', evidence({ source: present('9:999') }), 'conflicted'],
    ['源不可信（链接/目录）', evidence({ source: unsafe }), 'conflicted'],
    ['两端都可靠缺失', evidence({}), 'missing'],
  ];
  for (const [label, input, expected] of cases) {
    assert.equal(reconcileTrash(record('pending'), input).state, expected, label);
  }
});

test('R1-06b 表驱动：stored 的五种磁盘事实', () => {
  const cases: [string, TrashEvidence, string][] = [
    ['payload 匹配', evidence({ payload: present('1:100') }), 'stored'],
    ['payload 被替换', evidence({ payload: present('9:999') }), 'conflicted'],
    ['payload 类型异常', evidence({ payload: unsafe }), 'conflicted'],
    ['payload 探测失败', evidence({ payload: failed }), 'conflicted'],
    ['对象已回到原路径', evidence({ source: present('1:100') }), 'restored'],
    ['原路径是别的对象', evidence({ source: present('9:999') }), 'conflicted'],
    ['两端都可靠缺失', evidence({}), 'missing'],
  ];
  for (const [label, input, expected] of cases) {
    assert.equal(reconcileTrash(record('stored'), input).state, expected, label);
  }
});

test('R1-06c 表驱动：restoring 必须先比对 payload 身份，只有匹配才允许回退 stored', () => {
  const cases: [string, TrashEvidence, string][] = [
    ['payload 匹配 + 目标缺失 → 可重试', evidence({ payload: present('1:100') }), 'stored'],
    ['payload 不匹配 + 目标缺失 → 冲突（不得回退）', evidence({ payload: present('9:999') }), 'conflicted'],
    ['payload 不可信 + 目标缺失', evidence({ payload: unsafe }), 'conflicted'],
    ['payload 缺失 + 目标匹配', evidence({ target: present('1:100') }), 'restored'],
    ['payload 缺失 + 目标是别的对象', evidence({ target: present('9:999') }), 'conflicted'],
    ['payload 匹配 + 目标也在', evidence({ payload: present('1:100'), target: present('1:100') }), 'conflicted'],
    ['两端都可靠缺失', evidence({}), 'missing'],
  ];
  for (const [label, input, expected] of cases) {
    assert.equal(reconcileTrash(record('restoring'), input).state, expected, label);
  }
});

test('R1-06d 表驱动：任何参与判定的探测异常都不得落到 missing', () => {
  const unreadable: TrashProbe[] = [unsafe, failed];
  for (const state of ['pending', 'stored', 'restoring'] as const) {
    for (const bad of unreadable) {
      // 回收区对象在三种状态里都参与判定
      assert.equal(reconcileTrash(record(state), evidence({ payload: bad })).state, 'conflicted', `${state}/payload`);
      // 原位置只在 pending / stored 参与判定（restoring 看的是恢复目标）
      if (state === 'pending' || state === 'stored') {
        assert.equal(reconcileTrash(record(state), evidence({ source: bad })).state, 'conflicted', `${state}/source`);
      }
      // 恢复目标只在 restoring 参与判定
      if (state === 'restoring') {
        assert.equal(reconcileTrash(record(state), evidence({ target: bad })).state, 'conflicted', `${state}/target`);
      }
    }
  }
});

/* ================================================================== */
/* 真磁盘对账                                                          */
/* ================================================================== */

interface Ctx {
  root: string;
  storeDir: string;
  api: { get(path: string): Promise<{ status: number; body: any }> };
  config(): Promise<{ trash: { opId: string; state: string; identity: string }[] }>;
  payload(opId?: string): string;
  opDir(opId?: string): string;
}

async function withReconcileHost(
  fn: (ctx: Ctx) => Promise<void>,
  options: {
    /** 在启动 Host 之前准备磁盘事实；`rows` 是即将写入配置的记录。 */
    prepare: (root: string) => Promise<{
      state: 'pending' | 'stored' | 'restoring';
      identity: string;
      size?: number;
    }>;
    originalPath?: string;
  },
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-p2r1-rec-'));
  const storeDir = join(base, 'store');
  const root = join(base, 'project-a');
  await mkdir(storeDir, { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'a.md'), '# a.md\n', 'utf8');

  const prepared = await options.prepare(root);
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
      version: 4,
      commitSeq: 0,
      issuedIds: [PROJ],
      revoked: [],
      projects: [project],
      hidden: [],
      trash: [
        {
          opId: OP,
          projectId: PROJ,
          rootToken: project.rootToken,
          originalPath: options.originalPath ?? 'a.md',
          entryKind: 'file' as const,
          identity: prepared.identity,
          size: prepared.size ?? 6,
          deletedAt: '2026-11-22T00:00:00.000Z',
          state: prepared.state,
        },
      ],
    }),
    'utf8',
  );

  const server = await createShellServer({
    port: 0,
    managedStore: { dir: storeDir, picker: createFakePicker([]) },
  });
  const token = ((await (await fetch(`${server.url}/api/session-token`)).json()) as { token?: string }).token ?? '';
  const ctx: Ctx = {
    root,
    storeDir,
    api: {
      async get(path) {
        const res = await fetch(`${server.url}${path}`, { headers: { 'x-ws-token': token } });
        return { status: res.status, body: await res.json() };
      },
    },
    async config() {
      return JSON.parse(await readFile(join(storeDir, 'workspace.json'), 'utf8'));
    },
    payload: (opId = OP) => join(root, '.weavespace', 'trash', opId, 'payload'),
    opDir: (opId = OP) => join(root, '.weavespace', 'trash', opId),
  };
  try {
    await fn(ctx);
  } finally {
    await server.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

test('R1-06e payload 被符号链接替换：对账判 conflicted（不是 missing），落盘一致', async () => {
  await withReconcileHost(
    async (h) => {
      const list = await h.api.get(`/api/trash?projectId=${PROJ}`);
      assert.equal(list.status, 200, JSON.stringify(list.body));
      assert.equal(list.body.entries[0].state, 'conflicted');
      assert.equal(list.body.entries[0].canRestore, false);
      assert.equal((await h.config()).trash[0].state, 'conflicted', '判定必须落盘');
    },
    {
      async prepare(root) {
        mkdirSync(join(root, '.weavespace', 'trash', OP), { recursive: true });
        const external = join(root, '..', 'outside-target.md');
        writeFileSync(external, '# a.md\n', 'utf8');
        const externalIdentity = `${lstatSync(external).dev}:${lstatSync(external).ino}`;
        await symlink(external, join(root, '.weavespace', 'trash', OP, 'payload'), 'file');
        // 记录身份 = 链接目标身份：旧实现会沿链接读出该身份并误判为 stored
        return { state: 'stored' as const, identity: externalIdentity };
      },
    },
  );
});

test('R1-06f payload 被目录替换：对账判 conflicted，不删除该目录', async () => {
  await withReconcileHost(
    async (h) => {
      const list = await h.api.get(`/api/trash?projectId=${PROJ}`);
      assert.equal(list.body.entries[0].state, 'conflicted');
      assert.ok(lstatSync(h.payload()).isDirectory(), '目录必须原样保留');
      assert.equal((await h.config()).trash[0].state, 'conflicted');
    },
    {
      async prepare(root) {
        const dir = join(root, '.weavespace', 'trash', OP, 'payload');
        mkdirSync(dir, { recursive: true });
        return { state: 'stored' as const, identity: '1:100' };
      },
    },
  );
});

test('R1-06g payload 的父目录被链接替换到根外：对账判 conflicted，不沿链接读外部对象', async () => {
  await withReconcileHost(
    async (h) => {
      const list = await h.api.get(`/api/trash?projectId=${PROJ}`);
      assert.equal(list.body.entries[0].state, 'conflicted', '父链是链接时绝不能判 stored/missing');
      assert.equal((await h.config()).trash[0].state, 'conflicted');
      assert.equal(
        readFileSync(join(h.root, '..', 'outside-op', 'payload'), 'utf8'),
        '# a.md\n',
        '外部文件不得被动到',
      );
    },
    {
      async prepare(root) {
        const externalDir = join(root, '..', 'outside-op');
        mkdirSync(externalDir, { recursive: true });
        const externalPayload = join(externalDir, 'payload');
        writeFileSync(externalPayload, '# a.md\n', 'utf8');
        mkdirSync(join(root, '.weavespace', 'trash'), { recursive: true });
        await symlink(externalDir, join(root, '.weavespace', 'trash', OP), 'junction');
        return {
          state: 'stored' as const,
          identity: `${lstatSync(externalPayload).dev}:${lstatSync(externalPayload).ino}`,
        };
      },
    },
  );
});

test('R1-06h restoring 且 payload 身份不匹配：判 conflicted，绝不回退成 stored', async () => {
  await withReconcileHost(
    async (h) => {
      const list = await h.api.get(`/api/trash?projectId=${PROJ}`);
      assert.equal(list.body.entries[0].state, 'conflicted', '旧实现会把它当成"恢复未发生"而回退 stored');
      assert.equal((await h.config()).trash[0].state, 'conflicted');
      assert.equal(readFileSync(h.payload(), 'utf8'), 'SOMEONE ELSE\n', '外部对象必须原样保留');
    },
    {
      async prepare(root) {
        mkdirSync(join(root, '.weavespace', 'trash', OP), { recursive: true });
        writeFileSync(join(root, '.weavespace', 'trash', OP, 'payload'), 'SOMEONE ELSE\n', 'utf8');
        // 原位置为空（恢复尚未发生），payload 不是记录里那个对象
        await unlink(join(root, 'a.md'));
        return { state: 'restoring' as const, identity: '1:100' };
      },
    },
  );
});

test('R1-06k payload 被链接替换且原位置为空：旧实现会误判 missing，必须是 conflicted', async () => {
  await withReconcileHost(
    async (h) => {
      const list = await h.api.get(`/api/trash?projectId=${PROJ}`);
      assert.equal(list.body.entries[0].state, 'conflicted', '看不清/类型异常绝不能报"文件已丢失"');
      assert.equal((await h.config()).trash[0].state, 'conflicted');
    },
    {
      async prepare(root) {
        mkdirSync(join(root, '.weavespace', 'trash', OP), { recursive: true });
        const external = join(root, '..', 'outside-target-2.md');
        writeFileSync(external, '# a.md\n', 'utf8');
        await symlink(external, join(root, '.weavespace', 'trash', OP, 'payload'), 'file');
        await unlink(join(root, 'a.md'));
        return { state: 'stored' as const, identity: '1:100' };
      },
    },
  );
});

test('R1-06l payload 被目录替换且原位置为空：旧实现会误判 missing，必须是 conflicted', async () => {
  await withReconcileHost(
    async (h) => {
      const list = await h.api.get(`/api/trash?projectId=${PROJ}`);
      assert.equal(list.body.entries[0].state, 'conflicted');
      assert.equal((await h.config()).trash[0].state, 'conflicted');
    },
    {
      async prepare(root) {
        mkdirSync(join(root, '.weavespace', 'trash', OP, 'payload'), { recursive: true });
        await unlink(join(root, 'a.md'));
        return { state: 'stored' as const, identity: '1:100' };
      },
    },
  );
});

test('R1-06i pending 但原位置是另一个对象：判 conflicted，不把替换对象当成原文件', async () => {
  await withReconcileHost(
    async (h) => {
      const list = await h.api.get(`/api/trash?projectId=${PROJ}`);
      assert.equal(list.body.entries[0].state, 'conflicted');
      assert.equal((await h.config()).trash[0].state, 'conflicted');
    },
    {
      async prepare(root) {
        // 记录身份指向一个已不存在的对象；a.md 是后来重建的新对象
        const ghost = join(root, '..', 'ghost.md');
        writeFileSync(ghost, '# ghost\n', 'utf8');
        const ghostIdentity = `${lstatSync(ghost).dev}:${lstatSync(ghost).ino}`;
        await unlink(ghost);
        return { state: 'pending' as const, identity: ghostIdentity };
      },
    },
  );
});

test('R1-06j stored 且两端都可靠缺失：判 missing（真实丢失才报丢失）', async () => {
  await withReconcileHost(
    async (h) => {
      const list = await h.api.get(`/api/trash?projectId=${PROJ}`);
      assert.equal(list.body.entries[0].state, 'missing');
      assert.equal((await h.config()).trash[0].state, 'missing');
    },
    {
      async prepare(root) {
        const ghost = join(root, '..', 'ghost2.md');
        writeFileSync(ghost, '# ghost\n', 'utf8');
        const identity = `${lstatSync(ghost).dev}:${lstatSync(ghost).ino}`;
        await unlink(ghost);
        await unlink(join(root, 'a.md'));
        return { state: 'stored' as const, identity };
      },
    },
  );
});
