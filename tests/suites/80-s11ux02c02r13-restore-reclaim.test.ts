/**
 * UX-02C-02-R1.3（R1.3-01）：恢复**没能重开**的标签，其旧 View 同样必须回收。
 *
 * R1.2 只把"没来得及处理"的标签交给回收通道。复审发现另外四类被跳过的标签
 * （`open-rejected` / `file-missing` / `project-unavailable` / `unsaved-changes`）
 * 的旧 View 从来没有回收路径：它们不会再有 `/api/open` 去顺带清掉，于是该项目
 * 一直判定"有活动编辑会话"，改名/移动被 409 拦住——**即使文件或项目随后恢复可用**。
 *
 * 本套件用真实 Host + 真实 HTTP + 真实磁盘锁定：
 * - 四类跳过路径都进入回收候选（跳过不等于"这个人不存在"）；
 * - 当前标签持有的 View 与其它页面实例的 View 绝不回收；
 * - 脏草稿受保护：拒绝关闭时如实计入 `blocked`、View 与正文原样保留，
 *   **绝不为了清理 View 丢弃未保存内容**；
 * - 回收失败（项目不可用 / 请求被拒）必须可观察，不得静默跳过；
 * - 恢复被接管时，pending 与 skipped 都在结算前回收。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createLiveClient, setPageInstanceForTest } from '../../apps/shell/src/client/client-api.ts';
import type { TreeLevels } from '../../apps/shell/src/components/tree-model.ts';
import { createDocumentOpener, createEditEpochs } from '../../apps/shell/src/state/open-document.ts';
import type {
  DocTab,
  ResourceNodeState,
  WorkspaceAction,
  WorkspaceState,
} from '../../apps/shell/src/state/types.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import {
  serializeWorkspace,
  type PersistedTab,
  type PersistedWorkspaceV1,
  type WorkspaceStore,
} from '../../apps/shell/src/state/workspace-persistence.ts';
import {
  createWorkspaceRestorer,
  type RestoreReport,
} from '../../apps/shell/src/state/workspace-restore.ts';
import { createWorkspaceWriteGate } from '../../apps/shell/src/state/workspace-write-gate.ts';
import {
  createProjectRuntime,
  type ProjectStore,
  type StoredProject,
} from '../../apps/server/src/project-runtime.ts';
import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { inspectProjectRoot } from '../../packages/project-registry/index.ts';
import { createLocalProvider } from '../../packages/storage/index.ts';

const PROJ_A = 'project-a';
const PAGE = 'page-r13-aaaaaaaa';
const OTHER_PAGE = 'page-r13-bbbbbbbb';

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

function snapshotStore(snapshot: PersistedWorkspaceV1): WorkspaceStore {
  return {
    write: () => 'written',
    read: () => snapshot,
    readLast: () => snapshot,
    clear: () => undefined,
  };
}

/** 根层"已完整枚举"的层表：`branchFullyLoaded` 为真，"树里没有"才等价于"没有了"。 */
function completeRootLevel(files: readonly string[]): TreeLevels {
  return {
    '': {
      dir: '',
      entries: files.map((path) => ({
        id: `doc:${PROJ_A}/${path}`,
        name: path,
        kind: 'file' as const,
        extension: '.md',
        path,
      })),
      nextCursor: null,
      total: files.length,
      status: 'ready' as const,
      errorCode: null,
      loadingMore: false,
      snapshot: null,
      // UX-02C-03-P1 给层状态加了"本层隐藏条目数"：这个夹具不涉及隐藏，固定 0
      hiddenCount: 0,
    },
  };
}

interface Ctx {
  rootA: string;
  op: ReturnType<typeof createDocumentOpener>;
  restorer: ReturnType<typeof createWorkspaceRestorer>;
  state(): WorkspaceState;
  dispatch(action: WorkspaceAction): void;
  api(path: string, init?: RequestInit): Promise<ApiResponse>;
  post(path: string, body: unknown): Promise<ApiResponse>;
  document(sessionId: string, viewId: string): Promise<ApiResponse>;
  close(sessionId: string, viewId: string): Promise<ApiResponse>;
  rename(body: unknown): Promise<ApiResponse>;
  node(path: string): ResourceNodeState;
  legacyViews(
    paths: readonly string[],
    page?: string,
  ): Promise<Record<string, { viewId: string; sessionId: string }>>;
  /** 恢复停在被 `pauseOn` 指定的那次后台打开上时 resolve（未启用则永不 resolve）。 */
  pauseReached: Promise<void>;
  resume(): void;
  tabOf(path: string): DocTab | undefined;
  report(): RestoreReport | null;
}

