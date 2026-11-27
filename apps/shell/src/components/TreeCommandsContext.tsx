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
import {
  captureStructureIntent,
  structureSessionApplies,
  structureSubmitIntentProblem,
  type StructureIdentityState,
  type StructureIntent,
} from '../state/structure-intent.ts';
import { inlineNoticeTargets } from '../state/structure-ownership.ts';
import { structureRejectionInvalidatesSource } from '../state/structure-refresh.ts';
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
import {
  menuIdentityOf,
  toolbarTargetOf,
  treeCommandMatrix,
  identityVerificationOf,
  treeKeyIntentOf,
  treeTargetProblemOf,
  menuOrderOf,
  workspaceScopeOf,
  type TreeCommandId,
  type TreeCommandMatrix,
  type TreeCommandTarget,
} from '../state/tree-commands.ts';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
import { MoveEntryDialog } from './MoveEntryDialog.tsx';
import { RemoveProjectDialog } from './RemoveProjectEntry.tsx';
import { findEntryByPath } from './tree-model.ts';
import { createProjectRenameFlow } from '../state/project-rename.ts';

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
  /**
   * 会话票据（UX-02C-02-R2.1 / B02）。
   *
   * 每个新输入行一个号：请求结果回来时据此判断"这条错误该写进哪个输入框"。
   * 只比项目 + 路径不够——同一行可以先收起再打开，那是两个会话。
   */
  readonly sessionId: number;
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
  /**
   * rename 专用：打开输入行那一刻的**身份预期**（UX-02C-02-R2 / R2.1）。
   *
   * 冻结的锚 + 身份状态 + 世界（模式/工作区/代次）+ 会话票据。
   * 输入期间不随界面刷新自动更新：把它悄悄换成最新值，
   * 等于把"要改的已经不是那个对象了"藏起来。
   */
  readonly intent?: StructureIntent;
}

export interface MoveDialogState {
  readonly projectId: string;
  readonly sourcePath: string;
  readonly targetName: string;
  readonly entryKind: StructureEntryKind;
  readonly targetParentDir: string;
  /**
   * 当前选中目标文件夹的身份预期（UX-02C-02-R2.1 / D）。
   *
   * 项目根用根层的 `projectAnchor`；普通文件夹用父层的锚表。用户重新选择目标时
   * 重新捕获——**绝不**在提交时现算（那等于承认"搬进哪个目录都行"）。
   */
  readonly targetAnchor: string | null;
  readonly targetVerification: StructureIdentityState;
  readonly options: readonly string[];
  readonly error: string | null;
  readonly submitting: boolean;
  /** 打开对话框那一刻的身份预期（同 `NamingState.intent`）。 */
  readonly intent: StructureIntent;
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
  /** 会话票据：请求回来时据此判断"这条结果属于哪个会话"（UX-02C-05-R1）。 */
  readonly sessionId: number;
  /** 打开会话时所属的世界（模式 + 工作区模式 + 工作区摘要）。 */
  readonly scope: string;
  /**
   * 打开会话时的**当前活动项目**（UX-02C-05-R1.1）。
   *
   * 会话属于"打开它的那个界面状态"，不只是属于项目：活动项目一变，
   * 请求回来时就不能再写回这个会话（也不能假装它还没被收起）。
   * 注意它与 `projectId` 不同——右键菜单可以给**非当前项目**改显示名。
   */
  readonly activeProjectAtStart: string | null;
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
  /** 命名/移动会话的**最新**值：`await` 之后只能看它，不能看闭包里的旧值。 */
  const namingRef = useRef<NamingState | null>(null);
  const moveRef = useRef<MoveDialogState | null>(null);
  namingRef.current = naming;
  moveRef.current = moveDialog;
  /** 结构变更会话序号：每个新输入行 / 移动对话框一个票据。 */
  const structureSeq = useRef(0);
  const [projectRename, setProjectRename] = useState<ProjectRenameState | null>(null);
  /** 会话序号：每个新会话一个票据，结果回来时据此判断归属。 */
  const renameSeq = useRef(0);
  /** 当前会话的**最新**值：`await` 之后要拿它核对，不能看闭包里的旧值。 */
  const renameRef = useRef<ProjectRenameState | null>(null);
  renameRef.current = projectRename;
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
  /** `isSupported` 的同步镜像：改名编排在 await 之后要用"这一刻"的结论。 */
  const supportedRef = useRef(isSupported);
  supportedRef.current = isSupported;

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

