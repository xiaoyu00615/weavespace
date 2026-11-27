/**
 * 结构变更的**异步归属**（UX-02C-02-R2.1）。
 *
 * 一次改名/移动是"多段 await + 多个副作用"的组合：请求飞行、层表刷新、目标展开、
 * 只读核对，每一段之后世界都可能换了一代（切工作区、切模式、重新加载）。R2 只把
 * **源对象身份**钉住了，没有钉住"这条结果还该不该写进这一屏"：
 * - 旧工作区的 APPLIED 会作废新工作区的层表；
 * - 旧请求的 UNKNOWN 会在新工作区触发只读刷新；
 * - 旧请求的拒绝原因会写进另一个会话的输入框。
 *
 * 本模块给出**一把票**（`StructureWorld`）和一个**闸门**（`createStaleGuard`）：
 * 票据在"打开意图/发起提交"时冻结，闸门在每一次副作用之前重新核验。它不是
 * 第二套状态机——代次仍复用 `createLoadEpoch`，工作区摘要仍是 `workspaceKey`。
 *
 * 刻意**不**包含 `activeProjectId`：同一工作区内切换活动项目，不该阻止原项目
 * 真实结构变化的同步（那是两件不同的事）。
 *
 * 纯 TS：不碰 React / DOM / 网络 / 磁盘。
 */

/** 发起一次结构变更时所在的世界。 */
export interface StructureWorld {
  /** `live` / `demo`。 */
  readonly mode: string;
  /** `multi` / `legacy` / `static`。 */
  readonly workspaceMode: string;
  /** Host 的工作区摘要；换根 / 换工作区时变化。 */
  readonly workspaceKey: string | null;
  /** 工作区加载代次（`createLoadEpoch`）：切模式 / 重连 / 重新加载都会推进。 */
  readonly epoch: number;
}

/** 稳定字符串键：只用于比较与测试断言，不参与业务派生。 */
export function structureWorldKey(world: StructureWorld): string {
  return [world.mode, world.workspaceMode, world.workspaceKey ?? '', String(world.epoch)].join('\u0000');
}

/**
 * 两个世界还是不是同一个。
 *
 * 四个维度缺一不可：`Live → Demo → Live` 之后 `mode` 又变回 `live`，
 * 只有代次能证明"这一轮已经不是刚才那一轮"。
 */
export function structureWorldProblem(
  start: StructureWorld,
  now: StructureWorld,
): string | null {
  if (start.mode !== now.mode) return '工作区模式已经切换，结果没有写入当前界面';
  if (start.workspaceMode !== now.workspaceMode) return '工作区模式已经切换，结果没有写入当前界面';
  if (start.workspaceKey !== now.workspaceKey) return '工作区已经切换，结果没有写入当前界面';
  if (start.epoch !== now.epoch) return '工作区已重新加载，结果没有写入当前界面';
  return null;
}

export function structureWorldChanged(start: StructureWorld, now: StructureWorld): boolean {
  return structureWorldProblem(start, now) !== null;
}

export interface StaleGuard {
  /** 已作废（一旦作废就不再回头：代次只增不减）。 */
  readonly stale: boolean;
  /**
   * 副作用之前问一句："还属于发起时的那个世界吗？"
   *
   * 返回 `true` = 已作废，调用方必须**立即返回**，一个 dispatch / 一次请求都不发。
   */
  check(): boolean;
  /** 作废原因（给状态栏用）；仍有效时为 null。 */
  reason(): string | null;
}

/**
 * 多段 await 的闸门。
 *
 * 用法固定：`if (guard.check()) return;` —— 每次 await 之后、每次 dispatch 之前
 * 各一次。不要把它写成"只在开头判一次"，那正是 R2.1 要消灭的缺口。
 * 也**不要**在作废之后"补一条提示再顺手刷新一下"：作废的请求对当前界面零副作用。
 */
export function createStaleGuard(
  start: StructureWorld,
  now: () => StructureWorld,
): StaleGuard {
  let dropped = false;
  let why: string | null = null;
  return {
    get stale() {
      return dropped;
    },
    check() {
      if (!dropped) {
        const problem = structureWorldProblem(start, now());
        if (problem !== null) {
          dropped = true;
          why = problem;
        }
      }
      return dropped;
    },
    reason() {
      return why;
    },
  };
}

/* ------------------------------------------------------------------ */
/* 行内结果的路由（B02：共享 onNotice 的跨会话污染）                    */
/* ------------------------------------------------------------------ */

/**
 * 一条请求结果该写进哪个行内界面。
 *
 * 旧实现把提示同时写进 `naming` 和 `moveDialog`：只要有两个会话同时存在，
 * 另一个会话就会收到一条与它无关的错误（"这一行对应的对象已经变化"出现在
 * 一个完全不同的输入框里），用户据此会去改错的东西。
 *
 * 判据只有一条——**会话票据**。项目/路径相同不算：同一行可以先后开两个会话。
 */
export interface InlineNoticeTargets {
  readonly naming: boolean;
  readonly move: boolean;
}

export function inlineNoticeTargets(input: {
  /** 发起这次请求的会话票据；`null` = 没有会话（编辑器里的其它命令）。 */
  readonly sessionId: number | null;
  readonly namingSessionId: number | null;
  readonly moveSessionId: number | null;
}): InlineNoticeTargets {
  const { sessionId } = input;
  if (sessionId === null) return { naming: false, move: false };
  return {
    naming: input.namingSessionId !== null && input.namingSessionId === sessionId,
    move: input.moveSessionId !== null && input.moveSessionId === sessionId,
  };
}
