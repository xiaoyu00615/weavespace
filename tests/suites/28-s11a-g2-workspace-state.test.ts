/**
 * S11-A1-G2：Shell 多项目工作区状态（纯函数 / reducer 级）。
 *
 * 覆盖 G2-05/06/07/09/10/19/20 中不依赖 DOM 的部分：
 * 项目维度状态、文档身份、响应归属判定、队列与备份键隔离。
 *
 * 这些断言全部是纯数据变换，因此可以在 Node 里真实执行（不是静态字符串检查）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEditQueue } from '../../apps/shell/src/client/edit-queue.ts';
import {
  draftBackupKey,
  isProjectOpenable,
  isResponseOwnerCurrent,
  makeDocId,
  projectIdOfDocId,
  projectLabelOf,
} from '../../apps/shell/src/state/doc-identity.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import type { DocTab, WorkspaceState } from '../../apps/shell/src/state/types.ts';

const PROJECTS = [
  { projectId: 'project-a', name: '项目 A', status: 'READY' as const },
  { projectId: 'project-b', name: '项目 B', status: 'READY' as const },
  { projectId: 'project-c', name: '项目 C', status: 'UNAVAILABLE' as const, reason: 'MISSING' },
];

function tab(overrides: Partial<DocTab> & Pick<DocTab, 'docId' | 'path'>): DocTab {
  return {
    projectId: null,
    title: overrides.path,
    extension: '.md',
    buffer: '# x\n',
    dirty: false,
    mode: 'live',
    sessionId: 'session-1',
    viewId: 'view-1',
    baseVersion: 'sha256:aaa',
    revision: 0,
    documentState: 'CLEAN',
    saving: false,
    lastStatus: null,
    errorCode: null,
    ...overrides,
  };
}

const multiState = (): WorkspaceState =>
  workspaceReducer(
    workspaceReducer(INITIAL_STATE, { type: 'SET_MODE', mode: 'live' }),
    { type: 'SET_WORKSPACE_MODE', workspaceMode: 'multi' },
  );

// ---------------------------------------------------------------------------
// UI-01 项目列表与默认活动项目
// ---------------------------------------------------------------------------
test('UI-01 多项目列表：默认活动项目取第一个 READY，不伪造可用项目', () => {
  const withProjects = workspaceReducer(multiState(), { type: 'SET_PROJECTS', projects: PROJECTS });
  assert.deepEqual(
    withProjects.projects.map((project) => project.projectId),
    ['project-a', 'project-b', 'project-c'],
  );
  assert.equal(withProjects.activeProjectId, 'project-a');

  const allUnavailable = workspaceReducer(multiState(), {
    type: 'SET_PROJECTS',
    projects: [PROJECTS[2]],
  });
  assert.equal(allUnavailable.activeProjectId, null, '没有 READY 项目时不得伪造活动项目');
});

// ---------------------------------------------------------------------------
// UI-02 项目独立展开 / 折叠
// ---------------------------------------------------------------------------
test('UI-02 A/B 的目录展开状态互相独立', () => {
  let state = workspaceReducer(multiState(), { type: 'SET_PROJECTS', projects: PROJECTS });
  state = workspaceReducer(state, {
    type: 'SET_PROJECT_RESOURCES',
    projectId: 'project-a',
    nodes: [{ id: 'dir:docs', name: 'docs', kind: 'folder', children: [] }],
  });
  state = workspaceReducer(state, {
    type: 'SET_PROJECT_RESOURCES',
    projectId: 'project-b',
    nodes: [{ id: 'dir:scripts', name: 'scripts', kind: 'folder', children: [] }],
  });

  // 首次加载会自动展开一级目录
  assert.equal(state.expandedByProject['project-a']['dir:docs'], true);
  assert.equal(state.expandedByProject['project-b']['dir:scripts'], true);

  state = workspaceReducer(state, { type: 'TOGGLE_PROJECT_NODE', projectId: 'project-a', path: 'dir:docs' });
  assert.equal(state.expandedByProject['project-a']['dir:docs'], false, 'A 折叠自身');
  assert.equal(state.expandedByProject['project-b']['dir:scripts'], true, 'B 不受影响');

  // 刷新 A 不得覆盖 B 的资源树
  state = workspaceReducer(state, {
    type: 'SET_PROJECT_RESOURCES',
    projectId: 'project-a',
    nodes: [{ id: 'dir:new', name: 'new', kind: 'folder', children: [] }],
  });
  assert.equal(state.resourcesByProject['project-b'][0].id, 'dir:scripts');
  assert.equal(state.resourcesByProject['project-a'][0].id, 'dir:new');
});

// ---------------------------------------------------------------------------
// UI-03 同名文件 → 不同 docId
// ---------------------------------------------------------------------------
test('UI-03 同名文件在 A/B 生成不同 docId，Legacy 保持原样', () => {
  const a = makeDocId('project-a', 'a.md');
  const b = makeDocId('project-b', 'a.md');
  assert.equal(a, 'doc:project-a/a.md');
  assert.equal(b, 'doc:project-b/a.md');
  assert.notEqual(a, b);
  assert.equal(makeDocId(null, 'a.md'), 'a.md', 'Legacy/Demo 的 docId 不变');
  assert.equal(projectIdOfDocId(a), 'project-a');
  assert.equal(projectIdOfDocId('a.md'), null);
});

// ---------------------------------------------------------------------------
// UI-04 / UI-05 / UI-15 标签共存、切换项目与关闭隔离
// ---------------------------------------------------------------------------
test('UI-04 A/B 同名文件的标签可以同时存在', () => {
  let state = workspaceReducer(multiState(), { type: 'SET_PROJECTS', projects: PROJECTS });
  state = workspaceReducer(state, {
    type: 'OPEN_TAB',
    tab: tab({ docId: 'doc:project-a/a.md', projectId: 'project-a', path: 'a.md' }),
  });
  state = workspaceReducer(state, {
    type: 'OPEN_TAB',
    tab: tab({ docId: 'doc:project-b/a.md', projectId: 'project-b', path: 'a.md', title: 'a.md' }),
  });
  assert.equal(state.tabs.length, 2);
  assert.deepEqual(
    state.tabs.map((item) => item.docId),
    ['doc:project-a/a.md', 'doc:project-b/a.md'],
  );
});

test('UI-05 切换项目不丢草稿、不清标签', () => {
  let state = workspaceReducer(multiState(), { type: 'SET_PROJECTS', projects: PROJECTS });
  state = workspaceReducer(state, {
    type: 'OPEN_TAB',
    tab: tab({ docId: 'doc:project-a/a.md', projectId: 'project-a', path: 'a.md', dirty: true, buffer: '# draft\n' }),
  });
  state = workspaceReducer(state, { type: 'SET_ACTIVE_PROJECT', projectId: 'project-b' });

  assert.equal(state.activeProjectId, 'project-b');
  assert.equal(state.tabs.length, 1, '切换项目不得清空标签');
  assert.equal(state.tabs[0].buffer, '# draft\n', '草稿必须保留');
  assert.equal(state.tabs[0].dirty, true, 'dirty 标记必须保留');
});

test('UI-15 关闭 A 标签不影响 B（含分屏窗格指向）', () => {
  let state = workspaceReducer(multiState(), { type: 'SET_PROJECTS', projects: PROJECTS });
  state = workspaceReducer(state, {
    type: 'OPEN_TAB',
    tab: tab({ docId: 'doc:project-a/a.md', projectId: 'project-a', path: 'a.md' }),
  });
  state = workspaceReducer(state, {
    type: 'OPEN_TAB',
    tab: tab({ docId: 'doc:project-b/a.md', projectId: 'project-b', path: 'a.md' }),
  });
  state = workspaceReducer(state, { type: 'SET_LAYOUT', layout: 'vertical' });
  state = workspaceReducer(state, {
    type: 'ACTIVATE_TAB',
    docId: 'doc:project-b/a.md',
  });

  state = workspaceReducer(state, { type: 'CLOSE_TAB', docId: 'doc:project-a/a.md' });
  assert.deepEqual(
    state.tabs.map((item) => item.docId),
    ['doc:project-b/a.md'],
  );
  assert.equal(state.panes.primary.docId, 'doc:project-b/a.md', '窗格不得被误指到已关闭文档');
  assert.equal(state.panes.secondary.docId, 'doc:project-b/a.md');
});

// ---------------------------------------------------------------------------
// UI-16 分屏：两个窗格可以指向不同项目的文档
// ---------------------------------------------------------------------------
test('UI-16 左右分屏可分别指向 A 与 B 的文档', () => {
  let state = workspaceReducer(multiState(), { type: 'SET_PROJECTS', projects: PROJECTS });
  state = workspaceReducer(state, {
    type: 'OPEN_TAB',
    tab: tab({ docId: 'doc:project-a/a.md', projectId: 'project-a', path: 'a.md' }),
  });
  state = workspaceReducer(state, {
    type: 'OPEN_TAB',
    tab: tab({ docId: 'doc:project-b/a.md', projectId: 'project-b', path: 'a.md' }),
  });
  state = workspaceReducer(state, { type: 'SET_LAYOUT', layout: 'vertical' });
  // 左窗格放 A、右窗格放 B：全程只用真实 action，不直接改 state
  state = workspaceReducer(state, { type: 'FOCUS_PANE', pane: 'primary' });
  state = workspaceReducer(state, { type: 'ACTIVATE_TAB', docId: 'doc:project-a/a.md' });
  state = workspaceReducer(state, { type: 'FOCUS_PANE', pane: 'secondary' });
  state = workspaceReducer(state, { type: 'ACTIVATE_TAB', docId: 'doc:project-b/a.md' });
  assert.equal(state.panes.primary.docId, 'doc:project-a/a.md');
  assert.equal(state.panes.secondary.docId, 'doc:project-b/a.md');
  assert.notEqual(state.panes.primary.docId, state.panes.secondary.docId);
});

// ---------------------------------------------------------------------------
// UI-19 重复打开同一文档不产生重复标签
// ---------------------------------------------------------------------------
test('UI-19 同一 docId 重复打开只保留一个标签', () => {
  let state = workspaceReducer(multiState(), { type: 'SET_PROJECTS', projects: PROJECTS });
  const first = tab({ docId: 'doc:project-a/a.md', projectId: 'project-a', path: 'a.md' });
  state = workspaceReducer(state, { type: 'OPEN_TAB', tab: first });
  state = workspaceReducer(state, {
    type: 'OPEN_TAB',
    tab: { ...first, sessionId: 'session-2', buffer: '# replaced\n' },
  });
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].sessionId, 'session-2');
});

// ---------------------------------------------------------------------------
// UI-14 保存结果缺 content 时不得清空缓冲
// ---------------------------------------------------------------------------
test('UI-14 SAVE_RESULT 不触碰 buffer（服务端省略 content 也不会清空草稿）', () => {
  let state = workspaceReducer(multiState(), { type: 'SET_PROJECTS', projects: PROJECTS });
  state = workspaceReducer(state, {
    type: 'OPEN_TAB',
    tab: tab({ docId: 'doc:project-a/a.md', projectId: 'project-a', path: 'a.md', dirty: true, buffer: '# draft\n' }),
  });
  state = workspaceReducer(state, {
    type: 'SAVE_RESULT',
    docId: 'doc:project-a/a.md',
    status: 'FAILED',
    errorCode: 'ERR_PROJECT_UNAVAILABLE',
    dirty: true,
    documentState: 'FAILED',
    baseVersion: 'sha256:aaa',
    revision: 1,
    notice: '项目不可用',
  });
  assert.equal(state.tabs[0].buffer, '# draft\n', 'buffer 必须保持原样');
  assert.equal(state.tabs[0].dirty, true);
  assert.equal(state.tabs[0].lastStatus, 'FAILED');
});

// ---------------------------------------------------------------------------
// UI-09 / UI-10 异步响应归属
// ---------------------------------------------------------------------------
test('UI-09 晚到的 A 响应不得写入 B（项目/文档/会话三重比对）', () => {
  const captured = { projectId: 'project-a', docId: 'doc:project-a/a.md', sessionId: 'session-a' };

  assert.equal(
    isResponseOwnerCurrent(captured, {
      projectId: 'project-a',
      docId: 'doc:project-a/a.md',
      sessionId: 'session-a',
      exists: true,
    }),
    true,
    '身份一致才允许回填',
  );
  assert.equal(
    isResponseOwnerCurrent(captured, {
      projectId: 'project-b',
      docId: 'doc:project-b/a.md',
      sessionId: 'session-b',
      exists: true,
    }),
    false,
    '切到 B 后 A 的响应必须丢弃',
  );
  assert.equal(
    isResponseOwnerCurrent(captured, {
      projectId: 'project-a',
      docId: 'doc:project-a/a.md',
      sessionId: 'session-a2',
      exists: true,
    }),
    false,
    '会话被替换（重新打开）后旧响应必须丢弃',
  );
  assert.equal(
    isResponseOwnerCurrent(captured, {
      projectId: 'project-a',
      docId: 'doc:project-a/a.md',
      sessionId: 'session-a',
      exists: false,
    }),
    false,
    '标签已关闭时必须丢弃',
  );
});

// ---------------------------------------------------------------------------
// UI-06 编辑队列身份隔离
// ---------------------------------------------------------------------------
test('UI-06 A/B 的编辑队列互不影响，且各自保持顺序', async () => {
  const applied: Array<{ target: string; text: string }> = [];
  const queueA = createEditQueue<string>(async (text) => {
    applied.push({ target: 'A', text });
    return text;
  });
  const queueB = createEditQueue<string>(async (text) => {
    applied.push({ target: 'B', text });
    return text;
  });

  queueA.schedule('a1');
  queueB.schedule('b1');
  queueA.schedule('a2');
  await queueA.flush();
  await queueB.flush();

  assert.deepEqual(
    applied.filter((item) => item.target === 'A').map((item) => item.text),
    ['a1', 'a2'],
  );
  assert.deepEqual(
    applied.filter((item) => item.target === 'B').map((item) => item.text),
    ['b1'],
  );
});

// ---------------------------------------------------------------------------
// UI-12 / UI-13 项目不可用
// ---------------------------------------------------------------------------
test('UI-12 UNAVAILABLE 项目不得再打开新文件，但其他项目不受影响', () => {
  assert.equal(isProjectOpenable(PROJECTS, 'project-a'), true);
  assert.equal(isProjectOpenable(PROJECTS, 'project-c'), false, 'UNAVAILABLE 必须阻断打开');
  assert.equal(isProjectOpenable(PROJECTS, null), true, 'Legacy/Demo 不受项目状态影响');
  assert.equal(projectLabelOf(PROJECTS, 'project-c'), '项目 C');
  assert.equal(projectLabelOf(PROJECTS, null), null);
});

// ---------------------------------------------------------------------------
// UI-20 草稿备份键隔离
// ---------------------------------------------------------------------------
test('UI-20 A/B 同名文件的草稿备份键不得冲突', () => {
  const a = draftBackupKey('project-a', 'a.md');
  const b = draftBackupKey('project-b', 'a.md');
  assert.notEqual(a, b);
  assert.equal(draftBackupKey(null, 'a.md'), 'local:a.md', 'Legacy 保留稳定键');
});
