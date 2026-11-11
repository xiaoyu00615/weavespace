/**
 * 本地 StorageProvider（P0 探针版）。
 *
 * 契约要点（docs/06、docs/08）：
 * - `writeConditional` 是唯一写入原语，必须携带期望版本；
 * - 版本 token 使用内容 SHA-256（探针方案，ADR 未定：见 docs/18 RSK-06）；
 * - 写入采用同目录临时文件 + 替换，失败清理临时文件；
 * - 不把 mtime 当作冲突依据；mtime 仅作为元数据暴露。
 *
 * 本模块不负责编辑会话、冲突呈现或权限判定，那些属于 document / permission。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SaveResult } from '../contracts/types.ts';
import { fileExists, isUntrustedResolution, resolveInsideRoot } from './path-safety.ts';

export interface StorageFaultHooks {
  /** 在落盘前抛出即可模拟磁盘/IO 失败（CT-06）。 */
  beforeCommit?: () => void;
  /** 落盘成功后抛出，用于模拟"副作用已发生但确认丢失"（UNKNOWN，CT-06）。 */
  afterCommit?: () => void;
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

export function createLocalProvider(options: LocalProviderOptions): StorageProvider {
  const rootDir = options.rootDir;
  const faults = options.faults ?? {};

  async function versionAt(absolutePath: string): Promise<string | null> {
    if (!fileExists(absolutePath)) return null;
    const buf = await readFile(absolutePath);
    return contentVersionOf(buf);
  }

  return {
    providerId: 'local',
    rootDir,

    async stat(path: string): Promise<FileStat> {
      const check = resolveInsideRoot(rootDir, path);
      if (!check.ok) {
        // 安全拒绝不得伪装成「文件不存在」：必须以可识别错误码抛出（S4-D）
        throw Object.assign(new Error(check.detail), { errorCode: check.errorCode });
      }
      try {
        const s = await stat(check.absolutePath);
        const version = s.isFile() ? await versionAt(check.absolutePath) : null;
        return { exists: true, size: s.size, mtimeMs: s.mtimeMs, contentVersion: version };
      } catch {
        return { exists: false, size: 0, mtimeMs: 0, contentVersion: null };
      }
    },

    async read(path: string): Promise<ReadResult> {
      const check = resolveInsideRoot(rootDir, path);
      if (!check.ok) {
        throw Object.assign(new Error(check.detail), { errorCode: check.errorCode });
      }
      const buf = await readFile(check.absolutePath);
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
      const check = resolveInsideRoot(rootDir, path);
      if (!check.ok) {
        return { status: 'FAILED', errorCode: check.errorCode };
      }
      const absolutePath = check.absolutePath;

      let currentVersion: string | null;
      try {
        currentVersion = await versionAt(absolutePath);
      } catch {
        return { status: 'FAILED', errorCode: 'ERR_STORAGE_IO' };
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

      const tempPath = join(dirname(absolutePath), `.ws-tmp-${process.pid}-${Date.now()}`);
      try {
        faults.beforeCommit?.();
        await mkdir(dirname(absolutePath), { recursive: true });
        // mkdir 之后重新校验：目录创建可能引入新的重解析点，届时前面的检查已失效（S4-C）
        const afterMkdir = resolveInsideRoot(rootDir, path);
        if (!afterMkdir.ok) {
          return { status: 'FAILED', errorCode: afterMkdir.errorCode };
        }
        await writeFile(tempPath, content, 'utf8');
        await rename(tempPath, absolutePath);
      } catch (err) {
        await rm(tempPath, { force: true }).catch(() => {});
        const errCode = (err as { errorCode?: string }).errorCode;
        const osCode = (err as { code?: string }).code;
        // EACCES/EPERM 必须映射为权限错误码，避免与泛化 IO 故障混淆（CT-05）
        const errorCode: SaveResult['errorCode'] =
          errCode === 'ERR_PATH_OUTSIDE_ROOT'
            ? 'ERR_PATH_OUTSIDE_ROOT'
            : osCode === 'EACCES' || osCode === 'EPERM'
              ? 'ERR_PERMISSION_DENIED'
              : 'ERR_STORAGE_IO';
        return { status: 'FAILED', errorCode };
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
      const check = resolveInsideRoot(rootDir, dir);
      if (!check.ok) {
        throw Object.assign(new Error(check.detail), { errorCode: check.errorCode });
      }
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
