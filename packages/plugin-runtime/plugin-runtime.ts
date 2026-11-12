/**
 * Plugin Runtime（P0 探针版，自研极简实现；**不**代表对 Cordis 的选型结论，ADR-009 仍待探针）。
 *
 * 规则来源：docs/05。
 * - 声明能力 ≠ 获得授权：manifest 的 requestedPermissions 只做记录，不在此授予权限。
 * - 状态机 DISCOVERED → VALIDATED → REGISTERED → ACTIVATING → ACTIVE → DEACTIVATING → INACTIVE。
 * - 单个插件激活失败不得拖垮 Core；失败原因必须可由 Core 读取（OBS-002）。
 * - 插件卸载时若存在 dirty 文档必须被拒绝（docs/06 禁止事项）。
 * - 已知边界：同进程执行，**没有**强隔离；不得宣称沙箱能力（RSK-13）。
 *
 * S10-A：增加**能力维度**（`provides` 声明 → 运行期解析），宿主按能力名取实现，
 * 而不是按具体插件模块取实现；依赖缺失时明确失败，不做「假启动」。
 * 本文件不 import Node 内建模块（时间/计时在本地实现），使 Shell 侧可共用同一注册表。
 */
import type { PluginManifest, PluginStatus } from '../contracts/types.ts';
import type { Logger } from '../observability/logger.ts';
import { capabilityName, isCapabilityCompatible, parseCapabilityRef } from './capabilities.ts';
import { isApiVersionSupported, validateManifest, type ManifestViolation } from './manifest.ts';

export interface PluginModule {
  activate?: () => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
  /**
   * 能力实现：能力名（不含版本后缀）→ 实现对象。
   * 只有被 `manifest.provides` 声明的能力才会被解析出来；未声明的实现被忽略。
   */
  capabilities?: Record<string, unknown>;
}

export interface PluginRecord {
  pluginId: string;
  version: string;
  apiVersion: string;
  status: PluginStatus;
  registeredAt: string;
  activatedAt?: string;
  lastErrorCode?: string;
  lastErrorAt?: string;
  lastErrorMessage?: string;
  activationDurationMs?: number;
  fileExtensions: string[];
  provides: string[];
  requestedPermissions: string[];
  /** 已登记的能力名（去版本后缀、去重）。 */
  capabilities: string[];
}

export interface RegisterResult {
  ok: boolean;
  record?: PluginRecord;
  errorCode?: string;
  violations?: ManifestViolation[];
}

export interface DeactivateResult {
  ok: boolean;
  status?: PluginStatus;
  errorCode?: string;
  reason?: string;
}

/** 能力解析结果：`ok` 时带提供者记录与实现对象。 */
export type CapabilityResolution<T = unknown> =
  | { ok: true; capability: string; provider: PluginRecord; value: T }
  | { ok: false; capability: string; errorCode: string; reason: string };

export interface ResolveCapabilityOptions {
  /** 只接受声明了该扩展名的提供者（查看器按文件类型选择时使用）。 */
  extension?: string;
  /** 首选插件；它不可用或未实现该能力时按注册顺序回退。 */
  preferPluginId?: string;
}

export interface PluginRuntimeOptions {
  logger?: Logger;
  clock?: () => Date;
  /** 判断某插件是否仍有未保存内容；由 document 侧注入，避免插件直接持有会话。 */
  hasDirtyState?: (pluginId: string) => boolean;
  /**
   * 由 Core 保证可用的模块标识（默认见 `DEFAULT_CORE_DEPENDENCIES`）。
   * 插件 `requires` 命中这些标识时无需另有插件提供；其余依赖必须**已注册且已激活**。
   */
  coreCapabilities?: readonly string[];
}

/** 可信层自身提供的模块标识：权限与存储由 Core 强制，不能靠插件自证。 */
export const DEFAULT_CORE_DEPENDENCIES: readonly string[] = Object.freeze([
  'weavespace.document',
  'weavespace.storage',
  'weavespace.permission',
  'weavespace.command',
]);

