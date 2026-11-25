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
import {
  addTrashPending,
  createInlineCoordination,
  createTrashLedgerStore,
  encodeTrashLedger,
  MAX_TRASH_LEDGER_BYTES,
  MAX_TRASH_PENDING,
  pendingIdsOf,
  readTrashLedger,
  reconcileTrashPending,
  removeTrashPending,
  TRASH_LEDGER_KEY,
  TRASH_LEDGER_VERSION,
  trashLedgerBlockMessage,
  writeTrashLedger,
  type TrashLedgerCoordination,
  type TrashPendingRecord,
} from '../../apps/shell/src/state/trash-ledger.ts';
import type { StorageLike } from '../../apps/shell/src/state/workspace-persistence.ts';

const AT = '2026-11-23T04:05:06.000Z';
/** 工作区身份键：与 `state/trash.ts` 的 `identityKeyOf` 同一写法。 */
const SCOPE_A = 'live\u0000multi\u0000a1b2c3d4e5f60718\u00001';
const SCOPE_B = 'live\u0000multi\u0000b1b2c3d4e5f60718\u00001';
/** 切回 A 之后的下一代次（epoch 变了 → 身份键不同）。 */
const SCOPE_A_V2 = 'live\u0000multi\u0000a1b2c3d4e5f60718\u00002';

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
    busyOwners: {},
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
  state = workspaceReducer(state, { type: 'TRASH_BUSY', projectId: 'project-a', opId: 'op-A', busy: true, scope: SCOPE_A });
  state = workspaceReducer(state, { type: 'TRASH_BUSY', projectId: 'project-a', opId: 'op-B', busy: true, scope: SCOPE_A });
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
  state = workspaceReducer(state, { type: 'TRASH_BUSY', projectId: 'project-a', opId: 'op-A', busy: false, scope: SCOPE_A });
  assert.deepEqual(state.trashByProject['project-a'].busyOpIds, ['op-B'], 'A 完成不得清掉 B');

  // 重复派发同一个标记不产生新对象（省掉无意义重渲染）
  const same = workspaceReducer(state, { type: 'TRASH_BUSY', projectId: 'project-a', opId: 'op-B', busy: true, scope: SCOPE_A });
  assert.equal(same, state);

  state = workspaceReducer(state, { type: 'TRASH_BUSY', projectId: 'project-a', opId: 'op-B', busy: false, scope: SCOPE_A });
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

/* ================================================================== */
/* 五、跨重启「待核对」台账（R1.1-02）                                    */
/* ================================================================== */

/** 最小 StorageLike：可注入初始值，也能按需抛异常。 */
function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function pendingRecord(overrides: Partial<TrashPendingRecord> = {}): TrashPendingRecord {
  return {
    workspaceKey: 'a1b2c3d4e5f60718',
    projectId: 'project-001',
    opId: 'op-pending-0001',
    createdAt: '2026-11-24T00:00:00.000Z',
    ...overrides,
  };
}

