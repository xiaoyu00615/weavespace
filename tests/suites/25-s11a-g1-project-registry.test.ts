/**
 * S11-A1-G1：Project Registry（配置校验 / 根可用性 / 身份命名空间）。
 *
 * 纪律与 S4/S8/G0 一致：
 * - 只操作自建临时目录（`os.tmpdir()/ws-g1r-*`），不触碰真实项目；
 * - 断言同时检查「状态」与「真实文件系统副作用/内部字段是否泄露」；
 * - 无法在当前环境构造的场景（junction）标记 NOT_RUN，不记为 PASS。
 */
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createProjectRegistry,
  inspectProjectRoot,
  validateWorkspaceConfig,
  type WorkspaceConfig,
} from '../../packages/project-registry/index.ts';

const errorCodeOf = (fn: () => unknown): string => {
  try {
    fn();
    return 'NO_ERROR';
  } catch (err) {
    return (err as { errorCode?: string }).errorCode ?? `RAW:${(err as Error).message}`;
  }
};

interface Sandbox {
  base: string;
  rootA: string;
  rootB: string;
  cleanup(): Promise<void>;
}

async function withSandbox(fn: (sb: Sandbox) => Promise<void> | void): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-g1r-'));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');
  await writeFile(join(rootB, 'a.md'), '# B\n', 'utf8');
  try {
    await fn({
      base,
      rootA,
      rootB,
      cleanup: async () => {
        await rm(base, { recursive: true, force: true }).catch(() => {});
      },
    });
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

function configOf(projects: Array<{ projectId: string; name?: string; rootDir: string }>): WorkspaceConfig {
  return validateWorkspaceConfig({
    version: 1,
    projects: projects.map((p) => ({ projectId: p.projectId, name: p.name ?? p.projectId, rootDir: p.rootDir })),
  });
}

async function canCreateJunction(): Promise<boolean> {
  const base = await mkdtemp(join(tmpdir(), 'ws-g1r-cap-'));
  try {
    await mkdir(join(base, 'target'), { recursive: true });
    await symlink(join(base, 'target'), join(base, 'link'), 'junction');
    return true;
  } catch {
    return false;
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}
const HAS_JUNCTION = await canCreateJunction();
const NOT_RUN_J = HAS_JUNCTION ? false : 'NOT_RUN: 当前环境无法创建 junction';

// ---------------------------------------------------------------------------
// R-01 两个 READY 项目：身份独立，摘要不泄露内部字段
// ---------------------------------------------------------------------------
test('R-01 两个 READY 项目：身份独立，Summary 不含内部字段', async () => {
  await withSandbox(async ({ rootA, rootB }) => {
    const registry = createProjectRegistry({
      config: configOf([
        { projectId: 'project-a', name: '项目 A', rootDir: rootA },
        { projectId: 'project-b', name: '项目 B', rootDir: rootB },
      ]),
    });

    const list = registry.list();
    assert.equal(list.length, 2);
    assert.deepEqual(
      list.map((p) => [p.projectId, p.status]),
      [
        ['project-a', 'READY'],
        ['project-b', 'READY'],
      ],
    );
    for (const summary of list) {
      const keys = Object.keys(summary).sort();
      assert.deepEqual(keys, summary.reason ? ['name', 'projectId', 'reason', 'status'] : ['name', 'projectId', 'status']);
      assert.equal(JSON.stringify(summary).includes(rootA), false, 'Summary 不得包含 rootDir');
    }

    const a = registry.assertUsable('project-a');
    const b = registry.assertUsable('project-b');
    assert.equal(a.providerId, 'local:project-a');
    assert.equal(b.providerId, 'local:project-b');
    assert.notEqual(a.provider.providerId, b.provider.providerId);
    assert.equal(a.provider.rootDir, rootA);
    assert.equal(b.provider.rootDir, rootB);
    assert.equal(registry.version(), 1);
  });
});

// ---------------------------------------------------------------------------
// R-02 / R-03 根不存在 / 根是普通文件
// ---------------------------------------------------------------------------
test('R-02 项目根不存在 → UNAVAILABLE/MISSING，其他项目仍 READY', async () => {
  await withSandbox(async ({ base, rootA }) => {
    const registry = createProjectRegistry({
      config: configOf([
        { projectId: 'project-a', rootDir: rootA },
        { projectId: 'project-b', rootDir: join(base, 'missing-project') },
      ]),
    });
    const list = registry.list();
    assert.equal(list[0].status, 'READY');
    assert.equal(list[1].status, 'UNAVAILABLE');
    assert.equal(list[1].reason, 'MISSING');
    assert.equal(registry.providerOf('project-b'), undefined, 'UNAVAILABLE 项目不得有 Provider');

    assert.equal(
      errorCodeOf(() => registry.assertUsable('project-b')),
      'ERR_PROJECT_UNAVAILABLE',
    );
    assert.equal(existsSync(join(base, 'missing-project')), false, 'Registry 不得创建缺失的项目根');
  });
});

test('R-03 项目根是普通文件 → UNAVAILABLE/NOT_DIRECTORY', async () => {
  await withSandbox(async ({ base, rootA }) => {
    const fileRoot = join(base, 'not-a-dir.md');
    await writeFile(fileRoot, 'x', 'utf8');
    const registry = createProjectRegistry({
      config: configOf([
        { projectId: 'project-a', rootDir: rootA },
        { projectId: 'project-c', rootDir: fileRoot },
      ]),
    });
    assert.equal(registry.list()[1].reason, 'NOT_DIRECTORY');
    assert.equal(errorCodeOf(() => registry.assertUsable('project-c')), 'ERR_PROJECT_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// R-04 根是 junction
// ---------------------------------------------------------------------------
test('R-04 项目根是 junction → UNAVAILABLE/REPARSE_POINT', { skip: NOT_RUN_J }, async () => {
  await withSandbox(async ({ base, rootA }) => {
    const linkRoot = join(base, 'link-project');
    await symlink(rootA, linkRoot, 'junction');
    const registry = createProjectRegistry({
      config: configOf([
        { projectId: 'project-a', rootDir: rootA },
        { projectId: 'project-link', rootDir: linkRoot },
      ]),
    });
    const linkSummary = registry.list().find((p) => p.projectId === 'project-link');
    assert.equal(linkSummary?.status, 'UNAVAILABLE');
    assert.equal(linkSummary?.reason, 'REPARSE_POINT');
  });
});

// ---------------------------------------------------------------------------
// R-05 重复 / 嵌套 / 大小写等价根
// ---------------------------------------------------------------------------
test('R-05 重复、嵌套、Windows 大小写等价根必须在配置期拒绝', async () => {
  await withSandbox(async ({ base, rootA }) => {
    assert.equal(
      errorCodeOf(() =>
        configOf([
          { projectId: 'a', rootDir: rootA },
          { projectId: 'b', rootDir: rootA },
        ]),
      ),
      'ERR_PROJECT_DUPLICATE_ROOT',
    );

    assert.equal(
      errorCodeOf(() =>
        configOf([
          { projectId: 'a', rootDir: rootA },
          { projectId: 'b', rootDir: join(rootA, 'docs') },
        ]),
      ),
      'ERR_PROJECT_NESTED_ROOT',
    );

    if (process.platform === 'win32') {
      assert.equal(
        errorCodeOf(() =>
          configOf([
            { projectId: 'a', rootDir: rootA },
            { projectId: 'b', rootDir: rootA.toUpperCase() },
          ]),
        ),
        'ERR_PROJECT_DUPLICATE_ROOT',
        'Windows 上大小写等价路径必须视为同一根',
      );
    }

    // 正常的两级并列根不应误报
    assert.doesNotThrow(() =>
      configOf([
        { projectId: 'a', rootDir: rootA },
        { projectId: 'b', rootDir: join(base, 'project-b') },
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// R-06 UNC / 不支持的文件系统 / 非法配置
// ---------------------------------------------------------------------------
test('R-06 UNC 根 fail-closed；相对路径与环境变量占位符在配置期拒绝', async () => {
  await withSandbox(async ({ rootA }) => {
    const uncInspection = inspectProjectRoot('\\\\server\\share\\project');
    assert.equal(uncInspection.status, 'UNAVAILABLE');
    if (uncInspection.status === 'UNAVAILABLE') assert.equal(uncInspection.reason, 'UNC_UNSUPPORTED');

    const registry = createProjectRegistry({
      config: configOf([
        { projectId: 'project-a', rootDir: rootA },
        { projectId: 'project-unc', rootDir: '\\\\server\\share\\project' },
      ]),
    });
    assert.equal(registry.list()[1].status, 'UNAVAILABLE');
    assert.equal(registry.list()[1].reason, 'UNC_UNSUPPORTED');

    assert.equal(
      errorCodeOf(() => configOf([{ projectId: 'x', rootDir: 'relative/project' }])),
      'ERR_PROJECT_CONFIG_INVALID',
      '相对路径必须拒绝',
    );
    assert.equal(
      errorCodeOf(() => configOf([{ projectId: 'x', rootDir: '%USERPROFILE%\\project' }])),
      'ERR_PROJECT_CONFIG_INVALID',
      '环境变量占位符必须拒绝',
    );
    assert.equal(
      errorCodeOf(() => configOf([{ projectId: 'Bad Id!', rootDir: rootA }])),
      'ERR_PROJECT_CONFIG_INVALID',
      'projectId 非法字符必须拒绝',
    );
  });
});

// ---------------------------------------------------------------------------
// R-07 根删除 / 移动 / 替换 → 项目失效，磁盘不被重建
// ---------------------------------------------------------------------------
test('R-07 根删除/移动/替换后项目失效，且不重建根', async () => {
  await withSandbox(async ({ base, rootA }) => {
    const registry = createProjectRegistry({
      config: configOf([
        { projectId: 'project-a', rootDir: rootA },
        { projectId: 'project-b', rootDir: join(base, 'project-b') },
      ]),
    });
    assert.equal(registry.list()[0].status, 'READY');

    await rm(rootA, { recursive: true, force: true });
    assert.equal(errorCodeOf(() => registry.assertUsable('project-a')), 'ERR_PROJECT_UNAVAILABLE');
    assert.equal(existsSync(rootA), false, '不得重建被删除的根');
    assert.equal(registry.list()[0].status, 'UNAVAILABLE');
    assert.equal(registry.providerOf('project-a'), undefined, '失效项目不得再提供 Provider');

    // 即使同名目录后来出现，也不做"无证据的自动恢复"
    await mkdir(rootA, { recursive: true });
    assert.equal(errorCodeOf(() => registry.assertUsable('project-a')), 'ERR_PROJECT_UNAVAILABLE');
  });

  await withSandbox(async ({ base, rootA }) => {
    const registry = createProjectRegistry({
      config: configOf([
        { projectId: 'project-a', rootDir: rootA },
        { projectId: 'project-b', rootDir: join(base, 'project-b') },
      ]),
    });
    const moved = join(base, 'moved-a');
    await rename(rootA, moved);
    assert.equal(errorCodeOf(() => registry.assertUsable('project-a')), 'ERR_PROJECT_UNAVAILABLE');
    assert.equal(existsSync(rootA), false, '移动后旧路径不得被重建');
  });
});

// ---------------------------------------------------------------------------
// R-08 BigInt 根令牌
// ---------------------------------------------------------------------------
test('R-08 根令牌必须与 bigint stat 逐字段一致', async () => {
  await withSandbox(async ({ rootA }) => {
    const registry = createProjectRegistry({ config: configOf([{ projectId: 'project-a', rootDir: rootA }]) });
    const handle = registry.assertUsable('project-a');
    const s = statSync(rootA, { bigint: true });
    assert.equal(handle.rootToken, `${s.dev}:${s.ino}:${s.birthtimeNs}`);
    assert.doesNotMatch(handle.rootToken, /e\+|\.\d/, '令牌不得是浮点/科学计数法');
  });
});

// ---------------------------------------------------------------------------
// R-09 同一资源在不同项目下身份不同
// ---------------------------------------------------------------------------
test('R-09 两项目同名文件：Provider 身份与 Provider 实例都不相同', async () => {
  await withSandbox(async ({ rootA, rootB }) => {
    const registry = createProjectRegistry({
      config: configOf([
        { projectId: 'project-a', rootDir: rootA },
        { projectId: 'project-b', rootDir: rootB },
      ]),
    });
    const a = registry.assertUsable('project-a');
    const b = registry.assertUsable('project-b');
    assert.notEqual(a.provider, b.provider);
    assert.notEqual(a.rootToken, b.rootToken);
    // 同一个项目的重复访问必须返回同一身份（稳定）
    assert.equal(registry.assertUsable('project-a').providerId, a.providerId);
    assert.equal(registry.assertUsable('project-a').rootToken, a.rootToken);
  });
});
