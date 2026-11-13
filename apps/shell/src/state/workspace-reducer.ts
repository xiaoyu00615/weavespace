import { DEFAULT_EXPANDED } from '../data/demo-project.ts';
import type {
  DocTab,
  LayoutMode,
  PaneId,
  ResourceNodeState,
  WorkspaceAction,
  WorkspaceState,
} from './types.ts';

const MIN_RATIO = 25;
const MAX_RATIO = 75;

export const INITIAL_STATE: WorkspaceState = {
  navCollapsed: false,
  navKey: 'projects',
  treeCollapsed: false,
  expanded: { ...DEFAULT_EXPANDED },
  selectedPath: null,
  tabs: [],
  panes: {
    primary: { docId: null, mode: 'editor' },
    secondary: { docId: null, mode: 'preview' },
  },
  focusedPane: 'primary',
  layout: 'single',
  splitRatio: 50,
  auxCollapsed: true,
  auxTab: 'ai',
  notice: '演示数据：不读取、不写入本机文件',
  mode: 'demo',
  resources: [],
  loadingResources: false,
  workspaceMode: 'legacy',
  projects: [],
  activeProjectId: null,
  resourcesByProject: {},
  expandedByProject: {},
  selectedByProject: {},
  loadingByProject: {},
};

function clampRatio(value: number): number {
  if (Number.isNaN(value)) return 50;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, Math.round(value)));
}

/** 关闭标签后为窗格挑选替代文档：优先右侧邻居，其次左侧，最后为空。 */
function pickFallback(tabs: DocTab[], removedIndex: number): string | null {
  if (tabs.length === 0) return null;
  const next = tabs[removedIndex] ?? tabs[removedIndex - 1];
  return next ? next.docId : null;
}

function setPaneTarget(state: WorkspaceState, pane: PaneId): PaneId {
  // 单视图模式下一切操作都落在主窗格，避免出现“看不见的活动窗格”。
  return state.layout === 'single' ? 'primary' : pane;
}

