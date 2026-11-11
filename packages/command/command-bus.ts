/**
 * Command Bus（P0 探针版）。
 *
 * 规则来源：docs/03、docs/12 DATA-001 / SEC-001、docs/04 CommandEnvelope/Result。
 * - 身份由调用方（未来 Gateway）在 ctx 中绑定；envelope 不携带可信 actorId（RSK-04）。
 * - 写命令必须携带 expectedVersion（RSK-05），缺失即 REJECTED。
 * - idempotencyKey 命中则返回原收据，不重复产生副作用（CT-07）。
 * - UNKNOWN 不入收据、不自动重放：必须经 document.reconcile 核对。
 * - 每次判定与结果都写审计记录（actorId/时间/资源/结果）。
 */
import type { CommandEnvelope, CommandResult, CommandStatus } from '../contracts/types.ts';
import type { DocumentService, Serializer } from '../document/document-service.ts';
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

export interface CommandBus {
  dispatch(envelope: CommandEnvelope, ctx: CommandContext): Promise<CommandDispatchOutcome>;
  getResult(idempotencyKey: string): CommandDispatchOutcome | undefined;
  receiptCount(): number;
}

const WRITE_COMMANDS = new Set(['document.applyEdit', 'document.save']);
const READ_COMMANDS = new Set(['document.open']);

const identitySerializer: Serializer = (buffer) => buffer;

export function createCommandBus(options: CommandBusOptions): CommandBus {
  const { document, permission, resolveProvider } = options;
  const logger = options.logger;
  const clock = options.clock ?? (() => new Date());
  const receipts = new Map<string, CommandDispatchOutcome>();
  const seenCommandIds = new Set<string>();

  function audit(entry: {
    actorId: string;
    event: string;
    commandType: string;
    resourceId?: string;
    result: string;
    /** 与命令结果错误码同源，保证审计日志只能写入注册表中的稳定码。 */
    errorCode?: CommandResult['errorCode'];
    durationMs?: number;
    commandId: string;
  }): void {
    logger?.log({
      ...entry,
      level: 'INFO',
      kind: 'AUDIT',
      event: entry.event,
      operationId: currentTrace()?.operationId,
    });
  }

  async function run(
    envelope: CommandEnvelope,
    ctx: CommandContext,
    resourcePath: string | undefined,
  ): Promise<HandlerOutcome> {
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;

    switch (envelope.type) {
      case 'document.open': {
        const providerId = typeof payload.providerId === 'string' ? payload.providerId : 'local';
        const provider = resolveProvider(providerId);
        if (!provider) {
          return { status: 'REJECTED', errorCode: 'ERR_RESOURCE_NOT_FOUND' };
        }
        const resourceId = String(payload.resourceId ?? envelope.target?.resourceId ?? '');
        const path = String(payload.path ?? '');
        const handle = await document.openSession({ resourceId, path, provider });
        return { status: 'APPLIED', result: handle };
      }

      case 'document.applyEdit': {
        const sessionId = String(payload.sessionId ?? '');
        const buffer = String(payload.buffer ?? '');
        const view = document.applyEdit(sessionId, buffer);
        return { status: 'APPLIED', result: view };
      }

      case 'document.save': {
        const sessionId = String(payload.sessionId ?? '');
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
        const serializer = options.resolveSerializer?.(serializerId) ?? identitySerializer;
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

    getResult(idempotencyKey: string) {
      for (const [key, value] of receipts) {
        if (key.endsWith(`::${idempotencyKey}`)) return value;
      }
      return undefined;
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
          resourceId: envelope?.target?.resourceId,
          result: 'REJECTED',
          errorCode,
          durationMs: elapsed(),
          commandId: out.commandId,
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

      // 幂等：先查收据，避免重复副作用
      if (envelope.idempotencyKey) {
        const cached = receipts.get(`${ctx.actorId}::${envelope.idempotencyKey}`);
        if (cached) {
          audit({
            actorId: ctx.actorId,
            event: 'COMMAND_DEDUPLICATED',
            commandType: envelope.type,
            resourceId: envelope.target?.resourceId,
            result: cached.status,
            durationMs: elapsed(),
            commandId: envelope.commandId,
          });
          return { ...cached, commandId: envelope.commandId, deduplicated: true };
        }
      }

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

      const resourcePath =
        (envelope.payload as Record<string, unknown> | undefined)?.path as string | undefined;
      const authz = permission.authorize({
        actorId: ctx.actorId,
        action: isWrite ? 'write' : 'read',
        resourcePath: resourcePath ?? '',
      });
      audit({
        actorId: ctx.actorId,
        event: 'PERMISSION_DECIDED',
        commandType: envelope.type,
        resourceId: envelope.target?.resourceId,
        result: authz.allowed ? 'ALLOWED' : 'DENIED',
        errorCode: authz.allowed ? undefined : authz.errorCode,
        durationMs: elapsed(),
        commandId: envelope.commandId,
      });
      if (!authz.allowed) {
        return reject(authz.errorCode ?? 'ERR_PERMISSION_DENIED');
      }

      let outcome: HandlerOutcome;
      try {
        outcome = await run(envelope, ctx, resourcePath);
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
        receipts.set(`${ctx.actorId}::${envelope.idempotencyKey}`, finalResult);
      }

      audit({
        actorId: ctx.actorId,
        event: 'COMMAND_COMPLETED',
        commandType: envelope.type,
        resourceId: envelope.target?.resourceId,
        result: outcome.status,
        errorCode: outcome.errorCode,
        durationMs: elapsed(),
        commandId: envelope.commandId,
      });
      return finalResult;
    }
  }
}
