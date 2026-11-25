/**
 * UX-02C-03-P2-02-R1.2.1：台账的跨标签页原子性、UTF-8 字节上限与严格时间校验。
 *
 * 这里的"两个标签页"用**两个独立 store 共享同一份 storage + 同一把协调器**来建模：
 * 这正是浏览器里两个标签页的关系（各自的 store，同一份 localStorage，同一把
 * `navigator.locks` 锁）。协调器是进程内串行实现，语义与 Web Locks 相同：
 * 临界区里重新读取、校验、写盘。
 *
 * 关键判别力：每个用例都会让其中一个 store 的**镜像过期**，再验证它没有拿旧快照
 * 覆盖另一个 store 刚写进去的记录——去掉"锁内重读"，这些用例会真的失败。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createInlineCoordination,
  createTrashLedgerStore,
  createWebLockCoordination,
  encodeTrashLedger,
  MAX_TRASH_LEDGER_BYTES,
  MAX_TRASH_PENDING,
  readTrashLedger,
  TRASH_LEDGER_KEY,
  TRASH_LEDGER_LOCK,
  trashReserveAuthorizes,
  writeTrashLedger,
  type LockManagerLike,
  type TrashLedgerCoordination,
  type TrashPendingRecord,
  type TrashReserveOutcome,
} from '../../apps/shell/src/state/trash-ledger.ts';
import type { StorageLike } from '../../apps/shell/src/state/workspace-persistence.ts';

const WS = 'a1b2c3d4e5f60718';

function sharedStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function record(opId: string, overrides: Partial<TrashPendingRecord> = {}): TrashPendingRecord {
  return { workspaceKey: WS, projectId: 'project-001', opId, createdAt: '2026-11-25T00:00:00.000Z', ...overrides };
}

/** 两个"标签页"：各自的 store，共享 storage 与协调器。 */
function twoTabs(storage: StorageLike, coordination: TrashLedgerCoordination) {
  const tabA = createTrashLedgerStore(storage, readTrashLedger(storage), coordination);
  const tabB = createTrashLedgerStore(storage, readTrashLedger(storage), coordination);
  return { tabA, tabB };
}

const storedIds = (storage: StorageLike): string[] => {
  const read = readTrashLedger(storage);
  return read.status === 'ok' ? read.records.map((item) => item.opId) : [];
};

/* ================================================================== */
/* 一、跨标签页：锁内重读                                                */
/* ================================================================== */

test('P2-02-R1.2.1 跨标签页：镜像过期的一方不得覆盖对方刚写入的记录', async () => {
  const storage = sharedStorage();
  const { tabA, tabB } = twoTabs(storage, createInlineCoordination());
  await tabB.reserve(record('op-warm-000001'));

  // A 的镜像停留在"只有 1 条"，B 又写了一条（A 完全不知道）
  await tabB.reserve(record('op-warm-000002'));
  assert.deepEqual(storedIds(storage), ['op-warm-000001', 'op-warm-000002']);

  const outcome = await tabA.reserve(record('op-late-000003'));
  assert.equal(outcome.status, 'reserved');
  assert.deepEqual(
    storedIds(storage),
    ['op-warm-000001', 'op-warm-000002', 'op-late-000003'],
    'A 必须在锁内重读：拿自己的旧镜像写回会抹掉 B 的那条',
  );
  assert.equal(tabA.records().length, 3, '写完后本页镜像也要是最新的');
});

test('P2-02-R1.2.1 跨标签页：63 条时两个页面同时申请最后一个位置，只有一个拿到授权', async () => {
  const storage = sharedStorage();
  const { tabA, tabB } = twoTabs(storage, createInlineCoordination());
  for (let i = 0; i < MAX_TRASH_PENDING - 1; i += 1) {
    await tabA.reserve(record(`op-fill-${String(i).padStart(8, '0')}`));
  }
  assert.equal(tabA.records().length, MAX_TRASH_PENDING - 1);

  // 两个标签页同时点「恢复」：各自的 store 都以为还有 1 个位置
  const [fromA, fromB] = await Promise.all([
    tabA.reserve(record('op-tab-a-0001')),
    tabB.reserve(record('op-tab-b-0002')),
  ]);

  const statuses = [fromA.status, fromB.status].sort();
  assert.deepEqual(statuses, ['full', 'reserved'], '最后一个位置只能给一个请求');

  const ids = storedIds(storage);
  assert.equal(ids.length, MAX_TRASH_PENDING, '最终恰好 64 条');
  const winners = ['op-tab-a-0001', 'op-tab-b-0002'].filter((opId) => ids.includes(opId));
  assert.equal(winners.length, 1, '只有拿到授权的那条留在台账里，另一条不得出现在磁盘上');
});

