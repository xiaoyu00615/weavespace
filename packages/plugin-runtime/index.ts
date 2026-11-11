/**
 * plugin-runtime 模块唯一公开入口。
 * 职责：清单校验、注册、激活/停用、故障隔离与诊断状态。
 * 不直接访问存储；声明权限不在此授予。
 */
export {
  createPluginRuntime,
  type DeactivateResult,
  type PluginModule,
  type PluginRecord,
  type PluginRuntime,
  type PluginRuntimeOptions,
  type RegisterResult,
} from './plugin-runtime.ts';
export {
  isApiVersionSupported,
  SUPPORTED_API_VERSIONS,
  validateManifest,
  type ManifestViolation,
} from './manifest.ts';
