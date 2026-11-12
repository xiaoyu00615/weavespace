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
import { createLiveClient } from '../../apps/shell/src/client/client-api.ts';
import { createEditQueue, flushLatest } from '../../apps/shell/src/client/edit-queue.ts';
import { runSaveFlow } from '../../apps/shell/src/client/save-flow.ts';
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

// ---------------------------------------------------------------------------
// F01（S9B-19~22）：编辑同步失败必须阻止保存
// ---------------------------------------------------------------------------
test('S9B-19 编辑被拒绝时 flush 报失败，保存不得把旧内容写成草稿', async () => {
  await withServer(async ({ root, server, post, api }) => {
    const opened = await post('/api/open', { path: 'a.md' });
    const doc = opened.body.document;
    const live = createLiveClient(server.url);

    // 第一次 applyEdit 被业务拒绝（模拟权限/会话失效），之后恢复正常
    let rejectNext = true;
    const client = {
      applyEdit: async (sessionId: string, buffer: string, expectedVersion?: string | null) => {
        if (rejectNext) {
          rejectNext = false;
          return { status: 'REJECTED' as const, errorCode: 'ERR_PERMISSION_DENIED' };
        }
        return live.applyEdit(sessionId, buffer, expectedVersion);
      },
    };

    const queue = createEditQueue<string>(async (text) => {
      const outcome = await client.applyEdit(doc.sessionId, text, doc.baseVersion);
      if (outcome.status !== 'APPLIED') {
        throw Object.assign(new Error('edit rejected'), { errorCode: outcome.errorCode });
      }
      return text;
    });

    queue.schedule('UI 的 B 内容\n');
    const flushed = await queue.flush();
    assert.equal(flushed.ok, false, '同步失败必须被 flush 报告');

    let committed = false;
    const result = await runSaveFlow({
      buffer: 'UI 的 B 内容\n',
      sync: () => flushLatest(queue, 'UI 的 B 内容\n'),
      commit: async () => {
        committed = true;
        return { status: 'COMMITTED' as const, contentVersion: null };
      },
    });

    assert.equal(result.attempted, false, '同步失败时不得发起保存');
    assert.equal(result.status, 'FAILED');
    assert.equal(result.dirty, true, '脏标记必须保留');
    assert.equal(committed, false);

    // Core 与会话缓冲仍是 A；磁盘也仍是 A
    const reread = await api(`/api/document?sessionId=${doc.sessionId}&viewId=${doc.viewId}`);
    assert.equal(reread.body.document.content, '# A\n\n原始内容\n');
    assert.equal(await readFile(join(root, 'a.md'), 'utf8'), '# A\n\n原始内容\n');
  });
});

test('S9B-20 超过 1 MiB 的编辑被服务端拒绝，保存被阻止且磁盘不变', async () => {
  await withServer(async ({ root, server, post }) => {
    const opened = await post('/api/open', { path: 'a.md' });
    const doc = opened.body.document;
    const client = createLiveClient(server.url);
    const huge = 'x'.repeat(1024 * 1024 + 4096);

    const queue = createEditQueue<string>(async (text) => {
      const outcome = await client.applyEdit(doc.sessionId, text, doc.baseVersion);
      if (outcome.status !== 'APPLIED') {
        throw Object.assign(new Error('edit rejected'), { errorCode: outcome.errorCode });
      }
      return text;
    });

    queue.schedule(huge);
    const flushed = await queue.flush();
    assert.equal(flushed.ok, false, '超大请求必须被视为同步失败');

    const result = await runSaveFlow({
      buffer: huge,
      sync: () => flushLatest(queue, huge),
      commit: async () => ({ status: 'COMMITTED' as const, contentVersion: null }),
    });
    assert.equal(result.attempted, false);
    assert.equal(await readFile(join(root, 'a.md'), 'utf8'), '# A\n\n原始内容\n', '磁盘不得被写');
  });
});

