/**
 * 工作区配置 v3 的解析、校验与序列化（UX-02B-02 / ADR-022 §3；v3 由 UX-02C-03-P1 引入）。
 *
 * 纪律：
 * - **解析即校验**：任何字段形态不符都返回 `undefined`，由调用方按"配置不可用"处理；
 * - `checksum` 只证明这份配置**自身**没被截断，不能证明它是最新的（ADR-022 §3.2）；
 * - v1 / v2 只读兼容：内存里升级为 v3 视图，只有发生变更时才写回 v3；
 * - 序列化必须确定性（字段顺序固定），否则 checksum 无法复算；
 * - **校验和按"文件声明的版本"计算**：v2 文件里没有 `hidden` 字段参与哈希，
 *   否则升级的那一刻会把所有历史配置文件判成损坏（灾难级回归）。
 */
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { validateEntryPath } from '../../../../packages/storage/entry-name.ts';
import { sameEntryPath } from '../../../../packages/storage/entry-name.ts';

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
  readonly version: 4;
  readonly commitSeq: number;
  readonly issuedIds: readonly string[];
  readonly revoked: readonly ConfigRevokedEntry[];
  readonly projects: readonly ConfigProject[];
  readonly hidden: readonly ConfigHiddenEntry[];
  readonly trash: readonly ConfigTrashEntry[];
}

/**
 * 允许序列化的输入形态。
 *
 * 保留 `version: 2` / `3` 是为了既有夹具与"只读兼容"路径：低版本输入序列化成
 * 同版本文件（校验和也按声明版本计算），不会被悄悄升版。
 */
export interface ConfigStateInput {
  readonly version: 2 | 3 | 4;
  readonly commitSeq: number;
  readonly issuedIds: readonly string[];
  readonly revoked: readonly ConfigRevokedEntry[];
  readonly projects: readonly ConfigProject[];
  readonly hidden?: readonly ConfigHiddenEntry[];
  /** 只在 v4 参与序列化与哈希；低版本输入即使带着也会被忽略。 */
  readonly trash?: readonly ConfigTrashEntry[];
}

export interface ParsedConfig {
  readonly state: ConfigState;
  /** 原始文件声明的版本（用于判断是否需要写回）。 */
  readonly sourceVersion: 1 | 2 | 3 | 4;
}

export interface ConfigFile {
  readonly version: 4;
  readonly commitSeq: number;
  readonly issuedIds: readonly string[];
  readonly revoked: readonly ConfigRevokedEntry[];
  readonly projects: readonly ConfigProject[];
  readonly hidden: readonly ConfigHiddenEntry[];
  readonly trash: readonly ConfigTrashEntry[];
  readonly checksum: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
 * checksum 的输入：**固定字段顺序**的 canonical JSON。
 * 绝不直接对原始文件文本取哈希——那样缩进/键序变化就会误判为损坏。
 *
 * `hidden` 只在 v3 起参与哈希：v2 文件的校验和必须继续可复算。
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
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function serializeConfig(state: ConfigStateInput): string {
  const file = {
    ...state,
    hidden: state.hidden ?? [],
    ...(state.version >= 4 ? { trash: state.trash ?? [] } : {}),
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
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) return undefined;
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
 * 解析配置。返回 `undefined` 表示**这份文件不可用**（调用方必须按 fail-closed 处理）。
 *
 * v2 额外要求：`checksum` 复算一致、`projects[].projectId ∈ issuedIds`、序号自洽。
 * v3 在此基础上再把隐藏记录纳入校验和；v4 再把回收记录纳入。
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
  if (raw.version !== 1 && raw.version !== 2 && raw.version !== 3 && raw.version !== 4) return undefined;
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
        version: 4,
        commitSeq: 0,
        issuedIds: projects.map((project) => project.projectId),
        revoked: [],
        projects,
        hidden: [],
        trash: [],
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
  if (raw.version === 3 || raw.version === 4) {
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

  // 回收记录只在 v4 存在；v2/v3 文件里的同名字段一律忽略（不参与哈希、不参与判定）
  const trash: ConfigTrashEntry[] = [];
  if (raw.version === 4) {
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

  const state: ConfigState = {
    version: 4,
    commitSeq: raw.commitSeq,
    issuedIds,
    revoked,
    projects,
    hidden,
    trash,
  };
  // 校验和按**文件声明的版本**计算：v2 不含隐藏字段，v3 不含回收字段
  const declared =
    raw.version === 4
      ? checksumOf(state)
      : raw.version === 3
        ? checksumOf({ ...state, version: 3, trash: [] })
        : checksumOf({ ...state, version: 2, hidden: [], trash: [] });
  if (declared !== raw.checksum) return undefined;
  return { sourceVersion: raw.version, state };
}
