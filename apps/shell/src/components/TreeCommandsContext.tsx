/**
 * 文件树命令编排（UX-02C-01 创建 / UX-02C-02 改名与移动 / UX-02C-03-P1 隐藏）：
 * **菜单、顶部工具栏、行内输入框、移动对话框的唯一入口**。
 *
 * 职责：把"右键了什么 / 工具栏在哪"折算成显式 `(projectId, 相对路径)`，
 * 管住行内命名与单飞提交，然后把结果交给 `DocumentActions` 去刷新层表。
 * 不 fetch、不碰磁盘、不复制任何授权判定；同名/路径/会话的权威判定在 Host。
 *
 * 未来命令（`delete-local / …`）只在 `ContextMenu.tsx` 的
 * `RESERVED_TREE_COMMANDS` 里占位，本轮**不渲染**成点了没反应的假菜单。
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import type {
  CreateEntryKindDto,
  CreateEntryOutcome,
  StructureChangeOutcome,
} from '../client/client-api.ts';
import { useCapabilities } from '../capabilities/CapabilityContext.tsx';
import { supportedFileExtensions, type SupportedExtension } from '../capabilities/supported-extensions.ts';
import {
  createEntryRunner,
  createExpansionPlan,
  EMPTY_PRESET_STEM_MESSAGE,
  initialNamingDraft,
  missingPresetStem,
  normalizeDir,
  parentDirOf,
  resolveCreateTarget,
  selectionForPreset,
  type CreateOrigin,
} from '../state/create-entry.ts';
import {
  createStructureRunner,
  inputSurvivesStructureResult,
  localStructureBlockers,
  moveTargetOptions,
  renameDraftOf,
  STRUCTURE_BUSY_MESSAGE,
  type StructureEntryKind,
} from '../state/structure-change.ts';
import { entryNameOf } from '../../../../packages/storage/entry-name.ts';
import {
  visibilityCommandState,
  visibilityNoopNotice,
  visibilityNotice,
  visibilityUnknownNotice,
} from '../state/visibility.ts';
import { useDocumentActions } from '../state/DocumentActionsContext.tsx';
import { useTrash } from '../state/TrashContext.tsx';
import { trashDeleteCommandState } from '../state/trash.ts';
import { useWorkspace } from '../state/WorkspaceContext.tsx';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
import { MoveEntryDialog } from './MoveEntryDialog.tsx';

export interface TreeTarget {
  readonly origin: CreateOrigin;
  /** 上下文所属项目；Demo / Legacy 传 null。 */
  readonly projectId: string | null;
  /** folder：自身相对路径；file：文件相对路径。 */
  readonly nodePath?: string | null;
  /** 右键文件夹行时该行的节点 id：折叠目录中创建可精确、幂等地展开。 */
  readonly nodeId?: string | null;
  /** 被右键节点的类型：改名/移动据此判断是否要检查后代。 */
  readonly entryKind?: StructureEntryKind | 'link';
  /**
   * 该行自身是否已有隐藏记录（UX-02C-03-P1）。
   *
   * 只有"显示隐藏项"打开时才可能为 true；据此决定菜单给"隐藏"还是"取消隐藏"。
   */
  readonly nodeHidden?: boolean;
}

export interface NamingState {
  /** create = 新建；rename = 真实改名。两者共用同一个行内输入行。 */
  readonly mode: 'create' | 'rename';
  readonly projectId: string;
  /** 输入行所在的层：create 是目标目录；rename 是源节点的父目录。 */
  readonly parentDir: string;
  readonly kind: CreateEntryKindDto;
  readonly presetExtension?: string;
  readonly draft: string;
  readonly selection: [number, number];
  readonly error: string | null;
  readonly submitting: boolean;
  /** rename 专用：源相对路径与源类型。 */
  readonly sourcePath?: string;
  readonly entryKind?: StructureEntryKind;
}

