/**
 * P0-1A 回归套件（S1 / S2 / S3）。
 *
 * 纪律：本文件先于修复编写。修复前三个用例必须全部失败，且失败原因必须与缺陷一致
 * （见交付报告 §2「修复前后复现结果」）。
 * 断言对象是「结果 + 副作用（磁盘字节 / 调用返回值）」，不只看状态字符串。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHarness, writeProjectFile } from '../helpers.ts';
import { contentVersionOf, resolveInsideRoot } from '../../packages/storage/index.ts';
import { createPermissionService } from '../../packages/permission/index.ts';

// ---------------------------------------------------------------------------
// S1：Command Bus 缺 runWithOperation 导入 → 带 operationId 的命令直接抛错
// ---------------------------------------------------------------------------
test('P0-1A/S1 带 operationId 的 dispatch 可执行，且 operationId 贯穿审计与保存日志', async () => {
  const h = await createHarness({
    grants: [
      { actorId: 'user-a', action: 'read', scope: '' },
      { actorId: 'user-a', action: 'write', scope: '' },
    ],
  });
  try {
    await writeProjectFile(h.root, 'op.md', 'v1\n');
    const opened = await h.bus.dispatch(
      {
        commandId: 'cmd-op-1',
        type: 'document.open',
        payload: { resourceId: 'res-op', path: 'op.md', providerId: 'local' },
      },
      { actorId: 'user-a', traceId: 'trace-s1', operationId: 'op-s1' },
    );
    assert.equal(opened.status, 'APPLIED', '带 operationId 的命令必须被执行，而不是抛 ReferenceError');
    const sessionId = (opened.result as { sessionId: string }).sessionId;

    h.document.applyEdit(sessionId, 'v2\n');
    const base = h.document.getSession(sessionId)!.baseVersion!;
    const saved = await h.bus.dispatch(
      {
        commandId: 'cmd-op-2',
        type: 'document.save',
        expectedVersion: base,
        payload: { sessionId },
      },
      { actorId: 'user-a', traceId: 'trace-s1', operationId: 'op-s1' },
    );
    assert.equal(saved.status, 'APPLIED', '带 operationId 的保存必须成功');
    assert.equal(await readFile(join(h.root, 'op.md'), 'utf8'), 'v2\n', '副作用：磁盘内容必须真的更新');

    const audits = h.auditSink.records.filter((r) => r.operationId === 'op-s1');
    assert.ok(audits.length >= 3, `审计记录必须携带同一 operationId，实际 ${audits.length} 条`);
    assert.ok(
      audits.every((r) => r.traceId === 'trace-s1'),
      '同一操作的审计必须共享请求 traceId',
    );

    // 端到端：document 侧日志必须继承命令作用域的 operationId（TIME-002）
    const saveLog = h.memorySink.records.find((r) => r.event === 'SAVE_COMMITTED');
    assert.ok(saveLog, 'document 侧必须产生 SAVE_COMMITTED 日志');
    assert.equal(saveLog?.operationId, 'op-s1', '保存日志必须继承命令的 operationId');
    assert.equal(saveLog?.traceId, 'trace-s1', '保存日志必须继承命令的 traceId');
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S2：保存期间继续编辑 → dirty 被错误清除
// ---------------------------------------------------------------------------
test('P0-1A/S2 保存期间的新编辑不丢失：已写入版本与当前缓冲版本必须可区分', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'during.md', 'v1\n');
    const v = await h.document.openSession({
      resourceId: 'res-during',
      path: 'during.md',
      provider: h.provider,
    });
    h.document.applyEdit(v.sessionId, 'v2-saved\n');

    const savePromise = h.document.save(v.sessionId, (b) => b);
    // 前置条件：此刻必须处于 SAVING 窗口期，否则本用例不成立
    assert.equal(
      h.document.getSession(v.sessionId)?.state,
      'SAVING',
      '保存必须在首个 await 之前进入 SAVING，才能构造"保存期间编辑"',
    );

    h.document.applyEdit(v.sessionId, 'v3-typed-during-save\n'); // 保存期间继续输入
    const saved = await savePromise;
    assert.equal(saved.status, 'COMMITTED');

    const session = h.document.getSession(v.sessionId)!;
    const buffer = h.document.getBuffer(v.sessionId);
    const disk = await readFile(join(h.root, 'during.md'), 'utf8');

    // 副作用 1：磁盘上只能是被提交的那一刻的内容
    assert.equal(disk, 'v2-saved\n', '写盘内容必须来自保存开始时的缓冲');
    assert.equal(saved.contentVersion, contentVersionOf('v2-saved\n'));

    // 副作用 2：保存期间的新编辑必须完整保留在缓冲里
    assert.equal(buffer, 'v3-typed-during-save\n', '保存期间的新编辑不得丢失');

    // 版本区分：baseVersion 指向"已写入版本"，当前缓冲另有哈希
    assert.equal(session.baseVersion, saved.contentVersion, 'baseVersion 必须等于已写入版本');
    assert.notEqual(
      contentVersionOf(buffer),
      session.baseVersion,
      '当前缓冲的内容版本必须与已写入版本不同',
    );

    // 状态：仍有未保存内容
    assert.equal(session.dirty, true, '保存期间的新编辑必须让会话保持 dirty');
    assert.equal(session.state, 'EDITING_DIRTY');
    assert.equal(session.revision, 2);

    const committed = h.document.drainEvents().find((e) => e.type === 'SAVE_COMMITTED');
    const detail = committed?.detail as { savedRevision?: number; currentRevision?: number };
    assert.equal(detail?.savedRevision, 1, '事件必须记录被写入的代次');
    assert.equal(detail?.currentRevision, 2, '事件必须记录当前缓冲代次');

    // 副作用 3：dirty 未被误清除 → 关闭最后一个视图必须被拒绝（DATA-002）
    const closed = await h.document.closeView(v.viewId);
    assert.equal(closed.closed, false, '仍有未保存编辑时不得静默关闭');
    assert.equal(closed.protectedDirty, true);
    assert.equal(h.document.getSession(v.sessionId)?.dirty, true);

    // 副作用 4：新编辑仍可被正常落盘（内容没丢，只是还没保存）
    const secondSave = await h.document.save(v.sessionId, (b) => b);
    assert.equal(secondSave.status, 'COMMITTED');
    assert.equal(await readFile(join(h.root, 'during.md'), 'utf8'), 'v3-typed-during-save\n');
    assert.equal(h.document.getSession(v.sessionId)?.dirty, false, '再次保存后必须回到 CLEAN');
  } finally {
    await h.cleanup();
  }
});

test('P0-1A/S2b 保存期间无编辑时仍必须回到 CLEAN（防止过度修复）', async () => {
  const h = await createHarness();
  try {
    await writeProjectFile(h.root, 'quiet.md', 'v1\n');
    const v = await h.document.openSession({
      resourceId: 'res-quiet',
      path: 'quiet.md',
      provider: h.provider,
    });
    h.document.applyEdit(v.sessionId, 'v2\n');
    const saved = await h.document.save(v.sessionId, (b) => b);

    assert.equal(saved.status, 'COMMITTED');
    const session = h.document.getSession(v.sessionId)!;
    assert.equal(session.dirty, false);
    assert.equal(session.state, 'CLEAN');
    assert.equal(session.baseVersion, saved.contentVersion);
    assert.equal(await readFile(join(h.root, 'quiet.md'), 'utf8'), 'v2\n');

    const detail = h.document.drainEvents().find((e) => e.type === 'SAVE_COMMITTED')?.detail as {
      savedRevision?: number;
      currentRevision?: number;
    };
    assert.equal(
      detail?.savedRevision,
      detail?.currentRevision,
      '无并发编辑时「已写入代次」与「当前代次」必须相同',
    );
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S3：Permission scope 路径穿越
// ---------------------------------------------------------------------------
test('P0-1A/S3a scope 前缀不得被 .. 穿越：docs 授权不覆盖根下其他文件', () => {
  const permission = createPermissionService([{ actorId: 'w', action: 'write', scope: 'docs' }]);

  // 越界（规范形式落在 docs 之外）或非法（绝对路径/盘符/越过根）→ 一律拒绝
  const mustBeDenied = [
    'docs/../secret.md',
    'docs/../../outside.md',
    'docs/..\\secret.md',
    'docs/..',
    '../secret.md',
    'docs/./../../secret.md',
    '/etc/passwd',
    'C:/Windows/win.ini',
    'c:secret.md',
  ];
  for (const p of mustBeDenied) {
    const decision = permission.authorize({ actorId: 'w', action: 'write', resourcePath: p });
    assert.equal(decision.allowed, false, `越界路径必须被拒绝: ${p}`);
    assert.equal(decision.errorCode, 'ERR_PERMISSION_DENIED');
  }

  // 规范形式仍落在 docs 内 → 必须允许（拒绝不是目的，与 storage 同构才是）
  const mustBeAllowed = [
    'docs',
    'docs/',
    'docs/a.md',
    './docs/b.md',
    'docs\\c.md',
    'docs/./k.md',
    'docs/sub/../d.md', // → docs/d.md
  ];
  for (const p of mustBeAllowed) {
    const decision = permission.authorize({ actorId: 'w', action: 'write', resourcePath: p });
    assert.equal(decision.allowed, true, `docs 范围内的合法路径必须被允许: ${p}`);
  }
});

test('P0-1A/S3b 授权路径与 storage 实际解析路径使用同一规范形式（跨层不变量）', async () => {
  const h = await createHarness({ grants: [{ actorId: 'w', action: 'write', scope: 'docs' }] });
  try {
    // 同一份路径表同时问两件事：permission 是否放行 / storage 会落到哪个相对路径
    const cases = [
      'docs/a.md',
      'docs/../secret.md',
      'docs/sub/../b.md',
      './docs/x/y.md',
      'docs\\z.md',
      'docs/../../outside.md',
      'docs/./k.md',
    ];
    let deniedCount = 0;
    let allowedCount = 0;
    for (const candidate of cases) {
      const allowed = h.permission.authorize({
        actorId: 'w',
        action: 'write',
        resourcePath: candidate,
      }).allowed;
      if (allowed) {
        allowedCount += 1;
        const check = resolveInsideRoot(h.root, candidate);
        assert.equal(check.ok, true, `被授权路径必须能被 storage 解析: ${candidate}`);
        if (check.ok) {
          const relative = check.relativePath.replace(/\\/g, '/');
          assert.ok(
            relative === 'docs' || relative.startsWith('docs/'),
            `授权路径 ${candidate} 被允许，但 storage 实际落到 docs 之外: ${relative}`,
          );
        }
      } else {
        deniedCount += 1;
      }
    }
    // 防止测试空转：两类结果都必须出现
    assert.ok(deniedCount >= 1, '越界路径必须至少有一条被拒绝');
    assert.ok(allowedCount >= 1, '合法路径必须至少有一条被允许');

    // 对照：storage 会把 docs/../secret.md 解析成根目录下的 secret.md —— 这正是 permission 必须拒绝它的原因
    const normalized = resolveInsideRoot(h.root, 'docs/../secret.md');
    assert.equal(normalized.ok, true);
    if (normalized.ok) assert.equal(normalized.relativePath.replace(/\\/g, '/'), 'secret.md');
  } finally {
    await h.cleanup();
  }
});

test('P0-1A/S3c 非法 scope 不得被接受（授权表本身也要 fail-closed）', () => {
  assert.throws(
    () => createPermissionService([{ actorId: 'w', action: 'write', scope: 'docs/../../etc' }]),
    /非法 scope/,
    '构造时出现越界 scope 必须立刻失败，而不是静默存进授权表',
  );

  const permission = createPermissionService([{ actorId: 'w', action: 'write', scope: 'docs' }]);
  assert.throws(
    () => permission.grant({ actorId: 'w', action: 'write', scope: '../root' }),
    /非法 scope/,
    '授予越界 scope 必须被拒绝',
  );
  assert.deepEqual(
    permission.grantsOf('w').map((g) => g.scope),
    ['docs'],
    '非法 grant 不得改变授权表',
  );

  // 等价写法必须被视为同一 scope：撤销用 ./docs/ 也能撤销 docs
  permission.revoke({ actorId: 'w', action: 'write', scope: './docs/' });
  assert.deepEqual(permission.grantsOf('w'), [], '等价规范形式的 scope 必须能被撤销');
});
