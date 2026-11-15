/**
 * Client API 边界（S9-B）。
 *
 * 浏览器**不得**直接访问文件系统或 SQLite。Shell 只依赖下面这组接口：
 * - `demo`：内置演示数据，绝不写盘（S9-A 行为）；
 * - `live`：访问 localhost 的 Client API（apps/server），由 Core 的
 *   CommandBus + PermissionService 判定并落盘。
 *
 * 约定：**HTTP 状态码不等于结果**。调用方必须读 `status`：
 * `APPLIED` / `COMMITTED` / `CONFLICT` / `FAILED` / `UNKNOWN`。
 * `UNKNOWN` 既不是成功也不是失败，不得自动重试。
 */

export type ClientMode = 'demo' | 'live';

/** 服务端运行模式（G2-03）：不得假定连接的一定是 Multi。 */
export type WorkspaceMode = 'legacy' | 'multi';

/** 项目摘要：与服务端 `ProjectSummary` 同构，**不含任何本机路径**。 */
export interface ProjectSummary {
  projectId: string;
  name: string;
  status: 'READY' | 'UNAVAILABLE';
  reason?: string;
}

export interface ResourceNode {
  id: string;
  name: string;
  /** 只区分目录/文件/链接；格式由 `extension` + 能力注册表决定（S10-A）。 */
  kind: TreeEntryKind;
  /** 文件扩展名（小写含点）；目录为空。 */
  extension?: string;
  /** 文件相对路径（live 用于 open）；demo 下与 id 相同。 */
  path?: string;
  children?: ResourceNode[];
}

/* ---- UX-02B-TREE：逐层、可分页的真实目录树（契约 B.2/B.3） ---- */

/** 三套事实类型，`link` 只显示、不展开、不打开。 */
export type TreeEntryKind = 'folder' | 'file' | 'link';

export interface TreeEntry {
  /** `dir:` / `doc:` / `link:` 三套互不重叠的命名空间。 */
  id: string;
  name: string;
  kind: TreeEntryKind;
  /** 小写含点；无扩展名与目录为空串。 */
  extension: string;
  /** 项目内相对路径；**永不是绝对路径**。 */
  relPath: string;
}

export interface TreePageMeta {
  limit: number;
  cursor: string | null;
  /** 非 null 表示还有下一页，必须继续请求直到 null。 */
  nextCursor: string | null;
  total: number;
  /**
   * 本轮分页的**目录快照标识**（UX-02B-TREE-R1）。
   * 由服务端对"排序后的整层条目集合"计算，客户端原样回传给续页请求；
   * 目录在两页之间发生变化时服务端返回 `ERR_DIR_CHANGED`，客户端必须刷新整层。
   * 旧版服务端不返回该字段时为 null。
   */
  snapshot: string | null;
}

export type TreeQueryOutcome =
  | {
      status: 'APPLIED';
      level: string;
      entries: TreeEntry[];
      page: TreePageMeta;
    }
  | {
      status: 'REJECTED';
      errorCode: string | null;
      message?: string;
    };

/** Core 的会话快照：版本与状态语义与 DocumentStateView 对齐。 */
export interface DocumentSnapshot {
  sessionId: string;
  viewId: string | null;
  resourceId: string;
  path: string;
  content: string;
  baseVersion: string | null;
  revision: number;
  dirty: boolean;
  /** CLEAN | EDITING_DIRTY | SAVING | CONFLICT | FAILED | OUTCOME_UNKNOWN（demo 为 DEMO） */
  documentState: string;
  /** 会话所属项目（Multi）；Legacy 不返回。 */
  projectId?: string;
  /** 会话失效标记（与 documentState 正交）：磁盘访问已被拒绝，草稿仍保留。 */
  stale?: { reason: string; since: string };
}

export type SaveStatus = 'COMMITTED' | 'CONFLICT' | 'FAILED' | 'UNKNOWN' | 'DEMO';

export interface OpenOutcome {
  status: 'APPLIED' | 'REJECTED';
  errorCode?: string | null;
  message?: string;
  document?: DocumentSnapshot;
  /** true 表示服务端检测到磁盘变化，已把会话内容与基线刷新为磁盘版本。 */
  reloaded?: boolean;
}

/** 磁盘上的当前版本（冲突恢复时只读查看，不写任何东西）。 */
export interface DiskSnapshot {
  content: string;
  contentVersion: string;
}

export interface ReloadOutcome {
  status: 'APPLIED' | 'REJECTED';
  errorCode?: string | null;
  message?: string;
  document?: DocumentSnapshot;
  /** 覆盖前的草稿（服务端回传，供 UI 备份）。 */
  previousDraft?: string;
}

export interface SaveOutcome {
  status: SaveStatus;
  errorCode?: string | null;
  contentVersion?: string | null;
  document?: DocumentSnapshot;
}

export interface CloseOutcome {
  status: 'APPLIED' | 'REJECTED';
  errorCode?: string | null;
  message?: string;
}

/**
 * Host 的工作区身份（S11-C）。
 *
 * `workspaceKey` 是 Host 对"项目组合 + 规范根 + 根身份令牌"做的摘要，
 * **只用于判断本地恢复记录是否属于同一个工作区**，不能当作读写授权凭据：
 * 真正的授权仍由每次请求的 G0/G1 检查完成。
 */
export interface WorkspaceIdentity {
  workspaceMode: WorkspaceMode;
  /** 摘要；Host 无法可靠确认身份（旧版服务端、根缺失）时为 `null`。 */
  workspaceKey: string | null;
}

/* ---- UX-02B-04A：项目注册、本机目录选择、显示名称 ---- */

