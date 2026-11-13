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
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCommandBus, type CommandBus } from '../../../packages/command/index.ts';
import { ERROR_CODES, type ErrorCode } from '../../../packages/contracts/index.ts';
import { createDocumentService, type DocumentService } from '../../../packages/document/index.ts';
import { createPermissionService, type PermissionService } from '../../../packages/permission/index.ts';
import {
  createLocalProvider,
  type StorageFaultHooks,
  type StorageProvider,
} from '../../../packages/storage/index.ts';
import { buildResourceTree, type ResourceNodeDto } from './tree.ts';

export type SaveOutcomeStatus = 'COMMITTED' | 'CONFLICT' | 'FAILED' | 'UNKNOWN';

export interface DocumentDto {
  sessionId: string;
  viewId: string | null;
  resourceId: string;
  path: string;
  content: string;
  baseVersion: string | null;
  revision: number;
  dirty: boolean;
  documentState: string;
}

export interface ShellServerOptions {
  /** 受信任的项目根：只能来自启动配置，不能来自请求。 */
  rootDir: string;
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
}

export interface ShellServer {
  readonly url: string;
  readonly port: number;
  readonly actorId: string;
  readonly rootDir: string;
  close(): Promise<void>;
}

/** 把 Core/Storage 的错误码映射成 HTTP 语义（对外仍是 JSON + status）。 */
function httpStatusOfDomainError(errorCode: string | undefined): number {
  switch (errorCode) {
    case 'ERR_DOCUMENT_DIRTY':
    case 'ERR_DOCUMENT_VERSION_CONFLICT':
      return 409;
    case 'ERR_PERMISSION_DENIED':
    case 'ERR_PATH_OUTSIDE_ROOT':
    case 'ERR_RESOURCE_IDENTITY_CONFLICT':
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
      return 503;
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
function rejectTrustedFields(body: Record<string, unknown>): void {
  if ('actorId' in body) {
    throw new HttpError(400, 'ERR_COMMAND_INVALID', '不接受客户端提供的 actorId');
  }
  if ('rootDir' in body || 'root' in body) {
    throw new HttpError(400, 'ERR_COMMAND_INVALID', '项目根由启动配置决定，不接受客户端指定');
  }
  if ('providerId' in body && body.providerId !== 'local') {
    throw new HttpError(403, 'ERR_PERMISSION_DENIED', '本项目只允许本地 Provider');
  }
}

interface ViewRecord {
  sessionId: string;
  resourceId: string;
  path: string;
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

  const provider: StorageProvider = createLocalProvider({
    rootDir: options.rootDir,
    faults: options.providerFaults,
  });
  const document: DocumentService = createDocumentService();
  const permission: PermissionService = createPermissionService([
    { actorId, action: 'read', scope: '' },
    { actorId, action: 'write', scope: '' },
  ]);
  const bus: CommandBus = createCommandBus({
    document,
    permission,
    resolveProvider: (providerId) => (providerId === provider.providerId ? provider : undefined),
  });

  /** viewId → 会话；仅用于「这个 viewId 是否属于该会话」的校验，不作授权凭据。 */
  const views = new Map<string, ViewRecord>();
  const nextCommandId = (): string => `s9b-${randomUUID()}`;

  function identityOf(sessionId: string) {
    return document.inspectSession(sessionId);
  }

  function documentDto(sessionId: string, viewId: string | null): DocumentDto {
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
      content: document.getBuffer(sessionId),
      baseVersion: view.baseVersion,
      revision: view.revision,
      dirty: view.dirty,
      documentState: view.state,
    };
  }

  function requireView(sessionId: string, viewId: string | undefined): void {
    if (!viewId) return;
    const record = views.get(viewId);
    if (!record || record.sessionId !== sessionId) {
      throw new HttpError(403, 'ERR_PERMISSION_DENIED', 'viewId 与 sessionId 不匹配');
    }
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
      sendJson(res, 200, { status: 'APPLIED', mode: 'live', root: options.rootDir });
      return;
    }

    if (method === 'GET' && pathname === '/api/resources') {
      try {
        const paths = await provider.list();
        sendJson(res, 200, { status: 'APPLIED', nodes: buildResourceTree(paths) as ResourceNodeDto[] });
      } catch (err) {
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
      requireView(sessionId, viewId);
      authorizeRead(sessionId);
      const identity = identityOf(sessionId)!;
      try {
        // 只读查看：用会话绑定的路径读写，客户端无法指定其它位置
        const disk = await provider.read(identity.path);
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
      requireView(sessionId, viewId);
      authorizeRead(sessionId);
      sendJson(res, 200, { status: 'APPLIED', document: documentDto(sessionId, viewId ?? null) });
      return;
    }

    if (method === 'POST') {
      const body = await readJsonBody(req, maxBodyBytes);
      rejectTrustedFields(body);

      if (pathname === '/api/open') {
        const projectPath = normalizeProjectPath(body.path);
        if (!projectPath) {
          throw new HttpError(400, 'ERR_COMMAND_INVALID', '非法路径（越界/绝对路径/空）');
        }
        // resourceId 由服务端按「Provider + 规范化路径」派生，客户端不能自带
        const resourceId = `doc:${projectPath}`;
        if ('resourceId' in body && body.resourceId !== resourceId) {
          throw new HttpError(400, 'ERR_COMMAND_INVALID', 'resourceId 由服务端派生，不接受客户端指定');
        }

        const outcome = await bus.dispatch(
          {
            commandId: nextCommandId(),
            type: 'document.open',
            payload: { path: projectPath, resourceId },
          },
          { actorId },
        );
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
        requireView(sessionId, typeof body.viewId === 'string' ? body.viewId : undefined);
        const identity = identityOf(sessionId);
        if (!identity) throw new HttpError(404, 'ERR_DOCUMENT_NOT_FOUND', '会话不存在');

        const expectedVersion =
          typeof body.expectedVersion === 'string' && body.expectedVersion !== ''
            ? body.expectedVersion
            : (document.getSession(sessionId)?.baseVersion ?? '');
        // 写命令必须携带非空 expectedVersion；会话还没有基线时（新文件）用一个明确的占位
        const outcome = await bus.dispatch(
          {
            commandId: nextCommandId(),
            type: 'document.applyEdit',
            expectedVersion: expectedVersion === '' ? 'unversioned' : expectedVersion,
            payload: { sessionId, buffer: body.buffer },
          },
          { actorId },
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
        requireView(sessionId, typeof body.viewId === 'string' ? body.viewId : undefined);

        const outcome = await bus.dispatch(
          {
            commandId: nextCommandId(),
            type: 'document.save',
            expectedVersion,
            payload: { sessionId },
          },
          { actorId },
        );

        const status: SaveOutcomeStatus =
          outcome.status === 'APPLIED'
            ? 'COMMITTED'
            : outcome.errorCode === 'ERR_DOCUMENT_VERSION_CONFLICT'
              ? 'CONFLICT'
              : outcome.status === 'UNKNOWN'
                ? 'UNKNOWN'
                : 'FAILED';

        const httpStatus =
          status === 'COMMITTED'
            ? 200
            : status === 'CONFLICT'
              ? 409
              : status === 'UNKNOWN'
                ? 202
                : outcome.errorCode === 'ERR_ROOT_CHANGED' ||
                    outcome.errorCode === 'ERR_ROOT_IDENTITY_UNSUPPORTED'
                  ? 503
                  : 422;
        sendJson(res, httpStatus, {
          status,
          errorCode: outcome.errorCode,
          contentVersion: outcome.resultingVersion ?? null,
          document: documentDto(sessionId, typeof body.viewId === 'string' ? body.viewId : null),
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
          const reloaded = await document.reload(sessionId, { discardDirty: true });
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
        const decision = permission.authorize({
          actorId,
          action: 'read',
          resourcePath: identity.path,
          providerId: identity.providerId,
        });
        if (!decision.allowed) {
          throw new HttpError(403, decision.errorCode ?? 'ERR_PERMISSION_DENIED', decision.reason);
        }

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
      errorCode === 'ERR_DOCUMENT_VERSION_CONFLICT'
        ? 409
        : errorCode === 'ERR_PERMISSION_DENIED' || errorCode === 'ERR_RESOURCE_IDENTITY_CONFLICT'
          ? 403
          : errorCode === 'ERR_ROOT_CHANGED' || errorCode === 'ERR_ROOT_IDENTITY_UNSUPPORTED'
            ? 503
            : errorCode === 'ERR_RESOURCE_NOT_FOUND' || errorCode === 'ERR_DOCUMENT_NOT_FOUND'
              ? 404
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
    rootDir: options.rootDir,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
