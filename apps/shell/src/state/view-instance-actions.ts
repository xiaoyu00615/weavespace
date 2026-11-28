/**
 * 视图实例的生命周期动作（UI-F03-B3）：**纯 TS**，不依赖 React / DOM。
 *
 * 为什么单独成模块：`DocumentActionsContext` 是 `.tsx`，`node:test` 无法直接 import
 * （没有 JSX 变换）。而"关闭一格不能误伤另一格""最后一个脏视图必须服从 Host 拒绝"
 * 这些恰恰是**最容易写错、也最必须被确定性测试钉住**的时序逻辑。于是把它们放在这里，
 * Context 只负责转发。
 *
 * 三条不变量：
 *
 * 1. **一次只关一个 Host View**。关闭整份文档 = 逐个关它的实例，每关成功一个就把
 *    那一格从状态里摘掉；Shell 与 Host 因此始终对得上，不需要"回滚"这种动作。
 * 2. **Host 的拒绝就是结论**。`ERR_DOCUMENT_DIRTY`（最后一个脏视图）不许被忽略，
 *    也不许"先删状态再说"——那会让用户的草稿失去唯一的守护者。
 * 3. **第二个视图要自己的 Host View**。同一份文档要开第二格时，必须真的向 Host
 *    再开一次；绝不复用第一格的 `viewId`（那正是"关一格死两格"的来源）。
 */
import type { DocumentSnapshot, WeaveSpaceClient } from '../client/client-api.ts';
import type { ClientMode, DocTab, WorkspaceAction, WorkspaceState } from './types.ts';
import {
  hostViewIdForDoc,
  instanceFor,
  instanceOf,
  instancesOfDoc,
  viewInstanceIdOf,
} from './workspace-view-instances.ts';

export interface ViewInstanceActionsDeps {
  getState(): WorkspaceState;
  getMode(): ClientMode;
  dispatch(action: WorkspaceAction): void;
  clientFor(mode: ClientMode): WeaveSpaceClient;
  /** 本地编辑代次（可选）：用于拒绝"第二个视图的旧响应覆盖草稿"。 */
  editEpochs?: { of(docId: string): number };
}

/** 关闭一个实例的结论。`blocked` = Host 明确拒绝（通常因为它是最后一个脏视图）。 */
export interface CloseInstanceOutcome {
  status: 'closed' | 'missing' | 'blocked' | 'failed';
  errorCode: string | null;
}

/** 关闭整份文档的结论：`closed` 是真正关掉的数量。 */
export interface CloseDocOutcome {
  status: 'closed' | 'missing' | 'blocked' | 'failed';
  closed: number;
  errorCode: string | null;
}

/** 在某个组里打开（或切到）一份文档的结论。 */
export interface OpenInGroupOutcome {
  status: 'activated' | 'created' | 'rejected' | 'failed';
  hostViewId: string | null;
  errorCode: string | null;
}

export interface ViewInstanceActions {
  /** 关闭**一格**：只关它自己的 Host View，其他格与共享文档记录不受影响。 */
  closeInstance(viewInstanceId: string): Promise<CloseInstanceOutcome>;
  /**
   * 关闭整份文档 = 关闭它的**全部**实例（全局标签栏的语义）。
   *
   * 逐个关闭、逐个摘除：中途被 Host 拒绝时，之前关掉的那些已经从状态里移除，
   * 被拒绝的那一格原样保留——Shell 与 Host 不会分叉。
   */
  closeDoc(docId: string): Promise<CloseDocOutcome>;
  /**
   * 把一份**已经打开**的文档放进某个组，必要时为它开第二个 Host View。
   *
   * 用于恢复（两个 Pane 指向同一 docId）与未来的多窗格 UI。
   */
  openInGroup(docId: string, groupId: string): Promise<OpenInGroupOutcome>;
  /** 文档级操作要用哪个 Host View（属于这个会话的任意一个实例）。 */
  hostViewIdOf(docId: string): string | null;
}

