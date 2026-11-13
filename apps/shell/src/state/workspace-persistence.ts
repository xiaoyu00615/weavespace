/**
 * 工作区持久化契约（S11-C）。
 *
 * 只保存"重建界面所需的元数据"，**不保存工作区的运行时状态**：
 * - 不存正文、不存 `sessionId` / `viewId`、不存 `baseVersion` / `revision`
 *   （Core 的版本与会话不能从浏览器存储里恢复，只能重新 open 取得）；
 * - 不存 `rootDir` / `canonicalRoot` / `rootToken`（G0/G1 的根安全与权限边界）；
 * - 不存 Provider、权限、浏览器 `File`、编辑队列、保存锁、在途请求；
 * - 不存 Quick File 的任何内容（S11-B 明确不做持久化）。
 *
 * 结构带显式版本号 + 白名单 + 体积/数量上限，任何一项不满足都**整体丢弃**
 * （fail-closed：宁可回到空工作区，也不用来路不明的记录去发文件请求）。
 *
 * 本模块是纯 TS：`storage` 通过接口注入，测试可以用 Map 或"会抛异常的 Storage"
 * 驱动，不需要真实浏览器。
 */
import type {
  AuxTab,
  LayoutMode,
  NavKey,
  PaneId,
  ViewMode,
  WorkspaceState,
  WorkspaceUiSnapshot,
} from './types.ts';

export const PERSIST_VERSION = 1 as const;
/** 命名空间：`ws:workspace:v1:<record|last>`。 */
export const STORAGE_PREFIX = 'ws:workspace:v1:';
/** "上一次使用的工作区"指针（只含摘要与时间，不含任何路径）。 */
export const LAST_KEY = `${STORAGE_PREFIX}last`;

/** 上限：防止损坏的存储把启动流程拖进大量请求。 */
export const MAX_TABS = 24;
export const MAX_PROJECTS = 16;
export const MAX_EXPANDED_PER_PROJECT = 200;
export const MAX_PATH_LENGTH = 512;
export const MAX_ID_LENGTH = 256;
export const MAX_SNAPSHOT_BYTES = 64 * 1024;

const NAV_KEYS: readonly NavKey[] = ['projects', 'plugins', 'diagnostics'];
const AUX_TABS: readonly AuxTab[] = ['ai', 'tasks', 'diagnostics'];
const LAYOUTS: readonly LayoutMode[] = ['single', 'vertical'];
const PANE_IDS: readonly PaneId[] = ['primary', 'secondary'];
const VIEW_MODES: readonly ViewMode[] = ['editor', 'preview'];

/** 可存储的 UI 局部（阶段 A：不需要任何会话即可恢复）。 */
export type PersistedUi = WorkspaceUiSnapshot;

/**
 * 一个可恢复的标签：只有"哪些文件曾经打开过"这一事实。
 *
 * `mode` 恒为 `live`：demo 标签不写盘、也不该在下次启动时被"恢复"。
 * `projectId` 为 null 表示 Legacy（单项目工作区没有项目身份）。
 * `hadUnsavedChanges` 是**提示元数据**，不是草稿：下次启动绝不能据此宣称内容已恢复。
 */
export interface PersistedTab {
  projectId: string | null;
  path: string;
  mode: 'live';
  hadUnsavedChanges: boolean;
}

/** 窗格指向：用标签下标而不是 docId，避免把运行期身份写进存储。 */
export interface PersistedPane {
  tabIndex: number | null;
  mode: ViewMode;
}

export interface PersistedWorkspaceV1 {
  version: typeof PERSIST_VERSION;
  /** Host 计算的工作区摘要；只在摘要一致时允许恢复文件标签。 */
  workspaceKey: string;
  savedAt: string;
  ui: PersistedUi;
  activeProjectId: string | null;
  expandedByProject: Record<string, Record<string, boolean>>;
  tabs: PersistedTab[];
  panes: { primary: PersistedPane; secondary: PersistedPane };
}

