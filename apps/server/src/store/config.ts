/**
 * 工作区配置 v2 的解析、校验与序列化（UX-02B-02 / ADR-022 §3）。
 *
 * 纪律：
 * - **解析即校验**：任何字段形态不符都返回 `undefined`，由调用方按"配置不可用"处理；
 * - `checksum` 只证明这份配置**自身**没被截断，不能证明它是最新的（ADR-022 §3.2）；
 * - v1 只读兼容：内存里升级为 v2 视图，只有发生变更时才写回 v2；
 * - 序列化必须确定性（字段顺序固定），否则 checksum 无法复算。
 */
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

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

/** 内存形态：`checksum` 不参与（写盘时才算）。 */
export interface ConfigState {
  readonly version: 2;
  readonly commitSeq: number;
  readonly issuedIds: readonly string[];
  readonly revoked: readonly ConfigRevokedEntry[];
  readonly projects: readonly ConfigProject[];
}

export interface ParsedConfig {
  readonly state: ConfigState;
  /** 原始文件声明的版本（用于判断是否需要写回 v2）。 */
  readonly sourceVersion: 1 | 2;
}

export interface ConfigFile {
  readonly version: 2;
  readonly commitSeq: number;
  readonly issuedIds: readonly string[];
  readonly revoked: readonly ConfigRevokedEntry[];
  readonly projects: readonly ConfigProject[];
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

/**
 * checksum 的输入：**固定字段顺序**的 canonical JSON。
 * 绝不直接对原始文件文本取哈希——那样缩进/键序变化就会误判为损坏。
 */
export function checksumOf(state: ConfigState): string {
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
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function serializeConfig(state: ConfigState): string {
  const file: ConfigFile = { ...state, checksum: checksumOf(state) };
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

/**
 * 解析配置。返回 `undefined` 表示**这份文件不可用**（调用方必须按 fail-closed 处理）。
 *
 * v2 额外要求：`checksum` 复算一致、`projects[].projectId ∈ issuedIds`、序号自洽。
 */
export function parseConfig(text: string): ParsedConfig | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  if (raw.version !== 1 && raw.version !== 2) return undefined;
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
        version: 2,
        commitSeq: 0,
        issuedIds: projects.map((project) => project.projectId),
        revoked: [],
        projects,
      },
    };
  }

  // ---- v2：全部字段必须自洽 ----
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

  const state: ConfigState = {
    version: 2,
    commitSeq: raw.commitSeq,
    issuedIds,
    revoked,
    projects,
  };
  if (checksumOf(state) !== raw.checksum) return undefined;
  return { sourceVersion: 2, state };
}