export function createViewInstanceActions(deps: ViewInstanceActionsDeps): ViewInstanceActions {
  const tabOf = (docId: string): DocTab | undefined =>
    deps.getState().tabs.find((tab) => tab.docId === docId);

  async function closeOne(viewInstanceId: string): Promise<CloseInstanceOutcome> {
    const state = deps.getState();
    const instance = instanceOf(state.viewInstances, viewInstanceId);
    if (instance === null) return { status: 'missing', errorCode: null };

    const tab = tabOf(instance.docId);
    const hostViewId = instance.hostViewId;
    /*
     * 只有 live 且真的有 Host View 才需要问 Host。demo 没有真实视图生命周期，
     * 强行发请求只会造出一个"永远失败"的假错误。
     */
    if (tab && tab.mode === 'live' && tab.sessionId && hostViewId) {
      let outcome;
      try {
        outcome = await deps.clientFor('live').closeDocument(tab.sessionId, hostViewId);
      } catch {
        return { status: 'failed', errorCode: 'ERR_STORAGE_IO' };
      }
      if (outcome.status !== 'APPLIED') {
        // Host 拒绝（最后一个脏视图）：**不动状态**，让草稿继续被守护
        return { status: 'blocked', errorCode: outcome.errorCode ?? null };
      }
    }
    deps.dispatch({ type: 'CLOSE_VIEW_INSTANCE', viewInstanceId });
    return { status: 'closed', errorCode: null };
  }

  return {
    async closeInstance(viewInstanceId) {
      return await closeOne(viewInstanceId);
    },

    async closeDoc(docId) {
      const state = deps.getState();
      const instances = instancesOfDoc(state.viewInstances, docId);
      if (!state.tabs.some((tab) => tab.docId === docId)) {
        return { status: 'missing', closed: 0, errorCode: null };
      }
      let closed = 0;
      for (const instance of instances) {
        const outcome = await closeOne(instance.viewInstanceId);
        if (outcome.status === 'closed') {
          closed += 1;
          continue;
        }
        if (outcome.status === 'failed') {
          return { status: 'failed', closed, errorCode: outcome.errorCode };
        }
        /*
         * 被拒绝：它是最后一个脏视图。已经关掉的几格不必回滚——它们本来就已经
         * 不在 Host 里了，状态与 Host 一致；这里保留剩下这一格，用户还能继续保存。
         */
        return { status: 'blocked', closed, errorCode: outcome.errorCode };
      }
      // 全部关掉（或本来就没有实例）：把文档记录也收掉，避免留下幽灵标签
      if (deps.getState().tabs.some((tab) => tab.docId === docId)) {
        deps.dispatch({ type: 'CLOSE_TAB', docId });
      }
      return { status: 'closed', closed, errorCode: null };
    },

    async openInGroup(docId, groupId) {
      const state = deps.getState();
      const tab = tabOf(docId);
      if (!tab) return { status: 'rejected', hostViewId: null, errorCode: 'ERR_DOCUMENT_NOT_FOUND' };

      /*
       * 已经有这一格：只有在它**还没有自己的 Host View** 时才需要继续往下走。
       *
       * "分屏时右侧接管同一份文档"就是这种状态：实例建了、显示也对，但 `hostViewId`
       * 是 null（因为第一格已经占了那个 View）。等用户真的把它当第二格用（恢复、
       * 或列表里的"在另一组打开"），才补一个真正属于它的 Host View。
       */
      const existing = instanceFor(state.viewInstances, groupId, docId);
      const needsHostView =
        existing !== null && existing.hostViewId === null && tab.mode === 'live' && Boolean(tab.sessionId);
      if (existing !== null && !needsHostView) {
        deps.dispatch({ type: 'ACTIVATE_VIEW_INSTANCE', viewInstanceId: existing.viewInstanceId });
        return { status: 'activated', hostViewId: existing.hostViewId, errorCode: null };
      }

      /*
       * demo / 没有会话：不需要（也没有）Host View。建一个 `hostViewId: null` 的实例
       * 就够——文档级操作会退化成"不带 viewId"的请求。
       */
      if (tab.mode !== 'live' || !tab.sessionId) {
        deps.dispatch({
          type: 'REGISTER_VIEW_INSTANCE',
          docId,
          groupId,
          viewInstanceId: viewInstanceIdOf(groupId, docId),
          hostViewId: null,
          activate: true,
        });
        return { status: 'created', hostViewId: null, errorCode: null };
      }

      const captured = {
        mode: deps.getMode(),
        sessionId: tab.sessionId,
        revision: tab.revision,
        baseVersion: tab.baseVersion,
        editEpoch: deps.editEpochs?.of(docId) ?? 0,
      };

      let outcome;
      try {
        outcome = await deps.clientFor('live').openDocument(tab.path, tab.projectId ?? undefined);
      } catch {
        return { status: 'failed', hostViewId: null, errorCode: 'ERR_STORAGE_IO' };
      }
      if (outcome.status !== 'APPLIED' || !outcome.document) {
        return { status: 'rejected', hostViewId: null, errorCode: outcome.errorCode ?? null };
      }

      const document = outcome.document;
      /*
       * 归属核验（与打开流程同一条纪律）：模式变了、文档被关了、会话换了，
       * 这次响应就不属于当前界面。**但它建出来的 Host View 必须有人认领**，
       * 于是登记成未分组实例——既不留孤儿，也不会显示成某个组的活动视图。
       */
      const latest = tabOf(docId);
      const owned =
        deps.getMode() === captured.mode &&
        latest !== undefined &&
        latest.sessionId === captured.sessionId;
      if (!owned) {
        deps.dispatch({
          type: 'REGISTER_VIEW_INSTANCE',
          docId,
          groupId: null,
          viewInstanceId: viewInstanceIdOf(null, docId),
          hostViewId: document.viewId,
          activate: false,
        });
        return { status: 'rejected', hostViewId: document.viewId, errorCode: 'ERR_OWNER_CHANGED' };
      }

      deps.dispatch({
        type: 'REGISTER_VIEW_INSTANCE',
        docId,
        groupId,
        viewInstanceId: viewInstanceIdOf(groupId, docId),
        hostViewId: document.viewId,
        activate: true,
      });

      /*
       * 共享 Session 回填：第二次打开可能带回**更新**的缓冲/版本（Host 在会话
       * 无人编辑且磁盘变过时会刷新）。只在"期间没有本地编辑、标签仍干净、
       * revision 没有回退"时套用，否则一律丢弃——绝不让第二格的旧响应覆盖草稿。
       */
      if (
        deps.getMode() === captured.mode &&
        !latest.dirty &&
        captured.editEpoch === (deps.editEpochs?.of(docId) ?? 0) &&
        captured.revision === latest.revision &&
        document.revision >= latest.revision
      ) {
        applySnapshot(docId, document);
      }
      return { status: 'created', hostViewId: document.viewId, errorCode: null };
    },

    hostViewIdOf(docId) {
      return hostViewIdForDoc(deps.getState().viewInstances, docId);
    },
  };

  /** 把会话快照同步进文档记录（只回写版本与缓冲，不新建记录）。 */
  function applySnapshot(docId: string, document: DocumentSnapshot): void {
    const latest = tabOf(docId);
    if (!latest) return;
    if (
      latest.buffer === document.content &&
      latest.baseVersion === document.baseVersion &&
      latest.revision === document.revision
    ) {
      return;
    }
    deps.dispatch({
      type: 'TAB_PATCH',
      docId,
      patch: {
        buffer: document.content,
        baseVersion: document.baseVersion,
        revision: document.revision,
        dirty: document.dirty,
        documentState: document.documentState,
      },
    });
  }
}
