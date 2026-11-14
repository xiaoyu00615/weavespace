/**
 * UX-02B-TREE：Shell 侧"逐层文件树"的纯数据模型（契约 B.2 / C）。
 *
 * 为什么单独成模块：`.tsx` 无法被 `node:test` import（没有 JSX 变换），
 * 所以"单层合并 / 分页追加 / 项目级缓存 / 刷新作废"这些**容易出错的状态逻辑**
 * 必须放在纯 `.ts` 里，才能被套件直接断言（沿用 `tree-trails.ts` 的做法）。
 *
 * 数据结构是"按目录路径分片的层表"，而不是一棵递归大树：
 * - `TreeLevels['']` 是项目根的直接子项，`TreeLevels['docs']` 是 docs 的直接子项；
 * - 递归大树由 `materializeTree()` **派生**，从不手工维护，避免两份状态漂移；
 * - 展开一层只写它自己的分片，其他分片保持引用不变（T-15）；
 * - 刷新只替换该项目的层表，其他项目完全不受影响（T-16）。
 *
 * 这里不碰磁盘、不碰网络、不碰 React，所有函数都是纯函数。
 */
import type { TreeEntry } from '../client/client-api.ts';
import type { ResourceNodeState } from '../state/types.ts';

/** 项目根这一层的键。 */
export const ROOT_LEVEL = '';

/** 物化递归树时的最大深度保护：防止畸形数据（自指目录）造成无限递归。 */
const MAX_MATERIALIZE_DEPTH = 64;

export type TreeLevelStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface TreeLevelState {
  /** 规范化的层路径（根为空串）。 */
  readonly dir: string;
  /** 本层已加载的条目（分页追加后是所有已取页的拼接）。 */
  readonly entries: readonly ResourceNodeState[];
  /** 还有下一页时的游标；null = 该层已全部取完。 */
  readonly nextCursor: string | null;
  /** 该层总条目数（服务端给出）。 */
  readonly total: number;
  readonly status: TreeLevelStatus;
  readonly errorCode: string | null;
  /** 是否正在"加载更多"（区别于首次整层加载）。 */
  readonly loadingMore: boolean;
}

export type TreeLevels = Readonly<Record<string, TreeLevelState>>;

/** 层路径规范化：只保留非空、非 `.` 的段，永远得到 `''` 或 `a/b`。 */
export function normalizeDir(dir: string | null | undefined): string {
  if (typeof dir !== 'string' || dir.length === 0) return ROOT_LEVEL;
  return dir
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/');
}

export function emptyLevels(): TreeLevels {
  return Object.freeze({});
}

function blankLevel(dir: string): TreeLevelState {
  return {
    dir,
    entries: [],
    nextCursor: null,
    total: 0,
    status: 'idle',
    errorCode: null,
    loadingMore: false,
  };
}

/** 服务端条目 → 前端节点。路径只用 `relPath`，绝不接收或推导绝对路径。 */
export function entryToNode(entry: TreeEntry): ResourceNodeState {
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    extension: entry.extension,
    path: entry.relPath,
  };
}

/** 该层是否还有未加载的页。 */
export function hasMore(levels: TreeLevels, dir: string): boolean {
  return (levels[normalizeDir(dir)]?.nextCursor ?? null) !== null;
}

/** 标记一层开始加载。`append=true` 表示"加载更多"，已加载条目必须原样保留。 */
export function beginLevel(levels: TreeLevels, dir: string, append: boolean): TreeLevels {
  const key = normalizeDir(dir);
  const previous = levels[key] ?? blankLevel(key);
  return {
    ...levels,
    [key]: {
      ...previous,
      status: 'loading',
      errorCode: null,
      loadingMore: append,
    },
  };
}

export interface AppliedPage {
  readonly entries: readonly TreeEntry[];
  /** 本次请求的游标；null = 第一页（替换）。 */
  readonly cursor: string | null;
  readonly nextCursor: string | null;
  readonly total: number;
}

/**
 * 合并一页结果。
 *
 * - 第一页（`cursor === null`）：**替换**整层；
 * - 续页：**追加**，并按 id 去重（重复请求同一游标不得产生重复行，T-15b）；
 * - 只要 `nextCursor` 非 null 就保留它，UI 才有"继续加载"的入口。
 */
