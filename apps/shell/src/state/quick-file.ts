/**
 * Quick File（S11-B）：浏览器本地临时文件的只读模型。
 *
 * 定位：用户**主动选择**的一个本机文件，只用于预览。它
 * - 不属于任何 Project，没有 projectId / resourceId / sessionId；
 * - 不经过 Host、不发 HTTP、不写盘、不改原文件；
 * - 只保留在内存里，刷新页面即消失。
 *
 * 本模块是纯 TS（不依赖 React / DOM），因此可以在 Node 里用真实文件字节
 * 驱动完整生命周期（选择、替换、移除、迟到读取丢弃、格式与大小门禁）。
 */

/** 首版大小上限：2 MiB（读取前检查，不截断、不“部分加载”）。 */
export const QUICK_FILE_MAX_BYTES = 2 * 1024 * 1024;

/** 首版只接受能力注册表已提供查看器的格式。 */
export const QUICK_FILE_EXTENSIONS = ['.md', '.markdown', '.txt'] as const;

export type QuickFileExtension = (typeof QUICK_FILE_EXTENSIONS)[number];

export type QuickFileErrorCode =
  | 'ERR_QUICKFILE_MULTIPLE'
  | 'ERR_QUICKFILE_DIRECTORY'
  | 'ERR_QUICKFILE_UNSUPPORTED_TYPE'
  | 'ERR_QUICKFILE_TOO_LARGE'
  | 'ERR_QUICKFILE_NOT_UTF8'
  | 'ERR_QUICKFILE_READ_FAILED';

/** 一次选择/拖入的候选文件；`isDirectory` 来自 DataTransferItem 的目录标记。 */
export interface QuickFileSource {
  readonly name: string;
  readonly size: number;
  readonly isDirectory?: boolean;
  read(): Promise<ArrayBuffer>;
}

export interface QuickFile {
  /** 会话内自增 id：仅用于让查看器边界在换文件时重建，不是任何持久身份。 */
  readonly id: string;
  readonly name: string;
  readonly extension: QuickFileExtension;
  readonly size: number;
  readonly content: string;
}

export type QuickFileStatus = 'empty' | 'loading' | 'ready' | 'error';

export interface QuickFileState {
  readonly status: QuickFileStatus;
  readonly file: QuickFile | null;
  /** 是否正在工作区展示预览；与"是否持有文件"分开，便于返回文档后仍保留文件。 */
  readonly active: boolean;
  readonly pendingName: string | null;
  readonly errorCode: QuickFileErrorCode | null;
  readonly errorMessage: string | null;
}

export const EMPTY_QUICK_FILE_STATE: QuickFileState = Object.freeze({
  status: 'empty',
  file: null,
  active: false,
  pendingName: null,
  errorCode: null,
  errorMessage: null,
});

const ERROR_MESSAGES: Record<QuickFileErrorCode, string> = {
  ERR_QUICKFILE_MULTIPLE: '一次只能选择或拖入一个文件',
  ERR_QUICKFILE_DIRECTORY: '不支持文件夹：Quick File 只接受单个文件',
  ERR_QUICKFILE_UNSUPPORTED_TYPE: '暂不支持该格式：首版仅提供 .md / .markdown / .txt 预览',
  ERR_QUICKFILE_TOO_LARGE: '文件超过 2 MiB 上限，未读取内容',
  ERR_QUICKFILE_NOT_UTF8: '内容不是可安全预览的 UTF-8 文本（疑似二进制或编码不支持）',
  ERR_QUICKFILE_READ_FAILED: '读取文件失败，未加载任何内容',
};

export function quickFileErrorMessage(code: QuickFileErrorCode): string {
  return ERROR_MESSAGES[code];
}

