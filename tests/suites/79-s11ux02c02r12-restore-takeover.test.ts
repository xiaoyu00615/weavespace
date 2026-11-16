/**
 * UX-02C-02-R1.2：恢复被用户接管时，本页面遗留 View 的回收（R1-01）。
 *
 * 复审缺陷：页面刷新后旧 View 留在 Host。恢复流程逐个重开标签时会顺带回收
 * 每个文件的旧 View；可一旦用户在恢复途中主动打开某个**尚未恢复**的文件，
 * 恢复立即被接管中止，那个文件的旧 View 就再也没人关了 —— 它是"幽灵 View"，
 * 让该项目从此一直判定为"有活动编辑会话"，改名/移动全部被 409 拦住。
 *
 * 本套件用真实 Host + 真实 opener + 真实 reducer 复现这条时序：
 * 两个旧 View → 恢复开始 → 在第 1 个文件的打开上暂停 → 用户打开第 2 个文件 →
 * 恢复中止 → 检查第 2 个旧 View 是否被回收 → 关掉标签后改名成功。
 *
 * 同时锁定三条边界：不得回收其它页面的 View、不得为了回收丢掉 DIRTY 草稿、
 * 不得破坏 `pendingTabs()` 结转。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createLiveClient, setPageInstanceForTest } from '../../apps/shell/src/client/client-api.ts';
import { createDocumentOpener, createEditEpochs } from '../../apps/shell/src/state/open-document.ts';
import type { DocTab, ResourceNodeState, WorkspaceState } from '../../apps/shell/src/state/types.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import {
  serializeWorkspace,
  type PersistedWorkspaceV1,
  type WorkspaceStore,
} from '../../apps/shell/src/state/workspace-persistence.ts';
import { createWorkspaceRestorer } from '../../apps/shell/src/state/workspace-restore.ts';
import { createWorkspaceWriteGate } from '../../apps/shell/src/state/workspace-write-gate.ts';
import {
  createProjectRuntime,
  type ProjectRuntime,
  type ProjectStore,
  type StoredProject,
} from '../../apps/server/src/project-runtime.ts';
import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { inspectProjectRoot } from '../../packages/project-registry/index.ts';
import { createLocalProvider } from '../../packages/storage/index.ts';

const PROJ_A = 'project-a';
const PAGE = 'page-r12-aaaaaaaa';
const OTHER_PAGE = 'page-r12-bbbbbbbb';

interface ApiResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
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

/** 只提供 `readLast()` 的仓库：恢复流程只读"上次的记录"。 */
function snapshotStore(snapshot: PersistedWorkspaceV1): WorkspaceStore {
  return {
    write: () => 'written',
    read: () => snapshot,
    readLast: () => snapshot,
    clear: () => undefined,
  };
}

interface HarnessOptions {
  /** 上次离开时还开着的文件（按顺序）；恢复会逐个重建。 */
  tabs: readonly string[];
  /**
   * false = 对照组：完整回退到"没有回收能力"的旧行为（接管打开不回收、
   * 中断后也不批量回收），用于证明用例本身具有判别力。缺省 true。
   */
  reclaim?: boolean;
}

interface Ctx {
  rootA: string;
  op: ReturnType<typeof createDocumentOpener>;
  restorer: ReturnType<typeof createWorkspaceRestorer>;
  state(): WorkspaceState;
  dispatch(action: Parameters<typeof workspaceReducer>[1]): void;
  api(path: string, init?: RequestInit): Promise<ApiResponse>;
  post(path: string, body: unknown): Promise<ApiResponse>;
  document(sessionId: string, viewId: string): Promise<ApiResponse>;
  close(sessionId: string, viewId: string): Promise<ApiResponse>;
  rename(body: unknown): Promise<ApiResponse>;
  node(path: string): ResourceNodeState;
  /** 旧页面（刷新前）留下的 View：回放"刷新前打开过哪些文件"。 */
  legacyViews(
    paths: readonly string[],
    page?: string,
  ): Promise<Record<string, { viewId: string; sessionId: string }>>;
  /** 恢复流程停在第 1 个打开上时 resolve。 */
  pauseReached: Promise<void>;
  /** 放行恢复流程（让它继续跑完并给出报告）。 */
  resumeRestore(): void;
  tabOf(path: string): DocTab;
}

