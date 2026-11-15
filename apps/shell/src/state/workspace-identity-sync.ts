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
  /**
   * 身份修订号（UX-02B-05-E）。
   *
   * 只靠"代次 + 本次同步的 issued 序号"不足以保证归属：04A 的添加流程**不推进**
   * `loadEpoch`（它只登记项目、更新摘要），也**不经过** `refresh()`，于是移除时发起的
   * 旧探测会通过两道判定，把添加流程刚确认的摘要覆盖回"中间态"。
   *
   * 修订号是"身份已经落定的次数"：任何一处在界面里写定摘要（添加 / 只读 resync /
   * 本模块自己的探测结论）都 +1。探测只在"发起时的修订号仍然成立"时才允许写，
   * 因此**添加、移除、只读重新同步能共同使旧探测失效**。
   */
  revision?: WorkspaceKeyRevision;
  /** 写入新摘要；`null` = 待同步（让自动保存停下来，而不是写一条假记录）。 */
  onWorkspaceKey(key: string | null): void;
  /** 旧摘要的本地记录不再代表本工作区：清掉，避免被认领成"新工作区的旧记录"。 */
  onDropRecord?(workspaceKey: string): void;
}

/** 身份修订号：单调递增，只用来判"这条探测的归属是否已经被后来者取代"。 */
export interface WorkspaceKeyRevision {
  current(): number;
  /** 一处身份刚刚落定（摘要已写入界面）。 */
  bump(): void;
}

