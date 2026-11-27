/**
 * 项目**显示名称**改名的完整归属编排（UX-02C-05-R1.2，纯 TS）。
 *
 * 为什么单独成模块：`.tsx` 不能被 `node:test` import，而本轮要钉的恰好是
 * "请求已经发出去了，回来的时候这个世界还是不是原来那个"——这件事只有把
 * **真实的编排**（而不是它的替身）跑在测试里才能证明。
 *
 * 两层归属，必须分开表达（F03）：
 *
 * 1. **全局层**（`performProjectRename`）：Host 的结果要不要写进"项目列表"。
 *    判据是加载代次 + 工作区摘要 + 模式 + 项目行自身的注册身份。切换**当前项目**
 *    不在此列——真实名称确实变了，列表就该显示新名字。
 * 2. **会话层**（`createProjectRenameFlow`）：Host 的结果要不要写进"行内编辑会话"。
 *    判据是会话票据 + 世界 + 当前活动项目 + 项目是否还在。
 *
 * 两者都不能用"模式还是不是 live"这种粗判据代替：切到 Demo 再切回 Live 之后
 * 模式又变回 `live`，地址栏那一轮的世界已经换了两代。
 *
 * 纪律：
 * - 不建立第二套生命周期框架，直接复用 `loadEpoch`（`workspace-load.ts`）；
 * - 请求只发一次，任何分支都不自动重试；
 * - Host 明确 APPLIED 时，**不能**因为界面已经切走就把它改写成 REJECTED，
 *   只能表达成"Host 已应用 / 未回填界面"。
 */
import type { ProjectSummary, RenameOutcome } from '../client/client-api.ts';
import { validateProjectName } from './add-project.ts';
import {
  projectRenameGateMessage,
  projectRenameGateOf,
  projectRenameResultEffect,
  projectRenameSessionStillCurrent,
  type ProjectRenameSessionTicket,
} from './tree-commands.ts';

/* ------------------------------------------------------------------ */
/* 全局层：Host 结果 → 项目列表                                        */
/* ------------------------------------------------------------------ */

/**
 * 发起请求那一刻的"项目行身份"。
 *
 * 为什么要 `nameAtStart` / `statusAtStart` 而不只是 `projectId`：项目 id 永不复用，
 * 但**同一行**在这段时间里可能已经被别的操作改过（Host 侧另一次改名、只读 resync
 * 拿到新的可用状态）。拿着旧摘要覆盖上去，等于用历史快照抹掉别人刚写下的结果。
 */
export interface ProjectRenameOwnership {
  /** 工作区加载代次（`loadEpoch.current()`）。 */
  readonly epoch: number;
  /** `live` / `demo`：模式变了就不是同一个世界。 */
  readonly mode: string;
  /** 工作区摘要；切换工作区后旧结果不得回填。 */
  readonly workspaceKey: string | null;
  readonly projectId: string;
  readonly nameAtStart: string;
  readonly statusAtStart: string;
}

export function projectRenameOwnershipOf(input: {
  readonly epoch: number;
  readonly mode: string;
  readonly workspaceKey: string | null;
  readonly project: ProjectSummary;
}): ProjectRenameOwnership {
  return {
    epoch: input.epoch,
    mode: input.mode,
    workspaceKey: input.workspaceKey,
    projectId: input.project.projectId,
    nameAtStart: input.project.name,
    statusAtStart: input.project.status,
  };
}

/** 回填被拒绝的原因：`null` 表示允许回填。文案直接给用户看。 */
export function projectRenameBackfillProblem(input: {
  readonly ownership: ProjectRenameOwnership;
  readonly mode: string;
  readonly workspaceKey: string | null;
  readonly epoch: number;
  readonly current: ProjectSummary | null;
}): string | null {
  const { ownership } = input;
  if (input.mode !== ownership.mode) {
    return '工作区模式已经切换，重命名结果没有写入当前项目列表';
  }
  if (input.workspaceKey !== ownership.workspaceKey) {
    return '工作区已经切换，重命名结果没有写入当前项目列表';
  }
  if (input.epoch !== ownership.epoch) {
    return '工作区已重新加载，重命名结果没有写入当前项目列表';
  }
  if (input.current === null || input.current.projectId !== ownership.projectId) {
    return '该项目已不在工作区里，重命名结果没有写入当前项目列表';
  }
  if (input.current.name !== ownership.nameAtStart) {
    return '该项目的名称已被其他操作修改，本次结果没有覆盖它';
  }
  if (input.current.status !== ownership.statusAtStart) {
    return '该项目的可用状态已经变化，重命名结果没有写入当前项目列表';
  }
  return null;
}

/**
 * Host 结果 + 界面回填状态，**分别表达**。
 *
 * `outcome` 原样保留 Host 的判定：一次真实生效的改名不能因为"用户恰好切了项目"
 * 就在界面上变成失败——那会让用户以为没改成，于是再改一次。
 */
