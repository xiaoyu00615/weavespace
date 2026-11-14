/**
 * UX-02B-01：ProjectRuntime 运行期注册、Provider 隔离、权限协调、G-DISK/G-DRAFT 与移除屏障。
 *
 * 取证方式：
 * - HTTP 集成：服务在进程内启动（端口 0），全部断言同时看「状态码 + 响应体错误码 + 真实磁盘」；
 * - 单元：门的判定矩阵用注入的 `projectSessionStats` 打桩，避免为了造 SAVING 状态去改生产代码；
 * - 持久化：`FakeStore` 只模拟**调用顺序**。本轮**没有**真实配置写入/墓碑/崩溃恢复，
 *   因此撤销必须显式 `allowEphemeralRevocation: true` 才会执行（生产托管模式无此入口）。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import {
  createProjectRuntime,
  type ProjectRuntime,
  type ProjectStore,
  type RemoveBlocked,
  type RemoveOutcome,
  type StoredProject,
} from '../../apps/server/src/project-runtime.ts';
import {
  createDocumentService,
  type DocumentService,
  type ProjectSessionStats,
} from '../../packages/document/index.ts';
import { createPermissionService, type PermissionService } from '../../packages/permission/index.ts';
import { createProjectRegistry, type WorkspaceConfig } from '../../packages/project-registry/index.ts';
import { createLocalProvider, type StorageProvider } from '../../packages/storage/index.ts';

interface ApiResponse {
  status: number;
  // 测试内按字段取值，换取断言可读性（不影响生产代码）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/**
 * 只模拟持久化端口的**调用顺序**，不代表持久化安全。
 * `durability: 'memory'` 明确告诉 Runtime：这不是提交点。
 */
class FakeStore implements ProjectStore {
  readonly durability = 'memory' as const;
  calls: string[] = [];
  private projects: StoredProject[];

  constructor(initial: readonly StoredProject[]) {
    this.projects = initial.map((project) => ({ ...project }));
  }

  load(): readonly StoredProject[] {
    return this.projects.map((project) => ({ ...project }));
  }

  async commitAdd(entry: StoredProject & { opId: string }): Promise<void> {
    this.calls.push(`add:${entry.projectId}:${entry.opId}`);
    this.projects.push({ projectId: entry.projectId, name: entry.name, rootDir: entry.rootDir });
  }

  async commitRename(input: { projectId: string; name: string; opId: string }): Promise<void> {
    this.calls.push(`rename:${input.projectId}:${input.name}`);
    this.projects = this.projects.map((project) =>
      project.projectId === input.projectId ? { ...project, name: input.name } : project,
    );
  }

  async commitRevoke(input: { projectId: string; opId: string }): Promise<void> {
    this.calls.push(`revoke:${input.projectId}:${input.opId}`);
    this.projects = this.projects.filter((project) => project.projectId !== input.projectId);
  }
}

/** 取出 abort 的 blockedBy（保持可判别联合的窄化，避免到处强转）。 */
function blockersOf(outcome: RemoveOutcome | RemoveBlocked): readonly string[] {
  return outcome.outcome === 'aborted' ? outcome.blockedBy : [];
}

interface ManagedCtx {
  base: string;
  rootA: string;
  rootB: string;
  server: ShellServer;
  runtime: ProjectRuntime;
  store: FakeStore;
  document: DocumentService;
  permission: PermissionService;
  api(path: string, init?: RequestInit): Promise<ApiResponse>;
  post(path: string, body: unknown): Promise<ApiResponse>;
  open(projectId: string, path: string): Promise<ApiResponse>;
}

interface ManagedOptions {
  providerFactory?: (input: {
    projectId: string;
    providerId: string;
    rootDir: string;
  }) => StorageProvider;
}

