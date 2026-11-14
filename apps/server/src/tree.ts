/**
 * 从 `StorageProvider.list()` 的相对路径列表构造资源树（S9-B）。
 *
 * 只做「路径 → 树」的映射，不做磁盘访问；排序固定为「目录在前、同名按字典序」，
 * 保证同一份磁盘内容每次返回的树结构一致（UI 展开状态才有稳定的 key）。
 */

export interface ResourceNodeDto {
  /** 稳定标识：文件为 `doc:<相对路径>`，目录为 `dir:<相对路径>`。 */
  id: string;
  name: string;
  kind: 'folder' | 'markdown' | 'text';
  /** 文件相对路径（供 open 使用）；目录为 `undefined`。 */
  path?: string;
  children?: ResourceNodeDto[];
}

/** 可被文本接口打开的后缀；其余文件不进树（避免展示必定打不开的二进制）。 */
const TEXT_EXTENSIONS = ['.md', '.markdown', '.txt'];

export function isListableTextFile(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function kindOf(relativePath: string): 'markdown' | 'text' {
  const lower = relativePath.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown') ? 'markdown' : 'text';
}

type Entry =
  | { type: 'folder'; name: string; path: string; children: Map<string, Entry> }
  | { type: 'file'; node: ResourceNodeDto };

function sortNodes(nodes: ResourceNodeDto[]): ResourceNodeDto[] {
  return nodes.sort((a, b) => {
    if (a.kind === 'folder' && b.kind !== 'folder') return -1;
    if (a.kind !== 'folder' && b.kind === 'folder') return 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

export interface BuildResourceTreeOptions {
  /** Multi：节点 id 带上项目命名空间（`doc:<projectId>/<rel>`），避免跨项目撞 id。 */
  projectId?: string;
}

export function buildResourceTree(
  relativePaths: readonly string[],
  options: BuildResourceTreeOptions = {},
): ResourceNodeDto[] {
  const idFor = (kind: 'doc' | 'dir', relativePath: string): string =>
    options.projectId ? `${kind}:${options.projectId}/${relativePath}` : `${kind}:${relativePath}`;
  const rootChildren = new Map<string, Entry>();

  for (const relativePath of relativePaths) {
    if (!isListableTextFile(relativePath)) continue;
    const segments = relativePath.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    let cursor = rootChildren;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i];
      const childPath = segments.slice(0, i + 1).join('/');
      const existing = cursor.get(name);
      if (existing && existing.type === 'folder') {
        cursor = existing.children;
        continue;
      }
      const folder: Entry = { type: 'folder', name, path: childPath, children: new Map() };
      cursor.set(name, folder);
      cursor = folder.children;
    }

    const fileName = segments[segments.length - 1];
    cursor.set(fileName, {
      type: 'file',
      node: {
        id: idFor('doc', relativePath),
        name: fileName,
        kind: kindOf(relativePath),
        path: relativePath,
      },
    });
  }

  const materialize = (children: Map<string, Entry>): ResourceNodeDto[] => {
    const out: ResourceNodeDto[] = [];
    for (const entry of children.values()) {
      if (entry.type === 'folder') {
        out.push({
          id: idFor('dir', entry.path),
          name: entry.name,
          kind: 'folder',
          children: materialize(entry.children),
        });
      } else {
        out.push(entry.node);
      }
    }
    return sortNodes(out);
  };

  return materialize(rootChildren);
}

/* ==========================================================================
 * UX-02B-TREE：单层目录 → 分页 DTO（契约 B.2/B.3/B.4）
 *
 * 上面那套 `buildResourceTree` 是 `/api/resources` 的实现，**保持冻结**：
 * 它从扁平路径列表重建整棵递归树、只认文本后缀、无法表达空目录与链接。
 * 下面这套是"逐层 + 分页"的新契约，纯函数、不碰磁盘，因此可以直接在套件里断言。
 * ========================================================================== */

/** 节点类型只有三种事实，**不携带格式语义**（契约 B.3）。 */
export type TreeEntryKind = 'folder' | 'file' | 'link';

export interface TreeEntryDto {
  /** 稳定 id：`dir:` / `doc:` / `link:` 三套互不重叠的命名空间。 */
  id: string;
  /** 单段名称，不含路径分隔符。 */
  name: string;
  kind: TreeEntryKind;
  /** 小写含点；无扩展名与目录都是空串。 */
  extension: string;
  /** 项目内相对路径（正斜杠）。**永不是绝对路径。** */
  relPath: string;
}

export interface TreePageMeta {
  limit: number;
  /** 本次请求的游标；第一页为 null。 */
  cursor: string | null;
  /** 下一页游标；null 表示该层已全部取完。 */
  nextCursor: string | null;
  /** 该层总条目数（不受 limit 影响）。 */
  total: number;
}

export interface TreePageDto {
  status: 'APPLIED';
  /** 规范化后的层路径：根为空串。 */
  level: string;
  entries: TreeEntryDto[];
  page: TreePageMeta;
}

export const TREE_PAGE_DEFAULT_LIMIT = 200;
export const TREE_PAGE_MAX_LIMIT = 2000;

interface DirEntryLike {
  readonly name: string;
  readonly kind: TreeEntryKind;
}

/** 扩展名（小写含点）。点开头的隐藏文件与无扩展名文件都返回空串。 */
export function extensionOf(name: string): string {
  if (typeof name !== 'string' || name.length === 0) return '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot).toLowerCase();
}

/** 三套命名空间（契约 B.3）：`dir:` / `doc:` / `link:`，后两者绝不与目录混用。 */
export function treeEntryIdOf(kind: TreeEntryKind, relPath: string, projectId?: string): string {
  const prefix = kind === 'folder' ? 'dir' : kind === 'link' ? 'link' : 'doc';
  return projectId ? `${prefix}:${projectId}/${relPath}` : `${prefix}:${relPath}`;
}

/**
 * 全序排序（契约 B.4）：
 *   1. 目录与链接在前、文件在后；
 *   2. 同组按 `localeCompare(name, 'zh-Hans-CN')`；
 *   3. 仍相等时按 UTF-16 码点序兜底。
 *
 * 必须有第 3 步：分页依赖"同一份磁盘内容每次得到同一个顺序"，
 * 任何非全序比较器都可能让两页之间出现漂移（重复或遗漏）。
 */
export function sortTreeEntries<T extends DirEntryLike>(entries: readonly T[]): T[] {
  const groupOf = (entry: DirEntryLike): number => (entry.kind === 'file' ? 1 : 0);
  return [...entries].sort((a, b) => {
    const groupDiff = groupOf(a) - groupOf(b);
    if (groupDiff !== 0) return groupDiff;
    const localized = a.name.localeCompare(b.name, 'zh-Hans-CN');
    if (localized !== 0) return localized;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/** 把层路径规范化成 `''`（根）或 `a/b`；不做授权判定（那属于 storage/server）。 */
export function normalizeLevelPath(dir: string | null | undefined): string {
  if (typeof dir !== 'string') return '';
  return dir
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('/');
}

export interface BuildTreePageOptions {
  /** Multi：id 带项目命名空间，避免跨项目撞 id。 */
  projectId?: string;
  /** 层路径（已规范化）；根为空串。 */
  dir?: string;
  /** 已解析的游标偏移量。 */
  cursor?: number;
  /** 每页条数（调用方已校验范围）。 */
  limit?: number;
}

/**
 * 单层条目 → 一页 DTO。
 *
 * 顺序固定为"先对该层**全量**排序，再切片"，因此 `page.total` 是真实总数、
 * `nextCursor` 只要非 null 就一定还有内容（契约 B.2.1 禁止静默截断）。
 */
export function buildTreePage(
  entries: readonly DirEntryLike[],
  options: BuildTreePageOptions = {},
): TreePageDto {
  const level = normalizeLevelPath(options.dir);
  const limit = options.limit ?? TREE_PAGE_DEFAULT_LIMIT;
  const offset = options.cursor ?? 0;

  const all: TreeEntryDto[] = sortTreeEntries(
    entries.map((entry) => ({
      id: treeEntryIdOf(entry.kind, level ? `${level}/${entry.name}` : entry.name, options.projectId),
      name: entry.name,
      kind: entry.kind,
      extension: entry.kind === 'folder' ? '' : extensionOf(entry.name),
      relPath: level ? `${level}/${entry.name}` : entry.name,
    })),
  );

  const total = all.length;
  const page = all.slice(offset, offset + limit);
  const end = offset + page.length;

  return {
    status: 'APPLIED',
    level,
    entries: page,
    page: {
      limit,
      cursor: options.cursor === undefined ? null : String(offset),
      nextCursor: end < total && page.length > 0 ? String(end) : null,
      total,
    },
  };
}
