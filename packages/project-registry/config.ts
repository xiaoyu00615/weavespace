/**
 * 工作区配置（G1-01）：唯一可信的项目来源。
 *
 * 纪律：
 * - 只能由启动参数 `--workspace <config.json>` 读取一次，运行期不可变；
 * - 不提供任何 HTTP 增删改项目根的能力；
 * - 配置**合法**不等于项目**可用**（可用性由 registry 的运行期状态判定）；
 * - 任何可疑形态（相对路径、UNC、环境变量占位符、重复/嵌套根）都在加载期拒绝。
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ERROR_CODES, type ErrorCode } from '../contracts/errors.ts';

export interface ProjectConfigEntry {
  readonly projectId: string;
  readonly name: string;
  readonly rootDir: string;
}

export interface WorkspaceConfig {
  readonly version: 1;
  readonly projects: readonly ProjectConfigEntry[];
}

export type ProjectConfigErrorCode = ErrorCode;

export interface ProjectConfigError extends Error {
  readonly errorCode: ProjectConfigErrorCode;
}

const WIN = process.platform === 'win32';

/** `projectId` 会进入 providerId / resourceId，必须是受限字符集。 */
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function configError(errorCode: ProjectConfigErrorCode, message: string): ProjectConfigError {
  return Object.assign(new Error(message), { errorCode });
}

/** 环境变量展开一律拒绝：配置必须是"确定的本机绝对路径"，不能随环境漂移。 */
function looksLikeEnvPlaceholder(value: string): boolean {
  return /%[A-Za-z_][A-Za-z0-9_]*%/.test(value) || /\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/.test(value);
}

/** UNC / 设备路径（`\\server\share`、`\\?\C:\...`）；反斜杠与斜杠两种写法都拒绝。 */
export function isUncPath(value: string): boolean {
  const unified = value.replace(/\\/g, '/');
  return unified.startsWith('//');
}

function normalizeForCompare(path: string): string {
  const resolved = resolve(path);
  return WIN ? resolved.toLowerCase() : resolved;
}

/** a 是否等于或位于 b 之内（两侧都应已 resolve）。 */
function isSameOrInside(a: string, b: string): boolean {
  const rel = relative(b, a);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * 校验并规范化配置。**只做静态校验**，不触碰磁盘（可用性判定在 registry 初始化时进行）。
 *
 * 失败一律抛 `ProjectConfigError`；调用方不得带着半份配置启动 Host。
 */
export function validateWorkspaceConfig(raw: unknown): WorkspaceConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw configError(ERROR_CODES.ERR_PROJECT_CONFIG_INVALID, '工作区配置必须是 JSON 对象');
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) {
    throw configError(ERROR_CODES.ERR_PROJECT_CONFIG_INVALID, `不支持的工作区配置版本: ${String(record.version)}`);
  }
  const rawProjects = record.projects;
  if (!Array.isArray(rawProjects) || rawProjects.length === 0) {
    throw configError(ERROR_CODES.ERR_PROJECT_CONFIG_INVALID, '工作区配置必须包含至少一个项目');
  }

  const projects: ProjectConfigEntry[] = [];
  const seenIds = new Set<string>();

  for (const [index, item] of rawProjects.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw configError(ERROR_CODES.ERR_PROJECT_CONFIG_INVALID, `projects[${index}] 必须是对象`);
    }
    const entry = item as Record<string, unknown>;
    const projectId = entry.projectId;
    const name = entry.name;
    const rootDir = entry.rootDir;

    if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) {
      throw configError(
        ERROR_CODES.ERR_PROJECT_CONFIG_INVALID,
        `projects[${index}].projectId 非法（需匹配 ${PROJECT_ID_RE.source}）: ${String(projectId)}`,
      );
    }
    if (seenIds.has(projectId)) {
      throw configError(ERROR_CODES.ERR_PROJECT_CONFIG_INVALID, `projectId 重复: ${projectId}`);
    }
    seenIds.add(projectId);

    if (typeof name !== 'string' || name.trim() === '') {
      throw configError(ERROR_CODES.ERR_PROJECT_CONFIG_INVALID, `projects[${index}].name 不能为空`);
    }
    if (typeof rootDir !== 'string' || rootDir.trim() === '' || rootDir.includes('\0')) {
      throw configError(ERROR_CODES.ERR_PROJECT_CONFIG_INVALID, `projects[${index}].rootDir 非法`);
    }
    if (looksLikeEnvPlaceholder(rootDir)) {
      throw configError(ERROR_CODES.ERR_PROJECT_CONFIG_INVALID, `rootDir 不得包含环境变量占位符: ${rootDir}`);
    }
    if (!isAbsolute(rootDir)) {
      throw configError(ERROR_CODES.ERR_PROJECT_CONFIG_INVALID, `rootDir 必须是绝对路径: ${rootDir}`);
    }

    projects.push({ projectId, name: name.trim(), rootDir: resolve(rootDir) });
  }

  // 重复根 / 嵌套根：用规范化字面路径比较（大小写等价在 Windows 上折叠）
  for (let i = 0; i < projects.length; i += 1) {
    for (let j = i + 1; j < projects.length; j += 1) {
      const a = normalizeForCompare(projects[i].rootDir);
      const b = normalizeForCompare(projects[j].rootDir);
      if (a === b) {
        throw configError(
          ERROR_CODES.ERR_PROJECT_DUPLICATE_ROOT,
          `重复的项目根: ${projects[i].projectId} 与 ${projects[j].projectId} 指向同一目录`,
        );
      }
      if (isSameOrInside(a, b) || isSameOrInside(b, a)) {
        throw configError(
          ERROR_CODES.ERR_PROJECT_NESTED_ROOT,
          `项目根不得嵌套: ${projects[i].projectId} 与 ${projects[j].projectId}`,
        );
      }
    }
  }

  return { version: 1, projects };
}

/** 从文件读取并校验（仅启动时调用一次）。 */
export async function loadWorkspaceConfig(filePath: string): Promise<WorkspaceConfig> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    throw configError(
      ERROR_CODES.ERR_PROJECT_CONFIG_INVALID,
      `无法读取工作区配置 ${filePath}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw configError(ERROR_CODES.ERR_PROJECT_CONFIG_INVALID, '工作区配置不是合法 JSON');
  }
  return validateWorkspaceConfig(parsed);
}
