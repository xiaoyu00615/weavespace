/**
 * UX-02C-05-R1.2：身份降级契约补强 + 项目改名异步归属（先红后绿）。
 *
 * 这一组钉的是复审裁决里的三条 F：
 * - **F01**：`unsupported` 目标未核验当前身份状态。R1.1 只要目标声称"无身份能力"
 *   就放行，于是"能力声明变了、锚却对不上"被当成"还是同一个对象"；
 * - **F02**：首屏整层替换会继承上一轮的 `identitySupport` / `projectAnchor`，
 *   一个已经具备身份能力的新 Provider 继续享受"按路径身份"的降级；
 * - **F03**：项目改名的底层全局更新（`PROJECT_RENAMED`）早于上层票据核验，
 *   `await` 之后只比 `modeRef`，而"切到 Demo 再切回 Live"模式又变回 `live`。
 *
 * F03 的用例刻意跑**真实编排**（`performProjectRename` / `createProjectRenameFlow`）
 * + 真实 reducer + 真实 `createLoadEpoch`，用 deferred promise 控制时序；
 * 不断言"辅助函数算得对"，而是断言"实际派发了什么、列表变成什么、会话有没有被写坏、
 * 请求发了几次"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

/*
 * 命名空间导入：本轮先写红测，部分导出在旧实现里还不存在。
 * 具名导入会让整份文件在链接期失败，看不出"哪条行为不成立"。
 */
import * as tc from '../../apps/shell/src/state/tree-commands.ts';
import * as model from '../../apps/shell/src/components/tree-model.ts';
import * as pr from '../../apps/shell/src/state/project-rename.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import { createLoadEpoch } from '../../apps/shell/src/state/workspace-load.ts';
import type { WorkspaceState } from '../../apps/shell/src/state/types.ts';
import type { ProjectSummary, RenameOutcome, TreeEntry } from '../../apps/shell/src/client/client-api.ts';

/* ------------------------------------------------------------------ */
/* 通用夹具                                                            */
/* ------------------------------------------------------------------ */

const fileTarget = (extra: Record<string, unknown> = {}) =>
  ({
    origin: 'file',
    projectId: 'p1',
    nodePath: 'note.md',
    entryKind: 'file',
    ...extra,
  }) as unknown as tc.TreeCommandTarget;

const base = { projectExists: true, projectReady: true, entryPresent: true } as const;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让所有已排队的微任务跑完（deferred 的 resolve 派发是微任务）。 */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const PROJECT_A: ProjectSummary = { projectId: 'project-a', name: '项目A', status: 'READY' };
const PROJECT_B: ProjectSummary = { projectId: 'project-b', name: '项目B', status: 'READY' };

/* ================================================================== */
/* A 组：F01 —— 身份降级必须两侧对称                                    */
/* ================================================================== */

test('A01 unsupported → unverified：当前无法确认，不得按路径放行', () => {
  const problem = tc.treeTargetProblemOf({
    ...base,
    target: fileTarget({ nodeIdentity: 'unsupported' }),
    currentAnchor: null,
    currentIdentity: 'unverified',
  });
  assert.equal(typeof problem, 'string');
  assert.match(problem ?? '', /无法确认/);
});

test('A02 unsupported → verified：当前已有锚，能力声明矛盾，不得放行', () => {
  const problem = tc.treeTargetProblemOf({
    ...base,
    target: fileTarget({ nodeIdentity: 'unsupported' }),
    currentAnchor: 'anchor-a1',
    currentIdentity: 'verified',
  });
  assert.equal(typeof problem, 'string');
  assert.match(problem ?? '', /身份状态已经变化/);
});

test('A03 verified → unsupported：目标有锚而当前声明无能力，不得放行', () => {
  const problem = tc.treeTargetProblemOf({
    ...base,
    target: fileTarget({ nodeAnchor: 'anchor-a1', nodeIdentity: 'verified' }),
    currentAnchor: null,
    currentIdentity: 'unsupported',
  });
  assert.equal(typeof problem, 'string');
  assert.match(problem ?? '', /身份状态已经变化/);
});

