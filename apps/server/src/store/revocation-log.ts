/**
 * 撤销墓碑日志 `revocations.jsonl`（UX-02B-02 / ADR-022 §3.1）。
 *
 * 它是**撤销的权威**：配置里的 `revoked[]` 可能滞后（step 3 失败），备份可能更旧，
 * 只有这条 append-only 的链能证明"某次撤销是否真的发生过"。
 *
 * 格式（第一行是固定的日志头）：
 * ```jsonc
 * {"type":"header","version":2,"hash":"<HEAD_HASH>"}
 * {"seq":1,"projectId":"a","at":"...","opId":"op-1","prevHash":"<HEAD_HASH>","hash":"<line hash>"}
 * ```
 * `hash = sha256(seq|projectId|at|opId|prevHash)`；`prevHash` 必须等于上一行的 `hash`。
 * 任何一行不可解析、序号不连续、`prevHash` 不匹配，都视为**断裂**：
 * 断裂点之前的完整前缀仍可用（更保守的撤销集合），其后一律视为不可证。
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { LOG_FILE, StoreIoError, type StoreIo } from './io.ts';
import { PROJECT_ID_RE } from './config.ts';

/** 日志头哈希：链的起点常量（不依赖任何时钟或内容，便于复算）。 */
export const LOG_HEAD_HASH = createHash('sha256').update('weavespace/revocations/v2/header').digest('hex');

export interface RevocationEntry {
  readonly seq: number;
  readonly projectId: string;
  readonly at: string;
  readonly opId: string;
  readonly prevHash: string;
  readonly hash: string;
}

export type LogStatus = 'ok' | 'missing' | 'broken';

export interface LogReadResult {
  readonly status: LogStatus;
  /** 只在链完整的前缀内取值；断裂后不再收录。 */
  readonly entries: readonly RevocationEntry[];
  readonly lastSeq: number;
  readonly lastHash: string;
  readonly hasHeader: boolean;
  readonly reason?: string;
}

export function lineHash(input: {
  seq: number;
  projectId: string;
  at: string;
  opId: string;
  prevHash: string;
}): string {
  return createHash('sha256')
    .update(`${input.seq}|${input.projectId}|${input.at}|${input.opId}|${input.prevHash}`)
    .digest('hex');
}

export function headerLine(): string {
  return `${JSON.stringify({ type: 'header', version: 2, hash: LOG_HEAD_HASH })}\n`;
}

export function revocationLine(entry: Omit<RevocationEntry, 'hash'>): string {
  return `${JSON.stringify({ ...entry, hash: lineHash(entry) })}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const EMPTY: Omit<LogReadResult, 'status'> = {
  entries: [],
  lastSeq: 0,
  lastHash: LOG_HEAD_HASH,
  hasHeader: false,
};

/**
 * 解析日志。`text === undefined` 表示文件不存在（与"存在但为空"不同：
 * 后者在 `commitSeq > 0` 时属于内容丢失，不能当成"没有撤销"）。
 */
export function readLog(text: string | undefined): LogReadResult {
  if (text === undefined) return { status: 'missing', ...EMPTY };
  const broken = (reason: string, partial: RevocationEntry[], hasHeader: boolean): LogReadResult => ({
    status: 'broken',
    entries: partial,
    lastSeq: partial.length > 0 ? partial[partial.length - 1].seq : 0,
    lastHash: partial.length > 0 ? partial[partial.length - 1].hash : LOG_HEAD_HASH,
    hasHeader,
    reason,
  });

  const rawLines = text.split('\n');
  // 末尾换行会产生一个空串：它是正常结尾，不是"半行"
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();

  if (rawLines.length === 0) {
    // 空文件：没有日志头，撤销集合为空但**未建立**；由调用方决定是否补头
    return { status: 'ok', ...EMPTY };
  }

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(rawLines[0]) as Record<string, unknown>;
  } catch {
    return broken('日志头不可解析', [], false);
  }
  if (!isRecord(header) || header.type !== 'header' || header.hash !== LOG_HEAD_HASH) {
    return broken('日志头缺失或不可信', [], false);
  }

  const entries: RevocationEntry[] = [];
  let prevHash = LOG_HEAD_HASH;
  let prevSeq = 0;

  for (let index = 1; index < rawLines.length; index += 1) {
    const line = rawLines[index];
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return broken(`第 ${index + 1} 行不可解析（截断或半行）`, entries, true);
    }
    if (!isRecord(parsed)) return broken(`第 ${index + 1} 行不是对象`, entries, true);
    const { seq, projectId, at, opId, prevHash: linePrev, hash } = parsed;
    // 序号是**全局提交序号**：添加/重命名也会消耗 seq，因此墓碑行之间允许跳号，
    // 但必须严格递增（否则就是乱序/重复，链不可信）。
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= prevSeq) {
      return broken(`第 ${index + 1} 行序号未严格递增（前一行 ${prevSeq}）`, entries, true);
    }
    if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) {
      return broken(`第 ${index + 1} 行 projectId 非法`, entries, true);
    }
    if (typeof at !== 'string' || at === '' || typeof opId !== 'string' || opId === '') {
      return broken(`第 ${index + 1} 行字段缺失`, entries, true);
    }
    if (linePrev !== prevHash) {
      return broken(`第 ${index + 1} 行 prevHash 不匹配`, entries, true);
    }
    const expectedHash = lineHash({ seq, projectId, at, opId, prevHash: linePrev as string });
    if (hash !== expectedHash) {
      return broken(`第 ${index + 1} 行 hash 不匹配`, entries, true);
    }
    const entry: RevocationEntry = { seq, projectId, at, opId, prevHash: linePrev as string, hash: expectedHash };
    entries.push(entry);
    prevHash = expectedHash;
    prevSeq = seq;
  }

  return {
    status: 'ok',
    entries,
    lastSeq: entries.length > 0 ? entries[entries.length - 1].seq : 0,
    lastHash: prevHash,
    hasHeader: true,
  };
}

export interface AppendInput {
  readonly dir: string;
  readonly seq: number;
  readonly projectId: string;
  readonly opId: string;
  readonly at: string;
  readonly prevHash: string;
  readonly needsHeader: boolean;
}

/**
 * 追加一行墓碑并 fsync。
 *
 * **调用方必须把"本函数正常返回"当作撤销生效**；抛错时不得自行判定为失败，
 * 而要用 `readLog` 核对尾部是否已出现本次 `opId`（ADR-022 §3.1.1）。
 */
export function appendRevocation(io: StoreIo, input: AppendInput): RevocationEntry {
  const path = join(input.dir, LOG_FILE);
  if (input.needsHeader) {
    io.appendText(path, headerLine());
    io.fsyncPath(path);
  }
  const entry = revocationLine({
    seq: input.seq,
    projectId: input.projectId,
    at: input.at,
    opId: input.opId,
    prevHash: input.prevHash,
  });
  try {
    io.appendText(path, entry);
    io.fsyncPath(path);
  } catch (err) {
    if (err instanceof StoreIoError) throw err;
    throw new StoreIoError('append-log', undefined);
  }
  const record = JSON.parse(entry.trim()) as RevocationEntry;
  return record;
}
