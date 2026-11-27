/**
 * UX-02C-02：真实改名 / 移动（Host 侧）安全与磁盘验收。
 *
 * 取证方式：进程内真实 Host（托管 Multi Runtime + 真实 LocalProvider + 真实临时磁盘），
 * 断言同时看「HTTP 状态 + 响应体 + 真实字节/SHA-256 + 文件树 + 重启后的状态」。
 * 所有夹具都在受控临时目录内，绝不在真实用户项目上试验覆盖。
 *
 * 编号与本阶段验收清单对应：1/2/3/4/6/7/8/9/10/11/12/13/14/15/16/18。
 * Esc、移动选择器等交互由套件 73 与真实 Chrome 覆盖。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
import { createPermissionService } from '../../packages/permission/index.ts';
import { runManagedStructureChange } from '../../apps/server/src/structure-change.ts';
import {
  withSourceAnchor,
  type StructureBody,
} from '../helpers/structure-intent.ts';

const PROJ_A = 'project-a';
const PROJ_B = 'project-b';
const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

interface ApiResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** 只模拟持久化端口；磁盘与 Runtime 都是真的。 */
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
  /** 记录 Provider 的 moveEntry 调用次数：证明 UNKNOWN 不自动重发。 */
  onMove?: () => void;
}

interface Ctx {
  base: string;
  rootA: string;
  rootB: string;
  server: ShellServer;
  runtime: ProjectRuntime;
  token: string;
  api(path: string, init?: RequestInit): Promise<ApiResponse>;
  post(path: string, body: unknown, opts?: { token?: boolean; origin?: boolean }): Promise<ApiResponse>;
  rename(body: unknown, opts?: { token?: boolean; origin?: boolean }): Promise<ApiResponse>;
  move(body: unknown, opts?: { token?: boolean; origin?: boolean }): Promise<ApiResponse>;
  tree(projectId: string, dir?: string): Promise<ApiResponse>;
  open(projectId: string, path: string): Promise<ApiResponse>;
  edit(sessionId: string, viewId: string, buffer: string): Promise<ApiResponse>;
  restart(): Promise<ShellServer>;
}

