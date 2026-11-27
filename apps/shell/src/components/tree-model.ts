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
import type { IdentitySupport } from '../state/tree-commands.ts';
import type { ResourceNodeState } from '../state/types.ts';

/** 项目根这一层的键。 */
export const ROOT_LEVEL = '';

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
  /**
   * 本轮分页的目录快照标识（UX-02B-TREE-R1）。
   * 续页必须把它原样回传；`null` 表示这一层还没有建立一致性基线。
   */
  readonly snapshot: string | null;
  /**
   * 服务端报告的本层隐藏条目数（UX-02C-03-P1）。
   *
   * 默认视图下这些条目**不在** `entries` 里，所以这个数字是"此目录有 N 个隐藏项"
   * 唯一的来源；`0` 表示这一层没有隐藏项（或旧版服务端不返回）。
   */
  readonly hiddenCount: number;
  /**
   * 项目根展示项的元数据（UX-02C-04）：只有根层（`dir === ''`）才会有。
   *
   * 根不是一个磁盘条目，因此它不在这里的 `entries` 里；项目根行从这一项取标注。
   */
  readonly projectMeta?: {
    alias?: string;
    tags: string[];
    color?: string;
  };
  /**
   * 资源锚表（UX-02C-04-R1）：`relPath → 32 位十六进制摘要`。
   *
   * 只覆盖**本层已加载**的条目。锚不放进条目本身——理由见
   * `TreePageDto.anchors`：它由对象身份派生，而普通保存会换 inode，
   * 放进条目会让"条目集合"随保存变化。
   *
   * 可选是为了兼容既有夹具（手工构造的层状态）；缺省与空表语义相同。
   */
  readonly anchors?: Readonly<Record<string, string>>;
  /**
   * 项目根的资源锚（UX-02C-04-R1）：只有根层有。
   *
   * 根不是一个磁盘条目，它的"身份"就是根令牌；这个值与 `projectMeta` 一样
   * 属于"这个项目根"，续页不带时沿用。
   */
  readonly projectAnchor?: string;
  /**
   * 本层的 Provider 身份核验能力（UX-02C-05-R1.1）。
   *
   * 它是"缺锚"这件事的分母：`supported` + 某行无锚 = 这一行**身份未知**
   * （fail-closed）；`unsupported` = Provider 明确没有身份能力，才允许按路径身份降级。
   * 缺省（旧版响应 / 手工夹具）= 未声明，按 `unverified` 处理。
   */
  readonly identitySupport?: IdentitySupport;
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
    snapshot: null,
    hiddenCount: 0,
    anchors: Object.freeze({}),
  };
}

/**
 * 服务端条目 → 前端节点。路径只用 `relPath`，绝不接收或推导绝对路径。
 *
 * `anchor` 由层表的锚表按 `relPath` 提供（不在条目里，见 `TreeLevelState.anchors`）。
 */