test('P2-02-R1.1 台账：只接受合法结构，任何可疑内容整体判损坏', () => {
  // 没有记录 ≠ 损坏：第一次运行本来就没有
  assert.deepEqual(readTrashLedger(memoryStorage()), { status: 'ok', records: [] });

  const ok = memoryStorage({ [TRASH_LEDGER_KEY]: encodeTrashLedger([pendingRecord()]) });
  const read = readTrashLedger(ok);
  assert.equal(read.status, 'ok');
  assert.equal(read.status === 'ok' ? read.records.length : -1, 1);

  // JSON 坏了
  assert.deepEqual(readTrashLedger(memoryStorage({ [TRASH_LEDGER_KEY]: '{oops' })), { status: 'corrupt' });
  // 版本不认识
  assert.deepEqual(
    readTrashLedger(memoryStorage({ [TRASH_LEDGER_KEY]: JSON.stringify({ version: 99, records: [] }) })),
    { status: 'corrupt' },
  );
  // 单条非法 → 整体损坏（静默丢掉会把它重新开放）
  const badRecord = memoryStorage({
    [TRASH_LEDGER_KEY]: JSON.stringify({ version: TRASH_LEDGER_VERSION, records: [{ ...pendingRecord(), opId: 'x' }] }),
  });
  assert.deepEqual(readTrashLedger(badRecord), { status: 'corrupt' });
  // 超量
  const tooMany = memoryStorage({
    [TRASH_LEDGER_KEY]: JSON.stringify({
      version: TRASH_LEDGER_VERSION,
      records: Array.from({ length: MAX_TRASH_PENDING + 1 }, (_, i) => pendingRecord({ opId: `op-${String(i).padStart(8, '0')}` })),
    }),
  });
  assert.deepEqual(readTrashLedger(tooMany), { status: 'corrupt' });

  // 存储本身不可用 / 读取抛异常
  assert.deepEqual(readTrashLedger(null), { status: 'unavailable' });
  const throwing: StorageLike = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
    removeItem() {},
  };
  assert.deepEqual(readTrashLedger(throwing), { status: 'unavailable' });

  // 两种非 ok 都必须给出"关闭恢复"的说明，而且不能是空集合语义
  assert.match(trashLedgerBlockMessage('corrupt') ?? '', /损坏/);
  assert.match(trashLedgerBlockMessage('unavailable') ?? '', /不可用/);
  assert.equal(trashLedgerBlockMessage('ok'), null);
});

test('P2-02-R1.1 台账：按 工作区 + 项目 + opId 隔离，写入失败要如实返回', () => {
  const a = pendingRecord();
  const b = pendingRecord({ workspaceKey: 'b1b2c3d4e5f60718', opId: 'op-pending-0002' });
  let records = addTrashPending([], a);
  records = addTrashPending(records, b);
  records = addTrashPending(records, a); // 重复不追加
  assert.equal(records.length, 2);

  assert.deepEqual(pendingIdsOf(records, a.workspaceKey, a.projectId), [a.opId]);
  assert.deepEqual(pendingIdsOf(records, b.workspaceKey, b.projectId), [b.opId]);
  assert.deepEqual(pendingIdsOf(records, a.workspaceKey, 'project-999'), [], '同工作区别的项目不受影响');
  assert.deepEqual(pendingIdsOf(records, null, a.projectId), [], '没有工作区身份时不能"猜"归属');

  // 只删指定那一条
  assert.deepEqual(removeTrashPending(records, { workspaceKey: a.workspaceKey, projectId: a.projectId, opIds: [a.opId] }), [b]);

  // 写入失败（隐私模式 / 配额）必须返回 false，由调用方提示保护降级
  const storage = memoryStorage();
  assert.equal(writeTrashLedger(storage, [a]), true);
  assert.equal(readTrashLedger(storage).status, 'ok');
  const quota: StorageLike = {
    getItem: () => null,
    setItem() {
      const err = new Error('quota');
      err.name = 'QuotaExceededError';
      throw err;
    },
    removeItem() {},
  };
  assert.equal(writeTrashLedger(quota, [a]), false, '写不进去不能假装成功');
  assert.equal(writeTrashLedger(null, [a]), false);
});

test('P2-02-R1.1 台账：只有终态或记录消失才解除（stored/读取失败都保留）', () => {
  const record = pendingRecord();
  const scope = { workspaceKey: record.workspaceKey, projectId: record.projectId };
  const records = [record];

  for (const state of ['restored', 'aborted', 'conflicted', 'missing'] as const) {
    assert.deepEqual(
      reconcileTrashPending(records, { ...scope, entries: [entry({ opId: record.opId, state, canRestore: false })], loaded: true }),
      [],
      `${state} 是终态，必须解除`,
    );
  }
  for (const state of ['stored', 'pending', 'restoring'] as const) {
    assert.deepEqual(
      reconcileTrashPending(records, { ...scope, entries: [entry({ opId: record.opId, state, canRestore: false })], loaded: true }),
      records,
      `${state} 不是终态，必须保留`,
    );
  }
  // 记录已不在列表里：没有可点的行了 → 解除
  assert.deepEqual(reconcileTrashPending(records, { ...scope, entries: [], loaded: true }), []);
  // 读取失败：原样保留（一次网络错误不构成结论）
  assert.deepEqual(reconcileTrashPending(records, { ...scope, entries: [], loaded: false }), records);
  // 别的工作区的记录不受影响
  assert.deepEqual(
    reconcileTrashPending([record, pendingRecord({ workspaceKey: 'b1b2c3d4e5f60718' })], {
      ...scope,
      entries: [],
      loaded: true,
    }),
    [pendingRecord({ workspaceKey: 'b1b2c3d4e5f60718' })],
  );
});

