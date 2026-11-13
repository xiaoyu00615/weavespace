/**
 * S11-A1-G1-R1：CommandBus 项目/Provider 身份一致性（Core 级）。
 *
 * 背景：Multi 下 `providerId` 必须来自可信 Registry，payload 里的声明最多用于
 * 一致性校验。本轮修复前，payload 可以声明 `projectId=project-a` 却指定
 * `providerId=local:project-b` 或 `resourceId=doc:project-b/a.md`，从而越过项目边界。
 *
 * 本套件只操作自建临时目录，不依赖 Host/HTTP。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCommandBus, type CommandBus } from '../../packages/command/index.ts';
import { createDocumentService, type DocumentService } from '../../packages/document/index.ts';
import { createPermissionService, type PermissionService } from '../../packages/permission/index.ts';
import { createLocalProvider } from '../../packages/storage/index.ts';
import type { StorageProvider } from '../../packages/storage/index.ts';

const ACTOR = 'local-user';

interface CoreCtx {
  rootA: string;
  rootB: string;
  document: DocumentService;
  permission: PermissionService;
  bus: CommandBus;
  cleanup(): Promise<void>;
}

/** Multi 风格的 Core 装配：两项目、两 Provider、项目门禁。 */
async function withCore(
  fn: (ctx: CoreCtx) => Promise<void>,
  options: { grants?: 'both' | 'a-only'; withGate?: boolean } = {},
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-g1c-'));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(rootA, { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');
  await writeFile(join(rootB, 'a.md'), '# B\n', 'utf8');

  const providerA: StorageProvider = createLocalProvider({ rootDir: rootA, providerId: 'local:project-a' });
  const providerB: StorageProvider = createLocalProvider({ rootDir: rootB, providerId: 'local:project-b' });
  const providers = new Map<string, StorageProvider>([
    [providerA.providerId, providerA],
    [providerB.providerId, providerB],
  ]);

  const grants =
    options.grants === 'a-only'
      ? (['project-a'] as const)
      : (['project-a', 'project-b'] as const);
  const permission = createPermissionService(
    [...grants].flatMap((projectId) => [
      { actorId: ACTOR, action: 'read' as const, scope: '', providerId: `local:${projectId}` },
      { actorId: ACTOR, action: 'write' as const, scope: '', providerId: `local:${projectId}` },
    ]),
  );

  const document = createDocumentService();
  const bus = createCommandBus({
    document,
    permission,
    resolveProvider: (providerId) => providers.get(providerId),
    requireProjectId: true,
    ...(options.withGate === false
      ? {}
      : {
          gate: {
            resolveProject: (projectId: string) => ({ providerId: `local:${projectId}` }),
          },
        }),
  });

  try {
    await fn({ rootA, rootB, document, permission, bus, cleanup: async () => undefined });
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

function openCommand(projectId: string, extra: Record<string, unknown> = {}) {
  return {
    commandId: `cmd-${projectId}-${Math.random().toString(16).slice(2, 8)}`,
    type: 'document.open',
    payload: {
      path: 'a.md',
      projectId,
      resourceId: `doc:${projectId}/a.md`,
      providerId: `local:${projectId}`,
      ...extra,
    },
  };
}

// ---------------------------------------------------------------------------
// C-01 声明 project-a，却提供 project-b 的 providerId
// ---------------------------------------------------------------------------
test('C-01 声明 project-a 但 providerId 指向 project-b：必须拒绝，且不建立会话', async () => {
  await withCore(async ({ bus, document }) => {
    const outcome = await bus.dispatch(
      openCommand('project-a', { providerId: 'local:project-b' }) as never,
      { actorId: ACTOR },
    );
    assert.equal(outcome.status, 'REJECTED', '混合 providerId 必须被拒绝');
    assert.equal(outcome.errorCode, 'ERR_COMMAND_INVALID');
    // 不得产生任何会话（两个项目都不该被打开）
    assert.equal(document.getSessionByResource('doc:project-a/a.md'), undefined);
    assert.equal(document.getSessionByResource('doc:project-b/a.md'), undefined);
  });
});

// ---------------------------------------------------------------------------
// C-02 声明 project-a，却提供 project-b 的 resourceId
// ---------------------------------------------------------------------------
test('C-02 声明 project-a 但 resourceId 指向 project-b：必须拒绝', async () => {
  await withCore(async ({ bus, document }) => {
    const outcome = await bus.dispatch(
      openCommand('project-a', { resourceId: 'doc:project-b/a.md' }) as never,
      { actorId: ACTOR },
    );
    assert.equal(outcome.status, 'REJECTED');
    assert.equal(outcome.errorCode, 'ERR_COMMAND_INVALID');
    assert.equal(document.getSessionByResource('doc:project-b/a.md'), undefined);
  });
});

// ---------------------------------------------------------------------------
// C-03 两个项目都已授权，混合身份仍必须拒绝
// ---------------------------------------------------------------------------
test('C-03 两项目均已授权时，混合身份仍然必须拒绝', async () => {
  await withCore(
    async ({ bus }) => {
      const mixedProvider = await bus.dispatch(
        openCommand('project-a', { providerId: 'local:project-b' }) as never,
        { actorId: ACTOR },
      );
      assert.equal(mixedProvider.status, 'REJECTED');
      assert.equal(mixedProvider.errorCode, 'ERR_COMMAND_INVALID');

      const mixedResource = await bus.dispatch(
        openCommand('project-b', { resourceId: 'doc:project-a/a.md' }) as never,
        { actorId: ACTOR },
      );
      assert.equal(mixedResource.status, 'REJECTED');
      assert.equal(mixedResource.errorCode, 'ERR_COMMAND_INVALID');
    },
    { grants: 'both' },
  );
});

// ---------------------------------------------------------------------------
// C-04 正确的 A / B 分别能打开各自文件
// ---------------------------------------------------------------------------
test('C-04 正确身份下 A、B 各自打开自己的文件', async () => {
  await withCore(async ({ bus, document, rootA, rootB }) => {
    const a = await bus.dispatch(openCommand('project-a') as never, { actorId: ACTOR });
    const b = await bus.dispatch(openCommand('project-b') as never, { actorId: ACTOR });
    assert.equal(a.status, 'APPLIED');
    assert.equal(b.status, 'APPLIED');

    const handleA = a.result as { sessionId: string; resourceId: string };
    const handleB = b.result as { sessionId: string; resourceId: string };
    assert.equal(handleA.resourceId, 'doc:project-a/a.md');
    assert.equal(handleB.resourceId, 'doc:project-b/a.md');
    assert.notEqual(handleA.sessionId, handleB.sessionId);

    assert.equal(document.getBuffer(handleA.sessionId), '# A\n');
    assert.equal(document.getBuffer(handleB.sessionId), '# B\n');
    assert.equal(document.inspectSession(handleA.sessionId)?.projectId, 'project-a');
    assert.equal(document.inspectSession(handleB.sessionId)?.projectId, 'project-b');
    assert.equal(document.inspectSession(handleA.sessionId)?.providerId, 'local:project-a');

    // 保存必须落到各自项目根
    document.applyEdit(handleA.sessionId, '# A2\n');
    const saved = await bus.dispatch(
      {
        commandId: 'cmd-save-a',
        type: 'document.save',
        expectedVersion: document.getSession(handleA.sessionId)?.baseVersion as string,
        payload: { sessionId: handleA.sessionId },
      } as never,
      { actorId: ACTOR },
    );
    assert.equal(saved.status, 'APPLIED');
    assert.equal(await readFile(join(rootA, 'a.md'), 'utf8'), '# A2\n');
    assert.equal(await readFile(join(rootB, 'a.md'), 'utf8'), '# B\n');
  });
});

// ---------------------------------------------------------------------------
// C-05 Legacy 调用保持兼容（无 gate / 无 requireProjectId）
// ---------------------------------------------------------------------------
test('C-05 Legacy 总线调用（无项目门禁）保持原行为', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-g1c-legacy-'));
  const root = join(base, 'project');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'a.md'), '# legacy\n', 'utf8');
  const provider = createLocalProvider({ rootDir: root });
  const document = createDocumentService();
  const permission = createPermissionService([
    { actorId: ACTOR, action: 'read', scope: '' },
    { actorId: ACTOR, action: 'write', scope: '' },
  ]);
  const bus = createCommandBus({
    document,
    permission,
    resolveProvider: (providerId) => (providerId === provider.providerId ? provider : undefined),
  });
  try {
    const outcome = await bus.dispatch(
      {
        commandId: 'cmd-legacy-open',
        type: 'document.open',
        payload: { path: 'a.md', resourceId: 'doc:a.md' },
      } as never,
      { actorId: ACTOR },
    );
    assert.equal(outcome.status, 'APPLIED');
    const handle = outcome.result as { sessionId: string; resourceId: string };
    assert.equal(handle.resourceId, 'doc:a.md');
    assert.equal(document.getBuffer(handle.sessionId), '# legacy\n');
    assert.equal(document.inspectSession(handle.sessionId)?.projectId, undefined);
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});
