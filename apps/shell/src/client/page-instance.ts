/**
 * 页面实例身份（UX-02C-02-R1 / R1.1）。
 *
 * 只回答一个问题："这次请求来自哪一个浏览器页面？"——Host 用它识别"同一个页面
 * 刷新后重新打开同一资源"，从而只回收**该页面自己**遗留的 View。
 *
 * 三条硬约束：
 * 1. 同一页面刷新必须保留原身份（否则每次刷新都换新身份，旧 View 又是孤儿）；
 * 2. 新标签页 / 新窗口必须拿到独立身份；
 * 3. `sessionStorage` 会被 `window.open`（同源）与 Chrome「复制标签页」**整体复制**，
 *    所以只会"读一个字符串"是不够的——必须能发现"另一个还活着的页面正用着同一个
 *    id"，并把其中一个换掉。
 *
 * 还有一条同样是硬约束（R1.2）：**只有确实持久化的 id 才算身份**。读不出来或
 * 写不进去时必须返回 `null`（省略该字段），不能拿一个刷新后必然变化的 id 去
 * 冒充"稳定的页面身份"。
 *
 * 实现：`sessionStorage` 存候选 id + Web Locks 独占该 id 对应的锁。
 * - 同一个页面刷新：旧上下文销毁时锁自动释放，新上下文重新拿到同一把锁 → id 稳定；
 * - opener 复制 / 复制标签页：原页面仍活着并持有该锁 → 新页面拿不到 → 换新 id；
 * - 拿到锁后把 id 写回 sessionStorage，后续刷新继续用它。
 *
 * 这里**不涉及任何授权**：Host 从不凭这个 id 放行操作，它只是归属线索。
 */

export const PAGE_INSTANCE_KEY = 'weavespace.clientInstanceId';
export const PAGE_INSTANCE_SHAPE = /^[A-Za-z0-9._-]{8,64}$/;

/** 最小存储端口（sessionStorage 的同构子集）。 */
export interface InstanceStoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * 独占锁端口。`tryAcquire` 必须在"已被其它页面持有"时返回 `false`，
 * 并且**成功时保持持有直到页面销毁**（实现见 `client-api.ts`）。
 */
export interface InstanceLockPort {
  tryAcquire(name: string): Promise<boolean>;
}

export interface PageInstancePorts {
  readonly storage: InstanceStoragePort | null;
  /** 不支持 Web Locks 的环境传 `null`：退化为"只信 sessionStorage"。 */
  readonly locks: InstanceLockPort | null;
  /** 仅测试注入：生成新 id。 */
  readonly newId?: () => string;
  /** 仅测试注入：锁竞争失败后等多久再确认一次（默认 80ms，用于跨过卸载窗口）。 */
  readonly retryDelayMs?: number;
  /** 仅测试注入：等待实现（测试里可以立即 resolve）。 */
  readonly delay?: (ms: number) => Promise<void>;
}

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** 形状不合法（被外部写入垃圾）一律当没有，重新生成。 */
export function normalizeInstanceId(raw: string | null | undefined): string | null {
  return typeof raw === 'string' && PAGE_INSTANCE_SHAPE.test(raw) ? raw : null;
}

/**
 * 拿不到**可持久身份**的原因（R1.2，只用于诊断，不面向用户展示）。
 *
 * 语义唯一的判定口：`id === null` ⇔ `degraded !== null`。给出原因只是为了让
 * "为什么这次没有页面身份"可被测试与日志确认，而不是让调用方去猜。
 */
export type PageInstanceDegraded =
  | 'no-storage'
  | 'storage-read-failed'
  | 'storage-write-failed'
  | 'lock-contended';

export interface PageInstanceResolution {
  /** 可持久化的页面身份；`null` = 本次没有可用身份（调用方必须省略该字段）。 */
  readonly id: string | null;
  readonly degraded: PageInstanceDegraded | null;
}

