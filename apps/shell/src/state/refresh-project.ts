/**
 * 手动刷新编排（S11-UX-01A）。
 *
 * 为什么单独成模块：这段是"文件树 + 已打开文档"两段异步流程的**真实实现**，
 * 而 `reloadResources` 只是 Provider 里的一个转发。抽出来以后测试可以驱动
 * 与生产完全相同的链路（真实 Host + 真实 reducer + 真实 opener），
 * 并且能精确验证"刷新还在途中时用户切走"这种生命周期问题。
 *
 * 两段都不改变活动文档 / 焦点窗格 / 分屏结构：刷新只是核对磁盘，不是导航。
 */
import type { WeaveSpaceClient } from '../client/client-api.ts';
import type { OpenTabsRefreshReport } from './open-document.ts';
import type { ClientMode, WorkspaceAction, WorkspaceState } from './types.ts';
import { countFiles, loadProjectResources } from './workspace-load.ts';

export interface RefreshProjectDeps {
  getState(): WorkspaceState;
  /** 同步可读的工作区模式（切换模式的同一次回调里 state 仍是旧值）。 */
  getMode(): ClientMode;
  dispatch(action: WorkspaceAction): void;
  clientFor(mode: ClientMode): WeaveSpaceClient;
  /** 文档层刷新：复用打开编排器，不另建一套读取/会话状态机。 */
  refreshOpenTabs(projectId: string | null): Promise<OpenTabsRefreshReport>;
  /** 当前加载代次令牌（只读，不推进代次，因此不会打断 S11-C 恢复）。 */
  loadToken(): number;
  /** 该令牌是否仍是当前代（切模式 / 重新连接都让旧令牌失效）。 */
  isTokenCurrent(token: number): boolean;
}

export interface RefreshProjectResult {
  /** 本次刷新是否因工作区变化而被取消（取消时不留下任何状态改动）。 */
  cancelled: boolean;
  projectId: string | null;
  /** Legacy 树里的文件数；Multi 未读取全局树，恒为 0。 */
  files: number;
  /** 文档层报告；被取消或未进行到那一步时为 null。 */
  report: OpenTabsRefreshReport | null;
}

/**
 * 手动刷新的用户可见文案。
 *
 * 文件树结果与文档层结果必须**合并成一条**：`NOTICE` 只有一行，分开派发会互相覆盖，
 * 用户就看不到"哪些文件有外部修改但被草稿挡住"这个关键信息。
 */
export function refreshNotice(
  base: string,
  updated: number,
  dirtyChanged: readonly string[],
  failed: readonly string[],
): string {
  const parts = [base];
  if (updated > 0) parts.push(`${updated} 个已打开文件已同步磁盘变化`);
  if (dirtyChanged.length > 0) {
    parts.push(`${dirtyChanged.join('、')} 在磁盘上已被修改，但存在未保存草稿，未自动覆盖`);
  }
  if (failed.length > 0) parts.push(`${failed.join('、')} 检查失败（磁盘不可读）`);
  return parts.join('；');
}

function projectLabel(state: WorkspaceState, projectId: string | null): string {
  if (!projectId) return '';
  return state.projects.find((project) => project.projectId === projectId)?.name ?? projectId;
}

/**
 * 刷新一个项目（Multi）或单项目树（Legacy）。
 *
 * 返回 `cancelled: true` 表示这次刷新的结果已被丢弃，调用方不应再提示任何东西。
 *
 * 生命周期（UX-01A-R1）：刷新一开始就固定捕获「加载代次令牌 + 工作区身份 + 模式」，
 * 之后**每一段 await 返回后**都问一次 `stillValid()`。判定必须比对代次令牌而不是
 * 只比 `mode === 'live'`：Demo → Live 切回来之后模式又会变回 live，但那次请求已经
 * 属于上一代，只比模式会把它当成当前工作区的结果写进去。
 */
