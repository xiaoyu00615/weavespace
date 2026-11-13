/**
 * S11-C-R1 · 完整工作区身份（WK-01…WK-04）。
 *
 * 摘要的作用只有一件事：判断"这次连上的 Host 是不是上次那个工作区"，据此决定
 * 能不能用记录里的标签去发文件请求。它**不是**授权凭据。
 *
 * 因此摘要必须把"配置里的全部项目"算进去——只算 READY 的项目会得出一个错误结论：
 * "只配了 A" 与 "配了 A + B（B 的根缺失）" 会得到同一个摘要，两个工作区互相认领标签。
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createShellServer } from '../../apps/server/src/server.ts';
import { createLiveClient } from '../../apps/shell/src/client/client-api.ts';
import { makeRoots, startConfiguredHost } from '../helpers/s11c-harness.ts';
import type { WorkspaceConfig } from '../../packages/project-registry/index.ts';

interface ProjectInput {
  projectId: string;
  name: string;
  rootDir: string;
}

function config(projects: ProjectInput[]): WorkspaceConfig {
  return { version: 1, projects };
}

async function keyOf(url: string): Promise<string | null> {
  const identity = await createLiveClient(url).workspaceIdentity();
  return identity.workspaceKey;
}

// ---------------------------------------------------------------------------
// WK-01 只配 A 与 配 A+B（B 不可用）不得同摘要
// ---------------------------------------------------------------------------
test('WK-01 只配置 A 与"配置 A + B（B 根缺失）"必须得到不同摘要', async () => {
  const roots = await makeRoots('ws-s11c-r1-wk01-');
  const missingRoot = join(roots.base, 'project-b-missing');
  const onlyA = await startConfiguredHost(
    config([{ projectId: 'project-a', name: '项目 A', rootDir: roots.rootA }]),
  );
  const aPlusUnavailableB = await startConfiguredHost(
    config([
      { projectId: 'project-a', name: '项目 A', rootDir: roots.rootA },
      { projectId: 'project-b', name: '项目 B', rootDir: missingRoot },
    ]),
  );
  try {
    const keyOnlyA = await keyOf(onlyA.url);
    const keyAB = await keyOf(aPlusUnavailableB.url);
    assert.ok(keyOnlyA, 'A 可用时必须提供摘要');
    assert.ok(keyAB, '有一个可用项目时也必须提供摘要');
    assert.notEqual(keyOnlyA, keyAB, '项目组合不同就是不同工作区，不可互相认领标签');

    // 前提：B 只是不可用，没有拖累 A
    const projects = await createLiveClient(aPlusUnavailableB.url).listProjects();
    assert.equal(projects.find((project) => project.projectId === 'project-a')?.status, 'READY');
    assert.equal(projects.find((project) => project.projectId === 'project-b')?.status, 'UNAVAILABLE');
  } finally {
    await onlyA.close();
    await aPlusUnavailableB.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// WK-02 Host 重启摘要稳定
// ---------------------------------------------------------------------------
test('WK-02 同一份配置、未改动的根：Host 重启后摘要保持不变', async () => {
  const roots = await makeRoots('ws-s11c-r1-wk02-');
  const input = config([
    { projectId: 'project-a', name: '项目 A', rootDir: roots.rootA },
    { projectId: 'project-b', name: '项目 B', rootDir: roots.rootB },
    // 不可用项目也要稳定：否则每次重启都会换一个摘要，等于永远无法恢复
    { projectId: 'project-c', name: '项目 C', rootDir: roots.rootC },
  ]);
  const first = await startConfiguredHost(input);
  let key1: string | null = null;
  try {
    key1 = await keyOf(first.url);
  } finally {
    await first.close();
  }
  const second = await startConfiguredHost(input);
  try {
    const key2 = await keyOf(second.url);
    assert.ok(key1);
    assert.equal(key2, key1, '重启不该换摘要');
  } finally {
    await second.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// WK-03 根替换 / 项目新增 / 项目删除都不得错误匹配
// ---------------------------------------------------------------------------
test('WK-03 根被替换、项目新增、项目删除都会改变摘要', async () => {
  const roots = await makeRoots('ws-s11c-r1-wk03-');
  const other = await makeRoots('ws-s11c-r1-wk03r-');
  try {
    // (a) 同一个 projectId，根换成另一份目录（内容、inode 都不同）
    const beforeReplace = await startConfiguredHost(
      config([{ projectId: 'project-a', name: '项目 A', rootDir: roots.rootA }]),
    );
    const afterReplace = await startConfiguredHost(
      config([{ projectId: 'project-a', name: '项目 A', rootDir: other.rootA }]),
    );
    // (b) 新增一个 READY 项目
    const oneProject = await startConfiguredHost(
      config([{ projectId: 'project-a', name: '项目 A', rootDir: roots.rootA }]),
    );
    const twoProjects = await startConfiguredHost(
      config([
        { projectId: 'project-a', name: '项目 A', rootDir: roots.rootA },
        { projectId: 'project-b', name: '项目 B', rootDir: roots.rootB },
      ]),
    );
    try {
      const kRoot1 = await keyOf(beforeReplace.url);
      const kRoot2 = await keyOf(afterReplace.url);
      assert.ok(kRoot1 && kRoot2);
      assert.notEqual(kRoot1, kRoot2, '根被替换后不得匹配旧工作区');

      const kOne = await keyOf(oneProject.url);
      const kTwo = await keyOf(twoProjects.url);
      assert.ok(kOne && kTwo);
      assert.notEqual(kOne, kTwo, '新增项目后不得匹配旧工作区');

      // (c) 删除项目：kTwo（A+B）与 kOne（A）必然不同——同一个断言的另一侧
      assert.notEqual(kTwo, kOne, '删除项目后不得匹配旧工作区');
      // 两条路径算出来的"只有一个 A"必须是同一个摘要（说明组合语义与顺序无关）
      assert.equal(kRoot1, kOne);
    } finally {
      await beforeReplace.close();
      await afterReplace.close();
      await oneProject.close();
      await twoProjects.close();
    }
  } finally {
    await roots.cleanup();
    await other.cleanup();
  }
});

// ---------------------------------------------------------------------------
// WK-04 浏览器拿不到任何路径或根令牌
// ---------------------------------------------------------------------------
test('WK-04 /api/health 与 /api/projects 都不泄露绝对路径、根令牌或 provider', async () => {
  const roots = await makeRoots('ws-s11c-r1-wk04-');
  const host = await startConfiguredHost(
    config([
      { projectId: 'project-a', name: '项目 A', rootDir: roots.rootA },
      { projectId: 'project-b', name: '项目 B', rootDir: roots.rootB },
      { projectId: 'project-c', name: '项目 C', rootDir: roots.rootC },
    ]),
  );
  try {
    const healthText = await (await fetch(`${host.url}/api/health`)).text();
    const health = JSON.parse(healthText) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(health).sort(),
      ['mode', 'status', 'workspaceKey', 'workspaceMode'],
      '健康响应只允许这几个字段',
    );
    for (const forbidden of ['rootDir', 'canonicalRoot', 'rootToken', 'providerId', 'projects']) {
      assert.equal(healthText.includes(forbidden), false, `健康响应不得包含 ${forbidden}`);
    }
    assert.equal(healthText.includes(roots.base), false, '不得出现本机绝对路径');
    assert.equal(/[A-Za-z]:\\\\/.test(healthText), false, '不得出现 Windows 盘符路径');
    assert.equal(/["\s]\/(home|Users|tmp|var)\//.test(healthText), false, '不得出现 POSIX 绝对路径');

    const projectsText = await (await fetch(`${host.url}/api/projects`)).text();
    for (const forbidden of ['rootDir', 'canonicalRoot', 'rootToken', 'providerId']) {
      assert.equal(projectsText.includes(forbidden), false, `项目列表不得包含 ${forbidden}`);
    }
    assert.equal(projectsText.includes(roots.base), false, '项目列表不得出现本机绝对路径');
    const payload = JSON.parse(projectsText) as { projects: Array<Record<string, unknown>> };
    for (const project of payload.projects) {
      const keys = Object.keys(project).filter((key) => key !== 'reason').sort();
      assert.deepEqual(keys, ['name', 'projectId', 'status'], '项目摘要只有这三个字段');
    }

    // 客户端侧也只保留摘要与模式
    const identity = await createLiveClient(host.url).workspaceIdentity();
    assert.deepEqual(Object.keys(identity).sort(), ['workspaceKey', 'workspaceMode']);
    assert.match(String(identity.workspaceKey), /^[0-9a-f]{64}$/);
  } finally {
    await host.close();
    await roots.cleanup();
  }
});

// ---------------------------------------------------------------------------
// WK-04b Legacy 同样不泄露根
// ---------------------------------------------------------------------------
test('WK-04b Legacy 模式下健康响应同样只有摘要，没有根目录', async () => {
  const roots = await makeRoots('ws-s11c-r1-wk04b-');
  const server = await createShellServer({ rootDir: roots.rootA, port: 0 });
  try {
    const text = await (await fetch(`${server.url}/api/health`)).text();
    assert.equal(text.includes(roots.rootA), false);
    assert.equal(text.includes('rootDir'), false);
    const body = JSON.parse(text) as { workspaceKey?: string; workspaceMode?: string };
    assert.equal(body.workspaceMode, 'legacy');
    assert.match(String(body.workspaceKey), /^[0-9a-f]{64}$/);
  } finally {
    await server.close();
    await roots.cleanup();
  }
});
