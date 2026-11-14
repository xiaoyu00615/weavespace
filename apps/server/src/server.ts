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
 *   GET  /api/resources                  已授权的项目文件树
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
import { buildResourceTree, type ResourceNodeDto } from './tree.ts';
import type { ProjectRuntime } from './project-runtime.ts';

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
      return 409;
    case 'ERR_PERMISSION_DENIED':
    case 'ERR_PATH_OUTSIDE_ROOT':
    case 'ERR_RESOURCE_IDENTITY_CONFLICT':
    case 'ERR_PROJECT_REVOKE_UNKNOWN':
      return 403;
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
      return 503;
    case 'ERR_PROJECT_REQUIRED':
    case 'ERR_PROJECT_CONFIG_INVALID':
    case 'ERR_PROJECT_DUPLICATE_ROOT':
    case 'ERR_PROJECT_NESTED_ROOT':
      return 400;
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
  ERR_RESOURCE_NOT_FOUND: '资源不存在',
  ERR_DOCUMENT_NOT_FOUND: '文档会话不存在',
  ERR_STORAGE_IO: '存储访问失败',
  ERR_RESOURCE_NOT_TEXT: '资源不是可编辑文本',
  ERR_ENCODING_UNSUPPORTED: '资源编码不受支持',
  ERR_SAVE_FAILED: '保存失败',
  ERR_DOCUMENT_DIRTY: '存在未保存修改',
  ERR_DOCUMENT_VERSION_CONFLICT: '内容版本冲突',
  ERR_OUTCOME_UNKNOWN: '保存结果未确认',
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
  ERR_SESSION_STALE: '会话已失效（项目不可用），草稿仍保留',
};

function publicMessageOf(errorCode: ErrorCode): string {
  return PUBLIC_ERROR_MESSAGES[errorCode] ?? '请求处理失败';
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
  const wantsManaged = options.managed !== undefined;
  const wantsStaticMulti = options.workspace !== undefined || options.workspacePath !== undefined;
  const wantsMulti = wantsManaged || wantsStaticMulti;
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
   */
  const runtime: ProjectRuntime | undefined = options.managed
    ? options.managed.create({ actorId, document, permission })
    : undefined;

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

      if (pathname === '/api/open') {
        const projectPath = normalizeProjectPath(body.path);
        if (!projectPath) {
          throw new HttpError(400, 'ERR_COMMAND_INVALID', '非法路径（越界/绝对路径/空）');
        }

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
        });
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

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_PORT, bindHost, () => resolve());
  });

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
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
