/**
 * UX-02C-03-P2-01：单文件可恢复删除（Host 语义 + 真实磁盘）。
 *
 * 取证方式：真实 `createShellServer` + 真实 `FileProjectStore` + 真实 `LocalProvider`
 * + 真实临时磁盘 + 真实 HTTP。**不使用 mock**：本套件断言的是"磁盘上发生了什么"，
 * 而不是"某个函数被调用过"。
 *
 * 与 87 的分工：
 * - 87（本文件）：回收/恢复的正常路径与拒绝路径、容量、opId 幂等、撤销保留；
 * - 88：保留命名空间守卫 + 会话屏障（活动 View / 未保存草稿）；
 * - 89：事务中断（意图写失败 / 移动成功但提交失败 / 恢复中断）与重启对账。
 */
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { serializeConfig } from '../../apps/server/src/store/config.ts';
import { createFileProjectStore } from '../../apps/server/src/store/index.ts';
import { createNodeStoreIo, type StoreIo } from '../../apps/server/src/store/io.ts';
import { rootTokenOf } from '../../packages/storage/index.ts';

const PROJ = 'project-a';
const TRASH_ROOT = '.weavespace';
const OP = 'op-trash-0001';

interface ApiResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  status: number;
}

interface Ctx {
  base: string;
  root: string;
  storeDir: string;
  server: ShellServer;
  api: {
    post(path: string, body: unknown): Promise<ApiResponse>;
    get(path: string): Promise<ApiResponse>;
    trash(path: string, opId?: string): Promise<ApiResponse>;
    restore(opId?: string): Promise<ApiResponse>;
    trashList(): Promise<ApiResponse>;
    tree(): Promise<ApiResponse>;
    openSave(path: string, buffer: string): Promise<ApiResponse>;
    open(path: string): Promise<ApiResponse>;
    edit(sessionId: string, viewId: string | null, buffer: string, expectedVersion: string | null): Promise<ApiResponse>;
  };
  payloadPath(opId?: string): string;
  rootHas(name: string): boolean;
  restart(): Promise<void>;
}

function makeStoreIo(): { io: StoreIo; failure: { config: boolean } } {
  const real = createNodeStoreIo();
  const failure = { config: false };
  const io: StoreIo = {
    ...real,
    rename(from, to) {
      if (failure.config && String(to).endsWith('workspace.json')) {
        throw new Error('rename 失败（测试注入）');
      }
      real.rename(from, to);
    },
  };
  return { io, failure };
}

