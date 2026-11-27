/**
 * 文件树命令编排（UX-02C-01 创建 / UX-02C-02 改名与移动 / UX-02C-03-P1 隐藏 /
 * UX-02C-03-P2-02 回收 / UX-02C-04 标注 / UX-02C-05 交互统一）：
 * **右键菜单、顶部工具栏、行内输入框、移动对话框、双击改名、F2 / Shift+F10 的唯一入口**。
 *
 * 职责：把"右键了什么 / 工具栏在哪 / 焦点停在哪一行"折算成显式
 * `(projectId, 相对路径)`，管住行内命名与单飞提交，然后把结果交给
 * `DocumentActions` 去刷新层表。不 fetch、不碰磁盘、不复制任何授权判定；
 * 同名/路径/会话的权威判定在 Host。
 *
 * UX-02C-05 起，**可用性与禁用原因不再写在这份 JSX 里**：
 * `state/tree-commands.ts` 的 `treeCommandMatrix()` 是菜单、工具栏与键盘共用的唯一来源，
 * 这里只负责"命令 id → 执行函数"的映射，以及执行前的失效检测与菜单生命周期。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent, ReactNode } from 'react';
import type {
  CreateEntryKindDto,
  CreateEntryOutcome,
  ProjectSummary,
  ResourceMetadataDto,
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
  visibilityNoopNotice,
  visibilityNotice,
  visibilityUnknownNotice,
} from '../state/visibility.ts';
import { useDocumentActions } from '../state/DocumentActionsContext.tsx';
import { useResourceMetadata } from '../state/MetadataContext.tsx';
import { useTrash } from '../state/TrashContext.tsx';
import { useWorkspace } from '../state/WorkspaceContext.tsx';
import { validateProjectName } from '../state/add-project.ts';
import {
  menuIdentityOf,
  toolbarTargetOf,
  treeCommandMatrix,
  treeKeyIntentOf,
  treeTargetProblemOf,
  menuOrderOf,
  type TreeCommandId,
  type TreeCommandMatrix,
  type TreeCommandTarget,
} from '../state/tree-commands.ts';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
import { MoveEntryDialog } from './MoveEntryDialog.tsx';
import { RemoveProjectDialog } from './RemoveProjectEntry.tsx';
import { findEntryByPath } from './tree-model.ts';

export interface TreeTarget extends TreeCommandTarget {
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
  /**
   * 该行当前的展示元数据（UX-02C-04）。
   *
   * 传给对话框当"打开时的基准"：只有它才能算出"用户到底改了哪几个字段"，
   * 从而只提交差异，不覆盖别人刚改的其它字段。
   */
  readonly nodeMeta?: ResourceMetadataDto;
  /** 打开菜单那一刻该行的资源锚（UX-02C-04-R1）：执行前用来判断"还是不是那一行"。 */
  readonly nodeAnchor?: string | null;
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

/**
 * 项目**显示名称**的行内编辑（UX-02C-05 上提）。
 *
 * 与资源标注名、磁盘目录名是三件事：
 * - 显示名称属于项目注册信息（`renameProject`），改它不动路径、不动 `workspaceKey`；
 * - 标注名是资源元数据（UX-02C-04），只影响展示；
 * - 磁盘目录名只有用户自己在资源管理器里改，工作台不会去改它。
 */
export interface ProjectRenameState {
  readonly projectId: string;
  readonly draft: string;
  readonly error: string | null;
  readonly saving: boolean;
}

interface MenuState {
  readonly x: number;
  readonly y: number;
  /** 每次打开都换一个实例：键盘高亮/子菜单状态不从上一次右键带过来。 */
  readonly nonce: number;
  readonly target: TreeTarget;
  /** 打开时所属的"世界"；与当前世界不一致时菜单必须关闭（UX-02C-05）。 */
  readonly identity: string;
}

