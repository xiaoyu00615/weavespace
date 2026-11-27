/**
 * 从 `StorageProvider.list()` 的相对路径列表构造资源树（S9-B）。
 *
 * 只做「路径 → 树」的映射，不做磁盘访问；排序固定为「目录在前、同名按字典序」，
 * 保证同一份磁盘内容每次返回的树结构一致（UI 展开状态才有稳定的 key）。
 */
import { createHash } from 'node:crypto';

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
  /**
   * 该条目**自身**有一条（核验通过的）隐藏记录（UX-02C-03-P1）。
   *
   * 只有 `includeHidden=1` 时才会真正出现在结果里；默认视图直接把它过滤掉，
   * 这个字段仍然保留，是为了让"显示隐藏项"的界面能给出明显但克制的标识。
   */
  hidden?: true;
  /** 自身没有记录，但某个上级目录被隐藏：值是那个上级的相对路径。 */
  hiddenBy?: string;
  /**
   * 资源展示元数据（UX-02C-04）：标注名 / 标签 / 行颜色。
   *
   * 只包含**核验通过**（`active`）的记录：路径上换了另一个对象时，Host 不会把旧标注
   * 发下来，界面因此不可能"新文件继承旧标注"。空对象不会出现——三个字段全空时
   * 整条记录已被删除。
   */
  meta?: {
    readonly alias?: string;
    readonly tags: readonly string[];
    readonly color?: string;
  };
}

export interface TreePageMeta {
  limit: number;
  /** 本次请求的游标；第一页为 null。 */
  cursor: string | null;
  /** 下一页游标；null 表示该层已全部取完。 */
  nextCursor: string | null;
  /** 该层总条目数（不受 limit 影响）。 */
  total: number;
  /**
   * 本轮分页的目录快照标识（UX-02B-TREE-R1）。
   *
   * 由「排序后的整层条目集合」计算，与 `cursor` / `limit` 无关：静态目录的
   * 每一页都拿到同一个值。续页必须原样回传，服务端据此发现集合变化。
   */
  snapshot: string;
  /**
   * 本层**隐藏条目**的数量（UX-02C-03-P1）。
   *
   * 与 `total` 的关系：`total` 只统计本次视图里会返回的条目；`hiddenCount` 统计
   * 被隐藏（自身记录或被上级隐藏）的条目。只有 `includeHidden=1` 时两者才重叠
   * （此时隐藏项也在 `entries` 里，并带 `hidden` / `hiddenBy` 标记）。
   */
  hiddenCount: number;
}

export interface TreePageDto {
  status: 'APPLIED';
  /** 规范化后的层路径：根为空串。 */
  level: string;
  entries: TreeEntryDto[];
  page: TreePageMeta;
  /**
   * 项目根展示项的元数据（UX-02C-04）：只在 `level === ''` 且项目有标注时出现。
   *
   * 根不是磁盘条目，无法作为一个 `entries` 元素返回；它用项目身份（`rootToken`）
   * 关联，与"借元数据获得根目录操作权限"无关——元数据端点完全不碰磁盘。
   */
  projectMeta?: {
    readonly alias?: string;
    readonly tags: readonly string[];
    readonly color?: string;
  };
  /**
   * 本页条目的资源锚（UX-02C-04-R1）：`relPath → 32 位十六进制摘要`。
   *
   * 为什么**不放在条目里**：锚由对象身份派生，而"保存文件"是临时文件 + rename，
   * **必然换 inode**。若把它塞进条目，任何一次普通保存都会让"这一层的条目"
   * 发生变化——那会让以条目为口径的比较（"别的项目/别的操作不该影响这棵树"）
   * 变成假失败。锚是**行的附着信息**，不是条目的身份字段。
   *
   * 不透明：客户端不解析、不据此授权；Host 只用它和自己核验出的身份比对。
   * 对象不存在或 Provider 无身份能力时不会出现在这里。
   */
  anchors?: Readonly<Record<string, string>>;
  /**
   * 项目根的资源锚（UX-02C-04-R1）：只在 `level === ''` 且项目有根令牌时出现。
   *
   * 根不是磁盘条目，它的身份就是根令牌；这里给的是一个**仅供比对**的预期值，
   * 与"借元数据获得根目录操作权限"无关（元数据端点完全不碰磁盘）。
   */
  projectAnchor?: string;
  /**
   * 本页 Provider 的**身份核验能力**（UX-02C-05-R1.1）。
   *
   * 为什么需要它：`anchors` 里没有某一行，可能因为"Provider 没有身份能力"，
   * 也可能因为"这一行的身份这次没探到（对象消失 / lstat 失败）"。前者可以按
   * 路径身份降级，后者必须 fail-closed。只在页级声明能力，缺锚的原因就仍然
   * 由"有锚 / 无锚"表达——不引入任何客户端自述的身份或授权凭据。
   *
   * 缺省（旧版服务端）表示"未声明"，客户端按 `unverified` 处理（fail-closed）。
   */
  identitySupport?: 'supported' | 'unsupported';
}

