/**
 * S11-C 持久化契约（PC-01…PC-06、PC-24 + 路径白名单 + 离开页防护）。
 *
 * 这组用例只测**契约本身**：序列化白名单、严格校验、存储不可用时的降级、
 * 以及"旧 Session/View 不能成为恢复凭据"。恢复的完整调用链在套件 33。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installBeforeUnloadGuard, needsLeaveGuard } from '../../apps/shell/src/state/beforeunload-guard.ts';
import { INITIAL_STATE } from '../../apps/shell/src/state/workspace-reducer.ts';
import type { DocTab, WorkspaceState } from '../../apps/shell/src/state/types.ts';
import {
  LAST_KEY,
  MAX_TABS,
  PERSIST_VERSION,
  createWorkspaceAutosave,
  createWorkspaceStore,
  decodeSnapshot,
  encodeSnapshot,
  isSafeRelativePath,
  pruneExpanded,
  readLastSnapshot,
  readSnapshot,
  serializeWorkspace,
  storageKeyFor,
  validateSnapshot,
  type PersistedWorkspaceV1,
  type StorageLike,
  type WorkspaceStore,
} from '../../apps/shell/src/state/workspace-persistence.ts';

const KEY = 'a'.repeat(16) + '0123456789abcdef';

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
    baseVersion: 'sha256:aaaa',
    revision: 3,
    documentState: 'CLEAN',
    saving: false,
    lastStatus: null,
    errorCode: null,
    ...overrides,
  };
}

function makeState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    ...INITIAL_STATE,
    mode: 'live',
    workspaceMode: 'multi',
    workspaceKey: KEY,
    projects: [
      { projectId: 'project-a', name: '项目 A', status: 'READY' },
      { projectId: 'project-b', name: '项目 B', status: 'READY' },
    ],
    activeProjectId: 'project-a',
    notice: '',
    ...overrides,
  };
}

function baseState(): WorkspaceState {
  return makeState({
    navCollapsed: true,
    navKey: 'diagnostics',
    treeCollapsed: false,
    auxCollapsed: false,
    auxTab: 'tasks',
    layout: 'vertical',
    splitRatio: 63,
    focusedPane: 'secondary',
    expandedByProject: {
      'project-a': { 'dir:project-a/docs': true, 'dir:project-a/gone': false },
      'project-c': { 'dir:project-c/x': true },
    },
    tabs: [
      tab({ docId: 'doc:project-a/a.md', projectId: 'project-a', path: 'a.md' }),
      tab({
        docId: 'doc:project-a/docs/notes.md',
        projectId: 'project-a',
        path: 'docs/notes.md',
        dirty: true,
        documentState: 'EDITING_DIRTY',
        buffer: '# 未保存草稿正文\n',
        sessionId: 'session-secret',
        viewId: 'view-secret',
      }),
      tab({ docId: 'doc:project-b/a.md', projectId: 'project-b', path: 'a.md', saving: true }),
      // demo 标签不应进入记录
      tab({ docId: 'demo.md', projectId: null, path: 'demo.md', mode: 'demo', sessionId: null, viewId: null }),
    ],
    panes: {
      primary: { docId: 'doc:project-a/a.md', mode: 'editor' },
      secondary: { docId: 'doc:project-a/docs/notes.md', mode: 'preview' },
    },
  });
}

/** 递归收集 JSON 里出现过的所有键名。 */
function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, out);
  } else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out.add(key);
      allKeys(inner, out);
    }
  }
  return out;
}

/** 内存 Storage；可配置在哪个操作上抛错（模拟隐私模式 / Quota）。 */
class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  failOn: 'get' | 'set' | 'remove' | null = null;
  error: unknown = new Error('boom');
  getItem(key: string): string | null {
    if (this.failOn === 'get') throw this.error;
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failOn === 'set') throw this.error;
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    if (this.failOn === 'remove') throw this.error;
    this.map.delete(key);
  }
}

