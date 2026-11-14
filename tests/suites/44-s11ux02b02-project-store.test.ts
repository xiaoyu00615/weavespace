/**
 * UX-02B-02：真实 ProjectStore v2（配置 v2 + 墓碑日志 + 崩溃恢复 + 单实例锁 + opId 查询）。
 *
 * 取证方式：
 * - 全部使用**真实文件系统**（mkdtemp），崩溃点通过 `StoreIo` 故障注入复现，不依赖随机时序；
 * - "重启" = close() 后重新 `createFileProjectStore()`；
 * - 关键安全断言同时看三处：Store 报告的状态、Runtime 的 grants、以及磁盘上的字节。
 *
 * 覆盖：R-06 / R-06b / R-06c / R-07 / R-07b / R-07c / R-07d / R-07e / R-08 / R-08b /
 *       R-09 / R-15 / R-15b / R-16 / R-17 / R-17b，以及锁、原子写与运行期提交异常。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BACKUP_FILE,
  CONFIG_FILE,
  LOCK_FILE,
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
import { createDocumentService } from '../../packages/document/index.ts';
import { createPermissionService, type PermissionService } from '../../packages/permission/index.ts';
import { inspectProjectRoot } from '../../packages/project-registry/index.ts';
import { createShellServer } from '../../apps/server/src/server.ts';

/* ------------------------------- 基础设施 ------------------------------- */

async function newDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ws-store-'));
}

function open(dir: string, io?: StoreIo): FileProjectStore {
  return createFileProjectStore({ dir, ...(io ? { io } : {}) });
}

/** 一次"重启"：关掉旧实例再开新实例（等价于进程重启后重新加载）。 */
function restart(dir: string, io?: StoreIo): FileProjectStore {
  return open(dir, io);
}

async function readText(dir: string, name: string): Promise<string | undefined> {
  try {
    return await readFile(join(dir, name), 'utf8');
  } catch {
    return undefined;
  }
}

async function readJson(dir: string, name: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(dir, name);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** 可编程故障注入：只模拟 I/O 层，不改变 Store 的判定逻辑。 */
interface FaultPlan {
  /** 'zero' = 未写入 0 字节即报错；'after-write' = 已写入再报错（结果不确定）。 */
  append?: 'zero' | 'after-write';
  /** 配置 rename 阶段报错（墓碑之后）。 */
  rename?: boolean;
  /** fsync 报错（所有文件）。 */
  fsyncPath?: boolean;
  /** 只让撤销日志的 fsync 报错：行已写入，但持久化结论不确定。 */
  fsyncLog?: boolean;
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
      base.appendText(path, text);
    },
    rename(from, to) {
      if (plan.rename) throw new StoreIoError('rename-config', 0);
      base.rename(from, to);
    },
    fsyncPath(path) {
      if (plan.fsyncPath) throw new StoreIoError('fsync', undefined);
      if (plan.fsyncLog && path.endsWith(LOG_FILE)) throw new StoreIoError('fsync', undefined);
      base.fsyncPath(path);
    },
  };
}

interface RuntimeCtx {
  runtime: ProjectRuntime;
  permission: PermissionService;
  store: FileProjectStore;
  state(): ReturnType<FileProjectStore['loadState']>;
}

function runtimeOver(
  store: FileProjectStore,
  permission: PermissionService = createPermissionService([]),
): RuntimeCtx {
  const runtime = createProjectRuntime({
    actorId: 'local-user',
    document: createDocumentService(),
    permission,
    store,
    // 授权凭据是发 G-DISK 的唯一依据（P0-04）：测试显式声明"已由选择器确认"
    grantSource: 'os-dialog',
  });
  return { runtime, permission, store, state: () => store.loadState() };
}

/**
 * 写入一条**授权凭据完整**的记录（等价于 02B-03 的选择器确认）。
 * 只有这种记录才能在 Runtime 装载时换来 G-DISK 授权。
 */
async function trustedAdd(
  store: FileProjectStore,
  input: { projectId: string; name: string; rootDir: string; opId: string },
): Promise<void> {
  const inspected = inspectProjectRoot(input.rootDir);
  assert.equal(inspected.status, 'READY', `测试根必须可用: ${input.rootDir}`);
  await store.commitAdd({
    ...input,
    canonicalRoot: inspected.canonicalRoot,
    rootToken: inspected.rootToken,
    grantedAt: new Date().toISOString(),
    grantSource: 'os-dialog',
  });
}

function grantsFor(permission: PermissionService, projectId: string): number {
  return permission.grantsOf('local-user').filter((g) => g.providerId === `local:${projectId}`).length;
}

/* --------------------- 1. 首次初始化与基本持久化 --------------------- */