test('A04 verified → unverified：当前拿不到锚，不得退回路径身份', () => {
  const problem = tc.treeTargetProblemOf({
    ...base,
    target: fileTarget({ nodeAnchor: 'anchor-a1', nodeIdentity: 'verified' }),
    currentAnchor: null,
    currentIdentity: 'unverified',
  });
  assert.match(problem ?? '', /无法确认/);
});

test('A05 verified → verified：锚变了就是另一个对象', () => {
  const problem = tc.treeTargetProblemOf({
    ...base,
    target: fileTarget({ nodeAnchor: 'anchor-a1', nodeIdentity: 'verified' }),
    currentAnchor: 'anchor-a2',
    currentIdentity: 'verified',
  });
  assert.match(problem ?? '', /对象已经变化/);
});

test('A06 两侧都明确 unsupported 且都没有锚：唯一被批准的降级，放行', () => {
  assert.equal(
    tc.treeTargetProblemOf({
      ...base,
      target: fileTarget({ nodeIdentity: 'unsupported' }),
      currentAnchor: null,
      currentIdentity: 'unsupported',
    }),
    null,
  );
});

test('A07 目标自称 unsupported 却带着锚：声明自相矛盾，不得当成降级凭据', () => {
  const problem = tc.treeTargetProblemOf({
    ...base,
    target: fileTarget({ nodeIdentity: 'unsupported', nodeAnchor: 'anchor-a1' }),
    currentAnchor: null,
    currentIdentity: 'unsupported',
  });
  assert.equal(typeof problem, 'string');
});

test('A08 当前声明 unsupported 却仍能给出锚：同样矛盾，不得放行', () => {
  const problem = tc.treeTargetProblemOf({
    ...base,
    target: fileTarget({ nodeIdentity: 'unsupported' }),
    currentAnchor: 'anchor-a1',
    currentIdentity: 'unsupported',
  });
  assert.equal(typeof problem, 'string');
});

test('A09 未声明身份状态时仍按"有锚=verified"推导，不放宽旧调用者', () => {
  assert.equal(
    tc.treeTargetProblemOf({
      ...base,
      target: fileTarget({ nodeAnchor: 'anchor-a1' }),
      currentAnchor: 'anchor-a1',
    }),
    null,
  );
  assert.match(
    tc.treeTargetProblemOf({
      ...base,
      target: fileTarget(),
      currentAnchor: null,
    }) ?? '',
    /无法确认/,
  );
});

/* ================================================================== */
/* B 组：F02 —— 首屏整层替换不得继承过期的能力声明 / 根锚               */
/* ================================================================== */

const entry = (relPath: string, name: string): TreeEntry =>
  ({ id: `file:${relPath}`, name, kind: 'file', relPath }) as TreeEntry;

/** 造一层"上一轮已被声明为 unsupported、且带旧根锚"的层表。 */
function seededUnsupportedLevel(): model.TreeLevels {
  return model.applyPage(model.emptyLevels(), '', {
    entries: [entry('a.md', 'a.md')],
    cursor: null,
    nextCursor: 'cursor-1',
    total: 4,
    snapshot: 'snap-1',
    anchors: {},
    projectAnchor: 'old-root-anchor',
    identitySupport: 'unsupported',
  });
}

test('B01 首屏（cursor=null）响应没有能力声明：不得继承上一轮的 unsupported', () => {
  const next = model.applyPage(seededUnsupportedLevel(), '', {
    entries: [entry('b.md', 'b.md')],
    cursor: null,
    nextCursor: null,
    total: 1,
    snapshot: 'snap-2',
    anchors: {},
  });
  const level = next[''];
  assert.ok(level);
  assert.equal(level.identitySupport, undefined, '首屏是整层替换，旧声明必须消失');
});

test('B02 首屏声明 supported：以新响应为准，覆盖旧 unsupported', () => {
  const next = model.applyPage(seededUnsupportedLevel(), '', {
    entries: [entry('b.md', 'b.md')],
    cursor: null,
    nextCursor: null,
    total: 1,
    snapshot: 'snap-2',
    anchors: {},
    identitySupport: 'supported',
  });
  assert.equal(next['']?.identitySupport, 'supported');
});