test('S9B-21 网络故障导致 applyEdit 抛错：保存被阻止', async () => {
  // 先起一个服务再关掉，拿到一个确定没人监听的端口
  const deadRoot = await mkdtemp(join(tmpdir(), 'ws-s9b-dead-'));
  const dead = await createShellServer({ rootDir: deadRoot, port: 0 });
  const deadUrl = dead.url;
  await dead.close();

  const client = createLiveClient(deadUrl);
  const queue = createEditQueue<string>(async (text) => {
    const outcome = await client.applyEdit('session-1', text, 'sha256:dead');
    if (outcome.status !== 'APPLIED') throw new Error('unreachable');
    return text;
  });

  queue.schedule('断网时的输入\n');
  const flushed = await queue.flush();
  assert.equal(flushed.ok, false, '网络异常必须被报告为同步失败');

  let committed = false;
  const result = await runSaveFlow({
    buffer: '断网时的输入\n',
    sync: () => flushLatest(queue, '断网时的输入\n'),
    commit: async () => {
      committed = true;
      return { status: 'COMMITTED' as const, contentVersion: null };
    },
  });
  assert.equal(result.attempted, false);
  assert.equal(result.dirty, true);
  assert.equal(committed, false);

  await rm(deadRoot, { recursive: true, force: true }).catch(() => {});
});

test('S9B-22 失败后重新同步成功：可以正常保存并写盘', async () => {
  await withServer(async ({ root, server, post }) => {
    const opened = await post('/api/open', { path: 'a.md' });
    const doc = opened.body.document;
    const live = createLiveClient(server.url);

    let rejectNext = true;
    const flaky = {
      applyEdit: async (sessionId: string, buffer: string, expectedVersion?: string | null) => {
        if (rejectNext) {
          rejectNext = false;
          return { status: 'REJECTED' as const, errorCode: 'ERR_PERMISSION_DENIED' };
        }
        return live.applyEdit(sessionId, buffer, expectedVersion);
      },
    };

    const queue = createEditQueue<string>(async (text) => {
      const outcome = await flaky.applyEdit(doc.sessionId, text, doc.baseVersion);
      if (outcome.status !== 'APPLIED') throw new Error('edit rejected');
      return text;
    });

    queue.schedule('第一次失败的 B\n');
    assert.equal((await queue.flush()).ok, false);

    const blocked = await runSaveFlow({
      buffer: '第一次失败的 B\n',
      sync: () => flushLatest(queue, '第一次失败的 B\n'),
      commit: () => live.saveDocument(doc.sessionId, doc.baseVersion, doc.viewId),
    });
    assert.equal(blocked.attempted, false);
    assert.equal(await readFile(join(root, 'a.md'), 'utf8'), '# A\n\n原始内容\n');

    // 再次提交同一缓冲：这次同步成功 → 允许保存
    queue.schedule('第一次失败的 B\n');
    const ok = await runSaveFlow({
      buffer: '第一次失败的 B\n',
      sync: () => flushLatest(queue, '第一次失败的 B\n'),
      commit: () => live.saveDocument(doc.sessionId, doc.baseVersion, doc.viewId),
    });
    assert.equal(ok.attempted, true);
    assert.equal(ok.status, 'COMMITTED');
    assert.equal(await readFile(join(root, 'a.md'), 'utf8'), '第一次失败的 B\n');
  });
});

// ---------------------------------------------------------------------------
// F02（S9B-23~25）：保存状态收敛
// ---------------------------------------------------------------------------
test('S9B-23 保存请求抛异常（断网）：UNKNOWN、保留脏标记，绝不报成功', async () => {
  const result = await runSaveFlow({
    buffer: '草稿\n',
    sync: async () => ({ ok: true as const, lastSynced: '草稿\n' }),
    commit: async () => {
      throw Object.assign(new TypeError('fetch failed'), { errorCode: undefined });
    },
  });

  assert.equal(result.status, 'UNKNOWN', '网络异常不得伪装为 COMMITTED');
  assert.equal(result.attempted, true);
  assert.equal(result.dirty, true, '未确认的结果不得清除脏标记');
  assert.equal(result.documentState, 'OUTCOME_UNKNOWN');
  assert.equal(result.baseVersion, null, '不得假装拿到了新版本基线');
});

test('S9B-24 保存成功但 Core 仍有新编辑：标记保持 dirty', async () => {
  const result = await runSaveFlow({
    buffer: '草稿\n',
    sync: async () => ({ ok: true as const, lastSynced: '草稿\n' }),
    commit: async () => ({
      status: 'COMMITTED',
      contentVersion: 'sha256:new',
      document: {
        sessionId: 'session-1',
        viewId: 'view-1',
        resourceId: 'doc:a.md',
        path: 'a.md',
        content: '更新的草稿\n',
        baseVersion: 'sha256:new',
        revision: 3,
        dirty: true,
        documentState: 'EDITING_DIRTY',
      },
    }),
  });

  assert.equal(result.status, 'COMMITTED');
  assert.equal(result.dirty, true, '保存期间的新编辑不能被旧响应标记为已保存');
  assert.equal(result.baseVersion, 'sha256:new');
});