// ---------------------------------------------------------------------------
// PC-01 序列化只包含白名单字段
// ---------------------------------------------------------------------------
test('PC-01 快照只包含白名单字段（没有额外字段、没有运行期身份）', () => {
  const snapshot = serializeWorkspace(baseState(), { workspaceKey: KEY });
  assert.ok(snapshot, '有工作区身份时必须能序列化');

  assert.deepEqual(
    Object.keys(snapshot).sort(),
    ['activeProjectId', 'expandedByProject', 'panes', 'savedAt', 'tabs', 'ui', 'version', 'workspaceKey'],
  );
  assert.deepEqual(
    Object.keys(snapshot.ui).sort(),
    [
      'auxCollapsed',
      'auxTab',
      'focusedPane',
      'layout',
      'navCollapsed',
      'navKey',
      'splitRatio',
      'treeCollapsed',
    ],
  );
  assert.deepEqual(Object.keys(snapshot.tabs[0]).sort(), ['hadUnsavedChanges', 'mode', 'path', 'projectId']);
  assert.deepEqual(Object.keys(snapshot.panes.primary).sort(), ['mode', 'tabIndex']);

  // 递归白名单：任何禁止出现的键都视为契约破坏
  const forbidden = new Set([
    'buffer',
    'content',
    'sessionId',
    'viewId',
    'baseVersion',
    'revision',
    'documentState',
    'saving',
    'lastStatus',
    'errorCode',
    'docId',
    'rootDir',
    'canonicalRoot',
    'rootToken',
    'providerId',
    'resources',
    'resourcesByProject',
    'quickFile',
  ]);
  for (const key of allKeys(JSON.parse(JSON.stringify(snapshot)))) {
    assert.equal(forbidden.has(key), false, `快照里不得出现运行期字段: ${key}`);
  }

  assert.equal(snapshot.version, PERSIST_VERSION);
  assert.equal(snapshot.tabs.length, 3, 'demo 标签必须被丢弃，真实文件全部保留');
  assert.equal(snapshot.tabs[0].mode, 'live');
  assert.equal(snapshot.tabs[1].hadUnsavedChanges, true, 'dirty 只记录为"存在未确认内容"');
  assert.equal(snapshot.tabs[1].path, 'docs/notes.md');
  assert.equal(snapshot.tabs[2].hadUnsavedChanges, true, '保存中也算未确认内容');
});

// ---------------------------------------------------------------------------
// PC-02 不存正文、Session/View、根路径
// ---------------------------------------------------------------------------
test('PC-02 正文、Session/View、根路径都不得进入存储', () => {
  const state = baseState();
  const snapshot = serializeWorkspace(state, { workspaceKey: KEY });
  const json = encodeSnapshot(snapshot as PersistedWorkspaceV1);

  assert.equal(json.includes('未保存草稿正文'), false, '正文不得落盘');
  assert.equal(json.includes('session-secret'), false, 'sessionId 不得落盘');
  assert.equal(json.includes('view-secret'), false, 'viewId 不得落盘');
  assert.equal(json.includes('sha256:aaaa'), false, 'baseVersion 不得落盘');
  assert.equal(json.includes('C:\\'), false);
  assert.equal(json.includes('/home/'), false);
  assert.equal(json.length < 64 * 1024, true, '快照体积必须受控');

  // revision 只可能是 tabIndex 之类的整数，不能出现运行期 revision 字段
  assert.equal(/"revision"/.test(json), false);
  // 草稿只以布尔提示存在
  assert.equal(snapshot?.tabs[1].hadUnsavedChanges, true);
});

// ---------------------------------------------------------------------------
// PC-03 V1 快照有效解析（round-trip 不丢字段）
// ---------------------------------------------------------------------------
test('PC-03 有效 V1 快照可以完整往返解析', () => {
  const snapshot = serializeWorkspace(baseState(), { workspaceKey: KEY }) as PersistedWorkspaceV1;
  const parsed = decodeSnapshot(encodeSnapshot(snapshot));
  assert.ok(parsed);
  assert.deepEqual(parsed, snapshot, '往返不得丢字段或改变类型');
  assert.equal(parsed.panes.primary.tabIndex, 0);
  assert.equal(parsed.panes.secondary.tabIndex, 1);
  assert.equal(parsed.panes.secondary.mode, 'preview');
  assert.equal(parsed.expandedByProject['project-a']['dir:project-a/docs'], true);
  assert.equal(
    parsed.expandedByProject['project-c'],
    undefined,
    '不属于当前项目表的展开状态不写入',
  );
});

