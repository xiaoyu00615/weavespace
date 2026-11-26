/**
 * UX-02C-03-P2-02-R1.2.1-R2：独立持久化保护记录、StorageEvent 竞争、三写路径一致性。
 *
 * 这一套件只测**可注入**的部分：`TrashGuardStorage` 用内存假件（真实 IndexedDB 由
 * 浏览器证据证明），`StorageLike` 用内存 Map。要点是两个持久化层的关系：
 * - 主台账（localStorage）可以被外部删除 / 清空 / 写坏；
 * - 保护记录（IndexedDB）是**耐久真相**：它先于授权写入，外部删除动不到它。
 *
 * 因此"台账突然没了"与"记录已经结清"必须能被区分：前者保护记录里还有记录，
 * 后者保护记录也已经是空的（正常结清必须写合法空台账，不能 removeItem）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createInlineCoordination,
  createTrashLedgerStore,
  encodeTrashLedger,
  readTrashLedger,
  TRASH_LEDGER_KEY,
  trashReserveAuthorizes,
  type TrashLedgerCoordination,
  type TrashPendingRecord,
} from '../../apps/shell/src/state/trash-ledger.ts';
import type { TrashGuardRecord, TrashGuardStorage } from '../../apps/shell/src/state/trash-ledger-guard.ts';
import type { StorageLike } from '../../apps/shell/src/state/workspace-persistence.ts';

const WS = 'a1b2c3d4e5f60718';
const PROJ = 'project-001';
const AT = '2026-11-26T00:00:00.000Z';

function record(opId: string, overrides: Partial<TrashPendingRecord> = {}): TrashPendingRecord {
  return { workspaceKey: WS, projectId: PROJ, opId, createdAt: AT, ...overrides };
}

function memoryStorage(): StorageLike & { data: Map<string, string>; failWrites: boolean } {
  const data = new Map<string, string>();
  const storage = {
    data,
    failWrites: false,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (storage.failWrites) throw new Error('quota');
      data.set(key, value);
    },
    removeItem: (key: string) => void data.delete(key),
  };
  return storage;
}

interface GuardBox {
  record: TrashGuardRecord | null;
  failRead: boolean;
  failWrite: boolean;
  reads: number;
  writes: TrashGuardRecord[];
}

function memoryGuard(initial: TrashGuardRecord | null = null): { box: GuardBox; guard: TrashGuardStorage } {
  const box: GuardBox = { record: initial, failRead: false, failWrite: false, reads: 0, writes: [] };
  const guard: TrashGuardStorage = {
    read: async () => {
      box.reads += 1;
      if (box.failRead) throw new Error('indexeddb unavailable');
      return box.record;
    },
    write: async (next) => {
      box.writes.push(next);
      if (box.failWrite) return false;
      box.record = next;
      return true;
    },
  };
  return { box, guard };
}

const inline = (): TrashLedgerCoordination => createInlineCoordination();

function newStore(
  storage: StorageLike,
  guard: TrashGuardStorage | null,
  coordination: TrashLedgerCoordination = inline(),
) {
  return createTrashLedgerStore(storage, readTrashLedger(storage), coordination, guard ? { guard } : {});
}

const storedIds = (storage: StorageLike): string[] => {
  const read = readTrashLedger(storage);
  return read.status === 'ok' ? read.records.map((item) => item.opId) : [];
};

const guardIds = (box: GuardBox): string[] => (box.record ? box.record.records.map((item) => item.opId) : []);

const entry = (opId: string, state: 'stored' | 'restored' = 'stored') => ({
  opId,
  path: 'p.md',
  entryKind: 'file' as const,
  size: 4,
  deletedAt: AT,
  state,
  canRestore: state === 'stored',
});

/* ================================================================== */
/* A 组：独立持久化保护                                                  */
/* ================================================================== */

test('R2-A1 首次使用：两层都没有记录 → 合法空台账，并落下空保护记录', async () => {
  const storage = memoryStorage();
  const { box, guard } = memoryGuard();
  const store = newStore(storage, guard);
  await store.ready();

  assert.equal(store.status(), 'ok');
  assert.deepEqual(store.records(), []);
  assert.equal(store.blockMessage(), null);
  assert.deepEqual(guardIds(box), [], '首次使用要初始化出空的保护记录，而不是永远缺席');
});

