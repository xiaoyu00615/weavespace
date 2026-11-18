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
import { sameEntryPath } from '../../../../packages/storage/entry-name.ts';
import {
  BACKUP_FILE,
  CONFIG_FILE,
  LOCK_FILE,
  LOG_FILE,
  StoreIoError,
  createNodeStoreIo,
  type StoreIo,
} from './io.ts';
import {
  MAX_HIDDEN_ENTRIES,
  parseConfig,
  serializeConfig,
  type ConfigHiddenEntry,
  type ConfigRevokedEntry,
  type ConfigState,
  type ParsedConfig,
} from './config.ts';
import { appendRevocation, headerLine, readLog, type LogReadResult } from './revocation-log.ts';
import type {
  ConfigSource,
  OpEvidence,
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

/**
 * 允许落盘的授权来源；只有 `os-dialog`（本机选择器）会被 Runtime 当作可信凭据。
 * 未知来源一律拒绝写入，避免"某种字符串"被误读成授权。
 */
const KNOWN_GRANT_SOURCES: readonly string[] = ['os-dialog', 'unspecified'];

export interface FileProjectStore {
  readonly durability: 'durable';
  load(): readonly StoredProjectRecord[];
  loadState(): StoreLoadState;
  /** 历史签发集合（含已撤销）：Runtime 重启时继承，保证 id 不复用。 */
  issuedIds(): readonly string[];
  commitAdd(entry: StoredProjectRecord & { readonly opId: string }): Promise<void>;
  commitRename(input: { projectId: string; name: string; opId: string }): Promise<void>;
  commitRevoke(input: { projectId: string; opId: string }): Promise<StoreRevokeReceipt>;
  /**
   * 该项目的隐藏记录（只读内存投影，按路径升序）。
   *
   * 只返回属于**现存项目**的记录：项目被撤销后其记录不再对外可见
   * （撤销时也会从配置里清掉，这里兜住"墓碑已生效、配置尚未补写"的中间态）。
   */
  hiddenOf(projectId: string): readonly ConfigHiddenEntry[];
  /**
   * 写入 / 删除一条隐藏记录（UX-02C-03-P1）。
   *
   * 语义：
   * - `hidden: true` → 存在同路径记录时**替换身份**（幂等），否则追加；
   * - `hidden: false` → 删除该路径的记录（不存在则 no-op）；
   * - 内容没有变化时**不写盘、不推进 `commitSeq`**，返回 `changed: false`。
   *
   * 失败语义：配置写入是唯一的提交点，写不进去就抛 `ERR_PERSIST_FAILED`，
   * 内存投影保持原样 —— 绝不出现"接口说成功、重启后记录没了"。
   */
  commitHidden(input: {
    projectId: string;
    path: string;
    rootToken?: string;
    identity?: string;
    hidden: boolean;
    at?: string;
  }): Promise<{ changed: boolean }>;
  queryOp(opId: string): OpOutcome;
  /** 证据 + 归属（只读磁盘）：`unknown` 时归属恒为 `null`。 */
  opEvidence(opId: string): OpEvidence;
  /**
   * 该 `opId` 是否已被持久证据占用（添加的 `createdByOp` 或撤销墓碑）。
   *
   * `opId` 是事务身份，不是可复用的关联字段：同一个编号不得代表两次变更。
   */
  opIdUsed(opId: string): boolean;
  /** 供 Runtime 在"持久化成功但内存提交失败"时降级（ADR-022 §4.4）。 */
  markDegraded(reason: string): void;
  close(): void;
}

function domainError(errorCode: string, message: string, extra?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { errorCode, ...extra });
}

/**
 * 配置里每一条撤销都必须在日志里有**同一行**的证据（projectId + opId + seq）。
 *
 * 只比较"日志最大序号"是不够的：日志被截断成"表头 + 较早的几条墓碑"时，
 * 最大序号可能仍然覆盖配置声明的最晚撤销，但中间/末尾的证据已经没了。
 * 反方向不做要求——墓碑允许领先配置一个序号（配置补写失败时的合法滞后）。
 */
