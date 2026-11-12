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
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SaveResult } from '../contracts/types.ts';
import {
  assertBoundaryStable,
  createRootBoundary,
  isUntrustedResolution,
  mapStorageError,
  resolveInBoundary,
  toStorageError,
  type RootBoundary,
} from './path-safety.ts';

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
}

export interface LocalProviderOptions {
  rootDir: string;
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

export interface StorageProvider {
  readonly providerId: string;
  readonly rootDir: string;
  stat(path: string): Promise<FileStat>;
  read(path: string): Promise<ReadResult>;
  /** expectedVersion=null 表示"仅当不存在时创建"。 */
  writeConditional(path: string, content: string, expectedVersion: string | null): Promise<SaveResult>;
  list(dir?: string): Promise<string[]>;
}

export function contentVersionOf(content: string | Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
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
   * 「允许缺失」的版本读取：仅用于 `writeConditional` 的创建语义
   * （expectedVersion=null 表示“仅当不存在时创建”）。
   *
   * 只有 ENOENT 返回 null；读取失败（EPERM/EACCES/EBUSY…）必须上抛，
   * 否则会把「读不出来」误判成「可以创建」，进而覆盖已存在文件（S4-R2）。
   */
  async function versionIfPresent(absolutePath: string): Promise<string | null> {
    try {
      const buf = await readFile(absolutePath);
      return contentVersionOf(buf);
    } catch (err) {
      if (isMissing(err)) return null;
      throw toStorageError(err);
    }
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

  return {
    providerId: 'local',
    rootDir,

    async stat(path: string): Promise<FileStat> {
      const check = resolveInBoundary(boundary, path);
      if (!check.ok) {
        // 安全拒绝不得伪装成「文件不存在」：必须以可识别错误码抛出（S4-D）
        throw Object.assign(new Error(check.detail), { errorCode: check.errorCode });
      }
      assertBoundaryStable(boundary);

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
      assertBoundaryStable(boundary);

      let buf: Buffer;
      try {
        buf = await readFile(check.absolutePath);
      } catch (err) {
        throw toStorageError(err); // 与 stat 使用同一映射（S4-R2）
      }
      return {
        content: buf.toString('utf8'),
        contentVersion: contentVersionOf(buf),
        encoding: 'utf8',
      };
    },

    async writeConditional(
      path: string,
      content: string,
      expectedVersion: string | null,
    ): Promise<SaveResult> {
      // 全程只使用这一个固定边界；后续不再重新建立边界来决定“根在哪里”
      const check = resolveInBoundary(boundary, path);
      if (!check.ok) {
        return { status: 'FAILED', errorCode: check.errorCode };
      }

      // F06：边界漂移时版本比较没有意义。必须在读取版本/判定冲突之前先确认边界，
      // 否则会在已漂移的根上算出一个普通 CONFLICT，掩盖真正的安全拒绝。
      try {
        assertBoundaryStable(boundary);
      } catch (err) {
        return { status: 'FAILED', errorCode: mapStorageError(err) };
      }

      let currentVersion: string | null;
      try {
        currentVersion = await versionIfPresent(check.absolutePath);
      } catch (err) {
        // 版本无法确认 → 既不能放行覆盖，也不能谎报冲突
        return { status: 'FAILED', errorCode: mapStorageError(err) };
      }

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
        // 边界漂移检查点 ①：mkdir 之前拦截，避免在旧/新任一目标留下目录
        assertBoundaryStable(boundary);

        await mkdir(dirname(check.absolutePath), { recursive: true });

        // mkdir 之后重新解析：新建的目录本身也要逐级校验，且落盘必须用这次的结果
        const afterMkdir = resolveInBoundary(boundary, path);
        if (!afterMkdir.ok) {
          return { status: 'FAILED', errorCode: afterMkdir.errorCode };
        }
        // 边界漂移检查点 ②
        assertBoundaryStable(boundary);

        const absolutePath = afterMkdir.absolutePath;
        tempPath = join(dirname(absolutePath), `.ws-tmp-${process.pid}-${Date.now()}`);
        await writeFile(tempPath, content, 'utf8');

        // 边界漂移检查点 ③：rename 前最后一次确认
        assertBoundaryStable(boundary);
        await rename(tempPath, absolutePath);
      } catch (err) {
        if (tempPath) await rm(tempPath, { force: true }).catch(() => {});
        // EPERM/EACCES → 权限错误；边界漂移 → ERR_PATH_OUTSIDE_ROOT；其余 → 存储 IO
        return { status: 'FAILED', errorCode: mapStorageError(err) };
      }

      const committedVersion = contentVersionOf(content);
      if (faults.afterCommit) {
        try {
          faults.afterCommit();
        } catch {
          // 副作用已落盘但确认链中断：必须报 UNKNOWN，不得报成功或失败（docs/04、CT-06）
          return { status: 'UNKNOWN', errorCode: 'ERR_OUTCOME_UNKNOWN', contentVersion: committedVersion };
        }
      }
      return { status: 'COMMITTED', contentVersion: committedVersion };
    },

    async list(dir = '.'): Promise<string[]> {
      const check = resolveInBoundary(boundary, dir);
      if (!check.ok) {
        throw Object.assign(new Error(check.detail), { errorCode: check.errorCode });
      }
      assertBoundaryStable(boundary);

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
  };
}
