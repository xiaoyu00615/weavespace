/**
 * 工作台可见性（隐藏 / 取消隐藏）的 Host 侧纯逻辑（UX-02C-03-P1）。
 *
 * 职责边界：
 * - **不做 HTTP**（状态码与响应形状在 `server.ts`）；
 * - **不写配置**（持久化在 `store/file-store.ts`，提交点唯一）；
 * - **不删任何磁盘文件**：隐藏只影响"工作台视图"，不是删除。
 *
 * 本模块真正要解决的问题是"同一路径还是不是同一个对象"：
 * 隐藏记录里存了 `rootToken`（项目根身份）与 `identity`（`dev:ino`）。读取时逐个
 * 核验，得到四种状态：
 *
 * - `active`：路径上仍是当初那个对象 → 继续隐藏；
 * - `missing`：路径上已经没有对象 → 记录失效，**不再隐藏任何东西**；
 * - `rebound`：路径上换成了另一个对象 → 记录失效，**绝不隐藏新对象**；
 * - `unverified`：无法核验（Provider 没有身份能力 / IO 异常）→ 仍按隐藏处理。
 *
 * 为什么 `unverified` 是"继续隐藏"而不是"显示出来"：核验失败不是"换了对象"的
 * 证据；在拿不准的时候把用户明确隐藏过的内容重新暴露出来，比暂时保持隐藏更糟。
 * 这一取舍在 `docs/evidence/ux-02c-03-p1/notes.md` 里如实记录。
 */
import type { ErrorCode } from '../../../packages/contracts/errors.ts';
import { validateEntryPath } from '../../../packages/storage/entry-name.ts';
import type { DirEntry } from '../../../packages/storage/index.ts';
import { sameEntryPath } from '../../../packages/storage/entry-name.ts';
import type { ConfigHiddenEntry } from './store/config.ts';

/** 隐藏请求禁止携带的字段：任何一条都意味着客户端在自述身份或路径。 */
export const VISIBILITY_FORBIDDEN_FIELDS = [
  'absolutePath',
  'absolute',
  'rootDir',
  'root',
  'rootToken',
  'canonicalRoot',
  'identity',
  'providerId',
  'actorId',
  'hiddenAt',
  'hidden',
] as const;

export interface VisibilityRequest {
  readonly projectId: string;
  /** 规范化后的项目内相对路径；**空串（项目根）不合法**。 */
  readonly path: string;
}

export type ParseVisibilityResult =
  | { ok: true; request: VisibilityRequest }
  | { ok: false; errorCode: ErrorCode; message: string };

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function parseVisibilityBody(body: Record<string, unknown>): ParseVisibilityResult {
  for (const field of VISIBILITY_FORBIDDEN_FIELDS) {
    if (field in body) {
      return { ok: false, errorCode: 'ERR_COMMAND_INVALID', message: `不接受客户端提供的 ${field}` };
    }
  }
  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  if (projectId === '' || !PROJECT_ID_RE.test(projectId)) {
    return { ok: false, errorCode: 'ERR_COMMAND_INVALID', message: '缺少或非法的 projectId' };
  }
  const path = validateEntryPath(body.path);
  if (!path.ok) {
    // 项目根（空串）也走这里：隐藏一个项目根的语义是"移除项目"，不属于本能力
    return { ok: false, errorCode: path.errorCode, message: path.message };
  }
  return { ok: true, request: { projectId, path: path.value } };
}

/** 同一路径在 Windows 上大小写不敏感；`sameEntryPath` 是唯一的比较口径。 */
export function findHiddenRecord(
  records: readonly ConfigHiddenEntry[],
  path: string,
): ConfigHiddenEntry | undefined {
  return records.find((record) => sameEntryPath(record.path, path));
}

/** `a/b/c` → `['a', 'a/b']`（不含自身）。 */
export function ancestorDirsOf(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < segments.length; i += 1) out.push(segments.slice(0, i).join('/'));
  return out;
}

export type HiddenRecordState = 'active' | 'missing' | 'rebound' | 'unverified';