/**
 * 解析本页面实例身份（R1.2：把"存储异常"收敛成明确的"没有身份"）。
 *
 * 返回 `id: null` 表示"没有可用的页面身份"（无 sessionStorage / 读不出来 /
 * 新 id 写不进去 / 连新 id 都抢不到锁）：调用方应当**省略**该字段，Host 退回
 * 旧语义，绝不伪造一个每请求都不同的假 id。
 *
 * ## 为什么"写不进去"也必须返回 null（R1.2 复审缺陷）
 *
 * 这个身份唯一的用途是让 Host 认出"同一个页面刷新后重开了同一资源"，从而只回收
 * **该页面自己**上一轮遗留的 View。它的价值完全建立在"刷新后仍然是同一个 id"上。
 * 一个生在内存里、没写进 sessionStorage 的 id 在这件事上等于零：刷新后必然换成
 * 新值，上一轮的 View 依旧没人关。把它当身份返回，会让上层以为页面身份稳定，
 * 从而把"回收失败"归因成别的东西。所以：**没持久化 = 没有身份**。
 *
 * 唯一的例外是"旧 id 本来就在存储里"（读得到就说明它已经持久化）：此时那次
 * 回写只是重复写入，失败不影响可持续性，身份照旧可用。
 */
export async function resolvePageInstance(
  ports: PageInstancePorts,
): Promise<PageInstanceResolution> {
  const { storage, locks } = ports;
  if (!storage) return { id: null, degraded: 'no-storage' };
  const newId = ports.newId ?? generateInstanceId;
  const delay = ports.delay ?? defaultDelay;
  const retryDelayMs = ports.retryDelayMs ?? 80;

  let stored: string | null;
  try {
    stored = normalizeInstanceId(storage.getItem(PAGE_INSTANCE_KEY));
  } catch {
    // 读不出来 = 不知道上次是谁。此刻生成的任何 id 都无法与上一轮对齐，
    // 只会让调用方误以为"刷新后还能认出自己"。
    return { id: null, degraded: 'storage-read-failed' };
  }

  const reuseExisting = stored !== null;
  let candidate = stored ?? newId();

  if (locks) {
    let acquired = await locks.tryAcquire(candidate);
    if (!acquired && reuseExisting) {
      // 可能是"刷新时的卸载窗口"：旧上下文还没完全释放锁。稍等再确认一次，
      // 只有仍然抢不到才判定为"另一个活着的页面在用同一个 id"。
      await delay(retryDelayMs);
      acquired = await locks.tryAcquire(candidate);
    }
    if (!acquired) {
      // opener 复制 / 复制标签页：原页面仍在工作，我们必须换一个独立身份。
      candidate = newId();
      const second = await locks.tryAcquire(candidate);
      if (!second) {
        // 连新 id 都被占（几乎不可能）：宁可不带身份，也不与别人共用
        return { id: null, degraded: 'lock-contended' };
      }
    }
  }

  // 候选是否**已经**在存储里（读得到 ⇒ 已持久化）。换过候选就不算了。
  const alreadyPersisted = reuseExisting && candidate === stored;
  try {
    storage.setItem(PAGE_INSTANCE_KEY, candidate);
  } catch {
    // 新 id 写不进去：刷新后必然变化 → 不能当页面身份返回。
    if (!alreadyPersisted) return { id: null, degraded: 'storage-write-failed' };
    // 旧 id 已在存储里，这次只是重复写入，失败不影响身份可持续性。
  }
  return { id: candidate, degraded: null };
}

/** 便捷包装：只要 id（`null` 的语义见 `resolvePageInstance`）。 */
export async function resolvePageInstanceId(ports: PageInstancePorts): Promise<string | null> {
  const resolved = await resolvePageInstance(ports);
  return resolved.id;
}

/** `crypto.randomUUID` 优先；退化路径必须仍然满足 Host 的形状校验。 */
export function generateInstanceId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
