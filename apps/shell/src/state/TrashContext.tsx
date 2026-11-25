/**
 * 回收区编排的 React 装配层（UX-02C-03-P2-02）。
 *
 * 这一层只做三件事：把 state/dispatch/client 注入 `state/trash.ts` 的编排器、
 * 在合适的时机触发读取、把"该画什么"算好交给组件。
 * **判断逻辑一律不在组件里**，否则 `.tsx` 无法被测试覆盖。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import type { TrashEntryDto } from '../client/client-api.ts';
import { parentDirOfEntry } from '../../../../packages/storage/entry-name.ts';
import { useDocumentActions } from './DocumentActionsContext.tsx';
import { localStructureBlockers } from './structure-change.ts';
import { defaultNewOpId } from './remove-project.ts';
import {
  createTrashController,
  trashBadgeCount,
  trashBlockerMessage,
  trashLoadKey,
  trashPanelView,
  type TrashActionResult,
  type TrashController,
  type TrashIdentity,
  type TrashPanelView,
} from './trash.ts';
import {
  dialogBelongsTo,
  openTrashDelete as openTrashDeleteState,
  submitTrashDelete,
  type TrashDeleteDialogState,
} from './trash-dialog.ts';
import {
  createTrashLedgerStore,
  createWebLockCoordination,
  trashReserveAuthorizes,
  pendingIdsOf,
  readTrashLedger,
  type LockManagerLike,
} from './trash-ledger.ts';
import type { StorageLike } from './workspace-persistence.ts';
import { useWorkspace } from './WorkspaceContext.tsx';
import type { ClientMode, WorkspaceAction } from './types.ts';

/**
 * 浏览器存储的安全包装（与工作区快照同源的处理方式）。
 *
 * 隐私模式/策略禁用时**访问 `localStorage` 本身**就会抛异常；这里吞掉并返回 null，
 * 由台账模块判为 `unavailable`（fail-closed），而不是让启动流程崩掉。
 */
function safeBrowserStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export interface TrashPrecheck {
  readonly ok: boolean;
  /** 已翻译成用户语言的阻断原因（可含多条）。 */
  readonly reasons: readonly string[];
}

interface TrashValue {
  /** 面板当前该画什么（unsupported / loading / error / list）。 */
  readonly panel: TrashPanelView;
  /** 导航徽标数量；`null` = 未知，不显示数字。 */
  readonly badge: number | null;
  readonly loading: boolean;
  load(): Promise<void>;
  remove(projectId: string, path: string): Promise<TrashActionResult>;
  restore(projectId: string, entry: TrashEntryDto): Promise<TrashActionResult>;
  /** 弹确认框之前的前置检查：不支持 / 被标签占用时只显示原因，不给确认按钮。 */
  precheck(projectId: string, path: string): TrashPrecheck;
  /** 右键「移入回收区」→ 打开二段确认（不直接动磁盘）。 */
  openDelete(projectId: string, path: string): void;
  confirmDelete(): Promise<void>;
  cancelDelete(): void;
  readonly deleteDialog: TrashDeleteDialogState | null;
}

const TrashContext = createContext<TrashValue | null>(null);

/**
 * 工作区身份 + 代次。
 *
 * `epoch` 只在 (mode, workspaceMode, workspaceKey) 组合变化时 +1：
 * 切到 Demo 再切回来、Host 重连换了工作区，都会让在途请求立即作废；
 * 而普通的项目切换由 `activeProjectId` 这一维负责。
 */
function useIdentityTracker(mode: ClientMode, workspaceMode: string, workspaceKey: string | null) {
  const tracker = useRef({ key: '', epoch: 0 });
  const key = `${mode}|${workspaceMode}|${workspaceKey ?? ''}`;
  if (tracker.current.key !== key) {
    tracker.current = { key, epoch: tracker.current.epoch + 1 };
  }
  return tracker;
}

