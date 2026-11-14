/**
 * localhost 服务启动入口（S9-B / G1 / UX-00）。
 *
 * 两种互斥模式：
 *   Legacy：`node apps/server/src/main.ts <项目根目录> [端口]`
 *   Multi ：`node apps/server/src/main.ts --workspace <workspace.json> [端口]`
 *
 * 项目根 / 工作区配置只能由启动参数（可信配置）给出；服务不接受请求里指定的目录。
 * 同时给出项目根与工作区配置 → 直接拒绝（Legacy 与 Multi 不得混用身份规则）。
 *
 * 参数解析本身在 `startup-args.ts`：那是纯函数，可被测试直接 import；
 * 本文件只负责「解析 → 建服务 → 打日志 → 信号关闭」。
 */
import { resolve } from 'node:path';
import { createShellServer } from './server.ts';
import { StartupArgsError, parseStartup, type StartupArgs } from './startup-args.ts';

let args: StartupArgs;
try {
  args = parseStartup(process.argv.slice(2), process.env);
} catch (err) {
  // 参数错误一律 exit 2：既区分「参数写错」与「没给目标」，也不把堆栈刷给用户
  const message =
    err instanceof StartupArgsError
      ? err.message
      : `启动参数解析失败: ${(err as Error).message}`;
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const server =
  args.mode === 'multi'
    ? await createShellServer({ workspacePath: resolve(args.workspacePath), port: args.port })
    : await createShellServer({ rootDir: resolve(args.rootDir), port: args.port });

// Multi 日志不打印任何项目根，避免把本机路径写进可分享的运行日志
process.stdout.write(
  args.mode === 'multi'
    ? `[g1] live api  ${server.url}  mode=multi  workspace=${args.workspacePath}\n` +
        `[g1] 浏览器请访问 http://127.0.0.1:5178（Vite 会把 /api 代理到本服务）\n`
    : `[s9b] live api  ${server.url}  root=${server.rootDir}  actor=${server.actorId}\n` +
        `[s9b] 浏览器请访问 http://127.0.0.1:5178（Vite 会把 /api 代理到本服务）\n`,
);

const shutdown = async (signal: string): Promise<void> => {
  process.stdout.write(`[s9b] ${signal} 收到，正在关闭...\n`);
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
