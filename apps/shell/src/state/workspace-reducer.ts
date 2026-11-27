import { DEFAULT_EXPANDED } from '../data/demo-project.ts';
import {
  applyPage,
  beginLevel,
  emptyLevels,
  failLevel,
  invalidateLevel,
  materializeTree,
  resetLevels,
  type TreeLevels,
} from '../components/tree-model.ts';
import { TRASH_TERMINAL_STATES } from './types.ts';
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
  workspaceKey: null,
  projects: [],
  activeProjectId: null,
  resourcesByProject: {},
  treeByProject: {},
  expandedByProject: {},
  selectedByProject: {},
  loadingByProject: {},
  showHidden: false,
  trashByProject: {},
};

/**
 * 在 `opId` 集合里增删一项（UX-02C-03-P2-02-R1）。
 *
 * 返回 `null` 表示"本来就是这个状态"：reducer 因此可以返回同一个 `state`，
 * 既省掉一次重渲染，也让"重复派发同一个标记"不会产生看不出区别的新对象。
 * 用数组而不是 `Set`：状态要保持可序列化与值相等（快照/测试都直接比）。
 */
function toggleId(ids: readonly string[], opId: string, present: boolean): readonly string[] | null {
  const has = ids.includes(opId);
  if (present === has) return null;
  return present ? [...ids, opId] : ids.filter((item) => item !== opId);
}

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

/**
 * UX-02B-TREE：层表是权威数据，`resources` / `resourcesByProject` 是**派生视图**。
 *
 * 保留派生视图是为了不打断既有链路（启动恢复按树查文件、页脚计数、既有测试断言）。
 * 除这个函数外，任何地方都不允许直接写这两棵树，否则两份状态会漂移。
 * 展开状态刻意不动：懒加载下"默认全部展开"会把每个一级目录都立即拉一遍，
 * 那等于把按需展开退化成一次性的层级扫描。
 */
function withTreeLevels(state: WorkspaceState, projectId: string, levels: TreeLevels): WorkspaceState {
  const treeByProject = { ...state.treeByProject, [projectId]: levels };
  const derived = materializeTree(levels);
  if (projectId === '') {
    return { ...state, treeByProject, resources: derived };
  }
  return {
    ...state,
    treeByProject,
    resourcesByProject: { ...state.resourcesByProject, [projectId]: derived },
  };
}

/**
 * 首次拿到某个项目的根层时，沿用既有"默认一级目录展开"的用户可见行为
 * （`SET_PROJECT_RESOURCES` 一直如此，PC-08 依赖它）。
 *
 * 与旧实现的差别：这里只写展开标记，**不**把整棵子树塞进内存；
 * 展开的子层由 `TreeBranch` 在渲染时按需加载（仍然是一层一层取）。
 * 刷新时 expandedByProject 已存在，不会被重新填满。
 */