test('B03 续页没有能力声明：沿用本层既有声明（同一轮分页）', () => {
  const next = model.applyPage(seededUnsupportedLevel(), '', {
    entries: [entry('c.md', 'c.md')],
    cursor: 'cursor-1',
    nextCursor: null,
    total: 4,
    snapshot: 'snap-1',
    anchors: {},
  });
  assert.equal(next['']?.identitySupport, 'unsupported');
  assert.equal(next['']?.entries.length, 2, '续页仍然是追加');
});

test('B04 续页能力声明与既有声明矛盾：整层作废，绝不混合使用', () => {
  const next = model.applyPage(seededUnsupportedLevel(), '', {
    entries: [entry('c.md', 'c.md')],
    cursor: 'cursor-1',
    nextCursor: null,
    total: 4,
    snapshot: 'snap-1',
    anchors: {},
    identitySupport: 'supported',
  });
  const level = next[''];
  assert.ok(level);
  assert.equal(level.errorCode, 'ERR_IDENTITY_STATE_CHANGED');
  assert.equal(level.status, 'error');
  assert.deepEqual(level.entries, [], '作废就是作废，不能留下半层结果');
  assert.equal(level.nextCursor, null);
});

test('B05 首屏没有根锚：不得继承上一轮的旧根锚（F02 第二处）', () => {
  const next = model.applyPage(seededUnsupportedLevel(), '', {
    entries: [entry('b.md', 'b.md')],
    cursor: null,
    nextCursor: null,
    total: 1,
    snapshot: 'snap-2',
    anchors: {},
  });
  assert.equal(next['']?.projectAnchor, undefined);
});

test('B06 续页没有根锚：沿用（根是项目级属性，续页本来就不带）', () => {
  const next = model.applyPage(seededUnsupportedLevel(), '', {
    entries: [entry('c.md', 'c.md')],
    cursor: 'cursor-1',
    nextCursor: null,
    total: 4,
    snapshot: 'snap-1',
    anchors: {},
  });
  assert.equal(next['']?.projectAnchor, 'old-root-anchor');
});

test('B07 正常分页语义不变：追加去重、游标与总数照旧', () => {
  const first = model.applyPage(model.emptyLevels(), 'docs', {
    entries: [entry('docs/a.md', 'a.md')],
    cursor: null,
    nextCursor: 'c1',
    total: 3,
    snapshot: 's1',
    anchors: { 'docs/a.md': 'anchor-a' },
    identitySupport: 'supported',
  });
  const second = model.applyPage(first, 'docs', {
    entries: [entry('docs/a.md', 'a.md'), entry('docs/b.md', 'b.md')],
    cursor: 'c1',
    nextCursor: null,
    total: 3,
    snapshot: 's1',
    anchors: { 'docs/b.md': 'anchor-b' },
  });
  const level = second['docs'];
  assert.ok(level);
  assert.deepEqual(level.entries.map((node) => node.name), ['a.md', 'b.md'], '按 id 去重且保序');
  assert.equal(level.nextCursor, null);
  assert.equal(level.total, 3);
  assert.equal(level.identitySupport, 'supported');
  // 锚表：续页没有抹掉第一页的锚
  assert.equal(level.anchors?.['docs/a.md'], 'anchor-a');
  assert.equal(level.anchors?.['docs/b.md'], 'anchor-b');
  // 条目上的锚跟着表走（编辑会话的身份预期）
  assert.equal(level.entries[0]?.anchor, 'anchor-a');
});

test('B08 首屏仍然重建整层：上一轮的条目不会残留', () => {
  const first = model.applyPage(model.emptyLevels(), 'docs', {
    entries: [entry('docs/a.md', 'a.md'), entry('docs/b.md', 'b.md')],
    cursor: null,
    nextCursor: null,
    total: 2,
    snapshot: 's1',
    anchors: { 'docs/a.md': 'anchor-a', 'docs/b.md': 'anchor-b' },
  });
  const replaced = model.applyPage(first, 'docs', {
    entries: [entry('docs/c.md', 'c.md')],
    cursor: null,
    nextCursor: null,
    total: 1,
    snapshot: 's2',
    anchors: { 'docs/c.md': 'anchor-c' },
  });
  const level = replaced['docs'];
  assert.deepEqual(level?.entries.map((node) => node.name), ['c.md']);
  assert.deepEqual(Object.keys(level?.anchors ?? {}), ['docs/c.md'], '首屏替换后旧锚必须消失');
});

