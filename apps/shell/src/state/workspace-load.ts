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
 * - 连接失败返回 null，调用方据此降级（恢复流程只会保留界面布局）。
 */
import type { ProjectSummary, WeaveSpaceClient, WorkspaceMode } from '../client/client-api.ts';
import type { ClientMode, ResourceNodeState, WorkspaceAction, WorkspaceState } from './types.ts';

export interface WorkspaceLoadDeps {
  getState(): WorkspaceState;
  dispatch(action: WorkspaceAction): void;
  clientFor(mode: ClientMode): WeaveSpaceClient;
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
 */
export async function loadWorkspace(deps: WorkspaceLoadDeps): Promise<LoadedWorkspace | null> {
  const client = deps.clientFor('live');
  const { dispatch } = deps;

  let workspaceMode: WorkspaceMode = 'legacy';
  let workspaceKey: string | null = null;
  try {
    const identity = await client.workspaceIdentity();
    workspaceMode = identity.workspaceMode;
    workspaceKey = identity.workspaceKey;
  } catch {
    dispatch({
      type: 'NOTICE',
      message: '无法连接本地服务：请先启动 apps/server（npm run start:server）',
    });
    return null;
  }
  dispatch({ type: 'SET_WORKSPACE_MODE', workspaceMode });
  dispatch({ type: 'SET_WORKSPACE_KEY', workspaceKey });

  if (workspaceMode !== 'multi') {
    dispatch({ type: 'SET_LOADING_RESOURCES', loading: true });
    try {
      const nodes = await client.listResources();
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
      dispatch({ type: 'NOTICE', message: '无法连接本地服务：请先启动 apps/server' });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING_RESOURCES', loading: false });
    }
  }

  let projects: ProjectSummary[] = [];
  try {
    projects = await client.listProjects();
  } catch {
    dispatch({ type: 'NOTICE', message: '无法读取项目列表：请检查 --workspace 配置' });
    return null;
  }
  dispatch({ type: 'SET_PROJECTS', projects });

  const ready = projects.filter((project) => project.status === 'READY');
  for (const project of ready) {
    // 逐个加载，单个项目失败不影响其他项目
    await loadProjectResources(deps, project.projectId);
  }
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
 */
export async function loadProjectResources(
  deps: WorkspaceLoadDeps,
  projectId: string,
): Promise<boolean> {
  const { dispatch } = deps;
  dispatch({ type: 'SET_PROJECT_LOADING', projectId, loading: true });
  try {
    const nodes = await deps.clientFor('live').listResources(projectId);
    dispatch({ type: 'SET_PROJECT_RESOURCES', projectId, nodes });
    const projects = await refreshProjectStatuses(deps);
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
    dispatch({
      type: 'NOTICE',
      message: '无法连接本地服务：请先启动 apps/server（npm run start:server）',
    });
    return false;
  } finally {
    dispatch({ type: 'SET_PROJECT_LOADING', projectId, loading: false });
  }
}

export async function refreshProjectStatuses(
  deps: WorkspaceLoadDeps,
): Promise<ProjectSummary[] | null> {
  try {
    const projects = await deps.clientFor('live').listProjects();
    deps.dispatch({ type: 'SET_PROJECTS', projects });
    return projects;
  } catch {
    return null;
  }
}
