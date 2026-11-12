import { DEFAULT_EXPANDED } from '../data/demo-project';
import type { DocTab, LayoutMode, PaneId, WorkspaceAction, WorkspaceState } from './types';

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

    case 'OPEN_FILE': {
      const existing = state.tabs.find((tab) => tab.docId === action.docId);
      const tabs = existing
        ? state.tabs
        : [
            ...state.tabs,
            {
              docId: action.docId,
              path: action.path,
              title: action.title,
              kind: action.kind,
              buffer: action.content,
              dirty: false,
            },
          ];
      const pane = setPaneTarget(state, state.focusedPane);
      return {
        ...state,
        tabs,
        selectedPath: action.docId,
        panes: { ...state.panes, [pane]: { ...state.panes[pane], docId: action.docId } },
        notice: existing ? '已在标签中打开该文档' : `已打开（演示）：${action.title}`,
      };
    }

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
      return { ...state, tabs: remaining, panes, notice: '已关闭标签（演示缓冲丢弃）' };
    }

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
        notice: '左右分屏：左侧源码 / 右侧预览（演示）',
      };
    }

    case 'SET_SPLIT_RATIO':
      return { ...state, splitRatio: clampRatio(action.ratio) };

    case 'EDIT_DOC':
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.docId === action.docId ? { ...tab, buffer: action.text, dirty: true } : tab,
        ),
      };

    case 'DEMO_SAVE':
      return {
        ...state,
        tabs: state.tabs.map((tab) => (tab.docId === action.docId ? { ...tab, dirty: false } : tab)),
        notice: '演示保存：仅清除未保存标记，没有写入任何磁盘文件',
      };

    case 'NOTICE':
      return { ...state, notice: action.message };

    default:
      return state;
  }
}
