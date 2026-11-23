/**
 * 回收区的 Shell 侧编排与视图模型（UX-02C-03-P2-02）。
 *
 * 为什么单独一个纯 TS 模块：`.tsx` 无法被 `node:test` 直接 import（没有 JSX 变换），
 * 所以"哪些状态能恢复、迟到的响应该不该落地、失败时说什么"这类判断必须先脱离 React，
 * 才能被真实断言。组件只负责把这里的输出画出来。
 *
 * 纪律（与创建/改名/隐藏同源）：
 * - **不复制 Host 的授权与会话判定**：本地阻断只是第二道门，权威永远在 Host；
 * - UNKNOWN 只允许**一次只读**核对（`query`），绝不自动重发副作用请求；
 * - 失败不覆盖已有状态：读不到不能等于"回收区是空的"；
 * - 迟到响应（切项目 / 切模式 / 换了工作区）一律丢弃，不写回任何桶。
 */
import type {
  TrashActionOutcome,
  TrashEntryDto,
  TrashEntryState,
  TrashListOutcome,
  TrashOpQueryOutcome,
} from '../client/client-api.ts';
import { TRASH_TERMINAL_STATES } from './types.ts';
import type { ClientMode, TrashProjectState, WorkspaceAction } from './types.ts';
import { entryNameOf } from '../../../../packages/storage/entry-name.ts';

/* ================================================================== */
/* 一、状态 → 展示                                                      */
/* ================================================================== */

export type TrashTone = 'ok' | 'pending' | 'warn' | 'muted';

export interface TrashStateView {
  readonly label: string;
  readonly tone: TrashTone;
  /** 这一行是否给出「恢复」按钮：只有 `stored` 才是 true。 */
  readonly canRestore: boolean;
  readonly hint: string;
}

/**
 * 七个状态的展示语义（与 Host `STATE_NOTE` 同义，不新增状态）。
 *
 * `pending` / `restoring` 用 `pending` 而不是 `warn`：它们是"还在核对"，
 * 既不是成功也不是失败。把它们染成错误色，用户会去重试——而那正是禁止的动作。
 */
export const TRASH_STATE_VIEW: Record<TrashEntryState, TrashStateView> = {
  pending: {
    label: '结果核对中',
    tone: 'pending',
    canRestore: false,
    hint: '这次操作的结果尚未确认，正在与磁盘核对；请稍后刷新，不要重复操作。',
  },
  stored: {
    label: '可恢复',
    tone: 'ok',
    canRestore: true,
    hint: '文件在回收区里，可以恢复到原位置。',
  },
  restoring: {
    label: '恢复核对中',
    tone: 'pending',
    canRestore: false,
    hint: '恢复尚未确认完成，正在核对；请稍后刷新，不要重复操作。',
  },
  restored: {
    label: '已恢复',
    tone: 'muted',
    canRestore: false,
    hint: '文件已恢复到原位置。',
  },
  aborted: {
    label: '未成功移入',
    tone: 'warn',
    canRestore: false,
    hint: '这次删除没有执行，文件仍在原位置。',
  },
  conflicted: {
    label: '需要人工核对',
    tone: 'warn',
    canRestore: false,
    hint: '回收区或原位置的对象已被外部改动，无法自动恢复；请人工核对项目目录。',
  },
  missing: {
    label: '文件已丢失',
    tone: 'warn',
    canRestore: false,
    hint: '回收区里已找不到这个文件，请人工核对项目目录（本版本没有永久删除）。',
  },
};

/** 一条记录在界面上的全部字段（面板只渲染这些）。 */
export interface TrashRowView {
  readonly opId: string;
  readonly name: string;
  readonly originalPath: string;
  readonly deletedAtLabel: string;
  readonly sizeLabel: string;
  readonly stateLabel: string;
  readonly tone: TrashTone;
  readonly canRestore: boolean;
  readonly hint: string;
  /** 是否有恢复请求正在这个 opId 上跑（据此禁用按钮，不退化成"点了没反应"）。 */
  readonly busy: boolean;
  /** 结果未确认（UNKNOWN 或刷新失败）：核对完成前禁止再次操作。 */
  readonly unconfirmed: boolean;
}

