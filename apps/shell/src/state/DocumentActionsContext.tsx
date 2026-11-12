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
import { createEditQueue, flushLatest, type EditQueue } from '../client/edit-queue';
import { runSaveFlow } from '../client/save-flow';
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
            message: `编辑未被接受：${outcome.errorCode ?? '未知错误'}（Core 缓冲落后于编辑器，已阻止保存）`,
          });
          // 必须抛错：队列据此记住「最后一次同步失败」，保存流程才不会把旧内容当成草稿写盘
          throw Object.assign(new Error(`applyEdit 被拒绝: ${outcome.errorCode ?? 'unknown'}`), {
            errorCode: outcome.errorCode ?? 'ERR_EDIT_REJECTED',
          });
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
        // 保存期间的输入一律丢弃：Core 正在比较版本，不能让缓冲在保存途中继续变化
        if (locked.current.has(docId)) return;
        dispatch({ type: 'EDIT_DOC', docId, text });
        if (tab.mode !== 'live' || !tab.sessionId) return;
        queueFor(docId, tab.sessionId).schedule(text);
      },

      async saveTab(docId: string) {
        const tab = stateRef.current.tabs.find((item) => item.docId === docId);
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
              const latest = stateRef.current.tabs.find((item) => item.docId === docId);
              return client.saveDocument(
                sessionId,
                latest?.baseVersion ?? (tab.baseVersion as string),
                latest?.viewId ?? null,
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
        locked.current.clear();
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
