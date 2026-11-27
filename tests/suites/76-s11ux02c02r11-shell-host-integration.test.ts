/**
 * UX-02C-02-R1.1：Shell 编排 + 真实 Host 的**真实集成**测试。
 *
 * 这里不单独测 Host 接口，而是驱动真正被 Provider 使用的
 * `createDocumentOpener`（真实 reducer + 真实 live client + 真实 HTTP + 真实磁盘），
 * 复现并锁住 R1-01：
 *
 * 基线缺陷：Host 把"同页 open 同一资源"一律当成页面恢复，于是
 * `refreshCleanTab` 建出来核对磁盘的**临时 View** 一出现，就把当前标签持有的
 * view-1 关掉了；临时 View 随后被释放，标签手里只剩一个死 viewId —— 之后的
 * 编辑、保存、关闭、改名全部失败。
 *
 * 修复后的语义：只有恢复流程（reclaimPage）才申请回收旧 View；普通打开与临时
 * 打开必须保留当前标签的 View。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createLiveClient, setPageInstanceForTest } from '../../apps/shell/src/client/client-api.ts';
import { createDocumentOpener, createEditEpochs } from '../../apps/shell/src/state/open-document.ts';
import type { ResourceNodeState, WorkspaceState } from '../../apps/shell/src/state/types.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import { createProjectRuntime, type ProjectRuntime, type ProjectStore, type StoredProject } from '../../apps/server/src/project-runtime.ts';
import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { inspectProjectRoot } from '../../packages/project-registry/index.ts';
import { createLocalProvider } from '../../packages/storage/index.ts';

const PROJ_A = 'project-a';

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
  assert.equal(inspected.status, 'READY');
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
  state(): WorkspaceState;
  dispatch(action: Parameters<typeof workspaceReducer>[1]): void;
  opener: ReturnType<typeof createDocumentOpener>;
  /** 直接对 Host 发请求（用于校验 View 是否还活着）。 */
  api(path: string, init?: RequestInit): Promise<ApiResponse>;
  post(path: string, body: unknown): Promise<ApiResponse>;
  node: ResourceNodeState;
}

async function withShellHost(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-r11-int-'));
  const rootA = join(base, 'project-a');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await mkdir(join(rootA, 'archive'), { recursive: true });
  await writeFile(join(rootA, 'docs', 'notes.md'), 'NOTES-CONTENT\n', 'utf8');
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');

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

  // 真实的 Shell 侧装配：真实 reducer + 真实 live client
  let state: WorkspaceState = {
    ...INITIAL_STATE,
    mode: 'live',
    workspaceMode: 'multi',
    workspaceKey: 'workspace-key',
    projects: [{ projectId: PROJ_A, name: '项目 A', status: 'READY' }],
    activeProjectId: PROJ_A,
  };
  const dispatch = (action: Parameters<typeof workspaceReducer>[1]): void => {
    state = workspaceReducer(state, action);
  };
  // 集成测试没有 sessionStorage/Web Locks：固定一个页面身份（模拟同一浏览器页面）
  setPageInstanceForTest('integration-page-aaaaaaaa');
  const liveClient = createLiveClient(server.url);
  const opener = createDocumentOpener({
    getState: () => state,
    getMode: () => 'live',
    dispatch,
    clientFor: () => liveClient,
    editEpochs: createEditEpochs(),
  });
  assert.ok(runtimeRef);

  try {
    await fn({
      rootA,
      state: () => state,
      dispatch,
      opener,
      api,
      post,
      node: {
        id: `doc:${PROJ_A}/docs/notes.md`,
        name: 'notes.md',
        kind: 'file',
        extension: 'md',
        path: 'docs/notes.md',
      },
    });
  } finally {
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true });
  }
}

const tabOfState = (state: WorkspaceState) => state.tabs[0];

/* --------------------------------- R1-01 --------------------------------- */