async function withShellHost(fn: (ctx: Ctx) => Promise<void>, options: HarnessOptions): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-r12-int-'));
  const rootA = join(base, 'project-a');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await writeFile(join(rootA, 'a.md'), 'A-CONTENT\n', 'utf8');
  await writeFile(join(rootA, 'b.md'), 'B-CONTENT\n', 'utf8');
  await writeFile(join(rootA, 'c.md'), 'C-CONTENT\n', 'utf8');

  const store = new FakeStore([storedProject(PROJ_A, '项目 A', rootA)]);
  let runtimeRef: ProjectRuntime | undefined;
  const server: ShellServer = await createShellServer({
    port: 0,
    managed: {
      create: (deps) => {
        const runtime = createProjectRuntime({
          ...deps,
          store,
          grantSource: 'os-dialog',
          allowEphemeralRevocation: true,
          providerFactory: (input) =>
            createLocalProvider({ rootDir: input.rootDir, providerId: input.providerId }),
        });
        runtimeRef = runtime;
        return runtime;
      },
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
  assert.ok(identity.workspaceKey, 'Host 必须给出工作区摘要');

  const nodes: ResourceNodeState[] = ['a.md', 'b.md', 'c.md'].map((path) => ({
    id: `doc:${PROJ_A}/${path}`,
    name: path,
    kind: 'file',
    extension: '.md',
    path,
  }));

  // 真实的 Shell 状态：只有项目与资源，没有任何标签（= 刷新后的新页面）
  let state: WorkspaceState = {
    ...INITIAL_STATE,
    mode: 'live',
    workspaceMode: 'multi',
    workspaceKey: identity.workspaceKey,
    projects: [{ projectId: PROJ_A, name: '项目 A', status: 'READY' }],
    activeProjectId: PROJ_A,
    resourcesByProject: { [PROJ_A]: nodes },
  };
  const dispatch = (action: Parameters<typeof workspaceReducer>[1]): void => {
    state = workspaceReducer(state, action);
  };

  /** 用真实的序列化器产出"上次离开时"的记录，字段形状与生产完全一致。 */
  const snapshotOf = (tabs: readonly string[]): PersistedWorkspaceV1 => {
    const pre: WorkspaceState = {
      ...state,
      tabs: tabs.map((path, index) => ({
        docId: `doc:${PROJ_A}/${path}`,
        projectId: PROJ_A,
        path,
        title: path,
        extension: '.md',
        buffer: '',
        dirty: false,
        mode: 'live' as const,
        sessionId: `s-${index}`,
        viewId: `v-${index}`,
        baseVersion: null,
        revision: 0,
        documentState: 'CLEAN' as const,
        saving: false,
        lastStatus: null,
        errorCode: null,
      })),
    };
    const snapshot = serializeWorkspace(pre, { workspaceKey: identity.workspaceKey as string });
    assert.ok(snapshot, '记录必须能序列化');
    return snapshot;
  };

  setPageInstanceForTest(PAGE);
  /** restorer 依赖 opener，opener 又要知道"恢复是否在进行"：用 ref 打通（与 Provider 一致）。 */
  let restorerRef: ReturnType<typeof createWorkspaceRestorer> | null = null;
  const reclaimEnabled = options.reclaim !== false;
  const op = createDocumentOpener({
    getState: () => state,
    getMode: () => 'live',
    dispatch,
    clientFor: () => liveClient,
    editEpochs: createEditEpochs(),
    // 对照组：恒为 false = 接管打开也不回收（R1.2 之前的行为）
    isRestoring: () => reclaimEnabled && restorerRef?.isRestoring() === true,
  });

  let releaseRestore: () => void = () => {};
  let paused = false;
  let pauseResolve: () => void = () => {};
  const pauseReached = new Promise<void>((resolve) => {
    pauseResolve = resolve;
  });

  const restorer = createWorkspaceRestorer({
    getState: () => state,
    getMode: () => 'live',
    dispatch,
    store: snapshotStore(snapshotOf(options.tabs)),
    gate: createWorkspaceWriteGate(),
    connectLive: async () => ({
      workspaceKey: identity.workspaceKey,
      workspaceMode: 'multi' as const,
    }),
    openInBackground: async (node, projectId) => {
      if (!paused) {
        paused = true;
        pauseResolve();
        await new Promise<void>((resolve) => {
          releaseRestore = resolve;
        });
      }
      // 与 Provider 完全一致：恢复的后台打开带 reclaimPage
      return op.openNode(node, projectId, { background: true, reclaimPage: true });
    },
    // 与 Provider 完全一致：把"本页面遗留 View 的回收"交给 opener 串行链
    reclaimStaleViews: reclaimEnabled ? (tabs) => op.reclaimStaleViews(tabs) : undefined,
  });
  restorerRef = restorer;

  const ctx: Ctx = {
    rootA,
    op,
    restorer,
    state: () => state,
    dispatch,
    api,
    post,
    document: (sessionId, viewId) =>
      api(
        `/api/document?sessionId=${encodeURIComponent(sessionId)}&viewId=${encodeURIComponent(viewId)}`,
      ),
    close: (sessionId, viewId) => post('/api/close', { sessionId, viewId }),
    rename: (body) => post('/api/files/rename', body),
    node: (path) => {
      const hit = nodes.find((node) => node.path === path);
      assert.ok(hit, `夹具缺少节点 ${path}`);
      return hit;
    },
    legacyViews: async (paths, page = PAGE) => {
      const out: Record<string, { viewId: string; sessionId: string }> = {};
      for (const path of paths) {
        const res = await post('/api/open', { projectId: PROJ_A, path, clientInstanceId: page });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        out[path] = {
          viewId: res.body.document.viewId as string,
          sessionId: res.body.document.sessionId as string,
        };
      }
      return out;
    },
    pauseReached,
    resumeRestore: () => releaseRestore(),
    tabOf: (path) => {
      const tab = state.tabs.find((item) => item.path === path);
      assert.ok(tab, `标签 ${path} 必须存在`);
      return tab;
    },
  };

  try {
    await fn(ctx);
  } finally {
    setPageInstanceForTest(null);
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true });
  }
}

