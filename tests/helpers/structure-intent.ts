/**
 * 测试专用：给结构变更请求补上**源身份**与**目标目录身份**预期
 * （UX-02C-02-R2 / R2.1）。
 *
 * 真实 UI 里这两个锚都来自 `/api/tree`：源是那一行的 `anchors[path]`，
 * 目标是所选文件夹那一行的 `anchors[dir]`（项目根是根层的 `projectAnchor`）。
 * 测试也应该从**同一个权威出口**取，而不是自己按 `dev:ino` 算一遍——
 * 那会把生产逻辑抄成测试替身。
 *
 * 取不到锚时**不抛错、也不编造**：请求原样发出，由 Host 用
 * `ERR_STRUCTURE_INTENT_MISSING` 明确拒绝。这样"链接行没有锚"这类负例仍然
 * 走真实路径，而不是被夹具提前打断。
 *
 * 显式带了字段（包括空串 `''` 这种负例）时一律不覆盖。
 */
export interface StructureBody {
  readonly projectId: string;
  readonly sourcePath: string;
  readonly sourceAnchor?: string;
  readonly targetParentDir?: string;
  readonly targetAnchor?: string;
}

export interface TreePageLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

const parentDirOf = (path: string): string => {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(0, slash) : '';
};

/**
 * 给请求体补齐身份预期。
 *
 * `targetParentDir` 存在即视为移动请求（改名端点由 Host 派生目标目录，
 * 不接受也不校验目标锚）。
 */
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
  let next: Record<string, unknown> = { ...(body as Record<string, unknown>) };

  if (candidate.sourceAnchor === undefined) {
    const sourcePath = candidate.sourcePath;
    const page = await fetchTree(candidate.projectId, parentDirOf(sourcePath)).catch(() => null);
    const anchor = page?.body?.anchors?.[sourcePath];
    if (typeof anchor === 'string') next = { ...next, sourceAnchor: anchor };
  }

  if (typeof candidate.targetParentDir === 'string' && candidate.targetAnchor === undefined) {
    const targetDir = candidate.targetParentDir;
    if (targetDir === '') {
      // 项目根不是磁盘条目：它的身份是根令牌摘要，由根层单独给出
      const root = await fetchTree(candidate.projectId, '').catch(() => null);
      const anchor = root?.body?.projectAnchor;
      if (typeof anchor === 'string') next = { ...next, targetAnchor: anchor };
    } else {
      const page = await fetchTree(candidate.projectId, parentDirOf(targetDir)).catch(() => null);
      const anchor = page?.body?.anchors?.[targetDir];
      if (typeof anchor === 'string') next = { ...next, targetAnchor: anchor };
    }
  }

  return next as T;
}
