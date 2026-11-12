/**
 * 通用文本插件的客户端入口（S10-A）。
 * 只提供 `file.viewer`；不触碰存储、会话或保存。
 */
import type { PluginModule } from '../../packages/plugin-runtime/index.ts';
import { createPlaintextViewer } from './viewer.tsx';

export function createPlaintextClientModule(): PluginModule {
  return {
    capabilities: {
      'file.viewer': createPlaintextViewer(),
    },
  };
}
