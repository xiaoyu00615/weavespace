/**
 * 本地 StorageProvider（P0 探针版）。
 *
 * 契约要点（docs/06、docs/08）：
 * - `writeConditional` 是唯一写入原语，必须携带期望版本；
 * - 版本 token 使用内容 SHA-256（探针方案，ADR 未定：见 docs/18 RSK-06）；
 * - 写入采用同目录临时文件 + 替换，失败清理临时文件；
 * - 不把 mtime 当作冲突依据；mtime 仅作为元数据暴露。
 *
 * 安全要点（S4-R1）：
 * - 根目录身份在**构造时**固定为 `RootBoundary`，其后 read/stat/list/write 全部复用
 *   同一个边界，不再每次重新 realpath 根目录；
 * - 写入的每一次关键步骤（fault 注入后、mkdir 后、rename 前）都确认边界未漂移。
 *
 * 错误要点（S4-R2）：
 * - 只有 ENOENT 才解释为「目标不存在」；
 * - EPERM/EACCES → `ERR_PERMISSION_DENIED`，其余 I/O 异常（EBUSY 等）→ `ERR_STORAGE_IO`；
 * - 版本读取失败绝不复用「不存在」语义。
 *
 * 本模块不负责编辑会话、冲突呈现或权限判定，那些属于 document / permission。
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SaveResult } from '../contracts/types.ts';
import {
  assertRootContinuity,
  claimRootDirectory,
  createRootBoundary,
  isPathInsideRoot,
  isUntrustedResolution,
  mapStorageError,
  resolveInBoundary,
  rootTokenOf,
  toStorageError,
  type RootBoundary,
  type RootCheckpoint,
} from './path-safety.ts';
import { decodeUtf8Text, encodeUtf8Text, textError } from './text-safety.ts';

/** 统一错误映射在路径安全层实现（避免与 provider 循环依赖），此处转出便于调用方使用。 */
export { mapStorageError } from './path-safety.ts';

export interface StorageFaultHooks {
  /** 在落盘前抛出即可模拟磁盘/IO 失败（CT-06）。 */
  beforeCommit?: () => void;
  /** 落盘成功后抛出，用于模拟"副作用已发生但确认丢失"（UNKNOWN，CT-06）。 */
  afterCommit?: () => void;
  /**
   * 在 `stat()` 已确认目标为普通文件、尚未读取内容版本时执行（F01）。
   * 仅用于测试注入该窗口内的外部删除/替换，验证「存在性」与「版本」不会自相矛盾。
   */
  afterStat?: () => void;
  /**
   * 版本读取得到 ENOENT、尚未重新核验目标类型时执行（F05）。
   * 仅用于测试注入「重新核验前被替换为非普通文件」的窗口。
   */
  beforeReverify?: () => void;
  /**
   * 在写入链路的 C0–C4 检查点**之前**执行（G0-10/G0-11）。
   * 仅用于测试注入"检查与操作之间根被删除/替换"的竞争窗口；
   * 抛错即视为该检查点失败（C0–C3 → FAILED，C4 → UNKNOWN）。
   */
  atCheckpoint?: (checkpoint: RootCheckpoint) => void;
  /**
   * 版本读取完成、尚未据此判定 CONFLICT/继续写入时执行（G0-R1）。
   * 用于确定性注入"版本读取期间根失效"，验证根错误优先于版本冲突。
   */
  afterVersionRead?: () => void;
  /**
   * 单层列目录即将执行 `readdir` 时调用（UX-02B-TREE）。
   *
   * 用途：确定性注入"这个目录读不出来"（`EACCES`/`EPERM`/`EBUSY`），
   * 因为在 Windows 上无法用 `chmod` 造出不可读目录。抛错即视为该目录读取失败，
   * 由 `readDir` 的目录错误映射转成 `ERR_DIR_UNREADABLE`。
   */
  beforeReadDir?: (relativeDir: string) => void;
}

export interface LocalProviderOptions {
  rootDir: string;
  /**
   * Provider 身份（G1-04）。Legacy 缺省 `local`；Multi 由 Host 从 Registry 派生
   * `local:<projectId>`。身份只影响命名空间，不改变任何存储语义——不得为此复制第二套 Provider。
   */
  providerId?: string;
  faults?: StorageFaultHooks;
}

export interface FileStat {
  exists: boolean;
  size: number;
  mtimeMs: number;
  contentVersion: string | null;
}

