/**
 * UX-02B-02-R2：撤销提交点的证据强度，以及日志有效前缀被截断。
 *
 * 问题一（提交点）：append + fsync 失败时，"日志里能看到本次 opId"**不等于**
 * "持久化已提交"。必须区分：
 *   (a) 确认零字节写入        → not-committed（回 ACTIVE，可重试）
 *   (b) 行完整可读、同步未确认 → 只补 fsync，成功才算提交；失败即 UNKNOWN
 *   (c) 行完整可读、重新 fsync 成功 → 继续完成撤销
 *   (d) 尾部损坏 / 日志消失    → 日志不可证，全局 fail-closed
 *
 * 问题二（前缀）：`config.revoked[]` 的每一条都要在日志里有 projectId + opId + seq
 * 完全对应的墓碑；运行期已确认的日志前缀不允许无证据回退。
 *
 * 取证：真实文件系统 + 确定性 I/O 故障注入（不依赖随机时序）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CONFIG_FILE,
  LOG_FILE,
  LOG_HEAD_HASH,
  StoreIoError,
  createFileProjectStore,
  createNodeStoreIo,
  type FileProjectStore,
  type StoreIo,
} from '../../apps/server/src/store/index.ts';
import { headerLine, revocationLine } from '../../apps/server/src/store/revocation-log.ts';
import { createProjectRuntime, type ProjectRuntime } from '../../apps/server/src/project-runtime.ts';
import { createDocumentService } from '../../packages/document/index.ts';
import { createPermissionService, type PermissionService } from '../../packages/permission/index.ts';
import { inspectProjectRoot } from '../../packages/project-registry/index.ts';

/* ------------------------------- 基础设施 ------------------------------- */

async function newDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ws-r2-'));
}

async function newRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `ws-r2-${prefix}-`));
}

interface FaultPlan {
  /** 'zero' = 0 字节即报错；'after-write' = 整行写完再报错；'half' = 半行后报错。 */
  append?: 'zero' | 'after-write' | 'half';
  /** 只让撤销日志的 fsync 失败（行已写入，持久化未确认）。 */
  fsyncLog?: boolean;
  /** 配置 rename 阶段报错（墓碑已生效，配置补写失败）。 */
  rename?: boolean;
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
        const half = text.slice(0, Math.max(1, Math.floor(text.length / 2)));
        base.appendText(path, half);
        throw new StoreIoError('append-log', half.length);
      }
      base.appendText(path, text);
    },
    fsyncPath(path) {
      if (plan.fsyncLog && path.endsWith(LOG_FILE)) throw new StoreIoError('fsync', undefined);
      base.fsyncPath(path);
    },
    rename(from, to) {
      if (plan.rename) throw new StoreIoError('rename-config', 0);
      base.rename(from, to);
    },
  };
}