/** 只有这几种状态才能让"隐藏"真正生效。 */
export function stateHidesEntry(state: HiddenRecordState): boolean {
  return state === 'active' || state === 'unverified';
}

export interface IdentityProbe {
  identityOf?(path: string): Promise<string | null>;
}

/**
 * 核验一条记录当前是否仍然成立。
 *
 * 注意这里**不抛**：调用方要么需要逐条汇总（查询端点），要么需要在遍历目录时
 * 保持稳定行为。真正的"项目不可用"由外层的 G-DISK 门禁处理。
 */
export async function classifyHiddenRecord(
  record: ConfigHiddenEntry,
  probe: IdentityProbe,
): Promise<HiddenRecordState> {
  if (typeof probe.identityOf !== 'function') return 'unverified';
  try {
    const now = await probe.identityOf(record.path);
    if (now === null) return 'missing';
    return now === record.identity ? 'active' : 'rebound';
  } catch {
    return 'unverified';
  }
}

export interface MarkedDirEntry extends DirEntry {
  readonly hidden?: boolean;
  readonly hiddenBy?: string;
}

export interface MarkVisibilityInput {
  /** 本次读取的层路径（根为空串）。 */
  readonly level: string;
  readonly records: readonly ConfigHiddenEntry[];
  readonly probe: IdentityProbe;
  /** true = 保留隐藏条目（并在 DTO 上标记）。 */
  readonly includeHidden: boolean;
}

export interface MarkVisibilityResult {
  /** 已过滤（`includeHidden=false` 时去掉隐藏项）并带标记的条目。 */
  readonly entries: MarkedDirEntry[];
  /** 本层隐藏条目总数（过滤前）。 */
  readonly hiddenCount: number;
  /** 失效记录条数（`missing` + `rebound`）：只用于诊断，不改变记录本身。 */
  readonly stale: number;
}

/**
 * 给一层的条目打上可见性标记，并按 `includeHidden` 过滤。
 *
 * 顺序很重要：**先标记、再统计、最后过滤**。如果先过滤再统计，
 * `hiddenCount` 永远是 0，界面就没有"此目录有 N 个隐藏项"的入口了。
 */
export async function markVisibility(
  entries: readonly DirEntry[],
  input: MarkVisibilityInput,
): Promise<MarkVisibilityResult> {
  const { level, records, probe, includeHidden } = input;

  // 上级隐藏目录：对本层所有条目都生效。**本层自己**也是"条目的上级"，
  // 所以候选集合要从本层开始（`docs` 被隐藏 ⇒ `docs` 这一层的子项都算被上级隐藏）。
  // 每层最多 depth+1 次核验，与条目数量无关。
  let hiddenByAncestor: string | undefined;
  for (const dir of [level, ...ancestorDirsOf(level)]) {
    if (dir === '') continue;
    const record = findHiddenRecord(records, dir);
    if (!record) continue;
    const state = await classifyHiddenRecord(record, probe);
    if (stateHidesEntry(state)) {
      hiddenByAncestor = dir;
      break;
    }
  }

  const marked: MarkedDirEntry[] = [];
  let hiddenCount = 0;
  let stale = 0;

  for (const entry of entries) {
    const path = level === '' ? entry.name : `${level}/${entry.name}`;
    const record = findHiddenRecord(records, path);
    let own = false;
    if (record) {
      const state = await classifyHiddenRecord(record, probe);
      own = stateHidesEntry(state);
      if (state === 'missing' || state === 'rebound') stale += 1;
    }
    if (own) {
      hiddenCount += 1;
      marked.push({ ...entry, hidden: true });
      continue;
    }
    if (hiddenByAncestor) {
      hiddenCount += 1;
      marked.push({ ...entry, hiddenBy: hiddenByAncestor });
      continue;
    }
    marked.push({ ...entry });
  }

  return {
    entries: includeHidden ? marked : marked.filter((entry) => !entry.hidden && !entry.hiddenBy),
    hiddenCount,
    stale,
  };
}