/** 浏览器 Storage 的最小接口（`localStorage` 满足；测试可注入任何实现）。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * 写入结果。
 *
 * `held` / `sealed`（S11-C-R1）表示"被恢复门禁拦住，**没有触碰存储**"：
 * 这不是失败，更不是成功——调用方不得据此宣称记录已保存。
 */
export type WriteOutcome = 'written' | 'skipped' | 'unavailable' | 'quota' | 'held';

// ---------------------------------------------------------------------------
// 路径 / 标识校验
// ---------------------------------------------------------------------------

/**
 * 只接受"项目内的相对路径"。
 *
 * 拒绝：绝对路径、盘符、UNC、`..`、空段、NUL、反斜杠（服务端一律用 `/`）。
 * 这条校验是恢复流程的第一道闸门：即使存储被手工篡改，也不会把
 * `../../secret` 之类的路径送去 Host。
 */
export function isSafeRelativePath(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  if (path.includes('\u0000') || path.includes('\\')) return false;
  if (path.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  const segments = path.split('/');
  if (segments.length > 32) return false;
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function isProjectId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_ID_LENGTH) return false;
  return isSafeRelativePath(value) && !value.includes('/');
}

function isWorkspaceKey(value: unknown): value is string {
  // Host 生成的是 SHA-256 hex；这里只要求"像摘要"，不接受空串或超长值
  return typeof value === 'string' && /^[0-9a-zA-Z_-]{16,128}$/.test(value);
}

/**
 * 比例校验：**只接受合法区间内的整数**。
 * 越界值不做"夹紧"处理——那等于悄悄修补一份来路不明的记录，
 * 恢复流程只需要一个明确结论：这份记录能不能用。
 */
function validateRatio(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 25 || value > 75) return null;
  return value;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

// ---------------------------------------------------------------------------
// 序列化（白名单）
// ---------------------------------------------------------------------------

export interface SerializeOptions {
  /** 当前 Host 的工作区摘要；为 null（demo / 未连接）时不写记录。 */
  workspaceKey: string | null;
  /**
   * 结转的标签（S11-C-R1）。
   *
   * 两个来源，都不属于"当前界面"，但都**不能被这次写入抹掉**：
   * - 未自动重开的未确认内容标签（DR-03）：在用户明确处理前保留提示；
   * - 恢复被中断时还没处理完的标签（AS-05）：接管后的提交必须合并而不是替换。
   *
   * 已经以"当前标签"形式存在的（同一项目 + 同一路径）会被跳过——用户自己打开了它，
   * 提示就已经被处理掉了。
   */
  carryOver?: readonly PersistedTab[];
  now?: () => Date;
}

function expandedWhitelist(state: WorkspaceState): Record<string, Record<string, boolean>> {
  const projectIds = new Set(state.projects.map((project) => project.projectId).slice(0, MAX_PROJECTS));
  const out: Record<string, Record<string, boolean>> = {};
  for (const [projectId, entries] of Object.entries(state.expandedByProject ?? {})) {
    if (!isProjectId(projectId) || !projectIds.has(projectId)) continue;
    const picked: Record<string, boolean> = {};
    let count = 0;
    for (const [key, value] of Object.entries(entries ?? {})) {
      if (!isBoolean(value)) continue;
      // 展开键是资源树节点 id（`dir:<projectId>/<rel>`），不含绝对路径；
      // 仍然过一遍白名单，避免把奇怪的键写进存储
      if (key.length === 0 || key.length > MAX_PATH_LENGTH + MAX_ID_LENGTH) continue;
      if (key.includes('\u0000') || key.includes('\\')) continue;
      picked[key] = value;
      count += 1;
      if (count >= MAX_EXPANDED_PER_PROJECT) break;
    }
    out[projectId] = picked;
  }
  return out;
}

/** 标签身份：项目 + 相对路径（docId 属于运行期，不进存储）。 */
function tabKeyOf(tab: { projectId: string | null; path: string }): string {
  return `${tab.projectId ?? ''}\u0000${tab.path}`;
}