/** 字节数：只做展示，不参与任何安全判定。 */
export function formatTrashSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '—';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * `deletedAt`（严格 ISO，UTC）→ 本地 `YYYY-MM-DD HH:mm`。
 *
 * 解析失败不抛也不编造时间：返回 `—`，让"这条记录有问题"在界面上可见。
 */
export function formatTrashTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 一条记录的展示。
 *
 * `busy`（请求在途）与 `unconfirmed`（结果未确认）都要**占用恢复按钮**：
 * 前者是"还没回来"，后者是"回来了但结论不可用"，两者都不构成"可以再试一次"。
 * 但界面用语不同——把"待核对"写成"恢复中"会让用户以为再等一会就自动好了。
 */
export function trashRowView(
  entry: TrashEntryDto,
  busy: boolean,
  unconfirmed = false,
): TrashRowView {
  const view = TRASH_STATE_VIEW[entry.state];
  const stateLabel = unconfirmed ? '待核对' : busy ? '恢复中' : view.label;
  const tone: TrashTone = unconfirmed ? 'warn' : busy ? 'pending' : view.tone;
  const hint = unconfirmed
    ? '上一次操作的结果还没确认，核对完成前不能再次恢复（不会自动重发）。'
    : busy
      ? '正在把文件恢复到原位置，结果确认前不要重复操作。'
      : (entry.note ?? view.hint);
  return {
    opId: entry.opId,
    name: entryNameOf(entry.path),
    originalPath: entry.path,
    deletedAtLabel: formatTrashTime(entry.deletedAt),
    sizeLabel: formatTrashSize(entry.size),
    stateLabel,
    tone,
    // Host 的 canRestore 与状态两者都要满足：客户端不单方面放宽
    canRestore: entry.canRestore && view.canRestore && !busy && !unconfirmed,
    hint,
    busy,
    unconfirmed,
  };
}

/* ================================================================== */
/* 二、右键菜单：移入回收区                                              */
/* ================================================================== */

export interface TrashMenuInput {
  /** 右键目标的种类（与 `TreeTarget.origin` 对齐）。 */
  readonly origin: 'file' | 'folder' | 'link' | 'project-root' | 'toolbar' | 'blank';
  readonly entryKind?: 'file' | 'directory' | 'link';
  /** 该项目是否支持真实结构变更（live + multi + READY）。 */
  readonly supported: boolean;
}

export interface TrashMenuState {
  /** `false` = 当前上下文完全不适用的项不渲染（空白区/工具栏没有对象）。 */
  readonly visible: boolean;
  readonly disabled: boolean;
  readonly hint?: string;
}

/**
 * 「移入回收区」什么时候可点。
 *
 * 不支持的对象**显示但禁用并给出原因**，而不是藏起来——用户看到菜单里没有这一项，
 * 只会以为功能不存在，然后去找别的方式删文件。
 */
export function trashDeleteCommandState(input: TrashMenuInput): TrashMenuState {
  if (input.origin === 'toolbar' || input.origin === 'blank') {
    return { visible: false, disabled: true };
  }
  if (input.origin === 'link' || input.entryKind === 'link') {
    return { visible: true, disabled: true, hint: '链接不能移入回收区（不会跟随链接）' };
  }
  if (input.origin === 'project-root') {
    return { visible: true, disabled: true, hint: '项目根不能移入回收区' };
  }
  if (input.origin === 'folder' || input.entryKind === 'directory') {
    return { visible: true, disabled: true, hint: '目录暂不支持（本阶段只处理普通文件）' };
  }
  if (!input.supported) {
    return { visible: true, disabled: true, hint: '当前模式/项目不支持真实回收' };
  }
  return { visible: true, disabled: false };
}

/* ================================================================== */
/* 三、文案                                                             */
/* ================================================================== */

/** 回收区满：必须明确"先恢复"，因为本版本**没有**永久删除可以腾空间。 */
export const TRASH_FULL_MESSAGE = '回收区已满，请先恢复已有文件。';
/** 恢复目标冲突：产品规则 7 —— 绝不覆盖。 */
export const TRASH_TARGET_EXISTS_MESSAGE = '原位置已有同名文件，请先改名或移走它。';
export const TRASH_UNKNOWN_MESSAGE =
  '结果未确认：已按操作编号核对回收记录，请稍后在回收区查看（不会自动重发操作）。';