/**
 * 信任披露的协议标记（与 Host 侧常量一字不差）。
 *
 * **它不是授权凭据**：Host 不会因为它存在就多授予一毫秒的目录权限，也不会把它写进
 * 任何持久记录。它唯一的作用，是让"客户端跳过了披露这一步"在协议层可被发现。
 */
export const ACKNOWLEDGE_SCOPE = 'browse-subtree' as const;

/**
 * Host 是否支持"在界面里添加项目"。
 *
 * - `managed`：带 `--workspace-store` 启动的托管模式，可以弹本机目录选择；
 * - `static` / `legacy`：配置是只读的，动态注册不可能成功；
 * - `demo`：演示模式，根本没有 Host；
 * - `unknown`：旧版/异常 Host —— 一律按"不支持"处理，绝不假定可用。
 */
export type ProjectRegistrationSupport = 'managed' | 'static' | 'legacy' | 'demo' | 'unknown';

export interface ProjectRegistrationInfo {
  support: ProjectRegistrationSupport;
  /** Host 上报的原始模式（`managed` / `multi` / `static` / `legacy`），仅用于解释原因。 */
  mode: string;
}

/** 启动本机选择器的结果：只有 `PENDING` 才代表"对话框已经打开"。 */
export interface PickStartOutcome {
  status: 'PENDING' | 'REJECTED';
  requestId?: string;
  errorCode?: string | null;
  message?: string;
  httpStatus: number;
}

/**
 * 选择结果的四态（契约 D.4）。
 *
 * `CANCELLED` / `REJECTED` 都是**零副作用**：没有项目被注册，没有授权被记录。
 */
export interface PickQueryOutcome {
  status: 'PENDING' | 'APPLIED' | 'CANCELLED' | 'REJECTED';
  requestId?: string;
  /** 仅 `APPLIED` 携带；不含任何本机路径。 */
  project?: ProjectSummary;
  errorCode?: string | null;
  /** Host 记录的机读原因（如 `timeout` / `unavailable`），供界面区分文案。 */
  reason?: string;
  message?: string;
  httpStatus: number;
}

/**
 * 重命名显示名称的结果。
 *
 * `APPLIED` 时以 Host 返回的 `project` 为权威（名称已 trim、已校验），
 * 客户端不得自行"乐观改名"。
 */
export type RenameOutcome =
  | { status: 'APPLIED'; project: ProjectSummary }
  | { status: 'REJECTED'; errorCode: string | null; message: string; httpStatus: number };

/** 移除阻断原因（与 Host `RemoveBlocker` 对齐，ADR-023 §3.2）。 */
export type RemoveBlockerCode =
  | 'ACTIVE_VIEWS'
  | 'DIRTY'
  | 'SAVING'
  | 'OUTCOME_UNKNOWN'
  | 'CONFLICT'
  | 'IN_FLIGHT_DISK_OPS'
  | 'DRAIN_TIMEOUT';

/** 移除前置检查结果（只读）。仅用于提前给出可读提示，**不是**放行凭据。 */
export type RemovalPrecheckOutcome =
  | {
      status: 'APPLIED';
      projectId: string;
      allowed: boolean;
      blockedBy: RemoveBlockerCode[];
      state: string;
    }
  | { status: 'REJECTED'; errorCode: string | null; message: string; httpStatus: number };

/**
 * 移除项目的结果。
 *
 * - `APPLIED`：Host 明确撤销（`configPersisted=false` 表示墓碑已生效但配置待补齐，
 *   项目**已不可访问**，重启后按墓碑收敛）；
 * - `ABORTED`：Host 复检未通过，零变更（附具体阻断原因）；
 * - `REJECTED`：其余失败（含超时/未知），调用方**不得**据此断言"已移除"。
 */
export type RemoveProjectOutcome =
  | { status: 'APPLIED'; projectId: string; opId: string; configPersisted: boolean }
  | { status: 'ABORTED'; projectId: string; blockedBy: RemoveBlockerCode[] }
  | { status: 'REJECTED'; errorCode: string | null; message: string; httpStatus: number };

/**
 * `opId` 的持久证据结论（ADR-022 §7.1）；`unknown` 时不得反推具体结果。
 *
 * `projectId` 是该证据**归属的项目**（`unknown` 时恒为 `null`）：调用方必须比对
 * 它才能认领结果，否则"另一个项目的撤销证据"会被错算成本次移除。
 */
export type RemovalOpOutcome =
  | {
      status: 'APPLIED';
      opId: string;
      outcome: 'revoked' | 'created' | 'aborted' | 'unknown';
      projectId: string | null;
    }
  | { status: 'REJECTED'; errorCode: string | null; message: string; httpStatus: number };

/**
 * 真实创建（UX-02C-01）的客户端结论。
 *
 * `UNKNOWN` 是**独立**的一种，不能折成 REJECTED：网络断开 / 5xx / Host 明确报告
 * "副作用可能已发生但无法确认"，都只许做一次**只读**目录核对并提示人工确认，
 * 绝不自动重发创建，更不能因为"目录里出现了同名文件"就宣称本次操作成功。
 */
export type CreateEntryKindDto = 'file' | 'directory';
export type CreateEntryOutcome =
  | {
      status: 'APPLIED';
      projectId: string;
      parentDir: string;
      name: string;
      kind: CreateEntryKindDto;
      relativePath: string;
    }
  | {
      status: 'UNKNOWN';
      errorCode: 'ERR_OUTCOME_UNKNOWN';
      message: string;
      httpStatus: number;
    }
  | { status: 'REJECTED'; errorCode: string | null; message: string; httpStatus: number };

