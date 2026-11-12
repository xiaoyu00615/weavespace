/** 工作台状态模型（S9-A / S9-B）。布局与缓冲属于 UI；会话与版本以 Core 为准。 */

export type ViewMode = 'editor' | 'preview';
export type LayoutMode = 'single' | 'vertical';
export type PaneId = 'primary' | 'secondary';
export type AuxTab = 'ai' | 'tasks' | 'diagnostics';
export type NavKey = 'projects' | 'plugins' | 'diagnostics';

export type DocumentKind = 'markdown' | 'text';

/** demo：内置演示数据，绝不写盘；live：经 localhost API 读写真实文件。 */
export type ClientMode = 'demo' | 'live';

export interface ResourceNodeState {
  id: string;
  name: string;
  kind: 'folder' | 'markdown' | 'text';
  path?: string;
  children?: ResourceNodeState[];
}

export type SaveUiStatus = 'COMMITTED' | 'CONFLICT' | 'FAILED' | 'UNKNOWN' | 'DEMO' | null;

/**
 * 已打开文档的标签（每个文档一份缓冲，供多个视图共享）。
 *
 * `buffer` 是编辑器的即时草稿；`sessionId/baseVersion/revision/documentState`
 * 是 Core 的权威状态（live 模式下由服务端返回，UI 不得自行推断）。
 */
export interface DocTab {
  docId: string;
  path: string;
  title: string;
  kind: DocumentKind;
  buffer: string;
  dirty: boolean;
  mode: ClientMode;
  sessionId: string | null;
  viewId: string | null;
  baseVersion: string | null;
  revision: number;
  /** CLEAN | EDITING_DIRTY | SAVING | CONFLICT | FAILED | OUTCOME_UNKNOWN（demo 为 DEMO） */
  documentState: string;
  saving: boolean;
  /** 最近一次保存的服务端结论，用于明确反馈；null 表示本次会话还没保存过。 */
  lastStatus: SaveUiStatus;
  errorCode: string | null;
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
  /** 状态栏里的一行提示。 */
  notice: string;
  mode: ClientMode;
  /** live 模式下的服务端资源树；demo 模式继续使用内置演示树。 */
  resources: ResourceNodeState[];
  loadingResources: boolean;
}

export type WorkspaceAction =
  | { type: 'TOGGLE_NAV' }
  | { type: 'SET_NAV_KEY'; key: NavKey }
  | { type: 'TOGGLE_TREE' }
  | { type: 'TOGGLE_AUX' }
  | { type: 'SET_AUX_TAB'; tab: AuxTab }
  | { type: 'TOGGLE_NODE'; path: string }
  | { type: 'SET_MODE'; mode: ClientMode }
  | { type: 'SET_RESOURCES'; nodes: ResourceNodeState[] }
  | { type: 'SET_LOADING_RESOURCES'; loading: boolean }
  | { type: 'OPEN_TAB'; tab: DocTab }
  | { type: 'TAB_PATCH'; docId: string; patch: Partial<Omit<DocTab, 'docId'>> }
  | { type: 'ACTIVATE_TAB'; docId: string }
  | { type: 'CLOSE_TAB'; docId: string }
  | {
      type: 'SAVE_RESULT';
      docId: string;
      status: SaveUiStatus;
      errorCode: string | null;
      dirty: boolean;
      documentState: string | null;
      baseVersion: string | null;
      revision: number | null;
      notice: string;
    }
  | { type: 'SET_PANE_MODE'; pane: PaneId; mode: ViewMode }
  | { type: 'FOCUS_PANE'; pane: PaneId }
  | { type: 'SET_LAYOUT'; layout: LayoutMode }
  | { type: 'SET_SPLIT_RATIO'; ratio: number }
  | { type: 'EDIT_DOC'; docId: string; text: string }
  | { type: 'NOTICE'; message: string };