/**
 * 把运行时状态压成白名单快照。
 *
 * 返回 null 表示"这次不写"：没有工作区身份（demo / Host 未连接）时不允许落盘，
 * 否则下次启动无法判断这条记录属于哪个工作区。
 */
export function serializeWorkspace(
  state: WorkspaceState,
  options: SerializeOptions,
): PersistedWorkspaceV1 | null {
  const key = options.workspaceKey;
  if (!key || !isWorkspaceKey(key)) return null;
  if (state.mode !== 'live') return null;

  const tabs: PersistedTab[] = [];
  const indexOfDocId = new Map<string, number>();
  for (const tab of state.tabs) {
    if (tabs.length >= MAX_TABS) break;
    // 只存真实磁盘文件：demo 标签一律不进入记录
    if (tab.mode !== 'live') continue;
    if (tab.projectId !== null && !isProjectId(tab.projectId)) continue;
    // 没有项目身份只可能是 Legacy；Multi 下出现 null 说明状态已损坏，宁可不存
    if (tab.projectId === null && state.workspaceMode !== 'legacy') continue;
    if (!isSafeRelativePath(tab.path)) continue;
    indexOfDocId.set(tab.docId, tabs.length);
    tabs.push({
      projectId: tab.projectId,
      path: tab.path,
      mode: 'live',
      hadUnsavedChanges: hasUnconfirmedEdits(tab),
    });
  }

  /**
   * 结转：把"当前界面里还没有、但记录里不该丢"的标签补回来（S11-C-R1）。
   *
   * 必须在窗格下标计算**之前**结束，但**不能**影响下标语义：窗格只指向
   * 真正恢复出来的标签，结转条目永远不参与 `tabIndex`（否则下次启动会把窗格
   * 指到一个"上次压根没打开"的文件上）。
   */
  const seen = new Set(tabs.map(tabKeyOf));
  for (const carried of options.carryOver ?? []) {
    if (tabs.length >= MAX_TABS) break;
    if (!carried || !isSafeRelativePath(carried.path)) continue;
    if (carried.projectId !== null && !isProjectId(carried.projectId)) continue;
    // 没有项目身份只可能是 Legacy（与上面"当前标签"的规则保持一致）
    if (carried.projectId === null && state.workspaceMode !== 'legacy') continue;
    const carriedKey = tabKeyOf(carried);
    // 与当前标签同源（同项目同路径）→ 用户自己已经打开过它，提示到此结束
    if (seen.has(carriedKey)) continue;
    seen.add(carriedKey);
    tabs.push({
      projectId: carried.projectId,
      path: carried.path,
      mode: 'live',
      hadUnsavedChanges: carried.hadUnsavedChanges === true,
    });
  }

  const paneOf = (pane: PaneId): PersistedPane => {
    const docId = state.panes[pane]?.docId ?? null;
    const index = docId ? indexOfDocId.get(docId) : undefined;
    return {
      tabIndex: index === undefined ? null : index,
      mode: state.panes[pane]?.mode === 'editor' ? 'editor' : 'preview',
    };
  };

  const activeProjectId =
    state.activeProjectId && state.projects.some((project) => project.projectId === state.activeProjectId)
      ? state.activeProjectId
      : null;

  const now = options.now ? options.now() : new Date();
  return {
    version: PERSIST_VERSION,
    workspaceKey: key,
    savedAt: now.toISOString(),
    ui: {
      navCollapsed: state.navCollapsed,
      navKey: state.navKey,
      treeCollapsed: state.treeCollapsed,
      auxCollapsed: state.auxCollapsed,
      auxTab: state.auxTab,
      layout: state.layout,
      splitRatio: Math.min(75, Math.max(25, Math.round(state.splitRatio))),
      focusedPane: state.focusedPane,
    },
    activeProjectId,
    expandedByProject: expandedWhitelist(state),
    tabs,
    panes: { primary: paneOf('primary'), secondary: paneOf('secondary') },
  };
}

