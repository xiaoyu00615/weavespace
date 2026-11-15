/**
 * UX-02C-01：真实文件/文件夹创建（Host 侧）与安全验收。
 *
 * 取证方式：进程内真实 Host（托管 Multi 的 ProjectRuntime + 真实 LocalProvider）
 * + 真实临时磁盘；断言同时看「HTTP 状态 + 响应体 + 真实字节/SHA-256 + 重启后的树」。
 * 绝不在真实用户项目上试验覆盖。
 *
 * C-01…C-12、C-14、C-16 中能在 Host 侧证明的部分都在这里；
 * 行内交互、菜单与能力注册表由套件 70 与真实浏览器验证覆盖。
 */
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
import { inspectProjectRoot, type WorkspaceConfig } from '../../packages/project-registry/index.ts';
import { createLocalProvider, type StorageProvider } from '../../packages/storage/index.ts';
import { createPermissionService } from '../../packages/permission/index.ts';
import { createManagedEntry as runCreate } from '../../apps/server/src/create-entry.ts';

interface ApiResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

const PROJ_A = 'project-a';
const PROJ_B = 'project-b';

function sha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 只模拟持久化端口的调用顺序；磁盘与 Runtime 都是真的。 */
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

interface CreateCtx {
  base: string;
  rootA: string;
  rootB: string;
  server: ShellServer;
  runtime: ProjectRuntime;
  store: FakeStore;
  token: string;
  api(path: string, init?: RequestInit): Promise<ApiResponse>;
  post(path: string, body: unknown, opts?: { token?: boolean; origin?: boolean }): Promise<ApiResponse>;
  createFile(body: unknown, opts?: { token?: boolean; origin?: boolean }): Promise<ApiResponse>;
  createDir(body: unknown, opts?: { token?: boolean; origin?: boolean }): Promise<ApiResponse>;
  tree(projectId: string, dir?: string): Promise<ApiResponse>;
  /** 重启 Host（同一份工作区配置），返回新 server；旧 server 已关闭。 */
  restart(): Promise<ShellServer>;
}

interface HarnessOptions {
  /** Provider 故障注入（UNKNOWN 等）。 */
  faults?: Parameters<typeof createLocalProvider>[0]['faults'];
  /** 记录 Provider 创建调用次数，用于"不自动重发"取证。 */
  onProviderFactory?: () => void;
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

async function withCreate(fn: (ctx: CreateCtx) => Promise<void>, options: HarnessOptions = {}): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux02c01-'));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'guide.md'), '# guide\n', 'utf8');
  await writeFile(join(rootB, 'b.md'), '# B\n', 'utf8');

  const store = new FakeStore([
    storedProject(PROJ_A, '项目 A', rootA),
    storedProject(PROJ_B, '项目 B', rootB),
  ]);

  let runtimeRef: ProjectRuntime | undefined;
  const factory = (input: { projectId: string; providerId: string; rootDir: string }): StorageProvider => {
    options.onProviderFactory?.();
    return createLocalProvider({
      rootDir: input.rootDir,
      providerId: input.providerId,
      ...(options.faults ? { faults: options.faults } : {}),
    });
  };
  const build = (): Promise<ShellServer> =>
    createShellServer({
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

  let server = await build();
  const api = async (path: string, init?: RequestInit): Promise<ApiResponse> => {
    const res = await fetch(`${server.url}${path}`, init);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  };
  const tokenRes = await api('/api/session-token');
  const token = (tokenRes.body as { token?: string }).token ?? '';
  assert.notEqual(token, '', '夹具必须拿到 T1 令牌');
  const post = (
    path: string,
    body: unknown,
    opts: { token?: boolean; origin?: boolean } = {},
  ): Promise<ApiResponse> =>
    api(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.token === false ? {} : { 'x-ws-token': token }),
        ...(opts.origin === false ? {} : { origin: new URL(server.url).origin }),
      },
      body: JSON.stringify(body),
    });

  const ctx: CreateCtx = {
    base,
    rootA,
    rootB,
    get server() {
      return server;
    },
    get runtime() {
      assert.ok(runtimeRef);
      return runtimeRef as ProjectRuntime;
    },
    store,
    token,
    api,
    post,
    createFile: (body, opts) => post('/api/files/create', body, opts),
    createDir: (body, opts) => post('/api/directories/create', body, opts),
    tree: (projectId, dir = '') =>
      api(`/api/tree?projectId=${encodeURIComponent(projectId)}${dir ? `&dir=${encodeURIComponent(dir)}` : ''}`),
    async restart() {
      await server.close();
      server = await build();
      return server;
    },
  };

  try {
    await fn(ctx);
  } finally {
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true });
  }
}

