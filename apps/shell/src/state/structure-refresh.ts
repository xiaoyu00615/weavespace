/**
 * 结构变更**结果落地**的归属编排（UX-02C-02-R2.1 / B03）。
 *
 * 为什么单独成模块：`.tsx` 不能被 `node:test` import，而这一段的正确性完全是
 * **时序**问题——"请求在旧世界里发出、结果在新世界里回来"。把它留在组件里，
 * 只能靠源码字符串断言，证明不了"迟到的 APPLIED 会不会作废新工作区的层表"。
 *
 * 三条纪律（每一条都对应一个已经发生的缺陷）：
 * 1. **实际结果与界面回填分离**：Host 说 APPLIED 就是 APPLIED，界面不写不等于失败；
 * 2. **每一次副作用前重新核验归属**：多段 `await` 之间世界会变，开头判一次不够；
 * 3. **跨世界零副作用**：作废之后一个 `dispatch`、一次刷新、一次展开都不发，
 *    只允许一条全局提示（"已改完，但没写进这一屏"）。
 *
 * 不是第二套状态机：判据仍是 `mode + workspaceMode + workspaceKey + epoch`。
 * 纯 TS：不碰 React / DOM / 网络 / 磁盘。
 */
import type { StructureChangeOutcome } from '../client/client-api.ts';
import { parentDirOfEntry } from '../../../../packages/storage/entry-name.ts';
import type { TreeLevels } from '../components/tree-model.ts';
import type { TreeLoadOutcome } from './tree-load.ts';
import {
  createStaleGuard,
  structureWorldChanged,
  type StructureWorld,
} from './structure-ownership.ts';
import { structureChangeNotice } from './structure-change.ts';

type AppliedOutcome = Extract<StructureChangeOutcome, { status: 'APPLIED' }>;

export interface StructureRefreshHost {
  /** 实时世界（每次副作用前现读，绝不用闭包快照）。 */
  world(): StructureWorld;
  levels(projectId: string): TreeLevels;
  invalidateLevel(projectId: string, dir: string): void;
  /** `TREE_STRUCTURE_CHANGED`：删旧层缓存 / 展开 / 选择记录。 */
  markStructureChanged(projectId: string, sourcePath: string, targetPath: string): void;
  expandFolder(projectId: string, path: string): void;
  /**
   * 重新取一层。**必须**把真实的 `TreeLoadOutcome` 交回来
   * （UX-02C-02-R2.2-PATCH / P02）。
   *
   * 旧签名是 `Promise<unknown>`，实现里写 `await treeLoader.load(...)` —— 返回值
   * 被就地丢掉。于是"底层返回 failed / rejected / skipped-inflight"与"真的加载成功"
   * 在编排层看起来一模一样，界面据此宣称"已只读刷新源位置与目标位置"。
   */
  load(projectId: string, dir: string): Promise<TreeLoadOutcome>;
  notice(message: string): void;
}

export type StructureApplyResult = 'applied' | 'stale';

/**
 * 一次只读核对的结论（UX-02C-02-R2.2-PATCH / P02）。
 *
 * - `applied`：每个必要位置都明确加载成功，这一屏的数据确实刷新了；
 * - `partial`：请求发出去了，但有位置没被确认加载完成（或世界在途中变了）；
 * - `stale`：一个请求都没发（世界已切换，闸门作废）；
 * - `failed`：请求都发了，但没有一个位置成功。
 *
 * 提示文案必须按它来写：只有 `applied` 允许说"已只读刷新"。
 */
export type StructureCheckOutcome = 'applied' | 'partial' | 'stale' | 'failed';

/**
 * APPLIED 之后的层表同步。
 *
 * 顺序沿用 R2：作废旧路径下已加载的层 → 源父层与目标父层各自作废 → 通知 reducer
 * → 重新取两层 → 展开目标的祖先。每一段之前都过一次闸门。
 */
