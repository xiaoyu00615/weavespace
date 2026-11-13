/**
 * 未保存内容的离开页提醒（S11-C）。
 *
 * 边界（必须在文档里说清楚）：
 * - 这是**浏览器原生**的 `beforeunload` 防护，只能提示、不能保证：浏览器崩溃、
 *   被强制结束、或用户选择"离开"时，内存里的草稿仍会丢失；
 * - 本模块**不写任何草稿正文**到 localStorage / sessionStorage，也不接管
 *   `sessionStorage` 里的既有草稿备份（那是用户主动"复制草稿"的产物）；
 * - 只在确实存在未确认内容时挂监听，平时不打扰用户。
 *
 * 拆成纯函数是为了能在 Node 里用一个假 `window` 断言"该拦的时候拦、不该拦时不拦"。
 */
import { hasUnconfirmedEdits } from './workspace-persistence.ts';

/**
 * 只依赖"事件对象的最小形状"，不引用 DOM 的 `BeforeUnloadEvent`：
 * 这样本模块既能跑在浏览器里，也能在 Node 的单进程测试里用一个假对象驱动。
 */
export interface BeforeUnloadLikeEvent {
  preventDefault(): void;
  returnValue?: unknown;
}

export interface BeforeUnloadTarget {
  addEventListener(type: 'beforeunload', listener: (event: BeforeUnloadLikeEvent) => void): void;
  removeEventListener(type: 'beforeunload', listener: (event: BeforeUnloadLikeEvent) => void): void;
}

/** 是否存在"可能丢失"的内容：dirty / 保存中 / 保存结果未知。 */
export function needsLeaveGuard(
  tabs: readonly { dirty: boolean; saving?: boolean; documentState?: string }[],
): boolean {
  return tabs.some((tab) => hasUnconfirmedEdits(tab));
}

/**
 * 安装离开页防护，返回卸载函数。
 *
 * 只设置 `preventDefault()` + `returnValue`：现代浏览器会显示自己的通用文案，
 * 自定义文案已被忽略，因此**不把自定义提示当作安全保证**。
 */
export function installBeforeUnloadGuard(
  target: BeforeUnloadTarget,
  isAtRisk: () => boolean,
): () => void {
  const listener = (event: BeforeUnloadLikeEvent): void => {
    if (!isAtRisk()) return;
    event.preventDefault();
    // 兼容旧实现：部分浏览器需要 returnValue 非空才提示
    event.returnValue = '';
  };
  target.addEventListener('beforeunload', listener);
  return () => {
    target.removeEventListener('beforeunload', listener);
  };
}