function open(dir: string, io?: StoreIo): FileProjectStore {
  return createFileProjectStore({ dir, ...(io ? { io } : {}) });
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

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
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

function runtimeOver(store: FileProjectStore, permission = createPermissionService([])): Ctx {
  const runtime = createProjectRuntime({
    actorId: 'local-user',
    document: createDocumentService(),
    permission,
    store,
    grantSource: 'os-dialog',
  });
  return { runtime, permission, store };
}

/** 只保留日志头 + 前 n 行墓碑（模拟"有效的历史前缀被截断"）。 */
async function truncateLog(dir: string, keepTombstones: number): Promise<void> {
  const text = (await readText(dir, LOG_FILE)) ?? '';
  const lines = text.split('\n').filter((line) => line !== '');
  assert.ok(lines.length >= 1, '日志至少要有表头');
  const kept = [lines[0], ...lines.slice(1, 1 + keepTombstones)];
  await writeFile(join(dir, LOG_FILE), `${kept.join('\n')}\n`, 'utf8');
}

/* ------------------ 问题一：fsync 失败不等于提交成功 ------------------ */

test('R2-01 日志 fsync 持续失败（行已完整写入）→ UNKNOWN，且不重复追加墓碑', async () => {
  const dir = await newDir();
  const rootA = await newRoot('a');
  try {
    const plan: FaultPlan = {};
    const store = open(dir, ioWith(plan));
    const ctx = runtimeOver(store);
    const a = await ctx.runtime.addProject({ name: 'A', rootDir: rootA });
    assert.equal(grantsFor(ctx.permission, a.projectId), 2);

    plan.fsyncLog = true; // 行能写进去，但同步始终未确认
    await assert.rejects(
      () => ctx.runtime.removeProject(a.projectId),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PROJECT_REVOKE_UNKNOWN',
      '仅"墓碑可读"不能证明持久化提交成功',
    );

    // 目标项目：磁盘权限切断，且不是 ACTIVE（也不假装已彻底移除）
    assert.equal(ctx.runtime.stateOf(a.projectId), 'REVOKE_UNKNOWN');
    assert.equal(grantsFor(ctx.permission, a.projectId), 0);
    assert.throws(
      () => ctx.runtime.assertUsable(a.projectId),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PROJECT_REVOKE_UNKNOWN',
    );

    // 不重复追加同一墓碑；配置没有被补写
    const log = (await readText(dir, LOG_FILE)) ?? '';
    assert.equal(countOf(log, 'op-'), 1, `墓碑只能有一行: ${log}`);
    const config = await readJson(dir, CONFIG_FILE);
    assert.equal(config?.commitSeq, 1, '配置补写不应发生');
    assert.deepEqual(config?.revoked, []);
    assert.equal((config?.projects as unknown[]).length, 1);
    assert.equal(store.loadState().integrity, 'DEGRADED');
    assert.equal(store.loadState().mutationsAllowed, false, '持久化结论未知时不得继续变更');

    // 不得因"故障解除"自动恢复 ACTIVE
    plan.fsyncLog = false;
    assert.equal(ctx.runtime.stateOf(a.projectId), 'REVOKE_UNKNOWN');
    assert.equal(grantsFor(ctx.permission, a.projectId), 0);

    store.close();
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('R2-02 追加报错但行完整、重新 fsync 成功 → 撤销完成，且只写一行', async () => {
  const dir = await newDir();
  const rootA = await newRoot('a');
  try {
    const plan: FaultPlan = {};
    const store = open(dir, ioWith(plan));
    const ctx = runtimeOver(store);
    const a = await ctx.runtime.addProject({ name: 'A', rootDir: rootA });

    plan.append = 'after-write';
    const outcome = await ctx.runtime.removeProject(a.projectId);
    assert.equal(outcome.outcome, 'revoked');
    const opId = (outcome as { opId: string }).opId;

    const log = (await readText(dir, LOG_FILE)) ?? '';
    assert.equal(countOf(log, opId), 1, '不重复追加同一墓碑');
    assert.equal(store.loadState().integrity, 'OK', '重新同步成功即视为已提交');
    assert.equal(ctx.runtime.stateOf(a.projectId), 'REMOVED');
    assert.equal(grantsFor(ctx.permission, a.projectId), 0);
    const config = await readJson(dir, CONFIG_FILE);
    assert.deepEqual(config?.revoked, [{ projectId: a.projectId, revokedAtSeq: 2, opId }]);

    plan.append = undefined;
    store.close();
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('R2-03 半行墓碑（追加中断）→ 日志不可证，全局 fail-closed', async () => {
  const dir = await newDir();
  const rootA = await newRoot('a');
  const rootB = await newRoot('b');
  try {
    const plan: FaultPlan = {};
    const store = open(dir, ioWith(plan));
    const ctx = runtimeOver(store);
    const a = await ctx.runtime.addProject({ name: 'A', rootDir: rootA });
    const b = await ctx.runtime.addProject({ name: 'B', rootDir: rootB });

    plan.append = 'half';
    await assert.rejects(
      () => ctx.runtime.removeProject(a.projectId),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PROJECT_REVOKE_UNKNOWN',
    );
    assert.equal(ctx.runtime.stateOf(a.projectId), 'REVOKE_UNKNOWN');
    assert.equal(store.loadState().diskTrusted, false);
    assert.equal(store.loadState().integrity, 'RECOVERY_RESTRICTED');

    // 尾部损坏属于"日志不可证"：其它项目也不能继续读写磁盘
    assert.throws(
      () => ctx.runtime.assertUsable(b.projectId),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_STORE_RESTRICTED',
    );

    plan.append = undefined;
    store.close();
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('R2-04 确认零字节写入 → not-committed，回 ACTIVE 且授权保留', async () => {
  const dir = await newDir();
  const rootA = await newRoot('a');
  try {
    const plan: FaultPlan = {};
    const store = open(dir, ioWith(plan));
    const ctx = runtimeOver(store);
    const a = await ctx.runtime.addProject({ name: 'A', rootDir: rootA });

    plan.append = 'zero';
    await assert.rejects(
      () => ctx.runtime.removeProject(a.projectId),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PERSIST_FAILED',
    );
    assert.equal(ctx.runtime.stateOf(a.projectId), 'ACTIVE');
    assert.equal(grantsFor(ctx.permission, a.projectId), 2, '确认未写入才允许保持授权');
    assert.ok(ctx.runtime.assertUsable(a.projectId).canonicalRoot);
    assert.equal((await readJson(dir, CONFIG_FILE))?.commitSeq, 1);

    // 故障解除后可以真的撤销
    plan.append = undefined;
    const retried = await ctx.runtime.removeProject(a.projectId);
    assert.equal(retried.outcome, 'revoked');
    assert.equal(ctx.runtime.stateOf(a.projectId), 'REMOVED');
    store.close();
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------ 问题二：日志有效前缀被截断 ------------------ */

test('R2-05 配置已记录撤销、运行期把日志截断为表头 → 拒绝变更并全局拒盘', async () => {
  const dir = await newDir();
  const rootA = await newRoot('a');
  const rootB = await newRoot('b');
  try {
    const store = open(dir);
    const ctx = runtimeOver(store);
    const a = await ctx.runtime.addProject({ name: 'A', rootDir: rootA });
    const b = await ctx.runtime.addProject({ name: 'B', rootDir: rootB });
    await ctx.runtime.removeProject(a.projectId);

    // 运行期把撤销历史抹掉（只剩合法的表头）
    await writeFile(join(dir, LOG_FILE), headerLine(), 'utf8');

    await assert.rejects(
      () => ctx.runtime.removeProject(b.projectId),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_STORE_RESTRICTED',
      '配置声明的撤销在日志里没有对应墓碑时，不得继续提交',
    );
    assert.equal(store.loadState().diskTrusted, false);
    assert.equal(store.loadState().integrity, 'RECOVERY_RESTRICTED');
    assert.throws(
      () => ctx.runtime.assertUsable(b.projectId),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_STORE_RESTRICTED',
    );
    assert.equal(
      await readText(dir, LOG_FILE),
      headerLine(),
      '不得自动重建日志链，也不得覆盖原有证据',
    );
    store.close();
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('R2-06 日志只剩较早的墓碑（丢掉最后一条）→ 拒绝变更', async () => {
  const dir = await newDir();
  const rootA = await newRoot('a');
  const rootB = await newRoot('b');
  const rootC = await newRoot('c');
  try {
    const store = open(dir);
    const ctx = runtimeOver(store);
    const a = await ctx.runtime.addProject({ name: 'A', rootDir: rootA });
    const b = await ctx.runtime.addProject({ name: 'B', rootDir: rootB });
    const c = await ctx.runtime.addProject({ name: 'C', rootDir: rootC });
    await ctx.runtime.removeProject(a.projectId);
    await ctx.runtime.removeProject(b.projectId);

    const config = await readJson(dir, CONFIG_FILE);
    assert.equal(config?.commitSeq, 5);
    const revoked = config?.revoked as Array<{ projectId: string }>;
    assert.deepEqual(revoked.map((entry) => entry.projectId), [a.projectId, b.projectId]);

    // 保留表头 + 第一条墓碑：最大序号(4) 仍 ≤ commitSeq+1(6)，但 B 的证据没了
    await truncateLog(dir, 1);

    await assert.rejects(
      () => ctx.runtime.removeProject(c.projectId),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_STORE_RESTRICTED',
    );
    assert.equal(store.loadState().diskTrusted, false);
    assert.throws(
      () => ctx.runtime.assertUsable(c.projectId),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_STORE_RESTRICTED',
    );
    store.close();
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
    await rm(rootC, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('R2-07 加载期：撤销行的 opId 与配置不符 → 不可信、零授权', async () => {
  const dir = await newDir();
  const rootA = await newRoot('a');
  const rootB = await newRoot('b');
  try {
    const store = open(dir);
    await store.commitAdd({
      projectId: 'a',
      name: 'A',
      rootDir: rootA,
      ...identityOf(rootA),
      grantedAt: new Date().toISOString(),
      grantSource: 'os-dialog',
      opId: 'op-add-a',
    });
    await store.commitAdd({
      projectId: 'b',
      name: 'B',
      rootDir: rootB,
      ...identityOf(rootB),
      grantedAt: new Date().toISOString(),
      grantSource: 'os-dialog',
      opId: 'op-add-b',
    });
    await store.commitRevoke({ projectId: 'b', opId: 'op-rm-b' });
    store.close();

    // 用一条**哈希链完全自洽**的行替换 B 的墓碑：seq 对得上，但 opId 不是配置记录的那次
    const forged = revocationLine({
      seq: 3,
      projectId: 'b',
      at: new Date().toISOString(),
      opId: 'op-forged',
      prevHash: LOG_HEAD_HASH,
    });
    await writeFile(join(dir, LOG_FILE), `${headerLine()}${forged}`, 'utf8');

    const reopened = open(dir);
    try {
      const state = reopened.loadState();
      assert.equal(state.diskTrusted, false, '证据不能靠"最大序号覆盖"来蒙混');
      assert.equal(state.integrity, 'RECOVERY_RESTRICTED');
      const ctx = runtimeOver(reopened);
      assert.equal(grantsFor(ctx.permission, 'a'), 0);
      assert.throws(
        () => ctx.runtime.assertUsable('a'),
        (err: { errorCode?: string }) => err.errorCode === 'ERR_STORE_RESTRICTED',
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('R2-10 运行期日志被换成"同序号、不同 opId"的自洽链 → 拒绝变更', async () => {
  const dir = await newDir();
  const rootA = await newRoot('a');
  const rootB = await newRoot('b');
  try {
    const store = open(dir);
    const ctx = runtimeOver(store);
    const a = await ctx.runtime.addProject({ name: 'A', rootDir: rootA });
    const b = await ctx.runtime.addProject({ name: 'B', rootDir: rootB });
    const removed = await ctx.runtime.removeProject(a.projectId);
    const realOp = (removed as { opId: string }).opId;

    // 同序号(3)、哈希链自洽，但 opId 不是配置记录的那一次：最大序号与"前缀回退"都发现不了
    const forged = revocationLine({
      seq: 3,
      projectId: a.projectId,
      at: new Date().toISOString(),
      opId: 'op-forged',
      prevHash: LOG_HEAD_HASH,
    });
    await writeFile(join(dir, LOG_FILE), `${headerLine()}${forged}`, 'utf8');
    assert.notEqual(realOp, 'op-forged');

    await assert.rejects(
      () => ctx.runtime.removeProject(b.projectId),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_STORE_RESTRICTED',
      '每一条配置撤销都必须有 projectId + opId + seq 完全对应的墓碑',
    );
    assert.equal(store.loadState().diskTrusted, false);
    assert.equal(store.loadState().integrity, 'RECOVERY_RESTRICTED');
    assert.throws(
      () => ctx.runtime.assertUsable(b.projectId),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_STORE_RESTRICTED',
    );
    store.close();
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('R2-08 运行期已验证的日志前缀不得无证据回退', async () => {
  const dir = await newDir();
  const rootA = await newRoot('a');
  const rootB = await newRoot('b');
  try {
    const plan: FaultPlan = {};
    const store = open(dir, ioWith(plan));
    const ctx = runtimeOver(store);
    const a = await ctx.runtime.addProject({ name: 'A', rootDir: rootA });
    const b = await ctx.runtime.addProject({ name: 'B', rootDir: rootB });

    // 墓碑 seq=3 落盘，但配置补写失败 → 配置 commitSeq=2，日志领先一个序号（合法）
    plan.append = 'after-write';
    plan.rename = true;
    const pending = await ctx.runtime.removeProject(a.projectId);
    assert.equal(pending.outcome, 'revoked');
    assert.equal((pending as { configPersisted?: boolean }).configPersisted, false);
    store.close();
    plan.append = undefined;
    plan.rename = false;

    const reopened = open(dir);
    try {
      const state = reopened.loadState();
      assert.equal(state.diskTrusted, true, '墓碑领先配置一个序号是合法恢复路径');
      assert.deepEqual(reopened.load().map((project) => project.projectId), [b.projectId]);

      const ctx2 = runtimeOver(reopened);
      assert.equal(ctx2.runtime.stateOf(b.projectId), 'ACTIVE', '前置：B 正常可用');

      // 运行期把日志抹成表头：config.revoked 为空，序号对账也自洽 —— 只剩"前缀回退"能发现
      await writeFile(join(dir, LOG_FILE), headerLine(), 'utf8');

      await assert.rejects(
        () => ctx2.runtime.removeProject(b.projectId),
        (err: { errorCode?: string }) => err.errorCode === 'ERR_STORE_RESTRICTED',
      );
      assert.equal(reopened.loadState().diskTrusted, false);
      assert.throws(
        () => ctx2.runtime.assertUsable(b.projectId),
        (err: { errorCode?: string }) => err.errorCode === 'ERR_STORE_RESTRICTED',
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('R2-09 合法"墓碑领先配置一个序号"仍可加载并继续提交', async () => {
  const dir = await newDir();
  const rootA = await newRoot('a');
  const rootB = await newRoot('b');
  try {
    const plan: FaultPlan = {};
    const store = open(dir, ioWith(plan));
    const ctx = runtimeOver(store);
    const a = await ctx.runtime.addProject({ name: 'A', rootDir: rootA });
    const b = await ctx.runtime.addProject({ name: 'B', rootDir: rootB });

    plan.append = 'after-write'; // 墓碑落盘、配置补写失败
    plan.rename = true;
    await ctx.runtime.removeProject(a.projectId);
    store.close();
    plan.append = undefined;
    plan.rename = false;

    const reopened = open(dir);
    try {
      const state = reopened.loadState();
      assert.equal(state.diskTrusted, true);
      assert.equal(state.commitSeq, 2);
      assert.deepEqual(reopened.load().map((project) => project.projectId), [b.projectId]);

      const ctx2 = runtimeOver(reopened);
      const removed = await ctx2.runtime.removeProject(b.projectId);
      assert.equal(removed.outcome, 'revoked', '滞后仍可继续提交');
      assert.equal(reopened.queryOp((removed as { opId: string }).opId), 'revoked');
      assert.equal(
        (await readJson(dir, CONFIG_FILE))?.commitSeq,
        4,
        'seq 按日志与配置的较大者推进',
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------- 小工具 ------------------------------- */

function identityOf(rootDir: string): { canonicalRoot: string; rootToken: string } {
  const inspected = inspectProjectRoot(rootDir);
  assert.equal(inspected.status, 'READY', `测试根必须可用: ${rootDir}`);
  return { canonicalRoot: inspected.canonicalRoot, rootToken: inspected.rootToken };
}