/* ================================================================== */
/* C 组：F03 —— 项目改名的全局归属（真实编排 + 真实 reducer）           */
/* ================================================================== */

interface World {
  mode: string;
  workspaceKey: string | null;
}

/**
 * 全局层harness：真实 `performProjectRename` + 真实 reducer + 真实 `loadEpoch`。
 * 只有"网络"是可控的（deferred），这正是要测的那段时间。
 */
function globalHarness(input: {
  world: World;
  projects: readonly ProjectSummary[];
  epoch: ReturnType<typeof createLoadEpoch>;
}) {
  let state: WorkspaceState = {
    ...INITIAL_STATE,
    mode: input.world.mode as WorkspaceState['mode'],
    workspaceKey: input.world.workspaceKey,
    projects: [...input.projects],
    activeProjectId: input.projects[0]?.projectId ?? null,
  };
  const pending: ReturnType<typeof deferred<RenameOutcome>>[] = [];
  const sent: string[] = [];
  const host: pr.ProjectRenameCallHost = {
    mode: () => input.world.mode,
    workspaceKey: () => state.workspaceKey,
    epoch: () => input.epoch.current(),
    projects: () => state.projects,
    send: (projectId, name) => {
      sent.push(`${projectId}:${name}`);
      const gate = deferred<RenameOutcome>();
      pending.push(gate);
      return gate.promise;
    },
    dispatchRename: (project) => {
      state = workspaceReducer(state, { type: 'PROJECT_RENAMED', project });
    },
  };
  return {
    host,
    sent,
    pending,
    get state() {
      return state;
    },
    /**
     * 只换工作区摘要（不推进代次）。
     *
     * 这不是"为了测试造出来的"组合：`applyWorkspaceKey` 在只读 resync 里就会
     * 只写摘要、不碰代次。两种判据必须能各自被单独验到，否则删掉其中一个
     * 也照样"通过"——那正是本轮要避免的假绿。
     */
    switchWorkspace(nextKey: string | null): void {
      state = workspaceReducer(state, { type: 'SET_WORKSPACE_KEY', workspaceKey: nextKey });
    },
    switchMode(next: 'live' | 'demo'): void {
      input.world.mode = next;
      state = workspaceReducer(state, { type: 'SET_MODE', mode: next });
      input.epoch.cancel();
    },
    /** 只推进加载代次（重新连接 / 重新加载），摘要与模式都不变。 */
    reconnect(): void {
      input.epoch.start();
    },
    /** 模拟另一次操作把这一行改掉了（Host 侧 resync / 另一个改名）。 */
    replaceProjects(next: readonly ProjectSummary[]): void {
      state = workspaceReducer(state, { type: 'SET_PROJECTS', projects: [...next] });
    },
  };
}

function newEpoch(): ReturnType<typeof createLoadEpoch> {
  const epoch = createLoadEpoch();
  epoch.start();
  return epoch;
}

test('C01 正常成功：只派发一次 PROJECT_RENAMED，列表显示 Host 返回的名称', async () => {
  const epoch = newEpoch();
  const h = globalHarness({
    world: { mode: 'live', workspaceKey: 'ws-1' },
    projects: [PROJECT_A, PROJECT_B],
    epoch,
  });
  const run = pr.performProjectRename(h.host, 'project-a', '新名字');
  assert.equal(h.sent.length, 1, '请求只发一次');
  h.pending[0]!.resolve({
    status: 'APPLIED',
    project: { ...PROJECT_A, name: '新名字' },
  });
  const result = await run;
  assert.equal(result.outcome.status, 'APPLIED');
  assert.equal(result.backfill, 'done');
  assert.equal(result.backfillProblem, null);
  assert.equal(h.state.projects[0]?.name, '新名字');
  assert.equal(h.state.projects[1]?.name, '项目B', '只替换一行');
});

