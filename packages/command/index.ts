/**
 * command 模块唯一公开入口。
 * 职责：统一命令入口、信封校验、幂等收据、授权门禁、审计记录。
 * 不承担格式编码（插件 Serializer）与落盘（storage）。
 */
export {
  createCommandBus,
  type CommandBus,
  type CommandBusOptions,
  type CommandContext,
  type CommandDispatchOutcome,
} from './command-bus.ts';
export { validateEnvelope, type EnvelopeViolation } from './validate.ts';
