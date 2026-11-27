/**
 * 资源标注的 Shell 编排（UX-02C-04）：对话框状态 + 单飞提交 + 保存后刷新。
 *
 * 为什么要单独一层而不是继续塞进 `DocumentActionsContext`：
 * - `DocumentActions` 的职责是"打开/编辑/保存的编排"，它已经很长；
 * - 标注是**行级展示元数据**，与文档会话、草稿、标签页毫无关系，
 *   混进去只会让两边的依赖互相牵扯；
 * - 这里只依赖 `DocumentActions` 提供的三个动作（设置 / 清除 / 刷新该层），
 *   不 fetch、不碰配置、不复制任何身份或安全判定。
 *
 * 交互纪律：
 * - 一次只有一个编辑会话（单飞），避免同一行被双击产生两条并发写入；
 * - 失败**不关闭**对话框：用户输入的内容还在，能看到原因并修正；
 * - `UNKNOWN` 与失败不同：写入是幂等的，结果未知时刷新该层核对真实结果，
 *   然后关闭对话框并明确提示"未确认、不会自动重发"。
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ResourceMetadataDto } from '../client/client-api.ts';
import { useDocumentActions } from './DocumentActionsContext.tsx';
import { useWorkspace } from './WorkspaceContext.tsx';
import {
  addTagToDraft,
  draftErrorOf,
  draftOf,
  metadataClearedNotice,
  metadataNoopNotice,
  metadataSavedNotice,
  metadataUnknownNotice,
  patchIsEmpty,
  patchOfDraft,
  removeTagFromDraft,
  type MetadataDraft,
} from './resource-metadata.ts';

/** 被编辑的目标：`path === ''` 表示项目根展示项。 */
export interface MetadataTarget {
  readonly projectId: string;
  readonly path: string;
  /** 行上显示的真实名称（用于对话框标题，不是标识）。 */
  readonly name: string;
  /** 打开对话框那一刻的元数据：用来算"哪些字段真的变了"。 */
  readonly meta?: ResourceMetadataDto;
}

export interface MetadataSession {
  readonly target: MetadataTarget;
  readonly draft: MetadataDraft;
  readonly error: string | null;
  readonly submitting: boolean;
  /** 打开时希望聚焦的分区（右键点了哪一项）。 */
  readonly focus: 'alias' | 'tags' | 'color';
}

interface MetadataContextValue {
  readonly session: MetadataSession | null;
  open(target: MetadataTarget, focus?: 'alias' | 'tags' | 'color'): void;
  close(): void;
  setAlias(value: string): void;
  addTag(raw: string): void;
  removeTag(tag: string): void;
  setColor(token: MetadataDraft['color']): void;
  /** 保存草稿与打开时的差异（没有差异就是 no-op）。 */
  submit(): Promise<void>;
  /** 清除整条记录（标注名 + 标签 + 颜色）。 */
  clearAll(): Promise<void>;
}

const MetadataContext = createContext<MetadataContextValue | null>(null);

