/** 工作台状态模型（S9-A / S9-B / G2）。布局与缓冲属于 UI；会话与版本以 Core 为准。 */
import type { ProjectSummary, TrashEntryDto, TreeEntry, WorkspaceMode } from '../client/client-api.ts';
import type { TreeLevels } from '../components/tree-model.ts';

export type ViewMode = 'editor' | 'preview';
export type LayoutMode = 'single' | 'vertical';
export type PaneId = 'primary' | 'secondary';
export type AuxTab = 'ai' | 'tasks' | 'diagnostics';
/**
 * 一级导航。`trash` 是回收区（UX-02C-03-P2-02）：
 *
 * 它和 `projects` 共用**同一个项目上下文**（`activeProjectId`），因此切换项目时
 * 回收区跟着换数据；切到 Demo/Live 时整块按模式重新判定，不沿用旧项目的记录。
 */
export type NavKey = 'projects' | 'plugins' | 'trash' | 'diagnostics';

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
  /**
   * 该行**自身**有隐藏记录（UX-02C-03-P1）。
   *
   * 只有"显示隐藏项"打开时才会出现；它是展示状态，不是权限状态：
   * 隐藏的文件照样能打开、能保存（已打开的标签完全不受影响）。
   */
  hidden?: boolean;
  /** 自身没有记录，但上级目录被隐藏：值是那个上级的相对路径。 */
  hiddenBy?: string;
  /**
   * 资源展示元数据（UX-02C-04）：标注名 / 标签 / 行颜色。
   *
   * 只是**展示**：它不影响真实名称、扩展名、打开/保存/移动等任何真实操作。
   * 缺省 = 没有标注（Host 不会下发空对象）。
   */
  meta?: {
    alias?: string;
    tags: string[];
    color?: string;
  };
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

/**
 * 某个项目的回收区视图状态（UX-02C-03-P2-02）。
 *
 * 按项目分桶存放：项目 A 的记录永远不会被渲染在项目 B 的入口下。
 * `loaded=false` 表示"还没成功读过"——与"回收区是空的"必须区分：
 * 前者要显示"加载中/重试"，后者才能说"没有可恢复的文件"。
 */
/**
 * 回收记录的**终态**（UX-02C-03-P2-02-R1）。
 *
 * 只有这些状态代表"这件事已经有结论，不需要再等"：
 * `pending` / `stored` / `restoring` 都还可能是"没做完"，拿它们当结论就会
 * 把一条还能再动的记录重新开放成可恢复。
 *
 * 用 `Set<string>` 而不是字面量元组：这里只做"是不是终态"的判定，
 * 不需要把七态的类型关系再引入一层。
 */
export const TRASH_TERMINAL_STATES: ReadonlySet<string> = new Set([
  'restored',
  'aborted',
  'conflicted',
  'missing',
]);

