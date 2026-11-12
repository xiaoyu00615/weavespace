/**
 * 路径安全（S4-R1：根目录身份固定）。
 *
 * 规则：项目根是授权边界；拒绝 `..` 逃逸、绝对/盘符/UNC/设备路径、以及**重解析点**逃逸。
 *
 * 为什么不能只用字符串比较或 `isSymbolicLink()`：
 * - Windows 的 `lstatSync().isSymbolicLink()` 对 **junction 返回 false**（实测），
 *   只有 `readdir(withFileTypes)` 的 dirent 才会把 junction 标记为链接；
 * - JS 版 `realpathSync()` **不解析 junction**，只有 `realpathSync.native()` 才会解析。
 *
 * ## 根目录身份固定（S4-R1 核心变更）
 *
 * 旧实现每次解析都重新 `realpathSync.native(rootDir)`，失败时**回退到字面路径**。
 * 后果有两个：边界可以在一次操作内部漂移；回退出的字面路径仍然穿越 junction，
 * 一旦父级 junction 被改向，写盘就落到另一个目录。
 *
 * 新实现把「根目录身份」变成一次性的显式对象 `RootBoundary`：
 * - 根可解析 → `canonicalRoot = realpathSync.native(rootDir)`；
 * - 根尚不存在（ENOENT）→ 以**最近可解析祖先的 realpath + 字面剩余段**锚定
 *   （绝不直接使用未经验证的字面路径）；
 * - 其他失败（EPERM/EACCES/ENAMETOOLONG/悬空重解析点…）→ **抛错（fail closed）**。
 *
 * 之后每次解析都以 `canonicalRoot` 为绝对基准（前缀不再穿越任何链接）；
 * 写入的关键节点再用 `assertBoundaryStable()` 重建边界并比对身份：
 * 父级 junction 从 A 改向 B 时身份不一致 → 拒绝，B 不会产生任何副作用。
 *
 * 已知平台限制见 storage/README.md「路径安全」章节。
 */
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

export type PathCheck =
  | { ok: true; absolutePath: string; relativePath: string }
  | { ok: false; errorCode: 'ERR_PATH_OUTSIDE_ROOT' | 'ERR_RESOURCE_NOT_FOUND'; detail: string };

/**
 * 固定的根目录安全边界。
 * - `literalRoot`：调用方传入的字面根（诊断与漂移比对用）；
 * - `canonicalRoot`：唯一可信的绝对基准，所有解析从它出发；
 * - `verified`：是否由 realpath 直接确证（false 表示根本身尚不存在，由现存祖先锚定）；
 * - `anchor`：锚定的现存祖先规范路径。
 */
export interface RootBoundary {
  readonly literalRoot: string;
  readonly canonicalRoot: string;
  readonly verified: boolean;
  readonly anchor: string;
}

const WIN = process.platform === 'win32';

/** Windows 上路径比较必须大小写不敏感；POSIX 保持大小写敏感。 */
function samePath(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  return WIN ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function outsideRoot(detail: string): PathCheck {
  return { ok: false, errorCode: 'ERR_PATH_OUTSIDE_ROOT', detail };
}

/** 边界类错误统一携带 `ERR_PATH_OUTSIDE_ROOT`，便于调用方识别（不伪装成“不存在”）。 */
function boundaryError(detail: string): Error {
  return Object.assign(new Error(detail), { errorCode: 'ERR_PATH_OUTSIDE_ROOT' as const });
}

/**
 * OS 错误 → 注册错误码（docs/09）。
 *
 * 关键区分：`ENOENT` 才代表「目标不存在」；`EPERM/EACCES` 是权限问题；
 * 其余（EBUSY/EIO/ENOSPC/…）是存储 I/O 故障。三者处置完全不同，
 * 不得因为「读不出来」就当作「不存在」。
 */
export function mapStorageError(
  err: unknown,
): 'ERR_PATH_OUTSIDE_ROOT' | 'ERR_PERMISSION_DENIED' | 'ERR_STORAGE_IO' | 'ERR_RESOURCE_NOT_FOUND' {
  const own = (err as { errorCode?: string } | undefined)?.errorCode;
  if (own === 'ERR_PATH_OUTSIDE_ROOT') return 'ERR_PATH_OUTSIDE_ROOT';
  if (own === 'ERR_PERMISSION_DENIED') return 'ERR_PERMISSION_DENIED';
  if (own === 'ERR_STORAGE_IO') return 'ERR_STORAGE_IO';
  if (own === 'ERR_RESOURCE_NOT_FOUND') return 'ERR_RESOURCE_NOT_FOUND';

  const code = codeOf(err);
  if (code === 'EPERM' || code === 'EACCES') return 'ERR_PERMISSION_DENIED';
  if (code === 'ENOENT') return 'ERR_RESOURCE_NOT_FOUND';
  return 'ERR_STORAGE_IO';
}

/** 把原始 OS/边界错误包装成带注册错误码的 Error，供 read/stat 直接抛出。 */
export function toStorageError(err: unknown): Error {
  const errorCode = mapStorageError(err);
  const osCode = codeOf(err);
  const detail = err instanceof Error ? err.message : String(err);
  return Object.assign(new Error(detail), { errorCode, osCode });
}

/** 条目存在但无法解析成真实路径（典型：悬空 junction）→ 不可验证。 */
function isUnresolvableEntry(absPath: string): boolean {
  try {
    lstatSync(absPath);
    return true; // 条目存在却 realpath 失败 → 悬空重解析点或等价别名
  } catch (err) {
    return codeOf(err) !== 'ENOENT'; // 连 lstat 都失败（EACCES 等）→ fail closed
  }
}

/**
 * 建立**固定**的根目录安全边界。这是本模块唯一的信任锚点来源。
 *
 * 失败语义：非 ENOENT 的解析失败一律抛错，不回退字面路径（S4-R1/R2）。
 */
export function createRootBoundary(rootDir: string): RootBoundary {
  const literal = resolve(rootDir);

  try {
    const real = realpathSync.native(literal);
    return { literalRoot: literal, canonicalRoot: real, verified: true, anchor: real };
  } catch (err) {
    const code = codeOf(err);
    if (code !== 'ENOENT') {
      throw boundaryError(`根目录真实路径无法确认（${code ?? 'unknown'}）: ${literal}`);
    }
    if (isUnresolvableEntry(literal)) {
      throw boundaryError(`根目录是悬空重解析点，无法确认真实路径: ${literal}`);
    }
  }

  // 根尚不存在：以最近可解析的现存祖先锚定，绝不回退未经验证的字面路径
  const missing: string[] = [];
  let cursor = literal;
  for (;;) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw boundaryError(`根目录及其所有祖先均不可解析: ${literal}`);
    }
    missing.unshift(basename(cursor));
    cursor = parent;
    try {
      const realParent = realpathSync.native(cursor);
      return {
        literalRoot: literal,
        canonicalRoot: join(realParent, ...missing),
        verified: false,
        anchor: realParent,
      };
    } catch (err) {
      const code = codeOf(err);
      if (code !== 'ENOENT') {
        throw boundaryError(`根目录祖先真实路径无法确认（${code ?? 'unknown'}）: ${cursor}`);
      }
      // F04：ENOENT 不等于「普通缺失目录」。悬空 junction/符号链接同样让 realpath 报
      // ENOENT，若直接当作缺失拼进 canonicalRoot，就等于接受了一个未经验证的边界。
      if (isUnresolvableEntry(cursor)) {
        throw boundaryError(`根目录祖先中存在悬空重解析点，无法确认真实路径: ${cursor}`);
      }
    }
  }
}

