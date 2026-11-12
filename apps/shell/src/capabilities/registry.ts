/**
 * Shell 能力注册表（S10-A）——**组合根**。
 *
 * 这是 Shell 唯一 import 具体插件模块的地方：把插件（manifest + 模块）交给
 * `packages/plugin-runtime` 的注册表，之后所有组件只按**能力名**取实现
 * （`file.viewer`），不 import 任何插件的解析/渲染代码。
 *
 * 边界：
 * - 权限、存储、条件保存仍由 Core 的 CommandBus / PermissionService 强制，插件拿不到这些入口；
 * - 停用某个插件只影响「用什么渲染」，不影响文件树、会话、草稿与保存链路；
 * - 注册顺序即优先级：Markdown 先注册，通用文本作为回退。
 */
import {
  createPluginRuntime,
  type PluginModule,
  type PluginRuntime,
} from '../../../../packages/plugin-runtime/index.ts';
import type { PluginManifest, PluginStatus, ViewerCapability } from '../../../../packages/contracts/types.ts';
import markdownManifest from '../../../../plugins/markdown/manifest.json';
import plaintextManifest from '../../../../plugins/plaintext/manifest.json';
import { createMarkdownClientModule } from '../../../../plugins/markdown/client.tsx';
import { createPlaintextClientModule } from '../../../../plugins/plaintext/client.tsx';

export interface ShellPluginInfo {
  pluginId: string;
  version: string;
  status: PluginStatus;
  capabilities: string[];
  fileExtensions: string[];
  errorCode?: string;
  errorMessage?: string;
}

export type ViewerResolution =
  | { ok: true; providerId: string; viewer: ViewerCapability }
  | { ok: false; errorCode: string; reason: string };

export interface ShellCapabilityRegistry {
  readonly runtime: PluginRuntime;
  /** 初始激活完成的信号；宿主在 ready 之前不应假设查看器可用。 */
  readonly ready: Promise<void>;
  list(): ShellPluginInfo[];
  isActive(pluginId: string): boolean;
  /** 启用/停用某个插件（停用只影响它提供的能力）。 */
  setEnabled(pluginId: string, enabled: boolean): Promise<{ ok: boolean; errorCode?: string; reason?: string }>;
  /** 按扩展名解析查看器；没有可用实现时返回可识别错误，不抛。 */
  resolveViewer(extension: string): ViewerResolution;
  /** 注入「某插件是否还有未保存内容」，用于阻止会丢草稿的停用。 */
  setDirtyChecker(check: (pluginId: string) => boolean): void;
}

/** 小写扩展名（含点）；没有扩展名时返回空串。 */
export function extensionOf(pathOrName: string): string {
  const base = pathOrName.replace(/\\/g, '/').split('/').pop() ?? pathOrName;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

const VIEWER_CAPABILITY = 'file.viewer';

interface RegistryPlugin {
  manifest: PluginManifest;
  module: PluginModule;
  activate: boolean;
}

const BUILTIN_PLUGINS: readonly RegistryPlugin[] = [
  { manifest: markdownManifest as PluginManifest, module: createMarkdownClientModule(), activate: true },
  { manifest: plaintextManifest as PluginManifest, module: createPlaintextClientModule(), activate: true },
];

export interface ShellCapabilityRegistryOptions {
  /** 追加插件（测试用替代实现）；排在内置插件之后，只在回退时生效。 */
  extraPlugins?: readonly { manifest: PluginManifest; module: PluginModule; activate?: boolean }[];
  /** 初始就停用的插件 id（用于验证回退路径）。 */
  disabled?: readonly string[];
}

export function createShellCapabilityRegistry(
  options: ShellCapabilityRegistryOptions = {},
): ShellCapabilityRegistry {
  let dirtyChecker: (pluginId: string) => boolean = () => false;

  const runtime = createPluginRuntime({
    hasDirtyState: (pluginId) => dirtyChecker(pluginId),
  });

  const plugins: RegistryPlugin[] = [
    ...BUILTIN_PLUGINS,
    ...(options.extraPlugins ?? []).map((p) => ({ ...p, activate: p.activate ?? true })),
  ];

  const disabled = new Set(options.disabled ?? []);
  const pending: Promise<unknown>[] = [];

  for (const plugin of plugins) {
    const registered = runtime.register(plugin.manifest, plugin.module);
    if (!registered.ok && registered.errorCode) {
      // 注册失败不阻断宿主：记录在 record 上（status=BLOCKED_DEPENDENCY），
      // 宿主按能力解析时会得到 ERR_CAPABILITY_MISSING，而不是崩溃。
      continue;
    }
    if (plugin.activate && !disabled.has(plugin.manifest.id)) {
      // 激活本身是异步的；注册表必须能同步构造（组件首次渲染就要拿到），
      // 因此把激活收集到 `ready` 上，宿主等 ready 之后才认为查看器可用。
      pending.push(runtime.activate(plugin.manifest.id));
    }
  }

  return {
    runtime,
    ready: Promise.all(pending).then(() => undefined),

    list() {
      return runtime.list().map((record) => ({
        pluginId: record.pluginId,
        version: record.version,
        status: record.status,
        capabilities: [...record.capabilities],
        fileExtensions: [...record.fileExtensions],
        errorCode: record.lastErrorCode,
        errorMessage: record.lastErrorMessage,
      }));
    },

    isActive(pluginId) {
      return runtime.status(pluginId)?.status === 'ACTIVE';
    },

    async setEnabled(pluginId, enabled) {
      const record = runtime.status(pluginId);
      if (!record) {
        return { ok: false, errorCode: 'ERR_PLUGIN_NOT_REGISTERED', reason: '插件未注册' };
      }
      if (enabled) {
        if (record.status === 'ACTIVE') return { ok: true };
        const activated = await runtime.activate(pluginId);
        if (activated?.status !== 'ACTIVE') {
          return {
            ok: false,
            errorCode: activated?.lastErrorCode ?? 'ERR_PLUGIN_CRASHED',
            reason: activated?.lastErrorMessage ?? '激活失败',
          };
        }
        return { ok: true };
      }
      const result = await runtime.deactivate(pluginId);
      return result.ok ? { ok: true } : { ok: false, errorCode: result.errorCode, reason: result.reason };
    },

    resolveViewer(extension) {
      const ext = extension.toLowerCase();
      const resolved = runtime.resolveCapability<ViewerCapability>(VIEWER_CAPABILITY, {
        extension: ext,
      });
      if (!resolved.ok) {
        return { ok: false, errorCode: resolved.errorCode, reason: resolved.reason };
      }
      return { ok: true, providerId: resolved.provider.pluginId, viewer: resolved.value };
    },

    setDirtyChecker(check) {
      dirtyChecker = check;
    },
  };
}