function unmatchedRevocations(
  revoked: readonly ConfigRevokedEntry[],
  log: LogReadResult,
): ConfigRevokedEntry[] {
  if (revoked.length === 0) return [];
  if (log.status !== 'ok') return [...revoked];
  const present = new Set(log.entries.map((entry) => `${entry.seq}\u0000${entry.projectId}\u0000${entry.opId}`));
  return revoked.filter((entry) => !present.has(`${entry.revokedAtSeq}\u0000${entry.projectId}\u0000${entry.opId}`));
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
  function loadFromDisk(): {
    projects: readonly StoredProjectRecord[];
    config: ConfigState;
    state: StoreLoadState;
    logLastSeq: number;
  } {
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
      const initial: ConfigState = {
        version: 3,
        commitSeq: 0,
        issuedIds: [],
        revoked: [],
        projects: [],
        hidden: [],
      };
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
        logLastSeq: 0,
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
      // 日志可读：逐条核对配置声明的撤销是否都有对应墓碑（projectId + opId + seq）
      const unmatched = unmatchedRevocations(configRevoked, log);
      if (unmatched.length > 0) {
        notes.push(
          `配置声明的 ${unmatched.length} 条撤销在日志中缺少对应墓碑（projectId/opId/seq 不匹配）：撤销集合不可证`,
        );
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

    // 隐藏记录只保留"仍然存在的项目"：已撤销项目的记录在投影里直接丢弃，
    // 既不会让旧项目复活，也不会让配置在下次写入前一直带着无效条目。
    const hidden = (parsed?.state.hidden ?? []).filter(
      (entry) => !revokedIds.has(entry.projectId) && visible.some((project) => project.projectId === entry.projectId),
    );

    const config: ConfigState = {
      version: 3,
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
      hidden,
    };

    return {
      projects: visible,
      config,
      state: { integrity, diskTrusted, mutationsAllowed, log: logStatus, configSource, commitSeq, notes },
      // 已验证的日志前缀（加载期看到的最后一行），运行期只允许往前走
      logLastSeq: log.status === 'ok' ? log.lastSeq : 0,
    };
  }

  const loaded = loadFromDisk();
  state = loaded.state;
  current = loaded.config;
  projects = loaded.projects;
  /**
   * 运行期已确认过的日志前缀上界：日志只允许增长，任何回退都是证据丢失。
   * 仅靠"日志最大序号与配置对账"抓不到这种情况（截断后配置仍可能自洽）。
   */
  let verifiedLastSeq = loaded.logLastSeq;

  function assertOpen(): void {
    if (closed) throw domainError(ERROR_CODES.ERR_COMMAND_INVALID, 'Store 已关闭');
  }

  /** 进入不可证状态：全局拒盘 + 禁止变更（不重建日志、不覆盖任何证据）。 */
  function enterRestricted(reason: string): void {
    state = {
      ...state,
      integrity: 'RECOVERY_RESTRICTED',
      diskTrusted: false,
      mutationsAllowed: false,
      notes: [...state.notes, reason],
    };
  }

  function restrict(reason: string): never {
    enterRestricted(reason);
    throw domainError(ERROR_CODES.ERR_STORE_RESTRICTED, reason);
  }

  /**
   * 读取撤销日志；I/O 不可完成时返回 `undefined`。
   *
   * **读取失败不等价于"没有日志"或"没有撤销"**：把它当成空结果，正是
   * "证据已经读不到、却继续往后追加"的入口。调用方必须据此进入不可证状态。
   * 注意错误信息里不带本机路径（StoreIoError 只记录阶段与错误码）。
   */
  function readLogSafe(): LogReadResult | undefined {
    let text: string | undefined;
    try {
      text = io.readText(LOG_PATH);
    } catch {
      return undefined;
    }
    return readLog(text);
  }

  /**
   * 写入前的日志可信性复核（P0-03 / R2 / R3）。
   *
   * 加载时可信不代表写入时仍可信：进程运行期间日志可能被删除、截断或改写。
   * 先复核再提交，避免"用一条伪造的完整链"覆盖掉丢失的撤销历史。
   *
   * 四条独立的证据检查（缺一不可）：
   * 1. 日志**能被读到**（读取抛错 → 不可证，不得当成空日志）；
   * 2. 日志本身可读（缺失/空文件/断裂 → 不可证）；
   * 3. 日志前缀不得回退到运行期已确认的位置之下；
   * 4. `config.revoked[]` 的每一条都要在日志里有 projectId + opId + seq 完全对应的墓碑。
   *
   * 只有**从未发生过事务**（`commitSeq === 0` 且无撤销）时，日志缺失/空文件才等价于
   * 首次初始化，允许补写日志头；一旦有历史，缺失/断裂/截断一律 fail-closed。
   */
  function revalidateLog(): LogReadResult {
    const log = readLogSafe();
    if (!log) restrict('写入前复核失败：撤销日志无法读取，拒绝继续提交');
    const hasHistory = current.commitSeq > 0 || current.revoked.length > 0;
    const emptyFile = log.status === 'ok' && !log.hasHeader;
    const lost = log.status === 'missing' && hasHistory;
    const corrupt = log.status === 'broken' || (emptyFile && hasHistory);

    if (lost || corrupt) restrict('写入前复核失败：撤销日志缺失或不可信，拒绝继续提交');

    // 前缀回退：日志只能增长。截断到表头（或丢掉尾部）都没有证据支持
    if (log.lastSeq < verifiedLastSeq) {
      restrict(
        `写入前复核失败：撤销日志前缀回退（已确认到 ${verifiedLastSeq}，当前只有 ${log.lastSeq}），拒绝继续提交`,
      );
    }

    // 逐条对账：截断成"表头 + 较早的墓碑"时，最大序号仍可能自洽，但证据已缺失
    const unmatched = unmatchedRevocations(current.revoked, log);
    if (unmatched.length > 0) {
      restrict(
        `写入前复核失败：配置声明的 ${unmatched.length} 条撤销在日志中缺少对应墓碑，拒绝继续提交`,
      );
    }

    // 日志领先配置超过一个序号：无法解释为"上一次移除的已知滞后"，按不一致处理
    if (log.lastSeq > current.commitSeq + 1) {
      restrict('写入前复核失败：撤销日志与配置序号不一致，拒绝写入');
    }

    if (log.status === 'missing' || emptyFile) {
      // 仅无历史事务的冷启动会走到这里：重建日志头不等于伪造证据
      materializeLogHeader();
      return { ...log, status: 'ok', hasHeader: true };
    }
    return log;
  }

  function assertMutationsAllowed(): LogReadResult {
    if (!state.mutationsAllowed || !state.diskTrusted) {
      throw domainError(ERROR_CODES.ERR_STORE_RESTRICTED, '存储处于受限状态，禁止变更（需重启或人工修复）');
    }
    return revalidateLog();
  }

  function assertProjectKnown(projectId: string): ConfigState['projects'][number] {
    const project = current.projects.find((entry) => entry.projectId === projectId);
    if (!project) throw domainError(ERROR_CODES.ERR_PROJECT_NOT_FOUND, `未注册的项目: ${projectId}`);
    return project;
  }

  /**
   * `opId` 的唯一归属（R1-02）。
   *
   * 依次在"配置里已登记的添加事务"、"配置里已声明的撤销"、"日志里的墓碑"里找。
   * 三处都要查：配置补写失败时墓碑只存在于日志，重启后仍必须认出这个编号被用过。
   */
  function opClaimant(
    opId: string,
    logNow?: LogReadResult,
  ): { projectId: string; kind: 'created' | 'revoked' } | null {
    const created = current.projects.find((project) => project.createdByOp === opId);
    if (created) return { projectId: created.projectId, kind: 'created' };
    const revoked = current.revoked.find((entry) => entry.opId === opId);
    if (revoked) return { projectId: revoked.projectId, kind: 'revoked' };
    const log = logNow ?? readLogSafe();
    if (log && log.status === 'ok') {
      const tomb = log.entries.find((entry) => entry.opId === opId);
      if (tomb) return { projectId: tomb.projectId, kind: 'revoked' };
    }
    return null;
  }

  /** `opId` 已被占用：明确拒绝（零变更），绝不能被当成"可重试的持久化失败"。 */
  function opConflictError(
    opId: string,
    claimant: { projectId: string; kind: 'created' | 'revoked' },
  ): Error {
    return Object.assign(
      new Error(
        `操作编号 ${opId} 已被项目 ${claimant.projectId} 的${claimant.kind === 'created' ? '添加' : '撤销'}事务占用`,
      ),
      { errorCode: ERROR_CODES.ERR_OP_ID_CONFLICT, opConflict: true },
    );
  }

  /**
   * 只读磁盘上的 `opId` 证据 + 归属（ADR-022 §7.1 / R1-02）。
   *
   * 结论必须**跨进程一致**：因此只看磁盘（配置主副 + 撤销日志），不看任何内存态。
   * 没有证据时归属恒为 `null`——绝不按"项目现在还在不在"猜归属或猜结果。
   *
   * 读不到磁盘时同样返回 `unknown`（"没有可核对的证据"），**不抛**：这个方法
   * 也会被撤销前的预检调用，抛出去会把"存储受限"变成一次莫名其妙的 I/O 异常。
   * 真正的 fail-closed 仍然发生在提交点——`commitRevoke` 在写盘前会重新做
   * `assertMutationsAllowed()`，那一步才把 `ERR_STORE_RESTRICTED` 交给调用方。
   */
  function opEvidenceOf(opId: string): OpEvidence {
    try {
      const primary = readPrimary();
      const parsed = primary ?? readBackup();
      if (parsed) {
        const created = parsed.state.projects.find((project) => project.createdByOp === opId);
        if (created) return { outcome: 'created', projectId: created.projectId };
        const revoked = parsed.state.revoked.find((entry) => entry.opId === opId);
        if (revoked) return { outcome: 'revoked', projectId: revoked.projectId };
      }
      const log = readLog(io.readText(LOG_PATH));
      if (log.status === 'ok') {
        const tomb = log.entries.find((entry) => entry.opId === opId);
        if (tomb) return { outcome: 'revoked', projectId: tomb.projectId };
      }
    } catch {
      // 磁盘暂时读不到：没有可核对的证据。提交点会按存储状态单独把关。
      return { outcome: 'unknown', projectId: null };
    }
    return { outcome: 'unknown', projectId: null };
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
      if (entry.grantSource !== undefined && !KNOWN_GRANT_SOURCES.includes(entry.grantSource)) {
        // 非法来源不得落盘：它能被误读成"某种授权"，却永远不该换来权限
        throw domainError(ERROR_CODES.ERR_COMMAND_INVALID, `非法的授权来源: ${entry.grantSource}`);
      }
      if (current.issuedIds.includes(entry.projectId) || current.projects.some((p) => p.projectId === entry.projectId)) {
        // id 一旦签发（含已撤销）就永不复用；调用方必须重新签发
        throw domainError(ERROR_CODES.ERR_STORE_ID_REUSED, `projectId 已签发过，不得复用: ${entry.projectId}`);
      }
      const next: ConfigState = {
        version: 3,
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
        hidden: current.hidden,
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
        version: 3,
        commitSeq: current.commitSeq + 1,
        issuedIds: current.issuedIds,
        revoked: current.revoked,
        projects: current.projects.map((entry) =>
          entry.projectId === input.projectId ? { ...project, name: input.name } : entry,
        ),
        hidden: current.hidden,
      };
      writeConfigAtomic(next);
      applyConfig(next);
      state = { ...state, commitSeq: next.commitSeq };
    },

    async commitRevoke(input) {
      assertOpen();
      const logNow = assertMutationsAllowed();
      assertProjectKnown(input.projectId);

      // ---- opId 唯一归属：写任何字节之前就拒绝（R1-02）----
      // 同一个编号代表两次事务会让证据产生歧义：A 的撤销证据会被 B 认领。
      // 这里必须零变更——既不追加第二条墓碑，也不改动配置。
      const claimant = opClaimant(input.opId, logNow);
      if (claimant) throw opConflictError(input.opId, claimant);

      const seq = Math.max(current.commitSeq, logNow.lastSeq) + 1;
      const at = clock().toISOString();

      // ---- step 1：墓碑 + fsync（提交点）----
      //
      // 失败语义（ADR-022 §3.1.1 / §4.0）：
      // - 确认零字节写入 → `not-committed`，零变更、可重试；
      // - 行已完整可读但 fsync 未确认 → **重新 fsync 同一文件**（绝不重复追加墓碑）：
      //   成功才视为提交；仍失败 → `unknown`（目标项目拒盘，不恢复 ACTIVE）；
      // - 日志尾部损坏/消失 → 日志不可证 → 全局 fail-closed + `unknown`。
      try {
        appendRevocation(io, {
          dir,
          seq,
          projectId: input.projectId,
          opId: input.opId,
          at,
          prevHash: logNow.lastHash,
          needsHeader: !logNow.hasHeader,
        });
      } catch (err) {
        if (err instanceof StoreIoError && err.committedBytes === 0) {
          // 打开失败 / 0 字节写入：这是唯一能断言"没有落盘"的证据
          throw commitError('not-committed', err);
        }

        // 读取不到日志就无法核对：既不能判"未写入"，也不能判"已写入"
        const verify = readLogSafe();
        if (!verify) {
          // 撤销可能已经发生 → 保留 UNKNOWN；同时全局拒盘（不重建日志、不重复追加）
          enterRestricted('撤销写入结果不可判定：撤销日志无法读取，禁止全部磁盘访问');
          throw commitError('unknown', err);
        }
        if (verify.status !== 'ok') {
          // 尾部损坏或日志消失：撤销集合不再可证 —— 全局拒盘，且不得抛"未写入"
          enterRestricted('撤销写入结果不可判定：撤销日志无法核对，禁止全部磁盘访问');
          throw commitError('unknown', err);
        }

        const own = verify.entries.find(
          (entry) => entry.opId === input.opId && entry.projectId === input.projectId,
        );
        if (!own) {
          // 这一行确实没有出现（整行未写入）：可以按"未提交"处理
          throw commitError('not-committed', err);
        }

        // 行完整可读 ≠ 持久化已确认：只补 fsync，不重写、不追加
        try {
          io.fsyncPath(LOG_PATH);
        } catch (syncErr) {
          // 无法同步确认：保持 UNKNOWN。目标项目由 Runtime 拒盘，这里不恢复任何权限。
          state = {
            ...state,
            integrity: 'DEGRADED',
            mutationsAllowed: false,
            notes: [...state.notes, '撤销墓碑已写入但重新同步失败：持久化结论未知，拒绝后续变更'],
          };
          throw commitError('unknown', syncErr);
        }
      }

      verifiedLastSeq = Math.max(verifiedLastSeq, seq);

      // ---- step 3：补写配置（失败不回滚）----
      const next: ConfigState = {
        version: 3,
        commitSeq: seq,
        issuedIds: current.issuedIds,
        revoked: [...current.revoked, { projectId: input.projectId, revokedAtSeq: seq, opId: input.opId }],
        projects: current.projects.filter((project) => project.projectId !== input.projectId),
        // 项目已被撤销：它的隐藏记录随之作废（不删除任何磁盘文件，只是不再登记）
        hidden: current.hidden.filter((entry) => entry.projectId !== input.projectId),
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

    issuedIds() {
      return current.issuedIds;
    },

    hiddenOf(projectId) {
      if (!current.projects.some((project) => project.projectId === projectId)) return [];
      return current.hidden
        .filter((entry) => entry.projectId === projectId)
        .slice()
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },

    async commitHidden(input) {
      assertOpen();
      assertMutationsAllowed();
      assertProjectKnown(input.projectId);
      if (typeof input.hidden !== 'boolean') {
        // 缺省绝不能默认成"取消隐藏"：那会让一次写错的调用悄悄清掉记录
        throw domainError(ERROR_CODES.ERR_COMMAND_INVALID, '必须显式声明 hidden');
      }

      const existing = current.hidden.find(
        (entry) => entry.projectId === input.projectId && sameEntryPath(entry.path, input.path),
      );

      if (!input.hidden) {
        if (!existing) return { changed: false };
        const next: ConfigState = {
          version: 3,
          commitSeq: current.commitSeq + 1,
          issuedIds: current.issuedIds,
          revoked: current.revoked,
          projects: current.projects,
          hidden: current.hidden.filter((entry) => entry !== existing),
        };
        try {
          writeConfigAtomic(next);
        } catch (err) {
          // 写不进去 = 没生效：内存投影保持原样，绝不假装成功
          throw Object.assign(new Error('取消隐藏未能写入工作区配置'), {
            errorCode: ERROR_CODES.ERR_PERSIST_FAILED,
            cause: err,
          });
        }
        applyConfig(next);
        state = { ...state, commitSeq: next.commitSeq };
        return { changed: true };
      }

      const rootToken = input.rootToken ?? '';
      const identity = input.identity ?? '';
      if (rootToken === '' || identity === '') {
        // 没有根令牌/对象身份就无法在下次读取时判断"还是不是同一个对象"
        throw domainError(ERROR_CODES.ERR_COMMAND_INVALID, '缺少根令牌或对象身份，不能登记隐藏记录');
      }
      if (existing && existing.rootToken === rootToken && existing.identity === identity) {
        // 完全相同的记录：幂等 no-op（不写盘、不推进序号）
        return { changed: false };
      }
      if (!existing && current.hidden.length >= MAX_HIDDEN_ENTRIES) {
        throw domainError(ERROR_CODES.ERR_COMMAND_INVALID, `隐藏记录已达上限（${MAX_HIDDEN_ENTRIES} 条）`);
      }

      const record: ConfigHiddenEntry = {
        projectId: input.projectId,
        path: input.path,
        rootToken,
        identity,
        hiddenAt: input.at ?? clock().toISOString(),
      };
      const next: ConfigState = {
        version: 3,
        commitSeq: current.commitSeq + 1,
        issuedIds: current.issuedIds,
        revoked: current.revoked,
        projects: current.projects,
        hidden: existing
          ? current.hidden.map((entry) => (entry === existing ? record : entry))
          : [...current.hidden, record],
      };
      try {
        writeConfigAtomic(next);
      } catch (err) {
        throw Object.assign(new Error('隐藏记录未能写入工作区配置'), {
          errorCode: ERROR_CODES.ERR_PERSIST_FAILED,
          cause: err,
        });
      }
      applyConfig(next);
      state = { ...state, commitSeq: next.commitSeq };
      return { changed: true };
    },

    queryOp(opId) {
      return opEvidenceOf(opId).outcome;
    },

    opEvidence(opId) {
      return opEvidenceOf(opId);
    },

    opIdUsed(opId) {
      return opEvidenceOf(opId).outcome !== 'unknown';
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
