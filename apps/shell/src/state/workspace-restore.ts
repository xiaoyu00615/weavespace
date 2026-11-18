/**
 * 启动恢复（S11-C / S11-C-R1）。
 *
 * 分阶段执行，每一步都可能降级，但**绝不虚构成功**：
 *
 * A. 界面局部：折叠状态、布局、分屏比例、查看模式、展开状态（裁到真实存在的目录）。
 * B. 校验 Host：拿工作区摘要、工作区模式、项目列表与 READY 状态（一律以服务器本次结果为准）。
 * C. 重建文件标签：逐个项目/路径核对，再走**现有的打开流程**拿到新的 sessionId / viewId。
 *
 * 五条纪律：
 * 1. 摘要不一致（换根、根被替换、项目组合变化）→ 只保留界面，不碰任何文件；
 * 2. 标签一律**后台登记**（`OPEN_TAB_BACKGROUND`），只有全部恢复完、且用户没有新交互时
 *    才把窗格指回原来的位置——恢复不能抢焦点（继承 G2-R2）；
 * 3. 单个文件失败只跳过它，不影响其余文件；迟到响应交由打开流程的模式守卫处理并释放 View；
 * 4. **有未确认内容的标签不自动重开**（DR-01）：正文没有持久化，重开只能拿到磁盘内容，
 *    把它显示成普通干净标签等于谎称"草稿已恢复"。这类标签只保留提示，由用户自己决定；
 * 5. 恢复全程**禁止自动写入**（AS-01…AS-03）：阶段 C 的状态是"残缺"的，写下去就会用
 *    2 个标签覆盖上次离开时的 8 个。门禁在第一个 await 之前合上，终态才放开。
 * 6. 被接管时**不留孤儿 View**（R1.2）：恢复不会再重开那些没处理完的文件，它们的
 *    旧 View 只能在这一刻回收（`reclaimStaleViews`）；回收被拒（最后一个脏视图）
 *    时如实保留，绝不为了清理而丢草稿。
 *
 * 这里不做：A2 的动态重绑定、STALE 会话回收、草稿正文持久化、`/api/edit|save|reload`。
 */
import type { OpenNodeResult, ReclaimSummary } from './open-document.ts';
import type {
  ClientMode,
  LayoutMode,
  NavKey,
  PaneId,
  ResourceNodeState,
  WorkspaceAction,
  WorkspaceState,
  WorkspaceUiSnapshot,
} from './types.ts';
import type { WorkspaceMode } from '../client/client-api.ts';
import type { TreeLevels } from '../components/tree-model.ts';
import {
  folderIdsOf,
  pruneExpanded,
  uiRestoreOf,
  type PersistedPane,
  type PersistedTab,
  type PersistedWorkspaceV1,
  type WorkspaceStore,
} from './workspace-persistence.ts';
import type { WorkspaceWriteGate } from './workspace-write-gate.ts';

export type RestoreSkipReason =
  | 'project-missing'
  | 'project-unavailable'
  | 'file-missing'
  | 'open-rejected'
  | 'mode-changed'
  /** 有未确认内容：按契约不自动重开（DR-01）。 */
  | 'unsaved-changes'
  /** 恢复被用户接管 / 模式切换打断，这条还没处理（AS-05）。 */
  | 'interrupted';

export interface RestoreSkip {
  projectId: string | null;
  path: string;
  reason: RestoreSkipReason;
  errorCode?: string | null;
}

export type RestoreStatus = 'empty' | 'ui-only' | 'restored' | 'interrupted';
export type RestoreReason =
  | 'no-snapshot'
  | 'host-unavailable'
  | 'workspace-mismatch'
  | 'superseded'
  | null;

export interface RestoreReport {
  status: RestoreStatus;
  reason: RestoreReason;
  workspaceKeyMatched: boolean;
  uiRestored: boolean;
  tabsRequested: number;
  tabsRestored: number;
  /**
   * 有未确认内容、因此**没有**自动重开的标签数（DR-01/DR-02）。
   * 正文没有持久化，所以这里永远不是"已恢复"——只是"还有提示待处理"。
   */
  draftsPending: number;
  skipped: RestoreSkip[];
  /**
   * 本次对"本页面遗留 View"的回收结果（UX-02C-02-R1.3）。
   *
   * `null` = 本轮没有尝试回收（没有注入回收能力、不在 live 模式、或只恢复了界面）。
   * 非 null 时三个计数必须都被如实呈现：`blocked` 是保护脏草稿的代价，
   * `failed` 是"这次没清理掉、下次改名可能被拦住"的唯一可观察信号。
   */
  reclaim: ReclaimSummary | null;
  notice: string;
}