export interface ReadResult {
  content: string;
  contentVersion: string;
  encoding: 'utf8';
}

/** 单层目录条目类型（UX-02B-TREE 契约 B.3）：只描述事实，不带格式语义。 */
export type DirEntryKind = 'folder' | 'file' | 'link';

export interface DirEntry {
  /** 单段名称，不含路径分隔符。 */
  readonly name: string;
  readonly kind: DirEntryKind;
}

export interface StorageProvider {
  readonly providerId: string;
  readonly rootDir: string;
  stat(path: string): Promise<FileStat>;
  read(path: string): Promise<ReadResult>;
  /** expectedVersion=null 表示"仅当不存在时创建"。 */
  writeConditional(path: string, content: string, expectedVersion: string | null): Promise<SaveResult>;
  list(dir?: string): Promise<string[]>;
  /**
   * 只读**一层**目录（UX-02B-TREE）。
   *
   * 与 `list()` 的区别是语义而非实现细节：`list()` 递归整棵子树、只返回可编辑文本的
   * 相对路径（旧端点 `/api/resources` 依赖它，保持冻结）；`readDir()` 只枚举一层、
   * 返回目录/文件/链接三种事实，空目录正常返回 `[]`。
   *
   * 纪律（契约 B.5 / B.6）：
   * - **不跟随**符号链接与 junction：它们以 `kind: 'link'` 返回，绝不进入；
   * - 读不出来必须上抛 `ERR_DIR_UNREADABLE`，**不得**吞成空数组——
   *   把"读不出来"渲染成"空文件夹"会让用户以为文件丢了；
   * - 不存在返回 `ERR_RESOURCE_NOT_FOUND`，与"存在但为空"严格区分。
   */
  readDir(dir?: string): Promise<DirEntry[]>;
}

export function contentVersionOf(content: string | Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function domainError(errorCode: string, message: string): Error {
  return Object.assign(new Error(message), { errorCode });
}

/**
 * 单层列目录的错误映射（UX-02B-TREE 契约 B.6）。
 *
 * 与写入链路的 `toStorageError` **刻意分开**：那里把 `EPERM/EACCES` 映射成
 * `ERR_PERMISSION_DENIED`（"你没被允许写这里"），而这里必须映射成
 * `ERR_DIR_UNREADABLE`（"这个目录现在读不出来"）——两者是环境事实与策略事实的区别，
 * 混用会让用户去重新授权一个其实已授权的项目，或掩盖一次真实的越权尝试。
 *
 * 错误消息固定为常量文本：绝不携带绝对路径（S-14 / WK-04 的零泄露纪律）。
 */
function toDirError(err: unknown): Error {
  const tagged = (err as { errorCode?: string } | undefined)?.errorCode;
  if (typeof tagged === 'string') return err as Error;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return domainError('ERR_RESOURCE_NOT_FOUND', '目录不存在');
  }
  return domainError('ERR_DIR_UNREADABLE', '目录无法读取');
}

/** 已确认存在后的版本读取重试次数上限（F01：有限次数重新核验，不做无限重试）。 */
const VERSION_READ_ATTEMPTS = 3;

