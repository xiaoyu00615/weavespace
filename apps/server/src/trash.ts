/**
 * 单文件可恢复删除的 Host 侧纯逻辑（UX-02C-03-P2-01）。
 *
 * 职责边界（与 `hidden.ts` 同级）：
 * - **不做 HTTP**（状态码与响应形状在 `server.ts`）；
 * - **不碰磁盘**（移动/恢复在 `local-provider.ts`；提交点在 `store/file-store.ts`）；
 * - **不做状态迁移的写操作**，只回答"这条记录现在应该是什么状态"（`reconcileTrash`）。
 *
 * 为什么对账要写成纯函数：它是本阶段唯一敢说"崩溃后能收敛"的地方。若把判断散在
 * 请求处理里，就只能靠 try/catch 声称原子性——那正是任务书禁止的做法。这里的输入
 * 是**磁盘事实**（源/回收区/目标的身份），输出是唯一的目标状态与允许的动作。
 */
import type { ErrorCode } from '../../../packages/contracts/errors.ts';
import { validateEntryPath, isReservedPath } from '../../../packages/storage/entry-name.ts';
import type { ConfigTrashEntry, TrashState } from './store/config.ts';

/** 删除请求禁止携带的字段：任何一条都意味着客户端在自述身份或内部路径。 */
export const TRASH_FORBIDDEN_FIELDS = [
  'absolutePath',
  'absolute',
  'rootDir',
  'root',
  'rootToken',
  'canonicalRoot',
  'identity',
  'trashPath',
  'entryKind',
  'state',
  'providerId',
  'actorId',
  'deletedAt',
] as const;

export interface TrashDeleteRequest {
  readonly projectId: string;
  /** 规范化后的项目内相对路径；空串与保留命名空间都不合法。 */
  readonly path: string;
  /** 客户端生成的事务编号：同时是回收区目录名与幂等键。 */
  readonly opId: string;
}

export interface TrashRestoreRequest {
  readonly projectId: string;
  readonly opId: string;
}

export type ParseTrashResult<T> =
  | { ok: true; request: T }
  | { ok: false; errorCode: ErrorCode; message: string };

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** opId 会成为目录名：只允许小写字母/数字/连字符，长度受限（与 Provider 同一规则）。 */
export const TRASH_OP_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;

function reject(errorCode: ErrorCode, message: string): { ok: false; errorCode: ErrorCode; message: string } {
  return { ok: false, errorCode, message };
}

function forbiddenField(body: Record<string, unknown>): string | undefined {
  return TRASH_FORBIDDEN_FIELDS.find((field) => field in body);
}

/** 解析"移入回收区"请求。所有形状判定零 IO。 */
export function parseTrashDeleteBody(body: Record<string, unknown>): ParseTrashResult<TrashDeleteRequest> {
  const forbidden = forbiddenField(body);
  if (forbidden) return reject('ERR_COMMAND_INVALID', `不接受客户端提供的 ${forbidden}`);

  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  if (projectId === '' || !PROJECT_ID_RE.test(projectId)) {
    return reject('ERR_COMMAND_INVALID', '缺少或非法的 projectId');
  }
  const path = validateEntryPath(body.path);
  if (!path.ok) return reject(path.errorCode, path.message);
  // 内部保留命名空间：回收区不能"回收自己"，也不能借此探测内部目录
  if (isReservedPath(path.value)) {
    return reject('ERR_PATH_RESERVED', '该路径属于工作台内部目录，不参与回收');
  }
  const opId = typeof body.opId === 'string' ? body.opId.trim() : '';
  if (!TRASH_OP_ID_RE.test(opId)) {
    return reject('ERR_COMMAND_INVALID', '缺少或非法的 opId（小写字母/数字/连字符，8–64 位）');
  }
  return { ok: true, request: { projectId, path: path.value, opId } };
}