export interface PluginRuntime {
  register(manifest: PluginManifest, module?: PluginModule): RegisterResult;
  activate(pluginId: string): Promise<PluginRecord | undefined>;
  deactivate(pluginId: string, options?: { force?: boolean }): Promise<DeactivateResult>;
  status(pluginId: string): PluginRecord | undefined;
  list(): PluginRecord[];
  /** 扩展名 → 候选插件（一个扩展名可有多个处理器）。 */
  candidatesForExtension(ext: string): PluginRecord[];
  /** 某个能力的全部**已激活**提供者（按注册顺序）。 */
  providersOf(capability: string): PluginRecord[];
  /** 注册表中出现过的能力名与提供者数量（含未激活，便于诊断）。 */
  capabilities(): { capability: string; providers: number; active: number }[];
  /** 按能力名（+ 可选扩展名）解析实现；缺失时返回可识别错误，不抛。 */
  resolveCapability<T = unknown>(
    capability: string,
    options?: ResolveCapabilityOptions,
  ): CapabilityResolution<T>;
  /** 同上，但缺失时抛错——依赖方据此**拒绝启动**而不是假装成功。 */
  requireCapability<T = unknown>(
    capability: string,
    options?: ResolveCapabilityOptions,
  ): Extract<CapabilityResolution<T>, { ok: true }>;
}

function nowIso(clock: () => Date): string {
  return clock().toISOString();
}

/** 单调计时（不依赖 observability，避免把 Node 内建模块带进浏览器）。 */
function elapsedSince(startedAt: number): number {
  return Math.round((Date.now() - startedAt) * 1000) / 1000;
}

