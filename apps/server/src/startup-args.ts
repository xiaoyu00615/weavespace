/**
 * Host 启动参数解析（S11-UX-00）。
 *
 * 为什么单独成模块：`main.ts` 顶层会真正建监听，无法被测试 import；
 * 参数规则又必须能在 Node 里直接覆盖（沙箱禁止 spawn 子进程）。
 * 这里只做**纯字符串解析**：不读文件系统、不建服务、不写日志。
 *
 * 两种模式互斥：
 *   Legacy：`<项目根目录> [端口]`
 *   Multi ：`--workspace <workspace.json> [端口]`（也接受 `--workspace=<file>`）
 *
 * 位置参数的身份由**是否像端口（全数字）**判断，而不是看它在第几位：
 * Multi 下唯一的位置参数只能是端口，不是全数字就说明用户同时给了项目根，
 * 必须按模式冲突拒绝——否则会被当成端口传进 `listen()`，在 `validatePort` 处崩溃。
 * 数字但越界（如 `65536`）仍按端口处理，交给 `resolvePort` 报"端口非法"，
 * 以免真正的错误原因被"模式冲突"掩盖。
 */

/** 端口默认值；`WS_PORT` 环境变量可覆盖，命令行显式端口优先级最高。 */
export const DEFAULT_PORT = 5177;

export const USAGE =
  '用法:\n' +
  '  node apps/server/src/main.ts <项目根目录> [端口]              （Legacy 单项目）\n' +
  '  node apps/server/src/main.ts --workspace <workspace.json> [端口]（Multi 多项目）\n';

/** 启动参数错误码：测试断言错误码，不依赖中文文案。 */
export type StartupArgsErrorCode =
  | 'ERR_STARTUP_NO_TARGET'
  | 'ERR_STARTUP_WORKSPACE_MISSING_VALUE'
  | 'ERR_STARTUP_MODE_CONFLICT'
  | 'ERR_STARTUP_UNKNOWN_OPTION'
  | 'ERR_STARTUP_INVALID_PORT';

export class StartupArgsError extends Error {
  readonly code: StartupArgsErrorCode;

  constructor(code: StartupArgsErrorCode, message: string) {
    super(message);
    this.name = 'StartupArgsError';
    this.code = code;
  }
}

/**
 * 解析结果用可判别联合表达：`mode` 决定哪个目标字段存在。
 * 这样调用方拿 `rootDir` / `workspacePath` 时不需要强制类型转换。
 */
export type StartupArgs =
  | {
      readonly mode: 'legacy';
      readonly rootDir: string;
      readonly port: number;
    }
  | {
      readonly mode: 'multi';
      readonly workspacePath: string;
      readonly port: number;
    };

/** 只声明用到的环境变量，避免把整个 `process.env` 当输入。 */
export interface StartupEnv {
  readonly WS_PORT?: string | undefined;
}

const PORT_PATTERN = /^\d{1,5}$/;

function resolvePort(raw: string | undefined, env: StartupEnv): number {
  const value = raw ?? env.WS_PORT ?? String(DEFAULT_PORT);
  if (!PORT_PATTERN.test(value)) {
    throw new StartupArgsError('ERR_STARTUP_INVALID_PORT', `端口必须是 0-65535 的整数，收到: ${JSON.stringify(value)}`);
  }
  const port = Number(value);
  if (port > 65535) {
    throw new StartupArgsError('ERR_STARTUP_INVALID_PORT', `端口必须是 0-65535 的整数，收到: ${JSON.stringify(value)}`);
  }
  return port;
}

/**
 * 位置参数是否「看起来是端口」——只看是否全数字，**不判范围**。
 *
 * 范围非法（如 `65536`）必须留给 `resolvePort` 报"端口非法"，
 * 否则会被误判成"用户同时给了项目根"而报成模式冲突，掩盖真正的原因。
 */
function looksLikePortNumber(value: string | undefined): boolean {
  if (value === undefined) return false;
  return /^\d+$/.test(value);
}

/**
 * 解析启动参数。**纯函数**：同一组 argv/env 永远得到同一结果。
 *
 * @throws {StartupArgsError} 参数非法时抛出，调用方负责打印文案并 `exit 2`。
 */
export function parseStartup(argv: readonly string[], env: StartupEnv = {}): StartupArgs {
  const positional: string[] = [];
  /** `--workspace` 的值（用于识别重复指定）；出现即代表 Multi。 */
  const workspaceValues: string[] = [];
  let workspaceFlagSeen = false;
  let missingWorkspaceValue = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--workspace') {
      workspaceFlagSeen = true;
      const next = argv[i + 1];
      i += 1;
      // 缺值、空值、或下一个又是选项 → 一律按缺值拒绝（fail closed，不猜用户意图）
      if (next === undefined || next.trim() === '' || next.startsWith('--')) {
        missingWorkspaceValue = true;
        continue;
      }
      workspaceValues.push(next);
      continue;
    }
    if (arg.startsWith('--workspace=')) {
      workspaceFlagSeen = true;
      const value = arg.slice('--workspace='.length);
      if (value.trim() === '') {
        missingWorkspaceValue = true;
        continue;
      }
      workspaceValues.push(value);
      continue;
    }
    if (arg.startsWith('--')) {
      // 拼错的选项不能被当成项目根或端口（否则会在更深的地方以难懂的方式失败）
      throw new StartupArgsError('ERR_STARTUP_UNKNOWN_OPTION', `未知选项: ${arg}\n${USAGE}`);
    }
    positional.push(arg);
  }

  if (missingWorkspaceValue) {
    throw new StartupArgsError('ERR_STARTUP_WORKSPACE_MISSING_VALUE', '--workspace 需要一个工作区配置文件路径');
  }
  if (workspaceValues.length > 1) {
    // 重复指定不取最后一个：两个候选工区意味着调用方意图不明
    throw new StartupArgsError(
      'ERR_STARTUP_MODE_CONFLICT',
      `--workspace 只能指定一次，收到 ${workspaceValues.length} 次`,
    );
  }

  // 关键修复：`--workspace` 一旦出现就是 Multi，**与是否有端口无关**。
  if (workspaceFlagSeen) {
    if (positional.length > 1) {
      throw new StartupArgsError(
        'ERR_STARTUP_MODE_CONFLICT',
        '启动参数冲突：Multi 模式下位置参数只能是端口（不能同时给出项目根）',
      );
    }
    const portArg = positional[0];
    // 唯一的位置参数必须是端口；不是端口就说明用户同时给了项目根 → 模式冲突
    if (portArg !== undefined && !looksLikePortNumber(portArg)) {
      throw new StartupArgsError(
        'ERR_STARTUP_MODE_CONFLICT',
        '启动参数冲突：不能同时指定项目根与 --workspace（Legacy 与 Multi 互斥）',
      );
    }
    return { mode: 'multi', workspacePath: workspaceValues[0], port: resolvePort(portArg, env) };
  }

  const rootDir = positional[0];
  if ((rootDir ?? '').trim() === '') {
    // 与 main.ts 既有行为一致：既没给项目根也没给 --workspace → 打印用法后 exit 2
    throw new StartupArgsError('ERR_STARTUP_NO_TARGET', USAGE.trimEnd());
  }
  return { mode: 'legacy', rootDir, port: resolvePort(positional[1], env) };
}