/** 解析"恢复"请求。目标路径由记录决定，客户端不能指定（否则等于任意位置写入）。 */
export function parseTrashRestoreBody(body: Record<string, unknown>): ParseTrashResult<TrashRestoreRequest> {
  const forbidden = forbiddenField(body);
  if (forbidden) return reject('ERR_COMMAND_INVALID', `不接受客户端提供的 ${forbidden}`);
  if ('targetPath' in body) {
    return reject('ERR_COMMAND_INVALID', '恢复目标由回收记录决定，不接受客户端指定');
  }
  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  if (projectId === '' || !PROJECT_ID_RE.test(projectId)) {
    return reject('ERR_COMMAND_INVALID', '缺少或非法的 projectId');
  }
  const opId = typeof body.opId === 'string' ? body.opId.trim() : '';
  if (!TRASH_OP_ID_RE.test(opId)) return reject('ERR_COMMAND_INVALID', '缺少或非法的 opId');
  return { ok: true, request: { projectId, opId } };
}

/* ================================================================== */
/* 对账：磁盘事实 → 目标状态                                            */
/* ================================================================== */

/**
 * 一次对账看到的**磁盘事实**。
 *
 * 三个"探针失败"字段是刻意的：`null` 表示"这个位置没有对象"，`probeFailed` 表示
 * "我没能看清"。把两者混成一个 `null` 会把"读不出来"误判成"不存在"，
 * 于是回收区里明明有文件却被标成 `missing`——用户会以为文件丢了。
 */
export interface TrashEvidence {
  /** 原路径上是否还有对象；`null` = 没有。 */
  readonly sourceIdentity: string | null;
  readonly sourceProbeFailed: boolean;
  /** 回收区 payload 的对象身份；`null` = 没有。 */
  readonly payloadIdentity: string | null;
  readonly payloadProbeFailed: boolean;
  /** 恢复目标路径上的对象身份；`null` = 没有（仅 `restoring` 有意义）。 */
  readonly targetIdentity?: string | null;
  readonly targetProbeFailed?: boolean;
}

export type ReconcileAction =
  | 'none'
  | 'promote-stored'
  | 'revert-stored'
  | 'promote-restored'
  | 'abort'
  | 'conflict'
  | 'mark-missing';

export interface ReconcileResult {
  readonly state: TrashState;
  readonly action: ReconcileAction;
  /** 供诊断与 UI：一句话说明为什么落到这个状态。 */
  readonly reason: string;
}

const TERMINAL: readonly TrashState[] = ['restored', 'aborted', 'conflicted', 'missing'];

/**
 * 单条记录的对账判定（纯函数，表驱动）。
 *
 * 核心纪律（任务书 §二.2）：
 * - **身份不匹配一律 `conflicted`**，绝不当成 `missing`；
 * - 探针失败一律 `conflicted`（看不清不等于没有）；
 * - 只有"回收区里确实是记录里的那个对象"才允许进入 `stored`；
 * - `restoring` 下"payload 消失 + 目标身份匹配"才允许 `restored`。
 */
