/**
 * S11-C 系列的共享夹具（S11-C-R1 引入）。
 *
 * 与套件 30/33 同一思路：**真实 Host + 真实 reducer + 真实打开编排器**，
 * 只有"上一轮会话"是手工构造的（用序列化结果当作浏览器存储里的记录）。
 * "刷新浏览器" = 丢掉 WorkspaceState、保留 storage、重新走一遍启动恢复。
 *
 * 本夹具额外还原了 Provider 的三条装配行为，否则测不到真实风险：
 * 1. 每次状态变化都会触发一次自动保存（`autosave.schedule()` 的效果）；
 * 2. 自动保存带恢复门禁（`gate`）与结转列表（`unsavedHints` + `pendingTabs`）；
 * 3. 恢复期间的状态变化**不会**被任何"延迟调大"掩盖——定时器由测试显式推进。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShellServer } from '../../apps/server/src/server.ts';
import { createLiveClient, type WeaveSpaceClient, type WorkspaceMode } from '../../apps/shell/src/client/client-api.ts';
import { createDocumentOpener, createEditEpochs } from '../../apps/shell/src/state/open-document.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import { createLoadEpoch, loadWorkspace, type LoadEpoch } from '../../apps/shell/src/state/workspace-load.ts';
import {
  createWorkspaceRestorer,
  type RestoreReport,
} from '../../apps/shell/src/state/workspace-restore.ts';
import {
  LAST_KEY,
  createWorkspaceAutosave,
  createWorkspaceStore,
  serializeWorkspace,
  storageKeyFor,
  type PersistedTab,
  type PersistedWorkspaceV1,
  type StorageLike,
  type WorkspaceStore,
  type WriteOutcome,
} from '../../apps/shell/src/state/workspace-persistence.ts';
import { createWorkspaceWriteGate, type WorkspaceWriteGate } from '../../apps/shell/src/state/workspace-write-gate.ts';
import type { WorkspaceConfig } from '../../packages/project-registry/index.ts';
import type {
  ClientMode,
  DocTab,
  ResourceNodeState,
  WorkspaceAction,
  WorkspaceState,
} from '../../apps/shell/src/state/types.ts';

// ---------------------------------------------------------------------------
// 磁盘夹具
// ---------------------------------------------------------------------------

export interface Roots {
  base: string;
  rootA: string;
  rootB: string;
  /** 故意不创建：Multi 里它是 UNAVAILABLE。 */
  rootC: string;
  cleanup(): Promise<void>;
}

