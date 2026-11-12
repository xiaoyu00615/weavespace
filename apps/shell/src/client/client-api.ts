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

export interface ResourceNode {
  id: string;
  name: string;
  kind: 'folder' | 'markdown' | 'text';
  /** 文件相对路径（live 用于 open）；demo 下与 id 相同。 */
  path?: string;
  children?: ResourceNode[];
}

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
}

export type SaveStatus = 'COMMITTED' | 'CONFLICT' | 'FAILED' | 'UNKNOWN' | 'DEMO';

export interface OpenOutcome {
  status: 'APPLIED' | 'REJECTED';
  errorCode?: string | null;
  message?: string;
  document?: DocumentSnapshot;
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

export interface WeaveSpaceClient {
  readonly mode: ClientMode;
  listResources(): Promise<ResourceNode[]>;
  openDocument(path: string): Promise<OpenOutcome>;
  readDocument(sessionId: string, viewId?: string | null): Promise<OpenOutcome>;
  applyEdit(sessionId: string, buffer: string, expectedVersion?: string | null): Promise<OpenOutcome>;
  saveDocument(sessionId: string, expectedVersion: string, viewId?: string | null): Promise<SaveOutcome>;
  closeDocument(sessionId: string, viewId: string): Promise<CloseOutcome>;
}

interface ApiEnvelope {
  status?: string;
  errorCode?: string | null;
  message?: string;
  document?: DocumentSnapshot;
  contentVersion?: string | null;
}

async function request(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<{ httpStatus: number; body: ApiEnvelope }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    credentials: 'same-origin',
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
    async listResources() {
      const { body } = await request(baseUrl, '/api/resources');
      return Array.isArray((body as { nodes?: ResourceNode[] }).nodes)
        ? ((body as { nodes: ResourceNode[] }).nodes ?? [])
        : [];
    },
    async openDocument(path: string) {
      const { body } = await request(baseUrl, '/api/open', {
        method: 'POST',
        body: JSON.stringify({ path }),
      });
      return {
        status: body.status === 'APPLIED' ? 'APPLIED' : 'REJECTED',
        errorCode: body.errorCode ?? null,
        message: body.message,
        document: body.document,
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
    async applyEdit(sessionId: string, buffer: string, expectedVersion?: string | null) {
      const { body } = await request(baseUrl, '/api/edit', {
        method: 'POST',
        body: JSON.stringify({ sessionId, buffer, expectedVersion: expectedVersion ?? undefined }),
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
  };
}

/**
 * demo 客户端：与 live 同构，但全部在内存里。
 *
 * - `saveDocument` 返回 `DEMO`，**不是** `COMMITTED`：演示态不得冒充真实保存；
 * - 不接触任何真实文件，也不写入磁盘。
 */
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
    async listResources() {
      return nodes;
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
  };
}
