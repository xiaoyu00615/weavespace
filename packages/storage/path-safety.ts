/**
 * 路径安全（S4 加固版）。
 *
 * 规则：项目根是授权边界；拒绝 `..` 逃逸、绝对/盘符/UNC/设备路径、以及**重解析点**逃逸。
 *
 * 为什么不能只用字符串比较或 `isSymbolicLink()`：
 * - Windows 的 `lstatSync().isSymbolicLink()` 对 **junction 返回 false**（实测），
 *   只有 `readdir(withFileTypes)` 的 dirent 才会把 junction 标记为链接；
 * - JS 版 `realpathSync()` **不解析 junction**，只有 `realpathSync.native()` 才会解析。
 *
 * 因此本实现以 `realpathSync.native()` 为唯一权威：逐级比较「每个已存在前缀的
 * 真实路径」与「字面路径」，只要不一致就说明该级是重解析点（或等价别名）→ 拒绝。
 * 这是保守策略：连指向根内的 junction 也拒绝，避免信任边界出现歧义。
 *
 * 已知平台限制见 storage/README.md「路径安全」章节。
 */
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

export type PathCheck =
  | { ok: true; absolutePath: string; relativePath: string }
  | { ok: false; errorCode: 'ERR_PATH_OUTSIDE_ROOT' | 'ERR_RESOURCE_NOT_FOUND'; detail: string };

const WIN = process.platform === 'win32';

/** Windows 上路径比较必须大小写不敏感；POSIX 保持大小写敏感。 */
function samePath(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  return WIN ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function outsideRoot(detail: string): PathCheck {
  return { ok: false, errorCode: 'ERR_PATH_OUTSIDE_ROOT', detail };
}

function isInsideRoot(rootAbs: string, candidateAbs: string): boolean {
  const rel = relative(rootAbs, candidateAbs);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return !rel.startsWith(`..${sep}`) && rel !== '..';
}

/**
 * 计算项目根的**规范真实路径**，作为唯一信任边界。
 *
 * 若项目根本身是重解析点（junction/符号链接），这里会解析到其真实目标，
 * 并以此作为边界——这是显式策略，不做静默放宽（见 README）。
 * 根不存在时退回字面路径（例如初始化阶段尚未创建目录）。
 */
export function canonicalRoot(rootDir: string): string {
  const literal = resolve(rootDir);
  try {
    return realpathSync.native(literal);
  } catch {
    return literal;
  }
}

/**
 * 判断一个**已存在**路径是否为重解析点/别名（junction、符号链接、或任何被
 * 文件系统重定向的路径）。不一致即不可信。
 *
 * 对不存在的路径返回 false（是否越界由父级逐级校验负责）。
 */
export function isUntrustedResolution(absPath: string): boolean {
  let native: string;
  try {
    native = realpathSync.native(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // 不存在：不是重解析点问题；其他错误（EACCES/EPERM…）一律按不可信处理（fail closed）
    return code === 'ENOENT' ? false : true;
  }
  return !samePath(native, absPath);
}

/**
 * 把调用方给的相对路径解析为根内绝对路径，并验证路径全程不经过重解析点。
 *
 * 不要求目标存在（用于新建），但会逐级校验**所有已存在的前缀**：
 * 因此「尚不存在的文件经过链接父目录创建」同样会被拒绝。
 */
export function resolveInsideRoot(rootDir: string, requestedPath: string): PathCheck {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    return { ok: false, errorCode: 'ERR_RESOURCE_NOT_FOUND', detail: '路径为空' };
  }
  if (requestedPath.includes('\0')) {
    return outsideRoot('路径包含 NUL 字符');
  }

  const unified = requestedPath.replace(/\\/g, '/');

  // 设备路径 / UNC / 绝对路径 / 盘符（含盘符相对 `C:foo.md`）一律拒绝
  // 注：`\\server\share` 与 `\\?\C:\...` 经反斜杠归一后都以 `//` 开头
  if (unified.startsWith('//')) {
    return outsideRoot(`不接受 UNC 或设备路径: ${requestedPath}`);
  }
  if (/^[A-Za-z]:/.test(unified)) {
    return outsideRoot(`不接受盘符路径（含盘符相对）: ${requestedPath}`);
  }
  if (unified.startsWith('/')) {
    return outsideRoot(`不接受绝对路径输入: ${requestedPath}`);
  }
  if (isAbsolute(requestedPath)) {
    return outsideRoot(`不接受绝对路径输入: ${requestedPath}`);
  }

  const rootAbs = canonicalRoot(rootDir);
  const literal = resolve(rootAbs, normalize(requestedPath));
  if (!isInsideRoot(rootAbs, literal)) {
    return outsideRoot(`路径逃逸根目录: ${requestedPath}`);
  }

  // 逐级校验：每个已存在前缀的真实路径都必须等于其字面路径
  const rel = relative(rootAbs, literal);
  const segments = rel === '' ? [] : rel.split(sep).filter((s) => s.length > 0);
  let current = rootAbs;
  for (const segment of segments) {
    current = join(current, segment);
    let native: string;
    try {
      native = realpathSync.native(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') break; // 本级及其后都不存在，交给调用方决定是否创建
      // 无法确认（EACCES/EPERM/ENOTDIR…）时不得默认视为安全
      return outsideRoot(`无法确认路径安全（${code ?? 'unknown'}）: ${requestedPath}`);
    }
    if (!samePath(native, current)) {
      return outsideRoot(`路径经过重解析点（junction/符号链接）: ${requestedPath}`);
    }
  }

  // 目标已存在 → 用规范真实路径；不存在 → 用字面路径（其父级已验证）
  let absolutePath = literal;
  try {
    absolutePath = realpathSync.native(literal);
  } catch {
    absolutePath = literal;
  }
  return { ok: true, absolutePath, relativePath: relative(rootAbs, absolutePath) };
}

export function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