/** 树内焦点位置：F2 / Shift+F10 的"当前有效资源"。 */
interface FocusedRow {
  readonly target: TreeTarget;
  readonly element: HTMLElement | null;
  readonly left: number;
  readonly top: number;
  readonly height: number;
}

interface TreeCommandsValue {
  openContextMenu(event: MouseEvent, target: TreeTarget): void;
  closeContextMenu(): void;
  /** 右键菜单与工具栏都走这里；`presetExtension` 只影响行内输入的初值与选区。 */
  beginCreate(kind: CreateEntryKindDto, target: TreeTarget, presetExtension?: string): void;
  /** 右键文件/文件夹 / F2 / 双击名称 → 行内改名（预填原名，选主文件名）。 */
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
  /** 记录树内焦点行：F2 / Shift+F10 / 双击改名都以此为准。 */
  noteFocus(target: TreeTarget, element: HTMLElement | null): void;
  /** 树范围内的键盘处理（F2 / Shift+F10 / 菜单键 / Escape）。 */
  onTreeKeyDown(event: ReactKeyboardEvent<HTMLElement>): void;
  /** 项目根容器的展开态（R1-01）：与创建编排放在同一处，保证开始创建时一定可见。 */
  isRootOpen(projectId: string): boolean;
  toggleRoot(projectId: string): void;
  /** 项目显示名称的行内编辑（菜单、铅笔按钮、双击项目根名称共用）。 */
  readonly projectRename: ProjectRenameState | null;
  beginProjectRename(projectId: string): void;
  setProjectRenameDraft(value: string): void;
  submitProjectRename(): Promise<void>;
  cancelProjectRename(): void;
  /** 由右键菜单打开的项目移除确认框（与行内 🗑 按钮同一套检查与文案）。 */
  requestRemoveProject(projectId: string): void;
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
  const metadata = useResourceMetadata();
  const { ready, registry, resolveViewer, revision } = useCapabilities();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuSeq = useRef(0);
  const [naming, setNaming] = useState<NamingState | null>(null);
  const [moveDialog, setMoveDialog] = useState<MoveDialogState | null>(null);
  const [projectRename, setProjectRename] = useState<ProjectRenameState | null>(null);
  /** 菜单触发的移除：存项目快照而不是 id —— 移除成功后项目会从列表消失，
   * 但对话框还要把"已移除"的结果说完。 */
  const [removeTarget, setRemoveTarget] = useState<ProjectSummary | null>(null);
  /** "当前明确选中的目录"按项目记录：空白区 / 工具栏据此决定创建位置。 */
  const [selectedDirByProject, setSelectedDirByProject] = useState<Record<string, string>>({});
  /** 树内焦点行（F2 / Shift+F10 的"当前有效资源"）。 */
  const focusRef = useRef<FocusedRow | null>(null);
  /** 项目改名在途标记：同一 tick 连按两次 Enter 也只会发一次请求。 */
  const projectRenameBusy = useRef(false);
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

  /**
   * 菜单所属的"世界"。切换模式 / 工作区 / 当前项目都会让它变化，
   * 变化的瞬间旧菜单必须关闭——它的命令已经不属于当前界面。
   */
  const identity = menuIdentityOf({
    mode: state.mode,
    workspaceMode: state.workspaceMode,
    workspaceKey: state.workspaceKey,
    activeProjectId: state.activeProjectId,
  });

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

