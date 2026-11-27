/**
 * 资源元数据（标注名 / 标签 / 行颜色）的 Host 侧纯逻辑（UX-02C-04）。
 *
 * 职责边界（与 `hidden.ts` 同构，刻意不合并）：
 * - **不做 HTTP**（状态码与响应形状在 `server.ts`）；
 * - **不写配置**（持久化在 `store/file-store.ts`，提交点唯一）；
 * - **不碰磁盘内容**：元数据只改工作台配置，文件字节、扩展名、目录结构都不动。
 *
 * 这个模块真正要解决的是"同一路径还是不是同一个对象"：
 * 记录里存了 `rootToken`（项目根身份）与 `identity`（`dev:ino`）。读取时逐个核验，
 * 得到四种状态：
 *
 * - `active`：路径上仍是当初那个对象 → 元数据生效；
 * - `missing`：路径上已经没有对象（被删 / 被移走 / 在回收区里）→ 不生效；
 * - `rebound`：路径上换成了另一个对象 → 不生效，**绝不把旧标注名套到新文件上**；
 * - `unverified`：无法核验（Provider 没有身份能力 / IO 异常）→ 不生效。
 *
 * 与隐藏的取舍差别：隐藏遇到 `unverified` 继续隐藏（宁可少显示），
 * 元数据遇到 `unverified` **不显示**（宁可少标注）。理由是同一条——
 * 拿不准的时候不要声称一件用户没有确认过的事实。
 */
import type { ErrorCode } from '../../../packages/contracts/errors.ts';
import { sameEntryPath, validateEntryPath } from '../../../packages/storage/entry-name.ts';
import type {
  ConfigMetadataEntry,
  ResourceColor,
} from './store/config.ts';
import {
  RESOURCE_COLORS,
  normalizeAliasText,
  normalizeTagList,
} from '../../../packages/contracts/metadata.ts';

/** 集合端点禁止携带的字段：任何一条都意味着客户端在自述身份或路径。 */
export const METADATA_FORBIDDEN_FIELDS = [
  'absolutePath',
  'absolute',
  'rootDir',
  'root',
  'rootToken',
  'canonicalRoot',
  'identity',
  'providerId',
  'actorId',
  'updatedAt',
  'metadata',
] as const;

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 与 `sameEntryPath` 同一口径的 Map 键（Windows 大小写不敏感，其它平台原样）。 */
const pathKey = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path);

/** 写入意图：`undefined` = 不改这一项；`null` / `[]` = 清除这一项。 */
export interface MetadataUpdateRequest {
  readonly projectId: string;
  /** 规范化后的项目内相对路径；`''` = 项目根展示项。 */
  readonly path: string;
  readonly alias?: string | null;
  readonly tags?: readonly string[];
  readonly color?: ResourceColor | null;
}

export interface MetadataClearRequest {
  readonly projectId: string;
  readonly path: string;
}

export type ParseMetadataResult<T> =
  | { ok: true; request: T }
  | { ok: false; errorCode: ErrorCode; message: string };

function reject(errorCode: ErrorCode, message: string): { ok: false; errorCode: ErrorCode; message: string } {
  return { ok: false, errorCode, message };
}

function parseProjectId(body: Record<string, unknown>): string | null {
  const raw = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  if (raw === '' || !PROJECT_ID_RE.test(raw)) return null;
  return raw;
}

/**
 * 路径：允许空串（项目根展示项），其余必须是规范化的项目内相对路径。
 *
 * 空串**只**用于项目根，不会被拿去 `readDir` —— 元数据端点从头到尾没有磁盘读，
 * 因此这里不存在"借项目根元数据获得根目录操作权限"的路径。
 */
function parseMetadataPath(value: unknown): { ok: true; path: string } | { ok: false; errorCode: ErrorCode; message: string } {
  if (value === undefined || value === null) return reject('ERR_COMMAND_INVALID', '缺少或非法的 path');
  if (typeof value !== 'string') return reject('ERR_COMMAND_INVALID', '缺少或非法的 path');
  if (value === '') return { ok: true, path: '' };
  const checked = validateEntryPath(value);
  if (!checked.ok) return reject(checked.errorCode, checked.message);
  if (checked.value.startsWith('.weavespace')) {
    return reject('ERR_PATH_RESERVED', '该路径属于工作台内部目录（回收区），不接受标注');
  }
  return { ok: true, path: checked.value };
}