export async function applyStructureChangeWithOwnership(input: {
  readonly start: StructureWorld;
  readonly outcome: AppliedOutcome;
  readonly host: StructureRefreshHost;
}): Promise<StructureApplyResult> {
  const { outcome, host } = input;
  const guard = createStaleGuard(input.start, () => host.world());
  const projectId = outcome.projectId;
  const sourceParent = parentDirOfEntry(outcome.sourcePath);
  const targetParent = outcome.targetParentDir;

  // 第一个副作用之前：世界已经换了就什么都不做（连作废层表都不做）
  if (guard.check()) return 'stale';

  const levels = host.levels(projectId) ?? {};
  for (const dir of Object.keys(levels)) {
    if (dir === outcome.sourcePath || dir.startsWith(`${outcome.sourcePath}/`)) {
      host.invalidateLevel(projectId, dir);
    }
  }
  host.invalidateLevel(projectId, sourceParent);
  host.invalidateLevel(projectId, targetParent);
  host.markStructureChanged(projectId, outcome.sourcePath, outcome.targetPath);

  if (guard.check()) return 'stale';
  await host.load(projectId, sourceParent);
  if (guard.check()) return 'stale';
  if (targetParent !== sourceParent) {
    await host.load(projectId, targetParent);
    if (guard.check()) return 'stale';
  }

  // 尽可能展开目标位置的祖先目录，让用户看到新位置；分页未加载到的节点不假装可见
  const refreshed = host.levels(projectId) ?? {};
  const allNodes = Object.values(refreshed).flatMap((level) => level.entries);
  for (const dir of ancestorDirsOf(targetParent)) {
    const folder = allNodes.find((node) => node.kind === 'folder' && (node.path ?? '') === dir);
    if (!folder) continue;
    if (guard.check()) return 'stale';
    host.expandFolder(projectId, folder.id);
  }

  host.notice(structureChangeNotice(outcome));
  return 'applied';
}

/** 目标父目录的逐级祖先（`a/b/c` → `a`, `a/b`, `a/b/c`）；根为空数组。 */
export function ancestorDirsOf(dir: string): string[] {
  const segments = dir.split('/').filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i <= segments.length; i += 1) out.push(segments.slice(0, i).join('/'));
  return out;
}

/**
 * 一次（或多次）真实加载的**合并结论**（UX-02C-02-R2.2-PATCH / P02）。
 *
 * 四种情况必须分开，不能再用"没抛异常就是成功"来糊：
 * - 零请求（世界已切换，一次都没发）→ `stale`；
 * - 请求发出去了，但世界在途中变了 / 有的位置没确认加载完成 → `partial`；
 * - 请求都发了、全都失败 → `failed`；
 * - 每个必要位置都明确 `applied` → `applied`。
 */
export function structureLoadVerdict(
  outcomes: readonly TreeLoadOutcome[],
  worldChanged: boolean,
): StructureCheckOutcome {
  if (outcomes.length === 0) return worldChanged ? 'stale' : 'failed';
  if (worldChanged) return 'partial';
  if (outcomes.every((outcome) => outcome === 'applied')) return 'applied';
  return outcomes.some((outcome) => outcome === 'applied') ? 'partial' : 'failed';
}

/**
 * UNKNOWN 的只读核对（恰好一次）。
 *
 * 作废时**一个请求都不发**：旧世界的 UNKNOWN 不该让新工作区去读旧路径的层。
 *
 * 返回值是**核对本身**的结论，不是结构变更的结论。`load` 的真实
 * `TreeLoadOutcome` 必须逐个收集：`failed` / `rejected` / `changed` /
 * `skipped-inflight` / `skipped-mode` 都意味着"这一层没被确认加载成功"，
 * 一个都不能当成"已刷新"。
 */
export async function checkStructureLocationsWithOwnership(input: {
  readonly start: StructureWorld;
  readonly projectId: string;
  readonly sourceParentDir: string;
  readonly targetParentDir: string;
  readonly host: StructureRefreshHost;
}): Promise<StructureCheckOutcome> {
  const guard = createStaleGuard(input.start, () => input.host.world());
  const dirs =
    input.targetParentDir !== input.sourceParentDir
      ? [input.sourceParentDir, input.targetParentDir]
      : [input.sourceParentDir];
  const outcomes: TreeLoadOutcome[] = [];
  for (const dir of dirs) {
    // 每次请求之前重新核验归属：中途换世界就不再发下一个
    if (guard.check()) return structureLoadVerdict(outcomes, true);
    outcomes.push(await input.host.load(input.projectId, dir));
  }
  // 最后这次看的是"数据到底进没进这一屏"：世界变了就不算完成
  if (guard.check()) return structureLoadVerdict(outcomes, true);
  return structureLoadVerdict(outcomes, false);
}

