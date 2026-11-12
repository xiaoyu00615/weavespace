/**
 * 权限判定（P0 探针版）。
 * 默认拒绝；范围语法为「项目根 / 目录前缀 / 单文件」三档探测方案（ADR 待定）。
 * scope 与 resourcePath 都会先规范化为「相对项目根、`/` 分隔」的唯一形式再比较；
 * 越界（`..` 越过根）、绝对路径、盘符一律拒绝（P0-1A / S3）。
 * 显式全项目授权**只**承认空字符串；`docs/..` 等"规范化后变空"的写法按配置错误拒绝，
 * 以免被误解为全项目权限（P0-1A / S3 补充）。
 * 不拥有身份凭据：actorId 必须由 Gateway 绑定后传入（docs/04）。
 */
import type { ErrorCode } from '../contracts/errors.ts';

export type PermissionAction = 'read' | 'write';

export interface AuthRequest {
  actorId: string;
  action: PermissionAction;
  /** 相对项目根的路径；'' 表示整个项目。 */
  resourcePath: string;
  /**
   * 资源所属 Provider（S8-03）。缺省视为本地 Provider。
   * 同一相对路径在不同 Provider 下**不是**同一授权目标。
   */
  providerId?: string;
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
  /**
   * 授权绑定的 Provider（S8-03）。缺省 = 本地 Provider。
   * 保守策略：非本地 Provider 只接受**显式匹配**的授权，不会被本地授权继承。
   */
  providerId?: string;
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

/**
 * 解析 scope。
 *
 * 关键区分：「显式全项目」与「规范化后意外变空」不是一回事。
 * - 只有**空字符串**这一种写法代表显式全项目授权；
 * - `docs/..`、`docs/sub/../..`、`.`、`./` 等写法规范化后同样是空串，
 *   但它们表达的是具体路径，不得因此被放大成全项目权限 → 一律按配置错误拒绝。
 *
 * 授权表里的 scope 必须是规范形式，否则立刻失败（fail-closed）。
 */
function requireCanonicalScope(scope: string): string {
  if (scope === '') return ''; // 显式全项目
  const canonical = canonicalizeScopePath(scope);
  if (canonical === null || canonical === '') {
    throw Object.assign(
      new TypeError(
        canonical === ''
          ? `非法 scope（规范化后为空，不得扩大为全项目）: ${scope}`
          : `非法 scope（越界或绝对路径）: ${scope}`,
      ),
      { errorCode: 'ERR_PERMISSION_DENIED' as const },
    );
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

/** Provider 缺省视为本地；不同 Provider 的授权互不继承（S8-03）。 */
function providerKey(providerId: string | undefined): string {
  return providerId ?? 'local';
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
      const requestProvider = providerKey(request.providerId);
      const hit = entries.find(
        (e) =>
          e.actorId === request.actorId &&
          e.action === request.action &&
          providerKey(e.providerId) === requestProvider &&
          scopeMatches(e.scope, resourcePath),
      );
      if (!hit) {
        return {
          allowed: false,
          errorCode: 'ERR_PERMISSION_DENIED',
          reason: `actor ${request.actorId} 无 ${request.action} 权限（范围: ${resourcePath || '整个项目'}，Provider: ${requestProvider}）`,
        };
      }
      return { allowed: true, reason: 'scope 命中', matchedScope: hit.scope };
    },

    grant(entry: GrantEntry) {
      const scope = requireCanonicalScope(entry.scope);
      const provider = providerKey(entry.providerId);
      const exists = entries.some(
        (e) =>
          e.actorId === entry.actorId &&
          e.action === entry.action &&
          e.scope === scope &&
          providerKey(e.providerId) === provider,
      );
      if (!exists) entries.push({ ...entry, scope });
    },

    revoke(entry: GrantEntry) {
      // 与 grant 使用同一判据：只有显式 '' 才指向全项目授权；
      // `docs/..` 这类"规范化后变空"的写法不得撤销全项目授权（否则等于一次误伤式降权）。
      const scope = entry.scope === '' ? '' : canonicalizeScopePath(entry.scope);
      if (scope === null || (scope === '' && entry.scope !== '')) return;
      const provider = providerKey(entry.providerId);
      const idx = entries.findIndex(
        (e) =>
          e.actorId === entry.actorId &&
          e.action === entry.action &&
          e.scope === scope &&
          providerKey(e.providerId) === provider,
      );
      if (idx >= 0) entries.splice(idx, 1);
    },

    grantsOf(actorId: string) {
      return entries.filter((e) => e.actorId === actorId).map((e) => ({ ...e }));
    },
  };
}
