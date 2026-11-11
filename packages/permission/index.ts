/**
 * permission 模块唯一公开入口。
 * 职责：actor × action × 资源范围 的授权判定，默认拒绝。
 * 不拥有身份凭据，不做资源存在性校验。
 */
export {
  createPermissionService,
  type AuthDecision,
  type AuthRequest,
  type GrantEntry,
  type PermissionAction,
  type PermissionService,
} from './permission-service.ts';