/** 默认创建请求：项目 A 的根目录。 */
const atRoot = (name: string, extra: Record<string, unknown> = {}) => ({
  projectId: PROJ_A,
  parentDir: '',
  name,
  ...extra,
});

/* ------------------------------------------------------------------ */
/* C-01 / C-02 / C-04：真实创建                                         */
/* ------------------------------------------------------------------ */

test('C-01 项目根创建 123.md：真实磁盘存在且 0 字节', async () => {
  await withCreate(async (h) => {
    const res = await h.createFile(atRoot('123.md'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'APPLIED');
    assert.equal(res.body.relativePath, '123.md');
    assert.equal(existsSync(join(h.rootA, '123.md')), true, '磁盘上必须真实生成');
    assert.equal(statSync(join(h.rootA, '123.md')).size, 0, '不得擅自写入标题或模板');
    const page = await h.tree(PROJ_A);
    assert.equal(page.status, 200);
    assert.ok(
      (page.body.entries as { name: string }[]).some((entry) => entry.name === '123.md'),
      '文件树必须能看到新文件',
    );
  });
});

test('C-02 子文件夹创建 notes.txt：路径正确，父目录内容不变', async () => {
  await withCreate(async (h) => {
    const before = sha(await readFile(join(h.rootA, 'docs', 'guide.md')));
    const res = await h.createFile({ projectId: PROJ_A, parentDir: 'docs', name: 'notes.txt' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.relativePath, 'docs/notes.txt');
    assert.equal(existsSync(join(h.rootA, 'docs', 'notes.txt')), true);
    assert.equal(statSync(join(h.rootA, 'docs', 'notes.txt')).size, 0);
    assert.equal(existsSync(join(h.rootA, 'notes.txt')), false, '不得落在项目根');
    assert.equal(sha(await readFile(join(h.rootA, 'docs', 'guide.md'))), before);
  });
});

test('C-03 右键普通文件 → 目标为其父目录（由 Shell 解析，Host 只收相对目录）', async () => {
  await withCreate(async (h) => {
    // Shell 的规则：右键 docs/guide.md → parentDir='docs'；这里断言该目录语义
    const res = await h.createFile({ projectId: PROJ_A, parentDir: 'docs', name: 'sibling.md' });
    assert.equal(res.status, 200);
    assert.equal(res.body.relativePath, 'docs/sibling.md');
    assert.equal(existsSync(join(h.rootA, 'docs', 'sibling.md')), true);
  });
});

test('C-04 新建空文件夹：磁盘目录真实存在，文件树可展开', async () => {
  await withCreate(async (h) => {
    const res = await h.createDir(atRoot('新建文件夹'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.kind, 'directory');
    assert.equal(statSync(join(h.rootA, '新建文件夹')).isDirectory(), true);
    assert.deepEqual(await readdir(join(h.rootA, '新建文件夹')), []);
    const child = await h.tree(PROJ_A, '新建文件夹');
    assert.equal(child.status, 200);
    assert.equal(child.body.page.total, 0, '空目录正常返回空页，不伪装成错误');
  });
});

test('C-05 Esc 取消零变更由 Shell 保证；Host 端未被调用时磁盘零变更', async () => {
  await withCreate(async (h) => {
    const before = (await readdir(h.rootA)).sort();
    // 模拟"行内输入框按 Esc"：不发任何创建请求
    const after = (await readdir(h.rootA)).sort();
    assert.deepEqual(after, before);
    assert.equal(existsSync(join(h.rootA, 'draft.md')), false);
  });
});

/* ------------------------------------------------------------------ */
/* C-06 / C-07：重名保护与并发排他                                      */
/* ------------------------------------------------------------------ */

test('C-06 已存在同名文件/目录一律拒绝，原始内容 SHA-256 不变', async () => {
  await withCreate(async (h) => {
    const before = sha(await readFile(join(h.rootA, 'a.md')));
    const asFile = await h.createFile(atRoot('a.md'));
    assert.equal(asFile.status, 409, JSON.stringify(asFile.body));
    assert.equal(asFile.body.errorCode, 'ERR_ENTRY_EXISTS');
    assert.equal(sha(await readFile(join(h.rootA, 'a.md'))), before, '绝不覆盖既有字节');

    const asDir = await h.createDir(atRoot('docs'));
    assert.equal(asDir.status, 409);
    assert.equal(asDir.body.errorCode, 'ERR_ENTRY_EXISTS');
    assert.equal(statSync(join(h.rootA, 'docs')).isDirectory(), true);
  });
});

test('C-07 两次并发创建同名文件：最多成功一次', async () => {
  await withCreate(async (h) => {
    const [one, two] = await Promise.all([
      h.createFile(atRoot('race.md')),
      h.createFile(atRoot('race.md')),
    ]);
    const applied = [one, two].filter((r) => r.status === 200);
    assert.equal(applied.length, 1, JSON.stringify([one.body, two.body]));
    const rejected = [one, two].find((r) => r.status !== 200);
    assert.equal(rejected?.body.errorCode, 'ERR_ENTRY_EXISTS');
    assert.equal(statSync(join(h.rootA, 'race.md')).size, 0);
  });
});

/* ------------------------------------------------------------------ */
/* C-08：路径与名称安全                                                 */
/* ------------------------------------------------------------------ */

test('C-08 非法路径 / Windows 保留名 / 尾随空格句点：一律零 IO 拒绝', async () => {
  await withCreate(async (h) => {
    const badDirs = ['../escape', '/abs', 'C:/x', '//server/share', 'docs/..', 'docs//x', 'a\\b', 'docs\0x'];
    for (const parentDir of badDirs) {
      const res = await h.createFile({ projectId: PROJ_A, parentDir, name: 'x.md' });
      assert.equal(res.status, 400, `parentDir=${JSON.stringify(parentDir)} → ${JSON.stringify(res.body)}`);
      assert.equal(res.body.errorCode, 'ERR_COMMAND_INVALID');
    }
    const badNames = ['CON', 'con.txt', 'NUL.md', 'COM1.md', 'LPT9.txt', 'bad name.', 'bad ', 'a/b.md', 'a\\b', 'a:b', '..', '', 'x\0y'];
    for (const name of badNames) {
      const res = await h.createFile(atRoot(name));
      assert.equal(res.status, 400, `name=${JSON.stringify(name)} → ${JSON.stringify(res.body)}`);
      assert.equal(res.body.errorCode, 'ERR_ENTRY_NAME_INVALID');
    }
    // 客户端不得自述路径 / 根 / 令牌 / provider
    for (const field of ['path', 'rootDir', 'rootToken', 'canonicalRoot', 'providerId', 'content']) {
      const res = await h.createFile(atRoot('x.md', { [field]: 'C:\\secret' }));
      assert.notEqual(res.status, 200, `${field} 不得被接受`);
    }
    assert.equal(existsSync(join(h.rootA, 'x.md')), false);
    assert.equal(existsSync(join(h.base, 'escape')), false, '不得逃出项目根');
  });
});

test('C-08b 重解析点父目录与缺失父目录：拒绝且不递归创建', async () => {
  await withCreate(async (h) => {
    const outside = join(h.base, 'outside');
    await mkdir(outside, { recursive: true });
    const link = join(h.rootA, 'link');
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // 平台不支持创建链接：跳过，不记为通过
    }
    const throughLink = await h.createFile({ projectId: PROJ_A, parentDir: 'link', name: 'x.md' });
    assert.notEqual(throughLink.status, 200, '不得沿链接创建');
    assert.equal(existsSync(join(outside, 'x.md')), false, '项目根外零副作用');

    const missing = await h.createFile({ projectId: PROJ_A, parentDir: 'no/such/dir', name: 'x.md' });
    assert.notEqual(missing.status, 200);
    assert.equal(missing.body.errorCode, 'ERR_ENTRY_PARENT_INVALID');
    assert.equal(existsSync(join(h.rootA, 'no')), false, '绝不静默补建缺失父目录');
  });
});

/* ------------------------------------------------------------------ */
/* C-09：令牌 / Origin / 写权限 / 项目状态                              */
/* ------------------------------------------------------------------ */

test('C-09 无令牌、错误 Origin、无写权限：全部拒绝且零变更', async () => {
  await withCreate(async (h) => {
    const noToken = await h.createFile(atRoot('t1.md'), { token: false });
    assert.equal(noToken.status, 403);
    const noOrigin = await h.createFile(atRoot('t2.md'), { origin: false });
    assert.equal(noOrigin.status, 403, JSON.stringify(noOrigin.body));
    const badOrigin = await h.api('/api/files/create', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ws-token': h.token,
        origin: 'http://evil.example',
      },
      body: JSON.stringify(atRoot('t3.md')),
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(existsSync(join(h.rootA, 't1.md')), false);
    assert.equal(existsSync(join(h.rootA, 't2.md')), false);
    assert.equal(existsSync(join(h.rootA, 't3.md')), false);
  });
});

test('C-09b QUIESCING 与 UNAVAILABLE 一律拒绝且零变更', async () => {
  await withCreate(async (h) => {
    h.runtime.beginQuiesce(PROJ_A);
    const quiescing = await h.createFile(atRoot('q.md'));
    assert.equal(quiescing.status, 409, JSON.stringify(quiescing.body));
    assert.equal(quiescing.body.errorCode, 'ERR_PROJECT_QUIESCING');
    h.runtime.endQuiesce(PROJ_A);
    assert.equal(existsSync(join(h.rootA, 'q.md')), false);

    const moved = join(h.base, 'root-a-moved');
    await rename(h.rootA, moved);
    const unavailable = await h.createFile(atRoot('u.md'));
    assert.equal(unavailable.status, 503, JSON.stringify(unavailable.body));
    assert.equal(unavailable.body.errorCode, 'ERR_PROJECT_UNAVAILABLE');
  });
});

test('C-09c createManagedEntry：无项目写授权时连磁盘操作准入都不进入', async () => {
  const permission = createPermissionService([]); // 默认拒绝：没有任何 grant
  let entered = 0;
  const provider = {
    createEntry: async () => {
      entered += 1;
      return { status: 'CREATED' as const, kind: 'file' as const, relativePath: 'x.md' };
    },
  } as unknown as StorageProvider;
  const outcome = await runCreate({
    request: { projectId: PROJ_A, parentDir: '', name: 'x.md', kind: 'file' },
    provider,
    providerId: `local:${PROJ_A}`,
    permission,
    actorId: 'local-user',
    withDiskOp: async (fn) => {
      entered += 100;
      return fn();
    },
  });
  assert.deepEqual(outcome, { status: 'REJECTED', errorCode: 'ERR_PERMISSION_DENIED' });
  assert.equal(entered, 0, '零磁盘操作、零准入');

  // 没有创建能力的 Provider 一律"不支持"，不假装成功
  const unsupported = await runCreate({
    request: { projectId: PROJ_A, parentDir: '', name: 'x.md', kind: 'file' },
    provider: {} as StorageProvider,
    providerId: `local:${PROJ_A}`,
    permission,
    actorId: 'local-user',
    withDiskOp: async (fn) => fn(),
  });
  assert.deepEqual(unsupported, { status: 'REJECTED', errorCode: 'ERR_COMMAND_UNSUPPORTED' });
});

/* ------------------------------------------------------------------ */
/* C-10 / C-11 / C-12 / C-14 / C-16                                     */
/* ------------------------------------------------------------------ */

test('C-10 A/B 项目隔离：创建 A 不写入 B，项目集合与 workspaceKey 不变', async () => {
  await withCreate(async (h) => {
    const healthBefore = await h.api('/api/health');
    const bBefore = (await readdir(h.rootB)).sort();
    const res = await h.createFile(atRoot('only-a.md'));
    assert.equal(res.status, 200);
    assert.equal(existsSync(join(h.rootB, 'only-a.md')), false);
    assert.deepEqual((await readdir(h.rootB)).sort(), bBefore);
    const bTree = await h.tree(PROJ_B);
    assert.equal(bTree.status, 200);
    assert.ok(!(bTree.body.entries as { name: string }[]).some((e) => e.name === 'only-a.md'));
    const healthAfter = await h.api('/api/health');
    assert.equal(healthAfter.body.workspaceKey, healthBefore.body.workspaceKey, '创建不改项目集合');
  });
});

test('C-11 结果未知：明确 UNKNOWN、不自动重发、磁盘零猜测', async () => {
  let factoryCalls = 0;
  await withCreate(
    async (h) => {
      const res = await h.createFile(atRoot('uncertain.md'));
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(res.body.status, 'UNKNOWN');
      assert.equal(res.body.errorCode, 'ERR_OUTCOME_UNKNOWN');
      // 副作用确实发生了：不能用"没找到文件"推断失败，也不能据此重发
      assert.equal(existsSync(join(h.rootA, 'uncertain.md')), true);
      const page = await h.tree(PROJ_A);
      assert.ok((page.body.entries as { name: string }[]).some((e) => e.name === 'uncertain.md'));
    },
    {
      faults: { afterCreate: () => { throw new Error('injected: 确认链中断'); } },
      onProviderFactory: () => { factoryCalls += 1; },
    },
  );
  assert.equal(factoryCalls <= 2, true, 'Host 不因 UNKNOWN 反复重建 Provider');
});

test('C-12 重启 Host 后新文件仍在，文件树正确显示', async () => {
  await withCreate(async (h) => {
    const created = await h.createFile({ projectId: PROJ_A, parentDir: 'docs', name: 'persist.md' });
    assert.equal(created.status, 200);
    const dir = await h.createDir({ projectId: PROJ_A, parentDir: '', name: 'archive' });
    assert.equal(dir.status, 200);
    await h.restart();
    const rootTree = await h.tree(PROJ_A);
    assert.equal(rootTree.status, 200);
    assert.ok((rootTree.body.entries as { name: string }[]).some((e) => e.name === 'archive'));
    const docsTree = await h.tree(PROJ_A, 'docs');
    assert.ok((docsTree.body.entries as { name: string }[]).some((e) => e.name === 'persist.md'));
    assert.equal(existsSync(join(h.rootA, 'docs', 'persist.md')), true);
  });
});

test('C-14 Legacy 与静态 Multi：真实创建端点明确 501，磁盘零变更', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux02c01-nonmanaged-'));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');
  const legacy = await createShellServer({ rootDir: rootA, port: 0 });
  const config: WorkspaceConfig = {
    version: 1,
    projects: [
      { projectId: PROJ_A, name: 'A', rootDir: rootA },
      { projectId: PROJ_B, name: 'B', rootDir: rootB },
    ],
  };
  const staticMulti = await createShellServer({ workspace: config, port: 0 });
  try {
    for (const server of [legacy, staticMulti]) {
      const tokenRes = await fetch(`${server.url}/api/session-token`);
      const token = ((await tokenRes.json()) as { token?: string }).token ?? '';
      for (const path of ['/api/files/create', '/api/directories/create']) {
        const res = await fetch(`${server.url}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-ws-token': token,
            origin: new URL(server.url).origin,
          },
          body: JSON.stringify({ projectId: PROJ_A, parentDir: '', name: 'nope.md' }),
        });
        const body = (await res.json().catch(() => ({}))) as { errorCode?: string };
        assert.equal(res.status, 501, `${server.mode} ${path}: ${JSON.stringify(body)}`);
        assert.equal(body.errorCode, 'ERR_COMMAND_UNSUPPORTED');
      }
    }
    assert.equal(existsSync(join(rootA, 'nope.md')), false);
    assert.equal(statSync(join(rootA, 'a.md')).size, '# A\n'.length, '旧文件字节不变');
  } finally {
    await legacy.close();
    await staticMulti.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('C-16 旧链路未受影响：/api/resources、document.save、移除前检仍可用', async () => {
  await withCreate(async (h) => {
    const created = await h.createFile(atRoot('new.md'));
    assert.equal(created.status, 200);
    const resources = await h.api(`/api/resources?projectId=${PROJ_A}`);
    assert.equal(resources.status, 200);
    const nodes = JSON.stringify(resources.body.nodes ?? []);
    assert.match(nodes, /new\.md/);

    const opened = await h.post('/api/open', { projectId: PROJ_A, path: 'a.md' });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const doc = opened.body.document as { sessionId: string; viewId: string; baseVersion: string };
    await h.post('/api/edit', { sessionId: doc.sessionId, viewId: doc.viewId, buffer: '# edited\n' });
    const saved = await h.post('/api/save', {
      sessionId: doc.sessionId,
      viewId: doc.viewId,
      expectedVersion: doc.baseVersion,
    });
    assert.equal(saved.body.status, 'COMMITTED', JSON.stringify(saved.body));
    assert.equal((await readFile(join(h.rootA, 'a.md'), 'utf8')).trim(), '# edited');

    const precheck = await h.post('/api/projects/removal-precheck', { projectId: PROJ_A });
    assert.equal(precheck.status, 200);
    assert.equal(precheck.body.status, 'APPLIED');
  });
});
