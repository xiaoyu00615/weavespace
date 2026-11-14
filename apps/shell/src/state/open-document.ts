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
  /**
   * 打开（或激活并刷新）一个节点。
   *
   * `options.background`（S11-C）：只登记标签，**绝不**改动当前窗格与焦点，
   * 也不去刷新一个已经存在的标签。启动恢复走的就是这条路——恢复不是用户点击。
   */
  openNode(
    node: ResourceNodeState,
    projectId?: string | null,
    options?: OpenNodeOptions,
  ): Promise<OpenNodeResult>;
  /**
   * 手动刷新的**文档部分**（S11-UX-01A）：检查该项目下已打开文档的磁盘变化。
   *
   * 只做"检查 + 安全同步干净标签 + 报告有草稿的文件"，绝不丢草稿、绝不自动 reload。
   */
  refreshOpenTabs(projectId: string | null): Promise<OpenTabsRefreshReport>;
  /** 本地编辑发生：推进代次，使在途的磁盘读取失效。 */
  noteLocalEdit(docId: string): void;
  /** 标签关闭：丢弃该文档的编辑代次。 */
  forget(docId: string): void;
  /** 切换工作区：所有在途读取与代次都作废。 */
  reset(): void;
  /** 当前在途打开数（诊断/测试用）。 */
  pendingOpens(): number;
}

/** 一次"刷新项目"在文档层面的结果（UI 只据此拼提示，不据此改状态）。 */
export interface OpenTabsRefreshReport {
  projectId: string | null;
  /** 实际检查过的文档数（有会话、可读磁盘）。 */
  checked: number;
  /** 已安全同步的干净标签数。 */
  updated: number;
  /** 有未保存草稿、但磁盘已变更的文档路径（只提示，**不改标签**）。 */
  dirtyChanged: string[];
  /** 无法检查（磁盘删除 / 权限 / Host 不可用）的文档路径。 */
  failed: string[];
}

export interface OpenNodeOptions {
  /** true：只登记标签（后台），不激活、不刷新既有标签。 */
  background?: boolean;
}

/** 打开结果：恢复流程需要"成功了没有、是哪个 docId"，普通调用方可以忽略。 */
export type OpenNodeResult =
  | { ok: true; docId: string; reopened: boolean; dirty: boolean }
  | { ok: false; docId: string; errorCode: string | null };

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

/**
 * 用户"正在看什么"的快照（G2-R2）。
 *
 * 只有项目、焦点窗格、活动文档三者都没变，才说明用户仍然期望把新打开的文档
 * 设为当前文档；任何一项变了，迟到的响应就只能后台登记标签。
 */
interface FocusSnapshot {
  projectId: string | null;
  pane: WorkspaceState['focusedPane'];
  docId: string | null;
}

function captureFocus(state: WorkspaceState): FocusSnapshot {
  return {
    projectId: state.activeProjectId,
    pane: state.focusedPane,
    docId: state.panes[state.focusedPane]?.docId ?? null,
  };
}

function canActivate(focus: FocusSnapshot, state: WorkspaceState): boolean {
  if (state.activeProjectId !== focus.projectId) return false;
  if (state.focusedPane !== focus.pane) return false;
  return (state.panes[state.focusedPane]?.docId ?? null) === focus.docId;
}

/** 单个标签刷新的结果；`skipped` 表示"这次不该动它"（有草稿 / 已在刷新 / 已关闭）。 */
export type TabRefreshOutcome = 'updated' | 'unchanged' | 'skipped' | 'failed';

/**
 * 一段磁盘是否相对标签基线发生变化。
 *
 * 有草稿时必须比 `baseVersion` 而不是 `buffer`：用户一改动，buffer 就与磁盘不同，
 * 拿 buffer 比会把"自己改的"误报成"外部改的"。
 */
function diskChangedAgainst(
  tab: DocTab,
  disk: { content: string; contentVersion: string },
): boolean {
  if (tab.baseVersion) return disk.contentVersion !== tab.baseVersion;
  return disk.content !== tab.buffer;
}