/** 未确认内容：dirty / 保存中 / 结果未知。用于"刷新前提醒"与"未恢复"提示。 */
export function hasUnconfirmedEdits(tab: {
  dirty: boolean;
  saving?: boolean;
  documentState?: string;
}): boolean {
  return (
    Boolean(tab.dirty) ||
    Boolean(tab.saving) ||
    tab.documentState === 'SAVING' ||
    tab.documentState === 'OUTCOME_UNKNOWN'
  );
}

// ---------------------------------------------------------------------------
// 校验（读取路径的唯一入口）
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validateUi(raw: unknown): PersistedUi | null {
  const ui = asRecord(raw);
  if (!ui) return null;
  const ratio = validateRatio(ui.splitRatio);
  if (ratio === null) return null;
  if (!isBoolean(ui.navCollapsed) || !isBoolean(ui.treeCollapsed) || !isBoolean(ui.auxCollapsed)) return null;
  if (!NAV_KEYS.includes(ui.navKey as NavKey)) return null;
  if (!AUX_TABS.includes(ui.auxTab as AuxTab)) return null;
  if (!LAYOUTS.includes(ui.layout as LayoutMode)) return null;
  if (!PANE_IDS.includes(ui.focusedPane as PaneId)) return null;
  return {
    navCollapsed: ui.navCollapsed,
    navKey: ui.navKey as NavKey,
    treeCollapsed: ui.treeCollapsed,
    auxCollapsed: ui.auxCollapsed,
    auxTab: ui.auxTab as AuxTab,
    layout: ui.layout as LayoutMode,
    splitRatio: ratio,
    focusedPane: ui.focusedPane as PaneId,
  };
}

function validateTabs(raw: unknown): PersistedTab[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_TABS) return null;
  const tabs: PersistedTab[] = [];
  for (const item of raw) {
    const tab = asRecord(item);
    if (!tab) return null;
    if (tab.mode !== 'live') return null;
    if (tab.projectId !== null && !isProjectId(tab.projectId)) return null;
    if (!isSafeRelativePath(tab.path)) return null;
    if (!isBoolean(tab.hadUnsavedChanges)) return null;
    tabs.push({
      projectId: tab.projectId === null ? null : tab.projectId,
      path: tab.path,
      mode: 'live',
      hadUnsavedChanges: tab.hadUnsavedChanges,
    });
  }
  return tabs;
}

function validatePane(raw: unknown, tabCount: number): PersistedPane | null {
  const pane = asRecord(raw);
  if (!pane) return null;
  if (!VIEW_MODES.includes(pane.mode as ViewMode)) return null;
  const index = pane.tabIndex;
  if (index === null) return { tabIndex: null, mode: pane.mode as ViewMode };
  if (typeof index !== 'number' || !Number.isInteger(index)) return null;
  if (index < 0 || index >= tabCount) return null;
  return { tabIndex: index, mode: pane.mode as ViewMode };
}

/**
 * 严格校验任意 JSON 值。
 *
 * 任何一项不合法都返回 null（整体丢弃），不做"尽力修补"：半可信的快照
 * 最容易在恢复时表现为"看起来正常但指向错误文件"。
 */
