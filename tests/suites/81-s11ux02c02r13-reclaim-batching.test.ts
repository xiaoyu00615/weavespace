/**
 * UX-02C-02-R1.3（R1.3-02）：批量回收按 Host 的协议上限分批。
 *
 * Host 的 `POST /api/views/reclaim` 单次最多接受 `MAX_RECLAIM_PATHS`（64）条路径。
 * R1.2 的客户端把"每个项目的全部待回收路径"塞进一个请求：只要待恢复标签超过 64 个，
 * 整批被 400 拒绝，异常随后被吞掉 → 一个 View 都没回收，且没有任何观察点。
 *
 * 本套件用真实 Host + 真实 HTTP + 真实磁盘锁定：
 * - 64 / 65 / 128 / 129 条路径分别切成 1 / 2 / 2 / 3 批，且每批不超过上限；
 * - 每批都带正确的 projectId、clientInstanceId 与 keepViewIds；
 * - 某一批失败（400）不影响其它批次，失败规模被如实计入返回值；
 * - 去重后不会重复回收，也不会误关当前标签持有的 View；
 * - 分批发生在同一条维护串行链内（打开与回收互不穿插，由 opener 保证）。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createLiveClient, setPageInstanceForTest } from '../../apps/shell/src/client/client-api.ts';
import { createDocumentOpener, createEditEpochs } from '../../apps/shell/src/state/open-document.ts';
import type { DocTab, WorkspaceAction, WorkspaceState } from '../../apps/shell/src/state/types.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import {
  createProjectRuntime,
  type ProjectStore,
  type StoredProject,
} from '../../apps/server/src/project-runtime.ts';
import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { inspectProjectRoot } from '../../packages/project-registry/index.ts';
import { createLocalProvider } from '../../packages/storage/index.ts';

const PROJ_A = 'project-a';
const PAGE = 'page-r13-batching';

interface ApiResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

interface ReclaimCall {
  readonly paths: number;
  readonly projectId: unknown;
  readonly clientInstanceId: unknown;
  readonly keepViewIds: readonly string[];
}

class FakeStore implements ProjectStore {
  readonly durability = 'memory' as const;
  private projects: StoredProject[];
  constructor(initial: readonly StoredProject[]) {
    this.projects = initial.map((project) => ({ ...project }));
  }
  load(): readonly StoredProject[] {
    return this.projects.map((project) => ({ ...project }));
  }
  async commitAdd(entry: StoredProject & { opId: string }): Promise<void> {
    const { opId: _opId, ...rest } = entry;
    this.projects.push(rest);
  }
  async commitRename(input: { projectId: string; name: string; opId: string }): Promise<void> {
    this.projects = this.projects.map((project) =>
      project.projectId === input.projectId ? { ...project, name: input.name } : project,
    );
  }
  async commitRevoke(input: { projectId: string; opId: string }): Promise<void> {
    this.projects = this.projects.filter((project) => project.projectId !== input.projectId);
  }
}

function storedProject(projectId: string, name: string, rootDir: string): StoredProject {
  const inspected = inspectProjectRoot(rootDir);
  assert.equal(inspected.status, 'READY', `夹具根必须 READY: ${projectId}`);
  return {
    projectId,
    name,
    rootDir,
    canonicalRoot: inspected.canonicalRoot,
    rootToken: inspected.rootToken,
    grantedAt: new Date().toISOString(),
    grantSource: 'os-dialog',
  };
}

interface Ctx {
  rootA: string;
  op: ReturnType<typeof createDocumentOpener>;
  state(): WorkspaceState;
  dispatch(action: WorkspaceAction): void;
  api(path: string, init?: RequestInit): Promise<ApiResponse>;
  post(path: string, body: unknown): Promise<ApiResponse>;
  document(sessionId: string, viewId: string): Promise<ApiResponse>;
  file(index: number): string;
  openAll(): Promise<void>;
  views(): Record<string, { viewId: string; sessionId: string }>;
  /** 记录本进程对 `/api/views/reclaim` 的调用（真实请求仍然发出去）。 */
  calls(): readonly ReclaimCall[];
}

/**
 * 起一台真实 Host + 真实 Provider，预置 `count` 个小文件。
 *
 * 计数器包在 `globalThis.fetch` 外面：它只**观察**，不拦截也不改请求，
 * 因此这里仍然是真实 HTTP 往返，而不是 mock。
 */