export interface MoveDialogState {
  readonly projectId: string;
  readonly sourcePath: string;
  readonly targetName: string;
  readonly entryKind: StructureEntryKind;
  readonly targetParentDir: string;
  readonly options: readonly string[];
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
  /** 右键文件/文件夹 → 行内改名（预填原名，选主文件名）。 */
  beginRename(target: TreeTarget): void;
  /** 右键文件/文件夹 → 打开"移动到…"选择器。 */
  openMove(target: TreeTarget): void;
  /**
   * 右键 → 从文件树隐藏 / 取消隐藏（UX-02C-03-P1）。
   *
   * `currentlyHidden` 是这一行现在的状态：true 表示要**取消隐藏**。
   * 只改工作台可见性，不关标签、不动草稿、不碰磁盘内容。
   */
  toggleVisibility(target: TreeTarget, currentlyHidden: boolean): Promise<void>;
  setMoveTarget(dir: string): void;
  confirmMove(): Promise<void>;
  cancelMove(): void;
  readonly moveDialog: MoveDialogState | null;
  toolbarCreate(kind: CreateEntryKindDto): void;
  toolbarRefresh(): void;
  noteSelection(projectId: string, kind: 'folder' | 'file', path: string): void;
  /** 项目根容器的展开态（R1-01）：与创建编排放在同一处，保证开始创建时一定可见。 */
  isRootOpen(projectId: string): boolean;
  toggleRoot(projectId: string): void;
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
  const trash = useTrash();
  const { ready, registry, resolveViewer, revision } = useCapabilities();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuSeq = useRef(0);
  const [naming, setNaming] = useState<NamingState | null>(null);
  const [moveDialog, setMoveDialog] = useState<MoveDialogState | null>(null);
  /** "当前明确选中的目录"按项目记录：空白区 / 工具栏据此决定创建位置。 */
  const [selectedDirByProject, setSelectedDirByProject] = useState<Record<string, string>>({});
  /**
   * 项目根容器展开态（UX-02C-01-R1）。从 `ProjectList` 上提，使"打开根"与
   * "挂上输入行"在同一次渲染里完成。缺席即默认展开。
   */
  const [openRoots, setOpenRoots] = useState<Record<string, boolean>>({});
  const isRootOpen = useCallback((projectId: string): boolean => openRoots[projectId] ?? true, [openRoots]);
  const toggleRoot = useCallback((projectId: string): void => {
    setOpenRoots((current) => ({ ...current, [projectId]: !(current[projectId] ?? true) }));
  }, []);
  /** 幂等打开：已经展开时返回原 state，绝不误折叠。 */
  const ensureRootOpen = useCallback((projectId: string): void => {
    setOpenRoots((current) =>
      current[projectId] === false ? { ...current, [projectId]: true } : current,
    );
  }, []);

  const supportedExtensions = useMemo(
    () => supportedFileExtensions({ list: () => registry.list(), resolveViewer }, ready),
    [registry, resolveViewer, ready, revision],
  );

  const isSupported = useCallback(
    (projectId: string | null): boolean => {
      if (state.mode !== 'live' || state.workspaceMode !== 'multi' || !projectId) return false;
      return state.projects.some((project) => project.projectId === projectId && project.status === 'READY');
    },
    [state.mode, state.workspaceMode, state.projects],
  );

  /** 两个编排器共用的提示落地：状态栏 + 当前输入行/对话框的行内错误。 */
  const onNotice = useCallback(
    (message: string) => {
      dispatch({ type: 'NOTICE', message });
      setNaming((current) => (current ? { ...current, error: message } : current));
      setMoveDialog((current) => (current ? { ...current, error: message } : current));
    },
    [dispatch],
  );

  const runner = useMemo(
    () =>
      createEntryRunner({
        create: (input) => actions.createEntry(input.projectId, input.parentDir, input.name, input.kind),
        checkDirectory: async (projectId, parentDir) => {
          await actions.refreshTreeLevel(projectId, parentDir);
        },
        onApplied: (outcome: Extract<CreateEntryOutcome, { status: 'APPLIED' }>) => {
          void actions.refreshTreeLevel(outcome.projectId, outcome.parentDir, { expand: true });
          dispatch({
            type: 'NOTICE',
            message: `已创建「${outcome.name}」（刷新该目录后可见；未加载到的分页不声明已显示）`,
          });
        },
        onNotice,
      }),
    [actions, dispatch, onNotice],
  );