export function validateSnapshot(raw: unknown): PersistedWorkspaceV1 | null {
  const root = asRecord(raw);
  if (!root) return null;
  if (root.version !== PERSIST_VERSION) return null;
  if (!isWorkspaceKey(root.workspaceKey)) return null;
  if (!isIsoDate(root.savedAt)) return null;
  const ui = validateUi(root.ui);
  if (!ui) return null;
  const tabs = validateTabs(root.tabs);
  if (!tabs) return null;

  const panesRaw = asRecord(root.panes);
  if (!panesRaw) return null;
  const primary = validatePane(panesRaw.primary, tabs.length);
  const secondary = validatePane(panesRaw.secondary, tabs.length);
  if (!primary || !secondary) return null;

  const activeProjectIdRaw = root.activeProjectId;
  let activeProjectId: string | null = null;
  if (activeProjectIdRaw !== null) {
    if (!isProjectId(activeProjectIdRaw)) return null;
    activeProjectId = activeProjectIdRaw;
  }

  const expandedRaw = asRecord(root.expandedByProject);
  if (!expandedRaw) return null;
  const expandedByProject: Record<string, Record<string, boolean>> = {};
  const projectEntries = Object.entries(expandedRaw);
  if (projectEntries.length > MAX_PROJECTS) return null;
  for (const [projectId, entriesRaw] of projectEntries) {
    if (!isProjectId(projectId)) return null;
    const entries = asRecord(entriesRaw);
    if (!entries) return null;
    const picked: Record<string, boolean> = {};
    let count = 0;
    for (const [key, value] of Object.entries(entries)) {
      if (!isBoolean(value)) return null;
      if (key.length === 0 || key.length > MAX_PATH_LENGTH + MAX_ID_LENGTH) return null;
      if (key.includes('\u0000') || key.includes('\\')) return null;
      picked[key] = value;
      count += 1;
      if (count > MAX_EXPANDED_PER_PROJECT) return null;
    }
    expandedByProject[projectId] = picked;
  }

  return {
    version: PERSIST_VERSION,
    workspaceKey: root.workspaceKey,
    savedAt: root.savedAt,
    ui,
    activeProjectId,
    expandedByProject,
    tabs,
    panes: { primary, secondary },
  };
}

// ---------------------------------------------------------------------------
// 读写（所有异常都吞掉：存储不可用不得影响编辑与保存）
// ---------------------------------------------------------------------------

export function storageKeyFor(workspaceKey: string): string {
  return `${STORAGE_PREFIX}record:${workspaceKey}`;
}

export function encodeSnapshot(snapshot: PersistedWorkspaceV1): string {
  return JSON.stringify(snapshot);
}

/** 解析已存储的字符串：先判长度，再判 JSON，再判结构。 */
export function decodeSnapshot(raw: string | null): PersistedWorkspaceV1 | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw.length > MAX_SNAPSHOT_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return validateSnapshot(parsed);
}

export function readSnapshot(storage: StorageLike, workspaceKey: string): PersistedWorkspaceV1 | null {
  try {
    const snapshot = decodeSnapshot(storage.getItem(storageKeyFor(workspaceKey)));
    // 记录里的摘要与请求的摘要必须一致（防御手工拼接别的记录）
    return snapshot && snapshot.workspaceKey === workspaceKey ? snapshot : null;
  } catch {
    return null;
  }
}

/** 最近一次使用的工作区记录；无效则返回 null（启动流程按"没有记录"处理）。 */
export function readLastSnapshot(storage: StorageLike): PersistedWorkspaceV1 | null {
  let key: string | null = null;
  try {
    const raw = storage.getItem(LAST_KEY);
    if (!raw) return null;
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed || parsed.version !== PERSIST_VERSION) return null;
    key = isWorkspaceKey(parsed.workspaceKey) ? parsed.workspaceKey : null;
  } catch {
    return null;
  }
  return key ? readSnapshot(storage, key) : null;
}

export interface WorkspaceStore {
  write(snapshot: PersistedWorkspaceV1): WriteOutcome;
  read(workspaceKey: string): PersistedWorkspaceV1 | null;
  readLast(): PersistedWorkspaceV1 | null;
  clear(workspaceKey: string): void;
}

