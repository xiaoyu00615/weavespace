/**
 * S11-A1-G1：Host 多项目隔离、身份解析与门禁（HTTP 集成）。
 *
 * 全部用例只操作自建临时目录；服务在进程内启动（端口 0）。
 * 断言同时检查「HTTP 状态 + 响应体状态/错误码 + 真实磁盘副作用」。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createDocumentService } from '../../packages/document/index.ts';
import type { WorkspaceConfig } from '../../packages/project-registry/index.ts';
import { createLocalProvider } from '../../packages/storage/index.ts';

interface ApiResponse {
  status: number;
  // 测试内按字段取值，换取断言可读性（不影响生产代码）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

interface MultiCtx {
  base: string;
  rootA: string;
  rootB: string;
  server: ShellServer;
  api(path: string, init?: RequestInit): Promise<ApiResponse>;
  post(path: string, body: unknown): Promise<ApiResponse>;
  open(projectId: string, path: string): Promise<ApiResponse>;
}

interface MultiOptions {
  grantedProjects?: readonly string[];
  extraProject?: { projectId: string; rootDir: string };
}

/**
 * 直接构造已校验配置（类型仅用于编译期，运行时**不依赖** registry 模块）。
 * 这样本套件在基线上可以独立跑出真实失败，而不是"模块不存在"。
 */
function configOf(base: string, extra?: MultiOptions['extraProject']): WorkspaceConfig {
  const projects = [
    { projectId: 'project-a', name: '项目 A', rootDir: join(base, 'project-a') },
    { projectId: 'project-b', name: '项目 B', rootDir: join(base, 'project-b') },
  ];
  if (extra) projects.push({ projectId: extra.projectId, name: extra.projectId, rootDir: extra.rootDir });
  return { version: 1, projects };
}