  const structureRunner = useMemo(
    () =>
      createStructureRunner({
        rename: (projectId, sourcePath, name) => actions.renameEntry(projectId, sourcePath, name),
        move: (projectId, sourcePath, targetParentDir, name) =>
          actions.moveEntry(projectId, sourcePath, targetParentDir, name),
        // Host 重启后内存会话表归零，Shell 本地标签/草稿这道门必须独立存在
        localBlockers: (projectId, sourcePath, entryKind) =>
          localStructureBlockers(state.tabs, projectId, sourcePath, entryKind),
        checkLocations: (projectId, sourceParentDir, targetParentDir) =>
          actions.checkStructureLocations(projectId, sourceParentDir, targetParentDir),
        onApplied: (outcome: Extract<StructureChangeOutcome, { status: 'APPLIED' }>) => {
          void actions.applyStructureChange(outcome);
        },
        onNotice,
      }),
    [actions, state.tabs, onNotice],
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
      // R1-01：输入行只在展开的目录里渲染；两处都用幂等动作，不会误折叠
      const plan = createExpansionPlan({
        projectId: resolved.projectId,
        parentDir: resolved.parentDir,
        levels: state.treeByProject[resolved.projectId] ?? {},
        nodeId: target.nodeId ?? null,
      });
      if (plan.rootProjectId) ensureRootOpen(plan.rootProjectId);
      if (plan.folderNodeId && plan.rootProjectId) {
        dispatch({
          type: 'EXPAND_PROJECT_NODE',
          projectId: plan.rootProjectId,
          path: plan.folderNodeId,
        });
      }
      const draft = initialNamingDraft(presetExtension);
      setNaming({
        mode: 'create',
        projectId: resolved.projectId,
        parentDir: resolved.parentDir,
        kind,
        ...(presetExtension ? { presetExtension } : {}),
        draft,
        selection: selectionForPreset(draft, presetExtension),
        error: null,
        submitting: false,
      });
    },
    [dispatch, resolve, ensureRootOpen, state.treeByProject],
  );

  /** 能被改名/移动的上下文：必须是真实 Multi 项目里的普通文件或文件夹。 */
  const structureSource = useCallback(
    (target: TreeTarget):
      | {
          projectId: string;
          sourcePath: string;
          entryKind: StructureEntryKind;
          parentDir: string;
        }
      | null => {
      const projectId = target.projectId;
      const sourcePath = target.nodePath == null ? '' : normalizeDir(target.nodePath);
      if (
        !projectId ||
        sourcePath === '' ||
        (target.origin !== 'file' && target.origin !== 'folder') ||
        target.entryKind !== 'file' && target.entryKind !== 'directory'
      ) {
        return null;
      }
      if (!isSupported(projectId)) return null;
      return {
        projectId,
        sourcePath,
        entryKind: target.entryKind,
        parentDir: parentDirOf(sourcePath),
      };
    },
    [isSupported],
  );

  const beginRename = useCallback(
    (target: TreeTarget) => {
      setMenu(null);
      const source = structureSource(target);
      if (!source) {
        dispatch({ type: 'NOTICE', message: '只有已授权项目里的文件或文件夹可以改名' });
        return;
      }
      ensureRootOpen(source.projectId);
      const draft = renameDraftOf(source.sourcePath);
      setNaming({
        mode: 'rename',
        projectId: source.projectId,
        parentDir: draft.parentDir,
        kind: source.entryKind === 'directory' ? 'directory' : 'file',
        draft: draft.draft,
        selection: draft.selection,
        error: null,
        submitting: false,
        sourcePath: draft.sourcePath,
        entryKind: source.entryKind,
      });
    },
    [dispatch, ensureRootOpen, structureSource],
  );

  const openMove = useCallback(
    (target: TreeTarget) => {
      setMenu(null);
      const source = structureSource(target);
      if (!source) {
        dispatch({ type: 'NOTICE', message: '只有已授权项目里的文件或文件夹可以移动' });
        return;
      }
      const levels = state.treeByProject[source.projectId] ?? {};
      const options = moveTargetOptions(levels, source.sourcePath, source.entryKind).filter(
        (dir) => dir !== source.parentDir,
      );
      setMoveDialog({
        projectId: source.projectId,
        sourcePath: source.sourcePath,
        targetName: entryNameOf(source.sourcePath),
        entryKind: source.entryKind,
        targetParentDir: options[0] ?? '',
        options,
        error: null,
        submitting: false,
      });
    },
    [dispatch, state.treeByProject, structureSource],
  );

  const setMoveTarget = useCallback((dir: string) => {
    setMoveDialog((current) =>
      current && current.options.includes(dir) ? { ...current, targetParentDir: dir, error: null } : current,
    );
  }, []);

  const cancelMove = useCallback(() => setMoveDialog(null), []);

  /**
   * 隐藏 / 取消隐藏的单飞提交（UX-02C-03-P1）。
   *
   * 与创建/改名不同，这里没有输入行也没有模态：一次右键就是一个完整意图。
   * 仍然要单飞，避免同一行被双击两次产生两条并发请求（第二条会变成 no-op 提示，
   * 用户会以为"点了没反应"）。
   */
  const visibilityBusy = useRef(false);
  const toggleVisibility = useCallback(
    async (target: TreeTarget, currentlyHidden: boolean): Promise<void> => {
      setMenu(null);
      const projectId = target.projectId;
      const path = normalizeDir(target.nodePath ?? '');
      if (!projectId || path === '') {
        dispatch({ type: 'NOTICE', message: '只有已授权项目里的文件或文件夹可以从文件树隐藏' });
        return;
      }
      if (visibilityBusy.current) return;
      visibilityBusy.current = true;
      try {
        const outcome = currentlyHidden
          ? await actions.unhideEntry(projectId, path)
          : await actions.hideEntry(projectId, path);

        if (outcome.status === 'APPLIED') {
          // 先刷新父层再提示：提示"已隐藏"时树里必须真的已经不显示了
          await actions.applyVisibilityChange(projectId, path);
          dispatch({
            type: 'NOTICE',
            message: outcome.changed
              ? visibilityNotice(path, !currentlyHidden)
              : visibilityNoopNotice(path, !currentlyHidden),
          });
          return;
        }
        if (outcome.status === 'UNKNOWN') {
          // 只读核对一次：不重发、不宣布成功
          await actions.applyVisibilityChange(projectId, path);
          dispatch({ type: 'NOTICE', message: visibilityUnknownNotice() });
          return;
        }
        dispatch({ type: 'NOTICE', message: outcome.message ?? '隐藏操作失败' });
      } catch {
        dispatch({ type: 'NOTICE', message: '隐藏操作失败：网络或本地服务不可用' });
      } finally {
        visibilityBusy.current = false;
      }
    },
    [actions, dispatch],
  );

  const confirmMove = useCallback(async (): Promise<void> => {
    if (!moveDialog || moveDialog.submitting) return;
    setMoveDialog((current) => (current ? { ...current, submitting: true, error: null } : current));
    const result = await structureRunner.submit({
      kind: 'move',
      projectId: moveDialog.projectId,
      sourcePath: moveDialog.sourcePath,
      targetParentDir: moveDialog.targetParentDir,
      targetName: moveDialog.targetName,
      entryKind: moveDialog.entryKind,
    });
    if (!inputSurvivesStructureResult(result)) {
      setMoveDialog(null);
      return;
    }
    if (result === 'busy') {
      setMoveDialog((current) =>
        (current ? { ...current, submitting: false, error: STRUCTURE_BUSY_MESSAGE } : current),
      );
      return;
    }
    // blocked / rejected：保留对话框供修正目标，原因已由 onNotice 写入行内错误
    setMoveDialog((current) => (current ? { ...current, submitting: false } : current));
  }, [moveDialog, structureRunner]);

  const cancelNaming = useCallback(() => setNaming(null), []);

  const submitNaming = useCallback(async (): Promise<void> => {
    if (!naming || naming.submitting) return;
    if (naming.mode === 'create' && missingPresetStem(naming.draft, naming.presetExtension)) {
      // R1-02：连"提交中"都不进入，避免输入框被禁用而失焦
      setNaming((current) => (current ? { ...current, error: EMPTY_PRESET_STEM_MESSAGE } : current));
      return;
    }
    if (naming.mode === 'rename' && naming.draft === entryNameOf(naming.sourcePath ?? '')) {
      setNaming((current) => (current ? { ...current, error: '请输入不同的名称' } : current));
      return;
    }
    setNaming((current) => (current ? { ...current, submitting: true, error: null } : current));

    const result =
      naming.mode === 'rename'
        ? await structureRunner.submit({
            kind: 'rename',
            projectId: naming.projectId,
            sourcePath: naming.sourcePath ?? '',
            targetParentDir: naming.parentDir,
            targetName: naming.draft,
            entryKind: naming.entryKind ?? 'file',
          })
        : await runner.submit({
            projectId: naming.projectId,
            parentDir: naming.parentDir,
            name: naming.draft,
            kind: naming.kind,
            ...(naming.presetExtension ? { presetExtension: naming.presetExtension } : {}),
          });
    if (!inputSurvivesStructureResult(result)) {
      // applied / unknown：收起输入行（unknown 的提示由状态栏保持可辨认）
      setNaming(null);
      return;
    }
    if (result === 'busy') {
      setNaming((current) => (current ? { ...current, submitting: false, error: STRUCTURE_BUSY_MESSAGE } : current));
      return;
    }
    // blocked / rejected：保留输入供修正，行内显示原因
    // （原因已由 onNotice 在提交期间写入，这里只解除提交中状态）
    setNaming((current) => (current ? { ...current, submitting: false } : current));
  }, [naming, runner, structureRunner]);

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
    const structural = structureSource(target) !== null;
    const visibility = visibilityCommandState({ target, supported: usable });
    // 只有"普通文件 + 已授权项目"可回收；目录/链接/项目根显示为禁用并说明原因
    const trashCommand = trashDeleteCommandState({
      origin: target.origin,
      entryKind: target.entryKind === 'link' ? 'link' : target.entryKind,
      supported: usable,
    });
    return [
      {
        id: 'rename',
        label: '重命名',
        hidden: !structural,
        disabled: !usable || isLink,
        command: () => beginRename(target),
      },
      {
        id: 'move',
        label: '移动到…',
        hidden: !structural,
        disabled: !usable || isLink,
        command: () => openMove(target),
      },
      /*
       * 从文件树隐藏 / 取消隐藏（UX-02C-03-P1）。
       *
       * 单独一条、紧跟在改名/移动之后：它同样是"对这一个节点动手"，但**不碰磁盘**。
       * 链接节点不提供（Host 侧与"路径经过重解析点"同一条边界，必然 403）。
       */
      {
        id: visibility.action === 'unhide' ? 'unhide' : 'hide',
        label: visibility.action === 'unhide' ? '取消隐藏' : '从文件树隐藏',
        hidden: !visibility.visible,
        ...(visibility.hint ? { hint: visibility.hint } : {}),
        disabled: visibility.disabled,
        command: () => void toggleVisibility(target, target.nodeHidden === true),
      },
      /*
       * 移入回收区（UX-02C-03-P2-02）。
       *
       * 与"从文件树隐藏"是两件不同的事：隐藏只改可见性、不碰磁盘；
       * 回收会**移动文件**，因此只在普通文件上给入口，并且要经过二段确认。
       * `delete-local` 那个占位是"永久删除"，与本项无关，仍然不渲染。
       */
      {
        id: 'trash',
        label: '移入回收区',
        hidden: !trashCommand.visible,
        ...(trashCommand.hint ? { hint: trashCommand.hint } : {}),
        disabled: trashCommand.disabled,
        command: () => {
          setMenu(null);
          const projectId = target.projectId;
          const path = normalizeDir(target.nodePath ?? '');
          if (!projectId || path === '') {
            dispatch({ type: 'NOTICE', message: '只有已授权项目里的普通文件可以移入回收区' });
            return;
          }
          trash.openDelete(projectId, path);
        },
      },
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
  }, [
    menu,
    isSupported,
    state.activeProjectId,
    beginCreate,
    beginRename,
    openMove,
    structureSource,
    supportedExtensions,
    resolve,
    actions,
    toggleVisibility,
    trash,
  ]);

  const value = useMemo<TreeCommandsValue>(
    () => ({
      openContextMenu,
      closeContextMenu: () => setMenu(null),
      beginCreate,
      beginRename,
      openMove,
      toggleVisibility,
      setMoveTarget,
      confirmMove,
      cancelMove,
      moveDialog,
      toolbarCreate,
      toolbarRefresh,
      noteSelection,
      isRootOpen,
      toggleRoot,
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
      beginRename,
      openMove,
      toggleVisibility,
      setMoveTarget,
      confirmMove,
      cancelMove,
      moveDialog,
      toolbarCreate,
      toolbarRefresh,
      noteSelection,
      isRootOpen,
      toggleRoot,
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
      <MoveEntryDialog />
    </TreeCommandsContext.Provider>
  );
}

export function useTreeCommands(): TreeCommandsValue {
  const value = useContext(TreeCommandsContext);
  if (!value) throw new Error('useTreeCommands 必须在 TreeCommandsProvider 内使用');
  return value;
}