export const TREE_PAGE_DEFAULT_LIMIT = 200;
export const TREE_PAGE_MAX_LIMIT = 2000;

interface DirEntryLike {
  readonly name: string;
  readonly kind: TreeEntryKind;
  /** 该条目自身的隐藏记录已核验通过（UX-02C-03-P1）。 */
  readonly hidden?: boolean;
  /** 上级隐藏目录的相对路径（自身没有记录时才有）。 */
  readonly hiddenBy?: string;
  /** 该条目的展示元数据已核验通过（UX-02C-04）。 */
  readonly meta?: TreeEntryDto['meta'];
  /**
   * 该条目的资源锚（UX-02C-04-R1）；对象不可核验时没有。
   *
   * 只用于在构造响应时汇成 `TreePageDto.anchors`：**不进入条目**（理由见那里）。
   */
  readonly anchor?: string;
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
  /** 客户端首轮分页带回的快照；不一致时抛 `ERR_DIR_CHANGED`。 */
  expectedSnapshot?: string | null;
  /**
   * 本层隐藏条目数（UX-02C-03-P1）。
   *
   * 默认从 `entries` 里的隐藏标记统计；调用方在**过滤之后**建页时必须显式给出
   * 真实数量，否则"此目录有 N 个隐藏项"会变成 0。
   */
  hiddenCount?: number;
  /** 项目根展示项的元数据（只在 `level === ''` 时有意义）。 */
  projectMeta?: TreePageDto['projectMeta'];
  /** 项目根的资源锚（只在 `level === ''` 时有意义）。 */
  projectAnchor?: string;
  /**
   * 本页 Provider 的身份核验能力（UX-02C-05-R1.1）。
   *
   * 由调用方按 Provider **实际实现**给出（有没有 `identityOf`），绝不由
   * "这一页没有锚"反推：那样一次探测异常就会被伪装成"Provider 不支持身份"。
   */
  identitySupport?: TreePageDto['identitySupport'];
}

/**
 * 目录快照标识（UX-02B-TREE-R1 / 契约 B.2.2）。
 *
 * 数字偏移游标无法保证跨页时条目集合不变：第一页之后插入一个排在前面的文件，
 * 第二页按同样的偏移量取值就会漏掉原本位于边界的条目。这里对**排序后的整层
 * 条目集合**（而非当前页）做 SHA-256，让"集合变了"成为可验证的事实。
 *
 * 纳入 level / projectId 是为了让快照只在同一目录、同一项目命名空间内有效，
 * 不能把一个目录的快照拿到另一个目录去蒙混过关。返回值不含任何磁盘信息，
 * 只是摘要；目录名本身仍在同一次响应的 `entries` 里，不额外扩大信息面。
 */
