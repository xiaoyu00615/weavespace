/**
 * UX-02B-01-R1：五处确定性边界问题的定向红/绿测试。
 *
 * 覆盖范围（每一组都刻意只测一条不变式）：
 * 1. `commitRevoke` 抛错后的移除状态：**确认未写入** 才可回 ACTIVE，**结果不确定** 必须
 *    进入 `REVOKE_UNKNOWN` 并 fail-closed（不恢复授权、不释放屏障、不允许再次撤销）；
 * 2. `UNAVAILABLE` 项目仍**占用**其注册时的根身份，不能在同一路径/父目录/子目录下再注册；
 * 3. 托管模式的 `workspaceKey` 必须**按请求重算**，根消失/被替换后不得继续返回旧的 READY 摘要；
 * 4. 由显示名派生的 `projectId` 必须在加序号后仍满足 `^[a-z0-9][a-z0-9_-]{0,31}$`；
 * 5. Legacy 的 `GET /api/document` 仍然走原有读取授权；Multi 的 G-DRAFT 只认
 *    actor + session + viewId，不因项目 grant 被拒而无法取回草稿。
 *
 * 关于持久化：本轮仍然只有 fake Store。`ScriptedStore` 只模拟**提交点失败的分类**
 * （未写入 / 不确定），不代表任何真实的配置写入、墓碑或崩溃恢复能力。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import {
  createDocumentService,
  type DocumentService,
} from '../../packages/document/index.ts';
import { createPermissionService, type PermissionService } from '../../packages/permission/index.ts';
import { validateWorkspaceConfig } from '../../packages/project-registry/index.ts';

interface ApiResponse {
  status: number;
  // 测试内按字段取值，换取断言可读性（不影响生产代码）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** 提交点失败的三种注入形态；`unclassified` 表示"实现方没有说明"，必须按不确定处理。 */
type RevokeFault = 'not-committed' | 'unknown' | 'unclassified';

/**
 * 只模拟持久化端口的调用顺序与**失败分类**，不代表持久化安全。
 * `durability: 'memory'` 明确告诉 Runtime：这不是真实提交点。
 */
class ScriptedStore implements ProjectStore {
  readonly durability = 'memory' as const;
  calls: string[] = [];
  failNextRevoke: RevokeFault | undefined;
  private projects: StoredProject[];

  constructor(initial: readonly StoredProject[]) {
    this.projects = initial.map((project) => ({ ...project }));
  }

  load(): readonly StoredProject[] {
    return this.projects.map((project) => ({ ...project }));
  }

  revokeAttempts(): number {
    return this.calls.filter((call) => call.startsWith('revoke:')).length;
  }

  async commitAdd(entry: StoredProject & { opId: string }): Promise<void> {
    this.calls.push(`add:${entry.projectId}`);
    this.projects.push({ projectId: entry.projectId, name: entry.name, rootDir: entry.rootDir });
  }

  async commitRename(input: { projectId: string; name: string; opId: string }): Promise<void> {
    this.calls.push(`rename:${input.projectId}`);
    this.projects = this.projects.map((project) =>
      project.projectId === input.projectId ? { ...project, name: input.name } : project,
    );
  }

  async commitRevoke(input: { projectId: string; opId: string }): Promise<void> {
    this.calls.push(`revoke:${input.projectId}:${input.opId}`);
    const fault = this.failNextRevoke;
    this.failNextRevoke = undefined;
    if (fault === 'not-committed') {
      // 打开失败 / 写入 0 字节：可以断言"没有落盘"
      throw Object.assign(new Error('撤销写入失败（确认未写入）'), { commitState: 'not-committed' });
    }
    if (fault === 'unknown') {
      throw Object.assign(new Error('撤销写入结果不确定（fsync 报错）'), { commitState: 'unknown' });
    }
    if (fault === 'unclassified') {
      throw new Error('撤销写入失败（未声明提交结果）');
    }
    this.projects = this.projects.filter((project) => project.projectId !== input.projectId);
  }
}