/**
 * 标注名规范化：trim 后为空即"清除"。
 *
 * 允许清除是刻意的：用户在输入框里删光内容再保存，与点"清除"应该是同一件事，
 * 否则会出现"空字符串标注名"这种既显示不出来、又占着记录的状态。
 */
export function normalizeAlias(
  value: unknown,
): { ok: true; alias: string | null } | { ok: false; errorCode: ErrorCode; message: string } {
  // 规则本身在共享契约里（与 Shell 输入侧同一份实现），这里只做错误码映射
  const normalized = normalizeAliasText(value);
  if (!normalized.ok) return reject('ERR_COMMAND_INVALID', normalized.message);
  return { ok: true, alias: normalized.value };
}

/**
 * 标签规范化：trim → 丢弃空项 → 按**大小写不敏感**去重（保留首次出现的写法）。
 *
 * 大小写规则写死在这里并对外声明：`Arch` 与 `arch` 是同一个标签，
 * 但保留用户第一次输入的那种写法（不做大小写折叠，避免把 `API` 变成 `api`）。
 */
export function normalizeTags(
  value: readonly unknown[],
): { ok: true; tags: string[] } | { ok: false; errorCode: ErrorCode; message: string } {
  const normalized = normalizeTagList(value);
  if (!normalized.ok) return reject('ERR_COMMAND_INVALID', normalized.message);
  return { ok: true, tags: normalized.value };
}

function parseColor(
  value: unknown,
): { ok: true; color: ResourceColor | null } | { ok: false; errorCode: ErrorCode; message: string } {
  if (value === null) return { ok: true, color: null };
  if (typeof value !== 'string' || !(RESOURCE_COLORS as readonly string[]).includes(value)) {
    return reject('ERR_COMMAND_INVALID', `颜色只能是 ${RESOURCE_COLORS.join(' / ')} 之一，或 null 表示清除`);
  }
  return { ok: true, color: value as ResourceColor };
}

/** 解析"设置元数据"请求。三个字段都可选，但至少要有一个。 */
export function parseMetadataSetBody(
  body: Record<string, unknown>,
): ParseMetadataResult<MetadataUpdateRequest> {
  for (const field of METADATA_FORBIDDEN_FIELDS) {
    if (field in body) return reject('ERR_COMMAND_INVALID', `不接受客户端提供的 ${field}`);
  }
  const projectId = parseProjectId(body);
  if (!projectId) return reject('ERR_COMMAND_INVALID', '缺少或非法的 projectId');
  const path = parseMetadataPath(body.path);
  if (!path.ok) return path;

  const has = (key: string): boolean => key in body;
  if (!has('alias') && !has('tags') && !has('color')) {
    return reject('ERR_COMMAND_INVALID', '至少要提供 alias / tags / color 之一');
  }

  let alias: string | null | undefined;
  if (has('alias')) {
    const parsed = normalizeAlias(body.alias);
    if (!parsed.ok) return parsed;
    alias = parsed.alias;
  }

  let tags: string[] | undefined;
  if (has('tags')) {
    if (!Array.isArray(body.tags)) return reject('ERR_COMMAND_INVALID', 'tags 必须是数组');
    const parsed = normalizeTags(body.tags as unknown[]);
    if (!parsed.ok) return parsed;
    tags = parsed.tags;
  }

  let color: ResourceColor | null | undefined;
  if (has('color')) {
    const parsed = parseColor(body.color);
    if (!parsed.ok) return parsed;
    color = parsed.color;
  }

  return { ok: true, request: { projectId, path: path.path, alias, tags, color } };
}

export function parseMetadataClearBody(
  body: Record<string, unknown>,
): ParseMetadataResult<MetadataClearRequest> {
  for (const field of METADATA_FORBIDDEN_FIELDS) {
    if (field in body) return reject('ERR_COMMAND_INVALID', `不接受客户端提供的 ${field}`);
  }
  const projectId = parseProjectId(body);
  if (!projectId) return reject('ERR_COMMAND_INVALID', '缺少或非法的 projectId');
  const path = parseMetadataPath(body.path);
  if (!path.ok) return path;
  return { ok: true, request: { projectId, path: path.path } };
}