export async function refreshProject(
  deps: RefreshProjectDeps,
  projectId?: string,
): Promise<RefreshProjectResult> {
  const state = deps.getState();
  if (deps.getMode() !== 'live' || state.mode !== 'live') {
    return { cancelled: true, projectId: projectId ?? null, files: 0, report: null };
  }

  const token = deps.loadToken();
  const capturedKey = state.workspaceKey;
  const capturedActive = state.activeProjectId;
  /** 本次刷新是否仍然代表"当前这个工作区"（只读判定，不推进任何代次）。 */
  const stillValid = (): boolean =>
    deps.getMode() === 'live' &&
    deps.getState().mode === 'live' &&
    deps.getState().workspaceKey === capturedKey &&
    deps.isTokenCurrent(token);

  const cancelled = (target: string | null): RefreshProjectResult => ({
    cancelled: true,
    projectId: target,
    files: 0,
    report: null,
  });

  const multi = state.workspaceMode === 'multi';
  // Legacy 的标签没有项目身份（projectId === null）；Multi 按项目限定
  const target = multi ? (projectId ?? capturedActive ?? null) : null;
  // 没有活动项目时没有"要刷新哪一份"的答案：宁可不刷，也不猜
  if (multi && !target) return { cancelled: false, projectId: null, files: 0, report: null };

  if (multi) {
    const ok = await loadProjectResources(
      {
        getState: deps.getState,
        dispatch: deps.dispatch,
        clientFor: deps.clientFor,
        // 沿用既有取消机制：过期代次不得再派发 SET_PROJECT_RESOURCES / SET_PROJECTS /
        // 加载状态或 NOTICE（loadProjectResources 内部每个 await 后都会自检）
        isCancelled: () => !stillValid(),
        // 取消后不要清理 loading：标记可能已经属于新一代对同一个项目的加载（UX-01A-R2）
        preserveLoadingOnCancel: true,
      },
      target as string,
    );
    if (!stillValid()) return cancelled(target);
    // 失败 / 不可用的提示由 loadProjectResources 自己给出，这里不再叠一条
    if (!ok) return { cancelled: false, projectId: target, files: 0, report: null };

    const report = await deps.refreshOpenTabs(target);
    if (!stillValid()) return cancelled(target);

    // 用户已经切到别的项目：这次后台刷新仍然有效（标签照常同步），
    // 但提示会被他当前更关心的信息盖掉，因此静默收尾（不夺焦点、不覆盖提示）
    if (deps.getState().activeProjectId !== capturedActive) {
      return { cancelled: false, projectId: target, files: 0, report };
    }

    deps.dispatch({
      type: 'NOTICE',
      message: refreshNotice(
        `已刷新项目 ${projectLabel(deps.getState(), target) || target} 的文件树`,
        report.updated,
        report.dirtyChanged,
        report.failed,
      ),
    });
    return { cancelled: false, projectId: target, files: 0, report };
  }

  deps.dispatch({ type: 'SET_LOADING_RESOURCES', loading: true });
  let files = 0;
  try {
    const nodes = await deps.clientFor('live').listResources();
    // 树读回来了，但用户可能已经切走：此时连资源树都不属于当前工作区
    if (!stillValid()) return cancelled(null);
    deps.dispatch({ type: 'SET_RESOURCES', nodes });
    files = countFiles(nodes);
  } catch {
    if (!stillValid()) return cancelled(null);
    deps.dispatch({ type: 'NOTICE', message: '刷新失败：无法连接本地服务' });
    return { cancelled: false, projectId: null, files: 0, report: null };
  } finally {
    // 已取消时不要写"加载中=false"：那个标记属于旧工作区，切模式时归约已经重置
    if (stillValid()) deps.dispatch({ type: 'SET_LOADING_RESOURCES', loading: false });
  }

  const report = await deps.refreshOpenTabs(null);
  if (!stillValid()) return cancelled(null);

  deps.dispatch({
    type: 'NOTICE',
    message: refreshNotice(`已刷新资源树（${files} 个文件）`, report.updated, report.dirtyChanged, report.failed),
  });
  return { cancelled: false, projectId: null, files, report };
}
