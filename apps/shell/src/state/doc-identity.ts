/**
 * 文档身份（G2-06）。
 *
 * Multi：`doc:<projectId>/<relativePath>`；Legacy / Demo：仍为原来的相对路径。
 * 这两个 ID 必须被视为**完全不同的文档**——它们决定标签、编辑队列、保存锁与草稿备份键。
 *
 * 纪律：
 * - `DocTab` 显式记录 `projectId`，任何操作都不得靠拆字符串反推项目；
 * - 本模块只提供纯函数，便于在 Node 里直接测试（不依赖 React）。
 */
import type { ProjectSummary } from '../client/client-api.ts';

/** 项目限定 docId；无项目（Legacy / Demo）时保持原样。 */
export function makeDocId(projectId: string | null | undefined, path: string): string {
  return projectId ? `doc:${projectId}/${path}` : path;
}

/** 从 docId 里取项目命名空间（仅供诊断展示，业务判定请用 tab.projectId）。 */
export function projectIdOfDocId(docId: string): string | null {
  const match = /^doc:([^/]+)\//.exec(docId);
  return match ? match[1] : null;
}

/** 草稿备份键：必须同时包含项目与文档身份，避免 A/a.md 与 B/a.md 相互覆盖。 */
export function draftBackupKey(projectId: string | null | undefined, path: string): string {
  return `${projectId ?? 'local'}:${path}`;
}

/**
 * 异步响应归属判定（G2-10）。
 *
 * 请求发出时捕获 `captured`，响应回来时与「当前状态」比对：只有项目、文档、
 * 会话三者都仍然一致才允许回填。标签已关闭、项目已切换、会话被替换时一律丢弃。
 */
export interface ResponseOwner {
  projectId: string | null;
  docId: string;
  sessionId: string | null;
}

export interface CurrentOwner {
  projectId: string | null;
  docId: string;
  sessionId: string | null;
  exists: boolean;
}

export function isResponseOwnerCurrent(captured: ResponseOwner, current: CurrentOwner): boolean {
  if (!current.exists) return false;
  if (captured.docId !== current.docId) return false;
  if ((captured.projectId ?? null) !== (current.projectId ?? null)) return false;
  // 会话被替换（重新打开产生了新的 Session）时，旧响应不得覆盖新缓冲
  if ((captured.sessionId ?? null) !== (current.sessionId ?? null)) return false;
  return true;
}

/** 项目显示名：标签/状态栏用，找不到时退回 projectId。 */
export function projectLabelOf(
  projects: readonly ProjectSummary[] | undefined,
  projectId: string | null | undefined,
): string | null {
  if (!projectId) return null;
  return projects?.find((project) => project.projectId === projectId)?.name ?? projectId;
}

/** 项目是否可以继续打开新的磁盘文件（UNAVAILABLE 只能保留既有标签）。 */
export function isProjectOpenable(
  projects: readonly ProjectSummary[] | undefined,
  projectId: string | null | undefined,
): boolean {
  if (!projectId) return true;
  const project = projects?.find((item) => item.projectId === projectId);
  // 列表尚未加载时不阻断（Legacy / 首次加载）；只有明确 UNAVAILABLE 才阻断
  return project ? project.status === 'READY' : true;
}
