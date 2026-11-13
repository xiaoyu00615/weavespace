/**
 * Document Session（P0 探针版）。
 *
 * 规则来源：docs/06。
 * - 同一 Resource 的多个视图共享唯一权威 Session（单会话、多视图）。
 * - dirty 不得静默丢弃：有未保存内容时拒绝关闭最后一个视图。
 * - 保存先 SAVING，再依据 Storage.writeConditional 的结果进入 CLEAN / CONFLICT / FAILED / OUTCOME_UNKNOWN。
 * - 不依据 mtime 判定冲突；版本 token 由 Storage 提供。
 * - UNKNOWN 不得自动重试，必须经 reconcile 重新读取磁盘核对。
 */
import type { DocumentState, DocumentStateView, SaveResult } from '../contracts/types.ts';
import type { Logger } from '../observability/logger.ts';
import { currentTrace, startMonotonic } from '../observability/trace.ts';
import { contentVersionOf, type ReadResult, type StorageProvider } from '../storage/local-provider.ts';
import { canonicalRoot, resolveInsideRoot } from '../storage/path-safety.ts';
import { encodeUtf8Text } from '../storage/text-safety.ts';

export type Serializer = (buffer: string) => string;

const WIN = process.platform === 'win32';

/**
 * Provider 身份（S8-01）：`providerId` 字符串相同**不代表**存储根相同，
 * 因此身份由「providerId + 规范根目录」共同决定。
 */
function providerScopeOf(provider: StorageProvider): string {
  let root = provider.rootDir ?? '';
  try {
    root = canonicalRoot(provider.rootDir);
  } catch {
    // 根无法确认时保留字面值：此时任何真实读写都会被 storage 的 fail-closed 拒绝
  }
  return `${provider.providerId}::${WIN ? root.toLowerCase() : root}`;
}

/**
 * 资源键（S8-01）：与 S4 固定根目录边界规则保持一致——不可信/越界/经过重解析点的路径
 * 在这里就抛错，而不是等到 read 时才发现。
 */
function resourceKeyOf(provider: StorageProvider, path: string): string {
  const check = resolveInsideRoot(provider.rootDir, path);
  if (!check.ok) {
    throw Object.assign(new Error(check.detail), { errorCode: check.errorCode });
  }
  const rel = check.relativePath.replace(/\\/g, '/');
  return WIN ? rel.toLowerCase() : rel;
}

/**
 * 会话的身份描述（只读、可安全交给 CommandBus 使用）。
 * 不包含 Provider 对象、缓冲或任何可变引用。
 */
export interface SessionIdentity {
  readonly sessionId: string;
  readonly resourceId: string;
  readonly path: string;
  readonly providerId: string;
  readonly providerScope: string;
  /** 所属项目（G1）；Legacy 为 undefined。磁盘门禁据此解析 Registry 状态。 */
  readonly projectId?: string;
}

/** 身份探测结果：供 CommandBus 在**授权之前**判断是否会发生会话复用冲突（S8-02）。 */
export type ResourceIdentityProbe =
  | { status: 'none' }
  | { status: 'match'; identity: SessionIdentity }
  | { status: 'conflict'; claimedPath: string; identity: SessionIdentity };

/**
 * 打开文本会话时的读取（S5-04 / F01）。
 *
 * - 真正不存在（ERR_RESOURCE_NOT_FOUND）→ 返回 null，保留“新建空会话”的合法语义；
 * - 其余一切失败（路径安全、编码非法、二进制、权限、I/O）→ 原样抛出，
 *   不得伪装成“新建空文件”，也不得让调用方拿到一个虚假的 CLEAN 会话。
 */
async function readForOpen(provider: StorageProvider, path: string): Promise<ReadResult | null> {
  try {
    return await provider.read(path);
  } catch (err) {
    const code = (err as { errorCode?: string }).errorCode;
    if (code === 'ERR_RESOURCE_NOT_FOUND') return null;
    throw err;
  }
}

export interface OpenSessionInput {
  resourceId: string;
  path: string;
  provider: StorageProvider;
  /**
   * 所属项目（G1）。Legacy 缺省 undefined（仍用 providerId `local`）；
   * Multi 必填，且与 `provider.providerId` 一起决定会话身份。
   */
  projectId?: string;
}