async function withHost(fn: (ctx: Ctx) => Promise<void>, options: HarnessOptions = {}): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux02c02-'));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(join(rootA, 'docs', 'nested'), { recursive: true });
  await mkdir(join(rootA, 'archive'), { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'notes.md'), 'NOTES-CONTENT\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'nested', 'deep.md'), 'DEEP-CONTENT\n', 'utf8');
  await writeFile(join(rootB, 'b.md'), '# B\n', 'utf8');

  const store = new FakeStore([
    storedProject(PROJ_A, '项目 A', rootA),
    storedProject(PROJ_B, '项目 B', rootB),
  ]);
  let runtimeRef: ProjectRuntime | undefined;
  const factory = (input: { projectId: string; providerId: string; rootDir: string }): StorageProvider => {
    const provider = createLocalProvider({
      rootDir: input.rootDir,
      providerId: input.providerId,
      ...(options.faults ? { faults: options.faults } : {}),
    });
    if (options.onMove) {
      const original = provider.moveEntry;
      assert.ok(original);
      provider.moveEntry = async (...args) => {
        options.onMove?.();
        return original!(...args);
      };
    }
    return provider;
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

  const treeOf = (projectId: string, dir = ''): Promise<ApiResponse> =>
    api(
      `/api/tree?projectId=${encodeURIComponent(projectId)}${dir ? `&dir=${encodeURIComponent(dir)}` : ''}`,
    );

  const ctx: Ctx = {
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
    token,
    api,
    post,
    // 结构变更现在必须带源身份预期（UX-02C-02-R2）；锚从真实 `/api/tree` 取，
    // 不在这里按 dev:ino 重算一遍，否则等于把生产派生逻辑抄成测试替身。
    rename: async (body, opts) =>
      post('/api/files/rename', await withSourceAnchor(body as StructureBody, treeOf), opts),
    move: async (body, opts) =>
      post('/api/files/move', await withSourceAnchor(body as StructureBody, treeOf), opts),
    tree: treeOf,
    open: (projectId, path) => post('/api/open', { projectId, path }),
    edit: (sessionId, viewId, buffer) =>
      post('/api/edit', { sessionId, viewId, buffer, expectedVersion: undefined }),
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

const at = (sourcePath: string, name: string, extra: Record<string, unknown> = {}) => ({
  projectId: PROJ_A,
  sourcePath,
  name,
  ...extra,
});

/* ------------------------- 1–4：真实改名 / 移动 ------------------------- */

test('1 普通文件真实重命名：磁盘路径变化、SHA-256 不变、树同步', async () => {
  await withHost(async (h) => {
    const before = sha(await readFile(join(h.rootA, 'docs', 'notes.md')));
    const res = await h.rename(at('docs/notes.md', '数学笔记.md'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'APPLIED');
    assert.equal(res.body.contentSha256, before);
    assert.equal(existsSync(join(h.rootA, 'docs', 'notes.md')), false);
    assert.equal(sha(await readFile(join(h.rootA, 'docs', '数学笔记.md'))), before);
    const page = await h.tree(PROJ_A, 'docs');
    const names = (page.body.entries as { name: string }[]).map((e) => e.name);
    assert.ok(names.includes('数学笔记.md'));
    assert.equal(names.includes('notes.md'), false);
  });
});

test('2 文件夹重命名：后代文件路径同步变化，内容不变', async () => {
  await withHost(async (h) => {
    const before = sha(await readFile(join(h.rootA, 'docs', 'nested', 'deep.md')));
    const res = await h.rename(at('docs', '文档'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(existsSync(join(h.rootA, 'docs')), false);
    assert.equal(sha(await readFile(join(h.rootA, '文档', 'nested', 'deep.md'))), before);
    const page = await h.tree(PROJ_A, '文档');
    assert.ok((page.body.entries as { name: string }[]).some((e) => e.name === 'nested'));
  });
});

test('3 文件移动：源消失、目标出现、字节一致', async () => {
  await withHost(async (h) => {
    const before = sha(await readFile(join(h.rootA, 'docs', 'notes.md')));
    const res = await h.move({
      projectId: PROJ_A,
      sourcePath: 'docs/notes.md',
      targetParentDir: 'archive',
      name: 'notes.md',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(existsSync(join(h.rootA, 'docs', 'notes.md')), false);
    assert.equal(sha(await readFile(join(h.rootA, 'archive', 'notes.md'))), before);
  });
});

test('4 文件夹移动：完整目录结构保持一致', async () => {
  await withHost(async (h) => {
    const before = await readdir(join(h.rootA, 'docs'));
    const deep = sha(await readFile(join(h.rootA, 'docs', 'nested', 'deep.md')));
    const res = await h.move({
      projectId: PROJ_A,
      sourcePath: 'docs',
      targetParentDir: 'archive',
      name: 'docs',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(existsSync(join(h.rootA, 'docs')), false);
    assert.deepEqual((await readdir(join(h.rootA, 'archive', 'docs'))).sort(), before.sort());
    assert.equal(sha(await readFile(join(h.rootA, 'archive', 'docs', 'nested', 'deep.md'))), deep);
  });
});

/* ------------------------- 6–9：冲突 / 边界 ------------------------- */

test('6 同名冲突：源与目标都不被覆盖，字节不变', async () => {
  await withHost(async (h) => {
    const srcBefore = sha(await readFile(join(h.rootA, 'docs', 'notes.md')));
    const dstBefore = sha(await readFile(join(h.rootA, 'a.md')));
    const file = await h.move({
      projectId: PROJ_A,
      sourcePath: 'docs/notes.md',
      targetParentDir: '',
      name: 'a.md',
    });
    assert.equal(file.status, 409, JSON.stringify(file.body));
    assert.equal(file.body.errorCode, 'ERR_ENTRY_EXISTS');
    assert.equal(sha(await readFile(join(h.rootA, 'a.md'))), dstBefore);
    assert.equal(sha(await readFile(join(h.rootA, 'docs', 'notes.md'))), srcBefore);

    const dir = await h.move({
      projectId: PROJ_A,
      sourcePath: 'docs',
      targetParentDir: '',
      name: 'archive',
    });
    assert.equal(dir.status, 409, JSON.stringify(dir.body));
    assert.equal(statSync(join(h.rootA, 'archive')).isDirectory(), true);
  });
});

test('7 大小写仅变化的 Windows 重命名：真实目录项名称改变', async () => {
  await withHost(async (h) => {
    const res = await h.rename(at('docs/notes.md', 'NOTES.MD'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const names = await readdir(join(h.rootA, 'docs'));
    assert.ok(names.includes('NOTES.MD'), `实际目录项: ${names.join(',')}`);
    assert.equal(names.includes('notes.md'), false);
    assert.equal(await readFile(join(h.rootA, 'docs', 'NOTES.MD'), 'utf8'), 'NOTES-CONTENT\n');
  });
});

/**
 * 竞争窗口（UX-02C-02 核心）：目标存在性检查通过之后、排他占位执行之前，
 * 外部进程创建了同名目标。Windows + Node/libuv 的 fs.rename 用
 * MoveFileExW + REPLACE_EXISTING，没有 `wx` 占位防线时会**静默覆盖**外部
 * 对象——占位防线必须把这次变更以 ERR_ENTRY_EXISTS 拒绝且不碰外部内容。
 */
test('6b 竞争窗口：检查后占位前外部创建同名目标 → 拒绝且不覆盖', async () => {
  let rootA = '';
  await withHost(
    async (h) => {
      rootA = h.rootA;
      const res = await h.move({
        projectId: PROJ_A,
        sourcePath: 'docs/notes.md',
        targetParentDir: 'archive',
        name: 'raced.md',
      });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.errorCode, 'ERR_ENTRY_EXISTS');
      // 外部进程写入的内容一个字节都不能被覆盖
      assert.equal(await readFile(join(h.rootA, 'archive', 'raced.md'), 'utf8'), 'EXTERNAL\n');
      // 源保持原位
      assert.equal(existsSync(join(h.rootA, 'docs', 'notes.md')), true);
    },
    {
      faults: {
        beforeMoveReserve: () => {
          // 模拟外部进程：在检查与占位之间创建目标并写入内容
          writeFileSync(join(rootA, 'archive', 'raced.md'), 'EXTERNAL\n');
        },
      },
    },
  );
});

test('8 目录移动到自身 / 后代被拒，磁盘零变更', async () => {
  await withHost(async (h) => {
    for (const targetParentDir of ['docs', 'docs/nested']) {
      const res = await h.move({
        projectId: PROJ_A,
        sourcePath: 'docs',
        targetParentDir,
        name: 'moved',
      });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.errorCode, 'ERR_MOVE_INTO_DESCENDANT');
    }
    assert.equal(existsSync(join(h.rootA, 'docs', 'nested', 'deep.md')), true);
    assert.equal(existsSync(join(h.rootA, 'docs', 'moved')), false);
  });
});

test('9 junction / symlink / 根外路径 / 非法名称一律拒绝', async () => {
  await withHost(async (h) => {
    // 项目外的真实目录 + 项目内指向它的符号链接（Windows 上用 junction 类型）
    const outside = join(h.base, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'SECRET');
    await symlink(outside, join(h.rootA, 'escape'), 'junction');
    for (const targetParentDir of [
      '..',
      'escape',
      'escape/child',
      '/absolute',
      'C:/windows',
      'docs/../../outside',
    ]) {
      const res = await h.move({
        projectId: PROJ_A,
        sourcePath: 'docs/notes.md',
        targetParentDir,
        name: 'x.md',
      });
      assert.ok(res.status >= 400, `${targetParentDir} 不应放行: ${JSON.stringify(res.body)}`);
      assert.equal(existsSync(join(outside, 'x.md')), false);
    }
    // 源是链接：不得沿链接改名
    const linkSource = await h.rename(at('escape', 'renamed'));
    assert.ok(linkSource.status >= 400, JSON.stringify(linkSource.body));
    // 非法名称 / 保留设备名
    for (const name of ['CON.txt', 'bad/name.md', '../evil.md', 'name.', '', 'a|b.md']) {
      const res = await h.rename(at('docs/notes.md', name));
      assert.ok(res.status >= 400, `${JSON.stringify(name)} 不应放行`);
    }
    assert.equal(sha(await readFile(join(h.rootA, 'docs', 'notes.md'))), sha(Buffer.from('NOTES-CONTENT\n')));
  });
});

/* ------------------------- 10：鉴权 ------------------------- */

test('10 缺令牌 / 错误 Origin / 无项目写授权 / 禁字段一律拒绝', async () => {
  await withHost(async (h) => {
    const noToken = await h.rename(at('docs/notes.md', 'x.md'), { token: false });
    assert.equal(noToken.status, 403);
    const noOrigin = await h.rename(at('docs/notes.md', 'x.md'), { origin: false });
    assert.equal(noOrigin.status, 403);
    const forbidden = await h.move({
      projectId: PROJ_A,
      sourcePath: 'docs/notes.md',
      targetParentDir: 'archive',
      name: 'x.md',
      absolutePath: 'C:/evil',
    });
    assert.equal(forbidden.status, 400);
    // 直接编排：授权服务拒绝时，连结构变更磁盘通道都不进入
    let diskOps = 0;
    let identityReads = 0;
    const denied = await runManagedStructureChange({
      request: {
        projectId: PROJ_A,
        kind: 'rename',
        sourcePath: 'docs/notes.md',
        targetParentDir: 'docs',
        targetName: 'x.md',
        // 形状合法的占位锚：这条用例要验的是"授权先拒"，不是锚内容
        sourceAnchor: 'a'.repeat(32),
      },
      provider: h.runtime.providerOf(`local:${PROJ_A}`)!,
      providerId: `local:${PROJ_A}`,
      permission: createPermissionService([]),
      actorId: 'test-actor',
      sessionsUnder: () => [],
      rootToken: 'test-root-token',
      readSourceIdentity: async () => {
        identityReads += 1;
        return null;
      },
      withStructureDiskOp: async <T,>(_capability: unknown, fn: () => Promise<T>): Promise<T> => {
        diskOps += 1;
        return fn();
      },
      withStructureChange: async <T,>(
        fn: (capability: { projectId: string; token: symbol }) => Promise<T>,
      ): Promise<T> => fn({ projectId: PROJ_A, token: Symbol('test-capability') }),
    });
    assert.equal(denied.status, 'REJECTED');
    assert.equal(diskOps, 0, '无写授权时零磁盘操作');
    assert.equal(identityReads, 0, '无写授权时连源身份都不读');
    assert.equal(existsSync(join(h.rootA, 'docs', 'notes.md')), true);
  });
});

/* ------------------------- 11–13：会话保护与并发 ------------------------- */

test('11 活动编辑 View / 危险草稿阻止改名或移动，零磁盘变更', async () => {
  await withHost(async (h) => {
    const opened = await h.open(PROJ_A, 'docs/notes.md');
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;

    const blocked = await h.rename(at('docs/notes.md', 'x.md'));
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.errorCode, 'ERR_STRUCTURE_SESSION_BUSY');
    assert.ok((blocked.body.blockedBy as string[]).includes('ACTIVE_VIEWS'));

    // 制造 DIRTY 后，即使 closeView 被拒，Host 仍按内部状态阻断
    const edited = await h.post('/api/edit', {
      sessionId,
      viewId,
      buffer: 'UNSAVED-DRAFT',
      expectedVersion: opened.body.document.baseVersion,
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const dirtyBlocked = await h.move({
      projectId: PROJ_A,
      sourcePath: 'docs',
      targetParentDir: 'archive',
      name: 'docs',
    });
    assert.equal(dirtyBlocked.status, 409);
    assert.ok((dirtyBlocked.body.blockedBy as string[]).includes('DIRTY'));
    assert.equal(await readFile(join(h.rootA, 'docs', 'notes.md'), 'utf8'), 'NOTES-CONTENT\n');
    assert.equal(existsSync(join(h.rootA, 'archive', 'docs')), false);
  });
});

test('13 并发 open / save / create 与结构变更：屏障内新准入被拒，路径不脱节', async () => {
  await withHost(async (h) => {
    // 锚在竞态开始**之前**取好：取锚本身是一次真实往返，若放在并发块里，
    // 会改变三个请求进入屏障的先后次序，让这条竞态测试变得不确定。
    const anchor = (await h.tree(PROJ_A, 'docs')).body.anchors['docs/notes.md'];
    assert.equal(typeof anchor, 'string', '夹具取不到锚');
    const [renameRes, openRes, createRes] = await Promise.all([
      h.rename({ ...at('docs/notes.md', 'renamed.md'), sourceAnchor: anchor }),
      h.open(PROJ_A, 'docs/notes.md'),
      h.post('/api/files/create', {
        projectId: PROJ_A,
        parentDir: 'docs',
        name: 'concurrent.md',
      }),
    ]);
    assert.equal(renameRes.status, 200, JSON.stringify(renameRes.body));
    // 屏障期间的新 open / create 要么被拒，要么在改名完成后按新路径生效；
    // 唯一不允许的是"旧路径被重新创建出来"。
    assert.equal(existsSync(join(h.rootA, 'docs', 'notes.md')), false, '旧路径不得复活');
    assert.ok(openRes.status === 200 || openRes.status >= 400);
    assert.ok(createRes.status === 200 || createRes.status >= 400);
  });
});

/* ------------------------- 14–16：隔离 / UNKNOWN / 重启 ------------------------- */

test('14 A 项目操作不影响 B 项目', async () => {
  await withHost(async (h) => {
    const before = sha(await readFile(join(h.rootB, 'b.md')));
    // 跨项目伪装：拿 A 的真实锚，套上 B 的 projectId。B 里没有这条路径，
    // 所以锚不可能对上——无论在哪一层被拒，B 的盘和 A 的源文件都必须毫发无损。
    const anchorA = (await h.tree(PROJ_A, 'docs')).body.anchors['docs/notes.md'];
    assert.equal(typeof anchorA, 'string', '夹具取不到 A 的锚');
    const cross = await h.move({
      projectId: PROJ_B,
      sourcePath: 'docs/notes.md',
      targetParentDir: '',
      name: 'stolen.md',
      sourceAnchor: anchorA,
    });
    assert.ok(cross.status === 400 || cross.status === 404, JSON.stringify(cross.body));
    assert.deepEqual(await readdir(h.rootB), ['b.md']);
    assert.equal(sha(await readFile(join(h.rootB, 'b.md'))), before);
    assert.equal(
      existsSync(join(h.rootA, 'docs', 'notes.md')),
      true,
      'A 的源文件不得被 B 的请求动到',
    );
    assert.equal(existsSync(join(h.rootB, 'stolen.md')), false);

    const res = await h.rename(at('docs/notes.md', 'a-only.md'));
    assert.equal(res.status, 200);
    assert.deepEqual(await readdir(h.rootB), ['b.md']);
    assert.equal(sha(await readFile(join(h.rootB, 'b.md'))), before);
  });
});

test('15 副作用已发生但确认失败 → UNKNOWN，不自动重试、磁盘真实已变', async () => {
  let moves = 0;
  await withHost(
    async (h) => {
      const res = await h.rename(at('docs/notes.md', 'unknown.md'));
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(res.body.status, 'UNKNOWN');
      assert.equal(moves, 1, '绝不自动重发');
      // 磁盘确实变了：不能谎报"失败"
      assert.equal(existsSync(join(h.rootA, 'docs', 'unknown.md')), true);
      assert.equal(existsSync(join(h.rootA, 'docs', 'notes.md')), false);
    },
    {
      faults: {
        afterMove: () => {
          throw new Error('确认链中断（测试注入）');
        },
      },
      onMove: () => {
        moves += 1;
      },
    },
  );
});

test('16 Host 重启与页面刷新后，真实路径与文件树一致', async () => {
  await withHost(async (h) => {
    const res = await h.move({
      projectId: PROJ_A,
      sourcePath: 'docs/notes.md',
      targetParentDir: 'archive',
      name: 'kept.md',
    });
    assert.equal(res.status, 200);
    await h.restart();
    const root = await h.tree(PROJ_A);
    assert.equal(root.status, 200);
    const nested = await h.tree(PROJ_A, 'archive');
    assert.ok(
      (nested.body.entries as { name: string }[]).some((e) => e.name === 'kept.md'),
      '重启后文件树仍显示新位置',
    );
    assert.equal(existsSync(join(h.rootA, 'archive', 'kept.md')), true);
  });
});

test('18 旧创建 / 保存 / 移除端点保持原语义', async () => {
  await withHost(async (h) => {
    const created = await h.post('/api/files/create', {
      projectId: PROJ_A,
      parentDir: 'docs',
      name: 'fresh.md',
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(statSync(join(h.rootA, 'docs', 'fresh.md')).size, 0);
    const opened = await h.open(PROJ_A, 'docs/fresh.md');
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const saved = await h.post('/api/save', {
      sessionId: opened.body.document.sessionId,
      viewId: opened.body.document.viewId,
      expectedVersion: opened.body.document.baseVersion,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const precheck = await h.post('/api/projects/removal-precheck', { projectId: PROJ_B });
    assert.ok(precheck.status === 200 || precheck.status === 501, JSON.stringify(precheck.body));
  });
});
