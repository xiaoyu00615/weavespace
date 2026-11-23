/**
 * UX-02C-03-P2-02：回收区 Shell 侧的**纯逻辑**（状态展示 / 菜单判定 / 文案 / 面板视图）。
 *
 * 为什么不是组件测试：`.tsx` 没有 JSX 变换，`node:test` 无法 import。
 * 按项目既有约定（套件 41、84），可测判断必须先落在 `.ts` 模块里，
 * 组件只做渲染。本套件断言的就是"组件会照着画的那份数据"。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatTrashSize,
  formatTrashTime,
  TRASH_DEMO_MESSAGE,
  TRASH_FULL_MESSAGE,
  TRASH_TARGET_EXISTS_MESSAGE,
  TRASH_STATE_VIEW,
  trashBadgeCount,
  trashBlockerMessage,
  trashDeleteCommandState,
  trashErrorMessage,
  trashLoadKey,
  trashPanelView,
  trashRowView,
} from '../../apps/shell/src/state/trash.ts';
import {
  INITIAL_STATE,
  workspaceReducer,
} from '../../apps/shell/src/state/workspace-reducer.ts';
import {
  serializeWorkspace,
  validateSnapshot,
} from '../../apps/shell/src/state/workspace-persistence.ts';
import type { TrashEntryDto, TrashEntryState } from '../../apps/shell/src/client/client-api.ts';
import type { TrashProjectState, WorkspaceState } from '../../apps/shell/src/state/types.ts';

const AT = '2026-11-23T04:05:06.000Z';

function entry(overrides: Partial<TrashEntryDto> = {}): TrashEntryDto {
  return {
    opId: 'op-p202-trash-0001',
    path: 'docs/guide.md',
    entryKind: 'file',
    size: 2048,
    deletedAt: AT,
    state: 'stored',
    canRestore: true,
    ...overrides,
  };
}

function trashState(overrides: Partial<TrashProjectState> = {}): TrashProjectState {
  return {
    entries: [entry()],
    count: 1,
    loaded: true,
    loading: false,
    errorCode: null,
    errorMessage: null,
    busyOpIds: [],
    unconfirmedOpIds: [],
    ...overrides,
  };
}

/* ================================================================== */
/* 一、七种状态                                                         */
/* ================================================================== */

test('P2-02 七种状态各自有明确的标签 / 语气 / 是否可恢复', () => {
  const all: TrashEntryState[] = [
    'pending',
    'stored',
    'restoring',
    'restored',
    'aborted',
    'conflicted',
    'missing',
  ];
  // 七种状态必须**全部**有映射：新增状态时这里会先红，而不是界面上悄悄空白
  assert.deepEqual(Object.keys(TRASH_STATE_VIEW).sort(), [...all].sort());

  assert.equal(TRASH_STATE_VIEW.stored.canRestore, true, '只有 stored 给恢复按钮');
  for (const state of all) {
    if (state === 'stored') continue;
    assert.equal(TRASH_STATE_VIEW[state].canRestore, false, `${state} 不得给出恢复按钮`);
  }

  // 语义分组：核对中 / 已恢复 / 未成功 / 人工核对
  assert.equal(TRASH_STATE_VIEW.pending.tone, 'pending');
  assert.equal(TRASH_STATE_VIEW.restoring.tone, 'pending');
  assert.equal(TRASH_STATE_VIEW.pending.label, '结果核对中');
  assert.equal(TRASH_STATE_VIEW.restoring.label, '恢复核对中');
  assert.equal(TRASH_STATE_VIEW.restored.label, '已恢复');
  assert.equal(TRASH_STATE_VIEW.aborted.label, '未成功移入');
  assert.equal(TRASH_STATE_VIEW.conflicted.label, '需要人工核对');
  assert.equal(TRASH_STATE_VIEW.missing.label, '文件已丢失');

  // 不能把 UNKNOWN 说成成功：pending/restoring 的提示必须写"未确认"
  for (const state of ['pending', 'restoring'] as const) {
    assert.match(TRASH_STATE_VIEW[state].hint, /未(确认|完成)/, `${state} 的提示不得声称成功`);
    assert.notEqual(TRASH_STATE_VIEW[state].tone, 'ok');
  }
  // 异常状态不伪装成普通失败：要说清"需要人工核对"
  for (const state of ['conflicted', 'missing'] as const) {
    assert.match(TRASH_STATE_VIEW[state].hint, /人工核对/);
  }
});