test('S-01 首次初始化：空目录正常启动并建立日志头', async () => {
  const dir = await newDir();
  try {
    const store = open(dir);
    try {
      const state = store.loadState();
      assert.equal(state.integrity, 'OK');
      assert.equal(state.diskTrusted, true);
      assert.equal(state.mutationsAllowed, true);
      assert.deepEqual(store.load(), []);
      assert.equal(existsSync(join(dir, LOG_FILE)), true, '必须建立日志头');
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-02 添加：commitSeq 单调、createdByOp 落盘、重启后仍在', async () => {
  const dir = await newDir();
  try {
    const store = open(dir);
    await store.commitAdd({
      projectId: 'notes',
      name: '笔记',
      rootDir: 'C:/tmp/notes',
      canonicalRoot: 'C:\\tmp\\notes',
      rootToken: 'dev:1:2',
      opId: 'op-add-1',
    });
    const after = await readJson(dir, CONFIG_FILE);
    assert.equal(after?.commitSeq, 1);
    assert.deepEqual(after?.issuedIds, ['notes']);
    const projects = after?.projects as Array<Record<string, unknown>>;
    assert.equal(projects[0]?.createdByOp, 'op-add-1');
    store.close();

    const reopened = restart(dir);
    try {
      assert.deepEqual(reopened.load().map((p) => p.projectId), ['notes']);
      assert.equal(reopened.loadState().commitSeq, 1);
      assert.equal(reopened.queryOp('op-add-1'), 'created');
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-03 撤销：墓碑 + revoked[] + issuedIds 永久保留', async () => {
  const dir = await newDir();
  try {
    const store = open(dir);
    await store.commitAdd({ projectId: 'a', name: 'A', rootDir: 'C:/tmp/a', opId: 'op-add' });
    const receipt = await store.commitRevoke({ projectId: 'a', opId: 'op-rm' });
    assert.equal(receipt.configPersisted, true);
    assert.deepEqual(store.load(), []);
    store.close();

    const log = (await readText(dir, LOG_FILE)) ?? '';
    assert.match(log, /op-rm/, '墓碑行必须包含本次 opId');
    const lastLine = log.split('\n').filter((line) => line !== '').at(-1) ?? '';
    const tombstone = JSON.parse(lastLine) as { seq: number };
    // seq 是全局提交序号（添加也消耗一个），必须与配置的 commitSeq 对齐
    assert.equal(tombstone.seq, 2);
    assert.equal((await readJson(dir, CONFIG_FILE))?.commitSeq, 2);

    const reopened = restart(dir);
    try {
      assert.deepEqual(reopened.load(), []);
      assert.equal(reopened.queryOp('op-rm'), 'revoked');
      const config = await readJson(dir, CONFIG_FILE);
      assert.deepEqual(config?.issuedIds, ['a'], 'issuedIds 只增不减');
      const revoked = config?.revoked as Array<Record<string, unknown>>;
      assert.equal(revoked[0]?.opId, 'op-rm');
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-04 R-09/已撤销 id 永不复用（含重启后）', async () => {
  const dir = await newDir();
  try {
    const store = open(dir);
    await store.commitAdd({ projectId: 'notes', name: 'N', rootDir: 'C:/tmp/n1', opId: 'op-1' });
    await store.commitRevoke({ projectId: 'notes', opId: 'op-2' });
    store.close();

    const reopened = restart(dir);
    try {
      // 运行期签发必须避开 issuedIds；Store 侧同样拒绝复用
      await assert.rejects(
        () => reopened.commitAdd({ projectId: 'notes', name: 'N', rootDir: 'C:/tmp/n2', opId: 'op-3' }),
        (err: { errorCode?: string }) => err.errorCode === 'ERR_STORE_ID_REUSED',
      );
      await reopened.commitAdd({ projectId: 'notes-2', name: 'N', rootDir: 'C:/tmp/n2', opId: 'op-4' });
      assert.deepEqual(reopened.load().map((p) => p.projectId), ['notes-2']);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* --------------------------- 2. 崩溃点与恢复 --------------------------- */

test('S-05 C3a/C3b 墓碑优先：配置文件滞后时重启后项目消失且无 grant', async () => {
  const dir = await newDir();
  try {
    const store = open(dir);
    await store.commitAdd({
      projectId: 'a',
      name: 'A',
      rootDir: 'C:/tmp/a',
      canonicalRoot: 'C:\\tmp\\a',
      rootToken: 'dev:1:2',
      opId: 'op-add',
    });
    const stale = await readJson(dir, CONFIG_FILE);
    await store.commitRevoke({ projectId: 'a', opId: 'op-rm' });
    store.close();

    // 模拟 C3b：墓碑已落盘、配置仍是旧版本（条目还在、commitSeq 少 1）
    await writeFile(join(dir, CONFIG_FILE), JSON.stringify(stale), 'utf8');

    const reopened = restart(dir);
    try {
      const state = reopened.loadState();
      assert.equal(state.diskTrusted, true, '墓碑领先一个合法序号属于"已知滞后"，不进受限');
      assert.equal(state.integrity, 'OK');
      assert.deepEqual(reopened.load(), [], '墓碑优先于配置');

      const permission = createPermissionService([]);
      const ctx = runtimeOver(reopened, permission);
      assert.equal(ctx.state().diskTrusted, true);
      assert.equal(grantsFor(permission, 'a'), 0, '不得因配置残留而复活授权');
      assert.equal(ctx.runtime.stateOf('a'), 'ABSENT');
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-06 R-06c 墓碑追加中断（半行）→ 受限且不发任何磁盘权限', async () => {
  const dir = await newDir();
  try {
    const store = open(dir);
    await store.commitAdd({ projectId: 'a', name: 'A', rootDir: 'C:/tmp/a', opId: 'op-add' });
    await store.commitAdd({ projectId: 'b', name: 'B', rootDir: 'C:/tmp/b', opId: 'op-add-b' });
    store.close();

    // 半行：合法 JSON 前缀但不完整
    const log = (await readText(dir, LOG_FILE)) ?? '';
    await writeFile(join(dir, LOG_FILE), `${log}{"seq":1,"projectId":"a","opId":"op-x"\n`, 'utf8');

    const reopened = restart(dir);
    try {
      const state = reopened.loadState();
      assert.equal(state.diskTrusted, false);
      assert.equal(state.integrity, 'RECOVERY_RESTRICTED');
      assert.equal(state.mutationsAllowed, false);

      const permission = createPermissionService([]);
      const ctx = runtimeOver(reopened, permission);
      assert.equal(grantsFor(permission, 'a'), 0);
      assert.equal(grantsFor(permission, 'b'), 0, '撤销集合不可证时一份权限都不发');
      assert.equal(ctx.runtime.stateOf('a'), 'UNAVAILABLE');
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-07 R-08b hash 链断裂 → 断裂点之前的撤销仍生效，但整体不授权', async () => {
  const dir = await newDir();
  try {
    const store = open(dir);
    await store.commitAdd({ projectId: 'a', name: 'A', rootDir: 'C:/tmp/a', opId: 'op-a' });
    await store.commitAdd({ projectId: 'b', name: 'B', rootDir: 'C:/tmp/b', opId: 'op-b' });
    await store.commitRevoke({ projectId: 'a', opId: 'op-rm-a' });
    await store.commitRevoke({ projectId: 'b', opId: 'op-rm-b' });
    store.close();

    const lines = ((await readText(dir, LOG_FILE)) ?? '').split('\n').filter((l) => l !== '');
    assert.equal(lines.length, 3, '一行日志头 + 两行墓碑');
    // 追加一条"hash 对不上"的伪造行：前缀（两行真实墓碑）仍完整，但链在这行断裂。
    // 这恰好把"逐行 hash 校验"单独暴露出来（prevHash 仍指向前一行的真实 hash）。
    const lastEntry = JSON.parse(lines[2]) as { seq: number; hash: string };
    const ghost = {
      seq: lastEntry.seq + 1,
      projectId: 'c',
      at: new Date().toISOString(),
      opId: 'op-ghost',
      prevHash: lastEntry.hash,
      hash: '0'.repeat(64),
    };
    await writeFile(join(dir, LOG_FILE), `${lines.join('\n')}\n${JSON.stringify(ghost)}\n`, 'utf8');

    const reopened = restart(dir);
    try {
      const state = reopened.loadState();
      assert.equal(state.log, 'broken');
      assert.equal(state.diskTrusted, false, '链断裂即"完整性不可证"');
      assert.equal(state.integrity, 'RECOVERY_RESTRICTED');
      // 断裂行里的 opId 不算证据（即便行本身能解析、字段齐全）
      assert.equal(reopened.queryOp('op-ghost'), 'unknown', '不可信证据不算证据');
      // 而配置 checksum 保护的 revoked[] 仍是合法证据
      assert.equal(reopened.queryOp('op-rm-b'), 'revoked');
      assert.equal(state.notes.length > 0, true, '必须给出可诊断的原因');
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* --------------------------- 3. 配置损坏与备份 --------------------------- */

test('S-08 R-07 主配置截断但日志完整 → 回落 .bak，可读不可变更', async () => {
  const dir = await newDir();
  try {
    const store = open(dir);
    await store.commitAdd({ projectId: 'a', name: 'A', rootDir: 'C:/tmp/a', opId: 'op-1' });
    await store.commitAdd({ projectId: 'b', name: 'B', rootDir: 'C:/tmp/b', opId: 'op-2' });
    store.close();

    const text = (await readText(dir, CONFIG_FILE)) ?? '';
    await writeFile(join(dir, CONFIG_FILE), text.slice(0, Math.floor(text.length / 2)), 'utf8');

    const reopened = restart(dir);
    try {
      const state = reopened.loadState();
      assert.equal(state.configSource, 'backup');
      assert.equal(state.integrity, 'RECOVERY_RESTRICTED');
      assert.equal(state.diskTrusted, true, '日志可证 → 允许按并集应用撤销后读写');
      assert.equal(state.mutationsAllowed, false, '配置来源是备份时禁止变更');
      // `.bak` 是上一版（两次添加之间只有一次备份），因此只能回到 b 之前的状态；
      // 关键安全结论是"不授权给不可证集合"，而不是"备份一定最新"。
      assert.deepEqual(reopened.load().map((p) => p.projectId).sort(), ['a']);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-09 主配置与备份都损坏 → 空表、零授权、禁止变更', async () => {
  const dir = await newDir();
  try {
    const store = open(dir);
    await store.commitAdd({ projectId: 'a', name: 'A', rootDir: 'C:/tmp/a', opId: 'op-1' });
    await store.commitAdd({ projectId: 'b', name: 'B', rootDir: 'C:/tmp/b', opId: 'op-2' });
    store.close();

    await writeFile(join(dir, CONFIG_FILE), '{"version":2,"commit', 'utf8');
    await writeFile(join(dir, BACKUP_FILE), 'not json at all', 'utf8');

    const reopened = restart(dir);
    try {
      const state = reopened.loadState();
      assert.equal(state.integrity, 'RECOVERY_RESTRICTED');
      assert.equal(state.diskTrusted, false);
      assert.deepEqual(reopened.load(), [], '不可信配置不得作为项目表');
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-10 R-07b 日志缺失 + commitSeq>0：即使配置 checksum 正确也不得授权', async () => {
  const dir = await newDir();
  try {
    const store = open(dir);
    await store.commitAdd({ projectId: 'a', name: 'A', rootDir: 'C:/tmp/a', opId: 'op-1' });
    store.close();
    assert.equal((await readJson(dir, CONFIG_FILE))?.commitSeq, 1);

    await rm(join(dir, LOG_FILE), { force: true });

    const reopened = restart(dir);
    try {
      const state = reopened.loadState();
      assert.equal(state.log, 'missing');
      assert.equal(state.diskTrusted, false, '配置校验通过 ≠ 撤销集合完整');

      const permission = createPermissionService([]);
      runtimeOver(reopened, permission);
      assert.equal(grantsFor(permission, 'a'), 0);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-11 R-07c 日志缺失且配置来自 .bak → 同样全拒', async () => {
  const dir = await newDir();
  try {
    const store = open(dir);
    await store.commitAdd({ projectId: 'a', name: 'A', rootDir: 'C:/tmp/a', opId: 'op-1' });
    await store.commitAdd({ projectId: 'b', name: 'B', rootDir: 'C:/tmp/b', opId: 'op-2' });
    store.close();

    const text = (await readText(dir, CONFIG_FILE)) ?? '';
    await writeFile(join(dir, CONFIG_FILE), text.slice(0, 20), 'utf8');
    await rm(join(dir, LOG_FILE), { force: true });

    const reopened = restart(dir);
    try {
      const state = reopened.loadState();
      assert.equal(state.configSource, 'backup');
      assert.equal(state.diskTrusted, false);
      assert.equal(state.integrity, 'RECOVERY_RESTRICTED');
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-12 R-07e 冷启动（commitSeq 0、无撤销、日志缺失）→ 正常并重建日志头', async () => {
  const dir = await newDir();
  try {
    const store = open(dir);
    store.close();

    // 只保留配置、删掉日志：commitSeq === 0 且 revoked 为空 → 无信息损失
    await rm(join(dir, LOG_FILE), { force: true });
    const config = await readJson(dir, CONFIG_FILE);
    assert.equal(config?.commitSeq, 0);
    assert.deepEqual(config?.revoked, []);

    const reopened = restart(dir);
    try {
      const state = reopened.loadState();
      assert.equal(state.diskTrusted, true);
      assert.equal(state.integrity, 'OK');
      assert.equal(state.log, 'created');
      assert.equal(existsSync(join(dir, LOG_FILE)), true);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-13 R-08 备份含已撤销项目 → 墓碑优先，不复活', async () => {
  const dir = await newDir();
  try {
    const store = open(dir);
    await store.commitAdd({ projectId: 'a', name: 'A', rootDir: 'C:/tmp/a', opId: 'op-1' });
    await store.commitAdd({ projectId: 'b', name: 'B', rootDir: 'C:/tmp/b', opId: 'op-2' });
    // 此时的 .bak 含 a、b 两条
    await store.commitRevoke({ projectId: 'a', opId: 'op-rm-a' });
    store.close();

    // 让主配置"损坏"，迫使加载回落到含 a 的旧备份
    const text = (await readText(dir, CONFIG_FILE)) ?? '';
    await writeFile(join(dir, CONFIG_FILE), text.slice(0, 10), 'utf8');

    const reopened = restart(dir);
    try {
      assert.deepEqual(reopened.load().map((p) => p.projectId), ['b'], '已撤销的 a 不得从备份复活');
      assert.equal(reopened.loadState().configSource, 'backup');
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-14 无法解释的序号差异（配置远领先日志）→ 受限', async () => {
  const dir = await newDir();
  try {
    const store = open(dir);
    await store.commitAdd({ projectId: 'a', name: 'A', rootDir: 'C:/tmp/a', opId: 'op-1' });
    store.close();

    // 配置声称 seq 7 发生过一次撤销，但日志里只有 seq 1（添加）→ 证据缺口无法解释
    const config = (await readJson(dir, CONFIG_FILE)) as Record<string, unknown>;
    const crafted = {
      version: 2 as const,
      commitSeq: 7,
      issuedIds: ['a'],
      revoked: [{ projectId: 'a', revokedAtSeq: 7, opId: 'op-evil' }],
      projects: [],
    };
    await writeFile(join(dir, CONFIG_FILE), serializeConfig(crafted), 'utf8');
    assert.ok(config.commitSeq === 1);

    const reopened = restart(dir);
    try {
      const state = reopened.loadState();
      assert.equal(state.diskTrusted, false);
      assert.equal(state.integrity, 'RECOVERY_RESTRICTED');
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* --------------------------- 4. 提交失败的分支 --------------------------- */

test('S-15 R-15 墓碑确认未写入（0 字节）→ 零变更、可重试', async () => {
  const dir = await newDir();
  const rootDir = await mkdtemp(join(tmpdir(), 'ws-store-root-'));
  try {
    const plan: FaultPlan = {};
    const store = open(dir, ioWith(plan));
    await trustedAdd(store, { projectId: 'a', name: 'A', rootDir, opId: 'op-add' });

    const permission = createPermissionService([]);
    const ctx = runtimeOver(store, permission);
    assert.equal(grantsFor(permission, 'a'), 2);

    plan.append = 'zero';
    await assert.rejects(
      () => ctx.runtime.removeProject('a'),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PERSIST_FAILED',
    );
    assert.equal(ctx.runtime.stateOf('a'), 'ACTIVE', '确认未写入才可回滚');
    assert.equal(grantsFor(permission, 'a'), 2, '授权必须原样保留');

    // 故障解除后可重试成功
    delete plan.append;
    const ok = await ctx.runtime.removeProject('a');
    assert.equal(ok.outcome, 'revoked');
    assert.equal(ctx.runtime.stateOf('a'), 'REMOVED');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-16 R-15b 墓碑已写入但追加报错 → 证据核对 + 重新 fsync 成功 → 撤销生效', async () => {
  const dir = await newDir();
  const rootDir = await mkdtemp(join(tmpdir(), 'ws-store-root-'));
  try {
    const plan: FaultPlan = {};
    const store = open(dir, ioWith(plan));
    await trustedAdd(store, { projectId: 'a', name: 'A', rootDir, opId: 'op-add' });

    const permission = createPermissionService([]);
    const ctx = runtimeOver(store, permission);

    plan.append = 'after-write'; // 行已落盘，但调用方拿到错误
    const outcome = await ctx.runtime.removeProject('a');
    assert.equal(outcome.outcome, 'revoked', '行完整可读且重新 fsync 成功才视为提交');
    assert.equal(ctx.runtime.stateOf('a'), 'REMOVED');
    assert.equal(grantsFor(permission, 'a'), 0);

    // 证据核对后只补 fsync，绝不重复追加同一墓碑
    const logText = (await readText(dir, LOG_FILE)) ?? '';
    assert.equal(
      logText.split((outcome as { opId: string }).opId).length - 1,
      1,
      '墓碑只能有一行',
    );

    store.close();
    const reopened = restart(dir);
    try {
      assert.deepEqual(reopened.load(), []);
      assert.equal(reopened.queryOp((outcome as { opId: string }).opId), 'revoked');
    } finally {
      reopened.close();
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-17 R-16 墓碑成功、配置写失败 → 立即不可访问，重启后 REMOVED，Store DEGRADED', async () => {
  const dir = await newDir();
  const rootDir = await mkdtemp(join(tmpdir(), 'ws-store-root-'));
  try {
    const plan: FaultPlan = {};
    const store = open(dir, ioWith(plan));
    await trustedAdd(store, { projectId: 'a', name: 'A', rootDir, opId: 'op-add' });

    const permission = createPermissionService([]);
    const ctx = runtimeOver(store, permission);

    plan.rename = true; // 墓碑已 fsync，配置 rename 失败
    const outcome = await ctx.runtime.removeProject('a');
    assert.equal(outcome.outcome, 'revoked');
    assert.equal((outcome as { configPersisted?: boolean }).configPersisted, false);

    assert.equal(ctx.runtime.stateOf('a'), 'REMOVED');
    assert.equal(grantsFor(permission, 'a'), 0, '配置写失败不得重新授权');
    assert.equal(store.loadState().integrity, 'DEGRADED');
    assert.equal(store.loadState().mutationsAllowed, false);
    store.close();

    const reopened = restart(dir);
    try {
      assert.deepEqual(reopened.load(), [], '重启后墓碑胜出');
      assert.equal(reopened.loadState().integrity, 'OK', '补齐后可自愈');
      const config = await readJson(dir, CONFIG_FILE);
      assert.deepEqual(config?.issuedIds, ['a']);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-18 配置写入成功但运行期提交异常 → 黑名单拒盘且 DEGRADED', async () => {
  const dir = await newDir();
  const rootDir = await mkdtemp(join(tmpdir(), 'ws-store-root-'));
  try {
    const store = open(dir);
    await trustedAdd(store, { projectId: 'a', name: 'A', rootDir, opId: 'op-add' });

    // revoke 抛错：模拟 §4.4 "墓碑已有、COMMIT 抛错"
    let remainingFailures = 1;
    const inner = createPermissionService([]);
    const permission: PermissionService = {
      authorize: (r) => inner.authorize(r),
      grant: (e) => inner.grant(e),
      grantsOf: (a) => inner.grantsOf(a),
      revoke: (e) => {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error('injected commit failure');
        }
        inner.revoke(e);
      },
    };

    const ctx = runtimeOver(store, permission);
    assert.equal(grantsFor(permission, 'a'), 2, '前置：项目必须真的拿到过授权');
    await assert.rejects(
      () => ctx.runtime.removeProject('a'),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PROJECT_REVOKE_UNKNOWN',
    );

    assert.equal(grantsFor(permission, 'a'), 0, '必须兜底强制撤销授权');
    assert.equal(ctx.runtime.stateOf('a'), 'REMOVED');
    assert.equal(store.loadState().integrity, 'DEGRADED');

    // 黑名单：即使状态被改写，也不得再放行磁盘
    assert.throws(
      () => ctx.runtime.assertUsable('a'),
      (err: { errorCode?: string }) => err.errorCode !== undefined,
    );

    assert.equal(remainingFailures, 0, '兜底必须重试过 revoke');
    store.close();
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------ 5. 单实例锁 ------------------------------ */

test('S-19 双实例竞争同一个 Store：第二个必须拒绝，释放后可接管', async () => {
  const dir = await newDir();
  try {
    const first = open(dir);
    try {
      assert.throws(
        () => open(dir),
        (err: { errorCode?: string }) => err.errorCode === 'ERR_STORE_LOCKED',
        '同一目录不得有两个写者',
      );
    } finally {
      first.close();
    }
    assert.equal(existsSync(join(dir, LOCK_FILE)), false, '正常关闭必须释放锁');

    const second = open(dir);
    try {
      assert.equal(second.loadState().integrity, 'OK');
    } finally {
      second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-20 异常退出留下的陈旧锁可被接管（不依赖进程存活回调）', async () => {
  const dir = await newDir();
  try {
    const first = open(dir);
    first.close();
    // 伪造一个"已死进程"的锁
    await writeFile(
      join(dir, LOCK_FILE),
      JSON.stringify({ pid: 999999, host: 'test', startedAt: new Date().toISOString(), token: 'stale' }),
      'utf8',
    );

    const reopened = open(dir);
    try {
      assert.equal(reopened.loadState().integrity, 'OK');
      const lock = JSON.parse((await readText(dir, LOCK_FILE)) ?? '{}') as Record<string, unknown>;
      assert.notEqual(lock.token, 'stale', '必须换成当前实例的锁');
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* --------------------- 6. opId 精确查询（R-17 / R-17b） --------------------- */

test('S-21 R-17/17b opId 只认精确匹配的持久证据', async () => {
  const dir = await newDir();
  try {
    const store = open(dir);
    await store.commitAdd({ projectId: 'notes', name: 'N', rootDir: 'C:/tmp/n1', opId: 'op-A' });
    assert.equal(store.queryOp('op-A'), 'created');
    assert.equal(store.queryOp('op-D'), 'unknown', '从未发生 → unknown，不得因项目存在而报 created');

    await store.commitRevoke({ projectId: 'notes', opId: 'op-B' });
    assert.equal(store.queryOp('op-B'), 'revoked');
    // 条目已删除 → op-A 的证据不复存在
    assert.equal(store.queryOp('op-A'), 'unknown');

    await store.commitAdd({ projectId: 'notes-2', name: 'N', rootDir: 'C:/tmp/n1', opId: 'op-C' });
    assert.equal(store.queryOp('op-C'), 'created');
    assert.equal(store.queryOp('op-D'), 'unknown');
    store.close();

    const reopened = restart(dir);
    try {
      assert.equal(reopened.queryOp('op-C'), 'created', '重启前后结论一致');
      assert.equal(reopened.queryOp('op-B'), 'revoked');
      assert.equal(reopened.queryOp('op-A'), 'unknown');
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-22 重命名的 opId 也可确认（改的是同一条目证据）', async () => {
  const dir = await newDir();
  try {
    const store = open(dir);
    await store.commitAdd({ projectId: 'a', name: 'A', rootDir: 'C:/tmp/a', opId: 'op-add' });
    await store.commitRename({ projectId: 'a', name: 'A2', opId: 'op-rename' });
    assert.equal(store.load()[0]?.name, 'A2');
    assert.equal(store.loadState().commitSeq, 2);
    // 重命名不改变 createdByOp；也不能把 op-rename 说成 created
    assert.equal(store.queryOp('op-add'), 'created');
    assert.equal(store.queryOp('op-rename'), 'unknown');
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* --------------------------- 7. 兼容与文件系统 --------------------------- */

test('S-23 v1 配置只读兼容：可加载，变更后写回 v2', async () => {
  const dir = await newDir();
  try {
    await writeFile(
      join(dir, CONFIG_FILE),
      JSON.stringify({ version: 1, projects: [{ projectId: 'legacy', name: 'L', rootDir: 'C:/tmp/l' }] }),
      'utf8',
    );

    const store = open(dir);
    try {
      assert.deepEqual(store.load().map((p) => p.projectId), ['legacy']);
      assert.equal(store.loadState().commitSeq, 0);
      await store.commitAdd({ projectId: 'b', name: 'B', rootDir: 'C:/tmp/b', opId: 'op-b' });
    } finally {
      store.close();
    }

    const config = await readJson(dir, CONFIG_FILE);
    assert.equal(config?.version, 2, '发生变更即写回 v2');
    assert.deepEqual(config?.issuedIds, ['legacy', 'b']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-24 原子写：不残留 tmp 文件，.bak 是上一版本', async () => {
  const dir = await newDir();
  try {
    const store = open(dir);
    await store.commitAdd({ projectId: 'a', name: 'A', rootDir: 'C:/tmp/a', opId: 'op-1' });
    const v1 = await readText(dir, CONFIG_FILE);
    await store.commitAdd({ projectId: 'b', name: 'B', rootDir: 'C:/tmp/b', opId: 'op-2' });
    store.close();

    const { readdir } = await import('node:fs/promises');
    const files = await readdir(dir);
    assert.equal(files.some((f) => f.includes('.tmp')), false, '不得残留 tmp 文件');
    const backup = await readText(dir, BACKUP_FILE);
    assert.equal(backup, v1, '.bak 必须是上一份配置');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-25 R-10 配置记录的根令牌与当前不一致 → UNAVAILABLE，且不改写配置', async () => {
  const dir = await newDir();
  const rootDir = await mkdtemp(join(tmpdir(), 'ws-store-root-'));
  try {
    const store = open(dir);
    await store.commitAdd({
      projectId: 'a',
      name: 'A',
      rootDir,
      canonicalRoot: rootDir,
      rootToken: 'dev:999:999', // 与真实根不符
      opId: 'op-1',
    });
    const before = await readText(dir, CONFIG_FILE);

    const permission = createPermissionService([]);
    const ctx = runtimeOver(store, permission);
    assert.equal(ctx.runtime.stateOf('a'), 'UNAVAILABLE');
    assert.equal(grantsFor(permission, 'a'), 0, '根身份不一致不得授权');
    assert.equal(await readText(dir, CONFIG_FILE), before, '不得自动 adopt 或改写配置');
    store.close();
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-26 受限状态下 G-DISK 全拒、变更 503，草稿端点不受影响', async () => {
  const dir = await newDir();
  const rootDir = await mkdtemp(join(tmpdir(), 'ws-store-root-'));
  try {
    const store = open(dir);
    await store.commitAdd({
      projectId: 'a',
      name: 'A',
      rootDir,
      canonicalRoot: rootDir,
      opId: 'op-1',
    });
    store.close();

    // 制造"日志缺失 + commitSeq>0"：撤销集合不可证
    await rm(join(dir, LOG_FILE), { force: true });

    const serving = open(dir);
    let runtimeRef: ProjectRuntime | undefined;
    const server = await createShellServer({
      port: 0,
      managed: {
        create: (deps) => {
          runtimeRef = createProjectRuntime({ ...deps, store: serving });
          return runtimeRef;
        },
      },
    });
    try {
      assert.equal(serving.loadState().diskTrusted, false);
      const resources = await fetch(`${server.url}/api/resources?projectId=a`);
      assert.equal(resources.status, 503, '不得发放任何 G-DISK 授权');

      const projects = (await (await fetch(`${server.url}/api/projects`)).json()) as {
        projects: Array<{ projectId: string; status: string }>;
      };
      assert.equal(projects.projects[0]?.status, 'UNAVAILABLE', '条目仅供诊断，不得 READY');

      // 变更被禁止
      await assert.rejects(
        () => (runtimeRef as ProjectRuntime).addProject({ name: 'b', rootDir }),
        (err: { errorCode?: string }) => err.errorCode === 'ERR_STORE_RESTRICTED',
      );
    } finally {
      await server.close();
      serving.close();
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-27 日志 fsync 持续失败 → 持久化未确认，保持 UNKNOWN 且不重复追加墓碑', async () => {
  const dir = await newDir();
  const rootDir = await mkdtemp(join(tmpdir(), 'ws-store-root-'));
  try {
    const plan: FaultPlan = {};
    const store = open(dir, ioWith(plan));
    await trustedAdd(store, { projectId: 'a', name: 'A', rootDir, opId: 'op-add' });

    const permission = createPermissionService([]);
    const ctx = runtimeOver(store, permission);
    assert.equal(grantsFor(permission, 'a'), 2);

    plan.fsyncLog = true; // append 成功，fsync（含重新同步）失败：持久化结论不确定
    await assert.rejects(
      () => ctx.runtime.removeProject('a'),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PROJECT_REVOKE_UNKNOWN',
      '仅"墓碑可读"不能证明持久化提交成功',
    );
    assert.equal(ctx.runtime.stateOf('a'), 'REVOKE_UNKNOWN', '不得据此恢复 ACTIVE');
    assert.equal(grantsFor(permission, 'a'), 0);
    assert.equal(store.loadState().integrity, 'DEGRADED');
    assert.equal(store.loadState().mutationsAllowed, false);

    // 不重复追加墓碑，也不补写配置
    const logText = (await readText(dir, LOG_FILE)) ?? '';
    assert.equal(logText.split('"opId":"op-').length - 1, 1, '墓碑只能有一行');
    assert.equal((await readJson(dir, CONFIG_FILE))?.commitSeq, 1);

    plan.fsyncLog = false;
    assert.equal(ctx.runtime.stateOf('a'), 'REVOKE_UNKNOWN', '故障解除也不自动恢复');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('S-28 项目 A 的撤销失败不影响项目 B 的权限与可读性', async () => {
  const dir = await newDir();
  const rootA = await mkdtemp(join(tmpdir(), 'ws-store-a-'));
  const rootB = await mkdtemp(join(tmpdir(), 'ws-store-b-'));
  try {
    const plan: FaultPlan = {};
    const store = open(dir, ioWith(plan));
    await trustedAdd(store, { projectId: 'a', name: 'A', rootDir: rootA, opId: 'op-a' });
    await trustedAdd(store, { projectId: 'b', name: 'B', rootDir: rootB, opId: 'op-b' });

    const permission = createPermissionService([]);
    const ctx = runtimeOver(store, permission);
    assert.equal(grantsFor(permission, 'a'), 2);
    assert.equal(grantsFor(permission, 'b'), 2);

    plan.append = 'zero'; // A 的墓碑提交确认未写入
    await assert.rejects(
      () => ctx.runtime.removeProject('a'),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PERSIST_FAILED',
    );

    assert.equal(ctx.runtime.stateOf('a'), 'ACTIVE', 'A 回 ACTIVE，零变更');
    assert.equal(grantsFor(permission, 'a'), 2);
    assert.equal(grantsFor(permission, 'b'), 2, 'B 的授权不得被错误扩展或收回');
    assert.equal(ctx.runtime.stateOf('b'), 'ACTIVE');
    assert.ok(ctx.runtime.assertUsable('b').canonicalRoot, 'B 仍可正常取到磁盘句柄');
    assert.equal(store.queryOp('op-b'), 'created');

    delete plan.append;
    const removed = await ctx.runtime.removeProject('a');
    assert.equal(removed.outcome, 'revoked');
    assert.equal(ctx.runtime.stateOf('b'), 'ACTIVE', 'A 的撤销不得影响 B');
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
