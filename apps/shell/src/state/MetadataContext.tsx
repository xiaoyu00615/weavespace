/**
 * 资源标注的 Shell 编排（UX-02C-04 / R1-03）：对话框状态 + 单飞提交 + 归属核对。
 *
 * 为什么要单独一层而不是继续塞进 `DocumentActionsContext`：
 * - `DocumentActions` 的职责是"打开/编辑/保存的编排"，它已经很长；
 * - 标注是**行级展示元数据**，与文档会话、草稿、标签页毫无关系，
 *   混进去只会让两边的依赖互相牵扯；
 * - 这里只依赖 `DocumentActions` 提供的窄动作（设置 / 清除 / 刷新该层 /
 *   身份键 / 该行当前状态），不 fetch、不碰配置、不复制任何身份或安全判定。
 *
 * R1-03 的关键点：对话框打开的那一刻就是一个**会话**，它绑定
 * `工作区身份 + 项目 + 路径 + 资源锚`。判定逻辑全在 `metadata-session.ts`
 * （纯 TS，可被 node:test 直接驱动），这里只负责：
 * - 打开时冻结绑定、把当前行状态交给判定层；
 * - 提交/清除时把绑定原样交给 runner，由它在提交前后各判一次归属；
 * - 归属不成立时**一个请求都不发**，并给出"没有保存"而不是"保存失败"的提示。
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
  createMetadataRunner,
  type MetadataRunner,
  type MetadataRunnerHost,
  type MetadataSessionBinding,
} from './metadata-session.ts';
import {
  addTagToDraft,
  draftErrorOf,
  draftOf,
  metadataNoopNotice,
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
  /**
   * 打开时冻结的归属（工作区身份 + 项目 + 路径 + 资源锚）。
   *
   * 提交与清除都只认这份绑定：界面之后怎么变都不影响"这次编辑原本指向谁"。
   */
  readonly binding: MetadataSessionBinding;
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

  /*
   * runner 的端口全是 `actions` 上的窄方法：没有一处自己拼身份、自己读盘、
   * 自己决定要不要刷新。这样"归属判定"只有 `metadata-session.ts` 一个答案。
   */
  const runner = useMemo<MetadataRunner>(() => {
    const host: MetadataRunnerHost = {
      identityKey: () => actions.metadataIdentityKey(),
      targetState: (projectId, path) => actions.metadataTargetState(projectId, path),
      /*
       * `gate` 原样透传：最终裁决必须发生在传输层（取令牌之后、fetch 之前），
       * 这里不做任何二次包装——包装一次就等于把"何时判"又挪回了组件层。
       */
      set: (projectId, path, patch, anchor, gate) =>
        actions.setResourceMetadata(projectId, path, patch, anchor === null ? undefined : { anchor }, gate),
      clear: (projectId, path, anchor, gate) =>
        actions.clearResourceMetadata(
          projectId,
          path,
          anchor === null ? undefined : { anchor },
          undefined,
          gate,
        ),
      refresh: (projectId, path) => actions.applyMetadataChange(projectId, path),
      notice: (message) => dispatch({ type: 'NOTICE', message }),
    };
    return createMetadataRunner(host);
  }, [actions, dispatch]);

  const open = useCallback(
    (target: MetadataTarget, focus: 'alias' | 'tags' | 'color' = 'alias') => {
      if (busy.current) return;
      /*
       * 绑定在这里**冻结**：身份键与资源锚都取打开这一刻的值。
       * 之后无论用户切工作区、文件被替换还是行被刷新，都不会改这份绑定——
       * 它记录的是"用户以为自己在编辑谁"，不是"现在是谁"。
       */
      const state = actions.metadataTargetState(target.projectId, target.path);
      setSession({
        target,
        draft: draftOf(target.meta),
        error: null,
        submitting: false,
        focus,
        binding: {
          key: actions.metadataIdentityKey(),
          projectId: target.projectId,
          path: target.path,
          anchor: state.anchor,
        },
      });
    },
    [actions],
  );

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
    const result = await runner.submit(current.binding, patch);
    busy.current = false;
    // 归属已变 / 已保存 / 未确认：这次会话到此结束（旧结果不会落到新界面）
    if (result.kind !== 'rejected') {
      setSession(null);
      return;
    }
    // 只有"试过了、Host 拒绝"才留在对话框里，让用户看到原因并修正
    setSession((state) => (state ? { ...state, submitting: false, error: result.message } : state));
  }, [dispatch, runner, session]);

  const clearAll = useCallback(async () => {
    const current = session;
    if (!current || busy.current) return;
    busy.current = true;
    setSession((state) => (state ? { ...state, submitting: true, error: null } : state));
    const result = await runner.clear(current.binding);
    busy.current = false;
    if (result.kind !== 'rejected') {
      setSession(null);
      return;
    }
    setSession((state) => (state ? { ...state, submitting: false, error: result.message } : state));
  }, [runner, session]);

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
