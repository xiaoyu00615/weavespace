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
  type RemoveBlockerCode,
  type RemovalPrecheckOutcome,
  type WeaveSpaceClient,
  type CreateEntryOutcome,
  type CreateEntryKindDto,
  type StructureChangeOutcome,
} from '../client/client-api';
import { createEditQueue, flushLatest, type EditQueue } from '../client/edit-queue';
import { backupDraftBeforeReload } from '../client/draft-backup';
import { runSaveFlow } from '../client/save-flow';
import { DEMO_CONTENTS, DEMO_NODES } from '../data/demo-project';
import { installBeforeUnloadGuard, needsLeaveGuard } from './beforeunload-guard';
import { draftBackupKey, hasUnsavedDrafts, isResponseOwnerCurrent } from './doc-identity';
import { createDocumentOpener, createEditEpochs, type DocumentOpener } from './open-document';
import {
  createWorkspaceAutosave,
  createWorkspaceStore,
  serializeWorkspace,
  type Autosave,
} from './workspace-persistence';
import { createLoadEpoch, loadProjectResources, loadWorkspace } from './workspace-load';
import { emptyLevels, ROOT_LEVEL } from '../components/tree-model.ts';
import { parentDirOfEntry } from '../../../../packages/storage/entry-name.ts';
import { createTreeLevelLoader, createTreeOwnershipGuard, type TreeLoadIdentity } from './tree-load.ts';
import {
  createAddProjectFlow,
  createProjectAdder,
  createResyncRunner,
  createSupportProbe,
  validateProjectName,
  type AddProjectHandle,
  type AddProjectPort,
  type ResyncOutcome,
} from './add-project.ts';
import type { RenameOutcome } from '../client/client-api.ts';
import { refreshProject } from './refresh-project';
import {
  createRemoveProjectAction,
  defaultNewOpId,
  localRemovalBlockers,
  type RemoveUiResult,
} from './remove-project.ts';
import {
  createWorkspaceIdentitySync,
  createWorkspaceKeyApplier,
  createWorkspaceKeyRevision,
  settleIdentitySync,
  type IdentitySyncOutcome,
} from './workspace-identity-sync.ts';
import { createWorkspaceRestorer, type RestoreReport } from './workspace-restore';
import { createWorkspaceWriteGate } from './workspace-write-gate';
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
  /**
   * 重新拉取资源：Multi 只刷新指定项目，Legacy 刷新单项目树。
   *
   * S11-UX-01A：除文件树外，还要检查**该项目**下已打开文档的磁盘变化——
   * 干净标签安全同步内容和版本基线；有草稿的只提示存在外部修改，绝不动草稿、
   * 绝不自动 reload。刷新不改变活动文档、焦点窗格与分屏结构。
   */
  reloadResources(projectId?: string): Promise<void>;
  /** 切换"当前项目"：只改焦点，不动标签 / 队列 / 草稿。 */
  switchProject(projectId: string): Promise<void>;
  /**
   * UX-02B-TREE：按需加载**一层**目录。
   *
   * `projectId=null` 表示 Legacy 单根；`dir=''` 表示项目根层。
   * `append=true` 用该层当前的 `nextCursor` 继续加载下一页；
   * 已加载条目不会被清空，其它层与其它项目不受影响。
   */
  loadTreeLevel(projectId: string | null, dir: string, append: boolean): Promise<void>;
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
  /**
   * 添加项目的编排句柄（UX-02B-04A）。
   *
   * 披露模态只是个知情披露：`flow.open()` 零请求；只有 `confirm()` 才走
   * T1（令牌）→ T2（一次性意图）→ T3（Host 进程内选择器）。浏览器永远不提供路径。
   */
  addProject: AddProjectHandle;
  /**
   * 修改项目的**显示名称**（UX-02B-04A）。
   *
   * 只改名称：`projectId`、磁盘目录名、文件树、标签与草稿都不变，`workspaceKey` 也不变
   * （名称不是路径）。以 Host 返回的项目摘要为权威；失败时界面保持原名。
   */
  renameProject(projectId: string, name: string): Promise<RenameOutcome>;
  /**
   * 只读移除前置检查（UX-02B-04B）：用于打开确认框时展示阻断原因。
   *
   * **不是**放行凭据：`removeProject` 执行时 Host 会在屏障内按自身状态重新检查。
   */
  removalPrecheck(projectId: string): Promise<RemovalPrecheckOutcome>;
  /**
   * 移除项目（只解除 WeaveSpace 的注册与授权，**绝不删除磁盘文件**）。
   *
   * 只有 Host 明确撤销（或按 opId 命中持久证据）时才从列表移除；结果不确定时
   * 只做"查询 + 只读刷新列表 + 提示人工核对"，**不自动重试**。
   */
  removeProject(projectId: string): Promise<RemoveUiResult>;
  /**
   * 该项目在 Shell 侧的本地阻断（R2-02）：还有标签 / 未保存 / 保存中 / 结果未知时
   * 确认框只显示原因，不提供确认按钮。**不替代** Host 门禁。
   */
  localRemovalBlockers(projectId: string): RemoveBlockerCode[];

  /* ---- UX-02C-01：真实创建 ---- */

  /**
   * 创建空文件 / 空目录：只把 `(projectId, 相对父目录, 单段名称)` 交给 Host。
   * 菜单与工具栏共用的提交编排在 `state/create-entry.ts`，这里不做第二次判定。
   */
  createEntry(
    projectId: string,
    parentDir: string,
    name: string,
    kind: CreateEntryKindDto,
  ): Promise<CreateEntryOutcome>;
  /**
   * 只使**目标项目的目标目录层**失效并重新加载（不递归、不碰其他项目）。
   * `options.expand` 用于"目标文件夹原本折叠"：用树里真实存在的节点 id 幂等展开，
   * 绝不凭空声明分页尚未加载到的节点已经可见。
   */
  refreshTreeLevel(
    projectId: string | null,
    dir: string,
    options?: { expand?: boolean },
  ): Promise<void>;

  /* ---- UX-02C-02：真实改名 / 移动 ---- */

  /** 同一目录内改名；目标目录由 Host 派生。 */
  renameEntry(projectId: string, sourcePath: string, name: string): Promise<StructureChangeOutcome>;
  /** 同一授权项目内移动。 */
  moveEntry(
    projectId: string,
    sourcePath: string,
    targetParentDir: string,
    name: string,
  ): Promise<StructureChangeOutcome>;
  /**
   * Host 明确 APPLIED 之后才调用：清理旧路径层/展开/选择，刷新源父层与目标父层，
   * 并尽可能展开目标位置。失败或 UNKNOWN 时**不得**调用（不许乐观改名字）。
   */
  applyStructureChange(
    outcome: Extract<StructureChangeOutcome, { status: 'APPLIED' }>,
  ): Promise<void>;
  /** UNKNOWN 时恰好一次的只读核对：只刷新源父层与目标父层，不重发、不改草稿。 */
  checkStructureLocations(
    projectId: string,
    sourceParentDir: string,
    targetParentDir: string,
  ): Promise<void>;
}