test('P2-02 行视图：名称取原路径末段，路径原样展示，busy 时不可点恢复', () => {
  const row = trashRowView(entry(), false);
  assert.equal(row.name, 'guide.md');
  assert.equal(row.originalPath, 'docs/guide.md');
  assert.equal(row.sizeLabel, '2.0 KB');
  assert.equal(row.canRestore, true);
  assert.equal(row.tone, 'ok');

  const busy = trashRowView(entry(), true);
  assert.equal(busy.canRestore, false, '恢复中不能再点一次');
  assert.equal(busy.busy, true);
  // 恢复在途时不能继续写「可恢复」：那会和「恢复中…」按钮自相矛盾
  assert.equal(busy.stateLabel, '恢复中');
  assert.equal(busy.tone, 'pending', '在途状态不是成功也不是失败');
  assert.doesNotMatch(busy.hint, /可以恢复到原位置/);

  // 结果未确认：不是"在途"，但同样不能点；标签要能区分这两种情况
  const unconfirmed = trashRowView(entry(), false, true);
  assert.equal(unconfirmed.unconfirmed, true);
  assert.equal(unconfirmed.canRestore, false, '待核对期间不得再次恢复');
  assert.equal(unconfirmed.stateLabel, '待核对');
  assert.equal(unconfirmed.tone, 'warn');
  assert.match(unconfirmed.hint, /核对/);

  // Host 说 canRestore=false 时，即便状态是 stored 也不能点（客户端不放宽）
  const guarded = trashRowView(entry({ canRestore: false }), false);
  assert.equal(guarded.canRestore, false);

  // Host 给的 note 优先于默认提示
  const noted = trashRowView(entry({ state: 'conflicted', canRestore: false, note: '被外部改动' }), false);
  assert.equal(noted.hint, '被外部改动');
});

test('P2-02 大小与时间格式化：不编造，异常值显示为 —', () => {
  assert.equal(formatTrashSize(0), '0 B');
  assert.equal(formatTrashSize(1023), '1023 B');
  assert.equal(formatTrashSize(1024), '1.0 KB');
  assert.equal(formatTrashSize(1536), '1.5 KB');
  assert.equal(formatTrashSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatTrashSize(Number.NaN), '—');
  assert.equal(formatTrashSize(-1), '—');

  // 时间是本地时区展示：用同一个 Date 的本地分量算期望值，避免测试依赖 TZ
  const date = new Date(Date.parse(AT));
  const pad = (value: number): string => String(value).padStart(2, '0');
  const expected = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  assert.equal(formatTrashTime(AT), expected);
  assert.equal(formatTrashTime('不是时间'), '—');
});

/* ================================================================== */
/* 二、右键菜单：移入回收区                                              */
/* ================================================================== */

test('P2-02 菜单：普通文件可回收，目录/链接/项目根禁用并给出原因', () => {
  assert.deepEqual(trashDeleteCommandState({ origin: 'file', entryKind: 'file', supported: true }), {
    visible: true,
    disabled: false,
  });

  const folder = trashDeleteCommandState({ origin: 'folder', entryKind: 'directory', supported: true });
  assert.equal(folder.visible, true);
  assert.equal(folder.disabled, true);
  assert.match(folder.hint ?? '', /目录/);

  const link = trashDeleteCommandState({ origin: 'link', entryKind: 'link', supported: true });
  assert.equal(link.disabled, true);
  assert.match(link.hint ?? '', /链接/);

  const root = trashDeleteCommandState({ origin: 'project-root', supported: true });
  assert.equal(root.visible, true);
  assert.equal(root.disabled, true);
  assert.match(root.hint ?? '', /项目根/);

  // Demo / Legacy / 静态 Multi：显示但禁用，说明"当前模式不支持"
  const unsupported = trashDeleteCommandState({ origin: 'file', entryKind: 'file', supported: false });
  assert.equal(unsupported.visible, true);
  assert.equal(unsupported.disabled, true);
  assert.match(unsupported.hint ?? '', /不支持/);

  // 空白区 / 工具栏没有对象：整项不渲染（不是禁用）
  for (const origin of ['blank', 'toolbar'] as const) {
    const state = trashDeleteCommandState({ origin, supported: true });
    assert.equal(state.visible, false, `${origin} 不该出现回收项`);
  }
});

