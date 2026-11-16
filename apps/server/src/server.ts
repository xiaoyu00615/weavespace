/**
 * WeaveSpace localhost Client API（S9-B）。
 *
 * 定位：浏览器与 Core 之间**唯一的**本机通道。浏览器不接触文件系统、不接触 SQLite，
 * 也不能选择磁盘目录；项目根由启动参数（可信配置）确定。
 *
 * 安全边界：
 * - 只绑定 127.0.0.1；
 * - 校验 `Host`（拒绝 DNS rebinding）、`Origin`（写请求必须同源/白名单）、
 *   `Sec-Fetch-Site`（拒绝 cross-site）；
 * - 只接受 `application/json`，请求体上限 1 MiB；
 * - actorId 由服务端固定绑定，请求体里出现 `actorId` 直接拒绝（不接受客户端自述身份）；
 * - 不提供任何「传路径就读写磁盘」的裸接口：所有读写都经 CommandBus + PermissionService；
 * - 不发送 CORS 通配头；页面走 Vite 同源代理，不需要跨源访问。
 *
 * 接口（全部返回 JSON，`status` 是权威结果，HTTP 200 不等于成功）：
 *   GET  /api/health                     健康检查
 *   GET  /api/resources                  已授权的项目文件树（旧端点，输出冻结）
 *   GET  /api/tree                      逐层、可分页的真实文件树（UX-02B-TREE）
 *   POST /api/open      {path}           经 CommandBus 打开会话（返回会话句柄 + 正文）
 *   GET  /api/document  ?sessionId&viewId 经授权读取会话正文与版本
 *   POST /api/edit      {sessionId, buffer, expectedVersion?}
 *   POST /api/save      {sessionId, expectedVersion}
 *   POST /api/close     {sessionId, viewId}
 *   GET  /api/document/disk ?sessionId&viewId  只读查看磁盘上的当前版本（冲突恢复用）
 *   POST /api/reload    {sessionId, viewId, discardDraft:true}  用磁盘内容覆盖会话（需显式确认）
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename } from 'node:path';
import { createCommandBus, type CommandBus } from '../../../packages/command/index.ts';
import { ERROR_CODES, type ErrorCode } from '../../../packages/contracts/index.ts';
import { createDocumentService, type DocumentService } from '../../../packages/document/index.ts';
import { createPermissionService, type PermissionService } from '../../../packages/permission/index.ts';
import { realpathSync } from 'node:fs';
import {
  createLocalProvider,
  rootTokenOf,
  type StorageFaultHooks,
  type StorageProvider,
} from '../../../packages/storage/index.ts';
import {
  createProjectRegistry,
  loadWorkspaceConfig,
  type ProjectHandle,
  type ProjectRegistry,
  type WorkspaceConfig,
} from '../../../packages/project-registry/index.ts';
import { buildResourceTree, buildTreePage, TREE_PAGE_DEFAULT_LIMIT, TREE_PAGE_MAX_LIMIT, type ResourceNodeDto } from './tree.ts';
import { createProjectRuntime, type ProjectRuntime } from './project-runtime.ts';
import { createFileProjectStore, type FileProjectStore, type StoreIo } from './store/index.ts';
import { createHostFolderPicker, type ExecFileImpl, type FolderPicker } from './folder-picker/index.ts';
import { createIntentRegistry, type IntentRegistry } from './project-intents.ts';
import { createPickRegistry, type PickRegistry } from './pick-registry.ts';
import { createSessionTokenStore, type SessionTokenStore } from './session-token.ts';
import {
  createManagedEntry,
  parseCreateEntryBody,
  type CreateEntryKind,
} from './create-entry.ts';
import type { StructureChangeCapability } from './project-runtime.ts';
import {
  parseStructureBody,
  runManagedStructureChange,
  type StructureKind,
} from './structure-change.ts';

export type SaveOutcomeStatus = 'COMMITTED' | 'CONFLICT' | 'FAILED' | 'UNKNOWN';

export interface DocumentDto {
  sessionId: string;
  viewId: string | null;
  resourceId: string;
  path: string;
  /** 草稿正文；项目级失败响应（G1-R1）中会被省略，避免把草稿复制进错误响应。 */
  content?: string;
  baseVersion: string | null;
  revision: number;
  dirty: boolean;
  documentState: string;
  /** 会话所属项目（Multi）；Legacy 不返回该字段。 */
  projectId?: string;
  /** 失效标记（G1）：与 documentState 正交，表示磁盘访问已被拒绝。 */
  stale?: { reason: string; since: string };
}

export interface ShellServerOptions {
  /** Legacy：受信任的项目根，只能来自启动配置，不能来自请求。 */
  rootDir?: string;
  /** Multi：已校验的工作区配置（与 workspacePath 二选一）。 */
  workspace?: WorkspaceConfig;
  /** Multi：工作区配置文件路径；启动时读取一次。 */
  workspacePath?: string;
  /**
   * 已获授权的项目（G1-05）。缺省 = 配置内的全部项目。
   * 仅这些项目会建立 `local:<projectId>` 授权记录；未列出的项目一律 403。
   */
  grantedProjects?: readonly string[];
  /** 0 表示由系统分配（测试用）。默认 5177。 */
  port?: number;
  /** 默认 127.0.0.1；只允许回环地址。 */
  host?: string;
  /** 服务端固定绑定的本地 actor；请求无法覆盖。 */
  actorId?: string;
  /** 允许的浏览器来源（写请求校验 Origin）。缺省为同源 + 本机 Vite 开发服务器。 */
  allowedOrigins?: readonly string[];
  maxBodyBytes?: number;
  /** 仅测试注入：透传给 StorageProvider 的故障钩子（用于制造 UNKNOWN）。 */
  providerFaults?: StorageFaultHooks;
  /**
   * 托管模式（UX-02B-01）：由调用方提供运行期工厂，Host 不再持有静态 Registry。
   *
   * **仅用于测试与内部接线**：CLI 不提供该入口，因此生产进程无法进入托管模式，
   * 也就不存在"绕过持久化做撤销"的路径（真实持久化见 UX-02B-02）。
   * 与 `rootDir` / `workspace` / `workspacePath` 互斥。
   */
  managed?: { create(deps: ManagedRuntimeDeps): ProjectRuntime };
  /**
   * 托管模式（UX-02B-03）的生产接线：`--workspace-store <dir>` 指向的存储目录。
   *
   * Host 自己创建 `FileProjectStore` 与 `ProjectRuntime`，并持有唯一的
   * `FolderPicker`。与 `managed`（测试用工厂）、`rootDir`、`workspace` 全部互斥。
   *
   * `picker` 缺省按平台建（Windows → 系统对话框，可交互终端 → stdin，其余不可用）。
   * 只有真实选择器成功返回的目录，才会以 `grantSource: 'os-dialog'` 进入事务；
   * 任何 HTTP 字段都无法替代它。
   */
  managedStore?: {
    /** 存储目录（`workspace.json` / `revocations.jsonl` / 锁文件所在处）。 */
    readonly dir: string;
    /** 仅测试注入：替换选择器。生产不传。 */
    readonly picker?: FolderPicker;
    /** 仅测试注入：替换存储 I/O 层。 */
    readonly storeIo?: StoreIo;
    /** 仅测试注入：替换 Windows 选择器的进程调用。 */
    readonly execFileImpl?: ExecFileImpl;
    /** 意图 TTL（默认 120s）；仅测试会改。 */
    readonly intentTtlMs?: number;
    /** 选择器超时（默认 120s）；仅测试会改。 */
    readonly pickerTimeoutMs?: number;
    /** 仅测试注入：可控时钟（意图过期/请求保留期断言用）。 */
    readonly now?: () => number;
  };
  /**
   * 仅测试注入：**包裹**内置授权表的观察/拦截层。
   *
   * 生产代码仍然自己构造授权表（Legacy 的全项目授权、Multi 的逐项目 grant），
   * 这里只能在其外面加一层观察，不能替换授权表内容，因此不会改变任何真实授权语义。
   * 用途：验证 Legacy 的读取授权仍被强制执行、Multi 的 G-DRAFT 不依赖项目 grant。
   */
  permissionWrapper?: (inner: PermissionService) => PermissionService;
}

/** 托管模式下由 Host 提供给 Runtime 的依赖（Runtime 拥有 grants 与 Provider 表）。 */
export interface ManagedRuntimeDeps {
  actorId: string;
  document: DocumentService;
  permission: PermissionService;
}

export type ShellServerMode = 'legacy' | 'multi';

export interface ShellServer {
  readonly url: string;
  readonly port: number;
  readonly actorId: string;
  /** Legacy 为项目根；Multi 为空串（不向外部暴露任何本机路径）。 */
  readonly rootDir: string;
  readonly mode: ShellServerMode;
  close(): Promise<void>;
}

/** 把 Core/Storage 的错误码映射成 HTTP 语义（对外仍是 JSON + status）。 */
function httpStatusOfDomainError(errorCode: string | undefined): number {
  switch (errorCode) {
    case 'ERR_DOCUMENT_DIRTY':
    case 'ERR_DOCUMENT_VERSION_CONFLICT':
    case 'ERR_PROJECT_QUIESCING':
    case 'ERR_PROJECT_BUSY':
    case 'ERR_STORE_LOCKED':
    case 'ERR_STORE_ID_REUSED':
    // 同一个 opId 不能代表两次事务：属于"请求与既有证据冲突"，不是可重试的 IO 失败
    case 'ERR_OP_ID_CONFLICT':
    case 'ERR_PICKER_BUSY':
    // 同名目标必须零变更地拒绝：不是"可重试的 IO 失败"，而是明确的冲突
    case 'ERR_ENTRY_EXISTS':
    // 目录在本轮分页期间发生变化：客户端必须刷新整层，不能拿旧游标续页
    case 'ERR_DIR_CHANGED':
    // 结构变更：源路径下仍有活动 View / 危险会话，或屏障正忙（零磁盘副作用）
    case 'ERR_STRUCTURE_SESSION_BUSY':
    // Windows 上目录被占用，无法完成改名/移动
    case 'ERR_ENTRY_DIR_BUSY':
      return 409;
    // 意图/请求凭据类：一律 410，避免用不同状态码区分"过期/已用/不存在"（可探测性）
    case 'ERR_INTENT_EXPIRED':
    case 'ERR_INTENT_CONSUMED':
    case 'ERR_INTENT_INVALID':
    case 'ERR_PICK_REQUEST_GONE':
      return 410;
    // 选择器不可用 / 变更端点不支持：语义明确地"服务不提供该能力"，不是客户端错误
    case 'ERR_PICKER_UNAVAILABLE':
    case 'ERR_COMMAND_UNSUPPORTED':
      return 501;
    // 403 组：授权/路径越界/身份冲突/撤销待核对。
    // `ERR_DIR_UNREADABLE` 也落在 403（HTTP 语义所限），但它是**环境事实**而非策略判定，
    // 错误码与文案必须与 `ERR_PERMISSION_DENIED` 分开（契约 B.6 / T-22）。
    case 'ERR_PERMISSION_DENIED':
    case 'ERR_PATH_OUTSIDE_ROOT':
    case 'ERR_RESOURCE_IDENTITY_CONFLICT':
    case 'ERR_PROJECT_REVOKE_UNKNOWN':
    case 'ERR_DIR_UNREADABLE':
      return 403;
    // 链接不可展开：客户端指错了对象（既不是路径越界，也不是权限问题）。
    case 'ERR_DIR_IS_LINK':
      return 400;
    case 'ERR_RESOURCE_NOT_FOUND':
    case 'ERR_DOCUMENT_NOT_FOUND':
      return 404;
    case 'ERR_RESOURCE_NOT_TEXT':
    case 'ERR_ENCODING_UNSUPPORTED':
    case 'ERR_SAVE_FAILED':
    case 'ERR_STORAGE_IO':
      return 422;
    // 根目录连续性（G0）：项目根不可用既不是"不存在"也不是"冲突"，
    // 用 503 表达"暂时不可用，需重新建立 provider/重启"，避免误报 404/409/500。
    case 'ERR_ROOT_CHANGED':
    case 'ERR_ROOT_IDENTITY_UNSUPPORTED':
    case 'ERR_PROJECT_UNAVAILABLE':
    case 'ERR_STORE_RESTRICTED':
      return 503;
    case 'ERR_PROJECT_REQUIRED':
    case 'ERR_PROJECT_CONFIG_INVALID':
    case 'ERR_PROJECT_DUPLICATE_ROOT':
    case 'ERR_PROJECT_NESTED_ROOT':
      return 400;
    // 输入本身不合法（名称过长/含控制字符/缺必填参数）：这是**客户端错误**，
    // 不是"服务端无法处理"（422）。UX-02B-03-R1 修正：此前落到默认 500，
    // 会让"名字太长"看起来像 Host 内部故障，且掩盖了零副作用的事实。
    case 'ERR_COMMAND_INVALID':
    case 'ERR_ENTRY_NAME_INVALID':
    case 'ERR_ENTRY_PARENT_INVALID':
    case 'ERR_ENTRY_SOURCE_INVALID':
    case 'ERR_MOVE_INTO_DESCENDANT':
      return 400;
    // 跨卷移动首版不支持（不做"复制 + 删除"的部分成功链路）
    case 'ERR_MOVE_CROSS_VOLUME':
      return 422;
    case 'ERR_PROJECT_NOT_FOUND':
      return 404;
    case 'ERR_SESSION_STALE':
      return 409;
    default:
      return 500;
  }
}