test('R2-A2 R1 升级：主台账已有 UNKNOWN、保护记录不存在 → 迁移而不是丢弃', async () => {
  const storage = memoryStorage();
  const { box, guard } = memoryGuard();
  // 模拟 R1 留下的台账：只有 localStorage 有记录
  const seed = newStore(storage, null);
  assert.equal((await seed.reserve(record('op-migrate-001'))).status, 'reserved');
  assert.deepEqual(storedIds(storage), ['op-migrate-001']);

  const store = newStore(storage, guard);
  await store.ready();
  assert.equal(store.status(), 'ok');
  assert.deepEqual(store.records().map((item) => item.opId), ['op-migrate-001'], '升级后首次启动不得丢记录');
  assert.deepEqual(guardIds(box), ['op-migrate-001'], '要把已有记录迁进保护记录');
  assert.equal(box.record?.invalidated, false);
});

test('R2-A3 外部 removeItem 后重开页面：保护记录仍在 → invalidated，记录不丢', async () => {
  const storage = memoryStorage();
  const { box, guard } = memoryGuard();
  const first = newStore(storage, guard);
  await first.ready();
  await first.reserve(record('op-survive-001'));

  // 外部删除主台账（保护记录不受影响）
  storage.removeItem(TRASH_LEDGER_KEY);
  assert.deepEqual(storedIds(storage), []);

  const reopened = newStore(storage, guard);
  await reopened.ready();
  assert.equal(reopened.status(), 'invalidated', '刷新页面后不能重新开放恢复');
  assert.deepEqual(reopened.records().map((item) => item.opId), ['op-survive-001']);
  assert.match(reopened.blockMessage() ?? '', /删除|失效/);
  assert.equal(box.record?.invalidated, true, '失效标记必须落到保护记录里');
});

test('R2-A4 外部 clear 后重开页面：仍保留待核对并保持失效', async () => {
  const storage = memoryStorage();
  const { guard } = memoryGuard();
  const first = newStore(storage, guard);
  await first.ready();
  await first.reserve(record('op-cleared-001'));

  storage.data.clear();

  const reopened = newStore(storage, guard);
  await reopened.ready();
  assert.equal(reopened.status(), 'invalidated');
  assert.deepEqual(reopened.records().map((item) => item.opId), ['op-cleared-001']);
  assert.equal((await reopened.reserve(record('op-cleared-002'))).status, 'unavailable');
  assert.deepEqual(storedIds(storage), [], '不许自动重建空台账');
});

test('R2-A5 正常结清最后一条：两层都写成合法空台账，重开仍是正常状态', async () => {
  const storage = memoryStorage();
  const { box, guard } = memoryGuard();
  const store = newStore(storage, guard);
  await store.ready();
  await store.reserve(record('op-settle-001'));

  const outcome = await store.reconcile({
    workspaceKey: WS,
    projectId: PROJ,
    entries: [entry('op-settle-001', 'restored')],
    loaded: true,
  });
  assert.equal(outcome.status, 'changed');
  assert.equal(storage.data.has(TRASH_LEDGER_KEY), true, '正常结清要写合法空台账，不能把 key 删掉');
  assert.deepEqual(storedIds(storage), []);
  assert.deepEqual(guardIds(box), []);
  assert.equal(box.record?.invalidated, false);

  const reopened = newStore(storage, guard);
  await reopened.ready();
  assert.equal(reopened.status(), 'ok', '结清后重启不能误判为失效');
  assert.deepEqual(reopened.records(), []);
});

test('R2-A6 保护记录写入失败：不得授权，也不许先写主台账', async () => {
  const storage = memoryStorage();
  const { box, guard } = memoryGuard();
  const store = newStore(storage, guard);
  await store.ready();

  box.failWrite = true;
  const outcome = await store.reserve(record('op-guardfail-01'));
  assert.equal(outcome.status, 'write-failed');
  assert.equal(trashReserveAuthorizes(outcome), false, '保护记录没落盘就不能授权 POST');
  assert.deepEqual(storedIds(storage), [], '保护记录失败时不该留下半条主台账');
  assert.deepEqual(store.records(), [], '内存也不许假装已经预留');
});

test('R2-A7 主台账写入失败：不算授权，但保护记录保留（保守多拦一次）', async () => {
  const storage = memoryStorage();
  const { box, guard } = memoryGuard();
  const store = newStore(storage, guard);
  await store.ready();

  storage.failWrites = true;
  const outcome = await store.reserve(record('op-mainfail-01'));
  assert.equal(outcome.status, 'write-failed');
  assert.equal(trashReserveAuthorizes(outcome), false);
  assert.deepEqual(storedIds(storage), []);
  assert.deepEqual(guardIds(box), ['op-mainfail-01'], '保护记录可以比主台账更保守');
});

