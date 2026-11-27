/**
 * 工作区配置的解析、校验与序列化（UX-02B-02 / ADR-022 §3）。
 *
 * 版本演进（每一版只读兼容，写回时才升版）：
 * - v2：commitSeq / issuedIds / checksum / revoked；
 * - v3：+ `hidden`（UX-02C-03-P1 工作台隐藏）；
 * - v4：+ `trash`（UX-02C-03-P2 回收区）；
 * - v5：+ `metadata`（UX-02C-04 资源标注名 / 标签 / 颜色）。
 *
 * 纪律：
 * - **解析即校验**：任何字段形态不符都返回 `undefined`，由调用方按"配置不可用"处理；
 * - `checksum` 只证明这份配置**自身**没被截断，不能证明它是最新的（ADR-022 §3.2）；
 * - v1–v4 只读兼容：内存里升级为 v5 视图，只有发生变更时才写回 v5；
 * - 序列化必须确定性（字段顺序固定），否则 checksum 无法复算；
 * - **校验和按"文件声明的版本"计算**：v2 文件里没有 `hidden` 字段参与哈希，
 *   否则升级的那一刻会把所有历史配置文件判成损坏（灾难级回归）。
 */
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { validateEntryPath } from '../../../../packages/storage/entry-name.ts';
import { sameEntryPath } from '../../../../packages/storage/entry-name.ts';
import { isTrashSizeSupported } from '../../../../packages/storage/trash-size.ts';
import {
  MAX_ALIAS_LENGTH,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  METADATA_CONTROL_CHARS,
  RESOURCE_COLORS,
  type ResourceColor,
} from '../../../../packages/contracts/metadata.ts';

export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * 隐藏记录上限（UX-02C-03-P1）。
 *
 * 这是**配置体量**的护栏，不是语义限制：隐藏只写工作台配置，条目再多也不该让
 * 一份小 JSON 变成数据库。超过上限时写入口明确拒绝，而不是静默截断。
 */
export const MAX_HIDDEN_ENTRIES = 2000;

/**
 * 回收区上限（UX-02C-03-P2-01）。
 *
 * 两个不同的上限，各自解决一个问题：
 * - `MAX_TRASH_UNRESOLVED`：**占用回收区文件**的记录（pending/stored/restoring/conflicted）。
 *   到达上限后拒绝新的删除，而不是悄悄丢掉旧记录——P2 没有永久删除，静默丢弃等于
 *   让用户失去恢复能力。
 * - `MAX_TRASH_RECORDS`：配置体积护栏（含已恢复/已中止/已丢失的历史）。超出时按
 *   时间淘汰**不再占用文件**的终态记录（restored/aborted/missing），不损失恢复能力。
 */
export const MAX_TRASH_UNRESOLVED = 500;
export const MAX_TRASH_RECORDS = 2000;

/**
 * 资源元数据上限（UX-02C-04）。
 *
 * 与隐藏记录同一个数量级：这是**配置体量**的护栏，不是语义限制。超限时写入口明确
 * 拒绝（`ERR_METADATA_LIMIT`），绝不静默淘汰用户写过的标注名/标签。
 */
export const MAX_METADATA_ENTRIES = 2000;

// 颜色 token 与长度上限属于**共享契约**：Host 与 Shell 必须给出同一个答案，
// 因此实现在 `packages/contracts/metadata.ts`，这里只做转出。
export { MAX_ALIAS_LENGTH, MAX_TAGS, MAX_TAG_LENGTH, RESOURCE_COLORS };
export type { ResourceColor };

/**
 * 一条资源元数据（UX-02C-04）。
 *
 * 身份四元组与隐藏记录同源：`projectId + path + rootToken + identity`。
 * - `path` 是**定位器**（项目内相对路径，`''` 表示项目根展示项）；
 * - `rootToken` / `identity` 是**身份**：路径还在、对象换了，元数据就不再生效
 *   （`rebound`），绝不把旧标注名套到后来出现在同一路径的新文件上。
 *
 * 空 `tags` 与缺省的 `alias` / `color` 都是合法值：它表示"这条资源只剩别的字段"，
 * 三个字段全空时整条记录会被删除（不保留空壳）。
 */