test('P2-02-R1.1 重启：内存清空后仅凭台账也必须保持禁用', () => {
  const storage = memoryStorage({
    [TRASH_LEDGER_KEY]: encodeTrashLedger([pendingRecord()]),
  });

  // "重启" = React 状态全丢，只剩浏览器存储
  const reloaded = readTrashLedger(storage);
  assert.equal(reloaded.status, 'ok');
  const pending = reloaded.status === 'ok' ? reloaded.records : [];

  // Host 对账还没跑完：列表仍然说 stored
  const freshState = workspaceReducer(INITIAL_STATE, {
    type: 'TRASH_LOADED',
    projectId: pendingRecord().projectId,
    entries: [entry({ opId: pendingRecord().opId, state: 'stored' })],
    count: 1,
  });
  const view = trashPanelView({
    mode: 'live',
    workspaceMode: 'multi',
    projectId: pendingRecord().projectId,
    state: freshState.trashByProject[pendingRecord().projectId],
    extraUnconfirmed: pendingIdsOf(pending, pendingRecord().workspaceKey, pendingRecord().projectId),
  });
  assert.equal(view.kind, 'list');
  if (view.kind !== 'list') return;
  assert.equal(view.rows[0].canRestore, false, '重启后仍然不能恢复');
  assert.equal(view.rows[0].stateLabel, '待核对');

  // 列表给出终态后才解除，并且解除要落盘
  const next = reconcileTrashPending(pending, {
    workspaceKey: pendingRecord().workspaceKey,
    projectId: pendingRecord().projectId,
    entries: [entry({ opId: pendingRecord().opId, state: 'restored', canRestore: false })],
    loaded: true,
  });
  assert.deepEqual(next, []);
  assert.equal(writeTrashLedger(storage, next), true);
  assert.deepEqual(readTrashLedger(storage), { status: 'ok', records: [] });
});

test('P2-02-R1.1 台账不可用：所有恢复关闭并给出原因（fail-closed）', () => {
  const corrupted = readTrashLedger(memoryStorage({ [TRASH_LEDGER_KEY]: 'not-json' }));
  assert.equal(corrupted.status, 'corrupt');

  const view = trashPanelView({
    mode: 'live',
    workspaceMode: 'multi',
    projectId: 'project-a',
    state: trashState({ entries: [entry()], count: 1 }),
    restoreBlocked: trashLedgerBlockMessage(corrupted.status),
  });
  assert.equal(view.kind, 'list');
  if (view.kind !== 'list') return;
  assert.ok(view.blocked, '必须说明为什么不能恢复');
  assert.match(view.blocked ?? '', /损坏/);
  assert.equal(view.rows[0].canRestore, false, '台账不可用时任何记录都不能恢复');
  assert.match(view.rows[0].hint, /暂时不能恢复/);
});

test('P2-02-R1.1 reducer：切换工作区模式同样丢弃回收区缓存', () => {
  const loaded = workspaceReducer(
    { ...INITIAL_STATE, mode: 'live', workspaceMode: 'multi', workspaceKey: 'key-A' },
    { type: 'TRASH_LOADED', projectId: 'project-001', entries: [entry()], count: 1 },
  );
  const sameMode = workspaceReducer(loaded, { type: 'SET_WORKSPACE_MODE', workspaceMode: 'multi' });
  assert.equal(sameMode, loaded, '同样的模式不清理');

  const legacy = workspaceReducer(loaded, { type: 'SET_WORKSPACE_MODE', workspaceMode: 'legacy' });
  assert.deepEqual(legacy.trashByProject, {}, '模式变了就是换工作区');
});