export function createWorkspaceKeyRevision(): WorkspaceKeyRevision {
  let value = 0;
  return {
    current: () => value,
    bump: () => {
      value += 1;
    },
  };
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

/**
 * 把同步结论落到写入门禁上（R2-01）。
 *
 * 抽成纯函数是为了让 Provider 与测试用**同一条**规则：
 * - `updated` / `unchanged`：拿到（或确认）了新摘要 → 放开写入；
 * - `pending`：仍在待同步 → 继续拦住（摘要已被置空，不会伪造）；
 * - `stale`：工作区已经切走 → 这里不碰，由切换点自己收尾。
 */
export function settleIdentitySync(
  gate: { holdIdentity(): void; releaseIdentity(): void },
  outcome: IdentitySyncOutcome,
): 'released' | 'held' | 'ignored' {
  if (outcome.status === 'updated' || outcome.status === 'unchanged') {
    gate.releaseIdentity();
    return 'released';
  }
  if (outcome.status === 'pending') {
    gate.holdIdentity();
    return 'held';
  }
  return 'ignored';
}

/**
 * 把"摘要落地"这件事同时落到写入门禁上（R2E E-01）。
 *
 * 场景：移除**最后一个**项目之后，Host 的项目集合为空，`/api/health` 不再给出
 * `workspaceKey`。此时进入"待同步"是对的（不能凭空造一个空工作区摘要），
 * 但门禁不能就此永久合上——用户随后通过添加流程注册新项目，Host 会给出**新的**
 * 有效摘要，这一刻身份已经确定，写入资格必须自动恢复，否则新工作区永远不会
 * 产生恢复记录。
 *
 * 反过来，摘要为空或形状非法时**继续拦住**：Host 身份不可确认就不写。
 * 这条规则与 `settleIdentitySync` 共用一个原则：只有"能确认的身份"才放行。
 */
export function settleWorkspaceKey(
  gate: { holdIdentity(): void; releaseIdentity(): void },
  workspaceKey: string | null,
): 'released' | 'held' {
  if (workspaceKey !== null && isWorkspaceKey(workspaceKey)) {
    gate.releaseIdentity();
    return 'released';
  }
  gate.holdIdentity();
  return 'held';
}

export function createWorkspaceIdentitySync(host: WorkspaceIdentitySyncHost): WorkspaceIdentitySync {
  /**
   * 同步序号（UX-02B-05-01）。
   *
   * 一次会话里可能连着发起多次刷新：移除 A 之后、移除 B 之后各一次。它们各自
   * 异步返回，**只有最后发起的那次**代表当前的结构；更早的结果哪怕更晚到达，
   * 也只反映"中间某个时刻的项目集合"，绝不能拿它改写摘要或释放写入门禁
   * （否则会出现"界面已是空集合，摘要却停在只剩 B"这种认错工作区的状态）。
   */
  let issued = 0;

  /**
   * 这条探测是否已经被**后来落定的身份**取代（UX-02B-05-E）。
   *
   * `issued` 只能发现"又发起了一次 refresh"。真正的对手是添加项目与只读重新同步：
   * 它们不走 `refresh()`、也不推进 `loadEpoch`，却在 `applyWorkspaceKey` 里写下了
   * 一个**更新**的摘要。若还按 `issued` 判，移除时那条旧探测会理直气壮地把
   * `keyBC` 改回 `keyB`（成功分支）或置成 `null`（失败分支）。
   *
   * 判据改成"身份修订号是否还是发起时那个"：一旦别处落定了新身份，这条探测
   * 反映的就是**已被取代的结构**，无论返回什么都只能丢弃。
   */
  const superseded = (revisionAtStart: number): boolean =>
    (host.revision?.current() ?? 0) !== revisionAtStart;

  return {
    async refresh(epoch) {
      const ticket = ++issued;
      const before = host.currentKey();
      const revisionAtStart = host.revision?.current() ?? 0;

      let identity: WorkspaceIdentity;
      try {
        identity = await host.port.workspaceIdentity();
      } catch {
        // 探测失败：可能是 Host 正忙/重启中。此刻**已经知道项目集合变了**，
        // 继续沿用旧摘要就是伪造身份，因此统一收敛为"待同步"。
        if (!host.isCurrent(epoch)) return { status: 'stale' };
        // 已有更晚的刷新发起：这次失败属于过期的结构，交给最新那次定论
        if (ticket !== issued) return { status: 'stale' };
        // 期间别处已经确认过身份（添加项目 / 只读 resync）：这次失败没有裁决权，
        // 更不能把已确认的摘要打回 null
        if (superseded(revisionAtStart)) return { status: 'stale' };
        host.onWorkspaceKey(null);
        host.revision?.bump();
        return { status: 'pending', reason: 'probe-failed' };
      }

      // 迟到的探测：期间切模式 / 重连 / 换了工作区 → 一个 dispatch 都不发
      if (!host.isCurrent(epoch)) return { status: 'stale' };
      // 被更晚发起的刷新取代：结果属于更早的结构，同样一个 dispatch 都不发
      if (ticket !== issued) return { status: 'stale' };
      // 期间别处落定了更新的摘要：本探测已被取代，不得覆盖
      if (superseded(revisionAtStart)) return { status: 'stale' };

      const next = identity.workspaceKey;
      if (next === null) {
        host.onWorkspaceKey(null);
        host.revision?.bump();
        return { status: 'pending', reason: 'identity-absent' };
      }
      if (!isWorkspaceKey(next)) {
        // 形状不对就当"没拿到"：不写进状态，避免把垃圾串当成工作区身份
        host.onWorkspaceKey(null);
        host.revision?.bump();
        return { status: 'pending', reason: 'invalid-key' };
      }
      if (next === before) {
        return { status: 'unchanged', workspaceKey: next };
      }

      // 旧摘要的记录属于"上一个项目集合"，留着只会被下次启动误认领
      if (before !== null && isWorkspaceKey(before)) host.onDropRecord?.(before);
      host.onWorkspaceKey(next);
      // 本模块自己的写入同样计数：`issued` 已经兜住同模块内的先后，这里是为了让
      // "修订号 = 身份落定次数"对所有写入（含待同步的 null）都成立，不留例外。
      host.revision?.bump();
      return { status: 'updated', workspaceKey: next, previousKey: before };
    },
  };
}

/**
 * 「摘要落地」的统一入口（UX-02B-05-E）。
 *
 * Provider 的 `applyWorkspaceKey` 与测试共用这一个函数，规则只有一处：
 * 1. **先**推进身份修订号 —— 这一刻的身份由调用方确认，任何更早发起的探测
 *    都已属于被取代的结构（`refresh` 据此丢弃结果）；
 * 2. 再写入摘要并按"能否确认身份"收放写入门禁；
 * 3. 放行后重新排一次自动保存；只有从"待同步"回到确定身份才补提示。
 *
 * 顺序不可交换：修订号与摘要写入同属一个**同步片段**（中间没有 await，探测无法穿插），
 * 但"先记落定、再写界面"让语义自解释——修订号的含义是"已有更新的身份落定"，
 * 而不是"摘要恰好被写过一次"。后来者改这里时最容易犯的错就是把它挪到探测之后。
 */
export interface WorkspaceKeyApplierHost {
  readonly revision: WorkspaceKeyRevision;
  readonly gate: {
    holdIdentity(): void;
    releaseIdentity(): void;
    identityPending(): boolean;
  };
  /** 写入界面状态（`SET_WORKSPACE_KEY`）。 */
  setKey(workspaceKey: string | null): void;
  /** 身份确定后重新排程自动保存。 */
  schedule(): void;
  /** 从"待同步"回到确定身份时的提示（可选）。 */
  onIdentityRecovered?(): void;
}

export interface WorkspaceKeyApplier {
  apply(workspaceKey: string | null): 'released' | 'held';
}

export function createWorkspaceKeyApplier(host: WorkspaceKeyApplierHost): WorkspaceKeyApplier {
  return {
    apply(workspaceKey) {
      host.revision.bump();
      const wasPending = host.gate.identityPending();
      host.setKey(workspaceKey);
      if (settleWorkspaceKey(host.gate, workspaceKey) !== 'released') return 'held';
      host.schedule();
      if (wasPending) host.onIdentityRecovered?.();
      return 'released';
    },
  };
}