// ---------------------------------------------------------------------------
// PC-04 版本不匹配安全降级
// ---------------------------------------------------------------------------
test('PC-04 版本/时间/枚举不合法时整体丢弃（不修补、不猜测）', () => {
  const snapshot = serializeWorkspace(baseState(), { workspaceKey: KEY }) as PersistedWorkspaceV1;

  assert.equal(validateSnapshot({ ...snapshot, version: 2 }), null, '未知版本必须拒绝');
  assert.equal(validateSnapshot({ ...snapshot, version: '1' }), null, '版本必须是数字');
  assert.equal(validateSnapshot({ ...snapshot, savedAt: 'not-a-date' }), null);
  assert.equal(validateSnapshot({ ...snapshot, workspaceKey: '' }), null);
  assert.equal(validateSnapshot({ ...snapshot, tabs: 'nope' }), null);
  assert.equal(validateSnapshot({ ...snapshot, tabs: new Array(MAX_TABS + 1).fill(snapshot.tabs[0]) }), null);
  assert.equal(
    validateSnapshot({ ...snapshot, ui: { ...snapshot.ui, navKey: 'hacked' } }),
    null,
    '枚举越界必须拒绝',
  );
  assert.equal(
    validateSnapshot({ ...snapshot, ui: { ...snapshot.ui, splitRatio: 5 } }),
    null,
    '比例越界必须拒绝而不是悄悄夹紧',
  );
  assert.equal(
    validateSnapshot({ ...snapshot, panes: { primary: { tabIndex: 99, mode: 'editor' }, secondary: { tabIndex: null, mode: 'preview' } } }),
    null,
    'tabIndex 越界必须拒绝',
  );
  assert.equal(
    validateSnapshot({ ...snapshot, tabs: [{ projectId: 'project-a', path: '../../etc/passwd', mode: 'live', hadUnsavedChanges: false }] }),
    null,
    '绝对/越界路径必须拒绝',
  );
  assert.ok(validateSnapshot(snapshot), '原快照仍然有效');
});

// ---------------------------------------------------------------------------
// PC-05 损坏 JSON 不影响工作区启动
// ---------------------------------------------------------------------------
test('PC-05 损坏的 JSON / 非对象 / 超长内容一律视为没有记录', () => {
  assert.equal(decodeSnapshot(null), null);
  assert.equal(decodeSnapshot(''), null);
  assert.equal(decodeSnapshot('{oops'), null);
  assert.equal(decodeSnapshot('null'), null);
  assert.equal(decodeSnapshot('[]'), null);
  assert.equal(decodeSnapshot('"str"'), null);
  assert.equal(decodeSnapshot('{"version":1}'), null);
  assert.equal(decodeSnapshot('x'.repeat(64 * 1024 + 1)), null, '超长内容在解析前就被拒绝');

  const storage = new MemoryStorage();
  storage.map.set(LAST_KEY, '{broken');
  assert.equal(readLastSnapshot(storage), null, '损坏的指针不得让启动流程抛错');
  assert.equal(readSnapshot(storage, KEY), null);
  assert.deepEqual([...storage.map.keys()], [LAST_KEY], '读取过程不得写入任何东西');
});

// ---------------------------------------------------------------------------
// PC-06 localStorage 不可用不影响编辑
// ---------------------------------------------------------------------------
test('PC-06 存储不可用/配额满时只降级，不抛错、不影响编辑', () => {
  const snapshot = serializeWorkspace(baseState(), { workspaceKey: KEY }) as PersistedWorkspaceV1;

  const quota = new MemoryStorage();
  quota.failOn = 'set';
  quota.error = Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
  const quotaStore = createWorkspaceStore(quota);
  assert.equal(quotaStore.write(snapshot), 'quota');

  const blocked = new MemoryStorage();
  blocked.failOn = 'set';
  blocked.error = Object.assign(new Error('denied'), { name: 'SecurityError' });
  const blockedStore = createWorkspaceStore(blocked);
  assert.equal(blockedStore.write(snapshot), 'unavailable');

  const noRead = new MemoryStorage();
  noRead.failOn = 'get';
  const noReadStore = createWorkspaceStore(noRead);
  assert.equal(noReadStore.read(KEY), null, '读取失败必须回落到"没有记录"');
  assert.equal(noReadStore.readLast(), null);

  const noRemove = new MemoryStorage();
  noRemove.failOn = 'remove';
  assert.doesNotThrow(() => createWorkspaceStore(noRemove).clear(KEY));

  // 完全没有 Storage（SSR / 隐私模式禁用到对象都不给）
  const nullStore = createWorkspaceStore(null);
  assert.equal(nullStore.write(snapshot), 'unavailable');
  assert.equal(nullStore.read(KEY), null);
  assert.doesNotThrow(() => nullStore.clear(KEY));

  // 写入成功时同时更新"上一次工作区"指针，且指针里没有路径
  const ok = new MemoryStorage();
  const okStore = createWorkspaceStore(ok);
  assert.equal(okStore.write(snapshot), 'written');
  assert.ok(ok.map.get(storageKeyFor(KEY)));
  const pointer = ok.map.get(LAST_KEY) as string;
  assert.equal(pointer.includes('project-a'), false, '指针只放摘要与时间');
  assert.deepEqual(okStore.readLast(), snapshot);
});