test('P2-02-R1.2.1 跨标签页：同一 opId 在另一个页面申请 → exists，绝不授权', async () => {
  const storage = sharedStorage();
  const { tabA, tabB } = twoTabs(storage, createInlineCoordination());

  assert.equal((await tabA.reserve(record('op-shared-0001'))).status, 'reserved');
  const second = await tabB.reserve(record('op-shared-0001'));
  assert.equal(second.status, 'exists', 'exists 的含义是"这条还有一次没有结论的恢复"');
  assert.equal(storedIds(storage).length, 1, '不能重复占位');
  // B 的镜像也被刷新成最新（写路径统一走锁内重读）
  assert.deepEqual(tabB.records().map((item) => item.opId), ['op-shared-0001']);
});

test('P2-02-R1.2.1 跨标签页：释放同样走锁，不能用旧快照覆盖对方的新记录', async () => {
  const storage = sharedStorage();
  const { tabA, tabB } = twoTabs(storage, createInlineCoordination());

  await tabA.reserve(record('op-rel-a-0001'));
  await tabB.reserve(record('op-rel-b-0002'));
  assert.deepEqual(storedIds(storage), ['op-rel-a-0001', 'op-rel-b-0002']);

  // A 的镜像里只有自己那条；此时它释放自己那条
  const outcome = await tabA.release({
    workspaceKey: WS,
    projectId: 'project-001',
    opIds: ['op-rel-a-0001'],
  });
  assert.equal(outcome.status, 'changed');
  assert.deepEqual(storedIds(storage), ['op-rel-b-0002'], 'B 的记录不得被 A 的旧快照冲掉');

  // B 的镜像已经在 A 写入后过期，但再释放一次必须是 unchanged（锁内重读后看到已经没了）
  const again = await tabB.release({
    workspaceKey: WS,
    projectId: 'project-001',
    opIds: ['op-rel-a-0001'],
  });
  assert.equal(again.status, 'unchanged');
  assert.deepEqual(storedIds(storage), ['op-rel-b-0002']);
});

test('P2-02-R1.2.1 跨标签页：收敛也必须锁内重读，不能把别人的记录一起删掉', async () => {
  const storage = sharedStorage();
  const { tabA, tabB } = twoTabs(storage, createInlineCoordination());
  await tabA.reserve(record('op-rec-a-0001'));
  await tabB.reserve(record('op-rec-b-0002'));

  // A 的镜像里只有自己那条；列表里两条都在（A 已到终态，B 仍是 stored）
  const outcome = await tabA.reconcile({
    workspaceKey: WS,
    projectId: 'project-001',
    entries: [
      { opId: 'op-rec-a-0001', path: 'a.md', entryKind: 'file', size: 1, deletedAt: '2026-11-25T00:00:00.000Z', state: 'restored', canRestore: false },
      { opId: 'op-rec-b-0002', path: 'b.md', entryKind: 'file', size: 1, deletedAt: '2026-11-25T00:00:00.000Z', state: 'stored', canRestore: true },
    ],
    loaded: true,
  });
  assert.equal(outcome.status, 'changed');
  assert.deepEqual(storedIds(storage), ['op-rec-b-0002'], 'B 那条不得被 A 的旧镜像连带删除');
});

/* ================================================================== */
/* 二、没有跨标签页协调能力 → fail-closed                                 */
/* ================================================================== */

