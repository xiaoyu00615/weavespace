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
import type { ClientMode, ProjectSummary } from '../client/client-api.ts';

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

/**
 * 文件扩展名（小写含点）。
 *
 * 与 `capabilities/registry.ts` 的 `extensionOf` 语义一致；单独放在这里是为了让
 * 打开流程（`open-document.ts`）保持**纯 TS、可被 Node 直接执行**——
 * 注册表会拉入 React 插件模块，测试不需要为此承担 React 运行时。
 */
export function extensionOfPath(pathOrName: string): string {
  const base = pathOrName.replace(/\\/g, '/').split('/').pop() ?? pathOrName;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/** 是否存在未保存草稿：切换模式/工作区前必须为 false（G2-05 既有防护）。 */
export function hasUnsavedDrafts(tabs: readonly { dirty: boolean }[]): boolean {
  return tabs.some((tab) => tab.dirty);
}

/**
 * 磁盘刷新回填判定（G2-R1）。
 *
 * 与 `isResponseOwnerCurrent` 的区别：归属判定只回答"是不是同一个文档/会话"，
 * 这里还要回答"**这次读取发出之后，用户有没有动过这个文档**"。只要发生过本地编辑、
 * 保存或重载，旧读取结果就不得覆盖当前缓冲——那会把草稿回退成磁盘旧内容，
 * 并把 dirty 错误地重置为 false。
 */
export interface DiskRefreshSnapshot {
  mode: ClientMode;
  /** 本地编辑代次：每次 `editDoc` 递增（纯 UI 计数，不参与 Core 版本管理）。 */
  editEpoch: number;
  revision: number;
  baseVersion: string | null;
  buffer: string;
  dirty: boolean;
}

export interface DiskRefreshCapture extends DiskRefreshSnapshot {
  owner: ResponseOwner;
}

export interface DiskRefreshCurrent extends DiskRefreshSnapshot {
  owner: CurrentOwner;
}

export interface DiskRefreshIncoming {
  sessionId: string;
  revision: number;
  baseVersion: string | null;
  content: unknown;
}

export interface DiskRefreshInput {
  captured: DiskRefreshCapture;
  current: DiskRefreshCurrent;
  incoming: DiskRefreshIncoming;
}

/**
 * 是否允许把一次磁盘读取结果回填到标签。
 *
 * 全部条件都必须成立（fail-closed，任一不满足即丢弃这次读取）：
 * 1. 归属未变（项目 / 文档 / 会话）；
 * 2. 仍在 live 模式，且模式与发起时一致；
 * 3. 发起时与现在都没有草稿（dirty）；
 * 4. 本地编辑代次未变——请求期间用户没有继续输入；
 * 5. revision / baseVersion 未被保存或重载推进（旧结果不得回退版本）；
 * 6. 服务端返回的会话就是同一个，且 revision 不倒退；
 * 7. 内容或版本确实发生了变化（无变化时不需要回填，也不应打断用户）。
 */
export function canApplyDiskRefresh(input: DiskRefreshInput): boolean {
  const { captured, current, incoming } = input;
  if (!incoming || typeof incoming.content !== 'string') return false;
  if (!isResponseOwnerCurrent(captured.owner, current.owner)) return false;
  if (captured.mode !== 'live' || current.mode !== captured.mode) return false;
  if (captured.dirty || current.dirty) return false;
  if (current.editEpoch !== captured.editEpoch) return false;
  if (current.revision !== captured.revision) return false;
  if ((current.baseVersion ?? null) !== (captured.baseVersion ?? null)) return false;
  if (incoming.sessionId !== captured.owner.sessionId) return false;
  if (incoming.revision < current.revision) return false;
  return (
    incoming.content !== current.buffer ||
    (incoming.baseVersion ?? null) !== (current.baseVersion ?? null)
  );
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
