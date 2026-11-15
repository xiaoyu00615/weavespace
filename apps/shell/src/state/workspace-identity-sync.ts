/**
 * 移除项目之后的**工作区身份同步**（UX-02B-04B-R1-03）。
 *
 * 为什么必须有它：Host 的 `workspaceKey` 是按**当前项目集合**重算的摘要
 * （`ProjectRuntime.workspaceKey()`），所以"成功移除一个项目"之后摘要一定变了。
 * 如果 Shell 继续沿用旧摘要自动保存，就会写出"新项目列表 + 旧摘要"这条**看起来有效**
 * 的恢复记录，下次启动既匹配不上（丢标签），又可能把旧工作区的记录当成新工作区的。
 *
 * 纪律（与 ADR-022 §7 / S11-C 恢复契约一致）：
 * - **只在本次操作仍归属当前工作区时**写入（`isCurrent(epoch)`）——迟到的探测结果
 *   不得把新工作区的摘要改掉；
 * - 探测失败 / 摘要形状非法 / Host 没有身份 → **待同步**：摘要置空，
 *   `serializeWorkspace` 会因此拒绝落盘，**绝不伪造**一个猜出来的摘要；
 * - 摘要真的变了才写，并且清掉旧摘要的本地记录，避免它被当成新工作区的旧记录；
 * - 只动摘要：标签、草稿、其它项目的树一概不碰（由调用方/reducer 保证）。
 *
 * 纯状态机 + 窄端口：不碰 storage、不碰 React，可用 deferred 精确驱动。
 */
import type { WorkspaceIdentity } from '../client/client-api.ts';
import { isWorkspaceKey } from './workspace-persistence.ts';

/** 身份同步所需的窄端口（只需只读健康检查）。 */
export interface WorkspaceIdentityPort {
  workspaceIdentity(): Promise<WorkspaceIdentity>;
}

export interface WorkspaceIdentitySyncHost {
  readonly port: WorkspaceIdentityPort;
  /** 当前界面里的摘要；`null` 表示已经处于"待同步"。 */
  currentKey(): string | null;
  /** 给定代次是否仍是当前工作区（切模式 / 重连 / 换工作区都会推进 epoch）。 */
  isCurrent(epoch: number): boolean;
  /** 写入新摘要；`null` = 待同步（让自动保存停下来，而不是写一条假记录）。 */
  onWorkspaceKey(key: string | null): void;
  /** 旧摘要的本地记录不再代表本工作区：清掉，避免被认领成"新工作区的旧记录"。 */
  onDropRecord?(workspaceKey: string): void;
}

export type IdentitySyncOutcome =
  /** 摘要没变：不需要任何写入。 */
  | { status: 'unchanged'; workspaceKey: string }
  /** 摘要变化：已写入新摘要，旧记录已清理。 */
  | { status: 'updated'; workspaceKey: string; previousKey: string | null }
  /** 无法确认身份：摘要已置空（待同步），等下一次成功探测。 */
  | {
      status: 'pending';
      reason: 'probe-failed' | 'invalid-key' | 'identity-absent';
    }
  /** 探测期间工作区已切换：结果一律丢弃。 */
  | { status: 'stale' };

export interface WorkspaceIdentitySync {
  /** 在一次结构性变更（移除项目）之后刷新摘要。`epoch` 是变更开始时的代次。 */
  refresh(epoch: number): Promise<IdentitySyncOutcome>;
}

export function createWorkspaceIdentitySync(host: WorkspaceIdentitySyncHost): WorkspaceIdentitySync {
  return {
    async refresh(epoch) {
      const before = host.currentKey();

      let identity: WorkspaceIdentity;
      try {
        identity = await host.port.workspaceIdentity();
      } catch {
        // 探测失败：可能是 Host 正忙/重启中。此刻**已经知道项目集合变了**，
        // 继续沿用旧摘要就是伪造身份，因此统一收敛为"待同步"。
        if (!host.isCurrent(epoch)) return { status: 'stale' };
        host.onWorkspaceKey(null);
        return { status: 'pending', reason: 'probe-failed' };
      }

      // 迟到的探测：期间切模式 / 重连 / 换了工作区 → 一个 dispatch 都不发
      if (!host.isCurrent(epoch)) return { status: 'stale' };

      const next = identity.workspaceKey;
      if (next === null) {
        host.onWorkspaceKey(null);
        return { status: 'pending', reason: 'identity-absent' };
      }
      if (!isWorkspaceKey(next)) {
        // 形状不对就当"没拿到"：不写进状态，避免把垃圾串当成工作区身份
        host.onWorkspaceKey(null);
        return { status: 'pending', reason: 'invalid-key' };
      }
      if (next === before) {
        return { status: 'unchanged', workspaceKey: next };
      }

      // 旧摘要的记录属于"上一个项目集合"，留着只会被下次启动误认领
      if (before !== null && isWorkspaceKey(before)) host.onDropRecord?.(before);
      host.onWorkspaceKey(next);
      return { status: 'updated', workspaceKey: next, previousKey: before };
    },
  };
}
