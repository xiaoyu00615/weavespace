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
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, join, normalize, resolve as resolvePath } from 'node:path';
import type { ErrorCode } from '../contracts/errors.ts';
import type { SaveResult } from '../contracts/types.ts';
import {
  entryNameOf,
  entryRelativePath,
  isEntryUnder,
  isReservedPath,
  parentDirOfEntry,
  sameEntryPath,
  validateEntryName,
  validateEntryPath,
  validateParentDir,
} from './entry-name.ts';
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
  /**
   * 仅测试注入：替换 `readDir` 的 `lstat`（UX-02B-TREE-R2）。
   *
   * 用途：记录/拦截每一次元数据读取，验证对 `dir=link/child` 的拒绝**发生在**
   * 沿链接访问根外 `child` 之前。仅断言 HTTP 400/403 无法区分这两者。
   * 不注入时使用 `node:fs/promises.lstat`，生产行为不变。
   */
  lstatImpl?: LstatImpl;
  /**
   * 在**创建已发生**、尚未向调用方确认时抛出（UX-02C-01）。
   *
   * 用来确定性验证"磁盘副作用已存在但响应链中断"必须收敛为 `UNKNOWN`：
   * 既不谎报失败，也不谎报成功，客户端因此不会自动重发一次创建。
   */
  afterCreate?: () => void;
  /**
   * 在**结构变更已发生**、尚未向调用方确认时抛出（UX-02C-02）。
   * 用来确定性验证「磁盘副作用已存在但确认链中断」必须收敛为 UNKNOWN。
   */
  afterMove?: () => void;
  /**
   * 结构变更**目标存在性检查已通过、排他占位尚未执行**时调用（UX-02C-02）。
   *
   * 用途：确定性注入"检查与占位之间外部进程创建了同名目标"的竞争窗口。
   * 没有占位防线时，随后的 rename 会静默覆盖外部创建的对象（Windows 上
   * libuv 用 MoveFileExW + REPLACE_EXISTING）；有了 `wx` 占位，这里必须
   * 以 ERR_ENTRY_EXISTS 拒绝且外部对象不被覆盖。仅测试注入。
   */
  beforeMoveReserve?: () => void;
  /**
   * 排他占位**建立之后**、记录身份 / 关闭句柄之前调用（UX-02C-02-R1.1 / R1.2）。
   *
   * 用来确定性验证"占位已存在但拿不到身份 / 关不掉句柄"必须收敛为 UNKNOWN：
   * 此时磁盘已经有本次操作的副作用，绝不能返回一个"什么都没发生"的普通拒绝。
   *
   * `attempt`：1 = 初次占位；2 = 占位被外部删除后的重新占位。两条路径共用同一段
   * 实现，因此注入点的语义也完全一致（R1.2-04）。
   */
  reserveFault?: (stage: 'beforeStat' | 'beforeClose', attempt: 1 | 2) => void;
  /**
   * 排他占位**已建立并记录文件身份**、`rename` 尚未执行时调用（UX-02C-02-R1）。
   *
   * 用途：确定性模拟"占位被外部进程删除并换成同名 0 字节文件"。旧实现用
   * `isFile() && size===0` 判断占位归属，会把外部文件当成自己的占位并删除；
   * 有了 dev+ino 身份核对，这里必须以 ERR_ENTRY_EXISTS 拒绝且不碰外部文件。
   */
  afterMoveReserve?: () => void;
  /**
   * 身份复核完成、`rename` 即将执行时调用（UX-02C-02-R1.2 / R1-05）。
   *
   * 这是本 Provider **唯一**无法用"再检查一次"消除的竞争窗口：`rename` 由
   * libuv 映射为 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`，Node 没有原子
   * no-replace 变体（实测见 `docs/evidence/ux-02c-02-r12/notes.md`），因此
   * 复核与 rename 之间被外部替换的同名对象仍会被覆盖。
   *
   * 提供这个注入点不是为了掩饰它，而是为了把窗口行为钉成可观测断言，
   * 并保证"复核之后才动手"这个顺序本身可被测试验证。
   */
  beforeMoveRename?: () => void;
}

export type CreateEntryKind = 'file' | 'directory';
export type CreateEntryResult =
  | { status: 'CREATED'; kind: CreateEntryKind; relativePath: string }
  | { status: 'REJECTED'; errorCode: ErrorCode }
  /** 副作用可能已发生，但根连续性/确认链无法证明结果。 */
  | { status: 'UNKNOWN'; errorCode: 'ERR_OUTCOME_UNKNOWN' };

/**
 * 真实改名 / 移动（UX-02C-02）。
 *
 * `rename` 与 `move` 在磁盘上是**同一个原语**：都只是把项目内一个相对路径
 * 换成另一个相对路径。HTTP 层分成两个端点只是交互语义不同，不能因此写两份
 * 路径判定。
 *
 * `contentSha256`：文件为内容 SHA-256；目录为有界结构指纹（路径 + 长度 + 内容哈希），
 * 超出上限时为 `null`（明确不声称已完整核对，而不是假装核对过）。
 */
export type MoveEntryResult =
  | {
      status: 'MOVED';
      sourcePath: string;
      targetPath: string;
      kind: CreateEntryKind;
      contentSha256: string | null;
    }
  | { status: 'REJECTED'; errorCode: ErrorCode }
  | { status: 'UNKNOWN'; errorCode: 'ERR_OUTCOME_UNKNOWN' };

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

/** `lstat` 的最小视图：`readDir` 只关心这两件事，便于测试注入可观测实现。 */
export interface LstatResultLike {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}

/** 仅测试注入：替换 `readDir` 的元数据读取，用于证明"拒绝前没有越界元数据读取"。 */
export type LstatImpl = (absolutePath: string) => Promise<LstatResultLike>;

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
  /**
   * 对象身份 `${dev}:${ino}`（**不跟随**链接，用 `lstat`）；不存在返回 `null`。
   *
   * 只用于回答一个问题："这个路径上还是不是当初那个对象？"——工作台隐藏记录
   * 据此判断"同名路径是否已被换成另一个文件"，从而绝不把新对象错误当成旧对象
   * 继续隐藏（UX-02C-03-P1）。
   *
   * 它不是授权凭据，也不能当作绝对防伪：`lstat` 与后续操作之间仍有竞争窗口，
   * 调用方必须把"身份不一致"当作拒绝理由，而不是"身份一致"当作安全证明。
   *
   * 声明为可选：不提供该能力的 Provider（Demo / 静态多项目）由 Host 明确降级
   * 为"按路径匹配"，并在响应里如实标注（见 `apps/server/src/hidden.ts`）。
   */
  identityOf?(path: string): Promise<string | null>;
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
  /**
   * 新建**真实磁盘对象**（UX-02C-01）：空文件或空目录，排他、不覆盖。
   *
   * 声明为可选是为了不强制所有历史测试替身实现它：没有该能力的 Provider
   * （以及 Legacy / 静态 Multi 的端点）由 Host 明确返回"不支持"。
   * 实现必须复用本 Provider 同一个 `RootBoundary`，不得另起一套路径判定。
   */
  createEntry?(
    parentDir: string,
    name: string,
    kind: CreateEntryKind,
  ): Promise<CreateEntryResult>;
  /**
   * 真实改名 / 移动（UX-02C-02）：同一授权项目内，`sourcePath` →
   * `targetParentDir/targetName`。排他、不覆盖、不跨项目、不递归建父目录。
   *
   * 同样声明为可选：Demo / Legacy / 静态 Multi 不提供该能力，由 Host 明确拒绝。
   * 实现必须复用本 Provider 的固定 `RootBoundary` 与 C0/C1/C4 根连续性检查点。
   */
  moveEntry?(
    sourcePath: string,
    targetParentDir: string,
    targetName: string,
  ): Promise<MoveEntryResult>;
  /**
   * 目录项事实（UX-02C-03-P2-01）：`lstat` 得到"这一项本身"是文件/目录/链接/重解析点，
   * 附带 `dev:ino` 与大小，**绝不跟随链接**。
   *
   * 回收区需要它来回答两件事："用户选中的是普通文件吗？"、"待移动的对象是不是
   * 意图里记录的那一个？"。只读、不产生副作用。
   */
  entryFacts?(path: string): Promise<EntryFacts>;
  /**
   * 把**普通文件**移入项目内回收区（UX-02C-03-P2-01）。
   *
   * 目录 / 链接 / 重解析点一律拒绝；`expectedIdentity` 必须与磁盘上的对象身份一致，
   * 否则拒绝且零移动（绝不"删掉占着这个路径的陌生人"）。
   *
   * 目标固定为 `.weavespace/trash/<opId>/payload`：Recovery 侧只按 opId 定位，
   * 不依赖原文件名（避免长路径与非法名），也不会与 `manifest.json` 冲突。
   */
  trashEntry?(opId: string, sourcePath: string, expectedIdentity: string): Promise<TrashOpResult>;
  /**
   * 从回收区恢复到**指定路径**（UX-02C-03-P2-01）。
   *
   * 目标已存在一律拒绝（绝不覆盖）；`expectedIdentity` 必须与回收区对象身份一致，
   * 否则拒绝（说明回收区里的东西已经不是当初移入的那一个）。
   */
  restoreEntry?(opId: string, targetPath: string, expectedIdentity: string): Promise<TrashOpResult>;
  /** 回收区对象身份；不存在返回 `null`（只读，供对账使用）。 */
  trashIdentity?(opId: string): Promise<string | null>;
}

