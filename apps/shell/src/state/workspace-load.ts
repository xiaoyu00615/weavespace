/**
 * "连接 Host 并加载工作区"（S11-C）。
 *
 * 从 `DocumentActionsContext` 抽出来，是为了让**恢复流程**和**用户主动切换模式**
 * 走同一条链路：真实客户端 → `/api/health`（含工作区摘要）→ 项目列表 → 每个项目的资源树。
 * 抽成纯 TS + 依赖注入后，测试可以在 Node 里用真实 Host 驱动，而不用挂载 React。
 *
 * 纪律：
 * - 服务器说 UNAVAILABLE 就是 UNAVAILABLE：不用任何历史快照替代；
 * - 单个项目加载失败不影响其他项目；
 * - 连接失败返回 null，调用方据此降级（恢复流程只会保留界面布局）；
 * - 用户切走之后，迟到的结果一律丢弃（S11-C-R2，见 `isCancelled`）。
 */
import type { ProjectSummary, WeaveSpaceClient, WorkspaceMode } from '../client/client-api.ts';
import type { ClientMode, ResourceNodeState, WorkspaceAction, WorkspaceState } from './types.ts';

export interface WorkspaceLoadDeps {
  getState(): WorkspaceState;
  dispatch(action: WorkspaceAction): void;
  clientFor(mode: ClientMode): WeaveSpaceClient;
  /**
   * 取消检查（S11-C-R2）。
   *
   * 加载链是"身份 → 项目表 → 逐个项目资源树"的串行流程。用户在这条链的任意一段
   * 切回 Demo 之后，剩下的结果都属于**上一个工作区**：身份、项目表、资源树、加载中
   * 标记、提示文案，一个都不能再写。因此每次 await 返回之后、每次关键 dispatch
   * 之前都要问一遍；已取消就整条链收手（连错误提示也不发——那是旧工作区的错误）。
   *
   * 不传 = 永不取消，保持既有调用点的语义。
   */
  isCancelled?: () => boolean;
  /**
   * 取消后是否**保留**加载标记（UX-01A-R2）。
   *
   * 手动刷新会为同一个项目反复发起加载：旧请求被取消后，标记可能已经属于更新一代的
   * 同一个 `projectId`，它的 `SET_PROJECT_LOADING(false)` 会把新一代刚点亮的 `true` 关掉。
   * 传 `true` 表示"取消后不要碰标记"（归属已转移）。
   *
   * **默认不传**：S11-C 恢复被交互打断时仍按既有语义清零，避免 spinner 永久卡住。
   */
  preserveLoadingOnCancel?: boolean;
}

export interface LoadedWorkspace {
  workspaceMode: WorkspaceMode;
  /** Host 的工作区摘要；旧版服务端不提供时为 null（客户端据此 fail-closed）。 */
  workspaceKey: string | null;
  projects: ProjectSummary[];
  /** Legacy 的单树（Multi 为空对象）。 */
  resources: ResourceNodeState[];
  resourcesByProject: Record<string, ResourceNodeState[]>;
}

/**
 * 加载代次（S11-C-R2）。
 *
 * 为什么不直接比较 `state.mode`：用户"切到 Demo 再切回 Live"之后模式又变回 `live`，
 * 而上一代请求可能还挂在网络上——只看模式会把迟到结果当成本代结果写进界面。
 * 代次只增不减，旧代次永远过期。
 */
export interface LoadEpoch {
  /** 开启新一代，返回本代的取消检查（开启瞬间上一代即失效）。 */
  start(): () => boolean;
  /** 让所有在途加载失效（切到不需要加载的模式时用）。 */
  cancel(): void;
  /**
   * 读取当前代次令牌（S11-UX-01A-R1）。
   *
   * 只读，**不推进代次**：手动刷新需要在"不打断 S11-C 恢复"的前提下记住
   * 自己属于哪一代，事后再问一句"这一代还有效吗"。
   */
  current(): number;
  /** 给定令牌是否仍是当前代（切模式 / 重新连接都会让旧令牌失效）。 */
  isCurrent(token: number): boolean;
}

