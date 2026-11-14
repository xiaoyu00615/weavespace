/**
 * 变更意图 `intentId`（UX-02B-03 / ADR-021 §3.1 的 **T2**）。
 *
 * 严格的证明力声明：`intentId` **只**解决"重放与并发"——同一次意图不会被用两次、
 * 同一时刻只有一个 pending。它**不**证明"人类点了按钮"：页面内脚本同样能申请并
 * 使用它。真正的目录确认证据只有 T3（Host 内部选择器 + `inspectProjectRoot`）。
 *
 * 因此本模块的规则是纯粹的新鲜度约束：
 * - 一次性：`claim()` 成功即消费，第二次必然失败；
 * - 120s TTL：过期后不可用（与是否被消费无关）；
 * - 绑定 actor：不同 actor 不能使用别人的意图（不区分"不存在"与"不属于你"）。
 */
import { randomUUID } from 'node:crypto';

export const DEFAULT_INTENT_TTL_MS = 120_000;

export type IntentRejectionReason = 'unknown' | 'expired' | 'consumed' | 'actor-mismatch';

export interface IssuedIntent {
  readonly intentId: string;
  readonly expiresAt: string;
}

export type ClaimResult = { readonly ok: true } | { readonly ok: false; readonly reason: IntentRejectionReason };

export interface IntentRegistry {
  issue(actorId: string): IssuedIntent;
  claim(intentId: string, actorId: string): ClaimResult;
  /** 仅用于诊断/测试：当前保留的意图数量。 */
  size(): number;
}

export interface IntentRegistryOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
}

interface Entry {
  readonly actorId: string;
  readonly expiresAt: number;
  consumed: boolean;
}

export function createIntentRegistry(options: IntentRegistryOptions = {}): IntentRegistry {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_INTENT_TTL_MS;
  const entries = new Map<string, Entry>();

  function prune(at: number): void {
    for (const [id, entry] of entries) {
      // 过期的直接丢弃：之后一律按 unknown 拒绝（不区分"曾经存在但过期"）
      if (entry.expiresAt <= at) entries.delete(id);
    }
  }

  return {
    issue(actorId) {
      const at = now();
      prune(at);
      const intentId = `intent-${randomUUID()}`;
      const expiresAt = at + ttlMs;
      entries.set(intentId, { actorId, expiresAt, consumed: false });
      return { intentId, expiresAt: new Date(expiresAt).toISOString() };
    },

    claim(intentId, actorId) {
      const at = now();
      const entry = entries.get(intentId);
      if (!entry) return { ok: false, reason: 'unknown' };
      if (entry.expiresAt <= at) {
        entries.delete(intentId);
        return { ok: false, reason: 'expired' };
      }
      if (entry.actorId !== actorId) return { ok: false, reason: 'actor-mismatch' };
      if (entry.consumed) return { ok: false, reason: 'consumed' };
      // 同步消费：并发到达的第二个请求不可能同时成功
      entry.consumed = true;
      return { ok: true };
    },

    size() {
      prune(now());
      return entries.size;
    },
  };
}