/* ================================================================== */
/* 六、R1.2：台账原子性 / 容量 / busy 归属                                */
/* ================================================================== */

/** 可切换"写盘必失败"的 StorageLike（隐私模式、配额用尽）。 */
function storageWithFailure(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const ctl = { failWrites: false };
  const storage: StorageLike = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (ctl.failWrites) throw new Error('QuotaExceededError');
      data.set(key, value);
    },
    removeItem: (key) => void data.delete(key),
  };
  return { storage, data, ctl };
}

const pendingOf = (opId: string, overrides: Partial<TrashPendingRecord> = {}): TrashPendingRecord => ({
  workspaceKey: 'a1b2c3d4e5f60718',
  projectId: 'project-001',
  opId,
  createdAt: '2026-11-24T00:00:00.000Z',
  ...overrides,
});

/** 单标签页串行协调：store 现在必须显式给出"谁能保证互斥"。 */
function inline(): TrashLedgerCoordination {
  return createInlineCoordination();
}
function newStore(storage: StorageLike) {
  return createTrashLedgerStore(storage, readTrashLedger(storage), inline());
}

test('P2-02-R1.2 台账原子性：并发两次预留都不丢（内存与 localStorage 一致）', async () => {
  const { storage, ctl } = storageWithFailure();
  const first = newStore(storage);

  // 两条 UNKNOWN 在同一次 React 提交前先后到达：中间**没有**重新渲染
  const [a, b] = await Promise.all([
    first.reserve(pendingOf('op-atomic-a01')),
    first.reserve(pendingOf('op-atomic-b02')),
  ]);
  assert.deepEqual([a.status, b.status], ['reserved', 'reserved']);

  assert.deepEqual(first.records().map((record) => record.opId), ['op-atomic-a01', 'op-atomic-b02']);

  const stored = readTrashLedger(storage);
  assert.equal(stored.status, 'ok');
  assert.deepEqual(
    stored.status === 'ok' ? stored.records.map((record) => record.opId) : [],
    ['op-atomic-a01', 'op-atomic-b02'],
    'localStorage 与内存必须一致',
  );

  // 模拟重新初始化（页面重启）：两条都还在待核对
  const reopened = newStore(storage);
  assert.deepEqual(reopened.records().map((record) => record.opId), ['op-atomic-a01', 'op-atomic-b02']);

  // 同一个 opId 再来一次：exists（**不是**授权，见套件 96 的 Controller 闸门用例）
  assert.equal((await first.reserve(pendingOf('op-atomic-a01'))).status, 'exists');
  assert.equal(first.records().length, 2);

  // 落盘失败 → 内存不动，绝不假装保护生效
  ctl.failWrites = true;
  assert.equal((await first.reserve(pendingOf('op-atomic-c03'))).status, 'write-failed');
  assert.deepEqual(first.records().map((record) => record.opId), ['op-atomic-a01', 'op-atomic-b02']);
  ctl.failWrites = false;
  const afterFailure = readTrashLedger(storage);
  assert.deepEqual(
    afterFailure.status === 'ok' ? afterFailure.records.map((record) => record.opId) : [],
    ['op-atomic-a01', 'op-atomic-b02'],
    '写失败不得留下半条记录',
  );
});