/* ------------------------------ R1.2-01 ------------------------------ */

test('R1.2-01a 两个旧 View → 恢复被接管 → 第 2 个旧 View 被回收，关标签后改名成功', async () => {
  await withShellHost(
    async (h) => {
      // 1) 上一轮页面：a、b 各留下一个 View（刷新后都成了"幽灵"）
      const legacy = await h.legacyViews(['a.md', 'b.md']);
      assert.equal((await h.document(legacy['a.md'].sessionId, legacy['a.md'].viewId)).status, 200);
      assert.equal((await h.document(legacy['b.md'].sessionId, legacy['b.md'].viewId)).status, 200);

      // 2) 刷新后开始恢复：停在第 1 个文件（a.md）的打开上
      const restoring = h.restorer.restore();
      await h.pauseReached;

      // 3) 用户主动打开尚未恢复的 b.md（真实用户路径）
      h.restorer.noteInteraction();
      const opened = await h.op.openNode(h.node('b.md'), PROJ_A);
      assert.equal(opened.ok, true, JSON.stringify(opened));
      const newB = h.tabOf('b.md');
      assert.ok(newB.viewId && newB.sessionId);
      assert.notEqual(newB.viewId, legacy['b.md'].viewId, '接管打开必须建立新 View');

      /**
       * 3b) 回收必须发生在**接管打开那一刻**，而不是等恢复收尾时补一刀：
       * 恢复此刻还停在第 1 个文件的打开上，用户在完全相同的时刻去改名，
       * 也不该被一个早已没人持有的旧 View 拦住。
       */
      assert.notEqual(
        (await h.document(legacy['b.md'].sessionId, legacy['b.md'].viewId)).status,
        200,
        '接管打开必须当场回收该资源的旧 View（不能等恢复收尾）',
      );

      // 4) 放行恢复：它必须立刻发现自己已被接管并中止
      h.resumeRestore();
      const report = await restoring;
      assert.equal(report.status, 'interrupted');
      assert.equal(report.reason, 'superseded');

      // 5) 关键断言：第 2 个旧 View 已被回收（否则改名会被永久拦住）
      assert.notEqual(
        (await h.document(legacy['b.md'].sessionId, legacy['b.md'].viewId)).status,
        200,
        '第 2 个旧 View 必须被回收',
      );
      // 第 1 个旧 View 由恢复自身的 reclaim 回收（它确实走到了打开 a.md）
      assert.notEqual(
        (await h.document(legacy['a.md'].sessionId, legacy['a.md'].viewId)).status,
        200,
        '恢复自己打开的 a.md 旧 View 也应被回收',
      );
      // 接管打开的新 View 必须仍然有效（不能被回收顺手关掉）
      assert.equal((await h.document(newB.sessionId as string, newB.viewId as string)).status, 200);

      // 6) pendingTabs 结转未被破坏：b.md 仍是"未处理"的待恢复标签
      assert.deepEqual(
        h.restorer.pendingTabs().map((tab) => tab.path),
        ['b.md'],
        '恢复中断后的结转机制不得被回收逻辑改坏',
      );

      // 7) 关掉用户标签的 View 之后改名成功（没有幽灵 View 拦路）
      assert.equal((await h.close(newB.sessionId as string, newB.viewId as string)).status, 200);
      const renamed = await h.rename({
        projectId: PROJ_A,
        sourcePath: 'b.md',
        name: 'b-renamed.md',
      });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      assert.equal(existsSync(join(h.rootA, 'b-renamed.md')), true);
      assert.equal(existsSync(join(h.rootA, 'b.md')), false);
    },
    { tabs: ['a.md', 'b.md'] },
  );
});

