/**
 * localhost 服务启动入口（S9-B）。
 *
 * 用法：
 *   node apps/server/src/main.ts <项目根目录> [端口]
 *
 * 项目根只能由启动参数（可信配置）给出；服务不接受请求里指定的目录。
 */
import { resolve } from 'node:path';
import { createShellServer } from './server.ts';

const rootArg = process.argv[2] ?? process.env.WS_PROJECT_ROOT ?? '';
if (rootArg.trim() === '') {
  process.stderr.write('用法: node apps/server/src/main.ts <项目根目录> [端口]\n');
  process.exit(2);
}

const rootDir = resolve(rootArg);
const port = Number(process.argv[3] ?? process.env.WS_PORT ?? 5177);

const server = await createShellServer({ rootDir, port });
process.stdout.write(
  `[s9b] live api  ${server.url}  root=${rootDir}  actor=${server.actorId}\n` +
    `[s9b] 浏览器请访问 http://127.0.0.1:5178（Vite 会把 /api 代理到本服务）\n`,
);

const shutdown = async (signal: string): Promise<void> => {
  process.stdout.write(`[s9b] ${signal} 收到，正在关闭...\n`);
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