test('P2-02-R1.2 容量：满仓不淘汰，最多 64 条，第 65 条被拒且第一条仍在', async () => {
  const { storage } = storageWithFailure();
  const store = newStore(storage);

  for (let i = 0; i < MAX_TRASH_PENDING; i += 1) {
    assert.equal((await store.reserve(pendingOf(`op-cap-${String(i).padStart(8, '0')}`))).status, 'reserved');
  }
  assert.equal(store.records().length, MAX_TRASH_PENDING);
  assert.equal(store.status(), 'full');
  assert.match(store.blockMessage() ?? '', /已满/);

  // 64 条能被正常读回（写入前按实际字节校验过）
  const stored = readTrashLedger(storage);
  assert.equal(stored.status, 'ok');
  assert.equal(stored.status === 'ok' ? stored.records.length : -1, MAX_TRASH_PENDING);

  // 第 65 条：拒绝，且**不淘汰**最早那条
  assert.equal((await store.reserve(pendingOf('op-cap-overflow'))).status, 'full');
  assert.equal(store.records().length, MAX_TRASH_PENDING);
  assert.equal(store.records()[0].opId, 'op-cap-00000000', '第一条不得被挤掉');
  assert.equal(
    store.records().some((record) => record.opId === 'op-cap-overflow'),
    false,
  );

  // 满仓时不能恢复：闸门给的是"已满"，不是"损坏"
  assert.match(store.blockMessage() ?? '', /已满/);
  assert.doesNotMatch(store.blockMessage() ?? '', /损坏/);

  // 解除一条后重新获得一个位置
  await store.release({ workspaceKey: 'a1b2c3d4e5f60718', projectId: 'project-001', opIds: ['op-cap-00000000'] });
  assert.equal(store.status(), 'ok');
  assert.equal(store.records().length, MAX_TRASH_PENDING - 1);
  assert.equal((await store.reserve(pendingOf('op-cap-reuse001'))).status, 'reserved');
  assert.equal(store.records().length, MAX_TRASH_PENDING);
});

test('P2-02-R1.2 容量：62 条时两个并发恢复各占一位，都 UNKNOWN 也不丢记录', async () => {
  const { storage } = storageWithFailure();
  const store = newStore(storage);
  for (let i = 0; i < MAX_TRASH_PENDING - 2; i += 1) {
    await store.reserve(pendingOf(`op-pre-${String(i).padStart(8, '0')}`));
  }
  assert.equal(store.records().length, MAX_TRASH_PENDING - 2);

  // 两个恢复同时申请（控制器按 opId 分键，不互相阻塞）
  const [a, b] = await Promise.all([
    store.reserve(pendingOf('op-race-a00001')),
    store.reserve(pendingOf('op-race-b00002')),
  ]);
  assert.deepEqual([a.status, b.status], ['reserved', 'reserved']);
  assert.equal(store.records().length, MAX_TRASH_PENDING);

  // 两个都 UNKNOWN：列表里都还是 stored（不是终态），台账必须一条不少
  const reconciled = await store.reconcile({
    workspaceKey: 'a1b2c3d4e5f60718',
    projectId: 'project-001',
    entries: store.records().map((record) => entry({ opId: record.opId, state: 'stored' })),
    loaded: true,
  });
  assert.equal(reconciled.status, 'unchanged');
  assert.equal(store.records().length, MAX_TRASH_PENDING);
  assert.equal(
    store.records().filter((record) => record.opId.startsWith('op-race-')).length,
    2,
  );
});

test('P2-02-R1.2 容量：63 条时两个恢复只有一个能预留，另一个必须被挡', async () => {
  const { storage } = storageWithFailure();
  const store = newStore(storage);
  for (let i = 0; i < MAX_TRASH_PENDING - 1; i += 1) {
    await store.reserve(pendingOf(`op-last-${String(i).padStart(8, '0')}`));
  }
  const [winner, loser] = await Promise.all([
    store.reserve(pendingOf('op-last-winner')),
    store.reserve(pendingOf('op-last-loser0')),
  ]);
  // 只有一个能拿到最后一个位置：并发下也绝不出现两个 reserved
  assert.deepEqual([winner.status, loser.status].sort(), ['full', 'reserved']);
  assert.equal(store.records().length, MAX_TRASH_PENDING);
  // 谁赢不确定，但输的那个一定不在台账里
  const loserOpId = winner.status === 'full' ? 'op-last-winner' : 'op-last-loser0';
  assert.equal(
    store.records().some((record) => record.opId === loserOpId),
    false,
  );
});