/**
 * 核对之后仍然拿不到明确结论（或列表刷新失败）。
 *
 * 这条比 `TRASH_UNKNOWN_MESSAGE` 更进一步：不只是"还没确认"，而是**这一轮已经结束、
 * 仍然不能确认**。因此该记录必须保持禁用，直到某次成功的列表读取给出终态。
 */
export const TRASH_UNCONFIRMED_HOLD_MESSAGE =
  '结果仍未确认：该记录在核对完成前不能再次操作（不会自动重发）。请稍后刷新回收区。';
export const TRASH_BUSY_MESSAGE = '已有回收操作正在进行，请稍后再试';

/**
 * 错误码 → 用户能看懂的一句话。
 *
 * 不是"把 code 翻译一遍"：每一条都要说明**下一步做什么**，否则用户只能重试，
 * 而重试在有副作用路径上恰恰是最危险的动作。
 */
export function trashErrorMessage(errorCode: string | null, fallback = '操作失败'): string {
  switch (errorCode) {
    case 'ERR_TRASH_FULL':
      return TRASH_FULL_MESSAGE;
    case 'ERR_ENTRY_EXISTS':
      return TRASH_TARGET_EXISTS_MESSAGE;
    case 'ERR_TRASH_KIND_UNSUPPORTED':
      return '只有普通文件可以移入回收区（目录与链接暂不支持）。';
    case 'ERR_TRASH_STATE_CONFLICT':
      return '该回收记录当前不可恢复，需要人工核对。';
    case 'ERR_TRASH_UNAVAILABLE':
      return '回收区当前不可用（内部结构被占用或已损坏），请人工核对项目目录。';
    case 'ERR_TRASH_RECORD_NOT_FOUND':
      return '回收记录已不存在，请刷新回收区。';
    case 'ERR_OP_ID_CONFLICT':
      return '该操作编号已用于另一次回收，请重新发起。';
    case 'ERR_PATH_RESERVED':
      return '工作台内部目录不参与回收。';
    case 'ERR_STRUCTURE_SESSION_BUSY':
      return '该文件正在被打开或保存，请先关闭相关标签再操作。';
    case 'ERR_PERMISSION_DENIED':
      return '没有权限操作该文件或该回收记录。';
    case 'ERR_PROJECT_UNAVAILABLE':
    case 'ERR_PROJECT_NOT_FOUND':
      return '项目当前不可用，请稍后重试。';
    case 'ERR_COMMAND_UNSUPPORTED':
      return '当前运行模式不支持回收区。';
    case 'ERR_STORAGE_IO':
      return '读取磁盘失败，请稍后重试。';
    default:
      return fallback;
  }
}

const TRASH_BLOCKER_TEXT: Record<string, string> = {
  ACTIVE_VIEWS: '仍在标签中打开',
  DIRTY: '有未保存的修改',
  SAVING: '正在保存',
  OUTCOME_UNKNOWN: '保存结果尚未确认',
  CONFLICT: '存在冲突',
  IN_FLIGHT_DISK_OPS: '有正在进行的磁盘操作',
};

/**
 * 本地阻断原因 → 一句可执行的话。
 *
 * 这些代码来自 `localStructureBlockers`（与改名/移动同一套判定）：
 * 回收和恢复都会移动文件，因此它们必须共用同一条"别动正在用的文件"规则。
 */
export function trashBlockerMessage(path: string, codes: readonly string[]): string {
  const parts = codes.map((code) => TRASH_BLOCKER_TEXT[code] ?? code).join('、');
  return `无法操作「${path}」：${parts}。请先关闭相关标签并处理草稿（本次操作没有任何磁盘副作用）。`;
}

export function trashRemovedNotice(name: string): string {
  return `已把「${name}」移入回收区（未永久删除，可在回收区恢复）`;
}