export interface TrashProjectState {  readonly entries: readonly TrashEntryDto[];
  readonly count: number;
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  /**
   * 正在恢复的 `opId`（可以同时有多条：不同文件互不阻塞）。
   *
   * 用集合而不是单个 `busyOpId`：控制器本来就按 opId 分键单飞，状态层只能比它更宽，
   * 不能比它更窄——否则并发恢复两个文件时，先完成的那个会把另一个的在途状态抹掉。
   */
  readonly busyOpIds: readonly string[];
  /**
   * 每条在途恢复**属于哪个工作区身份**（`opId → 身份键`，UX-02C-03-P2-02-R1.2）。
   *
   * 只有发起这次恢复的那个身份才有资格结束它：A 的旧请求在切到 B（甚至 A→B→A）之后
   * 才回来时，`finally` 里的 `TRASH_BUSY(busy=false)` 带的还是 A 的身份，
   * 与这里存的键不相等，于是被丢弃——B 的同名在途标记不会被别人顺手清掉。
   * 键的定义与编排层的 `identityKeyOf` 完全一致（mode + workspaceMode + workspaceKey + epoch）。
   */
  readonly busyOwners: Record<string, string>;
  /**
   * 结果未确认、核对完成前**禁止再次操作**的 `opId`。
   *
   * 与 `busyOpIds` 分开：在途是"请求还没回来"，这里是"请求回来了但结论不可用"
   * （UNKNOWN，或 APPLIED 之后列表刷新失败/记录不在终态）。两者的界面用语不同，
   * 但都必须让恢复按钮保持禁用——重复恢复会真的再动一次磁盘。
   */
  readonly unconfirmedOpIds: readonly string[];
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
  /**
   * 是否在文件树里显示隐藏项（UX-02C-03-P1）。
   *
   * 这是**视图开关**，不是持久化配置：它决定下一次 `/api/tree` 是否带
   * `includeHidden=1`。隐藏记录本身在 Host 的工作区配置里，与它无关。
   */
  showHidden: boolean;
  /**
   * 每个项目的回收区（UX-02C-03-P2-02）。键是 `projectId`。
   *
   * 只存**Host 明确返回**的记录；任何写入都必须先通过编排层的归属核对，
   * 迟到的响应不得落到这里。
   */
  trashByProject: Record<string, TrashProjectState>;
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
  /**
   * 单个项目的摘要被 Host 改写（当前只有「重命名显示名称」，UX-02B-04A）。
   *
   * 只替换这一个元素的**值**：`treeByProject` / 标签 / 草稿 / `activeProjectId`
   * 全部保持原引用，因此重命名既不会让树重新加载，也不会让展开状态回到默认。
   */
  | { type: 'PROJECT_RENAMED'; project: ProjectSummary }
  /**
   * 项目已从工作区移除（UX-02B-04B，Host 明确撤销后）。
   *
   * 从项目列表移除，并**清空该项目的全部树缓存**（层表 / 展开 / 选中 / 加载标记），
   * 防止迟到的目录请求用旧层表重新长出已移除项目的行。其它项目、标签与草稿
   * 一律不动（移除只解除注册与授权，不删除磁盘文件）。
   */
  | { type: 'PROJECT_REMOVED'; projectId: string }
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
      /** 本轮分页的目录快照标识（可选，兼容旧版响应与既有夹具）。 */
      snapshot?: string | null;
      /**
       * 本层隐藏条目数（UX-02C-03-P1-R1）。
       *
       * 语义是**这一层**（服务端在过滤前统计），不是全项目；调用方按层累计时必须
       * 如实说明"已加载目录层合计"。`undefined` 表示"本次响应没有该字段"（旧版
       * 服务端），与真实的 `0` 必须区别处理：缺失时保留上一次已知值。
       */
      hiddenCount?: number;
    }
  /** 该层加载失败：保留已加载条目，UI 显示"重试"。 */
  | { type: 'TREE_LEVEL_ERROR'; projectId: string; dir: string; errorCode: string | null }
  /** 刷新：只作废这一个项目的层表，其他项目引用不变。 */
  | { type: 'TREE_RESET'; projectId: string }
  /**
   * 切换"显示隐藏项"（UX-02C-03-P1）。
   *
   * 只改视图开关；层表必须由调用方 `TREE_RESET` 后重新拉取——已加载的层里
   * 没有隐藏条目，留着就会出现"点了开关却什么都没变"。
   */
  | { type: 'SET_SHOW_HIDDEN'; value: boolean }
  /* ---- UX-02C-03-P2-02：回收区 ---- */
  /** 开始读取某个项目的回收区（保留已有条目，避免列表闪空）。 */
  | { type: 'TRASH_LOAD_BEGIN'; projectId: string }
  | { type: 'TRASH_LOADED'; projectId: string; entries: readonly TrashEntryDto[]; count: number }
  | { type: 'TRASH_LOAD_ERROR'; projectId: string; errorCode: string | null; message: string }
  /**
   * 单飞标记：只增删对应的 `opId`，不影响同一项目里别的在途恢复。
   *
   * `scope` 是发起这次恢复的工作区身份键：`busy=false` 只在键相等时生效，
   * 因此旧工作区（或旧代次）的 `finally` 无法清掉当前工作区的在途标记。
   */
  | { type: 'TRASH_BUSY'; projectId: string; opId: string; busy: boolean; scope: string }
  /** 结果未确认标记：`pending=true` 时该记录禁止再次操作。 */
  | { type: 'TRASH_UNCONFIRMED'; projectId: string; opId: string; pending: boolean }
  /**
   * 结构变更已由 Host 明确确认（UX-02C-02）：删掉旧路径下的层与展开/选择记录。
   * 只动这一个项目；层表重新加载由 DocumentActions 负责。
   */
  | {
      type: 'TREE_STRUCTURE_CHANGED';
      projectId: string;
      sourcePath: string;
      targetPath: string;
    }
  | { type: 'TOGGLE_PROJECT_NODE'; projectId: string; path: string }
  /** 幂等展开（UX-02C-01）：创建成功后把目标文件夹打开，重复调用不会把它折叠回去。 */
  | { type: 'EXPAND_PROJECT_NODE'; projectId: string; path: string }
  /** 幂等展开（Demo / Legacy 单根）。 */
  | { type: 'EXPAND_NODE'; path: string }
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