test('集成：再次点击已打开文档（refreshCleanTab）不得让 view-1 失效', async () => {
  await withShellHost(async (h) => {
    const opened = await h.opener.openNode(h.node, PROJ_A);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const tab = tabOfState(h.state());
    assert.ok(tab?.viewId && tab?.sessionId);
    const view1 = tab.viewId as string;
    const sessionId = tab.sessionId as string;

    // 再次点击同一个已打开文档：走 refreshCleanTab（临时 open + 释放临时 View）
    const again = await h.opener.openNode(h.node, PROJ_A);
    assert.equal(again.ok, true, JSON.stringify(again));

    // view-1 必须仍然有效：读、编辑、保存、关闭全部成功
    const read = await h.api(`/api/document?sessionId=${sessionId}&viewId=${view1}`);
    assert.equal(read.status, 200, `view-1 必须仍然有效: ${JSON.stringify(read.body)}`);

    const edited = await h.post('/api/edit', {
      sessionId,
      viewId: view1,
      buffer: 'EDITED VIA VIEW-1\n',
      expectedVersion: undefined,
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));

    const saved = await h.post('/api/save', {
      sessionId,
      viewId: view1,
      expectedVersion: edited.body.document.baseVersion,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(await readFile(join(h.rootA, 'docs', 'notes.md'), 'utf8'), 'EDITED VIA VIEW-1\n');

    const closed = await h.post('/api/close', { sessionId, viewId: view1 });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
  });
});

test('集成：修改磁盘后 refreshOpenTabs，原标签仍可正常编辑保存', async () => {
  await withShellHost(async (h) => {
    const opened = await h.opener.openNode(h.node, PROJ_A);
    assert.equal(opened.ok, true);
    const view1 = tabOfState(h.state()).viewId as string;
    const sessionId = tabOfState(h.state()).sessionId as string;

    // 外部改动磁盘（模拟另一个程序写入）
    await writeFile(join(h.rootA, 'docs', 'notes.md'), 'CHANGED ON DISK\n', 'utf8');
    const report = await h.opener.refreshOpenTabs(PROJ_A);
    assert.equal(report.checked, 1);
    assert.equal(report.updated, 1, JSON.stringify(report));

    // 标签已同步磁盘内容，且 view-1 仍可编辑保存
    assert.equal(tabOfState(h.state()).buffer, 'CHANGED ON DISK\n');
    assert.equal(tabOfState(h.state()).viewId, view1, '刷新不得替换标签的 viewId');
    const edited = await h.post('/api/edit', {
      sessionId,
      viewId: view1,
      buffer: 'AFTER-REFRESH\n',
      expectedVersion: undefined,
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
  });
});

test('集成：恢复流程（reclaimPage）才回收本页旧 View，普通打开不回收', async () => {
  await withShellHost(async (h) => {
    const opened = await h.opener.openNode(h.node, PROJ_A);
    assert.equal(opened.ok, true);
    const view1 = tabOfState(h.state()).viewId as string;
    const sessionId = tabOfState(h.state()).sessionId as string;

    // 普通后台打开（不带 reclaimPage）：只是"已打开"，不新建也不回收
    await h.opener.openNode(h.node, PROJ_A, { background: true });
    assert.equal(
      (await h.api(`/api/document?sessionId=${sessionId}&viewId=${view1}`)).status,
      200,
      '普通后台打开不得关闭 view-1',
    );

    // 页面恢复：清空标签（模拟刷新后进程内状态丢失），带 reclaimPage 重建
    h.state().tabs.length = 0;
    const restored = await h.opener.openNode(h.node, PROJ_A, { background: true, reclaimPage: true });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    const view2 = tabOfState(h.state()).viewId as string;
    assert.notEqual(view2, view1);

    // 恢复后旧 View 被回收，新 View 可用；改名不再被幽灵 View 拦住
    assert.notEqual(
      (await h.api(`/api/document?sessionId=${sessionId}&viewId=${view1}`)).status,
      200,
      '恢复后旧 View 必须被回收',
    );
    assert.equal((await h.api(`/api/document?sessionId=${sessionId}&viewId=${view2}`)).status, 200);
  });
});

test('集成：DIRTY 草稿在刷新/重开后不丢，且继续阻止结构变更', async () => {
  await withShellHost(async (h) => {
    const opened = await h.opener.openNode(h.node, PROJ_A);
    assert.equal(opened.ok, true);
    const docId = tabOfState(h.state()).docId;

    // 用户输入（脏）：走真实 reducer 的编辑路径 + Host 侧同步会话缓冲
    h.opener.noteLocalEdit(docId);
    h.dispatch({ type: 'EDIT_DOC', docId, text: 'UNSAVED DRAFT\n' });
    const tab = tabOfState(h.state());
    assert.equal(tab.dirty, true, '标签必须处于脏状态');
    const edited = await h.post('/api/edit', {
      sessionId: tab.sessionId,
      viewId: tab.viewId,
      buffer: 'UNSAVED DRAFT\n',
      expectedVersion: undefined,
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));

    // 再次点击同一文档：refreshCleanTab 必须跳过（不覆盖草稿）
    await h.opener.openNode(h.node, PROJ_A);
    assert.equal(tabOfState(h.state()).buffer, 'UNSAVED DRAFT\n');

    // 外部改动磁盘 + 刷新：有草稿的标签只报告，不得覆盖
    await writeFile(join(h.rootA, 'docs', 'notes.md'), 'DISK CHANGED\n', 'utf8');
    const report = await h.opener.refreshOpenTabs(PROJ_A);
    assert.equal(report.updated, 0, '有草稿的标签不得被自动覆盖');
    assert.deepEqual(report.dirtyChanged, ['docs/notes.md']);

    // 结构变更必须仍被拦（脏会话 + 活动 View）。锚要先取到，否则这条断言
    // 会被更早的"缺身份预期"挡在 400，测不到屏障本身。
    const treePage = await h.api(`/api/tree?projectId=${PROJ_A}&dir=docs`);
    const anchor = (treePage.body as { anchors?: Record<string, string> }).anchors?.['docs/notes.md'];
    assert.equal(typeof anchor, 'string', '夹具取不到锚');
    const renamed = await h.post('/api/files/rename', {
      projectId: PROJ_A,
      sourcePath: 'docs/notes.md',
      name: 'blocked.md',
      sourceAnchor: anchor,
    });
    assert.equal(renamed.status, 409, JSON.stringify(renamed.body));
    assert.equal(existsSync(join(h.rootA, 'docs', 'notes.md')), true);
  });
});
