/**
 * Command Bus（P0 探针版）。
 *
 * 规则来源：docs/03、docs/12 DATA-001 / SEC-001、docs/04 CommandEnvelope/Result。
 * - 身份由调用方（未来 Gateway）在 ctx 中绑定；envelope 不携带可信 actorId（RSK-04）。
 * - 写命令必须携带 expectedVersion（RSK-05），缺失即 REJECTED。
 * - idempotencyKey 命中则返回原收据，不重复产生副作用（CT-07）。
 * - UNKNOWN 不入收据、不自动重放：必须经 document.reconcile 核对。
 * - 每次判定与结果都写审计记录（actorId/时间/资源/结果）。
 *
 * 资源身份（S8）：
 * - 授权的对象必须是**实际资源**（会话绑定的 Provider + 规范路径），不是调用方声称的 path；
 * - target 与 payload 的资源声明必须一致，二者与会话实际身份也必须一致；
 * - 审计记录实际资源；拒绝时区分「声称」与「已验证」；
 * - sessionId 只是定位标识，不是访问凭证：每次访问都重新授权（S8-04）。
 */
import { createHash } from 'node:crypto';
import type { CommandEnvelope, CommandResult, CommandStatus } from '../contracts/types.ts';
import type { DocumentService, Serializer, SessionIdentity } from '../document/document-service.ts';
import type { Logger } from '../observability/logger.ts';
import {
  currentTrace,
  newOperationId,
  newTraceId,
  runWithOperation,
  runWithTrace,
  startMonotonic,
  utcNow,
} from '../observability/trace.ts';
import type { PermissionService } from '../permission/permission-service.ts';
import type { StorageProvider } from '../storage/local-provider.ts';
import { validateEnvelope, type EnvelopeViolation } from './validate.ts';

export interface CommandContext {
  /** 由网关绑定，不接受客户端自述。 */
  actorId: string;
  traceId?: string;
  operationId?: string;
}

export interface CommandDispatchOutcome extends CommandResult {
  deduplicated?: boolean;
  violations?: EnvelopeViolation[];
}

export interface CommandBusOptions {
  document: DocumentService;
  permission: PermissionService;
  resolveProvider: (providerId: string) => StorageProvider | undefined;
  resolveSerializer?: (serializerId: string) => Serializer | undefined;
  logger?: Logger;
  clock?: () => Date;
}

interface HandlerOutcome {
  status: CommandStatus;
  result?: unknown;
  errorCode?: CommandResult['errorCode'];
  resultingVersion?: string;
  /** UNKNOWN 时不写收据。 */
  cacheable?: boolean;
}

/** 已经过解析与身份校验的实际操作目标（S8-02）。 */
interface ResolvedTarget {
  resourceId: string;
  /** 用于授权的路径：命中已有会话时取会话绑定的实际路径。 */
  path: string;
  providerId: string;
  provider: StorageProvider;
  sessionId?: string;
}

interface ReceiptEntry {
  outcome: CommandDispatchOutcome;
  /** 命令语义 + 实际目标；同一幂等键不得跨语义/跨目标复用（S8-07）。 */
  fingerprint: string;
}

export interface CommandBus {
  dispatch(envelope: CommandEnvelope, ctx: CommandContext): Promise<CommandDispatchOutcome>;
  /** 只返回该 actor 自己的收据；缺少 actorId 时一律不返回（S8-07）。 */
  getResult(idempotencyKey: string, actorId?: string): CommandDispatchOutcome | undefined;
  receiptCount(): number;
}

const WRITE_COMMANDS = new Set(['document.applyEdit', 'document.save']);
const READ_COMMANDS = new Set(['document.open']);

const identitySerializer: Serializer = (buffer) => buffer;

