/**
 * 新建条目的名称 / 父目录校验（UX-02C-01）。
 *
 * 为什么单独一个纯模块：Host 与 Shell 必须用**同一条**规则，才能在行内输入框里
 * 立刻指出"注定失败"的名字，又不会在浏览器侧形成另一套可以漂移的判定。
 * 这里**不做授权、不碰磁盘**：路径是否仍在项目根内，由 `resolveInBoundary` 在
 * StorageProvider 内部逐级确认；本模块只负责"形态明显安全的单段名称/相对目录"。
 *
 * Windows 规则（本阶段按最严的跨平台交集实现，POSIX 也一律遵守）：
 * - 单段名称：不含 `/ \ : * ? " < > |`、控制字符、NUL，也不以空格或句点结尾；
 * - 保留设备名 `CON/PRN/AUX/NUL/COM1-9/LPT1-9`（含扩展名变体、上标数字变体）一律拒绝；
 * - `..` / `.`、绝对路径、盘符、UNC、设备路径、空段一律拒绝。
 *
 * 这些规则**不是**"创建一定成功"的凭证：真正的同名拒绝与排他创建在
 * `local-provider.createEntry()` 里用 `wx` / 非递归 `mkdir` 原子完成。
 */
import type { ErrorCode } from '../contracts/errors.ts';

export type EntryNameCheck =
  | { ok: true; value: string }
  | { ok: false; errorCode: ErrorCode; message: string };

export const MAX_ENTRY_NAME_LENGTH = 255;
export const MAX_PARENT_DIR_LENGTH = 4096;

/** 控制字符（含 DEL）与 Windows 文件名非法字符。 */
const FORBIDDEN_NAME_CHARS = /[\u0000-\u001f\u007f/\\:*?"<>|]/;
/** 保留设备名：允许后面带扩展名，但主体必须是保留字；上标 ¹²³ 也是 Windows 保留变体。 */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\..*)?$/i;

function invalid(errorCode: ErrorCode, message: string): EntryNameCheck {
  return { ok: false, errorCode, message };
}

/**
 * 校验一个**单段**条目名。
 *
 * 不做 trim：`" notes.txt"` / `"notes.txt "` 在 Windows 上会被静默改写成另一个名字，
 * 与其猜用户意图，不如明确拒绝并保留输入供修正。
 */
export function validateEntryName(raw: unknown): EntryNameCheck {
  if (typeof raw !== 'string') return invalid('ERR_ENTRY_NAME_INVALID', '缺少条目名称');
  const name = raw;
  if (name.length === 0) return invalid('ERR_ENTRY_NAME_INVALID', '名称不能为空');
  if (name.length > MAX_ENTRY_NAME_LENGTH) {
    return invalid('ERR_ENTRY_NAME_INVALID', '名称过长（最多 255 个字符）');
  }
  if (FORBIDDEN_NAME_CHARS.test(name)) {
    return invalid('ERR_ENTRY_NAME_INVALID', '名称含有非法字符或路径分隔符');
  }
  if (name === '.' || name === '..') {
    return invalid('ERR_ENTRY_NAME_INVALID', '名称不能是 . 或 ..');
  }
  if (/[ .]$/.test(name)) {
    return invalid('ERR_ENTRY_NAME_INVALID', '名称不能以空格或句点结尾');
  }
  // 保留设备名判定忽略后面的扩展名（"CON.txt" 在 Windows 上同样指向设备）
  const stem = name.split('.')[0];
  if (WINDOWS_DEVICE_NAME.test(stem) || WINDOWS_DEVICE_NAME.test(name)) {
    return invalid('ERR_ENTRY_NAME_INVALID', '名称是系统保留名，请换一个');
  }
  return { ok: true, value: name };
}

/**
 * 校验**项目内相对父目录**。空串代表项目根。
 *
 * 与 `/api/tree` 的 `parseTreeDir` 同构：统一用正斜杠、拒绝 `..`/`.`/空段、
 * 绝对路径、盘符、UNC、反斜杠、NUL。这里额外复用 `validateEntryName` 检查每一段，
 * 因此父目录里出现 `CON` 之类保留名也会在**任何 IO 之前**被拒。
 */
export function validateParentDir(raw: unknown): EntryNameCheck {
  if (typeof raw !== 'string') return invalid('ERR_COMMAND_INVALID', '缺少父目录');
  if (raw.length > MAX_PARENT_DIR_LENGTH) return invalid('ERR_COMMAND_INVALID', '父目录过长');
  if (raw === '') return { ok: true, value: '' };
  if (raw.includes('\0')) return invalid('ERR_COMMAND_INVALID', '父目录含非法字符');
  if (raw.includes('\\')) return invalid('ERR_COMMAND_INVALID', '父目录必须使用正斜杠');
  if (raw.startsWith('/')) return invalid('ERR_COMMAND_INVALID', '不接受绝对路径或 UNC');
  if (/^[A-Za-z]:/.test(raw)) return invalid('ERR_COMMAND_INVALID', '不接受盘符路径');
  const segments = raw.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return invalid('ERR_COMMAND_INVALID', '父目录含空段或相对段');
    }
    const checked = validateEntryName(segment);
    if (!checked.ok) return checked;
  }
  return { ok: true, value: segments.join('/') };
}

/** 合成项目内相对路径；调用方必须保证两段都已通过校验。 */
export function entryRelativePath(parentDir: string, name: string): string {
  return parentDir === '' ? name : `${parentDir}/${name}`;
}

/** 项目内相对路径 → 父目录（根下条目返回 ''）。仅做字符串拆分，不做 IO。 */
export function parentDirOfEntry(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** 项目内相对路径 → 末段名称。 */
export function entryNameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

/** Windows 路径比较：大小写不敏感；POSIX 保持敏感。 */
export function sameEntryPath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** `path` 是否等于 `prefix` 或位于 `prefix` 之下（按路径段比较，不做前缀字符串误判）。 */
export function isEntryUnder(path: string, prefix: string): boolean {
  if (prefix === '') return true;
  if (sameEntryPath(path, prefix)) return true;
  return process.platform === 'win32'
    ? path.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)
    : path.startsWith(`${prefix}/`);
}