export interface ProjectRenameResult {
  readonly outcome: RenameOutcome;
  /**
   * - `done`：把 Host 返回的摘要写进了当前项目列表；
   * - `stale`：Host 已应用，但这一行已经不属于当前界面（原因见 `backfillProblem`）；
   * - `nothing`：Host 没有应用，本来就没有东西要写。
   */
  readonly backfill: 'done' | 'stale' | 'nothing';
  readonly backfillProblem: string | null;
}

export interface ProjectRenameCallHost {
  /** 实时读取：这些值可能在任何 `await` 之间变化。 */
  readonly mode: () => string;
  readonly workspaceKey: () => string | null;
  readonly epoch: () => number;
  readonly projects: () => readonly ProjectSummary[];
  /** 唯一一条真实链路（Host 调用）。 */
  readonly send: (projectId: string, name: string) => Promise<RenameOutcome>;
  readonly dispatchRename: (project: ProjectSummary) => void;
}

/**
 * 改名一次：预检 → 捕获归属 → 交给 Host → 按归属决定要不要回填列表。
 *
 * 预检只挡"注定失败"的请求，权威仍是 Host（与 R1 的既有约定一致）。
 */
export async function performProjectRename(
  host: ProjectRenameCallHost,
  projectId: string,
  rawName: string,
): Promise<ProjectRenameResult> {
  const nothing = (outcome: RenameOutcome): ProjectRenameResult => ({
    outcome,
    backfill: 'nothing',
    backfillProblem: null,
  });

  const checked = validateProjectName(rawName);
  if (!checked.ok) {
    return nothing({
      status: 'REJECTED',
      errorCode: 'ERR_COMMAND_INVALID',
      message: checked.message,
      httpStatus: 400,
    });
  }
  if (host.mode() !== 'live') {
    return nothing({
      status: 'REJECTED',
      errorCode: 'ERR_COMMAND_UNSUPPORTED',
      message: '演示模式没有真实项目，无法重命名',
      httpStatus: 501,
    });
  }
  const current = host.projects().find((item) => item.projectId === projectId);
  if (!current) {
    return nothing({
      status: 'REJECTED',
      errorCode: 'ERR_PROJECT_NOT_FOUND',
      message: '项目已不存在',
      httpStatus: 404,
    });
  }
  // 名字没变化就不发请求：避免一次无意义的写盘与状态变化
  if (current.name === checked.name) {
    return nothing({ status: 'APPLIED', project: current });
  }

  /*
   * 捕获归属必须在**发请求之前**：请求飞行期间每一条判据都可能变。
   * 这里刻意读"实时值"，而不是调用方传进来的快照——两者的区别就是
   * "以谁为准"，而权威只能是这一刻的真实世界。
   */
  const ownership = projectRenameOwnershipOf({
    epoch: host.epoch(),
    mode: host.mode(),
    workspaceKey: host.workspaceKey(),
    project: current,
  });

  let outcome: RenameOutcome;
  try {
    outcome = await host.send(projectId, checked.name);
  } catch {
    return nothing({
      status: 'REJECTED',
      errorCode: 'ERR_STORAGE_IO',
      message: '无法连接本地服务',
      httpStatus: 0,
    });
  }
  if (outcome.status !== 'APPLIED') return nothing(outcome);

  const after = host.projects().find((item) => item.projectId === projectId) ?? null;
  const problem = projectRenameBackfillProblem({
    ownership,
    mode: host.mode(),
    workspaceKey: host.workspaceKey(),
    epoch: host.epoch(),
    current: after,
  });
  if (problem !== null) {
    // Host 已经改完了：磁盘/配置里的名称是新的，只是这一屏不该再写一遍
    return { outcome, backfill: 'stale', backfillProblem: problem };
  }
  host.dispatchRename(outcome.project);
  return { outcome, backfill: 'done', backfillProblem: null };
}

/* ------------------------------------------------------------------ */
/* 会话层：Host 结果 → 行内编辑会话                                     */
/* ------------------------------------------------------------------ */

/** 行内会话里编排需要的那几个字段（与组件里的 `ProjectRenameState` 同形）。 */
export interface ProjectRenameSessionView {
  readonly sessionId: number;
  readonly scope: string;
  readonly activeProjectAtStart: string | null;
  readonly projectId: string;
  readonly draft: string;
  readonly saving: boolean;
}

export interface ProjectRenameFlowPort {
  /** 实时读取当前会话（`null` = 已经收起）。 */
  readonly session: () => ProjectRenameSessionView | null;
  readonly currentScope: () => string;
  readonly currentActiveProject: () => string | null;
  readonly projects: () => readonly ProjectSummary[];
  readonly supported: (projectId: string) => boolean;
  /** 唯一真实链路（含全局归属回填）。 */
  readonly rename: (projectId: string, name: string) => Promise<ProjectRenameResult>;
  /** 单飞锁：跨组件重渲染存活（由调用方持有 ref）。 */
  readonly tryLock: () => boolean;
  readonly unlock: () => void;
  readonly setSaving: (sessionId: number) => void;
  readonly close: (sessionId: number) => void;
  readonly fail: (sessionId: number, message: string) => void;
  readonly notice: (message: string) => void;
}

