/**
 * 回收区编排的 React 装配层（UX-02C-03-P2-02）。
 *
 * 这一层只做三件事：把 state/dispatch/client 注入 `state/trash.ts` 的编排器、
 * 在合适的时机触发读取、把"该画什么"算好交给组件。
 * **判断逻辑一律不在组件里**，否则 `.tsx` 无法被测试覆盖。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
import { useWorkspace } from './WorkspaceContext.tsx';
import type { ClientMode } from './types.ts';

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
  const { state, dispatch } = useWorkspace();
  const actions = useDocumentActions();
  const [deleteDialog, setDeleteDialog] = useState<TrashDeleteDialogState | null>(null);

  /**
   * 回调里读"最新"状态：编排器的 await 之后要用它判断归属，
   * 用渲染闭包会拿到过期快照（与其它编排层同一个理由）。
   */
  const stateRef = useRef(state);
  stateRef.current = state;

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

  const panel = useMemo(
    () =>
      trashPanelView({
        mode: state.mode,
        workspaceMode: state.workspaceMode,
        projectId,
        state: projectTrash,
      }),
    [state.mode, state.workspaceMode, projectId, projectTrash],
  );

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