export interface ConfigMetadataEntry {
  readonly projectId: string;
  /** 规范化后的项目内相对路径；`''` = 项目根展示项。 */
  readonly path: string;
  readonly rootToken: string;
  /** 对象身份（`dev:ino`）；项目根为根令牌本身。 */
  readonly identity: string;
  /** 标注名：附加展示信息，**不替代**真实名称。 */
  readonly alias?: string;
  /** 规范化后的标签（已 trim、去空、按大小写不敏感去重，保持写入顺序）。 */
  readonly tags: readonly string[];
  readonly color?: ResourceColor;
  /** 最后写入时间（ISO 8601，仅用于诊断，不参与任何判定）。 */
  readonly updatedAt: string;
}

/** 回收记录状态机（UX-02C-03-P2-01）。 */
export type TrashState =
  | 'pending'
  | 'stored'
  | 'restoring'
  | 'restored'
  | 'aborted'
  | 'conflicted'
  | 'missing';

export const TRASH_STATES: readonly TrashState[] = Object.freeze([
  'pending',
  'stored',
  'restoring',
  'restored',
  'aborted',
  'conflicted',
  'missing',
]);

/** 仍在占用回收区文件、需要参与容量判定的状态。 */
export const TRASH_UNRESOLVED_STATES: readonly TrashState[] = Object.freeze([
  'pending',
  'stored',
  'restoring',
  'conflicted',
] as TrashState[]);

/**
 * 一条回收记录（UX-02C-03-P2-01）。
 *
 * `identity` 在 **pending 就要有**：它来自"移动前对源对象的 lstat"，是崩溃后判断
 * "移动到底发生没发生"的唯一凭据。没有它就只能靠文件名/大小猜，那正是本项目一直
 * 拒绝的做法。
 */
export interface ConfigTrashEntry {
  readonly opId: string;
  readonly projectId: string;
  readonly rootToken: string;
  readonly originalPath: string;
  readonly entryKind: 'file';
  readonly identity: string;
  readonly size: number;
  readonly deletedAt: string;
  readonly state: TrashState;
  readonly restoredAt?: string;
  readonly restoredTo?: string;
}

export interface ConfigProject {
  readonly projectId: string;
  readonly name: string;
  readonly rootDir: string;
  /** 授权时确认的规范根；缺失表示"未记录"（v1 迁移或旧配置）。 */
  readonly canonicalRoot?: string;
  /** 授权时确认的根令牌；缺失时加载期不比对（仍会重新 inspect 判可用性）。 */
  readonly rootToken?: string;
  readonly grantedAt?: string;
  readonly grantSource?: string;
  /** 该条目由哪一次变更事务写入（`opId` 结果查询凭据）。 */
  readonly createdByOp?: string;
}

export interface ConfigRevokedEntry {
  readonly projectId: string;
  readonly revokedAtSeq: number;
  readonly opId: string;
}

/**
 * 一条"从文件树隐藏"的记录（UX-02C-03-P1）。
 *
 * 四个字段各自解决一个问题：
 * - `projectId`：作用域。同名路径在另一个项目里不受影响；
 * - `path`：规范化后的项目内相对路径（正斜杠、无 `..`）；
 * - `rootToken`：项目根身份。根被重新授权/替换后，旧记录自动失效，
 *   不会把"新根里同名的新文件"继续当成隐藏对象；
 * - `identity`：对象身份（`dev:ino`）。同名路径被外部换成另一个对象时，
 *   Host 报告 `rebound` 并停止隐藏，绝不"未经核验继续隐藏新对象"。
 */
export interface ConfigHiddenEntry {
  readonly projectId: string;
  readonly path: string;
  readonly rootToken: string;
  readonly identity: string;
  /** 写入该记录的时间（ISO 8601，仅用于诊断，不参与任何判定）。 */
  readonly hiddenAt: string;
}

/** 内存形态：`checksum` 不参与（写盘时才算）。 */
export interface ConfigState {
  readonly version: 5;
  readonly commitSeq: number;
  readonly issuedIds: readonly string[];
  readonly revoked: readonly ConfigRevokedEntry[];
  readonly projects: readonly ConfigProject[];
  readonly hidden: readonly ConfigHiddenEntry[];
  readonly trash: readonly ConfigTrashEntry[];
  readonly metadata: readonly ConfigMetadataEntry[];
}