export interface WeaveSpaceClient {
  readonly mode: ClientMode;
  /** 服务端运行模式（`/api/health`）；demo 恒为 `legacy`。 */
  workspaceMode(): Promise<WorkspaceMode>;
  /** 运行模式 + 工作区摘要（一次请求取回）；demo 的摘要恒为 `null`。 */
  workspaceIdentity(): Promise<WorkspaceIdentity>;
  /** 仅 Multi 有项目列表；Legacy 返回 `[]`。 */
  listProjects(): Promise<ProjectSummary[]>;
  /**
   * 旧端点 `/api/resources`：递归整棵树、只含可编辑文本。
   *
   * **保持冻结**，Legacy 恢复链路与既有测试仍依赖它；新 UI 不要用。
   */
  listResources(projectId?: string): Promise<ResourceNode[]>;
  /**
   * UX-02B-TREE：只读**一层**目录，`cursor` 省略为第一页。
   *
   * `projectId` 为 null 表示 Legacy 单根。`dir` 是项目内相对路径（根为空串），
   * **绝不接受绝对路径**。调用方必须用 `page.nextCursor` 继续加载直到 null。
   */
  listTree(
    projectId: string | null,
    dir: string,
    cursor?: string | null,
    limit?: number,
    /** 本轮分页的目录快照（仅续页传入，第一页为 null）。 */
    snapshot?: string | null,
  ): Promise<TreeQueryOutcome>;
  openDocument(path: string, projectId?: string): Promise<OpenOutcome>;
  readDocument(sessionId: string, viewId?: string | null): Promise<OpenOutcome>;
  applyEdit(
    sessionId: string,
    buffer: string,
    expectedVersion?: string | null,
    viewId?: string | null,
  ): Promise<OpenOutcome>;
  saveDocument(sessionId: string, expectedVersion: string, viewId?: string | null): Promise<SaveOutcome>;
  closeDocument(sessionId: string, viewId: string): Promise<CloseOutcome>;
  /** 只读查看磁盘当前内容（冲突恢复入口的第一步）。 */
  readDisk(sessionId: string, viewId?: string | null): Promise<
    | { status: 'APPLIED'; content: string; contentVersion: string }
    | { status: 'REJECTED'; errorCode: string | null; message?: string }
  >;
  /**
   * 用磁盘内容覆盖会话。**调用方必须已经取得用户明确确认**（服务端也会强制校验
   * `discardDraft: true`），否则草稿会被丢弃。
   */
  reloadDocument(sessionId: string, viewId: string): Promise<ReloadOutcome>;

  /* ---- UX-02B-04A ---- */

  /**
   * 只读能力探测：这个 Host 能不能在界面里注册新项目。
   *
   * 必须在用户点「添加项目」**之前**就能回答，否则只能让用户读完披露再撞一次 501，
   * 把"不支持"伪装成"操作失败"。只读端点，不需要令牌，也不涉及任何路径。
   */
  registrationSupport(): Promise<ProjectRegistrationInfo>;
  /**
   * T1 + T2 引导：取会话令牌（证明来自本机页面）与一次性意图（证明这次操作没被重放）。
   *
   * 两者都**不是**目录授权证据。`intentId === null` 表示当前 Host 不发放意图
   * （静态 / Legacy），此时调用方必须直接放弃，而不是继续发 pick 请求。
   */
  bootstrapPick(): Promise<{ token: string; intentId: string | null }>;
  /**
   * 启动 Host 进程内的本机目录选择器（T3 唯一入口）。
   *
   * 请求体只允许 `intentId` / `acknowledgeScope` / `name`：**绝不**提交
   * `rootDir` / `path` / `grantSource` —— 目标目录只能由用户在系统对话框里选。
   */
  startPick(input: {
    token: string;
    intentId: string;
    acknowledgeScope: typeof ACKNOWLEDGE_SCOPE;
    name?: string;
  }): Promise<PickStartOutcome>;
  /** 按 `requestId` 查询选择结果；`PENDING` 表示系统对话框还开着。 */
  queryPick(input: { token: string; requestId: string }): Promise<PickQueryOutcome>;
  /**
   * 修改项目的**显示名称**。
   *
   * 只改名称：`projectId`、磁盘目录名、文件树、标签与草稿都不变。校验（trim / 64 字 /
   * 控制字符）由 Host 的 `ProjectRuntime` 执行，这里不复制一份规则。
   */
  renameProject(projectId: string, name: string): Promise<RenameOutcome>;

  /* ---- UX-02B-04B：项目移除 ---- */

  /** 只读移除前置检查：返回放行与否、阻断原因与生命周期状态。 */
  removalPrecheck(projectId: string): Promise<RemovalPrecheckOutcome>;
  /**
   * 移除项目（只解除注册与授权，**不删除磁盘文件**）。
   *
   * `opId` 由调用方**在提交前**生成并持有：超时/5xx 时才能用 `queryRemovalOp(opId)`
   * 查询持久事务证据，而不是凭列表差异猜测结果。
   */
  removeProject(projectId: string, opId: string): Promise<RemoveProjectOutcome>;
  /** 按 `opId` 查询持久事务证据（只读磁盘）；证据缺失即 `unknown`。 */
  queryRemovalOp(opId: string): Promise<RemovalOpOutcome>;

  /* ---- UX-02C-01：真实创建 ---- */

