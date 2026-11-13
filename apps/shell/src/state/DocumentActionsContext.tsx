/**
 * 文档操作编排（S9-B / G2）。
 *
 * 职责边界：
 * - UI 组件只调用本 hook 暴露的动作，不直接 fetch、不直接改 Core 状态；
 * - **Core 是会话、revision、baseVersion 与保存结果的权威**：这里只转发并展示，不推断；
 * - demo 模式的"保存"返回 `DEMO`，明确不是真实写入；
 * - live 模式的编辑经串行队列提交（见 client/edit-queue.ts），保存前先 flush；
 * - 关闭未保存的 live 会话直接拒绝（暂无安全 discard 契约，不虚构成功）。
 *
 * 多项目（G2）：
 * - 文档 id 由 `makeDocId(projectId, path)` 生成，A/a.md 与 B/a.md 是不同文档；
 * - 队列 / 保存锁 / 草稿备份键全部按该 id 索引，项目之间互不影响；
 * - 每个异步动作在发起时**固定捕获** `{ projectId, docId, sessionId }`，
 *   响应回来先比对归属，过期回填一律丢弃（G2-10）；
 * - 项目切换只改"当前项目"，不清标签、不清队列、不丢草稿。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import {
  createDemoClient,
  createLiveClient,
  type WeaveSpaceClient,
} from '../client/client-api';
import { createEditQueue, flushLatest, type EditQueue } from '../client/edit-queue';
import { backupDraftBeforeReload } from '../client/draft-backup';
import { runSaveFlow } from '../client/save-flow';
import { DEMO_CONTENTS, DEMO_NODES } from '../data/demo-project';
import { installBeforeUnloadGuard, needsLeaveGuard } from './beforeunload-guard';
import { draftBackupKey, hasUnsavedDrafts, isResponseOwnerCurrent } from './doc-identity';
import { createDocumentOpener, createEditEpochs, type DocumentOpener } from './open-document';
import { createWorkspaceAutosave, createWorkspaceStore, serializeWorkspace } from './workspace-persistence';
import { countFiles, loadProjectResources, loadWorkspace } from './workspace-load';
import { createWorkspaceRestorer, type RestoreReport } from './workspace-restore';
import { useWorkspace } from './WorkspaceContext';
import type { ClientMode, DocTab, ResourceNodeState } from './types';

export interface DocumentActions {
  /** 打开（或复用）会话节点。Multi 必须给 projectId。 */
  openNode(node: ResourceNodeState, projectId?: string | null): Promise<void>;
  /** 提交一次编辑：本地即时生效，live 模式下按序同步到 Core。 */
  editDoc(docId: string, text: string): void;
  /** 保存：demo 只清标记；live 先 flush 编辑再条件保存。 */
  saveTab(docId: string): Promise<void>;
  /** 关闭标签：live 下未保存则拒绝，并关闭服务端视图。 */
  closeTab(docId: string): Promise<void>;
  /** 切换 demo/live；有未保存修改时拒绝。 */
  switchMode(mode: ClientMode): Promise<void>;
  /** 重新拉取资源：Multi 只刷新指定项目，Legacy 刷新单项目树。 */
  reloadResources(projectId?: string): Promise<void>;
  /** 切换"当前项目"：只改焦点，不动标签 / 队列 / 草稿。 */
  switchProject(projectId: string): Promise<void>;
  /** 只读查看磁盘当前内容（冲突恢复第一步）。 */
  fetchDiskVersion(docId: string): Promise<
    { ok: true; content: string; contentVersion: string } | { ok: false; errorCode: string | null; message?: string }
  >;
  /**
   * 启动恢复（S11-C）：幂等，重复调用不会再发一次请求。
   * 没有本地记录时直接返回 null，不改变现有的 demo 启动行为。
   */
  restoreWorkspace(): Promise<RestoreReport | null>;
  /** 把当前草稿复制到剪贴板（尽力而为，失败返回 false）。 */
  copyDraft(docId: string): Promise<boolean>;
  /**
   * 用磁盘内容覆盖会话（冲突恢复）。**必须由用户明确确认**后才调用；
   * 调用前会把草稿备份到本标签页并在可能时复制到剪贴板。
   */
  reloadFromDisk(docId: string): Promise<boolean>;
}