/* ================================================================== */
/* 三、文案                                                             */
/* ================================================================== */

test('P2-02 文案：回收区满 / 同名冲突用产品规定的原话', () => {
  assert.equal(trashErrorMessage('ERR_TRASH_FULL'), '回收区已满，请先恢复已有文件。');
  assert.equal(trashErrorMessage('ERR_TRASH_FULL'), TRASH_FULL_MESSAGE);
  assert.equal(
    trashErrorMessage('ERR_ENTRY_EXISTS'),
    '原位置已有同名文件，请先改名或移走它。',
  );
  assert.equal(trashErrorMessage('ERR_ENTRY_EXISTS'), TRASH_TARGET_EXISTS_MESSAGE);

  // 未知错误码不吞掉兜底文案
  assert.equal(trashErrorMessage(null, '自定义兜底'), '自定义兜底');
  assert.equal(trashErrorMessage('ERR_SOMETHING_NEW', '兜底'), '兜底');

  // 阻断文案必须带路径，且说明"没有磁盘副作用"
  const blocked = trashBlockerMessage('docs/guide.md', ['ACTIVE_VIEWS', 'DIRTY']);
  assert.match(blocked, /docs\/guide\.md/);
  assert.match(blocked, /未保存/);
  assert.match(blocked, /没有任何磁盘副作用/);
});

/* ================================================================== */
/* 四、面板视图模型                                                     */
/* ================================================================== */

test('P2-02 面板：演示模式与无项目时明确不支持，而不是显示空列表', () => {
  assert.deepEqual(
    trashPanelView({ mode: 'demo', workspaceMode: 'legacy', projectId: null, state: undefined }),
    { kind: 'unsupported', message: TRASH_DEMO_MESSAGE },
  );
  assert.equal(
    trashPanelView({ mode: 'live', workspaceMode: 'multi', projectId: null, state: undefined }).kind,
    'unsupported',
  );
});

test('P2-02 面板：没读到 ≠ 空——loading / error / 空列表三态分开', () => {
  const base = { mode: 'live' as const, workspaceMode: 'multi' as const, projectId: 'project-a' };

  assert.equal(trashPanelView({ ...base, state: undefined }).kind, 'loading');
  assert.equal(
    trashPanelView({ ...base, state: trashState({ loaded: false, loading: true, entries: [], count: 0 }) }).kind,
    'loading',
  );

  const failed = trashPanelView({
    ...base,
    state: trashState({ loaded: false, loading: false, entries: [], count: 0, errorCode: 'ERR_STORAGE_IO', errorMessage: '读取失败' }),
  });
  assert.equal(failed.kind, 'error');
  assert.match(failed.kind === 'error' ? failed.message : '', /读取失败/);

  const empty = trashPanelView({ ...base, state: trashState({ entries: [], count: 0 }) });
  assert.equal(empty.kind, 'list');
  assert.equal(empty.kind === 'list' ? empty.rows.length : -1, 0);

  // 已有列表 + 本轮刷新失败：列表照旧显示，附一条降级提示（不清空）
  const degraded = trashPanelView({
    ...base,
    state: trashState({ errorCode: 'ERR_STORAGE_IO', errorMessage: '刷新失败' }),
  });
  assert.equal(degraded.kind, 'list');
  assert.equal(degraded.kind === 'list' ? degraded.rows.length : -1, 1);
  assert.equal(degraded.kind === 'list' ? degraded.degraded : null, '刷新失败');
});