  /**
   * 执行前的失效检测（UX-02C-05）。
   *
   * 菜单是 portal，打开之后树可能已经刷新、项目可能已经不可用、文件可能已经被
   * 同名新对象替换。这里只用**界面已知**的信息判断；权威仍是 Host。
   */
  const targetProblem = useCallback(
    (target: TreeTarget): string | null => {
      if (target.projectId === null) {
        return treeTargetProblemOf({
          target,
          projectExists: false,
          projectReady: false,
          entryPresent: true,
          currentAnchor: null,
        });
      }
      const project = state.projects.find((item) => item.projectId === target.projectId);
      const levels = state.treeByProject[target.projectId] ?? {};
      const path = normalizeDir(target.nodePath ?? '');
      const root = target.origin === 'project-root';
      const entry = root || path === '' ? undefined : findEntryByPath(levels, path);
      const anchor = root
        ? (levels['']?.projectAnchor ?? null)
        : entry
          ? (levels[parentDirOf(path)]?.anchors?.[path] ?? null)
          : null;
      return treeTargetProblemOf({
        target,
        projectExists: Boolean(project),
        projectReady: project?.status === 'READY',
        entryPresent: root ? true : Boolean(entry),
        currentAnchor: anchor,
      });
    },
    [state.projects, state.treeByProject],
  );

  /** 菜单矩阵：菜单、工具栏、键盘共用同一份（UX-02C-05 阶段 B）。 */
  const matrixOf = useCallback(
    (target: TreeTarget): TreeCommandMatrix =>
      treeCommandMatrix(target, {
        supported: isSupported(target.projectId ?? state.activeProjectId),
        supportedExtensionCount: supportedExtensions.length,
      }),
    [isSupported, state.activeProjectId, supportedExtensions],
  );

