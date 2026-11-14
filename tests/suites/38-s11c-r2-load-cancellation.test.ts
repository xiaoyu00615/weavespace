/**
 * S11-C-R2 · 工作区加载过程中的取消检查（IX-05…IX-10）。
 *
 * 加载链是串行的：身份 → 项目表 → 每个项目的资源树。用户在这条链的任意一段切回
 * Demo，剩下的响应都会**迟到**。这些迟到结果一旦落地，就会出现"演示模式下冒出
 * 真实项目列表 / 真实文件树 / 上一个工作区的身份与提示"。
 *
 * 这里用**可控 Promise** 把响应钉在网络上（`h.hold(...)`），放行时点由测试决定，
 * 不依赖 sleep。每条用例都能在"漏掉取消检查"的实现上确定性失败。
 *
 * 两条路径都要覆盖：
 * - 恢复流程的连接（`connectLive`，取消来源是恢复代次 + 组件传入的 isCancelled）；
 * - 用户主动切换（`manualSwitch`，取消来源是加载代次——因为"切走再切回来"之后
 *   模式又变回 live，只比较模式会把迟到结果当成本代结果）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadWorkspace } from '../../apps/shell/src/state/workspace-load.ts';
import {
  MemoryStorage,
  makeHarness,
  makeRoots,
  startHost,
  waitFor,
  type Harness,
} from '../helpers/s11c-harness.ts';

/** Demo 工作区唯一合法的提示文案（切模式的归约结果）。 */
const DEMO_NOTICE = '演示数据：不读取、不写入本机文件';

function countOf(h: Harness, name: string): number {
  // UX-02B-TREE：资源加载请求已从 listResources（递归旧端点）改为 listTree（逐层分页）。
  // 这些取消断言关心的是"有没有再发一次资源加载请求"，不是具体方法名，
  // 因此把两个名字归到同一个计数类别；断言本身一条未改。
  const names = name === 'listResources' ? ['listResources', 'listTree'] : [name];
  return h.calls.filter((call) => names.includes(call.name)).length;
}

