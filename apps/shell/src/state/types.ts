/** 工作台状态模型（S9-A / S9-B / G2）。布局与缓冲属于 UI；会话与版本以 Core 为准。 */
import type { ProjectSummary, TreeEntry, WorkspaceMode } from '../client/client-api.ts';
import type { TreeLevels } from '../components/tree-model.ts';

export type ViewMode = 'editor' | 'preview';
export type LayoutMode = 'single' | 'vertical';
export type PaneId = 'primary' | 'secondary';
export type AuxTab = 'ai' | 'tasks' | 'diagnostics';
export type NavKey = 'projects' | 'plugins' | 'diagnostics';

/**
 * 资源与文档只描述**事实**（是目录/是文件/是链接、扩展名），
 * 不描述「用哪个插件渲染」。查看器由能力注册表按扩展名解析（S10-A）。
 *
 * UX-02B-TREE：`link` 是"显示但不可用"的叶子——不可展开、不可打开、不可预览，
 * 目的是让符号链接/重解析点可见，同时不跟随它们越过项目根。
 */
export type ResourceEntryKind = 'folder' | 'file' | 'link';

/** demo：内置演示数据，绝不写盘；live：经 localhost API 读写真实文件。 */
export type ClientMode = 'demo' | 'live';

export interface ResourceNodeState {
  id: string;
  name: string;
  kind: ResourceEntryKind;
  /** 文件扩展名（小写含点）；目录为空。能力注册表据此选择查看器。 */
  extension?: string;
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
  /**
   * 所属项目（G2-06）。Multi 必填；Legacy / Demo 为 null。
   * 所有会话操作都以它为准，**不得**通过拆分 docId 反推项目。
   */
  projectId: string | null;
  path: string;
  title: string;
  /** 文件扩展名；决定预览用哪个查看器能力，而不是写死格式分支。 */
  extension: string;
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

/**
 * 可恢复的界面局部（S11-C 阶段 A）。
 *
 * 全部字段都与"会话/文件"无关：即使没有连上 Host、或工作区身份不匹配，
 * 套用这些字段也是安全的。定义放在这里（而不是持久化模块里），
 * 是为了让 reducer 不依赖存储层，避免循环引用。
 */
export interface WorkspaceUiSnapshot {
  navCollapsed: boolean;
  navKey: NavKey;
  treeCollapsed: boolean;
  auxCollapsed: boolean;
  auxTab: AuxTab;
  layout: LayoutMode;
  splitRatio: number;
  focusedPane: PaneId;
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

  // ---- 多项目（G2-05）----
  /** 服务端运行模式；demo 恒为 legacy。仅 multi 使用下面的项目表。 */
  workspaceMode: WorkspaceMode;
  /**
   * Host 的工作区摘要（S11-C）。**只用于匹配本地恢复记录**，不是授权凭据；
   * demo 模式或旧版服务端为 null（此时不写记录、不恢复文件标签）。
   */
  workspaceKey: string | null;
  /** 服务端返回的项目列表（含 UNAVAILABLE 与原因）；绝对不含本机路径。 */
  projects: ProjectSummary[];
  /** 当前操作焦点所在项目；切换它**不得**影响 tabs / 队列 / 草稿。 */
  activeProjectId: string | null;
  /** 每个项目独立的资源树 / 展开状态 / 选中项 / 加载状态。 */
  resourcesByProject: Record<string, ResourceNodeState[]>;
  /**
   * UX-02B-TREE：逐层文件树的**权威缓存**，按项目隔离。
   * 键 `''` 是 Legacy / Demo 的单根。
   * `resourcesByProject` / `resources` 是它的派生视图，只为兼容既有恢复链路与测试保留。
   */
  treeByProject: Record<string, TreeLevels>;
  expandedByProject: Record<string, Record<string, boolean>>;
  selectedByProject: Record<string, string | null>;
  loadingByProject: Record<string, boolean>;
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
  | { type: 'SET_WORKSPACE_MODE'; workspaceMode: WorkspaceMode }
  | { type: 'SET_WORKSPACE_KEY'; workspaceKey: string | null }
  /**
   * 套用持久化的界面局部（S11-C 阶段 A）。**不碰 tabs / panes / 会话 / 项目表**，
   * 因此可以在"只恢复界面"的降级路径里安全使用。
   */
  | { type: 'HYDRATE_UI'; ui: WorkspaceUiSnapshot; expandedByProject?: Record<string, Record<string, boolean>> }
  /**
   * 把某个窗格指向一个**已经存在**的标签（S11-C 恢复窗格用）。
   * 与 ACTIVATE_TAB 的区别：可以指定非焦点窗格，且 docId 不存在时整体忽略。
   */
  | { type: 'SET_PANE_TAB'; pane: PaneId; docId: string | null; mode?: ViewMode }
  | { type: 'SET_PROJECTS'; projects: ProjectSummary[] }
  | { type: 'SET_ACTIVE_PROJECT'; projectId: string }
  | { type: 'SET_PROJECT_RESOURCES'; projectId: string; nodes: ResourceNodeState[] }
  | { type: 'SET_PROJECT_LOADING'; projectId: string; loading: boolean }
  /**
   * UX-02B-TREE：开始加载某一层。`append=true` 表示继续加载下一页，
   * 已加载条目必须保留（否则用户会看到树突然清空）。
   */
  | { type: 'TREE_LEVEL_BEGIN'; projectId: string; dir: string; append: boolean }
  /** 合并一页结果，并重建该项目/单根的派生树视图。 */
  | {
      type: 'TREE_LEVEL_PAGE';
      projectId: string;
      dir: string;
      entries: readonly TreeEntry[];
      cursor: string | null;
      nextCursor: string | null;
      total: number;
    }
  /** 该层加载失败：保留已加载条目，UI 显示"重试"。 */
  | { type: 'TREE_LEVEL_ERROR'; projectId: string; dir: string; errorCode: string | null }
  /** 刷新：只作废这一个项目的层表，其他项目引用不变。 */
  | { type: 'TREE_RESET'; projectId: string }
  | { type: 'TOGGLE_PROJECT_NODE'; projectId: string; path: string }
  | { type: 'SELECT_PROJECT_NODE'; projectId: string; path: string | null }
  | { type: 'OPEN_TAB'; tab: DocTab }
  /**
   * 只登记标签，**不改**当前窗格/焦点（G2-R2）。
   * 迟到的打开响应在"用户已经换了项目/窗格/文档"时只能走这条路径。
   */
  | { type: 'OPEN_TAB_BACKGROUND'; tab: DocTab }
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