test('R1.2-01b 对照：没有回收能力时，第 2 个旧 View 会留下并拦住改名（用例有判别力）', async () => {
  await withShellHost(
    async (h) => {
      const legacy = await h.legacyViews(['a.md', 'b.md']);
      const restoring = h.restorer.restore();
      await h.pauseReached;
      h.restorer.noteInteraction();
      await h.op.openNode(h.node('b.md'), PROJ_A);
      h.resumeRestore();
      await restoring;

      const newB = h.tabOf('b.md');
      assert.equal((await h.close(newB.sessionId as string, newB.viewId as string)).status, 200);
      const blocked = await h.rename({ projectId: PROJ_A, sourcePath: 'b.md', name: 'nope.md' });
      assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
      assert.equal(blocked.body.errorCode, 'ERR_STRUCTURE_SESSION_BUSY');
      // 旧 View 还在（对照组如实暴露缺陷形态）
      assert.equal((await h.document(legacy['b.md'].sessionId, legacy['b.md'].viewId)).status, 200);
    },
    { tabs: ['a.md', 'b.md'], reclaim: false },
  );
});

test('R1.2-01c 不得回收其它页面的 View', async () => {
  await withShellHost(
    async (h) => {
      // 另一个页面（另一个浏览器标签页）也开着 b.md
      const other = await h.legacyViews(['b.md'], OTHER_PAGE);
      const mine = await h.legacyViews(['a.md', 'b.md']);

      const restoring = h.restorer.restore();
      await h.pauseReached;
      h.restorer.noteInteraction();
      await h.op.openNode(h.node('b.md'), PROJ_A);
      h.resumeRestore();
      const report = await restoring;
      assert.equal(report.status, 'interrupted');

      // 本页面的旧 View 已回收，另一个页面的 View 必须完好
      assert.notEqual(
        (await h.document(mine['b.md'].sessionId, mine['b.md'].viewId)).status,
        200,
        '本页面旧 View 必须回收',
      );
      assert.equal(
        (await h.document(other['b.md'].sessionId, other['b.md'].viewId)).status,
        200,
        '绝不能回收另一个页面的 View',
      );

      // 另一个页面的 View 仍在 → 改名被拦（这是正确的跨页保护，不是缺陷）
      const mine2 = h.tabOf('b.md');
      await h.close(mine2.sessionId as string, mine2.viewId as string);
      const blocked = await h.rename({ projectId: PROJ_A, sourcePath: 'b.md', name: 'x.md' });
      assert.equal(blocked.status, 409, JSON.stringify(blocked.body));

      // 关掉另一页的 View 之后才允许
      assert.equal(
        (await h.close(other['b.md'].sessionId, other['b.md'].viewId)).status,
        200,
      );
      const ok = await h.rename({ projectId: PROJ_A, sourcePath: 'b.md', name: 'x.md' });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
    },
    { tabs: ['a.md', 'b.md'] },
  );
});

