/**
 * 文档操作编排（S9-B）。
 *
 * 职责边界：
 * - UI 组件只调用本 hook 暴露的动作，不直接 fetch、不直接改 Core 状态；
 * - **Core 是会话、revision、baseVersion 与保存结果的权威**：这里只转发并展示，不推断；
 * - demo 模式的"保存"返回 `DEMO`，明确不是真实写入；
 * - live 模式的编辑经串行队列提交（见 client/edit-queue.ts），保存前先 flush；
 * - 关闭未保存的 live 会话直接拒绝（暂无安全 discard 契约，不虚构成功）。
 */
import { createContext, useContext, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import {
  createDemoClient,
  createLiveClient,
  type DocumentSnapshot,
  type WeaveSpaceClient,
} from '../client/client-api';
import { createEditQueue, type EditQueue } from '../client/edit-queue';
import { DEMO_CONTENTS, DEMO_NODES } from '../data/demo-project';
import { useWorkspace } from './WorkspaceContext';
import type { ClientMode, DocTab, ResourceNodeState } from './types';

export interface DocumentActions {
  /** 打开文件（live 走服务端 CommandBus；demo 走内置数据）。 */
  openNode(node: ResourceNodeState): Promise<void>;
  /** 提交一次编辑：本地即时生效，live 模式下按序同步到 Core。 */
  editDoc(docId: string, text: string): void;
  /** 保存：demo 只清标记；live 先 flush 编辑再条件保存。 */
  saveTab(docId: string): Promise<void>;
  /** 关闭标签：live 下未保存则拒绝，并关闭服务端视图。 */
  closeTab(docId: string): Promise<void>;
  /** 切换 demo/live；有未保存修改时拒绝。 */
  switchMode(mode: ClientMode): Promise<void>;
  /** 重新拉取 live 资源树。 */
  reloadResources(): Promise<void>;
}

const DocumentActionsContext = createContext<DocumentActions | null>(null);

function tabFromSnapshot(
  docId: string,
  title: string,
  kind: DocTab['kind'],
  mode: ClientMode,
  doc: DocumentSnapshot,
): DocTab {
  return {
    docId,
    path: doc.path,
    title,
    kind,
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

  const queues = useRef(new Map<string, EditQueue>());

  const actions = useMemo<DocumentActions>(() => {
    const queueFor = (docId: string, sessionId: string): EditQueue => {
      const existing = queues.current.get(docId);
      if (existing) return existing;
      const queue = createEditQueue<unknown>(async (text: string) => {
        const current = stateRef.current.tabs.find((tab) => tab.docId === docId);
        const outcome = await clientFor(current?.mode ?? stateRef.current.mode).applyEdit(
          sessionId,
          text,
          current?.baseVersion ?? null,
        );
        if (outcome.status !== 'APPLIED' || !outcome.document) {
          dispatch({
            type: 'NOTICE',
            message: `编辑未被接受：${outcome.errorCode ?? '未知错误'}（Core 缓冲可能落后于编辑器）`,
          });
          return;
        }
        // 只回写 Core 的 revision/状态，**不回写内容**：编辑器永远以用户输入为准
        const latest = stateRef.current.tabs.find((tab) => tab.docId === docId);
        if (latest && outcome.document.revision >= latest.revision) {
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
      async openNode(node: ResourceNodeState) {
        if (node.kind === 'folder') {
          dispatch({ type: 'TOGGLE_NODE', path: node.id });
          return;
        }
        const docId = node.path ?? node.id;
        if (stateRef.current.tabs.some((tab) => tab.docId === docId)) {
          dispatch({ type: 'ACTIVATE_TAB', docId });
          return;
        }

        const mode = stateRef.current.mode;
        const client = clientFor(mode);
        dispatch({ type: 'NOTICE', message: `正在打开 ${node.name} …` });
        const outcome = await client.openDocument(docId);
        if (outcome.status !== 'APPLIED' || !outcome.document) {
          dispatch({
            type: 'NOTICE',
            message: `无法打开 ${node.name}：${outcome.errorCode ?? '未知错误'}`,
          });
          return;
        }
        dispatch({
          type: 'OPEN_TAB',
          tab: tabFromSnapshot(
            docId,
            node.name,
            node.kind === 'markdown' ? 'markdown' : 'text',
            mode,
            outcome.document,
          ),
        });
      },

      editDoc(docId: string, text: string) {
        const tab = stateRef.current.tabs.find((item) => item.docId === docId);
        if (!tab) return;
        dispatch({ type: 'EDIT_DOC', docId, text });
        if (tab.mode !== 'live' || !tab.sessionId) return;
        queueFor(docId, tab.sessionId).schedule(text);
      },

      async saveTab(docId: string) {
        const tab = stateRef.current.tabs.find((item) => item.docId === docId);
        if (!tab) return;
        if (tab.saving) {
          dispatch({ type: 'NOTICE', message: '正在保存中，请稍候' });
          return;
        }

        if (tab.mode === 'demo') {
          dispatch({ type: 'TAB_PATCH', docId, patch: { saving: true } });
          const outcome = await clientFor('demo').saveDocument(tab.sessionId ?? '', '');
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

        dispatch({ type: 'TAB_PATCH', docId, patch: { saving: true } });
        // 先把在途/排队的编辑全部提交，保证保存的是最终缓冲
        await queues.current.get(docId)?.flush();

        const latest = stateRef.current.tabs.find((item) => item.docId === docId) ?? tab;
        const outcome = await clientFor(latest.mode).saveDocument(
          latest.sessionId as string,
          latest.baseVersion as string,
          latest.viewId,
        );
        const doc = outcome.document;

        if (outcome.status === 'COMMITTED') {
          const stillDirty = doc?.dirty ?? false;
          dispatch({
            type: 'SAVE_RESULT',
            docId,
            status: 'COMMITTED',
            errorCode: null,
            dirty: stillDirty,
            documentState: doc?.documentState ?? 'CLEAN',
            baseVersion: outcome.contentVersion ?? doc?.baseVersion ?? latest.baseVersion,
            revision: doc?.revision ?? null,
            notice: stillDirty
              ? '已写入磁盘，但保存期间又有新编辑（仍未保存）'
              : '已保存到磁盘',
          });
          return;
        }

        if (outcome.status === 'CONFLICT') {
          dispatch({
            type: 'SAVE_RESULT',
            docId,
            status: 'CONFLICT',
            errorCode: outcome.errorCode ?? 'ERR_DOCUMENT_VERSION_CONFLICT',
            dirty: true,
            documentState: doc?.documentState ?? 'CONFLICT',
            baseVersion: null,
            revision: doc?.revision ?? null,
            notice: '版本冲突：磁盘已被外部修改，编辑内容已保留，未覆盖磁盘',
          });
          return;
        }

        if (outcome.status === 'UNKNOWN') {
          dispatch({
            type: 'SAVE_RESULT',
            docId,
            status: 'UNKNOWN',
            errorCode: outcome.errorCode ?? 'ERR_OUTCOME_UNKNOWN',
            dirty: true,
            documentState: doc?.documentState ?? 'OUTCOME_UNKNOWN',
            baseVersion: null,
            revision: doc?.revision ?? null,
            notice: '保存结果未确认（UNKNOWN）：不要重复保存，请人工核对磁盘',
          });
          return;
        }

        dispatch({
          type: 'SAVE_RESULT',
          docId,
          status: 'FAILED',
          errorCode: outcome.errorCode ?? 'ERR_SAVE_FAILED',
          dirty: true,
          documentState: doc?.documentState ?? 'FAILED',
          baseVersion: null,
          revision: doc?.revision ?? null,
          notice: `保存失败：${outcome.errorCode ?? '未知错误'}（编辑内容已保留）`,
        });
      },

      async closeTab(docId: string) {
        const tab = stateRef.current.tabs.find((item) => item.docId === docId);
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
        dispatch({ type: 'CLOSE_TAB', docId });
      },

      async switchMode(mode: ClientMode) {
        if (mode === stateRef.current.mode) return;
        const target = clientFor(mode);
        if (stateRef.current.tabs.some((tab) => tab.dirty)) {
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
        dispatch({ type: 'SET_MODE', mode });
        if (mode === 'live') {
          dispatch({ type: 'SET_LOADING_RESOURCES', loading: true });
          try {
            const nodes = await target.listResources();
            dispatch({ type: 'SET_RESOURCES', nodes });
            const files = countFiles(nodes);
            dispatch({
              type: 'NOTICE',
              message: files > 0 ? `已加载 ${files} 个可编辑文件（真实文件模式）` : '未发现可编辑文件',
            });
          } catch {
            dispatch({
              type: 'NOTICE',
              message: '无法连接本地服务：请先启动 apps/server（npm run start:server）',
            });
          } finally {
            dispatch({ type: 'SET_LOADING_RESOURCES', loading: false });
          }
        }
      },

      async reloadResources() {
        if (stateRef.current.mode !== 'live') return;
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
    };
  }, [dispatch, demoClient, liveClient]);

  return (
    <DocumentActionsContext.Provider value={actions}>{children}</DocumentActionsContext.Provider>
  );
}

function countFiles(nodes: ResourceNodeState[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.kind === 'folder') total += countFiles(node.children ?? []);
    else total += 1;
  }
  return total;
}

export function useDocumentActions(): DocumentActions {
  const value = useContext(DocumentActionsContext);
  if (!value) throw new Error('useDocumentActions 必须在 DocumentActionsProvider 内使用');
  return value;
}