test('C02 Host 拒绝：不派发、列表不变、请求次数仍是 1', async () => {
  const epoch = newEpoch();
  const h = globalHarness({
    world: { mode: 'live', workspaceKey: 'ws-1' },
    projects: [PROJECT_A],
    epoch,
  });
  const run = pr.performProjectRename(h.host, 'project-a', '新名字');
  h.pending[0]!.resolve({
    status: 'REJECTED',
    errorCode: 'ERR_COMMAND_INVALID',
    message: '名称不合法',
    httpStatus: 400,
  });
  const result = await run;
  assert.equal(result.outcome.status, 'REJECTED');
  assert.equal(result.backfill, 'nothing');
  assert.equal(h.state.projects[0]?.name, '项目A');
  assert.equal(h.sent.length, 1);
});

test('C03 传输异常：按 ERR_STORAGE_IO 拒绝，零回填、不重试', async () => {
  const epoch = newEpoch();
  const h = globalHarness({
    world: { mode: 'live', workspaceKey: 'ws-1' },
    projects: [PROJECT_A],
    epoch,
  });
  const run = pr.performProjectRename(h.host, 'project-a', '新名字');
  h.pending[0]!.reject(new Error('boom'));
  const result = await run;
  assert.equal(result.outcome.status, 'REJECTED');
  assert.equal(
    result.outcome.status === 'REJECTED' ? result.outcome.errorCode : null,
    'ERR_STORAGE_IO',
  );
  assert.equal(result.backfill, 'nothing');
  assert.equal(h.state.projects[0]?.name, '项目A');
  assert.equal(h.sent.length, 1, '绝不自动重发');
});

test('C04 同工作区切换活动项目：不妨碍原项目真实名称更新', async () => {
  const epoch = newEpoch();
  const h = globalHarness({
    world: { mode: 'live', workspaceKey: 'ws-1' },
    projects: [PROJECT_A, PROJECT_B],
    epoch,
  });
  const run = pr.performProjectRename(h.host, 'project-a', '新名字');
  // 用户点了项目 B：活动项目变了，但世界与项目行都没变
  const switched = workspaceReducer(h.state, { type: 'SET_ACTIVE_PROJECT', projectId: 'project-b' });
  assert.equal(switched.activeProjectId, 'project-b');
  h.pending[0]!.resolve({ status: 'APPLIED', project: { ...PROJECT_A, name: '新名字' } });
  const result = await run;
  assert.equal(result.backfill, 'done');
  assert.equal(h.state.projects[0]?.name, '新名字');
});

test('C05 切换工作区：旧响应不得回填，但 Host 的 APPLIED 保持 APPLIED', async () => {
  const epoch = newEpoch();
  const h = globalHarness({
    world: { mode: 'live', workspaceKey: 'ws-1' },
    projects: [PROJECT_A],
    epoch,
  });
  const run = pr.performProjectRename(h.host, 'project-a', '新名字');
  h.switchWorkspace('ws-2');
  h.pending[0]!.resolve({ status: 'APPLIED', project: { ...PROJECT_A, name: '新名字' } });
  const result = await run;
  // 不能把"Host 已经改完"伪装成失败：用户会以为没改成而再改一次
  assert.equal(result.outcome.status, 'APPLIED');
  assert.equal(result.backfill, 'stale');
  assert.match(result.backfillProblem ?? '', /工作区已经切换/);
  assert.equal(h.state.projects[0]?.name, '项目A', '新工作区的列表不能被旧结果写');
});

