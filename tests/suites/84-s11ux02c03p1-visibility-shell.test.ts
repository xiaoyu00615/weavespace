/**
 * UX-02C-03-P1：Shell 侧的可见性状态与交互判定（真实 Host + 真实磁盘）。
 *
 * 分工：
 * - 套件 82/83 证明 Host 的记录语义与分页语义；
 * - 本套件证明 **Shell 真的把 `includeHidden` 发出去了**、DTO 的隐藏标记进了层表，
 *   以及"菜单什么时候该给「隐藏」/「取消隐藏」"这条判定是纯函数、可被断言。
 *
 * 全部使用真实 HTTP 往返（不 mock fetch 行为），只有菜单判定是纯函数。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { serializeConfig } from '../../apps/server/src/store/config.ts';
import { createLiveClient, type WeaveSpaceClient } from '../../apps/shell/src/client/client-api.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import {
  ROOT_LEVEL,
  applyPage,
  countHiddenEntries,
  emptyLevels,
  entryToNode,
  materializeTree,
} from '../../apps/shell/src/components/tree-model.ts';
import {
  visibilityCommandState,
  visibilityNotice,
} from '../../apps/shell/src/state/visibility.ts';
import { rootTokenOf } from '../../packages/storage/path-safety.ts';

const PROJ = 'project-a';

interface Ctx {
  root: string;
  server: ShellServer;
  client: WeaveSpaceClient;
  token: string;
  post(path: string, body: unknown): Promise<Response>;
  get(path: string): Promise<Response>;
}

async function withShell(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-p1-shell-'));
  const root = join(base, 'project-a');
  const storeDir = join(base, 'store');
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(storeDir, { recursive: true });
  await writeFile(join(root, 'a.md'), '# A\n', 'utf8');
  await writeFile(join(root, 'b.md'), '# B\n', 'utf8');
  await writeFile(join(root, 'docs', 'guide.md'), '# guide\n', 'utf8');
  await writeFile(
    join(storeDir, 'workspace.json'),
    serializeConfig({
      version: 2,
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
          grantedAt: '2026-11-18T00:00:00.000Z',
          grantSource: 'os-dialog',
        },
      ],
    }),
    'utf8',
  );

  const server = await createShellServer({
    port: 0,
    managedStore: { dir: storeDir, picker: createFakePicker([]) },
  });
  const tokenRes = await fetch(`${server.url}/api/session-token`);
  const token = ((await tokenRes.json()) as { token?: string }).token ?? '';
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${server.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ws-token': token, origin: server.url },
      body: JSON.stringify(body),
    });
  const get = (path: string): Promise<Response> =>
    fetch(`${server.url}${path}`, { headers: { 'x-ws-token': token } });

  /**
   * 浏览器对**所有** POST 都会自动带上 `Origin`（含同源），Node 的 fetch 不会。
   *
   * 为了让"真实 HTTP 往返"能验证到 Host 的同源门禁，这里在测试侧补上这个头——
   * 它模拟的是浏览器行为，**不是**绕过被测代码：客户端的请求构造完全不参与。
   */
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof originalFetch>[0], init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && init && init.headers && !('origin' in (init.headers as Record<string, string>))) {
      return originalFetch(input, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), origin: new URL(server.url).origin },
      });
    }
    return originalFetch(input, init);
  }) as typeof originalFetch;

  try {
    await fn({ root, server, client: createLiveClient(server.url), token, post, get });
  } finally {
    globalThis.fetch = originalFetch;
    await server.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */

test('P1-03a 客户端把 includeHidden 真实发给 Host，并把 hidden 标记带进结果', async () => {
  await withShell(async (h) => {
    const before = await h.client.listTree(PROJ, '', null, undefined, null);
    assert.equal(before.status, 'APPLIED');
    assert.ok(
      before.status === 'APPLIED' && before.entries.some((entry) => entry.relPath === 'a.md'),
      '隐藏前必须能看到 a.md',
    );

    assert.equal((await h.post('/api/workspace/hide', { projectId: PROJ, path: 'a.md' })).status, 200);

    const hidden = await h.client.listTree(PROJ, '', null, undefined, null);
    assert.equal(hidden.status, 'APPLIED');
    assert.ok(
      hidden.status === 'APPLIED' && !hidden.entries.some((entry) => entry.relPath === 'a.md'),
      '默认请求不得再返回被隐藏的条目',
    );

    const shown = await h.client.listTree(PROJ, '', null, undefined, null, { includeHidden: true });
    assert.equal(shown.status, 'APPLIED');
    const a = shown.status === 'APPLIED' ? shown.entries.find((entry) => entry.relPath === 'a.md') : undefined;
    assert.ok(a, 'includeHidden 必须真的生效（不是界面上的假开关）');
    assert.equal(a?.hidden, true);
  });
});

test('P1-03b 客户端的隐藏 / 取消隐藏调用可用，且报告 changed 语义', async () => {
  await withShell(async (h) => {
    const before = await readFile(join(h.root, 'a.md'), 'utf8');
    const first = await h.client.hideEntry(PROJ, 'a.md');
    assert.equal(first.status, 'APPLIED', JSON.stringify(first));
    assert.equal(first.status === 'APPLIED' && first.changed, true);

    const again = await h.client.hideEntry(PROJ, 'a.md');
    assert.equal(again.status, 'APPLIED');
    assert.equal(again.status === 'APPLIED' && again.changed, false);

    const back = await h.client.unhideEntry(PROJ, 'a.md');
    assert.equal(back.status, 'APPLIED');
    assert.equal(back.status === 'APPLIED' && back.changed, true);

    assert.equal(await readFile(join(h.root, 'a.md'), 'utf8'), before, '隐藏/取消隐藏不得改动磁盘内容');
  });
});

test('P1-03c 隐藏记录查询客户端与服务端一致（含失效状态）', async () => {
  await withShell(async (h) => {
    assert.equal((await h.post('/api/workspace/hide', { projectId: PROJ, path: 'docs' })).status, 200);
    const list = await h.client.hiddenEntries(PROJ);
    assert.equal(list.status, 'APPLIED');
    assert.deepEqual(list.status === 'APPLIED' ? list.entries : [], [{ path: 'docs', state: 'active' }]);
  });
});

/* ------------------------------------------------------------------ */
/* 层表 / 渲染模型                                                     */
/* ------------------------------------------------------------------ */

test('P1-03d 隐藏标记穿过 entryToNode / applyPage / materializeTree 全程不丢', () => {
  const levels = applyPage(emptyLevels(), ROOT_LEVEL, {
    entries: [
      { id: 'doc:a.md', name: 'a.md', kind: 'file', extension: '.md', relPath: 'a.md', hidden: true },
      { id: 'dir:docs', name: 'docs', kind: 'folder', extension: '', relPath: 'docs', hiddenBy: 'hidden-root' },
    ],
    cursor: null,
    nextCursor: null,
    total: 2,
    snapshot: 'snap-1',
  });
  const entries = levels[ROOT_LEVEL].entries;
  assert.equal(entries[0].hidden, true);
  assert.equal(entries[1].hiddenBy, 'hidden-root');

  const nodes = materializeTree(levels);
  assert.equal(nodes.find((node) => node.id === 'doc:a.md')?.hidden, true, '物化成递归树后标记不能丢');
  assert.equal(countHiddenEntries(levels), 1, '只把"自身隐藏"计入隐藏条数，被上级隐藏的不重复计数');

  // 未带标记的条目不会被误标
  assert.equal(entryToNode({ id: 'doc:b.md', name: 'b.md', kind: 'file', extension: '.md', relPath: 'b.md' }).hidden, undefined);
});

test('P1-03e reducer：显示隐藏项是真实状态，切换后层表仍需重新取（TREE_RESET 保留展开态）', () => {
  assert.equal(INITIAL_STATE.showHidden, false, '默认不显示隐藏项');

  const opened = workspaceReducer(INITIAL_STATE, { type: 'SET_SHOW_HIDDEN', value: true });
  assert.equal(opened.showHidden, true);
  assert.equal(INITIAL_STATE.showHidden, false, 'reducer 不得原地改状态');

  // 切到"显示隐藏项"之后必须整层重取：已加载层里没有隐藏条目，留着就会显示成"什么都没变"
  const withLevel = workspaceReducer(opened, {
    type: 'TREE_LEVEL_PAGE',
    projectId: PROJ,
    dir: ROOT_LEVEL,
    entries: [{ id: 'doc:a.md', name: 'a.md', kind: 'file', extension: '.md', relPath: 'a.md' }],
    cursor: null,
    nextCursor: null,
    total: 1,
    snapshot: 'snap',
  });
  assert.equal(withLevel.treeByProject[PROJ][ROOT_LEVEL].entries.length, 1);

  const reset = workspaceReducer(withLevel, { type: 'TREE_RESET', projectId: PROJ });
  assert.equal(reset.treeByProject[PROJ][ROOT_LEVEL], undefined, '层表必须清空，才会重新拉取');
  assert.equal(reset.showHidden, true, '切换可见性不能顺手把开关状态改回去');
});

/* ------------------------------------------------------------------ */
/* 菜单判定（纯函数）                                                  */
/* ------------------------------------------------------------------ */

test('P1-03f 菜单判定：文件/文件夹/链接可隐藏；隐藏项给"取消隐藏"；项目根与空白区不提供', () => {
  const file = visibilityCommandState({
    target: { origin: 'file', projectId: PROJ, nodePath: 'docs/guide.md', nodeHidden: false },
    supported: true,
  });
  assert.deepEqual(file, { visible: true, action: 'hide', disabled: false });

  const folder = visibilityCommandState({
    target: { origin: 'folder', projectId: PROJ, nodePath: 'docs', nodeHidden: false },
    supported: true,
  });
  assert.equal(folder.action, 'hide');

  const link = visibilityCommandState({
    target: { origin: 'link', projectId: PROJ, nodePath: 'linked', nodeHidden: false },
    supported: true,
  });
  assert.equal(link.visible, false, '链接节点不提供隐藏（Host 会以"路径经过重解析点"拒绝）');

  const hidden = visibilityCommandState({
    target: { origin: 'file', projectId: PROJ, nodePath: 'a.md', nodeHidden: true },
    supported: true,
  });
  assert.deepEqual(hidden, { visible: true, action: 'unhide', disabled: false });

  const root = visibilityCommandState({
    target: { origin: 'project-root', projectId: PROJ, nodePath: null, nodeHidden: false },
    supported: true,
  });
  assert.equal(root.visible, false, '项目根不提供普通文件级隐藏（那是"移除项目"的另一条链路）');

  const blank = visibilityCommandState({
    target: { origin: 'blank', projectId: PROJ },
    supported: true,
  });
  assert.equal(blank.visible, false);
});

test('P1-03g 菜单判定：Demo / Legacy / 未授权项目明确禁用并给出原因（不隐藏入口）', () => {
  const demo = visibilityCommandState({
    target: { origin: 'file', projectId: PROJ, nodePath: 'a.md', nodeHidden: false },
    supported: false,
  });
  assert.equal(demo.visible, true, '入口仍然显示：不能让用户以为功能不存在');
  assert.equal(demo.disabled, true);
  assert.ok(demo.hint && demo.hint.length > 0);
});

test('P1-03h 提示文案：隐藏后必须说清"文件没被删除"', () => {
  const hide = visibilityNotice('docs/guide.md', true);
  assert.match(hide, /隐藏/);
  assert.match(hide, /未删除|没有删除|仍/);
  const unhide = visibilityNotice('docs/guide.md', false);
  assert.match(unhide, /恢复|显示/);
});