/** 只包裹内置授权表的测试观察层：生产代码仍然自己构造授权表。 */
function wrappingPermission(inner: PermissionService): {
  service: PermissionService;
  denyReads(value: boolean): void;
} {
  let deny = false;
  return {
    service: {
      authorize: (request) =>
        deny && request.action === 'read'
          ? { allowed: false, errorCode: 'ERR_PERMISSION_DENIED', reason: '测试：拒绝所有读取' }
          : inner.authorize(request),
      grant: (entry) => inner.grant(entry),
      revoke: (entry) => inner.revoke(entry),
      grantsOf: (actorId) => inner.grantsOf(actorId),
    },
    denyReads(value: boolean) {
      deny = value;
    },
  };
}

interface ManagedCtx {
  base: string;
  rootA: string;
  server: ShellServer;
  runtime: ProjectRuntime;
  store: ScriptedStore;
  document: DocumentService;
  permission: PermissionService;
  api(path: string, init?: RequestInit): Promise<ApiResponse>;
  post(path: string, body: unknown): Promise<ApiResponse>;
  open(projectId: string, path: string): Promise<ApiResponse>;
}

interface ManagedOptions {
  store?: ScriptedStore;
  permissionWrapper?: (inner: PermissionService) => PermissionService;
}

async function withManaged(fn: (ctx: ManagedCtx) => Promise<void>, options: ManagedOptions = {}): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux02b01r1-'));
  const rootA = join(base, 'project-a');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  for (const name of ['project-b', 'project-c', 'project-d']) {
    await mkdir(join(base, name), { recursive: true });
    await writeFile(join(base, name, 'a.md'), `# ${name}\n`, 'utf8');
  }
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');

  const store = options.store ?? new ScriptedStore([{ projectId: 'project-a', name: '项目 A', rootDir: rootA }]);
  let runtime: ProjectRuntime | undefined;
  let documentRef: DocumentService | undefined;
  let permissionRef: PermissionService | undefined;

  const server = await createShellServer({
    port: 0,
    managed: {
      create: (deps) => {
        documentRef = deps.document;
        permissionRef = deps.permission;
        runtime = createProjectRuntime({ ...deps, store, allowEphemeralRevocation: true });
        return runtime;
      },
    },
    ...(options.permissionWrapper ? { permissionWrapper: options.permissionWrapper } : {}),
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
  assert.ok(documentRef);
  assert.ok(permissionRef);
  try {
    await fn({
      base,
      rootA,
      server,
      runtime: runtime as ProjectRuntime,
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

/* ------------------------------------------------------------------ *
 * 1. Store 异常后的移除状态
 * ------------------------------------------------------------------ */

test('R1-01 撤销「确认未写入」→ 回 ACTIVE、零变更、可安全重试', async () => {
  await withManaged(async (h) => {
    const keyBefore = (await h.api('/api/health')).body.workspaceKey as string;
    const grantsOfA = () => h.permission.grantsOf(h.server.actorId).filter((g) => g.providerId === 'local:project-a');
    const grantsBefore = grantsOfA().map((g) => g.action).sort();

    h.store.failNextRevoke = 'not-committed';
    await assert.rejects(
      () => h.runtime.removeProject('project-a'),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PERSIST_FAILED',
      '确认未写入必须报可识别的持久化失败',
    );

    assert.equal(h.runtime.stateOf('project-a'), 'ACTIVE', '确认未写入才允许恢复 ACTIVE');
    assert.deepEqual(grantsOfA().map((g) => g.action).sort(), grantsBefore, '授权不得被收回');
    assert.ok(h.runtime.providerOf('local:project-a'), 'Provider 不得被释放');
    assert.equal(h.store.load().length, 1, 'Store 内容不得变化');
    assert.equal((await h.api('/api/health')).body.workspaceKey, keyBefore, '工作区身份不得变化');

    // 零变更：仍能正常读盘
    const resources = await h.api('/api/resources?projectId=project-a');
    assert.equal(resources.status, 200, '磁盘访问必须仍然可用');
    assert.equal(JSON.stringify(resources.body.nodes).includes('a.md'), true);

    // 可重试且最终成功
    const retried = await h.runtime.removeProject('project-a');
    assert.equal(retried.outcome, 'revoked');
    assert.equal(h.runtime.stateOf('project-a'), 'REMOVED');
    assert.equal(h.store.revokeAttempts(), 2, '重试必须是一次新的提交尝试');
    assert.deepEqual(h.store.load(), []);
  });
});

test('R1-02 撤销「结果不确定」→ REVOKE_UNKNOWN：拒盘、撤权、不释放屏障、不重复提交', async () => {
  await withManaged(async (h) => {
    const keyBefore = (await h.api('/api/health')).body.workspaceKey as string;
    const grantsOfA = () => h.permission.grantsOf(h.server.actorId).filter((g) => g.providerId === 'local:project-a');
    assert.equal(grantsOfA().length, 2);

    h.store.failNextRevoke = 'unknown';
    await assert.rejects(
      () => h.runtime.removeProject('project-a'),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PROJECT_REVOKE_UNKNOWN',
      '结果不确定必须报撤销未知，不能假装什么都没发生',
    );

    assert.equal(h.runtime.stateOf('project-a'), 'REVOKE_UNKNOWN');
    assert.equal(grantsOfA().length, 0, '不确定期间不得保留任何磁盘授权');
    assert.equal(h.runtime.providerOf('local:project-a'), undefined, '不确定期间必须释放 Provider');

    // G-DISK 一律拒绝，且错误码可识别（不是 404：项目仍在表内等待证据核对）
    const resources = await h.api('/api/resources?projectId=project-a');
    assert.equal(resources.status, 403, `实际 ${resources.status}`);
    assert.equal(resources.body.errorCode, 'ERR_PROJECT_REVOKE_UNKNOWN');

    const opened = await h.open('project-a', 'a.md');
    assert.equal(opened.status, 403);
    assert.equal(opened.body.errorCode, 'ERR_PROJECT_REVOKE_UNKNOWN');

    // 身份摘要必须变化：不得继续对外宣称这是一个 READY 的根
    const keyAfter = (await h.api('/api/health')).body.workspaceKey as string;
    assert.notEqual(keyAfter, keyBefore);
    assert.equal(JSON.stringify((await h.api('/api/health')).body).includes(h.base), false);

    const list = await h.api('/api/projects');
    assert.equal(list.body.projects.length, 1, '条目仍在表内（等待证据核对），不得直接消失');
    assert.equal(list.body.projects[0].status, 'UNAVAILABLE');

    // 再次变更：不得二次提交（提交结果还未知，重放会伪造第二条证据）
    await assert.rejects(
      () => h.runtime.removeProject('project-a'),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PROJECT_REVOKE_UNKNOWN',
    );
    assert.equal(h.store.revokeAttempts(), 1, '不确定状态下不得再次调用提交点');

    // 变更锁已释放，其它项目仍可登记
    const added = await h.runtime.addProject({ name: '项目 B', rootDir: join(h.base, 'project-b') });
    assert.equal(added.status, 'READY');

    // 磁盘零操作
    assert.equal(existsSync(join(h.rootA, 'a.md')), true);
  });
});

test('R1-03 未声明提交结果的异常一律按「不确定」处理（fail-closed）', async () => {
  await withManaged(async (h) => {
    h.store.failNextRevoke = 'unclassified';
    await assert.rejects(
      () => h.runtime.removeProject('project-a'),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PROJECT_REVOKE_UNKNOWN',
      '未分类失败不得被当成"确认未写入"',
    );
    assert.equal(h.runtime.stateOf('project-a'), 'REVOKE_UNKNOWN');
    assert.equal(
      h.permission.grantsOf(h.server.actorId).filter((g) => g.providerId === 'local:project-a').length,
      0,
    );
  });
});

/* ------------------------------------------------------------------ *
 * 2. UNAVAILABLE 项目根占用
 * ------------------------------------------------------------------ */

test('R1-04 根不可用的项目仍占用其注册身份：同路径/父目录/子目录均拒绝', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux02b01r1-root-'));
  const nest = join(base, 'nest');
  const rootA = join(nest, 'a');
  const child = join(rootA, 'docs');
  await mkdir(child, { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');

  const store = new ScriptedStore([{ projectId: 'a', name: 'A', rootDir: rootA }]);
  const runtime = createProjectRuntime({
    actorId: 'local-user',
    document: createDocumentService(),
    permission: createPermissionService([]),
    store,
    allowEphemeralRevocation: true,
  });

  try {
    assert.equal(runtime.list()[0]?.status, 'READY');
    const keyBefore = runtime.workspaceKey();

    // 根暂时消失 → 项目永久降级（不自动恢复）
    await rm(rootA, { recursive: true, force: true });
    assert.equal(runtime.list()[0]?.status, 'UNAVAILABLE');
    assert.equal(runtime.stateOf('a'), 'UNAVAILABLE');
    const keyUnavailable = runtime.workspaceKey();

    // 目录恢复存在，但项目身份不得被"自动修复"
    await mkdir(child, { recursive: true });
    assert.equal(runtime.stateOf('a'), 'UNAVAILABLE', '不得自动恢复已降级的项目');
    assert.equal(runtime.workspaceKey(), keyUnavailable, '恢复目录不得改变身份摘要');

    // 同一路径：即使 A 的 handle 已释放，也必须拒绝
    await assert.rejects(
      () => runtime.addProject({ name: 'b', rootDir: rootA }),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PROJECT_DUPLICATE_ROOT',
      'UNAVAILABLE 项目的原路径不得被注册成第二个项目',
    );
    // 父目录
    await assert.rejects(
      () => runtime.addProject({ name: 'c', rootDir: nest }),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PROJECT_NESTED_ROOT',
      '父目录不得成为新项目根',
    );
    // 子目录
    await assert.rejects(
      () => runtime.addProject({ name: 'd', rootDir: child }),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PROJECT_NESTED_ROOT',
      '子目录不得成为新项目根',
    );

    assert.equal(store.calls.length, 0, '被拒的注册不得触碰 Store');
    assert.deepEqual(
      store.load().map((p) => p.projectId),
      ['a'],
      'A 的原始身份不得被修改',
    );
    assert.equal(runtime.stateOf('a'), 'UNAVAILABLE', '拒绝注册不得改变 A 的状态');
    assert.equal(runtime.workspaceKey(), keyUnavailable);
    assert.notEqual(keyUnavailable, keyBefore);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 3. workspaceKey 过期
 * ------------------------------------------------------------------ */

test('R1-05 仅凭 /api/health 也必须发现根已消失（不得继续返回旧 READY 摘要）', async () => {
  await withManaged(async (h) => {
    const before = await h.api('/api/health');
    assert.equal(before.status, 200);
    const keyBefore = before.body.workspaceKey as string;
    assert.equal(typeof keyBefore, 'string');

    await rm(h.rootA, { recursive: true, force: true });

    // 关键：不调用 /api/projects，也不调用 /api/resources
    const after = await h.api('/api/health');
    assert.equal(after.status, 200);
    assert.equal(typeof after.body.workspaceKey, 'string');
    assert.notEqual(after.body.workspaceKey, keyBefore, '根消失后不得继续返回旧的 READY 根身份摘要');
    assert.equal(JSON.stringify(after.body).includes(h.base), false, '不得回传绝对路径');

    // 该次请求已经把项目降级（不存在"健康检查看得到、项目表看不到"的双真相）
    assert.equal(h.runtime.stateOf('project-a'), 'UNAVAILABLE');
  });
});

test('R1-06 根被同名目录替换（令牌变化）时 /api/health 同样必须失效', async () => {
  await withManaged(async (h) => {
    const keyBefore = (await h.api('/api/health')).body.workspaceKey as string;

    // 用一个新的同名目录替换（新的 ino / creation time）
    await rm(h.rootA, { recursive: true, force: true });
    await mkdir(join(h.rootA, 'docs'), { recursive: true });
    await writeFile(join(h.rootA, 'a.md'), '# replaced\n', 'utf8');

    const after = await h.api('/api/health');
    assert.notEqual(after.body.workspaceKey, keyBefore);
    assert.equal(h.runtime.stateOf('project-a'), 'UNAVAILABLE');

    // 磁盘访问必须拒绝，且不得把替换后的目录当作原项目继续使用
    const resources = await h.api('/api/resources?projectId=project-a');
    assert.ok(resources.status === 503, `实际 ${resources.status}`);
  });
});

test('R1-07 Legacy 的工作区身份仍为启动快照（不因根消失而改变）', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux02b01r1-legacy-'));
  const root = join(base, 'root');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'a.md'), '# A\n', 'utf8');
  const server = await createShellServer({ rootDir: root, port: 0 });
  try {
    const first = (await (await fetch(`${server.url}/api/health`)).json()) as { workspaceKey?: string };
    assert.equal(typeof first.workspaceKey, 'string');

    await rm(root, { recursive: true, force: true });

    const second = (await (await fetch(`${server.url}/api/health`)).json()) as { workspaceKey?: string };
    assert.equal(second.workspaceKey, first.workspaceKey, 'Legacy 行为必须保持原样');
  } finally {
    await rm(base, { recursive: true, force: true });
    await server.close();
  }
});

/* ------------------------------------------------------------------ *
 * 4. projectId 长度
 * ------------------------------------------------------------------ */

test('R1-08 32 字符显示名派生出的 projectId 加序号后仍满足既有正则', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux02b01r1-id-'));
  const roots = [join(base, 'r1'), join(base, 'r2'), join(base, 'r3')];
  for (const root of roots) await mkdir(root, { recursive: true });

  const store = new ScriptedStore([]);
  const runtime = createProjectRuntime({
    actorId: 'local-user',
    document: createDocumentService(),
    permission: createPermissionService([]),
    store,
    allowEphemeralRevocation: true,
  });

  // 恰好 32 字符的 slug：任何追加后缀都会超出上限
  const name = 'x'.repeat(32);
  const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

  try {
    const ids: string[] = [];
    for (const root of roots) {
      const summary = await runtime.addProject({ name, rootDir: root });
      ids.push(summary.projectId);
      assert.match(summary.projectId, PROJECT_ID_RE, `projectId 非法: ${summary.projectId}`);
      assert.ok(summary.projectId.length <= 32, `projectId 超长: ${summary.projectId.length}`);

      // 持久化时用的仍是同一条正则：能写进去就必须能再读出来
      assert.doesNotThrow(() =>
        validateWorkspaceConfig({
          version: 1,
          projects: [{ projectId: summary.projectId, name, rootDir: root }],
        }),
      );
    }

    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3, 'ID 不得复用');
    assert.ok(ids.includes(name), '第一个项目应直接使用 slug 本身');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 5. Legacy G-DRAFT 兼容
 * ------------------------------------------------------------------ */

test('R1-09 Legacy 的 GET /api/document 仍执行原有读取授权', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux02b01r1-gdraft-'));
  const root = join(base, 'root');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'a.md'), '# A\n', 'utf8');

  const toggle = wrappingPermission(
    createPermissionService([
      { actorId: 'local-user', action: 'read', scope: '' },
      { actorId: 'local-user', action: 'write', scope: '' },
    ]),
  );
  const server = await createShellServer({
    rootDir: root,
    port: 0,
    permissionWrapper: () => toggle.service,
  });

  const post = async (path: string, body: unknown): Promise<ApiResponse> => {
    const res = await fetch(`${server.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  try {
    const opened = await post('/api/open', { path: 'a.md' });
    assert.equal(opened.status, 200);
    const sessionId = opened.body.document.sessionId as string;

    // Legacy 不要求 viewId，读取授权是唯一的门
    const allowed = await fetch(`${server.url}/api/document?sessionId=${sessionId}`);
    assert.equal(allowed.status, 200);

    toggle.denyReads(true);
    const denied = await fetch(`${server.url}/api/document?sessionId=${sessionId}`);
    const deniedBody = (await denied.json().catch(() => ({}))) as { errorCode?: string };
    assert.equal(denied.status, 403, 'Legacy 读取授权被移除后会退化成"任何人都能读会话正文"');
    assert.equal(deniedBody.errorCode, 'ERR_PERMISSION_DENIED');

    toggle.denyReads(false);
    const restored = await fetch(`${server.url}/api/document?sessionId=${sessionId}`);
    assert.equal(restored.status, 200);
  } finally {
    await rm(base, { recursive: true, force: true });
    await server.close();
  }
});

test('R1-10 Multi 的 G-DRAFT 只认 actor + session + viewId，不依赖项目 grant', async () => {
  const toggle = wrappingPermission(createPermissionService([]));
  await withManaged(
    async (h) => {
      const opened = await h.open('project-a', 'a.md');
      assert.equal(opened.status, 200);
      const sessionId = opened.body.document.sessionId as string;
      const viewId = opened.body.document.viewId as string;
      const baseVersion = opened.body.document.baseVersion as string;
      await h.post('/api/edit', { sessionId, viewId, buffer: '# my draft\n' });

      toggle.denyReads(true);
      try {
        // 门禁确实生效：项目级读授权被拒
        const resources = await h.api('/api/resources?projectId=project-a');
        assert.equal(resources.status, 403);
        assert.equal(resources.body.errorCode, 'ERR_PERMISSION_DENIED');

        // 草稿读取不受影响（G-DRAFT 与项目 grant 无关）
        const draft = await h.api(`/api/document?sessionId=${sessionId}&viewId=${viewId}`);
        assert.equal(draft.status, 200);
        assert.equal(draft.body.document.content, '# my draft\n');

        // 项目根失效后仍可读回草稿：STALE 草稿规则不得因本次修复被放宽或收紧
        await rm(h.rootA, { recursive: true, force: true });
        const stale = await h.api(`/api/document?sessionId=${sessionId}&viewId=${viewId}`);
        assert.equal(stale.status, 200);
        assert.equal(stale.body.document.content, '# my draft\n');
        assert.equal(stale.body.document.dirty, true);
        assert.equal(stale.body.document.baseVersion, baseVersion);

        // 伪造 viewId 仍然拒绝（授权边界没有被 G-DRAFT 放宽）
        const forged = await h.api(`/api/document?sessionId=${sessionId}&viewId=view-forged`);
        assert.equal(forged.status, 403);
      } finally {
        toggle.denyReads(false);
      }
    },
    { permissionWrapper: () => toggle.service },
  );
});

/* ------------------------------------------------------------------ *
 * 6. Legacy `POST /api/close` 的读取授权（UX-02B-01-R2）
 * ------------------------------------------------------------------ */

/**
 * 基线 `d6bc5e6` 的 `/api/close` 在关闭 View 前做了项目资源的 read 授权检查。
 * UX-02B-01 为 G-DRAFT 把这层检查整体移除，于是 Legacy 在 read grant 被撤销后
 * 仍能关闭 View —— Legacy 没有 viewId 绑定，读取授权是唯一的门，必须恢复；
 * 但 Multi 的关闭只操作 Host 内存，不能因为项目失效/授权撤销而拒绝。
 */
test('R2-01 Legacy 撤销 read 授权后 POST /api/close 必须 403 且 View 不得关闭', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux02b01r2-legacy-'));
  const root = join(base, 'root');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'a.md'), '# A\n', 'utf8');

  const toggle = wrappingPermission(
    createPermissionService([
      { actorId: 'local-user', action: 'read', scope: '' },
      { actorId: 'local-user', action: 'write', scope: '' },
    ]),
  );
  const server = await createShellServer({
    rootDir: root,
    port: 0,
    permissionWrapper: () => toggle.service,
  });

  const post = async (path: string, body: unknown): Promise<ApiResponse> => {
    const res = await fetch(`${server.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const read = async (sessionId: string): Promise<ApiResponse> => {
    const res = await fetch(`${server.url}/api/document?sessionId=${sessionId}`);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  try {
    const opened = await post('/api/open', { path: 'a.md' });
    assert.equal(opened.status, 200);
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;

    toggle.denyReads(true);
    try {
      const closed = await post('/api/close', { sessionId, viewId });
      assert.equal(closed.status, 403, 'Legacy 关闭视图前必须仍执行 read 授权检查');
      assert.equal(closed.body.errorCode, 'ERR_PERMISSION_DENIED');
    } finally {
      toggle.denyReads(false);
    }

    // 关键：View 没有被关闭（会话与视图仍可读回）
    const stillReadable = await read(sessionId);
    assert.equal(stillReadable.status, 200, '被拒绝的关闭请求不得悄悄关掉视图');

    // 授权恢复后仍能正常关闭，且第二次关闭因视图不存在而拒绝
    const closed = await post('/api/close', { sessionId, viewId });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.status, 'APPLIED');
    const again = await post('/api/close', { sessionId, viewId });
    assert.equal(again.status, 403, '视图已关闭，重复关闭必须被视图绑定校验拒绝');
  } finally {
    await rm(base, { recursive: true, force: true });
    await server.close();
  }
});

test('R2-02 Multi 的 POST /api/close 不受项目失效/授权撤销影响，dirty 仍 409', async () => {
  const toggle = wrappingPermission(createPermissionService([]));
  await withManaged(
    async (h) => {
      // 项目 A：一个干净视图（用于"授权被撤销"）、一个 dirty 视图
      await writeFile(join(h.rootA, 'docs', 'only-a.md'), '# only A\n', 'utf8');
      const cleanA = await h.open('project-a', 'docs/only-a.md');
      const dirtyA = await h.open('project-a', 'a.md');
      assert.equal(cleanA.status, 200);
      assert.equal(dirtyA.status, 200);
      const cleanASession = cleanA.body.document.sessionId as string;
      const cleanAView = cleanA.body.document.viewId as string;
      const dirtyASession = dirtyA.body.document.sessionId as string;
      const dirtyAView = dirtyA.body.document.viewId as string;
      await h.post('/api/edit', { sessionId: dirtyASession, viewId: dirtyAView, buffer: '# keep me\n' });

      // 项目 B：干净视图，用于"项目根失效"
      const b = await h.runtime.addProject({ name: '项目 B', rootDir: join(h.base, 'project-b') });
      const cleanB = await h.open(b.projectId, 'a.md');
      assert.equal(cleanB.status, 200);
      const cleanBSession = cleanB.body.document.sessionId as string;
      const cleanBView = cleanB.body.document.viewId as string;

      toggle.denyReads(true);
      try {
        // 授权被撤销 ≠ 视图不可关闭（G-DRAFT 只看 actor + session + viewId）
        const revoked = await h.post('/api/close', { sessionId: cleanASession, viewId: cleanAView });
        assert.equal(revoked.status, 200, `实际 ${revoked.status}/${JSON.stringify(revoked.body)}`);
        assert.equal(revoked.body.status, 'APPLIED');

        // dirty 保护不变：不因授权撤销而静默丢草稿
        const dirty = await h.post('/api/close', { sessionId: dirtyASession, viewId: dirtyAView });
        assert.equal(dirty.status, 409);
        assert.equal(dirty.body.errorCode, 'ERR_DOCUMENT_DIRTY');
        const draft = await h.api(`/api/document?sessionId=${dirtyASession}&viewId=${dirtyAView}`);
        assert.equal(draft.body.document.content, '# keep me\n');

        // 项目根失效同样不影响干净视图的关闭
        await rm(join(h.base, 'project-b'), { recursive: true, force: true });
        const failed = await h.post('/api/close', { sessionId: cleanBSession, viewId: cleanBView });
        assert.equal(failed.status, 200, `实际 ${failed.status}/${JSON.stringify(failed.body)}`);
        assert.equal(failed.body.status, 'APPLIED');

        // 伪造 viewId 仍被拒绝（G-DRAFT 未放宽归属校验）
        const forged = await h.post('/api/close', { sessionId: dirtyASession, viewId: 'view-forged' });
        assert.equal(forged.status, 403);
      } finally {
        toggle.denyReads(false);
      }
    },
    { permissionWrapper: () => toggle.service },
  );
});
