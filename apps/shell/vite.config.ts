/// <reference types="node" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 代理目标：默认本机 5177，可用 `WS_API_TARGET` 覆盖。
 * 需要覆盖的场景：5177 已被另一个（例如用户自己的）服务占用，或要并行跑多个测试实例。
 */
const apiTarget = process.env.WS_API_TARGET ?? 'http://127.0.0.1:5177';

/**
 * 仅本机可访问的开发/预览服务器：绑定 127.0.0.1，避免意外对局域网暴露演示页面。
 * Core 接入方式见 src/client/client-api.ts（未来走 HTTP/WS Client API）。
 */
export default defineConfig({
  plugins: [react()],
  // `/api` 同源代理到 localhost Client API（apps/server，默认 5177）：
  // 浏览器因此始终同源，不需要任何 CORS 头，也不会把服务暴露给局域网。
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
  preview: { host: '127.0.0.1', port: 5179, strictPort: true },
  build: { outDir: 'dist', sourcemap: false },
});
