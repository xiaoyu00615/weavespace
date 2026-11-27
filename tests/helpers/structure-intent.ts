/**
 * 测试专用：给结构变更请求补上源身份预期（UX-02C-02-R2）。
 *
 * 真实 UI 里这个锚来自那一行（`/api/tree` 的 `anchors[path]`）；测试也应该从
 * **同一个权威出口**取，而不是自己按 `dev:ino` 算一遍——那会把生产逻辑抄成测试替身。
 *
 * 取不到锚时**不抛错、也不编造**：请求原样发出，由 Host 用
 * `ERR_STRUCTURE_INTENT_MISSING` 明确拒绝。这样"链接行没有锚"这类负例仍然
 * 走真实路径，而不是被夹具提前打断。
 *
 * 显式带了 `sourceAnchor`（包括空串 `''` 这种负例）时一律不覆盖。
 */
export interface StructureBody {
  readonly projectId: string;
  readonly sourcePath: string;
  readonly sourceAnchor?: string;
}

export interface TreePageLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export async function withSourceAnchor<T extends object>(
  body: T,
  fetchTree: (projectId: string, dir: string) => Promise<TreePageLike>,
): Promise<T> {
  const candidate = body as Partial<StructureBody>;
  // 负例请求体（缺 projectId 或 sourcePath）原样放行：形状错误应该由 Host 自己判，
  // 夹具抢先补锚会把"字段缺失"这条负例洗成另一条负例。
  if (typeof candidate.projectId !== 'string' || typeof candidate.sourcePath !== 'string') {
    return body;
  }
  if (candidate.sourceAnchor !== undefined) return body;
  const sourcePath = candidate.sourcePath;
  const slash = sourcePath.lastIndexOf('/');
  const dir = slash >= 0 ? sourcePath.slice(0, slash) : '';
  const page = await fetchTree(candidate.projectId, dir).catch(() => null);
  const anchor = page?.body?.anchors?.[sourcePath];
  if (typeof anchor !== 'string') return body;
  return { ...body, sourceAnchor: anchor };
}