export function TrashProvider({ children }: { children: ReactNode }) {
  const { state, dispatch: workspaceDispatch } = useWorkspace();
  const actions = useDocumentActions();
  const [deleteDialog, setDeleteDialog] = useState<TrashDeleteDialogState | null>(null);

  /**
   * 回调里读"最新"状态：编排器的 await 之后要用它判断归属，
   * 用渲染闭包会拿到过期快照（与其它编排层同一个理由）。
   */
  const stateRef = useRef(state);
  stateRef.current = state;

  /*
   * 跨重启的「待核对」台账（R1.1-02 / R1.2-01）。
   *
   * `localStorage` 是同步 API，因此在**第一次渲染**时就能读到记录：
   * 面板第一次算出来的行就已经带着"待核对"，不存在"先亮出恢复按钮、下一帧才禁用"的窗口。
   *
   * 台账的"当前记录"只放在 store 里，**不**从 React 渲染快照反推：`setState` 是批处理
   * 的，两条 UNKNOWN 在同一次提交里到达时，后一条若基于旧快照起算就会覆盖前一条。
   * 这里的 `ledger` state 只是给渲染用的一份镜像，写路径永远先问 store。
   */
  const storage = useMemo(() => safeBrowserStorage(), []);
  const ledgerRead = useMemo(() => readTrashLedger(storage), [storage]);
  /**
   * 跨标签页互斥（R1.2.1-02）。
   *
   * 每个标签页有各自的 store，但共享同一份 localStorage。没有 `navigator.locks`
   * 就无法保证"读-改-写"不交错，那种情况下**整体关闭恢复**（fail-closed），
   * 而不是退回会丢记录的写法。
   */
  const coordination = useMemo(() => {
    const locks =
      typeof navigator === 'undefined'
        ? null
        : ((navigator as Navigator & { locks?: LockManagerLike }).locks ?? null);
    return createWebLockCoordination(locks);
  }, []);
  const ledgerStore = useMemo(
    () => createTrashLedgerStore(storage, ledgerRead, coordination),
    [storage, ledgerRead, coordination],
  );
  /**
   * 界面镜像 = store 快照（R1.2.1-R1）。
   *
   * 之前是"每个成功分支手写一次 `syncLedger()`"：`exists`、`full`、`write-failed`
   * 这些被拒绝的分支不会同步，但 store 在锁内重读时已经拿到了别的页面写的记录，
   * 于是出现"Store 正确、界面还显示可恢复"。改成订阅后，**任何**状态或记录变化
   * 都会重画，根本不给"漏掉某个分支"的机会。
   */
  const ledgerSnapshot = useSyncExternalStore(
    ledgerStore.subscribe,
    ledgerStore.snapshot,
    ledgerStore.snapshot,
  );
  const [ledgerWriteFailed, setLedgerWriteFailed] = useState(false);
  const markLedgerDegraded = useCallback(() => setLedgerWriteFailed(true), []);
  /** 一次成功的写盘说明降级只是暂时的：把提示收掉（否则会一直挂着吓人）。 */
  const markLedgerHealthy = useCallback(() => setLedgerWriteFailed(false), []);

  /**
   * 派发包装：观察 `TRASH_UNCONFIRMED(pending=true)`，把它写进跨重启台账。
   *
   * 为什么在 Provider 里做而不是在控制器里：控制器是纯编排（只认识 host 接口），
   * 持久化是 Shell 的装配职责；这样控制器仍可被 `node:test` 用假 host 完整驱动。
   */
  const dispatch = useCallback(
    (action: WorkspaceAction) => {
      if (action.type === 'TRASH_UNCONFIRMED' && action.pending) {
        const workspaceKey = stateRef.current.workspaceKey;
        if (!workspaceKey) {
          // 没有工作区身份就无法把这条记录归位：如实标记"保护降级"，绝不假装已记录
          markLedgerDegraded();
        } else {
          /*
           * 正常情况下这条早在 POST 之前就预留过了（R1.2-03），这里是幂等的兜底：
           * 万一有路径还没预留（或预留后又被释放），至少不要漏记。
           */
          void ledgerStore
            .reserve({
              workspaceKey,
              projectId: action.projectId,
              opId: action.opId,
              createdAt: new Date().toISOString(),
            })
            .then((outcome) => {
              // 镜像由 store 的订阅自动同步；这里只关心"保护是否降级"
              if (outcome.status !== 'reserved' && outcome.status !== 'exists') markLedgerDegraded();
            });
        }
      }
      workspaceDispatch(action);
    },
    [ledgerStore, markLedgerDegraded, workspaceDispatch],
  );

  const tracker = useIdentityTracker(state.mode, state.workspaceMode, state.workspaceKey);
  const controllerRef = useRef<TrashController | null>(null);
  /** 双击确认只允许一次提交：`phase` 要等一次渲染才变，用 ref 才拦得住同一 tick。 */
  const confirming = useRef(false);

  const identity = useCallback((): TrashIdentity => {
    const current = stateRef.current;
    return {
      mode: current.mode,
      workspaceMode: current.workspaceMode,
      workspaceKey: current.workspaceKey,
      activeProjectId: current.activeProjectId,
      epoch: tracker.current.epoch,
    };
  }, [tracker]);

  if (!controllerRef.current) {
    controllerRef.current = createTrashController({
      port: {
        list: (projectId) => actions.listTrash(projectId),
        remove: (projectId, path, opId) => actions.trashEntry(projectId, path, opId),
        restore: (projectId, opId) => actions.restoreTrash(projectId, opId),
        query: (projectId, opId) => actions.queryTrashOp(projectId, opId),
      },
      identity,
      dispatch,
      newOpId: defaultNewOpId,
      notify: (message) => dispatch({ type: 'NOTICE', message }),
      supported: (projectId) => {
        const current = stateRef.current;
        if (current.mode !== 'live' || current.workspaceMode !== 'multi') return false;
        return current.projects.some(
          (project) => project.projectId === projectId && project.status === 'READY',
        );
      },
      /**
       * 台账闸（R1.1-02 / R1.2-02）。
       *
       * 台账损坏 / 存储不可用 / 容量用尽，都说明"这次恢复以后可能追踪不到"，
       * 恢复一律关闭。控制器拿到的是一句可直接展示的原因。
       */
      restoreGate: () => ledgerStore.blockMessage(),
      /**
       * 恢复前的台账预留（R1.2-03）。
       *
       * 返回 false 时控制器一个请求都不发：宁可这次不恢复，也不要留下一次
       * "关掉页面就再也查不到"的磁盘副作用。
       */
      reservePending: async (target) => {
        const outcome = await ledgerStore.reserve({
          workspaceKey: target.workspaceKey,
          projectId: target.projectId,
          opId: target.opId,
          createdAt: new Date().toISOString(),
        });
        if (trashReserveAuthorizes(outcome)) {
          markLedgerHealthy();
          return { ok: true as const };
        }
        /*
         * R1.2.1-01：`exists` 不是授权。
         *
         * 台账里已经有同一个 opId，说明上一次恢复**还没有结论**（UNKNOWN、或列表还没
         * 确认到终态）。这时再发一次 POST 就是第二次真实的磁盘移动，而界面上那条
         * 记录也正是靠这条台账才被禁用。所以这里必须明确拒绝，而不是"已经记过了，
         * 继续吧"。
         */
        if (outcome.status === 'exists') {
          return {
            ok: false as const,
            message:
              '这条记录上一次恢复的结果还没有确认，已取消本次恢复（不会重复发送操作）。请先刷新回收区，等这条记录有了结论再试。',
          };
        }
        if (outcome.status === 'invalid') {
          return { ok: false as const, message: '工作区身份无效，已取消这次恢复（未发送请求）。' };
        }
        if (outcome.status === 'write-failed') {
          // 没落盘就发请求 = 关掉页面即失去保护：如实报错并拒绝
          markLedgerDegraded();
          return {
            ok: false as const,
            message: '本机存储写入失败，无法记录这次恢复的「待核对」状态，已取消（未发送请求）。',
          };
        }
        return {
          ok: false as const,
          message: ledgerStore.blockMessage() ?? '本机的「待核对」台账当前不可用，已取消这次恢复。',
        };
      },
      /** 只有明确零副作用（REJECTED）才走到这里；失败只降级提示，不回滚（结论仍然可靠）。 */
      releasePending: async (target) => {
        const outcome = await ledgerStore.release({
          workspaceKey: target.workspaceKey,
          projectId: target.projectId,
          opIds: [target.opId],
        });
        if (outcome.status === 'write-failed') markLedgerDegraded();
        else if (outcome.status === 'changed') markLedgerHealthy();
      },
      /**
       * 发送前的身份闸（R1-05）。
       *
       * 与 `supported` 的区别：这里区分"归属变了"和"项目此刻不可用"。
       * 前者必须**静默**丢弃（用户已经不在那个项目上了，弹提示只会让人困惑），
       * 后者要给一句能执行的话。
       */
      preflight: (projectId) => {
        const current = stateRef.current;
        if (current.mode !== 'live' || current.workspaceMode !== 'multi') {
          return { ok: false, kind: 'stale' as const };
        }
        if (current.activeProjectId !== projectId) return { ok: false, kind: 'stale' as const };
        const project = current.projects.find((item) => item.projectId === projectId);
        if (!project) return { ok: false, kind: 'stale' as const };
        if (project.status !== 'READY') {
          return {
            ok: false,
            kind: 'blocked' as const,
            message: '项目当前不可用，请稍后重试。',
          };
        }
        return { ok: true as const };
      },
      blockers: (projectId, path) =>
        localStructureBlockers(stateRef.current.tabs, projectId, path, 'file'),
      /**
       * 只刷新"原文件所在的那一层"：不递归、不碰其他项目、不动标签与草稿。
       * 目录层由 `treeLoader` 领取新票据，旧的在途响应自然作废。
       */
      refreshAfterRemoval: async (projectId, path) => {
        await actions.refreshTreeLevel(projectId, parentDirOfEntry(path));
      },
      refreshAfterRestore: async (projectId, path) => {
        await actions.refreshTreeLevel(projectId, parentDirOfEntry(path));
      },
    });
  }
  const controller = controllerRef.current;

  const projectId = state.activeProjectId;
  const projectTrash = projectId ? state.trashByProject[projectId] : undefined;

  /** 台账里属于当前工作区+项目的待核对 opId（与内存集合取并集展示）。 */
  const pendingFromLedger = useMemo(
    () => pendingIdsOf(ledgerSnapshot.records, state.workspaceKey, projectId),
    [ledgerSnapshot, state.workspaceKey, projectId],
  );

  // 能不能恢复只看快照：full / corrupt / unavailable / invalidated 都在里面
  const ledgerBlocked = ledgerSnapshot.blockMessage;
  const ledgerWarning = ledgerWriteFailed
    ? '「待核对」记录没能写入本机存储：本次会话内仍然禁用，但重开应用后可能失去保护；请尽快核对并恢复浏览器存储。'
    : null;

  const panel = useMemo(
    () =>
      trashPanelView({
        mode: state.mode,
        workspaceMode: state.workspaceMode,
        projectId,
        state: projectTrash,
        extraUnconfirmed: pendingFromLedger,
        restoreBlocked: ledgerBlocked,
        warning: ledgerWarning,
      }),
    [state.mode, state.workspaceMode, projectId, projectTrash, pendingFromLedger, ledgerBlocked, ledgerWarning],
  );

  /**
   * 用**成功的**列表读取收敛台账（R1.1-02 清除规则）。
   *
   * 只在 `loaded && !loading && errorCode === null` 时做：读取失败不构成任何结论，
   * 这时把记录删掉就等于"因为一次网络错误放开了未知副作用"。
   */
  useEffect(() => {
    if (!state.workspaceKey || !projectId) return;
    const bucket = state.trashByProject[projectId];
    if (!bucket || !bucket.loaded || bucket.loading || bucket.errorCode !== null) return;
    let cancelled = false;
    void ledgerStore
      .reconcile({
        workspaceKey: state.workspaceKey,
        projectId,
        entries: bucket.entries,
        loaded: true,
      })
      .then((outcome) => {
        // 组件已卸载 / 依赖已变：结果对当前界面没有意义（写盘已在锁内完成）
        if (cancelled) return;
        // 镜像同步由订阅负责；这里只需要把"没落盘"如实告诉用户
        if (outcome.status === 'write-failed') markLedgerDegraded();
      });
    return () => {
      cancelled = true;
    };
  }, [ledgerStore, state.workspaceKey, state.trashByProject, projectId, markLedgerDegraded]);

  /**
   * 别的标签页改了台账 → 同步本页镜像与界面（R1.2.1-02 / R1.2.1-R1）。
   *
   * `storage` 事件只是**通知**，不是锁：真正的并发安全在 store 的锁内重读。
   * 删除 / 清空（`newValue === null`，或 `clear()` 的 `key === null`）必须按
   * "保护被破坏"处理，**不能**当成"台账现在是空的"——store 内部会进入失效保护，
   * 这里只负责把事件原样交给它（并保留内存记录）。
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (event: StorageEvent): void => {
      ledgerStore.applyExternalEvent({ key: event.key, newValue: event.newValue });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [ledgerStore]);

  const badge = trashBadgeCount(projectTrash, state.mode, projectId);

  /**
   * 进入一个真实项目就顺手读一次回收区：导航上的数量徽标必须是真的。
   *
   * 单飞在编排器里；这里只按 (模式, 项目) 触发，切换项目/重连各触发一次。
   * 迟到的响应由编排器的归属核对丢弃，不会写进新项目的桶。
   */
  const loadKey = trashLoadKey({
    mode: state.mode,
    workspaceMode: state.workspaceMode,
    workspaceKey: state.workspaceKey,
    projectId: state.activeProjectId,
  });

  useEffect(() => {
    // 触发键把"工作区 + 项目"压成一个值：换工作区（即使项目 id 相同）必然重新读
    if (!loadKey) return;
    const current = stateRef.current;
    if (!current.activeProjectId) return;
    void controller.load(current.activeProjectId);
  }, [controller, loadKey]);

  const load = useCallback(async (): Promise<void> => {
    const current = stateRef.current;
    if (current.mode !== 'live' || current.workspaceMode !== 'multi') return;
    if (!current.activeProjectId) return;
    await controller.load(current.activeProjectId);
  }, [controller]);

  const precheck = useCallback((targetProjectId: string, path: string): TrashPrecheck => {
    const current = stateRef.current;
    const ready = current.projects.some(
      (project) => project.projectId === targetProjectId && project.status === 'READY',
    );
    if (current.mode !== 'live' || current.workspaceMode !== 'multi' || !ready) {
      return { ok: false, reasons: ['当前模式/项目不支持真实回收。'] };
    }
    const codes = localStructureBlockers(current.tabs, targetProjectId, path, 'file');
    if (codes.length === 0) return { ok: true, reasons: [] };
    return { ok: false, reasons: [trashBlockerMessage(path, codes)] };
  }, []);

  const remove = useCallback(
    (targetProjectId: string, path: string) => controller.remove(targetProjectId, path),
    [controller],
  );

  const restore = useCallback(
    (targetProjectId: string, entry: TrashEntryDto) => controller.restore(targetProjectId, entry),
    [controller],
  );

  /* ---- 二段确认 ---- */

  const openDelete = useCallback(
    (targetProjectId: string, path: string) => {
      const checked = precheck(targetProjectId, path);
      const current = identity();
      // 打开确认框本身不发请求：零网络、零磁盘。
      // 把"确认时的归属"记在对话框里：用户可能在确认前切走项目/工作区。
      setDeleteDialog(
        openTrashDeleteState({
          projectId: targetProjectId,
          path,
          reasons: checked.reasons,
          workspaceKey: current.workspaceKey,
          epoch: current.epoch,
        }),
      );
    },
    [identity, precheck],
  );

  const cancelDelete = useCallback(() => {
    if (confirming.current) return;
    setDeleteDialog(null);
  }, []);

  const confirmDelete = useCallback(async (): Promise<void> => {
    const dialog = deleteDialog;
    // `phase !== 'ready'` 时一次请求都不发；`confirming` ref 挡住同一 tick 的连点
    if (!dialog || dialog.phase !== 'ready' || confirming.current) return;
    /*
     * R1-05：确认前重新核对归属。
     *
     * "打开确认框 → 切到别的项目/工作区 → 点确认"是完全正常的操作序列，
     * 但那时这条命令已经不属于当前界面了：静默关闭，一个请求都不发。
     */
    const now = identity();
    if (!dialogBelongsTo(dialog, now)) {
      // 此刻还没发请求，`confirming` 一定是 false：可以直接走"取消"的关闭路径
      cancelDelete();
      return;
    }
    confirming.current = true;
    setDeleteDialog((current) => (current ? { ...current, phase: 'confirming' } : current));
    try {
      const { next } = await submitTrashDelete(dialog, controller.remove);
      setDeleteDialog(next);
    } catch {
      // 兜底：编排层已把断线收敛成 UNKNOWN，这里再挡一层，模态不会永久卡在"处理中"
      setDeleteDialog((current) =>
        current
          ? {
              ...current,
              phase: 'result',
              result: { tone: 'warn', body: '结果未确认：请到回收区查看真实状态（不会自动重发）。' },
            }
          : current,
      );
    } finally {
      confirming.current = false;
    }
  }, [controller, deleteDialog, identity, cancelDelete]);

  const value = useMemo<TrashValue>(
    () => ({
      panel,
      badge,
      loading: projectTrash?.loading === true,
      load,
      remove,
      restore,
      precheck,
      openDelete,
      confirmDelete,
      cancelDelete,
      deleteDialog,
    }),
    [panel, badge, projectTrash?.loading, load, remove, restore, precheck, openDelete, confirmDelete, cancelDelete, deleteDialog],
  );

  return <TrashContext.Provider value={value}>{children}</TrashContext.Provider>;
}

export function useTrash(): TrashValue {
  const value = useContext(TrashContext);
  if (!value) throw new Error('useTrash 必须在 TrashProvider 内使用');
  return value;
}
