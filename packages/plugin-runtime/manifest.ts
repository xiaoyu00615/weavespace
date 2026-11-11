/**
 * 插件清单校验（P0 探针版）。
 * 与 contracts/schemas/plugin-manifest.schema.json 对齐；手写实现，不引入第三方 schema 库。
 * 已知分歧：schema 为 additionalProperties:false，与 docs/04「未知字段优先保留」存在张力（RSK-03，ADR 待定）。
 */
import type { PluginManifest } from '../contracts/types.ts';

export interface ManifestViolation {
  field: string;
  reason: string;
}

const ID_RE = /^[a-z][a-z0-9.-]{2,100}$/;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/;
const EXT_RE = /^\.[A-Za-z0-9_-]{1,16}$/;

/** P0 支持的 SDK API 版本（与文件格式版本无关，见 docs/03 第 6 条）。 */
export const SUPPORTED_API_VERSIONS = ['0.1'] as const;

export function validateManifest(manifest: unknown): ManifestViolation[] {
  const v: ManifestViolation[] = [];
  if (!manifest || typeof manifest !== 'object') {
    return [{ field: 'manifest', reason: '清单必须为对象' }];
  }
  const m = manifest as Partial<PluginManifest>;

  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) {
    v.push({ field: 'id', reason: '匹配 ^[a-z][a-z0-9.-]{2,100}$' });
  }
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) {
    v.push({ field: 'version', reason: '语义化版本 x.y.z' });
  }
  if (typeof m.apiVersion !== 'string' || m.apiVersion.length === 0) {
    v.push({ field: 'apiVersion', reason: '必填' });
  }
  if (!Array.isArray(m.fileExtensions) || m.fileExtensions.some((e) => typeof e !== 'string' || !EXT_RE.test(e))) {
    v.push({ field: 'fileExtensions', reason: '扩展名数组，形如 .md' });
  }
  if (!Array.isArray(m.provides) || m.provides.length === 0) {
    v.push({ field: 'provides', reason: '至少声明一项能力' });
  }
  if (!Array.isArray(m.requires)) {
    v.push({ field: 'requires', reason: '必须为数组（可为空）' });
  }
  if (!Array.isArray(m.requestedPermissions)) {
    v.push({ field: 'requestedPermissions', reason: '必须为数组（可为空）' });
  }
  if (!Array.isArray(m.activationEvents)) {
    v.push({ field: 'activationEvents', reason: '必须为数组（可为空）' });
  }
  if (!m.entrypoints || typeof m.entrypoints !== 'object' || Object.keys(m.entrypoints).length === 0) {
    v.push({ field: 'entrypoints', reason: '至少一个入口' });
  }
  return v;
}

export function isApiVersionSupported(apiVersion: string): boolean {
  return (SUPPORTED_API_VERSIONS as readonly string[]).includes(apiVersion);
}