  const beginCreate = useCallback(
    (kind: CreateEntryKindDto, target: TreeTarget, presetExtension?: string) => {
      setMenu(null);
      const problem = targetProblem(target);
      if (problem) {
        dispatch({ type: 'NOTICE', message: problem });
        return;
      }
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
    [dispatch, resolve, ensureRootOpen, state.treeByProject, targetProblem],
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
      const problem = targetProblem(target);
      if (problem) {
        dispatch({ type: 'NOTICE', message: problem });
        return;
      }
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
    [dispatch, ensureRootOpen, structureSource, targetProblem],
  );

  const openMove = useCallback(
    (target: TreeTarget) => {
      setMenu(null);
      const problem = targetProblem(target);
      if (problem) {
        dispatch({ type: 'NOTICE', message: problem });
        return;
      }
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
    [dispatch, state.treeByProject, structureSource, targetProblem],
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
      const problem = targetProblem(target);
      if (problem) {
        dispatch({ type: 'NOTICE', message: problem });
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
    [actions, dispatch, targetProblem],
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

  const noteFocus = useCallback((target: TreeTarget, element: HTMLElement | null) => {
    const rect = element?.getBoundingClientRect();
    focusRef.current = {
      target,
      element,
      left: rect?.left ?? 0,
      top: rect?.top ?? 0,
      height: rect?.height ?? 0,
    };
  }, []);

  const activeTarget = useCallback(
    (): TreeTarget => toolbarTargetOf(state.activeProjectId),
    [state.activeProjectId],
  );
  const toolbarCreate = useCallback(
    (kind: CreateEntryKindDto) => beginCreate(kind, activeTarget()),
    [activeTarget, beginCreate],
  );
  const toolbarRefresh = useCallback(() => {
    const target = activeTarget();
    const problem = targetProblem(target);
    if (problem) {
      dispatch({ type: 'NOTICE', message: problem });
      return;
    }
    const resolved = resolve(target);
    if (!resolved.ok) {
      dispatch({ type: 'NOTICE', message: resolved.reason });
      return;
    }
    void actions.refreshTreeLevel(resolved.projectId, resolved.parentDir);
  }, [activeTarget, dispatch, resolve, actions, targetProblem]);

  const openContextMenu = useCallback((event: MouseEvent, target: TreeTarget) => {
    // 输入框里的原生文本右键（剪切/复制/粘贴）不能抢
    if ((event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    menuSeq.current += 1;
    setMenu({ x: event.clientX, y: event.clientY, nonce: menuSeq.current, target, identity });
  }, [identity]);

  /**
   * 菜单关闭（UX-02C-05 阶段 F）：
   * - 命令执行时先关闭再执行（`ContextMenu` 已经这么做），这里只兜住 Escape；
   * - Escape 关闭后把焦点还给触发它的那一行——键盘用户不该被扔回页面顶部。
   */
  const closeContextMenu = useCallback((reason?: 'escape' | 'other') => {
    setMenu(null);
    if (reason === 'escape') {
      const element = focusRef.current?.element;
      if (element && element.isConnected) element.focus();
    }
  }, []);

  /** 世界变了 → 旧菜单立刻失效（不向其他工作区发送旧操作）。 */
  useEffect(() => {
    setMenu((current) => (current && current.identity !== identity ? null : current));
  }, [identity]);

  /** 项目被移除 / 改名失败后不该继续挂着一个指向它的编辑器。 */
  useEffect(() => {
    if (!projectRename) return;
    if (!state.projects.some((project) => project.projectId === projectRename.projectId)) {
      setProjectRename(null);
    }
  }, [state.projects, projectRename]);

  const beginProjectRename = useCallback(
    (projectId: string) => {
      setMenu(null);
      const project = state.projects.find((item) => item.projectId === projectId);
      if (!project) {
        dispatch({ type: 'NOTICE', message: '该项目已不在工作区里' });
        return;
      }
      if (!isSupported(projectId)) {
        dispatch({ type: 'NOTICE', message: '只有已授权的真实项目可以修改显示名称' });
        return;
      }
      setProjectRename({ projectId, draft: project.name, error: null, saving: false });
    },
    [dispatch, isSupported, state.projects],
  );

  const setProjectRenameDraft = useCallback((value: string) => {
    setProjectRename((current) => (current ? { ...current, draft: value, error: null } : current));
  }, []);

  const cancelProjectRename = useCallback(() => setProjectRename(null), []);

  const submitProjectRename = useCallback(async (): Promise<void> => {
    if (!projectRename || projectRename.saving || projectRenameBusy.current) return;
    const checked = validateProjectName(projectRename.draft);
    // 本地预检只挡"注定失败"的请求；权威判断仍在 Host
    if (!checked.ok) {
      setProjectRename((current) => (current ? { ...current, error: checked.message } : current));
      return;
    }
    const project = state.projects.find((item) => item.projectId === projectRename.projectId);
    if (!project) {
      setProjectRename(null);
      dispatch({ type: 'NOTICE', message: '该项目已不在工作区里' });
      return;
    }
    // 名称没变：不发请求、不制造"已保存"的假象
    if (project.name === checked.name) {
      setProjectRename(null);
      return;
    }
    projectRenameBusy.current = true;
    setProjectRename((current) => (current ? { ...current, saving: true, error: null } : current));
    try {
      const outcome = await actions.renameProject(projectRename.projectId, checked.name);
      if (outcome.status === 'APPLIED') {
        setProjectRename(null);
        return;
      }
      // 失败：界面保持原名（未派发任何改名），输入保留供修正
      setProjectRename((current) => (current ? { ...current, saving: false, error: outcome.message } : current));
    } catch {
      setProjectRename((current) =>
        current ? { ...current, saving: false, error: '重命名失败：网络或本地服务不可用' } : current,
      );
    } finally {
      projectRenameBusy.current = false;
    }
  }, [actions, dispatch, projectRename, state.projects]);

  const requestRemoveProject = useCallback(
    (projectId: string) => {
      setMenu(null);
      const project = state.projects.find((item) => item.projectId === projectId);
      if (!project) {
        dispatch({ type: 'NOTICE', message: '该项目已不在工作区里' });
        return;
      }
      setRemoveTarget(project);
    },
    [dispatch, state.projects],
  );

  /**
   * 树范围内的键盘（阶段 E2）。
   *
   * 事件只绑在文件树的根 `<ul>` 上：焦点在正文编辑器 / 输入框 / 其它模块时
   * 根本不会冒泡到这里，因此不存在"劫持别人的快捷键"。
   */
  const onTreeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const element = event.target as HTMLElement | null;
      const inEditable = Boolean(
        element?.closest('input, textarea, select, [contenteditable="true"]'),
      );
      const focused = focusRef.current;
      const intent = treeKeyIntentOf({
        key: event.key,
        shiftKey: event.shiftKey,
        inEditable,
        hasTarget: focused !== null,
      });
      if (!intent) return;
      if (intent === 'escape') {
        // 输入行自己有 Escape（取消改名/创建）；这里只负责菜单
        if (menu) {
          event.preventDefault();
          closeContextMenu('escape');
        }
        return;
      }
      const target = focused?.target;
      if (!target) return;
      if (intent === 'rename') {
        event.preventDefault();
        // 已经有输入行/改名会话时不叠加：不把用户正在打的字换掉
        if (naming || projectRename) return;
        const matrix = matrixOf(target);
        if (!matrix.rename.visible) return;
        if (matrix.rename.disabled) {
          dispatch({ type: 'NOTICE', message: matrix.rename.hint ?? '当前不能改名' });
          return;
        }
        beginRename(target);
        return;
      }
      // context-menu：没有鼠标坐标，就落在焦点行的左下方
      event.preventDefault();
      menuSeq.current += 1;
      setMenu({
        x: (focused?.left ?? 0) + 12,
        y: (focused?.top ?? 0) + (focused?.height ?? 0),
        nonce: menuSeq.current,
        target,
        identity,
      });
    },
    [beginRename, closeContextMenu, dispatch, identity, matrixOf, menu, naming, projectRename],
  );

  /* ---------------- 菜单项：矩阵 → 具体命令 ---------------- */

  const openMetadata = useCallback(
    (target: TreeTarget, focus: 'alias' | 'tags' | 'color') => {
      setMenu(null);
      const problem = targetProblem(target);
      if (problem) {
        dispatch({ type: 'NOTICE', message: problem });
        return;
      }
      const projectId = target.projectId;
      const path = target.nodePath == null ? '' : normalizeDir(target.nodePath);
      if (!projectId || (path === '' && target.origin !== 'project-root')) {
        dispatch({ type: 'NOTICE', message: '只有已授权项目里的文件、文件夹或项目根可以标注' });
        return;
      }
      metadata.open(
        {
          projectId,
          path,
          name: path === '' ? '项目根' : (path.split('/').pop() ?? path),
          ...(target.nodeMeta ? { meta: target.nodeMeta } : {}),
        },
        focus,
      );
    },
    [dispatch, metadata, targetProblem],
  );

  const menuItems = useMemo<readonly MenuItem[]>(() => {
    if (!menu) return [];
    const target = menu.target;
    const matrix = matrixOf(target);
    /** 计时的"刷新"：目标目录由与创建相同的解析规则给出，链接/无项目时不发请求。 */
    const refresh = (): void => {
      setMenu(null);
      const problem = targetProblem(target);
      if (problem) {
        dispatch({ type: 'NOTICE', message: problem });
        return;
      }
      const resolved = resolve(target);
      if (!resolved.ok) {
        dispatch({ type: 'NOTICE', message: resolved.reason });
        return;
      }
      void actions.refreshTreeLevel(resolved.projectId, resolved.parentDir);
    };
    const create = (kind: CreateEntryKindDto, preset?: string) => () => beginCreate(kind, target, preset);
    const items: Record<TreeCommandId, MenuItem> = {
      rename: { id: 'rename', label: '重命名', command: () => beginRename(target) },
      move: { id: 'move', label: '移动到…', command: () => openMove(target) },
      // 隐藏与取消隐藏共用一条"对这一个节点动手但不碰磁盘"的语义，矩阵保证只出现一条
      hide: {
        id: 'hide',
        label: '从文件树隐藏',
        command: () => void toggleVisibility(target, target.nodeHidden === true),
      },
      unhide: {
        id: 'unhide',
        label: '取消隐藏',
        command: () => void toggleVisibility(target, true),
      },
      trash: {
        id: 'trash',
        label: '移入回收区',
        command: () => {
          setMenu(null);
          const problem = targetProblem(target);
          if (problem) {
            dispatch({ type: 'NOTICE', message: problem });
            return;
          }
          const projectId = target.projectId;
          const path = normalizeDir(target.nodePath ?? '');
          if (!projectId || path === '') {
            dispatch({ type: 'NOTICE', message: '只有已授权项目里的普通文件可以移入回收区' });
            return;
          }
          trash.openDelete(projectId, path);
        },
      },
      'meta-alias': { id: 'meta-alias', label: '设置标注名…', command: () => openMetadata(target, 'alias') },
      'meta-tags': { id: 'meta-tags', label: '编辑标签…', command: () => openMetadata(target, 'tags') },
      'meta-color': { id: 'meta-color', label: '设置颜色…', command: () => openMetadata(target, 'color') },
      'new-file': { id: 'new-file', label: '新建文件', command: create('file') },
      'new-folder': { id: 'new-folder', label: '新建文件夹', command: create('directory') },
      'new-supported': {
        id: 'new-supported',
        label: '创建已支持的扩展文件',
        children: supportedExtensions.map((item) => ({
          id: `new-supported:${item.extension}`,
          label: item.label,
          command: create('file', item.extension),
        })),
      },
      refresh: {
        id: 'refresh',
        label: target.origin === 'project-root' ? '刷新项目根' : '刷新此目录',
        command: refresh,
      },
      'rename-project': {
        id: 'rename-project',
        label: '修改项目显示名称…',
        command: () => target.projectId && beginProjectRename(target.projectId),
      },
      'remove-project': {
        id: 'remove-project',
        label: '从工作台移除项目…',
        command: () => target.projectId && requestRemoveProject(target.projectId),
      },
    };
    const order = menuOrderOf(target.origin);
    return order.map((id) => {
      const base = items[id];
      const cell = matrix[id];
      const children = base.children?.filter((child) => !child.hidden);
      return {
        ...base,
        ...(children ? { children } : {}),
        hidden: !cell.visible || base.hidden === true,
        ...(cell.hint ? { hint: cell.hint } : {}),
        disabled: cell.disabled,
      };
    });
  }, [
    menu,
    matrixOf,
    isSupported,
    state.activeProjectId,
    dispatch,
    targetProblem,
    resolve,
    actions,
    beginCreate,
    beginRename,
    openMove,
    openMetadata,
    supportedExtensions,
    toggleVisibility,
    trash,
    beginProjectRename,
    requestRemoveProject,
  ]);

  const value = useMemo<TreeCommandsValue>(
    () => ({
      openContextMenu,
      closeContextMenu: () => closeContextMenu('other'),
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
      noteFocus,
      onTreeKeyDown,
      isRootOpen,
      toggleRoot,
      projectRename,
      beginProjectRename,
      setProjectRenameDraft,
      submitProjectRename,
      cancelProjectRename,
      requestRemoveProject,
      naming,
      setDraft: (draft) =>
        setNaming((current) => (current ? { ...current, draft, error: null } : current)),
      submitNaming,
      cancelNaming,
      supportedExtensions,
    }),
    [
      openContextMenu,
      closeContextMenu,
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
      noteFocus,
      onTreeKeyDown,
      isRootOpen,
      toggleRoot,
      projectRename,
      beginProjectRename,
      setProjectRenameDraft,
      submitProjectRename,
      cancelProjectRename,
      requestRemoveProject,
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
          identity={menu.identity}
          onClose={(reason) => closeContextMenu(reason === 'escape' ? 'escape' : 'other')}
        />
      )}
      <MoveEntryDialog />
      {removeTarget && (
        <RemoveProjectDialog
          project={removeTarget}
          open
          onClose={() => setRemoveTarget(null)}
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