test('P2-02-R1.2.1 无 Web Locks：恢复整体关闭，绝不退回不安全的写盘', async () => {
  const storage = sharedStorage();
  const unsupported = createWebLockCoordination(null);
  const store = createTrashLedgerStore(storage, readTrashLedger(storage), unsupported);

  assert.equal(store.status(), 'unavailable');
  assert.match(store.blockMessage() ?? '', /跨标签页/);
  assert.doesNotMatch(store.blockMessage() ?? '', /清除本应用数据/);

  assert.equal((await store.reserve(record('op-no-lock-001'))).status, 'unavailable');
  assert.equal(
    (await store.release({ workspaceKey: WS, projectId: 'project-001', opIds: ['op-no-lock-001'] })).status,
    'unavailable',
  );
  assert.equal(
    (await store.reconcile({ workspaceKey: WS, projectId: 'project-001', entries: [], loaded: true })).status,
    'unavailable',
  );
  assert.deepEqual(st(storage), [], '一个字节都不许写');
});

function st(storage: StorageLike): string[] {
  return storedIds(storage);
}

test('P2-02-R1.2.1 Web Locks：所有写操作都用同一个固定锁名、独占模式', async () => {
  const storage = sharedStorage();
  const seen: Array<{ name: string; mode: string }> = [];
  const locks: LockManagerLike = {
    request(name, options, callback) {
      seen.push({ name, mode: options.mode });
      return Promise.resolve(callback());
    },
  };
  const store = createTrashLedgerStore(storage, readTrashLedger(storage), createWebLockCoordination(locks));

  await store.reserve(record('op-lock-0001'));
  await store.release({ workspaceKey: WS, projectId: 'project-001', opIds: ['op-lock-0001'] });
  await store.reconcile({ workspaceKey: WS, projectId: 'project-001', entries: [], loaded: true });

  assert.equal(seen.length, 3, 'reserve / release / reconcile 都必须过锁');
  assert.ok(
    seen.every((item) => item.name === TRASH_LEDGER_LOCK && item.mode === 'exclusive'),
    JSON.stringify(seen),
  );
});

/* ================================================================== */
/* 三、UTF-8 字节上限                                                    */
/* ================================================================== */

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

test('P2-02-R1.2.1 字节：纯 ASCII 台账可正常读写', () => {
  const storage = sharedStorage();
  const records = Array.from({ length: MAX_TRASH_PENDING }, (_, i) =>
    record(`op-ascii-${String(i).padStart(8, '0')}`),
  );
  assert.equal(writeTrashLedger(storage, records), true);
  const read = readTrashLedger(storage);
  assert.equal(read.status, 'ok');
  assert.equal(read.status === 'ok' ? read.records.length : -1, MAX_TRASH_PENDING);
});

test('P2-02-R1.2.1 字节：非 ASCII 的超限台账必须判损坏（按字节，不按字符数）', () => {
  const pad = '汉'.repeat(6000);
  const raw = JSON.stringify({ version: 1, records: [], pad });
  assert.ok(raw.length <= MAX_TRASH_LEDGER_BYTES, `字符数未超限（${raw.length}），必须靠字节判定`);
  assert.ok(byteLength(raw) > MAX_TRASH_LEDGER_BYTES, `字节数必须超限（${byteLength(raw)}）`);

  const storage = sharedStorage({ [TRASH_LEDGER_KEY]: raw });
  assert.deepEqual(readTrashLedger(storage), { status: 'corrupt' });
});

test('P2-02-R1.2.1 字节：写入前按字节拒写，且不留下会被判损坏的数据', () => {
  const storage = sharedStorage();
  const bulky: TrashPendingRecord[] = [record('op-wide-0001', { workspaceKey: '汉'.repeat(6000) })];
  assert.ok(byteLength(encodeTrashLedger(bulky)) > MAX_TRASH_LEDGER_BYTES);

  assert.equal(writeTrashLedger(storage, bulky), false);
  assert.equal(storage.data.has(TRASH_LEDGER_KEY), false, '一个字节都不许写进去');
  assert.deepEqual(readTrashLedger(storage), { status: 'ok', records: [] }, '下次启动仍是干净的首次使用');
});