export function createLoadEpoch(): LoadEpoch {
  let generation = 0;
  return {
    start() {
      generation += 1;
      const mine = generation;
      return () => generation !== mine;
    },
    cancel() {
      generation += 1;
    },
    current() {
      return generation;
    },
    isCurrent(token) {
      return generation === token;
    },
  };
}

/** 取消检查的默认值：未注入时永不取消。 */
function cancellationOf(deps: WorkspaceLoadDeps): () => boolean {
  const check = deps.isCancelled;
  return check ? () => check() : () => false;
}

/**
 * `finally` 里是否允许把"加载中"清零。
 *
 * - 未被取消：正常收尾；
 * - 已取消但界面仍在本代 live（例如恢复被交互打断、但用户没有切模式）：只清零布尔标记，
 *   否则 spinner 会永久卡住；这**不是**旧工作区数据，`false` 本来就是默认值；
 * - 已取消且用户已经切到别的工作区：一个 dispatch 都不发。切模式时归约已经清空项目级
 *   标记，宿主也会在切换点清掉全局标记，迟到的加载状态绝不能落到新工作区上。
 * - **例外（UX-01A-R2）**：调用方声明 `preserveLoadingOnCancel` 时不清理。手动刷新这类
 *   "同一目标可能被新一代重复加载"的调用方，旧请求的 `false` 会把新一代刚点亮的
 *   `true` 关掉；此时标记的归属已转移，旧请求无权改动。
 */
function mayClearLoading(deps: WorkspaceLoadDeps, cancelled: () => boolean): boolean {
  if (!cancelled()) return true;
  if (deps.preserveLoadingOnCancel) return false;
  return deps.getState().mode === 'live';
}

/** 文件计数（提示文案用）。 */
export function countFiles(nodes: ResourceNodeState[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.kind === 'folder') total += countFiles(node.children ?? []);
    else total += 1;
  }
  return total;
}

/**
 * 加载工作区；返回实际生效的状态。
 *
 * 返回值只用于调用方决策（恢复流程需要摘要与资源树），**权威状态仍是 reducer**：
 * 这里所有 load 结果都通过 dispatch 落到 WorkspaceState。
 *
 * 被取消时返回 null，且**不留下任何痕迹**——调用方据此收手，界面仍是用户切过去
 * 的那个工作区。
 */