export interface ConnectedWorkspace {
  workspaceKey: string | null;
  workspaceMode: WorkspaceMode;
}

export interface RestoreDeps {
  getState(): WorkspaceState;
  getMode(): ClientMode;
  dispatch(action: WorkspaceAction): void;
  store: WorkspaceStore;
  /**
   * 写入闸门（AS-01…AS-05）。恢复期间必须挡住自动保存，
   * 否则残缺陷状态会覆盖完整记录。缺省时不做任何拦截（仅测试夹具可省略）。
   */
  gate?: WorkspaceWriteGate;
  /**
   * 连接 Host 并加载项目/资源；不可用时返回 null（此时只恢复界面）。
   * `isCancelled()` 供实现方在每次 await 之后自检：用户已经接管就不要把界面切进 live。
   */
  connectLive(isCancelled: () => boolean): Promise<ConnectedWorkspace | null>;
  /** 后台打开：复用 open-document 的并发合并、模式守卫与 View 释放。 */
  openInBackground(node: ResourceNodeState, projectId: string | null): Promise<OpenNodeResult>;
  /**
   * 回收**本页面**遗留的 View（UX-02C-02-R1.2 / R1.3）。
   *
   * 输入是"本次恢复**没有**重开的标签"（被接管后没处理完的，加上因
   * `open-rejected` / `file-missing` / `project-unavailable` / `unsaved-changes`
   * 被跳过的）。它们都不会再有 `/api/open` 去顺带清掉旧 View，只能在这里清；
   * 否则该项目会一直判定为"有活动编辑会话"，改名/移动被拦住——即使文件或项目
   * 随后恢复可用。实现方必须只处理同一页面实例、且不碰当前标签正在用的 View
   * （由 `open-document.ts` 的 `reclaimStaleViews` 保证）。
   *
   * 脏草稿由 Host 的 `closeView` 兜底拒绝，调用方**不得**为此丢弃内容。
   * 缺省（未注入）时跳过：回收是清理动作，不影响恢复结论。
   */
  reclaimStaleViews?(tabs: readonly PersistedTab[]): Promise<ReclaimSummary>;
  /** 到达终态后回调（Provider 据此决定是否补一次提交）。 */
  onSettled?(report: RestoreReport): void;
}

export interface WorkspaceRestorer {
  /** 启动恢复。幂等：并发/重复调用返回同一个 Promise（StrictMode 不会重建 View）。 */
  restore(): Promise<RestoreReport>;
  /** 用户主动操作：此后的窗格指回必须放弃（标签本身仍继续后台登记）。 */
  noteInteraction(): void;
  lastReport(): RestoreReport | null;
  /**
   * 未确认内容提示（DR-02/DR-03）：未自动重开的脏标签。
   * 调用方必须把它们继续结转进写入，否则下一次自动保存就把提示抹掉了。
   */
  unsavedHints(): readonly PersistedTab[];
  /**
   * 被中断时还没处理完的标签（AS-05）：接管后的提交必须合并它们，不能只写当前界面。
   */
  pendingTabs(): readonly PersistedTab[];
  /**
   * 恢复是否**仍在进行**（UX-02C-02-R1.2）。
   *
   * 打开流程据此判定"这次打开可以回收本页面上轮遗留的 View"：恢复窗口内，
   * 用户主动打开的正是待恢复文件，它的旧 View 已经没人关了。窗口之外一律不回收。
   *
   * 注意窗口的终点是**报告落地**，不是 `noteInteraction()`：接管打开发生在
   * "用户已经接管、但恢复尚未收手"之间，这段时间必须仍然算恢复中。
   */
  isRestoring(): boolean;
}

