/**
 * project-registry 模块唯一公开入口（G1）。
 * 职责：可信工作区配置校验 + 项目根可用性判定 + Project 身份注册表。
 * 不负责会话、命令、权限或 HTTP；不提供运行期增删改。
 */
export {
  isUncPath,
  loadWorkspaceConfig,
  validateWorkspaceConfig,
  type ProjectConfigEntry,
  type ProjectConfigError,
  type ProjectConfigErrorCode,
  type WorkspaceConfig,
} from './config.ts';
export {
  inspectProjectRoot,
  type ProjectStatus,
  type ProjectUnavailableReason,
  type ReadyRoot,
  type RootInspection,
  type UnavailableRoot,
} from './root-status.ts';
export {
  createProjectRegistry,
  type ProjectHandle,
  type ProjectRegistry,
  type ProjectRegistryOptions,
  type ProjectSummary,
} from './project-registry.ts';