  /**
   * 在**已授权项目**的指定相对目录里创建一个空文件 / 空目录。
   *
   * 请求体只有 `projectId / parentDir / name`：绝不含绝对路径、rootDir、
   * rootToken、providerId 或正文。名称合法性与目录边界都由 Host 判定。
   */
  createEntry(
    projectId: string,
    parentDir: string,
    name: string,
    kind: CreateEntryKindDto,
  ): Promise<CreateEntryOutcome>;
}

interface ApiEnvelope {
  status?: string;
  errorCode?: string | null;
  message?: string;
  document?: DocumentSnapshot;
  contentVersion?: string | null;
}

/** 单次请求上限：请求挂住时也要让保存流程收敛为 UNKNOWN，而不是永久锁定（F02）。 */
const REQUEST_TIMEOUT_MS = 20_000;

async function request(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<{ httpStatus: number; body: ApiEnvelope }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    credentials: 'same-origin',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  let body: ApiEnvelope = {};
  try {
    body = (await res.json()) as ApiEnvelope;
  } catch {
    body = {};
  }
  return { httpStatus: res.status, body };
}

/**
 * live 客户端：同源 `/api`（开发时由 Vite 代理到 apps/server）。
 * 不缓存任何内容；每次操作都以服务端返回的会话状态为准。
 */