test('P2-02 面板：在途 / 待核对都只禁用对应那一行', () => {
  const view = trashPanelView({
    mode: 'live',
    workspaceMode: 'multi',
    projectId: 'project-a',
    state: trashState({
      entries: [
        entry({ opId: 'op-a', path: 'a.md' }),
        entry({ opId: 'op-b', path: 'b.md' }),
        entry({ opId: 'op-c', path: 'c.md' }),
      ],
      count: 3,
      busyOpIds: ['op-b'],
      unconfirmedOpIds: ['op-c'],
    }),
  });
  assert.equal(view.kind, 'list');
  if (view.kind !== 'list') return;
  assert.equal(view.rows[0].canRestore, true, '另一个文件仍可恢复');
  assert.equal(view.rows[0].busy, false);
  assert.equal(view.rows[0].unconfirmed, false);
  assert.equal(view.rows[1].canRestore, false, '正在恢复的那一行必须禁用');
  assert.equal(view.rows[1].stateLabel, '恢复中');
  assert.equal(view.rows[2].canRestore, false, '待核对的那一行同样禁用');
  assert.equal(view.rows[2].stateLabel, '待核对');
});

test('P2-02 导航徽标：未知不显示数字，已知才显示', () => {
  assert.equal(trashBadgeCount(undefined, 'live', 'project-a'), null);
  assert.equal(trashBadgeCount(trashState({ loaded: false }), 'live', 'project-a'), null);
  assert.equal(trashBadgeCount(trashState(), 'demo', 'project-a'), null);
  assert.equal(trashBadgeCount(trashState(), 'live', null), null);
  assert.equal(trashBadgeCount(trashState({ count: 3 }), 'live', 'project-a'), 3);
  // 空回收区是**已知的 0**，可以显示
  assert.equal(trashBadgeCount(trashState({ entries: [], count: 0 }), 'live', 'project-a'), 0);
});

/* ================================================================== */
/* 五、状态桶（reducer）与导航持久化                                     */
/* ================================================================== */

test('P2-02 reducer：读取失败不覆盖已有条目，重新读取时保留旧列表', () => {
  const loaded = workspaceReducer(
    { ...INITIAL_STATE, navKey: 'trash' },
    { type: 'TRASH_LOADED', projectId: 'project-a', entries: [entry()], count: 1 },
  );
  assert.equal(loaded.trashByProject['project-a'].count, 1);

  const failed = workspaceReducer(loaded, {
    type: 'TRASH_LOAD_ERROR',
    projectId: 'project-a',
    errorCode: 'ERR_STORAGE_IO',
    message: '读取失败',
  });
  assert.equal(failed.trashByProject['project-a'].entries.length, 1, '失败不得清空列表');
  assert.equal(failed.trashByProject['project-a'].count, 1, '失败不得把数量归零');
  assert.equal(failed.trashByProject['project-a'].errorMessage, '读取失败');

  const retried = workspaceReducer(failed, { type: 'TRASH_LOAD_BEGIN', projectId: 'project-a' });
  assert.equal(retried.trashByProject['project-a'].entries.length, 1, '重试期间列表保留，避免闪空');
  assert.equal(retried.trashByProject['project-a'].loading, true);
  assert.equal(retried.trashByProject['project-a'].errorMessage, null, '重试时清掉上一次的错误');
});

test('P2-02-R1 reducer：刷新不解除在途，且只动对应的那一个 opId', () => {
  let state = workspaceReducer(INITIAL_STATE, {
    type: 'TRASH_LOADED',
    projectId: 'project-a',
    entries: [entry()],
    count: 1,
  });
  state = workspaceReducer(state, { type: 'TRASH_BUSY', projectId: 'project-a', opId: 'op-A', busy: true });
  state = workspaceReducer(state, { type: 'TRASH_BUSY', projectId: 'project-a', opId: 'op-B', busy: true });
  assert.deepEqual(state.trashByProject['project-a'].busyOpIds, ['op-A', 'op-B']);

  // 恢复期间后台刷新回来：在途集合不能被顺手清掉，否则按钮又变回可点
  state = workspaceReducer(state, {
    type: 'TRASH_LOADED',
    projectId: 'project-a',
    entries: [entry()],
    count: 1,
  });
  assert.deepEqual(state.trashByProject['project-a'].busyOpIds, ['op-A', 'op-B'], '刷新不得解除在途状态');
  state = workspaceReducer(state, { type: 'TRASH_LOAD_BEGIN', projectId: 'project-a' });
  assert.deepEqual(state.trashByProject['project-a'].busyOpIds, ['op-A', 'op-B']);

  // A 结束只移除 A
  state = workspaceReducer(state, { type: 'TRASH_BUSY', projectId: 'project-a', opId: 'op-A', busy: false });
  assert.deepEqual(state.trashByProject['project-a'].busyOpIds, ['op-B'], 'A 完成不得清掉 B');

  // 重复派发同一个标记不产生新对象（省掉无意义重渲染）
  const same = workspaceReducer(state, { type: 'TRASH_BUSY', projectId: 'project-a', opId: 'op-B', busy: true });
  assert.equal(same, state);

  state = workspaceReducer(state, { type: 'TRASH_BUSY', projectId: 'project-a', opId: 'op-B', busy: false });
  assert.deepEqual(state.trashByProject['project-a'].busyOpIds, []);
});