/**
 * 允许序列化的输入形态。
 *
 * 保留 `version: 2` / `3` / `4` 是为了既有夹具与"只读兼容"路径：低版本输入序列化成
 * 同版本文件（校验和也按声明版本计算），不会被悄悄升版。
 */
export interface ConfigStateInput {
  readonly version: 2 | 3 | 4 | 5;
  readonly commitSeq: number;
  readonly issuedIds: readonly string[];
  readonly revoked: readonly ConfigRevokedEntry[];
  readonly projects: readonly ConfigProject[];
  readonly hidden?: readonly ConfigHiddenEntry[];
  /** 只在 v4 起参与序列化与哈希；低版本输入即使带着也会被忽略。 */
  readonly trash?: readonly ConfigTrashEntry[];
  /** 只在 v5 起参与序列化与哈希；v2–v4 输入即使带着也会被忽略。 */
  readonly metadata?: readonly ConfigMetadataEntry[];
}

export interface ParsedConfig {
  readonly state: ConfigState;
  /** 原始文件声明的版本（用于判断是否需要写回）。 */
  readonly sourceVersion: 1 | 2 | 3 | 4 | 5;
}

export interface ConfigFile {
  readonly version: 5;
  readonly commitSeq: number;
  readonly issuedIds: readonly string[];
  readonly revoked: readonly ConfigRevokedEntry[];
  readonly projects: readonly ConfigProject[];
  readonly hidden: readonly ConfigHiddenEntry[];
  readonly trash: readonly ConfigTrashEntry[];
  readonly metadata: readonly ConfigMetadataEntry[];
  readonly checksum: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 控制字符检查来自共享契约（与 Shell 输入侧同一份正则）：
 * 校验只在 Host 生效，但规则不能两端各写一份。
 */
const CONTROL_CHARS_RE = METADATA_CONTROL_CHARS;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** 隐藏记录在哈希前必须排序：入库顺序不同不代表配置不同。 */
function canonicalHidden(hidden: readonly ConfigHiddenEntry[]): unknown[] {
  return [...hidden]
    .sort((a, b) =>
      a.projectId === b.projectId ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) : a.projectId < b.projectId ? -1 : 1,
    )
    .map((entry) => ({
      projectId: entry.projectId,
      path: entry.path,
      rootToken: entry.rootToken,
      identity: entry.identity,
      hiddenAt: entry.hiddenAt,
    }));
}

/** 回收记录同样按 `opId` 排序后再哈希（顺序不是语义）。 */
function canonicalTrash(trash: readonly ConfigTrashEntry[]): unknown[] {
  return [...trash]
    .sort((a, b) => (a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0))
    .map((entry) => ({
      opId: entry.opId,
      projectId: entry.projectId,
      rootToken: entry.rootToken,
      originalPath: entry.originalPath,
      entryKind: entry.entryKind,
      identity: entry.identity,
      size: entry.size,
      deletedAt: entry.deletedAt,
      state: entry.state,
      restoredAt: entry.restoredAt,
      restoredTo: entry.restoredTo,
    }));
}

/**
 * 元数据记录按 `projectId` → `path` → `identity` → `rootToken` 排序后再哈希：
 * 写入顺序不是语义。
 *
 * R1-01：记录的唯一性从"项目 + 路径"改成**身份四元组**（项目 + 路径 + 根令牌 + 对象身份），
 * 因此同一路径可能同时存在多条记录（对象换过、历史未清）。排序必须补上后两维，
 * 否则同一份配置会因为两条同路径记录的顺序不同而算出两个校验和。
 *
 * 对**既有 v5 配置**（一条路径最多一条记录）这个改动是零影响的：`path` 已经全序，
 * 新加的维度只在"同一路径的多条记录之间"起作用，历史配置的校验和逐字节不变。
 *
 * `alias` / `color` 用 `?? null` 归一：缺省与显式 null 必须得到同一个校验和，
 * 否则一次"只改标签"的写入会被算成两次不同的配置（历史 diff 全是噪音）。
 */