export function createLiveClient(baseUrl = ''): WeaveSpaceClient {
  /**
   * 取一个会话令牌（T1）。
   *
   * 令牌只证明"请求来自本机 Host 的页面"，不证明任何目录权限；它会被放在
   * `x-ws-token` 头里，由 Host 在每个变更类请求上重新校验。
   */
  const sessionToken = async (): Promise<string> => {
    const { httpStatus, body } = await request(baseUrl, '/api/session-token');
    const token = (body as { token?: unknown }).token;
    if (httpStatus !== 200 || typeof token !== 'string' || token === '') {
      throw new Error(`session-token ${httpStatus}`);
    }
    return token;
  };

  return {
    mode: 'live',
    async workspaceMode() {
      const { body } = await request(baseUrl, '/api/health');
      const mode = (body as { workspaceMode?: string }).workspaceMode;
      // 旧版服务端没有该字段 → 只能是 legacy；不得假定 Multi
      return mode === 'multi' ? 'multi' : 'legacy';
    },
    async workspaceIdentity() {
      const { httpStatus, body } = await request(baseUrl, '/api/health');
      /**
       * 必须是**成功的**健康响应才算"连上了 Host"。
       *
       * 开发代理在 Host 未启动时会返回 5xx/非 JSON，`request()` 会把它降级成空 body；
       * 若在这里当成"旧版服务端（没有摘要）"继续走，就会出现"以为连上了、其实是空工作区"
       * 的假象。因此这里直接抛错，由调用方按"Host 不可用"降级。
       */
      if (httpStatus !== 200) throw new Error(`health ${httpStatus}`);
      const asHealth = body as { status?: string; workspaceMode?: string; workspaceKey?: unknown };
      if (asHealth.status !== 'APPLIED') throw new Error('health not applied');
      const mode: WorkspaceMode = asHealth.workspaceMode === 'multi' ? 'multi' : 'legacy';
      // 只接受"像摘要"的字符串；其余一律视为"身份不可确认"
      const key =
        typeof asHealth.workspaceKey === 'string' && /^[0-9a-zA-Z_-]{16,128}$/.test(asHealth.workspaceKey)
          ? asHealth.workspaceKey
          : null;
      return { workspaceMode: mode, workspaceKey: key };
    },
    async listProjects() {
      const { httpStatus, body } = await request(baseUrl, '/api/projects');
      if (httpStatus === 404) return [];
      const projects = (body as { projects?: ProjectSummary[] }).projects;
      return Array.isArray(projects) ? projects : [];
    },
    async listResources(projectId?: string) {
      const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
      const { body } = await request(baseUrl, `/api/resources${query}`);
      return Array.isArray((body as { nodes?: ResourceNode[] }).nodes)
        ? ((body as { nodes: ResourceNode[] }).nodes ?? [])
        : [];
    },
    async listTree(projectId, dir, cursor, limit, snapshot) {
      const query = new URLSearchParams();
      if (projectId) query.set('projectId', projectId);
      if (dir) query.set('dir', dir);
      if (cursor !== null && cursor !== undefined) query.set('cursor', cursor);
      if (limit !== undefined) query.set('limit', String(limit));
      if (snapshot !== null && snapshot !== undefined) query.set('snapshot', snapshot);
      const suffix = query.toString();
      const { httpStatus, body } = await request(baseUrl, `/api/tree${suffix ? `?${suffix}` : ''}`);
      if (httpStatus !== 200 || body.status !== 'APPLIED') {
        return { status: 'REJECTED' as const, errorCode: body.errorCode ?? null, message: body.message };
      }
      const asTree = body as unknown as {
        level?: string;
        entries?: TreeEntry[];
        page?: Partial<TreePageMeta>;
      };
      // 响应形状不完整时按"拒绝"处理，绝不把半截数据渲染成一棵不完整的树
      const entries = Array.isArray(asTree.entries) ? asTree.entries : null;
      const page = asTree.page;
      if (!entries || !page || typeof page.total !== 'number') {
        return { status: 'REJECTED' as const, errorCode: 'ERR_COMMAND_INTERNAL', message: '目录响应不完整' };
      }
      return {
        status: 'APPLIED' as const,
        level: typeof asTree.level === 'string' ? asTree.level : dir,
        entries,
        page: {
          limit: typeof page.limit === 'number' ? page.limit : entries.length,
          cursor: page.cursor ?? null,
          nextCursor: page.nextCursor ?? null,
          total: page.total,
          snapshot: typeof page.snapshot === 'string' ? page.snapshot : null,
        },
      };
    },
    async openDocument(path: string, projectId?: string) {
      const { body } = await request(baseUrl, '/api/open', {
        method: 'POST',
        body: JSON.stringify(projectId ? { projectId, path } : { path }),
      });
      return {
        status: body.status === 'APPLIED' ? 'APPLIED' : 'REJECTED',
        errorCode: body.errorCode ?? null,
        message: body.message,
        document: body.document,
        reloaded: (body as { reloaded?: boolean }).reloaded === true,
      };
    },
    async readDocument(sessionId: string, viewId?: string | null) {
      const query = new URLSearchParams({ sessionId });
      if (viewId) query.set('viewId', viewId);
      const { body } = await request(baseUrl, `/api/document?${query.toString()}`);
      return {
        status: body.status === 'APPLIED' ? 'APPLIED' : 'REJECTED',
        errorCode: body.errorCode ?? null,
        message: body.message,
        document: body.document,
      };
    },
    async applyEdit(
      sessionId: string,
      buffer: string,
      expectedVersion?: string | null,
      viewId?: string | null,
    ) {
      const { body } = await request(baseUrl, '/api/edit', {
        method: 'POST',
        body: JSON.stringify({
          sessionId,
          buffer,
          expectedVersion: expectedVersion ?? undefined,
          // Multi 必须带 viewId（会话归属校验）；Legacy 允许省略
          ...(viewId ? { viewId } : {}),
        }),
      });
      return {
        status: body.status === 'APPLIED' ? 'APPLIED' : 'REJECTED',
        errorCode: body.errorCode ?? null,
        message: body.message,
        document: body.document,
      };
    },
    async saveDocument(sessionId: string, expectedVersion: string, viewId?: string | null) {
      const { body } = await request(baseUrl, '/api/save', {
        method: 'POST',
        body: JSON.stringify({ sessionId, expectedVersion, viewId: viewId ?? undefined }),
      });
      const status: SaveStatus =
        body.status === 'COMMITTED' || body.status === 'CONFLICT' || body.status === 'FAILED' || body.status === 'UNKNOWN'
          ? body.status
          : 'FAILED';
      return {
        status,
        errorCode: body.errorCode ?? null,
        contentVersion: body.contentVersion ?? null,
        document: body.document,
      };
    },
    async closeDocument(sessionId: string, viewId: string) {
      const { body } = await request(baseUrl, '/api/close', {
        method: 'POST',
        body: JSON.stringify({ sessionId, viewId }),
      });
      return {
        status: body.status === 'APPLIED' ? 'APPLIED' : 'REJECTED',
        errorCode: body.errorCode ?? null,
        message: body.message,
      };
    },
    async readDisk(sessionId: string, viewId?: string | null) {
      const query = new URLSearchParams({ sessionId });
      if (viewId) query.set('viewId', viewId);
      const { body } = await request(baseUrl, `/api/document/disk?${query.toString()}`);
      const asDisk = body as { content?: string; contentVersion?: string };
      if (body.status === 'APPLIED' && typeof asDisk.content === 'string') {
        return {
          status: 'APPLIED' as const,
          content: asDisk.content,
          contentVersion: asDisk.contentVersion ?? '',
        };
      }
      return { status: 'REJECTED' as const, errorCode: body.errorCode ?? null, message: body.message };
    },
    async reloadDocument(sessionId: string, viewId: string) {
      const { body } = await request(baseUrl, '/api/reload', {
        method: 'POST',
        body: JSON.stringify({ sessionId, viewId, discardDraft: true }),
      });
      return {
        status: body.status === 'APPLIED' ? 'APPLIED' : 'REJECTED',
        errorCode: body.errorCode ?? null,
        message: body.message,
        document: body.document,
        previousDraft: (body as { previousDraft?: string }).previousDraft,
      };
    },

    async registrationSupport() {
      const { httpStatus, body } = await request(baseUrl, '/api/projects/registration');
      const asReg = body as { supported?: unknown; mode?: unknown };
      const mode = typeof asReg.mode === 'string' ? asReg.mode : '';
      if (httpStatus !== 200 || body.status !== 'APPLIED') {
        // 旧版 Host 没有这个端点：不得假定"可以添加"，也不得猜一个模式
        return { support: 'unknown' as const, mode: mode || 'unknown' };
      }
      const support: ProjectRegistrationSupport =
        asReg.supported === true
          ? 'managed'
          : mode === 'static'
            ? 'static'
            : mode === 'legacy'
              ? 'legacy'
              : 'unknown';
      return { support, mode: mode || support };
    },

    async bootstrapPick() {
      const { httpStatus, body } = await request(baseUrl, '/api/session-token');
      const token = (body as { token?: unknown }).token;
      if (httpStatus !== 200 || typeof token !== 'string' || token === '') {
        throw new Error(`session-token ${httpStatus}`);
      }
      const intent = (body as { intent?: { intentId?: unknown } }).intent;
      const intentId =
        intent && typeof intent.intentId === 'string' && intent.intentId !== '' ? intent.intentId : null;
      return { token, intentId };
    },

    async startPick(input) {
      const { httpStatus, body } = await request(baseUrl, '/api/projects/pick', {
        method: 'POST',
        headers: { 'x-ws-token': input.token },
        // 只发协议字段：目录与授权凭据只能由 Host 内部产生
        body: JSON.stringify({
          intentId: input.intentId,
          acknowledgeScope: input.acknowledgeScope,
          ...(input.name && input.name.trim() !== '' ? { name: input.name.trim() } : {}),
        }),
      });
      const requestId = (body as { requestId?: unknown }).requestId;
      if (httpStatus === 202 && body.status === 'PENDING' && typeof requestId === 'string' && requestId !== '') {
        return { status: 'PENDING' as const, requestId, httpStatus };
      }
      return {
        status: 'REJECTED' as const,
        errorCode: body.errorCode ?? null,
        message: body.message,
        httpStatus,
      };
    },

    async queryPick(input) {
      const query = new URLSearchParams({ requestId: input.requestId });
      const { httpStatus, body } = await request(baseUrl, `/api/projects/pick?${query.toString()}`, {
        headers: { 'x-ws-token': input.token },
      });
      const asPick = body as { requestId?: unknown; project?: ProjectSummary };
      /**
       * 判定依据是 **HTTP 2xx + body.status**，不是"200"。
       *
       * `PENDING` 记录的 HTTP 状态是 `202 Accepted`（已受理、尚未完成）。若把 202 当错误，
       * 用户在系统窗口里慢慢挑文件夹时，界面会立刻报"添加失败"并停止轮询 —— 而这一次
       * 选择其实完全正常。非 2xx（403/410/501）才是真的拒绝。
       */
      const accepted = httpStatus >= 200 && httpStatus < 300;
      if (accepted) {
        if (body.status === 'APPLIED' && asPick.project) {
          return {
            status: 'APPLIED' as const,
            project: asPick.project,
            requestId: typeof asPick.requestId === 'string' ? asPick.requestId : input.requestId,
            httpStatus,
          };
        }
        if (body.status === 'PENDING') {
          return { status: 'PENDING' as const, requestId: input.requestId, httpStatus };
        }
        if (body.status === 'CANCELLED') {
          return { status: 'CANCELLED' as const, requestId: input.requestId, httpStatus };
        }
      }
      return {
        status: 'REJECTED' as const,
        requestId: input.requestId,
        errorCode: body.errorCode ?? null,
        reason: (body as { reason?: string }).reason,
        message: body.message,
        httpStatus,
      };
    },

    async renameProject(projectId: string, name: string) {
      // 重命名属于变更类请求：先取令牌，Host 会重新校验（T1），不是"取过一次就长期有效"
      let token: string;
      try {
        token = await sessionToken();
      } catch {
        return { status: 'REJECTED' as const, errorCode: 'ERR_PERMISSION_DENIED', message: '无法获取会话令牌', httpStatus: 403 };
      }
      const { httpStatus, body } = await request(baseUrl, '/api/projects/rename', {
        method: 'POST',
        headers: { 'x-ws-token': token },
        body: JSON.stringify({ projectId, name }),
      });
      const project = (body as { project?: ProjectSummary }).project;
      if (httpStatus === 200 && body.status === 'APPLIED' && project) {
        return { status: 'APPLIED' as const, project };
      }
      return {
        status: 'REJECTED' as const,
        errorCode: body.errorCode ?? null,
        message: body.message ?? '重命名失败',
        httpStatus,
      };
    },

    async removalPrecheck(projectId: string) {
      let token: string;
      try {
        token = await sessionToken();
      } catch {
        return { status: 'REJECTED' as const, errorCode: 'ERR_PERMISSION_DENIED', message: '无法获取会话令牌', httpStatus: 403 };
      }
      const { httpStatus, body } = await request(baseUrl, '/api/projects/removal-precheck', {
        method: 'POST',
        headers: { 'x-ws-token': token },
        body: JSON.stringify({ projectId }),
      });
      const asPre = body as {
        allowed?: unknown;
        blockedBy?: unknown;
        state?: unknown;
        errorCode?: string | null;
        message?: string;
      };
      if (httpStatus === 200 && body.status === 'APPLIED' && typeof asPre.allowed === 'boolean') {
        return {
          status: 'APPLIED' as const,
          projectId,
          allowed: asPre.allowed,
          blockedBy: Array.isArray(asPre.blockedBy) ? (asPre.blockedBy as RemoveBlockerCode[]) : [],
          state: typeof asPre.state === 'string' ? asPre.state : 'ACTIVE',
        };
      }
      return {
        status: 'REJECTED' as const,
        errorCode: asPre.errorCode ?? null,
        message: asPre.message ?? '前置检查失败',
        httpStatus,
      };
    },

    async removeProject(projectId: string, opId: string) {
      let token: string;
      try {
        token = await sessionToken();
      } catch {
        return { status: 'REJECTED' as const, errorCode: 'ERR_PERMISSION_DENIED', message: '无法获取会话令牌', httpStatus: 403 };
      }
      let response: { httpStatus: number; body: ApiEnvelope };
      try {
        response = await request(baseUrl, '/api/projects/remove', {
          method: 'POST',
          headers: { 'x-ws-token': token },
          // 确认字段是硬性契约：缺失即 400；opId 由调用方先落定，超时后才能查证据
          body: JSON.stringify({ projectId, confirm: 'remove-from-workspace', opId }),
        });
      } catch {
        /**
         * 断线 / AbortError（20s 超时）/ 代理重置：请求**可能已经到达 Host**。
         * 这里不能抛：调用方需要拿到"结果不明"这个结论，才能用同一个 `opId`
         * 去查持久证据。抛出去只会让界面停在"正在移除…"。
         */
        return {
          status: 'REJECTED' as const,
          errorCode: 'ERR_OUTCOME_UNKNOWN',
          message: '网络中断或请求超时，移除结果未知',
          httpStatus: 0,
        };
      }
      const { httpStatus, body } = response;
      const asRemove = body as {
        outcome?: unknown;
        blockedBy?: unknown;
        opId?: unknown;
        configPersisted?: unknown;
        errorCode?: string | null;
        message?: string;
      };
      // 判定以 body.outcome 为准（配置补写失败时是 5xx，但移除**已生效**）
      if (asRemove.outcome === 'revoked') {
        return {
          status: 'APPLIED' as const,
          projectId,
          opId: typeof asRemove.opId === 'string' ? asRemove.opId : opId,
          configPersisted: asRemove.configPersisted !== false,
        };
      }
      if (asRemove.outcome === 'aborted') {
        return {
          status: 'ABORTED' as const,
          projectId,
          blockedBy: Array.isArray(asRemove.blockedBy) ? (asRemove.blockedBy as RemoveBlockerCode[]) : [],
        };
      }
      return {
        status: 'REJECTED' as const,
        errorCode: asRemove.errorCode ?? null,
        message: asRemove.message ?? '移除失败',
        httpStatus,
      };
    },

    async queryRemovalOp(opId: string) {
      let token: string;
      try {
        token = await sessionToken();
      } catch {
        return { status: 'REJECTED' as const, errorCode: 'ERR_PERMISSION_DENIED', message: '无法获取会话令牌', httpStatus: 403 };
      }
      let response: { httpStatus: number; body: ApiEnvelope };
      try {
        response = await request(baseUrl, `/api/projects/op?opId=${encodeURIComponent(opId)}`, {
          headers: { 'x-ws-token': token },
        });
      } catch {
        // 只读查询失败同样是"没有证据"，不抛：调用方会退到"只读刷新列表 + 人工核对"
        return {
          status: 'REJECTED' as const,
          errorCode: 'ERR_STORAGE_IO',
          message: '无法查询操作结果',
          httpStatus: 0,
        };
      }
      const { httpStatus, body } = response;
      const asOp = body as {
        outcome?: unknown;
        projectId?: unknown;
        errorCode?: string | null;
        message?: string;
      };
      if (
        httpStatus === 200 &&
        (asOp.outcome === 'revoked' ||
          asOp.outcome === 'created' ||
          asOp.outcome === 'aborted' ||
          asOp.outcome === 'unknown')
      ) {
        return {
          status: 'APPLIED' as const,
          opId,
          outcome: asOp.outcome,
          // 归属由 Host 的持久证据给出；缺失即视为"没有归属"，调用方不得据此认领
          projectId: typeof asOp.projectId === 'string' && asOp.projectId !== '' ? asOp.projectId : null,
        };
      }
      return {
        status: 'REJECTED' as const,
        errorCode: asOp.errorCode ?? null,
        message: asOp.message ?? '结果查询失败',
        httpStatus,
      };
    },

    async createEntry(projectId, parentDir, name, kind) {
      let token: string;
      try {
        token = await sessionToken();
      } catch {
        return {
          status: 'REJECTED' as const,
          errorCode: 'ERR_PERMISSION_DENIED',
          message: '无法获取会话令牌',
          httpStatus: 403,
        };
      }
      const endpoint = kind === 'file' ? '/api/files/create' : '/api/directories/create';
      let response: { httpStatus: number; body: ApiEnvelope };
      try {
        response = await request(baseUrl, endpoint, {
          method: 'POST',
          headers: { 'x-ws-token': token },
          // 只提交相对目录 + 单段名称：没有任何路径/根/令牌/providerId 字段
          body: JSON.stringify({ projectId, parentDir, name }),
        });
      } catch {
        /**
         * 断线 / AbortError / 代理重置：请求**可能已经到达 Host 并创建了对象**。
         * 只能是 UNKNOWN：不许重发，由编排层做一次只读目录核对 + 人工确认提示。
         */
        return {
          status: 'UNKNOWN' as const,
          errorCode: 'ERR_OUTCOME_UNKNOWN',
          message: '网络中断或请求超时，创建结果未知',
          httpStatus: 0,
        };
      }
      const { httpStatus, body } = response;
      if (httpStatus === 202 && body.status === 'UNKNOWN') {
        return {
          status: 'UNKNOWN' as const,
          errorCode: 'ERR_OUTCOME_UNKNOWN',
          message: body.message ?? '创建结果未确认，请刷新目录人工核对',
          httpStatus,
        };
      }
      if (httpStatus === 200 && body.status === 'APPLIED') {
        const applied = body as unknown as { relativePath?: unknown };
        // 回执形状不完整时不冒充成功：客户端不能自己猜相对路径
        if (typeof applied.relativePath === 'string' && applied.relativePath !== '') {
          return {
            status: 'APPLIED' as const,
            projectId,
            parentDir,
            name,
            kind,
            relativePath: applied.relativePath,
          };
        }
      }
      return {
        status: 'REJECTED' as const,
        errorCode: body.errorCode ?? (httpStatus === 200 ? 'ERR_COMMAND_INTERNAL' : null),
        message: body.message ?? '创建失败',
        httpStatus,
      };
    },
  };
}