export function trashRestoredNotice(path: string): string {
  return `已把「${path}」恢复到原位置`;
}

/* ================================================================== */
/* 四、面板视图模型                                                     */
/* ================================================================== */

export type TrashPanelView =
  | { readonly kind: 'unsupported'; readonly message: string }
  | { readonly kind: 'loading'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'list';
      readonly count: number;
      readonly rows: readonly TrashRowView[];
      /** 列表可用但本轮刷新失败：显示一条降级提示，不把列表清空。 */
      readonly degraded: string | null;
    };

export const TRASH_DEMO_MESSAGE =
  '演示模式没有回收区：回收区只在已连接的真实项目中可用（切到「实时」并选择项目后可查看）。';

export interface TrashPanelInput {
  readonly mode: ClientMode;
  readonly workspaceMode: 'legacy' | 'multi';
  readonly projectId: string | null;
  readonly state: TrashProjectState | undefined;
}

/** 面板该画什么：**不**返回"空列表"来掩盖"还没读到"。 */
export function trashPanelView(input: TrashPanelInput): TrashPanelView {
  if (input.mode !== 'live' || input.workspaceMode !== 'multi') {
    return { kind: 'unsupported', message: TRASH_DEMO_MESSAGE };
  }
  if (!input.projectId) {
    return { kind: 'unsupported', message: '请先添加并选择一个项目，回收区按项目隔离。' };
  }
  const state = input.state;
  if (!state || (!state.loaded && state.loading)) {
    return { kind: 'loading', message: '正在读取回收区…' };
  }
  if (!state.loaded) {
    return {
      kind: 'error',
      message: state.errorMessage ?? '读取回收区失败，请重试。',
    };
  }
  return {
    kind: 'list',
    count: state.count,
    rows: state.entries.map((entry) =>
      trashRowView(
        entry,
        state.busyOpIds.includes(entry.opId),
        state.unconfirmedOpIds.includes(entry.opId),
      ),
    ),
    degraded: state.errorMessage,
  };
}

/**
 * 自动读取的触发键（UX-02C-03-P2-02-R1-06）。
 *
 * 为什么不是把四个字段都塞进 `useEffect` 的依赖数组：那正是"漏一个字段"最容易发生的地方
 * （本轮缺陷就是漏了 `workspaceKey`）。把"该不该读、读哪个工作区的哪个项目"压成一个
 * 字符串，依赖只剩一个，语义也就只有一种解释：
 *
 * - 模式不对 / 没有项目 → `null`（不读）；
 * - 换工作区（即使项目 id 相同）→ 键变了 → 必须重新读；
 * - 切项目 → 键变了 → 重新读。
 */
export function trashLoadKey(input: {
  readonly mode: ClientMode;
  readonly workspaceMode: 'legacy' | 'multi';
  readonly workspaceKey: string | null;
  readonly projectId: string | null;
}): string | null {
  if (input.mode !== 'live' || input.workspaceMode !== 'multi') return null;
  if (!input.projectId) return null;
  return `${input.workspaceKey ?? ''}\u0000${input.projectId}`;
}

/**
 * 导航上的数量徽标。
 *
 * `null` = 还不知道（没读过 / 读失败）：此时**不显示数字**。
 * 显示 0 会让用户以为"回收区是空的"，从而不再去检查真正需要人工核对的记录。
 */
export function trashBadgeCount(
  state: TrashProjectState | undefined,
  mode: ClientMode,
  projectId: string | null,
): number | null {
  if (mode !== 'live' || !projectId || !state || !state.loaded) return null;
  return state.count;
}

/* ================================================================== */
/* 五、编排：读取 / 回收 / 恢复                                          */
/* ================================================================== */

export interface TrashPort {
  list(projectId: string): Promise<TrashListOutcome>;
  remove(projectId: string, path: string, opId: string): Promise<TrashActionOutcome>;
  restore(projectId: string, opId: string): Promise<TrashActionOutcome>;
  query(projectId: string, opId: string): Promise<TrashOpQueryOutcome>;
}