export function contentVersionOf(content: string | Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function domainError(errorCode: string, message: string): Error {
  return Object.assign(new Error(message), { errorCode });
}

/**
 * 文件系统对象身份（UX-02C-02-R1）。
 *
 * `dev + ino` 是目录项背后的真实对象身份：同一个路径被删除后重建，即使大小、
 * 时间戳都相同，ino 也会变。排他占位据此判断"目标还是不是本次操作自己创建
 * 的那个 0 字节文件"——绝不再用 `isFile() && size === 0` 这种可被外部伪造的
 * 外观特征来认定归属。
 */
interface EntryIdentity {
  readonly dev: string;
  readonly ino: string;
}

function identityOfStats(stats: {
  dev: number | bigint;
  ino: number | bigint;
}): EntryIdentity {
  // Windows 上 ino 可能以 number 或 bigint 出现，统一按字符串比较
  return { dev: String(stats.dev), ino: String(stats.ino) };
}

function sameEntryIdentity(
  left: EntryIdentity | null,
  right: EntryIdentity | null,
): boolean {
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
}

/* ================================================================== */
/* 回收区（UX-02C-03-P2-01）                                            */
/* ================================================================== */

/** 内部保留目录（项目根层）。普通入口不得到达，见 `isReservedPath`。 */
const TRASH_OWNER_DIR = '.weavespace';
const TRASH_ROOT_DIR = '.weavespace/trash';
/** 回收区 payload 使用固定名称：不与 `manifest.json` 争用，也不受原文件名长度影响。 */
const TRASH_PAYLOAD_NAME = 'payload';
const TRASH_MANIFEST_NAME = 'manifest.json';
const TRASH_OWNER_MARKER = '.ws-internal';
const TRASH_OWNER_MAGIC = 'weavespace-internal-trash-v1';
/** opId 同时是目录名：只允许小写字母数字与连字符，长度受限。 */
const TRASH_OP_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;

/** 目录项事实：不跟随链接，只描述"这个目录项本身是什么"。 */
export type EntryFactKind = 'file' | 'folder' | 'link' | 'other';

export interface EntryFacts {
  readonly kind: EntryFactKind;
  /** `dev:ino`；读不到时为 `null`（不是"不存在"，调用方按无法证明处理）。 */
  readonly identity: string | null;
  readonly size: number;
  /** 目录项是重解析点（junction / 其他不可信解析），绝不能按普通对象处理。 */
  readonly untrusted: boolean;
}

export type TrashOpStatus = 'MOVED' | 'REJECTED' | 'UNKNOWN';

export interface TrashOpResult {
  status: TrashOpStatus;
  errorCode?: ErrorCode;
  /** 被移动对象在移动后的身份（正常等于移动前）。 */
  identity?: string;
  size?: number;
}

function trashDirOf(opId: string): string {
  return `${TRASH_ROOT_DIR}/${opId}`;
}

function trashPayloadOf(opId: string): string {
  return `${TRASH_ROOT_DIR}/${opId}/${TRASH_PAYLOAD_NAME}`;
}

type TrashSetup = { ok: true; ownerAbs: string; opDirAbs: string } | { ok: false; errorCode: ErrorCode };

/**
 * 建立/核验内部回收区目录（UX-02C-03-P2-01 §二.3）。
 *
 * 规则（顺序不可交换）：
 * 1. `.weavespace` 不存在 → 建；存在 → 必须是**真目录**且不是符号链接/junction；
 * 2. 必须带我们的所有权标记；**没有标记就绝不接管**（用户已有同名目录/文件一律拒绝）；
 *    唯一例外：目录为空（上一次在 mkdir 与写标记之间崩溃），此时没有可覆盖的内容；
 * 3. 顺手写 `.gitignore`（内容 `*`），避免把回收区提交进用户仓库；
 * 4. `trash/<opId>` 必须是真目录，不是链接。
 *
 * 目录身份（dev:ino）也会记进标记：项目被整体复制后目录身份必然变化，
 * 这是**合法的**（文件也一起被复制了），因此身份变化只更新标记，不作为拒绝理由；
 * 真正的防伪仍在每个 payload 的对象身份上。
 */
async function prepareTrashRoot(
  boundary: RootBoundary,
  token: string | null,
  opId: string | null,
): Promise<TrashSetup> {
  const fail = (errorCode: ErrorCode): TrashSetup => ({ ok: false, errorCode });
  const rootAbs = boundary.canonicalRoot;
  const ownerAbs = resolvePath(rootAbs, TRASH_OWNER_DIR);
  if (!isPathInsideRoot(rootAbs, ownerAbs)) return fail('ERR_PATH_OUTSIDE_ROOT');

  let ownerStats;
  try {
    ownerStats = await lstat(ownerAbs);
  } catch (err) {
    if (!isMissing(err)) return fail(mapStorageError(err));
    try {
      await mkdir(ownerAbs);
    } catch (mkErr) {
      if (codeOf(mkErr) !== 'EEXIST') return fail(mapStorageError(mkErr));
    }
    try {
      ownerStats = await lstat(ownerAbs);
    } catch (again) {
      return fail(mapStorageError(again));
    }
  }
  // 链接 / junction 一律拒绝：否则回收区会被重定向到根外
  if (ownerStats.isSymbolicLink() || isUntrustedResolution(ownerAbs)) return fail('ERR_TRASH_UNAVAILABLE');
  if (!ownerStats.isDirectory()) return fail('ERR_TRASH_UNAVAILABLE');

  const identity = `${ownerStats.dev}:${ownerStats.ino}`;
  const markerAbs = join(ownerAbs, TRASH_OWNER_MARKER);
  let markerRaw: string | null = null;
  try {
    markerRaw = await readFile(markerAbs, 'utf8');
  } catch (err) {
    if (!isMissing(err)) return fail(mapStorageError(err));
  }

  if (markerRaw === null) {
    // 没有标记：只接受"空目录"（我们自己刚建、或上次崩在写标记之前）
    let entries: string[];
    try {
      entries = await readdir(ownerAbs);
    } catch (err) {
      return fail(mapStorageError(err));
    }
    if (entries.length > 0) return fail('ERR_TRASH_UNAVAILABLE');
    try {
      await writeFile(
        markerAbs,
        `${JSON.stringify({ magic: TRASH_OWNER_MAGIC, identity, createdAt: new Date().toISOString() }, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
      await writeFile(join(ownerAbs, '.gitignore'), '*\n', { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      // 并发/EEXIST：交给下面的复核；其它错误直接失败
      if (codeOf(err) !== 'EEXIST') return fail(mapStorageError(err));
    }
    try {
      markerRaw = await readFile(markerAbs, 'utf8');
    } catch (err) {
      return fail(mapStorageError(err));
    }
  }

  let marker: { magic?: unknown; identity?: unknown };
  try {
    marker = JSON.parse(markerRaw) as { magic?: unknown; identity?: unknown };
  } catch {
    return fail('ERR_TRASH_UNAVAILABLE');
  }
  if (marker.magic !== TRASH_OWNER_MAGIC) return fail('ERR_TRASH_UNAVAILABLE');
  if (typeof marker.identity === 'string' && marker.identity !== identity) {
    // 目录身份变化 = 项目被复制/移动过（文件也一起搬了）。更新标记，但不放弃防伪：
    // 真正被依赖的是 payload 的 dev:ino。
    try {
      await writeFile(
        markerAbs,
        `${JSON.stringify({ magic: TRASH_OWNER_MAGIC, identity, createdAt: new Date().toISOString() }, null, 2)}\n`,
        'utf8',
      );
    } catch (err) {
      return fail(mapStorageError(err));
    }
  }

  const trashRootAbs = resolvePath(rootAbs, TRASH_ROOT_DIR);
  try {
    const info = await lstat(trashRootAbs);
    if (info.isSymbolicLink() || isUntrustedResolution(trashRootAbs) || !info.isDirectory()) {
      return fail('ERR_TRASH_UNAVAILABLE');
    }
  } catch (err) {
    if (!isMissing(err)) return fail(mapStorageError(err));
    try {
      await mkdir(trashRootAbs);
    } catch (mkErr) {
      if (codeOf(mkErr) !== 'EEXIST') return fail(mapStorageError(mkErr));
    }
  }

  if (opId === null) return { ok: true, ownerAbs, opDirAbs: trashRootAbs };

  const opDirAbs = resolvePath(rootAbs, trashDirOf(opId));
  try {
    await mkdir(opDirAbs);
  } catch (err) {
    if (codeOf(err) !== 'EEXIST') return fail(mapStorageError(err));
  }
  try {
    const info = await lstat(opDirAbs);
    if (info.isSymbolicLink() || isUntrustedResolution(opDirAbs) || !info.isDirectory()) {
      return fail('ERR_TRASH_UNAVAILABLE');
    }
  } catch (err) {
    return fail(mapStorageError(err));
  }
  // 每一次进入都要确认根仍然连续（C1 由调用方在 rename 前再核一次）
  try {
    assertRootContinuity(boundary, token);
  } catch (err) {
    return fail(mapStorageError(err));
  }
  return { ok: true, ownerAbs, opDirAbs };
}

/** 该路径上的对象身份是否正好等于预期（不存在 / 读不出来 → false）。 */
async function objectMatchesIdentity(absPath: string, expected: string): Promise<boolean> {
  try {
    const info = await lstat(absPath);
    return `${info.dev}:${info.ino}` === expected;
  } catch {
    return false;
  }
}

/** 只清理"确实还是我们自己的占位"，外部对象一律不碰。 */
async function releaseReservation(absPath: string, reservation: EntryIdentity | null): Promise<void> {
  if (reservation === null) return;
  try {
    const info = await lstat(absPath);
    if (!sameEntryIdentity(identityOfStats(info), reservation)) return;
    await unlink(absPath);
  } catch {
    // 清理失败不影响结论：调用方本来就要报 REJECTED/UNKNOWN
  }
}



/** 结构指纹上限：超过即返回 null（如实说明"未完整核对"，不做全树扫描的假保证）。 */
const MAX_FINGERPRINT_ENTRIES = 2_000;
const MAX_FINGERPRINT_BYTES = 16 * 1024 * 1024;

/**
 * 有界的内容/结构指纹，用于结构变更后的**结果确认**。
 *
 * 文件：长度 + SHA-256；目录：递归列出相对路径、长度与每个文件的 SHA-256，
 * 不跟随符号链接（链接只记录名字）。超过条目/字节上限返回 `null`。
 */
async function fingerprintOf(absPath: string, isDir: boolean): Promise<string | null> {
  if (!isDir) {
    const buf = await readFile(absPath);
    return `file:${buf.length}:${createHash('sha256').update(buf).digest('hex')}`;
  }
  const parts: string[] = [];
  let entries = 0;
  let bytes = 0;
  const walk = async (dir: string, prefix: string): Promise<boolean> => {
    const list = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of list) {
      entries += 1;
      if (entries > MAX_FINGERPRINT_ENTRIES) return false;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        parts.push(`link:${rel}`);
      } else if (entry.isDirectory()) {
        parts.push(`dir:${rel}`);
        if (!(await walk(abs, rel))) return false;
      } else {
        const buf = await readFile(abs);
        bytes += buf.length;
        if (bytes > MAX_FINGERPRINT_BYTES) return false;
        parts.push(`file:${rel}:${buf.length}:${createHash('sha256').update(buf).digest('hex')}`);
      }
    }
    return true;
  };
  if (!(await walk(absPath, ''))) return null;
  return `tree:${createHash('sha256').update(parts.join('\n')).digest('hex')}`;
}

function moveErrorOf(err: unknown, isDir: boolean): ErrorCode {
  const code = codeOf(err);
  if (code === 'EXDEV') return 'ERR_MOVE_CROSS_VOLUME';
  if (code === 'EEXIST') return 'ERR_ENTRY_EXISTS';
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'ERR_ENTRY_PARENT_INVALID';
  if (isDir && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
    return 'ERR_ENTRY_DIR_BUSY';
  }
  return mapStorageError(err) as ErrorCode;
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
  /** 仅测试注入：默认就是真实的 `lstat`，生产行为完全不变。 */
  const lstatImpl: LstatImpl = faults.lstatImpl ?? lstat;

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
    /**
     * 提交对象的身份证据（UX-02C-03-P1-R1）：在 rename **之前**对临时文件取
     * `lstat`。rename 之后该对象就是目标路径上的对象，因此它是唯一能证明
     * "路径上现在这个对象是本次写入产生的"的凭据。
     *
     * 取不到时保持 `undefined`（调用方按"无法证明"处理），绝不用目标路径
     * 的现有身份回填——那会把外部替换来的新对象冒充成本次写入的结果。
     */
    let committedIdentity: string | undefined;
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

      // 提交身份必须在 rename 之前取：之后临时路径就不存在了，而目标路径上
      // 可能已经被别的进程换成另一个对象。
      try {
        const tempStats = await lstat(tempPath);
        const identity = identityOfStats(tempStats);
        committedIdentity = `${identity.dev}:${identity.ino}`;
      } catch {
        committedIdentity = undefined;
      }

      await rename(tempPath, absolutePath);
    } catch (err) {
      if (tempPath) await rm(tempPath, { force: true }).catch(() => {});
      // EPERM/EACCES → 权限错误；边界漂移/根身份 → 根错误；其余 → 存储 IO
      return { status: 'FAILED', errorCode: mapStorageError(err) };
    }

    const committedVersion = contentVersionOf(payload);
    /** 提交侧证据：有就带上，没有就不带（绝不回填目标路径的现有身份）。 */
    const withIdentity = <T extends Record<string, unknown>>(result: T): T =>
      committedIdentity ? ({ ...result, identity: committedIdentity } as T) : result;

    // C4：rename 之后、确认提交结果之前。
    // 此处副作用可能已经发生（文件落在提交时的根内），因此只能报 UNKNOWN。
    try {
      checkpoint('C4');
      assertRootContinuity(boundary, establishedToken);
    } catch {
      return withIdentity({
        status: 'UNKNOWN' as const,
        errorCode: 'ERR_OUTCOME_UNKNOWN' as const,
        contentVersion: committedVersion,
      });
    }

    if (faults.afterCommit) {
      try {
        faults.afterCommit();
      } catch {
        // 副作用已落盘但确认链中断：必须报 UNKNOWN，不得报成功或失败（docs/04、CT-06）
        return withIdentity({
          status: 'UNKNOWN' as const,
          errorCode: 'ERR_OUTCOME_UNKNOWN' as const,
          contentVersion: committedVersion,
        });
      }
    }
    return withIdentity({ status: 'COMMITTED' as const, contentVersion: committedVersion });
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

    /**
     * 对象身份（UX-02C-03-P1）：`lstat` + `dev:ino`，**不跟随**链接。
     *
     * 不跟随是刻意的：工作台树里的链接是一行"链接节点"，隐藏它不会影响它的目标，
     * 身份也必须是链接自身而不是目标目录。
     */
    async identityOf(path: string): Promise<string | null> {
      const check = resolveInBoundary(boundary, path);
      if (!check.ok) {
        throw Object.assign(new Error(check.detail), { errorCode: check.errorCode });
      }
      assertRootContinuity(boundary, establishedToken);
      let s;
      try {
        s = await lstat(check.absolutePath);
      } catch (err) {
        if (isMissing(err)) return null;
        throw toStorageError(err);
      }
      return `${String(s.dev)}:${String(s.ino)}`;
    },

    /**
     * 目录项事实（UX-02C-03-P2-01）：不跟随链接，只回答"这一项本身是什么"。
     *
     * 与 `stat()` 的区别：`stat()` 跟随链接且返回内容版本；这里要的恰恰是
     * "它是不是链接" —— 回收链接会删掉用户的项目里的一行，而回收链接**目标**
     * 才是灾难。junction 在 `lstat` 上可能不表现为符号链接，因此额外用
     * `isUntrustedResolution` 补判并标记 `untrusted`。
     */
    async entryFacts(path: string): Promise<EntryFacts> {
      /**
       * 这里**不能**先做 `resolveInBoundary`：它会把"末段是链接"解析成链接目标，
       * 于是我们永远看不到 `kind: 'link'`，而是得到一个指向别处的普通文件（甚至
       * 直接被判越界）。回收区要的恰恰是"这一项本身是不是链接"。
       *
       * 正确顺序：父链逐级 realpath 校验（不安全的父链直接失败、零目标元数据读取），
       * 然后对**末段**做一次不跟随的 `lstat`。
       */
      const shape = validateEntryPath(path);
      if (!shape.ok) {
        throw Object.assign(new Error(shape.message), { errorCode: shape.errorCode });
      }
      const rel = shape.value;
      const parentDir = parentDirOfEntry(rel);
      const leaf = entryNameOf(rel);
      assertRootContinuity(boundary, establishedToken);

      const parentCheck = resolveInBoundary(boundary, parentDir === '' ? '.' : parentDir);
      if (!parentCheck.ok) {
        throw Object.assign(new Error(parentCheck.detail), { errorCode: parentCheck.errorCode });
      }
      const abs = join(parentCheck.absolutePath, leaf);
      if (!isPathInsideRoot(boundary.canonicalRoot, abs)) {
        throw Object.assign(new Error('路径不在允许范围内'), { errorCode: 'ERR_PATH_OUTSIDE_ROOT' });
      }

      let info;
      try {
        info = await lstat(abs);
      } catch (err) {
        if (isMissing(err)) {
          throw Object.assign(new Error('资源不存在'), { errorCode: 'ERR_RESOURCE_NOT_FOUND' });
        }
        throw toStorageError(err);
      }
      const untrusted = isUntrustedResolution(abs);
      const kind: EntryFactKind = info.isSymbolicLink()
        ? 'link'
        : info.isDirectory()
          ? 'folder'
          : info.isFile()
            ? 'file'
            : 'other';
      return {
        kind,
        identity: `${info.dev}:${info.ino}`,
        size: info.size,
        untrusted,
      };
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
          // 根层的内部保留目录不进入递归清单（UX-02C-03-P2-01）
          if (prefix === '' && sameEntryPath(entry.name, TRASH_OWNER_DIR)) continue;
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

      /**
       * 链接诊断（契约 B.5 / UX-02B-TREE-R2）。
       *
       * 旧实现把**完整字面路径**拼出来后直接 `lstat`：当父级是 junction/symlink
       * 时，这次 lstat 会沿链接解析到项目根之外，等于在确认父链安全之前就读取了
       * 根外 `child` 的元数据。虽然随后 resolveInBoundary 仍会拒绝，但元数据已经
       * 被访问过了 —— 这不是"是否泄露内容"的问题，而是访问顺序本身不安全。
       *
       * 新顺序：
       *   1. 先用 `resolveInBoundary` 校验**父目录链**（它逐级 realpath，遇到
       *      重解析点立即返回，不会继续往下解析）；父链不安全就直接失败，
       *      一次目标元数据读取都不做（`dir=link/child` 走这一支）。
       *   2. 父链确认安全后，才对**末段本身**做一次不跟随的 lstat，用来把
       *      "这是一条链接"报成明确的 `ERR_DIR_IS_LINK`（`dir=link` 走这一支）。
       *
       * `isUntrustedResolution` 补上 Windows junction：`lstat().isSymbolicLink()`
       * 对 junction 可能返回 false，realpath 比对仍能识别它。
       * 非法形态（绝对路径 / 盘符 / `..` / 空段 / NUL）跳过诊断，交给正式链路
       * fail-closed 拒绝，绝不为了一次诊断去拼可疑路径。
       */
      const segments = safeSegmentsOf(requested);
      if (segments !== null && segments.length > 0) {
        const parentRel = segments.length > 1 ? segments.slice(0, -1).join('/') : '.';
        const parentCheck = resolveInBoundary(boundary, parentRel);
        if (!parentCheck.ok) {
          throw Object.assign(new Error(parentCheck.detail), { errorCode: parentCheck.errorCode });
        }
        const leaf = segments[segments.length - 1];
        const leafAbs = join(parentCheck.absolutePath, leaf);
        try {
          const pre = await lstatImpl(leafAbs);
          if (pre.isSymbolicLink() || isUntrustedResolution(leafAbs)) {
            throw domainError('ERR_DIR_IS_LINK', '该路径是链接，不展开');
          }
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
        const info = await lstatImpl(check.absolutePath);
        // 悬空重解析点也不会走到这里（resolveInBoundary 已判越界），此处是第二道闸
        if (info.isSymbolicLink()) throw domainError('ERR_DIR_IS_LINK', '该路径是链接，不展开');
        if (!info.isDirectory()) throw domainError('ERR_RESOURCE_NOT_FOUND', '该路径不是目录');

        faults.beforeReadDir?.(requested);

        const entries = await readdir(check.absolutePath, { withFileTypes: true });
        const out: DirEntry[] = [];
        /** 只在**项目根层**隐藏内部保留目录（UX-02C-03-P2-01）；子层的同名目录是用户自己的。 */
        const atRoot = requested === '.' || requested === '';
        for (const entry of entries) {
          if (atRoot && sameEntryPath(entry.name, TRASH_OWNER_DIR)) continue;
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

    /**
     * UX-02C-01：真实创建（空文件 / 空目录）。
     *
     * 与 `writeConditional` 的区别是**排他**：文件用 `open('wx')` 原子新建，
     * 目录用非递归 `mkdir`；两者在同名目标存在时都直接 EEXIST，绝不会走
     * 旧保存链路的"临时文件 + rename"（那会覆盖既有文件）。
     *
     * 检查顺序：名称/父目录形态（零 IO）→ 根连续性 C0 → 父目录真实存在且
     * 为普通目录（不跟随重解析点）→ 目标路径在固定边界内 → C1 → 排他创建 →
     * C4 根连续性复核。副作用之后的任何确认失败一律 `UNKNOWN`，**不回滚**
     * （回滚本身可能删掉别人刚放进去的东西），也不谎报成功。
     */
    async createEntry(parentDir, name, kind): Promise<CreateEntryResult> {
      const dirCheck = validateParentDir(parentDir);
      if (!dirCheck.ok) return { status: 'REJECTED', errorCode: dirCheck.errorCode };
      const nameCheck = validateEntryName(name);
      if (!nameCheck.ok) return { status: 'REJECTED', errorCode: nameCheck.errorCode };
      const relativePath = entryRelativePath(dirCheck.value, nameCheck.value);

      const reject = (errorCode: ErrorCode): CreateEntryResult => ({
        status: 'REJECTED',
        errorCode,
      });

      // C0：解析之前先确认项目根仍连续。根失效时不能把"根没了"报成"文件不存在"。
      try {
        faults.atCheckpoint?.('C0');
        assertRootContinuity(boundary, establishedToken);
      } catch (err) {
        return reject(mapStorageError(err));
      }

      const parentCheck = resolveInBoundary(boundary, dirCheck.value === '' ? '.' : dirCheck.value);
      if (!parentCheck.ok) return reject(parentCheck.errorCode);

      try {
        const info = await lstat(parentCheck.absolutePath);
        if (!info.isDirectory() || info.isSymbolicLink() || isUntrustedResolution(parentCheck.absolutePath)) {
          return reject('ERR_ENTRY_PARENT_INVALID');
        }
      } catch (err) {
        if (isMissing(err)) return reject('ERR_ENTRY_PARENT_INVALID');
        return reject(mapStorageError(err));
      }

      // 目标全路径再解析一次：逐级确认父链里没有 junction / 符号链接
      const targetCheck = resolveInBoundary(boundary, relativePath);
      if (!targetCheck.ok) return reject(targetCheck.errorCode);
      if (!isPathInsideRoot(boundary.canonicalRoot, targetCheck.absolutePath)) {
        return reject('ERR_PATH_OUTSIDE_ROOT');
      }
      // 归一化不得悄悄改掉末段（否则输入的名字和真正落盘的名字会不一致）
      if (basename(targetCheck.absolutePath) !== nameCheck.value) {
        return reject('ERR_ENTRY_NAME_INVALID');
      }

      let sideEffect = false;
      try {
        faults.atCheckpoint?.('C1');
        assertRootContinuity(boundary, establishedToken);
        if (kind === 'file') {
          // 'wx' = O_CREAT|O_EXCL：并发同名最多一个成功，且不跟随符号链接
          const handle = await open(targetCheck.absolutePath, 'wx');
          sideEffect = true;
          await handle.close(); // 0 字节；绝不写入标题或模板
        } else {
          await mkdir(targetCheck.absolutePath); // 非递归：缺父目录时 ENOENT，不补建
          sideEffect = true;
        }
      } catch (err) {
        // 创建本身可能已落盘，只是 close / 后续确认失败：按 UNKNOWN 收敛
        if (sideEffect) return { status: 'UNKNOWN', errorCode: 'ERR_OUTCOME_UNKNOWN' };
        const code = codeOf(err);
        if (code === 'EEXIST') return reject('ERR_ENTRY_EXISTS');
        if (code === 'ENOENT' || code === 'ENOTDIR') return reject('ERR_ENTRY_PARENT_INVALID');
        return reject(mapStorageError(err));
      }

      // C4：副作用已发生之后的根连续性/确认链失败 → UNKNOWN（不是 FAILED）
      try {
        faults.atCheckpoint?.('C4');
        assertRootContinuity(boundary, establishedToken);
        faults.afterCreate?.();
      } catch {
        return { status: 'UNKNOWN', errorCode: 'ERR_OUTCOME_UNKNOWN' };
      }
      return { status: 'CREATED', kind, relativePath };
    },

    /**
     * UX-02C-02：真实改名 / 移动（同一授权根内的相对路径变更）。
     *
     * ## Windows 防覆盖策略（实测 + 官方语义）
     *
     * 本机 Node 22.22.2 / win32 实测：`fs.rename` 由 libuv 映射为
     * `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`，因此
     * - 文件 → 已存在文件：**静默覆盖**（目标原内容丢失）；
     * - 目录 → 已存在文件：同样覆盖；
     * - 目录 → 已存在目录：`EPERM`。
     * 所以**绝不能**把 `fs.rename` 当成"目标不存在才成功"的原子操作，
     * 也不能只做一次 `lstat` 预检（TOCTOU 窗口内外部进程仍可放入同名对象）。
     *
     * 策略：`open(target,'wx')` 先**排他占位**目标名（0 字节，属于本次操作自己），
     * 随后 `rename` 只覆盖我们自己的占位。占位存在期间，任何外部进程创建同名
     * 对象都会得到 EEXIST；同一个 Host 内的并发由项目级结构屏障串行化。
     * 大小写仅变化的改名在 Windows 上源与目标本就是同一个对象，`wx` 会 EEXIST，
     * 因此单独走直接 `rename`（不会覆盖第三方），并用 readdir 复核名称确实变了。
     *
     * ## 已知残留窗口（如实披露，不宣称原子无覆盖）
     * - 外部进程若**删除我们的占位**并在 rename 之前放入自己的对象，仍可能被覆盖；
     * - 进程在"占位已建、rename 未执行"之间崩溃会留下一个 0 字节占位文件；
     * - `rename` 成功但之后根连续性/确认链失败一律 UNKNOWN，不回滚、不删除。
     */
    async moveEntry(sourcePath, targetParentDir, targetName): Promise<MoveEntryResult> {
      const reject = (errorCode: ErrorCode): MoveEntryResult => ({ status: 'REJECTED', errorCode });
      const unknown = (): MoveEntryResult => ({ status: 'UNKNOWN', errorCode: 'ERR_OUTCOME_UNKNOWN' });

      // 1) 形状校验（零 IO）：所有路径都只是项目内相对路径
      const srcCheck = validateParentDir(sourcePath);
      if (!srcCheck.ok || srcCheck.value === '') return reject('ERR_ENTRY_SOURCE_INVALID');
      const dirCheck = validateParentDir(targetParentDir);
      if (!dirCheck.ok) return reject(dirCheck.errorCode);
      const nameCheck = validateEntryName(targetName);
      if (!nameCheck.ok) return reject(nameCheck.errorCode);

      const source = srcCheck.value;
      const targetDir = dirCheck.value;
      const name = nameCheck.value;
      const target = entryRelativePath(targetDir, name);
      if (source === target) return reject('ERR_ENTRY_EXISTS');
      /**
       * 大小写仅变化：Windows 上源与目标其实是同一个目录项（路径大小写等价，
       * 但字符串不同）。此时不能用 `wx` 占位（会 EEXIST），也不能按"目标已存在"
       * 拒绝——这正是用户要改的显示大小写。POSIX 上不会命中这一分支。
       */
      const isCaseOnly = sameEntryPath(source, target);

      // 2) C0：根连续性
      try {
        faults.atCheckpoint?.('C0');
        assertRootContinuity(boundary, establishedToken);
      } catch (err) {
        return reject(mapStorageError(err) as ErrorCode);
      }

      // 3) 源：必须在固定边界内、真实存在、普通文件/目录，且不是重解析点
      const sourceCheck = resolveInBoundary(boundary, source);
      if (!sourceCheck.ok) return reject(sourceCheck.errorCode);
      const sourceAbs = resolvePath(boundary.canonicalRoot, normalize(source));
      if (!isPathInsideRoot(boundary.canonicalRoot, sourceAbs)) return reject('ERR_PATH_OUTSIDE_ROOT');
      let sourceIsDir: boolean;
      try {
        const info = await lstat(sourceAbs);
        if (info.isSymbolicLink() || isUntrustedResolution(sourceAbs)) {
          return reject('ERR_ENTRY_SOURCE_INVALID');
        }
        if (info.isDirectory()) sourceIsDir = true;
        else if (info.isFile()) sourceIsDir = false;
        else return reject('ERR_ENTRY_SOURCE_INVALID');
      } catch (err) {
        if (isMissing(err)) return reject('ERR_RESOURCE_NOT_FOUND');
        return reject(mapStorageError(err) as ErrorCode);
      }

      // 3b) 目录不得移入自身或后代：纯路径判定，必须早于目标父目录的 IO，
      // 否则会被误报成"目标文件夹不存在"，掩盖真正的结构错误。
      if (sourceIsDir && (isEntryUnder(targetDir, source) || isEntryUnder(target, source))) {
        return reject('ERR_MOVE_INTO_DESCENDANT');
      }

      // 4) 目标父目录：必须真实存在且为普通目录，不跟随链接
      const parentCheck = resolveInBoundary(boundary, targetDir === '' ? '.' : targetDir);
      if (!parentCheck.ok) return reject(parentCheck.errorCode);
      const parentAbs = resolvePath(boundary.canonicalRoot, normalize(targetDir === '' ? '.' : targetDir));
      try {
        const info = await lstat(parentAbs);
        if (!info.isDirectory() || info.isSymbolicLink() || isUntrustedResolution(parentAbs)) {
          return reject('ERR_ENTRY_PARENT_INVALID');
        }
      } catch (err) {
        if (isMissing(err)) return reject('ERR_ENTRY_PARENT_INVALID');
        return reject(mapStorageError(err) as ErrorCode);
      }

      // 5) 目标全路径：逐级边界校验 + 末段不被悄悄归一化
      const targetCheck = resolveInBoundary(boundary, target);
      if (!targetCheck.ok && !isCaseOnly) return reject(targetCheck.errorCode);
      const targetAbs = resolvePath(boundary.canonicalRoot, normalize(target));
      if (!isPathInsideRoot(boundary.canonicalRoot, targetAbs)) return reject('ERR_PATH_OUTSIDE_ROOT');
      if (basename(targetAbs) !== name) return reject('ERR_ENTRY_NAME_INVALID');

      // 6) 目标必须不存在（大小写仅变化除外：此时目标就是源本身）
      if (!isCaseOnly) {
        try {
          await lstat(targetAbs);
          return reject('ERR_ENTRY_EXISTS');
        } catch (err) {
          if (!isMissing(err)) return reject(mapStorageError(err) as ErrorCode);
        }
      }

      // 8) 变更前的指纹，用于事后确认（文件 SHA-256 / 目录有界结构指纹）
      let before: string | null;
      try {
        before = await fingerprintOf(sourceAbs, sourceIsDir);
      } catch (err) {
        return reject(mapStorageError(err) as ErrorCode);
      }

      // 9) C1：副作用之前的最后一次根连续性复核
      try {
        faults.atCheckpoint?.('C1');
        assertRootContinuity(boundary, establishedToken);
      } catch (err) {
        return reject(mapStorageError(err) as ErrorCode);
      }

      /**
       * 本次排他占位的真实对象身份（dev+ino）；`null` = 没有占位（大小写仅变化路径）。
       *
       * 声明在 `verify` 之前：结果确认与失败清理都要用它判断"目标还是不是我建的"。
       */
      let reservedIdentity: EntryIdentity | null = null;

      /**
       * 占位归属复核（UX-02C-02-R1）：
       * - `owned`：目标确实仍是本次操作创建的那个对象（dev+ino 一致）；
       * - `missing`：占位已不在（被外部删除，当前没有对象占着这个名字）；
       * - `foreign`：同名路径上是**别的**对象（哪怕它恰好也是 0 字节文件）。
       *
       * 只有 `owned` 才允许覆盖或删除；`foreign` 一律拒绝，绝不碰外部文件。
       */
      const reservationState = async (): Promise<'owned' | 'missing' | 'foreign'> => {
        if (reservedIdentity === null) return 'missing';
        try {
          const info = await lstat(targetAbs);
          return sameEntryIdentity(identityOfStats(info), reservedIdentity) ? 'owned' : 'foreign';
        } catch (err) {
          return isMissing(err) ? 'missing' : 'foreign';
        }
      };

      /**
       * 建立排他占位并取得真实身份（**唯一实现**，初次占位与重新占位共用）。
       *
       * R1-04 复审缺陷：两条路径各写一份，初次走"副作用之后一律 UNKNOWN"，
       * 重新占位却退化成 `catch → REJECTED`。同一块磁盘上已经多了一个 0 字节
       * 占位，却报告"什么都没发生"——调用方据此可以安全重试，于是留下第二个
       * 占位；更糟的是它会把"结果不明"当成"目标已存在"来展示。
       *
       * 统一后的语义（与尝试次数无关）：
       * - `open('wx')` 失败：**零副作用**。EEXIST → ERR_ENTRY_EXISTS，其余按
       *   `moveErrorOf` 映射成普通拒绝（可以放心重试）。
       * - 占位已建立但 `stat` 失败：身份未知 → UNKNOWN，**不删除目标**
       *   （此刻那个名字上的对象可能已经不是我们的了）。
       * - 占位已建立但 `close` 失败：句柄状态未知 → UNKNOWN，并再尽力释放一次
       *   句柄；绝不因为"关不掉"就宣称成功或失败。
       */
      type ReservationOutcome =
        | { status: 'RESERVED'; identity: EntryIdentity }
        | { status: 'FAILED'; result: MoveEntryResult };

      const reserveExclusive = async (attempt: 1 | 2): Promise<ReservationOutcome> => {
        let handle: FileHandle;
        try {
          handle = await open(targetAbs, 'wx');
        } catch (err) {
          if (codeOf(err) === 'EEXIST') {
            return { status: 'FAILED', result: reject('ERR_ENTRY_EXISTS') };
          }
          return { status: 'FAILED', result: reject(moveErrorOf(err, sourceIsDir)) };
        }

        /**
         * 从这里开始磁盘上已经有本次操作的副作用（0 字节占位）。之后所有
         * "拿不准"都必须 UNKNOWN：既不能用普通拒绝谎称"什么都没发生"，
         * 也不能在身份无法确认时去删除这个目标。
         */
        let identity: EntryIdentity;
        try {
          faults.reserveFault?.('beforeStat', attempt);
          identity = identityOfStats(await handle.stat());
        } catch {
          await handle.close().catch(() => undefined);
          return { status: 'FAILED', result: unknown() };
        }
        try {
          faults.reserveFault?.('beforeClose', attempt);
          await handle.close();
        } catch {
          /**
           * 句柄关不上：实测 Windows 上"保持句柄打开"会让随后的 rename 报
           * EPERM（见 docs/evidence/ux-02c-02-r11/notes.md），而且此刻既不能
           * 确认磁盘、也不能安全清理 → fail-closed。释放句柄只是尽力而为，
           * 绝不因为它成功就把结果改报成"已完成"。
           */
          await handle.close().catch(() => undefined);
          return { status: 'FAILED', result: unknown() };
        }
        return { status: 'RESERVED', identity };
      };

      /**
       * 结果确认：'moved' / 'unchanged' / 'ambiguous'。绝不以"目标存在"单独推断成功。
       */
      const verify = async (): Promise<'moved' | 'unchanged' | 'ambiguous'> => {
        try {
          if (isCaseOnly) {
            const names = await readdir(dirname(targetAbs));
            return names.includes(name) ? 'moved' : 'unchanged';
          }
          let sourceGone = false;
          try {
            await lstat(sourceAbs);
          } catch (err) {
            if (!isMissing(err)) return 'ambiguous';
            sourceGone = true;
          }
          let targetInfo;
          try {
            targetInfo = await lstat(targetAbs);
          } catch (err) {
            return isMissing(err) && !sourceGone ? 'unchanged' : 'ambiguous';
          }
          if (!sourceGone) {
            // 源还在：只有目标仍是**本次占位那个对象**才算零变更。
            // 目标被外部替换（哪怕同样 0 字节）时结果不确定，绝不据外观推断。
            return (await reservationState()) === 'owned' ? 'unchanged' : 'ambiguous';
          }
          const isDir = targetInfo.isDirectory();
          if (isDir !== sourceIsDir) return 'ambiguous';
          const after = await fingerprintOf(targetAbs, isDir).catch(() => null);
          if (before !== null && after !== null && before !== after) return 'ambiguous';
          return 'moved';
        } catch {
          return 'ambiguous';
        }
      };

      const finish = async (): Promise<MoveEntryResult> => {
        // C4：副作用之后的确认链失败 → UNKNOWN，不回滚、不删除
        try {
          faults.atCheckpoint?.('C4');
          assertRootContinuity(boundary, establishedToken);
          faults.afterMove?.();
        } catch {
          return unknown();
        }
        const fileSha = !sourceIsDir && before !== null ? before.slice(before.lastIndexOf(':') + 1) : null;
        return {
          status: 'MOVED',
          sourcePath: source,
          targetPath: target,
          kind: sourceIsDir ? 'directory' : 'file',
          contentSha256: fileSha,
        };
      };

      // 10) 排他占位：占用目标名，外部进程在此期间无法创建同名对象
      let reserved = false;
      if (!isCaseOnly) {
        // 仅测试注入：模拟"目标存在性检查之后、占位之前外部创建了同名对象"
        faults.beforeMoveReserve?.();
        const first = await reserveExclusive(1);
        if (first.status === 'FAILED') return first.result;
        reservedIdentity = first.identity;
        reserved = true;
        // 仅测试注入：模拟"占位建立之后被外部删除并替换成同名文件"
        faults.afterMoveReserve?.();
      }

      // 10b) rename 前再次核对占位归属：Windows 的 rename 会覆盖已存在目标，
      // 因此"目标是不是我的占位"必须在动手前确认，而不是事后靠外观猜测。
      if (reserved) {
        const state = await reservationState();
        if (state === 'foreign') {
          // 同名路径上是外部对象：拒绝覆盖，且绝不删除它（源保持原位）
          return reject('ERR_ENTRY_EXISTS');
        }
        if (state === 'missing') {
          // 占位被外部删除但这个名字还空着：重新占一次，把竞争窗口重新收紧。
          // 与初次占位**同一段实现**、同一套失败语义（R1.2-04）。
          const again = await reserveExclusive(2);
          if (again.status === 'FAILED') return again.result;
          reservedIdentity = again.identity;
        }
      }

      /**
       * 仅测试注入：身份复核完成、rename 尚未执行（R1-05 的竞争窗口）。
       * 放在这里而不是更早，是为了让"先复核、后动手"的顺序本身可被验证。
       */
      faults.beforeMoveRename?.();

      // 11) 真正的路径变更：只覆盖我们自己的占位
      try {
        await rename(sourceAbs, targetAbs);
      } catch (err) {
        const state = await verify();
        if (state === 'moved') return finish(); // 已确认结构变更完成
        if (state === 'ambiguous') return unknown();
        // 确认零变更：只有目标仍是本次占位（dev+ino 一致）才允许清理
        if (reserved) {
          const owned = await reservationState();
          if (owned === 'foreign') return unknown(); // 外部对象：绝不删除
          if (owned === 'owned') {
            try {
              await unlink(targetAbs);
            } catch (cleanupErr) {
              if (!isMissing(cleanupErr)) return unknown();
            }
          }
          // missing：占位已不在，无需清理
        }
        return reject(moveErrorOf(err, sourceIsDir));
      }

      const state = await verify();
      if (state !== 'moved') return unknown();
      return finish();
    },

    /**
     * 把普通文件移入回收区（UX-02C-03-P2-01）。
     *
     * 与 `moveEntry` 的三点关键差异：
     * 1. **必须**给出 `expectedIdentity`，并且与磁盘对象逐次核对（意图一致性）；
     * 2. 只接受普通文件：目录 / 符号链接 / junction / 其他重解析点一律拒绝；
     * 3. 目标固定为 `.weavespace/trash/<opId>/payload`，由 Provider 自己拼，
     *    客户端无法指定内部路径（否则等于给普通接口开一条进内部目录的旁路）。
     *
     * 残留窗口如实披露：最后一次身份复核与 `rename` 之间仍有竞争（与 `moveEntry`
     * 相同，未消除）；缓解手段是"目标排他占位 + 只覆盖自己的占位"。
     */
    async trashEntry(
      opId: string,
      sourcePath: string,
      expectedIdentity: string,
    ): Promise<TrashOpResult> {
      const reject = (errorCode: ErrorCode): TrashOpResult => ({ status: 'REJECTED', errorCode });
      const unknown = (identity?: string): TrashOpResult => ({
        status: 'UNKNOWN',
        errorCode: 'ERR_OUTCOME_UNKNOWN',
        ...(identity ? { identity } : {}),
      });

      if (!TRASH_OP_ID_RE.test(opId)) return reject('ERR_COMMAND_INVALID');
      if (typeof expectedIdentity !== 'string' || expectedIdentity === '') return reject('ERR_COMMAND_INVALID');
      const srcShape = validateEntryPath(sourcePath);
      if (!srcShape.ok) return reject(srcShape.errorCode);
      const source = srcShape.value;
      if (isReservedPath(source)) return reject('ERR_PATH_RESERVED');

      try {
        faults.atCheckpoint?.('C0');
        assertRootContinuity(boundary, establishedToken);
      } catch (err) {
        return reject(mapStorageError(err) as ErrorCode);
      }

      const sourceCheck = resolveInBoundary(boundary, source);
      if (!sourceCheck.ok) return reject(sourceCheck.errorCode);
      const sourceAbs = resolvePath(boundary.canonicalRoot, normalize(source));
      if (!isPathInsideRoot(boundary.canonicalRoot, sourceAbs)) return reject('ERR_PATH_OUTSIDE_ROOT');

      let sourceStats;
      try {
        sourceStats = await lstat(sourceAbs);
      } catch (err) {
        if (isMissing(err)) return reject('ERR_RESOURCE_NOT_FOUND');
        return reject(mapStorageError(err) as ErrorCode);
      }
      // 链接 / junction / 其他重解析点 / 目录：一律拒绝，且此前没有任何副作用
      if (sourceStats.isSymbolicLink() || isUntrustedResolution(sourceAbs)) {
        return reject('ERR_TRASH_KIND_UNSUPPORTED');
      }
      if (!sourceStats.isFile()) return reject('ERR_TRASH_KIND_UNSUPPORTED');

      const sourceIdentity = `${sourceStats.dev}:${sourceStats.ino}`;
      if (sourceIdentity !== expectedIdentity) return reject('ERR_ENTRY_SOURCE_CHANGED');

      const setup = await prepareTrashRoot(boundary, establishedToken, opId);
      if (!setup.ok) return reject(setup.errorCode);

      const payloadAbs = resolvePath(boundary.canonicalRoot, normalize(trashPayloadOf(opId)));
      if (!isPathInsideRoot(boundary.canonicalRoot, payloadAbs)) return reject('ERR_PATH_OUTSIDE_ROOT');

      // 目标必须不存在：绝不覆盖回收区里已有的对象
      try {
        await lstat(payloadAbs);
        return reject('ERR_ENTRY_EXISTS');
      } catch (err) {
        if (!isMissing(err)) return reject(mapStorageError(err) as ErrorCode);
      }

      // 排他占位：谁先创建谁拥有这个名字（外部同名对象会 EEXIST）
      let reservation: EntryIdentity | null = null;
      try {
        const handle = await open(payloadAbs, 'wx');
        try {
          reservation = identityOfStats(await handle.stat());
        } catch {
          await handle.close().catch(() => undefined);
          return unknown();
        }
        await handle.close();
      } catch (err) {
        if (codeOf(err) === 'EEXIST') return reject('ERR_ENTRY_EXISTS');
        return reject(moveErrorOf(err, false));
      }

      // 回收区自描述清单（配置丢失时仍能看出这是哪个文件的什么对象）
      const manifestAbs = join(setup.opDirAbs, TRASH_MANIFEST_NAME);
      try {
        await writeFile(
          manifestAbs,
          `${JSON.stringify(
            {
              magic: TRASH_OWNER_MAGIC,
              opId,
              originalPath: source,
              entryKind: 'file',
              identity: sourceIdentity,
              size: sourceStats.size,
              deletedAt: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
          { encoding: 'utf8', flag: 'wx' },
        );
      } catch (err) {
        await releaseReservation(payloadAbs, reservation);
        return reject(codeOf(err) === 'EEXIST' ? 'ERR_ENTRY_EXISTS' : (mapStorageError(err) as ErrorCode));
      }

      // rename 前最后一次身份核对：绝不把"占着这个路径的陌生人"搬走
      try {
        const again = await lstat(sourceAbs);
        if (`${again.dev}:${again.ino}` !== expectedIdentity) {
          await releaseReservation(payloadAbs, reservation);
          return reject('ERR_ENTRY_SOURCE_CHANGED');
        }
      } catch (err) {
        await releaseReservation(payloadAbs, reservation);
        return reject(isMissing(err) ? 'ERR_RESOURCE_NOT_FOUND' : (mapStorageError(err) as ErrorCode));
      }

      try {
        faults.atCheckpoint?.('C1');
        assertRootContinuity(boundary, establishedToken);
      } catch (err) {
        await releaseReservation(payloadAbs, reservation);
        return reject(mapStorageError(err) as ErrorCode);
      }

      try {
        await rename(sourceAbs, payloadAbs);
      } catch (err) {
        // rename 可能已经生效也可能没有：只按磁盘事实判定，不猜
        if (await objectMatchesIdentity(payloadAbs, expectedIdentity)) {
          // 落到下面的验证分支
        } else {
          await releaseReservation(payloadAbs, reservation);
          return reject(moveErrorOf(err, false));
        }
      }

      let sourceGone = false;
      try {
        await lstat(sourceAbs);
      } catch (err) {
        if (isMissing(err)) sourceGone = true;
        else return unknown();
      }
      const payloadOk = await objectMatchesIdentity(payloadAbs, expectedIdentity);
      if (!sourceGone || !payloadOk) return unknown(payloadOk ? expectedIdentity : undefined);

      try {
        faults.atCheckpoint?.('C4');
        assertRootContinuity(boundary, establishedToken);
      } catch {
        // 副作用已发生但确认链断了：只能 UNKNOWN；配置侧会停在 pending 由对账收敛
        return unknown(expectedIdentity);
      }

      return { status: 'MOVED', identity: expectedIdentity, size: sourceStats.size };
    },

    /**
     * 从回收区恢复到指定路径（UX-02C-03-P2-01）。
     *
     * 三条硬约束：
     * - 目标已存在 → `ERR_ENTRY_EXISTS`，绝不覆盖（产品规则 7）；
     * - 回收区对象身份必须等于记录身份，否则 `ERR_TRASH_STATE_CONFLICT`；
     * - 仍然用"排他占位 + 只覆盖自己的占位"来兜 Windows 的覆盖语义。
     */
    async restoreEntry(
      opId: string,
      targetPath: string,
      expectedIdentity: string,
    ): Promise<TrashOpResult> {
      const reject = (errorCode: ErrorCode): TrashOpResult => ({ status: 'REJECTED', errorCode });
      const unknown = (identity?: string): TrashOpResult => ({
        status: 'UNKNOWN',
        errorCode: 'ERR_OUTCOME_UNKNOWN',
        ...(identity ? { identity } : {}),
      });

      if (!TRASH_OP_ID_RE.test(opId)) return reject('ERR_COMMAND_INVALID');
      if (typeof expectedIdentity !== 'string' || expectedIdentity === '') return reject('ERR_COMMAND_INVALID');
      const targetShape = validateEntryPath(targetPath);
      if (!targetShape.ok) return reject(targetShape.errorCode);
      const target = targetShape.value;
      if (isReservedPath(target)) return reject('ERR_PATH_RESERVED');

      try {
        faults.atCheckpoint?.('C0');
        assertRootContinuity(boundary, establishedToken);
      } catch (err) {
        return reject(mapStorageError(err) as ErrorCode);
      }

      const payloadAbs = resolvePath(boundary.canonicalRoot, normalize(trashPayloadOf(opId)));
      if (!isPathInsideRoot(boundary.canonicalRoot, payloadAbs)) return reject('ERR_PATH_OUTSIDE_ROOT');

      let payloadStats;
      try {
        payloadStats = await lstat(payloadAbs);
      } catch (err) {
        if (isMissing(err)) return reject('ERR_TRASH_RECORD_NOT_FOUND');
        return reject(mapStorageError(err) as ErrorCode);
      }
      if (payloadStats.isSymbolicLink() || isUntrustedResolution(payloadAbs) || !payloadStats.isFile()) {
        return reject('ERR_TRASH_STATE_CONFLICT');
      }
      if (`${payloadStats.dev}:${payloadStats.ino}` !== expectedIdentity) {
        return reject('ERR_TRASH_STATE_CONFLICT');
      }

      const targetDir = parentDirOfEntry(target);
      const parentCheck = resolveInBoundary(boundary, targetDir === '' ? '.' : targetDir);
      if (!parentCheck.ok) return reject(parentCheck.errorCode);
      try {
        const info = await lstat(parentCheck.absolutePath);
        if (!info.isDirectory() || info.isSymbolicLink() || isUntrustedResolution(parentCheck.absolutePath)) {
          return reject('ERR_ENTRY_PARENT_INVALID');
        }
      } catch (err) {
        if (isMissing(err)) return reject('ERR_ENTRY_PARENT_INVALID');
        return reject(mapStorageError(err) as ErrorCode);
      }

      const targetAbs = resolvePath(boundary.canonicalRoot, normalize(target));
      if (!isPathInsideRoot(boundary.canonicalRoot, targetAbs)) return reject('ERR_PATH_OUTSIDE_ROOT');
      if (basename(targetAbs) !== entryNameOf(target)) return reject('ERR_ENTRY_NAME_INVALID');

      // 目标存在即拒绝：这一条不是"检查后覆盖"，而是"发现即结束"
      try {
        await lstat(targetAbs);
        return reject('ERR_ENTRY_EXISTS');
      } catch (err) {
        if (!isMissing(err)) return reject(mapStorageError(err) as ErrorCode);
      }

      let reservation: EntryIdentity | null = null;
      try {
        const handle = await open(targetAbs, 'wx');
        try {
          reservation = identityOfStats(await handle.stat());
        } catch {
          await handle.close().catch(() => undefined);
          return unknown();
        }
        await handle.close();
      } catch (err) {
        if (codeOf(err) === 'EEXIST') return reject('ERR_ENTRY_EXISTS');
        return reject(moveErrorOf(err, false));
      }

      // 占位建立后再核一次：回收区里的对象可能在这期间被外部替换
      if (!(await objectMatchesIdentity(payloadAbs, expectedIdentity))) {
        await releaseReservation(targetAbs, reservation);
        return reject('ERR_TRASH_STATE_CONFLICT');
      }

      try {
        faults.atCheckpoint?.('C1');
        assertRootContinuity(boundary, establishedToken);
      } catch (err) {
        await releaseReservation(targetAbs, reservation);
        return reject(mapStorageError(err) as ErrorCode);
      }

      try {
        await rename(payloadAbs, targetAbs);
      } catch (err) {
        if (await objectMatchesIdentity(targetAbs, expectedIdentity)) {
          // 落到下面的验证分支
        } else {
          await releaseReservation(targetAbs, reservation);
          return reject(moveErrorOf(err, false));
        }
      }

      let payloadGone = false;
      try {
        await lstat(payloadAbs);
      } catch (err) {
        if (isMissing(err)) payloadGone = true;
        else return unknown();
      }
      const targetOk = await objectMatchesIdentity(targetAbs, expectedIdentity);
      if (!payloadGone || !targetOk) return unknown(targetOk ? expectedIdentity : undefined);

      try {
        faults.atCheckpoint?.('C4');
        assertRootContinuity(boundary, establishedToken);
      } catch {
        return unknown(expectedIdentity);
      }

      return { status: 'MOVED', identity: expectedIdentity, size: payloadStats.size };
    },

    /** 回收区对象身份（只读，供 Host 对账）。不存在 → `null`。 */
    async trashIdentity(opId: string): Promise<string | null> {
      if (!TRASH_OP_ID_RE.test(opId)) {
        throw Object.assign(new Error('非法的 opId'), { errorCode: 'ERR_COMMAND_INVALID' });
      }
      const payloadAbs = resolvePath(boundary.canonicalRoot, normalize(trashPayloadOf(opId)));
      if (!isPathInsideRoot(boundary.canonicalRoot, payloadAbs)) {
        throw Object.assign(new Error('路径不在允许范围内'), { errorCode: 'ERR_PATH_OUTSIDE_ROOT' });
      }
      try {
        const info = await lstat(payloadAbs);
        if (info.isSymbolicLink() || isUntrustedResolution(payloadAbs) || !info.isFile()) return null;
        return `${info.dev}:${info.ino}`;
      } catch (err) {
        if (isMissing(err)) return null;
        throw toStorageError(err);
      }
    },
  };
}

/**
 * 把「形态明显安全」的相对路径拆成段；不安全形态返回 null（UX-02B-TREE-R2）。
 *
 * 这不是授权判定（授权仍由 `resolveInBoundary` 负责），只决定"要不要做链接诊断"：
 * 含 `..`、绝对路径、盘符、UNC、NUL、空段的请求一律跳过诊断，直接进入正式解析，
 * 避免为了一次诊断去拼出可疑的字面路径。
 *
 * 与旧 `literalPathIfSafe` 的关键区别：这里**不拼接完整绝对路径**，
 * 只交出段名；父链由 `resolveInBoundary` 逐级确认后才允许拼末段。
 */
function safeSegmentsOf(requested: string): string[] | null {
  if (requested.includes('\0')) return null;
  const unified = requested.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) return null;
  const segments = unified.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return segments;
}