  /**
   * 项目改名会话所属的世界（R1-04）：**不含**当前项目。
   *
   * 与菜单身份分开是有意的：菜单要随"当前项目"一起关闭，而改名会话的归属
   * 只关心"还在不在同一个工作区/模式里"；切换当前项目由单独一条 effect 收敛。
   */
  const workspaceScope = useMemo(
    () =>
      workspaceScopeOf({
        mode: state.mode,
        workspaceMode: state.workspaceMode,
        workspaceKey: state.workspaceKey,
      }),
    [state.mode, state.workspaceMode, state.workspaceKey],
  );

  /**
   * 同步归属快照（R1.1）。
   *
   * 为什么不能只看 state：请求回来的回调是微任务，可能在 React 提交后的
   * effect 之前跑。那时 `projectRename` 还是旧对象、`sessionId` 也还对得上，
   * 只看票据会把上一个世界的结果写进看起来还当前的界面。ref 在每次渲染时
   * 立刻更新，读到的就是"这一刻真实的世界"。
   */
  const scopeRef = useRef(workspaceScope);
  scopeRef.current = workspaceScope;
  const activeProjectRef = useRef(state.activeProjectId);
  activeProjectRef.current = state.activeProjectId;
  /**
   * 同一套同步镜像里的"状态与能力"：改名编排在 await 之后要读实时值，
   * 而它的 useMemo 依赖刻意保持稳定（否则每次渲染都重建编排器与单飞锁）。
   */
  const stateRef = useRef(state);
  stateRef.current = state;
  /**
   * DocumentActions 的实时镜像（R2.1）：结构变更编排只装配**一次**（单飞锁必须
   * 跨重渲染存活），但其中每一步动作都必须是最新的那份实现。
   */
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  /** 提示回调的实时镜像（它依赖 dispatch 与两个会话 ref）。 */
  const noticeRef = useRef<(message: string, sessionId: number | null) => void>(() => undefined);
  /** 意图核验的实时镜像（依赖当前层表、票据与当前世界）。 */
  const verifyIntentRef = useRef<(intent: StructureIntent) => string | null>(() => null);