/** 在资源树里按相对路径找文件节点（`path` 缺失时退回节点 id 的末段匹配）。 */
export function findNodeByPath(
  nodes: readonly ResourceNodeState[],
  path: string,
): ResourceNodeState | null {
  for (const node of nodes) {
    if (node.kind !== 'folder') {
      const nodePath = node.path ?? node.id;
      if (nodePath === path) return node;
    }
    if (node.children) {
      const hit = findNodeByPath(node.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 候选路径合法性：来自持久化记录的路径可能损坏或被改写，合成节点之前
 * 必须先挡掉绝对路径 / 盘符 / 反斜杠 / `..` / 空段 / 控制字符（fail-closed）。
 */
function safePathSegments(path: string): string[] | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) return null;
  if (path.includes('\0') || path.includes('\\') || path.startsWith('/')) return null;
  if (/^[A-Za-z]:/.test(path)) return null;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return segments;
}

/**
 * 这一条路径分支是否**已经被完整枚举**（UX-02B-TREE-R1 / R1-01）。
 *
 * 必须检查从根到父目录的每一层，而不只是父层：
 * - 任一层没加载 → 后面可能根本还没被扫描到；
 * - 任一层只取了第一页（`nextCursor !== null`）→ 后续页里可能就有这个文件；
 * - `loading` / `error` 也不算"完整"。
 * 只有每一层都 `ready` 且 `nextCursor === null`，"树里没有"才等价于"磁盘上没有"。
 */
function branchFullyLoaded(levels: TreeLevels, parentSegments: readonly string[]): boolean {
  for (let i = 0; i <= parentSegments.length; i += 1) {
    const dir = parentSegments.slice(0, i).join('/');
    const level = levels[dir];
    if (!level || level.status !== 'ready' || level.nextCursor !== null) return false;
  }
  return true;
}

/** 合成一个"待 Host 裁决"的候选文件节点；它不是磁盘事实，只是打开请求的目标。 */
function candidateNode(path: string, name: string, projectId: string | null): ResourceNodeState {
  const dot = name.lastIndexOf('.');
  const rel = projectId === null ? path : `${projectId}/${path}`;
  return {
    id: `doc:${rel}`,
    name,
    kind: 'file',
    extension: dot > 0 ? name.slice(dot).toLowerCase() : '',
    path,
  };
}

/**
 * UX-02B-TREE-R1：懒加载 + 分页树下"按树找文件"的解析规则。
 *
 * 逐层文件树里，未展开的目录、以及只取了第一页的层，都不在内存里。
 * 把"树里没有"直接判成文件不存在，会把**子目录里的 / 后续页里的**标签
 * 误报成 `file-missing` —— 那是懒加载的假象，不是磁盘事实。
 *
 * 1. 已在已加载层里找到 → 用真实节点；
 * 2. 从根到父目录**每一层都已完整加载**却仍找不到 → 真的不存在，
 *    保留既有 `file-missing` 语义（既有断言依赖它）；
 * 3. 其余情况 → 合成候选节点交给打开链路，由 Host 按真实磁盘判定存在性与授权；
 *    文件缺失走 `open-rejected`，不撒谎、不自动创建。
 *
 * Legacy（`projectId === null`）同样适用：它的层表键是 `''`，与 Multi 一样是懒加载。
 * 完全没有层表时按旧行为处理（旧式全量树 / 尚未开始加载），避免改动既有语义。
 */
export function resolveRestorableNode(
  state: WorkspaceState,
  path: string,
  projectId: string | null,
): ResourceNodeState | null {
  const nodes: readonly ResourceNodeState[] =
    projectId === null ? state.resources : (state.resourcesByProject[projectId] ?? []);
  const found = findNodeByPath(nodes, path);
  if (found) return found;

  const segments = safePathSegments(path);
  if (!segments) return null;

  const levels = state.treeByProject[projectId ?? ''];
  if (!levels) {
    // 没有层表：Legacy 旧式全量树沿用"找不到即不存在"；Multi 本来就是懒加载，
    // 没有层表说明还没扫描过，同样只能交 Host 判定（与 02B-TREE 既有行为一致）。
    return projectId === null ? null : candidateNode(path, segments[segments.length - 1], projectId);
  }
  if (branchFullyLoaded(levels, segments.slice(0, -1))) return null;
  return candidateNode(path, segments[segments.length - 1], projectId);
}

/**
 * 恢复开始时的界面基线（IX-01/IX-02）。
 *
 * 组件会直接 `dispatch({type:'SET_SPLIT_RATIO'})` 而不经过任何"恢复 API"，
 * 所以只靠代次计数抓不住它们。这里改为**逐字段比对**：某个字段在恢复期间被改过，
 * 就认为它属于用户，恢复不得把它改回去。
 */
interface Baseline {
  ui: WorkspaceUiSnapshot;
  panes: Record<PaneId, string | null>;
}

function captureBaseline(state: WorkspaceState): Baseline {
  return {
    ui: {
      navCollapsed: state.navCollapsed,
      navKey: state.navKey,
      treeCollapsed: state.treeCollapsed,
      auxCollapsed: state.auxCollapsed,
      auxTab: state.auxTab,
      layout: state.layout,
      splitRatio: state.splitRatio,
      focusedPane: state.focusedPane,
    },
    panes: {
      primary: state.panes.primary.docId,
      secondary: state.panes.secondary.docId,
    },
  };
}

function emptyReport(overrides: Partial<RestoreReport> = {}): RestoreReport {
  return {
    status: 'empty',
    reason: null,
    workspaceKeyMatched: false,
    uiRestored: false,
    tabsRequested: 0,
    tabsRestored: 0,
    draftsPending: 0,
    skipped: [],
    reclaim: null,
    notice: '',
    ...overrides,
  };
}

/**
 * 回收结果的用户可见措辞（UX-02C-02-R1.3）。
 *
 * 只在"真的有东西没清理掉"时追加：`blocked` 是保护未保存内容的代价，`failed`
 * 是本次没能清理、下次改名/移动可能被 409 拦住的唯一提示。两者都不能静默。
 */
function reclaimNotice(reclaim: ReclaimSummary | null): string[] {
  if (!reclaim) return [];
  const parts: string[] = [];
  if (reclaim.blocked > 0) {
    parts.push(
      `${reclaim.blocked} 个文件仍有未保存内容（已保留，未回收其编辑会话），处理草稿后才能改名/移动`,
    );
  }
  if (reclaim.failed > 0) {
    parts.push(`${reclaim.failed} 个文件的旧编辑会话未能回收，改名/移动可能被暂时拦住`);
  }
  return parts;
}

function buildNotice(report: RestoreReport): string {
  if (report.status === 'empty') return '没有找到可恢复的工作区记录';
  if (report.status === 'interrupted') {
    const parts = ['恢复被中断：原记录已保留'];
    if (report.tabsRestored > 0) parts.push(`本次恢复了 ${report.tabsRestored} 个文件标签`);
    if (report.draftsPending > 0) parts.push(`${report.draftsPending} 个未保存内容未自动恢复`);
    parts.push(...reclaimNotice(report.reclaim));
    return parts.join('；');
  }
  if (report.status === 'ui-only') {
    if (report.reason === 'host-unavailable') {
      return '无法连接本地服务：已恢复界面布局，未恢复文件标签（需要启动 apps/server）';
    }
    if (report.reason === 'workspace-mismatch') {
      return '当前工作区与上次记录不一致（根或项目组合已变化）：仅恢复界面布局，未恢复文件标签';
    }
    return '已保留当前界面，未执行恢复';
  }
  const parts = [`已恢复 ${report.tabsRestored}/${report.tabsRequested} 个文件标签`];
  if (report.skipped.length > 0) parts.push(`${report.skipped.length} 个未能恢复`);
  // DR-04：正文没有持久化，措辞必须诚实——"未自动恢复"而不是"已恢复"
  if (report.draftsPending > 0) {
    parts.push(`${report.draftsPending} 个标签有未保存内容，未自动恢复（正文未持久化）`);
  }
  parts.push(...reclaimNotice(report.reclaim));
  return parts.join('；');
}

export function createWorkspaceRestorer(deps: RestoreDeps): WorkspaceRestorer {
  let epoch = 0;
  let running: Promise<RestoreReport> | null = null;
  let restoring = false;
  let report: RestoreReport | null = null;
  let hints: PersistedTab[] = [];
  let pending: PersistedTab[] = [];

  const isCurrent = (token: number): boolean => epoch === token;

  /**
   * 回收本页面遗留的 View（UX-02C-02-R1.2 / R1.3）。
   *
   * 输入是**本次恢复没有重开**的标签：被接管后没处理完的，加上被跳过的
   * （`open-rejected` / `file-missing` / `project-unavailable` / `unsaved-changes`）。
   * 这些文件的旧 View 不会再有人关，只能在这里清。不做任何判断上的额外承诺：
   * 实现方只关"同页面上轮"的 View，关闭被拒（最后一个脏视图）时如实保留。
   *
   * 返回 `null` 表示"本轮没有尝试"（没注入能力 / 不在 live 模式），与
   * `{failed: N}` 严格区分：后者意味着"试过但没成功"，必须让用户看到。
   */
  async function reclaimAbandoned(
    tabs: readonly PersistedTab[],
  ): Promise<ReclaimSummary | null> {
    if (!deps.reclaimStaleViews || tabs.length === 0) return null;
    // 已经切到 demo：那边的 View 由 switchMode 收回，这里不该再发 live 请求
    if (deps.getMode() !== 'live') return null;
    try {
      return await deps.reclaimStaleViews(tabs);
    } catch {
      // 回收失败不能改写恢复结论，但也不能伪装成"没有需要清理的东西"
      return { closed: 0, blocked: 0, failed: tabs.length };
    }
  }

  /**
   * 阶段 A：界面局部。
   *
   * 逐字段比对基线（IX-01/IX-02）：恢复期间被改过的字段保留用户的值，
   * 其余字段才套用记录——这样"用户拖了一下分屏"不会把布局的其余部分也丢掉，
   * 同时用户的那一次拖动一定不会被迟到恢复改回去。
   */
  function applyUi(
    snapshot: PersistedWorkspaceV1,
    expanded: Record<string, Record<string, boolean>> | null,
    baseline: Baseline,
    token: number,
  ): void {
    const state = deps.getState();
    const recorded = uiRestoreOf(snapshot);
    const pick = <K extends keyof WorkspaceUiSnapshot>(key: K): WorkspaceUiSnapshot[K] =>
      state[key] !== baseline.ui[key] ? state[key] : recorded[key];

    const ui: WorkspaceUiSnapshot = {
      navCollapsed: pick('navCollapsed'),
      navKey: pick('navKey') as NavKey,
      treeCollapsed: pick('treeCollapsed'),
      auxCollapsed: pick('auxCollapsed'),
      auxTab: pick('auxTab'),
      layout: pick('layout') as LayoutMode,
      splitRatio: pick('splitRatio'),
      focusedPane: pick('focusedPane') as PaneId,
    };

    deps.dispatch({
      type: 'HYDRATE_UI',
      ui,
      ...(expanded ? { expandedByProject: expanded } : {}),
    });

    const active = snapshot.activeProjectId;
    if (!active) return;
    /**
     * 当前项目用**代次**判定，而不是基线比对（与界面字段不同）：
     * 连接 Host 本身就会按 `SET_PROJECTS` 选中第一个 READY 项目，那个"默认值"不是
     * 用户的选择，拿它跟恢复前的 null 比较会把正常恢复误判成"用户改过"。
     * 项目切换在 Provider 里一定经过 `switchProject`（会 `noteInteraction()`），
     * 所以代次足以区分。
     */
    if (!isCurrent(token)) return;
    if (deps.getState().projects.some((project) => project.projectId === active)) {
      deps.dispatch({ type: 'SET_ACTIVE_PROJECT', projectId: active });
    }
  }

  function expandedFromState(snapshot: PersistedWorkspaceV1): Record<string, Record<string, boolean>> | null {
    const state = deps.getState();
    const out: Record<string, Record<string, boolean>> = {};
    for (const [projectId, entries] of Object.entries(snapshot.expandedByProject)) {
      // 项目已经不存在：它的展开状态没有意义，直接丢弃
      if (!state.projects.some((project) => project.projectId === projectId)) continue;
      const nodes = state.resourcesByProject[projectId] ?? [];
      out[projectId] = pruneExpanded(entries, folderIdsOf(nodes));
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  interface RestoredTab {
    index: number;
    docId: string;
    dirty: boolean;
  }

  interface TabOutcome {
    restored: RestoredTab[];
    skipped: RestoreSkip[];
    draftsPending: number;
    hints: PersistedTab[];
    pending: PersistedTab[];
    /**
     * 本次**没有**重开的标签（= 记录里有、界面里没有）。
     *
     * `pending` 只回答"还没轮到/没处理成功，要结转进下一次写入"这个存储语义；
     * 回收 View 关心的是另一个集合：只要这个文件没被重开，它上轮的 View 就是
     * 孤儿——包括那些被判定为 `file-missing` / `open-rejected` /
     * `project-unavailable` / `unsaved-changes` 而跳过的情况（R1.3-01）。
     */
    abandoned: PersistedTab[];
    interrupted: boolean;
  }

  /** 阶段 C：逐个核对并后台重建标签。单个失败只记录，不中断。 */
  async function restoreTabs(snapshot: PersistedWorkspaceV1, token: number): Promise<TabOutcome> {
    const restored: RestoredTab[] = [];
    const skipped: RestoreSkip[] = [];
    const hintList: PersistedTab[] = [];
    /** 真正登记成标签的下标；其余下标（含跳过与未处理）都属于"没重开"。 */
    const restoredIndex = new Set<number>();
    const abandonedOf = (): PersistedTab[] =>
      snapshot.tabs.filter((_, index) => !restoredIndex.has(index));
    let draftsPending = 0;

    for (const [index, tab] of snapshot.tabs.entries()) {
      // 用户接管 / 模式被切走：**剩下的都没处理**，交给调用方结转（AS-05）
      if (!isCurrent(token) || deps.getMode() !== 'live') {
        const remaining = snapshot.tabs.slice(index);
        for (const rest of remaining) {
          skipped.push({
            projectId: rest.projectId,
            path: rest.path,
            reason: isCurrent(token) ? 'mode-changed' : 'interrupted',
          });
        }
        return {
          restored,
          skipped,
          draftsPending,
          hints: hintList,
          pending: [...remaining],
          abandoned: abandonedOf(),
          interrupted: true,
        };
      }

      // DR-01：有未确认内容就不自动重开。正文不在存储里，重开只能得到磁盘内容，
      // 把它当成普通 CLEAN 标签展示等于对用户撒谎。
      if (tab.hadUnsavedChanges) {
        skipped.push({ projectId: tab.projectId, path: tab.path, reason: 'unsaved-changes' });
        draftsPending += 1;
        hintList.push({ ...tab });
        continue;
      }

      const state = deps.getState();
      const project =
        tab.projectId === null
          ? undefined
          : state.projects.find((item) => item.projectId === tab.projectId);

      // Legacy 记录（projectId 为 null）只在 Legacy 工作区里成立
      if (tab.projectId !== null && !project) {
        skipped.push({ projectId: tab.projectId, path: tab.path, reason: 'project-missing' });
        continue;
      }
      if (project && project.status !== 'READY') {
        // 不可用项目不读盘、不建会话、不虚构项目记录
        skipped.push({ projectId: tab.projectId, path: tab.path, reason: 'project-unavailable' });
        continue;
      }

      const node = resolveRestorableNode(state, tab.path, tab.projectId);
      if (!node) {
        // 文件确实不在（或该层已完整加载却没有它）：不自动创建、不回退到别的项目
        skipped.push({ projectId: tab.projectId, path: tab.path, reason: 'file-missing' });
        continue;
      }

      const outcome = await deps.openInBackground(node, tab.projectId);

      // 打开期间被接管：这条已经登记成标签就算恢复成功，否则记为未处理
      if (!isCurrent(token) || deps.getMode() !== 'live') {
        const latest = deps.getState().tabs.find((item) => item.docId === outcome.docId);
        if (outcome.ok && latest) {
          restored.push({ index, docId: outcome.docId, dirty: latest.dirty });
          restoredIndex.add(index);
        } else {
          skipped.push({
            projectId: tab.projectId,
            path: tab.path,
            reason: isCurrent(token) ? 'mode-changed' : 'interrupted',
          });
        }
        const remaining = snapshot.tabs.slice(index + 1);
        for (const rest of remaining) {
          skipped.push({
            projectId: rest.projectId,
            path: rest.path,
            reason: isCurrent(token) ? 'mode-changed' : 'interrupted',
          });
        }
        return {
          restored,
          skipped,
          draftsPending,
          hints: hintList,
          pending: [...(outcome.ok && latest ? [] : [tab]), ...remaining],
          abandoned: abandonedOf(),
          interrupted: true,
        };
      }

      if (!outcome.ok) {
        skipped.push({
          projectId: tab.projectId,
          path: tab.path,
          reason: 'open-rejected',
          errorCode: outcome.errorCode,
        });
        continue;
      }

      const dirty = deps.getState().tabs.find((item) => item.docId === outcome.docId)?.dirty ?? false;
      restored.push({ index, docId: outcome.docId, dirty });
      restoredIndex.add(index);
    }

    return {
      restored,
      skipped,
      draftsPending,
      hints: hintList,
      pending: [],
      abandoned: abandonedOf(),
      interrupted: false,
    };
  }

  /**
   * 阶段 C 收尾：把窗格指回原来的位置。
   *
   * 只对"用户没动过"的窗格生效（IX-02）：用户在恢复期间把某个窗格指向了别的文档，
   * 恢复既不能覆盖它，也不能把焦点抢回去。
   */
  function applyPanes(
    snapshot: PersistedWorkspaceV1,
    result: TabOutcome,
    token: number,
    baseline: Baseline,
  ): void {
    if (!isCurrent(token)) return;
    if (deps.getMode() !== 'live') return;
    const state = deps.getState();
    if (state.workspaceKey !== snapshot.workspaceKey) return;

    const docOf = (pane: PersistedPane): string | null =>
      pane.tabIndex === null
        ? null
        : result.restored.find((item) => item.index === pane.tabIndex)?.docId ?? null;

    if (state.panes.primary.docId === baseline.panes.primary) {
      deps.dispatch({
        type: 'SET_PANE_TAB',
        pane: 'primary',
        docId: docOf(snapshot.panes.primary),
        mode: snapshot.panes.primary.mode,
      });
    }
    if (snapshot.ui.layout === 'vertical' && deps.getState().panes.secondary.docId === baseline.panes.secondary) {
      deps.dispatch({
        type: 'SET_PANE_TAB',
        pane: 'secondary',
        docId: docOf(snapshot.panes.secondary),
        mode: snapshot.panes.secondary.mode,
      });
    }
    // 焦点已由 HYDRATE_UI 处理（且同样做了逐字段比对），这里不再单独抢焦点。
  }

  /** 终态：交出写入门禁 + 通知调用方。每个返回路径都必须走这里。 */
  function settle(next: RestoreReport, outcome: 'release' | 'seal'): RestoreReport {
    if (outcome === 'release') deps.gate?.release();
    else deps.gate?.seal();
    deps.onSettled?.(next);
    return next;
  }

  async function run(): Promise<RestoreReport> {
    const snapshot = deps.store.readLast();
    if (!snapshot) {
      const empty = emptyReport({ reason: 'no-snapshot' });
      return { ...empty, notice: '' };
    }

    const token = epoch;
    const baseline = captureBaseline(deps.getState());
    // AS-01/AS-02：门禁必须在**第一个 await 之前**合上，否则第一次状态变化就能写盘
    deps.gate?.hold();

    let connected: ConnectedWorkspace | null = null;
    try {
      connected = await deps.connectLive(() => !isCurrent(token)).catch(() => null);
    } catch {
      connected = null;
    }

    // 用户接管（切模式、开别的文件）：不套用任何恢复结果，记录保持原样（AS-03/IX-03）
    if (!isCurrent(token)) {
      hints = [];
      pending = snapshot.tabs.slice();
      // 一个标签都没重开：全部旧 View 都是孤儿，必须在这里回收
      const reclaim = await reclaimAbandoned(pending);
      const interrupted = emptyReport({
        status: 'interrupted',
        reason: 'superseded',
        tabsRequested: snapshot.tabs.length,
        reclaim,
        skipped: snapshot.tabs.map((tab) => ({
          projectId: tab.projectId,
          path: tab.path,
          reason: 'interrupted' as const,
        })),
      });
      return settle({ ...interrupted, notice: buildNotice(interrupted) }, 'seal');
    }

    if (!connected || deps.getMode() !== 'live') {
      applyUi(snapshot, null, baseline, token);
      const uiOnly = emptyReport({
        status: 'ui-only',
        reason: 'host-unavailable',
        uiRestored: true,
        tabsRequested: snapshot.tabs.length,
      });
      const next = { ...uiOnly, notice: buildNotice(uiOnly) };
      deps.dispatch({ type: 'NOTICE', message: next.notice });
      return settle(next, 'release');
    }

    const matched =
      connected.workspaceKey !== null && connected.workspaceKey === snapshot.workspaceKey;
    applyUi(snapshot, matched ? expandedFromState(snapshot) : null, baseline, token);

    if (!matched) {
      // fail-closed：文件标签一律不恢复，只保留界面
      const uiOnly = emptyReport({
        status: 'ui-only',
        reason: 'workspace-mismatch',
        uiRestored: true,
        tabsRequested: snapshot.tabs.length,
      });
      const next = { ...uiOnly, notice: buildNotice(uiOnly) };
      deps.dispatch({ type: 'NOTICE', message: next.notice });
      return settle(next, 'release');
    }

    const result = await restoreTabs(snapshot, token);
    hints = result.hints;
    pending = result.pending;

    if (result.interrupted || !isCurrent(token) || deps.getMode() !== 'live') {
      /**
       * 接管前没处理完的标签 + 之前就跳过的标签：恢复都不会再重开它们，
       * 旧 View 在这里一次性回收（刚被用户接管打开的那个由打开路径自己回收，
       * 且它的新 View 在 keep 列表里）。
       */
      const reclaim = await reclaimAbandoned(result.abandoned);
      const interrupted = emptyReport({
        status: 'interrupted',
        reason: 'superseded',
        workspaceKeyMatched: true,
        uiRestored: true,
        tabsRequested: snapshot.tabs.length,
        tabsRestored: result.restored.length,
        draftsPending: result.draftsPending,
        skipped: result.skipped,
        reclaim,
      });
      const next = { ...interrupted, notice: buildNotice(interrupted) };
      deps.dispatch({ type: 'NOTICE', message: next.notice });
      return settle(next, 'seal');
    }

    applyPanes(snapshot, result, token, baseline);

    /**
     * 恢复成功也要清理"没能重开"的那些（UX-02C-02-R1.3）。
     *
     * 以前只有"被接管"才回收，于是 `file-missing` / `open-rejected` /
     * `project-unavailable` / `unsaved-changes` 的旧 View 一直留着：等项目或
     * 文件恢复可用、用户去改名时才发现 409，而这时已经没有任何路径能关掉它。
     *
     * 放在 applyPanes 之后、报告落地之前：界面照旧在同一拍落定（不因为清理
     * 遗留会话而延后），而提示里一定带上 `blocked` / `failed` 的真实数字。
     */
    const reclaim = await reclaimAbandoned(result.abandoned);

    const restoredReport = emptyReport({
      status: 'restored',
      reason: null,
      workspaceKeyMatched: true,
      uiRestored: true,
      tabsRequested: snapshot.tabs.length,
      tabsRestored: result.restored.length,
      draftsPending: result.draftsPending,
      skipped: result.skipped,
      reclaim,
    });
    const next = { ...restoredReport, notice: buildNotice(restoredReport) };
    deps.dispatch({ type: 'NOTICE', message: next.notice });
    return settle(next, 'release');
  }

  return {
    restore() {
      if (running) return running;
      if (report) return Promise.resolve(report);
      restoring = true;
      running = run().then(
        (value) => {
          report = value;
          restoring = false;
          return value;
        },
        (err: unknown) => {
          // 恢复流程本身不应该抛：真抛了也必须退出"恢复中"，否则打开流程会一直
          // 以为自己在恢复窗口内、继续回收旧 View（比失败本身更危险）。
          restoring = false;
          throw err;
        },
      );
      return running;
    },
    noteInteraction() {
      epoch += 1;
    },
    lastReport() {
      return report;
    },
    unsavedHints() {
      return hints;
    },
    pendingTabs() {
      return pending;
    },
    isRestoring() {
      return restoring;
    },
  };
}
