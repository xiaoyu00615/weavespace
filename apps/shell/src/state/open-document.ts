/**
 * 打开文档的编排（S9-B / G2 / G2-R1）。
 *
 * 为什么单独成模块：这段逻辑是纯异步流程（不依赖 React 渲染），但又是**真正被
 * `DocumentActionsContext` 调用的实现**。抽出来以后可以在 Node 里用真实 Host +
 * 真实 reducer 驱动完整调用链，验证"旧响应不覆盖新编辑""临时 View 必须释放"
 * "模式切换后旧响应不得插入另一个工作区"这些时序问题，而不是只测一个纯函数。
 *
 * 三条不变量：
 * 1. 只有「归属未变 + 请求期间没有本地编辑 + 版本未推进」时才允许用磁盘内容回填；
 * 2. 任何为完成操作而临时创建的 View，要么被标签接管，要么立刻释放（不泄漏）；
 * 3. 结果只能写回发起时的那个工作区/文档：模式切走、标签关掉、项目切走都丢弃。
 */
import type { DocumentSnapshot, WeaveSpaceClient } from '../client/client-api.ts';
import type { ClientMode } from './types.ts';
import {
  canApplyDiskRefresh,
  extensionOfPath,
  isProjectOpenable,
  isResponseOwnerCurrent,
  makeDocId,
} from './doc-identity.ts';
import type { DocTab, ResourceNodeState, WorkspaceAction, WorkspaceState } from './types.ts';

/** 本地编辑代次：纯 UI 计数，用来识别"读取请求期间用户又敲了字"。 */
export interface EditEpochs {
  of(docId: string): number;
  bump(docId: string): number;
  forget(docId: string): void;
  clear(): void;
}

/** 由调用方（Provider）提供的依赖；测试里可用真实 reducer 构造一份。 */
export interface OpenDocumentDeps {
  getState(): WorkspaceState;
  /** 当前工作区模式。必须同步可读（切换模式时要早于渲染生效）。 */
  getMode(): ClientMode;
  dispatch(action: WorkspaceAction): void;
  clientFor(mode: ClientMode): WeaveSpaceClient;
  editEpochs: EditEpochs;
}

export interface DocumentOpener {
  /** 打开（或激活并刷新）一个节点。 */
  openNode(node: ResourceNodeState, projectId?: string | null): Promise<void>;
  /** 本地编辑发生：推进代次，使在途的磁盘读取失效。 */
  noteLocalEdit(docId: string): void;
  /** 标签关闭：丢弃该文档的编辑代次。 */
  forget(docId: string): void;
  /** 切换工作区：所有在途读取与代次都作废。 */
  reset(): void;
  /** 当前在途打开数（诊断/测试用）。 */
  pendingOpens(): number;
}

export function tabFromSnapshot(
  docId: string,
  projectId: string | null,
  title: string,
  extension: string,
  mode: ClientMode,
  doc: DocumentSnapshot,
): DocTab {
  return {
    docId,
    projectId,
    path: doc.path,
    title,
    extension,
    buffer: doc.content,
    dirty: doc.dirty,
    mode,
    sessionId: doc.sessionId,
    viewId: doc.viewId,
    baseVersion: doc.baseVersion,
    revision: doc.revision,
    documentState: doc.documentState,
    saving: false,
    lastStatus: null,
    errorCode: null,
  };
}