export function entryToNode(entry: TreeEntry, anchor?: string): ResourceNodeState {
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    extension: entry.extension,
    path: entry.relPath,
    // 隐藏标记必须穿过这一层：否则"显示隐藏项"里所有行都和普通行一样（UX-02C-03-P1）
    ...(entry.hidden ? { hidden: true } : {}),
    ...(entry.hiddenBy ? { hiddenBy: entry.hiddenBy } : {}),
    // 展示元数据同样要穿过去：否则"设置标注名"保存成功、刷新后行上什么都没有
    ...(entry.meta ? { meta: entry.meta } : {}),
    // 资源锚：编辑会话的身份预期，丢了它就只能拒绝提交（宁可不写，也不写错对象）
    ...(anchor ? { anchor } : {}),
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
  /** 本轮分页的目录快照标识；旧版响应可能没有。 */
  readonly snapshot?: string | null;
  /** 本层隐藏条目数；旧版响应没有。 */
  readonly hiddenCount?: number;
  /** 项目根展示项的元数据（只有根层会带）。 */
  readonly projectMeta?: TreeLevelState['projectMeta'];
  /** 项目根的资源锚（只有根层会带）。 */
  readonly projectAnchor?: string;
  /** 本页条目的资源锚表（`relPath → 锚`）；旧版响应没有。 */
  readonly anchors?: Readonly<Record<string, string>>;
  /** 本层 Provider 的身份核验能力；旧版响应没有（按 `unverified` 处理）。 */
  readonly identitySupport?: IdentitySupport;
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
  /*
   * 锚表按页合并：第一页替换、续页叠加。这样"续页没有某条目的锚"不会把它
   * 上一页拿到的锚抹掉（否则翻页后早先那些行的标注对话框会全部变成"无法确认身份"）。
   */
  const anchors: Record<string, string> = page.cursor === null ? {} : { ...previous.anchors };
  for (const [relPath, anchor] of Object.entries(page.anchors ?? {})) anchors[relPath] = anchor;
  const incoming = page.entries.map((entry) => entryToNode(entry, anchors[entry.relPath]));
  const first = page.cursor === null;
  // Shell 侧第二道闸：即便服务端漏判，也不能把"另一份目录"的续页追加到本轮结果上。
  // 失败必须显式作废整层，绝不能让 `nextCursor: null` 伪装成"已经全部加载完成"。
  if (!first && page.snapshot != null && previous.snapshot != null && page.snapshot !== previous.snapshot) {
    return invalidateLevel(levels, dir, 'ERR_DIR_CHANGED');
  }
  /*
   * 身份能力声明的一致性（UX-02C-05-R1.2）。
   *
   * 能力是"这一层由谁提供"的属性，一页之内不该变。续页突然改口（例如首轮
   * `unsupported`、续页 `supported`）说明这一轮分页其实跨了两个 Provider 视图，
   * 继续把两页拼在一起会让同一层里一半的行按"路径身份"、另一半按"对象身份"判定，
   * 而这种混合状态没有任何地方能正确解释。
   *
   * 这里不是"取最新值"，而是**明确作废整层**：调用方只能刷新，不能继承。
   */
  if (
    !first &&
    page.identitySupport !== undefined &&
    previous.identitySupport !== undefined &&
    page.identitySupport !== previous.identitySupport
  ) {
    return invalidateLevel(levels, dir, 'ERR_IDENTITY_STATE_CHANGED');
  }
  /*
   * 能力声明的落地规则：
   * - 第一页是**整层替换**，声明以本次响应为准；响应没给就是"未声明"，
   *   绝不能继承上一轮的 `unsupported` —— 那会让一个已经具备身份能力的新 Provider
   *   继续享受"按路径身份"的降级（F02）；
   * - 续页沿用本层既有声明（同一轮分页、同一 Provider、同一快照基线）；
   *   续页自己给了就以它为准（上面的矛盾检查已经挡掉"改口"）。
   */
  const identitySupport = first
    ? page.identitySupport
    : (page.identitySupport ?? previous.identitySupport);
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
      snapshot: page.snapshot ?? null,
      // `0` 是真实值（这一层没有隐藏项），`undefined` 才是"没给"。用 `??` 或
      // 任何 truthy 判断都会把真实的 0 当成缺失，或把缺失当成 0（R1-01）。
      hiddenCount: typeof page.hiddenCount === 'number' ? page.hiddenCount : previous.hiddenCount,
      /*
       * 根层展示元数据（标注名/标签/颜色）保持原语义：第一页带回、续页沿用。
       *
       * 刻意与下面的 `projectAnchor` / `identitySupport` **不同**：那两项参与身份与
       * 可用性判定（旧值会让一次危险操作被放行），而这里只是展示文案，且它有自己的
       * 权威来源（标注接口的 `applyMetadata` 会显式覆盖）。为了"看起来一致"去改它，
       * 只会让首屏短暂丢掉已经生效的标注。
       */
      ...(page.projectMeta !== undefined
        ? { projectMeta: page.projectMeta }
        : previous.projectMeta
          ? { projectMeta: previous.projectMeta }
          : {}),
      /*
       * 项目根锚同理，但**续页才沿用**（UX-02C-05-R1.2）。
       *
       * 第一页是整层替换：响应没给根锚就是"这一屏没有根身份"，不能拿上一轮的旧锚
       * 顶上——否则根行的改名/标注入口会绑在一个可能已经不存在的根令牌上。
       */
      ...(page.projectAnchor !== undefined
        ? { projectAnchor: page.projectAnchor }
        : !first && previous.projectAnchor
          ? { projectAnchor: previous.projectAnchor }
          : {}),
      anchors: Object.freeze(anchors),
      // 能力是"这个 Provider"的属性：只有续页才沿用，首屏一律以新响应为准
      ...(identitySupport !== undefined ? { identitySupport } : {}),
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

/**
 * 目录在本轮分页期间发生变化：整层作废（UX-02B-TREE-R1 / R1-04）。
 *
 * 与 `failLevel` 的区别是**故意**的：普通失败保留已加载条目与游标供"重试同一页"，
 * 而集合已变时旧游标和旧快照都不再有任何意义，保留它们会让 UI 把"继续加载"
 * 当成安全的下一步。清空后 `status: 'error'` + 明确错误码，UI 只给"刷新整层"。
 */
export function invalidateLevel(levels: TreeLevels, dir: string, errorCode: string): TreeLevels {
  const key = normalizeDir(dir);
  return {
    ...levels,
    [key]: {
      dir: key,
      entries: [],
      nextCursor: null,
      total: 0,
      status: 'error',
      errorCode,
      loadingMore: false,
      snapshot: null,
      hiddenCount: 0,
      // 整层作废后锚表也必须清空：留着会让"已经不在这一层的条目"仍可被打开编辑会话
      anchors: Object.freeze({}),
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
  ancestors: ReadonlySet<string> = new Set(),
): ResourceNodeState[] {
  const key = normalizeDir(dir);
  // 环检测按**路径身份**而不是固定深度：真实项目可能有 70+ 层目录，
  // 任何数字上限都会把有效层级静默变成空文件夹（UX-02B-TREE-R1 / R1-03）。
  if (ancestors.has(key)) return [];
  const level = levels[key];
  if (!level) return [];
  const chain = new Set(ancestors).add(key);
  return level.entries.map((entry) => {
    if (entry.kind !== 'folder') return entry;
    // `entry.path` 已经是带父路径的项目内相对路径（服务端 relPath），直接用它定位子层
    const normalized = normalizeDir(entry.path ?? (key === ROOT_LEVEL ? entry.name : `${key}/${entry.name}`));
    // 自指（a 里又指向 a）或回到某个祖先：只显示这一行，不再往下展开
    if (normalized === key || chain.has(normalized)) return entry;
    const childLevel = levels[normalized];
    if (!childLevel) return entry;
    return { ...entry, children: materializeTree(levels, normalized, chain) };
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

/**
 * 已加载条目里**自身被隐藏**的数量（UX-02C-03-P1）。
 *
 * 只统计"这一行自己有记录"的条目：被上级隐藏的条目不算，否则父目录一隐藏，
 * 数字会按整个子树膨胀，用户会以为隐藏了几百个文件。
 */
export function countHiddenEntries(levels: TreeLevels): number {
  let total = 0;
  for (const level of Object.values(levels)) {
    for (const entry of level.entries) {
      if (entry.hidden) total += 1;
    }
  }
  return total;
}

/**
 * "隐藏项"开关旁的数字（UX-02C-03-P1-R1）：**已加载目录层**的隐藏条目合计。
 *
 * 口径必须说清楚（这一点正是 R1-01 要求 5）：
 * - 每个 `TreeLevelState.hiddenCount` 是**该层**的隐藏条目数（Host 过滤前统计），
 *   不是全项目；
 * - 这里把它们相加，得到的是"已经被加载过的层里一共有多少条被隐藏"；
 * - 没展开过的目录不计入——所以它**不是**全项目总数，界面文案也必须这么写。
 *
 * 为什么不换个"更准"的算法：要得到全项目总数只能递归扫描磁盘，那与"懒加载 +
 * 不偷看未展开目录"的既有约束冲突；宁可给一个口径诚实的部分数，也不编一个假总数。
 */
export function countHiddenInLoadedLevels(levels: TreeLevels): number {
  let total = 0;
  for (const level of Object.values(levels)) {
    total += level.hiddenCount;
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
