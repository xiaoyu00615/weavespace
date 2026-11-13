/**
 * S11-A1-G0-R1：Host 层错误状态映射（缺口 3）。
 *
 * 目标：经 CommandBus 返回的根连续性失败必须以 503 表达，而**不得**被误映射为
 * 404（不存在）/409（冲突）/500（内部错误）；同时 UNKNOWN 仍为 202、CONFLICT 仍为 409。
 *
 * 全部用例只操作自建临时目录；服务在进程内启动（端口 0）。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createShellServer } from '../../apps/server/src/server.ts';
import type { StorageFaultHooks } from '../../packages/storage/index.ts';

const sha = (content: string): string => `sha256:${createHash('sha256').update(content).digest('hex')}`;

interface ApiResponse {
  status: number;
  // 测试内按字段取值，换取断言可读性（不影响生产代码）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function withServer(
  fn: (ctx: {
    root: string;
    api(path: string, init?: RequestInit): Promise<ApiResponse>;
    post(path: string, body: unknown): Promise<ApiResponse>;
    removeRoot(): Promise<void>;
  }) => Promise<void>,
  options: { faults?: StorageFaultHooks; files?: Record<string, string> } = {},
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-g0r1-'));
  const root = join(base, 'project');
  await mkdir(root, { recursive: true });
  for (const [rel, content] of Object.entries(options.files ?? { 'a.md': '# A\n' })) {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }

  const server = await createShellServer({ rootDir: root, port: 0, providerFaults: options.faults });
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
      root,
      api,
      post,
      removeRoot: async () => {
        await rm(root, { recursive: true, force: true });
      },
    });
  } finally {
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// H-01 /api/open：根失效 → 503，不得 404
// ---------------------------------------------------------------------------
test('H-01 /api/open 在根失效后返回 503，且不伪装成资源不存在', async () => {
  await withServer(async ({ post, removeRoot }) => {
    await removeRoot();
    const res = await post('/api/open', { path: 'a.md' });
    assert.equal(res.status, 503, '根不可用必须是 503');
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.errorCode, 'ERR_ROOT_CHANGED');
  });
});

// ---------------------------------------------------------------------------
// H-02 /api/save：根失效 → 503 + FAILED + 草稿保留
// ---------------------------------------------------------------------------
test('H-02 /api/save 在根失效后返回 503，保留 FAILED 语义与未保存草稿', async () => {
  await withServer(async ({ api, post, removeRoot }) => {
    const opened = await post('/api/open', { path: 'a.md' });
    assert.equal(opened.status, 200);
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;
    const baseVersion = opened.body.document.baseVersion as string;

    const edited = await post('/api/edit', { sessionId, viewId, buffer: '# edited\n' });
    assert.equal(edited.status, 200, '编辑只改内存缓冲，不需要磁盘');

    await removeRoot();

    const saved = await post('/api/save', { sessionId, viewId, expectedVersion: baseVersion });
    assert.equal(saved.status, 503, '根不可用必须是 503（不是 409/422/500）');
    assert.equal(saved.body.status, 'FAILED', '响应体状态仍为 FAILED');
    assert.equal(saved.body.errorCode, 'ERR_ROOT_CHANGED');
    assert.equal(saved.body.document.dirty, true, 'dirty 语义必须保留');

    // 草稿仍可读回（不因根失效而丢失）
    const read = await api(`/api/document?sessionId=${sessionId}&viewId=${viewId}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.document.content, '# edited\n');
    assert.equal(read.body.document.dirty, true);
  });
});

// ---------------------------------------------------------------------------
// H-03 /api/document/disk：根失效 → 503
// ---------------------------------------------------------------------------
test('H-03 /api/document/disk 在根失效后返回 503', async () => {
  await withServer(async ({ api, post, removeRoot }) => {
    const opened = await post('/api/open', { path: 'a.md' });
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;
    await removeRoot();

    const disk = await api(`/api/document/disk?sessionId=${sessionId}&viewId=${viewId}`);
    assert.equal(disk.status, 503);
    assert.equal(disk.body.errorCode, 'ERR_ROOT_CHANGED');
  });
});

// ---------------------------------------------------------------------------
// H-04 UNKNOWN 仍为 202（不得被本次映射改动波及）
// ---------------------------------------------------------------------------
test('H-04 保存结果 UNKNOWN 仍返回 202', async () => {
  await withServer(
    async ({ post }) => {
      const opened = await post('/api/open', { path: 'a.md' });
      const sessionId = opened.body.document.sessionId as string;
      const viewId = opened.body.document.viewId as string;
      const baseVersion = opened.body.document.baseVersion as string;
      await post('/api/edit', { sessionId, viewId, buffer: '# edited\n' });

      const saved = await post('/api/save', { sessionId, viewId, expectedVersion: baseVersion });
      assert.equal(saved.status, 202, 'UNKNOWN 不是失败，仍为 202');
      assert.equal(saved.body.status, 'UNKNOWN');
      assert.equal(saved.body.errorCode, 'ERR_OUTCOME_UNKNOWN');
    },
    {
      faults: {
        afterCommit: () => {
          throw new Error('injected: 确认链中断');
        },
      },
    },
  );
});

// ---------------------------------------------------------------------------
// H-05 正常冲突仍为 409
// ---------------------------------------------------------------------------
test('H-05 磁盘版本变化导致 CONFLICT 时仍返回 409', async () => {
  await withServer(async ({ post, root }) => {
    const opened = await post('/api/open', { path: 'a.md' });
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;
    const baseVersion = opened.body.document.baseVersion as string;

    await post('/api/edit', { sessionId, viewId, buffer: '# mine\n' });
    await writeFile(join(root, 'a.md'), '# external\n', 'utf8');

    const saved = await post('/api/save', { sessionId, viewId, expectedVersion: baseVersion });
    assert.equal(saved.status, 409, '版本冲突仍是 409');
    assert.equal(saved.body.status, 'CONFLICT');
    assert.equal(saved.body.errorCode, 'ERR_DOCUMENT_VERSION_CONFLICT');
  });
});

// ---------------------------------------------------------------------------
// H-06 正常保存不受影响（回归护栏）
// ---------------------------------------------------------------------------
test('H-06 根正常时保存仍为 200 / COMMITTED', async () => {
  await withServer(async ({ post, root }) => {
    const opened = await post('/api/open', { path: 'a.md' });
    const sessionId = opened.body.document.sessionId as string;
    const viewId = opened.body.document.viewId as string;
    const baseVersion = opened.body.document.baseVersion as string;
    await post('/api/edit', { sessionId, viewId, buffer: '# ok\n' });

    const saved = await post('/api/save', { sessionId, viewId, expectedVersion: baseVersion });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.status, 'COMMITTED');
    assert.equal(saved.body.document.dirty, false);
    assert.equal(await (await import('node:fs/promises')).readFile(join(root, 'a.md'), 'utf8'), '# ok\n');
    assert.equal(sha('# ok\n').length, saved.body.contentVersion.length);
  });
});

// ---------------------------------------------------------------------------
// H-07 /api/resources：根失效 → 503，且不泄露本机绝对路径（G0-R2）
// ---------------------------------------------------------------------------
test('H-07 /api/resources 在根失效后返回 503，不泄露路径也不重建根', async () => {
  await withServer(async ({ api, root, removeRoot }) => {
    const before = await api('/api/resources');
    assert.equal(before.status, 200, '前置：根正常时资源树必须可用');

    await removeRoot();

    const res = await api('/api/resources');
    assert.equal(res.status, 503, '根不可用时资源树必须是 503，而不是 500');
    assert.equal(res.body.errorCode, 'ERR_ROOT_CHANGED', '必须保留可识别的根错误码');

    // 不得返回任何本机绝对路径（含盘符路径、真实根目录、其父目录）
    const text = JSON.stringify(res.body);
    assert.equal(text.includes(root), false, `响应不得包含真实根目录: ${text}`);
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]/, `响应不得出现盘符路径: ${text}`);
    const message = typeof res.body.message === 'string' ? res.body.message : '';
    assert.doesNotMatch(message, /[A-Za-z]:[\\/]/, `错误消息不得包含路径: ${message}`);

    assert.equal(existsSync(root), false, '不得因资源树请求而重建根目录');
  });
});

// ---------------------------------------------------------------------------
// H-08 /api/resources：根正常 → 200 + 正确文件树（回归护栏）
// ---------------------------------------------------------------------------
test('H-08 /api/resources 根正常时返回 200 与文件树', async () => {
  await withServer(
    async ({ api }) => {
      const res = await api('/api/resources');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'APPLIED');
      assert.ok(Array.isArray(res.body.nodes));
      const flat = JSON.stringify(res.body.nodes);
      assert.match(flat, /a\.md/);
      assert.match(flat, /b\.md/);
      // 二进制/非文本不进树（沿用既有规则）
      assert.doesNotMatch(flat, /c\.png/);
    },
    { files: { 'a.md': '# A\n', 'docs/b.md': '# B\n', 'bin/c.png': 'not-listed' } },
  );
});
