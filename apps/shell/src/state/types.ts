/** 工作台状态模型（S9-A）。只描述 UI/布局与演示缓冲，不涉及 Core 的会话或磁盘。 */

export type ViewMode = 'editor' | 'preview';
export type LayoutMode = 'single' | 'vertical';
export type PaneId = 'primary' | 'secondary';
export type AuxTab = 'ai' | 'tasks' | 'diagnostics';
export type NavKey = 'projects' | 'plugins' | 'diagnostics';

export type DocumentKind = 'markdown' | 'text';

/** 已打开文档的标签（每个文档一份缓冲，供多个视图共享）。 */
export interface DocTab {
  docId: string;
  path: string;
  title: string;
  kind: DocumentKind;
  /** 编辑缓冲：演示态，不写盘。 */
  buffer: string;
  dirty: boolean;
}

export interface PaneState {
  docId: string | null;
  mode: ViewMode;
}

export interface WorkspaceState {
  navCollapsed: boolean;
  navKey: NavKey;
  treeCollapsed: boolean;
  /** 文件树展开状态：目录路径 → 是否展开。 */
  expanded: Record<string, boolean>;
  selectedPath: string | null;
  tabs: DocTab[];
  panes: Record<PaneId, PaneState>;
  focusedPane: PaneId;
  layout: LayoutMode;
  /** 左窗格占比（%），限制在 25–75，保证两侧都可读。 */
  splitRatio: number;
  auxCollapsed: boolean;
  auxTab: AuxTab;
  /** 状态栏里的一行提示（演示模式提示等）。 */
  notice: string;
}

export type WorkspaceAction =
  | { type: 'TOGGLE_NAV' }
  | { type: 'SET_NAV_KEY'; key: NavKey }
  | { type: 'TOGGLE_TREE' }
  | { type: 'TOGGLE_AUX' }
  | { type: 'SET_AUX_TAB'; tab: AuxTab }
  | { type: 'TOGGLE_NODE'; path: string }
  | { type: 'OPEN_FILE'; docId: string; path: string; title: string; kind: DocumentKind; content: string }
  | { type: 'ACTIVATE_TAB'; docId: string }
  | { type: 'CLOSE_TAB'; docId: string }
  | { type: 'SET_PANE_MODE'; pane: PaneId; mode: ViewMode }
  | { type: 'FOCUS_PANE'; pane: PaneId }
  | { type: 'SET_LAYOUT'; layout: LayoutMode }
  | { type: 'SET_SPLIT_RATIO'; ratio: number }
  | { type: 'EDIT_DOC'; docId: string; text: string }
  | { type: 'DEMO_SAVE'; docId: string }
  | { type: 'NOTICE'; message: string };
