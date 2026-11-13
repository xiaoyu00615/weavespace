/// <reference types="node" />
import { basename, resolve as resolvePath } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 代理目标：默认本机 5177，可用 `WS_API_TARGET` 覆盖。
 * 需要覆盖的场景：5177 已被另一个（例如用户自己的）服务占用，或要并行跑多个测试实例。
 */
const apiTarget = process.env.WS_API_TARGET ?? 'http://127.0.0.1:5177';

/**
 * 宿主（本工程）目录与仓库根；插件在 `plugins/`，与 `apps/` 平级。
 *
 * 用 cwd 而不是 `import.meta.url`：Vite 会把配置文件转译到临时目录，
 * 那时 `import.meta.url` 指向临时文件，相对路径会算错。
 * 本工程的所有脚本都从 `apps/shell` 运行（根脚本用 `npm --prefix`），因此 cwd 可靠。
 */
const shellDir = basename(process.cwd()) === 'shell' ? process.cwd() : resolvePath(process.cwd(), 'apps/shell');
const repoRoot = resolvePath(shellDir, '../..');
const hostModules = `${resolvePath(shellDir, 'node_modules')}/`;

/**
 * 仅本机可访问的开发/预览服务器：绑定 127.0.0.1，避免意外对局域网暴露演示页面。
 * Core 接入方式见 src/client/client-api.ts（未来走 HTTP/WS Client API）。
 */
export default defineConfig({
  plugins: [react()],

  /**
   * 插件目录（`plugins/**`）把 react 视为**宿主提供的 peer 依赖**：
   * 它们不在 `apps/shell` 之下，Node/Vite 默认的向上查找到不了本工程的 node_modules。
   * 这里由宿主显式给出解析目标，插件源码保持独立（不 import 任何 Shell 代码）。
   * `dedupe` 防止出现两份 React 实例（否则 hooks 会失效）。
   */
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^react\/jsx-dev-runtime$/, replacement: `${hostModules}react/jsx-dev-runtime.js` },
      { find: /^react\/jsx-runtime$/, replacement: `${hostModules}react/jsx-runtime.js` },
      { find: /^react-dom\/client$/, replacement: `${hostModules}react-dom/client.js` },
      { find: /^react-dom\/server$/, replacement: `${hostModules}react-dom/server.js` },
      { find: /^react-dom$/, replacement: `${hostModules}react-dom/index.js` },
      { find: /^react$/, replacement: `${hostModules}react/index.js` },
    ],
  },

  // `/api` 同源代理到 localhost Client API（apps/server，默认 5177）：
  // 浏览器因此始终同源，不需要任何 CORS 头，也不会把服务暴露给局域网。
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
    fs: {
      // 允许读取仓库根下的 plugins/（插件目录在 apps/shell 之外）
      allow: [repoRoot],
    },
  },
  preview: { host: '127.0.0.1', port: 5179, strictPort: true },
  build: { outDir: 'dist', sourcemap: false },
});
