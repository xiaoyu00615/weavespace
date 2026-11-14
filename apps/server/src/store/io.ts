/**
 * ProjectStore 的同步 I/O 端口（UX-02B-02）。
 *
 * 为什么单独抽一层：
 * - 崩溃点必须能被**确定性地**复现（不能靠随机时序或真实断电）。测试通过替换这一层
 *   注入"写 0 字节""写完再报错""rename 失败"，Store 的判定逻辑本身不受污染；
 * - 每个操作的语义边界写死在这里（`appendText` 只 append、`fsyncPath` 只 fsync），
 *   避免上层把"写成功"当成"已持久化"。
 *
 * 不做异步：加载与提交都是本机小文件，同步实现让"提交块内不 await"这条不变式在
 * 类型层面就成立（参见 ADR-022 §4.2 step 2/3）。
 */
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';

export const CONFIG_FILE = 'workspace.json';
export const BACKUP_FILE = 'workspace.json.bak';
export const LOG_FILE = 'revocations.jsonl';
export const LOCK_FILE = 'workspace.lock';

/**
 * I/O 失败。
 *
 * `committedBytes` 是唯一可用于"确认未写入"的证据：
 * - `0`：可以断言一个字节都没落盘（打开失败、写入 0 字节即报错）；
 * - `undefined`、或 >0：**不确定**，必须走证据核对（ADR-022 §3.1.1）。
 */
export class StoreIoError extends Error {
  readonly phase: string;
  readonly committedBytes: number | undefined;

  constructor(phase: string, committedBytes: number | undefined, message?: string) {
    super(message ?? `存储 I/O 操作失败: ${phase}`);
    this.name = 'StoreIoError';
    this.phase = phase;
    this.committedBytes = committedBytes;
  }
}

export interface StoreIo {
  exists(path: string): boolean;
  /** 不存在返回 undefined（把 ENOENT 与"空文件"区分开）。 */
  readText(path: string): string | undefined;
  writeText(path: string, text: string): void;
  /** 仅创建（存在即抛 EEXIST）；用于单实例锁。 */
  createExclusive(path: string, text: string): void;
  appendText(path: string, text: string): void;
  /** 打开并 fsync 该文件；目录在 Windows 上不可 fsync，故意不提供。 */
  fsyncPath(path: string): void;
  rename(from: string, to: string): void;
  copyFile(from: string, to: string): void;
  remove(path: string): void;
  mkdirp(path: string): void;
}

function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

export function createNodeStoreIo(): StoreIo {
  return {
    exists: (path) => existsSync(path),
    readText(path) {
      try {
        return readFileSync(path, 'utf8');
      } catch (err) {
        if (codeOf(err) === 'ENOENT') return undefined;
        throw new StoreIoError('read', undefined, `读取失败: ${codeOf(err) ?? 'unknown'}`);
      }
    },
    writeText(path, text) {
      try {
        writeFileSync(path, text, 'utf8');
      } catch (err) {
        throw new StoreIoError('write', 0, `写入失败: ${codeOf(err) ?? 'unknown'}`);
      }
    },
    createExclusive(path, text) {
      try {
        writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' });
      } catch (err) {
        throw Object.assign(new Error(`独占创建失败: ${codeOf(err) ?? 'unknown'}`), {
          code: codeOf(err),
        });
      }
    },
    appendText(path, text) {
      let fd: number | undefined;
      try {
        fd = openSync(path, 'a');
        const written = writeSync(fd, text);
        if (written !== Buffer.byteLength(text)) {
          // 部分写入：字节数已知但不等于整行 → 结果不确定
          throw new StoreIoError('append-log', written, '日志仅部分写入');
        }
      } catch (err) {
        if (err instanceof StoreIoError) throw err;
        throw new StoreIoError('append-log', undefined, `追加失败: ${codeOf(err) ?? 'unknown'}`);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
    fsyncPath(path) {
      let fd: number | undefined;
      try {
        fd = openSync(path, 'r+');
        fsyncSync(fd);
      } catch (err) {
        throw new StoreIoError('fsync', undefined, `fsync 失败: ${codeOf(err) ?? 'unknown'}`);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
    rename(from, to) {
      try {
        renameSync(from, to);
      } catch (err) {
        throw new StoreIoError('rename-config', 0, `rename 失败: ${codeOf(err) ?? 'unknown'}`);
      }
    },
    copyFile(from, to) {
      try {
        copyFileSync(from, to);
      } catch (err) {
        throw new StoreIoError('backup', undefined, `备份失败: ${codeOf(err) ?? 'unknown'}`);
      }
    },
    remove(path) {
      try {
        rmSync(path, { force: true });
      } catch {
        // 释放/清理失败不影响安全结论：锁与 tmp 都会被下次启动覆盖
      }
    },
    mkdirp(path) {
      mkdirSync(path, { recursive: true });
    },
  };
}
