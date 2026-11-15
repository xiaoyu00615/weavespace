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
  /**
   * 票据是否只是"同一会话内 `workspaceKey` 变了"（UX-02B-04A-R2 / TREE-01）。
   *
   * 添加项目后 `onWorkspaceKey` 会**合法地**更新工作区摘要：此时 `workspaceKey`
   * 变化纯属我们自己提交造成的转移，不是外部切换。`isCurrent` 因 `workspaceKey`
   * 不等而返回 false，但这不代表请求作废——除 key 外其余维度（模式 / 代次 /
   * 全局作废序号 / 项目作废序号 / 该层请求序号）全部一致时，它就是"自己人"。
   *
   * 调用方据此**重发一次**（用新 key 取回本层），而不是把层永久留在"正在加载…"。
   * 真正切走（mode / epoch / 作废序号变化）时本方法返回 false，保持既有语义。
   */
  keyChangedWithinSession(ticket: TreeRequestTicket): boolean;
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
    keyChangedWithinSession(ticket) {
      const now = identity();
      const key = levelKeyOf(ticket.projectKey, ticket.dir);
      // 除 workspaceKey 外的每一个归属维度都必须仍然一致；
      // 并且确实发生了 key 变化（否则它不是"仅 key 变了"这一情形）。
      return (
        ticket.identity.mode === 'live' &&
        ticket.identity.syncMode === 'live' &&
        now.mode === 'live' &&
        now.syncMode === 'live' &&
        now.epoch === ticket.identity.epoch &&
        workspaceGeneration === ticket.workspaceGeneration &&
        (projectGeneration.get(ticket.projectKey) ?? 0) === ticket.projectGeneration &&
        (generation.get(key) ?? 0) === ticket.generation &&
        now.workspaceKey !== ticket.identity.workspaceKey
      );
    },
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

/**
 * 同一会话内因 `workspaceKey` 合法变化（例如刚添加项目）而失败的一次请求，
 * 最多重发多少次。key 在添加完成后很快稳定，1~2 次足够；留 2 次兜住连续添加。
 */
const MAX_KEY_REISSUE = 2;

export function createTreeLevelLoader(
  host: TreeLevelLoaderHost,
  ownership: TreeOwnershipGuard = createTreeOwnershipGuard(host.identity),
): TreeLevelLoader {
  /**
   * 真正取一层的实现。`tries` 只用于"同会话内仅 workspaceKey 变化"时的重发计数：
   * 这种变化是我们自己的 `onWorkspaceKey` 造成的合法状态转移，不是外部切换，
   * 旧票据被判 stale 之后必须用**新 key** 再取一次，否则层会永久停在"正在加载…"
   * （TREE-01 现场：添加两个项目后自动展开的子目录全部卡住）。
   */
  const attempt = async (
    projectId: string | null,
    dir: string,
    append: boolean,
    tries: number,
  ): Promise<TreeLoadOutcome> => {
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

    /** 同会话内仅 key 变（自己提交）：用新 key 重发；真正切走则维持 stale。 */
    const reissueIfOwnKeyChange = (): Promise<TreeLoadOutcome> | null => {
      if (tries < MAX_KEY_REISSUE && ownership.keyChangedWithinSession(ticket)) {
        return attempt(projectId, dir, append, tries + 1);
      }
      return null;
    };

    /**
     * 请求作废之后的统一收敛（TREE-01 要求 5）。
     *
     * 1. 同一 live 会话、仅 `workspaceKey` 抖动（自己提交）：用新 key 重发；
     * 2. 重发次数用尽仍是同一会话（key 持续抖动）：把本层由 loading 收敛为**可重试错误**，
     *    绝不让界面永久停在"正在加载…"；
     * 3. 真正切走（mode / epoch / 作废序号变化）：什么都不发——新会话自己会重置/重读层表；
     *    此时若贸然派发错误，反而会把已经被 `SET_MODE` 清空的 treeByProject 重新长出来。
     */
    const settleVoided = (): Promise<TreeLoadOutcome> | TreeLoadOutcome => {
      const again = reissueIfOwnKeyChange();
      if (again) return again;
      if (ownership.keyChangedWithinSession(ticket)) {
        const level = host.levels(projectKey)[levelDir];
        if (level?.status === 'loading' && !ownership.inFlight(projectKey, levelDir)) {
          host.dispatch({ type: 'TREE_LEVEL_ERROR', projectId: projectKey, dir: levelDir, errorCode: null });
        }
      }
      return 'stale';
    };

    host.dispatch({ type: 'TREE_LEVEL_BEGIN', projectId: projectKey, dir: levelDir, append });
    try {
      const outcome = await host.listTree({ projectId, dir: levelDir, cursor, snapshot });
      // 迟到响应属于上一个工作区 / 上一代 / 上一层：连 error 都不能直接派发，
      // 否则会覆盖新请求刚写下的 loading / ready / error 状态。
      if (!ownership.isCurrent(ticket)) return settleVoided();
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
      if (!ownership.isCurrent(ticket)) return settleVoided();
      host.dispatch({ type: 'TREE_LEVEL_ERROR', projectId: projectKey, dir: levelDir, errorCode: null });
      return 'failed';
    } finally {
      ownership.end(ticket);
    }
  };

  return {
    ownership,
    load: (projectId, dir, append) => attempt(projectId, dir, append, 0),
    invalidateProject(projectKey) {
      ownership.invalidateProject(projectKey);
    },
    invalidateAll() {
      ownership.invalidateAll();
    },
  };
}
