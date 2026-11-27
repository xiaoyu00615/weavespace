/**
 * 资源标注名 / 标签 / 行颜色的 Shell 侧纯逻辑（UX-02C-04）。
 *
 * 为什么单独成模块：`.tsx` 无法被 `node:test` import（没有 JSX 变换），
 * 而"草稿怎么合并、哪些字段真的变了、菜单该不该给入口、颜色 token 怎么映射"
 * 这些**容易出错且必须被断言**的逻辑不能散落在组件里。
 *
 * 边界：
 * - 不 fetch、不碰配置、不碰磁盘；
 * - 规范化规则来自 `packages/contracts/metadata.ts`（与 Host 同一份实现）；
 * - 颜色只产出**类名**，具体色值在样式表里（换主题不需要改数据）。
 */
import {
  MAX_TAGS,
  normalizeAliasText,
  normalizeTagList,
  RESOURCE_COLORS,
  type ResourceColor,
} from '../../../../packages/contracts/metadata.ts';
import type { ResourceMetadataDto, ResourceMetadataPatch } from '../client/client-api.ts';

/** 预设色的展示名。顺序即调色板顺序（从"警示"到"中性"）。 */
const COLOR_LABELS: Readonly<Record<ResourceColor, string>> = {
  red: '红',
  orange: '橙',
  yellow: '黄',
  green: '绿',
  blue: '蓝',
  purple: '紫',
  gray: '灰',
};

export interface ColorOption {
  readonly token: ResourceColor;
  readonly label: string;
  /** 行上的类名：具体色值由 CSS 变量决定，组件里不出现任何颜色字面量。 */
  readonly rowClass: string;
  /** 调色板按钮的类名（同一个 token，视觉上是一个色块）。 */
  readonly swatchClass: string;
}

export const COLOR_OPTIONS: readonly ColorOption[] = RESOURCE_COLORS.map((token) => ({
  token,
  label: COLOR_LABELS[token],
  rowClass: `tree__row--color-${token}`,
  swatchClass: `meta__swatch meta__swatch--${token}`,
}));

/** 未知/缺省颜色一律不产生类名：绝不拼出 `tree__row--color-undefined`。 */
export function colorOptionOf(color: string | undefined): ColorOption | undefined {
  if (typeof color !== 'string') return undefined;
  return COLOR_OPTIONS.find((option) => option.token === color);
}

export function colorRowClassOf(color: string | undefined): string | null {
  return colorOptionOf(color)?.rowClass ?? null;
}

export function colorLabelOf(color: string | undefined): string {
  return colorOptionOf(color)?.label ?? '默认';
}

/** 行首的"标注名"展示：真实名称在前，标注名在括号里（契约 §4.2）。 */
export function displayTitleOf(meta: ResourceMetadataDto | undefined): string | null {
  if (!meta?.alias) return null;
  return meta.alias;
}

/**
 * 编辑草稿。
 *
 * 与 `ResourceMetadataDto` 的区别：`alias` 用**空串**表示"用户删光了"（输入框的自然状态），
 * `color` 用 `undefined` 表示"默认色"。转成请求补丁时才变成 `null` / 缺省。
 */
export interface MetadataDraft {
  readonly alias: string;
  readonly tags: readonly string[];
  readonly color: ResourceColor | undefined;
}

export function draftOf(meta: ResourceMetadataDto | undefined): MetadataDraft {
  return {
    alias: meta?.alias ?? '',
    tags: meta?.tags ?? [],
    color: colorOptionOf(meta?.color)?.token,
  };
}

export function draftIsEmpty(draft: MetadataDraft): boolean {
  return draft.alias.trim() === '' && draft.tags.length === 0 && draft.color === undefined;
}

/** 草稿里"能不能保存"的即时判断：只挡注定失败的输入，权威判断仍在 Host。 */
export function draftErrorOf(draft: MetadataDraft): string | null {
  const alias = normalizeAliasText(draft.alias);
  if (!alias.ok) return alias.message;
  if (draft.tags.length > MAX_TAGS) return `单个资源最多 ${MAX_TAGS} 个标签`;
  return null;
}

/**
 * 提交补丁：**只带真的变了的字段**。
 *
 * 这一点很关键：两个窗口同时看同一个文件，A 改颜色、B 改标签。若每次都提交全部
 * 三个字段，后保存的那个会把对方刚写的值覆盖回自己屏幕上的旧值。
 */
export function patchOfDraft(draft: MetadataDraft, meta: ResourceMetadataDto | undefined): ResourceMetadataPatch {
  const patch: { -readonly [K in keyof ResourceMetadataPatch]: ResourceMetadataPatch[K] } = {};
  const alias = normalizeAliasText(draft.alias);
  const nextAlias = alias.ok ? alias.value : draft.alias.trim();
  const currentAlias = meta?.alias ?? null;
  if (nextAlias !== currentAlias) patch.alias = nextAlias;

  const currentTags = meta?.tags ?? [];
  if (draft.tags.length !== currentTags.length || draft.tags.some((tag, index) => tag !== currentTags[index])) {
    patch.tags = [...draft.tags];
  }

  const currentColor = colorOptionOf(meta?.color)?.token;
  if (draft.color !== currentColor) patch.color = draft.color ?? null;

  return patch;
}

