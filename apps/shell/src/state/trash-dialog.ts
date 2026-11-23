/**
 * 「移入回收区」二段确认的状态机（UX-02C-03-P2-02）。
 *
 * 单独抽出来的理由与 `trash.ts` 相同：模态是 `.tsx`，`node:test` import 不了。
 * 把"什么时候给确认按钮、点取消会不会发请求、提交后落到哪一屏"做成纯函数，
 * 才能真的断言"取消不产生任何磁盘修改"。
 */
import { entryNameOf } from '../../../../packages/storage/entry-name.ts';
import type { TrashActionResult } from './trash.ts';

export type TrashDeletePhase = 'checking' | 'ready' | 'blocked' | 'confirming' | 'result';

export interface TrashDeleteDialogState {
  readonly projectId: string;
  readonly path: string;
  readonly name: string;
  readonly phase: TrashDeletePhase;
  readonly reasons: readonly string[];
  readonly result: { readonly tone: 'ok' | 'warn' | 'error'; readonly body: string } | null;
}

/**
 * 打开确认框。
 *
 * 前置检查是**同步**的（本地标签 + 项目就绪）：这里不弹请求，因此"点开确认框"
 * 本身零磁盘、零网络。被阻断时直接进入 `blocked`，不给确认按钮。
 */
export function openTrashDelete(input: {
  readonly projectId: string;
  readonly path: string;
  readonly reasons: readonly string[];
}): TrashDeleteDialogState {
  return {
    projectId: input.projectId,
    path: input.path,
    name: entryNameOf(input.path),
    phase: input.reasons.length > 0 ? 'blocked' : 'ready',
    reasons: input.reasons,
    result: null,
  };
}

/**
 * 提交结果 → 下一屏。
 *
 * `stale` 表示结果不属于当前工作区（用户已经切走）：直接关掉，不宣布成功也不宣布失败。
 */
export function applyTrashDeleteResult(
  dialog: TrashDeleteDialogState,
  outcome: TrashActionResult,
): TrashDeleteDialogState | null {
  if (outcome.status === 'stale') return null;
  if (outcome.status === 'blocked') {
    return { ...dialog, phase: 'blocked', reasons: outcome.reasons, result: null };
  }
  if (outcome.status === 'applied') {
    return {
      ...dialog,
      phase: 'result',
      result: { tone: 'ok', body: `「${dialog.name}」已移入回收区，可在回收区恢复。` },
    };
  }
  if (outcome.status === 'unknown') {
    return {
      ...dialog,
      phase: 'result',
      result: {
        tone: 'warn',
        body: '结果未确认：已按操作编号核对并刷新回收区，请到回收区查看真实状态（不会自动重发）。',
      },
    };
  }
  return { ...dialog, phase: 'result', result: { tone: 'error', body: outcome.message } };
}

/**
 * 真正提交。
 *
 * 两道闸：`phase` 不是 `ready`（例如已经 `confirming` / `blocked` / 已取消）时
 * **一次请求都不发**；调用方另有 ref 级单飞，两处都不依赖渲染时序。
 */
export async function submitTrashDelete(
  dialog: TrashDeleteDialogState | null,
  remove: (projectId: string, path: string) => Promise<TrashActionResult>,
): Promise<{ next: TrashDeleteDialogState | null; outcome: TrashActionResult | null }> {
  if (!dialog || dialog.phase !== 'ready') return { next: dialog, outcome: null };
  const outcome = await remove(dialog.projectId, dialog.path);
  return { next: applyTrashDeleteResult(dialog, outcome), outcome };
}
