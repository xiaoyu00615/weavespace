/**
 * 启动恢复（S11-C）。
 *
 * 分阶段执行，每一步都可能降级，但**绝不虚构成功**：
 *
 * A. 界面局部：折叠状态、布局、分屏比例、查看模式、展开状态（裁到真实存在的目录）。
 * B. 校验 Host：拿工作区摘要、工作区模式、项目列表与 READY 状态（一律以服务器本次结果为准）。
 * C. 重建文件标签：逐个项目/路径核对，再走**现有的打开流程**拿到新的 sessionId / viewId。
 *
 * 三条纪律：
 * 1. 摘要不一致（换根、根被替换、项目组合变化）→ 只保留界面，不碰任何文件；
 * 2. 标签一律**后台登记**（`OPEN_TAB_BACKGROUND`），只有全部恢复完、且用户没有新交互时
 *    才把窗格指回原来的位置——恢复不能抢焦点（继承 G2-R2）；
 * 3. 单个文件失败只跳过它，不影响其余文件；迟到响应交由打开流程的模式守卫处理并释放 View。
 *
 * 这里不做：A2 的动态重绑定、STALE 会话回收、草稿正文持久化、`/api/edit|save|reload`。
 */
import type { OpenNodeResult } from './open-document.ts';
import type { ClientMode, ResourceNodeState, WorkspaceAction, WorkspaceState } from './types.ts';
import type { WorkspaceMode } from '../client/client-api.ts';
import {
  folderIdsOf,
  pruneExpanded,
  uiRestoreOf,
  type PersistedPane,
  type PersistedWorkspaceV1,
  type WorkspaceStore,
} from './workspace-persistence.ts';

export type RestoreSkipReason =
  | 'project-missing'
  | 'project-unavailable'
  | 'file-missing'
  | 'open-rejected'
  | 'mode-changed';

export interface RestoreSkip {
  projectId: string | null;
  path: string;
  reason: RestoreSkipReason;
  errorCode?: string | null;
}

export type RestoreStatus = 'empty' | 'ui-only' | 'restored';
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
  /** 有未确认内容、并且**确实**由服务端会话重新取回（Core 里那份草稿还在）。 */
  draftsRecovered: number;
  /** 有未确认内容、但恢复后是干净标签：内容没有恢复，不得宣称成功。 */
  draftsLost: number;
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
  /** 连接 Host 并加载项目/资源；不可用时返回 null（此时只恢复界面）。 */
  connectLive(): Promise<ConnectedWorkspace | null>;
  /** 后台打开：复用 open-document 的并发合并、模式守卫与 View 释放。 */
  openInBackground(node: ResourceNodeState, projectId: string | null): Promise<OpenNodeResult>;
}