class HttpError extends Error {
  readonly statusCode: number;
  readonly errorCode: string;

  constructor(statusCode: number, errorCode: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

/**
 * 对外错误文案（G0-R2）。
 *
 * 未预期异常一律不得把原始 message 回给浏览器：Storage 的根错误消息里带有本机绝对路径
 * （例如 `根目录已不存在，无法确认根身份: C:\Users\...\project`）。这里用固定文案替代，
 * 错误码保持可识别，便于调用方与 UI 分流。
 */
const PUBLIC_ERROR_MESSAGES: Partial<Record<ErrorCode, string>> = {
  ERR_ROOT_CHANGED: '项目根目录不可用（已失效或被替换）',
  ERR_ROOT_IDENTITY_UNSUPPORTED: '项目根目录身份无法确认',
  ERR_PATH_OUTSIDE_ROOT: '路径不在允许范围内',
  ERR_PERMISSION_DENIED: '权限不足',
  /**
   * 注意：这里**不能**写"权限"。目录读不出来不是授权问题，
   * 说成"权限不足"会让用户去重新授权一个其实已授权的项目（契约 B.6）。
   */
  ERR_DIR_UNREADABLE: '无法读取此文件夹',
  ERR_DIR_IS_LINK: '链接节点不能展开（避免越过项目根）',
  /** 目录变化不是权限、不是越界：文案必须明确告诉用户"刷新"，不得含本机路径。 */
  ERR_DIR_CHANGED: '目录已变化，请刷新',
  ERR_RESOURCE_NOT_FOUND: '资源不存在',
  ERR_DOCUMENT_NOT_FOUND: '文档会话不存在',
  ERR_STORAGE_IO: '存储访问失败',
  ERR_RESOURCE_NOT_TEXT: '资源不是可编辑文本',
  ERR_ENCODING_UNSUPPORTED: '资源编码不受支持',
  ERR_SAVE_FAILED: '保存失败',
  ERR_DOCUMENT_DIRTY: '存在未保存修改',
  ERR_DOCUMENT_VERSION_CONFLICT: '内容版本冲突',
  ERR_OUTCOME_UNKNOWN: '保存结果未确认',
  ERR_ENTRY_NAME_INVALID: '名称不合法：请检查非法字符、系统保留名或结尾的空格与句点',
  ERR_ENTRY_EXISTS: '该位置已有同名文件或文件夹，未覆盖任何内容',
  ERR_ENTRY_PARENT_INVALID: '目标文件夹不存在或不是普通目录（不会自动创建缺失目录）',
  ERR_ENTRY_SOURCE_INVALID: '源条目不存在或不是普通文件/文件夹',
  ERR_STRUCTURE_SESSION_BUSY:
    '该文件（或目录内文件）仍有打开的编辑标签、未保存草稿或结果未明的保存；请先处理后再操作',
  ERR_MOVE_INTO_DESCENDANT: '不能把文件夹移动到自身或它的子文件夹内',
  ERR_MOVE_CROSS_VOLUME: '跨磁盘分区的移动暂不支持（未复制也未删除任何文件）',
  ERR_ENTRY_DIR_BUSY: '文件夹正被占用（可能被其他程序打开），请关闭后重试',
  ERR_PROJECT_REQUIRED: '必须声明 projectId',
  ERR_PROJECT_NOT_FOUND: '项目不存在',
  ERR_PROJECT_UNAVAILABLE: '项目当前不可用（根目录缺失、被替换或不可读）',
  ERR_PROJECT_CONFIG_INVALID: '工作区配置不合法',
  ERR_PROJECT_DUPLICATE_ROOT: '工作区配置中存在重复的项目根',
  ERR_PROJECT_NESTED_ROOT: '工作区配置中存在嵌套的项目根',
  ERR_PROJECT_QUIESCING: '项目正在移除中，暂不接受磁盘操作',
  ERR_PROJECT_BUSY: '项目当前有其他变更或未结束的操作',
  ERR_PROJECT_REVOKE_UNKNOWN: '项目撤销结果待核对，磁盘访问被拒绝（草稿仍可读取）',
  ERR_PERSIST_FAILED: '变更未被持久化，状态未改变，可重试',
  ERR_STORE_LOCKED: '工作区存储已被另一个实例占用',
  ERR_STORE_RESTRICTED: '工作区存储处于受限状态，暂不接受变更（需重启或人工修复）',
  ERR_STORE_ID_REUSED: '项目标识已签发过，不能复用',
  ERR_OP_ID_CONFLICT: '操作编号已被另一次变更占用，请重新发起',
  ERR_SESSION_STALE: '会话已失效（项目不可用），草稿仍保留',
  ERR_PICKER_UNAVAILABLE:
    '本机目录选择器不可用（无图形界面 / 被策略拦截 / 超时），请改用静态配置启动',
  ERR_PICKER_BUSY: '已有一次目录选择正在进行，请先完成或等待其超时',
  ERR_INTENT_EXPIRED: '变更意图已过期，请重新发起',
  ERR_INTENT_CONSUMED: '变更意图已被使用，不可重放',
  ERR_INTENT_INVALID: '变更意图无效',
  ERR_PICK_REQUEST_GONE: '目录选择请求已不存在（Host 可能已重启），请重试',
  ERR_COMMAND_UNSUPPORTED: '当前运行模式不提供该接口',
};

function publicMessageOf(errorCode: ErrorCode): string {
  return PUBLIC_ERROR_MESSAGES[errorCode] ?? '请求处理失败';
}

/* ---------------- `/api/tree` 的参数校验（UX-02B-TREE） ---------------- */

/**
 * 层路径校验（契约 B.2.1 / 文档 26 §4.1）。
 *
 * 只接受**项目内相对路径**，且必须能在"不碰磁盘"的前提下判完：
 * 绝对路径、盘符、UNC、`..`/`.` 段、反斜杠、NUL、空段一律 400。
 * 这不是授权判定（越界由 storage 的 `resolveInBoundary` 负责），
 * 目的是让明显非法的输入在读盘之前就被拒（T-10 的"零 IO"）。
 */
function parseTreeDir(raw: string | null): string {
  if (raw === null || raw === '') return '';
  if (raw.length > 4096) throw new HttpError(400, 'ERR_COMMAND_INVALID', 'dir 过长');
  if (raw.includes('\0')) throw new HttpError(400, 'ERR_COMMAND_INVALID', 'dir 含非法字符');
  // 统一用正斜杠：反斜杠会与 Windows 分隔符产生歧义，且可能被用来绕过段级校验
  if (raw.includes('\\')) throw new HttpError(400, 'ERR_COMMAND_INVALID', 'dir 必须使用正斜杠');
  if (raw.startsWith('/')) throw new HttpError(400, 'ERR_COMMAND_INVALID', '不接受绝对路径或 UNC');
  if (/^[A-Za-z]:/.test(raw)) throw new HttpError(400, 'ERR_COMMAND_INVALID', '不接受盘符路径');
  const segments = raw.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new HttpError(400, 'ERR_COMMAND_INVALID', 'dir 含空段或相对段');
    }
  }
  return segments.join('/');
}

/**
 * 游标 = 不透明字符串（当前实现是十进制偏移量）。
 *
 * 客户端不得解析或构造它；这里做严格格式校验，非法即 400 且不读盘。
 * 超出总数的游标是**合法**的：返回空页 + `nextCursor: null`（幂等终点）。
 */
function parseTreeCursor(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  if (!/^(0|[1-9][0-9]{0,9})$/.test(raw)) {
    throw new HttpError(400, 'ERR_COMMAND_INVALID', 'cursor 不合法');
  }
  return Number(raw);
}

/**
 * 目录快照标识（UX-02B-TREE-R1 / 契约 B.2.2）。
 *
 * 不透明字符串，客户端原样回传；这里只做**严格形状校验**，不解释内容。
 * 非法值在读盘之前 400（零 IO）；合法但与当前目录不符由 `buildTreePage` 判 409。
 * 缺省 null 表示"不带快照的旧客户端"，保持既有分页形状兼容。
 */
function parseTreeSnapshot(raw: string | null): string | null {
  if (raw === null || raw === '') return null;
  if (!/^[0-9a-f]{32}$/.test(raw)) {
    throw new HttpError(400, 'ERR_COMMAND_INVALID', 'snapshot 不合法');
  }
  return raw;
}

/** 每页条数：缺省 200，范围 1–2000（契约 B.2.1）。它**不是**单层可见上限。 */
function parseTreeLimit(raw: string | null): number {
  if (raw === null) return TREE_PAGE_DEFAULT_LIMIT;
  if (!/^[0-9]{1,4}$/.test(raw)) throw new HttpError(400, 'ERR_COMMAND_INVALID', 'limit 不合法');
  const value = Number(raw);
  if (value < 1 || value > TREE_PAGE_MAX_LIMIT) {
    throw new HttpError(400, 'ERR_COMMAND_INVALID', `limit 必须在 1–${TREE_PAGE_MAX_LIMIT} 之间`);
  }
  return value;
}

/**
 * 未预期异常的统一安全出口（G0-R2）。
 *
 * - 已知领域错误码：按语义映射 HTTP 状态（根连续性 → 503），错误码原样保留；
 * - 未知异常：500 + 通用文案，绝不回传原始 message（可能含本机绝对路径）。
 */
function toPublicHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const raw = (err as { errorCode?: string } | undefined)?.errorCode;
  if (typeof raw === 'string' && raw in ERROR_CODES) {
    const code = raw as ErrorCode;
    return new HttpError(httpStatusOfDomainError(code), code, publicMessageOf(code));
  }
  return new HttpError(500, 'ERR_COMMAND_INTERNAL', '内部错误');
}

const DEFAULT_PORT = 5177;
const DEFAULT_MAX_BODY = 1024 * 1024;
const VITE_DEV_ORIGINS = ['http://127.0.0.1:5178', 'http://localhost:5178'];

/**
 * 绑定地址校验（F03）：只接受明确验证过的回环地址。
 * 请求侧 Host 检查不能替代它——`0.0.0.0` 监听会让局域网直连，此时浏览器仍可伪造 Host。
 */
function isLoopbackBindHost(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (/^127(\.\d{1,3}){3}$/.test(bare)) return true;
  if (bare === '::1') return true;
  return bare.toLowerCase() === 'localhost';
}

/** 只允许回环主机名，任何域名（DNS rebinding 的典型形态）一律拒绝。 */
function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host) || /^\[::1\](:\d+)?$/i.test(host);
}

/**
 * 规范化项目内相对路径。
 * 越界（`..`）、绝对路径、盘符、NUL 一律返回 null —— 早于授权层拒绝，错误更明确。
 */
function normalizeProjectPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw === '' || raw.includes('\0')) return null;
  const unified = raw.replace(/\\/g, '/');
  if (unified.startsWith('/')) return null;
  if (/^[A-Za-z]:/.test(unified)) return null;
  const segments: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join('/') : null;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    // 显式声明不允许被嵌入/嗅探；不设置任何 CORS 头
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
  res.end(payload);
}

async function readJsonBody(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<Record<string, unknown>> {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new HttpError(415, 'ERR_COMMAND_INVALID', '仅接受 application/json');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBodyBytes) {
      throw new HttpError(413, 'ERR_COMMAND_INVALID', `请求体超过上限 ${maxBodyBytes} 字节`);
    }
    chunks.push(buf);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'ERR_COMMAND_INVALID', '请求体不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'ERR_COMMAND_INVALID', '请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

/**
 * 拒绝客户端自述的可信字段：actorId / rootDir / 任意 providerId。
 * 这些值只能来自服务端配置，出现即视为越权尝试。
 */
function rejectTrustedFields(body: Record<string, unknown>, mode: ShellServerMode): void {
  if ('actorId' in body) {
    throw new HttpError(400, 'ERR_COMMAND_INVALID', '不接受客户端提供的 actorId');
  }
  if ('rootDir' in body || 'root' in body) {
    throw new HttpError(400, 'ERR_COMMAND_INVALID', '项目根由启动配置决定，不接受客户端指定');
  }
  // Multi：providerId 只能由 Host 从 Registry 派生，出现即视为越权尝试
  if (mode === 'multi' && 'providerId' in body) {
    throw new HttpError(403, 'ERR_PERMISSION_DENIED', 'providerId 由服务端从项目派生，不接受客户端指定');
  }
  if (mode === 'legacy' && 'providerId' in body && body.providerId !== 'local') {
    throw new HttpError(403, 'ERR_PERMISSION_DENIED', '本项目只允许本地 Provider');
  }
}

interface ViewRecord {
  sessionId: string;
  resourceId: string;
  path: string;
  /** 创建该视图的服务端 actor（G1-09）：草稿门禁据此拒绝跨主体猜读。 */
  actorId: string;
  /**
   * 页面实例归属（UX-02C-02-R1）：仅用于识别"同一个浏览器页面"。
   *
   * 只解决一个问题：同一页面刷新后重新打开同一资源时，旧 View 已经没有任何
   * 客户端会去关闭它（页面上下文没了），必须由 Host 在**新 View 登记成功后**
   * 释放。**不是授权凭据**——它从不参与任何授权判定，`null` 表示旧客户端。
   */
  clientInstanceId: string | null;
}

/**
 * 校验页面实例 id（UX-02C-02-R1）。只约束形状，不做任何授权语义：
 * 长度与字符集限得很死，避免把它当成任意负载塞进 Host 内存。
 */
/**
 * 是否申请回收本页面遗留的旧 View（UX-02C-02-R1.1）。
 *
 * **只有页面恢复流程**才会传 `true`（刷新后重建标签）。普通打开、临时打开
 * （例如 refreshCleanTab 用 open 核对磁盘）一律不传——把"每一次同页 open"
 * 都当成恢复，就会把当前标签正在使用的 View 关掉。
 */
function parseReclaimPrevious(body: Record<string, unknown>): boolean {
  const raw = body.reclaimPrevious;
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== 'boolean') {
    throw new HttpError(400, 'ERR_COMMAND_INVALID', 'reclaimPrevious 必须是布尔值');
  }
  return raw;
}