/**
 * demo 客户端：与 live 同构，但全部在内存里。
 *
 * - `saveDocument` 返回 `DEMO`，**不是** `COMMITTED`：演示态不得冒充真实保存；
 * - 不接触任何真实文件，也不写入磁盘。
 */
function extensionFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase() : '';
}

/**
 * demo 的"单层"视图：从嵌套演示树里取出指定层的直接子项。
 *
 * 这样 Demo / Legacy / Multi 三条路径都向同一套 UI 提供 `TreeEntry[]`，
 * 根行与子行的结构差异就没有机会再出现（契约 C.2）。
 */
function demoEntriesAt(nodes: readonly ResourceNode[], dir: string): TreeEntry[] {
  let level = nodes;
  for (const segment of dir.split('/').filter(Boolean)) {
    const folder = level.find((node) => node.kind === 'folder' && node.name === segment);
    if (!folder?.children) return [];
    level = folder.children;
  }
  return level.map((node) => ({
    id: node.id,
    name: node.name,
    kind: node.kind === 'folder' ? ('folder' as const) : ('file' as const),
    extension: node.extension ?? extensionFromName(node.name),
    relPath: node.path ?? (dir ? `${dir}/${node.name}` : node.name),
  }));
}

export function createDemoClient(
  nodes: ResourceNode[],
  contents: Readonly<Record<string, string>>,
): WeaveSpaceClient {
  const versions = new Map<string, string>();

  const find = (id: string): ResourceNode | undefined => {
    const walk = (list: ResourceNode[]): ResourceNode | undefined => {
      for (const node of list) {
        if (node.id === id) return node;
        if (node.children) {
          const hit = walk(node.children);
          if (hit) return hit;
        }
      }
      return undefined;
    };
    return walk(nodes);
  };

  return {
    mode: 'demo',
    // 演示模式不接触 Host：模式恒为 legacy，也没有项目列表
    async workspaceMode() {
      return 'legacy' as const;
    },
    // 演示模式没有工作区身份：不写恢复记录，也不参与身份比对
    async workspaceIdentity() {
      return { workspaceMode: 'legacy' as const, workspaceKey: null };
    },
    async listProjects() {
      return [];
    },
    async listResources() {
      return nodes;
    },
    async listTree(_projectId, dir) {
      const entries = demoEntriesAt(nodes, dir);
      return {
        status: 'APPLIED' as const,
        level: dir,
        entries,
        page: {
          limit: Math.max(entries.length, 1),
          cursor: null,
          nextCursor: null,
          total: entries.length,
          snapshot: null,
        },
      };
    },
    async openDocument(path: string) {
      const node = find(path);
      if (!node || node.kind === 'folder') {
        return { status: 'REJECTED', errorCode: 'ERR_RESOURCE_NOT_FOUND', message: '演示资源不存在' };
      }
      const id = node.id;
      const content = contents[id] ?? '';
      return {
        status: 'APPLIED',
        document: {
          sessionId: `demo-session:${id}`,
          viewId: `demo-view:${id}`,
          resourceId: id,
          path: node.path ?? id,
          content,
          baseVersion: versions.get(id) ?? null,
          revision: 0,
          dirty: false,
          documentState: 'DEMO',
        },
      };
    },
    async readDocument(sessionId: string) {
      const id = sessionId.replace('demo-session:', '');
      const content = contents[id] ?? '';
      return {
        status: 'APPLIED',
        document: {
          sessionId,
          viewId: `demo-view:${id}`,
          resourceId: id,
          path: id,
          content,
          baseVersion: versions.get(id) ?? null,
          revision: 0,
          dirty: false,
          documentState: 'DEMO',
        },
      };
    },
    async applyEdit() {
      return { status: 'APPLIED' };
    },
    async saveDocument(sessionId: string) {
      const id = sessionId.replace('demo-session:', '');
      versions.set(id, `demo:${id}:saved`);
      return { status: 'DEMO', contentVersion: versions.get(id) ?? null };
    },
    async closeDocument() {
      return { status: 'APPLIED' };
    },
    async readDisk(sessionId: string) {
      const id = sessionId.replace('demo-session:', '');
      return {
        status: 'APPLIED' as const,
        content: contents[id] ?? '',
        contentVersion: `demo:${id}`,
      };
    },
    async reloadDocument(sessionId: string, viewId: string) {
      const id = sessionId.replace('demo-session:', '');
      return {
        status: 'APPLIED' as const,
        document: {
          sessionId,
          viewId,
          resourceId: id,
          path: id,
          content: contents[id] ?? '',
          baseVersion: `demo:${id}`,
          revision: 0,
          dirty: false,
          documentState: 'DEMO',
        },
      };
    },

    /*
     * 演示模式没有任何 Host：不弹对话框、不注册项目、不改名称。
     * 返回值刻意不是"失败"而是"不支持"，界面据此给出说明而不是报错。
     */
    async registrationSupport() {
      return { support: 'demo' as const, mode: 'demo' };
    },
    async bootstrapPick() {
      return { token: '', intentId: null };
    },
    async startPick() {
      return { status: 'REJECTED' as const, errorCode: 'ERR_COMMAND_UNSUPPORTED', httpStatus: 501 };
    },
    async queryPick() {
      return { status: 'REJECTED' as const, errorCode: 'ERR_COMMAND_UNSUPPORTED', httpStatus: 501 };
    },
    async renameProject() {
      return {
        status: 'REJECTED' as const,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示数据没有真实项目，无法重命名',
        httpStatus: 501,
      };
    },

    async removalPrecheck() {
      return {
        status: 'REJECTED' as const,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示数据没有真实项目，无法移除',
        httpStatus: 501,
      };
    },

    async removeProject() {
      return {
        status: 'REJECTED' as const,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示数据没有真实项目，无法移除',
        httpStatus: 501,
      };
    },

    async queryRemovalOp() {
      return {
        status: 'REJECTED' as const,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示数据没有真实项目，无法查询移除结果',
        httpStatus: 501,
      };
    },

    async createEntry() {
      return {
        status: 'REJECTED' as const,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示模式不创建真实文件',
        httpStatus: 501,
      };
    },
  };
}
