/**
 * UX-02C-02-R1：View 生命周期 / 结构变更屏障 / 排他占位归属。
 *
 * 全部在进程内真实 Host（托管 Multi Runtime + 真实 LocalProvider + 真实临时磁盘）
 * 上验证，夹具在受控临时目录内。
 *
 * A. View：同一页面（clientInstanceId）重开同一资源 → 旧 View 释放；不同页面互不影响；
 *    DIRTY 草稿在重开后正文不丢。
 * B. 屏障：结构变更排空期间，普通 withDiskOp 被拒（ERR_PROJECT_BUSY），
 *    withStructureDiskOp 可用且正确计数；屏障外使用结构变更通道被拒。
 * C. 占位归属：占位被外部删除并换成 0 字节文件后，必须拒绝覆盖、外部文件保留、
 *    源文件仍在（不得以 size===0 认定占位归属）。
 */
import assert from 'node:assert/strict';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import {
  createProjectRuntime,
  type ProjectRuntime,
  type ProjectStore,
  type StoredProject,
} from '../../apps/server/src/project-runtime.ts';
import { inspectProjectRoot } from '../../packages/project-registry/index.ts';
import { createLocalProvider, type StorageProvider } from '../../packages/storage/index.ts';

const PROJ_A = 'project-a';
const PROJ_B = 'project-b';

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

interface HarnessOptions {
  faults?: Parameters<typeof createLocalProvider>[0]['faults'];
}

interface Ctx {
  base: string;
  rootA: string;
  rootB: string;
  server: ShellServer;
  runtime: ProjectRuntime;
  token: string;
  api(path: string, init?: RequestInit): Promise<ApiResponse>;
  post(path: string, body: unknown): Promise<ApiResponse>;
  /** 携带页面实例 id 的 open（R1 新增字段）。 */
  open(projectId: string, path: string, clientInstanceId?: string): Promise<ApiResponse>;
  document(sessionId: string, viewId?: string): Promise<ApiResponse>;
  edit(sessionId: string, viewId: string, buffer: string): Promise<ApiResponse>;
  close(sessionId: string, viewId: string): Promise<ApiResponse>;
  rename(body: unknown): Promise<ApiResponse>;
  move(body: unknown): Promise<ApiResponse>;
  tree(projectId: string, dir?: string): Promise<ApiResponse>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
    await sleep(10);
  }
}