  /**
   * 提示落地：**全局状态栏**与**行内错误**分开表达（UX-02C-02-R2.1 / B02）。
   *
   * 旧实现把同一条提示同时写进 `naming` 与 `moveDialog`：只要两个会话同时存在，
   * 另一个会话就会收到一条与它无关的错误（"这一行对应的对象已经变化"出现在
   * 一个完全不同的输入框里），用户据此会去改错的东西。
   *
   * 现在按**会话票据**路由：`sessionId` 是发起这次请求的那个会话，
   * 只有票据相同的行内界面才接收这条错误。`sessionId === null`（例如编辑器里
   * 的命令）只写状态栏。
   */
  const noticeFor = useCallback(
    (message: string, sessionId: number | null) => {
      dispatch({ type: 'NOTICE', message });
      const target = inlineNoticeTargets({
        sessionId,
        namingSessionId: namingRef.current?.sessionId ?? null,
        moveSessionId: moveRef.current?.intent.sessionId ?? null,
      });
      if (target.naming) {
        setNaming((current) => (current ? { ...current, error: message } : current));
      }
      if (target.move) {
        setMoveDialog((current) => (current ? { ...current, error: message } : current));
      }
    },
    [dispatch],
  );
  noticeRef.current = noticeFor;

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
        onNotice: (message, sessionId) => noticeFor(message, sessionId ?? null),
      }),
    [actions, dispatch, noticeFor],
  );

  /**
   * 结构变更的提交前核验（UX-02C-02-R2）。
   *
   * 只读**界面已知**的信息：从当前层表里读这一行的锚与身份状态，与打开输入行时
   * 冻结的预期比对。不一致就本地拒绝（零请求）；一致也只是"可以发出去"，
   * 权威判定仍在 Host（它会自己读一次源身份再算一次锚）。
   */
  const currentIdentityOf = useCallback(
    (projectId: string, path: string): { anchor: string | null; verification: StructureIdentityState } => {
      const levels = stateRef.current.treeByProject[projectId] ?? {};
      const entry = findEntryByPath(levels, path);
      const level = levels[parentDirOf(path)];
      const anchor = entry ? (level?.anchors?.[path] ?? null) : null;
      return {
        anchor,
        verification: identityVerificationOf({ anchor, support: level?.identitySupport ?? null }),
      };
    },
    [],
  );

  /**
   * 移动目标文件夹的身份（R2.1 / D）。
   *
   * 与源锚同一套口径：项目根用根层的 `projectAnchor`（根令牌摘要），普通文件夹用
   * 它所在层的锚表。用户选目标的那一刻捕获一次；重新选择时重新捕获。
   * 拿不到就是 `unverified` —— **不允许**"不知道也搬过去"。
   */
  const targetIdentityOf = useCallback(
    (projectId: string, dir: string): { anchor: string | null; verification: StructureIdentityState } => {
      const levels = stateRef.current.treeByProject[projectId] ?? {};
      if (dir === '') {
        const root = levels[''];
        const anchor = root?.projectAnchor ?? null;
        return {
          anchor,
          verification: identityVerificationOf({ anchor, support: root?.identitySupport ?? null }),
        };
      }
      const level = levels[parentDirOf(dir)];
      const anchor = level?.anchors?.[dir] ?? null;
      return {
        anchor,
        verification: identityVerificationOf({ anchor, support: level?.identitySupport ?? null }),
      };
    },
    [],
  );

  /**
   * 结构变更的提交前意图核验（UX-02C-02-R2 / R2.1）。
   *
   * 三件事都要核，缺一不可：
   * 1. **票据**：这条意图还属于当前这一行（同一行先后开过两个会话时，旧票据失效）；
   * 2. **世界**：模式 / 工作区 / 加载代次都没变（`Live → Demo → Live` 之后
   *    项目 ID、路径、锚可以完全一样，但那是另一个世界）；
   * 3. **源身份**：当前这一行的锚还是打开意图时那一个。
   *
   * 注意它核验的是**传进来的那份冻结意图**，不是按 `projectId + sourcePath`
   * 重新找一次"最新意图"——同一行先后开两个会话时，后者会把前者顶掉，
   * 于是核验的根本不是要提交的那一个（R2.1 / B04）。
   */
  const structureSessionCurrent = useCallback((intent: StructureIntent): boolean => {
    const naming = namingRef.current;
    const namingSessionId =
      naming && naming.mode === 'rename' && naming.intent ? naming.intent.sessionId : null;
    const moveSessionId = moveRef.current?.intent.sessionId ?? null;
    return (
      structureSessionApplies({ sessionId: intent.sessionId, currentSessionId: namingSessionId }) ||
      structureSessionApplies({ sessionId: intent.sessionId, currentSessionId: moveSessionId })
    );
  }, []);

  const verifyStructureIntent = useCallback(
    (intent: StructureIntent): string | null =>
      structureSubmitIntentProblem({
        intent,
        sessionCurrent: structureSessionCurrent(intent),
        world: actionsRef.current.structureWorld(),
        current: currentIdentityOf(intent.projectId, intent.sourcePath),
      }),
    [currentIdentityOf, structureSessionCurrent],
  );
  verifyIntentRef.current = verifyStructureIntent;

  /**
   * 单飞锁必须**跨重渲染**存活（R2.1 / B04）。
   *
   * 之前用 `useMemo` 装配：只要 `actions` / 提示回调换了引用就会重建一个 runner，
   * 而"在途"标记是 runner 的内部变量——重建即丢失，用户连按两次就产生两条并发
   * 结构变更。这里改为**只装配一次**，所有依赖通过 ref 读取实时值。
   */
  const structureRunnerRef = useRef<ReturnType<typeof createStructureRunner> | null>(null);
  if (structureRunnerRef.current === null) {
    structureRunnerRef.current = createStructureRunner({
      rename: (projectId, sourcePath, name, sourceAnchor) =>
        actionsRef.current.renameEntry(projectId, sourcePath, name, sourceAnchor),
      move: (projectId, sourcePath, targetParentDir, name, sourceAnchor, targetAnchor) =>
        actionsRef.current.moveEntry(
          projectId,
          sourcePath,
          targetParentDir,
          name,
          sourceAnchor,
          targetAnchor,
        ),
      // Host 重启后内存会话表归零，Shell 本地标签/草稿这道门必须独立存在
      localBlockers: (projectId, sourcePath, entryKind) =>
        localStructureBlockers(stateRef.current.tabs, projectId, sourcePath, entryKind),
      verifyIntent: ({ intent }) => verifyIntentRef.current(intent),
      checkLocations: async (projectId, sourceParentDir, targetParentDir, intent) => {
        await actionsRef.current.checkStructureLocations(
          projectId,
          sourceParentDir,
          targetParentDir,
          intent,
        );
      },
      onApplied: (outcome, intent) => {
        void actionsRef.current.applyStructureChange(outcome, intent);
      },
      /**
       * 拒绝即"这一层关于源对象的缓存已经过期"（UX-02C-02-R2）。
       *
       * `ERR_ENTRY_SOURCE_CHANGED` / `ERR_RESOURCE_NOT_FOUND` 是 Host 给出的磁盘事实，
       * 而层表里那一行还挂着**替换前**的锚。此时只重取源父层（不递归、不动其它层、
       * 不清草稿），行上的锚随之更新；用户重新选中当前对象就能正常改名/移动。
       *
       * R2.1：重取本身也按意图核验归属——旧世界的拒绝不得让新工作区去读旧路径。
       */
      onRejected: (outcome, target, intent) => {
        if (!structureRejectionInvalidatesSource(outcome.errorCode)) return;
        void actionsRef.current.refreshStructureSourceParent(
          target.projectId,
          target.sourcePath,
          intent,
        );
      },
      onNotice: (message, sessionId) => noticeRef.current(message, sessionId),
    });
  }
  const structureRunner = structureRunnerRef.current;

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
      const level = root ? levels[''] : levels[parentDirOf(path)];
      const anchor = root
        ? (levels['']?.projectAnchor ?? null)
        : entry
          ? (levels[parentDirOf(path)]?.anchors?.[path] ?? null)
          : null;
      /*
       * 当前身份状态必须显式给出（R1.1）：只传 `currentAnchor` 会把
       * "Provider 无能力"和"这次没探到"混成同一个 null。层表带着 Host 声明的
       * 能力（`identitySupport`），这里用它把两者分开；未声明一律 `unverified`。
       */
      const currentIdentity = identityVerificationOf({
        anchor,
        support: level?.identitySupport ?? null,
      });
      return treeTargetProblemOf({
        target,
        projectExists: Boolean(project),
        projectReady: project?.status === 'READY',
        entryPresent: root ? true : Boolean(entry),
        currentAnchor: anchor,
        currentIdentity,
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
        sessionId: (structureSeq.current += 1),
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
      const anchor = target.nodeAnchor ?? null;
      const verification = identityVerificationOf({
        anchor,
        support: stateRef.current.treeByProject[source.projectId]?.[draft.parentDir]?.identitySupport ?? null,
      });
      const captured = captureStructureIntent({
        projectId: source.projectId,
        sourcePath: draft.sourcePath,
        entryKind: source.entryKind,
        anchor,
        verification,
        world: actions.structureWorld(),
        sessionId: (structureSeq.current += 1),
      });
      if (!captured.ok) {
        dispatch({ type: 'NOTICE', message: captured.reason });
        return;
      }
      setNaming({
        mode: 'rename',
        sessionId: captured.intent.sessionId,
        projectId: source.projectId,
        parentDir: draft.parentDir,
        kind: source.entryKind === 'directory' ? 'directory' : 'file',
        draft: draft.draft,
        selection: draft.selection,
        error: null,
        submitting: false,
        sourcePath: draft.sourcePath,
        entryKind: source.entryKind,
        intent: captured.intent,
      });
    },
    [actions, dispatch, ensureRootOpen, structureSource, targetProblem],
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
      const anchor = target.nodeAnchor ?? null;
      const verification = identityVerificationOf({
        anchor,
        support: levels[source.parentDir]?.identitySupport ?? null,
      });
      const captured = captureStructureIntent({
        projectId: source.projectId,
        sourcePath: source.sourcePath,
        entryKind: source.entryKind,
        anchor,
        verification,
        world: actions.structureWorld(),
        sessionId: (structureSeq.current += 1),
      });
      if (!captured.ok) {
        dispatch({ type: 'NOTICE', message: captured.reason });
        return;
      }
      const initialTarget = options[0] ?? '';
      const targetIdentity = targetIdentityOf(source.projectId, initialTarget);
      setMoveDialog({
        projectId: source.projectId,
        sourcePath: source.sourcePath,
        targetName: entryNameOf(source.sourcePath),
        entryKind: source.entryKind,
        targetParentDir: initialTarget,
        targetAnchor: targetIdentity.anchor,
        targetVerification: targetIdentity.verification,
        options,
        error: null,
        submitting: false,
        intent: captured.intent,
      });
    },
    [actions, dispatch, state.treeByProject, structureSource, targetIdentityOf, targetProblem],
  );

  /**
   * 重新选择目标 = 重新捕获目标身份。
   *
   * 不在提交时现算：那等于承认"搬到哪个目录都行"。用户选中哪个目录，
   * 就锁定那一刻的那一个对象；它后来被删除重建，提交必须被拒。
   */
  const setMoveTarget = useCallback(
    (dir: string) => {
      setMoveDialog((current) => {
        if (!current || !current.options.includes(dir)) return current;
        const identity = targetIdentityOf(current.projectId, dir);
        return {
          ...current,
          targetParentDir: dir,
          targetAnchor: identity.anchor,
          targetVerification: identity.verification,
          error: null,
        };
      });
    },
    [targetIdentityOf],
  );

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
    const intent = moveDialog.intent;
    setMoveDialog((current) => (current ? { ...current, submitting: true, error: null } : current));
    const result = await structureRunner.submit({
      kind: 'move',
      projectId: moveDialog.projectId,
      sourcePath: moveDialog.sourcePath,
      targetParentDir: moveDialog.targetParentDir,
      targetName: moveDialog.targetName,
      entryKind: moveDialog.entryKind,
      intent,
      // 目标身份是用户在对话框里选中的那一个；`null` 会被本地拒绝（零请求）
      targetAnchor: moveDialog.targetAnchor ?? '',
    });
    /**
     * 会话归属（UX-02C-02-R2）：`await` 期间用户可能已经关掉对话框、或对另一行
     * 重新打开了移动框。那两种情况下这条结果都不该再写回界面——
     * 尤其是"失败原因"绝不能出现在一个不相干的对话框里。
     */
    if (
      !structureSessionApplies({
        sessionId: intent.sessionId,
        currentSessionId: moveRef.current?.intent.sessionId ?? null,
      })
    ) {
      return;
    }
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
    /** rename 必须带着打开输入行时冻结的身份预期；缺失就不发请求。 */
    const intent = naming.mode === 'rename' ? naming.intent : undefined;
    if (naming.mode === 'rename' && !intent) {
      setNaming((current) =>
        current ? { ...current, error: '缺少源文件的身份信息：请刷新文件树后重新发起操作' } : current,
      );
      return;
    }
    setNaming((current) => (current ? { ...current, submitting: true, error: null } : current));

    const result =
      naming.mode === 'rename' && intent
        ? await structureRunner.submit({
            kind: 'rename',
            projectId: naming.projectId,
            sourcePath: naming.sourcePath ?? '',
            targetParentDir: naming.parentDir,
            targetName: naming.draft,
            entryKind: naming.entryKind ?? 'file',
            intent,
          })
        : await runner.submit({
            projectId: naming.projectId,
            parentDir: naming.parentDir,
            name: naming.draft,
            kind: naming.kind,
            sessionId: naming.sessionId,
            ...(naming.presetExtension ? { presetExtension: naming.presetExtension } : {}),
          });
    /**
     * 改名会话的归属（UX-02C-02-R2）：结果回来时输入行可能已经被收起、
     * 或者已经被另一行的改名会话顶替。那条结果（尤其是"对象已变化"这类拒绝原因）
     * 绝不能写进别人的输入行。
     */
    const currentNaming = namingRef.current;
    if (intent) {
      const currentSessionId =
        currentNaming && currentNaming.mode === 'rename' && currentNaming.intent
          ? currentNaming.intent.sessionId
          : null;
      if (!structureSessionApplies({ sessionId: intent.sessionId, currentSessionId })) return;
    } else if (currentNaming?.sessionId !== naming.sessionId) {
      /**
       * 创建会话的归属（R2.1 / B02）：结果回来时输入行可能已经被收起、或已经
       * 被另一个创建会话顶替。旧结果不得把它重新打开，也不得写进别人的错误位。
       */
      return;
    }
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

  /**
   * 项目显示名编辑会话的三道收敛（R1-04）：
   * 1. 项目从列表里消失 → 收起（没有可改的对象了）；
   * 2. 工作区 / 模式变了 → 收起（旧世界的草稿不能带到新世界）；
   * 3. 切换当前项目 → 收起（会话属于具体的项目，不跟着焦点走）。
   *
   * 这里只清**界面会话**；已经发出的请求由 `submitProjectRename` 自己按票据收尾，
   * 不会因为会话被收起就被当成"没发出去"，也不会自动重发。
   */
  useEffect(() => {
    if (!projectRename) return;
    if (!state.projects.some((project) => project.projectId === projectRename.projectId)) {
      setProjectRename(null);
    }
  }, [state.projects, projectRename]);

  useEffect(() => {
    setProjectRename((current) => (current && current.scope !== workspaceScope ? null : current));
  }, [workspaceScope]);

  useEffect(() => {
    setProjectRename(null);
  }, [state.activeProjectId]);

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
      renameSeq.current += 1;
      setProjectRename({
        sessionId: renameSeq.current,
        scope: workspaceScope,
        activeProjectAtStart: state.activeProjectId,
        projectId,
        draft: project.name,
        error: null,
        saving: false,
      });
    },
    [dispatch, isSupported, state.activeProjectId, state.projects, workspaceScope],
  );

  const setProjectRenameDraft = useCallback((value: string) => {
    setProjectRename((current) => (current ? { ...current, draft: value, error: null } : current));
  }, []);

  const cancelProjectRename = useCallback(() => setProjectRename(null), []);

  /**
   * 项目改名会话的编排（UX-02C-05-R1.2）：会话层归属判定全在
   * `state/project-rename.ts`，这里只注入宿主依赖。
   *
   * 读的一律是 **ref 里的实时值**：`await` 之后要判断"这一刻的世界"，闭包里的
   * `state` / `isSupported` 都可能已经过期。
   */
  const renameFlow = useMemo(
    () =>
      createProjectRenameFlow({
        session: () => {
          const current = renameRef.current;
          return current
            ? {
                sessionId: current.sessionId,
                scope: current.scope,
                activeProjectAtStart: current.activeProjectAtStart,
                projectId: current.projectId,
                draft: current.draft,
                saving: current.saving,
              }
            : null;
        },
        currentScope: () => scopeRef.current,
        currentActiveProject: () => activeProjectRef.current,
        projects: () => stateRef.current.projects,
        supported: (projectId) => supportedRef.current(projectId),
        // 唯一一条真实链路；全局归属回填在 DocumentActions 里（R1.2 / F03）
        rename: (projectId, name) => actions.renameProject(projectId, name),
        tryLock: () => {
          if (projectRenameBusy.current) return false;
          projectRenameBusy.current = true;
          return true;
        },
        unlock: () => {
          projectRenameBusy.current = false;
        },
        setSaving: (sessionId) =>
          setProjectRename((current) =>
            current && current.sessionId === sessionId
              ? { ...current, saving: true, error: null }
              : current,
          ),
        close: (sessionId) =>
          setProjectRename((current) => (current && current.sessionId === sessionId ? null : current)),
        fail: (sessionId, message) =>
          setProjectRename((current) =>
            current && current.sessionId === sessionId
              ? { ...current, saving: false, error: message }
              : current,
          ),
        notice: (message) => dispatch({ type: 'NOTICE', message }),
      }),
    [actions, dispatch],
  );

  const submitProjectRename = useCallback(async (): Promise<void> => {
    await renameFlow.submit();
  }, [renameFlow]);

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
