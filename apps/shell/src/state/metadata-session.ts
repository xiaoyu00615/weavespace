/**
 * 标注编辑会话的**归属编排**（UX-02C-04-R1，纯 TS）。
 *
 * 为什么单独成模块：`.tsx` 无法被 `node:test` import，而这里要钉的恰恰是
 * "打开对话框之后世界变了"的时序问题——换了工作区、换了对象、对象消失、
 * 请求在途时才切换。把这些判定写进组件里，只能靠读源码相信它是对的。
 *
 * 纪律：
 * - **不做 HTTP、不碰 React、不碰磁盘**：全部经 `MetadataRunnerHost` 注入；
 * - 提交前先判归属，归属不成立就**一个请求都不发**（提示要说清"没保存"，不是"失败"）；
 * - 请求返回后再判一次：归属已变则**不刷新、不提示**，把结果丢掉；
 * - 资源身份预期（`anchor`）只是交给 Host 比对的前置条件，这里不解析、不推导。
 */
import type {
  MetadataOutcome,
  MetadataSendGate,
  ResourceMetadataDto,
  ResourceMetadataPatch,
} from '../client/client-api.ts';
import {
  metadataClearedNotice,
  metadataNoopNotice,
  metadataSavedNotice,
  metadataStaleNotice,
  metadataUnknownNotice,
  type MetadataStaleReason,
} from './resource-metadata.ts';

/** 打开对话框时冻结下来的归属：工作区身份 + 项目 + 路径 + 资源锚。 */
export interface MetadataSessionBinding {
  /** 工作区身份键（模式 + 工作区模式 + 工作区摘要 + 加载代次）。 */
  readonly key: string;
  readonly projectId: string;
  readonly path: string;
  /** 打开时该行的资源锚；`null` = 当时就拿不到（只能拒绝提交）。 */
  readonly anchor: string | null;
}

/** 提交这一刻，那一行在**当前**层表里的状态。 */
export interface MetadataTargetState {
  /** 行是否还在（项目根行只要项目还在就算在）。 */
  readonly present: boolean;
  /** 当前的资源锚；`null` = 无法确认。 */
  readonly anchor: string | null;
}

export type MetadataOwnership = 'current' | 'switched' | 'target-missing' | 'target-changed' | 'unverified';

export function metadataSessionKeyOf(input: {
  readonly mode: string;
  readonly workspaceMode: string;
  readonly workspaceKey: string | null;
  readonly epoch: number;
}): string {
  return `${input.mode}\u0000${input.workspaceMode}\u0000${input.workspaceKey ?? ''}\u0000${input.epoch}`;
}

/** 归属判定：先看工作区（切走了就不再讨论具体对象），再按锚比对象。 */
export function metadataOwnershipOf(input: {
  readonly binding: MetadataSessionBinding;
  readonly currentKey: string;
  readonly target: MetadataTargetState;
}): MetadataOwnership {
  if (input.binding.key !== input.currentKey) return 'switched';
  if (!input.target.present) return 'target-missing';
  if (input.target.anchor === null || input.binding.anchor === null) return 'unverified';
  return input.target.anchor === input.binding.anchor ? 'current' : 'target-changed';
}

function staleReasonOf(ownership: MetadataOwnership): MetadataStaleReason {
  switch (ownership) {
    case 'switched':
      return 'workspace-switched';
    case 'target-missing':
      return 'target-missing';
    case 'target-changed':
      return 'target-changed';
    default:
      return 'target-unverified';
  }
}

export type MetadataRunResult =
  | { kind: 'saved'; changed: boolean; metadata: ResourceMetadataDto }
  | { kind: 'noop' }
  | { kind: 'unknown' }
  | { kind: 'rejected'; message: string }
  | { kind: 'stale'; reason: MetadataStaleReason };

export interface MetadataRunnerHost {
  /** 当前工作区身份键（每次调用都读最新值）。 */
  identityKey(): string;
  /** 那一行此刻的状态（从层表里查，不做任何磁盘/网络推断）。 */
  targetState(projectId: string, path: string): MetadataTargetState;
  /**
   * 设置 / 清除。
   *
   * `gate` 必须原样交给传输层，由它在 `sessionToken()` 之后、`fetch()` 之前
   * **同步**执行一次（R1-H1-01）：这里的前置判定与真正的 POST 之间隔着取令牌的
   * await，只有把最后一次判定压进那个同步片段才没有可插入的窗口。
   */
  set(
    projectId: string,
    path: string,
    patch: ResourceMetadataPatch,
    anchor: string | null,
    gate: MetadataSendGate,
  ): Promise<MetadataOutcome>;
  clear(
    projectId: string,
    path: string,
    anchor: string | null,
    gate: MetadataSendGate,
  ): Promise<MetadataOutcome>;
  /** 只刷新该行所在的层。 */
  refresh(projectId: string, path: string): Promise<void>;
  notice(message: string): void;
}