// ---------------------------------------------------------------------------
// IX-05 加载阶段的身份请求迟到
// ---------------------------------------------------------------------------
test('IX-05 加载阶段 identity 迟到时不得写入旧 workspaceKey', async () => {
  const roots = await makeRoots('ws-s11c-r2-ix05-');
  const host = await startHost(roots, 'multi');
  try {
    const h = makeHarness(host.url, new MemoryStorage());
    let cancelled = false;
    // 第 1 次是"探测 Host"，第 2 次是 loadWorkspace 取身份——只挂起第 2 次
    const release = h.hold('identity', 2);
    const pending = h.connectLive(() => cancelled);
    await waitFor(() => countOf(h, 'workspaceIdentity') === 2, '加载阶段的 identity 未发出');

    // 用户在"正在加载"的窗口里切回 Demo
    cancelled = true;
    h.setMode('demo');
    release();

    const result = await pending;
    assert.equal(result, null, '被取消的连接必须交出 null');
    assert.equal(h.state.mode, 'demo');
    assert.equal(h.state.workspaceKey, null, '迟到结果不得写入上一个工作区的身份');
    assert.equal(h.state.workspaceMode, 'legacy', '不得写入上一个工作区的 Host 形态');
    assert.equal(h.state.projects.length, 0, '不得开始加载项目表');
    assert.equal(h.state.resources.length, 0);
    assert.equal(h.state.notice, DEMO_NOTICE, '用户已经看到 Demo 提示，迟到结果不得覆盖');
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// IX-06 项目列表迟到
// ---------------------------------------------------------------------------
test('IX-06 项目列表迟到时不得把旧项目表写进 Demo 工作区', async () => {
  const roots = await makeRoots('ws-s11c-r2-ix06-');
  const host = await startHost(roots, 'multi');
  try {
    const h = makeHarness(host.url, new MemoryStorage());
    let cancelled = false;
    const release = h.hold('projects', 1);
    const pending = h.connectLive(() => cancelled);
    await waitFor(() => countOf(h, 'listProjects') === 1, '项目列表请求未发出');

    cancelled = true;
    h.setMode('demo');
    release();

    assert.equal(await pending, null);
    assert.equal(h.state.mode, 'demo');
    assert.equal(h.state.projects.length, 0, '迟到项目表不得写回');
    assert.equal(h.state.activeProjectId, null, '不得把"当前项目"指回旧工作区');
    assert.equal(h.state.workspaceKey, null);
    assert.equal(h.state.notice, DEMO_NOTICE);
    assert.equal(countOf(h, 'listResources'), 0, '已取消就不得再加载任何项目的资源');
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// IX-07 项目资源树迟到（且不得继续加载后续项目）
// ---------------------------------------------------------------------------
test('IX-07 项目 A 的资源树迟到：不回填、不刷新状态、不继续加载项目 B', async () => {
  const roots = await makeRoots('ws-s11c-r2-ix07-');
  const host = await startHost(roots, 'multi');
  try {
    const h = makeHarness(host.url, new MemoryStorage());
    let cancelled = false;
    const release = h.hold('resources', 1); // project-a 的资源树
    const pending = h.connectLive(() => cancelled);
    await waitFor(() => countOf(h, 'listResources') === 1, 'project-a 的资源请求未发出');
    assert.equal(h.state.projects.length, 3, '前提：项目表已经落到状态里');
    assert.equal(h.state.activeProjectId, 'project-a');

    cancelled = true;
    h.setMode('demo');
    release();

    assert.equal(await pending, null);
    assert.equal(h.state.resourcesByProject['project-a'], undefined, '不得回填旧项目的资源树');
    assert.equal(
      h.state.expandedByProject['project-a'],
      undefined,
      '资源树没落地，展开状态也不能落地',
    );
    assert.equal(h.state.loadingByProject['project-a'], undefined, '加载中标记属于旧工作区');
    assert.equal(h.state.projects.length, 0, '不得把已被清空的项目表再写回来');
    assert.equal(h.state.activeProjectId, null);
    assert.equal(countOf(h, 'listResources'), 1, '已取消就不得继续加载项目 B');
    assert.equal(countOf(h, 'listProjects'), 1, '已取消就不得再刷新项目状态');
    assert.equal(h.state.notice, DEMO_NOTICE);
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// IX-08 Legacy 资源列表迟到
// ---------------------------------------------------------------------------
test('IX-08 Legacy 资源列表迟到时不得把真实文件树塞进 Demo', async () => {
  const roots = await makeRoots('ws-s11c-r2-ix08-');
  const host = await startHost(roots, 'legacy');
  try {
    const h = makeHarness(host.url, new MemoryStorage());
    let cancelled = false;
    const release = h.hold('resources', 1);
    const pending = h.connectLive(() => cancelled);
    await waitFor(() => countOf(h, 'listResources') === 1, 'Legacy 资源请求未发出');

    cancelled = true;
    h.setMode('demo');
    release();

    assert.equal(await pending, null);
    assert.equal(h.state.mode, 'demo');
    assert.equal(h.state.resources.length, 0, '不得把 Legacy 的真实文件树塞进 Demo');
    assert.equal(h.state.selectedPath, null);
    assert.equal(h.state.loadingResources, false, '切走后不得留下"加载中"');
    assert.equal(h.state.notice, DEMO_NOTICE, '不得用"已加载 N 个可编辑文件"覆盖 Demo 提示');
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// IX-09 没有取消时不得误伤：Multi 与 Legacy 都完整加载
// ---------------------------------------------------------------------------
test('IX-09 未取消时 Multi 与 Legacy 都能完整加载', async () => {
  const roots = await makeRoots('ws-s11c-r2-ix09-');
  const multi = await startHost(roots, 'multi');
  const legacy = await startHost(roots, 'legacy');
  try {
    // Multi：显式传入"永不取消"
    const h = makeHarness(multi.url, new MemoryStorage());
    const result = await h.connectLive(() => false);
    assert.ok(result, '连接必须成功');
    assert.equal(result.workspaceKey, h.state.workspaceKey);
    assert.equal(h.state.mode, 'live');
    assert.equal(h.state.projects.length, 3, '两个 READY + 一个 UNAVAILABLE 都要在表里');
    assert.equal(h.state.activeProjectId, 'project-a', '自动选中第一个 READY');
    assert.ok((h.state.resourcesByProject['project-a'] ?? []).length > 0, '项目 A 的资源树已加载');
    assert.ok((h.state.resourcesByProject['project-b'] ?? []).length > 0, '项目 B 的资源树已加载');
    assert.equal(h.state.loadingByProject['project-a'], false, '逐个项目的加载标记必须收尾');
    assert.equal(h.state.loadingByProject['project-b'], false);
    assert.match(h.state.notice, /已加载 2 个项目（1 个不可用）/);
    assert.equal(countOf(h, 'listResources'), 2, '只加载 READY 的两个项目');

    // Legacy：完全不传 isCancelled（保持既有调用点语义）
    const l = makeHarness(legacy.url, new MemoryStorage());
    const loaded = await loadWorkspace({
      getState: () => l.state,
      dispatch: l.dispatch,
      clientFor: () => l.inner,
    });
    assert.ok(loaded, '不传取消检查时必须照常加载');
    assert.equal(loaded.workspaceMode, 'legacy');
    assert.equal(l.state.workspaceMode, 'legacy');
    assert.ok(l.state.resources.length > 0, 'Legacy 单树必须加载');
    assert.equal(l.state.loadingResources, false);
    assert.match(l.state.notice, /可编辑文件（真实文件模式）/);
  } finally {
    await multi.close();
    await legacy.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// IX-10 手动切到 Live 后立刻切回 Demo
// ---------------------------------------------------------------------------
test('IX-10 手动切到 Live 又切回 Demo：迟到结果同样不得重建旧工作区', async () => {
  const roots = await makeRoots('ws-s11c-r2-ix10-');
  const host = await startHost(roots, 'multi');
  try {
    const h = makeHarness(host.url, new MemoryStorage());
    const release = h.hold('projects', 1);

    const switchingLive = h.manualSwitch('live');
    await waitFor(() => countOf(h, 'listProjects') === 1, 'live 加载未发出');
    assert.equal(h.state.mode, 'live', '前提：用户已经进入 Live');

    // 加载还没回来，用户又切回 Demo
    await h.manualSwitch('demo');
    release();
    await switchingLive;

    assert.equal(h.state.mode, 'demo');
    assert.equal(h.state.projects.length, 0, '迟到项目表不得写回');
    assert.equal(h.state.activeProjectId, null, '不得把"当前项目"指回旧工作区');
    assert.equal(h.state.workspaceKey, null, '不得写入旧身份');
    assert.equal(h.state.resources.length, 0);
    assert.equal(countOf(h, 'listResources'), 0, '切回 Demo 后不得继续加载资源');
    assert.equal(h.state.notice, DEMO_NOTICE);

    // 反向再走一次：切回 Demo 之后重新进 Live 必须正常加载（守卫不能把代次卡死）
    const again = await h.manualSwitch('live');
    assert.equal(again, undefined);
    assert.equal(h.state.mode, 'live');
    assert.equal(h.state.projects.length, 3, '新一代加载必须生效');
    assert.ok((h.state.resourcesByProject['project-a'] ?? []).length > 0);
  } finally {
    await host.close();
    await roots.cleanup();
  }
});