async function withHost(fn: (ctx: Ctx) => Promise<void>, options: HarnessOptions = {}): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux02c02r1-'));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await mkdir(join(rootA, 'archive'), { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'notes.md'), 'NOTES-CONTENT\n', 'utf8');
  await writeFile(join(rootB, 'b.md'), '# B\n', 'utf8');

  const store = new FakeStore([
    storedProject(PROJ_A, '项目 A', rootA),
    storedProject(PROJ_B, '项目 B', rootB),
  ]);
  let runtimeRef: ProjectRuntime | undefined;
  const factory = (input: { projectId: string; providerId: string; rootDir: string }): StorageProvider =>
    createLocalProvider({
      rootDir: input.rootDir,
      providerId: input.providerId,
      ...(options.faults ? { faults: options.faults } : {}),
    });

  const server: ShellServer = await createShellServer({
    port: 0,
    managed: {
      create: (deps) => {
        const runtime = createProjectRuntime({
          ...deps,
          store,
          grantSource: 'os-dialog',
          allowEphemeralRevocation: true,
          providerFactory: factory,
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
  assert.notEqual(token, '', '夹具必须拿到 T1 令牌');

  const post = (path: string, body: unknown): Promise<ApiResponse> =>
    api(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ws-token': token,
        // 写请求必须显式同源 Origin
        origin: new URL(server.url).origin,
      },
      body: JSON.stringify(body),
    });

  const ctx: Ctx = {
    base,
    rootA,
    rootB,
    server,
    get runtime() {
      assert.ok(runtimeRef);
      return runtimeRef as ProjectRuntime;
    },
    token,
    api,
    post,
    open: (projectId, path, clientInstanceId) =>
      post('/api/open', {
        projectId,
        path,
        ...(clientInstanceId ? { clientInstanceId } : {}),
      }),
    document: (sessionId, viewId) =>
      api(
        `/api/document?sessionId=${encodeURIComponent(sessionId)}${viewId ? `&viewId=${encodeURIComponent(viewId)}` : ''}`,
      ),
    edit: (sessionId, viewId, buffer) =>
      post('/api/edit', { sessionId, viewId, buffer, expectedVersion: undefined }),
    close: (sessionId, viewId) => post('/api/close', { sessionId, viewId }),
    rename: (body) => post('/api/files/rename', body),
    move: (body) => post('/api/files/move', body),
    tree: (projectId, dir = '') =>
      api(
        `/api/tree?projectId=${encodeURIComponent(projectId)}${dir ? `&dir=${encodeURIComponent(dir)}` : ''}`,
      ),
  };
  try {
    await fn(ctx);
  } finally {
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true });
  }
}

/* ------------------------------ A. View 生命周期 ------------------------------ */

test('A-01 同一页面重开同一文件：新 View 登记后旧 View 被释放，关闭新 View 后可改名', async () => {
  await withHost(async (h) => {
    const first = await h.open(PROJ_A, 'docs/notes.md', 'page-instance-a');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const { viewId: viewId1, sessionId } = first.body.document as { viewId: string; sessionId: string };
    assert.equal((await h.document(sessionId, viewId1)).status, 200, '旧 View 打开时有效');

    // 模拟页面刷新后重新打开：同一个 clientInstanceId
    const second = await h.open(PROJ_A, 'docs/notes.md', 'page-instance-a');
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const viewId2 = second.body.document.viewId as string;
    assert.notEqual(viewId2, viewId1, '必须建立新 View');

    // 旧 View 记录已释放：用旧 viewId 读取被拒
    assert.notEqual(
      (await h.document(sessionId, viewId1)).status,
      200,
      '同页旧 View 必须在成功登记新 View 后被释放',
    );
    // 新 View 仍有效
    assert.equal((await h.document(sessionId, viewId2)).status, 200);

    // 关闭新 View → 结构变更不再被活动 View 拦
    assert.equal((await h.close(sessionId, viewId2)).status, 200);
    const renamed = await h.rename({
      projectId: PROJ_A,
      sourcePath: 'docs/notes.md',
      name: 'renamed.md',
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(existsSync(join(h.rootA, 'docs', 'renamed.md')), true);
    assert.equal(existsSync(join(h.rootA, 'docs', 'notes.md')), false);
  });
});

test('A-02 不同页面的 View 互不影响：重开一页不得关闭另一页', async () => {
  await withHost(async (h) => {
    const pageA = await h.open(PROJ_A, 'docs/notes.md', 'page-instance-a');
    const pageB = await h.open(PROJ_A, 'docs/notes.md', 'page-instance-b');
    assert.equal(pageA.status, 200);
    assert.equal(pageB.status, 200);
    const sessionId = pageA.body.document.sessionId as string;
    const viewB = pageB.body.document.viewId as string;

    // A 页重开：只处理 A 页的旧 View
    const reopened = await h.open(PROJ_A, 'docs/notes.md', 'page-instance-a');
    assert.equal(reopened.status, 200);
    assert.equal((await h.document(sessionId, viewB)).status, 200, 'B 页 View 不得被关闭');

    // B 页仍有活动 View → 结构变更被拦
    const blocked = await h.rename({
      projectId: PROJ_A,
      sourcePath: 'docs/notes.md',
      name: 'blocked.md',
    });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.errorCode, 'ERR_STRUCTURE_SESSION_BUSY');

    // 关掉 B 页与 A 页新 View 之后才允许
    await h.close(sessionId, viewB);
    await h.close(sessionId, reopened.body.document.viewId as string);
    const ok = await h.rename({ projectId: PROJ_A, sourcePath: 'docs/notes.md', name: 'ok.md' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });
});

test('A-03 DIRTY 草稿在重新打开后正文不丢失，且仍然拦住结构变更', async () => {
  await withHost(async (h) => {
    const first = await h.open(PROJ_A, 'docs/notes.md', 'page-instance-a');
    const { viewId, sessionId } = first.body.document as { viewId: string; sessionId: string };
    const edited = await h.edit(sessionId, viewId, 'DIRTY-CONTENT\n');
    assert.equal(edited.status, 200, JSON.stringify(edited.body));

    const second = await h.open(PROJ_A, 'docs/notes.md', 'page-instance-a');
    assert.equal(second.status, 200);
    const viewId2 = second.body.document.viewId as string;
    const read = await h.document(sessionId, viewId2);
    assert.equal(read.status, 200);
    assert.equal(read.body.document.content, 'DIRTY-CONTENT\n', '刷新重开不得丢弃未保存草稿');

    const blocked = await h.rename({
      projectId: PROJ_A,
      sourcePath: 'docs/notes.md',
      name: 'nope.md',
    });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(existsSync(join(h.rootA, 'docs', 'notes.md')), true, '磁盘零变更');
  });
});

/* ------------------------------ B. 结构变更屏障 ------------------------------ */

test('B-01 屏障期间普通磁盘通道被拒，结构变更通道可用，排空后结构变更完成', async () => {
  await withHost(async (h) => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredP = new Promise<void>((resolve) => {
      entered = resolve;
    });

    // 1) 先启动一个在途普通磁盘操作
    const inFlight = h.runtime.withDiskOp(PROJ_A, async () => {
      entered();
      await hold;
      return 'held';
    });
    await enteredP;

    // 2) 开始结构变更：先关门，再排空（不会立即完成）
    // 立即挂一个 catch：断言失败提前退出时，别让在途请求变成未处理拒绝
    const structure = h
      .rename({
        projectId: PROJ_A,
        sourcePath: 'docs/notes.md',
        name: 'moved.md',
      })
      .catch((err: unknown) => ({ status: -1, body: { errorCode: String(err) } }));
    await waitUntil(() => !h.runtime.isAcceptingViews(PROJ_A), '结构变更屏障持有');

    // 3) 屏障期间新的普通磁盘操作必须被拒
    await assert.rejects(
      () => h.runtime.withDiskOp(PROJ_A, async () => 'should-not-run'),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'ERR_PROJECT_BUSY',
      '屏障期间普通 withDiskOp 必须 ERR_PROJECT_BUSY',
    );
    // HTTP 层同样被拒（tree 走 G-DISK）
    const tree = await h.tree(PROJ_A);
    assert.equal(tree.status, 409, JSON.stringify(tree.body));
    assert.equal(tree.body.errorCode, 'ERR_PROJECT_BUSY');

    // 4) 结构变更专用通道在屏障内可以执行（并正确计数后释放）
    assert.equal(
      await h.runtime.withStructureDiskOp(PROJ_A, async () => 'inner'),
      'inner',
      'withStructureDiskOp 在屏障持有期间必须可用',
    );

    // 5) 旧操作结束后结构变更正常完成
    release();
    assert.equal(await inFlight, 'held');
    const res = await structure;
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(existsSync(join(h.rootA, 'docs', 'moved.md')), true);
    assert.equal(existsSync(join(h.rootA, 'docs', 'notes.md')), false);
  });
});

test('B-02 屏障外使用结构变更通道必须被拒', async () => {
  await withHost(async (h) => {
    await assert.rejects(
      () => h.runtime.withStructureDiskOp(PROJ_A, async () => 'nope'),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'ERR_PROJECT_BUSY',
      '没有屏障就不能用结构变更通道绕过 G-DISK',
    );
  });
});

/* ------------------------------ C. 排他占位归属 ------------------------------ */

test('C-01 占位被外部换成 0 字节文件：拒绝覆盖、外部文件保留、源文件仍在', async () => {
  /** 占位目标的绝对路径：钩子只在 rename 请求期间触发，那时它已被赋值。 */
  let targetAbs = '';
  let tampered = false;
  await withHost(
    async (h) => {
      targetAbs = join(h.rootA, 'archive', 'raced.md');
      const res = await h.move({
        projectId: PROJ_A,
        sourcePath: 'docs/notes.md',
        targetParentDir: 'archive',
        name: 'raced.md',
      });

      assert.equal(tampered, true, '注入钩子必须真的执行过（占位已建立后被外部替换）');
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.errorCode, 'ERR_ENTRY_EXISTS');
      // 外部文件必须完整保留（旧实现会以 size===0 认作自己的占位并 unlink）
      assert.equal(existsSync(targetAbs), true, '绝不能删除外部文件');
      assert.equal((await stat(targetAbs)).size, 0);
      // 源文件仍在原位，内容不变
      assert.equal(existsSync(join(h.rootA, 'docs', 'notes.md')), true);
      assert.equal(await readFile(join(h.rootA, 'docs', 'notes.md'), 'utf8'), 'NOTES-CONTENT\n');
    },
    {
      faults: {
        afterMoveReserve: () => {
          // 模拟外部进程：删除本次占位，创建一个同名 0 字节文件
          unlinkSync(targetAbs);
          writeFileSync(targetAbs, '');
          tampered = true;
        },
      },
    },
  );
});