async function withBatchHost(fn: (ctx: Ctx) => Promise<void>, count: number): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-r13-batch-'));
  const rootA = join(base, 'project-a');
  await mkdir(rootA, { recursive: true });

  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const name = `f${String(i).padStart(3, '0')}.md`;
    names.push(name);
    await writeFile(join(rootA, name), `# ${name}\n`, 'utf8');
  }

  const store = new FakeStore([storedProject(PROJ_A, '项目 A', rootA)]);
  const server: ShellServer = await createShellServer({
    port: 0,
    managed: {
      create: (deps) =>
        createProjectRuntime({
          ...deps,
          store,
          grantSource: 'os-dialog',
          allowEphemeralRevocation: true,
          providerFactory: (input) =>
            createLocalProvider({ rootDir: input.rootDir, providerId: input.providerId }),
        }),
    },
  });

  const api = async (path: string, init?: RequestInit): Promise<ApiResponse> => {
    const res = await fetch(`${server.url}${path}`, init);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  };
  const tokenRes = await api('/api/session-token');
  const token = (tokenRes.body as { token?: string }).token ?? '';
  assert.notEqual(token, '');
  const post = (path: string, body: unknown): Promise<ApiResponse> =>
    api(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ws-token': token,
        origin: new URL(server.url).origin,
      },
      body: JSON.stringify(body),
    });

  const liveClient = createLiveClient(server.url);
  const identity = await liveClient.workspaceIdentity();
  assert.ok(identity.workspaceKey);

  let state: WorkspaceState = {
    ...INITIAL_STATE,
    mode: 'live',
    workspaceMode: 'multi',
    workspaceKey: identity.workspaceKey,
    projects: [{ projectId: PROJ_A, name: '项目 A', status: 'READY' }],
    activeProjectId: PROJ_A,
    resourcesByProject: { [PROJ_A]: [] },
  };
  const dispatch = (action: WorkspaceAction): void => {
    state = workspaceReducer(state, action);
  };

  setPageInstanceForTest(PAGE);
  const op = createDocumentOpener({
    getState: () => state,
    getMode: () => 'live',
    dispatch,
    clientFor: () => liveClient,
    editEpochs: createEditEpochs(),
  });

  const reclaimed: ReclaimCall[] = [];
  const originalFetch = globalThis.fetch;
  type FetchInput = Parameters<typeof originalFetch>[0];
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/views/reclaim')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        paths?: unknown;
        projectId?: unknown;
        clientInstanceId?: unknown;
        keepViewIds?: unknown;
      };
      reclaimed.push({
        paths: Array.isArray(body.paths) ? body.paths.length : -1,
        projectId: body.projectId,
        clientInstanceId: body.clientInstanceId,
        keepViewIds: Array.isArray(body.keepViewIds) ? (body.keepViewIds as string[]) : [],
      });
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;

  const opened: Record<string, { viewId: string; sessionId: string }> = {};
  const ctx: Ctx = {
    rootA,
    op,
    state: () => state,
    dispatch,
    api,
    post,
    document: (sessionId, viewId) =>
      api(
        `/api/document?sessionId=${encodeURIComponent(sessionId)}&viewId=${encodeURIComponent(viewId)}`,
      ),
    file: (index) => names[index],
    openAll: async () => {
      for (const name of names) {
        const res = await post('/api/open', {
          projectId: PROJ_A,
          path: name,
          clientInstanceId: PAGE,
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        opened[name] = {
          viewId: res.body.document.viewId as string,
          sessionId: res.body.document.sessionId as string,
        };
      }
    },
    views: () => opened,
    calls: () => reclaimed,
  };

  try {
    await fn(ctx);
  } finally {
    globalThis.fetch = originalFetch;
    setPageInstanceForTest(null);
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true });
  }
}

function entriesOf(ctx: Ctx, count: number, transform?: (index: number) => string) {
  return Array.from({ length: count }, (_, index) => ({
    projectId: PROJ_A,
    path: transform ? transform(index) : ctx.file(index),
  }));
}

/* ------------------------------ R1.3-02 ------------------------------ */

test('R1.3-02a 64 条路径：单批发完，不拆分', async () => {
  await withBatchHost(async (h) => {
    await h.openAll();
    const summary = await h.op.reclaimStaleViews(entriesOf(h, 64));
    assert.equal(summary.closed, 64);
    assert.equal(summary.blocked, 0);
    assert.equal(summary.failed, 0);
    assert.deepEqual(h.calls().map((call) => call.paths), [64]);
    assert.equal(h.calls()[0].projectId, PROJ_A);
    assert.equal(h.calls()[0].clientInstanceId, PAGE);
  }, 64);
});

test('R1.3-02b 65 条路径：切成 64 + 1，两批都真的执行', async () => {
  await withBatchHost(async (h) => {
    await h.openAll();
    const summary = await h.op.reclaimStaleViews(entriesOf(h, 65));
    assert.equal(summary.closed, 65);
    assert.equal(summary.failed, 0);
    assert.deepEqual(h.calls().map((call) => call.paths), [64, 1]);
    // 每条路径只出现一次：没有重复回收
    const total = h.calls().reduce((sum, call) => sum + call.paths, 0);
    assert.equal(total, 65);
  }, 65);
});