test('C06 Live → Demo → Live：模式回到 live 也不算同一代，旧结果不得回填', async () => {
  const epoch = newEpoch();
  const h = globalHarness({
    world: { mode: 'live', workspaceKey: 'ws-1' },
    projects: [PROJECT_A],
    epoch,
  });
  const run = pr.performProjectRename(h.host, 'project-a', '新名字');
  h.switchMode('demo');
  h.switchMode('live');
  h.pending[0]!.resolve({ status: 'APPLIED', project: { ...PROJECT_A, name: '新名字' } });
  const result = await run;
  assert.equal(result.backfill, 'stale');
  assert.equal(result.outcome.status, 'APPLIED');
  /*
   * 这里不断言具体文案：切到 Demo 时 reducer 会清空项目表，所以最终拦住回填的
   * 可能是"代次变了"也可能是"项目不在列表里"——两者都是正确的拒绝。
   * 真正单独钉"代次"的是 C06b（摘要与项目行都不变，只推进代次）。
   */
  /*
   * 切到 Demo 时 reducer 会清空项目表（Demo 没有真实项目），所以这里只能断言
   * "旧结果没有被写进去"：列表里不许出现那一行新名字，也不许凭空长出一个项目。
   */
  assert.equal(h.state.projects.length, 0);
  assert.equal(
    h.state.projects.some((project) => project.name === '新名字'),
    false,
    '旧世界的结果不能在新世界里出现',
  );
});

test('C06b 只推进加载代次（重新连接）：旧结果同样不得回填', async () => {
  const epoch = newEpoch();
  const h = globalHarness({
    world: { mode: 'live', workspaceKey: 'ws-1' },
    projects: [PROJECT_A, PROJECT_B],
    epoch,
  });
  const run = pr.performProjectRename(h.host, 'project-a', '新名字');
  // 重新连接：摘要、模式、项目行全都没变，只有代次推进
  h.reconnect();
  h.pending[0]!.resolve({ status: 'APPLIED', project: { ...PROJECT_A, name: '新名字' } });
  const result = await run;
  assert.equal(result.outcome.status, 'APPLIED');
  assert.equal(result.backfill, 'stale');
  assert.match(result.backfillProblem ?? '', /已重新加载/);
  assert.equal(h.state.projects[0]?.name, '项目A');
});

test('C07 旧项目已移除：旧响应不得回填，也不凭空插入一行', async () => {
  const epoch = newEpoch();
  const h = globalHarness({
    world: { mode: 'live', workspaceKey: 'ws-1' },
    projects: [PROJECT_A, PROJECT_B],
    epoch,
  });
  const run = pr.performProjectRename(h.host, 'project-a', '新名字');
  h.replaceProjects([PROJECT_B]);
  h.pending[0]!.resolve({ status: 'APPLIED', project: { ...PROJECT_A, name: '新名字' } });
  const result = await run;
  assert.equal(result.backfill, 'stale');
  assert.match(result.backfillProblem ?? '', /不在工作区/);
  assert.equal(h.state.projects.length, 1);
  assert.equal(h.state.projects[0]?.projectId, 'project-b');
});

test('C08 同 ID 项目已被别的操作改名：旧摘要不得覆盖新的那一行', async () => {
  const epoch = newEpoch();
  const h = globalHarness({
    world: { mode: 'live', workspaceKey: 'ws-1' },
    projects: [PROJECT_A],
    epoch,
  });
  const run = pr.performProjectRename(h.host, 'project-a', '旧名字');
  h.replaceProjects([{ ...PROJECT_A, name: '别人刚改的名字' }]);
  h.pending[0]!.resolve({ status: 'APPLIED', project: { ...PROJECT_A, name: '旧名字' } });
  const result = await run;
  assert.equal(result.backfill, 'stale');
  assert.match(result.backfillProblem ?? '', /已被其他操作修改/);
  assert.equal(h.state.projects[0]?.name, '别人刚改的名字');
});

test('C09 预检失败不发请求：空名称 / 演示模式 / 项目不存在 / 名称未变', async () => {
  const epoch = newEpoch();
  const live = globalHarness({
    world: { mode: 'live', workspaceKey: 'ws-1' },
    projects: [PROJECT_A],
    epoch,
  });
  const empty = await pr.performProjectRename(live.host, 'project-a', '   ');
  assert.equal(empty.outcome.status, 'REJECTED');
  const same = await pr.performProjectRename(live.host, 'project-a', '项目A');
  assert.equal(same.backfill, 'nothing');
  const missing = await pr.performProjectRename(live.host, 'project-x', '新名字');
  assert.equal(missing.outcome.status, 'REJECTED');
  assert.equal(live.sent.length, 0, '一条都不该发出去');

  const demo = globalHarness({
    world: { mode: 'demo', workspaceKey: 'ws-1' },
    projects: [PROJECT_A],
    epoch: newEpoch(),
  });
  const denied = await pr.performProjectRename(demo.host, 'project-a', '新名字');
  assert.equal(denied.outcome.status, 'REJECTED');
  assert.equal(demo.sent.length, 0);
});