export function patchIsEmpty(patch: ResourceMetadataPatch): boolean {
  return patch.alias === undefined && patch.tags === undefined && patch.color === undefined;
}

export type TagEditResult =
  | { ok: true; draft: MetadataDraft }
  | { ok: false; message: string };

/**
 * 添加一个标签。
 *
 * 空白、重复（大小写不敏感）、超长、超数量都在这里挡下来并给出可读原因：
 * 用户按了回车却"什么都没发生"是最难自查的失败。
 */
export function addTagToDraft(draft: MetadataDraft, raw: string): TagEditResult {
  const parsed = normalizeTagList([...(draft.tags as string[]), raw]);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  if (parsed.value.length === draft.tags.length) {
    const reason = raw.trim() === '' ? '标签不能为空' : `「${raw.trim()}」已经在这个资源的标签里了`;
    return { ok: false, message: reason };
  }
  return { ok: true, draft: { ...draft, tags: parsed.value } };
}

export function removeTagFromDraft(draft: MetadataDraft, tag: string): MetadataDraft {
  return { ...draft, tags: draft.tags.filter((item) => item !== tag) };
}

/* ------------------------------------------------------------------ */
/* 提示文案与菜单可用性                                                */
/* ------------------------------------------------------------------ */

export function metadataSavedNotice(alias: string | undefined): string {
  return alias ? `已保存资源标注（${alias}）` : '已保存资源标注';
}

export function metadataClearedNotice(): string {
  return '已清除该资源的全部标注';
}

export function metadataNoopNotice(): string {
  return '标注没有变化（未写入配置）';
}

export function metadataUnknownNotice(): string {
  return '标注保存结果未确认：已刷新该目录，请核对后再决定是否重试（不会自动重发）';
}

/**
 * 编辑会话归属失效的原因（UX-02C-04-R1）。
 *
 * 四种原因与"保存失败"是**两件事**：失败是"试过了、Host 拒绝了"，
 * 这里是"这次编辑已经不再指向原来那个对象/工作区"，因此提示文案里
 * 不允许出现"失败"二字，也不该建议用户"重试"同一个对话框。
 */
export type MetadataStaleReason =
  | 'workspace-switched'
  | 'target-changed'
  | 'target-missing'
  | 'target-unverified';

export const METADATA_STALE_REASONS: readonly MetadataStaleReason[] = Object.freeze([
  'workspace-switched',
  'target-changed',
  'target-missing',
  'target-unverified',
] as MetadataStaleReason[]);

const STALE_TEXTS: Readonly<Record<MetadataStaleReason, { readonly save: string; readonly clear: string }>> = {
  'workspace-switched': {
    save: '工作区已切换，这次标注没有保存（请在新工作区重新打开对话框）',
    clear: '工作区已切换，这次清除没有执行',
  },
  'target-changed': {
    save: '目标资源已被替换，这次标注没有保存（请对当前文件重新设置）',
    clear: '目标资源已被替换，这次清除没有执行（不会删掉别的对象的标注）',
  },
  'target-missing': {
    save: '目标资源已不存在，这次标注没有保存',
    clear: '目标资源已不存在，这次清除没有执行',
  },
  'target-unverified': {
    save: '无法确认目标资源的身份，这次标注没有保存（请刷新后重试）',
    clear: '无法确认目标资源的身份，这次清除没有执行（请刷新后重试）',
  },
};

export function metadataStaleNotice(reason: MetadataStaleReason, action: 'save' | 'clear'): string {
  return STALE_TEXTS[reason][action];
}

export interface MetadataCommandState {
  readonly visible: boolean;
  readonly disabled: boolean;
  readonly hint?: string;
}

/**
 * 右键菜单里三个元数据入口的可用性。
 *
 * 与隐藏/回收同一套判据：只有**已授权 Multi 项目**里的普通文件/文件夹可标注。
 * 链接一律不给（Host 侧同样拒绝：标注一个链接等于给"根外对象"起别名）；
 * 项目根单独一条（`origin === 'project-root'`），它用项目身份，不碰磁盘。
 */
export function metadataCommandState(input: {
  readonly origin: string;
  readonly entryKind?: 'file' | 'directory' | 'link';
  readonly supported: boolean;
}): MetadataCommandState {
  if (input.entryKind === 'link' || input.origin === 'link') {
    return { visible: false, disabled: true };
  }
  const relevant =
    input.origin === 'file' || input.origin === 'folder' || input.origin === 'project-root';
  if (!relevant) return { visible: false, disabled: true };
  if (!input.supported) {
    return { visible: true, disabled: true, hint: '当前模式/项目不支持（需要已授权的真实项目）' };
  }
  return { visible: true, disabled: false };
}

/** 行尾的标签摘要：最多显示 `limit` 个，其余折成 `+N`（侧栏只有 260px）。 */
export function tagBadges(tags: readonly string[], limit = 2): { shown: string[]; more: number } {
  return { shown: tags.slice(0, limit), more: Math.max(0, tags.length - limit) };
}
