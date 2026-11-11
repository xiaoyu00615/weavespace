/**
 * CommandEnvelope 运行时校验（P0 探针版，与 contracts/schemas/command-envelope.schema.json 对齐）。
 * 不做 JSON Schema 全量实现；只覆盖 P0 命令用到的必填项与类型约束。
 */
import type { CommandEnvelope } from '../contracts/types.ts';

export interface EnvelopeViolation {
  field: string;
  reason: string;
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export function validateEnvelope(envelope: CommandEnvelope | undefined): EnvelopeViolation[] {
  const violations: EnvelopeViolation[] = [];
  if (!envelope || typeof envelope !== 'object') {
    return [{ field: 'envelope', reason: '命令信封必须为对象' }];
  }
  const { commandId, type, payload, idempotencyKey, expectedVersion } = envelope;

  if (typeof commandId !== 'string' || commandId.trim() === '') {
    violations.push({ field: 'commandId', reason: '必填非空字符串' });
  } else if (!ID_PATTERN.test(commandId)) {
    violations.push({ field: 'commandId', reason: '只允许 [A-Za-z0-9._:-]' });
  }
  if (typeof type !== 'string' || type.length < 3) {
    violations.push({ field: 'type', reason: '必填且长度 >= 3' });
  }
  if (payload === null || typeof payload !== 'object') {
    violations.push({ field: 'payload', reason: '必填对象' });
  }
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey === '')) {
    violations.push({ field: 'idempotencyKey', reason: '提供时必须为非空字符串' });
  }
  if (expectedVersion !== undefined && (typeof expectedVersion !== 'string' || expectedVersion === '')) {
    violations.push({ field: 'expectedVersion', reason: '提供时必须为非空字符串' });
  }
  return violations;
}
