/**
 * 文件树命令编排（UX-02C-01）：**菜单与顶部工具栏的唯一入口**。
 *
 * 职责：把"右键了什么 / 工具栏在哪"折算成显式 `(projectId, parentDir)`，
 * 管住行内命名状态与单飞提交，然后把结果交给 `DocumentActions` 去刷新层表。
 * 不 fetch、不碰磁盘、不复制任何授权判定；同名/路径的权威判定在 Host。
 *
 * 未来命令（`rename / move / delete-local / …`）只在 `ContextMenu.tsx` 的
 * `RESERVED_TREE_COMMANDS` 里占位，本轮**不渲染**成点了没反应的假菜单。
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import type { CreateEntryKindDto, CreateEntryOutcome } from '../client/client-api.ts';
import { useCapabilities } from '../capabilities/CapabilityContext.tsx';
import { supportedFileExtensions, type SupportedExtension } from '../capabilities/supported-extensions.ts';
import {
  createEntryRunner,
  initialNamingDraft,
  parentDirOf,
  resolveCreateTarget,
  type CreateOrigin,
} from '../state/create-entry.ts';
import { useDocumentActions } from '../state/DocumentActionsContext.tsx';
import { useWorkspace } from '../state/WorkspaceContext.tsx';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';

export interface TreeTarget {
  readonly origin: CreateOrigin;
  /** 上下文所属项目；Demo / Legacy 传 null。 */
  readonly projectId: string | null;
  /** folder：自身相对路径；file：文件相对路径。 */
  readonly nodePath?: string | null;
}

export interface NamingState {
  readonly projectId: string;
  readonly parentDir: string;
  readonly kind: CreateEntryKindDto;
  readonly presetExtension?: string;
  readonly draft: string;
  readonly error: string | null;
  readonly submitting: boolean;
}

interface MenuState {
  readonly x: number;
  readonly y: number;
  /** 每次打开都换一个实例：键盘高亮/子菜单状态不从上一次右键带过来。 */
  readonly nonce: number;
  readonly target: TreeTarget;
}

interface TreeCommandsValue {
  openContextMenu(event: MouseEvent, target: TreeTarget): void;
  closeContextMenu(): void;
  /** 右键菜单与工具栏都走这里；`presetExtension` 只影响行内输入的初值与选区。 */
  beginCreate(kind: CreateEntryKindDto, target: TreeTarget, presetExtension?: string): void;
  toolbarCreate(kind: CreateEntryKindDto): void;
  toolbarRefresh(): void;
  noteSelection(projectId: string, kind: 'folder' | 'file', path: string): void;
  readonly naming: NamingState | null;
  setDraft(value: string): void;
  submitNaming(): Promise<void>;
  cancelNaming(): void;
  readonly supportedExtensions: readonly SupportedExtension[];
}

const TreeCommandsContext = createContext<TreeCommandsValue | null>(null);

