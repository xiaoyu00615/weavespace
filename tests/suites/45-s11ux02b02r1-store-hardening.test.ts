/**
 * UX-02B-02-R1：四项安全/身份一致性修复的定向测试。
 *
 * P0-01 Store 不可信时的全局拒盘（运行期日志被破坏后，其它项目也不得再读写）
 * P0-02 issuedIds 重启闭环（已撤销 id 不得在重启后被重新签发）
 * P0-03 撤销前复核日志（运行期删/坏日志必须拒绝，且不得伪造新链）
 * P0-04 授权凭据完整性（缺 grantSource/grantedAt/canonicalRoot/rootToken 一律不授权）
 * P1    加载期重复根/嵌套根不得同时授权
 *
 * 取证：真实文件系统 + I/O 故障注入；"重启"= close 后重新打开；关键结论同时看
 * Store 状态、Runtime 的 grants 与磁盘字节。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CONFIG_FILE,
  LOG_FILE,
  StoreIoError,
  createFileProjectStore,
  createNodeStoreIo,
  serializeConfig,
  type FileProjectStore,
  type StoreIo,
} from '../../apps/server/src/store/index.ts';
import {
  createProjectRuntime,
  type ProjectRuntime,
} from '../../apps/server/src/project-runtime.ts';
import { createShellServer } from '../../apps/server/src/server.ts';
import { createDocumentService } from '../../packages/document/index.ts';
import { createPermissionService, type PermissionService } from '../../packages/permission/index.ts';
import { inspectProjectRoot } from '../../packages/project-registry/index.ts';

/* ------------------------------- 基础设施 ------------------------------- */

async function newDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ws-r1-'));
}

interface FaultPlan {
  append?: 'zero' | 'after-write' | 'half';
}

function ioWith(plan: FaultPlan): StoreIo {
  const base = createNodeStoreIo();
  return {
    ...base,
    appendText(path, text) {
      if (plan.append === 'zero') throw new StoreIoError('append-log', 0);
      if (plan.append === 'after-write') {
        base.appendText(path, text);
        throw new StoreIoError('append-log', text.length);
      }
      if (plan.append === 'half') {
        // 半行：真实写入一部分字节再报错，模拟 append 中途被杀
        const half = text.slice(0, Math.max(1, Math.floor(text.length / 2)));
        base.appendText(path, half);
        throw new StoreIoError('append-log', half.length);
      }
      base.appendText(path, text);
    },
  };
}

function open(dir: string, io?: StoreIo): FileProjectStore {
  return createFileProjectStore({ dir, ...(io ? { io } : {}) });
}

interface Identity {
  canonicalRoot: string;
  rootToken: string;
}

/** 真实根身份（加载期比对用的就是它）。 */
function identityOf(rootDir: string): Identity {
  const inspected = inspectProjectRoot(rootDir);
  assert.equal(inspected.status, 'READY', `测试根必须可用: ${rootDir}`);
  return { canonicalRoot: inspected.canonicalRoot, rootToken: inspected.rootToken };
}

function grantsFor(permission: PermissionService, projectId: string): number {
  return permission
    .grantsOf('local-user')
    .filter((grant) => grant.providerId === `local:${projectId}`).length;
}

interface Ctx {
  runtime: ProjectRuntime;
  permission: PermissionService;
  store: FileProjectStore;
}

function runtimeOver(store: FileProjectStore, withGrantSource = true): Ctx {
  const permission = createPermissionService([]);
  const runtime = createProjectRuntime({
    actorId: 'local-user',
    document: createDocumentService(),
    permission,
    store,
    ...(withGrantSource ? { grantSource: 'os-dialog' } : {}),
  });
  return { runtime, permission, store };
}

/* ------------------ P0-01：Store 不可信时的全局拒盘 ------------------ */

