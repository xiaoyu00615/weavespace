/**
 * UX-02B-TREE-R1/R2：逐层目录加载的**异步编排与请求归属**（纯 TS）。
 *
 * 为什么单独成模块：`.tsx` 无法被 `node:test` import，而「迟到响应到底能不能回填」
 * 是典型的多分支时序问题，只靠 React 源码字符串断言证明不了。把 `loadTreeLevel`
 * 的编排移到这里之后，测试可以用可控的 deferred promise 精确制造
 * 「旧请求比新请求晚回来」并且逐条检查 dispatch。
 *
 * R2-01：`loadProjectResources()` 的**根层读取**也必须走同一套归属判定。
 * 因此把代次/作废/票据抽成 `TreeOwnershipGuard`，由 Provider 创建**同一个实例**
 * 同时供给逐层加载器与工作区加载链；不新增第二套状态机。
 *
 * 纪律：本模块**不碰网络、不碰 React、不碰磁盘**，所有外部能力经 `host` 注入。
 */
import type { TreeQueryOutcome } from '../client/client-api.ts';
import type { ClientMode, WorkspaceAction } from './types.ts';
import { normalizeDir, type TreeLevels } from '../components/tree-model.ts';

/** 发起一次请求时，同步可读的工作区身份。 */
export interface TreeLoadIdentity {
  /** reducer 里的模式（可能落后一个渲染周期）。 */
  readonly mode: ClientMode;
  /** 模式的同步镜像（切换模式的同一次回调里最先变化）。 */
  readonly syncMode: ClientMode;
  /** Host 工作区摘要；换根 / 换工作区时变化。 */
  readonly workspaceKey: string | null;
  /** 工作区加载代次（切模式 / 重新连接都会推进）。 */
  readonly epoch: number;
  /**
   * 当前操作焦点。**只读快照，不参与归属判定**：切换到另一个项目不应该
   * 取消已经发出、且目标明确是 A 项目的有效加载（R1-02）。
   */
  readonly activeProjectId?: string | null;
}

export interface TreeListRequest {
  readonly projectId: string | null;
  readonly dir: string;
  readonly cursor: string | null;
  /** 本轮分页的目录快照标识；第一页为 null。 */
  readonly snapshot: string | null;
}

export interface TreeLevelLoaderHost {
  identity(): TreeLoadIdentity;
  /** 该项目的层表（用于判断单飞与续页游标）。 */
  levels(projectKey: string): TreeLevels;
  listTree(request: TreeListRequest): Promise<TreeQueryOutcome>;
  dispatch(action: WorkspaceAction): void;
}

export type TreeLoadOutcome =
  | 'applied'
  | 'changed'
  | 'rejected'
  | 'failed'
  /** 响应回来时已不属于当前工作区：一个 dispatch 都不发。 */
  | 'stale'
  | 'skipped-mode'
  | 'skipped-inflight'
  | 'skipped-no-cursor';

export interface TreeLevelLoader {
  load(projectId: string | null, dir: string, append: boolean): Promise<TreeLoadOutcome>;
  /** 刷新某个项目：作废它名下所有层的在途请求。 */
  invalidateProject(projectKey: string): void;
  /** 换模式 / 重新连接：作废所有在途请求。 */
  invalidateAll(): void;
  /** 与工作区加载链共享的归属守卫（R2-01）。 */
  readonly ownership: TreeOwnershipGuard;
}

/**
 * 一次请求的**归属票据**（UX-02B-TREE-R1 / R1-02）。
 *
 * 五个维度缺一不可：
 * - 工作区身份（模式 + 同步模式镜像 + 工作区摘要）：挡住 Demo→Live 之后
 *   "模式又变回 live"的迟到响应；
 * - 加载代次：挡住重新连接 / 切模式（代次只增不减）；
 * - 项目 ID 与目录路径：挡住"别的层"的结果被写进这一层；
 * - 该层请求代次：挡住同层的新旧并发（刷新、重试、快速展开折叠）。
 *
 * 注意 `activeProjectId` 刻意**不参与**判定：切换焦点、刷新另一个项目都不该
 * 取消一个目标明确的有效加载。
 */
export interface TreeRequestTicket {
  readonly identity: TreeLoadIdentity;
  readonly projectKey: string;
  readonly dir: string;
  /** 该 (项目, 目录) 层的请求序号；每次新请求 +1，旧票据立即失效。 */
  readonly generation: number;
  /** 项目级作废序号：刷新一个项目时它名下所有层一起失效。 */
  readonly projectGeneration: number;
  /** 全局作废序号：换模式 / 重新连接时所有在途一起失效。 */
  readonly workspaceGeneration: number;
}

export interface TreeOwnershipGuard {
  /** 非 live 返回 null；否则推进该层代次、捕获身份并登记在途票据。 */
  begin(projectKey: string, dir: string): TreeRequestTicket | null;
  /** 该层是否还有**仍属当前代**的在途票据（单飞判定）。 */
  inFlight(projectKey: string, dir: string): TreeRequestTicket | undefined;
  /** 票据是否仍代表"当前这一份层表"；失败即一个 dispatch 都不发。 */
  isCurrent(ticket: TreeRequestTicket): boolean;
  /** 请求结束：只清理自己那条在途记录。 */
  end(ticket: TreeRequestTicket): void;
  invalidateProject(projectKey: string): void;
  invalidateAll(): void;
}