function canonicalMetadata(metadata: readonly ConfigMetadataEntry[]): unknown[] {
  return [...metadata]
    .sort((a, b) => {
      if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1;
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      if (a.identity !== b.identity) return a.identity < b.identity ? -1 : 1;
      return a.rootToken < b.rootToken ? -1 : a.rootToken > b.rootToken ? 1 : 0;
    })
    .map((entry) => ({
      projectId: entry.projectId,
      path: entry.path,
      rootToken: entry.rootToken,
      identity: entry.identity,
      alias: entry.alias ?? null,
      tags: [...entry.tags],
      color: entry.color ?? null,
      updatedAt: entry.updatedAt,
    }));
}

/**
 * checksum 的输入：**固定字段顺序**的 canonical JSON。
 * 绝不直接对原始文件文本取哈希——那样缩进/键序变化就会误判为损坏。
 *
 * `hidden` 只在 v3 起参与哈希，`trash` 只在 v4 起，`metadata` 只在 v5 起：
 * 低版本文件的校验和必须继续可复算。
 */
export function checksumOf(state: ConfigStateInput): string {
  const canonical = JSON.stringify({
    version: state.version,
    commitSeq: state.commitSeq,
    issuedIds: [...state.issuedIds],
    revoked: state.revoked.map((entry) => ({
      projectId: entry.projectId,
      revokedAtSeq: entry.revokedAtSeq,
      opId: entry.opId,
    })),
    projects: state.projects.map((project) => ({
      projectId: project.projectId,
      name: project.name,
      rootDir: project.rootDir,
      canonicalRoot: project.canonicalRoot,
      rootToken: project.rootToken,
      grantedAt: project.grantedAt,
      grantSource: project.grantSource,
      createdByOp: project.createdByOp,
    })),
    ...(state.version >= 3 ? { hidden: canonicalHidden(state.hidden ?? []) } : {}),
    // `trash` 只在 v4 起参与哈希：v2/v3 文件的校验和必须继续可复算
    ...(state.version >= 4 ? { trash: canonicalTrash(state.trash ?? []) } : {}),
    // `metadata` 只在 v5 起参与哈希：v2/v3/v4 文件的校验和必须继续可复算
    ...(state.version >= 5 ? { metadata: canonicalMetadata(state.metadata ?? []) } : {}),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function serializeConfig(state: ConfigStateInput): string {
  const file = {
    ...state,
    hidden: state.hidden ?? [],
    ...(state.version >= 4 ? { trash: state.trash ?? [] } : {}),
    ...(state.version >= 5 ? { metadata: state.metadata ?? [] } : {}),
    checksum: checksumOf(state),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

function parseProject(raw: unknown): ConfigProject | undefined {
  if (!isRecord(raw)) return undefined;
  const { projectId, name, rootDir } = raw;
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return undefined;
  if (!isNonEmptyString(name)) return undefined;
  if (!isNonEmptyString(rootDir) || !isAbsolute(rootDir)) return undefined;

  const optionalString = (key: string): string | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    return isNonEmptyString(value) ? value : undefined;
  };
  const canonicalRoot = optionalString('canonicalRoot');
  const rootToken = optionalString('rootToken');
  const grantedAt = optionalString('grantedAt');
  const grantSource = optionalString('grantSource');
  const createdByOp = optionalString('createdByOp');

  return {
    projectId,
    name: name.trim(),
    rootDir,
    ...(canonicalRoot ? { canonicalRoot } : {}),
    ...(rootToken ? { rootToken } : {}),
    ...(grantedAt ? { grantedAt } : {}),
    ...(grantSource ? { grantSource } : {}),
    ...(createdByOp ? { createdByOp } : {}),
  };
}

function parseRevoked(raw: unknown): ConfigRevokedEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const { projectId, revokedAtSeq, opId } = raw;
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return undefined;
  if (!isSeq(revokedAtSeq) || revokedAtSeq === 0) return undefined;
  if (!isNonEmptyString(opId)) return undefined;
  return { projectId, revokedAtSeq, opId };
}

function parseHidden(raw: unknown): ConfigHiddenEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const { projectId, path, rootToken, identity, hiddenAt } = raw;
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return undefined;
  if (typeof path !== 'string') return undefined;
  const checkedPath = validateEntryPath(path);
  // 路径必须是规范化的项目内相对路径：绝对路径 / `..` / 反斜杠一律视为损坏
  if (!checkedPath.ok || checkedPath.value !== path) return undefined;
  if (!isNonEmptyString(rootToken) || !isNonEmptyString(identity)) return undefined;
  if (!isNonEmptyString(hiddenAt)) return undefined;
  return { projectId, path, rootToken, identity, hiddenAt };
}

function parseTrash(raw: unknown): ConfigTrashEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const { opId, projectId, rootToken, originalPath, entryKind, identity, size, deletedAt, state } = raw;
  if (typeof opId !== 'string' || !/^[a-z0-9][a-z0-9-]{7,63}$/.test(opId)) return undefined;
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return undefined;
  if (!isNonEmptyString(rootToken) || !isNonEmptyString(identity)) return undefined;
  if (typeof originalPath !== 'string') return undefined;
  const checkedPath = validateEntryPath(originalPath);
  // 规范化 + 非保留命名空间：回收记录永远指向用户可见的项目内路径
  if (!checkedPath.ok || checkedPath.value !== originalPath) return undefined;
  if (checkedPath.value.startsWith('.weavespace')) return undefined;
  if (entryKind !== 'file') return undefined;
  // 与 Provider 共用同一条长度约束（R2-Supplement-R1 / R1-02）：超过 2^53 的长度
  // 无法精确表示，这样的记录永远无法通过恢复时的三方核对，属于"注定失败"的数据。
  if (!isTrashSizeSupported(size)) return undefined;
  if (!isNonEmptyString(deletedAt)) return undefined;
  if (typeof state !== 'string' || !(TRASH_STATES as readonly string[]).includes(state)) return undefined;

  const optionalString = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined;
  const restoredAt = optionalString(raw.restoredAt);
  const restoredTo = optionalString(raw.restoredTo);

  return {
    opId,
    projectId,
    rootToken,
    originalPath,
    entryKind: 'file',
    identity,
    size,
    deletedAt,
    state: state as TrashState,
    ...(restoredAt ? { restoredAt } : {}),
    ...(restoredTo ? { restoredTo } : {}),
  };
}

/**
 * 解析一条元数据记录（UX-02C-04）。
 *
 * 与 `parseHidden` 同一套严格口径，但多两条：
 * - `path` **允许空串**（项目根展示项）：它不是磁盘路径，永远不会被拿去 `readDir`；
 * - `alias` / `tags` / `color` 在这里也要校验——元数据是**用户输入**，一份被手工改坏的
 *   配置不能把一段任意文本变成界面上的标注名。
 *
 * 至少要有 `alias` / `tags` / `color` 之一：三个全空的记录没有意义（写入口会删掉它），
 * 出现即视为配置损坏（否则"删干净"与"留一条空壳"会有两种表示）。
 */
function parseMetadata(raw: unknown): ConfigMetadataEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const { projectId, path, rootToken, identity, updatedAt } = raw;
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return undefined;
  if (typeof path !== 'string') return undefined;
  if (path !== '') {
    const checkedPath = validateEntryPath(path);
    if (!checkedPath.ok || checkedPath.value !== path) return undefined;
    if (checkedPath.value.startsWith('.weavespace')) return undefined;
  }
  if (!isNonEmptyString(rootToken) || !isNonEmptyString(identity)) return undefined;
  if (!isNonEmptyString(updatedAt)) return undefined;

  const alias = raw.alias === undefined || raw.alias === null ? undefined : raw.alias;
  if (alias !== undefined) {
    if (typeof alias !== 'string') return undefined;
    if (alias !== alias.trim()) return undefined;
    if (alias === '' || alias.length > MAX_ALIAS_LENGTH) return undefined;
    if (CONTROL_CHARS_RE.test(alias)) return undefined;
  }

  const tagsRaw = raw.tags ?? [];
  if (!Array.isArray(tagsRaw)) return undefined;
  if (tagsRaw.length > MAX_TAGS) return undefined;
  const tags: string[] = [];
  const folded = new Set<string>();
  for (const item of tagsRaw as unknown[]) {
    if (typeof item !== 'string') return undefined;
    if (item === '' || item !== item.trim() || item.length > MAX_TAG_LENGTH) return undefined;
    if (CONTROL_CHARS_RE.test(item)) return undefined;
    const key = item.toLowerCase();
    // 重复（大小写不敏感）即损坏：写入口已经去过重，出现说明有人手工改过
    if (folded.has(key)) return undefined;
    folded.add(key);
    tags.push(item);
  }

  const color = raw.color === undefined || raw.color === null ? undefined : raw.color;
  if (color !== undefined && (typeof color !== 'string' || !(RESOURCE_COLORS as readonly string[]).includes(color))) {
    return undefined;
  }

  if (alias === undefined && tags.length === 0 && color === undefined) return undefined;

  return {
    projectId,
    path,
    rootToken,
    identity,
    ...(alias !== undefined ? { alias } : {}),
    tags,
    ...(color !== undefined ? { color: color as ResourceColor } : {}),
    updatedAt,
  };
}