function withInitialExpansion(state: WorkspaceState, projectId: string): WorkspaceState {
  const derived = materializeTree(state.treeByProject[projectId]);
  if (projectId === '') {
    if (Object.keys(state.expanded).length > 0) return state;
    return { ...state, expanded: defaultExpandedFor(derived) };
  }
  const previous = state.expandedByProject[projectId];
  if (previous && Object.keys(previous).length > 0) return state;
  return {
    ...state,
    expandedByProject: {
      ...state.expandedByProject,
      [projectId]: defaultExpandedFor(derived),
    },
  };
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

    case 'EXPAND_NODE':
      if (state.expanded[action.path] === true) return state;
      return { ...state, expanded: { ...state.expanded, [action.path]: true } };

    case 'EXPAND_PROJECT_NODE': {
      const current = state.expandedByProject[action.projectId] ?? {};
      if (current[action.path] === true) return state;
      return {
        ...state,
        expandedByProject: {
          ...state.expandedByProject,
          [action.projectId]: { ...current, [action.path]: true },
        },
      };
    }

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
        treeByProject: {},
        expandedByProject: {},
        selectedByProject: {},
        loadingByProject: {},
        // 回收区缓存同样属于"上一个工作区"：旧项目的记录不得挂在新模式下面
        trashByProject: {},
        workspaceMode: 'legacy',
        // 工作区身份属于"上一个工作区"：切模式后必须重新从 Host 取得
        workspaceKey: null,
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

    /**
     * 后台登记标签（G2-R2）：标签出现，但当前窗格、焦点与选中项都不动。
     * 用于"请求发出后用户已经切走"的迟到响应——不能覆盖用户的新选择。
     */
    case 'OPEN_TAB_BACKGROUND': {
      if (state.tabs.some((tab) => tab.docId === action.tab.docId)) return state;
      return {
        ...state,
        tabs: [...state.tabs, action.tab],
        notice: `已在后台打开：${action.tab.title}（未切换当前文档）`,
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
    /**
     * 工作区模式（legacy / multi，UX-02C-03-P2-02-R1.1）。
     *
     * 模式是工作区身份的一部分：切到另一个模式后，同一个 `projectId` 可能指向
     * 完全不同的东西（legacy 里根本没有项目这一层）。回收区缓存必须整块丢弃，
     * 否则 legacy 界面会显示 multi 时期的记录。
     */
    case 'SET_WORKSPACE_MODE':
      return state.workspaceMode === action.workspaceMode
        ? state
        : { ...state, workspaceMode: action.workspaceMode, trashByProject: {} };

    /**
     * 工作区身份（UX-02C-03-P2-02-R1）。
     *
     * 键变了就是**另一个工作区**：即使项目 id 相同，回收记录也属于各自的磁盘，
     * 因此必须整块丢弃再重新读取。保留旧桶会让"A 工作区的 a.md"显示在 B 下面，
     * 而用户没有任何线索能看出那是别人的记录。
     */
    case 'SET_WORKSPACE_KEY':
      return state.workspaceKey === action.workspaceKey
        ? state
        : { ...state, workspaceKey: action.workspaceKey, trashByProject: {} };

    /**
     * 只恢复界面局部（S11-C 阶段 A）。
     * 刻意不触碰 tabs / panes / 会话 / 项目表：这些必须由 Host 的真实结果重建。
     */
    case 'HYDRATE_UI': {
      const { ui } = action;
      return {
        ...state,
        navCollapsed: ui.navCollapsed,
        navKey: ui.navKey,
        treeCollapsed: ui.treeCollapsed,
        auxCollapsed: ui.auxCollapsed,
        auxTab: ui.auxTab,
        layout: ui.layout,
        splitRatio: clampRatio(ui.splitRatio),
        // 单视图只有主窗格：不接受"焦点在副窗格"这种不可见的组合
        focusedPane: ui.layout === 'single' ? 'primary' : ui.focusedPane,
        expandedByProject: action.expandedByProject ?? state.expandedByProject,
      };
    }

    case 'SET_PANE_TAB': {
      const pane = state.panes[action.pane];
      if (!action.docId) {
        return { ...state, panes: { ...state.panes, [action.pane]: { ...pane, docId: null } } };
      }
      // 只允许指向真实存在的标签：恢复不能让窗格指向一个不存在的文档
      if (!state.tabs.some((tab) => tab.docId === action.docId)) return state;
      return {
        ...state,
        panes: {
          ...state.panes,
          [action.pane]: { docId: action.docId, mode: action.mode ?? pane.mode },
        },
      };
    }

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

    /**
     * 只改一个项目的显示名称（UX-02B-04A）。
     *
     * 刻意不复用 `SET_PROJECTS`：那会重算 `activeProjectId`，而重命名根本没改变
     * 项目集合，也不该让"当前项目"跳到别的项目上去。`treeByProject` 原样保留 ——
     * 名字是显示属性，不是层表键，重命名不该触发任何文件读取。
     */
    case 'PROJECT_RENAMED': {
      const index = state.projects.findIndex((project) => project.projectId === action.project.projectId);
      // 列表里没有这个项目（例如刚被移除）：忽略，不凭空插入一行
      if (index < 0) return state;
      const projects = state.projects.slice();
      projects[index] = action.project;
      return { ...state, projects };
    }

    case 'SET_ACTIVE_PROJECT':
      // 只切"当前项目"：不清空 tabs、不动其他项目的资源树/展开状态/草稿
      return state.activeProjectId === action.projectId
        ? state
        : { ...state, activeProjectId: action.projectId };

    /**
     * 项目已移除（UX-02B-04B）：从列表移除 + 清空该项目的树缓存。
     *
     * 只动这一个项目：其它项目的树、标签、草稿、选择状态保持原引用。
     * 清空层表是防止"迟到的目录响应"在移除之后用旧层表重新长出该项目行
     * （配合 `treeLoader.invalidateProject` 的在途作废形成双保险）。
     */
    case 'PROJECT_REMOVED': {
      const removed = action.projectId;
      const projects = state.projects.filter((project) => project.projectId !== removed);
      const drop = <T,>(record: Record<string, T>): Record<string, T> => {
        if (!(removed in record)) return record;
        const next = { ...record };
        delete next[removed];
        return next;
      };
      const fallback = projects.find((project) => project.status === 'READY')?.projectId ?? null;
      /**
       * 被移除项目的标签必须一起收掉（R1-03）。
       *
       * 否则下一次自动保存会把"已不存在项目的标签"写进新摘要的记录里：下次启动
       * 逐个重开时必然失败，用户会看到一批打不开的标签。其它项目的标签、
       * 草稿与选中状态**原样保留**——这里只按 `projectId` 精确过滤。
       */
      const tabs = state.tabs.filter((tab) => tab.projectId !== removed);
      const panes = { ...state.panes };
      if (tabs.length !== state.tabs.length) {
        const nextDocId = tabs.length > 0 ? tabs[0].docId : null;
        (['primary', 'secondary'] as const).forEach((pane) => {
          const docId = panes[pane].docId;
          if (docId && !tabs.some((tab) => tab.docId === docId)) {
            panes[pane] = { ...panes[pane], docId: nextDocId };
          }
        });
      }
      return {
        ...state,
        projects,
        tabs,
        panes,
        activeProjectId:
          state.activeProjectId === removed ? fallback : state.activeProjectId,
        resourcesByProject: drop(state.resourcesByProject),
        treeByProject: drop(state.treeByProject),
        expandedByProject: drop(state.expandedByProject),
        selectedByProject: drop(state.selectedByProject),
        loadingByProject: drop(state.loadingByProject),
        // 项目已移出工作台：回收区入口不再存在，视图状态一并丢弃。
        // 磁盘上的记录与文件仍由 Host 保留（撤销不删除任何东西）。
        trashByProject: drop(state.trashByProject),
      };
    }

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

    // ---- UX-02B-TREE 逐层文件树 ----
    case 'TREE_LEVEL_BEGIN': {
      const levels = state.treeByProject[action.projectId] ?? emptyLevels();
      return withTreeLevels(state, action.projectId, beginLevel(levels, action.dir, action.append));
    }

    case 'TREE_LEVEL_PAGE': {
      const levels = state.treeByProject[action.projectId] ?? emptyLevels();
      const merged = withTreeLevels(
        state,
        action.projectId,
        applyPage(levels, action.dir, {
          entries: action.entries,
          cursor: action.cursor,
          nextCursor: action.nextCursor,
          total: action.total,
          snapshot: action.snapshot ?? null,
          // 0 与"字段缺失"必须区别对待：缺失（旧版服务端）保留上一次已知值
          hiddenCount: action.hiddenCount,
          // 根层展示信息与资源锚：缺失时沿用上一次（续页不带不等于"没有了"）
          ...(action.projectMeta !== undefined ? { projectMeta: action.projectMeta } : {}),
          ...(action.projectAnchor !== undefined ? { projectAnchor: action.projectAnchor } : {}),
          ...(action.anchors !== undefined ? { anchors: action.anchors } : {}),
        }),
      );
      // 只在"首次拿到根层的第一页"时补默认展开；续页与刷新都不重置展开状态
      return action.dir === '' && action.cursor === null
        ? withInitialExpansion(merged, action.projectId)
        : merged;
    }

    case 'TREE_LEVEL_ERROR': {
      const levels = state.treeByProject[action.projectId] ?? emptyLevels();
      // 目录在本轮分页中变了：旧游标/旧快照/已加载的那一页都不能再当作完整结果，
      // 必须整层作废并显式提示"刷新"（R1-04）。其余失败仍保留内容供重试。
      const next =
        action.errorCode === 'ERR_DIR_CHANGED'
          ? invalidateLevel(levels, action.dir, 'ERR_DIR_CHANGED')
          : failLevel(levels, action.dir, action.errorCode);
      return withTreeLevels(state, action.projectId, next);
    }

    case 'TREE_RESET':
      // 只作废这一个项目；其他项目的层表引用原样保留（T-16）
      return withTreeLevels(state, action.projectId, resetLevels());

    /**
     * 显示隐藏项（UX-02C-03-P1）。
     *
     * 只翻开关：层表由调用方随后 `TREE_RESET` + 重新拉取。这里刻意**不**顺手清层，
     * 因为 reducer 无法保证"清完之后一定有人重新加载"，那会把树留在空白状态。
     */
    case 'SET_SHOW_HIDDEN':
      return state.showHidden === action.value ? state : { ...state, showHidden: action.value };

    /* ---- UX-02C-03-P2-02：回收区 ---- */

    /**
     * 开始读取：保留已有条目（避免列表闪空），只把"加载中"打开。
     * 旧错误一并清掉——用户点了重试之后还挂着上一次的红字，会以为重试没生效。
     */
    case 'TRASH_LOAD_BEGIN': {
      const previous = state.trashByProject[action.projectId];
      return {
        ...state,
        trashByProject: {
          ...state.trashByProject,
          [action.projectId]: {
            entries: previous?.entries ?? [],
            count: previous?.count ?? 0,
            loaded: previous?.loaded ?? false,
            loading: true,
            errorCode: null,
            errorMessage: null,
            busyOpIds: previous?.busyOpIds ?? [],
            busyOwners: previous?.busyOwners ?? {},
            unconfirmedOpIds: previous?.unconfirmedOpIds ?? [],
          },
        },
      };
    }

    case 'TRASH_LOADED':
      return {
        ...state,
        trashByProject: {
          ...state.trashByProject,
          [action.projectId]: {
            entries: action.entries,
            count: action.count,
            loaded: true,
            loading: false,
            errorCode: null,
            errorMessage: null,
            // 列表刷新不结束恢复：在途集合只由 TRASH_BUSY 改，
            // 否则刷新回来的那一刻按钮又变回可点，用户会以为"上一次没生效"。
            busyOpIds: state.trashByProject[action.projectId]?.busyOpIds ?? [],
            busyOwners: state.trashByProject[action.projectId]?.busyOwners ?? {},
            /*
             * 「待核对」可以被一次**成功的**列表刷新收敛：列表里该记录已经落到终态
             * （或记录已不存在），说明结论已经有了，再拦着用户没有意义。
             * 注意这里只处理 unconfirmed——在途请求还没回来，不能提前放开。
             */
            unconfirmedOpIds: (state.trashByProject[action.projectId]?.unconfirmedOpIds ?? []).filter(
              (opId) => {
                const record = action.entries.find((entry) => entry.opId === opId);
                return record !== undefined && !TRASH_TERMINAL_STATES.has(record.state);
              },
            ),
          },
        },
      };

    /**
     * 读取失败：**不覆盖已有条目**。
     *
     * 覆盖成空列表等于告诉用户"回收区里什么都没有"——那正是最危险的一种谎报。
     * 在途/未确认标记同样保留：刷新失败不构成"可以再试一次"的依据。
     */
    case 'TRASH_LOAD_ERROR': {
      const previous = state.trashByProject[action.projectId];
      return {
        ...state,
        trashByProject: {
          ...state.trashByProject,
          [action.projectId]: {
            entries: previous?.entries ?? [],
            count: previous?.count ?? 0,
            loaded: previous?.loaded ?? false,
            loading: false,
            errorCode: action.errorCode,
            errorMessage: action.message,
            busyOpIds: previous?.busyOpIds ?? [],
            busyOwners: previous?.busyOwners ?? {},
            unconfirmedOpIds: previous?.unconfirmedOpIds ?? [],
          },
        },
      };
    }

    /**
     * 单飞标记只动一个 `opId`，而且**只有发起它的那个工作区身份能结束它**
     * （UX-02C-03-P2-02-R1.2）。
     *
     * 场景：A 的恢复还在途 → 切到 B → B 恢复同 `opId`（不同磁盘、不同记录）→ A 的请求
     * 这时才回来。它的 `finally` 带的是 A 的身份键，与这里记的 B 不相等，于是被丢弃；
     * B 的“恢复中”不会被别人的收尾抹掉。A→B→A 也成立：代次不同，键就不同。
     */
    case 'TRASH_BUSY': {
      const previous = state.trashByProject[action.projectId];
      const owners = previous?.busyOwners ?? {};

      // 结束在途：必须是自己发起的那一条
      if (!action.busy && owners[action.opId] !== action.scope) return state;

      const ids = previous?.busyOpIds ?? [];
      const next = toggleId(ids, action.opId, action.busy);
      const ownerChanged = action.busy && owners[action.opId] !== action.scope;
      if (next === null && !ownerChanged) return state;

      const nextOwners = { ...owners };
      if (action.busy) nextOwners[action.opId] = action.scope;
      else delete nextOwners[action.opId];

      return {
        ...state,
        trashByProject: {
          ...state.trashByProject,
          [action.projectId]: {
            entries: previous?.entries ?? [],
            count: previous?.count ?? 0,
            loaded: previous?.loaded ?? false,
            loading: previous?.loading ?? false,
            errorCode: previous?.errorCode ?? null,
            errorMessage: previous?.errorMessage ?? null,
            busyOpIds: next ?? ids,
            busyOwners: nextOwners,
            unconfirmedOpIds: previous?.unconfirmedOpIds ?? [],
          },
        },
      };
    }

    /** 未确认标记同样只动一个 `opId`，且不会被列表刷新顺手清掉。 */
    case 'TRASH_UNCONFIRMED': {
      const previous = state.trashByProject[action.projectId];
      const next = toggleId(previous?.unconfirmedOpIds ?? [], action.opId, action.pending);
      if (next === null) return state;
      return {
        ...state,
        trashByProject: {
          ...state.trashByProject,
          [action.projectId]: {
            entries: previous?.entries ?? [],
            count: previous?.count ?? 0,
            loaded: previous?.loaded ?? false,
            loading: previous?.loading ?? false,
            errorCode: previous?.errorCode ?? null,
            errorMessage: previous?.errorMessage ?? null,
            busyOpIds: previous?.busyOpIds ?? [],
            busyOwners: previous?.busyOwners ?? {},
            unconfirmedOpIds: next,
          },
        },
      };
    }

    /**
     * UX-02C-02：Host 明确 APPLIED 之后才清理旧路径。
     *
     * - 旧路径本身与它下面所有层缓存全部删除（目录改名/移动后旧 dir 键已失效）；
     * - 新路径下的层也清掉，避免残留一份改名前的同名层；
     * - expandedByProject 里指向旧路径的节点 id（`dir:<projectId>/<rel>`）作废，
     *   否则一个已不存在的目录会一直显示为展开；
     * - 指向旧路径的选择记录清空；标签、草稿与其它项目一概不动。
     */
    case 'TREE_STRUCTURE_CHANGED': {
      const { projectId, sourcePath, targetPath } = action;
      const levels = state.treeByProject[projectId] ?? {};
      const nextLevels: Record<string, TreeLevels[string]> = {};
      const stale = (dir: string, prefix: string): boolean =>
        dir === prefix || dir.startsWith(`${prefix}/`);
      for (const [dir, level] of Object.entries(levels)) {
        if (stale(dir, sourcePath) || stale(dir, targetPath)) continue;
        nextLevels[dir] = level;
      }
      const expanded = state.expandedByProject[projectId] ?? {};
      const nextExpanded: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(expanded)) {
        const slash = key.indexOf('/');
        const rel = slash < 0 ? key : key.slice(slash + 1);
        if (stale(rel, sourcePath)) continue;
        nextExpanded[key] = value;
      }
      const selected = state.selectedByProject[projectId];
      const nextSelected =
        selected && (selected === sourcePath || selected.includes(`/${sourcePath}`))
          ? null
          : selected;
      return {
        ...withTreeLevels(state, projectId, nextLevels),
        expandedByProject: { ...state.expandedByProject, [projectId]: nextExpanded },
        selectedByProject: { ...state.selectedByProject, [projectId]: nextSelected ?? null },
      };
    }

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
