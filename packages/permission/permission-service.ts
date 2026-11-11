/**
 * 权限判定（P0 探针版）。
 * 默认拒绝；范围语法为「项目根 / 目录前缀 / 单文件」三档探测方案（ADR 待定）。
 * 不拥有身份凭据：actorId 必须由 Gateway 绑定后传入（docs/04）。
 */
import type { ErrorCode } from '../contracts/errors.ts';

export type PermissionAction = 'read' | 'write';

export interface AuthRequest {
  actorId: string;
  action: PermissionAction;
  /** 相对项目根的路径；'' 表示整个项目。 */
  resourcePath: string;
}

export interface AuthDecision {
  allowed: boolean;
  errorCode?: ErrorCode;
  reason: string;
  matchedScope?: string;
}

export interface GrantEntry {
  actorId: string;
  action: PermissionAction;
  scope: string;
}

export interface PermissionService {
  authorize(request: AuthRequest): AuthDecision;
  grant(entry: GrantEntry): void;
  revoke(entry: GrantEntry): void;
  grantsOf(actorId: string): readonly GrantEntry[];
}

function normalizeScope(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** scope 为空表示全项目；否则按路径段前缀匹配，避免 `docsx` 误配 `docs`。 */
function scopeMatches(scope: string, resourcePath: string): boolean {
  const s = normalizeScope(scope);
  const p = normalizeScope(resourcePath);
  if (s === '') return true;
  if (p === s) return true;
  return p.startsWith(`${s}/`);
}

export function createPermissionService(
  initial: readonly GrantEntry[] = [],
): PermissionService {
  const entries: GrantEntry[] = [...initial];

  return {
    authorize(request: AuthRequest): AuthDecision {
      if (!request.actorId || request.actorId.trim() === '') {
        return {
          allowed: false,
          errorCode: 'ERR_PERMISSION_DENIED',
          reason: '缺少已绑定的 actorId（不接受客户端自述身份）',
        };
      }
      const hit = entries.find(
        (e) =>
          e.actorId === request.actorId &&
          e.action === request.action &&
          scopeMatches(e.scope, request.resourcePath),
      );
      if (!hit) {
        return {
          allowed: false,
          errorCode: 'ERR_PERMISSION_DENIED',
          reason: `actor ${request.actorId} 无 ${request.action} 权限（范围: ${normalizeScope(request.resourcePath) || '整个项目'}）`,
        };
      }
      return { allowed: true, reason: 'scope 命中', matchedScope: hit.scope };
    },

    grant(entry: GrantEntry) {
      const exists = entries.some(
        (e) =>
          e.actorId === entry.actorId && e.action === entry.action && e.scope === entry.scope,
      );
      if (!exists) entries.push({ ...entry });
    },

    revoke(entry: GrantEntry) {
      const idx = entries.findIndex(
        (e) =>
          e.actorId === entry.actorId && e.action === entry.action && e.scope === entry.scope,
      );
      if (idx >= 0) entries.splice(idx, 1);
    },

    grantsOf(actorId: string) {
      return entries.filter((e) => e.actorId === actorId).map((e) => ({ ...e }));
    },
  };
}
