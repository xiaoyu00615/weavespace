/**
 * 项目移除编排（UX-02B-04B）。
 *
 * 只做"界面 ↔ Host"之间的一次移除与结果确认；真正的事务、屏障、复检、墓碑、
 * 配置写入全在 `ProjectRuntime`（Host 侧），这里**不复制**任何事务逻辑。
 *
 * 纪律：
 * - 只解除注册与授权，**不触碰磁盘文件**：本模块不 import 任何删除/移动 API；
 * - `opId` 在**提交前**生成并持有：网络超时 / 5xx 后用它查询持久事务证据，
 *   而不是凭"项目还在不在"猜测结果（ADR-022 §7.1）；
 * - **绝不自动重试 remove**：结果不确定时只做"按 opId 查询 + 只读刷新列表 + 提示人工核对"；
 * - 每个 await 之后核对加载代次：切模式 / 重连 / 换工作区后，迟到的结果一律不回填。
 */
import type {
  ProjectSummary,
  RemoveBlockerCode,
  RemoveProjectOutcome,
  RemovalOpOutcome,
  RemovalPrecheckOutcome,
} from '../client/client-api.ts';

/** 移除编排所需的窄端口：便于用 deferred 精确驱动超时/未知分支。 */
export interface RemoveProjectPort {
  removalPrecheck(projectId: string): Promise<RemovalPrecheckOutcome>;
  removeProject(projectId: string, opId: string): Promise<RemoveProjectOutcome>;
  queryRemovalOp(opId: string): Promise<RemovalOpOutcome>;
  listProjects(): Promise<ProjectSummary[]>;
}

export type RemoveUiResult =
  /** Host 明确撤销（或在 op 证据里命中本次 opId）：项目已从工作台移除。 */
  | { kind: 'removed'; projectId: string; configPersisted: boolean }
  /** Host 复检未通过：零变更，附阻断原因。 */
  | { kind: 'blocked'; projectId: string; blockedBy: RemoveBlockerCode[]; state: string }
  /** 当前运行模式不支持（Demo / 静态 / Legacy）。 */
  | { kind: 'unsupported'; message: string }
  /** 结果不可确认：已按 opId 尽力查询 / 只读刷新列表，但**不**断言成功，也不自动重试。 */
  | { kind: 'unknown'; projectId: string; message: string }
  | { kind: 'failed'; message: string };

export interface RemoveProjectHost {
  readonly port: RemoveProjectPort;
  /** 生成一次移除的幂等键（提交前落定）。测试可注入固定值。 */
  newOpId(): string;
  /** 工作区身份与代次（切模式 / 重连会推进 epoch）。 */
  identity(): { mode: 'demo' | 'live'; epoch: number };
  /** 给定代次是否仍是当前代。 */
  isCurrent(epoch: number): boolean;
  /** 确认已移除：从列表移除 + 清理该项目的树缓存与展开/选中/加载状态。 */
  onRemoved(projectId: string): void;
  /** 重拉之后的项目列表回填（结果不确定时的只读刷新）。 */
  onProjects(projects: ProjectSummary[]): void;
}

export interface ProjectRemover {
  /** 只读前置检查（打开确认框时调用）。结果不是放行凭据。 */
  precheck(projectId: string): Promise<RemovalPrecheckOutcome | { status: 'REJECTED'; errorCode: string | null; message: string; httpStatus: number }>;
  /** 执行一次移除。**一次调用只提交一次 remove**，不自动重试。 */
  remove(projectId: string): Promise<RemoveUiResult>;
}

const STALE_MESSAGE = '工作区已切换，本次移除结果未回填';
const UNKNOWN_MESSAGE =
  '无法确认本次移除是否生效：已按操作编号查询并重新读取项目列表，请人工核对（不会自动重试移除）';

/** 用 crypto.randomUUID 生成幂等键；不可用时退回时间戳+随机数（仍是唯一串）。 */
function defaultNewOpId(): string {
  try {
    const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
    if (c?.randomUUID) return `op-${c.randomUUID()}`;
  } catch {
    /* 落到下面的兜底 */
  }
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createProjectRemover(host: RemoveProjectHost): ProjectRemover {
  return {
    precheck(projectId) {
      return host.port.removalPrecheck(projectId);
    },

    async remove(projectId) {
      const start = host.identity();
      if (start.mode !== 'live') {
        return { kind: 'unsupported', message: '演示模式没有真实项目，无法移除' };
      }
      const epoch = start.epoch;
      // 幂等键在**提交前**落定：这样结果丢失后仍能按它查询持久证据
      const opId = host.newOpId();

      const result = await host.port.removeProject(projectId, opId);

      // 提交期间用户切走：不把结果写进新工作区（也不清缓存）
      if (!host.isCurrent(epoch)) return { kind: 'unknown', projectId, message: STALE_MESSAGE };

      if (result.status === 'APPLIED') {
        host.onRemoved(result.projectId);
        return { kind: 'removed', projectId: result.projectId, configPersisted: result.configPersisted };
      }
      if (result.status === 'ABORTED') {
        return { kind: 'blocked', projectId, blockedBy: result.blockedBy, state: 'ACTIVE' };
      }

      // ---- REJECTED：可能是超时 / 5xx / 未知；绝不据此断言"已移除"，也绝不自动重试 ----
      if (result.httpStatus === 501) {
        return { kind: 'unsupported', message: result.message || '当前运行模式不支持移除项目' };
      }

      // 优先按 opId 查询持久事务证据（只读磁盘）
      const op = await host.port.queryRemovalOp(opId).catch((): RemovalOpOutcome => ({
        status: 'REJECTED',
        errorCode: null,
        message: '查询失败',
        httpStatus: 0,
      }));
      if (!host.isCurrent(epoch)) return { kind: 'unknown', projectId, message: STALE_MESSAGE };

      if (op.status === 'APPLIED' && op.outcome === 'revoked') {
        // 持久证据命中本次 opId → 移除确实已生效
        host.onRemoved(projectId);
        return { kind: 'removed', projectId, configPersisted: true };
      }

      // 其余（unknown / 无法查询）：只读刷新列表，明确说明结果仍需人工核对
      try {
        const projects = await host.port.listProjects();
        if (host.isCurrent(epoch)) host.onProjects(projects);
      } catch {
        /* 刷新失败也照样返回 unknown：不能因为刷新失败就谎报成功 */
      }
      return { kind: 'unknown', projectId, message: UNKNOWN_MESSAGE };
    },
  };
}

export { defaultNewOpId };