test('R1-01 运行期日志被破坏后，其它项目的 G-DISK 一律拒绝（含已发出的 grant）', async () => {
  const dir = await newDir();
  const rootA = await mkdtemp(join(tmpdir(), 'ws-r1-a-'));
  const rootB = await mkdtemp(join(tmpdir(), 'ws-r1-b-'));
  await mkdir(rootA, { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');
  await writeFile(join(rootB, 'b.md'), '# B\n', 'utf8');

  const plan: FaultPlan = {};
  const store = open(dir, ioWith(plan));
  let runtimeRef: ProjectRuntime | undefined;
  const server = await createShellServer({
    port: 0,
    managed: {
      create: (deps) => {
        runtimeRef = createProjectRuntime({ ...deps, store, grantSource: 'os-dialog' });
        return runtimeRef;
      },
    },
  });

  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${server.url}${path}`, init);
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const post = (path: string, body: unknown) =>
    api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  try {
    const runtime = runtimeRef as ProjectRuntime;
    const a = await runtime.addProject({ name: 'A', rootDir: rootA });
    const b = await runtime.addProject({ name: 'B', rootDir: rootB });
    assert.equal(a.status, 'READY');
    assert.equal(b.status, 'READY');

    const opened = await post('/api/open', { projectId: b.projectId, path: 'b.md' });
    assert.equal(opened.status, 200);
    const sessionId = (opened.body.document as Record<string, unknown>).sessionId as string;
    const viewId = (opened.body.document as Record<string, unknown>).viewId as string;
    const baseVersion = (opened.body.document as Record<string, unknown>).baseVersion as string;

    // A 的撤销把日志写坏 → Store 进入不可信
    plan.append = 'half';
    await assert.rejects(() => runtime.removeProject(a.projectId));
    assert.equal(store.loadState().diskTrusted, false, '前置：Store 必须已进入不可信状态');

    // B 的一切实体磁盘访问都必须被拒绝，即使它的 grant 仍在表里
    const resources = await api(`/api/resources?projectId=${b.projectId}`);
    assert.equal(resources.status, 503, `实际 ${resources.status}`);
    assert.equal(resources.body.errorCode, 'ERR_STORE_RESTRICTED');

    const reopened = await post('/api/open', { projectId: b.projectId, path: 'b.md' });
    assert.equal(reopened.status, 503, `实际 ${reopened.status}`);

    const saved = await post('/api/save', { sessionId, viewId, expectedVersion: baseVersion });
    assert.notEqual(saved.body.status, 'COMMITTED', '不可信状态下不得提交任何字节');
    assert.equal(saved.status, 503, `实际 ${saved.status}`);

    // G-DRAFT 不受影响：草稿仍可读（既有会话归属规则不变）
    const draft = await api(`/api/document?sessionId=${sessionId}&viewId=${viewId}`);
    assert.equal(draft.status, 200);
  } finally {
    await server.close();
    store.close();
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------ P0-02：issuedIds 重启闭环 ------------------ */

test('R1-02 撤销后重启，重新添加同名目录必须得到新 id（不复用、不认领旧会话）', async () => {
  const dir = await newDir();
  const rootDir = await mkdtemp(join(tmpdir(), 'ws-r1-notes-'));
  try {
    const identity = identityOf(rootDir);
    const first = open(dir);
    await first.commitAdd({
      projectId: 'notes',
      name: 'notes',
      rootDir,
      ...identity,
      grantedAt: new Date().toISOString(),
      grantSource: 'os-dialog',
      opId: 'op-add-1',
    });
    await first.commitRevoke({ projectId: 'notes', opId: 'op-rm-1' });
    first.close();

    // 重启：Runtime 只看到空项目表，但必须继承 issuedIds 里的 'notes'
    const reopened = open(dir);
    try {
      assert.deepEqual(reopened.load(), []);
      assert.deepEqual(reopened.issuedIds(), ['notes']);

      const ctx = runtimeOver(reopened);
      const readded = await ctx.runtime.addProject({ name: 'notes', rootDir });
      assert.notEqual(readded.projectId, 'notes', '已撤销的 id 不得复用');
      assert.match(readded.projectId, /^[a-z0-9][a-z0-9_-]{0,31}$/);
      assert.equal(readded.status, 'READY');
      assert.equal(grantsFor(ctx.permission, readded.projectId), 2);

      // 新身份与旧身份完全隔离：Provider 只认新 id
      assert.ok(ctx.runtime.providerOf(`local:${readded.projectId}`));
      assert.equal(ctx.runtime.providerOf('local:notes'), undefined);
      assert.equal(
        ctx.runtime.assertUsable(readded.projectId).providerId,
        `local:${readded.projectId}`,
        '句柄只认新身份，旧会话不可能被新项目认领',
      );
      assert.equal(reopened.queryOp('op-rm-1'), 'revoked');
      assert.equal(reopened.queryOp('op-add-1'), 'unknown', '旧添加证据已随条目删除');
      assert.equal(reopened.load()[0]?.projectId, readded.projectId);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------ P0-03：撤销前复核日志 ------------------ */

test('R1-03 运行期日志被删除后，撤销必须拒绝且不得伪造新日志链', async () => {
  const dir = await newDir();
  const rootDir = await mkdtemp(join(tmpdir(), 'ws-r1-p3-'));
  const store = open(dir);
  try {
    const identity = identityOf(rootDir);
    await store.commitAdd({
      projectId: 'a',
      name: 'A',
      rootDir,
      ...identity,
      grantedAt: new Date().toISOString(),
      grantSource: 'os-dialog',
      opId: 'op-add',
    });
    const ctx = runtimeOver(store);
    assert.equal(grantsFor(ctx.permission, 'a'), 2);

    // 模拟运行期日志被删（有历史事务 → 不允许当首次初始化）
    await rm(join(dir, LOG_FILE), { force: true });

    await assert.rejects(
      () => ctx.runtime.removeProject('a'),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_STORE_RESTRICTED',
    );

    assert.equal(existsSync(join(dir, LOG_FILE)), false, '不得创建一个伪造的完整新链');
    assert.equal(store.loadState().diskTrusted, false);
    assert.equal(store.loadState().mutationsAllowed, false);
    assert.equal(ctx.runtime.stateOf('a'), 'ACTIVE', '零变更：状态回原值');

    // 之后任何磁盘访问都被拒绝
    assert.throws(
      () => ctx.runtime.assertUsable('a'),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_STORE_RESTRICTED',
    );
  } finally {
    store.close();
    await rm(rootDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('R1-04 运行期链断裂后，撤销必须拒绝并进入受限', async () => {
  const dir = await newDir();
  const rootDir = await mkdtemp(join(tmpdir(), 'ws-r1-p3b-'));
  const store = open(dir);
  try {
    const identity = identityOf(rootDir);
    await store.commitAdd({
      projectId: 'a',
      name: 'A',
      rootDir,
      ...identity,
      grantedAt: new Date().toISOString(),
      grantSource: 'os-dialog',
      opId: 'op-add',
    });
    const ctx = runtimeOver(store);

    // 追加一条 hash 对不上的伪造行
    const log = await readFile(join(dir, LOG_FILE), 'utf8');
    const ghost = {
      seq: 99,
      projectId: 'a',
      at: new Date().toISOString(),
      opId: 'op-ghost',
      prevHash: 'x'.repeat(64),
      hash: 'y'.repeat(64),
    };
    await writeFile(join(dir, LOG_FILE), `${log}${JSON.stringify(ghost)}\n`, 'utf8');

    await assert.rejects(
      () => ctx.runtime.removeProject('a'),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_STORE_RESTRICTED',
    );
    assert.equal(store.loadState().diskTrusted, false);
    assert.equal(ctx.runtime.stateOf('a'), 'ACTIVE');
  } finally {
    store.close();
    await rm(rootDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------ P0-04：授权凭据完整性 ------------------ */

async function seedConfig(
  dir: string,
  projects: Array<Record<string, unknown>>,
  issuedIds: string[],
): Promise<void> {
  const config = {
    version: 2 as const,
    commitSeq: 0,
    issuedIds,
    revoked: [],
    projects: projects as never,
  };
  await writeFile(join(dir, CONFIG_FILE), serializeConfig(config), 'utf8');
}

test('R1-05 缺 grantSource（unspecified）的记录重启后不得获得任何 G-DISK', async () => {
  const dir = await newDir();
  const rootDir = await mkdtemp(join(tmpdir(), 'ws-r1-p4a-'));
  try {
    const identity = identityOf(rootDir);
    await seedConfig(
      dir,
      [
        {
          projectId: 'p',
          name: 'P',
          rootDir,
          ...identity,
          grantedAt: new Date().toISOString(),
          // grantSource 缺失 → 落盘为 unspecified
        },
      ],
      ['p'],
    );

    const store = open(dir);
    try {
      const ctx = runtimeOver(store);
      assert.equal(ctx.runtime.stateOf('p'), 'UNAVAILABLE', '没有授权来源就没有权限');
      assert.equal(grantsFor(ctx.permission, 'p'), 0);
      assert.equal(ctx.runtime.providerOf('local:p'), undefined);
    } finally {
      store.close();
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('R1-06 缺 canonicalRoot/rootToken 的记录重启后不得授权', async () => {
  const dir = await newDir();
  const rootDir = await mkdtemp(join(tmpdir(), 'ws-r1-p4b-'));
  try {
    await seedConfig(
      dir,
      [
        {
          projectId: 'p',
          name: 'P',
          rootDir,
          grantedAt: new Date().toISOString(),
          grantSource: 'os-dialog',
          // 缺 canonicalRoot / rootToken
        },
      ],
      ['p'],
    );

    const store = open(dir);
    try {
      const ctx = runtimeOver(store);
      assert.equal(ctx.runtime.stateOf('p'), 'UNAVAILABLE');
      assert.equal(grantsFor(ctx.permission, 'p'), 0);
    } finally {
      store.close();
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('R1-07 完整可信记录（os-dialog + 三元组 + 令牌一致）才会授权', async () => {
  const dir = await newDir();
  const rootDir = await mkdtemp(join(tmpdir(), 'ws-r1-p4c-'));
  try {
    const identity = identityOf(rootDir);
    await seedConfig(
      dir,
      [
        {
          projectId: 'p',
          name: 'P',
          rootDir,
          ...identity,
          grantedAt: new Date().toISOString(),
          grantSource: 'os-dialog',
        },
      ],
      ['p'],
    );

    const store = open(dir);
    try {
      const ctx = runtimeOver(store);
      assert.equal(ctx.runtime.stateOf('p'), 'ACTIVE');
      assert.equal(grantsFor(ctx.permission, 'p'), 2);
      assert.ok(ctx.runtime.assertUsable('p').canonicalRoot);
    } finally {
      store.close();
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------ P1：加载期根独立性 ------------------ */

test('R1-08 v2 配置含嵌套根时只授权第一个，第二个必须 UNAVAILABLE', async () => {
  const dir = await newDir();
  const parent = await mkdtemp(join(tmpdir(), 'ws-r1-nest-'));
  const child = join(parent, 'child');
  await mkdir(child, { recursive: true });
  try {
    const parentId = identityOf(parent);
    const childId = identityOf(child);
    await seedConfig(
      dir,
      [
        { projectId: 'parent', name: 'Parent', rootDir: parent, ...parentId, grantedAt: new Date().toISOString(), grantSource: 'os-dialog' },
        { projectId: 'child', name: 'Child', rootDir: child, ...childId, grantedAt: new Date().toISOString(), grantSource: 'os-dialog' },
      ],
      ['parent', 'child'],
    );

    const store = open(dir);
    try {
      const ctx = runtimeOver(store);
      assert.equal(ctx.runtime.stateOf('parent'), 'ACTIVE');
      assert.equal(ctx.runtime.stateOf('child'), 'UNAVAILABLE', '嵌套根不得同时获得读写权限');
      assert.equal(grantsFor(ctx.permission, 'parent'), 2);
      assert.equal(grantsFor(ctx.permission, 'child'), 0);
    } finally {
      store.close();
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('R1-09 v1 配置含重复根时也只授权第一个', async () => {
  const dir = await newDir();
  const rootDir = await mkdtemp(join(tmpdir(), 'ws-r1-dup-'));
  try {
    await writeFile(
      join(dir, CONFIG_FILE),
      JSON.stringify({
        version: 1,
        projects: [
          { projectId: 'one', name: 'One', rootDir },
          { projectId: 'two', name: 'Two', rootDir },
        ],
      }),
      'utf8',
    );

    const store = open(dir);
    try {
      const ctx = runtimeOver(store);
      assert.equal(ctx.runtime.stateOf('one'), 'UNAVAILABLE', 'v1 记录没有授权凭据，本就不该授权');
      assert.equal(ctx.runtime.stateOf('two'), 'UNAVAILABLE');
      assert.equal(grantsFor(ctx.permission, 'one') + grantsFor(ctx.permission, 'two'), 0);
    } finally {
      store.close();
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('R1-10 v2 配置含重复根（同一目录两个 id）时只授权第一个', async () => {
  const dir = await newDir();
  const rootDir = await mkdtemp(join(tmpdir(), 'ws-r1-same-'));
  try {
    const identity = identityOf(rootDir);
    await seedConfig(
      dir,
      [
        { projectId: 'one', name: 'One', rootDir, ...identity, grantedAt: new Date().toISOString(), grantSource: 'os-dialog' },
        { projectId: 'two', name: 'Two', rootDir, ...identity, grantedAt: new Date().toISOString(), grantSource: 'os-dialog' },
      ],
      ['one', 'two'],
    );

    const store = open(dir);
    try {
      const ctx = runtimeOver(store);
      assert.equal(ctx.runtime.stateOf('one'), 'ACTIVE');
      assert.equal(ctx.runtime.stateOf('two'), 'UNAVAILABLE', '同一目录不得有两个项目同时持有读写权限');
      assert.equal(grantsFor(ctx.permission, 'one'), 2);
      assert.equal(grantsFor(ctx.permission, 'two'), 0);
    } finally {
      store.close();
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
