/**
 * 契约测试：信封校验与错误码注册表一致性（docs/04、docs/18 RSK-01）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from '../helpers.ts';
import { validateEnvelope } from '../../packages/command/index.ts';
import { ALL_ERROR_CODES, ERROR_CODES } from '../../packages/contracts/errors.ts';
import type { CommandEnvelope } from '../../packages/contracts/types.ts';

test('CONTRACT-01 错误码注册表：键值一致、无重复、前缀统一', () => {
  assert.ok(ALL_ERROR_CODES.length >= 15, `错误码数量异常: ${ALL_ERROR_CODES.length}`);
  for (const code of ALL_ERROR_CODES) {
    assert.equal(ERROR_CODES[code], code, `${code} 的键值必须一致`);
    assert.match(code, /^ERR_[A-Z0-9_]+$/, `${code} 必须符合 ERR_ 前缀规范`);
  }
  assert.equal(new Set(ALL_ERROR_CODES).size, ALL_ERROR_CODES.length, '不得重复');
});

test('CONTRACT-02 信封校验：缺字段/类型错误均给出字段级原因', () => {
  const violations = validateEnvelope({} as CommandEnvelope);
  const fields = violations.map((v) => v.field);
  assert.ok(fields.includes('commandId'));
  assert.ok(fields.includes('type'));
  assert.ok(fields.includes('payload'));

  const bad = validateEnvelope({
    commandId: '含 空格',
    type: 'ab',
    payload: null as never,
  } as CommandEnvelope);
  assert.ok(bad.length >= 3);
});

test('CONTRACT-03 合法信封通过校验', () => {
  const ok = validateEnvelope({
    commandId: 'cmd-1',
    type: 'document.open',
    payload: { resourceId: 'r1', path: 'a.md' },
  });
  assert.deepEqual(ok, []);
});

test('CONTRACT-04 未知命令 → ERR_COMMAND_UNSUPPORTED，且不产生副作用', async () => {
  const h = await createHarness({ grants: [{ actorId: 'user-a', action: 'write', scope: '' }] });
  try {
    const result = await h.bus.dispatch(
      {
        commandId: 'cmd-unknown',
        type: 'canvas.explode',
        expectedVersion: 'v1',
        payload: {},
      },
      { actorId: 'user-a' },
    );
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.errorCode, 'ERR_COMMAND_UNSUPPORTED');
    assert.deepEqual(await h.provider.list(), []);
  } finally {
    await h.cleanup();
  }
});

test('CONTRACT-05 写命令缺 expectedVersion → REJECTED（DATA-001 强制版本校验）', async () => {
  const h = await createHarness({ grants: [{ actorId: 'user-a', action: 'write', scope: '' }] });
  try {
    const result = await h.bus.dispatch(
      {
        commandId: 'cmd-no-version',
        type: 'document.save',
        payload: { sessionId: 'session-x' },
      },
      { actorId: 'user-a' },
    );
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.errorCode, 'ERR_COMMAND_INVALID');
    assert.ok((result.violations ?? []).some((v) => v.field === 'expectedVersion'));
  } finally {
    await h.cleanup();
  }
});

test('CONTRACT-06 不存在的会话 → 明确错误码而非抛异常冒泡', async () => {
  const h = await createHarness({ grants: [{ actorId: 'user-a', action: 'write', scope: '' }] });
  try {
    const result = await h.bus.dispatch(
      {
        commandId: 'cmd-missing',
        type: 'document.save',
        expectedVersion: 'sha256:x',
        payload: { sessionId: 'session-missing' },
      },
      { actorId: 'user-a' },
    );
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.errorCode, 'ERR_DOCUMENT_NOT_FOUND');
  } finally {
    await h.cleanup();
  }
});

test('CONTRACT-07 命令执行抛错被转为 FAILED，不把内部异常泄漏为崩溃', async () => {
  const h = await createHarness({ grants: [{ actorId: 'user-a', action: 'write', scope: '' }] });
  try {
    const result = await h.bus.dispatch(
      {
        commandId: 'cmd-throw',
        type: 'document.applyEdit',
        expectedVersion: 'v1',
        payload: { sessionId: 'session-not-exist', buffer: 'x' },
      },
      { actorId: 'user-a' },
    );
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, 'ERR_DOCUMENT_NOT_FOUND');
  } finally {
    await h.cleanup();
  }
});