test('P2-02-R1.2.1 字节：恰好达到上限可读，再多一个字节即判损坏', () => {
  const base = '{"version":1,"records":[],"pad":""}';
  const needed = MAX_TRASH_LEDGER_BYTES - base.length;
  const exact = '{"version":1,"records":[],"pad":"' + 'a'.repeat(needed) + '"}';
  assert.equal(byteLength(exact), MAX_TRASH_LEDGER_BYTES);
  assert.deepEqual(readTrashLedger(sharedStorage({ [TRASH_LEDGER_KEY]: exact })), { status: 'ok', records: [] });

  const over = '{"version":1,"records":[],"pad":"' + 'a'.repeat(needed + 1) + '"}';
  assert.equal(byteLength(over), MAX_TRASH_LEDGER_BYTES + 1);
  assert.deepEqual(readTrashLedger(sharedStorage({ [TRASH_LEDGER_KEY]: over })), { status: 'corrupt' });
});

/* ================================================================== */
/* 四、createdAt 必须是规范 ISO 8601 UTC                                 */
/* ================================================================== */

function ledgerWith(createdAt: string) {
  return sharedStorage({
    [TRASH_LEDGER_KEY]: JSON.stringify({
      version: 1,
      records: [{ workspaceKey: WS, projectId: 'project-001', opId: 'op-time-0001', createdAt }],
    }),
  });
}

test('P2-02-R1.2.1 时间：合法 ISO 8601 UTC 仍然兼容', () => {
  const ok = readTrashLedger(ledgerWith('2026-11-23T04:05:06.000Z'));
  assert.equal(ok.status, 'ok');
  assert.equal(ok.status === 'ok' ? ok.records[0].createdAt : '', '2026-11-23T04:05:06.000Z');
});

test('P2-02-R1.2.1 时间：越界日期与不规范写法一律拒绝', () => {
  const bad = [
    '2026-02-30T00:00:00.000Z', // 2 月没有 30 日：Date.parse 会顺延到 3 月 2 日
    '2026-13-01T00:00:00.000Z', // 月份越界
    '2026-11-24T00:00:00Z', // 缺毫秒
    '2026-11-24T00:00:00.000+08:00', // 不是 Z 结尾
    '2026-11-24 00:00:00.000Z', // 用空格分隔
    '2026-11-24T00:00:00.000z', // 小写 z
    'not-a-date',
    '',
  ];
  for (const value of bad) {
    assert.deepEqual(readTrashLedger(ledgerWith(value)), { status: 'corrupt' }, `必须拒绝：${JSON.stringify(value)}`);
  }
});

test('P2-02-R1.2.1 时间：非法时间戳不会被当成"没有记录"而放行', async () => {
  const storage = ledgerWith('2026-02-30T00:00:00.000Z');
  const store = createTrashLedgerStore(storage, readTrashLedger(storage), createInlineCoordination());
  assert.equal(store.status(), 'corrupt');
  assert.match(store.blockMessage() ?? '', /已损坏/);
  // 读不懂就不写：原字节留着才有可能修复
  assert.equal((await store.reserve(record('op-time-0002'))).status, 'unavailable');
  assert.equal(storage.data.get(TRASH_LEDGER_KEY)?.includes('2026-02-30'), true);
});

/* ================================================================== */
/* 五、授权表：只有 reserved 能放行 POST                                  */
/* ================================================================== */

test('P2-02-R1.2.1 授权表：只有 reserved 授权新的恢复 POST', () => {
  const outcomes: TrashReserveOutcome[] = [
    { status: 'reserved' },
    { status: 'exists' },
    { status: 'full' },
    { status: 'unavailable' },
    { status: 'invalid' },
    { status: 'write-failed' },
  ];
  for (const outcome of outcomes) {
    assert.equal(
      trashReserveAuthorizes(outcome),
      outcome.status === 'reserved',
      `${outcome.status} 的授权判定错了`,
    );
  }
});