export function reconcileTrash(record: ConfigTrashEntry, evidence: TrashEvidence): ReconcileResult {
  if (TERMINAL.includes(record.state)) {
    return { state: record.state, action: 'none', reason: '终态不再判定' };
  }

  const payload = evidence.payloadIdentity;
  const source = evidence.sourceIdentity;

  if (record.state === 'pending') {
    if (evidence.payloadProbeFailed) return { state: 'conflicted', action: 'conflict', reason: '回收区无法核验' };
    if (payload !== null) {
      return payload === record.identity
        ? { state: 'stored', action: 'promote-stored', reason: '移动已完成，补记状态' }
        : { state: 'conflicted', action: 'conflict', reason: '回收区对象身份与记录不符' };
    }
    if (evidence.sourceProbeFailed) return { state: 'conflicted', action: 'conflict', reason: '原位置无法核验' };
    if (source === record.identity) return { state: 'aborted', action: 'abort', reason: '移动未发生，文件仍在原处' };
    if (source !== null) return { state: 'conflicted', action: 'conflict', reason: '原位置对象身份与记录不符' };
    return { state: 'missing', action: 'mark-missing', reason: '源与回收区都没有该对象' };
  }

  if (record.state === 'stored') {
    if (evidence.payloadProbeFailed) return { state: 'conflicted', action: 'conflict', reason: '回收区无法核验' };
    if (payload === record.identity) return { state: 'stored', action: 'none', reason: '正常' };
    if (payload !== null) return { state: 'conflicted', action: 'conflict', reason: '回收区对象被替换' };
    if (evidence.sourceProbeFailed) return { state: 'conflicted', action: 'conflict', reason: '原位置无法核验' };
    if (source === record.identity) {
      // 同一个对象又回到了原路径（rename 保留 inode）：说明恢复其实已经发生
      return { state: 'restored', action: 'promote-restored', reason: '对象已回到原路径，补记恢复' };
    }
    if (source !== null) return { state: 'conflicted', action: 'conflict', reason: '原位置出现另一个对象' };
    return { state: 'missing', action: 'mark-missing', reason: '回收区对象已不存在' };
  }

  // restoring
  if (evidence.payloadProbeFailed || evidence.targetProbeFailed) {
    return { state: 'conflicted', action: 'conflict', reason: '恢复两端无法核验' };
  }
  const target = evidence.targetIdentity ?? null;
  if (payload !== null) {
    if (target === null) return { state: 'stored', action: 'revert-stored', reason: '恢复未发生，可重试' };
    return { state: 'conflicted', action: 'conflict', reason: '回收区与原位置同时存在对象' };
  }
  if (target === record.identity) return { state: 'restored', action: 'promote-restored', reason: '对象已回到原路径' };
  if (target !== null) return { state: 'conflicted', action: 'conflict', reason: '原位置对象身份与记录不符' };
  return { state: 'missing', action: 'mark-missing', reason: '回收区与目标位置都没有该对象' };
}

/* ================================================================== */
/* 对外 DTO 与文案                                                      */
/* ================================================================== */

export interface TrashEntryDto {
  readonly opId: string;
  readonly path: string;
  readonly entryKind: 'file';
  readonly size: number;
  readonly deletedAt: string;
  readonly state: TrashState;
  readonly canRestore: boolean;
  readonly note?: string;
  readonly restoredAt?: string;
}

/** 不可恢复时的原因说明（不给按钮，也不假装可以点）。 */
const STATE_NOTE: Partial<Record<TrashState, string>> = {
  pending: '操作结果未确认，正在核对',
  restoring: '恢复未完成，正在核对',
  conflicted: '回收区或原位置的对象已被外部改动，需要人工核对',
  missing: '回收区里已找不到该文件',
  aborted: '这次删除没有执行，文件仍在原位置',
};

export function toTrashEntryDto(record: ConfigTrashEntry): TrashEntryDto {
  const note = STATE_NOTE[record.state];
  return {
    opId: record.opId,
    path: record.originalPath,
    entryKind: record.entryKind,
    size: record.size,
    deletedAt: record.deletedAt,
    state: record.state,
    canRestore: record.state === 'stored',
    ...(note ? { note } : {}),
    ...(record.restoredAt ? { restoredAt: record.restoredAt } : {}),
  };
}

/**
 * 项目被撤销后，回收记录仍然保留（文件还在 `.weavespace/trash` 里）。
 *
 * 这句话是给 P2-02 的 UI 契约：撤销一个还有回收内容的项目时，必须提示用户
 * "文件不会被删除，但应用内不再提供恢复入口"。**不得**静默丢弃记录（§二.6）。
 */
export const TRASH_ORPHAN_NOTICE =
  '该项目已移出工作台；其回收区文件仍保留在原项目目录的 .weavespace/trash 下，但应用内不再提供恢复入口';