export function createPluginRuntime(options: PluginRuntimeOptions = {}): PluginRuntime {
  const logger = options.logger;
  const clock = options.clock ?? (() => new Date());
  const coreCapabilities = new Set(options.coreCapabilities ?? DEFAULT_CORE_DEPENDENCIES);
  const records = new Map<string, PluginRecord>();
  const modules = new Map<string, PluginModule>();
  /** 注册时保留清单，供依赖校验使用（record 只保留诊断所需字段）。 */
  const manifests = new Map<string, PluginManifest>();
  /** 能力名 → pluginId（按注册顺序）。 */
  const capabilityProviders = new Map<string, string[]>();

  function log(event: string, record: Partial<PluginRecord>, extra: Record<string, unknown> = {}) {
    logger?.log({
      event,
      level: 'INFO',
      pluginId: record.pluginId,
      pluginVersion: record.version,
      status: record.status,
      ...extra,
    });
  }

  function indexCapabilities(pluginId: string, provides: readonly string[]): string[] {
    const names: string[] = [];
    for (const raw of provides) {
      const name = capabilityName(raw);
      if (names.includes(name)) continue; // 同一插件重复声明同一能力：只记一次
      names.push(name);
      const list = capabilityProviders.get(name) ?? [];
      if (!list.includes(pluginId)) list.push(pluginId);
      capabilityProviders.set(name, list);
    }
    return names;
  }

  /** 依赖是否满足：Core 侧可信模块，或**已注册且已激活**的插件。 */
  function missingDependencies(manifest: PluginManifest): string[] {
    return manifest.requires.filter((dep) => {
      if (coreCapabilities.has(dep)) return false;
      return records.get(dep)?.status !== 'ACTIVE';
    });
  }

  function providersOf(capability: string): PluginRecord[] {
    const name = capabilityName(capability);
    return (capabilityProviders.get(name) ?? [])
      .map((id) => records.get(id))
      .filter((record): record is PluginRecord => record !== undefined && record.status === 'ACTIVE');
  }

  function resolveCapability<T>(
    capability: string,
    resolveOptions: ResolveCapabilityOptions = {},
  ): CapabilityResolution<T> {
    const name = capabilityName(capability);
    const ext = resolveOptions.extension?.toLowerCase();
    const active = providersOf(name);
    const eligible = ext ? active.filter((r) => r.fileExtensions.includes(ext)) : active;

    const prefer = resolveOptions.preferPluginId;
    const ordered = prefer
      ? [...eligible].sort((a, b) => {
          if (a.pluginId === prefer) return -1;
          if (b.pluginId === prefer) return 1;
          return 0;
        })
      : eligible;

    for (const provider of ordered) {
      const impl = modules.get(provider.pluginId)?.capabilities?.[name];
      if (impl !== undefined) {
        return { ok: true, capability: name, provider, value: impl as T };
      }
    }

    const declared = [...records.values()].some((r) =>
      r.provides.some((p) => capabilityName(p) === name),
    );
    return {
      ok: false,
      capability: name,
      errorCode: 'ERR_CAPABILITY_MISSING',
      reason: declared
        ? `能力 ${name} 的提供者均未激活${ext ? `（扩展名 ${ext}）` : ''}`
        : `没有插件声明能力 ${name}`,
    };
  }

  return {
    register(manifest: PluginManifest, module?: PluginModule): RegisterResult {
      const violations = validateManifest(manifest);
      if (violations.length > 0) {
        return { ok: false, errorCode: 'ERR_PLUGIN_INVALID_MANIFEST', violations };
      }
      if (records.has(manifest.id)) {
        return { ok: false, errorCode: 'ERR_PLUGIN_DUPLICATE_ID' };
      }

      // 能力契约版本：声明了不可识别/不兼容主版本就拒绝注册，不静默降级（S10-A）
      for (const raw of manifest.provides) {
        const ref = parseCapabilityRef(raw);
        if (!ref || !isCapabilityCompatible(ref)) {
          const record: PluginRecord = {
            pluginId: manifest.id,
            version: manifest.version,
            apiVersion: manifest.apiVersion,
            status: 'BLOCKED_DEPENDENCY',
            registeredAt: nowIso(clock),
            lastErrorCode: 'ERR_CAPABILITY_INCOMPATIBLE',
            lastErrorAt: nowIso(clock),
            lastErrorMessage: `能力声明不可识别或版本不兼容: ${String(raw)}`,
            fileExtensions: [],
            provides: [],
            requestedPermissions: [],
            capabilities: [],
          };
          records.set(manifest.id, record);
          return { ok: false, record, errorCode: 'ERR_CAPABILITY_INCOMPATIBLE' };
        }
      }

      if (!isApiVersionSupported(manifest.apiVersion)) {
        const record: PluginRecord = {
          pluginId: manifest.id,
          version: manifest.version,
          apiVersion: manifest.apiVersion,
          status: 'BLOCKED_DEPENDENCY',
          registeredAt: nowIso(clock),
          lastErrorCode: 'ERR_PLUGIN_INCOMPATIBLE',
          lastErrorAt: nowIso(clock),
          lastErrorMessage: `不支持的 apiVersion: ${manifest.apiVersion}`,
          fileExtensions: [],
          provides: [],
          requestedPermissions: [],
          capabilities: [],
        };
        records.set(manifest.id, record);
        return { ok: false, record, errorCode: 'ERR_PLUGIN_INCOMPATIBLE' };
      }

      const record: PluginRecord = {
        pluginId: manifest.id,
        version: manifest.version,
        apiVersion: manifest.apiVersion,
        status: 'REGISTERED',
        registeredAt: nowIso(clock),
        fileExtensions: [...manifest.fileExtensions],
        provides: [...manifest.provides],
        requestedPermissions: [...manifest.requestedPermissions],
        capabilities: indexCapabilities(manifest.id, manifest.provides),
      };
      records.set(manifest.id, record);
      manifests.set(manifest.id, manifest);
      if (module) modules.set(manifest.id, module);
      log('PLUGIN_REGISTERED', record, {
        extensions: record.fileExtensions,
        capabilities: record.capabilities,
      });
      return { ok: true, record };
    },

    async activate(pluginId: string) {
      const record = records.get(pluginId);
      if (!record) return undefined;
      if (record.status === 'ACTIVE') return record;

      // 依赖缺失 → 明确失败，且**不调用** activate（避免「假启动」）
      const manifest = manifests.get(pluginId);
      const missing = manifest ? missingDependencies(manifest) : [];
      if (missing.length > 0) {
        record.status = 'BLOCKED_DEPENDENCY';
        record.lastErrorCode = 'ERR_PLUGIN_DEPENDENCY_MISSING';
        record.lastErrorAt = nowIso(clock);
        record.lastErrorMessage = `缺少依赖: ${missing.join(', ')}`;
        log('PLUGIN_BLOCKED', record, {
          errorCode: 'ERR_PLUGIN_DEPENDENCY_MISSING',
          missing,
        });
        return record;
      }

      record.status = 'ACTIVATING';
      const startedAt = Date.now();
      try {
        await modules.get(pluginId)?.activate?.();
        record.status = 'ACTIVE';
        record.activatedAt = nowIso(clock);
        record.activationDurationMs = elapsedSince(startedAt);
        delete record.lastErrorCode;
        log('PLUGIN_ACTIVATED', record, { durationMs: record.activationDurationMs });
      } catch (err) {
        // 单插件故障：记录原因、隔离该插件，Core 与其他插件继续可用
        record.status = 'QUARANTINED';
        record.lastErrorCode = 'ERR_PLUGIN_CRASHED';
        record.lastErrorAt = nowIso(clock);
        record.lastErrorMessage = (err as Error).message;
        record.activationDurationMs = elapsedSince(startedAt);
        log('PLUGIN_FAILED', record, {
          durationMs: record.activationDurationMs,
          errorCode: 'ERR_PLUGIN_CRASHED',
          message: record.lastErrorMessage,
        });
      }
      return record;
    },

    async deactivate(pluginId: string, opts: { force?: boolean } = {}) {
      const record = records.get(pluginId);
      if (!record) return { ok: false, errorCode: 'ERR_PLUGIN_NOT_REGISTERED' };
      if (record.status !== 'ACTIVE' && record.status !== 'QUARANTINED') {
        return { ok: false, status: record.status, reason: '插件未处于活动状态' };
      }
      if (!opts.force && options.hasDirtyState?.(pluginId)) {
        log('PLUGIN_DEACTIVATE_BLOCKED', record, { errorCode: 'ERR_PLUGIN_DEACTIVATE_BLOCKED' });
        return {
          ok: false,
          status: record.status,
          errorCode: 'ERR_PLUGIN_DEACTIVATE_BLOCKED',
          reason: '插件仍有未保存内容，拒绝卸载（docs/06）',
        };
      }
      record.status = 'DEACTIVATING';
      try {
        await modules.get(pluginId)?.deactivate?.();
        record.status = 'INACTIVE';
        log('PLUGIN_DEACTIVATED', record);
      } catch (err) {
        record.status = 'FAILED';
        record.lastErrorCode = 'ERR_PLUGIN_CRASHED';
        record.lastErrorAt = nowIso(clock);
        record.lastErrorMessage = (err as Error).message;
        log('PLUGIN_DEACTIVATE_FAILED', record, { errorCode: 'ERR_PLUGIN_CRASHED' });
      }
      return { ok: record.status === 'INACTIVE', status: record.status };
    },

    status(pluginId: string) {
      return records.get(pluginId);
    },

    list() {
      return [...records.values()];
    },

    candidatesForExtension(ext: string) {
      return [...records.values()].filter(
        (r) => r.status === 'ACTIVE' && r.fileExtensions.includes(ext),
      );
    },

    providersOf,

    capabilities() {
      return [...capabilityProviders.entries()].map(([capability, ids]) => ({
        capability,
        providers: ids.length,
        active: ids.filter((id) => records.get(id)?.status === 'ACTIVE').length,
      }));
    },

    resolveCapability,

    requireCapability<T = unknown>(
      capability: string,
      resolveOptions: ResolveCapabilityOptions = {},
    ): Extract<CapabilityResolution<T>, { ok: true }> {
      const resolved = resolveCapability<T>(capability, resolveOptions);
      if (!resolved.ok) {
        throw Object.assign(new Error(resolved.reason), {
          errorCode: resolved.errorCode,
          capability: resolved.capability,
        });
      }
      return resolved;
    },
  };
}
