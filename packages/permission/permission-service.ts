/**
 * 权限判定（P0 探针版）。
 * 默认拒绝；范围语法为「项目根 / 目录前缀 / 单文件」三档探测方案（ADR 待定）。
 * scope 与 resourcePath 都会先规范化为「相对项目根、`/` 分隔」的唯一形式再比较；
 * 越界（`..` 越过根）、绝对路径、盘符一律拒绝（P0-1A / S3）。
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

/**
 * 把调用方给的路径规范化成「相对项目根、以 `/` 分隔」的唯一形式。
 *
 * 必须与 storage 的解析语义对齐：storage 会把 `docs/../secret.md` 解析成根下的
 * `secret.md`，因此授权层绝不能按字面前缀判定，必须先做同构规范化再比较。
 *
 * 返回 null 表示非法路径（越过项目根 / 绝对路径 / 盘符 / NUL）。调用方必须按
 * 「默认拒绝」处理，**不得**回退成「整个项目」，否则等于放大授权。
 */
function canonicalizeScopePath(path: string): string | null {
  if (typeof path !== 'string' || path.includes('\0')) return null;
  const unified = path.replace(/\\/g, '/');
  if (unified.startsWith('/')) return null;
  if (/^[A-Za-z]:/.test(unified)) return null;
  const segments: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null; // 越过项目根
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/** 授权表里的 scope 必须是规范形式，否则立刻失败（fail-closed）。 */
function requireCanonicalScope(scope: string): string {
  const canonical = canonicalizeScopePath(scope);
  if (canonical === null) {
    throw Object.assign(new TypeError(`非法 scope（越界或绝对路径）: ${scope}`), {
      errorCode: 'ERR_PERMISSION_DENIED' as const,
    });
  }
  return canonical;
}

/**
 * scope 为空表示全项目；否则按路径段前缀匹配，避免 `docsx` 误配 `docs`。
 * 两个入参都必须已是 `canonicalizeScopePath` 的结果。
 */
function scopeMatches(canonicalScope: string, canonicalPath: string): boolean {
  if (canonicalScope === '') return true;
  if (canonicalPath === canonicalScope) return true;
  return canonicalPath.startsWith(`${canonicalScope}/`);
}

export function createPermissionService(
  initial: readonly GrantEntry[] = [],
): PermissionService {
  const entries: GrantEntry[] = initial.map((entry) => ({
    ...entry,
    scope: requireCanonicalScope(entry.scope),
  }));

  return {
    authorize(request: AuthRequest): AuthDecision {
      if (!request.actorId || request.actorId.trim() === '') {
        return {
          allowed: false,
          errorCode: 'ERR_PERMISSION_DENIED',
          reason: '缺少已绑定的 actorId（不接受客户端自述身份）',
        };
      }
      // 路径必须先规范化；非法路径直接拒绝，绝不退化成「整个项目」
      const resourcePath = canonicalizeScopePath(request.resourcePath);
      if (resourcePath === null) {
        return {
          allowed: false,
          errorCode: 'ERR_PERMISSION_DENIED',
          reason: `资源路径非法（越界或绝对路径），默认拒绝: ${String(request.resourcePath)}`,
        };
      }
      const hit = entries.find(
        (e) =>
          e.actorId === request.actorId &&
          e.action === request.action &&
          scopeMatches(e.scope, resourcePath),
      );
      if (!hit) {
        return {
          allowed: false,
          errorCode: 'ERR_PERMISSION_DENIED',
          reason: `actor ${request.actorId} 无 ${request.action} 权限（范围: ${resourcePath || '整个项目'}）`,
        };
      }
      return { allowed: true, reason: 'scope 命中', matchedScope: hit.scope };
    },

    grant(entry: GrantEntry) {
      const scope = requireCanonicalScope(entry.scope);
      const exists = entries.some(
        (e) => e.actorId === entry.actorId && e.action === entry.action && e.scope === scope,
      );
      if (!exists) entries.push({ ...entry, scope });
    },

    revoke(entry: GrantEntry) {
      // 等价写法（`./docs/` 与 `docs`）必须撤销同一条授权
      const scope = canonicalizeScopePath(entry.scope);
      if (scope === null) return; // 非法 scope 不可能存在于授权表
      const idx = entries.findIndex(
        (e) => e.actorId === entry.actorId && e.action === entry.action && e.scope === scope,
      );
      if (idx >= 0) entries.splice(idx, 1);
    },

    grantsOf(actorId: string) {
      return entries.filter((e) => e.actorId === actorId).map((e) => ({ ...e }));
    },
  };
}
