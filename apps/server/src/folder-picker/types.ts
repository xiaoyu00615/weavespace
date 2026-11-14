/**
 * 本机目录选择器端口（UX-02B-03 / ADR-021 §3.3）。
 *
 * 这是 **T3** 的唯一载体：只有本机系统对话框（或本机 TTY）返回的路径，才算
 * "用户确实确认过这个目录"。浏览器永远拿不到、也不允许提交路径。
 *
 * 四种结局必须可区分：
 * - `picked`      ：用户点了确定，带绝对路径；
 * - `cancelled`   ：用户主动取消（零副作用）；
 * - `unavailable` ：选择器不能用（无 GUI / 被策略拦截 / 找不到 PowerShell）；
 * - `timeout`     ：对话框没有在时限内返回（视为不可用，零副作用）。
 *
 * 注意：`cancelled` / `unavailable` / `timeout` **都不产生**任何项目配置或授权。
 */

export interface PickedFolder {
  readonly absolutePath: string;
}

export type PickOutcome =
  | { readonly status: 'picked'; readonly folder: PickedFolder }
  | { readonly status: 'cancelled' }
  | { readonly status: 'unavailable'; readonly detail: string }
  | { readonly status: 'timeout' };

export type PickerKind = 'windows-powershell' | 'stdin-prompt' | 'unavailable' | 'fake';

export interface PickOptions {
  /** 上层给的总时限（毫秒）。适配器必须自己兜底，不能挂死。 */
  readonly timeoutMs: number;
}

export interface FolderPicker {
  readonly kind: PickerKind;
  pick(options: PickOptions): Promise<PickOutcome>;
}

/** 没有选择器时的统一实现：结构上永远返回 `unavailable`。 */
export function createUnavailablePicker(detail: string): FolderPicker {
  return {
    kind: 'unavailable',
    async pick() {
      return { status: 'unavailable', detail };
    },
  };
}
