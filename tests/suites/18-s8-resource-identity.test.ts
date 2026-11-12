/**
 * S8：资源身份与授权绑定回归。
 *
 * 纪律：
 * - 本文件先于修复编写，基线（83e4149）上必须失败；
 * - 每条断言都检查「状态 + 真实磁盘字节 / 会话状态」，不能只看错误字符串；
 * - 只在自建临时目录内操作；不接触用户资产、不改 ACL。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHarness, writeProjectFile } from '../helpers.ts';
import { createLocalProvider } from '../../packages/storage/index.ts';
import { createPermissionService } from '../../packages/permission/index.ts';
import { createDocumentService } from '../../packages/document/index.ts';
import { createCommandBus } from '../../packages/command/index.ts';

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const errorCodeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return 'NO_ERROR';
  } catch (err) {
    return (err as { errorCode?: string }).errorCode ?? `RAW:${(err as NodeJS.ErrnoException).code}`;
  }
};

// ---------------------------------------------------------------------------
// S8-01：同一 resourceId 命中已有会话时，必须校验身份一致性
// ---------------------------------------------------------------------------
test('S8-01 同 resourceId + 不同 path：必须抛 ERR_RESOURCE_IDENTITY_CONFLICT，且不产生副作用', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'docs/a.md', 'A\n');
    await writeProjectFile(h.root, 'secret/x.md', 'SECRET\n');
    const aFile = join(h.root, 'docs/a.md');
    const xFile = join(h.root, 'secret/x.md');
    const aBefore = sha256(await readFile(aFile));
    const xBefore = sha256(await readFile(xFile));

    const v1 = await h.document.openSession({ resourceId: 'R1', path: 'docs/a.md', provider: h.provider });

    assert.equal(
      await errorCodeOf(() =>
        h.document.openSession({ resourceId: 'R1', path: 'secret/x.md', provider: h.provider }),
      ),
      'ERR_RESOURCE_IDENTITY_CONFLICT',
      '同一 resourceId 指向不同路径必须拒绝，不得静默复用',
    );

    // 副作用：磁盘与会话均不得被改动
    assert.equal(sha256(await readFile(aFile)), aBefore);
    assert.equal(sha256(await readFile(xFile)), xBefore);
    assert.equal(h.document.getBuffer(v1.sessionId), 'A\n');
    assert.equal(h.document.getSession(v1.sessionId)?.revision, 0);
  } finally {
    await h.cleanup();
  }
});

test('S8-02 同 resourceId + 不同存储根（providerId 相同）：必须拒绝', async () => {
  const h = await createHarness();
  const otherRoot = await mkdtemp(join(tmpdir(), 's8-other-'));
  try {
    await writeProjectFile(h.root, 'docs/a.md', 'A\n');
    await mkdir(join(otherRoot, 'docs'), { recursive: true });
    await writeFile(join(otherRoot, 'docs/a.md'), 'OTHER\n', 'utf8');

    const other = createLocalProvider({ rootDir: otherRoot });
    const v1 = await h.document.openSession({ resourceId: 'R2', path: 'docs/a.md', provider: h.provider });

    assert.equal(
      await errorCodeOf(() =>
        h.document.openSession({ resourceId: 'R2', path: 'docs/a.md', provider: other }),
      ),
      'ERR_RESOURCE_IDENTITY_CONFLICT',
      'providerId 字符串相同但存储根不同，不得视为同一资源',
    );
    assert.equal(h.document.getBuffer(v1.sessionId), 'A\n');
    assert.equal(await readFile(join(otherRoot, 'docs/a.md'), 'utf8'), 'OTHER\n');
  } finally {
    await h.cleanup();
    await rm(otherRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test('S8-03 相同资源多视图仍共享同一 Session（防过度修复）', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'docs/a.md', 'A\n');
    const v1 = await h.document.openSession({ resourceId: 'R3', path: 'docs/a.md', provider: h.provider });
    const v2 = await h.document.openSession({ resourceId: 'R3', path: 'docs/a.md', provider: h.provider });

    assert.equal(v1.sessionId, v2.sessionId);
    assert.equal(h.document.getSession(v1.sessionId)?.views, 2);

    h.document.applyEdit(v1.sessionId, 'A2\n');
    assert.equal(h.document.getBuffer(v2.sessionId), 'A2\n', '视图必须共享同一权威缓冲');
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S8-02：授权必须绑定实际资源，而不是调用方声称的 path
// ---------------------------------------------------------------------------
test('S8-04 仅 docs 写权限：伪造 payload.path 不能保存 secret 会话', async () => {
  const h = await createHarness({
    grants: [
      { actorId: 'user', action: 'read', scope: 'docs' },
      { actorId: 'user', action: 'write', scope: 'docs' },
    ],
  });
  try {
    await writeProjectFile(h.root, 'docs/a.md', 'A\n');
    await writeProjectFile(h.root, 'secret/x.md', 'SECRET\n');
    const secretFile = join(h.root, 'secret/x.md');
    const before = sha256(await readFile(secretFile));

    const v = await h.document.openSession({ resourceId: 'R4', path: 'secret/x.md', provider: h.provider });
    h.document.applyEdit(v.sessionId, 'PWNED\n');
    const base = h.document.getSession(v.sessionId)!.baseVersion!;
    const revision = h.document.getSession(v.sessionId)!.revision;

    // ① 不声明 path：授权必须回落到会话的实际路径 → 无权限
    const noClaim = await h.bus.dispatch(
      {
        commandId: 'c-s8-04a',
        type: 'document.save',
        expectedVersion: base,
        payload: { sessionId: v.sessionId },
      },
      { actorId: 'user' },
    );
    assert.equal(noClaim.status, 'REJECTED');
    assert.equal(noClaim.errorCode, 'ERR_PERMISSION_DENIED', '授权必须针对实际会话路径');

    // ② 伪造 path 声称在授权范围内：与真实会话不一致 → 拒绝
    const forged = await h.bus.dispatch(
      {
        commandId: 'c-s8-04b',
        type: 'document.save',
        expectedVersion: base,
        payload: { sessionId: v.sessionId, path: 'docs/a.md' },
      },
      { actorId: 'user' },
    );
    assert.equal(forged.status, 'REJECTED');
    assert.equal(forged.errorCode, 'ERR_COMMAND_INVALID');

    assert.equal(sha256(await readFile(secretFile)), before, '拒绝后不得有磁盘副作用');
    assert.equal(h.document.getBuffer(v.sessionId), 'PWNED\n', '缓冲不得被回滚或清空');
    assert.equal(h.document.getSession(v.sessionId)!.revision, revision);
  } finally {
    await h.cleanup();
  }
});

test('S8-05 仅 docs 写权限：伪造 payload.path 不能编辑 secret 会话', async () => {
  const h = await createHarness({
    grants: [
      { actorId: 'user', action: 'read', scope: 'docs' },
      { actorId: 'user', action: 'write', scope: 'docs' },
    ],
  });
  try {
    await writeProjectFile(h.root, 'docs/a.md', 'A\n');
    await writeProjectFile(h.root, 'secret/x.md', 'SECRET\n');
    const v = await h.document.openSession({ resourceId: 'R5', path: 'secret/x.md', provider: h.provider });
    const revision = h.document.getSession(v.sessionId)!.revision;

    const noClaim = await h.bus.dispatch(
      {
        commandId: 'c-s8-05a',
        type: 'document.applyEdit',
        expectedVersion: 'rev-0',
        payload: { sessionId: v.sessionId, buffer: 'EDITED-SECRET\n' },
      },
      { actorId: 'user' },
    );
    assert.equal(noClaim.status, 'REJECTED');
    assert.equal(noClaim.errorCode, 'ERR_PERMISSION_DENIED', '授权必须针对实际会话路径');

    const forged = await h.bus.dispatch(
      {
        commandId: 'c-s8-05b',
        type: 'document.applyEdit',
        expectedVersion: 'rev-0',
        payload: { sessionId: v.sessionId, buffer: 'EDITED-SECRET\n', path: 'docs/a.md' },
      },
      { actorId: 'user' },
    );
    assert.equal(forged.status, 'REJECTED');
    assert.equal(forged.errorCode, 'ERR_COMMAND_INVALID');

    assert.equal(h.document.getBuffer(v.sessionId), 'SECRET\n', '编辑缓冲不得被改动');
    assert.equal(h.document.getSession(v.sessionId)!.revision, revision);
  } finally {
    await h.cleanup();
  }
});

test('S8-06 仅 docs 读权限：复用 resourceId 不能拿到 secret 会话内容', async () => {
  const h = await createHarness({
    grants: [{ actorId: 'user', action: 'read', scope: 'docs' }],
  });
  try {
    await writeProjectFile(h.root, 'docs/a.md', 'PUBLIC\n');
    await writeProjectFile(h.root, 'secret/x.md', 'CLASSIFIED\n');
    // 会话由可信内部组件先打开
    const foreign = await h.document.openSession({ resourceId: 'R6', path: 'secret/x.md', provider: h.provider });

    // 声称打开 docs/a.md（授权范围内），试图复用 R6
    const claimed = await h.bus.dispatch(
      {
        commandId: 'c-s8-06a',
        type: 'document.open',
        payload: { resourceId: 'R6', path: 'docs/a.md' },
      },
      { actorId: 'user' },
    );
    assert.equal(claimed.status, 'REJECTED');
    assert.equal(claimed.errorCode, 'ERR_RESOURCE_IDENTITY_CONFLICT');
    assert.equal(claimed.result, undefined, '拒绝时不得返回会话句柄');

    // 老老实实声明真实路径 → 也必须因授权范围被拒
    const direct = await h.bus.dispatch(
      {
        commandId: 'c-s8-06b',
        type: 'document.open',
        payload: { resourceId: 'R6', path: 'secret/x.md' },
      },
      { actorId: 'user' },
    );
    assert.equal(direct.status, 'REJECTED');
    assert.equal(direct.errorCode, 'ERR_PERMISSION_DENIED');
    assert.equal(direct.result, undefined);
    assert.equal(h.document.getBuffer(foreign.sessionId), 'CLASSIFIED\n');
  } finally {
    await h.cleanup();
  }
});

test('S8-07 target 与 payload 身份不一致：必须拒绝（ERR_COMMAND_INVALID）', async () => {
  const h = await createHarness({ grants: [{ actorId: 'user', action: 'read', scope: '' }] });
  try {
    await writeProjectFile(h.root, 'docs/a.md', 'A\n');
    const out = await h.bus.dispatch(
      {
        commandId: 'c-s8-07',
        type: 'document.open',
        target: { resourceId: 'R-TARGET', uri: 'local://R-TARGET', providerId: 'local' },
        payload: { resourceId: 'R-PAYLOAD', path: 'docs/a.md' },
      },
      { actorId: 'user' },
    );

    assert.equal(out.status, 'REJECTED');
    assert.equal(out.errorCode, 'ERR_COMMAND_INVALID');
  } finally {
    await h.cleanup();
  }
});

test('S8-08 save 时 target.resourceId 与会话不一致：必须拒绝', async () => {
  const h = await createHarness({
    grants: [
      { actorId: 'user', action: 'read', scope: '' },
      { actorId: 'user', action: 'write', scope: '' },
    ],
  });
  try {
    await writeProjectFile(h.root, 'docs/a.md', 'A\n');
    const v = await h.document.openSession({ resourceId: 'R8', path: 'docs/a.md', provider: h.provider });
    const base = h.document.getSession(v.sessionId)!.baseVersion!;
    h.document.applyEdit(v.sessionId, 'A2\n');

    const out = await h.bus.dispatch(
      {
        commandId: 'c-s8-08',
        type: 'document.save',
        expectedVersion: base,
        target: { resourceId: 'R-OTHER', uri: 'local://R-OTHER', providerId: 'local' },
        payload: { sessionId: v.sessionId },
      },
      { actorId: 'user' },
    );

    assert.equal(out.status, 'REJECTED');
    assert.equal(out.errorCode, 'ERR_COMMAND_INVALID');
    assert.equal(await readFile(join(h.root, 'docs/a.md'), 'utf8'), 'A\n', '磁盘不得变化');
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S8-03：Provider 维度的授权范围
// ---------------------------------------------------------------------------
test('S8-09 同一相对路径在不同 Provider 下不共享授权', () => {
  const localOnly = createPermissionService([{ actorId: 'u', action: 'read', scope: 'docs' }]);
  assert.equal(localOnly.authorize({ actorId: 'u', action: 'read', resourcePath: 'docs/a.md' }).allowed, true);
  assert.equal(
    localOnly.authorize({ actorId: 'u', action: 'read', resourcePath: 'docs/a.md', providerId: 'remote' }).allowed,
    false,
    '本地授权不得自动延伸到其他 Provider',
  );

  const scoped = createPermissionService([
    { actorId: 'u', action: 'read', scope: 'docs', providerId: 'remote' },
  ]);
  assert.equal(
    scoped.authorize({ actorId: 'u', action: 'read', resourcePath: 'docs/a.md', providerId: 'remote' }).allowed,
    true,
  );
  assert.equal(
    scoped.authorize({ actorId: 'u', action: 'read', resourcePath: 'docs/a.md' }).allowed,
    false,
    'Provider 专属授权不得溢出到本地',
  );
});

// ---------------------------------------------------------------------------
// S8-06：外部删除检测
// ---------------------------------------------------------------------------
test('S8-10 有 baseVersion 的文件被删除：changed 必须为 true；新建会话仍为 false', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'docs/a.md', 'A\n');
    const v = await h.document.openSession({ resourceId: 'R10', path: 'docs/a.md', provider: h.provider });
    assert.equal((await h.document.detectExternalChange(v.sessionId)).changed, false);

    await rm(join(h.root, 'docs/a.md'));
    const afterDelete = await h.document.detectExternalChange(v.sessionId);
    assert.equal(afterDelete.changed, true, '原本存在且已建立基线，消失必须报告变化');

    // 从未存在的新建会话：目标仍不存在
    const fresh = await h.document.openSession({ resourceId: 'R10-new', path: 'docs/new.md', provider: h.provider });
    assert.equal((await h.document.detectExternalChange(fresh.sessionId)).changed, false);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S8-07：幂等收据必须重新校验授权与目标身份
// ---------------------------------------------------------------------------
test('S8-11 权限撤销后：同一 idempotencyKey 不得返回旧收据', async () => {
  const h = await createHarness();
  try {
    h.permission.grant({ actorId: 'user', action: 'read', scope: '' });
    h.permission.grant({ actorId: 'user', action: 'write', scope: '' });
    await writeProjectFile(h.root, 'docs/a.md', 'v1\n');

    const v = await h.document.openSession({ resourceId: 'R11', path: 'docs/a.md', provider: h.provider });
    h.document.applyEdit(v.sessionId, 'v2\n');
    const base = h.document.getSession(v.sessionId)!.baseVersion!;

    const first = await h.bus.dispatch(
      {
        commandId: 'c-s8-11a',
        type: 'document.save',
        idempotencyKey: 'idem-11',
        expectedVersion: base,
        payload: { sessionId: v.sessionId },
      },
      { actorId: 'user' },
    );
    assert.equal(first.status, 'APPLIED');

    const afterFirst = sha256(await readFile(join(h.root, 'docs/a.md')));
    h.permission.revoke({ actorId: 'user', action: 'write', scope: '' });

    const replay = await h.bus.dispatch(
      {
        commandId: 'c-s8-11b',
        type: 'document.save',
        idempotencyKey: 'idem-11',
        expectedVersion: base,
        payload: { sessionId: v.sessionId },
      },
      { actorId: 'user' },
    );

    assert.equal(replay.status, 'REJECTED', '授权已撤销时不得直接返回缓存结果');
    assert.equal(replay.errorCode, 'ERR_PERMISSION_DENIED');
    assert.equal(sha256(await readFile(join(h.root, 'docs/a.md'))), afterFirst, '不得重复写盘');
  } finally {
    await h.cleanup();
  }
});

test('S8-12 不同资源复用同一 idempotencyKey：必须拒绝', async () => {
  const h = await createHarness();
  try {
    h.permission.grant({ actorId: 'user', action: 'read', scope: '' });
    h.permission.grant({ actorId: 'user', action: 'write', scope: '' });
    await writeProjectFile(h.root, 'docs/a.md', 'A\n');
    await writeProjectFile(h.root, 'docs/b.md', 'B\n');

    const va = await h.document.openSession({ resourceId: 'RA', path: 'docs/a.md', provider: h.provider });
    const vb = await h.document.openSession({ resourceId: 'RB', path: 'docs/b.md', provider: h.provider });
    h.document.applyEdit(va.sessionId, 'A2\n');
    h.document.applyEdit(vb.sessionId, 'B2\n');

    const a = await h.bus.dispatch(
      {
        commandId: 'c-s8-12a',
        type: 'document.save',
        idempotencyKey: 'idem-12',
        expectedVersion: h.document.getSession(va.sessionId)!.baseVersion!,
        payload: { sessionId: va.sessionId },
      },
      { actorId: 'user' },
    );
    assert.equal(a.status, 'APPLIED');

    const b = await h.bus.dispatch(
      {
        commandId: 'c-s8-12b',
        type: 'document.save',
        idempotencyKey: 'idem-12',
        expectedVersion: h.document.getSession(vb.sessionId)!.baseVersion!,
        payload: { sessionId: vb.sessionId },
      },
      { actorId: 'user' },
    );

    assert.equal(b.status, 'REJECTED', '同一幂等键不得跨资源复用');
    assert.equal(b.errorCode, 'ERR_COMMAND_INVALID');
    assert.equal(await readFile(join(h.root, 'docs/b.md'), 'utf8'), 'B\n', 'b.md 不得被写');
  } finally {
    await h.cleanup();
  }
});

test('S8-13 幂等收据不得跨 actor 查询', async () => {
  const h = await createHarness();
  try {
    h.permission.grant({ actorId: 'user-a', action: 'read', scope: '' });
    h.permission.grant({ actorId: 'user-a', action: 'write', scope: '' });
    await writeProjectFile(h.root, 'docs/a.md', 'v1\n');
    const v = await h.document.openSession({ resourceId: 'R13', path: 'docs/a.md', provider: h.provider });
    h.document.applyEdit(v.sessionId, 'v2\n');

    const out = await h.bus.dispatch(
      {
        commandId: 'c-s8-13',
        type: 'document.save',
        idempotencyKey: 'idem-13',
        expectedVersion: h.document.getSession(v.sessionId)!.baseVersion!,
        payload: { sessionId: v.sessionId },
      },
      { actorId: 'user-a' },
    );
    assert.equal(out.status, 'APPLIED');

    assert.equal(h.bus.getResult('idem-13', 'user-b'), undefined, '不得向其他 actor 暴露收据');
    assert.equal(h.bus.getResult('idem-13'), undefined, '无 actor 上下文时不得返回收据');
    assert.ok(h.bus.getResult('idem-13', 'user-a'), '本人应能查到自己的收据');
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S8-05：审计必须记录实际资源，并区分“声称”与“已验证”
// ---------------------------------------------------------------------------
test('S8-14 审计记录实际资源；身份冲突拒绝时同时记录声称值', async () => {
  const h = await createHarness({
    grants: [
      { actorId: 'user', action: 'read', scope: '' },
      { actorId: 'user', action: 'write', scope: '' },
    ],
  });
  try {
    await writeProjectFile(h.root, 'docs/a.md', 'A\n');
    const v = await h.document.openSession({ resourceId: 'R14', path: 'docs/a.md', provider: h.provider });
    h.document.applyEdit(v.sessionId, 'A2\n');
    h.auditSink.clear();

    await h.bus.dispatch(
      {
        commandId: 'c-s8-14a',
        type: 'document.save',
        expectedVersion: h.document.getSession(v.sessionId)!.baseVersion!,
        payload: { sessionId: v.sessionId },
      },
      { actorId: 'user' },
    );
    const completed = h.auditSink.records.find((r) => r.event === 'COMMAND_COMPLETED');
    assert.ok(completed, '必须记录 COMMAND_COMPLETED');
    assert.equal(completed?.resourceId, 'R14', '审计的资源必须是实际会话资源');

    // 身份冲突：声称 path 与实际会话不同
    await writeProjectFile(h.root, 'secret/x.md', 'S\n');
    const v2 = await h.document.openSession({ resourceId: 'R14b', path: 'secret/x.md', provider: h.provider });
    assert.ok(v2.sessionId);

    const rejected = await h.bus.dispatch(
      {
        commandId: 'c-s8-14b',
        type: 'document.open',
        payload: { resourceId: 'R14b', path: 'docs/a.md' },
      },
      { actorId: 'user' },
    );
    assert.equal(rejected.status, 'REJECTED');

    const rejection = h.auditSink.records
      .filter((r) => r.event === 'COMMAND_REJECTED')
      .at(-1);
    assert.ok(rejection, '拒绝必须落审计');
    assert.equal(rejection?.errorCode, 'ERR_RESOURCE_IDENTITY_CONFLICT');
    assert.equal(rejection?.claimedPath, 'docs/a.md', '必须记录声称路径');
    assert.equal(rejection?.verifiedPath, 'secret/x.md', '必须记录已验证的实际路径');
    assert.equal(rejection?.resourceId, 'R14b');
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S8-15：正常流程回归（授权按实际资源后，合法操作仍必须通过）
// ---------------------------------------------------------------------------
test('S8-15 正常授权下 open/applyEdit/save 仍 APPLIED（含 path 一致与省略 path 两种写法）', async () => {
  const h = await createHarness({
    grants: [
      { actorId: 'user', action: 'read', scope: 'docs' },
      { actorId: 'user', action: 'write', scope: 'docs' },
    ],
  });
  try {
    await writeProjectFile(h.root, 'docs/a.md', 'v1\n');

    const opened = await h.bus.dispatch(
      { commandId: 'c-s8-15a', type: 'document.open', payload: { resourceId: 'R15', path: 'docs/a.md' } },
      { actorId: 'user' },
    );
    assert.equal(opened.status, 'APPLIED');
    const sessionId = (opened.result as { sessionId: string }).sessionId;

    const edited = await h.bus.dispatch(
      {
        commandId: 'c-s8-15b',
        type: 'document.applyEdit',
        expectedVersion: 'rev-0',
        payload: { sessionId, buffer: 'v2\n' },
      },
      { actorId: 'user' },
    );
    assert.equal(edited.status, 'APPLIED');

    const saved = await h.bus.dispatch(
      {
        commandId: 'c-s8-15c',
        type: 'document.save',
        expectedVersion: h.document.getSession(sessionId)!.baseVersion!,
        payload: { sessionId, path: 'docs/a.md' },
      },
      { actorId: 'user' },
    );
    assert.equal(saved.status, 'APPLIED');
    assert.equal(await readFile(join(h.root, 'docs/a.md'), 'utf8'), 'v2\n');
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S8-16（F01）：resolveProvider 返回的 Provider 必须与会话绑定的存储根一致
//   两个不同根目录的 Provider 可以共用同一个 providerId。
// ---------------------------------------------------------------------------
test('S8-16 双根 Provider（同 providerId）：applyEdit/save 必须按身份冲突拒绝', async () => {
  const rootA = await mkdtemp(join(tmpdir(), 's8-rootA-'));
  const rootB = await mkdtemp(join(tmpdir(), 's8-rootB-'));
  try {
    await writeFile(join(rootA, 'doc.md'), 'A-CONTENT\n', 'utf8');
    await writeFile(join(rootB, 'doc.md'), 'B-CONTENT\n', 'utf8');
    const providerA = createLocalProvider({ rootDir: rootA });
    const providerB = createLocalProvider({ rootDir: rootB });

    // 命令总线只认识 A（providerId 相同 → 解析到 A）
    const document = createDocumentService();
    const permission = createPermissionService([
      { actorId: 'user', action: 'read', scope: '' },
      { actorId: 'user', action: 'write', scope: '' },
    ]);
    const bus = createCommandBus({
      document,
      permission,
      resolveProvider: (id) => (id === 'local' ? providerA : undefined),
    });

    // 会话由内部组件在 B 根上合法打开
    const foreign = await document.openSession({ resourceId: 'R-B', path: 'doc.md', provider: providerB });
    const base = document.getSession(foreign.sessionId)!.baseVersion!;
    const shaBBefore = sha256(await readFile(join(rootB, 'doc.md')));
    const shaABefore = sha256(await readFile(join(rootA, 'doc.md')));

    // ① applyEdit：授权与实际操作对象会错配（A 被授权，B 会被改）
    const edit = await bus.dispatch(
      {
        commandId: 'c-s8-16a',
        type: 'document.applyEdit',
        expectedVersion: 'rev-0',
        payload: { sessionId: foreign.sessionId, buffer: 'HIJACKED\n' },
      },
      { actorId: 'user' },
    );
    assert.equal(edit.status, 'REJECTED', 'Provider 根不一致时不得授权通过');
    assert.equal(edit.errorCode, 'ERR_RESOURCE_IDENTITY_CONFLICT');
    assert.equal(document.getBuffer(foreign.sessionId), 'B-CONTENT\n', '缓冲不得被改动');
    assert.equal(document.getSession(foreign.sessionId)!.revision, 0);

    // ② save：同样必须拒绝，且两个根的文件都不变
    document.applyEdit(foreign.sessionId, 'B-EDITED\n');
    const revision = document.getSession(foreign.sessionId)!.revision;

    const save = await bus.dispatch(
      {
        commandId: 'c-s8-16b',
        type: 'document.save',
        expectedVersion: base,
        payload: { sessionId: foreign.sessionId },
      },
      { actorId: 'user' },
    );
    assert.equal(save.status, 'REJECTED');
    assert.equal(save.errorCode, 'ERR_RESOURCE_IDENTITY_CONFLICT');

    assert.equal(sha256(await readFile(join(rootB, 'doc.md'))), shaBBefore, 'B 根不得被写入');
    assert.equal(sha256(await readFile(join(rootA, 'doc.md'))), shaABefore, 'A 根不得被写入');
    assert.equal(document.getSession(foreign.sessionId)!.revision, revision);
  } finally {
    await rm(rootA, { recursive: true, force: true }).catch(() => {});
    await rm(rootB, { recursive: true, force: true }).catch(() => {});
  }
});

test('S8-17 显式声明错误的 providerId：必须拒绝，不得静默忽略', async () => {
  const h = await createHarness({
    grants: [
      { actorId: 'user', action: 'read', scope: '' },
      { actorId: 'user', action: 'write', scope: '' },
    ],
  });
  try {
    await writeProjectFile(h.root, 'docs/a.md', 'v1\n');
    const v = await h.document.openSession({ resourceId: 'R17', path: 'docs/a.md', provider: h.provider });
    h.document.applyEdit(v.sessionId, 'v2\n');
    const base = h.document.getSession(v.sessionId)!.baseVersion!;

    const out = await h.bus.dispatch(
      {
        commandId: 'c-s8-17',
        type: 'document.save',
        expectedVersion: base,
        payload: { sessionId: v.sessionId, providerId: 'remote' },
      },
      { actorId: 'user' },
    );
    assert.equal(out.status, 'REJECTED');
    assert.equal(out.errorCode, 'ERR_COMMAND_INVALID');
    assert.equal(await readFile(join(h.root, 'docs/a.md'), 'utf8'), 'v1\n', '磁盘不得变化');
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S8-18（F02）：幂等指纹必须覆盖命令语义（applyEdit 的 buffer / expectedVersion）
// ---------------------------------------------------------------------------
test('S8-18 同一幂等键提交不同 buffer 的 applyEdit：必须拒绝，缓冲保持第一次的结果', async () => {
  const h = await createHarness({
    grants: [
      { actorId: 'user', action: 'read', scope: '' },
      { actorId: 'user', action: 'write', scope: '' },
    ],
  });
  try {
    await writeProjectFile(h.root, 'docs/a.md', 'v1\n');
    const v = await h.document.openSession({ resourceId: 'R18', path: 'docs/a.md', provider: h.provider });

    const first = await h.bus.dispatch(
      {
        commandId: 'c-s8-18a',
        type: 'document.applyEdit',
        idempotencyKey: 'idem-18',
        expectedVersion: 'rev-0',
        payload: { sessionId: v.sessionId, buffer: 'EDIT-A\n' },
      },
      { actorId: 'user' },
    );
    assert.equal(first.status, 'APPLIED');
    assert.equal(h.document.getBuffer(v.sessionId), 'EDIT-A\n');

    const second = await h.bus.dispatch(
      {
        commandId: 'c-s8-18b',
        type: 'document.applyEdit',
        idempotencyKey: 'idem-18',
        expectedVersion: 'rev-1',
        payload: { sessionId: v.sessionId, buffer: 'EDIT-B\n' },
      },
      { actorId: 'user' },
    );
    assert.equal(second.status, 'REJECTED', '不同 buffer 不得命中同一幂等键');
    assert.equal(second.errorCode, 'ERR_COMMAND_INVALID');
    assert.equal(h.document.getBuffer(v.sessionId), 'EDIT-A\n', '缓冲不得被第二次内容覆盖');
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S8-19（F02）：save 的幂等指纹覆盖 expectedVersion / serializerId / 待保存缓冲
// ---------------------------------------------------------------------------
test('S8-19 save：内容或 expectedVersion 变化后复用同键必须拒绝；完全相同重试仍去重', async () => {
  const h = await createHarness();
  try {
    h.permission.grant({ actorId: 'user', action: 'read', scope: '' });
    h.permission.grant({ actorId: 'user', action: 'write', scope: '' });
    await writeProjectFile(h.root, 'docs/a.md', 'v1\n');
    const v = await h.document.openSession({ resourceId: 'R19', path: 'docs/a.md', provider: h.provider });
    h.document.applyEdit(v.sessionId, 'v2\n');
    const base = h.document.getSession(v.sessionId)!.baseVersion!;

    const first = await h.bus.dispatch(
      {
        commandId: 'c-s8-19a',
        type: 'document.save',
        idempotencyKey: 'idem-19',
        expectedVersion: base,
        payload: { sessionId: v.sessionId },
      },
      { actorId: 'user' },
    );
    assert.equal(first.status, 'APPLIED');
    const diskAfterFirst = sha256(await readFile(join(h.root, 'docs/a.md')));

    // ① 完全相同语义（新 commandId、同幂等键）→ 应去重，不重复写盘
    const replay = await h.bus.dispatch(
      {
        commandId: 'c-s8-19b',
        type: 'document.save',
        idempotencyKey: 'idem-19',
        expectedVersion: base,
        payload: { sessionId: v.sessionId },
      },
      { actorId: 'user' },
    );
    assert.equal(replay.status, 'APPLIED');
    assert.equal(replay.deduplicated, true, '合法重试必须仍被去重');
    assert.equal(sha256(await readFile(join(h.root, 'docs/a.md'))), diskAfterFirst, '不得重复写盘');

    // ② 改变缓冲后再复用同键 → 语义不同，必须拒绝
    h.document.applyEdit(v.sessionId, 'v3\n');
    const changedBuffer = await h.bus.dispatch(
      {
        commandId: 'c-s8-19c',
        type: 'document.save',
        idempotencyKey: 'idem-19',
        expectedVersion: base,
        payload: { sessionId: v.sessionId },
      },
      { actorId: 'user' },
    );
    assert.equal(changedBuffer.status, 'REJECTED');
    assert.equal(changedBuffer.errorCode, 'ERR_COMMAND_INVALID');
    assert.equal(sha256(await readFile(join(h.root, 'docs/a.md'))), diskAfterFirst, '拒绝时不得写盘');

    // ③ 只改 expectedVersion 也必须拒绝
    const changedVersion = await h.bus.dispatch(
      {
        commandId: 'c-s8-19d',
        type: 'document.save',
        idempotencyKey: 'idem-19',
        expectedVersion: 'sha256:deadbeef',
        payload: { sessionId: v.sessionId },
      },
      { actorId: 'user' },
    );
    assert.equal(changedVersion.status, 'REJECTED');
    assert.equal(changedVersion.errorCode, 'ERR_COMMAND_INVALID');
  } finally {
    await h.cleanup();
  }
});
