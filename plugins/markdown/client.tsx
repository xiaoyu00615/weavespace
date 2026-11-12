/**
 * Markdown 插件的客户端入口（S10-A）。
 *
 * 只在 Shell 的**组合根**被 import 一次；具体渲染实现（`viewer.tsx`）通过
 * `file.viewer` 能力对外提供，宿主组件不直接依赖本文件。
 *
 * 说明：本文件为 `.tsx` 是因为能力实现返回 JSX 节点；Core 侧（packages/tests）
 * 只使用 `manifest.json` 与 `index.ts` 的纯函数，不受影响。
 */
import type { PluginModule } from '../../packages/plugin-runtime/index.ts';
import { createMarkdownViewer } from './viewer.tsx';

/** 组装插件模块：能力实现在注册时登记，激活/停用不需要额外资源。 */
export function createMarkdownClientModule(): PluginModule {
  return {
    capabilities: {
      'file.viewer': createMarkdownViewer(),
    },
  };
}