test('P2-02-R1 reducer：待核对只由终态列表收敛，stored 仍保持禁用', () => {
  let state = workspaceReducer(INITIAL_STATE, {
    type: 'TRASH_LOADED',
    projectId: 'project-a',
    entries: [entry()],
    count: 1,
  });
  state = workspaceReducer(state, {
    type: 'TRASH_UNCONFIRMED',
    projectId: 'project-a',
    opId: entry().opId,
    pending: true,
  });
  assert.deepEqual(state.trashByProject['project-a'].unconfirmedOpIds, [entry().opId]);

  // 列表仍是 stored：不是终态，不能当作"恢复没发生"就放开
  const stillStored = workspaceReducer(state, {
    type: 'TRASH_LOADED',
    projectId: 'project-a',
    entries: [entry()],
    count: 1,
  });
  assert.deepEqual(stillStored.trashByProject['project-a'].unconfirmedOpIds, [entry().opId]);

  // 列表刷新失败：同样不放开
  const failed = workspaceReducer(state, {
    type: 'TRASH_LOAD_ERROR',
    projectId: 'project-a',
    errorCode: 'ERR_STORAGE_IO',
    message: '读取失败',
  });
  assert.deepEqual(failed.trashByProject['project-a'].unconfirmedOpIds, [entry().opId]);

  // 列表给出终态：收敛
  const restored = workspaceReducer(state, {
    type: 'TRASH_LOADED',
    projectId: 'project-a',
    entries: [entry({ state: 'restored', canRestore: false })],
    count: 1,
  });
  assert.deepEqual(restored.trashByProject['project-a'].unconfirmedOpIds, []);

  // 记录从列表里消失（没有可点的行了）：也收敛
  const gone = workspaceReducer(state, {
    type: 'TRASH_LOADED',
    projectId: 'project-a',
    entries: [],
    count: 0,
  });
  assert.deepEqual(gone.trashByProject['project-a'].unconfirmedOpIds, []);
});

test('P2-02-R1 reducer：换工作区 / 切模式都丢弃旧回收区缓存', () => {
  const loaded = workspaceReducer(
    { ...INITIAL_STATE, mode: 'live', workspaceMode: 'multi', workspaceKey: 'key-A' },
    { type: 'TRASH_LOADED', projectId: 'project-001', entries: [entry()], count: 1 },
  );
  assert.equal(loaded.trashByProject['project-001'].count, 1);

  // 同一个 workspaceKey 的重复派发：不清理（否则每次重连都会闪空）
  const same = workspaceReducer(loaded, { type: 'SET_WORKSPACE_KEY', workspaceKey: 'key-A' });
  assert.equal(same, loaded);

  // 换工作区：项目 id 相同也不得继续显示 A 的记录
  const otherWorkspace = workspaceReducer(loaded, { type: 'SET_WORKSPACE_KEY', workspaceKey: 'key-B' });
  assert.deepEqual(otherWorkspace.trashByProject, {}, '换工作区必须丢弃旧缓存');

  const demo = workspaceReducer(loaded, { type: 'SET_MODE', mode: 'demo' });
  assert.deepEqual(demo.trashByProject, {}, '切模式同样丢弃');
});