function levelKeyOf(projectKey: string, dir: string): string {
  return `${projectKey}\u0000${dir}`;
}

/** 归属守卫工厂：所有请求（子层 / 根层 / 刷新）共用同一个实例才有意义。 */
export function createTreeOwnershipGuard(
  identity: () => TreeLoadIdentity,
): TreeOwnershipGuard {
  let workspaceGeneration = 0;
  const projectGeneration = new Map<string, number>();
  const generation = new Map<string, number>();
  /**
   * 该层当前在途请求的票据。单飞必须按"票据是否仍属当前代"判定，
   * 不能只看 `status === 'loading'`：上一代请求被作废后留下的 loading
   * 会把新一代请求永远挡在门外（R1-02-02 现场发现的边界）。
   */
  const inFlight = new Map<string, TreeRequestTicket>();

  const isCurrent = (ticket: TreeRequestTicket): boolean => {
    const now = identity();
    const key = levelKeyOf(ticket.projectKey, ticket.dir);
    return (
      ticket.identity.mode === 'live' &&
      ticket.identity.syncMode === 'live' &&
      now.mode === 'live' &&
      now.syncMode === 'live' &&
      now.workspaceKey === ticket.identity.workspaceKey &&
      now.epoch === ticket.identity.epoch &&
      workspaceGeneration === ticket.workspaceGeneration &&
      (projectGeneration.get(ticket.projectKey) ?? 0) === ticket.projectGeneration &&
      (generation.get(key) ?? 0) === ticket.generation
    );
  };

  return {
    begin(projectKey, dir) {
      const at = identity();
      if (at.mode !== 'live' || at.syncMode !== 'live') return null;
      const key = levelKeyOf(projectKey, dir);
      const next = (generation.get(key) ?? 0) + 1;
      generation.set(key, next);
      const ticket: TreeRequestTicket = {
        identity: at,
        projectKey,
        dir,
        generation: next,
        projectGeneration: projectGeneration.get(projectKey) ?? 0,
        workspaceGeneration,
      };
      inFlight.set(key, ticket);
      return ticket;
    },
    inFlight(projectKey, dir) {
      const key = levelKeyOf(projectKey, dir);
      const ticket = inFlight.get(key);
      if (!ticket) return undefined;
      if (!isCurrent(ticket)) {
        inFlight.delete(key);
        return undefined;
      }
      return ticket;
    },
    isCurrent,
    end(ticket) {
      const key = levelKeyOf(ticket.projectKey, ticket.dir);
      if (inFlight.get(key) === ticket) inFlight.delete(key);
    },
    invalidateProject(projectKey) {
      projectGeneration.set(projectKey, (projectGeneration.get(projectKey) ?? 0) + 1);
    },
    invalidateAll() {
      workspaceGeneration += 1;
    },
  };
}

export function createTreeLevelLoader(
  host: TreeLevelLoaderHost,
  ownership: TreeOwnershipGuard = createTreeOwnershipGuard(host.identity),
): TreeLevelLoader {
  return {
    ownership,
    async load(projectId, dir, append) {
      const at = host.identity();
      if (at.mode !== 'live' || at.syncMode !== 'live') return 'skipped-mode';
      const projectKey = projectId ?? '';
      const levelDir = normalizeDir(dir);
      const levels = host.levels(projectKey);
      const current = levels[levelDir];
      // 同一层已有**仍属当前代**的在途请求：不重复发，也不推进代次。
      // 过期票据留下的 loading 不算在途，新一代必须能重新发起。
      if (ownership.inFlight(projectKey, levelDir)) return 'skipped-inflight';
      const cursor = append ? (current?.nextCursor ?? null) : null;
      if (append && !cursor) return 'skipped-no-cursor';
      const snapshot = append ? (current?.snapshot ?? null) : null;

      const ticket = ownership.begin(projectKey, levelDir);
      if (!ticket) return 'skipped-mode';

      host.dispatch({ type: 'TREE_LEVEL_BEGIN', projectId: projectKey, dir: levelDir, append });
      try {
        const outcome = await host.listTree({ projectId, dir: levelDir, cursor, snapshot });
        // 迟到响应属于上一个工作区 / 上一代 / 上一层：连 error 都不能派发，
        // 否则会覆盖新请求刚写下的 loading / ready / error 状态。
        if (!ownership.isCurrent(ticket)) return 'stale';
        if (outcome.status !== 'APPLIED') {
          host.dispatch({
            type: 'TREE_LEVEL_ERROR',
            projectId: projectKey,
            dir: levelDir,
            errorCode: outcome.errorCode,
          });
          return outcome.errorCode === 'ERR_DIR_CHANGED' ? 'changed' : 'rejected';
        }
        host.dispatch({
          type: 'TREE_LEVEL_PAGE',
          projectId: projectKey,
          dir: levelDir,
          entries: outcome.entries,
          cursor,
          nextCursor: outcome.page.nextCursor,
          total: outcome.page.total,
          snapshot: outcome.page.snapshot ?? null,
        });
        return 'applied';
      } catch {
        if (!ownership.isCurrent(ticket)) return 'stale';
        host.dispatch({ type: 'TREE_LEVEL_ERROR', projectId: projectKey, dir: levelDir, errorCode: null });
        return 'failed';
      } finally {
        ownership.end(ticket);
      }
    },
    invalidateProject(projectKey) {
      ownership.invalidateProject(projectKey);
    },
    invalidateAll() {
      ownership.invalidateAll();
    },
  };
}
