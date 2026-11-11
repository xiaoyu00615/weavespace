/**
 * 路径安全（P0 探针版）。
 * 规则：项目根是授权边界；拒绝 `..` 逃逸、绝对路径逃逸、符号链接逃逸。
 * 限制：仅覆盖本地 NTFS 常见情形；大小写/UNC/长路径的完整策略待 E01 与 ADR。
 * 规范依据 docs/08「Path Traversal、软链接逃逸」与 docs/12 SEC-001。
 */
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

export type PathCheck =
  | { ok: true; absolutePath: string; relativePath: string }
  | { ok: false; errorCode: 'ERR_PATH_OUTSIDE_ROOT' | 'ERR_RESOURCE_NOT_FOUND'; detail: string };

function isInsideRoot(rootAbs: string, candidateAbs: string): boolean {
  const rel = relative(rootAbs, candidateAbs);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return !rel.startsWith(`..${sep}`) && rel !== '..';
}

/**
 * 把调用方给的相对路径解析为根内绝对路径。
 * 不要求目标存在（用于新建），但若存在则解析真实路径并再次校验根边界。
 */
export function resolveInsideRoot(rootDir: string, requestedPath: string): PathCheck {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    return { ok: false, errorCode: 'ERR_RESOURCE_NOT_FOUND', detail: '路径为空' };
  }
  if (isAbsolute(requestedPath)) {
    return { ok: false, errorCode: 'ERR_PATH_OUTSIDE_ROOT', detail: '不接受绝对路径输入' };
  }
  const rootAbs = resolve(rootDir);
  const normalized = normalize(requestedPath);
  const absolutePath = resolve(rootAbs, normalized);
  if (!isInsideRoot(rootAbs, absolutePath)) {
    return {
      ok: false,
      errorCode: 'ERR_PATH_OUTSIDE_ROOT',
      detail: `路径逃逸根目录: ${requestedPath}`,
    };
  }
  // 若目标已存在，检查真实路径（防符号链接/junction 指向根外）
  try {
    const real = realpathSync(absolutePath);
    let realRoot = rootAbs;
    try {
      realRoot = realpathSync(rootAbs);
    } catch {
      /* 根目录真实路径不可得时退回字面根 */
    }
    if (!isInsideRoot(normalize(realRoot), normalize(real))) {
      return {
        ok: false,
        errorCode: 'ERR_PATH_OUTSIDE_ROOT',
        detail: `真实路径逃逸根目录: ${requestedPath}`,
      };
    }
    return { ok: true, absolutePath: real, relativePath: relative(realRoot, real) };
  } catch {
    // 不存在：用字面路径（父目录存在性由调用方决定）
    return { ok: true, absolutePath, relativePath: relative(rootAbs, absolutePath) };
  }
}

export function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
