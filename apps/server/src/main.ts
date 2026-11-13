/**
 * localhost 服务启动入口（S9-B / G1）。
 *
 * 两种互斥模式：
 *   Legacy：`node apps/server/src/main.ts <项目根目录> [端口]`
 *   Multi ：`node apps/server/src/main.ts --workspace <workspace.json> [端口]`
 *
 * 项目根 / 工作区配置只能由启动参数（可信配置）给出；服务不接受请求里指定的目录。
 * 同时给出项目根与工作区配置 → 直接拒绝（Legacy 与 Multi 不得混用身份规则）。
 */
import { resolve } from 'node:path';
import { createShellServer } from './server.ts';

interface StartupArgs {
  rootDir?: string;
  workspacePath?: string;
  portArg?: string;
}

function parseArgs(argv: readonly string[]): StartupArgs {
  const positional: string[] = [];
  let workspacePath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--workspace') {
      workspacePath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--workspace=')) {
      workspacePath = arg.slice('--workspace='.length);
      continue;
    }
    positional.push(arg);
  }

  if (workspacePath !== undefined && positional.length > 0) {
    // Multi 下位置参数只能是端口；出现两个以上说明同时给了项目根
    if (positional.length > 1) {
      throw new Error('启动参数冲突：不能同时指定项目根与 --workspace（Legacy 与 Multi 互斥）');
    }
    if (workspacePath.trim() === '') {
      throw new Error('--workspace 需要一个工作区配置文件路径');
    }
    return { workspacePath, portArg: positional[0] };
  }

  return { rootDir: positional[0], portArg: positional[1] };
}

let args: StartupArgs;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(2);
}

if ((args.rootDir ?? '').trim() === '' && (args.workspacePath ?? '').trim() === '') {
  process.stderr.write(
    '用法:\n' +
      '  node apps/server/src/main.ts <项目根目录> [端口]              （Legacy 单项目）\n' +
      '  node apps/server/src/main.ts --workspace <workspace.json> [端口]（Multi 多项目）\n',
  );
  process.exit(2);
}

const port = Number(args.portArg ?? process.env.WS_PORT ?? 5177);

const server =
  args.workspacePath !== undefined
    ? await createShellServer({ workspacePath: resolve(args.workspacePath), port })
    : await createShellServer({ rootDir: resolve(args.rootDir as string), port });

// Multi 日志不打印任何项目根，避免把本机路径写进可分享的运行日志
process.stdout.write(
  args.workspacePath !== undefined
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
