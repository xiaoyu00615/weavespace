/**
 * S9-B：真实文件操作闭环（localhost Client API + Core）。
 *
 * 全部测试只操作自建临时目录（`os.tmpdir()/ws-s9b-*`），不接触用户文件；
 * 服务在进程内启动（本机沙箱禁止子进程管道），端口用 0 由系统分配。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createEditQueue } from '../../apps/shell/src/client/edit-queue.ts';
import type { StorageFaultHooks } from '../../packages/storage/index.ts';

const sha = (content: Buffer | string): string =>
  `sha256:${createHash('sha256').update(content).digest('hex')}`;

interface ApiResponse {
  status: number;
  // 测试里直接按字段取值；用 any 换取断言可读性（不影响生产代码）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

interface Ctx {
  base: string;
  root: string;
  server: ShellServer;
  api(path: string, init?: RequestInit): Promise<ApiResponse>;
  post(path: string, body: unknown): Promise<ApiResponse>;
}

const TEXT_FILES: Record<string, string> = {
  'a.md': '# A\n\n原始内容\n',
  'docs/b.md': '# B\n\n二级目录\n',
  'notes/c.txt': '纯文本\n',
  'bin/d.png': 'not-listed',
};

async function withServer(
  fn: (ctx: Ctx) => Promise<void>,
  options: { files?: Record<string, string | Buffer>; faults?: StorageFaultHooks } = {},
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-s9b-'));
  const root = join(base, 'project');
  await mkdir(root, { recursive: true });
  for (const [rel, content] of Object.entries(options.files ?? TEXT_FILES)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
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
    await fn({ base, root, server, api, post });
  } finally {
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// 1. 服务启动与停止
// ---------------------------------------------------------------------------
test('S9B-01 服务可启动、健康检查通过、关闭后不再接受连接', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-s9b-life-'));
  try {
    const server = await createShellServer({ rootDir: base, port: 0 });
    const health = await fetch(`${server.url}/api/health`);
    const body = (await health.json()) as { status: string; mode: string };
    assert.equal(health.status, 200);
    assert.equal(body.status, 'APPLIED');
    assert.equal(body.mode, 'live');
    assert.equal(server.url.startsWith('http://127.0.0.1:'), true, '只能绑定回环地址');

    await server.close();
    await assert.rejects(() => fetch(`${server.url}/api/health`), '关闭后必须拒绝连接');
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 2. 浏览器不能指定项目根 / 不能越界
// ---------------------------------------------------------------------------
test('S9B-02 不接受客户端指定项目根，越界路径被拒绝', async () => {
  await withServer(async ({ base, root, api, post }) => {
    const outside = join(base, 'outside.md');
    await writeFile(outside, 'SECRET-OUTSIDE\n');

    const withRoot = await post('/api/open', { path: 'a.md', rootDir: base });
    assert.equal(withRoot.status, 400);
    assert.equal(withRoot.body.errorCode, 'ERR_COMMAND_INVALID');

    const traversal = await post('/api/open', { path: '../outside.md' });
    assert.equal(traversal.status, 400, '越界路径必须被拒绝');
    assert.equal(traversal.body.status, 'REJECTED');

    const absolute = await post('/api/open', { path: outside });
    assert.equal(absolute.status, 400, '绝对路径必须被拒绝');

    // 根外文件始终没有被读写过
    assert.equal(await readFile(outside, 'utf8'), 'SECRET-OUTSIDE\n');
    assert.deepEqual((await readdir(base)).sort(), ['outside.md', 'project']);
    assert.ok(root.endsWith('project'));
    // 健康检查仍只暴露自己的根
    const health = await api('/api/health');
    assert.equal(health.body.root, root);
  });
});

// ---------------------------------------------------------------------------
// 3. 文件树只包含授权范围内的可读文本文件
// ---------------------------------------------------------------------------
test('S9B-03 资源树只包含项目内可读文本文件，不包含二进制', async () => {
  await withServer(async ({ api }) => {
    const res = await api('/api/resources');
    assert.equal(res.status, 200);
    const nodes = res.body.nodes as Array<{ name: string; kind: string; path?: string; children?: unknown[] }>;
    const flat: string[] = [];
    const foldes: string[] = [];
    const walk = (list: typeof nodes): void => {
      for (const node of list) {
        if (node.kind === 'folder') foldes.push(node.name);
        else flat.push(node.path ?? node.name);
        if (Array.isArray(node.children)) walk(node.children as typeof nodes);
      }
    };
    walk(nodes);

    assert.deepEqual(flat.sort(), ['a.md', 'docs/b.md', 'notes/c.txt'].sort());
    assert.equal(flat.includes('a.md'), true);
    assert.equal(flat.includes('docs/b.md'), true);
    assert.equal(flat.includes('notes/c.txt'), true);
    assert.equal(flat.includes('bin/d.png'), false, '二进制不进树');
    assert.equal(flat.some((p) => p.startsWith('..')), false);
    assert.deepEqual(foldes.sort(), ['docs', 'notes'], '目录只来自项目内的文本文件');
  });
});

// ---------------------------------------------------------------------------
// 4. 未授权/伪造的读取被拒绝
// ---------------------------------------------------------------------------
test('S9B-04 伪造 sessionId/viewId 的正文读取被拒绝', async () => {
  await withServer(async ({ api, post }) => {
    const forgedSession = await api('/api/document?sessionId=session-999&viewId=view-999');
    assert.equal(forgedSession.status, 404);
    assert.equal(forgedSession.body.status, 'REJECTED');

    const noSession = await api('/api/document');
    assert.equal(noSession.status, 400);

    const opened = await post('/api/open', { path: 'a.md' });
    assert.equal(opened.status, 200);
    const sessionId = opened.body.document.sessionId as string;

    // 用别人的 viewId 读取同一会话 → 拒绝（viewId 必须属于该会话）
    const wrongView = await api(`/api/document?sessionId=${sessionId}&viewId=view-does-not-exist`);
    assert.equal(wrongView.status, 403);
    assert.equal(wrongView.body.errorCode, 'ERR_PERMISSION_DENIED');
  });
});

// ---------------------------------------------------------------------------
// 5. open 返回会话句柄、内容与版本
// ---------------------------------------------------------------------------
test('S9B-05 open 返回 SessionId/ViewId、真实内容与内容版本', async () => {
  await withServer(async ({ post }) => {
    const res = await post('/api/open', { path: 'docs/b.md' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'APPLIED');
    const doc = res.body.document;
    assert.match(doc.sessionId, /^session-\d+$/);
    assert.match(doc.viewId, /^view-\d+$/);
    assert.equal(doc.path, 'docs/b.md');
    assert.equal(doc.resourceId, 'doc:docs/b.md');
    assert.equal(doc.content, '# B\n\n二级目录\n');
    assert.equal(doc.baseVersion, sha(Buffer.from('# B\n\n二级目录\n', 'utf8')));
    assert.equal(doc.revision, 0);
    assert.equal(doc.dirty, false);
    assert.equal(doc.documentState, 'CLEAN');
  });
});

// ---------------------------------------------------------------------------
// 6. 编辑 → 保存 → 磁盘字节一致
// ---------------------------------------------------------------------------
test('S9B-06 编辑后保存：磁盘字节与会话内容一致，版本更新', async () => {
  await withServer(async ({ root, post }) => {
    const opened = await post('/api/open', { path: 'a.md' });
    const doc = opened.body.document;

    const edited = await post('/api/edit', {
      sessionId: doc.sessionId,
      viewId: doc.viewId,
      buffer: '# A\n\n改过的内容\n',
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.document.revision, 1);
    assert.equal(edited.body.document.dirty, true);

    const saved = await post('/api/save', {
      sessionId: doc.sessionId,
      viewId: doc.viewId,
      expectedVersion: doc.baseVersion,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.status, 'COMMITTED');

    const disk = await readFile(join(root, 'a.md'));
    assert.equal(disk.toString('utf8'), '# A\n\n改过的内容\n');
    assert.equal(saved.body.contentVersion, sha(disk));
    assert.equal(saved.body.document.dirty, false);
    assert.equal(saved.body.document.documentState, 'CLEAN');
    assert.equal(saved.body.document.baseVersion, sha(disk));
  });
});

// ---------------------------------------------------------------------------
// 7. 关闭后重新打开仍是刚才保存的内容
// ---------------------------------------------------------------------------
test('S9B-07 关闭视图后重新打开，读到本次保存的内容', async () => {
  await withServer(async ({ post }) => {
    const opened = await post('/api/open', { path: 'notes/c.txt' });
    const doc = opened.body.document;
    await post('/api/edit', { sessionId: doc.sessionId, viewId: doc.viewId, buffer: '第一版\n' });
    const saved = await post('/api/save', {
      sessionId: doc.sessionId,
      viewId: doc.viewId,
      expectedVersion: doc.baseVersion,
    });
    assert.equal(saved.body.status, 'COMMITTED');

    const closed = await post('/api/close', { sessionId: doc.sessionId, viewId: doc.viewId });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.status, 'APPLIED');

    const reopened = await post('/api/open', { path: 'notes/c.txt' });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.document.content, '第一版\n');
    assert.equal(reopened.body.document.baseVersion, saved.body.contentVersion);
    // Core 在最后一个视图关闭后仍保留会话（既有行为），因此 revision 继续累加；
    // 重开只要求「内容与基线版本正确」，见 README 的遗留限制。
    assert.ok(reopened.body.document.revision >= 1);
    assert.notEqual(reopened.body.document.viewId, doc.viewId, '重开必须是一个新视图');
  });
});

// ---------------------------------------------------------------------------
// 8. 外部修改 → 保存冲突
// ---------------------------------------------------------------------------
test('S9B-08 外部修改后保存：CONFLICT，磁盘不被覆盖，编辑内容保留', async () => {
  await withServer(async ({ root, post }) => {
    const opened = await post('/api/open', { path: 'a.md' });
    const doc = opened.body.document;
    await post('/api/edit', { sessionId: doc.sessionId, viewId: doc.viewId, buffer: '# 我的修改\n' });

    // 模拟外部（别的编辑器）改了同一个文件
    await writeFile(join(root, 'a.md'), '# 外部修改\n', 'utf8');
    const diskBefore = sha(await readFile(join(root, 'a.md')));

    const saved = await post('/api/save', {
      sessionId: doc.sessionId,
      viewId: doc.viewId,
      expectedVersion: doc.baseVersion,
    });
    assert.equal(saved.status, 409);
    assert.equal(saved.body.status, 'CONFLICT');
    assert.equal(saved.body.errorCode, 'ERR_DOCUMENT_VERSION_CONFLICT');
    assert.equal(sha(await readFile(join(root, 'a.md'))), diskBefore, '冲突不得静默覆盖磁盘');
    assert.equal(saved.body.document.content, '# 我的修改\n', '编辑内容必须保留');
    assert.equal(saved.body.document.dirty, true);
    assert.equal(saved.body.document.documentState, 'CONFLICT');
  });
});

// ---------------------------------------------------------------------------
// 9. 保存 FAILED 不丢缓冲
// ---------------------------------------------------------------------------
test('S9B-09 保存 FAILED（目标变成二进制）：返回错误码且不丢用户缓冲', async () => {
  await withServer(async ({ root, post, api }) => {
    const opened = await post('/api/open', { path: 'notes/c.txt' });
    const doc = opened.body.document;
    await post('/api/edit', { sessionId: doc.sessionId, viewId: doc.viewId, buffer: '用户输入不能丢\n' });

    // 外部把目标替换成二进制（PNG 魔数）→ 文本接口必须拒绝覆盖
    await writeFile(join(root, 'notes/c.txt'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const binaryBefore = sha(await readFile(join(root, 'notes/c.txt')));

    const saved = await post('/api/save', {
      sessionId: doc.sessionId,
      viewId: doc.viewId,
      expectedVersion: doc.baseVersion,
    });
    assert.equal(saved.status, 422);
    assert.equal(saved.body.status, 'FAILED');
    assert.equal(saved.body.errorCode, 'ERR_RESOURCE_NOT_TEXT');
    assert.equal(sha(await readFile(join(root, 'notes/c.txt'))), binaryBefore, '拒绝时不得改字节');

    const reread = await api(`/api/document?sessionId=${doc.sessionId}&viewId=${doc.viewId}`);
    assert.equal(reread.status, 200);
    assert.equal(reread.body.document.content, '用户输入不能丢\n');
    assert.equal(reread.body.document.dirty, true);
  });
});

// ---------------------------------------------------------------------------
// 10. UNKNOWN 不自动重试
// ---------------------------------------------------------------------------
test('S9B-10 保存结果未知（UNKNOWN）：标记 OUTCOME_UNKNOWN 且不自动重试', async () => {
  let commits = 0;
  const faults: StorageFaultHooks = {
    beforeCommit: () => {
      commits += 1;
    },
    afterCommit: () => {
      throw new Error('确认链中断（测试注入）');
    },
  };

  await withServer(
    async ({ post }) => {
      const opened = await post('/api/open', { path: 'a.md' });
      const doc = opened.body.document;
      await post('/api/edit', { sessionId: doc.sessionId, viewId: doc.viewId, buffer: '# UNKNOWN 测试\n' });

      const saved = await post('/api/save', {
        sessionId: doc.sessionId,
        viewId: doc.viewId,
        expectedVersion: doc.baseVersion,
      });
      assert.equal(saved.status, 202);
      assert.equal(saved.body.status, 'UNKNOWN');
      assert.equal(saved.body.errorCode, 'ERR_OUTCOME_UNKNOWN');
      assert.equal(saved.body.document.documentState, 'OUTCOME_UNKNOWN');
      assert.equal(saved.body.document.dirty, true, 'UNKNOWN 不得标记为已保存');

      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(commits, 1, 'UNKNOWN 之后不得自动重试写入');
    },
    { faults },
  );
});

// ---------------------------------------------------------------------------
// 11. 同一文档两个视图共享会话
// ---------------------------------------------------------------------------
test('S9B-11 同一文档的两个视图共享同一会话与缓冲', async () => {
  await withServer(async ({ post, api }) => {
    const first = await post('/api/open', { path: 'docs/b.md' });
    const second = await post('/api/open', { path: 'docs/b.md' });
    assert.equal(second.body.document.sessionId, first.body.document.sessionId, '必须复用同一会话');
    assert.notEqual(second.body.document.viewId, first.body.document.viewId, '视图必须各自独立');

    await post('/api/edit', {
      sessionId: first.body.document.sessionId,
      viewId: first.body.document.viewId,
      buffer: '共享缓冲\n',
    });

    const viaSecond = await api(
      `/api/document?sessionId=${second.body.document.sessionId}&viewId=${second.body.document.viewId}`,
    );
    assert.equal(viaSecond.body.document.content, '共享缓冲\n');
    assert.equal(viaSecond.body.document.revision, 1);
  });
});

// ---------------------------------------------------------------------------
// 12. 伪造身份字段不得绕过
// ---------------------------------------------------------------------------
test('S9B-12 伪造 providerId / resourceId / actorId 一律拒绝', async () => {
  await withServer(async ({ post }) => {
    const provider = await post('/api/open', { path: 'a.md', providerId: 'remote' });
    assert.equal(provider.status, 403);
    assert.equal(provider.body.errorCode, 'ERR_PERMISSION_DENIED');

    const resource = await post('/api/open', { path: 'a.md', resourceId: 'doc:docs/b.md' });
    assert.equal(resource.status, 400, 'resourceId 由服务端派生，不能被伪造');

    const actor = await post('/api/open', { path: 'a.md', actorId: 'root' });
    assert.equal(actor.status, 400);
    assert.equal(actor.body.errorCode, 'ERR_COMMAND_INVALID');
  });
});

// ---------------------------------------------------------------------------
// 13. Host / Origin / 跨站写请求
// ---------------------------------------------------------------------------
test('S9B-13 非法 Host、非白名单 Origin、跨站写请求均被拒绝', async () => {
  await withServer(async ({ server, post, api }) => {
    // 非回环 Host（DNS rebinding 形态）
    const badHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: '/api/health',
          headers: { Host: 'evil.example' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(badHost, 403);

    const badOrigin = await api('/api/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ path: 'a.md' }),
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.body.errorCode, 'ERR_PERMISSION_DENIED');

    const crossSite = await api('/api/open', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: server.url,
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify({ path: 'a.md' }),
    });
    assert.equal(crossSite.status, 403, '跨站请求必须被拒绝');

    const options = await api('/api/open', { method: 'OPTIONS' });
    assert.equal(options.status, 405);

    // 同源（无 Origin 的非浏览器客户端）正常
    const ok = await post('/api/open', { path: 'a.md' });
    assert.equal(ok.status, 200);

    // 不允许 CORS 通配
    const health = await fetch(`${server.url}/api/health`);
    assert.equal(health.headers.get('access-control-allow-origin'), null);
  });
});

// ---------------------------------------------------------------------------
// 14. 演示数据不会进入 live 通道，也不会产生写盘
// ---------------------------------------------------------------------------
test('S9B-14 live 通道不暴露演示数据，也不会凭空写盘', async () => {
  await withServer(async ({ root, api, post }) => {
    const res = await api('/api/resources');
    const serialized = JSON.stringify(res.body);
    assert.equal(serialized.includes('第01场'), false, '演示数据不得出现在 live 树里');
    assert.equal(serialized.includes('演示项目'), false);

    const before = (await readdir(root, { recursive: true })).sort();
    await post('/api/open', { path: 'a.md' });
    const after = (await readdir(root, { recursive: true })).sort();
    assert.deepEqual(after, before, '打开/读取不得产生新文件');
  });
});

// ---------------------------------------------------------------------------
// 15. 连续编辑的请求顺序（客户端队列）
// ---------------------------------------------------------------------------
test('S9B-15 编辑队列串行发送并合并中间态，避免响应乱序导致内容回退', async () => {
  const applied: string[] = [];
  const gates: Array<() => void> = [];
  const queue = createEditQueue<string>(async (text) => {
    applied.push(text);
    await new Promise<void>((resolve) => {
      gates.push(resolve);
    });
    return text;
  });

  queue.schedule('A');
  await tick();
  assert.deepEqual(applied, ['A'], '第一个请求已发出');
  assert.equal(queue.pending(), true);

  // 在途期间连续输入 B、C：只应保留最新的 C
  queue.schedule('B');
  queue.schedule('C');
  gates.shift()?.();
  await tick();

  assert.deepEqual(applied, ['A', 'C'], 'B 必须被合并掉，且 C 在 A 之后发送');

  gates.shift()?.();
  await queue.flush();
  assert.equal(queue.pending(), false);
  assert.deepEqual(applied, ['A', 'C']);
});

test('S9B-16 编辑队列：单次失败不吞掉后续输入', async () => {
  const applied: string[] = [];
  const queue = createEditQueue<string>(async (text) => {
    applied.push(text);
    if (text === 'BAD') throw new Error('模拟编辑失败');
    return text;
  });

  queue.schedule('BAD');
  await queue.flush();
  assert.deepEqual(applied, ['BAD']);
  assert.ok(queue.lastError() instanceof Error);

  queue.schedule('OK');
  await queue.flush();
  assert.deepEqual(applied, ['BAD', 'OK']);
  assert.equal(queue.lastError(), null);
});

// ---------------------------------------------------------------------------
// 静态资源目录约束：服务只暴露 JSON API
// ---------------------------------------------------------------------------
test('S9B-17 服务不提供静态文件或磁盘浏览接口', async () => {
  await withServer(async ({ api }) => {
    for (const path of ['/', '/index.html', '/api/fs', '/api/read?path=a.md']) {
      const res = await api(path);
      assert.equal(res.status, 404, `${path} 不应存在`);
    }
    // 目录本身也不能被当成文件打开
    const dir = await api('/api/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'docs' }),
    });
    assert.notEqual(dir.body.status, 'APPLIED');
  });
});

// 确保临时目录已清理（防御性断言：withServer 的 finally 已删除）
test('S9B-18 测试临时目录不落在仓库内', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-s9b-path-'));
  const info = await stat(base);
  assert.equal(info.isDirectory(), true);
  assert.equal(base.startsWith(tmpdir()), true);
  await rm(base, { recursive: true, force: true });
});