test('R2-A8 保护记录读不出来：整体 unavailable，恢复关闭', async () => {
  const storage = memoryStorage();
  const { box, guard } = memoryGuard();
  const store = newStore(storage, guard);
  await store.ready();
  await store.reserve(record('op-unreadable-1'));

  box.failRead = true;
  const reopened = newStore(storage, guard);
  await reopened.ready();
  assert.equal(reopened.status(), 'unavailable');
  assert.match(reopened.blockMessage() ?? '', /不可用/);
  assert.equal((await reopened.reserve(record('op-unreadable-2'))).status, 'unavailable');
});

/* ================================================================== */
/* B 组：StorageEvent 竞争                                              */
/* ================================================================== */

/**
 * A 页面连续 setItem → removeItem，B 页面还没处理第一个事件。
 * 处理第一个事件时，当前 localStorage 已经是空的——必须用事件自己的 newValue。
 */
test('R2-B1 事件必须使用自己的 newValue，不能回读当前（已变空的）localStorage', async () => {
  const storage = memoryStorage();
  const { guard } = memoryGuard();
  const store = newStore(storage, guard);
  await store.ready();

  const firstValue = encodeTrashLedger([record('op-race-0001')]);
  // 事件 1 的快照是"有一条记录"，而此刻持久层已经被删掉了
  storage.removeItem(TRASH_LEDGER_KEY);

  const changed = store.applyExternalEvent({ key: TRASH_LEDGER_KEY, newValue: firstValue });
  assert.equal(changed, true);
  assert.equal(store.status(), 'ok', '还没收到删除事件，不能先把状态变成失效');
  assert.deepEqual(store.records().map((item) => item.opId), ['op-race-0001'], '事件快照里的记录必须采纳');

  // 事件 2 才是删除
  assert.equal(store.applyExternalEvent({ key: TRASH_LEDGER_KEY, newValue: null }), true);
  assert.equal(store.status(), 'invalidated');
  assert.deepEqual(store.records().map((item) => item.opId), ['op-race-0001'], '记录一条都不许丢');
});

test('R2-B2 删除之后再收到旧的非空事件：不得解除失效，也不得改回可恢复', async () => {
  const storage = memoryStorage();
  const { guard } = memoryGuard();
  const store = newStore(storage, guard);
  await store.ready();
  await store.reserve(record('op-sticky-001'));

  store.applyExternalEvent({ key: TRASH_LEDGER_KEY, newValue: null });
  assert.equal(store.status(), 'invalidated');

  const versionBefore = store.snapshot().version;
  // 旧事件里还带着一条更早写入的记录：失效之后连镜像都不许再动
  const stale = encodeTrashLedger([record('op-sticky-001'), record('op-sticky-old')]);
  assert.equal(store.applyExternalEvent({ key: TRASH_LEDGER_KEY, newValue: stale }), false, '失效后不再跟随事件');
  assert.equal(store.status(), 'invalidated');
  assert.equal(store.snapshot().version, versionBefore, '失效是终态：版本都不该再动');
  assert.equal(store.refresh(), false, 'refresh 也不能解除');
  assert.deepEqual(
    store.records().map((item) => item.opId),
    ['op-sticky-001'],
    '旧事件不得往失效页面的镜像里塞记录',
  );
});

test('R2-B3 clear（key === null）保留原有记录并进入失效', async () => {
  const storage = memoryStorage();
  const { guard } = memoryGuard();
  const store = newStore(storage, guard);
  await store.ready();
  await store.reserve(record('op-clear-0001'));

  assert.equal(store.applyExternalEvent({ key: null, newValue: null }), true);
  assert.equal(store.status(), 'invalidated');
  assert.deepEqual(store.records().map((item) => item.opId), ['op-clear-0001']);
});

test('R2-B4 外部写坏 JSON：进入 corrupt、保留内存记录、不覆盖原字节', async () => {
  const storage = memoryStorage();
  const { guard } = memoryGuard();
  const store = newStore(storage, guard);
  await store.ready();
  await store.reserve(record('op-corrupt-001'));

  const broken = '{"version":1,"records":[';
  storage.setItem(TRASH_LEDGER_KEY, broken);
  assert.equal(store.applyExternalEvent({ key: TRASH_LEDGER_KEY, newValue: broken }), true);
  assert.equal(store.status(), 'corrupt');
  assert.deepEqual(store.records().map((item) => item.opId), ['op-corrupt-001']);
  assert.equal(storage.data.get(TRASH_LEDGER_KEY), broken);
});