export function createDocumentOpener(deps: OpenDocumentDeps): DocumentOpener {
  /** 同一 (模式, 文档) 的并发打开合并为一次请求：不会各自在服务端造一个 View。 */
  const inFlight = new Map<string, Promise<OpenNodeResult>>();
  /** 正在刷新的文档：连续点击刷新时让位，避免重复建临时 View。 */
  const refreshing = new Set<string>();

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
   *
   * 返回结果供"刷新整个项目"聚合提示用；单次点击可以忽略。
   */
  async function refreshCleanTab(docId: string): Promise<TabRefreshOutcome> {
    const tab = tabOf(docId);
    // 有草稿就不刷新：Core 也不会在 dirty 时刷新，回填只会覆盖输入（既有行为）
    if (!tab || tab.mode !== 'live' || tab.dirty || !tab.sessionId || !tab.viewId) return 'skipped';
    // 同一文档已在刷新中：第二次点击直接让位，避免重复建临时 View
    if (refreshing.has(docId)) return 'skipped';
    refreshing.add(docId);

    try {
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
        return 'failed';
      }

      const tempSessionId = outcome.document?.sessionId ?? null;
      const tempViewId = outcome.document?.viewId ?? null;

      try {
        if (outcome.status !== 'APPLIED' || !outcome.document) return 'failed';
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

        if (!allowed) {
          // 期间发生了编辑 / 保存 / 关闭 / 切模式：这次读取已过期，宁可丢弃也不回写
          return latest ? 'unchanged' : 'skipped';
        }

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
        return 'updated';
      } finally {
        // 临时 View 必须在所有分支释放（成功、失败、标签已关闭都算）
        await releaseView(client, tempSessionId, tempViewId, tab.viewId);
      }
    } finally {
      refreshing.delete(docId);
    }
  }

  /** 单项目刷新结果之上的聚合提示由调用方（Provider）负责，这里只报事实。 */
  async function refreshOpenTabsInternal(projectId: string | null): Promise<OpenTabsRefreshReport> {
    const report: OpenTabsRefreshReport = {
      projectId,
      checked: 0,
      updated: 0,
      dirtyChanged: [],
      failed: [],
    };

    // 快照目标：刷新期间新开 / 关闭的标签不参与本轮（每个 docId 仍在循环内重新校验）
    const targets = deps
      .getState()
      .tabs.filter((tab) => tab.mode === 'live' && tab.projectId === projectId)
      .map((tab) => tab.docId);

    for (const docId of targets) {
      // 用户已切走工作区：剩下的检查都属于上一个工作区，连请求都不该再发
      if (deps.getMode() !== 'live') break;

      const tab = tabOf(docId);
      // 期间被关闭 / 会话没建立：跳过，绝不复活也不凭空造会话
      if (!tab || tab.mode !== 'live' || tab.projectId !== projectId) continue;
      if (!tab.sessionId || !tab.viewId) {
        report.failed.push(tab.path);
        continue;
      }

      report.checked += 1;

      // 先只读检查：无论干净还是有草稿，都不写盘、不动会话
      const capturedBaseVersion = tab.baseVersion;
      let disk: { content: string; contentVersion: string };
      try {
        const outcome = await deps.clientFor('live').readDisk(tab.sessionId, tab.viewId);
        if (outcome.status !== 'APPLIED') {
          report.failed.push(tab.path);
          continue;
        }
        disk = { content: outcome.content, contentVersion: outcome.contentVersion };
      } catch {
        report.failed.push(tab.path);
        continue;
      }

      // 期间用户改了 / 存了 / 关了：这次读取已过期，不再据此决策
      const stillThere = tabOf(docId);
      if (!stillThere || stillThere.sessionId !== tab.sessionId) continue;
      // 读取期间用户保存/重载推进了基线：快照对应的是**保存前**的磁盘，
      // 拿它与新基线比较只会得出一份不存在的"外部修改"（还会白建一个临时 View）
      if ((stillThere.baseVersion ?? null) !== (capturedBaseVersion ?? null)) continue;

      if (!diskChangedAgainst(stillThere, disk)) continue;

      if (stillThere.dirty) {
        // 有草稿：只报告"外部改过"，绝不自动 reload（那会丢掉草稿）
        report.dirtyChanged.push(stillThere.path);
        continue;
      }

      // 干净标签：复用既有安全回填路径（内部还有 canApplyDiskRefresh 二次把关）
      const outcome = await refreshCleanTab(docId);
      if (outcome === 'updated') report.updated += 1;
      else if (outcome === 'failed') report.failed.push(tab.path);
    }

    return report;
  }

  async function createTab(
    node: ResourceNodeState,
    docId: string,
    projectId: string | null,
    path: string,
    mode: ClientMode,
    background: boolean,
  ): Promise<OpenNodeResult> {
    const client = deps.clientFor(mode);
    const before = deps.getState();
    const focus = captureFocus(before);
    deps.dispatch({ type: 'NOTICE', message: `正在打开 ${node.name} …` });

    let outcome;
    try {
      outcome = await client.openDocument(path, projectId ?? undefined);
    } catch {
      deps.dispatch({ type: 'NOTICE', message: `无法打开 ${node.name}：无法连接本地服务` });
      return { ok: false, docId, errorCode: 'ERR_STORAGE_IO' };
    }

    // 模式已切换（G2-R1）：这次结果属于上一个工作区，绝不能插进当前工作区。
    // 新建的 View 必须释放，否则会在服务端留下无人管理的会话视图。
    if (deps.getMode() !== mode) {
      await releaseView(
        client,
        outcome.document?.sessionId ?? null,
        outcome.document?.viewId ?? null,
      );
      return { ok: false, docId, errorCode: 'ERR_MODE_CHANGED' };
    }

    if (outcome.status !== 'APPLIED' || !outcome.document) {
      deps.dispatch({
        type: 'NOTICE',
        message: `无法打开 ${node.name}：${outcome.errorCode ?? '未知错误'}`,
      });
      return { ok: false, docId, errorCode: outcome.errorCode ?? null };
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
      // 后台模式（恢复）不得因此把焦点拉过去
      if (!background) deps.dispatch({ type: 'ACTIVATE_TAB', docId });
      return { ok: true, docId, reopened: true, dirty: raced.dirty };
    }

    const tab = tabFromSnapshot(
      docId,
      projectId,
      node.name,
      node.extension ?? extensionOfPath(node.name),
      mode,
      outcome.document,
    );

    // 用户在这期间换了项目 / 窗格 / 活动文档：只后台登记标签，绝不改动当前焦点
    // （G2-R2）。这同时覆盖"旧实现把焦点还原成发起时那个文档"的错误行为。
    // 恢复流程（S11-C）则无条件走后台：它不是用户点击，没有"期望激活"可言。
    if (!background && canActivate(focus, deps.getState())) {
      deps.dispatch({ type: 'OPEN_TAB', tab });
    } else {
      deps.dispatch({ type: 'OPEN_TAB_BACKGROUND', tab });
    }
    if (projectId) {
      deps.dispatch({ type: 'SELECT_PROJECT_NODE', projectId, path: docId });
    }
    // 放在 OPEN_TAB 之后：OPEN_TAB 会写"已打开"提示，不能让刷新提示被覆盖
    if (outcome.reloaded) {
      deps.dispatch({
        type: 'NOTICE',
        message: '检测到磁盘已被外部修改：已重新载入最新内容与版本',
      });
    }
    return { ok: true, docId, reopened: false, dirty: tab.dirty };
  }

  return {
    async openNode(node, projectId, options) {
      const background = options?.background === true;
      if (node.kind === 'folder') {
        if (projectId) {
          deps.dispatch({ type: 'TOGGLE_PROJECT_NODE', projectId, path: node.id });
        } else {
          deps.dispatch({ type: 'TOGGLE_NODE', path: node.id });
        }
        return { ok: false, docId: node.id, errorCode: 'ERR_RESOURCE_NOT_FOUND' };
      }

      const targetProject = projectId ?? null;
      if (!isProjectOpenable(deps.getState().projects, targetProject)) {
        deps.dispatch({
          type: 'NOTICE',
          message: `项目${projectName(targetProject) ? ` ${projectName(targetProject)}` : ''}当前不可用：无法打开新的磁盘文件（既有标签与草稿仍保留）`,
        });
        return { ok: false, docId: '', errorCode: 'ERR_PROJECT_UNAVAILABLE' };
      }

      const path = node.path ?? node.id;
      const docId = makeDocId(targetProject, path);

      if (tabOf(docId)) {
        const existing = tabOf(docId) as DocTab;
        // 后台模式：既有标签不动（不刷新、不激活）——恢复不该打扰已经打开的东西
        if (background) {
          return { ok: true, docId, reopened: true, dirty: existing.dirty };
        }
        deps.dispatch({ type: 'ACTIVATE_TAB', docId });
        await refreshCleanTab(docId);
        return { ok: true, docId, reopened: true, dirty: existing.dirty };
      }

      const mode = deps.getMode();
      const key = `${mode}::${docId}`;
      const running = inFlight.get(key);
      if (running) {
        // 合并在途请求：等它结束后最多只做激活，不再发第二个 open（否则必然多一个 View）。
        // 等待期间用户可能已经切走，因此这里**同样**要按焦点快照判断（G2-R2）。
        const waitingFocus = captureFocus(deps.getState());
        await running.catch(() => undefined);
        const merged = tabOf(docId);
        if (merged && !background && canActivate(waitingFocus, deps.getState())) {
          deps.dispatch({ type: 'ACTIVATE_TAB', docId });
        }
        return merged
          ? { ok: true, docId, reopened: true, dirty: merged.dirty }
          : { ok: false, docId, errorCode: 'ERR_DOCUMENT_NOT_FOUND' };
      }

      const task = createTab(node, docId, targetProject, path, mode, background).finally(() => {
        if (inFlight.get(key) === task) inFlight.delete(key);
      });
      inFlight.set(key, task);
      return await task;
    },

    noteLocalEdit(docId) {
      deps.editEpochs.bump(docId);
    },

    async refreshOpenTabs(projectId) {
      return await refreshOpenTabsInternal(projectId);
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