/** 把 Storage 包成不会抛异常的仓库。 */
export function createWorkspaceStore(storage: StorageLike | null): WorkspaceStore {
  return {
    write(snapshot) {
      if (!storage) return 'unavailable';
      const encoded = encodeSnapshot(snapshot);
      if (encoded.length > MAX_SNAPSHOT_BYTES) return 'skipped';
      try {
        storage.setItem(storageKeyFor(snapshot.workspaceKey), encoded);
        storage.setItem(
          LAST_KEY,
          JSON.stringify({
            version: PERSIST_VERSION,
            workspaceKey: snapshot.workspaceKey,
            savedAt: snapshot.savedAt,
          }),
        );
        return 'written';
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        // QuotaExceededError / 隐私模式下的 SecurityError 都只降级，不冒泡
        return name === 'QuotaExceededError' ? 'quota' : 'unavailable';
      }
    },
    read(workspaceKey) {
      return storage ? readSnapshot(storage, workspaceKey) : null;
    },
    readLast() {
      return storage ? readLastSnapshot(storage) : null;
    },
    clear(workspaceKey) {
      if (!storage) return;
      try {
        storage.removeItem(storageKeyFor(workspaceKey));
      } catch {
        // 清理失败不影响任何功能
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 恢复用的纯函数
// ---------------------------------------------------------------------------

/** 阶段 A：可安全套用到 WorkspaceState 的 UI 局部（不涉及标签/会话）。 */
export function uiRestoreOf(snapshot: PersistedWorkspaceV1): PersistedUi {
  return { ...snapshot.ui };
}

/**
 * 展开状态裁剪：只保留"当前资源树里确实存在的目录"。
 *
 * 旧快照里的键可能指向已删除的目录；直接套用会得到一个不存在的文件树，
 * 因此恢复时必须用新加载的树做交集。
 */
export function pruneExpanded(
  expanded: Record<string, boolean>,
  existingFolderIds: ReadonlySet<string>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(expanded)) {
    if (!isBoolean(value)) continue;
    if (!existingFolderIds.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/** 树里所有目录节点的 id（展开状态的白名单）。 */
export function folderIdsOf(nodes: readonly { id: string; kind: string; children?: readonly unknown[] }[]): Set<string> {
  const out = new Set<string>();
  const walk = (list: readonly { id: string; kind: string; children?: readonly unknown[] }[]): void => {
    for (const node of list) {
      if (node.kind === 'folder') out.add(node.id);
      const children = node.children as readonly { id: string; kind: string; children?: readonly unknown[] }[] | undefined;
      if (children) walk(children);
    }
  };
  walk(nodes);
  return out;
}

// ---------------------------------------------------------------------------
// 写入节流
// ---------------------------------------------------------------------------

export interface AutosaveOptions {
  store: WorkspaceStore;
  /** 取当前快照；返回 null 表示"此刻不该写"（如未连接工作区）。 */
  snapshot(): PersistedWorkspaceV1 | null;
  /**
   * 恢复期间的写入门禁（S11-C-R1）。存在且不允许写入时，`schedule()` 不排定时器、
   * `flush()` 直接返回 `held`——**存储一个字节都不会被改**。
   */
  gate?: { allowsWrite(): boolean; state(): string };
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface Autosave {
  /** 合并高频变化（拖动分屏、切换折叠）后写入。 */
  schedule(): void;
  /** 立即写入（离开页面前调用；不依赖异步定时器）。 */
  flush(): WriteOutcome;
  dispose(): void;
}

export function createWorkspaceAutosave(options: AutosaveOptions): Autosave {
  const delay = options.delayMs ?? 400;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let handle: unknown = null;
  let disposed = false;

  const cancel = (): void => {
    if (handle !== null) {
      clearTimer(handle);
      handle = null;
    }
  };

  const write = (): WriteOutcome => {
    // 门禁优先于一切：恢复期间连"读取当前状态做快照"都不必要，直接拦住
    if (options.gate && !options.gate.allowsWrite()) return 'held';
    const snapshot = options.snapshot();
    if (!snapshot) return 'skipped';
    return options.store.write(snapshot);
  };

  return {
    schedule() {
      if (disposed) return;
      // 被门禁拦住时不排定时器：避免恢复期间反复空转，也避免"排了队再被拦"的歧义
      if (options.gate && !options.gate.allowsWrite()) return;
      cancel();
      handle = setTimer(() => {
        handle = null;
        write();
      }, delay);
    },
    flush() {
      cancel();
      return write();
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}