test('S9B-25 各保存结论保持既有 Core 语义（CONFLICT / UNKNOWN / FAILED）', async () => {
  const caseOf = async (status: 'CONFLICT' | 'UNKNOWN' | 'FAILED', errorCode: string) =>
    runSaveFlow({
      buffer: 'x\n',
      sync: async () => ({ ok: true as const, lastSynced: 'x\n' }),
      commit: async () => ({ status, errorCode }),
    });

  const conflict = await caseOf('CONFLICT', 'ERR_DOCUMENT_VERSION_CONFLICT');
  assert.equal(conflict.dirty, true);
  assert.equal(conflict.documentState, 'CONFLICT');
  assert.equal(conflict.errorCode, 'ERR_DOCUMENT_VERSION_CONFLICT');

  const unknown = await caseOf('UNKNOWN', 'ERR_OUTCOME_UNKNOWN');
  assert.equal(unknown.documentState, 'OUTCOME_UNKNOWN');
  assert.equal(unknown.dirty, true);

  const failed = await caseOf('FAILED', 'ERR_RESOURCE_NOT_TEXT');
  assert.equal(failed.documentState, 'FAILED');
  assert.equal(failed.errorCode, 'ERR_RESOURCE_NOT_TEXT');
  assert.equal(failed.dirty, true);
});