test('R1.2-01d 不得为了回收 View 而丢弃 DIRTY 草稿', async () => {  await withShellHost(
    async (h) => {
      const legacy = await h.legacyViews(['a.md', 'b.md', 'c.md']);
      // c.md 在上一次会话里有未保存草稿（只有那个 View 持有它）
      const dirty = await h.post('/api/edit', {
        sessionId: legacy['c.md'].sessionId,
        viewId: legacy['c.md'].viewId,
        buffer: 'DRAFT-NOT-SAVED\n',
        expectedVersion: undefined,
      });
      assert.equal(dirty.status, 200, JSON.stringify(dirty.body));

      const restoring = h.restorer.restore();
      await h.pauseReached;
      h.restorer.noteInteraction();
      await h.op.openNode(h.node('b.md'), PROJ_A);
      h.resumeRestore();
      const report = await restoring;
      assert.equal(report.status, 'interrupted');
      // a、b 已处理，c 未处理 → 结转里必须有 c
      assert.deepEqual(
        h.restorer.pendingTabs().map((tab) => tab.path).sort(),
        ['b.md', 'c.md'],
      );

      // c 的旧 View 是"最后一个脏视图"：回收必须被拒绝，草稿原样保留
      const stillThere = await h.document(legacy['c.md'].sessionId, legacy['c.md'].viewId);
      assert.equal(stillThere.status, 200, '不得为了回收 View 关闭最后一个脏视图');
      assert.equal(stillThere.body.document.content, 'DRAFT-NOT-SAVED\n');
      assert.equal(await readFile(join(h.rootA, 'c.md'), 'utf8'), 'C-CONTENT\n', '磁盘零写入');

      // 因此 c.md 仍然不能改名：这是"保住草稿"的正确代价，不是缺陷
      const blocked = await h.rename({ projectId: PROJ_A, sourcePath: 'c.md', name: 'c2.md' });
      assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
      assert.equal(blocked.body.errorCode, 'ERR_STRUCTURE_SESSION_BUSY');
    },
    { tabs: ['a.md', 'b.md', 'c.md'] },
  );
});

test('R1.2-01e 接管后，未被用户打开的待恢复文件同样不得遗留旧 View', async () => {
  await withShellHost(
    async (h) => {
      // 三个文件都开着；用户只接管 b.md，c.md 从头到尾没有被重新打开
      const legacy = await h.legacyViews(['a.md', 'b.md', 'c.md']);
      const restoring = h.restorer.restore();
      await h.pauseReached;
      h.restorer.noteInteraction();
      await h.op.openNode(h.node('b.md'), PROJ_A);
      h.resumeRestore();
      const report = await restoring;
      assert.equal(report.status, 'interrupted');

      // c.md 的旧 View 只能由"接管后批量回收"关掉：这是 requirement-2 的核心
      assert.notEqual(
        (await h.document(legacy['c.md'].sessionId, legacy['c.md'].viewId)).status,
        200,
        '未被重新打开的待恢复文件同样不得留下旧 View',
      );
      assert.deepEqual(
        h.restorer.pendingTabs().map((tab) => tab.path).sort(),
        ['b.md', 'c.md'],
        '结转列表本身不受回收影响',
      );

      // 不需要关任何标签就能给 c.md 改名（它已经没有活动会话视图）
      const renamed = await h.rename({
        projectId: PROJ_A,
        sourcePath: 'c.md',
        name: 'c-renamed.md',
      });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      assert.equal(existsSync(join(h.rootA, 'c-renamed.md')), true);
    },
    { tabs: ['a.md', 'b.md', 'c.md'] },
  );
});