export interface ViewHandle {
  viewId: string;
  sessionId: string;
  resourceId: string;
  /** true 表示本次打开检测到磁盘变化，已把会话内容/基线刷新为磁盘版本（S9B-A）。 */
  reloaded?: boolean;
}

export interface CloseViewResult {
  closed: boolean;
  /** true 表示因存在未保存修改而拒绝关闭（内容仍被保留）。 */
  protectedDirty: boolean;
  reason?: string;
}

/** 从磁盘重载会话内容的结果（S9B-C）。 */
export interface ReloadResult {
  content: string;
  contentVersion: string;
  /** 重载前的草稿与基线，供调用方备份/展示，避免误丢弃。 */
  previousContent: string;
  previousBaseVersion: string | null;
}

export interface ReconcileResult {
  outcome: 'APPLIED' | 'NOT_APPLIED' | 'UNKNOWN';
  diskVersion: string | null;
  dirty: boolean;
  detail: string;
}

interface Session {
  sessionId: string;
  resourceId: string;
  path: string;
  provider: StorageProvider;
  /** 所属项目（G1）；Legacy 为 undefined。 */
  projectId?: string;
  /**
   * 失效标记（G1-07）：与六态状态机正交。置位后禁止磁盘访问，但缓冲 / revision /
   * baseVersion / dirty 一律保持原值，不做自动迁移或丢弃。
   */
  stale?: { reason: string; since: string };
  /** 创建时固定的 Provider 身份与规范资源键，用于拒绝隐式复用（S8-01）。 */
  providerScope: string;
  resourceKey: string;
  buffer: string;
  baseVersion: string | null;
  revision: number;
  dirty: boolean;
  state: DocumentState;
  views: Set<string>;
  lastErrorCode?: string;
}

export interface DocumentService {
  /**
   * 打开（或复用）权威会话。
   *
   * 注意：本对象是**可信内部 API**。未授权调用方必须经 CommandBus（它会在每次操作前
   * 按实际资源重新授权）；sessionId 只是定位标识，不是访问凭证（S8-04）。
   */
  openSession(input: OpenSessionInput): Promise<ViewHandle>;
  closeView(viewId: string): Promise<CloseViewResult>;
  getSession(sessionId: string): DocumentStateView | undefined;
  getSessionByResource(resourceId: string): DocumentStateView | undefined;
  getBuffer(sessionId: string): string;
  applyEdit(sessionId: string, nextBuffer: string): DocumentStateView;
  save(sessionId: string, serializer: Serializer): Promise<SaveResult>;
  /**
   * 用磁盘内容覆盖会话（冲突恢复，S9B-C）。
   *
   * `discardDirty` 必须由调用方在用户明确确认后传 true；
   * 否则存在未保存修改时直接拒绝（`ERR_DOCUMENT_DIRTY`），Core 绝不自行丢弃草稿。
   */
  reload(sessionId: string, options?: { discardDirty?: boolean }): Promise<ReloadResult>;
  reconcile(sessionId: string, serializer: Serializer): Promise<ReconcileResult>;
  detectExternalChange(sessionId: string): Promise<{ changed: boolean; diskVersion: string | null }>;
  drainEvents(): DocumentEvent[];
  /** 只读身份查询：按 resourceId 探测已有会话的身份（S8-02，不返回 Provider/缓冲）。 */
  identityFor(input: OpenSessionInput): ResourceIdentityProbe;
  /** 只读身份查询：按 sessionId 取会话的实际资源身份（S8-02）。 */
  inspectSession(sessionId: string): SessionIdentity | undefined;
  /** 判断候选路径是否与会话绑定的规范路径一致（S8-02，path 的存在性校验）。 */
  matchesSessionPath(sessionId: string, candidatePath: string): boolean;
  /**
   * 把某项目的全部会话标记为失效（G1-07）。
   * 仅置标记：缓冲、revision、baseVersion、dirty 与六态 state 全部保持不变。
   * 返回被标记的会话数。
   */
  markProjectStale(projectId: string, reason: string): number;
  /** 标记单个会话失效；仅用于 Host 已经判定该会话的磁盘门禁失败时。 */
  markSessionStale(sessionId: string, reason: string): boolean;
}

