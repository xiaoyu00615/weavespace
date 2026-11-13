/**
 * S11-C-R1 · 恢复与自动保存互斥门禁（AS-01…AS-05）。
 *
 * 背景：恢复是分阶段异步的，阶段 C 一个一个后台登记标签，而每次状态变化都会触发
 * 自动保存。如果没有门禁，"刚恢复了 2 个标签"的残缺状态就会覆盖"上次离开时有 8 个"
 * 的记录——**旧记录被自己的恢复流程毁掉**。调大节流延迟只是缩小窗口，不是修复。
 *
 * 这些用例全部用真实 Host + 真实 reducer 驱动，定时器由测试显式推进，
 * 因此"恢复中途写了一次"是可复现的事实，而不是偶发的竞态。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkspaceWriteGate } from '../../apps/shell/src/state/workspace-write-gate.ts';
import {
  EIGHT_TABS,
  MemoryStorage,
  makeHarness,
  makeRoots,
  nodeOf,
  seedEightTabs,
  startHost,
  waitFor,
} from '../helpers/s11c-harness.ts';

// ---------------------------------------------------------------------------
// AS-05a 门禁状态迁移（契约本身）
// ---------------------------------------------------------------------------
test('AS-05a 门禁状态迁移是显式的：hold/release/seal/adopt 各有唯一语义', () => {
  const gate = createWorkspaceWriteGate();
  assert.equal(gate.state(), 'open');
  assert.equal(gate.reason(), null);
  assert.equal(gate.allowsWrite(), true);

  gate.hold();
  assert.equal(gate.state(), 'held');
  assert.equal(gate.reason(), 'restoring');
  assert.equal(gate.allowsWrite(), false, '恢复期间禁止写入');

  gate.release();
  assert.equal(gate.state(), 'open');
  assert.equal(gate.reason(), null);

  // 中断之后不能靠"恢复自己说完成"悄悄放开
  gate.hold();
  gate.seal();
  assert.equal(gate.state(), 'sealed');
  assert.equal(gate.reason(), 'interrupted');
  gate.release();
  assert.equal(gate.state(), 'sealed', 'release 只对被本次恢复持有的状态生效');
  assert.equal(gate.allowsWrite(), false);

  // 只有显式提交点才放开
  gate.adopt();
  assert.equal(gate.state(), 'open');
  assert.equal(gate.allowsWrite(), true);
});

test('AS-05a2 恢复途中就接管：终态才放开（不抢先落盘残缺状态）', () => {
  const gate = createWorkspaceWriteGate();
  gate.hold();
  gate.adopt(); // 用户结构性操作，但恢复还在跑
  assert.equal(gate.state(), 'held', '接管意图不能立刻放开写入');
  assert.equal(gate.allowsWrite(), false);
  gate.seal(); // 恢复终态：已接管 → 合并提交
  assert.equal(gate.state(), 'open');
  assert.equal(gate.reason(), null);
});

// ---------------------------------------------------------------------------
// AS-01 恢复中途的自动保存不得覆盖完整记录
// ---------------------------------------------------------------------------
test('AS-01 恢复只登记了 2 个标签时，自动保存不得覆盖 8 个标签的记录', async () => {
  const roots = await makeRoots('ws-s11c-r1-as01-');
  const host = await startHost(roots, 'multi');
  const storage = new MemoryStorage();
  try {
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    const snapshot = await seedEightTabs(first);
    assert.equal(snapshot.tabs.length, 8);
    const before = first.recordRaw();
    assert.ok(before, '夹具前提：记录必须已落盘');

    const second = makeHarness(host.url, storage);
    // 只放行前 2 个：第 3 个打开请求挂起，此时状态里正好 2 个标签
    const release = second.holdOpenAt(3);
    const pending = second.restore();
    await waitFor(() => second.state.tabs.length === 2, '恢复应已登记 2 个标签');
    assert.equal(second.gate.state(), 'held', '恢复期间门禁必须合上');

    // 界面在这个中间态发生变化（拖动分屏 / 折叠 / 任何 dispatch）→ 触发自动保存
    second.dispatch({ type: 'SET_SPLIT_RATIO', ratio: 44 });
    second.advance();
    assert.equal(second.recordRaw(), before, '残缺状态绝不能写进存储');

    release();
    const report = await pending;
    assert.equal(report.status, 'restored');
    assert.equal(second.state.tabs.length, EIGHT_TABS.length);

    // 恢复完成后，完整状态才允许落盘
    second.advance();
    assert.equal(second.record()?.tabs.length, EIGHT_TABS.length, '完整恢复后应写回 8 个标签');
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AS-02 恢复期间 pagehide/flush 不得覆盖尚未恢复的记录
// ---------------------------------------------------------------------------
test('AS-02 恢复期间 flush（关页面）必须被拦住，原记录一字不差', async () => {
  const roots = await makeRoots('ws-s11c-r1-as02-');
  const host = await startHost(roots, 'multi');
  const storage = new MemoryStorage();
  try {
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await seedEightTabs(first);
    const before = first.recordRaw();

    const second = makeHarness(host.url, storage);
    const release = second.holdOpenAt(2);
    const pending = second.restore();
    await waitFor(() => second.state.tabs.length === 1, '恢复应已登记 1 个标签');

    assert.equal(second.flush(), 'held', '恢复期间的 flush 必须明确返回 held');
    assert.equal(second.recordRaw(), before, '尚未恢复的记录不得被覆盖');

    release();
    const report = await pending;
    assert.equal(report.status, 'restored');
    // 恢复完成后的 flush 才是真实提交
    assert.equal(second.flush(), 'written');
    assert.equal(second.record()?.tabs.length, EIGHT_TABS.length);
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AS-03 Host 不可达 / 恢复被中断：原记录与提示都保留
// ---------------------------------------------------------------------------
test('AS-03 Host 超时或恢复中断时，原快照与"未确认内容"提示都保留', async () => {
  const roots = await makeRoots('ws-s11c-r1-as03-');
  const host = await startHost(roots, 'multi');
  const storage = new MemoryStorage();
  try {
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    await first.opener.openNode(nodeOf('docs/notes.md', 'project-a'), 'project-a');
    // 一个标签带未确认内容
    first.dispatch({ type: 'EDIT_DOC', docId: 'doc:project-a/a.md', text: '# 未保存的草稿\n' });
    const seeded = first.saveSnapshot();
    assert.equal(seeded.tabs[0].hadUnsavedChanges, true);
    const before = first.recordRaw();

    // (a) Host 不可达：只恢复界面，不写任何东西
    const offline = makeHarness('http://127.0.0.1:9', storage);
    const offlineReport = await offline.restore();
    assert.equal(offlineReport.status, 'ui-only');
    assert.equal(offlineReport.reason, 'host-unavailable');
    assert.equal(offline.recordRaw(), before, '连不上 Host 时不得改动记录');

    // (b) 恢复被中断（连接期间用户接管，但没有结构性操作）
    const second = makeHarness(host.url, storage);
    const releaseConnect = second.holdConnect();
    const pending = second.restore();
    await waitFor(() => second.calls.some((call) => call.name === 'workspaceIdentity'));
    second.restorer.noteInteraction();
    releaseConnect();

    const report = await pending;
    assert.equal(report.status, 'interrupted');
    assert.equal(report.reason, 'superseded');
    assert.equal(second.gate.state(), 'sealed', '中断后记录必须继续被保护');
    assert.equal(second.flush(), 'held');
    assert.equal(second.recordRaw(), before, '原快照必须一字不差');

    const kept = second.record();
    assert.equal(
      kept?.tabs.find((tab) => tab.path === 'a.md')?.hadUnsavedChanges,
      true,
      '未确认内容提示必须仍然保留',
    );
    assert.equal(kept?.tabs.length, 2);
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AS-04 恢复正式完成后可以正常保存
// ---------------------------------------------------------------------------
test('AS-04 恢复到达终态后，新状态可以正常写入', async () => {
  const roots = await makeRoots('ws-s11c-r1-as04-');
  const host = await startHost(roots, 'multi');
  const storage = new MemoryStorage();
  try {
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    await first.opener.openNode(nodeOf('a.md', 'project-b'), 'project-b');
    first.saveSnapshot();

    const second = makeHarness(host.url, storage);
    const report = await second.restore();
    assert.equal(report.status, 'restored');
    assert.equal(second.gate.state(), 'open', '终态必须放开写入');

    second.dispatch({ type: 'SET_SPLIT_RATIO', ratio: 66 });
    second.dispatch({ type: 'TOGGLE_TREE' });
    second.advance();

    const record = second.record();
    assert.equal(record?.ui.splitRatio, 66, '恢复完成后新布局必须能落盘');
    assert.equal(record?.ui.treeCollapsed, true);
    assert.equal(record?.tabs.length, 2, '标签不得因保存而丢失');
    assert.equal(second.flush(), 'written');
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AS-05 用户接管后的提交规则：合并提交
// ---------------------------------------------------------------------------
test('AS-05 用户接管后是"合并提交"：当前标签 + 未处理的旧标签一条都不丢', async () => {
  const roots = await makeRoots('ws-s11c-r1-as05-');
  const host = await startHost(roots, 'multi');
  const storage = new MemoryStorage();
  try {
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await seedEightTabs(first);
    const before = first.recordRaw();

    const second = makeHarness(host.url, storage);
    const release = second.holdOpenAt(3);
    const pending = second.restore();
    await waitFor(() => second.state.tabs.length === 2, '恢复应已登记 2 个标签');

    // 用户结构性操作接管恢复（Provider 里打开/关闭/编辑/切模式都会这样做）
    second.restorer.noteInteraction();
    second.gate.adopt();
    assert.equal(second.gate.state(), 'held', '恢复还没结束，接管不能抢先放开写入');
    assert.equal(second.flush(), 'held');
    assert.equal(second.recordRaw(), before);

    release();
    const report = await pending;
    assert.equal(report.status, 'interrupted');
    assert.equal(report.tabsRestored, second.state.tabs.length, '报告的数量必须等于真正登记出来的标签数');
    assert.ok(report.tabsRestored >= 2);
    assert.equal(second.gate.state(), 'open', '接管后的终态就是提交点');

    second.advance();
    const record = second.record();
    assert.ok(record);
    assert.equal(record.tabs.length, EIGHT_TABS.length, '接管提交必须合并还没处理完的旧标签');
    const keyOf = (tab: { projectId: string | null; path: string }) => `${tab.projectId}/${tab.path}`;
    // 当前标签原样进记录，且顺序在前
    const liveKeys = second.state.tabs.map(keyOf);
    assert.deepEqual(record.tabs.slice(0, liveKeys.length).map(keyOf), liveKeys);
    // 未处理的标签全部被结转，一条不丢、一条不重
    const recordKeys = record.tabs.map(keyOf);
    assert.equal(new Set(recordKeys).size, EIGHT_TABS.length, '不得重复');
    for (const [, projectId] of EIGHT_TABS) {
      assert.equal(recordKeys.some((key) => key.startsWith(`${projectId}/`)), true);
    }
    assert.deepEqual(
      [...recordKeys].sort(),
      EIGHT_TABS.map(([path, projectId]) => `${projectId}/${path}`).sort(),
      '8 个标签一条都不许少',
    );
  } finally {
    await host.close();
    await roots.cleanup();
  }
});