test('R2-B5 无关 key 的事件被忽略', async () => {
  const storage = memoryStorage();
  const { guard } = memoryGuard();
  const store = newStore(storage, guard);
  await store.ready();
  await store.reserve(record('op-unrelated1'));

  assert.equal(store.applyExternalEvent({ key: 'ws:workspace:v1:x', newValue: null }), false);
  assert.equal(store.applyExternalEvent({ key: 'other', newValue: '{"broken' }), false);
  assert.equal(store.status(), 'ok');
  assert.deepEqual(store.records().map((item) => item.opId), ['op-unrelated1']);
});

/* ================================================================== */
/* C 组：reserve / release / reconcile 的异常缺失处理要一致              */
/* ================================================================== */

for (const kind of ['reserve', 'release', 'reconcile'] as const) {
  test(`R2-C ${kind}：锁内发现主台账异常缺失 → 保留记录、失效、不可用、快照更新`, async () => {
    const storage = memoryStorage();
    const { box, guard } = memoryGuard();
    const store = newStore(storage, guard);
    await store.ready();
    await store.reserve(record('op-missing-001'));

    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    const before = store.snapshot().version;

    // 外部删除主台账，但保护记录里还有这条
    storage.removeItem(TRASH_LEDGER_KEY);

    const outcome =
      kind === 'reserve'
        ? await store.reserve(record('op-missing-002'))
        : kind === 'release'
          ? await store.release({ workspaceKey: WS, projectId: PROJ, opIds: ['op-missing-001'] })
          : await store.reconcile({
              workspaceKey: WS,
              projectId: PROJ,
              entries: [entry('op-missing-001', 'restored')],
              loaded: true,
            });

    assert.equal(outcome.status, 'unavailable', `${kind} 必须 fail-closed`);
    assert.equal(store.status(), 'invalidated');
    assert.deepEqual(store.records().map((item) => item.opId), ['op-missing-001'], `${kind} 不得丢记录`);
    assert.deepEqual(guardIds(box), ['op-missing-001'], `${kind} 不得清除保护记录`);
    assert.deepEqual(storedIds(storage), [], `${kind} 不得重建空台账`);
    assert.ok(notified > 0, '必须通过订阅通知界面');
    assert.ok(store.snapshot().version > before);
    assert.ok(store.snapshot().blockMessage, '闸门文案必须同步关闭');
  });
}

test('R2-C 正常写入合法空台账不触发 invalidated（另一页面结清）', async () => {
  const storage = memoryStorage();
  const { box, guard } = memoryGuard();
  const store = newStore(storage, guard);
  await store.ready();
  await store.reserve(record('op-settled-001'));

  // 另一个页面正常结清：两层都写成空（不是 removeItem）
  storage.setItem(TRASH_LEDGER_KEY, encodeTrashLedger([]));
  box.record = { version: 1, records: [], invalidated: false };

  const outcome = await store.reconcile({
    workspaceKey: WS,
    projectId: PROJ,
    entries: [entry('op-settled-001', 'restored')],
    loaded: true,
  });
  // 记录已经在另一页面结清：这里既可能"读到空、无事可做"，也可能"补写一次空台账"
  assert.ok(outcome.status === 'changed' || outcome.status === 'unchanged', outcome.status);
  assert.equal(store.status(), 'ok', '已经结清的记录不能被当成异常缺失');
  assert.deepEqual(store.records(), []);
});

/* ================================================================== */
/* R2-04：浏览器验证脚本的退出码必须是可信信号                            */
/* ================================================================== */

test('R2-04 验证脚本：全部通过退出 0，任一失败退出 1（不是无条件 exit(0)）', () => {
  const script = fileURLToPath(
    new URL('../../docs/evidence/ux-02c-03-p2-02-r1.2.1-r1/verify-browser.mjs', import.meta.url),
  );

  const failing = spawnSync(process.execPath, [script, '--self-test'], { encoding: 'utf8' });
  assert.equal(failing.status, 1, `合成失败必须非零退出；stdout=${failing.stdout} stderr=${failing.stderr}`);
  assert.match(failing.stdout, /"exitCode":1/);

  const passing = spawnSync(process.execPath, [script, '--self-test-pass'], { encoding: 'utf8' });
  assert.equal(passing.status, 0, `合成通过必须退出 0；stdout=${passing.stdout} stderr=${passing.stderr}`);
  assert.match(passing.stdout, /"exitCode":0/);
});
