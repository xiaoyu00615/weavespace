/**
 * S11-UX-02B-TREE：真实文件树的服务端契约（契约 B / 文档 26 §4.1 §4.3 §7.3）。
 *
 * 覆盖 T-01…T-14d、T-21、T-22。全部经真实 HTTP 驱动真实 Host，
 * 断言的是"浏览器能看到什么"，不是内部实现。
 *
 * 关键纪律：
 * - 目录读不出来（EPERM/EACCES）≠ 授权不足（ERR_PERMISSION_DENIED）：错误码、文案都必须分开；
 * - 空目录 ≠ 读不出来 ≠ 不存在：三者都不得被渲染成 `200 []`；
 * - 分页必须能一直翻到 `nextCursor === null`，且累计条目 = total（禁止静默截断）；
 * - 链接只显示、不跟随，id 走 `link:` 命名空间。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import type { ProjectRuntime } from '../../apps/server/src/project-runtime.ts';
import { validateWorkspaceConfig } from '../../packages/project-registry/index.ts';
import type { StorageFaultHooks } from '../../packages/storage/index.ts';

/* ------------------------------- 夹具 ------------------------------- */

interface ApiResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface Page {
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
  total: number;
}

interface Entry {
  id: string;
  name: string;
  kind: string;
  extension?: string;
  relPath: string;
}

