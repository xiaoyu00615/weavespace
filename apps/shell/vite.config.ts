import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 仅本机可访问的开发/预览服务器：绑定 127.0.0.1，避免意外对局域网暴露演示页面。
 * Core 接入方式见 src/client/client-api.ts（未来走 HTTP/WS Client API）。
 */
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  preview: { host: '127.0.0.1', port: 5179, strictPort: true },
  build: { outDir: 'dist', sourcemap: false },
});
