/**
 * 文本安全（S5）：严格 UTF-8 解码、二进制门禁、可无损编码校验。
 *
 * 定位：`StorageProvider.read()` 是 **UTF-8 文本接口**，不是通用二进制读取器。
 * 对无法安全表示为文本的内容必须拒绝，绝不产生“有损字符串”——
 * 否则下一次保存会把替换字符写回磁盘，原始字节永久丢失（S5-01）。
 *
 * 三条规则：
 * 1. 严格解码：`TextDecoder('utf-8', { fatal: true, ignoreBOM: true })`。
 *    注意 `ignoreBOM: true` 的含义是**不剥离 BOM**（BOM 作为 U+FEFF 保留在内容里），
 *    这样 BOM 与 CRLF 在“读取→保存”后字节完全一致。
 * 2. 二进制门禁：NUL、不安全控制字节、常见二进制签名——这是**有限的启发式**，
 *    不是通用二进制识别器；未覆盖的格式仍依赖插件声明与上游授权。
 * 3. 编码校验：写入的 JS 字符串若含未配对 UTF-16 代理项，UTF-8 编码会静默替换为
 *    U+FFFD，必须在写入前拒绝（S5-02 的字符串侧）。
 */
import type { ErrorCode } from '../contracts/errors.ts';

export type TextRejectCode = Extract<ErrorCode, 'ERR_RESOURCE_NOT_TEXT' | 'ERR_ENCODING_UNSUPPORTED'>;

export type TextDecodeResult =
  | { ok: true; content: string }
  | { ok: false; errorCode: TextRejectCode; detail: string };

function reject(errorCode: TextRejectCode, detail: string): { ok: false; errorCode: TextRejectCode; detail: string } {
  return { ok: false, errorCode, detail };
}

/** 已知二进制签名（只收录长度足够、误判风险低的魔数）。 */
const SIGNATURES: ReadonlyArray<{ format: string; bytes: readonly number[] }> = [
  { format: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { format: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { format: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { format: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] }, // docx/xlsx 等容器
  { format: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { format: 'elf', bytes: [0x7f, 0x45, 0x4c, 0x46] },
];

/** 文本中允许出现的控制字节：TAB / LF / FF / CR。 */
const ALLOWED_CONTROLS = new Set<number>([0x09, 0x0a, 0x0c, 0x0d]);

function detectSignature(buf: Uint8Array): string | null {
  for (const sig of SIGNATURES) {
    if (buf.length < sig.bytes.length) continue;
    if (sig.bytes.every((b, i) => buf[i] === b)) return sig.format;
  }
  return null;
}

/** 返回第一个不安全控制字节的值；没有则返回 null。 */
function findUnsafeControlByte(buf: Uint8Array): number | null {
  for (const b of buf) {
    if (b < 0x20 && !ALLOWED_CONTROLS.has(b)) return b; // 含 NUL(0x00)
    if (b === 0x7f) return b;
  }
  return null;
}

function hex2(v: number): string {
  return `0x${v.toString(16).padStart(2, '0')}`;
}

/**
 * 读写共用的字节层判定（F03）：二进制签名 + 不安全控制字节。
 *
 * 读取与写入必须使用同一套规则，否则「读不出来的内容」仍可能由文本接口写出，
 * 或反之——那会让门禁形同虚设。
 */
function screenTextBytes(
  buf: Uint8Array,
): { ok: false; errorCode: TextRejectCode; detail: string } | null {
  const signature = detectSignature(buf);
  if (signature) {
    return { ok: false, errorCode: 'ERR_RESOURCE_NOT_TEXT', detail: `疑似二进制内容（${signature} 签名）` };
  }
  const ctrl = findUnsafeControlByte(buf);
  if (ctrl !== null) {
    return {
      ok: false,
      errorCode: 'ERR_RESOURCE_NOT_TEXT',
      detail: `内容包含不安全控制字节 ${hex2(ctrl)}`,
    };
  }
  return null;
}

/**
 * 把磁盘字节按 UTF-8 文本解读。
 *
 * - 二进制特征（签名/控制字节/NUL）→ `ERR_RESOURCE_NOT_TEXT`
 * - 非法 UTF-8 字节序列 → `ERR_ENCODING_UNSUPPORTED`
 * - 合法 UTF-8（含 BOM、CRLF、字面 U+FFFD）→ 原文返回
 */
export function decodeUtf8Text(buf: Uint8Array): TextDecodeResult {
  const screening = screenTextBytes(buf);
  if (screening) return screening;

  try {
    // ignoreBOM:true = 不剥离 BOM（保留为内容首字符）
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    return { ok: true, content: decoder.decode(buf) };
  } catch {
    return reject('ERR_ENCODING_UNSUPPORTED', '内容不是合法 UTF-8（存在无法解码的字节序列）');
  }
}

/** 返回第一个未配对代理项的索引；没有则返回 -1。 */
export function findUnpairedSurrogate(content: string): number {
  for (let i = 0; i < content.length; i += 1) {
    const code = content.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < content.length ? content.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return i;
      i += 1; // 成对代理项，跳过低位
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return i; // 孤立的低位代理项
    }
  }
  return -1;
}

export interface TextEncodeFailure {
  ok: false;
  errorCode: TextRejectCode;
  detail: string;
}

/**
 * 把要写入的 JS 字符串编码为 UTF-8 字节，并保证可以无损还原。
 *
 * 拒绝：未配对代理项（编码器会静默替换成 U+FFFD）、含不安全控制字节的内容。
 * 允许：BOM（U+FEFF 在正文中）、CRLF、字面 U+FFFD。
 */
export function encodeUtf8Text(content: string): Buffer | TextEncodeFailure {
  const surrogate = findUnpairedSurrogate(content);
  if (surrogate >= 0) {
    return {
      ok: false,
      errorCode: 'ERR_ENCODING_UNSUPPORTED',
      detail: `内容包含未配对的 UTF-16 代理项（索引 ${surrogate}），无法无损编码`,
    };
  }

  const buf = Buffer.from(content, 'utf8');
  // F03：与读取共用同一套字节规则，保证“写进去的内容”一定能被文本接口读回，
  // 且已识别的二进制签名不会经由文本接口被创建或覆盖。
  const screening = screenTextBytes(buf);
  if (screening) return screening;
  return buf;
}

/** 便于调用方抛出的统一错误对象（带注册错误码）。 */
export function textError(failure: TextEncodeFailure | Extract<TextDecodeResult, { ok: false }>): Error {
  return Object.assign(new Error(failure.detail), { errorCode: failure.errorCode });
}
