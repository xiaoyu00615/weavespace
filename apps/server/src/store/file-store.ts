/**
 * 真实 ProjectStore v2（UX-02B-02）。
 *
 * 磁盘权威 = **墓碑日志 ∪ 配置**（ADR-022 §3.2）。内存只是它的一次投影。
 *
 * 两种提交点刻意不同（ADR-022 §4.0）：
 * - 添加/重命名：配置 `rename` 成功即提交 → 失败零变更；
 * - 移除：墓碑 `fsync` 成功即提交 → 之后配置补写失败只降级为
 *   `REVOKED_PENDING_CONFIG`，**不回滚、不重新授权**。
 *
 * 明确的能力边界（不得宣称超出以下范围）：
 * - Windows 上 `fsync(文件)` + `rename` 是"尽可能原子"的落盘，不是事务性文件系统语义；
 *   目录项本身无法 fsync，因此**不保证断电后 rename 一定可见**。这属于已知限制，
 *   而不是"已保证原子性"；
 * - 单实例锁只防同机双写（`workspace.lock`），不是分布式锁；
 * - 本模块不删除/移动任何项目目录内容。
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { ERROR_CODES } from '../../../../packages/contracts/index.ts';
import {
  BACKUP_FILE,
  CONFIG_FILE,
  LOCK_FILE,
  LOG_FILE,
  StoreIoError,
  createNodeStoreIo,
  type StoreIo,
} from './io.ts';
import { parseConfig, serializeConfig, type ConfigRevokedEntry, type ConfigState, type ParsedConfig } from './config.ts';
import { appendRevocation, headerLine, readLog, type LogReadResult } from './revocation-log.ts';
import type {
  ConfigSource,
  OpOutcome,
  StoreIntegrity,
  StoreLoadState,
  StoreRevokeReceipt,
  StoredProjectRecord,
} from './types.ts';

export interface FileStoreOptions {
  /** 托管存储目录（`--workspace-store` 指向的目录）。 */
  readonly dir: string;
  /** 仅测试注入：替换 I/O 层以复现崩溃点。 */
  readonly io?: StoreIo;
  readonly clock?: () => Date;
}

export interface FileProjectStore {
  readonly durability: 'durable';
  load(): readonly StoredProjectRecord[];
  loadState(): StoreLoadState;
  commitAdd(entry: StoredProjectRecord & { readonly opId: string }): Promise<void>;
  commitRename(input: { projectId: string; name: string; opId: string }): Promise<void>;
  commitRevoke(input: { projectId: string; opId: string }): Promise<StoreRevokeReceipt>;
  queryOp(opId: string): OpOutcome;
  /** 供 Runtime 在"持久化成功但内存提交失败"时降级（ADR-022 §4.4）。 */
  markDegraded(reason: string): void;
  close(): void;
}

function domainError(errorCode: string, message: string, extra?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { errorCode, ...extra });
}

function commitError(commitState: 'not-committed' | 'unknown', cause: unknown): Error {
  return Object.assign(
    new Error(commitState === 'not-committed' ? '撤销未被持久化（确认未写入）' : '撤销写入结果不确定'),
    {
      errorCode: commitState === 'not-committed' ? ERROR_CODES.ERR_PERSIST_FAILED : ERROR_CODES.ERR_PROJECT_REVOKE_UNKNOWN,
      commitState,
      cause,
    },
  );
}