export async function loadWorkspace(deps: WorkspaceLoadDeps): Promise<LoadedWorkspace | null> {
  const client = deps.clientFor('live');
  const { dispatch } = deps;
  const cancelled = cancellationOf(deps);

  let workspaceMode: WorkspaceMode = 'legacy';
  let workspaceKey: string | null = null;
  try {
    const identity = await client.workspaceIdentity();
    // 身份是整条链的第一份"旧工作区数据"，迟到时连模式都不能改
    if (cancelled()) return null;
    workspaceMode = identity.workspaceMode;
    workspaceKey = identity.workspaceKey;
  } catch {
    if (cancelled()) return null;
    dispatch({
      type: 'NOTICE',
      message: '无法连接本地服务：请先启动 apps/server（npm run start:server）',
    });
    return null;
  }
  dispatch({ type: 'SET_WORKSPACE_MODE', workspaceMode });
  dispatch({ type: 'SET_WORKSPACE_KEY', workspaceKey });

  if (workspaceMode !== 'multi') {
    if (cancelled()) return null;
    dispatch({ type: 'SET_LOADING_RESOURCES', loading: true });
    try {
      const nodes = await client.listResources();
      if (cancelled()) return null;
      dispatch({ type: 'SET_RESOURCES', nodes });
      const files = countFiles(nodes);
      dispatch({
        type: 'NOTICE',
        message: files > 0 ? `已加载 ${files} 个可编辑文件（真实文件模式）` : '未发现可编辑文件',
      });
      return {
        workspaceMode,
        workspaceKey,
        projects: [],
        resources: nodes,
        resourcesByProject: {},
      };
    } catch {
      if (cancelled()) return null;
      dispatch({ type: 'NOTICE', message: '无法连接本地服务：请先启动 apps/server' });
      return null;
    } finally {
      // 已经切走的加载不能把"加载中"写进别的工作区（那个标记属于旧工作区）
      if (mayClearLoading(deps, cancelled)) dispatch({ type: 'SET_LOADING_RESOURCES', loading: false });
    }
  }

  let projects: ProjectSummary[] = [];
  try {
    projects = await client.listProjects();
  } catch {
    if (cancelled()) return null;
    dispatch({ type: 'NOTICE', message: '无法读取项目列表：请检查 --workspace 配置' });
    return null;
  }
  // 项目表会顺带改写"当前项目"（reducer 自动选中第一个 READY），迟到的表绝不能落盘
  if (cancelled()) return null;
  dispatch({ type: 'SET_PROJECTS', projects });

  const ready = projects.filter((project) => project.status === 'READY');
  for (const project of ready) {
    // 已取消就停止后续项目加载：不再发请求，也不再派发任何项目级状态
    if (cancelled()) return null;
    // 逐个加载，单个项目失败不影响其他项目
    await loadProjectResources(deps, project.projectId);
  }
  if (cancelled()) return null;
  dispatch({
    type: 'NOTICE',
    message:
      ready.length > 0
        ? `已加载 ${ready.length} 个项目（${projects.length - ready.length} 个不可用）`
        : '没有可用的项目：请检查工作区配置',
  });

  const state = deps.getState();
  const refreshed = state.projects.length > 0 ? state.projects : projects;
  return {
    workspaceMode,
    workspaceKey,
    projects: refreshed,
    resources: [],
    resourcesByProject: { ...state.resourcesByProject },
  };
}

/**
 * 加载单个项目的资源树，并同步项目状态（G2-11）。
 * 根被删除/移走后服务端返回 UNAVAILABLE，界面不能继续显示 READY。
 *
 * 取消语义与 `loadWorkspace` 一致：取消之后既不回填资源树，也不刷新项目状态，
 * 更不会在 `finally` 里把 `SET_PROJECT_LOADING` 派发到别的工作区。
 */
export async function loadProjectResources(
  deps: WorkspaceLoadDeps,
  projectId: string,
): Promise<boolean> {
  const { dispatch } = deps;
  const cancelled = cancellationOf(deps);
  if (cancelled()) return false;
  dispatch({ type: 'SET_PROJECT_LOADING', projectId, loading: true });
  try {
    const nodes = await deps.clientFor('live').listResources(projectId);
    if (cancelled()) return false;
    dispatch({ type: 'SET_PROJECT_RESOURCES', projectId, nodes });
    const projects = await refreshProjectStatuses(deps);
    if (cancelled()) return false;
    const status = projects?.find((project) => project.projectId === projectId);
    if (status?.status === 'UNAVAILABLE') {
      dispatch({
        type: 'NOTICE',
        message: `项目 ${status.name} 已不可用${status.reason ? `（${status.reason}）` : ''}：既有标签与草稿仍保留`,
      });
      return false;
    }
    return true;
  } catch {
    if (cancelled()) return false;
    dispatch({
      type: 'NOTICE',
      message: '无法连接本地服务：请先启动 apps/server（npm run start:server）',
    });
    return false;
  } finally {
    // 同上：切到别的工作区后，项目级的加载中标记不属于那里
    if (mayClearLoading(deps, cancelled)) dispatch({ type: 'SET_PROJECT_LOADING', projectId, loading: false });
  }
}

export async function refreshProjectStatuses(
  deps: WorkspaceLoadDeps,
): Promise<ProjectSummary[] | null> {
  const cancelled = cancellationOf(deps);
  try {
    const projects = await deps.clientFor('live').listProjects();
    // 迟到的项目表同样会改写当前项目，必须丢掉
    if (cancelled()) return null;
    deps.dispatch({ type: 'SET_PROJECTS', projects });
    return projects;
  } catch {
    return null;
  }
}
