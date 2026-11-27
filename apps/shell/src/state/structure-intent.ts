/**
 * 真实改名 / 移动的**资源意图身份**（UX-02C-02-R2）。
 *
 * 一次改名/移动从"用户点开输入行"到"Host 动手"之间，世界会变：
 * 树可能刷新、文件可能被外部换成同名新对象、Provider 可能换了一种身份能力。
 * 所以意图必须携带**打开那一刻**的身份预期，而不是提交时再算一遍：
 *
 * - **捕获**：打开输入行 / 移动对话框时冻结 `anchor`（不透明摘要）与身份状态；
 * - **不自动刷新**：输入期间无论界面怎么变，预期都保持原样——把它悄悄换成
 *   最新值，等于把"改的已经不是那个对象了"这件事藏起来；
 * - **提交前核验**：用当前树里的锚再比一次，不一致就**本地拒绝、不发请求**；
 *   Host 仍会独立再核验一次（权威在那里，这里只是尽早给用户一个明确原因）。
 *
 * 为什么锚可以当预期而不能当授权：它由 Host 用自己 `lstat` 到的 `dev:ino`
 * 派生，客户端只负责原样回传；Host 拿到后**自己重算**再比对，不采信客户端
 * 自述的身份。锚既不能解锁任何路径，也不能替代权限判定。
 */
import type { StructureEntryKind } from './structure-change.ts';

/** 与 `tree-commands.ts` 同一套三态；这里独立声明，避免交互层与结构层互相依赖。 */
export type StructureIdentityState = 'verified' | 'unsupported' | 'unverified';

const UNCONFIRMED = '无法确认这一行的身份，命令没有执行';
const IDENTITY_UNAVAILABLE = '这一行的身份无法核验，无法改名或移动';
const IDENTITY_STATE_CHANGED = '这一行的身份状态已经变化，命令没有执行';
const OBJECT_CHANGED = '这一行对应的对象已经变化，命令没有执行';

export interface StructureIntent {
  /** 冻结时的项目；跨项目提交必须被拒。 */
  readonly projectId: string;
  /** 冻结时的项目内相对路径（源）。 */
  readonly sourcePath: string;
  readonly entryKind: StructureEntryKind;
  /**
   * 打开意图时那一行的资源锚（32 位十六进制）。
   *
   * 整个会话内**不可被自动刷新**：它是"用户想改的是哪个对象"的唯一依据。
   */
  readonly anchor: string;
  /** 与锚同时冻结的身份状态，用于区分"能力变了"和"对象变了"。 */
  readonly verification: StructureIdentityState;
  /** 会话票据：结果回来时据此判断是否还属于当前输入行。 */
  readonly sessionId: number;
}

export type CaptureStructureIntentResult =
  | { ok: true; intent: StructureIntent }
  | { ok: false; reason: string };

/**
 * 冻结一次结构变更意图。**没有锚就不放行**——这里不提供"按路径凑合"的分支，
 * 因为那正是 R2 要消灭的静默降级。
 */
export function captureStructureIntent(input: {
  readonly projectId: string;
  readonly sourcePath: string;
  readonly entryKind: StructureEntryKind;
  readonly anchor: string | null;
  readonly verification: StructureIdentityState;
  readonly sessionId: number;
}): CaptureStructureIntentResult {
  if (input.projectId === '' || input.sourcePath === '') {
    return { ok: false, reason: '源路径不合法' };
  }
  if (input.verification === 'unsupported') {
    // Provider 自己说"我核验不了"：这条路径上没有任何身份可冻结
    return { ok: false, reason: IDENTITY_UNAVAILABLE };
  }
  if (input.verification !== 'verified') {
    // unverified：这次探测失败（对象消失 / lstat 失败），不能当成"路径即身份"
    return { ok: false, reason: UNCONFIRMED };
  }
  if (typeof input.anchor !== 'string' || input.anchor === '') {
    return { ok: false, reason: UNCONFIRMED };
  }
  return {
    ok: true,
    intent: Object.freeze({
      projectId: input.projectId,
      sourcePath: input.sourcePath,
      entryKind: input.entryKind,
      anchor: input.anchor,
      verification: input.verification,
      sessionId: input.sessionId,
    }),
  };
}

/**
 * 提交前核验：当前这一行还是不是意图里那个对象。
 *
 * 返回 `null` 表示"可以发出去"（Host 仍会独立核验）；否则返回给用户看的原因。
 * 三种拒绝刻意分开，因为对用户是三件事：查不到（可重试）、状态变了（系统）、
 * 对象变了（要刷新）。
 */
export function structureIntentProblem(input: {
  readonly intent: StructureIntent;
  readonly current: { readonly anchor: string | null; readonly verification: StructureIdentityState };
}): string | null {
  const { current } = input;
  if (current.verification === 'unverified') return UNCONFIRMED;
  if (current.verification === 'unsupported') return IDENTITY_STATE_CHANGED;
  if (current.anchor === null || current.anchor === '') return OBJECT_CHANGED;
  if (current.anchor !== input.intent.anchor) return OBJECT_CHANGED;
  return null;
}

/**
 * 结果回来时这一条还属不属于当前会话。
 *
 * `currentSessionId === null` 表示输入行已被收起——旧结果绝不能把它重新打开。
 */
export function structureSessionApplies(input: {
  readonly sessionId: number;
  readonly currentSessionId: number | null;
}): boolean {
  return input.currentSessionId !== null && input.currentSessionId === input.sessionId;
}