/**
 * 解析配置。返回 `undefined` 表示**这份文件不可用**（调用方必须按 fail-closed 处理）。
 *
 * v2 额外要求：`checksum` 复算一致、`projects[].projectId ∈ issuedIds`、序号自洽。
 * v3 在此基础上再把隐藏记录纳入校验和；v4 再把回收记录纳入；v5 再把元数据纳入。
 * 校验和一律按**文件声明的版本**复算——否则升级那一刻会把历史配置全判成损坏。
 */
export function parseConfig(text: string): ParsedConfig | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  if (
    raw.version !== 1 &&
    raw.version !== 2 &&
    raw.version !== 3 &&
    raw.version !== 4 &&
    raw.version !== 5
  ) {
    return undefined;
  }
  if (!Array.isArray(raw.projects)) return undefined;
  if (!Array.isArray(raw.revoked ?? [])) return undefined;

  // ---- v1：只读兼容（结构同静态配置，无 commitSeq / issuedIds / checksum） ----
  if (raw.version === 1) {
    const projects: ConfigProject[] = [];
    for (const item of raw.projects) {
      const project = parseProject(item);
      if (!project) return undefined;
      if (projects.some((existing) => existing.projectId === project.projectId)) return undefined;
      projects.push(project);
    }
    return {
      sourceVersion: 1,
      state: {
        version: 5,
        commitSeq: 0,
        issuedIds: projects.map((project) => project.projectId),
        revoked: [],
        projects,
        hidden: [],
        trash: [],
        metadata: [],
      },
    };
  }

  // ---- v2 / v3：全部字段必须自洽 ----
  if (!isSeq(raw.commitSeq)) return undefined;
  if (typeof raw.checksum !== 'string' || raw.checksum === '') return undefined;
  if (!Array.isArray(raw.issuedIds)) return undefined;

  const issuedIds: string[] = [];
  for (const id of raw.issuedIds) {
    if (typeof id !== 'string' || !PROJECT_ID_RE.test(id)) return undefined;
    if (issuedIds.includes(id)) return undefined;
    issuedIds.push(id);
  }

  const revoked: ConfigRevokedEntry[] = [];
  for (const item of (raw.revoked ?? []) as unknown[]) {
    const entry = parseRevoked(item);
    if (!entry) return undefined;
    if (entry.revokedAtSeq > raw.commitSeq) return undefined;
    if (revoked.some((existing) => existing.projectId === entry.projectId)) return undefined;
    revoked.push(entry);
  }

  const projects: ConfigProject[] = [];
  for (const item of raw.projects) {
    const project = parseProject(item);
    if (!project) return undefined;
    if (projects.some((existing) => existing.projectId === project.projectId)) return undefined;
    // 已签发集合必须覆盖现存条目，否则说明配置与身份账本不一致
    if (!issuedIds.includes(project.projectId)) return undefined;
    // 已撤销的条目不得仍在项目表里（否则等于"复活"）
    if (revoked.some((entry) => entry.projectId === project.projectId)) return undefined;
    projects.push(project);
  }
  // issuedIds 必须覆盖所有已撤销 id（撤销后仍永久保留）
  for (const entry of revoked) {
    if (!issuedIds.includes(entry.projectId)) return undefined;
  }

  // 隐藏记录从 v3 起存在；v2 文件里的同名字段一律忽略（不参与哈希、不参与判定）
  const hidden: ConfigHiddenEntry[] = [];
  if (raw.version === 3 || raw.version === 4 || raw.version === 5) {
    if (!Array.isArray(raw.hidden)) return undefined;
    if (raw.hidden.length > MAX_HIDDEN_ENTRIES) return undefined;
    for (const item of raw.hidden as unknown[]) {
      const entry = parseHidden(item);
      if (!entry) return undefined;
      // 同一项目里同一条路径只能有一条记录（Windows 下按大小写不敏感比较）
      const duplicate = hidden.some(
        (existing) => existing.projectId === entry.projectId && sameEntryPath(existing.path, entry.path),
      );
      if (duplicate) return undefined;
      hidden.push(entry);
    }
  }

  // 回收记录只在 v4 起存在；v2/v3 文件里的同名字段一律忽略（不参与哈希、不参与判定）
  const trash: ConfigTrashEntry[] = [];
  if (raw.version === 4 || raw.version === 5) {
    if (!Array.isArray(raw.trash)) return undefined;
    if (raw.trash.length > MAX_TRASH_RECORDS) return undefined;
    for (const item of raw.trash as unknown[]) {
      const entry = parseTrash(item);
      if (!entry) return undefined;
      // opId 是事务身份：不得重复（同一编号不能代表两次删除）
      if (trash.some((existing) => existing.opId === entry.opId)) return undefined;
      // 已签发过的项目才可能有回收记录（撤销后 id 仍永久保留，记录因此不会被判损坏）
      if (!issuedIds.includes(entry.projectId)) return undefined;
      trash.push(entry);
    }
  }

  // 元数据只在 v5 存在；v2–v4 文件里的同名字段一律忽略（不参与哈希、不参与判定）
  const metadata: ConfigMetadataEntry[] = [];
  if (raw.version === 5) {
    if (!Array.isArray(raw.metadata)) return undefined;
    if (raw.metadata.length > MAX_METADATA_ENTRIES) return undefined;
    for (const item of raw.metadata as unknown[]) {
      const entry = parseMetadata(item);
      if (!entry) return undefined;
      /*
       * 唯一性是**身份四元组**（项目 + 路径 + 根令牌 + 对象身份），不是"项目 + 路径"。
       *
       * 同一路径完全可能先后住过两个对象：旧对象被回收/替换，新对象拿到自己的记录，
       * 而旧记录要留着（用户可能还要恢复那个文件）。若仍按路径判重，这种配置会被判成
       * 损坏——那等于强迫 Host 在写入时销毁历史。
       *
       * 但"同一对象的两条记录"没有任何意义（同一个身份不可能同时有两个标注），
       * 出现即视为损坏：它会让"到底显示哪一条"变成未定义。
       */
      const duplicate = metadata.some(
        (existing) =>
          existing.projectId === entry.projectId &&
          sameEntryPath(existing.path, entry.path) &&
          existing.rootToken === entry.rootToken &&
          existing.identity === entry.identity,
      );
      if (duplicate) return undefined;
      // 已签发过的项目才可能有元数据（撤销后 id 仍永久保留，记录因此不会被判损坏）
      if (!issuedIds.includes(entry.projectId)) return undefined;
      metadata.push(entry);
    }
  }

  const state: ConfigState = {
    version: 5,
    commitSeq: raw.commitSeq,
    issuedIds,
    revoked,
    projects,
    hidden,
    trash,
    metadata,
  };
  // 校验和按**文件声明的版本**计算：v2 不含隐藏字段，v3 不含回收字段，v4 不含元数据
  const declared =
    raw.version === 5
      ? checksumOf(state)
      : raw.version === 4
        ? checksumOf({ ...state, version: 4, metadata: [] })
        : raw.version === 3
          ? checksumOf({ ...state, version: 3, trash: [], metadata: [] })
          : checksumOf({ ...state, version: 2, hidden: [], trash: [], metadata: [] });
  if (declared !== raw.checksum) return undefined;
  return { sourceVersion: raw.version, state };
}