async function call(server: ShellServer, path: string): Promise<ApiResponse> {
  const res = await fetch(`${server.url}${path}`);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

function entriesOf(body: Record<string, unknown>): Entry[] {
  const list = body.entries;
  assert.ok(Array.isArray(list), `响应缺少 entries: ${JSON.stringify(body)}`);
  return list as Entry[];
}

function pageOf(body: Record<string, unknown>): Page {
  const page = body.page as Page | undefined;
  assert.ok(page, `响应缺少 page: ${JSON.stringify(body)}`);
  return page;
}

function namesOf(entries: readonly Entry[]): string[] {
  return entries.map((entry) => entry.name);
}

async function canCreateJunction(): Promise<boolean> {
  const base = await mkdtemp(join(tmpdir(), 'ws-tree-cap-'));
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

interface Fixture {
  base: string;
  root: string;
  outside: string;
}

/**
 * 一份"什么都有"的项目根：
 * 文本/代码/图片/PDF/视频/无扩展名/隐藏文件/隐藏目录/空目录/三层嵌套/指向根外的 junction。
 */
async function makeFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'ws-tree-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');

  await mkdir(join(root, 'docs', 'sub'), { recursive: true });
  await mkdir(join(root, 'empty'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(outside, { recursive: true });

  await writeFile(join(root, 'README.md'), '# root\n', 'utf8');
  await writeFile(join(root, 'notes.txt'), 'text\n', 'utf8');
  await writeFile(join(root, 'data.json'), '{}\n', 'utf8');
  await writeFile(join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(root, 'doc.pdf'), Buffer.from('%PDF-1.4'));
  await writeFile(join(root, 'clip.mp4'), Buffer.from([0, 0, 0, 0x18]));
  await writeFile(join(root, 'LICENSE'), 'no extension\n', 'utf8');
  await writeFile(join(root, '.hidden'), 'hidden\n', 'utf8');
  await writeFile(join(root, '.git', 'config'), '[core]\n', 'utf8');
  await writeFile(join(root, 'docs', 'notes.md'), '# notes\n', 'utf8');
  await writeFile(join(root, 'docs', 'sub', 'deep.md'), '# deep\n', 'utf8');
  await writeFile(join(outside, 'secret.txt'), 'secret\n', 'utf8');

  if (HAS_JUNCTION) {
    await symlink(outside, join(root, 'linked-out'), 'junction').catch(() => {});
  }
  return { base, root, outside };
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = await makeFixture();
  try {
    await fn(fixture);
  } finally {
    await rm(fixture.base, { recursive: true, force: true }).catch(() => {});
  }
}

/** 启一个 Legacy Host（单根，无项目表）。 */
async function bootLegacy(rootDir: string, providerFaults?: StorageFaultHooks): Promise<ShellServer> {
  return createShellServer({
    rootDir,
    port: 0,
    ...(providerFaults ? { providerFaults } : {}),
  });
}

async function withLegacy(
  rootDir: string,
  fn: (server: ShellServer) => Promise<void>,
  providerFaults?: StorageFaultHooks,
): Promise<void> {
  const server = await bootLegacy(rootDir, providerFaults);
  try {
    await fn(server);
  } finally {
    await server.close().catch(() => {});
  }
}

function configOf(projects: Array<{ projectId: string; name?: string; rootDir: string }>) {
  return validateWorkspaceConfig({
    version: 1,
    projects: projects.map((p) => ({ projectId: p.projectId, name: p.name ?? p.projectId, rootDir: p.rootDir })),
  });
}

/* --------------------------- T-01 / T-07 全类型 --------------------------- */

test('TX-01 根层显示所有可枚举条目（图片/PDF/视频/无扩展名/隐藏文件/空目录）', async () => {
  await withFixture(async ({ root }) => {
    await withLegacy(root, async (server) => {
      const res = await call(server, '/api/tree');
      assert.equal(res.status, 200, `根层应可读: ${JSON.stringify(res.body)}`);
      const entries = entriesOf(res.body);
      const names = namesOf(entries);

      for (const expected of [
        'README.md',
        'notes.txt',
        'data.json',
        'pic.png',
        'doc.pdf',
        'clip.mp4',
        'LICENSE',
        '.hidden',
        '.git',
        'docs',
        'empty',
      ]) {
        assert.ok(names.includes(expected), `缺少条目 ${expected}：${names.join(',')}`);
      }

      // 文件类型只影响"能否预览"，不影响"是否显示"
      const byName = new Map(entries.map((entry) => [entry.name, entry]));
      for (const file of ['README.md', 'pic.png', 'doc.pdf', 'clip.mp4', 'LICENSE', 'data.json', '.hidden']) {
        assert.equal(byName.get(file)?.kind, 'file', `${file} 必须是 file`);
      }
      assert.equal(byName.get('docs')?.kind, 'folder');
      assert.equal(byName.get('empty')?.kind, 'folder');
      assert.equal(byName.get('.git')?.kind, 'folder', '隐藏目录也是目录');

      // extension：小写含点；无扩展名是空串
      assert.equal(byName.get('README.md')?.extension, '.md');
      assert.equal(byName.get('pic.png')?.extension, '.png');
      assert.equal(byName.get('doc.pdf')?.extension, '.pdf');
      assert.equal(byName.get('clip.mp4')?.extension, '.mp4');
      assert.equal(byName.get('LICENSE')?.extension ?? '', '', '无扩展名必须是空串');
      assert.equal(byName.get('docs')?.extension ?? '', '', '目录的 extension 必须是空串');

      // relPath 是项目内相对路径
      assert.equal(byName.get('README.md')?.relPath, 'README.md');
      assert.equal(byName.get('docs')?.relPath, 'docs');
    });
  });
});

test('TX-02 空目录返回空页（EMPTY），不是 200 + 缺字段', async () => {
  await withFixture(async ({ root }) => {
    await withLegacy(root, async (server) => {
      const res = await call(server, '/api/tree?dir=empty');
      assert.equal(res.status, 200);
      assert.deepEqual(entriesOf(res.body), []);
      const page = pageOf(res.body);
      assert.equal(page.total, 0);
      assert.equal(page.nextCursor, null, '空目录没有下一页');
      assert.equal(res.body.level, 'empty');
    });
  });
});

/* --------------------------- T-03 嵌套层级 --------------------------- */

test('TX-03 逐层请求：docs 与 docs/sub 各自正确', async () => {
  await withFixture(async ({ root }) => {
    await withLegacy(root, async (server) => {
      const docs = await call(server, '/api/tree?dir=docs');
      assert.equal(docs.status, 200);
      assert.deepEqual(namesOf(entriesOf(docs.body)).sort(), ['notes.md', 'sub']);
      const sub = entriesOf(docs.body).find((entry) => entry.name === 'sub');
      assert.equal(sub?.relPath, 'docs/sub', '子目录 relPath 必须带父路径');

      const deep = await call(server, '/api/tree?dir=docs/sub');
      assert.equal(deep.status, 200);
      assert.deepEqual(namesOf(entriesOf(deep.body)), ['deep.md']);
      assert.equal(entriesOf(deep.body)[0]?.relPath, 'docs/sub/deep.md');
    });
  });
});

/* --------------------- T-04 / T-05 不存在与不是目录 --------------------- */

test('TX-04 不存在的目录 → 404，不是 200 空页', async () => {
  await withFixture(async ({ root }) => {
    await withLegacy(root, async (server) => {
      const res = await call(server, '/api/tree?dir=nope');
      assert.equal(res.status, 404, `应为 404: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.errorCode, 'ERR_RESOURCE_NOT_FOUND');
      assert.equal(JSON.stringify(res.body).includes(root), false, '响应不得含绝对路径');
    });
  });
});

test('TX-05 dir 指向文件 → 404（ENOTDIR），不是空目录', async () => {
  await withFixture(async ({ root }) => {
    await withLegacy(root, async (server) => {
      const res = await call(server, '/api/tree?dir=README.md');
      assert.equal(res.status, 404, `应为 404: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.errorCode, 'ERR_RESOURCE_NOT_FOUND');
    });
  });
});

/* ------------------- T-03 / T-22 不可读 ≠ 授权不足 ------------------- */

test('TX-06 目录读不出来 → 403 ERR_DIR_UNREADABLE（不是 ERR_PERMISSION_DENIED）', async () => {
  await withFixture(async ({ root }) => {
    const faults = {
      beforeReadDir: (relativeDir: string) => {
        if (relativeDir === 'docs') {
          throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
        }
      },
    };
    await withLegacy(
      root,
      async (server) => {
        const res = await call(server, '/api/tree?dir=docs');
        assert.equal(res.status, 403, `应为 403: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.errorCode, 'ERR_DIR_UNREADABLE');
        assert.notEqual(res.body.errorCode, 'ERR_PERMISSION_DENIED');
        const text = JSON.stringify(res.body);
        assert.equal(text.includes(root), false, '不可读响应不得泄露绝对路径');
        assert.equal(text.includes('docs'), false, '不可读响应不得回显路径片段');
        assert.match(String(res.body.message ?? ''), /无法读取/, '文案必须说"无法读取"，不能说"权限不足"');
        assert.doesNotMatch(String(res.body.message ?? ''), /权限/);

        // 其他层仍可正常读取：故障是"这一层读不出来"，不是"整个项目坏了"
        const ok = await call(server, '/api/tree');
        assert.equal(ok.status, 200);
      },
      faults,
    );
  });
});

test('TX-07 未授权项目 → 403 ERR_PERMISSION_DENIED（与不可读严格区分）', async () => {
  await withFixture(async ({ root }) => {
    const server = await createShellServer({
      workspace: configOf([{ projectId: 'project-a', name: 'A', rootDir: root }]),
      grantedProjects: [],
      port: 0,
    });
    try {
      const res = await call(server, '/api/tree?projectId=project-a');
      assert.equal(res.status, 403, `应为 403: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.errorCode, 'ERR_PERMISSION_DENIED');
      assert.notEqual(res.body.errorCode, 'ERR_DIR_UNREADABLE', '授权不足不得复用目录不可读的错误码');
      assert.match(String(res.body.message ?? ''), /权限/);
    } finally {
      await server.close().catch(() => {});
    }
  });
});

/* --------------------------- T-21 链接 --------------------------- */

test('TX-21 链接显示为 link 叶子、id 走 link: 命名空间、展开被拒且不跟随', async () => {
  if (!HAS_JUNCTION) {
    assert.ok(NOT_RUN_J);
    return;
  }
  await withFixture(async ({ root, outside }) => {
    await withLegacy(root, async (server) => {
      const res = await call(server, '/api/tree');
      assert.equal(res.status, 200);
      const link = entriesOf(res.body).find((entry) => entry.name === 'linked-out');
      assert.ok(link, '链接必须显示（静默隐藏会让用户以为文件丢了）');
      assert.equal(link?.kind, 'link');
      assert.match(String(link?.id), /^link:/, `link 必须走独立命名空间: ${link?.id}`);
      assert.notEqual(link?.id, `dir:project-a/linked-out`);
      assert.notEqual(link?.id, `doc:project-a/linked-out`);

      // 不跟随：把 dir 指向链接本身必须被拒
      const expand = await call(server, '/api/tree?dir=linked-out');
      assert.equal(expand.status, 400, `链接不可展开: ${JSON.stringify(expand.body)}`);
      assert.equal(expand.body.errorCode, 'ERR_DIR_IS_LINK');

      // 也没有把根外的 secret.txt 暴露出来
      const root = await call(server, '/api/tree');
      assert.equal(JSON.stringify(root.body).includes('secret.txt'), false, '不得越过项目根');
    });
    assert.ok(outside);
  });
});

/* --------------------------- T-06 排序 --------------------------- */

test('TX-06b 排序：目录与链接在前、文件在后、同组按 zh-Hans-CN，且两次一致', async () => {
  await withFixture(async ({ root }) => {
    await withLegacy(root, async (server) => {
      const first = entriesOf((await call(server, '/api/tree')).body);
      const second = entriesOf((await call(server, '/api/tree')).body);
      assert.deepEqual(namesOf(first), namesOf(second), '同一份磁盘内容两次顺序必须一致');

      const firstFile = first.findIndex((entry) => entry.kind === 'file');
      const lastDirLike = first.reduce((acc, entry, index) => (entry.kind === 'file' ? acc : index), -1);
      assert.ok(
        firstFile === -1 || lastDirLike < firstFile,
        `目录/链接必须全部排在文件之前: ${namesOf(first).join(',')}`,
      );

      // 文件组内按字典序（zh-Hans-CN）
      const files = first.filter((entry) => entry.kind === 'file').map((entry) => entry.name);
      const sorted = [...files].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN') || (a < b ? -1 : 1));
      assert.deepEqual(files, sorted);
    });
  });
});

/* --------------------------- T-08 id 命名空间 --------------------------- */

test('TX-08 id 命名空间：dir:/doc: 带 projectId，跨项目不撞', async () => {
  await withFixture(async ({ base, root }) => {
    const other = join(base, 'other');
    await mkdir(join(other, 'docs'), { recursive: true });
    await writeFile(join(other, 'README.md'), '# other\n', 'utf8');

    const server = await createShellServer({
      workspace: configOf([
        { projectId: 'project-a', name: 'A', rootDir: root },
        { projectId: 'project-b', name: 'B', rootDir: other },
      ]),
      grantedProjects: ['project-a', 'project-b'],
      port: 0,
    });
    try {
      const a = entriesOf((await call(server, '/api/tree?projectId=project-a')).body);
      const b = entriesOf((await call(server, '/api/tree?projectId=project-b')).body);

      const aReadme = a.find((entry) => entry.name === 'README.md');
      const bReadme = b.find((entry) => entry.name === 'README.md');
      assert.equal(aReadme?.id, 'doc:project-a/README.md');
      assert.equal(bReadme?.id, 'doc:project-b/README.md');
      assert.notEqual(aReadme?.id, bReadme?.id);

      const aDocs = a.find((entry) => entry.name === 'docs');
      assert.equal(aDocs?.id, 'dir:project-a/docs');

      // 用 A 的 projectId 读 B 的路径：不存在的目录 → 404（不得跨项目落到 B）
      const cross = await call(server, '/api/tree?projectId=project-a&dir=README.md');
      assert.equal(cross.status, 404);
    } finally {
      await server.close().catch(() => {});
    }
  });
});

/* --------------------------- T-09 旧端点不动 --------------------------- */

test('TX-09 /api/resources 输出形状与过滤规则完全不变（旧实现冻结）', async () => {
  await withFixture(async ({ root }) => {
    await withLegacy(root, async (server) => {
      const res = await call(server, '/api/resources');
      assert.equal(res.status, 200);
      const nodes = res.body.nodes as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(nodes));
      const flat = JSON.stringify(nodes);
      // 旧端点仍然只列可编辑文本，且 kind 仍是 markdown/text（不跟随新契约改）
      assert.match(flat, /"kind":"markdown"/);
      assert.match(flat, /"kind":"text"/);
      assert.equal(flat.includes('pic.png'), false, '旧端点不得包含二进制');
      assert.equal(flat.includes('empty'), false, '旧端点无法表达空目录');
      assert.equal(flat.includes('"link"'), false);
    });
  });
});

/* --------------------------- T-10 dir 校验 --------------------------- */

test('TX-10 非法 dir 一律 400 且不读盘', async () => {
  await withFixture(async ({ root }) => {
    let reads = 0;
    const faults = { beforeReadDir: () => { reads += 1; } };
    await withLegacy(
      root,
      async (server) => {
        const bad = [
          '..',
          '../etc',
          'docs/../../outside',
          'C:/Windows',
          'C:docs',
          '//server/share',
          '/etc/passwd',
          'docs\\notes.md',
          './docs',
          'docs/./sub',
          'docs//sub',
          'README.md\u0000.png',
        ];
        for (const dir of bad) {
          const res = await call(server, `/api/tree?dir=${encodeURIComponent(dir)}`);
          assert.equal(res.status, 400, `dir=${JSON.stringify(dir)} 应为 400，实际 ${res.status}`);
          assert.equal(res.body.errorCode, 'ERR_COMMAND_INVALID', `dir=${JSON.stringify(dir)}`);
        }
        assert.equal(reads, 0, '非法 dir 必须在触碰磁盘之前被拒绝');
      },
      faults,
    );
  });
});

/* --------------------------- T-11 / T-12 项目门禁 --------------------------- */

test('TX-11 Multi：projectId 缺失 400 / 不存在 404 / 不可用 503', async () => {
  await withFixture(async ({ base, root }) => {
    const gone = join(base, 'gone');
    const server = await createShellServer({
      workspace: configOf([
        { projectId: 'project-a', name: 'A', rootDir: root },
        { projectId: 'project-b', name: 'B', rootDir: gone },
      ]),
      grantedProjects: ['project-a', 'project-b'],
      port: 0,
    });
    try {
      const missing = await call(server, '/api/tree');
      assert.equal(missing.status, 400);
      assert.equal(missing.body.errorCode, 'ERR_PROJECT_REQUIRED');

      const notFound = await call(server, '/api/tree?projectId=project-z');
      assert.equal(notFound.status, 404);
      assert.equal(notFound.body.errorCode, 'ERR_PROJECT_NOT_FOUND');

      const unavailable = await call(server, '/api/tree?projectId=project-b');
      assert.equal(unavailable.status, 503, `应为 503: ${JSON.stringify(unavailable.body)}`);
      assert.equal(unavailable.body.errorCode, 'ERR_PROJECT_UNAVAILABLE');
    } finally {
      await server.close().catch(() => {});
    }
  });
});

test('TX-16 屏障期（QUIESCING）→ 409，且在读盘之前被拒', async () => {
  await withFixture(async ({ root }) => {
    let reads = 0;
    const server = await createShellServer({
      managed: {
        create: () =>
          ({
            list: () => [{ projectId: 'project-a', name: 'A', status: 'READY' }],
            assertUsable: () => {
              throw Object.assign(new Error('quiescing'), { errorCode: 'ERR_PROJECT_QUIESCING' });
            },
            withDiskOp: async () => {
              reads += 1;
              throw new Error('不应进入磁盘操作');
            },
            isAcceptingViews: () => false,
            providerOf: () => undefined,
            workspaceKey: () => 'k',
          }) as unknown as ProjectRuntime,
      },
      port: 0,
    });
    try {
      const res = await call(server, '/api/tree?projectId=project-a');
      assert.equal(res.status, 409, `屏障期应为 409: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.errorCode, 'ERR_PROJECT_QUIESCING');
      assert.equal(reads, 0);
    } finally {
      await server.close().catch(() => {});
    }
    assert.ok(root);
  });
});

/* --------------------------- T-14 分页 --------------------------- */

async function makeMany(dir: string, count: number): Promise<void> {
  // 分批写入：2001 个文件在小文件系统上逐条 await 会拖慢整套门禁
  const batch = 200;
  for (let start = 0; start < count; start += batch) {
    const todo: Array<Promise<void>> = [];
    for (let i = start; i < Math.min(start + batch, count); i += 1) {
      todo.push(writeFile(join(dir, `f${String(i).padStart(5, '0')}.txt`), 'x', 'utf8'));
    }
    await Promise.all(todo);
  }
}

async function fetchAll(
  server: ShellServer,
  dir: string,
  limit: number,
): Promise<{ names: string[]; total: number; pages: number }> {
  const names: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let total = 0;
  for (;;) {
    const query = new URLSearchParams({ dir, limit: String(limit) });
    if (cursor !== null) query.set('cursor', cursor);
    const res = await call(server, `/api/tree?${query.toString()}`);
    assert.equal(res.status, 200, `分页请求失败: ${JSON.stringify(res.body)}`);
    const page = pageOf(res.body);
    const entries = entriesOf(res.body);
    total = page.total;
    pages += 1;
    names.push(...namesOf(entries));
    if (page.nextCursor === null) {
      assert.equal(names.length, total, `nextCursor 归零时已取 ${names.length} 条，但 total=${total}（静默截断）`);
      break;
    }
    assert.ok(entries.length > 0, 'nextCursor 非空时这一页不得为空');
    cursor = page.nextCursor;
    assert.ok(pages < 100, '分页未收敛，可能是游标实现错误');
  }
  return { names, total, pages };
}

test('TX-14 单层 2001 项：limit=2000 时两页取完，nextCursor 归零即全覆盖', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-tree-many-'));
  try {
    await makeMany(base, 2001);
    await withLegacy(base, async (server) => {
      const first = await call(server, '/api/tree?limit=2000');
      assert.equal(first.status, 200);
      assert.equal(entriesOf(first.body).length, 2000);
      const page = pageOf(first.body);
      assert.equal(page.total, 2001);
      assert.equal(page.nextCursor, '2000', '还有 1 项时必须给出下一页游标');
      assert.equal(page.limit, 2000);

      const second = await call(server, `/api/tree?limit=2000&cursor=${page.nextCursor}`);
      assert.equal(second.status, 200);
      assert.equal(entriesOf(second.body).length, 1);
      assert.equal(pageOf(second.body).nextCursor, null);
      assert.equal(pageOf(second.body).cursor, '2000');
    });
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

test('TX-14b 完整分页遍历：无重复、无遗漏、按序拼接', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-tree-walk-'));
  try {
    await makeMany(base, 23);
    await withLegacy(base, async (server) => {
      const walked = await fetchAll(server, '', 7);
      assert.equal(walked.total, 23);
      assert.equal(walked.names.length, 23);
      assert.deepEqual([...new Set(walked.names)].length, 23, '不得出现重复条目');
      assert.equal(walked.pages, 4, '23 项 / 每页 7 → 4 页');

      const once = entriesOf((await call(server, '/api/tree?limit=2000')).body).map((e) => e.name);
      assert.deepEqual(walked.names, once, '分页拼接的顺序必须与整层排序完全一致');
    });
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

test('TX-14c limit 取 1 / 7 / 2000 得到同一序列', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-tree-limit-'));
  try {
    await makeMany(base, 9);
    await withLegacy(base, async (server) => {
      const one = await fetchAll(server, '', 1);
      const seven = await fetchAll(server, '', 7);
      const all = await fetchAll(server, '', 2000);
      assert.deepEqual(one.names, seven.names);
      assert.deepEqual(seven.names, all.names);
      assert.equal(one.pages, 9);
    });
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

test('TX-14d cursor / limit 非法 → 400 且不读盘', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-tree-bad-'));
  try {
    await makeMany(base, 3);
    let reads = 0;
    const faults = { beforeReadDir: () => { reads += 1; } };
    await withLegacy(
      base,
      async (server) => {
        for (const cursor of ['-1', 'abc', '1.5', '1e3', ' ']) {
          const res = await call(server, `/api/tree?cursor=${encodeURIComponent(cursor)}`);
          assert.equal(res.status, 400, `cursor=${JSON.stringify(cursor)} 应为 400`);
          assert.equal(res.body.errorCode, 'ERR_COMMAND_INVALID');
        }
        for (const limit of ['0', '2001', '-5', 'x']) {
          const res = await call(server, `/api/tree?limit=${encodeURIComponent(limit)}`);
          assert.equal(res.status, 400, `limit=${JSON.stringify(limit)} 应为 400`);
          assert.equal(res.body.errorCode, 'ERR_COMMAND_INVALID');
        }
        // 游标超出总数：幂等终点，不报错
        const beyond = await call(server, '/api/tree?cursor=999');
        assert.equal(beyond.status, 200);
        assert.deepEqual(entriesOf(beyond.body), []);
        assert.equal(pageOf(beyond.body).nextCursor, null);
        assert.equal(reads, 1, '只有那次合法请求碰过磁盘');
      },
      faults,
    );
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

/* --------------------------- T-15 零泄露 --------------------------- */

test('TX-15 响应不含本机绝对路径 / providerId / rootToken', async () => {
  await withFixture(async ({ root }) => {
    await withLegacy(root, async (server) => {
      const res = await call(server, '/api/tree');
      const text = JSON.stringify(res.body);
      assert.equal(text.includes(root), false);
      assert.equal(text.includes(root.replace(/\\/g, '\\\\')), false);
      assert.doesNotMatch(text, /rootToken|canonicalRoot|providerId|local:/);
      assert.doesNotMatch(text, /[A-Za-z]:\\\\/, '不得出现盘符路径');
    });
  });
});