export async function makeRoots(prefix: string): Promise<Roots> {
  const base = await mkdtemp(join(tmpdir(), prefix));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  const rootC = join(base, 'project-c');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await mkdir(join(rootB, 'x'), { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'notes.md'), '# notes\n', 'utf8');
  await writeFile(join(rootA, 'n1.md'), '# n1\n', 'utf8');
  await writeFile(join(rootA, 'n2.md'), '# n2\n', 'utf8');
  await writeFile(join(rootA, 'n3.md'), '# n3\n', 'utf8');
  await writeFile(join(rootB, 'a.md'), '# B\n', 'utf8');
  await writeFile(join(rootB, 'x', 'deep.md'), '# deep\n', 'utf8');
  await writeFile(join(rootB, 'n4.md'), '# n4\n', 'utf8');
  return {
    base,
    rootA,
    rootB,
    rootC,
    async cleanup() {
      await rm(base, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** 8 个真实文件标签：(相对路径, 项目)。顺序即恢复顺序。 */
export const EIGHT_TABS: ReadonlyArray<readonly [string, string]> = [
  ['a.md', 'project-a'],
  ['docs/notes.md', 'project-a'],
  ['n1.md', 'project-a'],
  ['n2.md', 'project-a'],
  ['n3.md', 'project-a'],
  ['a.md', 'project-b'],
  ['x/deep.md', 'project-b'],
  ['n4.md', 'project-b'],
];

export type HostKind = 'multi' | 'legacy';

export interface Host {
  url: string;
  close(): Promise<void>;
}

export function multiConfig(roots: Roots): WorkspaceConfig {
  return {
    version: 1,
    projects: [
      { projectId: 'project-a', name: '项目 A', rootDir: roots.rootA },
      { projectId: 'project-b', name: '项目 B', rootDir: roots.rootB },
      // 根不存在 → UNAVAILABLE（恢复流程必须跳过它，且不得创建任何文件）
      { projectId: 'project-c', name: '项目 C', rootDir: roots.rootC },
    ],
  };
}

export async function startHost(roots: Roots, kind: HostKind): Promise<Host> {
  if (kind === 'legacy') {
    const server = await createShellServer({ rootDir: roots.rootA, port: 0 });
    return { url: server.url, close: () => server.close() };
  }
  const server = await createShellServer({ workspace: multiConfig(roots), port: 0 });
  return { url: server.url, close: () => server.close() };
}

/** 按任意项目组合启动 Host（身份测试用）。 */
export async function startConfiguredHost(config: WorkspaceConfig): Promise<Host> {
  const server = await createShellServer({ workspace: config, port: 0 });
  return { url: server.url, close: () => server.close() };
}

// ---------------------------------------------------------------------------
// 浏览器存储
// ---------------------------------------------------------------------------

export class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

// ---------------------------------------------------------------------------
// 会话夹具
// ---------------------------------------------------------------------------

export interface SeenView {
  sessionId: string;
  viewId: string;
}

export interface Call {
  name: string;
  path?: string;
  projectId?: string;
}

/** 可以被"挂起"的请求种类（S11-C-R2）：用可控 Promise 制造迟到的响应。 */
export type HoldableRequest = 'identity' | 'projects' | 'resources';

export interface Harness {
  readonly state: WorkspaceState;
  readonly opener: ReturnType<typeof createDocumentOpener>;
  readonly restorer: ReturnType<typeof createWorkspaceRestorer>;
  readonly store: WorkspaceStore;
  readonly gate: WorkspaceWriteGate;
  readonly storage: MemoryStorage;
  readonly inner: WeaveSpaceClient;
  readonly calls: Call[];
  readonly views: SeenView[];
  /** 加载代次（与 Provider 同一份实例）。 */
  readonly epoch: LoadEpoch;
  mode(): ClientMode;
  dispatch(action: WorkspaceAction): void;
  /** 模拟"上一轮会话"：连接 Host 并加载项目/资源（不触发恢复）。 */
  bootLive(): Promise<void>;
  /** 与 Provider 的 `connectWorkspace` 同构：探测 Host → 切 live → 加载工作区。 */
  connectLive(isCancelled?: () => boolean): Promise<{ workspaceKey: string | null; workspaceMode: WorkspaceMode } | null>;
  /** 与 Provider 的 `switchMode` 同构：作废旧代次 → 派发模式 → （live 时）加载。 */
  manualSwitch(mode: ClientMode): Promise<void>;
  /** 挂起第 `at` 次某类请求（1 起数）；返回放行函数。 */
  hold(kind: HoldableRequest, at: number): () => void;
  /** 挂起下一次某类请求。 */
  holdNext(kind: HoldableRequest): () => void;
  /** 该类请求已发出的次数。 */
  callCount(kind: string): number;
  /** 把当前状态写成存储记录（= 离开页面前的那次 flush）。 */
  saveSnapshot(): PersistedWorkspaceV1;
  /** 挂起第 n 次 openDocument 的响应；返回放行函数。 */
  holdOpenAt(n: number): () => void;
  /** 挂起下一次 openDocument 的响应。 */
  holdNextOpen(): () => void;
  /** 等到下一次 openDocument 真的发出去（而不是等到响应）。 */
  nextOpenStarted(): Promise<void>;
  /** 挂起下一次 /api/health 探测（模拟"连接 Host 期间"）。 */
  holdConnect(): () => void;
  setMode(mode: ClientMode): void;
  restore(): Promise<RestoreReport>;
  lastReport(): RestoreReport | null;
  /** 推进自动保存定时器（模拟 400ms 到期），返回实际执行的写入次数。 */
  advance(): number;
  flush(): WriteOutcome;
  /** 当前存储记录（经严格校验）。 */
  record(): PersistedWorkspaceV1 | null;
  /** 当前存储记录的原始字符串（用于断言"一个字节都没变"）。 */
  recordRaw(): string | null;
  /** 结转列表（与 Provider 的装配保持一致）。 */
  carryOver(): PersistedTab[];
}

export function makeHarness(url: string, storage: MemoryStorage): Harness {
  let state: WorkspaceState = { ...INITIAL_STATE };
  let mode: ClientMode = 'demo';
  let report: RestoreReport | null = null;

  const calls: Call[] = [];
  const views: SeenView[] = [];
  const inner = createLiveClient(url);
  const store = createWorkspaceStore(storage);
  const gate = createWorkspaceWriteGate();

  // 自动保存定时器由测试显式推进（不依赖真实时间）
  const timers = new Map<number, () => void>();
  let timerSeq = 0;

  let holdAt = 0;
  let openCount = 0;
  let openGate: Promise<void> | null = null;
  let releaseOpenGate: (() => void) | null = null;
  let openStarted: (() => void) | null = null;

  let connectGate: Promise<void> | null = null;
  let releaseConnectGate: (() => void) | null = null;

  /**
   * 迟到响应夹具（S11-C-R2）：把第 n 次请求钉在网络上，等测试放行。
   * 取消语义必须有"响应确实晚到"这个前提才测得到，用 sleep 制造时序不算证据。
   */
  const holds: Record<HoldableRequest, { count: number; pending: Map<number, { promise: Promise<void>; release: () => void }> }> = {
    identity: { count: 0, pending: new Map() },
    projects: { count: 0, pending: new Map() },
    resources: { count: 0, pending: new Map() },
  };

  async function passHold(kind: HoldableRequest): Promise<void> {
    const slot = holds[kind];
    slot.count += 1;
    const held = slot.pending.get(slot.count);
    if (!held) return;
    slot.pending.delete(slot.count);
    await held.promise;
  }

  function holdRequestAt(kind: HoldableRequest, at: number): () => void {
    let release: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    holds[kind].pending.set(at, { promise, release });
    return () => {
      holds[kind].pending.delete(at);
      release();
    };
  }

  const epoch = createLoadEpoch();

  const client: WeaveSpaceClient = {
    ...inner,
    async workspaceIdentity() {
      calls.push({ name: 'workspaceIdentity' });
      await passHold('identity');
      const held = connectGate;
      if (held) {
        connectGate = null;
        await held;
      }
      return inner.workspaceIdentity();
    },
    async workspaceMode() {
      calls.push({ name: 'workspaceMode' });
      return inner.workspaceMode();
    },
    async listProjects() {
      calls.push({ name: 'listProjects' });
      await passHold('projects');
      return inner.listProjects();
    },
    async listResources(projectId?: string) {
      calls.push(projectId ? { name: 'listResources', projectId } : { name: 'listResources' });
      await passHold('resources');
      return inner.listResources(projectId);
    },
    async openDocument(path: string, projectId?: string) {
      calls.push(projectId ? { name: 'openDocument', path, projectId } : { name: 'openDocument', path });
      openCount += 1;
      const mine = openCount;
      const started = openStarted;
      openStarted = null;
      started?.();
      const pending = inner.openDocument(path, projectId);
      const held = mine === holdAt ? openGate : null;
      if (held) {
        holdAt = 0;
        openGate = null;
        await held;
      }
      const outcome = await pending;
      if (outcome.document?.viewId) {
        views.push({ sessionId: outcome.document.sessionId, viewId: outcome.document.viewId });
      }
      return outcome;
    },
    async readDocument(sessionId: string, viewId?: string | null) {
      calls.push({ name: 'readDocument' });
      return inner.readDocument(sessionId, viewId);
    },
    async applyEdit(sessionId: string, buffer: string, expected?: string | null, viewId?: string | null) {
      calls.push({ name: 'applyEdit' });
      return inner.applyEdit(sessionId, buffer, expected, viewId);
    },
    async saveDocument(sessionId: string, expected: string, viewId?: string | null) {
      calls.push({ name: 'saveDocument' });
      return inner.saveDocument(sessionId, expected, viewId);
    },
    async closeDocument(sessionId: string, viewId: string) {
      calls.push({ name: 'closeDocument' });
      return inner.closeDocument(sessionId, viewId);
    },
    async readDisk(sessionId: string, viewId?: string | null) {
      calls.push({ name: 'readDisk' });
      return inner.readDisk(sessionId, viewId);
    },
    async reloadDocument(sessionId: string, viewId: string) {
      calls.push({ name: 'reloadDocument' });
      return inner.reloadDocument(sessionId, viewId);
    },
  };

  const clientFor = (target: ClientMode): WeaveSpaceClient => {
    if (target !== 'live') throw new Error(`测试不应使用 ${target} 客户端`);
    return client;
  };

  /** 与 Provider 一致：状态落地后立刻安排一次（被门禁拦住时 no-op）。 */
  const dispatch = (action: WorkspaceAction): void => {
    state = workspaceReducer(state, action);
    autosave.schedule();
  };

  const opener = createDocumentOpener({
    getState: () => state,
    getMode: () => mode,
    dispatch,
    clientFor,
    editEpochs: createEditEpochs(),
  });

  /** 与 Provider 一致：未确认内容提示 + 恢复中断时未处理的标签。 */
  function carryOver(): PersistedTab[] {
    return [...restorer.unsavedHints(), ...restorer.pendingTabs()];
  }

  const autosave = createWorkspaceAutosave({
    store,
    gate,
    snapshot: () =>
      serializeWorkspace(state, {
        workspaceKey: state.workspaceKey,
        carryOver: carryOver(),
      }),
    setTimer: (fn) => {
      timerSeq += 1;
      timers.set(timerSeq, fn);
      return timerSeq;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });

  /**
   * 与 Provider 的 `connectWorkspace` 同构（S11-C-R2）：
   * 每次连接独占一个加载代次，任何一次主动切换都会让本代结果作废。
   */
  async function connectLive(
    isCancelled: () => boolean = () => false,
  ): Promise<{ workspaceKey: string | null; workspaceMode: WorkspaceMode } | null> {
    const cancelledByEpoch = epoch.start();
    const cancelled = () => isCancelled() || cancelledByEpoch();
    // 先探测 Host：连不上就**不要**把界面切进 live
    const probe = await client.workspaceIdentity().catch(() => null);
    if (cancelled()) return null;
    if (!probe) return null;
    if (mode !== 'live') {
      // 与 Provider 的 switchMode 顺序一致：先同步模式，再派发
      mode = 'live';
      dispatch({ type: 'SET_MODE', mode: 'live' });
    }
    const loaded = await loadWorkspace({
      getState: () => state,
      dispatch,
      clientFor,
      isCancelled: cancelled,
    });
    // 加载期间用户接管了：结果不属于当前工作区，交出 null 让恢复流程收手
    if (cancelled()) return null;
    return loaded ? { workspaceKey: loaded.workspaceKey, workspaceMode: loaded.workspaceMode } : null;
  }

  const restorer = createWorkspaceRestorer({
    getState: () => state,
    getMode: () => mode,
    dispatch,
    store,
    gate,
    connectLive,
    openInBackground: (node, projectId) => opener.openNode(node, projectId, { background: true }),
    onSettled: () => autosave.schedule(),
  });

  /** 与 Provider 的 `switchMode` 的派发部分同构。 */
  function applyModeChange(next: ClientMode): void {
    mode = next;
    restorer.noteInteraction();
    gate.adopt();
    dispatch({ type: 'SET_MODE', mode: next });
    // 上一个工作区的"加载中"标记不属于新工作区：切走时在这里收掉
    if (next !== 'live') dispatch({ type: 'SET_LOADING_RESOURCES', loading: false });
  }

  /**
   * 用户主动切换模式（与 Provider 的 `switchMode` 同构）：
   * 先作废上一代加载，再派发模式；切到 live 时用新代次加载。
   */
  async function manualSwitch(next: ClientMode): Promise<void> {
    if (next === mode) return;
    // 用户一旦要求切换，所有在途加载立即失效（包括正在等待响应的那些）
    epoch.cancel();
    applyModeChange(next);
    if (next !== 'live') return;
    const cancelled = epoch.start();
    await loadWorkspace({ getState: () => state, dispatch, clientFor, isCancelled: cancelled });
  }

  const holdOpenAt = (n: number): (() => void) => {
    holdAt = n;
    openGate = new Promise<void>((resolve) => {
      releaseOpenGate = resolve;
    });
    return () => {
      holdAt = 0;
      openGate = null;
      releaseOpenGate?.();
      releaseOpenGate = null;
    };
  };

  return {
    get state() {
      return state;
    },
    opener,
    restorer,
    store,
    gate,
    storage,
    inner,
    calls,
    views,
    epoch,
    mode: () => mode,
    dispatch,
    connectLive,
    manualSwitch,
    hold: holdRequestAt,
    holdNext: (kind: HoldableRequest) => holdRequestAt(kind, holds[kind].count + 1),
    callCount: (kind: string) => calls.filter((call) => call.name === kind).length,
    async bootLive() {
      mode = 'live';
      dispatch({ type: 'SET_MODE', mode: 'live' });
      const loaded = await loadWorkspace({ getState: () => state, dispatch, clientFor });
      assert.ok(loaded, '夹具前提：Host 必须可连接');
    },
    saveSnapshot() {
      const snapshot = serializeWorkspace(state, {
        workspaceKey: state.workspaceKey,
        carryOver: carryOver(),
      });
      assert.ok(snapshot, '夹具前提：live 且身份已知时必须能序列化');
      assert.equal(store.write(snapshot), 'written');
      return snapshot;
    },
    holdOpenAt,
    holdNextOpen: () => holdOpenAt(openCount + 1),
    nextOpenStarted() {
      return new Promise<void>((resolve) => {
        openStarted = resolve;
      });
    },
    holdConnect() {
      connectGate = new Promise<void>((resolve) => {
        releaseConnectGate = resolve;
      });
      return () => {
        connectGate = null;
        releaseConnectGate?.();
        releaseConnectGate = null;
      };
    },
    setMode(next) {
      // 与 Provider 的 switchMode 一致：作废旧代次 + 同步模式镜像 + 派发 + 接管恢复
      epoch.cancel();
      applyModeChange(next);
    },
    restore() {
      return restorer.restore().then((value) => {
        report = value;
        return value;
      });
    },
    lastReport() {
      return report;
    },
    advance() {
      const pending = [...timers.values()];
      timers.clear();
      for (const fn of pending) fn();
      return pending.length;
    },
    flush() {
      return autosave.flush();
    },
    record() {
      return store.readLast();
    },
    recordRaw() {
      const pointer = storage.getItem(LAST_KEY);
      if (!pointer) return null;
      const parsed = JSON.parse(pointer) as { workspaceKey?: string };
      if (!parsed.workspaceKey) return null;
      return storage.getItem(storageKeyFor(parsed.workspaceKey));
    },
    carryOver,
  };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 等到条件成立（只用于"异步流程走到某个中间态"）。
 *
 * 不用固定 sleep：轮询 5ms，最多 1s，条件一成立立刻返回——既确定又不会拖慢套件。
 */
export async function waitFor(predicate: () => boolean, message = '条件未在预期时间内成立'): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

export function nodeOf(path: string, projectId: string | null): ResourceNodeState {
  const id = projectId ? `doc:${projectId}/${path}` : `doc:${path}`;
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return {
    id,
    name,
    kind: 'file',
    extension: dot > 0 ? name.slice(dot).toLowerCase() : '',
    path,
  };
}

export function tabOf(overrides: Partial<DocTab> & Pick<DocTab, 'docId' | 'path'>): DocTab {
  return {
    projectId: null,
    title: overrides.path,
    extension: '.md',
    buffer: '# x\n',
    dirty: false,
    mode: 'live',
    sessionId: 'session-x',
    viewId: 'view-x',
    baseVersion: 'sha256:x',
    revision: 1,
    documentState: 'CLEAN',
    saving: false,
    lastStatus: null,
    errorCode: null,
    ...overrides,
  };
}

export function paneDocId(h: Harness): string | null {
  return h.state.panes[h.state.focusedPane]?.docId ?? null;
}

export async function viewAccepted(h: Harness, view: SeenView): Promise<boolean> {
  const outcome = await h.inner.readDocument(view.sessionId, view.viewId);
  return outcome.status === 'APPLIED';
}

/** 打开 8 个文件并写入记录（AS-01 的前提）。 */
export async function seedEightTabs(h: Harness): Promise<PersistedWorkspaceV1> {
  for (const [path, projectId] of EIGHT_TABS) {
    const outcome = await h.opener.openNode(nodeOf(path, projectId), projectId);
    assert.equal(outcome.ok, true, `夹具前提：${projectId}/${path} 必须能打开`);
  }
  const snapshot = h.saveSnapshot();
  assert.equal(snapshot.tabs.length, EIGHT_TABS.length, '夹具前提：记录里应有 8 个标签');
  return snapshot;
}
