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
  load(projectId: string, dir: string): Promise<unknown>;
  notice(message: string): void;
}

export type StructureApplyResult = 'applied' | 'stale';

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
 * UNKNOWN 的只读核对（恰好一次）。
 *
 * 作废时**一个请求都不发**：旧世界的 UNKNOWN 不该让新工作区去读旧路径的层。
 */
export async function checkStructureLocationsWithOwnership(input: {
  readonly start: StructureWorld;
  readonly projectId: string;
  readonly sourceParentDir: string;
  readonly targetParentDir: string;
  readonly host: StructureRefreshHost;
}): Promise<StructureApplyResult> {
  const guard = createStaleGuard(input.start, () => input.host.world());
  if (guard.check()) return 'stale';
  await input.host.load(input.projectId, input.sourceParentDir);
  if (guard.check()) return 'stale';
  if (input.targetParentDir !== input.sourceParentDir) {
    await input.host.load(input.projectId, input.targetParentDir);
    if (guard.check()) return 'stale';
  }
  return 'applied';
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
}): Promise<StructureApplyResult> {
  const guard = createStaleGuard(input.start, () => input.host.world());
  if (guard.check()) return 'stale';
  await input.host.load(input.projectId, parentDirOfEntry(input.sourcePath));
  if (guard.check()) return 'stale';
  return 'applied';
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