export interface MetadataRunner {
  submit(binding: MetadataSessionBinding, patch: ResourceMetadataPatch): Promise<MetadataRunResult>;
  clear(binding: MetadataSessionBinding): Promise<MetadataRunResult>;
}

type MetadataAction = 'save' | 'clear';

/**
 * 发送前裁决（R1-H1-01）。
 *
 * 与 `run()` 开头的判定**是同一个判据**，区别只在**时刻**：那一次是"用户按下按钮时"，
 * 这一次是"令牌到手、马上就要 fetch 时"。中间这段时间用户可能已经切走或换了对象。
 *
 * 无参、同步、不读任何外部状态以外的异步源：它只会调 `host` 的两个同步读口。
 */
function sendGateOf(host: MetadataRunnerHost, binding: MetadataSessionBinding): MetadataSendGate {
  return () => {
    const ownership = metadataOwnershipOf({
      binding,
      currentKey: host.identityKey(),
      target: host.targetState(binding.projectId, binding.path),
    });
    return ownership === 'current' ? { ok: true } : { ok: false, reason: staleReasonOf(ownership) };
  };
}

async function run(
  host: MetadataRunnerHost,
  binding: MetadataSessionBinding,
  action: MetadataAction,
  send: (gate: MetadataSendGate) => Promise<MetadataOutcome>,
): Promise<MetadataRunResult> {
  const ownership = metadataOwnershipOf({
    binding,
    currentKey: host.identityKey(),
    target: host.targetState(binding.projectId, binding.path),
  });
  if (ownership !== 'current') {
    const reason = staleReasonOf(ownership);
    host.notice(metadataStaleNotice(reason, action));
    return { kind: 'stale', reason };
  }

  let outcome: MetadataOutcome;
  try {
    outcome = await send(sendGateOf(host, binding));
  } catch {
    return { kind: 'rejected', message: '本地服务不可用，资源标注没有保存' };
  }

  /*
   * 请求已经回来了，但用户可能已经切走。此时**什么都不做**：
   * 不刷新（层表已经不归这个会话了）、不提示（那会落在别人的工作区里）。
   */
  if (host.identityKey() !== binding.key) {
    return { kind: 'stale', reason: 'workspace-switched' };
  }

  /*
   * 发送前被拒（R1-H1-01）：一个请求都没发出去。
   *
   * 它既不是 `UNKNOWN`（那会去刷新核对一份与本次编辑无关的旧状态，用户还会以为
   * "可能写进去了"），也不是失败（没有任何人拒绝过这次编辑）。归到 stale：
   * 同一工作区内明确告诉用户"没保存"；工作区已经切走则上面那一支已经静默丢弃。
   */
  if (outcome.status === 'NOT_SENT') {
    host.notice(metadataStaleNotice(outcome.reason, action));
    return { kind: 'stale', reason: outcome.reason };
  }

  if (outcome.status === 'UNKNOWN') {
    await host.refresh(binding.projectId, binding.path);
    if (host.identityKey() !== binding.key) return { kind: 'stale', reason: 'workspace-switched' };
    host.notice(metadataUnknownNotice());
    return { kind: 'unknown' };
  }

  if (outcome.status === 'REJECTED') {
    // Host 判定"目标已变"：这不是失败，而是这次编辑不再指向那个对象。不重试、不刷新。
    if (outcome.errorCode === 'ERR_METADATA_TARGET_CHANGED') {
      host.notice(metadataStaleNotice('target-changed', action));
      return { kind: 'stale', reason: 'target-changed' };
    }
    return { kind: 'rejected', message: outcome.message ?? '资源标注保存失败' };
  }

  await host.refresh(binding.projectId, binding.path);
  if (host.identityKey() !== binding.key) return { kind: 'stale', reason: 'workspace-switched' };

  if (!outcome.changed) {
    host.notice(metadataNoopNotice());
    return { kind: 'noop' };
  }
  host.notice(action === 'clear' ? metadataClearedNotice() : metadataSavedNotice(outcome.metadata.alias));
  return { kind: 'saved', changed: true, metadata: outcome.metadata };
}

export function createMetadataRunner(host: MetadataRunnerHost): MetadataRunner {
  return {
    submit(binding, patch) {
      return run(host, binding, 'save', (gate) =>
        host.set(binding.projectId, binding.path, patch, binding.anchor, gate),
      );
    },
    clear(binding) {
      return run(host, binding, 'clear', (gate) =>
        host.clear(binding.projectId, binding.path, binding.anchor, gate),
      );
    },
  };
}