test('P2-02-R1.2.1 跨标签页：storage 事件用 refresh 同步镜像（只动显示，不写盘）', async () => {
  const storage = sharedStorage();
  const { tabA, tabB } = twoTabs(storage, createInlineCoordination());
  await tabA.reserve(record('op-sync-0001'));

  // B 还没收到通知：镜像是空的
  assert.deepEqual(tabB.records(), []);
  assert.equal(tabB.refresh(), true, '发现存储变了');
  assert.deepEqual(tabB.records().map((item) => item.opId), ['op-sync-0001']);
  assert.equal(tabB.refresh(), false, '再刷一次没有变化');
  // refresh 不写盘：A 刚写的记录不会被"空镜像"覆盖
  assert.deepEqual(storedIds(storage), ['op-sync-0001']);
});

/* ================================================================== */
/* 六、R1.2.1-R1：台账被外部删除 / 清空 / 写坏                           */
/* ================================================================== */

/** 已有 UNKNOWN 的两个标签页：A 写入、B 同步（这就是"另一个页面已经知道这条"）。 */
async function twoTabsWithUnknown(opId = 'op-known-0001') {
  const storage = sharedStorage();
  const { tabA, tabB } = twoTabs(storage, createInlineCoordination());
  assert.equal((await tabA.reserve(record(opId))).status, 'reserved');
  assert.equal(tabB.refresh(), true);
  assert.deepEqual(tabB.records().map((item) => item.opId), [opId]);
  return { storage, tabA, tabB };
}

test('P2-02-R1.2.1-R1 首次启动：没有台账是合法的空台账，不是损坏', () => {
  const storage = sharedStorage();
  const store = createTrashLedgerStore(storage, readTrashLedger(storage), createInlineCoordination());

  assert.equal(store.status(), 'ok');
  assert.deepEqual(store.records(), []);
  assert.equal(store.blockMessage(), null);
  assert.equal(store.snapshot().version, 0, '第一次读到空台账不算一次变化');
});

test('P2-02-R1.2.1-R1 外部 removeItem：保留内存待核对、状态失效、写操作全关、不重建', async () => {
  const { storage, tabB } = await twoTabsWithUnknown('op-ext-del-01');

  // 另一个页面把整条台账删掉：下次读取看起来就是"干净的首次使用"
  storage.removeItem(TRASH_LEDGER_KEY);
  const changed = tabB.applyExternalEvent({ key: TRASH_LEDGER_KEY, newValue: null });

  assert.equal(changed, true, '必须通知界面重画');
  assert.equal(tabB.status(), 'invalidated');
  assert.deepEqual(tabB.records().map((item) => item.opId), ['op-ext-del-01'], '内存记录一条都不许丢');
  assert.match(tabB.blockMessage() ?? '', /删除|失效/);

  // 三个写路径全部拒绝：既不写盘，也不"重建"一份空台账
  assert.equal((await tabB.reserve(record('op-ext-del-02'))).status, 'unavailable');
  assert.equal(
    (await tabB.release({ workspaceKey: WS, projectId: 'project-001', opIds: ['op-ext-del-01'] })).status,
    'unavailable',
  );
  assert.equal(
    (await tabB.reconcile({ workspaceKey: WS, projectId: 'project-001', entries: [], loaded: true })).status,
    'unavailable',
  );
  assert.equal(storage.data.has(TRASH_LEDGER_KEY), false, '不许自动重建空台账');
});

test('P2-02-R1.2.1-R1 外部 localStorage.clear：event.key === null 同样进入失效保护', async () => {
  const { storage, tabB } = await twoTabsWithUnknown('op-ext-clr-01');
  storage.setItem('ws:workspace:v1:keep', '{"version":1}');

  // clear() 的 storage 事件是 key === null / newValue === null
  storage.data.clear();
  assert.equal(tabB.applyExternalEvent({ key: null, newValue: null }), true);

  assert.equal(tabB.status(), 'invalidated');
  assert.deepEqual(tabB.records().map((item) => item.opId), ['op-ext-clr-01']);
  assert.match(tabB.blockMessage() ?? '', /删除|失效/);
  assert.equal((await tabB.reserve(record('op-ext-clr-02'))).status, 'unavailable');
  assert.equal(storage.data.has(TRASH_LEDGER_KEY), false, '不许自动重建空台账');
});