export function createFileProjectStore(options: FileStoreOptions): FileProjectStore {
  const io = options.io ?? createNodeStoreIo();
  const clock = options.clock ?? (() => new Date());
  const dir = resolve(options.dir);

  const CONFIG_PATH = join(dir, CONFIG_FILE);
  const BACKUP_PATH = join(dir, BACKUP_FILE);
  const LOG_PATH = join(dir, LOG_FILE);
  const LOCK_PATH = join(dir, LOCK_FILE);

  io.mkdirp(dir);

  // ---- 单实例锁（先于任何读写，避免两个写者交错）----
  const lockToken = acquireLock();

  let closed = false;
  let state: StoreLoadState;
  let current: ConfigState;
  let projects: readonly StoredProjectRecord[];

  function acquireLock(): string {
    const token = randomUUID();
    const payload = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      startedAt: clock().toISOString(),
      token,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        io.createExclusive(LOCK_PATH, payload);
        return token;
      } catch {
        const existing = io.readText(LOCK_PATH);
        if (!isStaleLock(existing)) {
          throw domainError(ERROR_CODES.ERR_STORE_LOCKED, '另一个 Host 正在写同一份工作区存储');
        }
        // 陈旧锁（持有进程已不存在 / 内容不可解析 / 文件刚被删除）→ 接管
        io.remove(LOCK_PATH);
      }
    }
    throw domainError(ERROR_CODES.ERR_STORE_LOCKED, '无法获取工作区存储锁');
  }

  function isStaleLock(text: string | undefined): boolean {
    if (text === undefined) return true;
    try {
      const parsed = JSON.parse(text) as { pid?: unknown };
      const pid = parsed.pid;
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return true;
      if (pid === process.pid) return false;
      try {
        process.kill(pid, 0);
        return false;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ESRCH';
      }
    } catch {
      return true;
    }
  }

  function releaseLock(): void {
    const text = io.readText(LOCK_PATH);
    if (text === undefined) return;
    try {
      const parsed = JSON.parse(text) as { token?: unknown };
      if (parsed.token === lockToken) io.remove(LOCK_PATH);
    } catch {
      io.remove(LOCK_PATH);
    }
  }

  // ---- 配置读写 ----

  function readPrimary(): ParsedConfig | undefined {
    const text = io.readText(CONFIG_PATH);
    return text === undefined ? undefined : parseConfig(text);
  }

  function readBackup(): ParsedConfig | undefined {
    const text = io.readText(BACKUP_PATH);
    return text === undefined ? undefined : parseConfig(text);
  }

  /**
   * 原子写：tmp → fsync(tmp) → 备份当前主文件 → rename。
   *
   * 顺序按 ADR-022 §3.1 step 3：备份在 rename 之前，所以 `.bak` 永远是**上一份**
   * 已被替换的配置，而不是"新配置的副本"。
   */
  function writeConfigAtomic(next: ConfigState): void {
    const tmp = `${CONFIG_PATH}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
    try {
      io.writeText(tmp, serializeConfig(next));
      io.fsyncPath(tmp);
      if (io.exists(CONFIG_PATH)) io.copyFile(CONFIG_PATH, BACKUP_PATH);
      io.rename(tmp, CONFIG_PATH);
    } catch (err) {
      io.remove(tmp);
      throw err;
    }
  }

  function materializeLogHeader(): void {
    io.appendText(LOG_PATH, headerLine());
    io.fsyncPath(LOG_PATH);
  }

  function toRecord(project: ConfigState['projects'][number]): StoredProjectRecord {
    return {
      projectId: project.projectId,
      name: project.name,
      rootDir: project.rootDir,
      ...(project.canonicalRoot ? { canonicalRoot: project.canonicalRoot } : {}),
      ...(project.rootToken ? { rootToken: project.rootToken } : {}),
      ...(project.grantedAt ? { grantedAt: project.grantedAt } : {}),
      ...(project.grantSource ? { grantSource: project.grantSource } : {}),
      ...(project.createdByOp ? { createdByOp: project.createdByOp } : {}),
    };
  }

  /**
   * 加载与恢复（ADR-022 §3.2 的完整判定矩阵）。
   *
   * 顺序不可调换：先判配置来源，再判日志可证性，最后才决定"能不能授权"。
   * **配置 checksum 通过不足以授权**——它无法证明撤销集合完整。
   */
  function loadFromDisk(): { projects: readonly StoredProjectRecord[]; config: ConfigState; state: StoreLoadState } {
    const primaryText = io.readText(CONFIG_PATH);
    const backupText = io.readText(BACKUP_PATH);
    const logText = io.readText(LOG_PATH);

    const primary = primaryText === undefined ? undefined : parseConfig(primaryText);
    const backup = primary === undefined && backupText !== undefined ? parseConfig(backupText) : undefined;
    const parsed = primary ?? backup;
    const configSource: ConfigSource = primary ? 'primary' : backup ? 'backup' : 'none';
    const notes: string[] = [];

    // ---- 首次初始化：配置与日志都不存在（该判定独立于其它分支）----
    if (primaryText === undefined && backupText === undefined && logText === undefined) {
      const initial: ConfigState = { version: 2, commitSeq: 0, issuedIds: [], revoked: [], projects: [] };
      writeConfigAtomic(initial);
      materializeLogHeader();
      return {
        projects: [],
        config: initial,
        state: {
          integrity: 'OK',
          diskTrusted: true,
          mutationsAllowed: true,
          log: 'created',
          configSource: 'primary',
          commitSeq: 0,
          notes: ['首次初始化：已写入空配置与日志头'],
        },
      };
    }

    const log = readLog(logText);
    let logStatus: StoreLoadState['log'] = log.status;
    const commitSeq = parsed?.state.commitSeq ?? 0;
    const configRevoked: readonly ConfigRevokedEntry[] = parsed?.state.revoked ?? [];
    const coldStart = parsed !== undefined && commitSeq === 0 && configRevoked.length === 0;

    // 存在但为空的日志文件：内容已丢失，只有冷启动可以安全补头
    const logIsEmptyFile = log.status === 'ok' && !log.hasHeader;
    if (logIsEmptyFile && !coldStart) {
      logStatus = 'broken';
      notes.push('撤销日志文件存在但内容为空（内容丢失）');
    }

    let integrity: StoreIntegrity = 'RECOVERY_RESTRICTED';
    let diskTrusted = false;
    let mutationsAllowed = false;

    if (!parsed) {
      notes.push('配置不可用：主文件与备份均无法校验');
    } else if (logStatus === 'missing') {
      if (coldStart) {
        materializeLogHeader();
        logStatus = 'created';
        diskTrusted = true;
        mutationsAllowed = true;
        integrity = 'OK';
        notes.push('冷启动：无撤销历史，已重建日志头');
      } else {
        notes.push('撤销日志缺失，且配置声称存在变更历史：撤销集合不可证');
      }
    } else if (logStatus === 'broken') {
      notes.push(`撤销日志不可信：${log.reason ?? '未知原因'}`);
    } else {
      // 日志可读：核对它与配置的序号关系
      const maxRevokedSeq = configRevoked.reduce((max, entry) => Math.max(max, entry.revokedAtSeq), 0);
      if (maxRevokedSeq > log.lastSeq) {
        notes.push('配置声明的撤销在日志中不存在：撤销集合不可证');
      } else if (log.lastSeq > commitSeq + 1) {
        notes.push(`日志序号(${log.lastSeq})领先配置(${commitSeq})超过一个，无法解释`);
      } else {
        diskTrusted = true;
        if (logIsEmptyFile) {
          materializeLogHeader();
          logStatus = 'created';
        }
        if (configSource === 'backup') {
          integrity = 'RECOVERY_RESTRICTED';
          mutationsAllowed = false;
          notes.push('主配置损坏，已回落备份：按日志并集恢复读写，禁止变更');
        } else {
          integrity = 'OK';
          mutationsAllowed = true;
          if (log.lastSeq === commitSeq + 1) notes.push('墓碑领先配置一个序号（REVOKED_PENDING_CONFIG），按墓碑补齐');
        }
      }
    }

    // ---- 撤销集合 = 日志前缀 ∪ config.revoked[]（墓碑压倒一切）----
    const revokedIds = new Set<string>();
    for (const entry of configRevoked) revokedIds.add(entry.projectId);
    for (const entry of log.entries) revokedIds.add(entry.projectId);

    const sourceProjects = parsed?.state.projects ?? [];
    const visible = sourceProjects
      .filter((project) => !revokedIds.has(project.projectId))
      .map((project) => toRecord(project));

    const issuedIds = new Set<string>(parsed?.state.issuedIds ?? []);
    for (const id of revokedIds) issuedIds.add(id);
    for (const project of visible) issuedIds.add(project.projectId);

    const config: ConfigState = {
      version: 2,
      commitSeq,
      issuedIds: [...issuedIds],
      revoked: configRevoked,
      projects: visible.map((project) => ({
        projectId: project.projectId,
        name: project.name,
        rootDir: project.rootDir,
        ...(project.canonicalRoot ? { canonicalRoot: project.canonicalRoot } : {}),
        ...(project.rootToken ? { rootToken: project.rootToken } : {}),
        ...(project.grantedAt ? { grantedAt: project.grantedAt } : {}),
        ...(project.grantSource ? { grantSource: project.grantSource } : {}),
        ...(project.createdByOp ? { createdByOp: project.createdByOp } : {}),
      })),
    };

    return {
      projects: visible,
      config,
      state: { integrity, diskTrusted, mutationsAllowed, log: logStatus, configSource, commitSeq, notes },
    };
  }

  const loaded = loadFromDisk();
  state = loaded.state;
  current = loaded.config;
  projects = loaded.projects;

  function assertOpen(): void {
    if (closed) throw domainError(ERROR_CODES.ERR_COMMAND_INVALID, 'Store 已关闭');
  }

  function assertMutationsAllowed(): void {
    if (!state.mutationsAllowed || !state.diskTrusted) {
      throw domainError(ERROR_CODES.ERR_STORE_RESTRICTED, '存储处于受限状态，禁止变更（需重启或人工修复）');
    }
  }

  function assertProjectKnown(projectId: string): ConfigState['projects'][number] {
    const project = current.projects.find((entry) => entry.projectId === projectId);
    if (!project) throw domainError(ERROR_CODES.ERR_PROJECT_NOT_FOUND, `未注册的项目: ${projectId}`);
    return project;
  }

  function applyConfig(next: ConfigState): void {
    current = next;
    projects = next.projects.map((project) => toRecord(project));
  }

  return {
    durability: 'durable',

    load() {
      assertOpen();
      return projects;
    },

    loadState() {
      return state;
    },

    async commitAdd(entry) {
      assertOpen();
      assertMutationsAllowed();
      if (current.issuedIds.includes(entry.projectId) || current.projects.some((p) => p.projectId === entry.projectId)) {
        // id 一旦签发（含已撤销）就永不复用；调用方必须重新签发
        throw domainError(ERROR_CODES.ERR_STORE_ID_REUSED, `projectId 已签发过，不得复用: ${entry.projectId}`);
      }
      const next: ConfigState = {
        version: 2,
        commitSeq: current.commitSeq + 1,
        issuedIds: [...current.issuedIds, entry.projectId],
        revoked: current.revoked,
        projects: [
          ...current.projects,
          {
            projectId: entry.projectId,
            name: entry.name,
            rootDir: entry.rootDir,
            ...(entry.canonicalRoot ? { canonicalRoot: entry.canonicalRoot } : {}),
            ...(entry.rootToken ? { rootToken: entry.rootToken } : {}),
            grantedAt: entry.grantedAt ?? clock().toISOString(),
            // 02B-03 起由本机选择器提供真实来源；本轮只有内部测试接线
            grantSource: entry.grantSource ?? 'unspecified',
            createdByOp: entry.opId,
          },
        ],
      };
      writeConfigAtomic(next);
      applyConfig(next);
      state = { ...state, commitSeq: next.commitSeq };
    },

    async commitRename(input) {
      assertOpen();
      assertMutationsAllowed();
      const project = assertProjectKnown(input.projectId);
      const next: ConfigState = {
        version: 2,
        commitSeq: current.commitSeq + 1,
        issuedIds: current.issuedIds,
        revoked: current.revoked,
        projects: current.projects.map((entry) =>
          entry.projectId === input.projectId ? { ...project, name: input.name } : entry,
        ),
      };
      writeConfigAtomic(next);
      applyConfig(next);
      state = { ...state, commitSeq: next.commitSeq };
    },

    async commitRevoke(input) {
      assertOpen();
      assertMutationsAllowed();
      assertProjectKnown(input.projectId);

      const logNow: LogReadResult = readLog(io.readText(LOG_PATH));
      const seq = Math.max(current.commitSeq, logNow.status === 'ok' ? logNow.lastSeq : 0) + 1;

      // ---- step 1：墓碑 + fsync（提交点）----
      try {
        appendRevocation(io, {
          dir,
          seq,
          projectId: input.projectId,
          opId: input.opId,
          at: clock().toISOString(),
          prevHash: logNow.lastHash,
          needsHeader: !logNow.hasHeader,
        });
      } catch (err) {
        const definitelyNotWritten = err instanceof StoreIoError && err.committedBytes === 0;
        if (definitelyNotWritten) throw commitError('not-committed', err);

        // 结果不确定：只能核对日志尾部（ADR-022 §3.1.1）
        const verify = readLog(io.readText(LOG_PATH));
        if (verify.status === 'ok' && verify.entries.some((entry) => entry.opId === input.opId)) {
          // 已落盘 → 继续提交
        } else if (verify.status === 'ok') {
          throw commitError('not-committed', err);
        } else {
          state = {
            ...state,
            integrity: 'RECOVERY_RESTRICTED',
            diskTrusted: false,
            mutationsAllowed: false,
            notes: [...state.notes, '撤销写入结果无法判定：禁止全部磁盘访问'],
          };
          throw commitError('unknown', err);
        }
      }

      // ---- step 3：补写配置（失败不回滚）----
      const next: ConfigState = {
        version: 2,
        commitSeq: seq,
        issuedIds: current.issuedIds,
        revoked: [...current.revoked, { projectId: input.projectId, revokedAtSeq: seq, opId: input.opId }],
        projects: current.projects.filter((project) => project.projectId !== input.projectId),
      };
      try {
        writeConfigAtomic(next);
        applyConfig(next);
        state = { ...state, commitSeq: seq };
        return { configPersisted: true };
      } catch {
        // 墓碑已生效：内存按已撤销推进，磁盘留给下次启动按墓碑补齐
        applyConfig(next);
        state = {
          ...state,
          integrity: 'DEGRADED',
          mutationsAllowed: false,
          notes: [...state.notes, '撤销已生效但配置补写失败（REVOKED_PENDING_CONFIG）'],
        };
        return { configPersisted: false };
      }
    },

    queryOp(opId) {
      // 只读磁盘：重启前后结论一致（ADR-022 §7.1）
      const primary = readPrimary();
      const parsed = primary ?? readBackup();
      if (parsed) {
        if (parsed.state.projects.some((project) => project.createdByOp === opId)) return 'created';
        if (parsed.state.revoked.some((entry) => entry.opId === opId)) return 'revoked';
      }
      const log = readLog(io.readText(LOG_PATH));
      if (log.status === 'ok' && log.entries.some((entry) => entry.opId === opId)) return 'revoked';
      return 'unknown';
    },

    markDegraded(reason) {
      state = {
        ...state,
        integrity: 'DEGRADED',
        mutationsAllowed: false,
        notes: [...state.notes, reason],
      };
    },

    close() {
      if (closed) return;
      closed = true;
      releaseLock();
    },
  };
}