interface HarnessOptions {
  /** 上次离开时开着的标签（按顺序）。 */
  tabs: readonly string[];
  /**
   * 有未保存内容的结转标签：只出现在记录里，**不会**被恢复重开（DR-01）。
   * 用来验证"保护草稿优先于清理 View"。
   */
  unsavedTabs?: readonly string[];
  /**
   * `'none'`（默认）：没有层表 → 树里找不到的路径交 Host 裁决（可得到 open-rejected）。
   * `'root'`：根层已完整枚举 → 树里没有即"不存在"（得到 file-missing）。
   */
  tree?: 'none' | 'root';
  /** 资源表里的文件（默认 a/b/c）。不在表里 + 层表完整 = file-missing。 */
  resources?: readonly string[];
  /** Shell 侧项目状态（默认 READY）。 */
  projectStatus?: 'READY' | 'UNAVAILABLE';
  /**
   * 记录里属于**别的项目**的标签（例如那个项目已经被移除）。
   * 用来验证"回收失败必须可观察"：Host 对未知项目返回 404。
   */
  foreignTabs?: readonly { projectId: string; path: string }[];
  /** 在这个路径的后台打开上暂停一次（用于"恢复被接管"）。 */
  pauseOn?: string;
}

async function withRestoreHost(fn: (ctx: Ctx) => Promise<void>, options: HarnessOptions): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-r13-int-'));
  const rootA = join(base, 'project-a');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  for (const name of ['a.md', 'b.md', 'c.md']) {
    await writeFile(join(rootA, name), `${name} CONTENT\n`, 'utf8');
  }

  const store = new FakeStore([storedProject(PROJ_A, '项目 A', rootA)]);
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

  const visible = options.resources ?? ['a.md', 'b.md', 'c.md'];
  const nodes: ResourceNodeState[] = visible.map((path) => ({
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
    projects: [{ projectId: PROJ_A, name: '项目 A', status: options.projectStatus ?? 'READY' }],
    activeProjectId: PROJ_A,
    resourcesByProject: { [PROJ_A]: nodes },
    treeByProject: options.tree === 'root' ? { [PROJ_A]: completeRootLevel(visible) } : {},
  };
  const dispatch = (action: WorkspaceAction): void => {
    state = workspaceReducer(state, action);
  };

  /** 用真实序列化器产出"上次离开时"的记录，字段形状与生产完全一致。 */
  const snapshotOf = (): PersistedWorkspaceV1 => {
    const pre: WorkspaceState = {
      ...state,
      tabs: options.tabs.map((path, index) => ({
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
    const carryOver: PersistedTab[] = [
      ...(options.unsavedTabs ?? []).map((path) => ({
        projectId: PROJ_A,
        path,
        mode: 'live' as const,
        hadUnsavedChanges: true,
      })),
      ...(options.foreignTabs ?? []).map((tab) => ({
        projectId: tab.projectId,
        path: tab.path,
        mode: 'live' as const,
        hadUnsavedChanges: false,
      })),
    ];
    const snapshot = serializeWorkspace(pre, {
      workspaceKey: identity.workspaceKey as string,
      carryOver,
    });
    assert.ok(snapshot, '记录必须能序列化');
    return snapshot;
  };

  setPageInstanceForTest(PAGE);
  /** restorer 依赖 opener，opener 又要知道"恢复是否在进行"：用 ref 打通（与 Provider 一致）。 */
  let restorerRef: ReturnType<typeof createWorkspaceRestorer> | null = null;
  const op = createDocumentOpener({
    getState: () => state,
    getMode: () => 'live',
    dispatch,
    clientFor: () => liveClient,
    editEpochs: createEditEpochs(),
    isRestoring: () => restorerRef?.isRestoring() === true,
  });

  let releaseRestore: () => void = () => undefined;
  let pausedOnce = false;
  let pauseResolve: () => void = () => undefined;
  const pauseReached = new Promise<void>((resolve) => {
    pauseResolve = resolve;
  });

  const restorer = createWorkspaceRestorer({
    getState: () => state,
    getMode: () => 'live',
    dispatch,
    store: snapshotStore(snapshotOf()),
    gate: createWorkspaceWriteGate(),
    connectLive: async () => ({
      workspaceKey: identity.workspaceKey,
      workspaceMode: 'multi' as const,
    }),
    openInBackground: async (node, projectId) => {
      if (options.pauseOn === node.path && !pausedOnce) {
        pausedOnce = true;
        pauseResolve();
        await new Promise<void>((resolve) => {
          releaseRestore = resolve;
        });
      }
      // 与 Provider 完全一致：恢复的后台打开带 reclaimPage
      return op.openNode(node, projectId, { background: true, reclaimPage: true });
    },
    // 与 Provider 完全一致：把"本页面遗留 View 的回收"交给 opener 串行链
    reclaimStaleViews: (tabs) => op.reclaimStaleViews(tabs),
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
    resume: () => releaseRestore(),
    tabOf: (path) => state.tabs.find((item) => item.path === path),
    report: () => restorer.lastReport(),
  };

  try {
    await fn(ctx);
  } finally {
    setPageInstanceForTest(null);
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true });
  }
}

/* ------------------------------ R1.3-01 ------------------------------ */

test('R1.3-01a open-rejected：重开失败的文件，旧 View 仍要被回收', async () => {
  await withRestoreHost(
    async (h) => {
      await writeFile(join(h.rootA, 'ghost.md'), 'GHOST\n', 'utf8');
      const legacy = await h.legacyViews(['a.md', 'ghost.md']);
      // 刷新后 ghost.md 被外部删除：资源表里没有它、也没有层表 → 恢复只能交 Host 裁决
      await unlink(join(h.rootA, 'ghost.md'));

      const report = await h.restorer.restore();
      assert.equal(report.status, 'restored');
      assert.equal(report.tabsRestored, 1, 'a.md 必须恢复成功');
      assert.equal(report.skipped[0]?.reason, 'open-rejected', 'ghost.md 的失败原因是 open-rejected');

      // 旧 View 当场回收（不是"等下次刷新"）：否则文件重新出现后再也改不了名
      assert.notEqual(
        (await h.document(legacy['ghost.md'].sessionId, legacy['ghost.md'].viewId)).status,
        200,
        'open-rejected 的旧 View 必须被回收',
      );
      assert.notEqual(
        (await h.document(legacy['a.md'].sessionId, legacy['a.md'].viewId)).status,
        200,
        '重开成功的文件，旧 View 也由 /api/open 的 reclaimPrevious 回收',
      );
      assert.equal(report.reclaim?.closed, 1, '批量回收只处理跳过的那一个');
      assert.equal(report.reclaim?.blocked, 0);
      assert.equal(report.reclaim?.failed, 0);

      // 文件重新出现：没有任何幽灵 View 拦路
      await writeFile(join(h.rootA, 'ghost.md'), 'GHOST-REBORN\n', 'utf8');
      const renamed = await h.rename({
        projectId: PROJ_A,
        sourcePath: 'ghost.md',
        name: 'ghost2.md',
      });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      assert.equal(existsSync(join(h.rootA, 'ghost.md')), false);
    },
    { tabs: ['a.md', 'ghost.md'] },
  );
});

test('R1.3-01b file-missing：树里没有的文件，旧 View 也回收，回来后不被阻塞', async () => {
  await withRestoreHost(
    async (h) => {
      await writeFile(join(h.rootA, 'lost.md'), 'LOST-CONTENT\n', 'utf8');
      const legacy = await h.legacyViews(['a.md', 'lost.md']);
      // 文件消失（U 盘拔掉 / 同步删除），资源表与层表都反映"根层已完整枚举且没有它"
      await unlink(join(h.rootA, 'lost.md'));

      const report = await h.restorer.restore();
      assert.equal(report.status, 'restored');
      assert.equal(report.skipped[0]?.reason, 'file-missing');
      assert.notEqual(
        (await h.document(legacy['lost.md'].sessionId, legacy['lost.md'].viewId)).status,
        200,
        'file-missing 的旧 View 必须被回收',
      );
      assert.equal(report.reclaim?.closed, 1);
      assert.equal(report.reclaim?.failed, 0);

      // 文件回来（挂载恢复）：改名不再被"已经没有主人的会话"拦住
      await writeFile(join(h.rootA, 'lost.md'), 'LOST-REBORN\n', 'utf8');
      const renamed = await h.rename({
        projectId: PROJ_A,
        sourcePath: 'lost.md',
        name: 'found.md',
      });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      assert.equal(await readFile(join(h.rootA, 'found.md'), 'utf8'), 'LOST-REBORN\n');
    },
    { tabs: ['a.md', 'lost.md'], resources: ['a.md'], tree: 'root' },
  );
});

test('R1.3-01c project-unavailable：项目恢复可用后，旧 View 不得再拦住改名', async () => {
  await withRestoreHost(
    async (h) => {
      const legacy = await h.legacyViews(['a.md']);

      const report = await h.restorer.restore();
      assert.equal(report.skipped[0]?.reason, 'project-unavailable');
      assert.equal(report.tabsRestored, 0, '不可用项目不得读盘/建会话');
      assert.notEqual(
        (await h.document(legacy['a.md'].sessionId, legacy['a.md'].viewId)).status,
        200,
        '不可用项目的旧 View 仍要回收（View 只存在于 Host 内存，不需要项目 grant）',
      );
      assert.equal(report.reclaim?.closed, 1);

      // 项目恢复可用（重新挂载）：改名不该被上轮的会话拦住
      h.dispatch({
        type: 'SET_PROJECTS',
        projects: [{ projectId: PROJ_A, name: '项目 A', status: 'READY' }],
      });
      const renamed = await h.rename({
        projectId: PROJ_A,
        sourcePath: 'a.md',
        name: 'a-after-recovery.md',
      });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      assert.equal(existsSync(join(h.rootA, 'a-after-recovery.md')), true);
    },
    { tabs: ['a.md'], projectStatus: 'UNAVAILABLE' },
  );
});

test('R1.3-01d unsaved-changes：拒绝关闭时保留 View 与草稿，并如实报告 blocked', async () => {
  await withRestoreHost(
    async (h) => {
      const legacy = await h.legacyViews(['a.md', 'c.md']);
      // c.md 的会话里有**未保存**内容：它必须是最后一个脏视图
      const edited = await h.post('/api/edit', {
        sessionId: legacy['c.md'].sessionId,
        viewId: legacy['c.md'].viewId,
        buffer: 'UNSAVED-DRAFT\n',
      });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));

      const report = await h.restorer.restore();
      assert.equal(report.status, 'restored');
      assert.equal(report.draftsPending, 1, '有未保存内容的标签不自动重开');
      assert.equal(report.skipped[0]?.reason, 'unsaved-changes');

      // 保护优先：View 与正文都还在，关闭被拒这件事被如实计入 blocked
      assert.notEqual(
        (await h.document(legacy['a.md'].sessionId, legacy['a.md'].viewId)).status,
        200,
        'a.md 的旧 View 由 /api/open 的 reclaimPrevious 回收（不计入批量回收）',
      );
      assert.equal(report.reclaim?.closed, 0, '批量回收这一轮没有可关的 View');
      assert.equal(report.reclaim?.blocked, 1, '脏会话的 View 必须记入 blocked');
      assert.equal(report.reclaim?.failed, 0);
      const stillThere = await h.document(legacy['c.md'].sessionId, legacy['c.md'].viewId);
      assert.equal(stillThere.status, 200, '宁可留下悬挂 View，也不能丢未保存内容');
      assert.equal(stillThere.body.document.content, 'UNSAVED-DRAFT\n');
      assert.equal(stillThere.body.document.dirty, true);
      assert.equal(await readFile(join(h.rootA, 'c.md'), 'utf8'), 'c.md CONTENT\n', '磁盘不得被改写');
      // 用户没有放弃草稿之前，这个文件不允许改名（既有保护，不是缺陷）
      const blockedRename = await h.rename({
        projectId: PROJ_A,
        sourcePath: 'c.md',
        name: 'c-renamed.md',
      });
      assert.equal(blockedRename.status, 409, JSON.stringify(blockedRename.body));
      // 失败状态对用户可见：通知里必须说明有未回收的会话
      assert.match(report.notice, /未保存|受保护|保留/);
    },
    { tabs: ['a.md'], unsavedTabs: ['c.md'] },
  );
});

test('R1.3-01e 当前标签持有的新 View 不得被批量回收顺手关掉', async () => {
  await withRestoreHost(
    async (h) => {
      const legacy = await h.legacyViews(['a.md', 'b.md']);

      const report = await h.restorer.restore();
      assert.equal(report.tabsRestored, 1);
      assert.equal(report.skipped[0]?.reason, 'file-missing');
      const tab = h.tabOf('a.md');
      assert.ok(tab?.sessionId && tab.viewId);
      assert.notEqual(tab.viewId, legacy['a.md'].viewId, '恢复必须建立新 View');
      assert.equal(
        (await h.document(tab.sessionId, tab.viewId as string)).status,
        200,
        '当前标签的 View 属于"当前活动"，不得回收',
      );
      assert.notEqual(
        (await h.document(legacy['b.md'].sessionId, legacy['b.md'].viewId)).status,
        200,
        '跳过的文件旧 View 要回收',
      );
      assert.equal(report.reclaim?.closed, 1);
    },
    { tabs: ['a.md', 'b.md'], resources: ['a.md'], tree: 'root' },
  );
});

test('R1.3-01f 其它页面实例的 View 不得回收，且阻塞状态可观察', async () => {
  await withRestoreHost(
    async (h) => {
      // b.md 的旧 View 属于另一个页面（另一台标签页/窗口）
      const other = await h.legacyViews(['b.md'], OTHER_PAGE);
      await h.legacyViews(['a.md']);

      const report = await h.restorer.restore();
      assert.equal(report.skipped[0]?.reason, 'file-missing');
      assert.equal(
        (await h.document(other['b.md'].sessionId, other['b.md'].viewId)).status,
        200,
        '别的页面的 View 不在本页面的回收范围内',
      );
      assert.equal(report.reclaim?.closed, 0, '本页面没有可回收的 View');
      // 它仍然拦着改名（这是正确行为），关掉它之后才放行
      const blockedRename = await h.rename({
        projectId: PROJ_A,
        sourcePath: 'b.md',
        name: 'b-x.md',
      });
      assert.equal(blockedRename.status, 409, JSON.stringify(blockedRename.body));
      const closed = await h.close(other['b.md'].sessionId, other['b.md'].viewId);
      assert.equal(closed.status, 200, JSON.stringify(closed.body));
      const renamed = await h.rename({
        projectId: PROJ_A,
        sourcePath: 'b.md',
        name: 'b-y.md',
      });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    },
    { tabs: ['a.md', 'b.md'], resources: ['a.md'], tree: 'root' },
  );
});

test('R1.3-01g 恢复被接管：pending 与 skipped 在结算前一起回收，活动 View 不动', async () => {
  await withRestoreHost(
    async (h) => {
      await writeFile(join(h.rootA, 'ghost.md'), 'GHOST\n', 'utf8');
      const legacy = await h.legacyViews(['a.md', 'b.md', 'ghost.md']);
      await unlink(join(h.rootA, 'ghost.md'));

      const restoring = h.restorer.restore();
      await h.pauseReached;
      // 用户在恢复途中打开 b.md（它本来在待恢复列表里）：接管
      h.restorer.noteInteraction();
      const opened = await h.op.openNode(h.node('b.md'), PROJ_A);
      assert.equal(opened.ok, true, JSON.stringify(opened));
      h.resume();

      const report = await restoring;
      assert.equal(report.status, 'interrupted');
      assert.equal(report.reason, 'superseded');
      const tabB = h.tabOf('b.md');
      assert.ok(tabB?.sessionId && tabB.viewId);
      assert.equal(
        (await h.document(tabB.sessionId, tabB.viewId as string)).status,
        200,
        '接管打开的新 View 不得被回收',
      );
      assert.notEqual(
        (await h.document(legacy['ghost.md'].sessionId, legacy['ghost.md'].viewId)).status,
        200,
        '从未被重开的文件，其旧 View 必须在结算前回收',
      );
      assert.notEqual(
        (await h.document(legacy['a.md'].sessionId, legacy['a.md'].viewId)).status,
        200,
        '恢复自己处理过的文件，旧 View 已由 open 的 reclaimPrevious 回收',
      );
      // 结转语义不受回收影响
      assert.deepEqual(
        h.restorer.pendingTabs().map((tab) => tab.path),
        ['b.md', 'ghost.md'],
      );
      assert.equal(report.reclaim?.closed, 1, '批量回收只补 ghost.md 那一个');
      assert.equal(report.reclaim?.failed, 0);
    },
    { tabs: ['a.md', 'b.md', 'ghost.md'], pauseOn: 'a.md' },
  );
});

test('R1.3-01h 回收失败（项目已不存在）：不得静默跳过，必须计入 failed 并进提示', async () => {
  await withRestoreHost(
    async (h) => {
      const report = await h.restorer.restore();
      assert.equal(report.status, 'restored');
      assert.equal(report.tabsRestored, 1, '可用的 a.md 照常恢复');
      assert.equal(report.skipped[0]?.reason, 'project-missing');
      // Host 对未知项目返回 404：这次回收"没做成"，必须被计数而不是当成 0
      assert.equal(report.reclaim?.failed, 1, '失败的回收路径数必须如实报告');
      assert.equal(report.reclaim?.closed, 0);
      assert.match(report.notice, /未能回收/, '失败要让用户看见，而不是留到下次改名才发现 409');
      const tab = h.tabOf('a.md');
      assert.ok(tab?.sessionId && tab.viewId);
      assert.equal((await h.document(tab.sessionId, tab.viewId as string)).status, 200);
    },
    { tabs: ['a.md'], foreignTabs: [{ projectId: 'project-ghost', path: 'x.md' }] },
  );
});
