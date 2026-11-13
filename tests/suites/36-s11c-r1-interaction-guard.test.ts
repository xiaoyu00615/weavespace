/**
 * S11-C-R1 · 用户交互不能被迟到恢复覆盖（IX-01…IX-04）。
 *
 * 组件里很多交互是**直接 dispatch** 的（拖动分屏、切焦点、折叠），它们不经过任何
 * "恢复 API"，所以只靠代次计数抓不住。这里改用"逐字段比对基线"：
 * 恢复期间被改过的字段属于用户，恢复不得写回去。
 *
 * 另一条竞争是**连接阶段**：用户在探测 Host 期间切走，迟到的连接结果不能把界面
 * 拉进 live（那会出现"演示模式下突然显示真实文件"）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MemoryStorage,
  makeHarness,
  makeRoots,
  nodeOf,
  paneDocId,
  startHost,
  waitFor,
} from '../helpers/s11c-harness.ts';

async function seedLayout(url: string, storage: MemoryStorage) {
  const first = makeHarness(url, storage);
  await first.bootLive();
  await first.opener.openNode(nodeOf('a.md', 'project-a'), 'project-a');
  await first.opener.openNode(nodeOf('docs/notes.md', 'project-a'), 'project-a');
  first.dispatch({ type: 'SET_LAYOUT', layout: 'vertical' });
  first.dispatch({ type: 'SET_SPLIT_RATIO', ratio: 62 });
  first.dispatch({ type: 'SET_PANE_MODE', pane: 'secondary', mode: 'editor' });
  first.dispatch({ type: 'FOCUS_PANE', pane: 'primary' });
  const snapshot = first.saveSnapshot();
  assert.equal(snapshot.ui.layout, 'vertical');
  assert.equal(snapshot.ui.splitRatio, 62);
  assert.equal(snapshot.ui.focusedPane, 'primary');
  return { first, snapshot };
}

// ---------------------------------------------------------------------------
// IX-01 迟到的恢复不得改回旧分屏比例
// ---------------------------------------------------------------------------
test('IX-01 连接 Host 期间用户改了分屏比例，迟到恢复不得改回', async () => {
  const roots = await makeRoots('ws-s11c-r1-ix01-');
  const host = await startHost(roots, 'multi');
  const storage = new MemoryStorage();
  try {
    await seedLayout(host.url, storage);

    const second = makeHarness(host.url, storage);
    const releaseConnect = second.holdConnect();
    const pending = second.restore();
    await waitFor(() => second.calls.some((call) => call.name === 'workspaceIdentity'));

    // 组件直接 dispatch：没有经过 restorer / 没有 noteInteraction
    second.dispatch({ type: 'SET_SPLIT_RATIO', ratio: 33 });
    releaseConnect();

    const report = await pending;
    assert.equal(report.status, 'restored');
    assert.equal(second.state.splitRatio, 33, '用户这次拖动必须保留');
    // 未被用户碰过的字段照常恢复
    assert.equal(second.state.panes.secondary.mode, 'editor');
    assert.equal(second.state.layout, 'vertical');
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// IX-02 恢复不得抢回旧焦点
// ---------------------------------------------------------------------------
test('IX-02 恢复途中用户切了焦点窗格，恢复结束不得改回旧焦点', async () => {
  const roots = await makeRoots('ws-s11c-r1-ix02-');
  const host = await startHost(roots, 'multi');
  const storage = new MemoryStorage();
  try {
    await seedLayout(host.url, storage);

    const second = makeHarness(host.url, storage);
    const releaseConnect = second.holdConnect();
    const pending = second.restore();
    await waitFor(() => second.calls.some((call) => call.name === 'workspaceIdentity'));

    // 用户在"正在连接"的窗口里先开分屏、再把焦点挪到副窗格（组件直接 dispatch）
    second.dispatch({ type: 'SET_LAYOUT', layout: 'vertical' });
    second.dispatch({ type: 'FOCUS_PANE', pane: 'secondary' });
    assert.equal(second.state.focusedPane, 'secondary');
    releaseConnect();

    const report = await pending;
    assert.equal(report.status, 'restored');
    assert.equal(second.state.focusedPane, 'secondary', '焦点属于用户，恢复不得抢回 primary');
    // 窗格内容仍然恢复：恢复的是"布局"，不是"焦点"
    assert.equal(second.state.panes.primary.docId, 'doc:project-a/docs/notes.md');
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// IX-03 切模式后，旧连接与加载结果不得重建错误工作区
// ---------------------------------------------------------------------------
test('IX-03 连接期间切到 Demo：迟到的 Host 结果不得把界面拉回 live', async () => {
  const roots = await makeRoots('ws-s11c-r1-ix03-');
  const host = await startHost(roots, 'multi');
  const storage = new MemoryStorage();
  try {
    await seedLayout(host.url, storage);

    const second = makeHarness(host.url, storage);
    const releaseConnect = second.holdConnect();
    const pending = second.restore();
    await waitFor(() => second.calls.some((call) => call.name === 'workspaceIdentity'));

    // 用户在"正在连接"的窗口里切到 Demo
    second.setMode('demo');
    releaseConnect();

    const report = await pending;
    assert.equal(report.status, 'interrupted');
    assert.equal(second.mode(), 'demo');
    assert.equal(second.state.mode, 'demo', '不得被迟到结果改回 live');
    assert.equal(second.state.workspaceKey, null, '不得写入上一个工作区的身份');
    assert.equal(second.state.projects.length, 0, '不得把项目表塞进 Demo 工作区');
    assert.equal(second.state.resources.length, 0, '不得把真实文件树塞进 Demo 工作区');
    assert.equal(second.state.tabs.length, 0);
    assert.equal(
      second.calls.some((call) => call.name === 'listProjects'),
      false,
      '用户切走之后不该再继续加载项目',
    );
    assert.equal(
      second.calls.some((call) => call.name === 'openDocument'),
      false,
      '更不该重建任何标签',
    );
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// IX-04 没有交互时，合法布局恢复必须正常生效（守卫不能误伤）
// ---------------------------------------------------------------------------
test('IX-04 全程无交互时，布局、比例、焦点、窗格都按记录恢复', async () => {
  const roots = await makeRoots('ws-s11c-r1-ix04-');
  const host = await startHost(roots, 'multi');
  const storage = new MemoryStorage();
  try {
    const { snapshot } = await seedLayout(host.url, storage);

    const second = makeHarness(host.url, storage);
    const report = await second.restore();

    assert.equal(report.status, 'restored');
    assert.equal(report.tabsRestored, 2);
    assert.equal(second.state.layout, 'vertical');
    assert.equal(second.state.splitRatio, 62);
    assert.equal(second.state.panes.secondary.mode, 'editor');
    assert.equal(second.state.focusedPane, 'primary', '没有交互时焦点按记录恢复');
    const byIndex = ['doc:project-a/a.md', 'doc:project-a/docs/notes.md'];
    const expectedPrimary =
      snapshot.panes.primary.tabIndex === null ? null : byIndex[snapshot.panes.primary.tabIndex];
    const expectedSecondary =
      snapshot.panes.secondary.tabIndex === null ? null : byIndex[snapshot.panes.secondary.tabIndex];
    assert.equal(second.state.panes.primary.docId, expectedPrimary, '主窗格按记录下标恢复');
    assert.equal(second.state.panes.secondary.docId, expectedSecondary, '副窗格按记录下标恢复');
    assert.equal(paneDocId(second), expectedPrimary, '焦点窗格指回记录里的文档');
  } finally {
    await host.close();
    await roots.cleanup();
  }
});