export function createLocalProvider(options: LocalProviderOptions): StorageProvider {
  const rootDir = options.rootDir;
  const faults = options.faults ?? {};

  // 根目录身份在此一次性固定；无法确认（EPERM/EACCES/悬空重解析点…）时直接抛错，
  // 不允许“先建 provider、之后每次操作各自猜边界”。
  const boundary: RootBoundary = createRootBoundary(rootDir);

  /**
   * 根连续性状态（G0-02）。
   * - `null` = INITIALIZABLE：Provider 构造时根不存在，允许首次合法写入创建根；
   * - 非空 = ESTABLISHED：已认领真实根身份；根消失/被替换后一律拒绝，绝不重建。
   */
  let establishedToken: string | null = null;
  if (boundary.verified) {
    try {
      establishedToken = rootTokenOf(boundary.canonicalRoot);
    } catch (err) {
      const code = (err as { errorCode?: string }).errorCode;
      // ino 不可用是"该文件系统无法提供根身份"，保留原码便于诊断（G0-14）
      if (code === 'ERR_ROOT_IDENTITY_UNSUPPORTED') throw err;
      throw Object.assign(
        new Error(`根目录身份无法确认: ${(err as Error).message}`),
        { errorCode: 'ERR_PATH_OUTSIDE_ROOT' as const },
      );
    }
  }

  /**
   * 首次初始化的串行协调（G0-02.6 / G0-07）。
   * 只在"尚未建立根身份"时使用，避免并发首写各自 mkdir 后各自认领；
   * ESTABLISHED 之后不加全局锁，正常并发语义保持不变。
   */
  let initTail: Promise<void> = Promise.resolve();
  async function serializeFirstInit<T>(fn: () => Promise<T>): Promise<T> {
    const previous = initTail;
    let release: () => void = () => {};
    initTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * 读取既有目标：同时给出字节版本与「能否作为文本」的判定（S5-02）。
   *
   * 只有 ENOENT 返回 `exists:false`；读取失败（EPERM/EACCES/EBUSY…）必须上抛，
   * 否则会把「读不出来」误判成「可以创建」，进而覆盖已存在文件（S4-R2）。
   */
  type ExistingTarget =
    | { exists: false }
    | {
        exists: true;
        version: string;
        textFailure: { errorCode: 'ERR_RESOURCE_NOT_TEXT' | 'ERR_ENCODING_UNSUPPORTED'; detail: string } | null;
      };

  async function inspectExisting(absolutePath: string): Promise<ExistingTarget> {
    let buf: Buffer;
    try {
      buf = await readFile(absolutePath);
    } catch (err) {
      if (isMissing(err)) return { exists: false };
      throw toStorageError(err);
    }
    const decoded = decodeUtf8Text(buf);
    return {
      exists: true,
      version: contentVersionOf(buf),
      textFailure: decoded.ok ? null : { errorCode: decoded.errorCode, detail: decoded.detail },
    };
  }

  /**
   * 「已确认存在」的版本读取（F01）。
   *
   * 与 `versionIfPresent` 的语义差别：调用它之前 `stat()` 刚确认过普通文件存在，
   * 所以这里的 ENOENT 不是“允许缺失”，而是与存在性判定矛盾。此时必须有限次数
   * 重新核验，直到取得一致状态：
   * - 重新 stat 确认已消失 → 返回 null（调用方据此返回一致的 exists:false）；
   * - 重新 stat 仍说存在 → 重试读取；多次仍矛盾 → 抛 ERR_STORAGE_IO；
   * - EBUSY/EPERM/EACCES 等其他错误 → 立即上抛（不得当作不存在）。
   */
  async function versionOfConfirmedFile(absolutePath: string): Promise<string | null> {
    for (let attempt = 0; attempt < VERSION_READ_ATTEMPTS; attempt += 1) {
      try {
        const buf = await readFile(absolutePath);
        return contentVersionOf(buf);
      } catch (err) {
        if (!isMissing(err)) throw toStorageError(err);

        faults.beforeReverify?.();
        let again;
        try {
          again = await stat(absolutePath);
        } catch (statErr) {
          if (isMissing(statErr)) return null; // 再次确认已消失：状态一致
          throw toStorageError(statErr);
        }
        if (!again.isFile()) {
          // F05：刚才确认过是普通文件，现在却成了目录/其他类型。
          // 这是「无法确认」，不是「不存在」——不得返回 null 让调用方当作已删除。
          throw Object.assign(
            new Error('目标已由普通文件变为非普通文件，内容版本无法确认'),
            { errorCode: 'ERR_STORAGE_IO' as const },
          );
        }
      }
    }
    throw Object.assign(new Error('目标存在性判定与内容读取持续不一致'), {
      errorCode: 'ERR_STORAGE_IO' as const,
    });
  }

  /**
   * 实际写入链路（G0-03 / G0-04）。
   *
   * C0–C4 是**分阶段检查**，不是原子文件系统事务：检查与随后的系统调用之间仍有
   * 竞争窗口（无 `openat`/目录句柄）。要求是"任何已确认失败都不得留下非授权副作用"，
   * 而不是"绝对不会发生"。窗口内已提交但无法确认时返回 UNKNOWN。
   */
  async function writeEstablished(
    path: string,
    content: string,
    expectedVersion: string | null,
  ): Promise<SaveResult> {
    const checkpoint = (id: RootCheckpoint): void => {
      faults.atCheckpoint?.(id);
    };

    // 全程只使用这一个固定边界；后续不再重新建立边界来决定“根在哪里”
    const check = resolveInBoundary(boundary, path);
    if (!check.ok) {
      return { status: 'FAILED', errorCode: check.errorCode };
    }

    // C0：目标路径解析后、版本读取前。
    // 顺序不可颠倒 —— 根缺失时 assertBoundaryStable 会"锚定现存祖先"而误判通过。
    try {
      checkpoint('C0');
      assertRootContinuity(boundary, establishedToken);
    } catch (err) {
      return { status: 'FAILED', errorCode: mapStorageError(err) };
    }

    // S5-02：先校验「要写入的内容」本身可无损编码（未配对代理项、NUL/控制字节）
    const encoded = encodeUtf8Text(content);
    if (!Buffer.isBuffer(encoded)) {
      return { status: 'FAILED', errorCode: encoded.errorCode };
    }
    const payload = encoded;

    let target: ExistingTarget;
    try {
      target = await inspectExisting(check.absolutePath);
    } catch (err) {
      // 版本无法确认 → 既不能放行覆盖，也不能谎报冲突
      return { status: 'FAILED', errorCode: mapStorageError(err) };
    }

    // 版本读取是异步的，期间根可能失效（G0-R1 缺口 2）。
    // 根错误必须**优先于**版本冲突：否则会把"项目根没了"报成 CONFLICT，
    // 引导用户去做一次注定失败的"用磁盘覆盖草稿"。
    try {
      faults.afterVersionRead?.();
      assertRootContinuity(boundary, establishedToken);
    } catch (err) {
      return { status: 'FAILED', errorCode: mapStorageError(err) };
    }

    // S5-02：已识别的非文本目标一律拒绝覆盖（不得用文本 API 改写二进制/非 UTF-8 文件）
    if (target.exists && target.textFailure) {
      return { status: 'FAILED', errorCode: target.textFailure.errorCode };
    }

    const currentVersion: string | null = target.exists ? target.version : null;

    if (expectedVersion === null) {
      if (currentVersion !== null) {
        return {
          status: 'CONFLICT',
          errorCode: 'ERR_DOCUMENT_VERSION_CONFLICT',
          contentVersion: currentVersion,
        };
      }
    } else if (currentVersion !== expectedVersion) {
      return {
        status: 'CONFLICT',
        errorCode: 'ERR_DOCUMENT_VERSION_CONFLICT',
        contentVersion: currentVersion ?? undefined,
      };
    }

    let tempPath: string | null = null;
    try {
      faults.beforeCommit?.();

      // C1：mkdir 之前。ESTABLISHED 根消失/被替换时绝不允许走到 mkdir（否则就是 D-1 的重建）
      checkpoint('C1');
      assertRootContinuity(boundary, establishedToken);

      // 受控初始化（G0-R1 缺口 1）：必须由本 Provider 逐级非递归创建并当场认领，
      // 绝不能用 recursive mkdir 把"别人已经建好的根"当成自己的。竞争失败即 fail-closed。
      if (establishedToken === null) {
        establishedToken = claimRootDirectory(boundary);
      }

      await mkdir(dirname(check.absolutePath), { recursive: true });

      // mkdir 之后重新解析：新建的目录本身也要逐级校验，且落盘必须用这次的结果
      const afterMkdir = resolveInBoundary(boundary, path);
      if (!afterMkdir.ok) {
        return { status: 'FAILED', errorCode: afterMkdir.errorCode };
      }

      // C2：mkdir 之后、写临时文件之前
      checkpoint('C2');
      assertRootContinuity(boundary, establishedToken);

      const absolutePath = afterMkdir.absolutePath;
      const parentDir = dirname(absolutePath);
      // 目标父目录必须仍在授权根内（重解析点改向时不得把临时文件写到别处）
      if (!isPathInsideRoot(boundary.canonicalRoot, parentDir)) {
        return { status: 'FAILED', errorCode: 'ERR_PATH_OUTSIDE_ROOT' };
      }

      tempPath = join(parentDir, `.ws-tmp-${process.pid}-${Date.now()}`);
      await writeFile(tempPath, payload);

      // C3：最终 rename 之前
      checkpoint('C3');
      assertRootContinuity(boundary, establishedToken);

      await rename(tempPath, absolutePath);
    } catch (err) {
      if (tempPath) await rm(tempPath, { force: true }).catch(() => {});
      // EPERM/EACCES → 权限错误；边界漂移/根身份 → 根错误；其余 → 存储 IO
      return { status: 'FAILED', errorCode: mapStorageError(err) };
    }

    const committedVersion = contentVersionOf(payload);

    // C4：rename 之后、确认提交结果之前。
    // 此处副作用可能已经发生（文件落在提交时的根内），因此只能报 UNKNOWN。
    try {
      checkpoint('C4');
      assertRootContinuity(boundary, establishedToken);
    } catch {
      return { status: 'UNKNOWN', errorCode: 'ERR_OUTCOME_UNKNOWN', contentVersion: committedVersion };
    }

    if (faults.afterCommit) {
      try {
        faults.afterCommit();
      } catch {
        // 副作用已落盘但确认链中断：必须报 UNKNOWN，不得报成功或失败（docs/04、CT-06）
        return { status: 'UNKNOWN', errorCode: 'ERR_OUTCOME_UNKNOWN', contentVersion: committedVersion };
      }
    }
    return { status: 'COMMITTED', contentVersion: committedVersion };
  }

  return {
    providerId: options.providerId ?? 'local',
    rootDir,

    async stat(path: string): Promise<FileStat> {
      const check = resolveInBoundary(boundary, path);
      if (!check.ok) {
        // 安全拒绝不得伪装成「文件不存在」：必须以可识别错误码抛出（S4-D）
        throw Object.assign(new Error(check.detail), { errorCode: check.errorCode });
      }
      // G0-05：已建立根消失后不得返回 exists:false（那是"文件不存在"，不是"根不可用"）
      assertRootContinuity(boundary, establishedToken);

      let s;
      try {
        s = await stat(check.absolutePath);
      } catch (err) {
        // 只有真正的「不存在」才是 exists:false；EPERM/EACCES/EBUSY… 必须抛出
        if (isMissing(err)) {
          return { exists: false, size: 0, mtimeMs: 0, contentVersion: null };
        }
        throw toStorageError(err);
      }

      // 目录等非普通文件没有内容版本：这里的 null 是明确语义，不是“读取失败”
      if (!s.isFile()) {
        return { exists: true, size: s.size, mtimeMs: s.mtimeMs, contentVersion: null };
      }

      // 已确认是普通文件：此后版本必须「有效」或「确认已消失」，
      // 绝不能再出现 exists:true/contentVersion:null 的自相矛盾结果（F01）
      faults.afterStat?.();
      const version = await versionOfConfirmedFile(check.absolutePath);
      if (version === null) {
        // 重新核验后确认目标已消失：返回一致的“不存在”
        return { exists: false, size: 0, mtimeMs: 0, contentVersion: null };
      }
      return { exists: true, size: s.size, mtimeMs: s.mtimeMs, contentVersion: version };
    },

    async read(path: string): Promise<ReadResult> {
      const check = resolveInBoundary(boundary, path);
      if (!check.ok) {
        throw Object.assign(new Error(check.detail), { errorCode: check.errorCode });
      }
      // G0-05：根被删除/替换时必须在读取前失败，不得伪装成"单个文件不存在"
      assertRootContinuity(boundary, establishedToken);

      let buf: Buffer;
      try {
        buf = await readFile(check.absolutePath);
      } catch (err) {
        throw toStorageError(err); // 与 stat 使用同一映射（S4-R2）
      }

      // S5-01/02：文本接口必须严格解码；非法字节或二进制特征一律拒绝，
      // 绝不以 U+FFFD 替换后返回（那会让下一次保存静默破坏原始字节）。
      const decoded = decodeUtf8Text(buf);
      if (!decoded.ok) throw textError(decoded);

      return {
        content: decoded.content,
        contentVersion: contentVersionOf(buf), // 版本仍基于原始磁盘字节
        encoding: 'utf8',
      };
    },

    async writeConditional(
      path: string,
      content: string,
      expectedVersion: string | null,
    ): Promise<SaveResult> {
      // 首次初始化必须串行：两个并发首写不得各自 mkdir 后各自认领根身份（G0-07）
      if (establishedToken === null) {
        return serializeFirstInit(() => writeEstablished(path, content, expectedVersion));
      }
      return writeEstablished(path, content, expectedVersion);
    },

    async list(dir = '.'): Promise<string[]> {
      const check = resolveInBoundary(boundary, dir);
      if (!check.ok) {
        throw Object.assign(new Error(check.detail), { errorCode: check.errorCode });
      }
      // G0-05：根消失时不得静默表现为"普通空目录"
      assertRootContinuity(boundary, establishedToken);

      const out: string[] = [];
      async function walk(absDir: string, prefix: string): Promise<void> {
        // 每一级目录都必须仍是可信解析结果，否则不再深入（S4-C：list 不得穿越链接）
        if (isUntrustedResolution(absDir)) return;
        let entries;
        try {
          entries = await readdir(absDir, { withFileTypes: true });
        } catch {
          return; // 目录不可读：跳过而不是让整个列表失败
        }
        for (const entry of entries) {
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
          // 显式跳过 junction / 符号链接：dirent 是唯一能可靠识别 junction 的通道
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            await walk(join(absDir, entry.name), relPath);
          } else if (entry.isFile()) {
            out.push(relPath);
          }
        }
      }
      await walk(check.absolutePath, '');
      return out.sort();
    },

    /**
     * 只读一层目录（UX-02B-TREE）。
     *
     * `list()` 的语义是"取整棵子树里所有可编辑文本的路径清单"，它无法表达空目录、
     * 无法表达链接、也无法表达"这一层读不出来"。本方法补上这三件事，且**只**做一层。
     */
    async readDir(dir = '.'): Promise<DirEntry[]> {
      const requested = typeof dir === 'string' && dir.length > 0 ? dir : '.';

      // 链接预检（契约 B.5）：必须发生在 resolveInBoundary **之前**。
      // resolveInBoundary 会逐级 realpath 比对，链接因"真实路径 ≠ 字面路径"被它判成越界，
      // 用户只会看到"路径不在允许范围内"，看不出"这是一条链接"。这里只看末段的元数据，
      // 且只在字面形态明显安全时进行（含 `..`/绝对路径/盘符的一律不做这次 peek）。
      const literal = literalPathIfSafe(boundary.canonicalRoot, requested);
      if (literal !== null) {
        try {
          const pre = await lstat(literal);
          if (pre.isSymbolicLink()) throw domainError('ERR_DIR_IS_LINK', '该路径是链接，不展开');
        } catch (err) {
          const tagged = (err as { errorCode?: string } | undefined)?.errorCode;
          if (typeof tagged === 'string') throw err;
          // ENOENT / EACCES 等：交给下面的统一链路给出一致的错误
        }
      }

      const check = resolveInBoundary(boundary, requested);
      if (!check.ok) {
        throw Object.assign(new Error(check.detail), { errorCode: check.errorCode });
      }
      // 与 list() 同一条纪律：根消失时不得静默表现为"普通空目录"
      assertRootContinuity(boundary, establishedToken);

      try {
        const info = await lstat(check.absolutePath);
        // 悬空重解析点也不会走到这里（resolveInBoundary 已判越界），此处是第二道闸
        if (info.isSymbolicLink()) throw domainError('ERR_DIR_IS_LINK', '该路径是链接，不展开');
        if (!info.isDirectory()) throw domainError('ERR_RESOURCE_NOT_FOUND', '该路径不是目录');

        faults.beforeReadDir?.(requested);

        const entries = await readdir(check.absolutePath, { withFileTypes: true });
        const out: DirEntry[] = [];
        for (const entry of entries) {
          // `dirent` 是唯一能可靠识别 Windows junction 的通道（旧 list() 已依赖这一点）
          if (entry.isSymbolicLink()) {
            out.push({ name: entry.name, kind: 'link' });
          } else if (entry.isDirectory()) {
            out.push({ name: entry.name, kind: 'folder' });
          } else {
            // 普通文件，以及管道/设备等非目录条目：一律显示为文件。
            // 静默丢弃会让用户以为"文件丢了"。
            out.push({ name: entry.name, kind: 'file' });
          }
        }
        // 稳定升序；"目录/链接在前"是展示层语义（tree.ts 负责），不在存储层表达
        return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      } catch (err) {
        throw toDirError(err);
      }
    },
  };
}

/**
 * 把一个"形态明显安全的相对路径"拼成字面绝对路径；不安全则返回 null。
 *
 * 这不是授权判定（授权仍由 `resolveInBoundary` 负责），只是决定"要不要做那次链接元数据预检"：
 * 含 `..`、绝对路径、盘符、UNC、NUL、空段的请求一律跳过预检，直接进入正式解析，
 * 避免为了一次诊断性 peek 去触碰根外路径。
 */
function literalPathIfSafe(canonicalRoot: string, requested: string): string | null {
  if (requested.includes('\0')) return null;
  const unified = requested.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) return null;
  const segments = unified.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return join(canonicalRoot, ...segments);
}
