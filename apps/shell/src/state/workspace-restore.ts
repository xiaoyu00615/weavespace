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
 *
 * 这里不做：A2 的动态重绑定、STALE 会话回收、草稿正文持久化、`/api/edit|save|reload`。
 */
import type { OpenNodeResult } from './open-document.ts';
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
    notice: '',
    ...overrides,
  };
}

function buildNotice(report: RestoreReport): string {
  if (report.status === 'empty') return '没有找到可恢复的工作区记录';
  if (report.status === 'interrupted') {
    const parts = ['恢复被中断：原记录已保留'];
    if (report.tabsRestored > 0) parts.push(`本次恢复了 ${report.tabsRestored} 个文件标签`);
    if (report.draftsPending > 0) parts.push(`${report.draftsPending} 个未保存内容未自动恢复`);
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
  return parts.join('；');
}

export function createWorkspaceRestorer(deps: RestoreDeps): WorkspaceRestorer {
  let epoch = 0;
  let running: Promise<RestoreReport> | null = null;
  let report: RestoreReport | null = null;
  let hints: PersistedTab[] = [];
  let pending: PersistedTab[] = [];

  const isCurrent = (token: number): boolean => epoch === token;

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
    interrupted: boolean;
  }

  /** 阶段 C：逐个核对并后台重建标签。单个失败只记录，不中断。 */
  async function restoreTabs(snapshot: PersistedWorkspaceV1, token: number): Promise<TabOutcome> {
    const restored: RestoredTab[] = [];
    const skipped: RestoreSkip[] = [];
    const hintList: PersistedTab[] = [];
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

      const nodes: readonly ResourceNodeState[] =
        tab.projectId === null
          ? state.resources
          : state.resourcesByProject[tab.projectId] ?? [];
      const node = findNodeByPath(nodes, tab.path);
      if (!node) {
        // 文件不存在 / 不在本次树里：不自动创建、不回退到别的项目的同名文件
        skipped.push({ projectId: tab.projectId, path: tab.path, reason: 'file-missing' });
        continue;
      }

      const outcome = await deps.openInBackground(node, tab.projectId);

      // 打开期间被接管：这条已经登记成标签就算恢复成功，否则记为未处理
      if (!isCurrent(token) || deps.getMode() !== 'live') {
        const latest = deps.getState().tabs.find((item) => item.docId === outcome.docId);
        if (outcome.ok && latest) {
          restored.push({ index, docId: outcome.docId, dirty: latest.dirty });
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
    }

    return {
      restored,
      skipped,
      draftsPending,
      hints: hintList,
      pending: [],
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
      const interrupted = emptyReport({
        status: 'interrupted',
        reason: 'superseded',
        tabsRequested: snapshot.tabs.length,
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
      const interrupted = emptyReport({
        status: 'interrupted',
        reason: 'superseded',
        workspaceKeyMatched: true,
        uiRestored: true,
        tabsRequested: snapshot.tabs.length,
        tabsRestored: result.restored.length,
        draftsPending: result.draftsPending,
        skipped: result.skipped,
      });
      const next = { ...interrupted, notice: buildNotice(interrupted) };
      deps.dispatch({ type: 'NOTICE', message: next.notice });
      return settle(next, 'seal');
    }

    applyPanes(snapshot, result, token, baseline);

    const restoredReport = emptyReport({
      status: 'restored',
      reason: null,
      workspaceKeyMatched: true,
      uiRestored: true,
      tabsRequested: snapshot.tabs.length,
      tabsRestored: result.restored.length,
      draftsPending: result.draftsPending,
      skipped: result.skipped,
    });
    const next = { ...restoredReport, notice: buildNotice(restoredReport) };
    deps.dispatch({ type: 'NOTICE', message: next.notice });
    return settle(next, 'release');
  }

  return {
    restore() {
      if (running) return running;
      if (report) return Promise.resolve(report);
      running = run().then((value) => {
        report = value;
        return value;
      });
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
  };
}
