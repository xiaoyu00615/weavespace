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
 * 解析本页面实例 id。
 *
 * 返回 `null` 表示"没有可用的页面身份"（无 sessionStorage / 连新 id 都抢不到锁）：
 * 调用方应当**省略**该字段，Host 退回旧语义，绝不伪造一个每请求都不同的假 id。
 */
export async function resolvePageInstanceId(ports: PageInstancePorts): Promise<string | null> {
  const { storage, locks } = ports;
  if (!storage) return null;
  const newId = ports.newId ?? generateInstanceId;
  const delay = ports.delay ?? defaultDelay;
  const retryDelayMs = ports.retryDelayMs ?? 80;

  let candidate = normalizeInstanceId(storage.getItem(PAGE_INSTANCE_KEY));
  const reuseExisting = candidate !== null;
  if (candidate === null) candidate = newId();

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
        return null;
      }
    }
  }

  try {
    storage.setItem(PAGE_INSTANCE_KEY, candidate);
  } catch {
    // 写入失败（隐私模式/超限）：本次仍可用，只是刷新后可能换新身份
  }
  return candidate;
}

/** `crypto.randomUUID` 优先；退化路径必须仍然满足 Host 的形状校验。 */
export function generateInstanceId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
