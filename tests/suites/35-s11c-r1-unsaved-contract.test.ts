/**
 * S11-C-R1 · 未确认修改标签的恢复契约（DR-01…DR-05）。
 *
 * 已批准的首版策略是"**干净标签才自动重开**"：正文不持久化，重开只能拿到磁盘内容。
 * 把这样的标签显示成普通 CLEAN 标签，等于对用户说"你的改动还在"——那是谎报。
 * 因此脏标签只保留"存在未确认内容"的提示，由用户自己决定怎么处理；
 * 提示必须活过后续的自动保存，直到用户**明确**处理（自己重新打开那个文件）。
 *
 * 本轮不做 Core 草稿自动续接，也不写任何草稿正文。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MemoryStorage,
  makeHarness,
  makeRoots,
  nodeOf,
  startHost,
  tabOf,
} from '../helpers/s11c-harness.ts';

/** 准备一份"a.md 有未确认内容 + docs/notes.md 干净"的记录。 */
async function seedDirtyAndClean(url: string, storage: MemoryStorage) {
  const first = makeHarness(url, storage);
  await first.bootLive();
  await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
  await first.opener.openNode(nodeOf('docs/notes.md', 'project-a'), 'project-a');
  first.dispatch({ type: 'EDIT_DOC', docId: 'doc:project-a/a.md', text: '# 未保存的草稿正文\n' });
  const snapshot = first.saveSnapshot();
  assert.equal(snapshot.tabs[0].path, 'a.md');
  assert.equal(snapshot.tabs[0].hadUnsavedChanges, true);
  assert.equal(snapshot.tabs[1].hadUnsavedChanges, false);
  assert.equal(JSON.stringify(snapshot).includes('未保存的草稿正文'), false, '正文绝不落盘');
  return { first, snapshot, before: first.recordRaw() };
}