// ---------------------------------------------------------------------------
// PC-24 旧 Session/View ID 不能作为恢复凭据
// ---------------------------------------------------------------------------
test('PC-24 快照里手工塞入 sessionId/viewId 也不会被接受为恢复凭据', () => {
  const snapshot = serializeWorkspace(baseState(), { workspaceKey: KEY }) as PersistedWorkspaceV1;
  const tampered = {
    ...snapshot,
    tabs: snapshot.tabs.map((item) => ({ ...item, sessionId: 'session-old', viewId: 'view-old' })),
  };
  const parsed = validateSnapshot(tampered);
  assert.ok(parsed, '额外的未知字段不影响可恢复性');
  assert.deepEqual(
    Object.keys(parsed.tabs[0]).sort(),
    ['hadUnsavedChanges', 'mode', 'path', 'projectId'],
    '运行期身份必须被剥离，绝不能原样带进恢复流程',
  );
  assert.equal(encodeSnapshot(parsed).includes('session-old'), false);
  assert.equal(encodeSnapshot(parsed).includes('view-old'), false);
});

// ---------------------------------------------------------------------------
// 路径白名单
// ---------------------------------------------------------------------------
test('PC-01b 只接受项目内相对路径（绝对路径/盘符/.. 一律拒绝）', () => {
  for (const good of ['a.md', 'docs/a.md', 'a/b/c.txt', '中文 目录/文件.md']) {
    assert.equal(isSafeRelativePath(good), true, `应接受: ${good}`);
  }
  for (const bad of ['', '/abs/a.md', 'C:/x/a.md', 'c:x.md', 'a\\b.md', '../a.md', 'a/../../b', './a.md', 'a//b.md', 'a/\u0000b', 'x'.repeat(600)]) {
    assert.equal(isSafeRelativePath(bad), false, `应拒绝: ${bad}`);
  }
});

// ---------------------------------------------------------------------------
// 展开状态裁剪
// ---------------------------------------------------------------------------
test('PC-08a 展开状态只保留当前树里存在的目录', () => {
  const pruned = pruneExpanded(
    { 'dir:project-a/docs': true, 'dir:project-a/gone': true, 'dir:project-a/x': false },
    new Set(['dir:project-a/docs', 'dir:project-a/x']),
  );
  assert.deepEqual(pruned, { 'dir:project-a/docs': true, 'dir:project-a/x': false });
});