export function MetadataProvider({ children }: { children: ReactNode }) {
  const actions = useDocumentActions();
  const { dispatch } = useWorkspace();
  const [session, setSession] = useState<MetadataSession | null>(null);
  /** 单飞：一次只允许一个写入在途（对话框是模态的，但回车键可能连发两次）。 */
  const busy = useRef(false);

  const open = useCallback((target: MetadataTarget, focus: 'alias' | 'tags' | 'color' = 'alias') => {
    if (busy.current) return;
    setSession({ target, draft: draftOf(target.meta), error: null, submitting: false, focus });
  }, []);

  const close = useCallback(() => {
    if (busy.current) return;
    setSession(null);
  }, []);

  const setAlias = useCallback((value: string) => {
    setSession((current) => (current ? { ...current, draft: { ...current.draft, alias: value }, error: null } : current));
  }, []);

  const addTag = useCallback((raw: string) => {
    setSession((current) => {
      if (!current) return current;
      const result = addTagToDraft(current.draft, raw);
      if (!result.ok) return { ...current, error: result.message };
      return { ...current, draft: result.draft, error: null };
    });
  }, []);

  const removeTag = useCallback((tag: string) => {
    setSession((current) =>
      current ? { ...current, draft: removeTagFromDraft(current.draft, tag), error: null } : current,
    );
  }, []);

  const setColor = useCallback((token: MetadataDraft['color']) => {
    setSession((current) => (current ? { ...current, draft: { ...current.draft, color: token }, error: null } : current));
  }, []);

  const submit = useCallback(async () => {
    const current = session;
    if (!current || busy.current) return;
    const invalid = draftErrorOf(current.draft);
    if (invalid) {
      setSession((state) => (state ? { ...state, error: invalid } : state));
      return;
    }
    const patch = patchOfDraft(current.draft, current.target.meta);
    if (patchIsEmpty(patch)) {
      setSession(null);
      dispatch({ type: 'NOTICE', message: metadataNoopNotice() });
      return;
    }
    busy.current = true;
    setSession((state) => (state ? { ...state, submitting: true, error: null } : state));
    try {
      const outcome = await actions.setResourceMetadata(current.target.projectId, current.target.path, patch);
      if (outcome.status === 'APPLIED') {
        // 先刷新再提示：提示"已保存"时行上必须真的已经是新值
        await actions.applyMetadataChange(current.target.projectId, current.target.path);
        dispatch({
          type: 'NOTICE',
          message: outcome.changed
            ? metadataSavedNotice(outcome.metadata.alias)
            : metadataNoopNotice(),
        });
        busy.current = false;
        setSession(null);
        return;
      }
      if (outcome.status === 'UNKNOWN') {
        // 幂等写入：结果未知时只刷新核对，不重发、不宣布成功
        await actions.applyMetadataChange(current.target.projectId, current.target.path);
        dispatch({ type: 'NOTICE', message: metadataUnknownNotice() });
        busy.current = false;
        setSession(null);
        return;
      }
      busy.current = false;
      setSession((state) =>
        state ? { ...state, submitting: false, error: outcome.message ?? '资源标注保存失败' } : state,
      );
    } catch {
      busy.current = false;
      setSession((state) =>
        state ? { ...state, submitting: false, error: '资源标注保存失败：本地服务不可用' } : state,
      );
    }
  }, [actions, dispatch, session]);

  const clearAll = useCallback(async () => {
    const current = session;
    if (!current || busy.current) return;
    busy.current = true;
    setSession((state) => (state ? { ...state, submitting: true, error: null } : state));
    try {
      const outcome = await actions.clearResourceMetadata(current.target.projectId, current.target.path);
      if (outcome.status === 'APPLIED') {
        await actions.applyMetadataChange(current.target.projectId, current.target.path);
        dispatch({ type: 'NOTICE', message: metadataClearedNotice() });
        busy.current = false;
        setSession(null);
        return;
      }
      if (outcome.status === 'UNKNOWN') {
        await actions.applyMetadataChange(current.target.projectId, current.target.path);
        dispatch({ type: 'NOTICE', message: metadataUnknownNotice() });
        busy.current = false;
        setSession(null);
        return;
      }
      busy.current = false;
      setSession((state) =>
        state ? { ...state, submitting: false, error: outcome.message ?? '清除标注失败' } : state,
      );
    } catch {
      busy.current = false;
      setSession((state) =>
        state ? { ...state, submitting: false, error: '清除标注失败：本地服务不可用' } : state,
      );
    }
  }, [actions, dispatch, session]);

  const value = useMemo<MetadataContextValue>(
    () => ({ session, open, close, setAlias, addTag, removeTag, setColor, submit, clearAll }),
    [session, open, close, setAlias, addTag, removeTag, setColor, submit, clearAll],
  );

  return <MetadataContext.Provider value={value}>{children}</MetadataContext.Provider>;
}

export function useResourceMetadata(): MetadataContextValue {
  const value = useContext(MetadataContext);
  if (!value) throw new Error('useResourceMetadata 必须在 MetadataProvider 内使用');
  return value;
}
