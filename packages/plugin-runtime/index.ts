/**
 * plugin-runtime 模块唯一公开入口。
 * 职责：清单校验、能力注册与解析、激活/停用、故障隔离与诊断状态。
 * 不直接访问存储；声明权限不在此授予。
 */
export {
  createPluginRuntime,
  DEFAULT_CORE_DEPENDENCIES,
  type CapabilityResolution,
  type DeactivateResult,
  type PluginModule,
  type PluginRecord,
  type PluginRuntime,
  type PluginRuntimeOptions,
  type RegisterResult,
  type ResolveCapabilityOptions,
} from './plugin-runtime.ts';
export {
  CAPABILITY_API_MAJOR,
  capabilityName,
  isCapabilityCompatible,
  parseCapabilityRef,
  type CapabilityRef,
} from './capabilities.ts';
export {
  isApiVersionSupported,
  SUPPORTED_API_VERSIONS,
  validateManifest,
  type ManifestViolation,
} from './manifest.ts';