async function withHost(
  fn: (ctx: Ctx) => Promise<void>,
  options: { seed?: (root: string, storeDir: string) => Promise<void> } = {},
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-p2-'));
  const storeDir = join(base, 'store');
  const root = join(base, 'project-a');
  await mkdir(storeDir, { recursive: true });
  await mkdir(root, { recursive: true });
  for (const name of ['a.md', 'b.md', 'c.md']) {
    await writeFile(join(root, name), `# ${name}\n`, 'utf8');
  }

  const project = {
    projectId: PROJ,
    name: '项目 A',
    rootDir: root,
    canonicalRoot: realpathSync(root),
    rootToken: rootTokenOf(root),
    grantedAt: '2026-11-22T00:00:00.000Z',
    grantSource: 'os-dialog',
  };
  await writeFile(
    join(storeDir, 'workspace.json'),
    serializeConfig({
      version: 2,
      commitSeq: 0,
      issuedIds: [PROJ],
      revoked: [],
      projects: [project],
    }),
    'utf8',
  );
  if (options.seed) await options.seed(root, storeDir);

  const { io, failure } = makeStoreIo();
  let server = await createShellServer({
    port: 0,
    managedStore: { dir: storeDir, picker: createFakePicker([]), storeIo: io },
  });
  let token = ((await (await fetch(`${server.url}/api/session-token`)).json()) as { token?: string }).token ?? '';

  const api = {
    async post(path: string, body: unknown): Promise<ApiResponse> {
      const res = await fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ws-token': token, origin: server.url },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    async get(path: string): Promise<ApiResponse> {
      const res = await fetch(`${server.url}${path}`, { headers: { 'x-ws-token': token } });
      return { status: res.status, body: await res.json() };
    },
    trash(path: string, opId = OP) {
      return api.post('/api/trash/entry', { projectId: PROJ, path, opId });
    },
    restore(opId = OP) {
      return api.post('/api/trash/restore', { projectId: PROJ, opId });
    },
    trashList() {
      return api.get(`/api/trash?projectId=${PROJ}`);
    },
    tree() {
      return api.get(`/api/tree?projectId=${PROJ}`);
    },
    async open(path: string) {
      return api.post('/api/open', { projectId: PROJ, path });
    },
    async edit(
      sessionId: string,
      viewId: string | null,
      buffer: string,
      expectedVersion: string | null,
    ) {
      return api.post('/api/edit', { sessionId, viewId, buffer, expectedVersion });
    },
    async openSave(path: string, buffer: string) {
      const opened = await api.open(path);
      if (opened.status !== 200) return opened;
      const { sessionId, viewId, baseVersion } = opened.body.document;
      const edited = await api.edit(sessionId, viewId, buffer, baseVersion);
      if (edited.status !== 200) return edited;
      return api.post('/api/save', { sessionId, viewId, expectedVersion: edited.body.document.baseVersion });
    },
  };

  const ctx: Ctx = {
    base,
    root,
    storeDir,
    server,
    api,
    payloadPath: (opId = OP) => join(root, TRASH_ROOT, 'trash', opId, 'payload'),
    rootHas: (name) => {
      try {
        lstatSync(join(root, name));
        return true;
      } catch {
        return false;
      }
    },
    async restart() {
      await server.close();
      server = await createShellServer({
        port: 0,
        managedStore: { dir: storeDir, picker: createFakePicker([]), storeIo: io },
      });
      ctx.server = server;
      token = ((await (await fetch(`${server.url}/api/session-token`)).json()) as { token?: string }).token ?? '';
    },
  };

  try {
    await fn(ctx);
  } finally {
    void failure;
    await server.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

/* ================================================================== */
/* 正常路径                                                            */
/* ================================================================== */

test('P2-01a 普通文件回收：源消失、payload 就位、记录 stored、树里消失、证据可查', async () => {
  await withHost(async (h) => {
    const res = await h.api.trash('a.md');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'APPLIED');
    assert.equal(res.body.opId, OP);
    assert.equal(res.body.entry.state, 'stored');
    assert.equal(res.body.entry.path, 'a.md', '响应只给项目内相对路径');

    assert.equal(h.rootHas('a.md'), false, '源必须消失');
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\n', 'payload 内容与原文一致');

    const tree = await h.api.tree();
    const names = (tree.body.entries as { name: string }[]).map((entry) => entry.name);
    assert.ok(!names.includes('a.md'), '默认视图里看不到');
    assert.ok(!names.includes(TRASH_ROOT), '内部目录不得出现在文件树里');

    const list = await h.api.trashList();
    assert.equal(list.body.entries.length, 1);
    assert.equal(list.body.entries[0].state, 'stored');
    assert.equal(list.body.entries[0].canRestore, true);

    const op = await h.api.get(`/api/trash/op?opId=${OP}`);
    assert.equal(op.body.outcome, 'trashed');
    assert.equal(op.body.state, 'stored');
  });
});

test('P2-01b 恢复：回到原路径、对象身份不变、树里回来、记录 restored', async () => {
  await withHost(async (h) => {
    const before = lstatSync(join(h.root, 'a.md'));
    assert.equal((await h.api.trash('a.md')).status, 200);
    const trashed = lstatSync(h.payloadPath());

    const res = await h.api.restore();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'APPLIED');
    assert.equal(res.body.entry.state, 'restored');

    const after = lstatSync(join(h.root, 'a.md'));
    assert.equal(`${after.dev}:${after.ino}`, `${before.dev}:${before.ino}`, '恢复的是同一个对象');
    assert.equal(`${after.dev}:${after.ino}`, `${trashed.dev}:${trashed.ino}`, 'rename 全程保持身份');
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# a.md\n');
    assert.equal(h.rootHas(join(TRASH_ROOT, 'trash', OP, 'payload')), false, 'payload 已移出');

    const tree = await h.api.tree();
    assert.ok((tree.body.entries as { name: string }[]).some((entry) => entry.name === 'a.md'));
  });
});