test('P2-02-R1 reducer：换工作区后读取失败显示错误，不回填旧工作区数据', () => {
  const loaded = workspaceReducer(
    { ...INITIAL_STATE, mode: 'live', workspaceMode: 'multi', workspaceKey: 'key-A' },
    { type: 'TRASH_LOADED', projectId: 'project-001', entries: [entry()], count: 1 },
  );
  const switched = workspaceReducer(loaded, { type: 'SET_WORKSPACE_KEY', workspaceKey: 'key-B' });
  const failed = workspaceReducer(switched, {
    type: 'TRASH_LOAD_BEGIN',
    projectId: 'project-001',
  });
  const errored = workspaceReducer(failed, {
    type: 'TRASH_LOAD_ERROR',
    projectId: 'project-001',
    errorCode: 'ERR_STORAGE_IO',
    message: '读取失败',
  });

  const view = trashPanelView({
    mode: 'live',
    workspaceMode: 'multi',
    projectId: 'project-001',
    state: errored.trashByProject['project-001'],
  });
  assert.equal(view.kind, 'error', '新工作区读失败必须显示错误，而不是旧工作区的列表');
  assert.equal(errored.trashByProject['project-001'].entries.length, 0, '不得回填 A 的记录');
});

test('P2-02 reducer：项目按桶隔离，移除项目时连回收区视图一起清掉', () => {
  let state = workspaceReducer(
    { ...INITIAL_STATE, mode: 'live', workspaceMode: 'multi' },
    { type: 'TRASH_LOADED', projectId: 'project-a', entries: [entry()], count: 1 },
  );
  state = workspaceReducer(state, {
    type: 'TRASH_LOADED',
    projectId: 'project-b',
    entries: [],
    count: 0,
  });
  assert.equal(state.trashByProject['project-a'].count, 1);
  assert.equal(state.trashByProject['project-b'].count, 0);

  state = workspaceReducer({ ...state, projects: [
    { projectId: 'project-a', name: 'A', status: 'READY' },
    { projectId: 'project-b', name: 'B', status: 'READY' },
  ], activeProjectId: 'project-a' }, { type: 'PROJECT_REMOVED', projectId: 'project-a' });
  assert.equal('project-a' in state.trashByProject, false, '被移除项目的回收区视图必须丢弃');
  assert.equal(state.trashByProject['project-b'].count, 0, '其它项目不受影响');
});

test('P2-02-R1 自动加载键：换工作区（同项目 id）必然重新读取', () => {
  const base = { mode: 'live' as const, workspaceMode: 'multi' as const, projectId: 'project-001' };

  const keyA = trashLoadKey({ ...base, workspaceKey: 'key-A' });
  assert.ok(keyA, 'live + multi + 有项目 → 应该触发读取');
  assert.equal(trashLoadKey({ ...base, workspaceKey: 'key-A' }), keyA, '同样的输入必须得到同样的键（否则每次渲染都会重读）');
  assert.notEqual(trashLoadKey({ ...base, workspaceKey: 'key-B' }), keyA, '换工作区必须换键 → 重新读取');
  assert.notEqual(trashLoadKey({ ...base, workspaceKey: 'key-A', projectId: 'project-002' }), keyA, '换项目换键');

  // 不该读的三种情况一律 null
  assert.equal(trashLoadKey({ ...base, workspaceKey: 'key-A', mode: 'demo' }), null);
  assert.equal(trashLoadKey({ ...base, workspaceKey: 'key-A', workspaceMode: 'legacy' }), null);
  assert.equal(trashLoadKey({ ...base, workspaceKey: 'key-A', projectId: null }), null);
});

test('P2-02 导航持久化：trash 是合法 navKey，未知值仍然被拒绝', () => {
  const state: WorkspaceState = { ...INITIAL_STATE, mode: 'live', navKey: 'trash' };
  const snapshot = serializeWorkspace(state, { workspaceKey: 'test-workspace-key-0001' });
  assert.ok(snapshot, 'live + 有摘要时必须能写出快照');
  assert.equal(snapshot!.ui.navKey, 'trash');

  const raw = JSON.parse(JSON.stringify(snapshot));
  const parsed = validateSnapshot(raw);
  assert.ok(parsed, '写出的快照必须能被读回');
  assert.equal(parsed!.ui.navKey, 'trash', '重开工作台后仍停在回收区');

  // 白名单仍然生效：不在白名单里的 navKey 整份判为不可用
  const tampered = { ...raw, ui: { ...raw.ui, navKey: 'trash-can' } };
  assert.equal(validateSnapshot(tampered), null);
});
