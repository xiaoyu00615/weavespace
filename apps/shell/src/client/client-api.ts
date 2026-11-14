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
    async listTree(projectId, dir, cursor, limit) {
      const query = new URLSearchParams();
      if (projectId) query.set('projectId', projectId);
      if (dir) query.set('dir', dir);
      if (cursor !== null && cursor !== undefined) query.set('cursor', cursor);
      if (limit !== undefined) query.set('limit', String(limit));
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
        page: { limit: Math.max(entries.length, 1), cursor: null, nextCursor: null, total: entries.length },
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
  };
}