/* ------------------------------------------------------------------ */
/* 读取侧：核验记录与打标                                              */
/* ------------------------------------------------------------------ */

export type MetadataRecordState = 'active' | 'missing' | 'rebound' | 'unverified';

/** 只有 `active` 才允许把记录里的展示字段拿出来用。 */
export function stateShowsMetadata(state: MetadataRecordState): boolean {
  return state === 'active';
}

/** 与 `IdentityProbe`（hidden.ts）同一形状：只依赖 `identityOf` 一个方法。 */
export interface MetadataIdentityProbe {
  identityOf?(path: string): Promise<string | null>;
}

/**
 * 核验一条记录当前是否仍然成立。
 *
 * 空路径（项目根）不查 Provider：根的身份就是根令牌，调用方已按
 * `rootToken === handle.rootToken` 过滤，这里直接判 `active`。
 */
export async function classifyMetadataRecord(
  record: ConfigMetadataEntry,
  probe: MetadataIdentityProbe,
  rootToken?: string,
): Promise<MetadataRecordState> {
  if (record.path === '') {
    if (rootToken !== undefined && record.rootToken !== rootToken) return 'rebound';
    return 'active';
  }
  if (typeof probe.identityOf !== 'function') return 'unverified';
  try {
    const now = await probe.identityOf(record.path);
    if (now === null) return 'missing';
    return now === record.identity ? 'active' : 'rebound';
  } catch {
    return 'unverified';
  }
}

/** 对外展示的三个字段：只包含**存在**的项，空对象表示"没有任何标注"。 */
export interface MetadataDisplay {
  readonly alias?: string;
  readonly tags: readonly string[];
  readonly color?: string;
}

export function displayOf(entry: ConfigMetadataEntry): MetadataDisplay {
  return {
    ...(entry.alias !== undefined ? { alias: entry.alias } : {}),
    tags: entry.tags,
    ...(entry.color !== undefined ? { color: entry.color } : {}),
  };
}

export function isEmptyDisplay(display: MetadataDisplay): boolean {
  return display.alias === undefined && display.tags.length === 0 && display.color === undefined;
}

export interface MarkMetadataInput {
  /** 本次读取的层路径（根为空串）。 */
  readonly level: string;
  readonly records: readonly ConfigMetadataEntry[];
  readonly probe: MetadataIdentityProbe;
  readonly rootToken?: string;
}

export interface MarkMetadataResult<T> {
  /** 原条目 + 可选 `meta`（只有核验通过才有）。 */
  readonly entries: T[];
  /** 生效的元数据条数（本层）。 */
  readonly applied: number;
  /** 失效条数（`missing` + `rebound` + `unverified`）：只用于诊断，不改变记录。 */
  readonly stale: number;
}

/**
 * 给一层的条目挂上元数据。
 *
 * 只为**本层**的条目找记录：元数据是逐条目的展示信息，不做"目录标注影响子项"的继承
 * （那会让一次目录标注把整棵子树染色，用户无法区分"我自己标的"和"被上级带的"）。
 */
export async function markMetadata<T extends { readonly name: string }>(
  entries: readonly T[],
  input: MarkMetadataInput,
): Promise<MarkMetadataResult<T & { readonly meta?: MetadataDisplay }>> {
  const { level, records, probe, rootToken } = input;
  const byPath = new Map<string, ConfigMetadataEntry>();
  for (const record of records) byPath.set(pathKey(record.path), record);

  const out: Array<T & { readonly meta?: MetadataDisplay }> = [];
  let applied = 0;
  let stale = 0;

  for (const entry of entries) {
    const path = level === '' ? entry.name : `${level}/${entry.name}`;
    const record = byPath.get(pathKey(path));
    if (!record) {
      out.push(entry);
      continue;
    }
    const state = await classifyMetadataRecord(record, probe, rootToken);
    if (!stateShowsMetadata(state)) {
      stale += 1;
      out.push(entry);
      continue;
    }
    applied += 1;
    out.push({ ...entry, meta: displayOf(record) });
  }

  return { entries: out, applied, stale };
}

/** 同路径记录查找（Windows 大小写不敏感）。 */
export function findMetadataRecord(
  records: readonly ConfigMetadataEntry[],
  path: string,
): ConfigMetadataEntry | undefined {
  return records.find((record) => sameEntryPath(record.path, path));
}