async function withManaged(fn: (ctx: ManagedCtx) => Promise<void>, options: ManagedOptions = {}): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux02b01-'));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'only-a.md'), '# only A\n', 'utf8');
  await writeFile(join(rootB, 'a.md'), '# B\n', 'utf8');

  const store = new FakeStore([{ projectId: 'project-a', name: '项目 A', rootDir: rootA }]);
  let runtime: ProjectRuntime | undefined;
  let documentRef: DocumentService | undefined;
  let permissionRef: PermissionService | undefined;

  const server = await createShellServer({
    port: 0,
    managed: {
      create: (deps) => {
        // Host 传进来的就是生产实例：测试直接持有同一引用，避免出现第二套 Document/Permission
        documentRef = deps.document;
        permissionRef = deps.permission;
        runtime = createProjectRuntime({
          ...deps,
          store,
          allowEphemeralRevocation: true,
          ...(options.providerFactory ? { providerFactory: options.providerFactory } : {}),
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
  const post = (path: string, body: unknown): Promise<ApiResponse> =>
    api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const open = (projectId: string, path: string): Promise<ApiResponse> =>
    post('/api/open', { projectId, path });

  assert.ok(runtime, '托管模式必须构造 Runtime');
  const runtimeRef = runtime as ProjectRuntime;
  assert.ok(documentRef);
  assert.ok(permissionRef);
  try {
    await fn({
      base,
      rootA,
      rootB,
      server,
      runtime: runtimeRef,
      store,
      document: documentRef,
      permission: permissionRef,
      api,
      post,
      open,
    });
  } finally {
    await rm(base, { recursive: true, force: true });
    await server.close();
  }
}

test('R-13 静态 Registry 的 version() 仍为 1（不变式）', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-ver-'));
  try {
    const root = join(base, 'p');
    await mkdir(root, { recursive: true });
    const config: WorkspaceConfig = {
      version: 1,
      projects: [{ projectId: 'p1', name: 'P1', rootDir: root }],
    };
    assert.equal(createProjectRegistry({ config }).version(), 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('R-01 运行期添加项目：/api/projects 与 /api/resources 立即可用', async () => {
  await withManaged(async (h) => {
    const before = await h.api('/api/health');
    const keyBefore = before.body.workspaceKey as string;

    const added = await h.runtime.addProject({ name: '项目 B', rootDir: h.rootB });
    assert.equal(added.status, 'READY');

    const list = await h.api('/api/projects');
    const ids = (list.body.projects as { projectId: string }[]).map((p) => p.projectId).sort();
    assert.deepEqual(ids, ['project-a', added.projectId].sort());

    const resources = await h.api(`/api/resources?projectId=${added.projectId}`);
    assert.equal(resources.status, 200);
    assert.equal(JSON.stringify(resources.body.nodes).includes('a.md'), true);

    // 无需重启：workspaceKey 立即变化，且不含绝对路径
    const after = await h.api('/api/health');
    assert.notEqual(after.body.workspaceKey, keyBefore);
    assert.equal(JSON.stringify(after.body).includes(h.base), false);
    assert.equal(h.store.calls.filter((c) => c.startsWith('add:')).length, 1);
  });
});

test('R-02 移除后项目消失且 G-DISK 全部拒绝，磁盘文件不动', async () => {
  await withManaged(async (h) => {
    const removed = await h.runtime.removeProject('project-a');
    assert.equal(removed.outcome, 'revoked');

    const list = await h.api('/api/projects');
    assert.deepEqual(list.body.projects, []);

    const resources = await h.api('/api/resources?projectId=project-a');
    assert.equal(resources.status, 404);

    const opened = await h.open('project-a', 'a.md');
    assert.equal(opened.status, 404);

    assert.equal(existsSync(h.rootA), true, '撤销不得删除项目目录');
    assert.equal(await readFile(join(h.rootA, 'a.md'), 'utf8'), '# A\n');
  });
});

test('R-04 撤销后 read/write grant 立即消失', async () => {
  await withManaged(async (h) => {
    const grantsOfA = () =>
      h.permission.grantsOf(h.server.actorId).filter((grant) => grant.providerId === 'local:project-a');

    assert.deepEqual(
      grantsOfA().map((grant) => grant.action).sort(),
      ['read', 'write'],
      '装载后必须发放 read/write 两条',
    );

    const removed = await h.runtime.removeProject('project-a');
    assert.equal(removed.outcome, 'revoked');

    assert.equal(grantsOfA().length, 0, '撤销必须立即收回授权，不得留到会话回收');
    assert.equal(h.runtime.providerOf('local:project-a'), undefined, 'Provider 必须一并释放');
    assert.equal(h.runtime.stateOf('project-a'), 'REMOVED');
  });
});

test('R-05 移除被拒（有草稿）后状态回 ACTIVE，草稿与版本不变', async () => {
  await withManaged(async (h) => {
    const opened = await h.open('project-a', 'a.md');
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;
    const baseVersion = opened.body.document.baseVersion as string;
    await h.post('/api/edit', { sessionId, viewId, buffer: '# draft\n' });

    const before = await h.api(`/api/document?sessionId=${sessionId}&viewId=${viewId}`);
    const revisionBefore = before.body.document.revision as number;

    const removed = await h.runtime.removeProject('project-a');
    assert.equal(removed.outcome, 'aborted');
    assert.ok(blockersOf(removed).includes('DIRTY'));
    assert.equal(h.runtime.stateOf('project-a'), 'ACTIVE');

    const after = await h.api(`/api/document?sessionId=${sessionId}&viewId=${viewId}`);
    assert.equal(after.body.document.content, '# draft\n');
    assert.equal(after.body.document.revision, revisionBefore);
    assert.equal(after.body.document.baseVersion, baseVersion);
    assert.equal(after.body.document.dirty, true);

    // 取消移除后仍可正常保存（Provider / grant 未被破坏）
    const saved = await h.post('/api/save', { sessionId, viewId, expectedVersion: baseVersion });
    assert.equal(saved.body.status, 'COMMITTED');
  });
});

test('D-A-04 无 View 的干净历史会话不阻止移除', async () => {
  await withManaged(async (h) => {
    const opened = await h.open('project-a', 'a.md');
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;

    const closed = await h.post('/api/close', { sessionId, viewId });
    assert.equal(closed.status, 200, '干净视图应可关闭，Session 保留');

    const removed = await h.runtime.removeProject('project-a');
    assert.equal(removed.outcome, 'revoked', '残留的干净会话不得阻止移除');
    assert.equal(h.runtime.stateOf('project-a'), 'REMOVED');
  });
});

test('D-A-05 存在活动 View 时拒绝移除（409 语义 + 不破坏视图）', async () => {
  await withManaged(async (h) => {
    const opened = await h.open('project-a', 'a.md');
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;

    const removed = await h.runtime.removeProject('project-a');
    assert.equal(removed.outcome, 'aborted');
    assert.deepEqual(blockersOf(removed), ['ACTIVE_VIEWS']);

    const still = await h.api(`/api/document?sessionId=${sessionId}&viewId=${viewId}`);
    assert.equal(still.status, 200);
    assert.equal(h.runtime.stateOf('project-a'), 'ACTIVE');
  });
});

test('D-A-07 有草稿（且视图仍开着）时拒绝移除，blockedBy 含 ACTIVE_VIEWS 与 DIRTY', async () => {
  await withManaged(async (h) => {
    const opened = await h.open('project-a', 'a.md');
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;
    await h.post('/api/edit', { sessionId, viewId, buffer: '# keep me\n' });

    const removed = await h.runtime.removeProject('project-a');
    assert.equal(removed.outcome, 'aborted');
    const blocked = blockersOf(removed);
    assert.ok(blocked.includes('ACTIVE_VIEWS'));
    assert.ok(blocked.includes('DIRTY'));

    const draft = await h.api(`/api/document?sessionId=${sessionId}&viewId=${viewId}`);
    assert.equal(draft.body.document.content, '# keep me\n');
  });
});

test('D-A-06 [UNIT] SAVING / OUTCOME_UNKNOWN / CONFLICT / DIRTY 各自单独阻断移除', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-gate-'));
  try {
    const root = join(base, 'p');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'a.md'), '# A\n', 'utf8');

    const cases: Array<[string, Partial<ProjectSessionStats>]> = [
      ['SAVING', { sessions: 1, dirty: 1, saving: 1 }],
      ['OUTCOME_UNKNOWN', { sessions: 1, dirty: 1, unknown: 1 }],
      ['CONFLICT', { sessions: 1, dirty: 1, conflicted: 1 }],
      ['DIRTY', { sessions: 1, dirty: 1 }],
    ];

    for (const [label, patch] of cases) {
      const stats: ProjectSessionStats = {
        sessions: 0,
        activeViews: 0,
        dirty: 0,
        saving: 0,
        unknown: 0,
        conflicted: 0,
        cleanIdle: 0,
        ...patch,
      };
      const document = {
        projectSessionStats: () => Object.freeze(stats),
        markProjectStale: () => 0,
      } as unknown as DocumentService;
      const permission = createPermissionService([]);
      const store = new FakeStore([{ projectId: 'p', name: 'P', rootDir: root }]);
      const runtime = createProjectRuntime({
        actorId: 'local-user',
        document,
        permission,
        store,
        allowEphemeralRevocation: true,
      });

      const removed = await runtime.removeProject('p');
      assert.equal(removed.outcome, 'aborted', `${label} 必须阻断移除`);
      assert.ok(
        blockersOf(removed).length > 0,
        `${label} 必须给出 blockedBy`,
      );
      assert.equal(runtime.stateOf('p'), 'ACTIVE', `${label}: abort 后必须回 ACTIVE`);
      assert.equal(store.calls.length, 0, `${label}: abort 不得触发持久化`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('D-B-01/UNAVAILABLE 后 G-DRAFT 仍可读回内存草稿', async () => {
  await withManaged(async (h) => {
    const opened = await h.open('project-a', 'a.md');
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;
    await h.post('/api/edit', { sessionId, viewId, buffer: '# my draft\n' });

    await rm(h.rootA, { recursive: true, force: true });

    const draft = await h.api(`/api/document?sessionId=${sessionId}&viewId=${viewId}`);
    assert.equal(draft.status, 200, '草稿在 Host 内存里，不得因磁盘授权失效而拒绝');
    assert.equal(draft.body.document.content, '# my draft\n');
    assert.equal(draft.body.document.dirty, true);
    assert.equal(JSON.stringify(draft.body).includes(h.base), false, '不得回传绝对根路径');
  });
});

test('D-B-02 非 dirty 的视图在项目失效后仍可关闭', async () => {
  await withManaged(async (h) => {
    const opened = await h.open('project-a', 'a.md');
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;

    await rm(h.rootA, { recursive: true, force: true });

    const closed = await h.post('/api/close', { sessionId, viewId });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.status, 'APPLIED');
  });
});

test('D-B-03 dirty 视图在项目失效后仍按既有契约拒关（不静默丢草稿）', async () => {
  await withManaged(async (h) => {
    const opened = await h.open('project-a', 'a.md');
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;
    await h.post('/api/edit', { sessionId, viewId, buffer: '# keep\n' });

    await rm(h.rootA, { recursive: true, force: true });

    const closed = await h.post('/api/close', { sessionId, viewId });
    assert.equal(closed.status, 409);
    assert.equal(closed.body.errorCode, 'ERR_DOCUMENT_DIRTY');

    const draft = await h.api(`/api/document?sessionId=${sessionId}&viewId=${viewId}`);
    assert.equal(draft.body.document.content, '# keep\n');
  });
});

test('D-B-04 项目失效后 G-DISK 仍全部拒绝（草稿可读 ≠ 磁盘可用）', async () => {
  await withManaged(async (h) => {
    const opened = await h.open('project-a', 'a.md');
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;
    const baseVersion = opened.body.document.baseVersion as string;

    await rm(h.rootA, { recursive: true, force: true });

    const resources = await h.api('/api/resources?projectId=project-a');
    assert.ok(resources.status === 503, `实际 ${resources.status}`);

    const saved = await h.post('/api/save', { sessionId, viewId, expectedVersion: baseVersion });
    assert.ok(saved.status === 503 || saved.status === 202, `实际 ${saved.status}`);
    assert.equal(existsSync(h.rootA), false, '不得重建项目根');
  });
});

test('D-B-05 伪造 viewId 不能读草稿（G-DRAFT 仍绑定会话与视图）', async () => {
  await withManaged(async (h) => {
    const opened = await h.open('project-a', 'a.md');
    const sessionId = opened.body.document.sessionId as string;

    const forged = await h.api(`/api/document?sessionId=${sessionId}&viewId=view-forged`);
    assert.equal(forged.status, 403);
    assert.equal(forged.body.errorCode, 'ERR_PERMISSION_DENIED');
  });
});

test('D-C-01 屏障期间新的 open/edit/save 一律 409，且不产生磁盘写入', async () => {
  await withManaged(async (h) => {
    const opened = await h.open('project-a', 'a.md');
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;
    const baseVersion = opened.body.document.baseVersion as string;
    await h.post('/api/edit', { sessionId, viewId, buffer: '# draft\n' });

    h.runtime.beginQuiesce('project-a');
    try {
      const opened2 = await h.open('project-a', 'docs/only-a.md');
      assert.equal(opened2.status, 409);
      assert.equal(opened2.body.errorCode, 'ERR_PROJECT_QUIESCING');

      const edited = await h.post('/api/edit', { sessionId, viewId, buffer: '# edited during barrier\n' });
      assert.equal(edited.status, 409);
      assert.equal(edited.body.errorCode, 'ERR_PROJECT_QUIESCING');

      const saved = await h.post('/api/save', { sessionId, viewId, expectedVersion: baseVersion });
      assert.equal(saved.status, 409);
      assert.equal(saved.body.errorCode, 'ERR_PROJECT_QUIESCING');

      // 磁盘完全没有被写过（仍是打开时的内容）
      assert.equal(await readFile(join(h.rootA, 'a.md'), 'utf8'), '# A\n');
    } finally {
      h.runtime.endQuiesce('project-a');
    }

    // 屏障解除后恢复正常
    const reopened = await h.open('project-a', 'docs/only-a.md');
    assert.equal(reopened.status, 200);
  });
});

test('D-C-02 屏障期间草稿读取与关闭视图不受影响', async () => {
  await withManaged(async (h) => {
    const opened = await h.open('project-a', 'a.md');
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;

    h.runtime.beginQuiesce('project-a');
    const draft = await h.api(`/api/document?sessionId=${sessionId}&viewId=${viewId}`);
    assert.equal(draft.status, 200);

    const closed = await h.post('/api/close', { sessionId, viewId });
    assert.equal(closed.status, 200);
    h.runtime.endQuiesce('project-a');
  });
});

test('X-01 跨项目同名文件不混淆身份与授权', async () => {
  await withManaged(async (h) => {
    const b = await h.runtime.addProject({ name: '项目 B', rootDir: h.rootB });
    const openedA = await h.open('project-a', 'a.md');
    const openedB = await h.open(b.projectId, 'a.md');

    assert.equal(openedA.status, 200);
    assert.equal(openedB.status, 200);
    assert.notEqual(openedA.body.document.resourceId, openedB.body.document.resourceId);
    assert.equal(openedA.body.document.content, '# A\n');
    assert.equal(openedB.body.document.content, '# B\n');
    assert.notEqual(openedA.body.document.sessionId, openedB.body.document.sessionId);
  });
});

test('X-02 撤销 A 不影响 B 的读写', async () => {
  await withManaged(async (h) => {
    const b = await h.runtime.addProject({ name: '项目 B', rootDir: h.rootB });
    const openedB = await h.open(b.projectId, 'a.md');
    const sessionId = openedB.body.document.sessionId as string;
    const viewId = openedB.body.document.viewId as string;

    const removed = await h.runtime.removeProject('project-a');
    assert.equal(removed.outcome, 'revoked');

    const stillRead = await h.api(`/api/document?sessionId=${sessionId}&viewId=${viewId}`);
    assert.equal(stillRead.status, 200);

    const resources = await h.api(`/api/resources?projectId=${b.projectId}`);
    assert.equal(resources.status, 200);
  });
});

test('X-03 已撤销的 projectId 不被复用（同目录重新添加得到新 id）', async () => {
  await withManaged(async (h) => {
    await h.runtime.removeProject('project-a');
    assert.equal(h.runtime.stateOf('project-a'), 'REMOVED');

    const readded = await h.runtime.addProject({ name: 'project-a', rootDir: h.rootA });
    assert.notEqual(readded.projectId, 'project-a');
    assert.equal(h.runtime.stateOf('project-a'), 'REMOVED', '旧 id 的状态不得被覆盖');
    assert.equal(h.runtime.stateOf(readded.projectId), 'ACTIVE');
  });
});

test('X-04 add 拒绝重复根与嵌套根，不产生任何持久化调用', async () => {
  await withManaged(async (h) => {
    const before = h.store.calls.length;

    await assert.rejects(
      () => h.runtime.addProject({ name: 'again', rootDir: h.rootA }),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PROJECT_DUPLICATE_ROOT',
    );
    await assert.rejects(
      () => h.runtime.addProject({ name: 'nested', rootDir: join(h.rootA, 'docs') }),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PROJECT_NESTED_ROOT',
    );
    await assert.rejects(
      () => h.runtime.addProject({ name: 'missing', rootDir: join(h.base, 'nope') }),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PROJECT_CONFIG_INVALID',
    );

    assert.equal(h.store.calls.length, before, '被拒的添加不得触碰 Store');
  });
});

test('X-05 屏障期间晚到的 open 不留下 View（可继续移除）', async () => {
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: (() => void) | undefined;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });

  await withManaged(
    async (h) => {
      const pending = h.open('project-a', 'a.md');
      await enteredPromise; // 确定性信号：Provider.read 已经进入

      h.runtime.beginQuiesce('project-a');
      release?.();

      const late = await pending;
      assert.equal(late.status, 409, '晚到的 open 必须被取消');
      assert.equal(late.body.errorCode, 'ERR_PROJECT_QUIESCING');

      // 关键：不得留下活动 View —— 否则移除会被自己刚取消的 open 挡住
      h.runtime.endQuiesce('project-a');
      const removed = await h.runtime.removeProject('project-a');
      assert.equal(removed.outcome, 'revoked');
    },
    {
      providerFactory: (input) => {
        const inner = createLocalProvider({ rootDir: input.rootDir, providerId: input.providerId });
        return {
          providerId: inner.providerId,
          rootDir: inner.rootDir,
          stat: (path) => inner.stat(path),
          read: async (path) => {
            entered?.();
            await blocked;
            return inner.read(path);
          },
          writeConditional: (path, content, expected) => inner.writeConditional(path, content, expected),
          list: (dir) => inner.list(dir),
        } satisfies StorageProvider;
      },
    },
  );
});

test('X-06 撤销不会删除或移动项目目录内容', async () => {
  await withManaged(async (h) => {
    await h.runtime.removeProject('project-a');
    assert.equal(existsSync(join(h.rootA, 'a.md')), true);
    assert.equal(existsSync(join(h.rootA, 'docs', 'only-a.md')), true);
    assert.deepEqual(h.store.load(), []);
  });
});

test('X-07 重命名只改显示名，身份与 workspaceKey 不变', async () => {
  await withManaged(async (h) => {
    const keyBefore = (await h.api('/api/health')).body.workspaceKey as string;

    const renamed = await h.runtime.renameProject('project-a', '新名字');
    assert.equal(renamed.name, '新名字');
    assert.equal(renamed.projectId, 'project-a');

    const keyAfter = (await h.api('/api/health')).body.workspaceKey as string;
    assert.equal(keyAfter, keyBefore, '重命名不改变工作区身份');

    const list = await h.api('/api/projects');
    const entry = (list.body.projects as { projectId: string; name: string }[]).find(
      (p) => p.projectId === 'project-a',
    );
    assert.equal(entry?.name, '新名字');
  });
});
