/**
 * 保存流程的状态收敛（S9-B / F02）。
 *
 * 为什么单独抽出来：保存有多条结束路径（同步失败、网络异常、COMMITTED、CONFLICT、
 * FAILED、UNKNOWN），任何一条漏掉都会让 UI 停在「保存中」，或把未确认的结果说成成功。
 * 这里把判定写成**纯函数**，React 层只负责 dispatch，测试可以直接覆盖每个分支。
 *
 * 三条硬约束：
 * - 草稿没有成功同步到 Core 时**不发保存请求**（否则会把旧内容写盘）；
 * - 网络/传输异常一律报 `UNKNOWN`，绝不报 `COMMITTED`；
 * - 只有服务端明确 `COMMITTED` 且 Core 也不再 dirty 时才清除脏标记。
 */
import type { DocumentSnapshot, SaveOutcome } from './client-api.ts';
import type { EditFlushResult } from './edit-queue.ts';

export type SaveUiStatus = 'COMMITTED' | 'CONFLICT' | 'FAILED' | 'UNKNOWN';

export interface SaveFlowInput {
  /** 把编辑器当前草稿同步到 Core，并报告是否成功。 */
  sync: () => Promise<EditFlushResult>;
  /** 发起条件保存；传输层异常应当 reject。 */
  commit: () => Promise<SaveOutcome>;
  /** 调用时的编辑器缓冲，用于确认「最终草稿」确实已同步。 */
  buffer: string;
}

export interface SaveFlowResult {
  status: SaveUiStatus;
  /** 是否真的向服务端发起过保存（同步失败时为 false）。 */
  attempted: boolean;
  errorCode: string | null;
  dirty: boolean;
  documentState: string;
  baseVersion: string | null;
  revision: number | null;
  contentVersion: string | null;
  document?: DocumentSnapshot;
  notice: string;
}

function errorCodeOf(err: unknown): string | null {
  const code = (err as { errorCode?: unknown } | undefined)?.errorCode;
  return typeof code === 'string' ? code : null;
}

export async function runSaveFlow(input: SaveFlowInput): Promise<SaveFlowResult> {
  // ---- 1. 先确认草稿真的进了 Core ----
  let sync: EditFlushResult;
  try {
    sync = await input.sync();
  } catch (err) {
    sync = { ok: false, error: err, lastSynced: null };
  }

  if (!sync.ok || sync.lastSynced !== input.buffer) {
    const errorCode = errorCodeOf(sync.ok ? null : sync.error) ?? 'ERR_EDIT_SYNC_FAILED';
    return {
      status: 'FAILED',
      attempted: false,
      errorCode,
      dirty: true,
      documentState: 'EDITING_DIRTY',
      baseVersion: null,
      revision: null,
      contentVersion: null,
      notice: `编辑未能同步到 Core（${errorCode}），已阻止保存；草稿仍然保留`,
    };
  }

  // ---- 2. 发起条件保存（传输层异常 → 结果未知） ----
  let outcome: SaveOutcome;
  try {
    outcome = await input.commit();
  } catch (err) {
    const errorCode = errorCodeOf(err) ?? 'ERR_OUTCOME_UNKNOWN';
    return {
      status: 'UNKNOWN',
      attempted: true,
      errorCode,
      dirty: true,
      documentState: 'OUTCOME_UNKNOWN',
      baseVersion: null,
      revision: null,
      contentVersion: null,
      notice: '保存请求未完成（网络异常）：结果未确认，请勿重复保存，草稿已保留',
    };
  }

  const doc = outcome.document;

  // ---- 3. 按服务端结论收敛 ----
  if (outcome.status === 'COMMITTED') {
    // 保存期间若 Core 仍 dirty（有更新的编辑），不得清标记
    const stillDirty = doc?.dirty ?? false;
    return {
      status: 'COMMITTED',
      attempted: true,
      errorCode: null,
      dirty: stillDirty,
      documentState: doc?.documentState ?? 'CLEAN',
      baseVersion: outcome.contentVersion ?? doc?.baseVersion ?? null,
      revision: doc?.revision ?? null,
      contentVersion: outcome.contentVersion ?? null,
      document: doc,
      notice: stillDirty
        ? '已写入磁盘，但保存期间又有新编辑（仍未保存）'
        : '已保存到磁盘',
    };
  }

  if (outcome.status === 'CONFLICT') {
    return {
      status: 'CONFLICT',
      attempted: true,
      errorCode: outcome.errorCode ?? 'ERR_DOCUMENT_VERSION_CONFLICT',
      dirty: true,
      documentState: doc?.documentState ?? 'CONFLICT',
      baseVersion: null,
      revision: doc?.revision ?? null,
      contentVersion: null,
      document: doc,
      notice: '版本冲突：磁盘已被外部修改，编辑内容已保留，未覆盖磁盘',
    };
  }

  if (outcome.status === 'UNKNOWN') {
    return {
      status: 'UNKNOWN',
      attempted: true,
      errorCode: outcome.errorCode ?? 'ERR_OUTCOME_UNKNOWN',
      dirty: true,
      documentState: doc?.documentState ?? 'OUTCOME_UNKNOWN',
      baseVersion: null,
      revision: doc?.revision ?? null,
      contentVersion: null,
      document: doc,
      notice: '保存结果未确认（UNKNOWN）：不要重复保存，请人工核对磁盘',
    };
  }

  return {
    status: 'FAILED',
    attempted: true,
    errorCode: outcome.errorCode ?? 'ERR_SAVE_FAILED',
    dirty: true,
    documentState: doc?.documentState ?? 'FAILED',
    baseVersion: null,
    revision: doc?.revision ?? null,
    contentVersion: null,
    document: doc,
    notice: `保存失败：${outcome.errorCode ?? '未知错误'}（编辑内容已保留）`,
  };
}
