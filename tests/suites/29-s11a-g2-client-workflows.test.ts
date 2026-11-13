/**
 * S11-A1-G2：Shell ↔ Host 的真实工作流（HTTP 集成，走 Shell 自己的 client-api）。
 *
 * 与 26 套件（Host 契约）的区别：这里从**前端调用姿势**出发，验证 Shell 实际
 * 发出的参数（projectId / viewId）能被 G1 Host 正确接受，且跨项目互不串用。
 *
 * 只操作自建临时目录；服务在进程内启动（端口 0）。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createShellServer } from '../../apps/server/src/server.ts';
import {
  createDemoClient,
  createLiveClient,
  type ProjectSummary,
} from '../../apps/shell/src/client/client-api.ts';
import { DEMO_CONTENTS, DEMO_NODES } from '../../apps/shell/src/data/demo-project.ts';
import type { WorkspaceConfig } from '../../packages/project-registry/index.ts';

interface MultiCtx {
  base: string;
  rootA: string;
  rootB: string;
  client: ReturnType<typeof createLiveClient>;
  close(): Promise<void>;
}

async function withMulti(fn: (ctx: MultiCtx) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-g2c-'));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await mkdir(join(rootB, 'docs'), { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');
  await writeFile(join(rootB, 'a.md'), '# B\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'only-a.md'), '# only A\n', 'utf8');

  const workspace: WorkspaceConfig = {
    version: 1,
    projects: [
      { projectId: 'project-a', name: '项目 A', rootDir: rootA },
      { projectId: 'project-b', name: '项目 B', rootDir: rootB },
    ],
  };
  const server = await createShellServer({ workspace, port: 0 });
  const client = createLiveClient(server.url);
  try {
    await fn({ base, rootA, rootB, client, close: async () => server.close() });
  } finally {
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// UI-01 模式与项目列表
// ---------------------------------------------------------------------------
test('UI-01a Multi：workspaceMode=multi 且能列出两个项目', async () => {
  await withMulti(async ({ client }) => {
    assert.equal(await client.workspaceMode(), 'multi');
    const projects = await client.listProjects();
    assert.deepEqual(
      projects.map((project: ProjectSummary) => [project.projectId, project.status]),
      [
        ['project-a', 'READY'],
        ['project-b', 'READY'],
      ],
    );
    assert.equal(JSON.stringify(projects).includes('rootDir'), false, '摘要不得含 rootDir');
  });
});

test('UI-01b Legacy：workspaceMode=legacy 且没有项目列表', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-g2l-'));
  const root = join(base, 'project');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'a.md'), '# legacy\n', 'utf8');
  const server = await createShellServer({ rootDir: root, port: 0 });
  const client = createLiveClient(server.url);
  try {
    assert.equal(await client.workspaceMode(), 'legacy');
    assert.deepEqual(await client.listProjects(), []);
    const opened = await client.openDocument('a.md');
    assert.equal(opened.status, 'APPLIED');
    assert.equal(opened.document?.resourceId, 'doc:a.md', 'Legacy 身份格式不变');
  } finally {
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// UI-03 资源树按项目隔离，同名文件 docId 不同
// ---------------------------------------------------------------------------
test('UI-03 两个项目的资源树各自命名空间，同名文件不共享节点 id', async () => {
  await withMulti(async ({ client }) => {
    const nodesA = await client.listResources('project-a');
    const nodesB = await client.listResources('project-b');
    const flatA = JSON.stringify(nodesA);
    const flatB = JSON.stringify(nodesB);

    assert.match(flatA, /doc:project-a\/a\.md/);
    assert.match(flatB, /doc:project-b\/a\.md/);
    assert.doesNotMatch(flatA, /project-b/);
    assert.doesNotMatch(flatB, /project-a/);
    assert.match(flatA, /only-a\.md/);
    assert.doesNotMatch(flatB, /only-a\.md/);
  });
});

// ---------------------------------------------------------------------------
// UI-03/07/08/11 跨项目同名文件的完整工作流
// ---------------------------------------------------------------------------
test('UI-07/08 同名文件同时打开：编辑与保存只影响各自项目', async () => {
  await withMulti(async ({ client, rootA, rootB }) => {
    const a = await client.openDocument('a.md', 'project-a');
    const b = await client.openDocument('a.md', 'project-b');
    assert.equal(a.status, 'APPLIED');
    assert.equal(b.status, 'APPLIED');
    assert.equal(a.document?.content, '# A\n');
    assert.equal(b.document?.content, '# B\n');
    assert.notEqual(a.document?.sessionId, b.document?.sessionId);
    assert.equal(a.document?.resourceId, 'doc:project-a/a.md');
    assert.equal(b.document?.resourceId, 'doc:project-b/a.md');

    // 编辑必须带 viewId（UI-11）
    const editedA = await client.applyEdit(
      a.document!.sessionId,
      '# A edited\n',
      a.document!.baseVersion,
      a.document!.viewId,
    );
    assert.equal(editedA.status, 'APPLIED');
    const editedB = await client.applyEdit(
      b.document!.sessionId,
      '# B edited\n',
      b.document!.baseVersion,
      b.document!.viewId,
    );
    assert.equal(editedB.status, 'APPLIED');

    const savedA = await client.saveDocument(
      a.document!.sessionId,
      a.document!.baseVersion as string,
      a.document!.viewId,
    );
    assert.equal(savedA.status, 'COMMITTED');
    assert.equal(await readFile(join(rootA, 'a.md'), 'utf8'), '# A edited\n');
    assert.equal(await readFile(join(rootB, 'a.md'), 'utf8'), '# B\n', 'B 未被 A 的保存影响');

    const savedB = await client.saveDocument(
      b.document!.sessionId,
      b.document!.baseVersion as string,
      b.document!.viewId,
    );
    assert.equal(savedB.status, 'COMMITTED');
    assert.equal(await readFile(join(rootB, 'a.md'), 'utf8'), '# B edited\n');
    assert.equal(await readFile(join(rootA, 'a.md'), 'utf8'), '# A edited\n', 'A 未被 B 的保存影响');
  });
});

// ---------------------------------------------------------------------------
// UI-11 Multi 会话请求必须带 viewId
// ---------------------------------------------------------------------------
test('UI-11 Multi 省略 viewId 的 edit 被拒绝（前端必须携带）', async () => {
  await withMulti(async ({ client }) => {
    const opened = await client.openDocument('a.md', 'project-a');
    const sessionId = opened.document!.sessionId;

    const rejected = await client.applyEdit(sessionId, '# no view\n', opened.document!.baseVersion);
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.errorCode, 'ERR_COMMAND_INVALID');

    // 带 viewId 则成功
    const ok = await client.applyEdit(
      sessionId,
      '# with view\n',
      opened.document!.baseVersion,
      opened.document!.viewId,
    );
    assert.equal(ok.status, 'APPLIED');
  });
});

// ---------------------------------------------------------------------------
// UI-03 disk 读取走会话归属项目
// ---------------------------------------------------------------------------
test('UI-03b readDisk 读取会话所属项目，不被同名文件误导', async () => {
  await withMulti(async ({ client, rootB }) => {
    const opened = await client.openDocument('a.md', 'project-a');
    await writeFile(join(rootB, 'a.md'), '# B changed\n', 'utf8');
    const disk = await client.readDisk(opened.document!.sessionId, opened.document!.viewId);
    assert.equal(disk.status, 'APPLIED');
    if (disk.status === 'APPLIED') assert.equal(disk.content, '# A\n');
  });
});

// ---------------------------------------------------------------------------
// UI-14 项目级保存失败不返回正文
// ---------------------------------------------------------------------------
test('UI-14 项目根失效后保存失败：响应不带 content，dirty 仍为真', async () => {
  await withMulti(async ({ client, rootA }) => {
    const opened = await client.openDocument('a.md', 'project-a');
    const sessionId = opened.document!.sessionId;
    await client.applyEdit(sessionId, '# draft\n', opened.document!.baseVersion, opened.document!.viewId);

    await rm(rootA, { recursive: true, force: true });
    const saved = await client.saveDocument(
      sessionId,
      opened.document!.baseVersion as string,
      opened.document!.viewId,
    );
    assert.equal(saved.status, 'FAILED');
    assert.equal(saved.errorCode, 'ERR_PROJECT_UNAVAILABLE');
    assert.equal(saved.document?.content, undefined, '失败响应不得包含正文（UI 不得据此清空缓冲）');
    assert.equal(saved.document?.dirty, true);

    // 合法 view 仍可取回草稿（G-DRAFT），证明"失败 ≠ 丢失"
    const draft = await client.readDocument(sessionId, opened.document!.viewId);
    assert.equal(draft.status, 'APPLIED');
    assert.equal(draft.document?.content, '# draft\n');
    assert.equal(draft.document?.stale?.reason, 'ERR_PROJECT_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// UI-18 Demo：不依赖 Host，也不触盘
// ---------------------------------------------------------------------------
test('UI-18 Demo 客户端不接触 Host：模式为 legacy、无项目、保存仅为 DEMO', async () => {
  const demo = createDemoClient(DEMO_NODES, DEMO_CONTENTS);
  assert.equal(demo.mode, 'demo');
  assert.equal(await demo.workspaceMode(), 'legacy');
  assert.deepEqual(await demo.listProjects(), []);

  const first = DEMO_NODES[0];
  const fileNode = first.children?.find((node) => node.kind === 'file');
  assert.ok(fileNode, '演示树必须至少有一个文件');

  const opened = await demo.openDocument(fileNode.id);
  assert.equal(opened.status, 'APPLIED');
  const saved = await demo.saveDocument(opened.document!.sessionId, '');
  assert.equal(saved.status, 'DEMO', '演示保存不得冒充 COMMITTED');
});
