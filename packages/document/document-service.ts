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
import { encodeUtf8Text } from '../storage/text-safety.ts';

export type Serializer = (buffer: string) => string;

/**
 * 打开文本会话时的读取（S5-04）。
 *
 * - 真正不存在（ERR_RESOURCE_NOT_FOUND）→ 返回 null，保留“新建空会话”的合法语义；
 * - 编码非法 / 二进制 / 权限 / I/O 失败 → 原样抛出，不得伪装成“新建空文件”，
 *   也不得让调用方拿到一个虚假的 CLEAN 会话；
 * - 路径安全拒绝沿用 S4 既有契约（不读入内容、得到空会话，见 storage/README 已知限制）。
 */
async function readForOpen(provider: StorageProvider, path: string): Promise<ReadResult | null> {
  try {
    return await provider.read(path);
  } catch (err) {
    const code = (err as { errorCode?: string }).errorCode;
    if (code === 'ERR_RESOURCE_NOT_FOUND' || code === 'ERR_PATH_OUTSIDE_ROOT') return null;
    throw err;
  }
}

export interface OpenSessionInput {
  resourceId: string;
  path: string;
  provider: StorageProvider;
}

export interface ViewHandle {
  viewId: string;
  sessionId: string;
  resourceId: string;
}

export interface CloseViewResult {
  closed: boolean;
  /** true 表示因存在未保存修改而拒绝关闭（内容仍被保留）。 */
  protectedDirty: boolean;
  reason?: string;
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
  buffer: string;
  baseVersion: string | null;
  revision: number;
  dirty: boolean;
  state: DocumentState;
  views: Set<string>;
  lastErrorCode?: string;
}

export interface DocumentService {
  openSession(input: OpenSessionInput): Promise<ViewHandle>;
  closeView(viewId: string): Promise<CloseViewResult>;
  getSession(sessionId: string): DocumentStateView | undefined;
  getSessionByResource(resourceId: string): DocumentStateView | undefined;
  getBuffer(sessionId: string): string;
  applyEdit(sessionId: string, nextBuffer: string): DocumentStateView;
  save(sessionId: string, serializer: Serializer): Promise<SaveResult>;
  reconcile(sessionId: string, serializer: Serializer): Promise<ReconcileResult>;
  detectExternalChange(sessionId: string): Promise<{ changed: boolean; diskVersion: string | null }>;
  drainEvents(): DocumentEvent[];
}

export interface DocumentEvent {
  type: 'SESSION_OPENED' | 'EDIT_APPLIED' | 'SAVE_STARTED' | 'SAVE_COMMITTED' | 'SAVE_CONFLICT' | 'SAVE_FAILED' | 'SAVE_UNKNOWN' | 'VIEW_CLOSED' | 'CLOSE_BLOCKED_DIRTY';
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

  return {
    async openSession(input: OpenSessionInput): Promise<ViewHandle> {
      let sessionId = sessionsByResource.get(input.resourceId);
      let session = sessionId ? sessions.get(sessionId) : undefined;

      if (!session) {
        const read = await readForOpen(input.provider, input.path);
        sessionId = `session-${++sessionCounter}`;
        session = {
          sessionId,
          resourceId: input.resourceId,
          path: input.path,
          provider: input.provider,
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
      return { viewId, sessionId: session.sessionId, resourceId: session.resourceId };
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

      const payload = serializer(session.buffer);
      const result = await session.provider.writeConditional(
        session.path,
        payload,
        session.baseVersion,
      );
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
      const expected = serializer(session.buffer);

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
      const changed = stat.exists && stat.contentVersion !== session.baseVersion;
      return { changed, diskVersion: stat.contentVersion };
    },

    drainEvents() {
      const copy = [...events];
      events.length = 0;
      return copy;
    },
  };
}