// ---------------------------------------------------------------------------
// DR-01 脏标签不得被自动恢复成普通 CLEAN 标签
// ---------------------------------------------------------------------------
test('DR-01 hadUnsavedChanges 的标签不会被自动重开成 CLEAN 标签', async () => {
  const roots = await makeRoots('ws-s11c-r1-dr01-');
  const host = await startHost(roots, 'multi');
  const storage = new MemoryStorage();
  try {
    await seedDirtyAndClean(host.url, storage);

    const second = makeHarness(host.url, storage);
    const report = await second.restore();

    assert.equal(
      second.state.tabs.some((tab) => tab.docId === 'doc:project-a/a.md'),
      false,
      '有未确认内容的标签不得出现在当前标签里',
    );
    assert.equal(
      second.calls.some((call) => call.name === 'openDocument' && call.path === 'a.md'),
      false,
      '连打开请求都不该发出去（否则会把磁盘内容当成"你的草稿"）',
    );
    const skipped = report.skipped.find((item) => item.path === 'a.md');
    assert.equal(skipped?.reason, 'unsaved-changes');
    assert.equal(report.draftsPending, 1);
    assert.equal(report.tabsRestored, 1, '干净的标签照常恢复');

    const restored = second.state.tabs[0];
    assert.equal(restored.path, 'docs/notes.md');
    assert.equal(restored.dirty, false);
    assert.equal(restored.documentState, 'CLEAN');
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DR-02 只恢复干净标签时，未确认修改提示仍然保留
// ---------------------------------------------------------------------------
test('DR-02 提示不随恢复结束而消失：记录里仍然保留"存在未确认内容"', async () => {
  const roots = await makeRoots('ws-s11c-r1-dr02-');
  const host = await startHost(roots, 'multi');
  const storage = new MemoryStorage();
  try {
    await seedDirtyAndClean(host.url, storage);

    const second = makeHarness(host.url, storage);
    const report = await second.restore();
    assert.match(report.notice, /未保存内容/);
    assert.match(report.notice, /未自动恢复/);
    assert.equal(report.notice.includes('草稿已恢复'), false);

    // 恢复完成后的第一次自动保存（onSettled 排的那次）
    second.advance();
    const record = second.record();
    assert.ok(record);
    assert.equal(
      record.tabs.find((tab) => tab.path === 'a.md')?.hadUnsavedChanges,
      true,
      '记录里必须继续保有这条提示',
    );
    assert.equal(record.tabs.length, 2, '干净标签 + 提示标签都在');
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DR-03 用户未处理前，自动保存不得静默抹掉该标记
// ---------------------------------------------------------------------------
test('DR-03 多次自动保存都不会抹掉提示；只有用户自己打开该文件才结束', async () => {
  const roots = await makeRoots('ws-s11c-r1-dr03-');
  const host = await startHost(roots, 'multi');
  const storage = new MemoryStorage();
  try {
    await seedDirtyAndClean(host.url, storage);

    const second = makeHarness(host.url, storage);
    await second.restore();

    // 用户只是调了布局、折叠了侧栏：这些都不得让提示消失
    const ratios = [42, 47, 53];
    for (const ratio of ratios) {
      second.dispatch({ type: 'SET_SPLIT_RATIO', ratio });
      second.dispatch({ type: 'TOGGLE_NAV' });
      second.advance();
      const record = second.record();
      assert.equal(
        record?.tabs.find((tab) => tab.path === 'a.md')?.hadUnsavedChanges,
        true,
        `第 ${ratio} 次自动保存不得抹掉未确认内容提示`,
      );
      assert.equal(second.state.tabs.some((tab) => tab.path === 'a.md'), false, '也不得偷偷把它变成普通标签');
    }

    // 用户明确处理：自己重新打开它（此时拿到的是磁盘内容，提示到此为止）
    const outcome = await second.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    assert.equal(outcome.ok, true);
    second.advance();
    const after = second.record();
    const entry = after?.tabs.find((tab) => tab.path === 'a.md');
    assert.equal(entry?.hadUnsavedChanges, false, '用户自己打开后，提示才算被处理掉');
    assert.equal(after?.tabs.length, 2, '不得凭空多出标签');
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DR-04 没有正文时绝不显示"草稿已恢复"
// ---------------------------------------------------------------------------
test('DR-04 报告与提示里不存在任何"草稿已恢复"的说法', async () => {
  const roots = await makeRoots('ws-s11c-r1-dr04-');
  const host = await startHost(roots, 'multi');
  const storage = new MemoryStorage();
  try {
    await seedDirtyAndClean(host.url, storage);

    const second = makeHarness(host.url, storage);
    const report = await second.restore();
    const asRecord = report as unknown as Record<string, unknown>;
    assert.equal('draftsRecovered' in asRecord, false, '不再存在"已恢复草稿"这个字段');
    for (const text of [report.notice]) {
      assert.equal(text.includes('草稿已恢复'), false);
      assert.equal(text.includes('重新取得'), false);
      assert.equal(text.includes('已恢复草稿'), false);
    }
    // 明确说明"正文未持久化"，避免用户以为改动还在
    assert.match(report.notice, /正文未持久化/);
    // 存储里也不允许出现任何正文
    for (const value of storage.map.values()) {
      assert.equal(value.includes('未保存的草稿正文'), false);
    }
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DR-05 干净标签继续正常恢复，单个失败不影响其他标签
// ---------------------------------------------------------------------------
test('DR-05 干净标签照常恢复；缺失文件与未确认内容都只影响自己', async () => {
  const roots = await makeRoots('ws-s11c-r1-dr05-');
  const host = await startHost(roots, 'multi');
  const storage = new MemoryStorage();
  try {
    const first = makeHarness(host.url, storage);
    await first.bootLive();
    await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
    await first.opener.openNode(nodeOf('docs/notes.md', 'project-a'), 'project-a');
    // 第三个标签指向从未存在的文件
    first.dispatch({
      type: 'OPEN_TAB',
      tab: tabOf({ docId: 'doc:project-a/missing.md', projectId: 'project-a', path: 'missing.md' }),
    });
    first.dispatch({ type: 'EDIT_DOC', docId: 'doc:project-a/docs/notes.md', text: '# 草稿\n' });
    const snapshot = first.saveSnapshot();
    assert.equal(snapshot.tabs.length, 3);

    const second = makeHarness(host.url, storage);
    const report = await second.restore();

    assert.equal(report.status, 'restored');
    assert.equal(report.tabsRestored, 1, '只有干净的 a.md 可以恢复');
    assert.equal(second.state.tabs.length, 1);
    assert.equal(second.state.tabs[0].docId, 'doc:project-a/a.md');
    assert.equal(second.state.tabs[0].buffer, '# A\n');
    assert.equal(report.draftsPending, 1);
    assert.equal(report.skipped.find((item) => item.path === 'missing.md')?.reason, 'file-missing');
    assert.equal(report.skipped.find((item) => item.path === 'docs/notes.md')?.reason, 'unsaved-changes');
    assert.equal(second.state.tabs.some((tab) => tab.docId.includes('missing.md')), false);
  } finally {
    await host.close();
    await roots.cleanup();
  }
});