test('P2-02-R1.2.1-R1 删除之后再写入空台账：本页仍保持失效，refresh 不得解除', async () => {
  const { storage, tabA, tabB } = await twoTabsWithUnknown('op-ext-late1');
  storage.removeItem(TRASH_LEDGER_KEY);
  assert.equal(tabB.applyExternalEvent({ key: TRASH_LEDGER_KEY, newValue: null }), true);
  assert.equal(tabB.status(), 'invalidated');

  // 别的页面又写了一份"合法但为空"的台账（或用户手动重建）
  const empty = encodeTrashLedger([]);
  storage.setItem(TRASH_LEDGER_KEY, empty);
  assert.equal(
    tabB.applyExternalEvent({ key: TRASH_LEDGER_KEY, newValue: empty }),
    false,
    '失效之后普通 storage 事件不得再改动本页状态',
  );
  assert.equal(tabB.refresh(), false, 'refresh 也不能把失效保护解除');
  assert.equal(tabB.status(), 'invalidated');
  assert.deepEqual(tabB.records().map((item) => item.opId), ['op-ext-late1'], '内存记录仍然保留');
  assert.equal((await tabB.reserve(record('op-ext-late2'))).status, 'unavailable');

  // 另一个仍然健康的页面（A）读到的是"空台账"：这是它自己的视角，本页不跟
  assert.deepEqual(storedIds(storage), []);
  assert.equal(tabA.status(), 'ok');
});

test('P2-02-R1.2.1-R1 外部写入非法 JSON：保留内存记录、进入 corrupt、不覆盖原始字节', async () => {
  const { storage, tabB } = await twoTabsWithUnknown('op-ext-bad-01');
  const broken = '{"version":1,"records":[{"workspaceKey":';
  storage.setItem(TRASH_LEDGER_KEY, broken);

  assert.equal(tabB.applyExternalEvent({ key: TRASH_LEDGER_KEY, newValue: broken }), true, '状态变了就要通知');
  assert.equal(tabB.status(), 'corrupt');
  assert.deepEqual(tabB.records().map((item) => item.opId), ['op-ext-bad-01'], '内存记录仍然保留');
  assert.match(tabB.blockMessage() ?? '', /损坏/);
  assert.equal(storage.data.get(TRASH_LEDGER_KEY), broken, '原始损坏数据不得被覆盖');
  assert.equal((await tabB.reserve(record('op-ext-bad-02'))).status, 'unavailable');
});

test('P2-02-R1.2.1-R1 无关 key 的 storage 事件不影响台账', async () => {
  const { tabB } = await twoTabsWithUnknown('op-ext-irr-01');

  assert.equal(tabB.applyExternalEvent({ key: 'ws:workspace:v1:abc', newValue: null }), false);
  assert.equal(tabB.applyExternalEvent({ key: 'something-else', newValue: '{"broken' }), false);
  assert.equal(tabB.status(), 'ok');
  assert.deepEqual(tabB.records().map((item) => item.opId), ['op-ext-irr-01']);
  assert.equal((await tabB.reserve(record('op-ext-irr-02'))).status, 'reserved');
});

test('P2-02-R1.2.1-R1 删除事件尚未到达：reserve 不得把已知记录覆盖成"只剩新的这一条"', async () => {
  const { storage, tabB } = await twoTabsWithUnknown('op-ext-race1');

  // 模拟"删除已经发生但 storage 事件还没送达这一帧"
  storage.removeItem(TRASH_LEDGER_KEY);
  const outcome = await tabB.reserve(record('op-ext-race2'));

  assert.equal(outcome.status, 'unavailable', '持久层突然变空时不能当它是首次使用');
  assert.deepEqual(tabB.records().map((item) => item.opId), ['op-ext-race1'], '内存记录必须保住');
  assert.equal(storage.data.has(TRASH_LEDGER_KEY), false, '更不能拿一份"只剩新记录"的台账覆盖删除现场');
});
