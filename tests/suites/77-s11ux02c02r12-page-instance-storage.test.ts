/**
 * UX-02C-02-R1.2：页面实例身份的**存储异常边界**。
 *
 * R1-02 复审缺陷：`resolvePageInstanceId` 只把 `setItem` 包在 try 里，
 * `getItem` 抛错会直接把异常冒到 `/api/open`（表现为"无法连接本地服务"）；
 * 而"新 id 已生成但没能写进 sessionStorage"仍然被返回，等于对调用方声称
 * "这是一个刷新后仍然有效的页面身份"——它并不是。
 *
 * 本套件的判定只讲一条纪律：
 * **只有确实持久化过的 id 才是页面身份；拿不到就返回 null（省略该字段），
 * 绝不伪造一个刷新后必然变化的假身份。**
 *
 * 纯端口注入，不依赖真实浏览器（真实浏览器部分见 R1.2 的 Chrome 证据）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAGE_INSTANCE_KEY,
  PAGE_INSTANCE_SHAPE,
  resolvePageInstance,
  resolvePageInstanceId,
  type InstanceLockPort,
  type InstanceStoragePort,
} from '../../apps/shell/src/client/page-instance.ts';

const immediate = { delay: async () => undefined, retryDelayMs: 0 };

class MemoryStorage implements InstanceStoragePort {
  readonly map = new Map<string, string>();
  private readonly mode: { read?: 'throw'; write?: 'throw' };
  constructor(mode: { read?: 'throw'; write?: 'throw' } = {}) {
    this.mode = mode;
  }
  getItem(key: string): string | null {
    if (this.mode.read === 'throw') throw new Error('storage disabled（测试注入：读取）');
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.mode.write === 'throw') throw new Error('storage disabled（测试注入：写入）');
    this.map.set(key, value);
  }
}

class FakeLocks implements InstanceLockPort {
  readonly held = new Set<string>();
  /** 永远拿不到的名字（模拟"别的活页面正持有"）。 */
  readonly refuse = new Set<string>();
  attempts = 0;
  async tryAcquire(name: string): Promise<boolean> {
    this.attempts += 1;
    if (this.refuse.has(name) || this.held.has(name)) return false;
    this.held.add(name);
    return true;
  }
}

/* --------------------------- 读取失败：不得冒泡 --------------------------- */

test('R1.2-02a getItem 抛错：不得抛出异常，也不得伪造新身份', async () => {
  const storage = new MemoryStorage({ read: 'throw' });
  let generated = 0;
  const id = await resolvePageInstanceId({
    storage,
    locks: new FakeLocks(),
    newId: () => `generated-${++generated}`,
    ...immediate,
  });
  assert.equal(id, null, '读不到上次的身份时，绝不能凭空造一个"稳定 id"');
  assert.equal(generated, 0, '读取失败就不该生成候选 id（生成也无法与上次对齐）');

  const resolved = await resolvePageInstance({
    storage,
    locks: new FakeLocks(),
    newId: () => `generated-${++generated}`,
    ...immediate,
  });
  assert.equal(resolved.id, null);
  assert.equal(resolved.degraded, 'storage-read-failed');
});

/* --------------------------- 写入失败：不得宣称稳定 --------------------------- */

test('R1.2-02b 新生成的 id 没能持久化：不得返回它', async () => {
  const storage = new MemoryStorage({ write: 'throw' });
  let generated = 0;
  const resolved = await resolvePageInstance({
    storage,
    locks: new FakeLocks(),
    newId: () => `ephemeral-${++generated}`,
    ...immediate,
  });
  assert.equal(generated, 1, '必须真的尝试过一次新 id');
  assert.equal(resolved.id, null, '未持久化的 id 刷新后必然变化，不能当页面身份返回');
  assert.equal(resolved.degraded, 'storage-write-failed');

  const viaId = await resolvePageInstanceId({
    storage,
    locks: new FakeLocks(),
    newId: () => `ephemeral-${++generated}`,
    ...immediate,
  });
  assert.equal(viaId, null);
});

test('R1.2-02c 旧身份本来就在存储里：重写失败不影响它的可持续性', async () => {
  const storage = new MemoryStorage();
  storage.setItem(PAGE_INSTANCE_KEY, 'persisted-page-aaaaaaaa');
  // 之后存储变成只读（例如配额耗尽）：这个 id 仍在 sessionStorage 里
  const readOnly = new MemoryStorage({ write: 'throw' });
  readOnly.map.set(PAGE_INSTANCE_KEY, 'persisted-page-aaaaaaaa');

  const resolved = await resolvePageInstance({
    storage: readOnly,
    locks: new FakeLocks(),
    newId: () => 'should-not-be-used',
    ...immediate,
  });
  assert.equal(resolved.id, 'persisted-page-aaaaaaaa');
  assert.equal(resolved.degraded, null, '已经持久化的身份不算降级');

  // 对照：普通可写存储下行为不变
  const ok = await resolvePageInstanceId({
    storage,
    locks: new FakeLocks(),
    ...immediate,
  });
  assert.equal(ok, 'persisted-page-aaaaaaaa');
});

/* --------------------------- 无存储 / 抢不到锁 --------------------------- */

test('R1.2-02d 没有 sessionStorage：不给身份（原因可诊断）', async () => {
  const resolved = await resolvePageInstance({ storage: null, locks: new FakeLocks(), ...immediate });
  assert.equal(resolved.id, null);
  assert.equal(resolved.degraded, 'no-storage');
});

test('R1.2-02e 连新 id 都抢不到锁：宁可不带身份也不与别人共用', async () => {
  const locks = new FakeLocks();
  const storage = new MemoryStorage();
  storage.setItem(PAGE_INSTANCE_KEY, 'contended-page-aaaaaa');
  // 候选与"换一个"的候选都已被别的活页面占住
  locks.refuse.add('contended-page-aaaaaa');
  locks.refuse.add('second-choice-aaaaaaaa');
  const resolved = await resolvePageInstance({
    storage,
    locks,
    newId: () => 'second-choice-aaaaaaaa',
    ...immediate,
  });
  assert.equal(resolved.id, null);
  assert.equal(resolved.degraded, 'lock-contended');
});

test('R1.2-02f 成功路径不受影响：返回的 id 一定已落进 storage', async () => {
  const storage = new MemoryStorage();
  const resolved = await resolvePageInstance({ storage, locks: new FakeLocks(), ...immediate });
  assert.ok(resolved.id && PAGE_INSTANCE_SHAPE.test(resolved.id));
  assert.equal(resolved.degraded, null);
  assert.equal(storage.getItem(PAGE_INSTANCE_KEY), resolved.id);
});