export function TreeCommandsProvider({ children }: { children: ReactNode }) {
  const { state, dispatch } = useWorkspace();
  const actions = useDocumentActions();
  const { ready, registry, resolveViewer, revision } = useCapabilities();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuSeq = useRef(0);
  const [naming, setNaming] = useState<NamingState | null>(null);
  /** "当前明确选中的目录"按项目记录：空白区 / 工具栏据此决定创建位置。 */
  const [selectedDirByProject, setSelectedDirByProject] = useState<Record<string, string>>({});

  const supportedExtensions = useMemo(
    () => supportedFileExtensions({ list: () => registry.list(), resolveViewer }, ready),
    // revision 参与依赖：插件启用/停用后二级菜单立刻跟着变
    [registry, resolveViewer, ready, revision],
  );

  const isSupported = useCallback(
    (projectId: string | null): boolean => {
      if (state.mode !== 'live' || state.workspaceMode !== 'multi' || !projectId) return false;
      return state.projects.some((project) => project.projectId === projectId && project.status === 'READY');
    },
    [state.mode, state.workspaceMode, state.projects],
  );

  const runner = useMemo(
    () =>
      createEntryRunner({
        create: (input) => actions.createEntry(input.projectId, input.parentDir, input.name, input.kind),
        checkDirectory: async (projectId, parentDir) => {
          // 只读核对：不创建、不改标签草稿；同一层的在途旧请求由 layer loader 作废
          await actions.refreshTreeLevel(projectId, parentDir);
        },
        onApplied: (outcome: Extract<CreateEntryOutcome, { status: 'APPLIED' }>) => {
          // 只失效目标项目的目标目录层；必要时把目标文件夹展开
          void actions.refreshTreeLevel(outcome.projectId, outcome.parentDir, { expand: true });
          dispatch({
            type: 'NOTICE',
            message: `已创建「${outcome.name}」（刷新该目录后可见；未加载到的分页不声明已显示）`,
          });
        },
        onNotice: (message) => {
          dispatch({ type: 'NOTICE', message });
          setNaming((current) => (current ? { ...current, error: message } : current));
        },
      }),
    [actions, dispatch],
  );

  const resolve = useCallback(
    (target: TreeTarget): ReturnType<typeof resolveCreateTarget> =>
      resolveCreateTarget({
        origin: target.origin,
        projectId: target.projectId,
        nodePath: target.nodePath,
        kind: 'file',
        selectedDirByProject,
        activeProjectId: state.activeProjectId,
        supported: isSupported(target.projectId ?? state.activeProjectId),
      }),
    [selectedDirByProject, state.activeProjectId, isSupported],
  );

  const beginCreate = useCallback(
    (kind: CreateEntryKindDto, target: TreeTarget, presetExtension?: string) => {
      setMenu(null);
      const resolved = resolve(target);
      if (!resolved.ok) {
        dispatch({ type: 'NOTICE', message: resolved.reason });
        return;
      }
      setNaming({
        projectId: resolved.projectId,
        parentDir: resolved.parentDir,
        kind,
        ...(presetExtension ? { presetExtension } : {}),
        draft: initialNamingDraft(presetExtension),
        error: null,
        submitting: false,
      });
    },
    [dispatch, resolve],
  );

  const cancelNaming = useCallback(() => setNaming(null), []);

  const submitNaming = useCallback(async (): Promise<void> => {
    if (!naming || naming.submitting) return;
    setNaming((current) => (current ? { ...current, submitting: true, error: null } : current));
    const result = await runner.submit({
      projectId: naming.projectId,
      parentDir: naming.parentDir,
      name: naming.draft,
      kind: naming.kind,
    });
    if (result === 'applied' || result === 'unknown' || result === 'busy') {
      // 成功或结果未知都收起输入行：绝不留一个"看起来还能再点一次"的入口
      setNaming(null);
      return;
    }
    // rejected：保留输入供修正，行内显示 Host 给出的原因
    setNaming((current) => (current ? { ...current, submitting: false } : current));
  }, [naming, runner]);

  const noteSelection = useCallback((projectId: string, kind: 'folder' | 'file', path: string) => {
    const dir = kind === 'folder' ? path.replace(/\\/g, '/') : parentDirOf(path);
    setSelectedDirByProject((current) => (current[projectId] === dir ? current : { ...current, [projectId]: dir }));
  }, []);

  const activeTarget = useCallback(
    (): TreeTarget => ({ origin: 'toolbar', projectId: state.activeProjectId }),
    [state.activeProjectId],
  );
  const toolbarCreate = useCallback(
    (kind: CreateEntryKindDto) => beginCreate(kind, activeTarget()),
    [activeTarget, beginCreate],
  );
  const toolbarRefresh = useCallback(() => {
    const resolved = resolve(activeTarget());
    if (!resolved.ok) {
      dispatch({ type: 'NOTICE', message: resolved.reason });
      return;
    }
    void actions.refreshTreeLevel(resolved.projectId, resolved.parentDir);
  }, [activeTarget, dispatch, resolve, actions]);

  const openContextMenu = useCallback((event: MouseEvent, target: TreeTarget) => {
    // 输入框里的原生文本右键（剪切/复制/粘贴）不能抢
    if ((event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return;
    event.preventDefault();
    // 行上打开菜单后不再冒泡到"空白区"处理器，否则上下文会被覆盖成 blank
    event.stopPropagation();
    menuSeq.current += 1;
    setMenu({ x: event.clientX, y: event.clientY, nonce: menuSeq.current, target });
  }, []);

  const menuItems = useMemo<readonly MenuItem[]>(() => {
    if (!menu) return [];
    const target = menu.target;
    const usable = isSupported(target.projectId ?? state.activeProjectId);
    const isLink = target.origin === 'link';
    const whyNot = isLink ? '链接节点不允许创建' : usable ? undefined : '当前模式/项目不支持';
    const create = (kind: CreateEntryKindDto, preset?: string) => () => beginCreate(kind, target, preset);
    const refresh = (): void => {
      const resolved = resolve(target);
      if (resolved.ok) void actions.refreshTreeLevel(resolved.projectId, resolved.parentDir);
      setMenu(null);
    };
    return [
      {
        id: 'new-file',
        label: '新建文件',
        hint: whyNot,
        disabled: !usable || isLink,
        command: create('file'),
      },
      {
        id: 'new-folder',
        label: '新建文件夹',
        hint: whyNot,
        disabled: !usable || isLink,
        command: create('directory'),
      },
      {
        id: 'new-supported',
        label: '创建已支持的扩展文件',
        hint: supportedExtensions.length === 0 ? '暂无可用查看能力' : undefined,
        disabled: !usable || isLink || supportedExtensions.length === 0,
        children: supportedExtensions.map((item) => ({
          id: `new-supported:${item.extension}`,
          label: item.label,
          command: create('file', item.extension),
        })),
      },
      {
        id: 'refresh',
        label: target.origin === 'project-root' ? '刷新项目根' : '刷新此目录',
        hidden: isLink || !usable,
        command: refresh,
      },
    ];
  }, [menu, isSupported, state.activeProjectId, beginCreate, supportedExtensions, resolve, actions]);

  const value = useMemo<TreeCommandsValue>(
    () => ({
      openContextMenu,
      closeContextMenu: () => setMenu(null),
      beginCreate,
      toolbarCreate,
      toolbarRefresh,
      noteSelection,
      naming,
      setDraft: (draft) =>
        setNaming((current) => (current ? { ...current, draft, error: null } : current)),
      submitNaming,
      cancelNaming,
      supportedExtensions,
    }),
    [
      openContextMenu,
      beginCreate,
      toolbarCreate,
      toolbarRefresh,
      noteSelection,
      naming,
      submitNaming,
      cancelNaming,
      supportedExtensions,
    ],
  );

  return (
    <TreeCommandsContext.Provider value={value}>
      {children}
      {menu && (
        <ContextMenu
          key={menu.nonce}
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </TreeCommandsContext.Provider>
  );
}

export function useTreeCommands(): TreeCommandsValue {
  const value = useContext(TreeCommandsContext);
  if (!value) throw new Error('useTreeCommands 必须在 TreeCommandsProvider 内使用');
  return value;
}
