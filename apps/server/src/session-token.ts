/**
 * 会话令牌（UX-02B-03 / ADR-021 §3.1 的 **T1**）。
 *
 * 严格的证明力声明：令牌**只**证明"这个请求来自本机 Host 服务的页面"，
 * 是 CSRF / 跨源投递的防线。它**不**表达、也不能表达任何目录授权：
 * 拿到令牌的页面依然不能指定路径，只有 T3（Host 内选择器）能产生目录确认证据。
 *
 * 因此这里刻意做成"纯随机、无载荷"：
 * - 不带任何身份/权限声明，避免被误读成 capability；
 * - 只在内存里保存哈希，泄露一个令牌文件也不会反推出其它令牌；
 * - 数量上限 + FIFO 淘汰，防止无限增长（页面每次打开都会取一个）。
 *
 * 令牌通过 `GET /api/session-token` 发放（同源页面可读，跨源 JS 读不到响应体），
 * 变更类请求用 `X-WS-Token` 头携带。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface SessionTokenStore {
  issue(): string;
  /** 缺少 / 空串 / 未知 / 已淘汰 → false。绝不抛错（令牌不是可信输入）。 */
  validate(token: string | undefined | null): boolean;
  /** 仅诊断/测试：当前保留的令牌数量。 */
  size(): number;
}

export interface SessionTokenOptions {
  /** 保留的最大令牌数（FIFO 淘汰）；默认 64。 */
  readonly maxTokens?: number;
  /** 仅测试注入：令牌字节数（默认 32 → 43 字符 base64url）。 */
  readonly byteLength?: number;
}

const digestOf = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

export function createSessionTokenStore(options: SessionTokenOptions = {}): SessionTokenStore {
  const maxTokens = options.maxTokens ?? 64;
  const byteLength = options.byteLength ?? 32;
  /** 只存哈希：即便发生内存转储，也无法还原出可用令牌。 */
  const digests: Buffer[] = [];

  return {
    issue() {
      const token = randomBytes(byteLength).toString('base64url');
      digests.push(digestOf(token));
      while (digests.length > maxTokens) digests.shift();
      return token;
    },

    validate(token) {
      if (typeof token !== 'string' || token === '') return false;
      // 定长摘要 + timingSafeEqual：比较耗时与内容无关
      const candidate = digestOf(token);
      let matched = false;
      for (const known of digests) {
        if (known.length === candidate.length && timingSafeEqual(known, candidate)) matched = true;
      }
      return matched;
    },

    size() {
      return digests.length;
    },
  };
}
