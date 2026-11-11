/**
 * Plugin Runtime（P0 探针版，自研极简实现；**不**代表对 Cordis 的选型结论，ADR-009 仍待探针）。
 *
 * 规则来源：docs/05。
 * - 声明能力 ≠ 获得授权：manifest 的 requestedPermissions 只做记录，不在此授予权限。
 * - 状态机 DISCOVERED → VALIDATED → REGISTERED → ACTIVATING → ACTIVE → DEACTIVATING → INACTIVE。
 * - 单个插件激活失败不得拖垮 Core；失败原因必须可由 Core 读取（OBS-002）。
 * - 插件卸载时若存在 dirty 文档必须被拒绝（docs/06 禁止事项）。
 * - 已知边界：同进程执行，**没有**强隔离；不得宣称沙箱能力（RSK-13）。
 */
import type { PluginManifest, PluginStatus } from '../contracts/types.ts';
import type { Logger } from '../observability/logger.ts';
import { startMonotonic, utcNow } from '../observability/trace.ts';
import { isApiVersionSupported, validateManifest, type ManifestViolation } from './manifest.ts';

export interface PluginModule {
  activate?: () => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
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

export interface PluginRuntimeOptions {
  logger?: Logger;
  clock?: () => Date;
  /** 判断某插件是否仍有未保存内容；由 document 侧注入，避免插件直接持有会话。 */
  hasDirtyState?: (pluginId: string) => boolean;
}

export interface PluginRuntime {
  register(manifest: PluginManifest, module?: PluginModule): RegisterResult;
  activate(pluginId: string): Promise<PluginRecord | undefined>;
  deactivate(pluginId: string, options?: { force?: boolean }): Promise<DeactivateResult>;
  status(pluginId: string): PluginRecord | undefined;
  list(): PluginRecord[];
  /** 扩展名 → 候选插件（一个扩展名可有多个处理器）。 */
  candidatesForExtension(ext: string): PluginRecord[];
}

export function createPluginRuntime(options: PluginRuntimeOptions = {}): PluginRuntime {
  const logger = options.logger;
  const clock = options.clock ?? (() => new Date());
  const records = new Map<string, PluginRecord>();
  const modules = new Map<string, PluginModule>();

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

  return {
    register(manifest: PluginManifest, module?: PluginModule): RegisterResult {
      const violations = validateManifest(manifest);
      if (violations.length > 0) {
        return { ok: false, errorCode: 'ERR_PLUGIN_INVALID_MANIFEST', violations };
      }
      if (records.has(manifest.id)) {
        return { ok: false, errorCode: 'ERR_PLUGIN_DUPLICATE_ID' };
      }
      if (!isApiVersionSupported(manifest.apiVersion)) {
        const record: PluginRecord = {
          pluginId: manifest.id,
          version: manifest.version,
          apiVersion: manifest.apiVersion,
          status: 'BLOCKED_DEPENDENCY',
          registeredAt: utcNow(clock),
          lastErrorCode: 'ERR_PLUGIN_INCOMPATIBLE',
          lastErrorAt: utcNow(clock),
          lastErrorMessage: `不支持的 apiVersion: ${manifest.apiVersion}`,
          fileExtensions: [],
          provides: [],
          requestedPermissions: [],
        };
        records.set(manifest.id, record);
        return { ok: false, record, errorCode: 'ERR_PLUGIN_INCOMPATIBLE' };
      }

      const record: PluginRecord = {
        pluginId: manifest.id,
        version: manifest.version,
        apiVersion: manifest.apiVersion,
        status: 'REGISTERED',
        registeredAt: utcNow(clock),
        fileExtensions: [...manifest.fileExtensions],
        provides: [...manifest.provides],
        requestedPermissions: [...manifest.requestedPermissions],
      };
      records.set(manifest.id, record);
      if (module) modules.set(manifest.id, module);
      log('PLUGIN_REGISTERED', record, { extensions: record.fileExtensions });
      return { ok: true, record };
    },

    async activate(pluginId: string) {
      const record = records.get(pluginId);
      if (!record) return undefined;
      if (record.status === 'ACTIVE') return record;

      record.status = 'ACTIVATING';
      const elapsed = startMonotonic();
      try {
        await modules.get(pluginId)?.activate?.();
        record.status = 'ACTIVE';
        record.activatedAt = utcNow(clock);
        record.activationDurationMs = elapsed();
        delete record.lastErrorCode;
        log('PLUGIN_ACTIVATED', record, { durationMs: record.activationDurationMs });
      } catch (err) {
        // 单插件故障：记录原因、隔离该插件，Core 与其他插件继续可用
        record.status = 'QUARANTINED';
        record.lastErrorCode = 'ERR_PLUGIN_CRASHED';
        record.lastErrorAt = utcNow(clock);
        record.lastErrorMessage = (err as Error).message;
        record.activationDurationMs = elapsed();
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
        record.lastErrorAt = utcNow(clock);
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
  };
}