test('P2-01c 二进制文件：不做文本解码也能回收与恢复，字节完全不变', async () => {
  await withHost(async (h) => {
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00, 0x41, 0x80, 0x7f, 0x00]);
    await writeFile(join(h.root, 'bin.dat'), bytes);

    const res = await h.api.trash('bin.dat');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.entry.size, bytes.length);
    assert.deepEqual(readFileSync(h.payloadPath()), bytes, '移入不得改变字节');

    assert.equal((await h.api.restore()).status, 200);
    assert.deepEqual(readFileSync(join(h.root, 'bin.dat')), bytes);
  });
});

/* ================================================================== */
/* 拒绝路径                                                            */
/* ================================================================== */

test('P2-01d 链接 / junction 全部拒绝，且零磁盘副作用', async () => {
  await withHost(async (h) => {
    const { symlinkSync } = await import('node:fs');
    symlinkSync(join(h.root, 'a.md'), join(h.root, 'link-to-file'), 'file');
    symlinkSync(h.root, join(h.root, 'junction-to-root'), 'junction');

    for (const path of ['link-to-file', 'junction-to-root']) {
      const res = await h.api.trash(path);
      assert.equal(res.status, 400, `${path} 必须被拒绝：${JSON.stringify(res.body)}`);
      assert.equal(res.body.errorCode, 'ERR_TRASH_KIND_UNSUPPORTED');
      assert.equal(h.rootHas(path), true, '链接本身不得被删除或移动');
      assert.equal(h.rootHas('a.md'), true, '链接目标绝不能被动到');
    }
    assert.equal(h.rootHas(TRASH_ROOT), false, '全部拒绝时不得创建回收区目录');
    assert.equal((await h.api.trashList()).body.entries.length, 0);
  });
});

test('P2-01e 目录拒绝：本阶段只支持普通文件', async () => {
  await withHost(async (h) => {
    await mkdir(join(h.root, 'docs'));
    await writeFile(join(h.root, 'docs', 'guide.md'), '# g\n');
    const res = await h.api.trash('docs');
    assert.equal(res.status, 400);
    assert.equal(res.body.errorCode, 'ERR_TRASH_KIND_UNSUPPORTED');
    assert.equal(readFileSync(join(h.root, 'docs', 'guide.md'), 'utf8'), '# g\n');
    assert.equal(h.rootHas(TRASH_ROOT), false);
  });
});

test('P2-01f 恢复时原位置已有同名文件：409 拒绝，绝不覆盖', async () => {
  await withHost(async (h) => {
    assert.equal((await h.api.trash('a.md')).status, 200);
    await writeFile(join(h.root, 'a.md'), '# NEW FILE AT SAME PATH\n', 'utf8');

    const res = await h.api.restore();
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_ENTRY_EXISTS');
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# NEW FILE AT SAME PATH\n', '新文件必须原样保留');

    const list = await h.api.trashList();
    assert.equal(list.body.entries[0].state, 'stored', '记录仍可恢复');
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\n', '回收区内容不受影响');
  });
});