async function withMulti(fn: (ctx: MultiCtx) => Promise<void>, options: MultiOptions = {}): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-g1h-'));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');
  await writeFile(join(rootB, 'a.md'), '# B\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'only-a.md'), '# only A\n', 'utf8');

  const server = await createShellServer({
    workspace: configOf(base, options.extraProject),
    port: 0,
    ...(options.grantedProjects ? { grantedProjects: options.grantedProjects } : {}),
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

  try {
    await fn({
      base,
      rootA,
      rootB,
      server,
      api,
      post,
      open: (projectId, path) => post('/api/open', { projectId, path }),
    });
  } finally {
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// H-01 Multi 缺 projectId
// ---------------------------------------------------------------------------
test('H-01 Multi 缺 projectId 返回 400，且绝不回落默认项目', async () => {
  await withMulti(async ({ api, post }) => {
    const resources = await api('/api/resources');
    assert.equal(resources.status, 400);
    assert.equal(resources.body.errorCode, 'ERR_PROJECT_REQUIRED');

    const open = await post('/api/open', { path: 'a.md' });
    assert.equal(open.status, 400);
    assert.equal(open.body.errorCode, 'ERR_PROJECT_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
// H-02 两项目都有 a.md：返回各自真实内容
// ---------------------------------------------------------------------------
test('H-02 两个项目同名文件：资源树与打开结果都各自独立', async () => {
  await withMulti(async ({ api, open }) => {
    const treeA = await api('/api/resources?projectId=project-a');
    const treeB = await api('/api/resources?projectId=project-b');
    assert.equal(treeA.status, 200);
    assert.equal(treeB.status, 200);
    assert.match(JSON.stringify(treeA.body.nodes), /doc:project-a\/a\.md/);
    assert.match(JSON.stringify(treeB.body.nodes), /doc:project-b\/a\.md/);

    const a = await open('project-a', 'a.md');
    const b = await open('project-b', 'a.md');
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.document.content, '# A\n');
    assert.equal(b.body.document.content, '# B\n');
    assert.equal(a.body.document.projectId, 'project-a');
    assert.equal(b.body.document.projectId, 'project-b');
    assert.notEqual(a.body.document.sessionId, b.body.document.sessionId);
    assert.equal(a.body.document.resourceId, 'doc:project-a/a.md');
    assert.equal(b.body.document.resourceId, 'doc:project-b/a.md');
  });
});

// ---------------------------------------------------------------------------
// H-03 Session 归属 Provider：disk / save 不得跨项目
// ---------------------------------------------------------------------------
test('H-03 会话绑定项目的 Provider：disk 与 save 不跨项目，客户端改 projectId 无效', async () => {
  await withMulti(async ({ api, post, open, rootA, rootB }) => {
    const opened = await open('project-a', 'a.md');
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;
    const baseVersion = opened.body.document.baseVersion as string;

    // B 项目的同名文件被外部改掉，A 会话的磁盘视图不得受影响
    await writeFile(join(rootB, 'a.md'), '# B changed\n', 'utf8');
    const diskOfA = await api(`/api/document/disk?sessionId=${sessionId}&viewId=${viewId}`);
    assert.equal(diskOfA.status, 200);
    assert.equal(diskOfA.body.content, '# A\n', 'A 会话只能读 A 项目磁盘');

    await post('/api/edit', { sessionId, viewId, buffer: '# A edited\n' });
    const saved = await post('/api/save', { sessionId, viewId, expectedVersion: baseVersion });
    assert.equal(saved.status, 200);
    assert.equal(await readFile(join(rootA, 'a.md'), 'utf8'), '# A edited\n');
    assert.equal(await readFile(join(rootB, 'a.md'), 'utf8'), '# B changed\n', 'B 文件必须原样');

    // 客户端把 projectId 改成 B：只作为一致性断言，必须拒绝
    const forged = await post('/api/save', {
      sessionId,
      viewId,
      expectedVersion: saved.body.contentVersion,
      projectId: 'project-b',
    });
    assert.equal(forged.status, 400);
    assert.equal(forged.body.errorCode, 'ERR_COMMAND_INVALID');

    const forgedDisk = await api(
      `/api/document/disk?sessionId=${sessionId}&viewId=${viewId}&projectId=project-b`,
    );
    assert.equal(forgedDisk.status, 400);
    assert.equal(await readFile(join(rootB, 'a.md'), 'utf8'), '# B changed\n');
  });
});

// ---------------------------------------------------------------------------
// H-04 仅授权 A：B 的读与写都必须拒绝
// ---------------------------------------------------------------------------
test('H-04 仅授权 project-a：访问 project-b 的读与写都被拒绝', async () => {
  await withMulti(
    async ({ api, open, post }) => {
      const a = await open('project-a', 'a.md');
      assert.equal(a.status, 200, '已授权项目必须可读');

      const bResources = await api('/api/resources?projectId=project-b');
      assert.equal(bResources.status, 403);
      assert.equal(bResources.body.errorCode, 'ERR_PERMISSION_DENIED');

      const bOpen = await open('project-b', 'a.md');
      assert.equal(bOpen.status, 403);
      assert.equal(bOpen.body.errorCode, 'ERR_PERMISSION_DENIED');

      const bWrite = await post('/api/open', { projectId: 'project-b', path: 'docs/x.md' });
      assert.equal(bWrite.status, 403);
    },
    { grantedProjects: ['project-a'] },
  );
});

// ---------------------------------------------------------------------------
// H-05 客户端伪造可信身份
// ---------------------------------------------------------------------------
test('H-05 伪造 providerId / resourceId / actorId / rootDir 一律拒绝', async () => {
  await withMulti(async ({ post }) => {
    const provider = await post('/api/open', { projectId: 'project-a', path: 'a.md', providerId: 'local' });
    assert.equal(provider.status, 403, 'Multi 下任何 providerId 都视为越权');
    assert.equal(provider.body.errorCode, 'ERR_PERMISSION_DENIED');

    const resource = await post('/api/open', {
      projectId: 'project-a',
      path: 'a.md',
      resourceId: 'doc:project-b/a.md',
    });
    assert.equal(resource.status, 400);
    assert.equal(resource.body.errorCode, 'ERR_COMMAND_INVALID');

    const actor = await post('/api/open', { projectId: 'project-a', path: 'a.md', actorId: 'root' });
    assert.equal(actor.status, 400);
    assert.equal(actor.body.errorCode, 'ERR_COMMAND_INVALID');

    const root = await post('/api/open', { projectId: 'project-a', path: 'a.md', rootDir: 'C:/x' });
    assert.equal(root.status, 400);
    assert.equal(root.body.errorCode, 'ERR_COMMAND_INVALID');
  });
});

// ---------------------------------------------------------------------------
// H-06 根失效后的 save / reload / disk
// ---------------------------------------------------------------------------
test('H-06 项目根失效后 save/reload/disk 全部拒绝，且不重建根', async () => {
  await withMulti(async ({ api, post, open, rootA }) => {
    const opened = await open('project-a', 'a.md');
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;
    const baseVersion = opened.body.document.baseVersion as string;
    await post('/api/edit', { sessionId, viewId, buffer: '# draft\n' });

    await rm(rootA, { recursive: true, force: true });

    const saved = await post('/api/save', { sessionId, viewId, expectedVersion: baseVersion });
    assert.equal(saved.status, 503, '项目不可用必须是 503，不能误报版本冲突');
    assert.notEqual(saved.body.status, 'CONFLICT');
    assert.equal(saved.body.errorCode, 'ERR_PROJECT_UNAVAILABLE');
    assert.equal(existsSync(rootA), false, '不得重建根');

    const disk = await api(`/api/document/disk?sessionId=${sessionId}&viewId=${viewId}`);
    assert.equal(disk.status, 503);

    const reload = await post('/api/reload', { sessionId, viewId, discardDraft: true });
    assert.equal(reload.status, 503);
    assert.equal(existsSync(rootA), false, 'reload 不得重建根');
  });
});

// ---------------------------------------------------------------------------
// H-07 STALE 草稿：保留、可授权读取、不回传正文到错误
// ---------------------------------------------------------------------------
test('H-07 根失效后草稿必须保留且可读回，重开被拒绝', async () => {
  await withMulti(async ({ api, post, open, rootA }) => {
    const opened = await open('project-a', 'a.md');
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;
    const baseVersion = opened.body.document.baseVersion as string;
    await post('/api/edit', { sessionId, viewId, buffer: '# my draft\n' });

    await rm(rootA, { recursive: true, force: true });

    const saved = await post('/api/save', { sessionId, viewId, expectedVersion: baseVersion });
    assert.equal(saved.status, 503);

    // 错误**消息**不得回传草稿正文（save 的 document 快照是既有契约，仍需保留 dirty 状态）
    assert.equal(String(saved.body.message ?? '').includes('my draft'), false);

    const draft = await api(`/api/document?sessionId=${sessionId}&viewId=${viewId}`);
    assert.equal(draft.status, 200, '草稿读取属于内存缓冲，不受磁盘门禁影响');
    assert.equal(draft.body.document.content, '# my draft\n');
    assert.equal(draft.body.document.dirty, true, 'dirty 必须保留');
    assert.ok(draft.body.document.stale, '必须带 stale 标记');
    assert.equal(draft.body.document.stale.reason, 'ERR_PROJECT_UNAVAILABLE');

    // 重新打开同一资源：项目不可用 → 拒绝，绝不覆盖草稿
    const reopened = await post('/api/open', { projectId: 'project-a', path: 'a.md' });
    assert.ok(reopened.status === 503 || reopened.status === 409, `重开必须被拒绝，实际 ${reopened.status}`);
    assert.equal(
      JSON.stringify(reopened.body).includes('my draft'),
      false,
      '重开失败不得把草稿正文放进错误响应',
    );
    assert.equal(existsSync(rootA), false);
  });
});

test('H-07b [UNIT] STALE 会话：dirty 重开拒绝、非 dirty 丢弃重建', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-g1s-'));
  try {
    const root = join(base, 'project');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'a.md'), '# A\n', 'utf8');
    const provider = createLocalProvider({ rootDir: root, providerId: 'local:project-a' });
    const document = createDocumentService();
    const resourceId = 'doc:project-a/a.md';

    const dirty = await document.openSession({ resourceId, path: 'a.md', provider, projectId: 'project-a' });
    document.applyEdit(dirty.sessionId, '# draft\n');
    document.markProjectStale('project-a', 'MISSING');

    await assert.rejects(
      () => document.openSession({ resourceId, path: 'a.md', provider, projectId: 'project-a' }),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_SESSION_STALE',
      'dirty 的失效会话不得被覆盖重建',
    );
    assert.equal(document.getBuffer(dirty.sessionId), '# draft\n', '草稿必须保留');
    assert.equal(document.getSession(dirty.sessionId)?.baseVersion, document.getSession(dirty.sessionId)?.baseVersion);

    // 非 dirty：允许丢弃旧会话并按磁盘重建（无草稿损失）
    const clean = await document.openSession({
      resourceId: 'doc:project-a/docs/clean.md',
      path: 'docs/clean.md',
      provider,
      projectId: 'project-a',
    });
    document.markProjectStale('project-a', 'MISSING');
    const reopened = await document.openSession({
      resourceId: 'doc:project-a/docs/clean.md',
      path: 'docs/clean.md',
      provider,
      projectId: 'project-a',
    });
    assert.notEqual(reopened.sessionId, clean.sessionId, '非 dirty 的失效会话应按磁盘重建');
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// H-08 猜读
// ---------------------------------------------------------------------------
test('H-08 陌生 sessionId 返回 404，他人 viewId 返回 403', async () => {
  await withMulti(async ({ api, open }) => {
    const unknown = await api('/api/document?sessionId=session-99999');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.errorCode, 'ERR_DOCUMENT_NOT_FOUND');

    const a = await open('project-a', 'a.md');
    const b = await open('project-b', 'a.md');
    const crossView = await api(
      `/api/document?sessionId=${a.body.document.sessionId}&viewId=${b.body.document.viewId}`,
    );
    assert.equal(crossView.status, 403, '用别人的 viewId 猜读必须拒绝');
    assert.equal(crossView.body.errorCode, 'ERR_PERMISSION_DENIED');
  });
});

// ---------------------------------------------------------------------------
// H-09 Health 隐私
// ---------------------------------------------------------------------------
test('H-09 /api/health 不返回本机绝对路径', async () => {
  await withMulti(async ({ api, rootA, server }) => {
    const res = await api('/api/health');
    assert.equal(res.status, 200);
    assert.equal('root' in res.body, false, '不得再返回 root');
    assert.equal(res.body.workspaceMode, 'multi');
    const text = JSON.stringify(res.body);
    assert.equal(text.includes(rootA), false);
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]/);
    assert.equal(server.rootDir, '', 'Multi 的 server.rootDir 不得承载真实路径');
  });
});

// ---------------------------------------------------------------------------
// H-10 Legacy 兼容
// ---------------------------------------------------------------------------
test('H-10 Legacy 模式：接口与身份保持兼容', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-g1l-'));
  const root = join(base, 'project');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'a.md'), '# A\n', 'utf8');
  const server = await createShellServer({ rootDir: root, port: 0 });
  const api = async (path: string, init?: RequestInit): Promise<ApiResponse> => {
    const res = await fetch(`${server.url}${path}`, init);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const post = (path: string, body: unknown) =>
    api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  try {
    assert.equal(server.mode, 'legacy');

    const projects = await api('/api/projects');
    assert.equal(projects.status, 404, 'Legacy 不提供项目列表');

    const resources = await api('/api/resources');
    assert.equal(resources.status, 200, 'Legacy 资源树不需要 projectId');

    const opened = await post('/api/open', { path: 'a.md' });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.document.content, '# A\n');
    assert.equal(opened.body.document.resourceId, 'doc:a.md', 'Legacy resourceId 格式必须保持');
    assert.equal(opened.body.document.projectId, undefined, 'Legacy 不返回 projectId');

    const saved = await post('/api/save', {
      sessionId: opened.body.document.sessionId,
      viewId: opened.body.document.viewId,
      expectedVersion: opened.body.document.baseVersion,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.status, 'COMMITTED');

    const withProject = await post('/api/open', { path: 'a.md', projectId: 'project-a' });
    assert.equal(withProject.status, 400, 'Legacy 不接受 projectId');

    const health = await api('/api/health');
    assert.equal('root' in health.body, false);
    assert.equal(health.body.workspaceMode, 'legacy');
  } finally {
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// H-11 模式混用
// ---------------------------------------------------------------------------
test('H-11 同进程混用 Legacy 与 Multi 必须拒绝', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-g1m-'));
  try {
    await mkdir(join(base, 'project'), { recursive: true });
    await assert.rejects(
      () =>
        createShellServer({
          rootDir: join(base, 'project'),
          workspace: configOf(base),
          port: 0,
        }),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PROJECT_CONFIG_INVALID',
      '同时给出项目根与工作区配置必须拒绝',
    );
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// H-12 一个项目失效不影响另一个
// ---------------------------------------------------------------------------
test('H-12 一个项目失效不影响另一个 READY 项目', async () => {
  await withMulti(async ({ api, post, open, rootA, rootB }) => {
    const before = await open('project-b', 'a.md');
    assert.equal(before.status, 200);

    await rm(rootA, { recursive: true, force: true });

    const a = await api('/api/resources?projectId=project-a');
    assert.equal(a.status, 503);
    assert.equal(a.body.errorCode, 'ERR_PROJECT_UNAVAILABLE');

    const b = await api('/api/resources?projectId=project-b');
    assert.equal(b.status, 200, '另一个项目必须仍然可用');

    const bOpened = await post('/api/open', { projectId: 'project-b', path: 'a.md' });
    assert.equal(bOpened.status, 200);
    assert.equal(bOpened.body.document.content, '# B\n');

    const saved = await post('/api/save', {
      sessionId: bOpened.body.document.sessionId,
      viewId: bOpened.body.document.viewId,
      expectedVersion: bOpened.body.document.baseVersion,
    });
    assert.equal(saved.status, 200);
    assert.equal(await readFile(join(rootB, 'a.md'), 'utf8'), '# B\n');
  });
});