export interface DocumentEvent {
  type: 'SESSION_OPENED' | 'SESSION_STALE' | 'DOCUMENT_RELOADED' | 'EDIT_APPLIED' | 'SAVE_STARTED' | 'SAVE_COMMITTED' | 'SAVE_CONFLICT' | 'SAVE_FAILED' | 'SAVE_UNKNOWN' | 'VIEW_CLOSED' | 'CLOSE_BLOCKED_DIRTY';
  sessionId: string;
  resourceId: string;
  occurredAt: string;
  traceId: string;
  /** 与 SaveResult 的错误码保持同源，避免与 LogRecord/错误码注册表脱节。 */
  errorCode?: SaveResult['errorCode'];
  detail?: Record<string, unknown>;
}

export interface DocumentServiceOptions {
  logger?: Logger;
  clock?: () => Date;
}

let sessionCounter = 0;
let viewCounter = 0;

export function createDocumentService(options: DocumentServiceOptions = {}): DocumentService {
  const sessions = new Map<string, Session>();
  const sessionsByResource = new Map<string, string>();
  const views = new Map<string, string>();
  const events: DocumentEvent[] = [];
  const clock = options.clock ?? (() => new Date());
  const logger = options.logger;

  function emit(event: Omit<DocumentEvent, 'occurredAt' | 'traceId'>): void {
    const full: DocumentEvent = {
      ...event,
      occurredAt: clock().toISOString(),
      traceId: currentTrace()?.traceId ?? 'trace-unbound',
    };
    events.push(full);
    const level = event.type === 'SAVE_FAILED' || event.type === 'SAVE_CONFLICT' ? 'WARN' : 'INFO';
    logger?.log({
      event: event.type,
      level,
      resourceId: event.resourceId,
      sessionId: event.sessionId,
      errorCode: event.errorCode,
      detail: event.detail,
    });
  }

  function toView(session: Session): DocumentStateView {
    return {
      sessionId: session.sessionId,
      resourceId: session.resourceId,
      baseVersion: session.baseVersion,
      revision: session.revision,
      dirty: session.dirty,
      state: session.state,
      views: session.views.size,
      ...(session.stale ? { stale: { ...session.stale } } : {}),
    };
  }

  function require(sessionId: string): Session {
    const s = sessions.get(sessionId);
    if (!s) {
      throw Object.assign(new Error(`会话不存在: ${sessionId}`), {
        errorCode: 'ERR_DOCUMENT_NOT_FOUND',
      });
    }
    return s;
  }

  function toIdentity(session: Session): SessionIdentity {
    return Object.freeze({
      sessionId: session.sessionId,
      resourceId: session.resourceId,
      path: session.path,
      providerId: session.provider.providerId,
      providerScope: session.providerScope,
      ...(session.projectId ? { projectId: session.projectId } : {}),
    });
  }

  /** resourceId 命中时校验「Provider 身份 + 规范路径」是否仍一致（S8-01）。 */
  function probeIdentity(input: OpenSessionInput): ResourceIdentityProbe {
    const existingId = sessionsByResource.get(input.resourceId);
    const session = existingId ? sessions.get(existingId) : undefined;
    if (!session) return { status: 'none' };

    const incomingScope = providerScopeOf(input.provider);
    const incomingKey = resourceKeyOf(input.provider, input.path);
    if (session.providerScope === incomingScope && session.resourceKey === incomingKey) {
      return { status: 'match', identity: toIdentity(session) };
    }
    return { status: 'conflict', claimedPath: input.path, identity: toIdentity(session) };
  }

  return {
    async openSession(input: OpenSessionInput): Promise<ViewHandle> {
      // 先做身份探测：不一致必须在任何读取/副作用之前拒绝，不允许隐式重绑定（S8-01）
      const probe = probeIdentity(input);
      if (probe.status === 'conflict') {
        throw Object.assign(
          new Error(
            `资源身份冲突：resourceId ${input.resourceId} 已绑定 ${probe.identity.providerId}:${probe.identity.path}，` +
              `本次请求为 ${input.provider.providerId}:${input.path}`,
          ),
          { errorCode: 'ERR_RESOURCE_IDENTITY_CONFLICT' as const },
        );
      }

      let sessionId = sessionsByResource.get(input.resourceId);
      let session = sessionId ? sessions.get(sessionId) : undefined;
      let reloaded = false;

      /**
       * G1-07：失效会话不得被静默复用。
       * - 有未保存草稿 → 拒绝（`ERR_SESSION_STALE`），绝不覆盖；
       * - 无草稿 → 丢弃该会话并按磁盘重建（磁盘是唯一权威，不存在草稿损失）。
       * 两种情况都不做 Provider 重绑定、不迁移到其他根。
       */
      if (session?.stale) {
        if (session.dirty) {
          throw Object.assign(
            new Error(
              `会话已失效（${session.stale.reason}）且存在未保存修改，拒绝覆盖草稿: ${session.path}`,
            ),
            { errorCode: 'ERR_SESSION_STALE' as const, staleReason: session.stale.reason },
          );
        }
        for (const viewId of session.views) views.delete(viewId);
        sessions.delete(session.sessionId);
        sessionsByResource.delete(input.resourceId);
        sessionId = undefined;
        session = undefined;
      }

      /**
       * S9B-A：会话在「全部视图已关闭且没有未保存修改」时被复用时，磁盘可能已被外部编辑器改动。
       * 此时必须重新读取磁盘并刷新会话，否则用户会看到旧内容、拿着旧 baseVersion，
       * 一保存就必然 CONFLICT（且 UI 没有恢复入口）。
       *
       * 唯一的禁止条件是 **dirty**：不能拿磁盘内容覆盖正在编辑的草稿（S9B-B）。
       * 不按「有没有视图」判断——页面刷新/崩溃会留下无人认领的旧视图，
       * 若因此跳过刷新，用户重开后仍会拿着旧版本保存，缺陷会以另一种形式复现。
       */
      if (session && !session.dirty) {
        // F02：读盘是异步的，期间会话可能被编辑/保存/重载；先记录代次，回来再核对。
        const snapshot = {
          revision: session.revision,
          baseVersion: session.baseVersion,
          dirty: session.dirty,
        };

        let disk: ReadResult | null = null;
        try {
          disk = await session.provider.read(session.path);
        } catch (err) {
          // F01：读取失败必须分类，不能静默吞掉后继续返回旧的 CLEAN 会话。
          // 唯一可接受的是「从未存在的新文件」：baseVersion 为空且磁盘上确实没有该文件。
          const code = (err as { errorCode?: string }).errorCode;
          const neverExisted = session.baseVersion === null && code === 'ERR_RESOURCE_NOT_FOUND';
          if (!neverExisted) throw err;
          disk = null;
        }

        // await 之后重新核对：出现新编辑、基线变化或转 dirty，都放弃这次回填
        const unchanged =
          session.revision === snapshot.revision &&
          session.baseVersion === snapshot.baseVersion &&
          session.dirty === snapshot.dirty &&
          !session.dirty;

        if (disk && unchanged && disk.contentVersion !== session.baseVersion) {
          const previousBaseVersion = session.baseVersion;
          session.buffer = disk.content;
          session.baseVersion = disk.contentVersion;
          session.state = 'CLEAN';
          session.revision += 1;
          reloaded = true;
          emit({
            type: 'DOCUMENT_RELOADED',
            sessionId: session.sessionId,
            resourceId: session.resourceId,
            detail: {
              reason: 'reopen-after-external-change',
              views: session.views.size,
              previousBaseVersion,
              baseVersion: disk.contentVersion,
            },
          });
        }
      }

      if (!session) {
        const read = await readForOpen(input.provider, input.path);
        sessionId = `session-${++sessionCounter}`;
        session = {
          sessionId,
          resourceId: input.resourceId,
          path: input.path,
          provider: input.provider,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          providerScope: providerScopeOf(input.provider),
          resourceKey: resourceKeyOf(input.provider, input.path),
          buffer: read?.content ?? '',
          baseVersion: read?.contentVersion ?? null,
          revision: 0,
          dirty: false,
          state: 'CLEAN',
          views: new Set<string>(),
        };
        sessions.set(sessionId, session);
        sessionsByResource.set(input.resourceId, sessionId);
        emit({
          type: 'SESSION_OPENED',
          sessionId,
          resourceId: input.resourceId,
          detail: { baseVersion: session.baseVersion, existed: read !== null },
        });
      }

      const viewId = `view-${++viewCounter}`;
      views.set(viewId, session.sessionId);
      session.views.add(viewId);
      return { viewId, sessionId: session.sessionId, resourceId: session.resourceId, reloaded };
    },

    async closeView(viewId: string): Promise<CloseViewResult> {
      const sessionId = views.get(viewId);
      if (!sessionId) {
        return { closed: false, protectedDirty: false, reason: '视图不存在' };
      }
      const session = require(sessionId);
      if (session.views.size <= 1 && session.dirty) {
        emit({
          type: 'CLOSE_BLOCKED_DIRTY',
          sessionId,
          resourceId: session.resourceId,
          errorCode: 'ERR_DOCUMENT_DIRTY',
          detail: { viewId, revision: session.revision },
        });
        return {
          closed: false,
          protectedDirty: true,
          reason: '存在未保存修改，拒绝关闭最后一个视图（DATA-002）',
        };
      }
      session.views.delete(viewId);
      views.delete(viewId);
      emit({ type: 'VIEW_CLOSED', sessionId, resourceId: session.resourceId, detail: { viewId } });
      return { closed: true, protectedDirty: false };
    },

    getSession(sessionId: string) {
      const s = sessions.get(sessionId);
      return s ? toView(s) : undefined;
    },

    getSessionByResource(resourceId: string) {
      const id = sessionsByResource.get(resourceId);
      const s = id ? sessions.get(id) : undefined;
      return s ? toView(s) : undefined;
    },

    getBuffer(sessionId: string) {
      return require(sessionId).buffer;
    },

    applyEdit(sessionId: string, nextBuffer: string): DocumentStateView {
      const session = require(sessionId);
      if (session.buffer !== nextBuffer) {
        session.buffer = nextBuffer;
        session.revision += 1;
        session.dirty = true;
        if (session.state === 'CLEAN' || session.state === 'SAVING') {
          session.state = 'EDITING_DIRTY';
        }
        emit({
          type: 'EDIT_APPLIED',
          sessionId,
          resourceId: session.resourceId,
          detail: { revision: session.revision },
        });
      }
      return toView(session);
    },

    async save(sessionId: string, serializer: Serializer): Promise<SaveResult> {
      const session = require(sessionId);
      const elapsed = startMonotonic();
      // 保存代次：本次保存写入的是「哪一个 revision」的缓冲。
      // 保存期间允许继续编辑（真实打字节奏），但由此产生的新编辑绝不能被当成已保存（DATA-002）。
      const savedRevision = session.revision;
      session.state = 'SAVING';
      emit({
        type: 'SAVE_STARTED',
        sessionId,
        resourceId: session.resourceId,
        detail: { revision: savedRevision },
      });

      // F02：序列化阶段失败必须收敛为明确失败。此时写请求尚未交给 Provider，
      // 磁盘未被触碰，因此 baseVersion 不得改变（否则会把未发生的写当成已知基线），
      // 状态也不得停留在 SAVING。
      let payload: string;
      try {
        payload = serializer(session.buffer);
      } catch (err) {
        const durationMs = elapsed();
        session.state = 'FAILED';
        session.dirty = true;
        session.lastErrorCode = 'ERR_SAVE_FAILED';
        emit({
          type: 'SAVE_FAILED',
          sessionId,
          resourceId: session.resourceId,
          errorCode: 'ERR_SAVE_FAILED',
          detail: {
            phase: 'serialize',
            durationMs,
            reason: err instanceof Error ? err.message : String(err),
          },
        });
        return { status: 'FAILED', errorCode: 'ERR_SAVE_FAILED', durationMs };
      }

      let result: SaveResult;
      try {
        result = await session.provider.writeConditional(session.path, payload, session.baseVersion);
      } catch (err) {
        // F02：写请求已交给 Provider，异常导致「是否已落盘」无法确认 → 保守报 UNKNOWN。
        // 不得报 FAILED（副作用可能已发生），也不得报成功。
        const durationMs = elapsed();
        session.state = 'OUTCOME_UNKNOWN';
        session.dirty = true;
        session.lastErrorCode = 'ERR_OUTCOME_UNKNOWN';
        emit({
          type: 'SAVE_UNKNOWN',
          sessionId,
          resourceId: session.resourceId,
          errorCode: 'ERR_OUTCOME_UNKNOWN',
          detail: {
            phase: 'provider',
            durationMs,
            reason: err instanceof Error ? err.message : String(err),
          },
        });
        return { status: 'UNKNOWN', errorCode: 'ERR_OUTCOME_UNKNOWN', durationMs };
      }
      const durationMs = elapsed();

      switch (result.status) {
        case 'COMMITTED': {
          // baseVersion 始终指向「已经写入磁盘的版本」；当它与当前缓冲的代次不一致时，
          // 说明保存期间又产生了新编辑 → 必须保持 dirty，只允许把状态退回 EDITING_DIRTY。
          session.baseVersion = result.contentVersion ?? null;
          const editedDuringSave = session.revision !== savedRevision;
          if (editedDuringSave) {
            session.dirty = true;
            session.state = 'EDITING_DIRTY';
          } else {
            session.dirty = false;
            session.state = 'CLEAN';
          }
          emit({
            type: 'SAVE_COMMITTED',
            sessionId,
            resourceId: session.resourceId,
            detail: {
              contentVersion: session.baseVersion,
              durationMs,
              revision: savedRevision,
              savedRevision,
              currentRevision: session.revision,
              editedDuringSave,
            },
          });
          return { ...result, durationMs };
        }
        case 'CONFLICT': {
          session.state = 'CONFLICT';
          session.dirty = true;
          emit({
            type: 'SAVE_CONFLICT',
            sessionId,
            resourceId: session.resourceId,
            errorCode: 'ERR_DOCUMENT_VERSION_CONFLICT',
            detail: { baseVersion: session.baseVersion, diskVersion: result.contentVersion, durationMs },
          });
          return { ...result, durationMs };
        }
        case 'UNKNOWN': {
          // 不标记 CLEAN，也不自动重试（docs/06 状态机）
          session.state = 'OUTCOME_UNKNOWN';
          session.dirty = true;
          session.lastErrorCode = 'ERR_OUTCOME_UNKNOWN';
          emit({
            type: 'SAVE_UNKNOWN',
            sessionId,
            resourceId: session.resourceId,
            errorCode: 'ERR_OUTCOME_UNKNOWN',
            detail: { durationMs },
          });
          return { ...result, durationMs };
        }
        default: {
          session.state = 'FAILED';
          session.dirty = true;
          session.lastErrorCode = result.errorCode;
          emit({
            type: 'SAVE_FAILED',
            sessionId,
            resourceId: session.resourceId,
            errorCode: result.errorCode ?? 'ERR_SAVE_FAILED',
            detail: { durationMs },
          });
          return { ...result, durationMs };
        }
      }
    },

    async reload(sessionId: string, options?: { discardDirty?: boolean }): Promise<ReloadResult> {
      const session = require(sessionId);
      if (session.dirty && options?.discardDirty !== true) {
        throw Object.assign(new Error('会话存在未保存修改，未经确认不得用磁盘内容覆盖'), {
          errorCode: 'ERR_DOCUMENT_DIRTY' as const,
        });
      }
      // 读取失败（不存在/不可读/非文本）必须上抛：绝不能用空内容或旧内容伪装成"重载成功"
      const read = await session.provider.read(session.path);
      const previousContent = session.buffer;
      const previousBaseVersion = session.baseVersion;
      session.buffer = read.content;
      session.baseVersion = read.contentVersion;
      session.dirty = false;
      session.state = 'CLEAN';
      session.revision += 1;
      emit({
        type: 'DOCUMENT_RELOADED',
        sessionId,
        resourceId: session.resourceId,
        detail: {
          reason: 'explicit-reload',
          discardedDirty: previousContent !== read.content,
          previousBaseVersion,
          baseVersion: read.contentVersion,
        },
      });
      return { content: read.content, contentVersion: read.contentVersion, previousContent, previousBaseVersion };
    },

    async reconcile(sessionId: string, serializer: Serializer): Promise<ReconcileResult> {
      const session = require(sessionId);
      let disk: { content: string; contentVersion: string } | null = null;
      try {
        disk = await session.provider.read(session.path);
      } catch {
        disk = null;
      }
      if (!disk) {
        return {
          outcome: 'UNKNOWN',
          diskVersion: null,
          dirty: session.dirty,
          detail: '磁盘不可读，无法判定副作用是否已发生',
        };
      }
      // F02：序列化失败不得直接抛出——无法确认磁盘副作用，必须保持 UNKNOWN。
      let expected: string;
      try {
        expected = serializer(session.buffer);
      } catch (err) {
        return {
          outcome: 'UNKNOWN',
          diskVersion: disk.contentVersion,
          dirty: session.dirty,
          detail: `序列化失败（${err instanceof Error ? err.message : String(err)}），无法确认副作用是否已发生`,
        };
      }

      // S5-03：判定「副作用是否已发生」必须比较**字节级**版本，而不是解码后的文本。
      // 不同字节可能解码成同一字符串，用文本比较会把未生效的写入误报为 APPLIED。
      let expectedVersion: string;
      try {
        const encoded = encodeUtf8Text(expected);
        if (!Buffer.isBuffer(encoded)) {
          return {
            outcome: 'UNKNOWN',
            diskVersion: disk.contentVersion,
            dirty: session.dirty,
            detail: `序列化结果无法无损编码（${encoded.errorCode}），无法确认副作用是否已发生`,
          };
        }
        expectedVersion = contentVersionOf(encoded);
      } catch {
        return {
          outcome: 'UNKNOWN',
          diskVersion: disk.contentVersion,
          dirty: session.dirty,
          detail: '序列化结果无法编码，无法确认副作用是否已发生',
        };
      }

      if (disk.contentVersion === expectedVersion) {
        session.baseVersion = disk.contentVersion;
        session.dirty = false;
        session.state = 'CLEAN';
        return {
          outcome: 'APPLIED',
          diskVersion: disk.contentVersion,
          dirty: false,
          detail: '磁盘内容与会话缓冲一致：此前 UNKNOWN 的保存实际已生效',
        };
      }
      return {
        outcome: 'NOT_APPLIED',
        diskVersion: disk.contentVersion,
        dirty: session.dirty,
        detail: '磁盘内容与会话缓冲不同：副作用未发生，可安全重新编辑/保存',
      };
    },

    async detectExternalChange(sessionId: string) {
      const session = require(sessionId);
      const stat = await session.provider.stat(session.path);
      // S8-06：原本存在（已建立基线）的文件消失必须报告变化；
      // 只有「从未存在的新建会话」才允许 changed:false。I/O/路径错误仍照常抛出。
      const changed = stat.exists
        ? stat.contentVersion !== session.baseVersion
        : session.baseVersion !== null;
      return { changed, diskVersion: stat.contentVersion };
    },

    identityFor(input: OpenSessionInput): ResourceIdentityProbe {
      return probeIdentity(input);
    },

    inspectSession(sessionId: string): SessionIdentity | undefined {
      const session = sessions.get(sessionId);
      return session ? toIdentity(session) : undefined;
    },

    matchesSessionPath(sessionId: string, candidatePath: string): boolean {
      const session = sessions.get(sessionId);
      if (!session) return false;
      try {
        return resourceKeyOf(session.provider, candidatePath) === session.resourceKey;
      } catch {
        return false;
      }
    },

    markProjectStale(projectId: string, reason: string) {
      const since = clock().toISOString();
      let marked = 0;
      for (const session of sessions.values()) {
        if (session.projectId !== projectId) continue;
        session.stale = { reason, since };
        marked += 1;
        emit({
          type: 'SESSION_STALE',
          sessionId: session.sessionId,
          resourceId: session.resourceId,
          detail: { reason, projectId, dirty: session.dirty, revision: session.revision },
        });
      }
      return marked;
    },

    markSessionStale(sessionId: string, reason: string) {
      const session = sessions.get(sessionId);
      if (!session) return false;
      session.stale = { reason, since: clock().toISOString() };
      emit({
        type: 'SESSION_STALE',
        sessionId,
        resourceId: session.resourceId,
        detail: { reason, projectId: session.projectId, dirty: session.dirty, revision: session.revision },
      });
      return true;
    },

    drainEvents() {
      const copy = [...events];
      events.length = 0;
      return copy;
    },
  };
}
