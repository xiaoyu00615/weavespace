/**
 * 项目根可用性判定（G1-01 / G1-02）。
 *
 * 关键区分（与 R2 契约一致）：
 * - 路径可以规范化 ≠ 目录真实存在 ≠ 可访问 ≠ 根身份可安全确认；
 * - 只有四项全部成立才是 READY；
 * - **Multi 模式绝不自动创建缺失的项目根**：G0 的 INITIALIZABLE 首次创建能力只服务于
 *   Legacy Storage，Registry 不提供这条路径（缺失即 UNAVAILABLE）。
 *
 * 本模块只做判定，不产生任何副作用（不 mkdir、不写文件）。
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildRootToken, isUntrustedResolution } from '../storage/path-safety.ts';
import { isUncPath } from './config.ts';

export type ProjectStatus = 'READY' | 'UNAVAILABLE';

export type ProjectUnavailableReason =
  | 'MISSING'
  | 'NOT_DIRECTORY'
  | 'PERMISSION_DENIED'
  | 'REPARSE_POINT'
  | 'UNC_UNSUPPORTED'
  | 'ROOT_IDENTITY_UNSUPPORTED'
  | 'CANONICAL_CHANGED'
  | 'ROOT_TOKEN_CHANGED'
  | 'IO_ERROR';

export interface ReadyRoot {
  readonly status: 'READY';
  readonly literalRoot: string;
  readonly canonicalRoot: string;
  readonly rootToken: string;
}

export interface UnavailableRoot {
  readonly status: 'UNAVAILABLE';
  readonly reason: ProjectUnavailableReason;
  readonly detail: string;
}

export type RootInspection = ReadyRoot | UnavailableRoot;

function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * 检查一个项目根当前是否可用。**无副作用**，任何异常都收敛为 UNAVAILABLE。
 *
 * READY 条件：
 * 1. 不是 UNC/设备路径；
 * 2. `stat` 成功且是目录（存在 + 可访问）；
 * 3. 根自身不是重解析点（`realpath` 必须等于字面路径）；
 * 4. 能构造 bigint 根身份令牌（`ino` 可用；`ino === 0` 视为不支持）。
 */
export function inspectProjectRoot(rootDir: string): RootInspection {
  if (isUncPath(rootDir)) {
    return { status: 'UNAVAILABLE', reason: 'UNC_UNSUPPORTED', detail: `不支持 UNC/网络路径: ${rootDir}` };
  }

  const literalRoot = resolve(rootDir);

  let stat;
  try {
    stat = statSync(literalRoot, { bigint: true });
  } catch (err) {
    const code = codeOf(err);
    if (code === 'ENOENT') return { status: 'UNAVAILABLE', reason: 'MISSING', detail: '项目根不存在' };
    if (code === 'EPERM' || code === 'EACCES') {
      return { status: 'UNAVAILABLE', reason: 'PERMISSION_DENIED', detail: '项目根不可访问' };
    }
    return { status: 'UNAVAILABLE', reason: 'IO_ERROR', detail: `项目根无法读取（${code ?? 'unknown'}）` };
  }

  if (!stat.isDirectory()) {
    return { status: 'UNAVAILABLE', reason: 'NOT_DIRECTORY', detail: '项目根不是目录' };
  }

  // 根本身是重解析点 → 身份可被改向，不登记为 READY
  if (isUntrustedResolution(literalRoot)) {
    return { status: 'UNAVAILABLE', reason: 'REPARSE_POINT', detail: '项目根是重解析点，身份不可靠' };
  }

  try {
    const rootToken = buildRootToken(stat);
    return { status: 'READY', literalRoot, canonicalRoot: literalRoot, rootToken };
  } catch (err) {
    const code = (err as { errorCode?: string }).errorCode;
    if (code === 'ERR_ROOT_IDENTITY_UNSUPPORTED') {
      return {
        status: 'UNAVAILABLE',
        reason: 'ROOT_IDENTITY_UNSUPPORTED',
        detail: '文件系统未提供可用的根身份（ino=0）',
      };
    }
    return { status: 'UNAVAILABLE', reason: 'IO_ERROR', detail: '根身份无法确认' };
  }
}