export interface TrashIdentity {
  readonly mode: ClientMode;
  readonly workspaceMode: 'legacy' | 'multi';
  readonly workspaceKey: string | null;
  readonly activeProjectId: string | null;
  /** 工作区加载代次：切模式 / 重连 / 换工作区后旧请求立即作废。 */
  readonly epoch: number;
}

/**
 * 发送副作用请求**之前**的本机闸门（UX-02C-03-P2-02-R1-05）。
 *
 * 只在响应回来后核对归属是不够的：用户完全可能"打开确认框 → 切到 B → 点确认"，
 * 那时 A 的 POST 已经发出去，磁盘已经动了。因此发送前必须先问一次。
 *
 * 两种失败要分开：
 * - `stale`：归属变了（切项目/切模式/换工作区）。静默丢弃，不提示、不刷新、不发请求；
 * - `blocked`：归属没变，但项目此刻不可用。要给用户一句能看懂的话。
 */
export type TrashPreflight =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: 'stale' }
  | { readonly ok: false; readonly kind: 'blocked'; readonly message: string };

export interface TrashHost {
  readonly port: TrashPort;
  identity(): TrashIdentity;
  dispatch(action: WorkspaceAction): void;
  newOpId(): string;
  notify(message: string): void;
  /** 该项目是否支持真实结构变更（与菜单判定同源）。 */
  supported(projectId: string): boolean;
  /** 发送前的身份/就绪检查：live + multi + READY + activeProjectId 一致。 */
  preflight(projectId: string): TrashPreflight;
  /** Shell 侧本地阻断（活动标签 / 草稿 / 保存中 / 结果未知）。 */
  blockers(projectId: string, path: string): readonly string[];
  /** 回收成功 / 结果未知：只刷新原文件的父层，不递归、不碰其他项目。 */
  refreshAfterRemoval(projectId: string, path: string): Promise<void>;
  /** 恢复成功 / 结果未知：刷新原路径的父层。 */
  refreshAfterRestore(projectId: string, path: string): Promise<void>;
}

export type TrashActionResult =
  | { readonly status: 'applied'; readonly opId: string }
  | { readonly status: 'unknown'; readonly opId: string; readonly message: string }
  | { readonly status: 'blocked'; readonly reasons: readonly string[] }
  | { readonly status: 'rejected'; readonly message: string }
  /** 结果属于别的工作区/项目：已丢弃，不再提示"成功"或"失败"。 */
  | { readonly status: 'stale' };

/** 一次列表读取的结论（`load` 的返回值，供"操作后必须确认"使用）。 */
export type TrashLoadResult =
  | { readonly status: 'applied'; readonly entries: readonly TrashEntryDto[] }
  /** 读取失败：列表还是旧的，"能不能再操作"没有新依据。 */
  | { readonly status: 'failed' }
  /** 读取期间归属已变：结果不落地。 */
  | { readonly status: 'stale' };

export interface TrashController {
  /** 读取列表；并发调用共享同一次请求（单飞）。 */
  load(projectId: string): Promise<TrashLoadResult>;
  remove(projectId: string, path: string): Promise<TrashActionResult>;
  restore(projectId: string, entry: TrashEntryDto): Promise<TrashActionResult>;
}

/**
 * 操作后"这条记录算不算已经有结论"。
 *
 * 返回 `true` 才允许解除"待核对"：
 * - 列表读取成功；
 * - 且该 `opId` 不在列表里（没东西可点），或记录已落到终态。
 *
 * `stored` / `pending` / `restoring` 都不算：那正是"可能还没做完"的三种形态。
 */
function confirmedByList(
  loaded: TrashLoadResult,
  opId: string,
  terminal: ReadonlySet<string>,
): boolean {
  if (loaded.status !== 'applied') return false;
  const record = loaded.entries.find((entry) => entry.opId === opId);
  return record === undefined || terminal.has(record.state);
}

/**
 * 编排器。
 *
 * 单飞按"项目 + 目标"分键：同一行被连点两次只发一个请求；不同行互不阻塞
 * （按 opId 分键而不是一个全局锁，否则用户恢复第二个文件时会被第一个卡住）。
 * 因此状态层也必须能同时记住多个在途 opId——见 `TrashProjectState.busyOpIds`。
 */
