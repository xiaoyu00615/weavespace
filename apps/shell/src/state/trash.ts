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
  /** 是否有一条恢复请求正在这个 opId 上跑（据此禁用按钮，不退化成"点了没反应"）。 */
  readonly busy: boolean;
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

export function trashRowView(entry: TrashEntryDto, busy: boolean): TrashRowView {
  const view = TRASH_STATE_VIEW[entry.state];
  return {
    opId: entry.opId,
    name: entryNameOf(entry.path),
    originalPath: entry.path,
    deletedAtLabel: formatTrashTime(entry.deletedAt),
    sizeLabel: formatTrashSize(entry.size),
    // 恢复请求在途时不能继续写「可恢复」：那会和「恢复中…」按钮自相矛盾，
    // 也不是任何结论（既没成功也没失败）。
    stateLabel: busy ? '恢复中' : view.label,
    tone: busy ? 'pending' : view.tone,
    // Host 的 canRestore 与状态两者都要满足：客户端不单方面放宽
    canRestore: entry.canRestore && view.canRestore && !busy,
    hint: busy ? '正在把文件恢复到原位置，结果确认前不要重复操作。' : (entry.note ?? view.hint),
    busy,
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
  const busy = state.busyOpId;
  return {
    kind: 'list',
    count: state.count,
    rows: state.entries.map((entry) => trashRowView(entry, busy !== null && busy === entry.opId)),
    degraded: state.errorMessage,
  };
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
  readonly workspaceKey: string | null;
  readonly activeProjectId: string | null;
  /** 工作区加载代次：切模式 / 重连后旧请求立即作废。 */
  readonly epoch: number;
}

export interface TrashHost {
  readonly port: TrashPort;
  identity(): TrashIdentity;
  dispatch(action: WorkspaceAction): void;
  newOpId(): string;
  notify(message: string): void;
  /** 该项目是否支持真实结构变更（与菜单判定同源）。 */
  supported(projectId: string): boolean;
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

export interface TrashController {
  load(projectId: string): Promise<void>;
  remove(projectId: string, path: string): Promise<TrashActionResult>;
  restore(projectId: string, entry: TrashEntryDto): Promise<TrashActionResult>;
}

/**
 * 编排器。
 *
 * 单飞按"项目 + 目标"分键：同一行被连点两次只发一个请求；不同行互不阻塞
 * （按 opId 分键而不是一个全局锁，否则用户恢复第二个文件时会被第一个卡住）。
 */
export function createTrashController(host: TrashHost): TrashController {
  const loadSeq = new Map<string, number>();
  const loading = new Set<string>();
  const inflight = new Map<string, Promise<TrashActionResult>>();

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
      now.workspaceKey === snapshot.workspaceKey &&
      now.epoch === snapshot.epoch &&
      now.activeProjectId === projectId &&
      snapshot.activeProjectId === projectId
    );
  };

  const load = async (projectId: string): Promise<void> => {
    if (!projectId) return;
    if (loading.has(projectId)) return;
    loading.add(projectId);
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
    loading.delete(projectId);
    if (loadSeq.get(projectId) !== seq) return;
    if (!owned(projectId, snapshot)) return;
    if (outcome.status === 'APPLIED') {
      host.dispatch({ type: 'TRASH_LOADED', projectId, entries: outcome.entries, count: outcome.count });
      return;
    }
    host.dispatch({
      type: 'TRASH_LOAD_ERROR',
      projectId,
      errorCode: outcome.errorCode ?? 'ERR_STORAGE_IO',
      message: trashErrorMessage(outcome.errorCode ?? null, outcome.message ?? '读取回收区失败'),
    });
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
    const existing = inflight.get(key);
    if (existing) return existing;
    const task = (async (): Promise<TrashActionResult> => {
      try {
        return await action();
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, task);
    return task;
  };

  const settle = async (
    projectId: string,
    outcome: TrashActionOutcome,
    stillOwned: () => boolean,
    after: () => Promise<void>,
    notice: { applied: string; rejectedFallback: string },
  ): Promise<TrashActionResult> => {
    if (outcome.status === 'APPLIED') {
      // 归属已变（切项目 / 切模式）：磁盘事实由 Host 保证，界面不再宣布成功
      if (!stillOwned()) return { status: 'stale' };
      await after();
      if (!stillOwned()) return { status: 'stale' };
      void load(projectId);
      host.notify(notice.applied);
      return { status: 'applied', opId: outcome.opId };
    }
    if (outcome.status === 'UNKNOWN') {
      // 只读核对一次 + 刷新列表：不宣布成功，也绝不重发
      await verifyOnce(projectId, outcome.opId);
      if (!stillOwned()) return { status: 'stale' };
      await after();
      if (!stillOwned()) return { status: 'stale' };
      void load(projectId);
      host.notify(TRASH_UNKNOWN_MESSAGE);
      return { status: 'unknown', opId: outcome.opId, message: TRASH_UNKNOWN_MESSAGE };
    }
    const message = trashErrorMessage(outcome.errorCode, outcome.message || notice.rejectedFallback);
    host.notify(message);
    return { status: 'rejected', message };
  };

  const remove = async (projectId: string, path: string): Promise<TrashActionResult> => {
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
      return settle(
        projectId,
        outcome,
        () => owned(projectId, snapshot),
        () => host.refreshAfterRemoval(projectId, path),
        { applied: trashRemovedNotice(name), rejectedFallback: '无法移入回收区' },
      );
    });
  };

  const restore = async (projectId: string, entry: TrashEntryDto): Promise<TrashActionResult> => {
    if (!TRASH_STATE_VIEW[entry.state].canRestore) {
      return { status: 'rejected', message: TRASH_STATE_VIEW[entry.state].hint };
    }
    if (entry.state !== 'stored') {
      return { status: 'rejected', message: '该记录当前不可恢复，需要人工核对。' };
    }
    const reasons = host.blockers(projectId, entry.path);
    if (reasons.length > 0) return { status: 'blocked', reasons };

    return run(`restore\u0000${projectId}\u0000${entry.opId}`, async () => {
      const snapshot = capture();
      host.dispatch({ type: 'TRASH_BUSY', projectId, opId: entry.opId });
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
        return settle(
          projectId,
          outcome,
          () => owned(projectId, snapshot),
          () => host.refreshAfterRestore(projectId, entry.path),
          { applied: trashRestoredNotice(entry.path), rejectedFallback: '无法恢复该文件' },
        );
      } finally {
        host.dispatch({ type: 'TRASH_BUSY', projectId, opId: null });
      }
    });
  };

  return { load, remove, restore };
}