test('P2-01g 回收区目标冲突：不覆盖回收区里已有的对象', async () => {
  await withHost(async (h) => {
    // 先做一次正常回收，让 .weavespace 与 marker 就位
    assert.equal((await h.api.trash('b.md', 'op-trash-setup')).status, 200);

    const conflictOp = 'op-trash-0007';
    const dir = join(h.root, TRASH_ROOT, 'trash', conflictOp);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'payload'), 'FOREIGN OBJECT\n', 'utf8');

    const res = await h.api.trash('a.md', conflictOp);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_ENTRY_EXISTS');
    assert.equal(readFileSync(join(dir, 'payload'), 'utf8'), 'FOREIGN OBJECT\n', '外部对象必须原样保留');
    assert.equal(h.rootHas('a.md'), true, '源文件仍在原处');
  });
});

/* ================================================================== */
/* 幂等与容量                                                          */
/* ================================================================== */

test('P2-01h opId 幂等重放：同一 opId 不产生第二次移动；换个路径必须冲突', async () => {
  await withHost(async (h) => {
    assert.equal((await h.api.trash('a.md')).status, 200);
    const replay = await h.api.trash('a.md');
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.entry.state, 'stored');

    const conflict = await h.api.trash('b.md');
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.errorCode, 'ERR_OP_ID_CONFLICT');
    assert.equal(h.rootHas('b.md'), true, '冲突时不得移动 b.md');
  });
});

test('P2-01i 容量上限：已有 500 条未解决记录时拒绝第 501 个', async () => {
  await withHost(
    async (h) => {
      const res = await h.api.trash('a.md');
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.errorCode, 'ERR_TRASH_FULL');
      assert.equal(h.rootHas('a.md'), true, '拒绝时零磁盘副作用');
      assert.equal(h.rootHas(TRASH_ROOT), false);
    },
    {
      async seed(root, storeDir) {
        // 直接把 500 条 stored 记录写进配置：容量判定读的是持久化事实，不是内存计数器
        const records = Array.from({ length: 500 }, (_, index) => ({
          opId: `op-seed-${String(index).padStart(4, '0')}`,
          projectId: PROJ,
          rootToken: rootTokenOf(root),
          originalPath: `seed-${index}.md`,
          entryKind: 'file' as const,
          identity: `1:${1000 + index}`,
          size: 1,
          deletedAt: '2026-11-22T00:00:00.000Z',
          // 用 conflicted 而不是 stored：启动对账会把"源与回收区都不存在"的 stored
          // 记录收敛成 missing（正确行为），那样就测不到容量了。conflicted 同样是"未解决"，
          // 但需要对人工核对，不会被自动改变。
          state: 'conflicted' as const,
        }));
        writeFileSync(
          join(storeDir, 'workspace.json'),
          serializeConfig({
            version: 4,
            commitSeq: 0,
            issuedIds: [PROJ],
            revoked: [],
            projects: [
              {
                projectId: PROJ,
                name: '项目 A',
                rootDir: root,
                canonicalRoot: realpathSync(root),
                rootToken: rootTokenOf(root),
                grantedAt: '2026-11-22T00:00:00.000Z',
                grantSource: 'os-dialog',
              },
            ],
            hidden: [],
            trash: records,
          }),
          'utf8',
        );
      },
    },
  );
});

/* ================================================================== */
/* 项目撤销                                                            */
/* ================================================================== */

test('P2-01j 项目撤销：回收记录不被静默删除，payload 仍在磁盘', async () => {
  await withHost(async (h) => {
    assert.equal((await h.api.trash('a.md')).status, 200);
    const removed = await h.api.post('/api/projects/remove', {
      projectId: PROJ,
      confirm: 'remove-from-workspace',
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));

    // 应用内入口随之失效（项目已不在工作区）
    const after = await h.api.trashList();
    assert.ok(after.status === 404 || after.status === 503, `撤销后不得继续提供恢复入口：${after.status}`);

    // 但记录与文件都还在：配置里仍有该 opId，磁盘上 payload 仍在
    const config = JSON.parse(await readFile(join(h.storeDir, 'workspace.json'), 'utf8'));
    assert.equal(
      (config.trash as { opId: string }[]).some((entry) => entry.opId === OP),
      true,
      '撤销不得静默丢弃回收记录',
    );
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\n', '回收区文件必须留在项目目录里');
  });
});