const DocumentActionsContext = createContext<DocumentActions | null>(null);

/** 冲突重载前的草稿备份前缀：只写 sessionStorage，不落任何用户目录。 */
const DRAFT_BACKUP_PREFIX = 'ws:draft-backup:';

function backupDraftLocally(projectId: string | null, path: string, content: string): boolean {
  try {
    window.sessionStorage.setItem(`${DRAFT_BACKUP_PREFIX}${draftBackupKey(projectId, path)}`, content);
    return true;
  } catch {
    return false;
  }
}

/** 尽力复制到剪贴板；无权限/无 API 时返回 false（由调用方提示用户手动复制）。 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * localStorage 的**安全包装**（S11-C）。
 *
 * 隐私模式/策略禁用时访问 `localStorage` 本身就会抛异常，因此在构造阶段就吞掉，
 * 交给 `createWorkspaceStore` 统一降级：存储不可用只是不持久化，编辑与保存照常。
 */
function safeLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function DocumentActionsProvider({ children }: { children: ReactNode }) {
  const { state, dispatch } = useWorkspace();

  const demoClient = useMemo(() => createDemoClient(DEMO_NODES, DEMO_CONTENTS), []);
  const liveClient = useMemo(() => createLiveClient(), []);
  /**
   * 取客户端必须按**目标模式**，不能读 `state.mode` 的当前值：
   * 切换模式的同一次回调里 state 还是旧值，用旧客户端会把演示数据当成 live 资源。
   */
  const clientFor = (mode: ClientMode): WeaveSpaceClient =>
    mode === 'live' ? liveClient : demoClient;

  // 回调里读取"最新"状态，避免闭包拿到过期快照
  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * 模式的同步镜像：`switchMode` 里 dispatch 之后 state 仍然是旧值，
   * 而在途的 HTTP 响应可能在那之后立刻返回——必须有一个同步可读的模式。
   */
  const modeRef = useRef<ClientMode>(state.mode);
  modeRef.current = state.mode;

  /** 本地编辑代次（G2-R1）：用于判断"磁盘读取期间用户是否又改了内容"。 */
  const edits = useRef(createEditEpochs());

  /**
   * 打开流程的编排器（G2-R1）：真实实现放在 `open-document.ts`，
   * 这里只注入宿主依赖，便于在 Node 里用真实 Host + reducer 验证时序。
   */
  const opener = useMemo<DocumentOpener>(
    () =>
      createDocumentOpener({
        getState: () => stateRef.current,
        getMode: () => modeRef.current,
        dispatch,
        clientFor,
        editEpochs: edits.current,
      }),
    [dispatch, demoClient, liveClient],
  );

  /**
   * 工作区持久化（S11-C）。
   *
   * 存储、恢复、节流写入都在纯 TS 模块里，这里只负责装配：
   * - `store`：localStorage 的安全包装（不可用就整体降级）；
   * - `connectLive`：连接 Host 并加载项目/资源，同时拿到工作区摘要；
   * - `restorer`：分阶段恢复，标签一律后台登记；
   * - `autosave`：界面变化合并写入，离开页面前同步 flush。
   */
  const store = useMemo(() => createWorkspaceStore(safeLocalStorage()), []);

  /** 进入 live 并加载工作区；失败（Host 不在线）返回 null，由调用方决定如何降级。 */
  const connectWorkspace = useCallback(async () => {
    // 先探测 Host：连不上就**不要**把界面切进 live（否则会显示"真实文件"却空空如也）
    const probe = await liveClient.workspaceIdentity().catch(() => null);
    if (!probe) {
      dispatch({
        type: 'NOTICE',
        message: '无法连接本地服务：请先启动 apps/server（npm run start:server）',
      });
      return null;
    }
    if (modeRef.current !== 'live') {
      // 与 switchMode 一致：先同步模式，再派发，避免在途响应读到旧模式
      modeRef.current = 'live';
      dispatch({ type: 'SET_MODE', mode: 'live' });
    }
    const loaded = await loadWorkspace({
      getState: () => stateRef.current,
      dispatch,
      clientFor: (mode) => (mode === 'live' ? liveClient : demoClient),
    });
    return loaded ? { workspaceKey: loaded.workspaceKey, workspaceMode: loaded.workspaceMode } : null;
  }, [dispatch, demoClient, liveClient]);

  const restorer = useMemo(
    () =>
      createWorkspaceRestorer({
        getState: () => stateRef.current,
        getMode: () => modeRef.current,
        dispatch,
        store,
        connectLive: connectWorkspace,
        openInBackground: (node, projectId) =>
          opener.openNode(node, projectId, { background: true }),
      }),
    [connectWorkspace, dispatch, opener, store],
  );

  const autosave = useMemo(
    () =>
      createWorkspaceAutosave({
        store,
        // 只在"已连接工作区"时才产出快照（serialize 自己也会拒绝 demo / 无摘要）
        snapshot: () =>
          serializeWorkspace(stateRef.current, { workspaceKey: stateRef.current.workspaceKey }),
      }),
    [store],
  );

  /**
   * 启动恢复：只有存在本地记录时才尝试连 Host。
   *
   * 没有记录 → 完全保持原来的 demo 启动路径（不自动连 Host、不改界面）。
   * 用 ref 保证 StrictMode 的二次 effect 不会重复执行（重复也不会多建 View，见套件 33）。
   */
  const bootStarted = useRef(false);
  useEffect(() => {
    if (bootStarted.current) return;
    bootStarted.current = true;
    if (!store.readLast()) return;
    void restorer.restore();
  }, [restorer, store]);

  // 界面变化 → 合并写入（拖动分屏等高频变化不会每次都写）
  useEffect(() => {
    autosave.schedule();
  }, [state, autosave]);

  // 离开页面前：同步落盘 + 有未确认内容时弹浏览器原生提醒
  useEffect(() => {
    const flush = (): void => {
      autosave.flush();
    };
    const uninstall = installBeforeUnloadGuard(window, () => needsLeaveGuard(stateRef.current.tabs));
    window.addEventListener('pagehide', flush);
    return () => {
      uninstall();
      window.removeEventListener('pagehide', flush);
    };
  }, [autosave]);

  const queues = useRef(new Map<string, EditQueue>());

  /**
   * 保存期间锁定的文档（F02）。用 ref 而不是 React 状态做判定：
   * `saving` 的渲染更新是异步的，不能作为「是否允许继续改 / 继续保存」的唯一依据。
   */
  const locked = useRef(new Set<string>());

  /** 幂等地解除保存锁，并确保 `saving` 一定回到 false。 */
  const unlocked = (docId: string): void => {
    locked.current.delete(docId);
    dispatch({ type: 'TAB_PATCH', docId, patch: { saving: false } });
  };

  const actions = useMemo<DocumentActions>(() => {
    const tabOf = (docId: string): DocTab | undefined =>
      stateRef.current.tabs.find((tab) => tab.docId === docId);

    /** 资源加载的依赖（与恢复流程共用同一份实现，避免两套加载逻辑）。 */
    const loadDeps = {
      getState: () => stateRef.current,
      dispatch,
      clientFor: (target: ClientMode) => (target === 'live' ? liveClient : demoClient),
    };

    /** Multi：按项目取资源树（Legacy 用单树）。 */
    const projectName = (projectId: string | null): string | null => {
      if (!projectId) return null;
      return (
        stateRef.current.projects.find((project) => project.projectId === projectId)?.name ??
        projectId
      );
    };

    /**
     * 编辑队列：索引为项目限定的 docId。
     * `sessionId` / `viewId` / `projectId` 在创建时固定，之后不随 state 漂移——
     * 项目切换或重新打开都不会把已发出的请求改投到别的会话。
     */
    const queueFor = (
      docId: string,
      sessionId: string,
      projectId: string | null,
      viewId: string | null,
    ): EditQueue => {
      const existing = queues.current.get(docId);
      if (existing) return existing;
      const queue = createEditQueue<unknown>(async (text: string) => {
        const current = tabOf(docId);
        const outcome = await clientFor(current?.mode ?? stateRef.current.mode).applyEdit(
          sessionId,
          text,
          current?.baseVersion ?? null,
          viewId,
        );
        if (outcome.status !== 'APPLIED' || !outcome.document) {
          dispatch({
            type: 'NOTICE',
            message: `编辑未被接受：${outcome.errorCode ?? '未知错误'}（Core 缓冲落后于编辑器，已阻止保存）`,
          });
          // 必须抛错：队列据此记住「最后一次同步失败」，保存流程才不会把旧内容当成草稿写盘
          throw Object.assign(new Error(`applyEdit 被拒绝: ${outcome.errorCode ?? 'unknown'}`), {
            errorCode: outcome.errorCode ?? 'ERR_EDIT_REJECTED',
          });
        }
        // 只回写 Core 的 revision/状态，**不回写内容**：编辑器永远以用户输入为准
        const latest = tabOf(docId);
        const owned = isResponseOwnerCurrent(
          { projectId, docId, sessionId },
          {
            projectId: latest?.projectId ?? null,
            docId: latest?.docId ?? '',
            sessionId: latest?.sessionId ?? null,
            exists: Boolean(latest),
          },
        );
        if (latest && owned && outcome.document.revision >= latest.revision) {
          dispatch({
            type: 'TAB_PATCH',
            docId,
            patch: {
              revision: outcome.document.revision,
              documentState: outcome.document.documentState,
            },
          });
        }
      });
      queues.current.set(docId, queue);
      return queue;
    };

    return {
      async openNode(node: ResourceNodeState, projectId?: string | null) {
        // 用户主动打开：恢复流程不得再把窗格指回旧位置（S11-C）
        restorer.noteInteraction();
        // 打开/刷新/并发/模式切换的全部时序处理都在 open-document.ts：
        // 这里只转发，避免把异步归属判定散落在组件里（G2-R1）。
        await opener.openNode(node, projectId);
      },

      async restoreWorkspace() {
        // 没有记录时什么都不做，避免在纯 demo 启动里凭空连 Host
        if (!store.readLast()) return null;
        return restorer.restore();
      },

      editDoc(docId: string, text: string) {
        const tab = tabOf(docId);
        if (!tab) return;
        // 保存期间的输入一律丢弃：Core 正在比较版本，不能让缓冲在保存途中继续变化
        if (locked.current.has(docId)) return;
        // 本地编辑代次（G2-R1）：任何在途的磁盘读取都在此作废，避免旧内容覆盖草稿
        opener.noteLocalEdit(docId);
        restorer.noteInteraction();
        dispatch({ type: 'EDIT_DOC', docId, text });
        if (tab.mode !== 'live' || !tab.sessionId) return;
        queueFor(docId, tab.sessionId, tab.projectId, tab.viewId).schedule(text);
      },

      async saveTab(docId: string) {
        const tab = tabOf(docId);
        if (!tab) return;
        // 用 ref 判定（而不是 tab.saving）：后者要等一次渲染才更新
        if (locked.current.has(docId)) {
          dispatch({ type: 'NOTICE', message: '正在保存中，请稍候' });
          return;
        }

        const mode = tab.mode;
        const client = clientFor(mode);
        locked.current.add(docId);
        dispatch({ type: 'TAB_PATCH', docId, patch: { saving: true } });

        try {
          if (mode === 'demo') {
            const outcome = await client.saveDocument(tab.sessionId ?? '', '');
            dispatch({
              type: 'SAVE_RESULT',
              docId,
              status: 'DEMO',
              errorCode: null,
              dirty: false,
              documentState: 'DEMO',
              baseVersion: outcome.contentVersion ?? tab.baseVersion,
              revision: null,
              notice: '演示保存：仅清除未保存标记，没有写入任何磁盘文件',
            });
            return;
          }

          if (!tab.sessionId || !tab.baseVersion) {
            dispatch({ type: 'NOTICE', message: '缺少版本基线（会话未成功建立），无法保存' });
            return;
          }

          const sessionId = tab.sessionId;
          const buffer = tab.buffer;
          const queue = queues.current.get(docId);

          // 保存前的门禁：草稿必须已同步到 Core，否则不发起写盘（F01）
          const result = await runSaveFlow({
            buffer,
            sync: async () =>
              queue
                ? flushLatest(queue, buffer)
                : { ok: true as const, lastSynced: buffer },
            commit: () => {
              const latest = tabOf(docId);
              return client.saveDocument(
                sessionId,
                latest?.baseVersion ?? (tab.baseVersion as string),
                latest?.viewId ?? tab.viewId,
              );
            },
          });

          dispatch({
            type: 'SAVE_RESULT',
            docId,
            status: result.status,
            errorCode: result.errorCode,
            dirty: result.dirty,
            documentState: result.documentState,
            baseVersion: result.baseVersion,
            revision: result.revision,
            // 项目级失败（根失效/会话失效）时服务端可能不带正文：
            // 这里**从不**用保存响应覆盖 buffer，因此缺失 content 不会清空草稿。
            notice: result.notice,
          });
        } catch {
          // 兜底：任何未预期异常都必须收敛为 UNKNOWN，且保留草稿（绝不留下永久 SAVING）
          dispatch({
            type: 'SAVE_RESULT',
            docId,
            status: 'UNKNOWN',
            errorCode: 'ERR_OUTCOME_UNKNOWN',
            dirty: true,
            documentState: 'OUTCOME_UNKNOWN',
            baseVersion: null,
            revision: null,
            notice: '保存流程异常：结果未确认，草稿已保留',
          });
        } finally {
          unlocked(docId);
        }
      },

      async closeTab(docId: string) {
        const tab = tabOf(docId);
        if (!tab) return;
        if (tab.saving) {
          dispatch({ type: 'NOTICE', message: '正在保存中，暂时不能关闭' });
          return;
        }
        // live：未保存就拒绝关闭（没有 discard 契约，不虚构成功）
        if (tab.dirty && tab.mode === 'live') {
          dispatch({
            type: 'NOTICE',
            message: '该标签有未保存的真实文件修改：请先保存（暂不支持丢弃）',
          });
          return;
        }
        if (tab.dirty && tab.mode === 'demo') {
          if (!window.confirm('该标签有未保存的演示修改，仍要关闭吗？')) return;
        }

        if (tab.mode === 'live' && tab.sessionId && tab.viewId) {
          await queues.current.get(docId)?.flush();
          // 只关闭**本标签自己的** viewId；其他标签（含其他项目的同名文件）不受影响
          const outcome = await clientFor('live').closeDocument(tab.sessionId, tab.viewId);
          if (outcome.status !== 'APPLIED') {
            dispatch({
              type: 'NOTICE',
              message: `关闭被拒绝：${outcome.errorCode ?? outcome.message ?? '未知原因'}`,
            });
            return;
          }
        }

        queues.current.delete(docId);
        opener.forget(docId);
        restorer.noteInteraction();
        dispatch({ type: 'CLOSE_TAB', docId });
      },

      async switchMode(mode: ClientMode) {
        if (mode === stateRef.current.mode) return;
        // 未保存草稿阻止切换：语义与之前完全一致，只是判定抽成可测的纯函数
        if (hasUnsavedDrafts(stateRef.current.tabs)) {
          dispatch({ type: 'NOTICE', message: '有未保存修改，已阻止切换模式（请先保存）' });
          return;
        }
        // 尽量收回服务端视图，避免 live 会话在后台悬挂
        for (const tab of stateRef.current.tabs) {
          if (tab.mode === 'live' && tab.sessionId && tab.viewId) {
            await clientFor('live').closeDocument(tab.sessionId, tab.viewId).catch(() => undefined);
          }
        }
        queues.current.clear();
        locked.current.clear();
        // 先同步模式，再派发：在途的打开/读取响应据此判定"已不属于当前工作区"
        modeRef.current = mode;
        opener.reset();
        restorer.noteInteraction();
        dispatch({ type: 'SET_MODE', mode });
        if (mode === 'live') {
          await loadWorkspace({
            getState: () => stateRef.current,
            dispatch,
            clientFor: (target) => (target === 'live' ? liveClient : demoClient),
          });
        }
      },

      async reloadResources(projectId?: string) {
        if (stateRef.current.mode !== 'live') return;
        if (projectId) {
          // 只刷新指定项目，绝不覆盖其他项目的资源树（G2-01）
          const ok = await loadProjectResources(loadDeps, projectId);
          if (ok) {
            dispatch({
              type: 'NOTICE',
              message: `已刷新项目 ${projectName(projectId) ?? projectId} 的文件树`,
            });
          }
          return;
        }
        if (stateRef.current.workspaceMode === 'multi') {
          // 未指定项目：只刷新当前项目，避免把别的项目一起重写
          const active = stateRef.current.activeProjectId;
          if (active) {
            await loadProjectResources(loadDeps, active);
            dispatch({
              type: 'NOTICE',
              message: `已刷新项目 ${projectName(active) ?? active} 的文件树`,
            });
          }
          return;
        }
        dispatch({ type: 'SET_LOADING_RESOURCES', loading: true });
        try {
          const nodes = await clientFor('live').listResources();
          dispatch({ type: 'SET_RESOURCES', nodes });
          dispatch({ type: 'NOTICE', message: `已刷新资源树（${countFiles(nodes)} 个文件）` });
        } catch {
          dispatch({ type: 'NOTICE', message: '刷新失败：无法连接本地服务' });
        } finally {
          dispatch({ type: 'SET_LOADING_RESOURCES', loading: false });
        }
      },

      async switchProject(projectId: string) {
        const project = stateRef.current.projects.find((item) => item.projectId === projectId);
        if (!project) return;
        // 只改活动项目：不清空标签、不清队列、不丢草稿（G2-05/G2-07）
        restorer.noteInteraction();
        dispatch({ type: 'SET_ACTIVE_PROJECT', projectId });
        if (project.status !== 'READY') {
          dispatch({
            type: 'NOTICE',
            message: `项目 ${project.name} 不可用${project.reason ? `（${project.reason}）` : ''}：既有标签与草稿仍保留`,
          });
          return;
        }
        if ((stateRef.current.resourcesByProject[projectId] ?? []).length === 0) {
          await loadProjectResources(loadDeps, projectId);
        }
        dispatch({ type: 'NOTICE', message: `已切换到项目 ${project.name}` });
      },

      async fetchDiskVersion(docId: string) {
        const tab = tabOf(docId);
        if (!tab || tab.mode !== 'live' || !tab.sessionId) {
          return { ok: false as const, errorCode: 'ERR_DOCUMENT_NOT_FOUND' };
        }
        try {
          const disk = await clientFor('live').readDisk(tab.sessionId, tab.viewId);
          if (disk.status !== 'APPLIED') {
            return { ok: false as const, errorCode: disk.errorCode ?? null, message: disk.message };
          }
          return { ok: true as const, content: disk.content, contentVersion: disk.contentVersion };
        } catch {
          return { ok: false as const, errorCode: 'ERR_STORAGE_IO' };
        }
      },

      async copyDraft(docId: string) {
        const tab = tabOf(docId);
        if (!tab) return false;
        const copied = await copyText(tab.buffer);
        const backedUp = backupDraftLocally(tab.projectId, tab.path, tab.buffer);
        dispatch({
          type: 'NOTICE',
          message: copied
            ? '草稿已复制到剪贴板'
            : backedUp
              ? '剪贴板不可用：草稿已备份到本标签页（ws:draft-backup）'
              : '剪贴板不可用，且备份失败：请手动复制草稿',
        });
        return copied;
      },

      async reloadFromDisk(docId: string) {
        const tab = tabOf(docId);
        if (!tab || tab.mode !== 'live') return false;
        if (!tab.sessionId || !tab.viewId) {
          dispatch({ type: 'NOTICE', message: '缺少会话信息，无法重新加载' });
          return false;
        }
        if (locked.current.has(docId)) {
          dispatch({ type: 'NOTICE', message: '当前文档正在保存/重载中，请稍候' });
          return false;
        }

        // 明确确认：默认取消，只有用户点「确定」才丢弃草稿
        const confirmed = window.confirm(
          '将用磁盘上的最新内容覆盖当前草稿，未保存的修改会丢失。\n\n建议先点「复制草稿」。确定继续？',
        );
        if (!confirmed) {
          dispatch({ type: 'NOTICE', message: '已取消重新加载：草稿保持不变' });
          return false;
        }

        locked.current.add(docId);
        dispatch({ type: 'TAB_PATCH', docId, patch: { saving: true } });
        try {
          // 先让在途编辑落定，避免重载后又被旧缓冲覆盖
          await queues.current.get(docId)?.flush();
          const draft = tabOf(docId)?.buffer ?? tab.buffer;
          const sessionId = tab.sessionId;
          const viewId = tab.viewId;

          // F03：先备份，再重载；两种备份都失败时不发起重载（草稿原样保留）
          const backup = await backupDraftBeforeReload(draft, {
            saveLocal: (content) => backupDraftLocally(tab.projectId, tab.path, content),
            copy: (content) => copyText(content),
            reload: async () => {
              const outcome = await clientFor('live').reloadDocument(sessionId, viewId);
              if (outcome.status !== 'APPLIED' || !outcome.document) {
                dispatch({
                  type: 'NOTICE',
                  message: `重新加载失败：${outcome.errorCode ?? '未知错误'}（草稿仍保留）`,
                });
                return false;
              }
              const doc = outcome.document;
              queues.current.delete(docId);
              dispatch({
                type: 'TAB_PATCH',
                docId,
                patch: {
                  buffer: doc.content,
                  baseVersion: doc.baseVersion,
                  revision: doc.revision,
                  dirty: false,
                  documentState: doc.documentState,
                  errorCode: null,
                  lastStatus: null,
                },
              });
              return true;
            },
          });

          if (!backup.ok) {
            dispatch({
              type: 'NOTICE',
              message: '草稿备份失败（剪贴板与本标签页都不可用）：请先手动复制草稿，再重新加载',
            });
            return false;
          }
          if (!backup.reloaded) return false;

          dispatch({
            type: 'NOTICE',
            message: backup.clipboard
              ? '已从磁盘重新加载（旧草稿已复制到剪贴板）'
              : '已从磁盘重新加载（旧草稿已备份到本标签页）',
          });
          return true;
        } catch {
          dispatch({ type: 'NOTICE', message: '重新加载失败（网络异常），草稿仍保留' });
          return false;
        } finally {
          unlocked(docId);
        }
      },
    };
  }, [dispatch, demoClient, liveClient, opener, restorer, store]);

  return (
    <DocumentActionsContext.Provider value={actions}>{children}</DocumentActionsContext.Provider>
  );
}

export function useDocumentActions(): DocumentActions {
  const value = useContext(DocumentActionsContext);
  if (!value) throw new Error('useDocumentActions 必须在 DocumentActionsProvider 内使用');
  return value;
}