export function createTrashController(host: TrashHost): TrashController {
  const loadSeq = new Map<string, number>();
  const inflightLoad = new Map<string, Promise<TrashLoadResult>>();
  const inflightAction = new Map<string, Promise<TrashActionResult>>();

  const capture = (): TrashIdentity => host.identity();

  /**
   * 归属核对：任何一个维度变了，这次响应就不属于当前界面。
   *
   * 注意 `activeProjectId` 必须仍然等于发起时的项目：用户切到 B 之后，
   * A 的迟到列表绝不能写进 A 的桶再被"以后某一刻"看到——那正是脏数据的来源。
   *
   * 这里**不**比较"第几次读取"：同一项目的旧读取由 `loadSeq` 单独作废，
   * 两种机制混在一起会让"刚完成的操作"被自己后续的刷新判成过期。
   */
  const owned = (projectId: string, snapshot: TrashIdentity): boolean => {
    const now = host.identity();
    return (
      now.mode === 'live' &&
      now.mode === snapshot.mode &&
      now.workspaceMode === snapshot.workspaceMode &&
      now.workspaceKey === snapshot.workspaceKey &&
      now.epoch === snapshot.epoch &&
      now.activeProjectId === projectId &&
      snapshot.activeProjectId === projectId
    );
  };

  /** 真正发一次列表请求；结果落地前先核对归属与序号。 */
  const runLoad = async (projectId: string): Promise<TrashLoadResult> => {
    const seq = (loadSeq.get(projectId) ?? 0) + 1;
    loadSeq.set(projectId, seq);
    const snapshot = capture();
    host.dispatch({ type: 'TRASH_LOAD_BEGIN', projectId });
    let outcome: TrashListOutcome;
    try {
      outcome = await host.port.list(projectId);
    } catch {
      outcome = { status: 'REJECTED', errorCode: 'ERR_STORAGE_IO', message: '读取回收区失败，请稍后重试' };
    }
    if (loadSeq.get(projectId) !== seq) return { status: 'stale' };
    if (!owned(projectId, snapshot)) return { status: 'stale' };
    if (outcome.status === 'APPLIED') {
      host.dispatch({ type: 'TRASH_LOADED', projectId, entries: outcome.entries, count: outcome.count });
      return { status: 'applied', entries: outcome.entries };
    }
    host.dispatch({
      type: 'TRASH_LOAD_ERROR',
      projectId,
      errorCode: outcome.errorCode ?? 'ERR_STORAGE_IO',
      message: trashErrorMessage(outcome.errorCode ?? null, outcome.message ?? '读取回收区失败'),
    });
    return { status: 'failed' };
  };

  /** 单飞读取：并发调用共享同一个请求（用户连点刷新不会打两次）。 */
  const load = (projectId: string): Promise<TrashLoadResult> => {
    if (!projectId) return Promise.resolve({ status: 'failed' });
    const existing = inflightLoad.get(projectId);
    if (existing) return existing;
    let task: Promise<TrashLoadResult>;
    task = runLoad(projectId).finally(() => {
      if (inflightLoad.get(projectId) === task) inflightLoad.delete(projectId);
    });
    inflightLoad.set(projectId, task);
    return task;
  };

  /**
   * 操作之后的**确认性读取**：先等掉在途的那次，再发一个新的。
   *
   * 在途那次可能是在 POST 之前发出的，它看到的是操作前的状态；拿它当"操作后的事实"
   * 就是典型的读写竞态。等它结束再发一次，代价是一次本地 GET，换的是不会再出现
   * "刚恢复完按钮又亮着"。
   */
  const freshLoad = async (projectId: string): Promise<TrashLoadResult> => {
    const existing = inflightLoad.get(projectId);
    if (existing) {
      try {
        await existing;
      } catch {
        // 在途那次失败与否都不影响下面这次新读取
      }
    }
    return load(projectId);
  };

  /** 只读核对：**恰好一次**，不重发副作用。 */
  const verifyOnce = async (projectId: string, opId: string): Promise<void> => {
    try {
      await host.port.query(projectId, opId);
    } catch {
      // 核对失败也不重发：调用方仍会刷新列表，用户看到的是记录的真实状态
    }
  };

  const run = async (
    key: string,
    action: () => Promise<TrashActionResult>,
  ): Promise<TrashActionResult> => {
    const existing = inflightAction.get(key);
    if (existing) return existing;
    let task: Promise<TrashActionResult>;
    task = action().finally(() => {
      if (inflightAction.get(key) === task) inflightAction.delete(key);
    });
    inflightAction.set(key, task);
    return task;
  };

  const refreshParent = async (refresh: () => Promise<void>): Promise<void> => {
    try {
      await refresh();
    } catch {
      // 刷新目录失败不影响"操作是否成功"的结论：列表与文件树都可以手动刷新
    }
  };

  interface SettleNotice {
    readonly applied: string;
    readonly appliedUnconfirmed: string;
    readonly rejectedFallback: string;
  }

  /**
   * 结算一次副作用操作。
   *
   * 纪律（R1-01 / R1-04）：
   * 1. **三个分支都先核对归属**；归属失效 → `stale`，不提示、不刷新旧项目；
   * 2. APPLIED 与 UNKNOWN 都必须等一次**确认性列表读取**才有资格解除"待核对"；
   * 3. 读取失败 / 记录仍在非终态 → 保持禁用（`hold`），绝不把旧的 `stored` 重新开放；
   * 4. 绝不因为结算失败而重发副作用请求。
   */
  const settle = async (
    projectId: string,
    opId: string,
    outcome: TrashActionOutcome,
    stillOwned: () => boolean,
    after: () => Promise<void>,
    notice: SettleNotice,
    terminal: ReadonlySet<string>,
  ): Promise<{ result: TrashActionResult; hold: boolean }> => {
    // R1-04：先核对归属，**再**决定要不要提示/刷新（REJECTED 同样适用）
    if (!stillOwned()) return { result: { status: 'stale' }, hold: false };

    if (outcome.status === 'REJECTED') {
      // 明确拒绝 = 零副作用：可以安全地解除在途/待核对标记
      const message = trashErrorMessage(outcome.errorCode, outcome.message || notice.rejectedFallback);
      host.notify(message);
      return { result: { status: 'rejected', message }, hold: false };
    }

    if (outcome.status === 'APPLIED') {
      await refreshParent(after);
      if (!stillOwned()) return { result: { status: 'stale' }, hold: false };
    } else {
      // UNKNOWN：先做一次只读核对，再刷新列表（绝不重发副作用）
      await verifyOnce(projectId, outcome.opId);
      if (!stillOwned()) return { result: { status: 'stale' }, hold: false };
      await refreshParent(after);
      if (!stillOwned()) return { result: { status: 'stale' }, hold: false };
    }

    const loaded = await freshLoad(projectId);
    if (!stillOwned()) return { result: { status: 'stale' }, hold: false };
    const confirmed = confirmedByList(loaded, opId, terminal);

    if (outcome.status === 'APPLIED') {
      if (confirmed) {
        host.notify(notice.applied);
        return { result: { status: 'applied', opId }, hold: false };
      }
      // Host 已经确认成功，但列表没能确认到终态：不宣布"可以再操作一次"
      host.notify(notice.appliedUnconfirmed);
      return { result: { status: 'applied', opId }, hold: true };
    }

    if (confirmed) {
      host.notify(TRASH_UNKNOWN_MESSAGE);
      return { result: { status: 'unknown', opId, message: TRASH_UNKNOWN_MESSAGE }, hold: false };
    }
    host.notify(TRASH_UNCONFIRMED_HOLD_MESSAGE);
    return {
      result: { status: 'unknown', opId, message: TRASH_UNCONFIRMED_HOLD_MESSAGE },
      hold: true,
    };
  };

  const preflightFailure = (projectId: string): TrashActionResult | null => {
    const gate = host.preflight(projectId);
    if (gate.ok) return null;
    if (gate.kind === 'stale') return { status: 'stale' };
    return { status: 'rejected', message: gate.message };
  };

  const remove = async (projectId: string, path: string): Promise<TrashActionResult> => {
    const blockedByGate = preflightFailure(projectId);
    if (blockedByGate) return blockedByGate;
    if (!host.supported(projectId)) {
      return { status: 'rejected', message: '当前模式/项目不支持真实回收' };
    }
    const reasons = host.blockers(projectId, path);
    if (reasons.length > 0) return { status: 'blocked', reasons };

    return run(`${projectId}\u0000${path}`, async () => {
      const snapshot = capture();
      const opId = host.newOpId();
      let outcome: TrashActionOutcome;
      try {
        outcome = await host.port.remove(projectId, path, opId);
      } catch {
        outcome = {
          status: 'UNKNOWN',
          projectId,
          opId,
          message: '网络中断或请求超时，结果未确认',
          httpStatus: 0,
        };
      }
      const name = entryNameOf(path);
      const settled = await settle(
        projectId,
        opId,
        outcome,
        () => owned(projectId, snapshot),
        () => host.refreshAfterRemoval(projectId, path),
        {
          applied: trashRemovedNotice(name),
          appliedUnconfirmed: `已把「${name}」移入回收区，但回收区列表没能刷新；请稍后手动刷新核对（不会自动重发）。`,
          rejectedFallback: '无法移入回收区',
        },
        // 回收成功的终态是 `stored`；其余终态说明这次回收没有成功，记录本身也不需要再动
        REMOVE_TERMINAL_STATES,
      );
      return settled.result;
    });
  };

  const restore = async (projectId: string, entry: TrashEntryDto): Promise<TrashActionResult> => {
    if (!TRASH_STATE_VIEW[entry.state].canRestore) {
      return { status: 'rejected', message: TRASH_STATE_VIEW[entry.state].hint };
    }
    if (entry.state !== 'stored') {
      return { status: 'rejected', message: '该记录当前不可恢复，需要人工核对。' };
    }
    // R1-05：恢复同样要过身份闸——不能只看 entry.state
    const blockedByGate = preflightFailure(projectId);
    if (blockedByGate) return blockedByGate;
    if (!host.supported(projectId)) {
      return { status: 'rejected', message: '当前模式/项目不支持真实恢复' };
    }
    const reasons = host.blockers(projectId, entry.path);
    if (reasons.length > 0) return { status: 'blocked', reasons };

    return run(`restore\u0000${projectId}\u0000${entry.opId}`, async () => {
      const snapshot = capture();
      host.dispatch({ type: 'TRASH_BUSY', projectId, opId: entry.opId, busy: true });
      try {
        let outcome: TrashActionOutcome;
        try {
          outcome = await host.port.restore(projectId, entry.opId);
        } catch {
          outcome = {
            status: 'UNKNOWN',
            projectId,
            opId: entry.opId,
            message: '网络中断或请求超时，结果未确认',
            httpStatus: 0,
          };
        }
        const settled = await settle(
          projectId,
          entry.opId,
          outcome,
          () => owned(projectId, snapshot),
          () => host.refreshAfterRestore(projectId, entry.path),
          {
            applied: trashRestoredNotice(entry.path),
            appliedUnconfirmed: `已把「${entry.path}」恢复到原位置，但回收区列表没能刷新；记录暂不可再次操作，请稍后手动刷新核对。`,
            rejectedFallback: '无法恢复该文件',
          },
          TRASH_TERMINAL_STATES,
        );
        if (settled.hold) {
          // 结论不可用（UNKNOWN / 刷新失败 / 记录仍在非终态）：转为"待核对"，仍然禁用
          host.dispatch({
            type: 'TRASH_UNCONFIRMED',
            projectId,
            opId: entry.opId,
            pending: true,
          });
        }
        return settled.result;
      } finally {
        // 只解除**这一条**的在途标记：同项目里别的恢复不受影响
        host.dispatch({ type: 'TRASH_BUSY', projectId, opId: entry.opId, busy: false });
      }
    });
  };

  return { load, remove, restore };
}

/** 回收成功 = 记录进入 `stored`；其余终态说明没成功，但也都不必再拦。 */
const REMOVE_TERMINAL_STATES: ReadonlySet<string> = new Set([
  'stored',
  ...TRASH_TERMINAL_STATES,
]);
