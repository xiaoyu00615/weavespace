/**
 * UX-02C-02-R1.1：页面实例身份（纯 TS，注入端口）。
 *
 * 覆盖：
 * - 同一页面刷新 → id 不变；
 * - 两个独立页面 → id 不同；
 * - opener 复制 sessionStorage / Chrome 复制标签页 → 复制品必须换新 id；
 * - 刷新时的"卸载窗口"（旧锁还没释放）不得误判成复制；
 * - 没有 Web Locks 时退化行为（只信 sessionStorage）；
 * - 没有 sessionStorage → 不带身份（绝不伪造）；
 * - 生成的 id 必须满足 Host 形状校验（否则请求会被 400 拒绝）。
 *
 * 这些规则与授权无关：id 只用于"这是哪个页面"的归属识别。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAGE_INSTANCE_KEY,
  PAGE_INSTANCE_SHAPE,
  generateInstanceId,
  normalizeInstanceId,
  resolvePageInstanceId,
  type InstanceLockPort,
  type InstanceStoragePort,
} from '../../apps/shell/src/client/page-instance.ts';

class MemoryStorage implements InstanceStoragePort {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

/**
 * 假锁端口：`held` 模拟"别的页面正持有的锁"。
 * 页面自己的锁在"刷新"时由 `releaseAll()` 释放。
 */
class FakeLocks implements InstanceLockPort {
  readonly held = new Set<string>();
  attempts = 0;
  /** 命中该集合时，第一次尝试失败、第二次成功（模拟卸载窗口）。 */
  readonly releaseAfterFirstAttempt = new Set<string>();

  async tryAcquire(name: string): Promise<boolean> {
    this.attempts += 1;
    if (this.held.has(name)) {
      if (this.releaseAfterFirstAttempt.has(name)) {
        this.releaseAfterFirstAttempt.delete(name);
        this.held.delete(name);
        return false;
      }
      return false;
    }
    this.held.add(name);
    return true;
  }

  releaseAll(): void {
    this.held.clear();
  }
}

const immediate = { delay: async () => undefined, retryDelayMs: 0 };

test('同一页面刷新：锁已释放后解析出同一个 id', async () => {
  const storage = new MemoryStorage();
  const locks = new FakeLocks();
  const first = await resolvePageInstanceId({ storage, locks, ...immediate });
  assert.ok(first && PAGE_INSTANCE_SHAPE.test(first));
  assert.equal(storage.getItem(PAGE_INSTANCE_KEY), first);

  // 刷新：旧上下文销毁 → 锁释放，sessionStorage 保留
  locks.releaseAll();
  const second = await resolvePageInstanceId({ storage, locks, ...immediate });
  assert.equal(second, first, '刷新必须保留原页面身份');
});

test('两个独立页面：各自生成不同 id', async () => {
  const a = new MemoryStorage();
  const b = new MemoryStorage();
  const idA = await resolvePageInstanceId({ storage: a, locks: new FakeLocks(), ...immediate });
  const idB = await resolvePageInstanceId({ storage: b, locks: new FakeLocks(), ...immediate });
  assert.ok(idA && idB);
  assert.notEqual(idA, idB);
});

test('opener 复制 sessionStorage：原页面仍持锁 → 复制品换新 id', async () => {
  const locks = new FakeLocks();
  const original = new MemoryStorage();
  const idA = await resolvePageInstanceId({ storage: original, locks, ...immediate });
  assert.ok(idA);

  // window.open 会把 sessionStorage 整体复制给新页面，锁则不会复制
  const copy = new MemoryStorage();
  copy.setItem(PAGE_INSTANCE_KEY, idA);
  let counter = 0;
  const idB = await resolvePageInstanceId({
    storage: copy,
    locks,
    newId: () => `copied-page-${++counter}`,
    ...immediate,
  });
  assert.notEqual(idB, idA, '复制来的 id 不能与仍在工作的页面共用');
  assert.equal(idB, 'copied-page-1');
  assert.equal(copy.getItem(PAGE_INSTANCE_KEY), idB, '新 id 必须写回，刷新后继续用它');
  // 原页面的 id 不受影响
  assert.equal(original.getItem(PAGE_INSTANCE_KEY), idA);
});

test('Chrome 复制标签页：同一 id 已被占 → 复制品换新 id，原标签保持原 id', async () => {
  const locks = new FakeLocks();
  const original = new MemoryStorage();
  const idA = await resolvePageInstanceId({ storage: original, locks, ...immediate });
  assert.ok(idA);

  const duplicated = new MemoryStorage();
  duplicated.setItem(PAGE_INSTANCE_KEY, idA);
  let counter = 0;
  const idC = await resolvePageInstanceId({
    storage: duplicated,
    locks,
    newId: () => `dup-tab-${++counter}`,
    ...immediate,
  });
  assert.notEqual(idC, idA);
  assert.equal(original.getItem(PAGE_INSTANCE_KEY), idA);
});

test('刷新卸载窗口：第一次抢不到锁但随即释放 → 不换 id', async () => {
  const storage = new MemoryStorage();
  const locks = new FakeLocks();
  const id = await resolvePageInstanceId({ storage, locks, ...immediate });
  assert.ok(id);

  // 旧页面还没完全销毁：锁仍被持着；下一次尝试时已释放
  locks.held.add(id);
  locks.releaseAfterFirstAttempt.add(id);
  const again = await resolvePageInstanceId({
    storage,
    locks,
    newId: () => 'should-not-be-used',
    ...immediate,
  });
  assert.equal(again, id, '卸载窗口内的锁竞争必须重试而不是换身份');
  assert.equal(locks.attempts >= 3, true);
});

test('没有 Web Locks：退化信任 sessionStorage（记录局限）', async () => {
  const storage = new MemoryStorage();
  storage.setItem(PAGE_INSTANCE_KEY, 'legacy-page-aaaaaaaa');
  const id = await resolvePageInstanceId({ storage, locks: null, ...immediate });
  assert.equal(id, 'legacy-page-aaaaaaaa');
});

test('没有 sessionStorage：不生成身份（请求里省略该字段）', async () => {
  const id = await resolvePageInstanceId({ storage: null, locks: new FakeLocks(), ...immediate });
  assert.equal(id, null);
});

test('形状：生成的 id 必须通过 Host 校验；垃圾值被忽略并重建', async () => {
  assert.equal(PAGE_INSTANCE_SHAPE.test(generateInstanceId()), true);
  assert.equal(normalizeInstanceId('  '), null);
  assert.equal(normalizeInstanceId('短'), null);
  assert.equal(normalizeInstanceId('has space here'), null);
  assert.equal(normalizeInstanceId('ok-instance-1234'), 'ok-instance-1234');

  const storage = new MemoryStorage();
  storage.setItem(PAGE_INSTANCE_KEY, '带空格的垃圾 id');
  const id = await resolvePageInstanceId({ storage, locks: new FakeLocks(), ...immediate });
  assert.ok(id && PAGE_INSTANCE_SHAPE.test(id));
});