test('P2-02-R1.2 台账：写盘前按实际字节校验，绝不写入下次必判损坏的数据', () => {
  const { storage, data } = storageWithFailure();

  // 字段都取上限：64 条编码后超过 16 KiB
  const bulky: TrashPendingRecord[] = Array.from({ length: MAX_TRASH_PENDING }, (_, i) => ({
    workspaceKey: 'f'.repeat(128),
    projectId: 'p'.repeat(32),
    opId: `op-${String(i).padStart(8, '0')}${'x'.repeat(48)}`,
    createdAt: '2026-11-24T00:00:00.000Z',
  }));
  const encoded = encodeTrashLedger(bulky);
  const encodedBytes = new TextEncoder().encode(encoded).byteLength;
  assert.ok(encodedBytes > MAX_TRASH_LEDGER_BYTES, `夹具必须真的超限（${encodedBytes} 字节）`);

  assert.equal(writeTrashLedger(storage, bulky), false, '超限必须拒写');
  assert.equal(data.has(TRASH_LEDGER_KEY), false, '不能留下一条下次必判 corrupt 的数据');
  assert.deepEqual(readTrashLedger(storage), { status: 'ok', records: [] }, '下次启动仍是干净的首次使用');

  // 正常体量的 64 条必须写得进去
  const normal: TrashPendingRecord[] = Array.from({ length: MAX_TRASH_PENDING }, (_, i) =>
    pendingOf(`op-norm-${String(i).padStart(8, '0')}`),
  );
  assert.equal(writeTrashLedger(storage, normal), true);
  assert.equal(readTrashLedger(storage).status, 'ok');
});

test('P2-02-R1.2 文案：损坏时关闭恢复，且不引导用户清除本应用数据', () => {
  const message = trashLedgerBlockMessage('corrupt') ?? '';
  assert.match(message, /已损坏/);
  assert.match(message, /暂时关闭/);
  assert.doesNotMatch(message, /清除本应用数据/, '清数据会连台账一起删掉，等于绕过 fail-closed');
});

test('P2-02-R1.2 reducer：A 的收尾不得清掉 B 的同 opId 在途，A→B→A 也不行', () => {
  const KEY_A = 'a1b2c3d4e5f60718';
  const KEY_B = 'b1b2c3d4e5f60718';
  const base = { ...INITIAL_STATE, mode: 'live' as const, workspaceMode: 'multi' as const, workspaceKey: KEY_A };
  const loaded = (state: typeof INITIAL_STATE) =>
    workspaceReducer(state, {
      type: 'TRASH_LOADED',
      projectId: 'project-001',
      entries: [entry({ opId: 'op-x-0001' })],
      count: 1,
    });

  let state = loaded(base);
  state = workspaceReducer(state, {
    type: 'TRASH_BUSY',
    projectId: 'project-001',
    opId: 'op-x-0001',
    busy: true,
    scope: SCOPE_A,
  });
  assert.deepEqual(state.trashByProject['project-001'].busyOpIds, ['op-x-0001']);

  // 切到 B 工作区（同 projectId）：桶被清空，B 重新读到记录并开始恢复
  state = workspaceReducer(state, { type: 'SET_WORKSPACE_KEY', workspaceKey: KEY_B });
  state = loaded(state);
  state = workspaceReducer(state, {
    type: 'TRASH_BUSY',
    projectId: 'project-001',
    opId: 'op-x-0001',
    busy: true,
    scope: SCOPE_B,
  });
  assert.deepEqual(state.trashByProject['project-001'].busyOpIds, ['op-x-0001']);

  // A 的旧请求这时才返回，finally 里带的是 A 的身份
  const afterLateA = workspaceReducer(state, {
    type: 'TRASH_BUSY',
    projectId: 'project-001',
    opId: 'op-x-0001',
    busy: false,
    scope: SCOPE_A,
  });
  assert.equal(afterLateA, state, '别人的收尾必须整个丢弃（连对象都不新建）');
  assert.deepEqual(afterLateA.trashByProject['project-001'].busyOpIds, ['op-x-0001'], 'B 仍在恢复中');

  // B 自己结束：正常解除
  const afterB = workspaceReducer(afterLateA, {
    type: 'TRASH_BUSY',
    projectId: 'project-001',
    opId: 'op-x-0001',
    busy: false,
    scope: SCOPE_B,
  });
  assert.deepEqual(afterB.trashByProject['project-001'].busyOpIds, []);

  // A→B→A：代次不同 → 身份键不同，旧收尾不得清掉新一轮的在途
  let back = workspaceReducer(afterB, { type: 'SET_WORKSPACE_KEY', workspaceKey: KEY_A });
  back = loaded(back);
  back = workspaceReducer(back, {
    type: 'TRASH_BUSY',
    projectId: 'project-001',
    opId: 'op-x-0001',
    busy: true,
    scope: SCOPE_A_V2,
  });
  const lateOldEpoch = workspaceReducer(back, {
    type: 'TRASH_BUSY',
    projectId: 'project-001',
    opId: 'op-x-0001',
    busy: false,
    scope: SCOPE_A,
  });
  assert.deepEqual(
    lateOldEpoch.trashByProject['project-001'].busyOpIds,
    ['op-x-0001'],
    '上一代次的收尾不能结束这一代次的恢复',
  );
  const done = workspaceReducer(lateOldEpoch, {
    type: 'TRASH_BUSY',
    projectId: 'project-001',
    opId: 'op-x-0001',
    busy: false,
    scope: SCOPE_A_V2,
  });
  assert.deepEqual(done.trashByProject['project-001'].busyOpIds, []);
});