export interface ProjectRenameFlow {
  submit(): Promise<void>;
}

function ticketOf(session: ProjectRenameSessionView): ProjectRenameSessionTicket {
  return {
    sessionId: session.sessionId,
    scope: session.scope,
    activeProjectAtStart: session.activeProjectAtStart,
  };
}

/**
 * 一次提交 = 一把单飞锁。
 *
 * 提交前、返回后各核一次归属；旧结果既不能关闭新会话，也不能把错误写进新会话。
 * 已发出的请求不会因为会话被收起而"变成没发生"——它只会变成一条 notice。
 */
export function createProjectRenameFlow(port: ProjectRenameFlowPort): ProjectRenameFlow {
  return {
    async submit(): Promise<void> {
      const session = port.session();
      if (!session || session.saving) return;
      if (!port.tryLock()) return;
      try {
        /*
         * 提交前复核：会话可能是在另一个工作区打开的，也可能项目在这期间被移除
         * 或变成不可用。任何一条不成立都不发请求。
         */
        const gate = projectRenameGateOf({
          sessionScope: session.scope,
          currentScope: port.currentScope(),
          // 打开会话那一刻的活动项目 vs 现在的活动项目（R2.1 / A01）：
          // 不能比 `session.projectId`——它可以是**非当前项目**（右键菜单改名）
          activeProjectAtStart: session.activeProjectAtStart,
          currentActiveProject: port.currentActiveProject(),
          projectExists: port.projects().some((item) => item.projectId === session.projectId),
          projectSupported: port.supported(session.projectId),
        });
        if (gate !== 'ok') {
          port.close(session.sessionId);
          port.notice(projectRenameGateMessage(gate) ?? '旧的改名会话已失效');
          return;
        }
        const checked = validateProjectName(session.draft);
        if (!checked.ok) {
          port.fail(session.sessionId, checked.message);
          return;
        }
        const project = port.projects().find((item) => item.projectId === session.projectId);
        if (!project) {
          port.close(session.sessionId);
          port.notice('该项目已不在工作区里');
          return;
        }
        // 名称没变：不发请求，也不制造"已保存"的假象
        if (project.name === checked.name) {
          port.close(session.sessionId);
          return;
        }

        port.setSaving(session.sessionId);
        let result: ProjectRenameResult;
        try {
          // 请求只发一次：结果回来时按票据落地，绝不重发
          result = await port.rename(session.projectId, checked.name);
        } catch {
          result = {
            outcome: {
              status: 'REJECTED',
              errorCode: 'ERR_STORAGE_IO',
              message: '重命名失败：网络或本地服务不可用',
              httpStatus: 0,
            },
            backfill: 'nothing',
            backfillProblem: null,
          };
        }

        const outcome = result.outcome;
        const applied = outcome.status === 'APPLIED';
        // 成功分支没有 message，直接按判别字段窄化，避免把"未应用"的文案用在成功上
        const failureMessage = outcome.status === 'APPLIED' ? null : outcome.message;
        const live = port.session();
        const projectPresent = port
          .projects()
          .some((item) => item.projectId === session.projectId);
        const stillCurrent =
          projectPresent &&
          projectRenameSessionStillCurrent({
            session: live ? ticketOf(live) : null,
            sessionId: session.sessionId,
            currentScope: port.currentScope(),
            activeProjectId: port.currentActiveProject(),
          });

        const effect = projectRenameResultEffect({ applied, sessionStillCurrent: stillCurrent });
        if (effect === 'close') {
          /**
           * 会话还在，但**列表没回填**（R2.1 / A02）。
           *
           * 这是最容易被误读的一种组合：Host 确实改完了，行内会话也还开着，
           * 只是这一行已经不属于当前列表（代次变了 / 同一行被别的操作改过）。
           * 静默关掉会让用户以为"没改成"，于是再改一次——第二次会撞上
           * "名称已被其他操作修改"，变成一条无法解释的失败。
           */
          if (applied && result.backfill === 'stale') {
            port.notice(
              `「${checked.name}」的显示名称已在工作区中更新，但当前项目列表未回填：` +
                `${result.backfillProblem ?? '当前界面已切换'}（没有自动重发）`,
            );
          }
          port.close(session.sessionId);
          return;
        }
        if (effect === 'keep-error') {
          // 失败：界面保持原名（全局层没有派发任何改名），输入保留供修正
          port.fail(session.sessionId, failureMessage ?? '重命名失败');
          return;
        }
        /*
         * notice-only：请求确实发出去了，不能假装"什么都没发生"，也不自动重试。
         * 如果 Host 已应用但列表没回填，必须把两件事都说清楚，否则用户无法判断
         * 到底改成了没有。
         */
        port.notice(
          applied
            ? result.backfill === 'stale'
              ? `「${checked.name}」的显示名称已更新（${result.backfillProblem ?? '当前界面已切换'}）`
              : `「${checked.name}」的显示名称已更新（原编辑会话已收起）`
            : `重命名没有完成：${failureMessage ?? '未知原因'}`,
        );
      } finally {
        port.unlock();
      }
    },
  };
}