export function applyPage(levels: TreeLevels, dir: string, page: AppliedPage): TreeLevels {
  const key = normalizeDir(dir);
  const previous = levels[key] ?? blankLevel(key);
  const incoming = page.entries.map(entryToNode);
  const first = page.cursor === null;
  const merged = first ? incoming : [...previous.entries, ...incoming];
  const deduped: ResourceNodeState[] = [];
  const seen = new Set<string>();
  for (const node of merged) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    deduped.push(node);
  }
  return {
    ...levels,
    [key]: {
      dir: key,
      entries: deduped,
      nextCursor: page.nextCursor,
      total: page.total,
      status: 'ready',
      errorCode: null,
      loadingMore: false,
    },
  };
}

/** 加载失败：保留已加载条目与游标，让用户能"重试"而不是整层变空。 */
export function failLevel(levels: TreeLevels, dir: string, errorCode: string | null): TreeLevels {
  const key = normalizeDir(dir);
  const previous = levels[key] ?? blankLevel(key);
  return {
    ...levels,
    [key]: {
      ...previous,
      status: 'error',
      errorCode,
      loadingMore: false,
    },
  };
}

/** 刷新：整份层表作废（调用方只对**这一个项目**调用）。 */
export function resetLevels(): TreeLevels {
  return emptyLevels();
}

/**
 * 由层表派生递归树，供既有 `TreeRow` 组件消费。
 *
 * 只有 `kind === 'folder'` 且该层已加载时才挂 `children`；
 * 未加载、空目录、不可读、链接都不挂 children，因此 UI 能明确区分
 * "还没展开" / "空文件夹" / "无法读取" 三态。
 */
export function materializeTree(
  levels: TreeLevels,
  dir: string = ROOT_LEVEL,
  depth = 0,
): ResourceNodeState[] {
  if (depth > MAX_MATERIALIZE_DEPTH) return [];
  const key = normalizeDir(dir);
  const level = levels[key];
  if (!level) return [];
  return level.entries.map((entry) => {
    if (entry.kind !== 'folder') return entry;
    // `entry.path` 已经是带父路径的项目内相对路径（服务端 relPath），直接用它定位子层
    const normalized = normalizeDir(entry.path ?? (key === ROOT_LEVEL ? entry.name : `${key}/${entry.name}`));
    const childLevel = levels[normalized];
    if (!childLevel) return entry;
    return { ...entry, children: materializeTree(levels, normalized, depth + 1) };
  });
}

/** 已加载的文件总数（页脚文案用；链接不算文件）。 */
export function countLoadedFiles(levels: TreeLevels): number {
  let total = 0;
  for (const level of Object.values(levels)) {
    for (const entry of level.entries) {
      if (entry.kind === 'file') total += 1;
    }
  }
  return total;
}

/** 已加载条目总数（含目录与链接）。 */
export function countLoadedEntries(levels: TreeLevels): number {
  return Object.values(levels).reduce((sum, level) => sum + level.entries.length, 0);
}

/**
 * demo / 静态树 → 层表。
 *
 * Demo 数据本来就是一棵递归大树；把它拆成层表之后，
 * Demo 与真实文件模式走的是**同一个**渲染组件与同一套 depth 语义（契约 C.2）。
 */
export function fromStaticTree(nodes: readonly ResourceNodeState[]): TreeLevels {
  let levels: TreeLevels = emptyLevels();
  const visit = (dir: string, children: readonly ResourceNodeState[]): void => {
    levels = applyPage(levels, dir, {
      entries: children.map((node) => ({
        id: node.id,
        name: node.name,
        kind: node.kind,
        extension: node.extension ?? '',
        relPath: node.path ?? (dir ? `${dir}/${node.name}` : node.name),
      })),
      cursor: null,
      nextCursor: null,
      total: children.length,
    });
    for (const child of children) {
      if (child.kind !== 'folder' || !child.children) continue;
      const childDir = child.path ?? (dir ? `${dir}/${child.name}` : child.name);
      visit(normalizeDir(childDir), child.children);
    }
  };
  visit(ROOT_LEVEL, nodes);
  return levels;
}

/** 在已加载的层表里按相对路径找节点；找不到返回 undefined（不做任何磁盘推断）。 */
export function findEntryByPath(levels: TreeLevels, relPath: string): ResourceNodeState | undefined {
  const normalized = normalizeDir(relPath);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return undefined;
  const parent = segments.slice(0, -1).join('/');
  const name = segments[segments.length - 1];
  return levels[parent]?.entries.find((entry) => entry.name === name || entry.path === normalized);
}