test('R1.3-02c 128 条路径：64 + 64，全部关闭且无遗漏', async () => {
  await withBatchHost(async (h) => {
    await h.openAll();
    const summary = await h.op.reclaimStaleViews(entriesOf(h, 128));
    assert.equal(summary.closed, 128);
    assert.equal(summary.failed, 0);
    assert.deepEqual(h.calls().map((call) => call.paths), [64, 64]);
    // 抽查首、中、尾三个 View 都已关闭
    const views = h.views();
    for (const index of [0, 63, 64, 127]) {
      const view = views[h.file(index)];
      assert.notEqual(
        (await h.document(view.sessionId, view.viewId)).status,
        200,
        `${h.file(index)} 的 View 应已回收`,
      );
    }
  }, 128);
});

test('R1.3-02d 129 条路径：64 + 64 + 1，最后一批只有 1 条也要发', async () => {
  await withBatchHost(async (h) => {
    await h.openAll();
    const summary = await h.op.reclaimStaleViews(entriesOf(h, 129));
    assert.equal(summary.closed, 129);
    assert.equal(summary.failed, 0);
    assert.deepEqual(h.calls().map((call) => call.paths), [64, 64, 1]);
  }, 129);
});

test('R1.3-02e 中间批次被拒：其它批次照常执行，失败规模如实报告', async () => {
  await withBatchHost(
    async (h) => {
      await h.openAll();
      // 第 65 条（第 2 批的第一条）是非法路径：整批 400，且零副作用
      // `..` 段由 Host 判为非法路径：整批 400，且零副作用
      const entries = entriesOf(h, 129, (index) =>
        index === 64 ? '../escape.md' : h.file(index),
      );
      const summary = await h.op.reclaimStaleViews(entries);
      // 3 个批次：第 1 批 64 条成功、第 2 批 64 条整批失败、第 3 批 1 条成功
      assert.deepEqual(h.calls().map((call) => call.paths), [64, 64, 1]);
      assert.equal(summary.closed, 65, '成功批次必须照常回收');
      assert.equal(summary.failed, 64, '失败批次必须被计数，不能静默跳过');
      assert.equal(summary.blocked, 0);
      // 失败批次里的 View 仍然存在（没有假装回收成功）
      const kept = h.views()[h.file(65)];
      assert.equal(
        (await h.document(kept.sessionId, kept.viewId)).status,
        200,
        '失败批次的 View 必须原样保留',
      );
      // 成功批次的 View 已关闭
      const gone = h.views()[h.file(0)];
      assert.notEqual((await h.document(gone.sessionId, gone.viewId)).status, 200);
    },
    129,
  );
});

test('R1.3-02f 重复路径去重、keepViewIds 每批都带，当前 View 不被误关', async () => {
  await withBatchHost(async (h) => {
    await h.openAll();
    const first = h.views()[h.file(0)];
    // 当前标签持有 f000：它属于"当前活动 View"，任何批次都不得关闭
    const tab: DocTab = {
      docId: `doc:${PROJ_A}/${h.file(0)}`,
      projectId: PROJ_A,
      path: h.file(0),
      title: h.file(0),
      extension: '.md',
      buffer: '',
      dirty: false,
      mode: 'live',
      sessionId: first.sessionId,
      viewId: first.viewId,
      baseVersion: null,
      revision: 0,
      documentState: 'CLEAN',
      saving: false,
      lastStatus: null,
      errorCode: null,
    };
    h.dispatch({ type: 'OPEN_TAB', tab });

    // 70 条输入里前 6 条互相重复 → 去重后 65 条唯一路径
    const entries = entriesOf(h, 70, (index) => h.file(index >= 6 ? index - 5 : index));
    const summary = await h.op.reclaimStaleViews(entries);
    assert.deepEqual(h.calls().map((call) => call.paths), [64, 1], '去重后才分批');
    assert.equal(summary.closed, 64, '唯一的 65 条里，1 条被 keep 保护');
    assert.equal(summary.failed, 0);
    // 每批都带同一个 keep 列表
    for (const call of h.calls()) {
      assert.deepEqual(call.keepViewIds, [first.viewId]);
      assert.equal(call.clientInstanceId, PAGE);
      assert.equal(call.projectId, PROJ_A);
    }
    assert.equal(
      (await h.document(first.sessionId, first.viewId)).status,
      200,
      '当前标签的 View 绝不能被批量回收顺手关掉',
    );
  }, 65);
});