/** 小写扩展名（含点）；与 `extensionOfPath` 同规则，但只用于 Quick File。 */
export function extensionOfQuickFile(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

export function formatQuickFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export type QuickFileInputCheck =
  | { ok: true; extension: QuickFileExtension }
  | { ok: false; code: QuickFileErrorCode; message: string };

function fail(code: QuickFileErrorCode): { ok: false; code: QuickFileErrorCode; message: string } {
  return { ok: false, code, message: ERROR_MESSAGES[code] };
}

/**
 * 读取前的门禁：目录 → 格式 → 大小。
 *
 * 顺序有意为之：先排除"根本不是单文件"的输入，再排除格式，最后才是体积——
 * 这样超过上限的 .exe 报的是格式错误，不会让用户误以为只是文件太大。
 */
export function checkQuickFileInput(
  input: { name: string; size: number; isDirectory?: boolean },
  options: { maxBytes?: number } = {},
): QuickFileInputCheck {
  if (input.isDirectory) return fail('ERR_QUICKFILE_DIRECTORY');
  const extension = extensionOfQuickFile(input.name);
  if (!(QUICK_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
    return fail('ERR_QUICKFILE_UNSUPPORTED_TYPE');
  }
  const max = options.maxBytes ?? QUICK_FILE_MAX_BYTES;
  if (input.size > max) return fail('ERR_QUICKFILE_TOO_LARGE');
  return { ok: true, extension: extension as QuickFileExtension };
}

/** 与 S5 文本门禁一致的二进制签名（只收录误判风险低的魔数）。 */
const BINARY_SIGNATURES: ReadonlyArray<readonly number[]> = [
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], // png
  [0xff, 0xd8, 0xff], // jpeg
  [0x47, 0x49, 0x46, 0x38], // gif8
  [0x50, 0x4b, 0x03, 0x04], // zip/docx/xlsx
  [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  [0x7f, 0x45, 0x4c, 0x46], // elf
];

const ALLOWED_CONTROL_BYTES = new Set<number>([0x09, 0x0a, 0x0c, 0x0d]);

function looksBinary(bytes: Uint8Array): boolean {
  for (const signature of BINARY_SIGNATURES) {
    if (bytes.length < signature.length) continue;
    if (signature.every((byte, index) => bytes[index] === byte)) return true;
  }
  for (const byte of bytes) {
    if (byte < 0x20 && !ALLOWED_CONTROL_BYTES.has(byte)) return true;
    if (byte === 0x7f) return true;
  }
  return false;
}

export type QuickFileDecodeResult =
  | { ok: true; content: string }
  | { ok: false; code: QuickFileErrorCode; message: string };

/**
 * 严格 UTF-8 解码。绝不产生"有损字符串"：非法字节序列、二进制签名与不安全
 * 控制字节一律拒绝，而不是把 U+FFFD 当成正常文本展示。
 */
export function decodeQuickFileBytes(bytes: ArrayBuffer | Uint8Array): QuickFileDecodeResult {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (looksBinary(view)) return fail('ERR_QUICKFILE_NOT_UTF8');
  try {
    // ignoreBOM:true = 不剥离 BOM（与存储层语义一致，内容原样展示）
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(view);
    return { ok: true, content };
  } catch {
    return fail('ERR_QUICKFILE_NOT_UTF8');
  }
}

let sequence = 0;

export type QuickFileLoadResult =
  | { ok: true; file: QuickFile }
  | { ok: false; code: QuickFileErrorCode; message: string };

/** 校验 → 读取 → 解码。任何一步失败都不会返回半个文件。 */
export async function loadQuickFile(
  source: QuickFileSource,
  options: { maxBytes?: number } = {},
): Promise<QuickFileLoadResult> {
  const checked = checkQuickFileInput(source, options);
  if (!checked.ok) return checked;

  let bytes: ArrayBuffer;
  try {
    bytes = await source.read();
  } catch {
    return fail('ERR_QUICKFILE_READ_FAILED');
  }
  const decoded = decodeQuickFileBytes(bytes);
  if (!decoded.ok) return decoded;

  sequence += 1;
  return {
    ok: true,
    file: {
      id: `quick-${sequence}`,
      name: source.name,
      extension: checked.extension,
      size: source.size,
      content: decoded.content,
    },
  };
}

export interface QuickFileController {
  getState(): QuickFileState;
  subscribe(listener: () => void): () => void;
  /**
   * 选择/拖入文件。`sources` 的长度必须是 1；`directory` 为 true 表示拖入内容里
   * 含有文件夹（浏览器不会把文件夹展开成文件，必须显式拒绝）。
   */
  open(
    sources: readonly QuickFileSource[],
    options?: { directory?: boolean; maxBytes?: number },
  ): Promise<QuickFileState>;
  /** 收起预览但保留当前文件（"返回文档"）。 */
  deactivate(): QuickFileState;
  /** 重新展示当前文件。 */
  activate(): QuickFileState;
  /** 清空当前 Quick File（不触碰磁盘上的原文件）。 */
  remove(): QuickFileState;
}

/**
 * 内存控制器。
 *
 * 迟到读取保护：每次 `open` 递增代次；读取返回时若代次已变，结果整份丢弃，
 * 绝不覆盖用户后来选择的文件（与 G2-R1 的编辑代次同一思路）。
 */
export function createQuickFileController(): QuickFileController {
  let state: QuickFileState = EMPTY_QUICK_FILE_STATE;
  let generation = 0;
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  const setState = (next: QuickFileState): QuickFileState => {
    state = next;
    emit();
    return state;
  };

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async open(sources, options = {}) {
      // 任何新的选择都作废在途读取
      generation += 1;
      const token = generation;

      if (options.directory) {
        return setState({
          ...EMPTY_QUICK_FILE_STATE,
          status: 'error',
          errorCode: 'ERR_QUICKFILE_DIRECTORY',
          errorMessage: ERROR_MESSAGES.ERR_QUICKFILE_DIRECTORY,
        });
      }
      if (sources.length !== 1) {
        return setState({
          ...EMPTY_QUICK_FILE_STATE,
          status: 'error',
          errorCode: 'ERR_QUICKFILE_MULTIPLE',
          errorMessage: ERROR_MESSAGES.ERR_QUICKFILE_MULTIPLE,
        });
      }

      const source = sources[0];
      setState({
        ...EMPTY_QUICK_FILE_STATE,
        status: 'loading',
        pendingName: source.name,
      });

      const result = await loadQuickFile(source, { maxBytes: options.maxBytes });
      if (token !== generation) return state;

      if (!result.ok) {
        return setState({
          ...EMPTY_QUICK_FILE_STATE,
          status: 'error',
          errorCode: result.code,
          errorMessage: result.message,
        });
      }
      return setState({
        status: 'ready',
        file: result.file,
        active: true,
        pendingName: null,
        errorCode: null,
        errorMessage: null,
      });
    },

    deactivate() {
      if (!state.active) return state;
      return setState({ ...state, active: false });
    },

    activate() {
      if (!state.file || state.active) return state;
      return setState({ ...state, active: true });
    },

    remove() {
      generation += 1;
      return setState(EMPTY_QUICK_FILE_STATE);
    },
  };
}