/* ------------------------------------------------------------------ */
/* C 组续：会话层（真实 flow 编排）                                     */
/* ------------------------------------------------------------------ */

interface SessionRow extends pr.ProjectRenameSessionView {}

/** 会话层 harness：真实 `createProjectRenameFlow` + 真实全局层。 */
function flowHarness(input: {
  session: SessionRow;
  projects: readonly ProjectSummary[];
  scope: string;
  activeProjectId: string | null;
}) {
  let session: SessionRow | null = input.session;
  let scope = input.scope;
  let activeProjectId = input.activeProjectId;
  let projects: readonly ProjectSummary[] = input.projects;
  let locks = 0;
  const effects: string[] = [];
  const epoch = newEpoch();
  const world: World = { mode: 'live', workspaceKey: 'ws-1' };
  const global = globalHarness({ world, projects, epoch });

  const flow = pr.createProjectRenameFlow({
    session: () => session,
    currentScope: () => scope,
    currentActiveProject: () => activeProjectId,
    projects: () => global.state.projects,
    supported: (projectId) =>
      world.mode === 'live' && projects.some((p) => p.projectId === projectId && p.status === 'READY'),
    rename: (projectId, name) => pr.performProjectRename(global.host, projectId, name),
    tryLock: () => {
      if (locks > 0) return false;
      locks += 1;
      return true;
    },
    unlock: () => {
      locks = 0;
    },
    setSaving: (sessionId) => {
      if (session && session.sessionId === sessionId) session = { ...session, saving: true };
    },
    close: (sessionId) => {
      effects.push(`close:${sessionId}`);
      if (session && session.sessionId === sessionId) session = null;
    },
    fail: (sessionId, message) => {
      effects.push(`fail:${sessionId}:${message}`);
      if (session && session.sessionId === sessionId) session = { ...session, saving: false };
    },
    notice: (message) => effects.push(`notice:${message}`),
  });

  return {
    global,
    effects,
    flow,
    get session() {
      return session;
    },
    setSession(next: SessionRow | null): void {
      session = next;
    },
    switchActiveProject(projectId: string): void {
      activeProjectId = projectId;
    },
    switchScope(next: string): void {
      scope = next;
    },
    setProjects(next: readonly ProjectSummary[]): void {
      projects = next;
    },
  };
}

const SESSION_1: SessionRow = {
  sessionId: 1,
  scope: 'live\u0000multi\u0000ws-1',
  activeProjectAtStart: 'project-a',
  projectId: 'project-a',
  draft: '新名字',
  saving: false,
};

test('C10 会话层正常成功：Host APPLIED → 关闭会话，且只有一次请求', async () => {
  const h = flowHarness({
    session: SESSION_1,
    projects: [PROJECT_A, PROJECT_B],
    scope: SESSION_1.scope,
    activeProjectId: 'project-a',
  });
  const run = h.flow.submit();
  assert.equal(h.global.sent.length, 1);
  h.global.pending[0]!.resolve({ status: 'APPLIED', project: { ...PROJECT_A, name: '新名字' } });
  await run;
  assert.deepEqual(h.effects, ['close:1']);
  assert.equal(h.session, null);
  assert.equal(h.global.state.projects[0]?.name, '新名字');
});

test('C11 会话层失败：保留会话写错误，列表不变，不重发', async () => {
  const h = flowHarness({
    session: SESSION_1,
    projects: [PROJECT_A],
    scope: SESSION_1.scope,
    activeProjectId: 'project-a',
  });
  const run = h.flow.submit();
  h.global.pending[0]!.resolve({
    status: 'REJECTED',
    errorCode: 'ERR_PROJECT_BUSY',
    message: '项目忙',
    httpStatus: 409,
  });
  await run;
  assert.equal(h.effects.length, 1);
  assert.match(h.effects[0] ?? '', /^fail:1:/);
  assert.ok(h.session, '失败的会话必须留着供修正');
  assert.equal(h.global.state.projects[0]?.name, '项目A');
  assert.equal(h.global.sent.length, 1);
});