// ---------------------------------------------------------------------------
// F03（S9B-26）：强制回环绑定
// ---------------------------------------------------------------------------
test('S9B-26 非回环地址在 listen 之前被拒绝，默认与 IPv6 回环可用', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-s9b-bind-'));
  const closed: ShellServer[] = [];
  try {
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
      await assert.rejects(
        () => createShellServer({ rootDir: base, port: 0, host }),
        (err: { errorCode?: string }) => err.errorCode === 'ERR_PERMISSION_DENIED',
        `${host} 必须被拒绝`,
      );
    }

    // 默认绑定 127.0.0.1
    const v4 = await createShellServer({ rootDir: base, port: 0 });
    closed.push(v4);
    assert.equal(v4.url.startsWith('http://127.0.0.1:'), true);

    // 显式回环仍然可用（本机若不支持 IPv6 则记为跳过，不伪造通过）
    const v6 = await createShellServer({ rootDir: base, port: 0, host: '::1' }).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL') return null;
      throw err;
    });
    if (v6) {
      closed.push(v6);
      assert.equal(v6.url.startsWith('http://[::1]:'), true);
      const res = await fetch(`${v6.url}/api/health`);
      assert.equal(res.status, 200);
    }
  } finally {
    for (const server of closed) await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// S9B-A：关闭视图后外部改盘，重开必须读到最新磁盘内容
// ---------------------------------------------------------------------------
test('S9B-27 关闭后外部改盘：重开读到最新内容与版本，再次保存成功', async () => {
  await withServer(async ({ root, post }) => {
    const file = join(root, 'a.md');
    const opened = await post('/api/open', { path: 'a.md' });
    const doc = opened.body.document;
    assert.equal(opened.body.reloaded, false, '首次打开不应标记为已刷新');

    await post('/api/edit', { sessionId: doc.sessionId, viewId: doc.viewId, buffer: '# v2\n' });
    const saved = await post('/api/save', {
      sessionId: doc.sessionId,
      viewId: doc.viewId,
      expectedVersion: doc.baseVersion,
    });
    assert.equal(saved.body.status, 'COMMITTED');

    const closed = await post('/api/close', { sessionId: doc.sessionId, viewId: doc.viewId });
    assert.equal(closed.body.status, 'APPLIED');

    // 外部编辑器改盘
    await writeFile(file, '# v3 外部写入\n', 'utf8');

    const reopened = await post('/api/open', { path: 'a.md' });
    assert.equal(reopened.status, 200);
    const doc2 = reopened.body.document;
    assert.equal(doc2.sessionId, doc.sessionId, '仍是同一会话（复用而非重建）');
    assert.equal(doc2.content, '# v3 外部写入\n', '重开必须读到最新磁盘内容');
    assert.equal(doc2.baseVersion, sha(Buffer.from('# v3 外部写入\n', 'utf8')));
    assert.equal(reopened.body.reloaded, true, '必须报告已刷新');
    assert.equal(doc2.dirty, false);
    assert.equal(doc2.documentState, 'CLEAN');

    // 再编辑保存：必须恢复正常
    await post('/api/edit', { sessionId: doc2.sessionId, viewId: doc2.viewId, buffer: '# v4 继续编辑\n' });
    const saved2 = await post('/api/save', {
      sessionId: doc2.sessionId,
      viewId: doc2.viewId,
      expectedVersion: doc2.baseVersion,
    });
    assert.equal(saved2.body.status, 'COMMITTED', '冲突修复后应能继续保存');
    assert.equal(await readFile(file, 'utf8'), '# v4 继续编辑\n');
  });
});

// ---------------------------------------------------------------------------
// S9B-B：有未保存修改的会话不得被磁盘内容覆盖
// ---------------------------------------------------------------------------
test('S9B-28 有未保存修改时外部改盘：保存 CONFLICT，草稿保持原样', async () => {
  await withServer(async ({ root, post, api }) => {
    const opened = await post('/api/open', { path: 'a.md' });
    const doc = opened.body.document;
    await post('/api/edit', { sessionId: doc.sessionId, viewId: doc.viewId, buffer: '# 我的草稿\n' });

    await writeFile(join(root, 'a.md'), '# 外部改动\n', 'utf8');

    const saved = await post('/api/save', {
      sessionId: doc.sessionId,
      viewId: doc.viewId,
      expectedVersion: doc.baseVersion,
    });
    assert.equal(saved.body.status, 'CONFLICT');

    const reread = await api(`/api/document?sessionId=${doc.sessionId}&viewId=${doc.viewId}`);
    assert.equal(reread.body.document.content, '# 我的草稿\n', '草稿不得被磁盘内容覆盖');
    assert.equal(reread.body.document.dirty, true);
    assert.equal(await readFile(join(root, 'a.md'), 'utf8'), '# 外部改动\n', '磁盘不得被覆盖');
  });
});

// ---------------------------------------------------------------------------
// S9B-C：冲突恢复入口
// ---------------------------------------------------------------------------
async function makeConflict(sessionCtx: {
  root: string;
  post: (p: string, b: unknown) => Promise<ApiResponse>;
}) {
  const opened = await sessionCtx.post('/api/open', { path: 'a.md' });
  const doc = opened.body.document;
  await sessionCtx.post('/api/edit', {
    sessionId: doc.sessionId,
    viewId: doc.viewId,
    buffer: '# 冲突时的草稿\n',
  });
  await writeFile(join(sessionCtx.root, 'a.md'), '# 磁盘新版本\n', 'utf8');
  const saved = await sessionCtx.post('/api/save', {
    sessionId: doc.sessionId,
    viewId: doc.viewId,
    expectedVersion: doc.baseVersion,
  });
  assert.equal(saved.body.status, 'CONFLICT');
  return doc;
}

test('S9B-29 未经显式确认的重载被拒绝，草稿不丢', async () => {
  await withServer(async ({ root, post, api }) => {
    const doc = await makeConflict({ root, post });

    for (const payload of [
      { sessionId: doc.sessionId, viewId: doc.viewId },
      { sessionId: doc.sessionId, viewId: doc.viewId, discardDraft: false },
      { sessionId: doc.sessionId, viewId: doc.viewId, discardDraft: 'yes' },
    ]) {
      const res = await post('/api/reload', payload);
      assert.equal(res.status, 409, '缺少显式确认必须拒绝');
      assert.equal(res.body.errorCode, 'ERR_DOCUMENT_DIRTY');
    }

    const reread = await api(`/api/document?sessionId=${doc.sessionId}&viewId=${doc.viewId}`);
    assert.equal(reread.body.document.content, '# 冲突时的草稿\n');
    assert.equal(await readFile(join(root, 'a.md'), 'utf8'), '# 磁盘新版本\n');
  });
});

test('S9B-30 显式确认后重载：内容与版本对齐磁盘，可继续编辑保存', async () => {
  await withServer(async ({ root, post, api }) => {
    const doc = await makeConflict({ root, post });

    const reloaded = await post('/api/reload', {
      sessionId: doc.sessionId,
      viewId: doc.viewId,
      discardDraft: true,
    });
    assert.equal(reloaded.status, 200);
    assert.equal(reloaded.body.status, 'APPLIED');
    assert.equal(reloaded.body.document.content, '# 磁盘新版本\n');
    assert.equal(reloaded.body.document.baseVersion, sha(Buffer.from('# 磁盘新版本\n', 'utf8')));
    assert.equal(reloaded.body.document.dirty, false);
    assert.equal(reloaded.body.document.documentState, 'CLEAN');
    assert.equal(reloaded.body.previousDraft, '# 冲突时的草稿\n', '必须回传旧草稿供备份');

    // 冲突解除后可正常保存
    await post('/api/edit', { sessionId: doc.sessionId, viewId: doc.viewId, buffer: '# 重载后编辑\n' });
    const saved = await post('/api/save', {
      sessionId: doc.sessionId,
      viewId: doc.viewId,
      expectedVersion: reloaded.body.document.baseVersion,
    });
    assert.equal(saved.body.status, 'COMMITTED');
    assert.equal(await readFile(join(root, 'a.md'), 'utf8'), '# 重载后编辑\n');

    const reread = await api(`/api/document?sessionId=${doc.sessionId}&viewId=${doc.viewId}`);
    assert.equal(reread.body.document.dirty, false);
  });
});

test('S9B-31 重载失败（磁盘文件已删除）：返回错误且原有草稿不丢失', async () => {
  await withServer(async ({ root, post, api }) => {
    const doc = await makeConflict({ root, post });
    await rm(join(root, 'a.md'), { force: true });

    const reloaded = await post('/api/reload', {
      sessionId: doc.sessionId,
      viewId: doc.viewId,
      discardDraft: true,
    });
    assert.equal(reloaded.status, 404);
    assert.equal(reloaded.body.status, 'REJECTED');

    const reread = await api(`/api/document?sessionId=${doc.sessionId}&viewId=${doc.viewId}`);
    assert.equal(reread.body.document.content, '# 冲突时的草稿\n', '重载失败不得清空草稿');
    assert.equal(reread.body.document.dirty, true);
  });
});

test('S9B-32 磁盘版本只读查看：返回磁盘内容，伪造会话被拒绝', async () => {
  await withServer(async ({ root, post, api }) => {
    const opened = await post('/api/open', { path: 'a.md' });
    const doc = opened.body.document;
    await writeFile(join(root, 'a.md'), '# 磁盘上的内容\n', 'utf8');

    const disk = await api(`/api/document/disk?sessionId=${doc.sessionId}&viewId=${doc.viewId}`);
    assert.equal(disk.status, 200);
    assert.equal(disk.body.content, '# 磁盘上的内容\n');
    assert.equal(disk.body.contentVersion, sha(Buffer.from('# 磁盘上的内容\n', 'utf8')));

    // 只读查看不改变会话与磁盘
    assert.equal(await readFile(join(root, 'a.md'), 'utf8'), '# 磁盘上的内容\n');
    const session = await api(`/api/document?sessionId=${doc.sessionId}&viewId=${doc.viewId}`);
    assert.equal(session.body.document.content, '# A\n\n原始内容\n', '会话内容不受只读查看影响');

    const forged = await api('/api/document/disk?sessionId=session-999&viewId=view-999');
    assert.equal(forged.status, 404);
  });
});

test('S9B-33 干净会话即使还有视图（页面刷新残留）也会在重开时同步磁盘', async () => {
  await withServer(async ({ root, post }) => {
    const opened = await post('/api/open', { path: 'a.md' });
    const doc = opened.body.document;
    // 不关闭视图：模拟浏览器刷新后旧 view 仍留在服务端
    await writeFile(join(root, 'a.md'), '# 磁盘新内容\n', 'utf8');

    const reopened = await post('/api/open', { path: 'a.md' });
    assert.equal(reopened.body.document.content, '# 磁盘新内容\n', '干净会话必须同步磁盘');
    assert.equal(reopened.body.reloaded, true);
    assert.equal(
      reopened.body.document.baseVersion,
      sha(Buffer.from('# 磁盘新内容\n', 'utf8')),
    );

    // 有草稿时仍然不覆盖（回归保护）
    await post('/api/edit', {
      sessionId: doc.sessionId,
      viewId: reopened.body.document.viewId,
      buffer: '# 我的草稿\n',
    });
    await writeFile(join(root, 'a.md'), '# 磁盘又变了\n', 'utf8');
    const third = await post('/api/open', { path: 'a.md' });
    assert.equal(third.body.document.content, '# 我的草稿\n', 'dirty 时不得被磁盘覆盖');
    assert.equal(third.body.reloaded, false);
  });
});
