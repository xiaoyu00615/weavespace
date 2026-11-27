/**
 * 资源元数据的**共享契约**（UX-02C-04）：颜色 token、长度上限与规范化规则。
 *
 * 为什么放在 `packages/contracts` 而不是各端各写一份：
 * Host 与 Shell 必须对"什么算合法标注名/标签"给出**同一个答案**。两处各写一份，
 * 迟早在长度边界、大小写去重或控制字符上走形——那时用户会看到"输入框允许、
 * 保存却 400"，而这正是本阶段要避免的体验。
 *
 * Host 仍然是唯一权威：它在写配置前会再跑一次同一份函数（这里的实现是纯函数，
 * 两端共用同一段代码，因此"再跑一次"不会得出不同结论）。
 */

/**
 * 颜色只存**语义 token**，不存 `#rrggbb` 或任意 CSS 字符串：
 * 具体色值由样式表映射，将来换主题不需要迁移任何数据，
 * 也不可能把用户配置变成一段注入样式。
 */
export const RESOURCE_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'] as const;
export type ResourceColor = (typeof RESOURCE_COLORS)[number];

/** 标注名长度上限（侧栏 260px，再长也只能显示前几个字，截断在展示层做）。 */
export const MAX_ALIAS_LENGTH = 80;
/** 单个资源的标签数上限。 */
export const MAX_TAGS = 16;
/** 单个标签的长度上限。 */
export const MAX_TAG_LENGTH = 24;

/**
 * 控制字符（含换行/制表/双向覆盖符）：标注名与标签是**单行展示文本**，
 * 允许它们进来就等于允许一段配置把界面排版撑开或改成从右往左。
 */
export const METADATA_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

export function isResourceColor(value: unknown): value is ResourceColor {
  return typeof value === 'string' && (RESOURCE_COLORS as readonly string[]).includes(value);
}

/**
 * 资源锚（R1-03）：`projectId + path + rootToken + identity` 的不可逆摘要（32 位十六进制）。
 *
 * 它解决的是"编辑会话打开之后，那个位置上还是不是同一个对象"：
 * - Shell 只把它当成**不透明字符串**原样回传，不解析、不推导、不据此做授权；
 * - Host 收到后用它和**自己核验出的身份**重新算一遍做比对，不一致即拒绝写入；
 * - 因此它既不是身份自述（客户端无法从锚反推出 `dev:ino`），
 *   也不是权限凭据（写授权仍然只看项目级授权判定）。
 *
 * 形状规则放在共享契约里，两端对"什么算一个锚"只有一个答案。
 */
export const METADATA_ANCHOR_RE = /^[0-9a-f]{32}$/;

export function isMetadataAnchor(value: unknown): value is string {
  return typeof value === 'string' && METADATA_ANCHOR_RE.test(value);
}

/** 规范化结果：`value` 为空表示"清除这一项"。 */
export type NormalizedText =
  | { ok: true; value: string | null }
  | { ok: false; message: string };

/**
 * 标注名规范化：trim 后为空即"清除"。
 *
 * 允许"空 → 清除"是刻意的：用户在输入框里删光内容再保存，与点"清除"应该是同一件事，
 * 否则会出现"空字符串标注名"这种既显示不出来、又占着记录的状态。
 */
export function normalizeAliasText(value: unknown): NormalizedText {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, message: '标注名必须是文本' };
  const trimmed = value.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (METADATA_CONTROL_CHARS.test(trimmed)) return { ok: false, message: '标注名不能包含换行或控制字符' };
  if (trimmed.length > MAX_ALIAS_LENGTH) {
    return { ok: false, message: `标注名最多 ${MAX_ALIAS_LENGTH} 个字符` };
  }
  return { ok: true, value: trimmed };
}

export type NormalizedTags =
  | { ok: true; value: string[] }
  | { ok: false; message: string };

/**
 * 标签规范化：trim → 丢弃空项 → 按**大小写不敏感**去重（保留首次出现的写法）。
 *
 * 大小写规则就写在这里并对外声明：`Arch` 与 `arch` 是同一个标签，
 * 但保留用户第一次输入的那种写法（不做大小写折叠，避免把 `API` 变成 `api`）。
 */
export function normalizeTagList(value: readonly unknown[]): NormalizedTags {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return { ok: false, message: '标签必须是文本' };
    const trimmed = item.trim();
    if (trimmed === '') continue;
    if (METADATA_CONTROL_CHARS.test(trimmed)) return { ok: false, message: '标签不能包含换行或控制字符' };
    if (trimmed.length > MAX_TAG_LENGTH) {
      return { ok: false, message: `单个标签最多 ${MAX_TAG_LENGTH} 个字符` };
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length > MAX_TAGS) return { ok: false, message: `单个资源最多 ${MAX_TAGS} 个标签` };
  }
  return { ok: true, value: out };
}