test('P2-02-R1.2 reducer：同一工作区切项目后，旧项目的在途仍能正常结算', () => {
  let state = workspaceReducer(
    { ...INITIAL_STATE, mode: 'live', workspaceMode: 'multi', workspaceKey: 'a1b2c3d4e5f60718' },
    { type: 'TRASH_LOADED', projectId: 'project-a', entries: [entry({ opId: 'op-x-0001' })], count: 1 },
  );
  state = workspaceReducer(state, {
    type: 'TRASH_BUSY',
    projectId: 'project-a',
    opId: 'op-x-0001',
    busy: true,
    scope: SCOPE_A,
  });
  state = workspaceReducer(state, { type: 'SET_ACTIVE_PROJECT', projectId: 'project-b' });
  state = workspaceReducer(state, {
    type: 'TRASH_BUSY',
    projectId: 'project-a',
    opId: 'op-x-0001',
    busy: false,
    scope: SCOPE_A,
  });
  assert.deepEqual(state.trashByProject['project-a'].busyOpIds, [], '切项目不影响原来那条的收尾');
});

/* ================================================================== */
/* R1.2.1-R1：台账状态变化也必须通知界面（不能只比记录签名）              */
/* ================================================================== */

test('P2-02-R1.2.1-R1 台账：记录集合没变、只有状态变坏时 refresh 必须返回"有变化"', async () => {
  const { storage } = storageWithFailure();
  const store = newStore(storage);
  assert.equal((await store.reserve(pendingOf('op-status-0001'))).status, 'reserved');
  assert.equal(store.status(), 'ok');
  assert.equal(store.refresh(), false, '什么都没变时不该有信号');

  // 外部把台账写坏：记录集合（在内存里）仍然是那一条，变化的是 readStatus
  storage.setItem(TRASH_LEDGER_KEY, '{"version":1,"records":[{"workspaceKey":');
  assert.equal(store.refresh(), true, '状态从 ok 变成 corrupt 也必须通知界面');
  assert.equal(store.status(), 'corrupt');
  assert.deepEqual(store.records().map((record) => record.opId), ['op-status-0001'], '非 ok 不得丢弃已知记录');
  assert.match(store.blockMessage() ?? '', /损坏/);

  // 同一个损坏状态再刷一次：没有新变化
  assert.equal(store.refresh(), false);
});

test('P2-02-R1.2.1-R1 文案：外部删除导致的失效有独立说明，且不引导用户清空数据', () => {
  const message = trashLedgerBlockMessage('invalidated') ?? '';
  assert.match(message, /删除|失效/);
  assert.match(message, /恢复/);
  assert.doesNotMatch(message, /清除本应用数据/);
});