export function createDocumentOpener(deps: OpenDocumentDeps): DocumentOpener {
  /** 同一 (模式, 文档) 的并发打开合并为一次请求：不会各自在服务端造一个 View。 */
  const inFlight = new Map<string, Promise<void>>();

  const tabOf = (docId: string): DocTab | undefined =>
    deps.getState().tabs.find((tab) => tab.docId === docId);

  const projectName = (projectId: string | null): string | null => {
    if (!projectId) return null;
    return (
      deps.getState().projects.find((project) => project.projectId === projectId)?.name ?? projectId
    );
  };

  /**
   * 释放一个**不属于任何标签**的 View。
   *
   * 失败一律吞掉：关闭被拒绝只可能因为"最后一个视图且有草稿"，那种情况下
   * 关闭本身就会丢草稿，宁可留一个悬挂 View 也不能毁掉用户内容。
   */
  async function releaseView(
    client: WeaveSpaceClient,
    sessionId: string | null | undefined,
    viewId: string | null | undefined,
    keepViewId?: string | null,
  ): Promise<boolean> {
    if (!sessionId || !viewId) return false;
    if (keepViewId && viewId === keepViewId) return false;
    try {
      const outcome = await client.closeDocument(sessionId, viewId);
      return outcome.status === 'APPLIED';
    } catch {
      return false;
    }
  }

  /**
   * 已有干净标签被再次点击：允许把磁盘上的新内容同步过来，但**不得**
   * 1) 覆盖请求期间的新编辑；2) 在服务端留下临时 View。
   */
  async function refreshCleanTab(docId: string): Promise<void> {
    const tab = tabOf(docId);
    // 有草稿就不刷新：Core 也不会在 dirty 时刷新，回填只会覆盖输入（既有行为）
    if (!tab || tab.mode !== 'live' || tab.dirty || !tab.sessionId || !tab.viewId) return;

    const captured = {
      owner: { projectId: tab.projectId, docId, sessionId: tab.sessionId },
      mode: tab.mode,
      editEpoch: deps.editEpochs.of(docId),
      revision: tab.revision,
      baseVersion: tab.baseVersion,
      buffer: tab.buffer,
      dirty: tab.dirty,
    };

    const client = deps.clientFor('live');
    let outcome;
    try {
      // 用 open 让 Core 重新核对磁盘并（必要时）推进基线；它同时会新建一个 View，
      // 因此下面必须在**所有分支**把它释放掉——标签自己的 viewId 才是被管理的那个。
      outcome = await client.openDocument(tab.path, tab.projectId ?? undefined);
    } catch {
      return;
    }

    const tempSessionId = outcome.document?.sessionId ?? null;
    const tempViewId = outcome.document?.viewId ?? null;

    if (outcome.status === 'APPLIED' && outcome.document) {
      const doc = outcome.document;
      const latest = tabOf(docId);
      const current = {
        owner: {
          projectId: latest?.projectId ?? null,
          docId: latest?.docId ?? '',
          sessionId: latest?.sessionId ?? null,
          exists: Boolean(latest),
        },
        mode: latest?.mode ?? captured.mode,
        editEpoch: deps.editEpochs.of(docId),
        revision: latest?.revision ?? -1,
        baseVersion: latest?.baseVersion ?? null,
        buffer: latest?.buffer ?? '',
        dirty: latest?.dirty ?? false,
      };

      const allowed =
        deps.getMode() === captured.mode &&
        canApplyDiskRefresh({
          captured,
          current,
          incoming: {
            sessionId: doc.sessionId,
            revision: doc.revision,
            baseVersion: doc.baseVersion,
            content: doc.content,
          },
        });

      if (allowed) {
        deps.dispatch({
          type: 'TAB_PATCH',
          docId,
          patch: {
            buffer: doc.content,
            baseVersion: doc.baseVersion,
            revision: doc.revision,
            dirty: false,
            documentState: doc.documentState,
          },
        });
        deps.dispatch({ type: 'NOTICE', message: '检测到磁盘变化：已同步最新内容与版本' });
      }
    }

    await releaseView(client, tempSessionId, tempViewId, tab.viewId);
  }

  async function createTab(
    node: ResourceNodeState,
    docId: string,
    projectId: string | null,
    path: string,
    mode: ClientMode,
  ): Promise<void> {
    const client = deps.clientFor(mode);
    const before = deps.getState();
    const focus = {
      pane: before.focusedPane,
      docId: before.panes[before.focusedPane]?.docId ?? null,
      activeProjectId: before.activeProjectId,
    };
    deps.dispatch({ type: 'NOTICE', message: `正在打开 ${node.name} …` });

    let outcome;
    try {
      outcome = await client.openDocument(path, projectId ?? undefined);
    } catch {
      deps.dispatch({ type: 'NOTICE', message: `无法打开 ${node.name}：无法连接本地服务` });
      return;
    }

    // 模式已切换（G2-R1）：这次结果属于上一个工作区，绝不能插进当前工作区。
    // 新建的 View 必须释放，否则会在服务端留下无人管理的会话视图。
    if (deps.getMode() !== mode) {
      await releaseView(
        client,
        outcome.document?.sessionId ?? null,
        outcome.document?.viewId ?? null,
      );
      return;
    }

    if (outcome.status !== 'APPLIED' || !outcome.document) {
      deps.dispatch({
        type: 'NOTICE',
        message: `无法打开 ${node.name}：${outcome.errorCode ?? '未知错误'}`,
      });
      return;
    }

    // 打开期间标签已被别的入口创建：不新建标签，并释放本次多出来的 View
    const raced = tabOf(docId);
    if (raced) {
      await releaseView(
        client,
        outcome.document.sessionId,
        outcome.document.viewId,
        raced.viewId,
      );
      deps.dispatch({ type: 'ACTIVATE_TAB', docId });
      return;
    }

    // 用户已经切到别的项目：标签仍然创建（内容已经取回），但**不要**把焦点抢回来
    const projectChanged = deps.getState().activeProjectId !== focus.activeProjectId;

    deps.dispatch({
      type: 'OPEN_TAB',
      tab: tabFromSnapshot(
        docId,
        projectId,
        node.name,
        node.extension ?? extensionOfPath(node.name),
        mode,
        outcome.document,
      ),
    });
    if (projectId) {
      deps.dispatch({ type: 'SELECT_PROJECT_NODE', projectId, path: docId });
    }
    if (projectChanged && focus.docId) {
      deps.dispatch({ type: 'FOCUS_PANE', pane: focus.pane });
      deps.dispatch({ type: 'ACTIVATE_TAB', docId: focus.docId });
    }
    // 放在 OPEN_TAB 之后：OPEN_TAB 会写"已打开"提示，不能让刷新提示被覆盖
    if (outcome.reloaded) {
      deps.dispatch({
        type: 'NOTICE',
        message: '检测到磁盘已被外部修改：已重新载入最新内容与版本',
      });
    }
  }

  return {
    async openNode(node, projectId) {
      if (node.kind === 'folder') {
        if (projectId) {
          deps.dispatch({ type: 'TOGGLE_PROJECT_NODE', projectId, path: node.id });
        } else {
          deps.dispatch({ type: 'TOGGLE_NODE', path: node.id });
        }
        return;
      }

      const targetProject = projectId ?? null;
      if (!isProjectOpenable(deps.getState().projects, targetProject)) {
        deps.dispatch({
          type: 'NOTICE',
          message: `项目${projectName(targetProject) ? ` ${projectName(targetProject)}` : ''}当前不可用：无法打开新的磁盘文件（既有标签与草稿仍保留）`,
        });
        return;
      }

      const path = node.path ?? node.id;
      const docId = makeDocId(targetProject, path);

      if (tabOf(docId)) {
        deps.dispatch({ type: 'ACTIVATE_TAB', docId });
        await refreshCleanTab(docId);
        return;
      }

      const mode = deps.getMode();
      const key = `${mode}::${docId}`;
      const running = inFlight.get(key);
      if (running) {
        // 合并在途请求：等它结束后只做激活，不再发第二个 open（否则必然多一个 View）
        await running.catch(() => undefined);
        if (tabOf(docId)) deps.dispatch({ type: 'ACTIVATE_TAB', docId });
        return;
      }

      const task = createTab(node, docId, targetProject, path, mode).finally(() => {
        if (inFlight.get(key) === task) inFlight.delete(key);
      });
      inFlight.set(key, task);
      await task;
    },

    noteLocalEdit(docId) {
      deps.editEpochs.bump(docId);
    },

    forget(docId) {
      deps.editEpochs.forget(docId);
    },

    reset() {
      deps.editEpochs.clear();
    },

    pendingOpens() {
      return inFlight.size;
    },
  };
}

/** 便捷构造：基于 ref 的编辑代次实现（Provider 与测试共用）。 */
export function createEditEpochs(): EditEpochs {
  const epochs = new Map<string, number>();
  return {
    of(docId) {
      return epochs.get(docId) ?? 0;
    },
    bump(docId) {
      const next = (epochs.get(docId) ?? 0) + 1;
      epochs.set(docId, next);
      return next;
    },
    forget(docId) {
      epochs.delete(docId);
    },
    clear() {
      epochs.clear();
    },
  };
}

/** 归属比对的便捷包装：调用方只需要提供"当前标签"。 */
export function isSameTab(
  docId: string,
  captured: { projectId: string | null; sessionId: string | null },
  tab: DocTab | undefined,
): boolean {
  return isResponseOwnerCurrent(
    { projectId: captured.projectId, docId, sessionId: captured.sessionId },
    {
      projectId: tab?.projectId ?? null,
      docId: tab?.docId ?? '',
      sessionId: tab?.sessionId ?? null,
      exists: Boolean(tab),
    },
  );
}