export interface WorkspaceRestorer {
  /** 启动恢复。幂等：并发/重复调用返回同一个 Promise（StrictMode 不会重建 View）。 */
  restore(): Promise<RestoreReport>;
  /** 用户主动操作：此后的窗格指回必须放弃（标签本身仍继续后台登记）。 */
  noteInteraction(): void;
  lastReport(): RestoreReport | null;
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

function emptyReport(overrides: Partial<RestoreReport> = {}): RestoreReport {
  return {
    status: 'empty',
    reason: null,
    workspaceKeyMatched: false,
    uiRestored: false,
    tabsRequested: 0,
    tabsRestored: 0,
    draftsRecovered: 0,
    draftsLost: 0,
    skipped: [],
    notice: '',
    ...overrides,
  };
}

function buildNotice(report: RestoreReport): string {
  if (report.status === 'empty') return '没有找到可恢复的工作区记录';
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
  if (report.draftsRecovered > 0) parts.push(`${report.draftsRecovered} 个未保存修改由服务端会话重新取得`);
  if (report.draftsLost > 0) parts.push(`${report.draftsLost} 个未保存内容未自动恢复`);
  return parts.join('；');
}

export function createWorkspaceRestorer(deps: RestoreDeps): WorkspaceRestorer {
  let epoch = 0;
  let running: Promise<RestoreReport> | null = null;
  let report: RestoreReport | null = null;

  const isCurrent = (token: number): boolean => epoch === token;

  /** 阶段 A：界面局部。展开状态必须用**本次加载的树**裁剪。 */
  function applyUi(snapshot: PersistedWorkspaceV1, expanded: Record<string, Record<string, boolean>> | null): void {
    deps.dispatch({
      type: 'HYDRATE_UI',
      ui: uiRestoreOf(snapshot),
      ...(expanded ? { expandedByProject: expanded } : {}),
    });
    const active = snapshot.activeProjectId;
    if (active && deps.getState().projects.some((project) => project.projectId === active)) {
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

  /** 阶段 C：逐个核对并后台重建标签。单个失败只记录，不中断。 */
  async function restoreTabs(snapshot: PersistedWorkspaceV1): Promise<{
    restored: RestoredTab[];
    skipped: RestoreSkip[];
    draftsRecovered: number;
    draftsLost: number;
  }> {
    const restored: RestoredTab[] = [];
    const skipped: RestoreSkip[] = [];
    let draftsRecovered = 0;
    let draftsLost = 0;

    for (const [index, tab] of snapshot.tabs.entries()) {
      // 模式被切走：剩下的都不属于当前工作区了（在途请求由打开流程释放 View）
      if (deps.getMode() !== 'live') {
        skipped.push({ projectId: tab.projectId, path: tab.path, reason: 'mode-changed' });
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
      if (tab.hadUnsavedChanges) {
        // 只有 Core 真的还持有那份草稿时才算"重新取得"；否则明确算作未恢复
        if (dirty) draftsRecovered += 1;
        else draftsLost += 1;
      }
      restored.push({ index, docId: outcome.docId, dirty });
    }

    return { restored, skipped, draftsRecovered, draftsLost };
  }

  /** 阶段 C 收尾：把窗格指回原来的位置（只有用户没动过焦点时才做）。 */
  function applyPanes(
    snapshot: PersistedWorkspaceV1,
    restored: RestoredTab[],
    token: number,
  ): void {
    if (!isCurrent(token)) return;
    if (deps.getMode() !== 'live') return;
    if (deps.getState().workspaceKey !== snapshot.workspaceKey) return;

    const docOf = (pane: PersistedPane): string | null =>
      pane.tabIndex === null
        ? null
        : restored.find((item) => item.index === pane.tabIndex)?.docId ?? null;

    deps.dispatch({
      type: 'SET_PANE_TAB',
      pane: 'primary',
      docId: docOf(snapshot.panes.primary),
      mode: snapshot.panes.primary.mode,
    });
    if (snapshot.ui.layout === 'vertical') {
      deps.dispatch({
        type: 'SET_PANE_TAB',
        pane: 'secondary',
        docId: docOf(snapshot.panes.secondary),
        mode: snapshot.panes.secondary.mode,
      });
      deps.dispatch({ type: 'FOCUS_PANE', pane: snapshot.ui.focusedPane });
    }
  }

  async function run(): Promise<RestoreReport> {
    const snapshot = deps.store.readLast();
    if (!snapshot) {
      const empty = emptyReport({ reason: 'no-snapshot', notice: '' });
      return { ...empty, notice: buildNotice(empty) };
    }

    const token = epoch;
    const connected = await deps.connectLive().catch(() => null);

    if (!connected || deps.getMode() !== 'live') {
      applyUi(snapshot, null);
      const uiOnly = emptyReport({
        status: 'ui-only',
        reason: 'host-unavailable',
        uiRestored: true,
        tabsRequested: snapshot.tabs.length,
      });
      const next = { ...uiOnly, notice: buildNotice(uiOnly) };
      deps.dispatch({ type: 'NOTICE', message: next.notice });
      return next;
    }

    const matched =
      connected.workspaceKey !== null && connected.workspaceKey === snapshot.workspaceKey;
    applyUi(snapshot, matched ? expandedFromState(snapshot) : null);

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
      return next;
    }

    const { restored, skipped, draftsRecovered, draftsLost } = await restoreTabs(snapshot);
    applyPanes(snapshot, restored, token);

    const result = emptyReport({
      status: 'restored',
      reason: null,
      workspaceKeyMatched: true,
      uiRestored: true,
      tabsRequested: snapshot.tabs.length,
      tabsRestored: restored.length,
      draftsRecovered,
      draftsLost,
      skipped,
    });
    const next = { ...result, notice: buildNotice(result) };
    deps.dispatch({ type: 'NOTICE', message: next.notice });
    return next;
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
  };
}