test('C12 在途时打开新会话：旧结果只能 notice，绝不关闭或污染新会话', async () => {
  const h = flowHarness({
    session: SESSION_1,
    projects: [PROJECT_A, PROJECT_B],
    scope: SESSION_1.scope,
    activeProjectId: 'project-a',
  });
  const run = h.flow.submit();
  // 用户收起旧会话、给另一个项目开了新会话（sessionId=2）
  const SESSION_2: SessionRow = {
    sessionId: 2,
    scope: SESSION_1.scope,
    activeProjectAtStart: 'project-b',
    projectId: 'project-b',
    draft: 'B 的新名字',
    saving: false,
  };
  h.setSession(SESSION_2);
  h.switchActiveProject('project-b');
  h.global.pending[0]!.resolve({ status: 'APPLIED', project: { ...PROJECT_A, name: '新名字' } });
  await run;
  assert.equal(h.effects.length, 1);
  assert.match(h.effects[0] ?? '', /^notice:/, '只能提示');
  assert.deepEqual(h.session, SESSION_2, '新会话一个字都不能被改');
  // 全球层仍按归属回填（同一工作区、同一项目行、活动项目不参与）
  assert.equal(h.global.state.projects[0]?.name, '新名字');
});

test('C13 在途时切换工作区：旧结果 notice，且不回填列表', async () => {
  const h = flowHarness({
    session: SESSION_1,
    projects: [PROJECT_A],
    scope: SESSION_1.scope,
    activeProjectId: 'project-a',
  });
  const run = h.flow.submit();
  h.switchScope('live\u0000multi\u0000ws-2');
  h.global.switchWorkspace('ws-2');
  h.global.pending[0]!.resolve({ status: 'APPLIED', project: { ...PROJECT_A, name: '新名字' } });
  await run;
  assert.match(h.effects[0] ?? '', /^notice:/);
  assert.equal(h.global.state.projects[0]?.name, '项目A');
});

test('C14 在途时项目被移除：notice 而不是静默关闭', async () => {
  const h = flowHarness({
    session: SESSION_1,
    projects: [PROJECT_A],
    scope: SESSION_1.scope,
    activeProjectId: 'project-a',
  });
  const run = h.flow.submit();
  h.setProjects([PROJECT_B]);
  h.global.replaceProjects([PROJECT_B]);
  h.global.pending[0]!.resolve({ status: 'APPLIED', project: { ...PROJECT_A, name: '新名字' } });
  await run;
  assert.match(h.effects[0] ?? '', /^notice:/);
  assert.equal(h.global.state.projects.length, 1);
});

test('C15 提交前就失效的会话：不发请求，直接收起并说明原因', async () => {
  const h = flowHarness({
    session: SESSION_1,
    projects: [PROJECT_A],
    scope: SESSION_1.scope,
    activeProjectId: 'project-a',
  });
  h.switchScope('live\u0000multi\u0000ws-9');
  await h.flow.submit();
  assert.equal(h.global.sent.length, 0, '失效会话不得发请求');
  assert.deepEqual(h.effects[0]?.slice(0, 6), 'close:');
});

test('C16 单飞：同一会话连按两次只发一次请求', async () => {
  const h = flowHarness({
    session: SESSION_1,
    projects: [PROJECT_A],
    scope: SESSION_1.scope,
    activeProjectId: 'project-a',
  });
  const first = h.flow.submit();
  // 第二次进入时 session.saving 已经是 true（或锁未被释放）
  await h.flow.submit();
  assert.equal(h.global.sent.length, 1);
  h.global.pending[0]!.resolve({ status: 'APPLIED', project: { ...PROJECT_A, name: '新名字' } });
  await first;
  await settle();
  assert.equal(h.global.sent.length, 1, '绝不自动重发');
});
