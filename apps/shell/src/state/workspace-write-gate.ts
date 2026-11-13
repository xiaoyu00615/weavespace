/**
 * 恢复期间的写入门禁（S11-C-R1 · AS-01…AS-05）。
 *
 * 为什么需要它：恢复是**分阶段、异步**的。阶段 C 一个一个后台登记标签，而
 * `WorkspaceState` 每变一次都会触发自动保存。如果这期间允许写入，那么"刚恢复了 2 个
 * 标签"的状态就会覆盖掉"上次离开时有 8 个标签"的记录——**旧记录被自己的恢复流程毁掉**。
 * 把节流延迟调大只是把窗口缩小，不是修复。
 *
 * 因此写入必须在恢复期间被**明确拦住**，并且拦到什么程度、什么时候放开，都要有
 * 可测试的规则：
 *
 * | 状态     | 触发                                   | 写入 | 说明 |
 * |----------|----------------------------------------|------|------|
 * | `open`   | 初始 / `release()` / `adopt()`         | 允许 | 正常自动保存 |
 * | `held`   | `hold()`（恢复开始）                   | 拒绝 | 存储**完全不被触碰**，旧记录原样保留 |
 * | `sealed` | `seal()`（恢复被中断 / 被用户接管）    | 拒绝 | 记录被保护；只有显式提交点才放开 |
 *
 * **提交规则（AS-05）**：恢复被中断后，用户的结构性操作（打开文件、关闭标签、切换模式）
 * 视为"接管"：Provider 调用 `adopt()`，此后的第一次写入是**合并提交**——当前标签 +
 * 恢复正常流程还没处理完的旧标签（结转），一条都不丢。纯视觉操作（拖动分屏、折叠、
 * 切焦点）**不**构成接管：记录继续保持原样，下次启动仍按完整记录恢复。
 *
 * 本模块是纯状态机：不碰存储、不碰 React，测试可以直接断言状态迁移。
 */

export type GateState = 'open' | 'held' | 'sealed';

/** 被拦住的原因（诊断/测试用；`null` 表示没有拦截）。 */
export type GateReason = 'restoring' | 'interrupted' | null;

export interface WorkspaceWriteGate {
  /** 恢复开始：禁止一切自动写入。 */
  hold(): void;
  /** 恢复到达可提交的终态（成功 / 明确降级）：放开写入。 */
  release(): void;
  /** 恢复被中断或被用户接管：继续保护旧记录，直到显式提交。 */
  seal(): void;
  /** 用户接管后的显式提交点：放开写入，下一次写入即合并提交。 */
  adopt(): void;
  state(): GateState;
  reason(): GateReason;
  /** 唯一判定入口：自动保存据此决定"能不能写"。 */
  allowsWrite(): boolean;
}

export function createWorkspaceWriteGate(): WorkspaceWriteGate {
  let state: GateState = 'open';
  let reason: GateReason = null;
  /**
   * 恢复还在进行时用户就接管了（结构性操作）。
   *
   * 这时**不能**立刻放开写入：阶段 C 还没跑完，此刻的状态仍是残缺的。
   * 只记下意图，等恢复到达终态时按"合并提交"处理（结转列表此时已经就绪）。
   */
  let adoptPending = false;

  return {
    hold() {
      state = 'held';
      reason = 'restoring';
      adoptPending = false;
    },
    release() {
      // 只有"被这次恢复持有"才谈得上放开：sealed 必须走 adopt，
      // 否则中断的恢复会借着一次 release 悄悄把记录换掉。
      if (state !== 'held') return;
      state = 'open';
      reason = null;
      adoptPending = false;
    },
    seal() {
      if (state !== 'held') return;
      // 用户已经接管：终态就是"合并提交"，直接放开（结转列表已在途中准备好）
      if (adoptPending) {
        state = 'open';
        reason = null;
        adoptPending = false;
        return;
      }
      state = 'sealed';
      reason = 'interrupted';
    },
    adopt() {
      if (state === 'sealed') {
        state = 'open';
        reason = null;
        return;
      }
      // 恢复进行中：记下接管意图，等终态再放开，避免用残缺状态抢先落盘
      if (state === 'held') adoptPending = true;
    },
    state() {
      return state;
    },
    reason() {
      return reason;
    },
    allowsWrite() {
      return state === 'open';
    },
  };
}