export function createCommandBus(options: CommandBusOptions): CommandBus {
  const { document, permission, resolveProvider } = options;
  const logger = options.logger;
  const clock = options.clock ?? (() => new Date());
  const receipts = new Map<string, ReceiptEntry>();
  const seenCommandIds = new Set<string>();

  function audit(entry: {
    actorId: string;
    event: string;
    commandType: string;
    resourceId?: string;
    result: string;
    errorCode?: CommandResult['errorCode'];
    durationMs?: number;
    commandId: string;
    extra?: Record<string, unknown>;
  }): void {
    logger?.log({
      ...entry,
      ...(entry.extra ?? {}),
      level: 'INFO',
      kind: 'AUDIT',
      event: entry.event,
      operationId: currentTrace()?.operationId,
    });
  }

  async function run(envelope: CommandEnvelope, target: ResolvedTarget): Promise<HandlerOutcome> {
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;

    switch (envelope.type) {
      case 'document.open': {
        const handle = await document.openSession({
          resourceId: target.resourceId,
          path: target.path,
          provider: target.provider,
        });
        return { status: 'APPLIED', result: handle };
      }

      case 'document.applyEdit': {
        const buffer = String(payload.buffer ?? '');
        const view = document.applyEdit(target.sessionId!, buffer);
        return { status: 'APPLIED', result: view };
      }

      case 'document.save': {
        const sessionId = target.sessionId!;
        const session = document.getSession(sessionId);
        if (!session) {
          return { status: 'REJECTED', errorCode: 'ERR_DOCUMENT_NOT_FOUND' };
        }
        if (envelope.expectedVersion && session.baseVersion !== envelope.expectedVersion) {
          return {
            status: 'REJECTED',
            errorCode: 'ERR_DOCUMENT_VERSION_CONFLICT',
            result: { baseVersion: session.baseVersion },
          };
        }
        const serializerId = typeof payload.serializerId === 'string' ? payload.serializerId : 'identity';
        // S5-05：显式指定但无法解析的 serializerId 不得静默回退 identity 直写；
        // 未指定（或明确 'identity'）才使用原样文本写回，其文本安全校验由 storage 侧强制。
        let serializer: Serializer;
        const resolvedSerializer = options.resolveSerializer?.(serializerId);
        if (resolvedSerializer) {
          serializer = resolvedSerializer;
        } else if (serializerId === 'identity') {
          serializer = identitySerializer;
        } else {
          return {
            status: 'REJECTED',
            errorCode: 'ERR_COMMAND_INVALID',
            result: { serializerId, reason: '未知 serializerId：禁止回退 identity 直写' },
          };
        }
        const saved = await document.save(sessionId, serializer);
        const status: CommandStatus =
          saved.status === 'COMMITTED'
            ? 'APPLIED'
            : saved.status === 'CONFLICT'
              ? 'REJECTED'
              : saved.status === 'UNKNOWN'
                ? 'UNKNOWN'
                : 'FAILED';
        return {
          status,
          errorCode: saved.errorCode,
          resultingVersion: saved.contentVersion,
          result: saved,
          cacheable: status !== 'UNKNOWN',
        };
      }

      default:
        return { status: 'REJECTED', errorCode: 'ERR_COMMAND_UNSUPPORTED' };
    }
  }

  return {
    async dispatch(envelope, ctx): Promise<CommandDispatchOutcome> {
      // 无追踪上下文时自动建立一条，保证命令链路的日志都有可用的 traceId（docs/09）
      if (!currentTrace()) {
        const traceId = ctx.traceId ?? newTraceId();
        const runId = logger?.runId ?? 'run-unbound';
        return runWithTrace({ runId, traceId }, () => dispatchImpl(envelope, ctx));
      }
      return dispatchImpl(envelope, ctx);
    },

    getResult(idempotencyKey: string, actorId?: string) {
      // S8-07：收据是「该 actor 的操作结果」，不得跨主体查询；无 actor 上下文一律不返回。
      if (!actorId) return undefined;
      return receipts.get(`${actorId}::${idempotencyKey}`)?.outcome;
    },

    receiptCount() {
      return receipts.size;
    },
  };

  async function dispatchImpl(
    envelope: CommandEnvelope,
    ctx: CommandContext,
  ): Promise<CommandDispatchOutcome> {
    const elapsed = startMonotonic();
    // 有 operationId 时建立子作用域，使 document 保存事件共享同一 operationId
    if (ctx.operationId) {
      const operationId = ctx.operationId;
      return runWithOperation(operationId, () => body());
    }
    return body();

    async function body(): Promise<CommandDispatchOutcome> {
      const reject = (
        errorCode: CommandResult['errorCode'],
        violations?: EnvelopeViolation[],
        extra?: Record<string, unknown>,
      ): CommandDispatchOutcome => {
        const out: CommandDispatchOutcome = {
          commandId: envelope?.commandId ?? 'unknown',
          status: 'REJECTED',
          errorCode,
          violations,
        };
        audit({
          actorId: ctx.actorId,
          event: 'COMMAND_REJECTED',
          commandType: envelope?.type ?? 'unknown',
          resourceId: typeof extra?.resourceId === 'string' ? extra.resourceId : undefined,
          result: 'REJECTED',
          errorCode,
          durationMs: elapsed(),
          commandId: out.commandId,
          extra,
        });
        return out;
      };

      /**
       * 无法定位目标（会话不存在）沿用既有契约：按 FAILED 结束而不是 REJECTED，
       * 以保持 docs/04「执行期失败」语义与 CONTRACT-07 的断言不变。
       * 此路径不触碰任何资源，因此不需要（也无法）做资源授权。
       */
      const fail = (errorCode: CommandResult['errorCode']): CommandDispatchOutcome => {
        const out: CommandDispatchOutcome = {
          commandId: envelope.commandId,
          status: 'FAILED',
          errorCode,
        };
        audit({
          actorId: ctx.actorId,
          event: 'COMMAND_COMPLETED',
          commandType: envelope.type,
          result: 'FAILED',
          errorCode,
          durationMs: elapsed(),
          commandId: out.commandId,
          extra: { reason: '目标不可定位' },
        });
        return out;
      };

      const violations = validateEnvelope(envelope);
      if (violations.length > 0) {
        return reject('ERR_COMMAND_INVALID', violations);
      }
      if (seenCommandIds.has(envelope.commandId)) {
        return reject('ERR_COMMAND_INVALID', [
          { field: 'commandId', reason: '重复的 commandId（幂等请使用 idempotencyKey）' },
        ]);
      }
      seenCommandIds.add(envelope.commandId);

      const isWrite = WRITE_COMMANDS.has(envelope.type);
      const known = isWrite || READ_COMMANDS.has(envelope.type);
      if (!known) {
        return reject('ERR_COMMAND_UNSUPPORTED');
      }

      if (isWrite && !envelope.expectedVersion) {
        return reject('ERR_COMMAND_INVALID', [
          { field: 'expectedVersion', reason: '写命令必须携带 expectedVersion（DATA-001）' },
        ]);
      }

      const payload = (envelope.payload ?? {}) as Record<string, unknown>;
      const payloadResourceId = typeof payload.resourceId === 'string' ? payload.resourceId : undefined;
      const payloadProviderId = typeof payload.providerId === 'string' ? payload.providerId : undefined;
      const payloadPath = typeof payload.path === 'string' && payload.path !== '' ? payload.path : undefined;

      // S8-02：target 与 payload 的资源声明不能互相矛盾
      if (envelope.target?.resourceId && payloadResourceId && envelope.target.resourceId !== payloadResourceId) {
        return reject('ERR_COMMAND_INVALID', [
          { field: 'resourceId', reason: 'envelope.target.resourceId 与 payload.resourceId 不一致' },
        ]);
      }
      if (envelope.target?.providerId && payloadProviderId && envelope.target.providerId !== payloadProviderId) {
        return reject('ERR_COMMAND_INVALID', [
          { field: 'providerId', reason: 'envelope.target.providerId 与 payload.providerId 不一致' },
        ]);
      }

      const claimedResourceId = envelope.target?.resourceId ?? payloadResourceId;
      const claimedProviderId = envelope.target?.providerId ?? payloadProviderId;

      // ---- 解析实际目标：授权之前必须先确定“到底操作谁”（S8-02） ----
      let target: ResolvedTarget;
      try {
        if (envelope.type === 'document.open') {
          if (!payloadPath) {
            return reject('ERR_COMMAND_INVALID', [
              { field: 'path', reason: '打开资源必须声明 path（禁止回退到根范围授权）' },
            ]);
          }
          const providerId = claimedProviderId ?? 'local';
          // resourceId 缺省时按「Provider + 声明路径」派生一个稳定标识，
          // 避免用空串做键（空串会让不同资源共用同一会话槽位）。
          const resourceId = claimedResourceId ?? `derived:${providerId}:${payloadPath}`;
          const provider = resolveProvider(providerId);
          if (!provider) {
            return reject('ERR_RESOURCE_NOT_FOUND', undefined, { providerId });
          }
          const probe = document.identityFor({ resourceId, path: payloadPath, provider });
          if (probe.status === 'conflict') {
            return reject('ERR_RESOURCE_IDENTITY_CONFLICT', undefined, {
              resourceId: probe.identity.resourceId,
              claimedResourceId,
              claimedPath: payloadPath,
              verifiedPath: probe.identity.path,
              verifiedProviderId: probe.identity.providerId,
              reason: 'resourceId 已绑定其他 Provider/路径，不得隐式复用',
            });
          }
          target =
            probe.status === 'match'
              ? {
                  resourceId: probe.identity.resourceId,
                  path: probe.identity.path,
                  providerId: probe.identity.providerId,
                  provider,
                  sessionId: probe.identity.sessionId,
                }
              : { resourceId, path: payloadPath, providerId, provider };
        } else {
          const sessionId = String(payload.sessionId ?? '');
          if (!sessionId) {
            return reject('ERR_COMMAND_INVALID', [{ field: 'sessionId', reason: '必须声明 sessionId' }]);
          }
          const identity: SessionIdentity | undefined = document.inspectSession(sessionId);
          if (!identity) {
            // 既有契约（CONTRACT-06/07）对「目标会话不存在」的状态码并不一致：
            // save 视为请求拒绝（REJECTED），applyEdit 视为执行失败（FAILED）。
            // 两者都已被端到端契约测试固定，本轮不改语义，只在 README 记录该不一致。
            return envelope.type === 'document.save'
              ? reject('ERR_DOCUMENT_NOT_FOUND')
              : fail('ERR_DOCUMENT_NOT_FOUND');
          }
          if (claimedResourceId && claimedResourceId !== identity.resourceId) {
            return reject('ERR_COMMAND_INVALID', [
              { field: 'resourceId', reason: '声明的 resourceId 与实际会话不一致' },
            ]);
          }
          if (payloadPath && !document.matchesSessionPath(sessionId, payloadPath)) {
            return reject('ERR_COMMAND_INVALID', [{ field: 'path', reason: '声明的 path 与实际会话不一致' }]);
          }
          // 声明的 providerId 必须与会话实际 Provider 一致（不得静默忽略错误声明）
          if (claimedProviderId && claimedProviderId !== identity.providerId) {
            return reject('ERR_COMMAND_INVALID', [
              { field: 'providerId', reason: '声明的 providerId 与实际会话不一致' },
            ]);
          }
          const provider = resolveProvider(identity.providerId);
          if (!provider) {
            return reject('ERR_RESOURCE_NOT_FOUND', undefined, { providerId: identity.providerId });
          }
          // F01：`providerId` 相同不代表同一个存储。resolveProvider 返回的 Provider 必须与
          // 会话创建时绑定的存储根身份一致，否则授权对象（A）与实际写入对象（B）会错配。
          const providerProbe = document.identityFor({
            resourceId: identity.resourceId,
            path: identity.path,
            provider,
          });
          if (providerProbe.status !== 'match') {
            return reject('ERR_RESOURCE_IDENTITY_CONFLICT', undefined, {
              resourceId: identity.resourceId,
              sessionId,
              resourcePath: identity.path,
              claimedProviderId: identity.providerId,
              reason: 'resolveProvider 返回的 Provider 与会话绑定的存储根不一致',
            });
          }
          target = {
            resourceId: identity.resourceId,
            path: identity.path,
            providerId: identity.providerId,
            provider,
            sessionId,
          };
        }
      } catch (err) {
        const code = ((err as { errorCode?: CommandResult['errorCode'] }).errorCode ??
          'ERR_COMMAND_INTERNAL') as CommandResult['errorCode'];
        return reject(code, undefined, { claimedPath: payloadPath, claimedResourceId });
      }

      // F02：幂等指纹必须覆盖「这次操作到底做了什么」，而不只是目标标识。
      // 只存哈希，不在审计/日志中出现原文。commandId 不参与（合法重试会换 commandId）。
      const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
      const semantics = ((): string => {
        if (envelope.type === 'document.applyEdit') {
          return `|ev=${envelope.expectedVersion ?? ''}|buf=${digest(String(payload.buffer ?? ''))}`;
        }
        if (envelope.type === 'document.save') {
          const serializerId = typeof payload.serializerId === 'string' ? payload.serializerId : 'identity';
          const buffered = target.sessionId ? document.getBuffer(target.sessionId) : '';
          return `|ev=${envelope.expectedVersion ?? ''}|ser=${serializerId}|buf=${digest(buffered)}`;
        }
        return '';
      })();

      // F03：`document.open` 执行前还不存在 sessionId，若把它计入指纹，
      // 首次成功后的合法重试会因「- → 实际 sessionId」而被误判为新请求。
      // 打开操作的稳定身份是 Provider + ResourceId + Path，故不纳入运行期 sessionId；
      // applyEdit/save 仍保留 sessionId（它决定实际作用对象）。
      const sessionPart = envelope.type === 'document.open' ? 'open' : (target.sessionId ?? '-');

      const fingerprint = [
        envelope.type,
        isWrite ? 'W' : 'R',
        target.providerId,
        target.resourceId,
        target.path,
        sessionPart,
      ].join('|') + semantics;

      const authorize = (): { allowed: boolean; errorCode?: CommandResult['errorCode'] } => {
        const decision = permission.authorize({
          actorId: ctx.actorId,
          action: isWrite ? 'write' : 'read',
          resourcePath: target.path,
          providerId: target.providerId,
        });
        audit({
          actorId: ctx.actorId,
          event: 'PERMISSION_DECIDED',
          commandType: envelope.type,
          resourceId: target.resourceId,
          result: decision.allowed ? 'ALLOWED' : 'DENIED',
          errorCode: decision.allowed ? undefined : decision.errorCode,
          durationMs: elapsed(),
          commandId: envelope.commandId,
          extra: { resourcePath: target.path, providerId: target.providerId },
        });
        return { allowed: decision.allowed, errorCode: decision.errorCode as CommandResult['errorCode'] };
      };

      // ---- 幂等：命中收据也必须重新授权，且不得跨目标/跨语义复用（S8-07） ----
      if (envelope.idempotencyKey) {
        const cached = receipts.get(`${ctx.actorId}::${envelope.idempotencyKey}`);
        if (cached) {
          if (cached.fingerprint !== fingerprint) {
            return reject('ERR_COMMAND_INVALID', [
              { field: 'idempotencyKey', reason: '同一幂等键不得用于不同命令目标或语义' },
            ]);
          }
          const decision = authorize();
          if (!decision.allowed) {
            return reject(decision.errorCode ?? 'ERR_PERMISSION_DENIED', undefined, {
              resourceId: target.resourceId,
              reason: '授权已失效，不得返回旧收据',
            });
          }
          audit({
            actorId: ctx.actorId,
            event: 'COMMAND_DEDUPLICATED',
            commandType: envelope.type,
            resourceId: target.resourceId,
            result: cached.outcome.status,
            durationMs: elapsed(),
            commandId: envelope.commandId,
          });
          return { ...cached.outcome, commandId: envelope.commandId, deduplicated: true };
        }
      }

      const decision = authorize();
      if (!decision.allowed) {
        return reject(decision.errorCode ?? 'ERR_PERMISSION_DENIED', undefined, {
          resourceId: target.resourceId,
          resourcePath: target.path,
          providerId: target.providerId,
        });
      }

      let outcome: HandlerOutcome;
      try {
        outcome = await run(envelope, target);
      } catch (err) {
        const errorCode = ((err as { errorCode?: CommandResult['errorCode'] }).errorCode ??
          'ERR_COMMAND_INTERNAL') as CommandResult['errorCode'];
        outcome = { status: 'FAILED', errorCode };
      }

      const finalResult: CommandDispatchOutcome = {
        commandId: envelope.commandId,
        status: outcome.status,
        result: outcome.result,
        errorCode: outcome.errorCode,
        resultingVersion: outcome.resultingVersion,
      };

      if (envelope.idempotencyKey && outcome.cacheable !== false) {
        receipts.set(`${ctx.actorId}::${envelope.idempotencyKey}`, {
          outcome: finalResult,
          fingerprint,
        });
      }

      audit({
        actorId: ctx.actorId,
        event: 'COMMAND_COMPLETED',
        commandType: envelope.type,
        resourceId: target.resourceId,
        result: outcome.status,
        errorCode: outcome.errorCode,
        durationMs: elapsed(),
        commandId: envelope.commandId,
        extra: { resourcePath: target.path, providerId: target.providerId },
      });
      return finalResult;
    }
  }
}