// ---------------------------------------------------------------------------
// 写入节流
// ---------------------------------------------------------------------------
test('PC-06b 高频变化合并写入，flush 立即落盘（不依赖异步定时器）', () => {
  const storage = new MemoryStorage();
  const store = createWorkspaceStore(storage);
  const snapshot = serializeWorkspace(baseState(), { workspaceKey: KEY }) as PersistedWorkspaceV1;

  const timers = new Map<number, () => void>();
  let next = 1;
  const autosave = createWorkspaceAutosave({
    store,
    snapshot: () => snapshot,
    delayMs: 50,
    setTimer: (fn) => {
      const handle = next++;
      timers.set(handle, fn);
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });

  autosave.schedule();
  autosave.schedule();
  autosave.schedule();
  assert.equal(timers.size, 1, '多次 schedule 只保留一个未决定时器');
  assert.equal(storage.map.size, 0, '定时器未触发前不写入');

  for (const fn of [...timers.values()]) fn();
  timers.clear();
  assert.equal(storage.map.size, 2, '一次写入 = 记录 + 指针');

  // 退出页面时必须能同步落盘（不依赖定时器真的被触发）
  storage.map.clear();
  timers.clear();
  autosave.schedule();
  assert.equal(autosave.flush(), 'written');
  assert.equal(timers.size, 0, 'flush 必须取消未决定的写入');
  assert.equal(storage.map.size, 2);

  autosave.dispose();
  autosave.schedule();
  assert.equal(timers.size, 0, 'dispose 之后不再安排写入');
});

test('PC-06c 快照返回 null（未连接工作区）时 autosave 不写任何东西', () => {
  const storage = new MemoryStorage();
  const timers = new Map<number, () => void>();
  const autosave = createWorkspaceAutosave({
    store: createWorkspaceStore(storage),
    snapshot: () => null,
    setTimer: (fn) => {
      const handle = timers.size + 1;
      timers.set(handle, fn);
      return handle;
    },
    clearTimer: () => undefined,
  });
  assert.equal(autosave.flush(), 'skipped');
  assert.equal(storage.map.size, 0);
});

// ---------------------------------------------------------------------------
// PC-18 离开页草稿防护
// ---------------------------------------------------------------------------
test('PC-18 有未确认内容时才挂 beforeunload 防护（且只提示，不假装保存）', () => {
  assert.equal(needsLeaveGuard([tab({ docId: 'a', path: 'a.md', dirty: false })]), false);
  assert.equal(needsLeaveGuard([tab({ docId: 'a', path: 'a.md', dirty: true })]), true);
  assert.equal(
    needsLeaveGuard([tab({ docId: 'a', path: 'a.md', dirty: false, saving: true })]),
    true,
    '保存中同样有丢失风险',
  );
  assert.equal(
    needsLeaveGuard([tab({ docId: 'a', path: 'a.md', dirty: false, documentState: 'OUTCOME_UNKNOWN' })]),
    true,
    '结果未知必须拦',
  );
  assert.equal(
    needsLeaveGuard([tab({ docId: 'a', path: 'a.md', dirty: false, documentState: 'SAVING' })]),
    true,
  );
  assert.equal(needsLeaveGuard([]), false);

  const listeners: Array<(event: { preventDefault(): void; returnValue: unknown }) => void> = [];
  const target = {
    addEventListener: (_type: 'beforeunload', listener: (event: never) => void) => {
      listeners.push(listener as unknown as (event: { preventDefault(): void; returnValue: unknown }) => void);
    },
    removeEventListener: () => {
      listeners.pop();
    },
  };

  let atRisk = false;
  const uninstall = installBeforeUnloadGuard(target as never, () => atRisk);
  assert.equal(listeners.length, 1);

  const clean = { prevented: false, preventDefault() { this.prevented = true; }, returnValue: '' };
  listeners[0](clean as never);
  assert.equal(clean.prevented, false, '干净状态不得弹离开提醒');

  atRisk = true;
  const dirty = { prevented: false, preventDefault() { this.prevented = true; }, returnValue: '' };
  listeners[0](dirty as never);
  assert.equal(dirty.prevented, true, '有未确认内容时必须拦截');
  assert.equal(dirty.returnValue, '');

  uninstall();
  assert.equal(listeners.length, 0);
});

// ---------------------------------------------------------------------------
// 没有工作区身份时不写记录（demo / Host 未连接）
// ---------------------------------------------------------------------------
test('PC-09a 没有工作区摘要或处于 demo 时拒绝写入记录', () => {
  assert.equal(serializeWorkspace(makeState({ mode: 'demo' }), { workspaceKey: KEY }), null);
  assert.equal(serializeWorkspace(makeState(), { workspaceKey: null }), null);
  assert.equal(serializeWorkspace(makeState(), { workspaceKey: 'short' }), null);
});

test('PC-09b 记录按工作区摘要隔离，读不到别的摘要的记录', () => {
  const storage = new MemoryStorage();
  const store: WorkspaceStore = createWorkspaceStore(storage);
  const snapshot = serializeWorkspace(baseState(), { workspaceKey: KEY }) as PersistedWorkspaceV1;
  assert.equal(store.write(snapshot), 'written');

  const other = 'b'.repeat(16) + '0123456789abcdef';
  assert.equal(store.read(other), null, '不同工作区不得读到彼此记录');
  assert.equal(store.read(KEY)?.workspaceKey, KEY);
  assert.equal(storage.map.has(storageKeyFor(other)), false);
});