const DocumentActionsContext = createContext<DocumentActions | null>(null);

/** Demo / Legacy / 静态 Multi 明确不提供真实结构变更，不制造"点了会假成功"的入口。 */
function unsupportedStructure(): StructureChangeOutcome {
  return {
    status: 'REJECTED',
    errorCode: 'ERR_COMMAND_UNSUPPORTED',
    message: '当前模式不提供真实改名或移动',
    httpStatus: 501,
  };
}

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
   * 工作区加载代次（S11-C-R2）。
   *
   * 恢复连接和手动切模式都会各占一代；用户一旦切走，上一代的所有在途响应立即作废。
   * 不能只比较 `modeRef`：切到 Demo 再切回 Live 之后模式又变回 `live`，迟到结果会
   * 被误认成本代结果重新写进界面。
   */
  const loadEpoch = useRef(createLoadEpoch());

  /**
   * 逐层目录加载的编排器（UX-02B-TREE-R1）。
   *
   * 真正实现在 `tree-load.ts`（纯 TS、可确定性测试）：每次请求固定捕获
   * 工作区身份 / 加载代次 / 项目 / 目录 / 该层请求代次，迟到响应一律不回填。
   * 这里只注入宿主依赖，不复制任何编排逻辑。
   */
  const treeLoader = useRef(
    createTreeLevelLoader(
      {
        identity: (): TreeLoadIdentity => ({
          mode: stateRef.current.mode,
          syncMode: modeRef.current,
          workspaceKey: stateRef.current.workspaceKey,
          epoch: loadEpoch.current.current(),
          activeProjectId: stateRef.current.activeProjectId,
        }),
        levels: (projectKey: string) => stateRef.current.treeByProject[projectKey] ?? emptyLevels(),
        listTree: (request) =>
          clientFor('live').listTree(request.projectId, request.dir, request.cursor, undefined, request.snapshot),
        dispatch,
      },
      /**
       * R2-01：显式创建**同一个**归属守卫，供逐层加载器与工作区加载链共用。
       * loader 不传第二个参数时会自建一个，那样根层刷新就拿不到同一份代次。
       */
      createTreeOwnershipGuard(
        (): TreeLoadIdentity => ({
          mode: stateRef.current.mode,
          syncMode: modeRef.current,
          workspaceKey: stateRef.current.workspaceKey,
          epoch: loadEpoch.current.current(),
          activeProjectId: stateRef.current.activeProjectId,
        }),
      ),
    ),
  );

  /**
   * 写入门禁（S11-C-R1）。
   *
   * 恢复期间 `WorkspaceState` 是"残缺"的：阶段 C 一个一个后台登记标签，
   * 每登记一个都会触发一次状态变化。若此时允许自动保存，就会用"刚恢复了 2 个"
   * 的状态覆盖"上次离开时有 8 个"的记录。门禁在恢复的第一个 await 之前合上，
   * 恢复到达终态才放开；调大节流延迟只是缩小窗口，不是修复。
   */
  const gate = useMemo(() => createWorkspaceWriteGate(), []);

  /**
   * 身份修订号（UX-02B-05-E）。
   *
   * "最后一次落定的身份"计数器：添加项目、只读 resync、移除后的身份同步，任一处
   * 写定摘要都 +1。移除时发起的那条健康检查据此自检——只要期间别处确认过新身份，
   * 它反映的就是**已被取代的结构**，返回什么都只能丢弃（否则会把 `keyBC` 改回
   * `keyB`，或把已确认的摘要重新置空）。
   */
  const keyRevision = useMemo(() => createWorkspaceKeyRevision(), []);

  /**
   * `autosave` 在 `restorer` 之后构造（它要读恢复流程的结转列表），
   * 而 `restorer` 的终态回调又要请求一次提交，因此用一个 ref 打通这两个方向。
   */
  const autosaveRef = useRef<Autosave | null>(null);

  /**
   * 「摘要落地」的唯一入口：添加项目、只读重新读取都走这里（R2E E-01 / 05-E）。
   *
   * 规则抽在 `createWorkspaceKeyApplier`（纯 TS，与测试共用同一条实现）：
   * - 先推进身份修订号 → 在途的旧探测一律作废（添加 / resync 也能让它们失效，
   *   不必依赖 `loadEpoch` 是否推进）；
   * - 有效摘要 → 放开写入并重新排程；`null` / 形状非法 → 继续待同步，绝不伪造；
   * - 归属由调用方保证：添加流程与 resync 都在**代次仍属当前工作区**时才调用。
   */
  const keyApplier = useMemo(
    () =>
      createWorkspaceKeyApplier({
        revision: keyRevision,
        gate,
        setKey: (workspaceKey) => dispatch({ type: 'SET_WORKSPACE_KEY', workspaceKey }),
        schedule: () => autosaveRef.current?.schedule(),
        // 从"待同步"回到确定身份时补一句：否则状态栏会一直挂着上一条
        // "工作区身份待同步"，与事实相反
        onIdentityRecovered: () =>
          dispatch({ type: 'NOTICE', message: '工作区身份已同步，自动保存已恢复' }),
      }),
    [dispatch, gate, keyRevision],
  );

  const applyWorkspaceKey = useCallback(
    (workspaceKey: string | null): void => {
      keyApplier.apply(workspaceKey);
    },
    [keyApplier],
  );

  /**
   * 「添加项目」的编排句柄（UX-02B-04A / R1）。
   *
   * 组装都在这里，编排逻辑全在 `add-project.ts`（纯 TS、可确定性测试）：
   * - 端口只映射 5 个窄方法，注入后测试不必实现整个客户端；
   * - `identity()` 读的是**实时**状态，编排层会在每次 await 之后比对，迟到结果丢弃；
   * - `loadRoot` 复用逐层加载器，因此新项目根层与用户手动展开走的是同一条链路；
   * - 能力探测用 `createSupportProbe`：挂载 / 模式变化 / 工作区变化时问一次，
   *   同一身份下并发调用只发一个请求。**点击入口本身不探测**（R1-02）。
   */
  const addProject = useMemo<AddProjectHandle>(() => {
    const port: AddProjectPort = {
      bootstrap: () => liveClient.bootstrapPick(),
      startPick: (input) => liveClient.startPick(input),
      queryPick: (input) => liveClient.queryPick(input),
      listProjects: () => liveClient.listProjects(),
      workspaceKey: async () => (await liveClient.workspaceIdentity()).workspaceKey,
    };
    const adder = createProjectAdder({
      port,
      identity: () => ({
        mode: stateRef.current.mode,
        workspaceKey: stateRef.current.workspaceKey,
        epoch: loadEpoch.current.current(),
      }),
      onProjects: (projects) => dispatch({ type: 'SET_PROJECTS', projects }),
      // 摘要落地同时收放写入门禁（R2E E-01）：移除最后一个项目后再添加，靠这条恢复自动保存
      onWorkspaceKey: applyWorkspaceKey,
      loadRoot: async (projectId) => {
        await treeLoader.current.load(projectId, '', false);
      },
    });
    const probe = createSupportProbe({
      mode: () => stateRef.current.mode,
      workspaceKey: () => stateRef.current.workspaceKey,
      fetchSupport: async () => (await liveClient.registrationSupport()).support,
    });
    const flow = createAddProjectFlow({
      adder,
      // 未探测（或身份已变）时按"未知"处理：界面会给出说明，绝不假装可用
      support: () => probe.support() ?? 'unknown',
    });

    /**
     * 只读重新同步的纯编排（R2-01）。见 `add-project.ts`。
     *
     * 复用 `loadEpoch` 作为归属机制：Demo/Live 切换、Host 重连、工作区替换都会让它 +1，
     * 旧 resync 立即作废。调度权与状态写入都在 `dispatch` 与 `treeLoader`（其自身也带
     * 代次守卫）手里，这里只把"读到的数据"交给它们。
     */
    const resyncRunner = createResyncRunner({
      port,
      identity: () => ({
        mode: stateRef.current.mode,
        workspaceKey: stateRef.current.workspaceKey,
        epoch: loadEpoch.current.current(),
      }),
      isCurrent: (epoch) => loadEpoch.current.isCurrent(epoch),
      onProjects: (projects) => dispatch({ type: 'SET_PROJECTS', projects }),
      // 只读重新读取也会刷新摘要：同样要能结束"待同步"（E-01）
      onWorkspaceKey: applyWorkspaceKey,
      // 返回真实结果：resync 据此判断根层是否真的落到了界面（要求 8），
      // 不把 rejected / failed / changed / stale 当成"已成功加载"
      loadRoot: (pid) => treeLoader.current.load(pid, '', false),
      missingRoots: (projects) =>
        projects
          .filter((project) => project.status === 'READY')
          .filter((project) => {
            const levels = stateRef.current.treeByProject[project.projectId];
            // 根层从未加载（层表里根本没有根层分片）：这类项目需要补齐，否则界面
            // 会把它显示成"空的"而非"还没展开"。已加载 / 失败 / 出错的分片都不重读。
            return !levels || levels[ROOT_LEVEL] === undefined;
          })
          .map((project) => project.projectId),
    });

    return {
      flow,
      probe: () => probe.probe(),
      support: () => probe.support(),
      subscribeSupport: (listener) => probe.subscribe(listener),
      invalidateSupport: () => probe.invalidate(),
      /**
       * 只读核对（R1-03 / R2-01）：重新读取项目列表、补齐缺失根层、刷新工作区摘要。
       * 不重发 pick、不弹窗口、不改授权 —— 用户不必重新选择同一个文件夹。
       *
       * 编排逻辑在 `add-project.ts` 的 `createResyncRunner`（纯 TS、可确定性测试）：
       * 捕获加载代次、每次 await 后核对、过期结果不回填；缺失根层自动补齐（避免被
       * 误显示成空目录）。这里只注入宿主依赖，不复制任何归属判定。
       */
      resync: (projectId?: string): Promise<ResyncOutcome> => resyncRunner(projectId),
    };
  }, [applyWorkspaceKey, dispatch, liveClient]);

  /**
   * 打开流程的编排器（G2-R1）：真实实现放在 `open-document.ts`，
   * 这里只注入宿主依赖，便于在 Node 里用真实 Host + reducer 验证时序。
   */
  const opener = useMemo<DocumentOpener>(    () =>
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

  /**
   * 项目移除之后的工作区摘要同步（UX-02B-04B-R1-03）。
   *
   * 只写摘要（`SET_WORKSPACE_KEY`），不清标签、不动树：摘要变化不该让用户
   * 正在编辑的内容消失。旧摘要的本地记录会被清掉——它代表的是"上一个项目集合"，
   * 留着只会被下次启动误认领。
   */
  const identitySync = useMemo(
    () =>
      createWorkspaceIdentitySync({
        port: { workspaceIdentity: () => liveClient.workspaceIdentity() },
        currentKey: () => stateRef.current.workspaceKey,
        isCurrent: (value) => loadEpoch.current.isCurrent(value),
        // 与添加 / 只读 resync 共用同一个修订号：任一处的写入都能让在途探测失效
        revision: keyRevision,
        onWorkspaceKey: (workspaceKey) => dispatch({ type: 'SET_WORKSPACE_KEY', workspaceKey }),
        onDropRecord: (workspaceKey) => store.clear(workspaceKey),
      }),
    [dispatch, keyRevision, liveClient, store],
  );

  /**
   * 摘要同步 + 写入门禁联动（R2-01）。
   *
   * 门禁的"身份"那一轴在 `onRemoved` 里**同步**合上（先于 `PROJECT_REMOVED` 派发），
   * 这里负责在拿到新摘要后放开；进入待同步时保持合上，让自动保存彻底停下来，
   * 而不是写一条挂在旧摘要上的记录。
   */
  const syncIdentity = useCallback(
    async (epoch: number): Promise<IdentitySyncOutcome> => {
      const outcome = await identitySync.refresh(epoch);
      // 规则与测试共用同一个纯函数（workspace-identity-sync.settleIdentitySync）
      const settled = settleIdentitySync(gate, outcome);
      if (settled === 'released') autosaveRef.current?.schedule();
      return outcome;
    },
    [gate, identitySync],
  );

  /**
   * 移除动作的编排器（R2-03）：**稳定作用域**下只装配一次。
   *
   * 之前每次 `actions.removeProject(...)` 都新建一个 `createProjectRemover`，
   * 它内部的 `inflight` 表随即被丢掉——单飞形同虚设，双击就是两次 remove。
   * 这里把实例提到 Provider 级；所有可变依赖都通过 ref 读取，因此这个 memo
   * 在整个会话里不会重建。
   */
  const removeAction = useMemo(
    () =>
      createRemoveProjectAction({
        port: {
          removalPrecheck: (pid) => liveClient.removalPrecheck(pid),
          removeProject: (pid, opId) => liveClient.removeProject(pid, opId),
          queryRemovalOp: (opId) => liveClient.queryRemovalOp(opId),
          listProjects: () => liveClient.listProjects(),
        },
        newOpId: defaultNewOpId,
        identity: () => ({ mode: stateRef.current.mode, epoch: loadEpoch.current.current() }),
        isCurrent: (value) => loadEpoch.current.isCurrent(value),
        // 本地危险状态：Host 重启后 activeViews 归零，Shell 仍可能握着未保存 buffer
        localBlockers: (pid) => localRemovalBlockers(stateRef.current.tabs, pid),
        onRemoved: (pid) => {
          /**
           * R2-01 的关键顺序：**先**同步合上旧身份下的写入资格，**再**派发
           * `PROJECT_REMOVED`。派发之后状态里已经是新项目集合，而新摘要还要走一次
           * 异步健康检查；这之间的任意一次 400ms 自动保存或 pagehide flush，
           * 都会把新列表写到旧摘要下面。
           */
          gate.holdIdentity();
          // 先作废该项目所有在途层请求（推高 projectGeneration，迟到响应一律 stale），
          // 再从列表移除并清空层表缓存——两道防线共同阻止旧行复活。
          treeLoader.current.invalidateProject(pid);
          dispatch({ type: 'PROJECT_REMOVED', projectId: pid });
        },
        onProjects: (projects) => dispatch({ type: 'SET_PROJECTS', projects }),
        syncIdentity,
        notify: (message) => dispatch({ type: 'NOTICE', message }),
      }),
    [dispatch, gate, liveClient, syncIdentity],
  );

  /**
   * 进入 live 并加载工作区；失败（Host 不在线）返回 null，由调用方决定如何降级。
   *
   * `isCancelled()`：恢复流程用它在**每次 await 之后**自检。用户已经切走时，
   * 这里绝不能把界面切进 live——否则会出现"用户切到 Demo 却又冒出真实文件"。
   */
  const connectWorkspace = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      // 本次连接独占一代；恢复流程自带的代次与加载代次任一过期都算取消
      const cancelledByEpoch = loadEpoch.current.start();
      // 重新连接等于换一份层表：上一代所有逐层请求立即失效（R1-02）
      treeLoader.current.invalidateAll();
      const cancelled = () => isCancelled() || cancelledByEpoch();
      // 先探测 Host：连不上就**不要**把界面切进 live（否则会显示"真实文件"却空空如也）
      const probe = await liveClient.workspaceIdentity().catch(() => null);
      // 探测结果也是会迟到的：已取消时连"连不上"的提示都属于上一个工作区
      if (cancelled()) return null;
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
        isCancelled: cancelled,
        treeOwnership: treeLoader.current.ownership,
      });
      // 加载期间用户接管了：结果不属于当前工作区，交出 null 让恢复流程收手
      if (cancelled()) return null;
      // 重新连上并拿到身份 = 上一次"身份待同步"自然结束（R2-01）：别让门禁永久拦住写入
      if (loaded && loaded.workspaceKey) {
        gate.releaseIdentity();
        autosaveRef.current?.schedule();
      }
      return loaded ? { workspaceKey: loaded.workspaceKey, workspaceMode: loaded.workspaceMode } : null;
    },
    [dispatch, demoClient, gate, liveClient],
  );

  const restorer = useMemo(
    () =>
      createWorkspaceRestorer({
        getState: () => stateRef.current,
        getMode: () => modeRef.current,
        dispatch,
        store,
        gate,
        connectLive: connectWorkspace,
        openInBackground: (node, projectId) =>
          opener.openNode(node, projectId, { background: true }),
        // 终态后再排一次写入：此时标签已经全部登记完，写下去的是完整状态（AS-04）
        onSettled: () => autosaveRef.current?.schedule(),
      }),
    [connectWorkspace, dispatch, gate, opener, store],
  );

  const autosave = useMemo(
    () =>
      createWorkspaceAutosave({
        store,
        gate,
        // 只在"已连接工作区"时才产出快照（serialize 自己也会拒绝 demo / 无摘要）
        snapshot: () =>
          serializeWorkspace(stateRef.current, {
            workspaceKey: stateRef.current.workspaceKey,
            // 结转：未处理的未确认内容提示 + 恢复被中断时还没重建的标签。
            // 少了这一步，下一次自动保存就会把它们静默抹掉（DR-03 / AS-05）。
            carryOver: [...restorer.unsavedHints(), ...restorer.pendingTabs()],
          }),
      }),
    [gate, restorer, store],
  );
  autosaveRef.current = autosave;

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
      treeOwnership: treeLoader.current.ownership,
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
      addProject,

      /**
       * 重命名显示名称（UX-02B-04A）。
       *
       * 三条纪律：
       * 1. 本地预检与 Host 同规则，但**权威仍是 Host**：这里只避免发出注定失败的请求；
       * 2. 只有 `APPLIED` 才写界面，且写的是 Host 返回的摘要（不做乐观改名）；
       * 3. 不动 `workspaceKey` / 层表 / 标签 / 草稿 —— 名称是显示属性，不是路径。
       */
      async renameProject(projectId: string, rawName: string): Promise<RenameOutcome> {
        const checked = validateProjectName(rawName);
        if (!checked.ok) {
          return {
            status: 'REJECTED' as const,
            errorCode: 'ERR_COMMAND_INVALID',
            message: checked.message,
            httpStatus: 400,
          };
        }
        if (modeRef.current !== 'live') {
          return {
            status: 'REJECTED' as const,
            errorCode: 'ERR_COMMAND_UNSUPPORTED',
            message: '演示模式没有真实项目，无法重命名',
            httpStatus: 501,
          };
        }
        const current = stateRef.current.projects.find((item) => item.projectId === projectId);
        if (!current) {
          return { status: 'REJECTED' as const, errorCode: 'ERR_PROJECT_NOT_FOUND', message: '项目已不存在', httpStatus: 404 };
        }
        // 名字没变化就不发请求：避免一次无意义的写盘与状态变化
        if (current.name === checked.name) {
          return { status: 'APPLIED' as const, project: current };
        }

        let outcome: RenameOutcome;
        try {
          outcome = await clientFor('live').renameProject(projectId, checked.name);
        } catch {
          return { status: 'REJECTED' as const, errorCode: 'ERR_STORAGE_IO', message: '无法连接本地服务', httpStatus: 0 };
        }
        // 等到结果时工作区已经不是原来那个：不把旧工作区的名称写进当前界面
        if (modeRef.current !== 'live') {
          return { status: 'REJECTED' as const, errorCode: 'ERR_COMMAND_UNSUPPORTED', message: '工作区已切换，重命名结果已丢弃', httpStatus: 0 };
        }
        if (outcome.status === 'APPLIED') {
          dispatch({ type: 'PROJECT_RENAMED', project: outcome.project });
        }
        return outcome;
      },

      /**
       * 只读移除前置检查（UX-02B-04B）。
       * 只用于确认框打开时显示疑似阻断原因；真正放行由 `removeProject` 内部复检决定。
       */
      async removalPrecheck(projectId: string): Promise<RemovalPrecheckOutcome> {
        if (modeRef.current !== 'live') {
          return {
            status: 'REJECTED',
            errorCode: 'ERR_COMMAND_UNSUPPORTED',
            message: '演示模式没有真实项目，无法移除',
            httpStatus: 501,
          };
        }
        try {
          return await clientFor('live').removalPrecheck(projectId);
        } catch {
          return { status: 'REJECTED', errorCode: 'ERR_STORAGE_IO', message: '无法连接本地服务', httpStatus: 0 };
        }
      },

      /**
       * 移除项目（UX-02B-04B）。
       *
       * 编排全在 `remove-project.ts`（纯 TS、可确定性测试）：opId 提交前落定、
       * 超时后按 opId 查持久证据、结果不确定时只读刷新列表且**不自动重试**；
       * 移除成功后接着同步工作区摘要（R1-03），期间写入被门禁拦住（R2-01）。
       * 编排器实例在 Provider 级只装配一次（R2-03），这里只做转发。
       */
      async removeProject(projectId: string): Promise<RemoveUiResult> {
        return removeAction.remove(projectId);
      },

      /** 本地危险状态（R2-02）：确认框据此提前拦住，不替代 Host 门禁。 */
      localRemovalBlockers(projectId: string): RemoveBlockerCode[] {
        return removeAction.localBlockers(projectId);
      },

      /**
       * 真实创建（UX-02C-01）：只转发，不推断结果。
       * Demo / Legacy / 静态 Multi 在这里与 Host 一起明确"不支持"，
       * 不会出现"演示树里长出一个假节点"。
       */
      async createEntry(projectId, parentDir, name, kind) {
        const current = stateRef.current;
        if (current.mode !== 'live' || current.workspaceMode !== 'multi') {
          return {
            status: 'REJECTED' as const,
            errorCode: 'ERR_COMMAND_UNSUPPORTED',
            message: '当前模式不提供真实创建',
            httpStatus: 501,
          };
        }
        return liveClient.createEntry(projectId, parentDir, name, kind);
      },

      /**
       * 创建成功后的层同步：`treeLoader.load(..., append=false)` 会为这一层
       * 领取**新的**归属票据，上一代在途响应立即失效；其它项目、其它层、
       * 标签与草稿一概不动，也不递归扫描整棵树。
       */
      async refreshTreeLevel(projectId, dir, options) {
        const projectKey = projectId ?? '';
        if (options?.expand && dir !== '') {
          const levels = stateRef.current.treeByProject[projectKey] ?? {};
          const folder = Object.values(levels)
            .flatMap((level) => level.entries)
            .find((node) => node.kind === 'folder' && (node.path ?? '') === dir);
          // 只展开树里真实存在的节点；分页还没加载到的层不假装已经可见
          if (folder) {
            dispatch(
              projectId
                ? { type: 'EXPAND_PROJECT_NODE', projectId: projectKey, path: folder.id }
                : { type: 'EXPAND_NODE', path: folder.id },
            );
          }
        }
        await treeLoader.current.load(projectId, dir, false);
      },

      /* ---- UX-02C-02：真实改名 / 移动 ---- */

      async renameEntry(projectId, sourcePath, name) {
        if (stateRef.current.mode !== 'live' || stateRef.current.workspaceMode !== 'multi') {
          return unsupportedStructure();
        }
        return liveClient.renameEntry(projectId, sourcePath, name);
      },

      async moveEntry(projectId, sourcePath, targetParentDir, name) {
        if (stateRef.current.mode !== 'live' || stateRef.current.workspaceMode !== 'multi') {
          return unsupportedStructure();
        }
        return liveClient.moveEntry(projectId, sourcePath, targetParentDir, name);
      },

      /**
       * 只有 Host 明确 APPLIED 才走到这里。
       *
       * 迟到的旧路径加载结果由 `invalidateLevel` 推进该层请求代次作废；
       * `TREE_STRUCTURE_CHANGED` 删掉旧层缓存 / 展开 / 选择记录；随后只重新取
       * 源父层与目标父层，不递归扫描整棵树，也不动其它项目、标签与草稿。
       */
      async applyStructureChange(outcome) {
        const projectId = outcome.projectId;
        const sourceParent = parentDirOfEntry(outcome.sourcePath);
        const targetParent = outcome.targetParentDir;
        const levels = stateRef.current.treeByProject[projectId] ?? {};
        for (const dir of Object.keys(levels)) {
          if (dir === outcome.sourcePath || dir.startsWith(`${outcome.sourcePath}/`)) {
            treeLoader.current.invalidateLevel(projectId, dir);
          }
        }
        treeLoader.current.invalidateLevel(projectId, sourceParent);
        treeLoader.current.invalidateLevel(projectId, targetParent);
        dispatch({
          type: 'TREE_STRUCTURE_CHANGED',
          projectId,
          sourcePath: outcome.sourcePath,
          targetPath: outcome.targetPath,
        });
        await treeLoader.current.load(projectId, sourceParent, false);
        if (targetParent !== sourceParent) {
          await treeLoader.current.load(projectId, targetParent, false);
        }
        // 尽可能展开目标位置的祖先目录，让用户看到新位置；分页未加载到的节点不假装可见
        const refreshed = stateRef.current.treeByProject[projectId] ?? {};
        const allNodes = Object.values(refreshed).flatMap((level) => level.entries);
        const segments = targetParent.split('/').filter(Boolean);
        for (let i = 1; i <= segments.length; i += 1) {
          const dir = segments.slice(0, i).join('/');
          const folder = allNodes.find(
            (node) => node.kind === 'folder' && (node.path ?? '') === dir,
          );
          if (folder) dispatch({ type: 'EXPAND_PROJECT_NODE', projectId, path: folder.id });
        }
        dispatch({
          type: 'NOTICE',
          message: `已把「${outcome.sourcePath}」变更为「${outcome.targetPath}」（只刷新了相关目录）`,
        });
      },

      /** UNKNOWN：恰好一次只读核对源位置与目标位置，不重发、不改草稿、不推断成功。 */
      async checkStructureLocations(projectId, sourceParentDir, targetParentDir) {
        await treeLoader.current.load(projectId, sourceParentDir, false);
        if (targetParentDir !== sourceParentDir) {
          await treeLoader.current.load(projectId, targetParentDir, false);
        }
      },

      async openNode(node: ResourceNodeState, projectId?: string | null) {        // 用户主动打开：恢复流程不得再把窗格指回旧位置（S11-C）
        restorer.noteInteraction();
        // 结构化操作 = 接管恢复（AS-05）：此后当前界面才是权威，提交时合并结转标签
        gate.adopt();
        // 打开/刷新/并发/模式切换的全部时序处理都在 open-document.ts：
        // 这里只转发，避免把异步归属判定散落在组件里（G2-R1）。
        await opener.openNode(node, projectId);
      },

      /**
       * 逐层加载（UX-02B-TREE 契约 B.2）。
       *
       * 一层一个 `TREE_LEVEL_BEGIN` → 一次 `listTree` → `TREE_LEVEL_PAGE`；
       * 同层已有在途请求时不重复发（单飞），迟到结果在切回 demo 后丢弃。
       */
      async loadTreeLevel(projectId, dir, append) {
        // 归属判定、单飞、迟到响应丢弃全在 `tree-load.ts`（纯 TS，可确定性测试）
        await treeLoader.current.load(projectId, dir, append);
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
        // 改动正文同样属于"用户已经接管"：提交时不得丢掉还没重建的旧标签
        gate.adopt();
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
        gate.adopt();
        dispatch({ type: 'CLOSE_TAB', docId });
      },

      async switchMode(mode: ClientMode) {
        if (mode === stateRef.current.mode) return;
        // 未保存草稿阻止切换：语义与之前完全一致，只是判定抽成可测的纯函数
        if (hasUnsavedDrafts(stateRef.current.tabs)) {
          dispatch({ type: 'NOTICE', message: '有未保存修改，已阻止切换模式（请先保存）' });
          return;
        }
        // 用户一旦要求切换，所有在途加载立即失效：连"收回服务端视图"的等待期间
        // 回来的结果也不属于新工作区（S11-C-R2）
        loadEpoch.current.cancel();
        treeLoader.current.invalidateAll();
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
        gate.adopt();
        /**
         * 切走就是换一份工作区身份（R2-01）：上一次移除留下的"身份待同步"到此为止。
         * 这里只放开写入资格，**不**动摘要——新摘要由接下来的连接/加载写入，
         * 旧身份不会被一次切换"恢复"回来。
         */
        gate.releaseIdentity();
        dispatch({ type: 'SET_MODE', mode });
        // 旧工作区的"加载中"标记不属于新工作区，在切换点收掉（加载链因取消不会
        // 再在 finally 里派发它）
        if (mode !== 'live') dispatch({ type: 'SET_LOADING_RESOURCES', loading: false });
        if (mode === 'live') {
          const cancelled = loadEpoch.current.start();
          await loadWorkspace({
            getState: () => stateRef.current,
            dispatch,
            clientFor: (target) => (target === 'live' ? liveClient : demoClient),
            isCancelled: cancelled,
            treeOwnership: treeLoader.current.ownership,
          });
        }
      },

      async reloadResources(projectId?: string) {
        // 刷新只作废**目标项目**的层请求：其它项目正在展开的目录照常完成（R1-02）。
        // Legacy 的层表键是 ''，与 loadWorkspace / refreshProject 的目标约定一致。
        const target =
          stateRef.current.workspaceMode === 'multi'
            ? (projectId ?? stateRef.current.activeProjectId ?? '')
            : '';
        treeLoader.current.invalidateProject(target);
        // 编排（文件树 + 已打开文档 + 生命周期判定）都在 refresh-project.ts：
        // 这里只注入宿主依赖，保证测试驱动的是生产同一条链路（UX-01A-R1）
        await refreshProject(
          {
            getState: () => stateRef.current,
            getMode: () => modeRef.current,
            dispatch,
            clientFor,
            refreshOpenTabs: (target) => opener.refreshOpenTabs(target),
            loadToken: () => loadEpoch.current.current(),
            isTokenCurrent: (token) => loadEpoch.current.isCurrent(token),
            treeOwnership: treeLoader.current.ownership,
          },
          projectId,
        );
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
  }, [addProject, dispatch, demoClient, gate, liveClient, opener, removeAction, restorer, store]);

  return (
    <DocumentActionsContext.Provider value={actions}>{children}</DocumentActionsContext.Provider>
  );
}

export function useDocumentActions(): DocumentActions {
  const value = useContext(DocumentActionsContext);
  if (!value) throw new Error('useDocumentActions 必须在 DocumentActionsProvider 内使用');
  return value;
}
