/**
 * 「创建已支持的扩展文件」二级菜单的数据来源（UX-02C-01）。
 *
 * 唯一来源是**当前已激活的 Shell 能力注册表**：插件停用、注册失败、查看能力
 * 解析不到，或能力注册表还没就绪，都不再把该扩展名列为"已支持"。
 * 因此这里不维护 `.md/.markdown/.txt` 的硬编码清单——首版出现这三项，是因为
 * 当前两个内置插件恰好声明了它们，插件一变菜单自动跟着变。
 *
 * 纯函数 + 窄端口：不 import 任何插件实现（也不 import `.tsx`），可被 node:test
 * 直接用真实 manifest 数据驱动；菜单组件只负责渲染结果。
 */

export interface ActivePluginView {
  readonly pluginId: string;
  readonly status: string;
  readonly capabilities: readonly string[];
  readonly fileExtensions: readonly string[];
  readonly displayName?: string;
}

export interface CapabilitySnapshot {
  list(): readonly ActivePluginView[];
  /** 该扩展名此刻是否真的能拿到查看器。 */
  resolveViewer(extension: string): { ok: boolean };
}

export interface SupportedExtension {
  readonly extension: string;
  readonly label: string;
  readonly pluginId: string;
}

const EXT_RE = /^\.[a-z0-9]+$/;

/** 注册顺序即优先级：同一扩展名由第一个已激活且可解析的插件提供。 */
export function supportedFileExtensions(
  registry: CapabilitySnapshot,
  ready: boolean,
): readonly SupportedExtension[] {
  if (!ready) return [];
  const out: SupportedExtension[] = [];
  const seen = new Set<string>();
  for (const plugin of registry.list()) {
    if (plugin.status !== 'ACTIVE' || !plugin.capabilities.includes('file.viewer')) continue;
    for (const raw of plugin.fileExtensions) {
      const extension = raw.toLowerCase();
      if (seen.has(extension) || !EXT_RE.test(extension)) continue;
      if (!registry.resolveViewer(extension).ok) continue;
      seen.add(extension);
      out.push({
        extension,
        label: `${plugin.displayName ?? plugin.pluginId} (${extension})`,
        pluginId: plugin.pluginId,
      });
    }
  }
  return out;
}