/** 进入 live 时自动展开一级目录，避免首屏全是收起状态。 */
function defaultExpandedFor(nodes: ResourceNodeState[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const node of nodes) {
    if (node.kind === 'folder') out[node.id] = true;
  }
  return out;
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'TOGGLE_NAV':
      return { ...state, navCollapsed: !state.navCollapsed };

    case 'SET_NAV_KEY':
      return { ...state, navKey: action.key };

    case 'TOGGLE_TREE':
      return { ...state, treeCollapsed: !state.treeCollapsed };

    case 'TOGGLE_AUX':
      return { ...state, auxCollapsed: !state.auxCollapsed };

    case 'SET_AUX_TAB':
      return { ...state, auxTab: action.tab, auxCollapsed: false };

    case 'TOGGLE_NODE':
      return {
        ...state,
        expanded: { ...state.expanded, [action.path]: !state.expanded[action.path] },
      };

    case 'SET_MODE': {
      if (action.mode === state.mode) return state;
      return {
        ...state,
        mode: action.mode,
        // 切换模式等于换一个工作区：未保存内容不允许被静默丢弃，调用方需先拦截
        tabs: [],
        resources: [],
        selectedPath: null,
        expanded: action.mode === 'demo' ? { ...DEFAULT_EXPANDED } : {},
        // 项目维度状态同样属于"上一个工作区"
        projects: [],
        activeProjectId: null,
        resourcesByProject: {},
        expandedByProject: {},
        selectedByProject: {},
        loadingByProject: {},
        workspaceMode: 'legacy',
        panes: {
          primary: { docId: null, mode: 'editor' },
          secondary: { docId: null, mode: 'preview' },
        },
        notice:
          action.mode === 'live'
            ? '真实文件模式：读取本机测试项目（写入经 Core）'
            : '演示数据：不读取、不写入本机文件',
      };
    }

    case 'SET_RESOURCES':
      return {
        ...state,
        resources: action.nodes,
        expanded:
          Object.keys(state.expanded).length === 0
            ? defaultExpandedFor(action.nodes)
            : state.expanded,
      };

    case 'SET_LOADING_RESOURCES':
      return { ...state, loadingResources: action.loading };

    case 'OPEN_TAB': {
      const existing = state.tabs.find((tab) => tab.docId === action.tab.docId);
      const tabs = existing
        ? state.tabs.map((tab) => (tab.docId === action.tab.docId ? { ...tab, ...action.tab } : tab))
        : [...state.tabs, action.tab];
      const pane = setPaneTarget(state, state.focusedPane);
      return {
        ...state,
        tabs,
        selectedPath: action.tab.docId,
        panes: { ...state.panes, [pane]: { ...state.panes[pane], docId: action.tab.docId } },
        notice: existing
          ? '已在标签中打开该文档'
          : `已打开（${action.tab.mode === 'live' ? '真实文件' : '演示'}）：${action.tab.title}`,
      };
    }

    case 'TAB_PATCH':
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.docId === action.docId ? { ...tab, ...action.patch } : tab,
        ),
      };

    case 'ACTIVATE_TAB': {
      const pane = setPaneTarget(state, state.focusedPane);
      return {
        ...state,
        panes: { ...state.panes, [pane]: { ...state.panes[pane], docId: action.docId } },
      };
    }

    case 'CLOSE_TAB': {
      const index = state.tabs.findIndex((tab) => tab.docId === action.docId);
      if (index < 0) return state;
      const remaining = state.tabs.filter((tab) => tab.docId !== action.docId);
      const fallback = pickFallback(remaining, index);
      const panes = { ...state.panes };
      (['primary', 'secondary'] as const).forEach((pane) => {
        if (panes[pane].docId === action.docId) {
          panes[pane] = { ...panes[pane], docId: fallback };
        }
      });
      return { ...state, tabs: remaining, panes, notice: '已关闭标签' };
    }

    case 'SAVE_RESULT':
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.docId === action.docId
            ? {
                ...tab,
                saving: false,
                dirty: action.dirty,
                lastStatus: action.status,
                errorCode: action.errorCode,
                documentState: action.documentState ?? tab.documentState,
                baseVersion: action.baseVersion ?? tab.baseVersion,
                revision: action.revision ?? tab.revision,
              }
            : tab,
        ),
        notice: action.notice,
      };

    case 'SET_PANE_MODE':
      return {
        ...state,
        panes: { ...state.panes, [action.pane]: { ...state.panes[action.pane], mode: action.mode } },
      };

    case 'FOCUS_PANE': {
      if (state.layout === 'single' && action.pane === 'secondary') return state;
      return { ...state, focusedPane: action.pane };
    }

    case 'SET_LAYOUT': {
      const layout: LayoutMode = action.layout;
      if (layout === 'single') {
        return { ...state, layout, focusedPane: 'primary', notice: '单视图' };
      }
      const anchor = state.panes.primary.docId ?? state.tabs[0]?.docId ?? null;
      return {
        ...state,
        layout,
        focusedPane: 'primary',
        panes: {
          primary: { ...state.panes.primary, docId: state.panes.primary.docId ?? anchor },
          secondary: { docId: state.panes.secondary.docId ?? anchor, mode: 'preview' },
        },
        notice: '左右分屏：左侧源码 / 右侧预览',
      };
    }

    case 'SET_SPLIT_RATIO':
      return { ...state, splitRatio: clampRatio(action.ratio) };

    case 'EDIT_DOC':
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.docId === action.docId
            ? {
                ...tab,
                buffer: action.text,
                dirty: true,
                documentState:
                  tab.documentState === 'SAVING' ? 'SAVING' : tab.documentState === 'DEMO' ? 'DEMO' : 'EDITING_DIRTY',
              }
            : tab,
        ),
      };

    // ---- 多项目（G2-05）----
    case 'SET_WORKSPACE_MODE':
      return state.workspaceMode === action.workspaceMode
        ? state
        : { ...state, workspaceMode: action.workspaceMode };

    case 'SET_PROJECTS': {
      const projects = action.projects;
      const stillThere = state.activeProjectId
        ? projects.some((project) => project.projectId === state.activeProjectId)
        : false;
      // 默认选中第一个 READY 项目；没有 READY 就保持为空（不伪造可用项目）
      const fallback = projects.find((project) => project.status === 'READY')?.projectId ?? null;
      return {
        ...state,
        projects,
        activeProjectId: stillThere ? state.activeProjectId : fallback,
      };
    }

    case 'SET_ACTIVE_PROJECT':
      // 只切"当前项目"：不清空 tabs、不动其他项目的资源树/展开状态/草稿
      return state.activeProjectId === action.projectId
        ? state
        : { ...state, activeProjectId: action.projectId };

    case 'SET_PROJECT_RESOURCES': {
      const previous = state.expandedByProject[action.projectId];
      return {
        ...state,
        resourcesByProject: { ...state.resourcesByProject, [action.projectId]: action.nodes },
        expandedByProject: {
          ...state.expandedByProject,
          [action.projectId]:
            previous && Object.keys(previous).length > 0
              ? previous
              : defaultExpandedFor(action.nodes),
        },
      };
    }

    case 'SET_PROJECT_LOADING':
      return {
        ...state,
        loadingByProject: { ...state.loadingByProject, [action.projectId]: action.loading },
      };

    case 'TOGGLE_PROJECT_NODE': {
      const current = state.expandedByProject[action.projectId] ?? {};
      return {
        ...state,
        expandedByProject: {
          ...state.expandedByProject,
          [action.projectId]: { ...current, [action.path]: !current[action.path] },
        },
      };
    }

    case 'SELECT_PROJECT_NODE':
      return {
        ...state,
        selectedByProject: {
          ...state.selectedByProject,
          [action.projectId]: action.path,
        },
      };

    case 'NOTICE':
      return { ...state, notice: action.message };

    default:
      return state;
  }
}