/**
 * 一次"回收本页面遗留 View"请求最多处理多少条路径（UX-02C-02-R1.2）。
 *
 * 上限只防"把整棵树的路径全塞进来"这种滥用：恢复记录本身最多 24 个标签，
 * 64 条已经足够宽松，同时保证这次内存操作不会被拉长到影响其它请求。
 */
const MAX_RECLAIM_PATHS = 64;

function parseClientInstanceId(body: Record<string, unknown>): string | null {
  const raw = body.clientInstanceId;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new HttpError(400, 'ERR_COMMAND_INVALID', 'clientInstanceId 必须是字符串');
  }
  if (!/^[A-Za-z0-9._-]{8,64}$/.test(raw)) {
    throw new HttpError(400, 'ERR_COMMAND_INVALID', 'clientInstanceId 形状非法');
  }
  return raw;
}

export async function createShellServer(options: ShellServerOptions): Promise<ShellServer> {
  const actorId = options.actorId ?? 'local-user';
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const bindHost = options.host ?? '127.0.0.1';

  // 必须在建 provider / listen 之前拒绝：非回环绑定等于把服务暴露给整个网络
  if (!isLoopbackBindHost(bindHost)) {
    throw Object.assign(
      new Error(`拒绝绑定非回环地址: ${bindHost}（本服务只能监听 127.0.0.1 / ::1 / localhost）`),
      { errorCode: 'ERR_PERMISSION_DENIED' as const },
    );
  }

  // ---- 模式判定（G1-03）：Legacy 单根 / 静态 Multi / 托管 Multi，三者互斥 ----
  const wantsManagedStore = options.managedStore !== undefined;
  const wantsManaged = options.managed !== undefined || wantsManagedStore;
  const wantsStaticMulti = options.workspace !== undefined || options.workspacePath !== undefined;
  const wantsMulti = wantsManaged || wantsStaticMulti;
  if (wantsManagedStore && options.managed !== undefined) {
    // 两套 Runtime 工厂同时存在 → 谁持有项目权威不明确，必须拒绝
    throw Object.assign(
      new Error('启动参数冲突：managed 与 managedStore 不能同时提供（项目权威必须唯一）'),
      { errorCode: 'ERR_PROJECT_CONFIG_INVALID' as const },
    );
  }
  if (wantsManaged && wantsStaticMulti) {
    throw Object.assign(
      new Error('启动参数冲突：托管模式与静态工作区配置互斥（不能同时持有两套项目权威）'),
      { errorCode: 'ERR_PROJECT_CONFIG_INVALID' as const },
    );
  }
  if (wantsMulti && options.rootDir !== undefined) {
    throw Object.assign(
      new Error('启动参数冲突：不能同时指定项目根与工作区配置（Legacy 与 Multi 不得混用身份）'),
      { errorCode: 'ERR_PROJECT_CONFIG_INVALID' as const },
    );
  }
  if (!wantsMulti && (options.rootDir === undefined || options.rootDir === '')) {
    throw Object.assign(new Error('缺少项目根（Legacy）或工作区配置（Multi）'), {
      errorCode: 'ERR_PROJECT_CONFIG_INVALID' as const,
    });
  }
  if (wantsManagedStore && (options.managedStore?.dir ?? '').trim() === '') {
    throw Object.assign(new Error('--workspace-store 需要一个非空的存储目录'), {
      errorCode: 'ERR_PROJECT_CONFIG_INVALID' as const,
    });
  }

  const mode: ShellServerMode = wantsMulti ? 'multi' : 'legacy';
  const workspace: WorkspaceConfig | undefined = wantsStaticMulti
    ? (options.workspace ??
      (await loadWorkspaceConfig(options.workspacePath as string /* 已由 wantsMulti 保证 */)))
    : undefined;

  // Multi：Registry 是项目身份唯一权威；只有 READY 项目才有 Provider
  const registry: ProjectRegistry | undefined = workspace
    ? createProjectRegistry({ config: workspace })
    : undefined;

  // Legacy：保持原有单 Provider 行为与 providerId `local`
  const legacyProvider: StorageProvider | undefined =
    mode === 'legacy'
      ? createLocalProvider({ rootDir: options.rootDir as string, faults: options.providerFaults })
      : undefined;

  /**
   * 工作区身份（S11-C / S11-C-R1）：**只用于恢复记录匹配**，不能当作读写授权凭据。
   *
   * 组成 = 每个**已配置**项目的 id + （READY 时）规范根 + 根身份令牌，
   * 排序后做 SHA-256，只暴露摘要。因此：
   * - Host 重启、根未变 → 摘要不变（可匹配）；
   * - 换根 / 根被同名目录替换 / 项目组合变化 → 摘要变化（拒绝恢复文件标签）；
   * - 浏览器只拿到摘要，看不到任何路径、令牌或授权信息。
   *
   * 关键：**不可用的项目也必须参与身份**。只把 READY 项目算进去，会让
   * "只配置 A" 与 "配置 A + B（B 的根缺失）" 得到同一个摘要——那是一个错误的匹配：
   * 两个工作区的项目组合不同，恢复时却会互相认领对方的标签。不可用项目以固定的
   * `unavailable` 标记参与（不写原因，保证同一份坏配置重启后摘要稳定），
   * 这样项目从 READY 变成不可用、或从不可用恢复成 READY，摘要都会变（fail-closed）。
   *
   * 无法可靠确认（一个项目都没有、根不可读）时不提供该字段 → 客户端 fail-closed。
   */
  function computeWorkspaceKey(): string | undefined {
    try {
      const lines: string[] = [];
      if (registry) {
        for (const summary of registry.list()) {
          const handle = registry.get(summary.projectId);
          lines.push(
            handle
              ? `multi\u0000${summary.projectId}\u0000${handle.canonicalRoot}\u0000${handle.rootToken}`
              : `multi\u0000${summary.projectId}\u0000unavailable`,
          );
        }
        if (lines.length === 0) return undefined;
      } else if (legacyProvider) {
        const canonicalRoot = realpathSync.native(legacyProvider.rootDir);
        lines.push(`legacy\u0000${canonicalRoot}\u0000${rootTokenOf(canonicalRoot)}`);
      } else {
        return undefined;
      }
      return createHash('sha256').update(lines.sort().join('\n')).digest('hex');
    } catch {
      return undefined;
    }
  }

  const staticWorkspaceKey = computeWorkspaceKey();

  /**
   * 托管模式的身份来自 Runtime（按请求求值）；静态模式沿用启动时的快照。
   * Legacy 与静态 Multi 的返回值因此与改动前完全一致。
   */
  function currentWorkspaceKey(): string | undefined {
    return runtime ? runtime.workspaceKey() : staticWorkspaceKey;
  }

  /** providerId → Provider。Multi 由 Registry 派生，客户端无法指定。 */
  const providers = new Map<string, StorageProvider>();
  if (legacyProvider) providers.set(legacyProvider.providerId, legacyProvider);
  if (registry) {
    for (const summary of registry.list()) {
      const handle = registry.get(summary.projectId);
      if (handle) providers.set(handle.providerId, handle.provider);
    }
  }

  /**
   * 授权（G1-05）：Legacy 沿用全项目单一授权；Multi 逐项目按 `local:<pid>` 维度发放，
   * 项目 A 的授权不会自动覆盖项目 B。
   */
  const configuredProjectIds = (workspace?.projects ?? []).map((project) => project.projectId);
  const grantedProjectIds = new Set<string>(options.grantedProjects ?? configuredProjectIds);
  const basePermission: PermissionService =
    mode === 'legacy'
      ? createPermissionService([
          { actorId, action: 'read', scope: '' },
          { actorId, action: 'write', scope: '' },
        ])
      : wantsManaged
        ? // 托管模式：grant 由 Runtime 在装载与添加时发放，Host 不再预置一张静态表
          createPermissionService([])
        : createPermissionService(
            [...grantedProjectIds].flatMap((projectId) => [
              { actorId, action: 'read' as const, scope: '', providerId: `local:${projectId}` },
              { actorId, action: 'write' as const, scope: '', providerId: `local:${projectId}` },
            ]),
          );
  const permission: PermissionService = options.permissionWrapper
    ? options.permissionWrapper(basePermission)
    : basePermission;

  const document: DocumentService = createDocumentService();

  /**
   * 托管模式的唯一项目权威（UX-02B-01）。由调用方（测试/内部接线）构造，
   * Host 只负责使用它，不持有第二套项目表。
   *
   * UX-02B-03 起，生产入口（`--workspace-store`）也走这里：Store 与 Runtime 都由
   * Host 创建，`close()` 时释放存储单实例锁。契约里**没有**任何"传路径就注册"的形状：
   * Runtime 的 `addProject` 只能由下面 T3 路径在拿到选择器结果后调用。
   */
  let managedFileStore: FileProjectStore | undefined;
  const runtime: ProjectRuntime | undefined = (() => {
    if (options.managed) return options.managed.create({ actorId, document, permission });
    const config = options.managedStore;
    if (!config) return undefined;
    const store = createFileProjectStore({
      dir: config.dir,
      ...(config.storeIo ? { io: config.storeIo } : {}),
    });
    managedFileStore = store;
    try {
      return createProjectRuntime({
        actorId,
        document,
        permission,
        store,
        // 刻意**不**在构造期声明 'os-dialog'：授权来源必须逐次来自选择器成功结果。
      });
    } catch (err) {
      // Runtime 构造失败（例如装载时 store 抛错）也必须释放锁，否则下次启动被自己挡住
      store.close();
      managedFileStore = undefined;
      throw err;
    }
  })();

  // ---- T1 / T2 / T3 所需的进程内状态（仅托管模式持有选择器与意图）----
  const tokenStore: SessionTokenStore = createSessionTokenStore();
  const picker: FolderPicker | undefined = options.managedStore
    ? (options.managedStore.picker ??
      createHostFolderPicker(
        options.managedStore.execFileImpl
          ? { execFileImpl: options.managedStore.execFileImpl }
          : {},
      ))
    : undefined;
  const intents: IntentRegistry | undefined = options.managedStore
    ? createIntentRegistry({
        ttlMs: options.managedStore.intentTtlMs,
        now: options.managedStore.now,
      })
    : undefined;
  const pickRequests: PickRegistry | undefined = options.managedStore
    ? createPickRegistry({ now: options.managedStore.now })
    : undefined;
  const pickerTimeoutMs = options.managedStore?.pickerTimeoutMs ?? 120_000;
  /** 选择器任务结束时若 Host 已关闭，结果直接丢弃（不得再写 Store）。 */
  let disposed = false;

  /** Provider 解析：托管模式按 Runtime 现查（不再是启动时的 Map 快照）。 */
  const resolveProviderById = (providerId: string): StorageProvider | undefined =>
    runtime ? runtime.providerOf(providerId) : providers.get(providerId);

  const projectAuthority: { assertUsable(projectId: string): ProjectHandle } | undefined =
    runtime ?? registry;

  const bus: CommandBus = createCommandBus({
    document,
    permission,
    resolveProvider: resolveProviderById,
    ...(mode === 'multi' && projectAuthority
      ? {
          requireProjectId: true,
          // 门禁同时给出可信 providerId：payload 里的声明只能用于一致性校验
          gate: { resolveProject: (projectId: string) => projectAuthority.assertUsable(projectId) },
        }
      : {}),
  });

  /** viewId → 会话；仅用于「这个 viewId 是否属于该会话」的校验，不作授权凭据。 */
  const views = new Map<string, ViewRecord>();
  const nextCommandId = (): string => `s9b-${randomUUID()}`;

  function identityOf(sessionId: string) {
    return document.inspectSession(sessionId);
  }

  function documentDto(
    sessionId: string,
    viewId: string | null,
    options: { includeContent?: boolean } = {},
  ): DocumentDto {
    const identity = identityOf(sessionId);
    const view = document.getSession(sessionId);
    if (!identity || !view) {
      throw new HttpError(404, 'ERR_DOCUMENT_NOT_FOUND', '会话不存在');
    }
    return {
      sessionId,
      viewId,
      resourceId: identity.resourceId,
      path: identity.path,
      ...(options.includeContent === false
        ? {}
        : { content: document.getBuffer(sessionId) }),
      baseVersion: view.baseVersion,
      revision: view.revision,
      dirty: view.dirty,
      documentState: view.state,
      ...(identity.projectId ? { projectId: identity.projectId } : {}),
      ...(view.stale ? { stale: view.stale } : {}),
    };
  }

  function requireView(sessionId: string, viewId: string | undefined, required = false): void {
    if (!viewId) {
      // Multi（G1-R1）：viewId 是会话归属的绑定校验标识，不允许只凭 sessionId 操作会话
      if (required) throw new HttpError(400, 'ERR_COMMAND_INVALID', '缺少 viewId');
      return;
    }
    const record = views.get(viewId);
    if (!record || record.sessionId !== sessionId) {
      throw new HttpError(403, 'ERR_PERMISSION_DENIED', 'viewId 与 sessionId 不匹配');
    }
    // G1-09：视图必须属于当前 actor，凭猜测的 sessionId/viewId 不得读取草稿
    if (record.actorId !== actorId) {
      throw new HttpError(403, 'ERR_PERMISSION_DENIED', 'viewId 不属于当前 actor');
    }
  }

  /** 取项目句柄并做 G-DISK 门禁；失败时把该项目全部会话标记为 STALE（草稿保留）。 */
  function requireProjectHandle(projectId: string): ProjectHandle {
    const authority = runtime ?? registry;
    if (!authority) {
      throw new HttpError(404, 'ERR_PROJECT_NOT_FOUND', '当前未启用多项目模式');
    }
    try {
      // 托管模式的 assertUsable 额外包含屏障判定（QUIESCING → 409）
      return authority.assertUsable(projectId);
    } catch (err) {
      const code = (err as { errorCode?: string }).errorCode;
      const reason = (err as { reason?: string }).reason;
      if (code === 'ERR_PROJECT_UNAVAILABLE' || code === 'ERR_PROJECT_REVOKE_UNKNOWN') {
        // 两者都意味着"该项目不能再碰磁盘"，遗留会话一律转 STALE（草稿保留，G-DRAFT 仍可读）
        const staleReason =
          code === 'ERR_PROJECT_REVOKE_UNKNOWN' ? 'REVOKE_UNKNOWN' : reason ?? 'PROJECT_UNAVAILABLE';
        document.markProjectStale(projectId, staleReason);
      }
      const known = typeof code === 'string' && code in ERROR_CODES ? (code as ErrorCode) : undefined;
      throw new HttpError(
        known ? httpStatusOfDomainError(known) : 503,
        known ?? 'ERR_PROJECT_UNAVAILABLE',
        known ? publicMessageOf(known) : PUBLIC_ERROR_MESSAGES.ERR_PROJECT_UNAVAILABLE ?? '项目不可用',
      );
    }
  }

  /**
   * G-DISK 门禁（G1-08）：会话所属项目必须仍属于 Registry 且 READY，根身份不变。
   * 与 CommandBus 内的 gate 是同一条判定，绕过 CommandBus 的直连入口也必须调用它。
   */
  function assertSessionDiskUsable(sessionId: string): void {
    const identity = identityOf(sessionId);
    if (!identity) throw new HttpError(404, 'ERR_DOCUMENT_NOT_FOUND', '会话不存在');
    if (mode !== 'multi') return;

    if (!identity.projectId) {
      throw new HttpError(409, 'ERR_SESSION_STALE', '会话缺少项目归属');
    }
    // 先判项目可用性（项目不可用 → 503），再判会话标记（会话失效 → 409）：
    // 项目级原因更能解释"为什么磁盘访问被拒绝"，也避免把根失效误报成会话问题。
    requireProjectHandle(identity.projectId);
    if (document.getSession(sessionId)?.stale) {
      throw new HttpError(
        409,
        'ERR_SESSION_STALE',
        PUBLIC_ERROR_MESSAGES.ERR_SESSION_STALE ?? '会话已失效',
      );
    }
  }

  /** 会话绑定的 Provider（G1-11）：绝不使用全局单例，也不接受请求指定。 */
  function providerForSession(sessionId: string): StorageProvider {
    const identity = identityOf(sessionId);
    if (!identity) throw new HttpError(404, 'ERR_DOCUMENT_NOT_FOUND', '会话不存在');
    const provider = resolveProviderById(identity.providerId);
    if (!provider) {
      throw new HttpError(
        503,
        'ERR_PROJECT_UNAVAILABLE',
        PUBLIC_ERROR_MESSAGES.ERR_PROJECT_UNAVAILABLE ?? '项目不可用',
      );
    }
    return provider;
  }

  /** Legacy 分支使用的单 Provider；Multi 下不存在。 */
  function legacyOnlyProvider(): StorageProvider {
    if (!legacyProvider) {
      throw new HttpError(404, 'ERR_PROJECT_NOT_FOUND', '当前运行在 Multi 模式，请指定 projectId');
    }
    return legacyProvider;
  }

  /**
   * 客户端声明的 projectId 只能作为**一致性断言**（G1-06）：
   * 会话归属由服务端身份决定，声明不一致一律拒绝，绝不允许借此切到别的项目。
   */
  function assertProjectAssertion(identity: { projectId?: string } | undefined, declared: unknown): void {
    if (!identity || typeof declared !== 'string' || declared === '') return;
    if (identity.projectId !== declared) {
      throw new HttpError(400, 'ERR_COMMAND_INVALID', '声明的 projectId 与会话归属的项目不一致');
    }
  }

  /**
   * G-DISK 操作的统一准入与计数（UX-02B-01）。
   *
   * 托管模式下：准入判定与 activeDiskOps +1 在同一个同步块内完成，因此不存在
   * "判完还没计数就被屏障插队"的窗口；操作结束后在 finally 释放，屏障据此 drain。
   * Legacy 与静态 Multi 没有 Runtime，行为与改动前完全一致（直接执行）。
   */
  async function withDiskOp<T>(projectId: string | null | undefined, fn: () => Promise<T>): Promise<T> {
    if (!runtime || mode !== 'multi' || !projectId) return fn();
    return runtime.withDiskOp(projectId, fn);
  }

  /** 会话所属项目；Legacy 返回 undefined。 */
  function projectOfSession(sessionId: string): string | undefined {
    return identityOf(sessionId)?.projectId;
  }

  /** 正文读取必须按**会话实际资源**重新授权，不能只凭 sessionId。 */
  function authorizeRead(sessionId: string): void {
    const identity = identityOf(sessionId);
    if (!identity) throw new HttpError(404, 'ERR_DOCUMENT_NOT_FOUND', '会话不存在');
    const decision = permission.authorize({
      actorId,
      action: 'read',
      resourcePath: identity.path,
      providerId: identity.providerId,
    });
    if (!decision.allowed) {
      throw new HttpError(403, decision.errorCode ?? 'ERR_PERMISSION_DENIED', decision.reason);
    }
  }

  /**
   * **T1**：变更类请求必须携带 `X-WS-Token`。
   *
   * 令牌只证明"请求来自本机 Host 的页面"，不证明任何目录权限。缺省/伪造/已淘汰
   * 一律 403，且在触碰选择器之前返回（S-01…S-04 要求"不弹对话框"）。
   */
  function requireSessionToken(req: IncomingMessage): void {
    const raw = req.headers['x-ws-token'];
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (!tokenStore.validate(token)) {
      throw new HttpError(403, 'ERR_PERMISSION_DENIED', '缺少或无效的会话令牌');
    }
  }

  /**
   * 选择请求**禁止**携带的字段（ADR-021 §3.2）。
   *
   * 这些字段一旦被接受，就等于"网页可以指定本机路径 / 自述授权来源"，即绕过 T3。
   * 与 `rejectTrustedFields` 分开是有意的：`path` 在 `/api/open` 里是**项目内相对
   * 路径**，属于另一类参数，绝不能被这条规则误伤。
   */
  const PICK_FORBIDDEN_FIELDS = [
    'rootDir',
    'root',
    'path',
    'directory',
    'canonicalRoot',
    'rootToken',
    'grantSource',
    'actorId',
    'providerId',
  ] as const;

  function rejectPickFields(body: Record<string, unknown>): void {
    for (const field of PICK_FORBIDDEN_FIELDS) {
      if (field in body) {
        throw new HttpError(
          400,
          'ERR_COMMAND_INVALID',
          `不接受客户端提供的 ${field}：目录与授权凭据只能由 Host 内部产生`,
        );
      }
    }
  }

  /**
   * 信任披露的协议标记（契约 D.5 / UX-02B-04A）。
   *
   * **它不是授权凭据**：Host 不会因为它存在就多授予一毫秒的目录权限，也不会把它写进
   * 任何持久记录。真正的授权证据仍然只有 T3 的 `grantSource: 'os-dialog'`。
   * 它存在的唯一理由，是让"客户端跳过了披露这一步"在协议层可被发现与断言。
   */
  const ACKNOWLEDGE_SCOPE = 'browse-subtree';

  /** 准入/提交失败对应的 HTTP 语义（S-11 / S-12 需要区分 422 与 409）。 */
  function pickStatusOf(errorCode: string | undefined): number {
    switch (errorCode) {
      case 'ERR_PROJECT_DUPLICATE_ROOT':
        return 409;
      case 'ERR_PROJECT_NESTED_ROOT':
      case 'ERR_PROJECT_CONFIG_INVALID':
        return 422;
      case 'ERR_PROJECT_BUSY':
      case 'ERR_STORE_LOCKED':
      case 'ERR_STORE_ID_REUSED':
        return 409;
      case 'ERR_STORE_RESTRICTED':
      case 'ERR_PROJECT_UNAVAILABLE':
        return 503;
      default:
        return httpStatusOfDomainError(errorCode);
    }
  }

  /**
   * 选择任务（T3 的唯一实现路径）。
   *
   * 顺序不可交换：先弹**本机**对话框，拿到真实路径，才可能进入 addProject
   * （后者内部做 `inspectProjectRoot` + 重复/嵌套检查 + 持久提交）。因此：
   * - 取消 / 超时 / 不可用 → 停在第一步，零副作用；
   * - 复核失败 → addProject 抛错，Store 未被写入；
   * - 成功 → 提交成功之后才有 Provider 与 grant。
   */
  async function runPick(input: { requestId: string; name?: string }): Promise<void> {
    const registry = pickRequests as PickRegistry;
    const rt = runtime as ProjectRuntime;
    const pk = picker as FolderPicker;
    try {
      const outcome = await pk.pick({ timeoutMs: pickerTimeoutMs });
      if (disposed) return;

      if (outcome.status === 'cancelled') {
        registry.settle(input.requestId, { status: 'CANCELLED', httpStatus: 200 });
        return;
      }
      if (outcome.status === 'timeout') {
        registry.settle(input.requestId, {
          status: 'REJECTED',
          httpStatus: 501,
          errorCode: 'ERR_PICKER_UNAVAILABLE',
          reason: 'timeout',
        });
        return;
      }
      if (outcome.status === 'unavailable') {
        registry.settle(input.requestId, {
          status: 'REJECTED',
          httpStatus: 501,
          errorCode: 'ERR_PICKER_UNAVAILABLE',
          reason: 'unavailable',
        });
        return;
      }

      // ---- T3 的唯一出口：选择器成功返回的路径 + 逐次声明 'os-dialog' ----
      // 名称可由调用方提供（非路径信息）；缺省取目录名，绝不回传该路径。
      const picked = outcome.folder.absolutePath;
      const name = input.name ?? (basename(picked) || 'project');
      const project = await rt.addProject({ name, rootDir: picked, grantSource: 'os-dialog' });
      if (disposed) return;
      registry.settle(input.requestId, { status: 'APPLIED', httpStatus: 200, project });
    } catch (err) {
      const code = (err as { errorCode?: string } | undefined)?.errorCode;
      const reason = (err as { reason?: string } | undefined)?.reason;
      registry.settle(input.requestId, {
        status: 'REJECTED',
        httpStatus: pickStatusOf(code),
        ...(typeof code === 'string' ? { errorCode: code } : {}),
        ...(typeof reason === 'string' ? { reason } : {}),
      });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req.headers.host)) {
      sendJson(res, 403, { status: 'REJECTED', errorCode: 'ERR_PERMISSION_DENIED', message: '非法 Host' });
      return;
    }

    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const pathname = url.pathname;
    const isWrite = method !== 'GET' && method !== 'HEAD';

    if (!['GET', 'POST'].includes(method)) {
      sendJson(res, 405, { status: 'REJECTED', errorCode: 'ERR_COMMAND_INVALID', message: '方法不允许' });
      return;
    }

    if (isWrite) {
      const origin = req.headers.origin;
      const allowedOrigins = new Set(
        options.allowedOrigins ?? [`http://${req.headers.host ?? ''}`, ...VITE_DEV_ORIGINS],
      );
      if (origin !== undefined && !allowedOrigins.has(origin.toLowerCase())) {
        sendJson(res, 403, {
          status: 'REJECTED',
          errorCode: 'ERR_PERMISSION_DENIED',
          message: '来源不被允许',
        });
        return;
      }
      const site = req.headers['sec-fetch-site'];
      if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
        sendJson(res, 403, {
          status: 'REJECTED',
          errorCode: 'ERR_PERMISSION_DENIED',
          message: `跨站请求被拒绝（sec-fetch-site=${site}）`,
        });
        return;
      }
    }

    if (method === 'GET' && pathname === '/api/health') {
      // G1-12：不再返回本机绝对根目录（Legacy / Multi 一致）；只暴露运行模式
      // S11-C：workspaceKey 是工作区摘要（哈希），仅用于恢复记录匹配
      // UX-02B-01：托管模式按请求求值，项目集合变化后立即反映新身份
      const key = currentWorkspaceKey();
      sendJson(res, 200, {
        status: 'APPLIED',
        mode: 'live',
        workspaceMode: mode,
        ...(key ? { workspaceKey: key } : {}),
      });
      return;
    }

    /**
     * T1 引导端点（ADR-021 §4）：发放会话令牌；托管模式下同时发放一次性意图。
     *
     * 之所以在同一个响应里给出 token + intentId，是因为页面"点一次添加"必须同时
     * 持有两者，而端点清单只定义了这一个引导入口。**两者证明力互不替代**：
     * token 证明请求来自本机页面（T1），intentId 证明这次意图未被重放（T2），
     * 谁都不证明"用户真的选了目录"——那只有 T3。
     *
     * 跨源页面读不到响应体（服务不发送任何 CORS 头），这里仍显式校验来源。
     */
    if (method === 'GET' && pathname === '/api/session-token') {
      const origin = req.headers.origin;
      if (origin !== undefined) {
        const allowedOrigins = new Set(
          options.allowedOrigins ?? [`http://${req.headers.host ?? ''}`, ...VITE_DEV_ORIGINS],
        );
        if (!allowedOrigins.has(origin.toLowerCase())) {
          sendJson(res, 403, {
            status: 'REJECTED',
            errorCode: 'ERR_PERMISSION_DENIED',
            message: '来源不被允许',
          });
          return;
        }
      }
      const site = req.headers['sec-fetch-site'];
      if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
        sendJson(res, 403, {
          status: 'REJECTED',
          errorCode: 'ERR_PERMISSION_DENIED',
          message: `跨站请求被拒绝（sec-fetch-site=${site}）`,
        });
        return;
      }
      const token = tokenStore.issue();
      const intent = intents?.issue(actorId);
      sendJson(res, 200, {
        status: 'APPLIED',
        token,
        ...(intent ? { intent } : {}),
      });
      return;
    }

    // 目录选择结果查询（ADR-021 §4）。pending 记录只在内存，Host 重启后 → 410。
    if (method === 'GET' && pathname === '/api/projects/pick') {
      if (!pickRequests) {
        throw new HttpError(
          501,
          'ERR_COMMAND_UNSUPPORTED',
          PUBLIC_ERROR_MESSAGES.ERR_COMMAND_UNSUPPORTED ?? '当前运行模式不支持目录选择',
        );
      }
      requireSessionToken(req);
      const requestId = url.searchParams.get('requestId') ?? '';
      if (requestId === '') {
        throw new HttpError(400, 'ERR_COMMAND_INVALID', '缺少 requestId');
      }
      const record = pickRequests.get(requestId);
      if (!record) {
        throw new HttpError(
          410,
          'ERR_PICK_REQUEST_GONE',
          PUBLIC_ERROR_MESSAGES.ERR_PICK_REQUEST_GONE ?? '目录选择请求已不存在',
        );
      }
      sendJson(res, record.httpStatus, {
        status: record.status,
        requestId: record.requestId,
        ...(record.project ? { project: record.project } : {}),
        ...(record.errorCode ? { errorCode: record.errorCode } : {}),
        ...(record.reason ? { reason: record.reason } : {}),
      });
      return;
    }

    /**
     * 变更结果查询（ADR-022 §7.1，UX-02B-04B）。
     *
     * 只认与本次 `opId` **精确匹配**的持久事务证据（配置 `createdByOp` / 墓碑 `opId`），
     * 证据缺失即 `unknown`——**绝不**用"项目现在在不在"反推某次操作的结果。
     * 只读磁盘，因此重启前后结论一致；静态 / Legacy / 内存注入模式下无持久库 → 501。
     */
    if (method === 'GET' && pathname === '/api/projects/op') {
      if (!runtime || !managedFileStore) {
        if (runtime) requireSessionToken(req);
        throw new HttpError(
          501,
          'ERR_COMMAND_UNSUPPORTED',
          PUBLIC_ERROR_MESSAGES.ERR_COMMAND_UNSUPPORTED ?? '当前运行模式不支持该接口',
        );
      }
      requireSessionToken(req);
      const opId = (url.searchParams.get('opId') ?? '').trim();
      if (opId === '' || opId.length > 128) {
        throw new HttpError(400, 'ERR_COMMAND_INVALID', '缺少或非法的 opId');
      }
      // 归属必须一起返回：否则调用方会把"别的项目的撤销证据"当成本次移除成功
      const evidence = managedFileStore.opEvidence(opId);
      sendJson(res, 200, {
        status: 'APPLIED',
        opId,
        outcome: evidence.outcome,
        projectId: evidence.projectId,
      });
      return;
    }

    /**
     * 项目注册能力探测（UX-02B-04A，只读）。
     *
     * 为什么需要它：界面必须在用户点「添加项目」**之前**就知道这个 Host 能不能
     * 动态注册项目，否则只能让用户先读完披露、再撞一次 501 —— 那既违反"不假装成功"，
     * 也把"不支持"伪装成"操作失败"。
     *
     * 只回答能力，不回答任何路径、项目或授权信息，因此与 `/api/projects` 一样
     * 不需要令牌；也不改变 `/api/health` 的既有形状（WK-04 把它当白名单断言）。
     */
    if (method === 'GET' && pathname === '/api/projects/registration') {
      sendJson(res, 200, {
        status: 'APPLIED',
        supported: runtime !== undefined,
        mode: runtime ? 'managed' : mode,
      });
      return;
    }

    // Multi 专用：项目列表只给 Summary（不含 rootDir / canonicalRoot / rootToken）
    if (method === 'GET' && pathname === '/api/projects') {
      const authority = runtime ?? registry;
      if (!authority) {
        sendJson(res, 404, {
          status: 'REJECTED',
          errorCode: 'ERR_COMMAND_UNSUPPORTED',
          message: 'Legacy 模式不提供项目列表',
        });
        return;
      }
      sendJson(res, 200, { status: 'APPLIED', projects: authority.list() });
      return;
    }

    /**
     * UX-02B-TREE：只读、逐层、可分页的真实目录树。
     *
     * 与 `/api/resources` 的关系：旧端点的实现与输出**冻结**（递归、只认文本后缀），
     * 保留给既有客户端与测试；新端点只增不改，是 Shell 懒加载的唯一数据来源。
     *
     * 门禁顺序与旧端点一致：项目存在/可用（404/503）→ 项目级读授权（403）
     * → 参数合法性（400，零 IO）→ `withDiskOp` 包裹下的单次 `readDir`。
     * 全过程不接受、也不返回任何本机绝对路径。
     */
    if (method === 'GET' && pathname === '/api/tree') {
      const projectId = url.searchParams.get('projectId') ?? '';
      if (mode === 'multi' && !projectId) {
        throw new HttpError(400, 'ERR_PROJECT_REQUIRED', PUBLIC_ERROR_MESSAGES.ERR_PROJECT_REQUIRED ?? '必须声明 projectId');
      }

      // 先判项目存在与可用，再判授权：不存在的项目不该被报成"权限不足"。
      let treeProvider: StorageProvider;
      let treeProjectId: string | undefined;
      if (mode === 'multi') {
        treeProvider = requireProjectHandle(projectId).provider;
        const decision = permission.authorize({
          actorId,
          action: 'read',
          resourcePath: '',
          providerId: `local:${projectId}`,
        });
        if (!decision.allowed) {
          throw new HttpError(403, decision.errorCode ?? 'ERR_PERMISSION_DENIED', decision.reason);
        }
        treeProjectId = projectId;
      } else {
        treeProvider = legacyOnlyProvider();
      }

      // 参数校验必须在 readDir 之前：非法 dir / cursor / limit 一律零 IO
      const dir = parseTreeDir(url.searchParams.get('dir'));
      const cursor = parseTreeCursor(url.searchParams.get('cursor'));
      const limit = parseTreeLimit(url.searchParams.get('limit'));
      const expectedSnapshot = parseTreeSnapshot(url.searchParams.get('snapshot'));

      try {
        const entries = await withDiskOp(treeProjectId, () =>
          treeProvider.readDir(dir === '' ? '.' : dir),
        );
        // 排序 → 切片 → nextCursor 全在纯函数里，便于直接断言"没有静默截断"
        sendJson(
          res,
          200,
          buildTreePage(entries, { projectId: treeProjectId, dir, cursor, limit, expectedSnapshot }),
        );
      } catch (err) {
        if (err instanceof HttpError) throw err;
        const code = (err as { errorCode?: string }).errorCode;
        const known = typeof code === 'string' && code in ERROR_CODES ? (code as ErrorCode) : undefined;
        throw new HttpError(
          known ? httpStatusOfDomainError(known) : 422,
          known ?? 'ERR_STORAGE_IO',
          known ? publicMessageOf(known) : '目录读取失败',
        );
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/resources') {
      const projectId = url.searchParams.get('projectId') ?? '';
      // Multi：projectId 必填，且必须先过 G-DISK 门禁；Legacy 保持原行为
      if (mode === 'multi' && !projectId) {
        throw new HttpError(400, 'ERR_PROJECT_REQUIRED', PUBLIC_ERROR_MESSAGES.ERR_PROJECT_REQUIRED ?? '必须声明 projectId');
      }
      // 先判项目存在与可用（404/503），再判授权（403）：
      // 不存在的项目不应因"没有授权记录"而被报成权限问题。
      let multiProvider: StorageProvider | undefined;
      if (mode === 'multi') {
        multiProvider = requireProjectHandle(projectId).provider;
        // 项目级读授权（G1-05）：A 项目的授权不覆盖 B 项目
        const decision = permission.authorize({
          actorId,
          action: 'read',
          resourcePath: '',
          providerId: `local:${projectId}`,
        });
        if (!decision.allowed) {
          throw new HttpError(403, decision.errorCode ?? 'ERR_PERMISSION_DENIED', decision.reason);
        }
      }

      try {
        const source = multiProvider ?? legacyOnlyProvider();
        const paths = await withDiskOp(mode === 'multi' ? projectId : undefined, () => source.list());
        sendJson(res, 200, {
          status: 'APPLIED',
          nodes: buildResourceTree(paths, mode === 'multi' ? { projectId } : undefined) as ResourceNodeDto[],
        });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        // 根连续性失败必须按"项目根不可用"返回 503，且不得回传原始 message（含绝对路径）
        const code = (err as { errorCode?: string }).errorCode;
        const known = typeof code === 'string' && code in ERROR_CODES ? (code as ErrorCode) : undefined;
        throw new HttpError(
          known ? httpStatusOfDomainError(known) : 422,
          known ?? 'ERR_STORAGE_IO',
          known ? publicMessageOf(known) : '资源列表读取失败',
        );
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/document/disk') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const viewId = url.searchParams.get('viewId') ?? undefined;
      if (!sessionId) throw new HttpError(400, 'ERR_COMMAND_INVALID', '缺少 sessionId');
      if (!identityOf(sessionId)) throw new HttpError(404, 'ERR_DOCUMENT_NOT_FOUND', '会话不存在');
      requireView(sessionId, viewId, mode === 'multi');
      assertProjectAssertion(identityOf(sessionId), url.searchParams.get('projectId'));
      authorizeRead(sessionId);
      // G1-11：先过 G-DISK 门禁，再用**会话绑定项目**的 Provider 读取
      assertSessionDiskUsable(sessionId);
      const identity = identityOf(sessionId)!;
      const sessionProvider = providerForSession(sessionId);
      try {
        // 只读查看：用会话绑定的路径读写，客户端无法指定其它位置
        const disk = await withDiskOp(projectOfSession(sessionId), () =>
          sessionProvider.read(identity.path),
        );
        sendJson(res, 200, {
          status: 'APPLIED',
          content: disk.content,
          contentVersion: disk.contentVersion,
        });
      } catch (err) {
        const code = (err as { errorCode?: string }).errorCode;
        throw new HttpError(httpStatusOfDomainError(code), code ?? 'ERR_STORAGE_IO', '磁盘内容不可读');
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/document') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const viewId = url.searchParams.get('viewId') ?? undefined;
      if (!sessionId) throw new HttpError(400, 'ERR_COMMAND_INVALID', '缺少 sessionId');
      // 先判会话是否存在（404），再判 viewId 归属（403）：错误语义更精确
      if (!identityOf(sessionId)) throw new HttpError(404, 'ERR_DOCUMENT_NOT_FOUND', '会话不存在');
      requireView(sessionId, viewId, mode === 'multi');
      assertProjectAssertion(identityOf(sessionId), url.searchParams.get('projectId'));
      // G-DRAFT（ADR-023 §2）：草稿是 Host 内存里的字节，不是磁盘访问。
      // Multi：归属已由 requireView（actor + session + viewId）确认，因此**不再**要求
      // 项目 grant —— 项目被撤销/根失效时磁盘权限已收回，但用户仍须能取回自己的草稿。
      // Legacy：没有 viewId 绑定（viewId 非必填），读取授权仍是唯一的门，必须保持原样。
      if (mode === 'legacy') authorizeRead(sessionId);
      sendJson(res, 200, { status: 'APPLIED', document: documentDto(sessionId, viewId ?? null) });
      return;
    }

    if (method === 'POST') {
      const body = await readJsonBody(req, maxBodyBytes);
      rejectTrustedFields(body, mode);

      /**
       * 真实创建（UX-02C-01）：空文件 / 空目录。
       *
       * 校验顺序即安全顺序：模式(501，Demo/Legacy/静态 Multi 一律不提供) →
       * T1 令牌(403) → 显式同源 Origin(403) → 请求体禁字段与名称/父目录形状(400，零 IO)
       * → 项目可用性(G-DISK 前置) → 项目级写授权 → Runtime `withDiskOp` →
       * Provider 的排他创建。浏览器自始至终只提交 `projectId + 相对父目录 + 单段名称`。
       *
       * `UNKNOWN`（副作用可能已发生但无法确认）用 202 + `status:'UNKNOWN'` 明确报告，
       * 客户端只读核对目录并提示人工确认，**绝不自动重发创建**。
       */
      const createKind: CreateEntryKind | null =
        pathname === '/api/files/create'
          ? 'file'
          : pathname === '/api/directories/create'
            ? 'directory'
            : null;
      if (createKind !== null) {
        if (!runtime) {
          throw new HttpError(
            501,
            'ERR_COMMAND_UNSUPPORTED',
            PUBLIC_ERROR_MESSAGES.ERR_COMMAND_UNSUPPORTED ?? '当前运行模式不支持真实创建',
          );
        }
        requireSessionToken(req);
        if (req.headers.origin === undefined) {
          throw new HttpError(403, 'ERR_PERMISSION_DENIED', '变更类请求必须声明 Origin');
        }
        const parsed = parseCreateEntryBody(body, createKind);
        if (!parsed.ok) {
          throw new HttpError(
            httpStatusOfDomainError(parsed.errorCode),
            parsed.errorCode,
            publicMessageOf(parsed.errorCode),
          );
        }
        const { request } = parsed;
        const handle = requireProjectHandle(request.projectId);
        const outcome = await createManagedEntry({
          request,
          provider: handle.provider,
          providerId: handle.providerId,
          permission,
          actorId,
          withDiskOp: <T,>(fn: () => Promise<T>) => withDiskOp(request.projectId, fn),
        });
        if (outcome.status === 'UNKNOWN') {
          sendJson(res, 202, {
            status: 'UNKNOWN',
            errorCode: 'ERR_OUTCOME_UNKNOWN',
            message: '创建结果未确认：请刷新该目录人工核对（不会自动重试）',
            projectId: request.projectId,
            parentDir: request.parentDir,
            name: request.name,
            kind: request.kind,
          });
          return;
        }
        if (outcome.status === 'REJECTED') {
          throw new HttpError(
            httpStatusOfDomainError(outcome.errorCode),
            outcome.errorCode,
            publicMessageOf(outcome.errorCode),
          );
        }
        sendJson(res, 200, {
          status: 'APPLIED',
          projectId: request.projectId,
          parentDir: request.parentDir,
          name: request.name,
          kind: request.kind,
          relativePath: outcome.relativePath,
        });
        return;
      }

      /**
       * 真实改名 / 移动（UX-02C-02）：两个端点共用同一条编排与同一个
       * `StorageProvider.moveEntry` 原语，只是 `rename` 的目标目录由 Host 派生。
       *
       * 校验顺序：模式(501) → T1 → 显式同源 Origin → 禁字段/形状(400，零 IO)
       * → 项目可用性(G-DISK 前置) → 项目级写授权 → 结构变更准入屏障 + 排空在途
       * 磁盘操作 → Host 会话保护 → `withStructureDiskOp` → 排他路径变更。
       * 浏览器只提交 `projectId + 项目内相对路径 + 单段名称`。
       */
      const structureKind: StructureKind | null =
        pathname === '/api/files/rename'
          ? 'rename'
          : pathname === '/api/files/move'
            ? 'move'
            : null;
      if (structureKind !== null) {
        if (!runtime) {
          throw new HttpError(
            501,
            'ERR_COMMAND_UNSUPPORTED',
            PUBLIC_ERROR_MESSAGES.ERR_COMMAND_UNSUPPORTED ?? '当前运行模式不支持真实结构变更',
          );
        }
        requireSessionToken(req);
        if (req.headers.origin === undefined) {
          throw new HttpError(403, 'ERR_PERMISSION_DENIED', '变更类请求必须声明 Origin');
        }
        const parsed = parseStructureBody(body, structureKind);
        if (!parsed.ok) {
          throw new HttpError(
            httpStatusOfDomainError(parsed.errorCode),
            parsed.errorCode,
            publicMessageOf(parsed.errorCode),
          );
        }
        const { request } = parsed;
        const handle = requireProjectHandle(request.projectId);
        const outcome = await runManagedStructureChange({
          request,
          provider: handle.provider,
          providerId: handle.providerId,
          permission,
          actorId,
          sessionsUnder: (projectId, prefix) => document.sessionsUnder(projectId, prefix),
          // 屏障持有期间普通 withDiskOp 已被拒，结构变更自己的磁盘操作走专用通道
          withStructureDiskOp: <T,>(capability: StructureChangeCapability, fn: () => Promise<T>) =>
            runtime.withStructureDiskOp(capability, fn),
          withStructureChange: <T,>(fn: (capability: StructureChangeCapability) => Promise<T>) =>
            runtime.withStructureChange(request.projectId, fn),
        });
        const targetPath = request.targetParentDir === ''
          ? request.targetName
          : `${request.targetParentDir}/${request.targetName}`;
        if (outcome.status === 'UNKNOWN') {
          sendJson(res, 202, {
            status: 'UNKNOWN',
            errorCode: 'ERR_OUTCOME_UNKNOWN',
            message: '结构变更结果未确认：已保留源位置与目标位置供人工核对（不会自动重试、不会回滚）',
            projectId: request.projectId,
            sourcePath: request.sourcePath,
            targetParentDir: request.targetParentDir,
            targetName: request.targetName,
            targetPath,
          });
          return;
        }
        if (outcome.status === 'REJECTED') {
          if (outcome.blockedBy) {
            sendJson(res, 409, {
              status: 'REJECTED',
              errorCode: outcome.errorCode,
              message: publicMessageOf(outcome.errorCode),
              blockedBy: outcome.blockedBy,
              projectId: request.projectId,
              sourcePath: request.sourcePath,
            });
            return;
          }
          throw new HttpError(
            httpStatusOfDomainError(outcome.errorCode),
            outcome.errorCode,
            publicMessageOf(outcome.errorCode),
          );
        }
        sendJson(res, 200, {
          status: 'APPLIED',
          projectId: request.projectId,
          kind: structureKind,
          sourcePath: outcome.sourcePath,
          targetPath: outcome.targetPath,
          targetParentDir: outcome.targetParentDir,
          targetName: outcome.targetName,
          entryKind: outcome.kind,
          contentSha256: outcome.contentSha256,
        });
        return;
      }

      /**
       * 启动本机目录选择（ADR-021 §4）。
       *
       * 校验顺序即安全顺序：
       * 1. 模式（非托管 → 501，不含任何实现）
       * 2. T1 令牌（无/伪造 → 403，**不弹对话框**）
       * 3. 请求体禁字段（path/rootDir/... → 400，零 IO）
       * 4. 单飞（已有一次进行中 → 409，不消费意图）
       * 5. T2 意图（过期/已用/未知 → 410，一次性消费）
       * 6. 启动 T3 选择器 → 202 + requestId
       */
      if (pathname === '/api/projects/pick') {
        if (!runtime || !picker || !intents || !pickRequests) {
          throw new HttpError(
            501,
            'ERR_COMMAND_UNSUPPORTED',
            PUBLIC_ERROR_MESSAGES.ERR_COMMAND_UNSUPPORTED ?? '当前运行模式不支持目录选择',
          );
        }
        requireSessionToken(req);
        // S-02：变更类请求必须显式声明 Origin。浏览器对所有 POST 都会发送（含同源），
        // 因此"没有 Origin"只可能是非浏览器客户端或跨源探测——不弹对话框。
        if (req.headers.origin === undefined) {
          throw new HttpError(403, 'ERR_PERMISSION_DENIED', '变更类请求必须声明 Origin');
        }
        rejectPickFields(body);
        // 披露形状校验必须早于意图消费：否则一次"没读披露"的请求会把一次性意图用掉，
        // 用户随后照着模态再点一次就只会拿到 410，而错误其实出在上一个请求。
        if (body.acknowledgeScope !== ACKNOWLEDGE_SCOPE) {
          throw new HttpError(
            400,
            'ERR_COMMAND_INVALID',
            '缺少或错误的 acknowledgeScope：目录选择必须由信任披露确认发起',
          );
        }
        if (pickRequests.isBusy()) {
          throw new HttpError(
            409,
            'ERR_PICKER_BUSY',
            PUBLIC_ERROR_MESSAGES.ERR_PICKER_BUSY ?? '已有一次目录选择正在进行',
          );
        }
        const intentId = typeof body.intentId === 'string' ? body.intentId : '';
        if (intentId === '') {
          throw new HttpError(400, 'ERR_COMMAND_INVALID', '缺少 intentId');
        }
        const claimed = intents.claim(intentId, actorId);
        if (!claimed.ok) {
          const code: ErrorCode =
            claimed.reason === 'expired'
              ? 'ERR_INTENT_EXPIRED'
              : claimed.reason === 'consumed'
                ? 'ERR_INTENT_CONSUMED'
                : 'ERR_INTENT_INVALID';
          // 三种失败一律 410：不区分"过期/已用/不存在"，避免成为探测面
          throw new HttpError(410, code, publicMessageOf(code));
        }
        const rawName = typeof body.name === 'string' ? body.name.trim() : '';
        const requestId = pickRequests.begin();
        // 选择器可能开很久：结果为异步，客户端用 requestId 轮询
        void runPick({ requestId, ...(rawName === '' ? {} : { name: rawName }) });
        sendJson(res, 202, { status: 'PENDING', requestId });
        return;
      }

      /**
       * 项目显示名称重命名（UX-02B-04A，契约 §4.2）。
       *
       * 只转发给 `ProjectRuntime.renameProject`：事务、持久化、名称校验（trim / 64 字 /
       * 控制字符）与 `REVOKE_UNKNOWN` 拒改都在 Runtime 里，Host 不复制一份规则，
       * 也不在这里"先假装成功"。磁盘目录名永远不动 —— 名称是显示属性，不是路径。
       */
      if (pathname === '/api/projects/rename') {
        if (!runtime) {
          throw new HttpError(
            501,
            'ERR_COMMAND_UNSUPPORTED',
            PUBLIC_ERROR_MESSAGES.ERR_COMMAND_UNSUPPORTED ?? '当前运行模式不支持重命名项目',
          );
        }
        requireSessionToken(req);
        const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
        if (projectId === '') throw new HttpError(400, 'ERR_COMMAND_INVALID', '缺少 projectId');
        if (typeof body.name !== 'string') {
          throw new HttpError(400, 'ERR_COMMAND_INVALID', '缺少项目名称');
        }
        try {
          const project = await runtime.renameProject(projectId, body.name);
          sendJson(res, 200, { status: 'APPLIED', project });
        } catch (err) {
          const code = (err as { errorCode?: ErrorCode }).errorCode;
          throw new HttpError(
            httpStatusOfDomainError(code),
            code ?? 'ERR_STORAGE_IO',
            code ? publicMessageOf(code) : '重命名失败',
          );
        }
        return;
      }

      /**
       * 移除前置检查（UX-02B-04B，只读）。
       *
       * 只回答"现在能不能移除、被什么挡住"，**不改任何状态**；`remove` 执行时会
       * 在屏障内用 Host 状态重新检查，因此这里的结果不是放行凭据。
       */
      if (pathname === '/api/projects/removal-precheck') {
        if (!runtime) {
          throw new HttpError(
            501,
            'ERR_COMMAND_UNSUPPORTED',
            PUBLIC_ERROR_MESSAGES.ERR_COMMAND_UNSUPPORTED ?? '当前运行模式不支持移除项目',
          );
        }
        requireSessionToken(req);
        const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
        if (projectId === '') throw new HttpError(400, 'ERR_COMMAND_INVALID', '缺少 projectId');
        try {
          const pre = runtime.removalPrecheck(projectId);
          sendJson(res, 200, {
            status: 'APPLIED',
            projectId,
            allowed: pre.allowed,
            blockedBy: pre.blockedBy,
            state: pre.state,
          });
        } catch (err) {
          const code = (err as { errorCode?: ErrorCode }).errorCode;
          throw new HttpError(
            httpStatusOfDomainError(code),
            code ?? 'ERR_STORAGE_IO',
            code ? publicMessageOf(code) : '前置检查失败',
          );
        }
        return;
      }

      /**
       * 移除项目（UX-02B-04B）。
       *
       * 校验顺序即安全顺序：模式(501) → T1 令牌(403) → Origin(403) → 请求体禁字段
       * （已在上面统一执行）→ projectId/confirm/opId 形状(400) → Runtime 事务。
       * **确认字段 `confirm === 'remove-from-workspace'` 缺失或错误一律 400 且零变更**；
       * 真正放行由 Runtime 在屏障内按 Host 状态重新检查，前检结果不采信。
       * 只解除注册与授权，绝不触碰磁盘文件（Runtime 不引用任何删除/移动 API）。
       */
      if (pathname === '/api/projects/remove') {
        if (!runtime) {
          throw new HttpError(
            501,
            'ERR_COMMAND_UNSUPPORTED',
            PUBLIC_ERROR_MESSAGES.ERR_COMMAND_UNSUPPORTED ?? '当前运行模式不支持移除项目',
          );
        }
        requireSessionToken(req);
        // 变更类请求必须显式声明 Origin（浏览器对同源 POST 也会发送）
        if (req.headers.origin === undefined) {
          throw new HttpError(403, 'ERR_PERMISSION_DENIED', '变更类请求必须声明 Origin');
        }
        const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
        if (projectId === '') throw new HttpError(400, 'ERR_COMMAND_INVALID', '缺少 projectId');
        // 明确确认：缺失/错误 → 400，且在任何 Runtime 调用之前返回（零变更）
        if (body.confirm !== 'remove-from-workspace') {
          throw new HttpError(
            400,
            'ERR_COMMAND_INVALID',
            '缺少或错误的确认：移除项目必须显式确认 confirm="remove-from-workspace"',
          );
        }
        const rawOpId = typeof body.opId === 'string' ? body.opId.trim() : '';
        if (rawOpId !== '' && !/^op-[A-Za-z0-9-]{8,80}$/.test(rawOpId)) {
          throw new HttpError(400, 'ERR_COMMAND_INVALID', '非法 opId');
        }
        try {
          const result = await runtime.removeProject(
            projectId,
            rawOpId === '' ? undefined : { opId: rawOpId },
          );
          if (result.outcome === 'aborted') {
            sendJson(res, 409, {
              status: 'REJECTED',
              outcome: 'aborted',
              projectId,
              blockedBy: result.blockedBy,
            });
            return;
          }
          // 墓碑已生效但配置补写失败 → 5xx，但**明确** outcome:'revoked'（项目已不可访问）
          const degraded = result.configPersisted === false;
          sendJson(res, degraded ? 500 : 200, {
            status: 'APPLIED',
            outcome: 'revoked',
            projectId: result.projectId,
            opId: result.opId,
            ...(result.configPersisted !== undefined ? { configPersisted: result.configPersisted } : {}),
          });
        } catch (err) {
          const code = (err as { errorCode?: ErrorCode }).errorCode;
          throw new HttpError(
            httpStatusOfDomainError(code),
            code ?? 'ERR_STORAGE_IO',
            code ? publicMessageOf(code) : '移除失败',
          );
        }
        return;
      }

      // 其余未实现的 `/api/projects/*` 变更端点：统一 501，绝不留下"看起来能用但没有
      // 鉴权/没有事务"的部分实现。
      if (pathname.startsWith('/api/projects/')) {
        if (runtime) requireSessionToken(req);
        throw new HttpError(
          501,
          'ERR_COMMAND_UNSUPPORTED',
          PUBLIC_ERROR_MESSAGES.ERR_COMMAND_UNSUPPORTED ?? '当前运行模式不支持该接口',
        );
      }

      /**
       * 回收"本页面上一轮"遗留的 View（UX-02C-02-R1.2）。
       *
       * 场景：页面刷新后旧 View 留在 Host。恢复流程逐个重开标签时，`/api/open`
       * 会顺带回收每个文件的旧 View；但如果用户在恢复途中主动打开某个**尚未恢复**
       * 的文件，恢复立即被接管中止，剩下那些文件的旧 View 就再也没人关了。
       * 它们会让项目一直判定为"有活动编辑会话"，改名/移动被永久 409 拦住。
       *
       * 因此需要一次"只回收、不打开"的批量通道：不读盘、不建会话、不动任何草稿。
       *
       * 边界（与 `/api/open` 的 reclaim 完全同源）：
       * - 必须声明 `clientInstanceId`，且只处理**同一页面实例 + 同一 actor +
       *   同一 resourceId** 的 View；其它页面、其它文件一律不动。
       * - `keepViewIds` 是调用方此刻在用的 View（标签持有的那些）：**永不关闭**。
       *   这是"当前活动 View"与"上轮历史 View"的显式分界。
       * - `document.closeView` 拒绝时（例如保护最后一个脏视图）保留记录并如实
       *   报告 `blocked`，绝不为了回收 View 丢弃 DIRTY 草稿。
       * - 只操作 Host 内存，不触碰磁盘，因此不需要项目 grant；项目不存在仍是 404。
       * - 与 `/api/close` 同一档门禁（T1 令牌 + 同源）：`isWrite` 阶段已经对带
       *   Origin 的请求做了同源校验，而令牌本身只发给同源页面；这里不额外要求
       *   Origin 头——Node 里的真实集成测试没有该头，强制要求会让生产链路无法被
       *   端到端验证（视图操作不碰磁盘，风险面与 `/api/close` 相同）。
       */
      if (pathname === '/api/views/reclaim') {
        requireSessionToken(req);
        const pageInstance = parseClientInstanceId(body);
        if (!pageInstance) {
          throw new HttpError(400, 'ERR_COMMAND_INVALID', '缺少或非法的 clientInstanceId');
        }
        const rawPaths = body.paths;
        if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
          throw new HttpError(400, 'ERR_COMMAND_INVALID', '缺少 paths');
        }
        if (rawPaths.length > MAX_RECLAIM_PATHS) {
          throw new HttpError(400, 'ERR_COMMAND_INVALID', `paths 不能超过 ${MAX_RECLAIM_PATHS} 条`);
        }
        const keep = new Set(
          Array.isArray(body.keepViewIds)
            ? body.keepViewIds.filter((item): item is string => typeof item === 'string')
            : [],
        );

        let reclaimProjectId: string | undefined;
        if (mode === 'multi') {
          reclaimProjectId = typeof body.projectId === 'string' ? body.projectId : '';
          if (!reclaimProjectId) {
            throw new HttpError(
              400,
              'ERR_PROJECT_REQUIRED',
              PUBLIC_ERROR_MESSAGES.ERR_PROJECT_REQUIRED ?? '必须声明 projectId',
            );
          }
          // 项目不存在 → 404（与其它项目级端点一致），不虚构"回收成功"
          requireProjectHandle(reclaimProjectId);
        } else if ('projectId' in body) {
          throw new HttpError(400, 'ERR_COMMAND_INVALID', 'Legacy 模式不接受 projectId');
        }

        const wanted: string[] = [];
        for (const raw of rawPaths) {
          const normalized = normalizeProjectPath(raw);
          if (!normalized) {
            throw new HttpError(400, 'ERR_COMMAND_INVALID', '非法路径（越界/绝对路径/空）');
          }
          wanted.push(normalized);
        }

        let closed = 0;
        const blocked: Array<{ path: string; viewId: string; reason: string }> = [];
        for (const path of new Set(wanted)) {
          const resourceId = reclaimProjectId ? `doc:${reclaimProjectId}/${path}` : `doc:${path}`;
          for (const [viewId, record] of [...views]) {
            if (record.clientInstanceId !== pageInstance) continue;
            if (record.actorId !== actorId) continue;
            if (record.resourceId !== resourceId) continue;
            // 当前标签正在用的 View：属于"当前活动"，不是"上轮历史"
            if (keep.has(viewId)) continue;
            const outcome = await document
              .closeView(viewId)
              .catch((err: unknown) => ({ closed: false, reason: String(err) }));
            if (outcome.closed) {
              views.delete(viewId);
              closed += 1;
            } else {
              blocked.push({
                path,
                viewId,
                reason: (outcome as { reason?: string }).reason ?? '拒绝关闭',
              });
            }
          }
        }
        sendJson(res, 200, { status: 'APPLIED', closed, blocked });
        return;
      }

      if (pathname === '/api/open') {
        const projectPath = normalizeProjectPath(body.path);
        if (!projectPath) {
          throw new HttpError(400, 'ERR_COMMAND_INVALID', '非法路径（越界/绝对路径/空）');
        }
        // UX-02C-02-R1：页面归属标识（非授权凭据）。形状不合法在零 IO 前拒绝。
        const clientInstanceId = parseClientInstanceId(body);
        // R1.1：回收旧 View 必须由恢复流程显式申请，且必须有页面身份
        const reclaimPrevious = parseReclaimPrevious(body) && clientInstanceId !== null;

        // resourceId / providerId 一律由服务端派生（G1-04），客户端只能断言不能指定
        let resourceId: string;
        let targetPayload: Record<string, unknown>;
        /** 该 open 归属的项目（Legacy 为 undefined），用于 G-DISK 计数与晚到校验。 */
        let openProjectId: string | undefined;
        if (mode === 'multi') {
          const projectId = typeof body.projectId === 'string' ? body.projectId : '';
          if (!projectId) {
            throw new HttpError(
              400,
              'ERR_PROJECT_REQUIRED',
              PUBLIC_ERROR_MESSAGES.ERR_PROJECT_REQUIRED ?? '必须声明 projectId',
            );
          }
          const handle = requireProjectHandle(projectId);
          openProjectId = projectId;
          resourceId = `doc:${projectId}/${projectPath}`;
          if ('resourceId' in body && body.resourceId !== resourceId) {
            throw new HttpError(400, 'ERR_COMMAND_INVALID', 'resourceId 由服务端派生，不接受客户端指定');
          }
          targetPayload = {
            path: projectPath,
            resourceId,
            projectId,
            providerId: handle.providerId,
          };
        } else {
          resourceId = `doc:${projectPath}`;
          if ('resourceId' in body && body.resourceId !== resourceId) {
            throw new HttpError(400, 'ERR_COMMAND_INVALID', 'resourceId 由服务端派生，不接受客户端指定');
          }
          if ('projectId' in body) {
            throw new HttpError(400, 'ERR_COMMAND_INVALID', 'Legacy 模式不接受 projectId');
          }
          targetPayload = { path: projectPath, resourceId };
        }

        const outcome = await withDiskOp(openProjectId, async () => {
          const dispatched = await bus.dispatch(
            {
              commandId: nextCommandId(),
              type: 'document.open',
              payload: targetPayload,
            },
            { actorId },
          );
          // 晚到校验（ADR-023 §3）：屏障在本次 await 期间关门时，这次 open 不得留下 View。
          // 释放刚建的 View 属于"取消本次打开"，不触碰任何草稿字节。
          if (
            dispatched.status === 'APPLIED' &&
            runtime &&
            openProjectId &&
            !runtime.isAcceptingViews(openProjectId)
          ) {
            const created = dispatched.result as { viewId?: string } | undefined;
            if (created?.viewId) await document.closeView(created.viewId).catch(() => undefined);
            throw new HttpError(409, 'ERR_PROJECT_QUIESCING', '项目正在移除中，本次打开已取消');
          }
          return dispatched;
        });
        if (outcome.status !== 'APPLIED') {
          await replyCommandFailure(res, outcome.status, outcome.errorCode);
          return;
        }
        const handle = outcome.result as {
          viewId: string;
          sessionId: string;
          resourceId: string;
          reloaded?: boolean;
        };
        const identity = identityOf(handle.sessionId);
        if (!identity) throw new HttpError(500, 'ERR_COMMAND_INTERNAL', '会话未建立');
        views.set(handle.viewId, {
          sessionId: handle.sessionId,
          resourceId: identity.resourceId,
          path: identity.path,
          actorId,
          clientInstanceId,
        });

        /**
         * 同一页面重开同一资源：释放该页面此前遗留的旧 View（UX-02C-02-R1）。
         *
         * 场景：页面刷新后页面实例 id 不变，恢复流程重新 /api/open 同一文件；
         * 旧 View 的持有者（旧页面上下文）已经消失，永远不会自己关闭，若不清理
         * 就会让该项目永远"有活动 View"，改名/移动被永久拦住。
         *
         * **只有 reclaimPrevious=true 才执行**（R1.1）：普通打开与临时打开
         * （refreshCleanTab 核对磁盘）必须保留当前标签自己的 View。
         *
         * 边界（按契约逐条）：
         * - 只处理**同一个 clientInstanceId + 同一个 resourceId**；
         *   其它页面、其它文件一律不动。
         * - 一定在新 View 登记成功之后才关旧的：即使关闭被拒，新 View 也已可用。
         * - `document.closeView` 拒绝（例如保护最后一个脏视图）时**保留**记录，
         *   不伪造成功；脏草稿因此不会被静默丢弃。
         * - 关闭过程不触碰磁盘，也不改变会话缓冲。
         */
        if (reclaimPrevious && clientInstanceId) {
          for (const [oldViewId, record] of [...views]) {
            if (oldViewId === handle.viewId) continue;
            // 归属四连核对：同一页面实例 + 同一 actor + 同一会话 + 同一资源，
            // 缺一不回收。其它页面、其它文件一律不动。
            if (record.clientInstanceId !== clientInstanceId) continue;
            if (record.actorId !== actorId) continue;
            if (record.sessionId !== handle.sessionId) continue;
            if (record.resourceId !== identity.resourceId) continue;
            const closed = await document.closeView(oldViewId).catch(() => ({ closed: false }));
            if (closed.closed) views.delete(oldViewId);
          }
        }
        // open 的 CommandBus 已按实际资源授权；正文读取再按会话实际资源授权一次
        authorizeRead(handle.sessionId);
        sendJson(res, 200, {
          status: 'APPLIED',
          reloaded: handle.reloaded === true,
          document: documentDto(handle.sessionId, handle.viewId),
        });
        return;
      }

      if (pathname === '/api/edit') {
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        if (!sessionId) throw new HttpError(400, 'ERR_COMMAND_INVALID', '缺少 sessionId');
        if (typeof body.buffer !== 'string') {
          throw new HttpError(400, 'ERR_COMMAND_INVALID', '缺少 buffer');
        }
        requireView(sessionId, typeof body.viewId === 'string' ? body.viewId : undefined, mode === 'multi');
        const identity = identityOf(sessionId);
        if (!identity) throw new HttpError(404, 'ERR_DOCUMENT_NOT_FOUND', '会话不存在');
        assertProjectAssertion(identity, body.projectId);

        const expectedVersion =
          typeof body.expectedVersion === 'string' && body.expectedVersion !== ''
            ? body.expectedVersion
            : (document.getSession(sessionId)?.baseVersion ?? '');
        // 写命令必须携带非空 expectedVersion；会话还没有基线时（新文件）用一个明确的占位
        const outcome = await withDiskOp(identity.projectId, () =>
          bus.dispatch(
            {
              commandId: nextCommandId(),
              type: 'document.applyEdit',
              expectedVersion: expectedVersion === '' ? 'unversioned' : expectedVersion,
              payload: {
                sessionId,
                buffer: body.buffer,
                ...(typeof body.projectId === 'string' ? { projectId: body.projectId } : {}),
              },
            },
            { actorId },
          ),
        );
        if (outcome.status !== 'APPLIED') {
          await replyCommandFailure(res, outcome.status, outcome.errorCode);
          return;
        }
        sendJson(res, 200, {
          status: 'APPLIED',
          document: documentDto(sessionId, typeof body.viewId === 'string' ? body.viewId : null),
        });
        return;
      }

      if (pathname === '/api/save') {
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        const expectedVersion = typeof body.expectedVersion === 'string' ? body.expectedVersion : '';
        if (!sessionId) throw new HttpError(400, 'ERR_COMMAND_INVALID', '缺少 sessionId');
        if (!expectedVersion) {
          throw new HttpError(400, 'ERR_COMMAND_INVALID', '写命令必须携带 expectedVersion');
        }
        requireView(sessionId, typeof body.viewId === 'string' ? body.viewId : undefined, mode === 'multi');
        const saveIdentity = identityOf(sessionId);
        assertProjectAssertion(saveIdentity, body.projectId);

        const outcome = await withDiskOp(saveIdentity?.projectId, () =>
          bus.dispatch(
            {
              commandId: nextCommandId(),
              type: 'document.save',
              expectedVersion,
              payload: {
                sessionId,
                ...(typeof body.projectId === 'string' ? { projectId: body.projectId } : {}),
              },
            },
            { actorId },
          ),
        );
        // 项目不可用 → 立刻把该项目会话标记为 STALE，阻止后续磁盘访问（草稿保留）
        if (
          saveIdentity?.projectId &&
          (outcome.errorCode === 'ERR_PROJECT_UNAVAILABLE' || outcome.errorCode === 'ERR_PROJECT_NOT_FOUND')
        ) {
          document.markProjectStale(saveIdentity.projectId, outcome.errorCode);
        }

        const status: SaveOutcomeStatus =
          outcome.status === 'APPLIED'
            ? 'COMMITTED'
            : outcome.errorCode === 'ERR_DOCUMENT_VERSION_CONFLICT'
              ? 'CONFLICT'
              : outcome.status === 'UNKNOWN'
                ? 'UNKNOWN'
                : 'FAILED';

        const projectLevel =
          outcome.errorCode === 'ERR_PROJECT_UNAVAILABLE' ||
          outcome.errorCode === 'ERR_PROJECT_NOT_FOUND' ||
          outcome.errorCode === 'ERR_PROJECT_REVOKE_UNKNOWN' ||
          outcome.errorCode === 'ERR_SESSION_STALE' ||
          outcome.errorCode === 'ERR_ROOT_CHANGED' ||
          outcome.errorCode === 'ERR_ROOT_IDENTITY_UNSUPPORTED';
        const httpStatus =
          status === 'COMMITTED'
            ? 200
            : status === 'CONFLICT'
              ? 409
              : status === 'UNKNOWN'
                ? 202
                : projectLevel
                  ? httpStatusOfDomainError(outcome.errorCode)
                  : 422;
        sendJson(res, httpStatus, {
          status,
          errorCode: outcome.errorCode,
          contentVersion: outcome.resultingVersion ?? null,
          // G1-R1：项目级失败（根失效/会话失效）不得回传草稿正文副本；
          // dirty / baseVersion / stale 仍保留，供 UI 提示与后续恢复。
          document: documentDto(sessionId, typeof body.viewId === 'string' ? body.viewId : null, {
            includeContent: !(mode === 'multi' && projectLevel),
          }),
        });
        return;
      }

      if (pathname === '/api/reload') {
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        const viewId = typeof body.viewId === 'string' ? body.viewId : '';
        if (!sessionId || !viewId) {
          throw new HttpError(400, 'ERR_COMMAND_INVALID', '缺少 sessionId 或 viewId');
        }
        // 「明确确认」是协议的一部分：缺少该标记一律拒绝，服务端不替用户做丢弃决定
        if (body.discardDraft !== true) {
          throw new HttpError(409, 'ERR_DOCUMENT_DIRTY', '覆盖草稿必须显式确认（discardDraft: true）');
        }
        requireView(sessionId, viewId);
        const identity = identityOf(sessionId);
        if (!identity) throw new HttpError(404, 'ERR_DOCUMENT_NOT_FOUND', '会话不存在');
        assertProjectAssertion(identity, body.projectId);
        // 重载会覆盖草稿并读盘：必须先过 G-DISK 门禁
        assertSessionDiskUsable(sessionId);
        for (const action of ['read', 'write'] as const) {
          const decision = permission.authorize({
            actorId,
            action,
            resourcePath: identity.path,
            providerId: identity.providerId,
          });
          if (!decision.allowed) {
            throw new HttpError(403, decision.errorCode ?? 'ERR_PERMISSION_DENIED', decision.reason);
          }
        }

        try {
          const reloaded = await withDiskOp(identity.projectId, () =>
            document.reload(sessionId, { discardDirty: true }),
          );
          sendJson(res, 200, {
            status: 'APPLIED',
            document: documentDto(sessionId, viewId),
            previousDraft: reloaded.previousContent,
            previousBaseVersion: reloaded.previousBaseVersion,
          });
        } catch (err) {
          const code = (err as { errorCode?: string }).errorCode;
          throw new HttpError(httpStatusOfDomainError(code), code ?? 'ERR_STORAGE_IO', '重载失败');
        }
        return;
      }

      if (pathname === '/api/close') {
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        const viewId = typeof body.viewId === 'string' ? body.viewId : '';
        if (!sessionId || !viewId) {
          throw new HttpError(400, 'ERR_COMMAND_INVALID', '缺少 sessionId 或 viewId');
        }
        requireView(sessionId, viewId);
        const identity = identityOf(sessionId);
        if (!identity) throw new HttpError(404, 'ERR_DOCUMENT_NOT_FOUND', '会话不存在');
        assertProjectAssertion(identity, body.projectId);
        // G-DRAFT（ADR-023 §2）：关闭视图只操作 Host 内存（views / sessions），
        // 不触碰磁盘，因此 Multi 不要求项目 grant；dirty 保护仍由 closeView 自身执行。
        // Legacy 例外：没有 viewId 绑定（viewId 非必填），读取授权是唯一的门，
        // 必须保持基线 `d6bc5e6` 的行为——否则撤销 read 授权后仍能关掉别人的视图。
        if (mode === 'legacy') authorizeRead(sessionId);
        const closed = await document.closeView(viewId);
        if (!closed.closed) {
          // 未保存内容不得静默丢弃：明确拒绝，并保留会话（暂无 discard 契约）
          sendJson(res, 409, {
            status: 'REJECTED',
            errorCode: 'ERR_DOCUMENT_DIRTY',
            message: closed.reason ?? '存在未保存修改，拒绝关闭',
            document: documentDto(sessionId, viewId),
          });
          return;
        }
        views.delete(viewId);
        sendJson(res, 200, { status: 'APPLIED' });
        return;
      }
    }

    sendJson(res, 404, { status: 'REJECTED', errorCode: 'ERR_COMMAND_UNSUPPORTED', message: '未知接口' });
  }

  async function replyCommandFailure(
    res: ServerResponse,
    status: string,
    errorCode?: string,
  ): Promise<void> {
    const httpStatus =
      errorCode === 'ERR_DOCUMENT_VERSION_CONFLICT' ||
      errorCode === 'ERR_SESSION_STALE' ||
      errorCode === 'ERR_PROJECT_QUIESCING' ||
      errorCode === 'ERR_PROJECT_BUSY'
        ? 409
        : errorCode === 'ERR_PERMISSION_DENIED' ||
            errorCode === 'ERR_RESOURCE_IDENTITY_CONFLICT' ||
            errorCode === 'ERR_PROJECT_REVOKE_UNKNOWN'
          ? 403
          : errorCode === 'ERR_ROOT_CHANGED' ||
              errorCode === 'ERR_ROOT_IDENTITY_UNSUPPORTED' ||
              errorCode === 'ERR_PROJECT_UNAVAILABLE'
            ? 503
            : errorCode === 'ERR_PROJECT_NOT_FOUND' ||
                errorCode === 'ERR_RESOURCE_NOT_FOUND' ||
                errorCode === 'ERR_DOCUMENT_NOT_FOUND'
              ? 404
              : errorCode === 'ERR_PROJECT_REQUIRED'
                ? 400
                : // 与 `httpStatusOfDomainError` 保持一致：输入不合法是 400，
                  // 不是 422（同一个错误码不能因为走的端点不同而给出两种状态）。
                  errorCode === 'ERR_COMMAND_INVALID'
                  ? 400
                  : status === 'UNKNOWN'
                    ? 202
                    : 422;
    sendJson(res, httpStatus, { status: 'REJECTED', errorCode, message: '命令被拒绝' });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const httpErr = toPublicHttpError(err);
      if (!res.headersSent) {
        sendJson(res, httpErr.statusCode, {
          status: 'REJECTED',
          errorCode: httpErr.errorCode,
          message: httpErr.message,
        });
      } else {
        res.end();
      }
    });
  });

  /**
   * 监听失败（EADDRINUSE / EACCES / EADDRNOTAVAIL 等）必须**当场**释放本次创建的
   * Host 资源（UX-02B-03-R1）。
   *
   * 为什么不能交给调用方：`createShellServer()` 抛错时不返回句柄，调用方拿不到
   * `close()`，于是 Store 的单实例锁会挂在进程里直到退出——同进程内"换个端口重试"
   * 会被自己的锁挡住（ERR_STORE_LOCKED），看起来像"存储坏了"。
   *
   * 边界：只关**本函数创建的**句柄（`managedFileStore` 仅在 `managedStore` 模式下
   * 由 Host 自建；`options.managed` 注入的 Store 归调用方所有，不动）。`close()`
   * 只释放锁，不删除配置、墓碑或项目文件；也不触碰其他进程/其他服务的监听。
   */
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: unknown): void => reject(err);
      server.once('error', onError);
      server.listen(options.port ?? DEFAULT_PORT, bindHost, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
  } catch (err) {
    managedFileStore?.close();
    managedFileStore = undefined;
    // 未成功监听时 close() 的语义是"回调收到 ERR_SERVER_NOT_RUNNING"，不会抛；
    // 必须给回调，否则错误会以 'error' 事件冒出来变成未捕获异常。
    server.close(() => {
      /* 未监听：无需等待任何连接排空 */
    });
    throw err;
  }

  const address = server.address() as AddressInfo;
  const host = address.address === '::1' ? '[::1]' : address.address;

  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    actorId,
    // Multi 不向外部暴露任何本机路径
    rootDir: mode === 'legacy' ? (options.rootDir as string) : '',
    mode,
    async close() {
      // 先停受理：选择器任务即使之后返回，也不会再写 Store（pending 记录随进程消失，
      // 客户端拿 410 重试——见 S-13）。
      disposed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      managedFileStore?.close();
      managedFileStore = undefined;
    },
  };
}