export function directorySnapshotOf(
  entries: readonly TreeEntryDto[],
  level: string,
  projectId?: string,
  hiddenCount = 0,
): string {
  const hash = createHash('sha256');
  // hiddenCount 参与哈希：隐藏集合变化必须让旧游标失效，否则续页会把
  // "少了一条"当成"读完了"（UX-02C-03-P1）。
  hash.update(`ws-tree-v2\n${projectId ?? ''}\n${level}\n${hiddenCount}\n`);
  for (const entry of entries) {
    hash.update(
      `${entry.kind}\u0000${entry.name}\u0000${entry.relPath}\u0000${entry.extension}\u0000${
        entry.hidden ? '1' : '0'
      }\u0000${entry.hiddenBy ?? ''}\u0000\n`,
    );
  }
  return hash.digest('hex').slice(0, 32);
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

  /*
   * 资源锚单独收集：它是**行的附着信息**，不是条目字段（见 `TreePageDto.anchors`）。
   * 键用 `relPath`，与条目一一对应；对象不可核验的条目没有锚。
   */
  const anchors = new Map<string, string>();
  const all: TreeEntryDto[] = sortTreeEntries(
    entries.map((entry) => {
      const relPath = level ? `${level}/${entry.name}` : entry.name;
      if (entry.anchor) anchors.set(relPath, entry.anchor);
      return {
        id: treeEntryIdOf(entry.kind, relPath, options.projectId),
        name: entry.name,
        kind: entry.kind,
        extension: entry.kind === 'folder' ? '' : extensionOf(entry.name),
        relPath,
        ...(entry.hidden ? { hidden: true as const } : {}),
        ...(entry.hiddenBy ? { hiddenBy: entry.hiddenBy } : {}),
        // 元数据**不参与**目录快照：它不影响"这一层有哪些条目"，
        // 因此改一个颜色不该让正在进行的翻页作废。
        ...(entry.meta ? { meta: entry.meta } : {}),
      };
    }),
  );

  const total = all.length;
  const hiddenCount =
    options.hiddenCount ?? all.reduce((sum, entry) => sum + (entry.hidden || entry.hiddenBy ? 1 : 0), 0);
  const snapshot = directorySnapshotOf(all, level, options.projectId, hiddenCount);

  // 目录在两页之间变了：失败必须显式，绝不返回一份可能漏项的"成功"结果。
  // 错误码由 `server.ts` 统一映射成 409 + 公共文案；这里只负责判定，不碰 HTTP。
  if (options.expectedSnapshot != null && options.expectedSnapshot !== snapshot) {
    throw Object.assign(
      new Error('目录已变化，请刷新'),
      { errorCode: 'ERR_DIR_CHANGED' },
    );
  }

  const page = all.slice(offset, offset + limit);
  const end = offset + page.length;

  /*
   * 只给本页返回的条目带锚：续页不需要别人的锚，多带只是白白扩大响应体。
   * 顺序按 `page` 走，序列化结果因此是稳定的。
   */
  const pageAnchors: Record<string, string> = {};
  for (const entry of page) {
    const anchor = anchors.get(entry.relPath);
    if (anchor) pageAnchors[entry.relPath] = anchor;
  }

  return {
    status: 'APPLIED',
    level,
    entries: page,
    page: {
      limit,
      cursor: options.cursor === undefined ? null : String(offset),
      nextCursor: end < total && page.length > 0 ? String(end) : null,
      total,
      snapshot,
      hiddenCount,
    },
    // 项目根展示项的元数据放在**顶层**：它不是"这一页"的属性，
    // 而是这个项目根的展示信息（分页时每页都可以带同一个值）。
    ...(options.projectMeta ? { projectMeta: options.projectMeta } : {}),
    // 根的资源锚同理：每页都带同一个值，续页丢失不会影响已加载的行。
    ...(options.projectAnchor ? { projectAnchor: options.projectAnchor } : {}),
    // 身份能力是页级声明：缺锚的语义由它区分"Provider 不支持"与"这次没探到"。
    ...(options.identitySupport ? { identitySupport: options.identitySupport } : {}),
    ...(Object.keys(pageAnchors).length > 0 ? { anchors: pageAnchors } : {}),
  };
}
