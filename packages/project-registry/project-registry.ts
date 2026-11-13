/**
 * Project Registry（G1-02）：Project 身份的唯一权威来源。
 *
 * 设计约束：
 * - 只在构造时读取配置并探测根；运行期不 refresh / rebind / adopt / add / remove；
 * - READY 的项目才有 Provider；UNAVAILABLE 的项目**没有** Provider，
 *   因此不存在"Multi 模式自动创建缺失根"的路径；
 * - `assertUsable` 每次访问都重新确认根身份（路径规范 + 存在 + 可访问 + 令牌），
 *   发现变化即把该项目永久置为 UNAVAILABLE（不做无证据的自动恢复）；
 * - 对外 `ProjectSummary` 绝不包含 rootDir / canonicalRoot / rootToken / Provider。
 */
import type { StorageProvider } from '../storage/local-provider.ts';
import { ERROR_CODES } from '../contracts/errors.ts';
import { createLocalProvider } from '../storage/local-provider.ts';
import type { WorkspaceConfig } from './config.ts';
import {
  inspectProjectRoot,
  type ProjectStatus,
  type ProjectUnavailableReason,
} from './root-status.ts';

export type { ProjectStatus, ProjectUnavailableReason } from './root-status.ts';

/** 对外可序列化摘要：不含任何本机绝对路径或 Provider。 */
export interface ProjectSummary {
  readonly projectId: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly reason?: ProjectUnavailableReason;
}

/** Host 内部句柄：允许持有根路径、令牌与 Provider。 */
export interface ProjectHandle {
  readonly projectId: string;
  readonly providerId: string;
  readonly rootDir: string;
  readonly canonicalRoot: string;
  readonly rootToken: string;
  readonly provider: StorageProvider;
}

export interface ProjectRegistry {
  list(): readonly ProjectSummary[];
  get(projectId: string): ProjectHandle | undefined;
  providerOf(projectId: string): StorageProvider | undefined;
  assertUsable(projectId: string): ProjectHandle;
  version(): number;
}

export interface ProjectRegistryOptions {
  config: WorkspaceConfig;
  /** 仅测试注入：替换 Provider 构造（默认 createLocalProvider）。 */
  providerFactory?: (input: { projectId: string; providerId: string; rootDir: string }) => StorageProvider;
}

interface Entry {
  readonly projectId: string;
  readonly name: string;
  readonly rootDir: string;
  status: ProjectStatus;
  reason?: ProjectUnavailableReason;
  handle?: ProjectHandle;
}

function unavailableError(projectId: string, reason: ProjectUnavailableReason | undefined): Error {
  return Object.assign(
    new Error(`项目不可用: ${projectId}${reason ? `（${reason}）` : ''}`),
    { errorCode: ERROR_CODES.ERR_PROJECT_UNAVAILABLE, reason },
  );
}

export function createProjectRegistry(options: ProjectRegistryOptions): ProjectRegistry {
  const factory =
    options.providerFactory ??
    ((input: { providerId: string; rootDir: string }) =>
      createLocalProvider({ rootDir: input.rootDir, providerId: input.providerId }));

  const entries = new Map<string, Entry>();

  for (const project of options.config.projects) {
    const providerId = `local:${project.projectId}`;
    const inspection = inspectProjectRoot(project.rootDir);

    if (inspection.status !== 'READY') {
      entries.set(project.projectId, {
        projectId: project.projectId,
        name: project.name,
        rootDir: project.rootDir,
        status: 'UNAVAILABLE',
        reason: inspection.reason,
      });
      continue;
    }

    let provider: StorageProvider;
    try {
      provider = factory({ projectId: project.projectId, providerId, rootDir: project.rootDir });
    } catch {
      // Provider 构造失败（权限/身份不可确认）→ 该项目不可用，不得让整个 Host 半初始化
      entries.set(project.projectId, {
        projectId: project.projectId,
        name: project.name,
        rootDir: project.rootDir,
        status: 'UNAVAILABLE',
        reason: 'IO_ERROR',
      });
      continue;
    }

    entries.set(project.projectId, {
      projectId: project.projectId,
      name: project.name,
      rootDir: project.rootDir,
      status: 'READY',
      handle: {
        projectId: project.projectId,
        providerId,
        rootDir: project.rootDir,
        canonicalRoot: inspection.canonicalRoot,
        rootToken: inspection.rootToken,
        provider,
      },
    });
  }

  /**
   * 重新确认某个已 READY 条目的根身份；失效则就地降级。
   * `list()` 与 `assertUsable()` 复用同一判定，避免出现"第二套项目状态"。
   */
  function refreshEntry(entry: Entry): void {
    if (entry.status !== 'READY' || !entry.handle) return;
    const inspection = inspectProjectRoot(entry.rootDir);
    if (inspection.status !== 'READY') {
      entry.status = 'UNAVAILABLE';
      entry.reason = inspection.reason;
      entry.handle = undefined;
      return;
    }
    if (inspection.canonicalRoot !== entry.handle.canonicalRoot) {
      entry.status = 'UNAVAILABLE';
      entry.reason = 'CANONICAL_CHANGED';
      entry.handle = undefined;
      return;
    }
    if (inspection.rootToken !== entry.handle.rootToken) {
      entry.status = 'UNAVAILABLE';
      entry.reason = 'ROOT_TOKEN_CHANGED';
      entry.handle = undefined;
    }
  }

  const list = (): readonly ProjectSummary[] => {
    for (const entry of entries.values()) refreshEntry(entry);
    return Object.freeze(
      [...entries.values()].map((entry) =>
        Object.freeze({
          projectId: entry.projectId,
          name: entry.name,
          status: entry.status,
          ...(entry.reason ? { reason: entry.reason } : {}),
        }),
      ),
    );
  };

  /**
   * 访问门禁：每次都重新确认根身份。一旦发现变化，就把项目永久置为 UNAVAILABLE
   * （Provider 也随之不可再获取），不做自动恢复。
   */
  function assertUsable(projectId: string): ProjectHandle {
    const entry = entries.get(projectId);
    if (!entry) {
      throw Object.assign(new Error(`未注册的项目: ${projectId}`), {
        errorCode: ERROR_CODES.ERR_PROJECT_NOT_FOUND,
      });
    }
    if (entry.status !== 'READY' || !entry.handle) {
      throw unavailableError(projectId, entry.reason);
    }

    refreshEntry(entry);
    if (entry.status !== 'READY' || !entry.handle) {
      throw unavailableError(projectId, entry.reason);
    }
    return entry.handle;
  }

  return {
    list,
    get(projectId) {
      const entry = entries.get(projectId);
      return entry?.status === 'READY' ? entry.handle : undefined;
    },
    providerOf(projectId) {
      const entry = entries.get(projectId);
      return entry?.status === 'READY' ? entry.handle?.provider : undefined;
    },
    assertUsable,
    /** A1 不支持运行期变更，版本恒为 1。 */
    version: () => 1,
  };
}