/**
 * 拒绝之后刷新源父层（R2 的 `onRejected` 落地）。
 *
 * 只有 Host 给出的拒绝**是磁盘事实**（源对象变了 / 源不在了）时才需要重取；
 * 其余拒绝（授权、会话忙、目标已存在）只影响这一次命令，不动层表。
 */
export function structureRejectionInvalidatesSource(
  errorCode: string | null | undefined,
): boolean {
  return errorCode === 'ERR_ENTRY_SOURCE_CHANGED' || errorCode === 'ERR_RESOURCE_NOT_FOUND';
}

export async function refreshStructureSourceParent(input: {
  readonly start: StructureWorld;
  readonly projectId: string;
  readonly sourcePath: string;
  readonly host: StructureRefreshHost;
}): Promise<StructureCheckOutcome> {
  const guard = createStaleGuard(input.start, () => input.host.world());
  if (guard.check()) return 'stale';
  const outcome = await input.host.load(input.projectId, parentDirOfEntry(input.sourcePath));
  return structureLoadVerdict([outcome], guard.check());
}

/**
 * 目标身份变化后刷新"目标目录所属父层"（UX-02C-02-R2.2 / F02）。
 *
 * `ERR_ENTRY_TARGET_CHANGED` 不只是一条错误：它同时是一条**磁盘事实**——
 * 层表里那个文件夹行挂着的锚已经过期。只把错误显示出来、留着过期锚，
 * 用户下一次提交还会撞在同一道墙上（永远无法重新确认目标）。
 *
 * 取的是**父层**而不是目标层本身：目标文件夹的锚存在父层的 `anchors[dir]` 里；
 * 项目根（`''`）的锚在根层的 `projectAnchor` 里，所以根目标要重取根层。
 *
 * 归属仍按发起意图时的世界票据核验：跨工作区/跨代次不发请求。
 */
export async function refreshStructureTargetParent(input: {
  readonly start: StructureWorld;
  readonly projectId: string;
  readonly targetParentDir: string;
  readonly host: StructureRefreshHost;
}): Promise<StructureCheckOutcome> {
  const guard = createStaleGuard(input.start, () => input.host.world());
  if (guard.check()) return 'stale';
  const dir = input.targetParentDir === '' ? '' : parentDirOfEntry(input.targetParentDir);
  const outcome = await input.host.load(input.projectId, dir);
  return structureLoadVerdict([outcome], guard.check());
}

/**
 * UNKNOWN 提示的**真实性**（UX-02C-02-R2.2 / F03）。
 *
 * 旧文案无条件写"已只读刷新源位置与目标位置"。可是只读核对也会不执行
 * （世界已经换了 → 闸门作废、一个请求都不发），也可能失败（网络/服务不可用）。
 * 零刷新请求却宣称"已刷新"，会让用户以为树已经是对的了。
 *
 * 三种结论分开说，且都不承诺"会自动重试"。
 */
export function structureUnknownNotice(check: StructureCheckOutcome): string {
  const tail = '（不会自动重试、不会自行回滚）';
  if (check === 'applied') {
    return `结构变更结果未确认：已只读刷新源位置与目标位置，请人工核对${tail}`;
  }
  if (check === 'stale') {
    return `结构变更结果未确认：当前界面已经切换，没有执行只读核对，请手动刷新后核对${tail}`;
  }
  if (check === 'partial') {
    return `结构变更结果未确认：只读刷新只完成了一部分（有位置未确认加载完成），请手动刷新后核对${tail}`;
  }
  return `结构变更结果未确认：只读核对没有完成，请手动刷新后核对${tail}`;
}

/** 给调用方的一句话：Host 已经完成，但这一屏没有回填。 */
export function staleStructureNotice(
  outcome: AppliedOutcome,
  reason: string | null,
): string {
  const base = `已把「${outcome.sourcePath}」变更为「${outcome.targetPath}」`;
  return `${base}；${reason ?? '当前界面已经切换'}（未刷新文件树，不会自动重发）`;
}

export { structureWorldChanged };