/** 兼容旧接口：返回固定边界的规范根；无法确认时抛错（不再静默回退字面路径）。 */
export function canonicalRoot(rootDir: string): string {
  return createRootBoundary(rootDir).canonicalRoot;
}

/**
 * 重建边界并与既有边界比对，确认根目录身份未变。
 *
 * 这是防「父级 junction 从 A 改向 B」的判定点：身份不一致即拒绝，
 * 因此不会在 B 侧创建/修改对象后谎报 COMMITTED。
 *
 * 注意：这是**检查**而非原子锁；检查与随后的文件操作之间仍有时间窗（见 README「已知限制」）。
 */
export function assertBoundaryStable(boundary: RootBoundary): void {
  let fresh: RootBoundary;
  try {
    fresh = createRootBoundary(boundary.literalRoot);
  } catch (err) {
    throw boundaryError(`根目录边界已不可确认: ${(err as Error).message}`);
  }
  if (!samePath(fresh.canonicalRoot, boundary.canonicalRoot)) {
    throw boundaryError(
      `根目录身份已改变（边界漂移）: ${boundary.canonicalRoot} -> ${fresh.canonicalRoot}`,
    );
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
    const code = codeOf(err);
    // 不存在：不是重解析点问题；其他错误（EACCES/EPERM…）一律按不可信处理（fail closed）
    return code === 'ENOENT' ? false : true;
  }
  return !samePath(native, absPath);
}

function isInsideRoot(rootAbs: string, candidateAbs: string): boolean {
  const rel = relative(rootAbs, candidateAbs);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return !rel.startsWith(`..${sep}`) && rel !== '..';
}

/**
 * 在**已固定**的边界内解析相对路径（StorageProvider 内部使用）。
 *
 * 不要求目标存在（用于新建），但会逐级校验**所有已存在的前缀**。
 * 与旧实现的区别：起点是 `boundary.canonicalRoot`（已解析），路径前缀不再穿越
 * 任何链接；且末段 realpath 失败不再无条件回退字面路径。
 */
export function resolveInBoundary(boundary: RootBoundary, requestedPath: string): PathCheck {
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

  const rootAbs = boundary.canonicalRoot;
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
      const code = codeOf(err);
      if (code === 'ENOENT') {
        // 本级不存在：若其实是悬空重解析点则不可信；否则其后各级均不存在
        if (isUnresolvableEntry(current)) {
          return outsideRoot(`路径经过悬空重解析点: ${requestedPath}`);
        }
        break;
      }
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
  } catch (err) {
    const code = codeOf(err);
    // 末段无法确认时不得回退字面路径（旧实现的风险点）
    if (code !== 'ENOENT') {
      return outsideRoot(`无法确认目标真实路径（${code ?? 'unknown'}）: ${requestedPath}`);
    }
    if (isUnresolvableEntry(literal)) {
      return outsideRoot(`目标路径是悬空重解析点: ${requestedPath}`);
    }
    absolutePath = literal;
  }
  return { ok: true, absolutePath, relativePath: relative(rootAbs, absolutePath) };
}

/**
 * 便捷包装：为一次性调用建立临时边界后解析。
 *
 * StorageProvider 必须**复用同一个边界**（`createRootBoundary` + `resolveInBoundary`），
 * 不得靠反复调用本函数来实现“每次重新校验”。
 */
export function resolveInsideRoot(rootDir: string, requestedPath: string): PathCheck {
  let boundary: RootBoundary;
  try {
    boundary = createRootBoundary(rootDir);
  } catch (err) {
    return outsideRoot((err as Error).message);
  }
  return resolveInBoundary(boundary, requestedPath);
}

/**
 * 存在性判定。**只有 ENOENT 才返回 false**；权限/IO 失败原样抛出，
 * 避免调用方把「读不出来」误认为「不存在」（S4-R2）。
 */
export function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return false;
    throw err;
  }
}
