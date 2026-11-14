/**
 * S11-UX-02B-TREE：Shell 数据层与 UI 契约的聚焦测试（文档 26 §7.3 T-15…T-20）。
 *
 * `.tsx` 无法 import 进 node:test，所以所有可测逻辑都放在纯 `.ts`：
 * `tree-model.ts`（分页/合并/缓存）、`workspace-reducer.ts`（派生视图/项目隔离）、
 * `workspace-restore.ts`（懒加载树下的标签解析）、`client-api.ts`（逐层请求形状）。
 * 视觉一致性由真实浏览器截图与 DOM 结构记录验证，不在本套件里冒充覆盖。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { TreeEntry } from '../../apps/shell/src/client/client-api.ts';
import { createLiveClient, createDemoClient } from '../../apps/shell/src/client/client-api.ts';
import {
  applyPage,
  beginLevel,
  countLoadedFiles,
  emptyLevels,
  entryToNode,
  failLevel,
  findEntryByPath,
  fromStaticTree,
  hasMore,
  materializeTree,
  normalizeDir,
  resetLevels,
} from '../../apps/shell/src/components/tree-model.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import { resolveRestorableNode } from '../../apps/shell/src/state/workspace-restore.ts';
import type { ResourceNodeState, WorkspaceState } from '../../apps/shell/src/state/types.ts';

/* ------------------------------- 夹具 ------------------------------- */

function entry(name: string, kind: TreeEntry['kind'] = 'file', dir = ''): TreeEntry {
  const relPath = dir ? `${dir}/${name}` : name;
  return {
    id: `${kind === 'folder' ? 'dir' : kind === 'link' ? 'link' : 'doc'}:p/${relPath}`,
    name,
    kind,
    extension: kind === 'file' && name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '',
    relPath,
  };
}

function page(entries: readonly TreeEntry[], cursor: string | null, nextCursor: string | null, total = entries.length) {
  return { entries, cursor, nextCursor, total };
}

const ROOT = resolve(process.cwd());

/* --------------------- T-15 单层合并与缓存隔离 --------------------- */

test('S-51-01 第一页替换整层；其它层的对象引用不变', () => {
  let levels = applyPage(emptyLevels(), '', page([entry('a.md'), entry('docs', 'folder')], null, null, 2));
  levels = applyPage(levels, 'docs', page([entry('deep.md', 'file', 'docs')], null, null, 1));
  const childBefore = levels['docs'];

  levels = applyPage(levels, '', page([entry('b.md')], null, null, 1));

  assert.deepEqual(levels[''].entries.map((n) => n.name), ['b.md'], '第一页必须替换');
  assert.equal(levels['docs'], childBefore, '兄弟层引用不得改变');
  assert.equal(childBefore.entries.length, 1);
});

test('S-51-02 续页追加而非替换；重复游标不产生重复条目；nextCursor 归零即结束', () => {
  let levels = applyPage(emptyLevels(), '', page([entry('a.md'), entry('b.md')], null, '2', 3));
  assert.equal(hasMore(levels, ''), true);
  levels = applyPage(levels, '', page([entry('c.md')], '2', null, 3));
  assert.deepEqual(levels[''].entries.map((n) => n.name), ['a.md', 'b.md', 'c.md']);
  assert.equal(hasMore(levels, ''), false);
  assert.equal(levels[''].total, 3);

  // 重复应用同一续页：按 id 去重（T-15b）
  const again = applyPage(levels, '', page([entry('c.md')], '2', null, 3));
  assert.equal(again[''].entries.length, 3, '重复加载同一游标不得出现重复行');
});

test('S-51-03 分页状态与已加载文件计数', () => {
  let levels = applyPage(emptyLevels(), '', page([entry('a.md'), entry('docs', 'folder')], null, null, 2));
  levels = applyPage(levels, 'docs', page([entry('x.md', 'file', 'docs'), entry('y.png', 'file', 'docs')], null, null, 2));
  assert.equal(countLoadedFiles(levels), 3, '目录不算文件');
  assert.equal(hasMore(levels, 'missing'), false, '未加载的层没有下一页');
  assert.equal(normalizeDir('/docs//sub/'), 'docs/sub');
  assert.equal(normalizeDir(''), '');
});

test('S-51-04 层表物化成递归树，且未加载的子层不会被伪装成空目录', () => {
  let levels = applyPage(emptyLevels(), '', page([entry('docs', 'folder'), entry('empty', 'folder')], null, null, 2));
  const before = materializeTree(levels);
  assert.equal(before.length, 2);
  assert.equal(before[0].children, undefined, '没加载过的目录不能挂空 children');

  levels = applyPage(levels, 'empty', page([], null, null, 0));
  levels = applyPage(levels, 'docs', page([entry('readme.md', 'file', 'docs')], null, null, 1));
  const after = materializeTree(levels);
  assert.deepEqual(after.find((n) => n.name === 'empty')?.children, [], '真空目录是空 children');
  assert.deepEqual(
    after.find((n) => n.name === 'docs')?.children?.map((n) => n.path),
    ['docs/readme.md'],
  );
  assert.deepEqual(findEntryByPath(levels, 'docs/readme.md')?.path, 'docs/readme.md');
  assert.equal(findEntryByPath(levels, 'docs/nope.md'), undefined);
});

test('S-51-05 加载中标记不丢已加载条目；失败保留内容与游标供重试', () => {
  let levels = applyPage(emptyLevels(), 'docs', page([entry('a.md', 'file', 'docs')], null, '1', 2));
  levels = beginLevel(levels, 'docs', true);
  assert.equal(levels['docs'].status, 'loading');
  assert.equal(levels['docs'].loadingMore, true);
  assert.equal(levels['docs'].entries.length, 1, '加载更多不得清空已显示条目');

  levels = failLevel(levels, 'docs', 'ERR_DIR_UNREADABLE');
  assert.equal(levels['docs'].status, 'error');
  assert.equal(levels['docs'].errorCode, 'ERR_DIR_UNREADABLE');
  assert.equal(levels['docs'].entries.length, 1, '失败后已有条目仍可见');
  assert.equal(levels['docs'].nextCursor, '1', '失败后仍可重试同一页');
  assert.deepEqual(resetLevels(), {});
});

/* --------------------- T-16 项目级缓存隔离 --------------------- */

test('S-51-06 reducer：刷新只作废该项目，其他项目的层表引用完全不变', () => {
  let state: WorkspaceState = { ...INITIAL_STATE };
  state = workspaceReducer(state, {
    type: 'TREE_LEVEL_PAGE',
    projectId: 'project-a',
    dir: '',
    entries: [entry('a.md'), entry('docs', 'folder')],
    cursor: null,
    nextCursor: null,
    total: 2,
  });
  state = workspaceReducer(state, {
    type: 'TREE_LEVEL_PAGE',
    projectId: 'project-b',
    dir: '',
    entries: [entry('b.md')],
    cursor: null,
    nextCursor: null,
    total: 1,
  });
  const bBefore = state.treeByProject['project-b'];
  const bNodesBefore = state.resourcesByProject['project-b'];

  state = workspaceReducer(state, { type: 'TREE_RESET', projectId: 'project-a' });

  assert.deepEqual(state.treeByProject['project-a'], {}, 'A 的层表已作废');
  assert.equal(state.treeByProject['project-b'], bBefore, 'B 的层表引用不变');
  assert.equal(state.resourcesByProject['project-b'], bNodesBefore, 'B 的派生树引用不变');
  assert.equal(state.tabs.length, 0, '刷新不得动标签');
  assert.equal(state.expandedByProject['project-b'], state.expandedByProject['project-b'], '展开状态保留');
});

test('S-51-07 reducer：TREE_LEVEL_PAGE 同时维护派生树（既有恢复链路的兼容视图）', () => {
  const state = workspaceReducer(INITIAL_STATE, {
    type: 'TREE_LEVEL_PAGE',
    projectId: 'project-a',
    dir: '',
    entries: [entry('docs', 'folder'), entry('a.md')],
    cursor: null,
    nextCursor: null,
    total: 2,
  });
  assert.equal(state.resourcesByProject['project-a'].length, 2);
  assert.equal(state.resourcesByProject['project-a'][0].kind, 'folder');
  assert.equal(state.resourcesByProject['project-a'][1].path, 'a.md');
  assert.equal(state.expandedByProject['project-a']['dir:p/docs'], true, '首屏沿用默认展开一级目录');
});

/* --------------------- T-19 数据同源：Demo 静态树 --------------------- */

test('S-51-08 Demo 静态树拆成层表后能物化回同一结构（三种模式同一渲染路径）', () => {
  const demo: ResourceNodeState[] = [
    {
      id: 'dir:docs',
      name: 'docs',
      kind: 'folder',
      path: 'docs',
      children: [{ id: 'doc:docs/a.md', name: 'a.md', kind: 'file', extension: '.md', path: 'docs/a.md' }],
    },
    { id: 'doc:readme.md', name: 'readme.md', kind: 'file', extension: '.md', path: 'readme.md' },
  ];
  const levels = fromStaticTree(demo);
  const materialized = materializeTree(levels);
  assert.deepEqual(
    materialized.map((n) => [n.name, n.kind, n.children?.length ?? 0]),
    [
      ['docs', 'folder', 1],
      ['readme.md', 'file', 0],
    ],
  );
  assert.deepEqual(findEntryByPath(levels, 'docs/a.md')?.id, 'doc:docs/a.md');
});

test('S-51-09 entryToNode 保持 link: 独立命名空间与相对路径', () => {
  const link = entryToNode(entry('linked-out', 'link'));
  assert.equal(link.kind, 'link');
  assert.match(link.id, /^link:/);
  assert.notEqual(link.id, 'doc:p/linked-out');
  assert.notEqual(link.id, 'dir:p/linked-out');
  assert.equal(link.path, 'linked-out');
});

/* --------------------- 懒加载树下的恢复语义 --------------------- */

test('S-51-10 恢复：父层已完整加载却找不到 → file-missing；父层未加载 → 交给 Host 判定', () => {
  const base: WorkspaceState = { ...INITIAL_STATE };
  let state = workspaceReducer(base, {
    type: 'TREE_LEVEL_PAGE',
    projectId: 'project-a',
    dir: '',
    entries: [entry('a.md'), entry('docs', 'folder')],
    cursor: null,
    nextCursor: null,
    total: 2,
  });

  // 根层完整加载：根目录里确实没有 missing.md
  assert.equal(resolveRestorableNode(state, 'missing.md', 'project-a'), null);
  // 子目录未加载：不能凭"没扫过"断言不存在，返回候选节点由 Host 判定
  const nested = resolveRestorableNode(state, 'docs/notes.md', 'project-a');
  assert.ok(nested, '未加载目录里的标签不能被误判成 file-missing');
  assert.equal(nested?.path, 'docs/notes.md');
  assert.equal(nested?.kind, 'file');

  // 该子层完整加载后仍找不到 → 回到明确的 file-missing
  state = workspaceReducer(state, {
    type: 'TREE_LEVEL_PAGE',
    projectId: 'project-a',
    dir: 'docs',
    entries: [entry('deep.md', 'file', 'docs')],
    cursor: null,
    nextCursor: null,
    total: 1,
  });
  assert.equal(resolveRestorableNode(state, 'docs/nope.md', 'project-a'), null);
  assert.ok(resolveRestorableNode(state, 'docs/deep.md', 'project-a'));
  // Legacy（无层表）沿用旧行为
  assert.equal(resolveRestorableNode(state, 'nope.md', null), null);
});

/* --------------------- 客户端逐层请求形状 --------------------- */

test('S-51-11 live.listTree 正确编码 projectId/dir/cursor/limit，失败归一为 REJECTED', async () => {
  const client = createLiveClient('http://127.0.0.1:1');
  const original = globalThis.fetch;
  const urls: string[] = [];
  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      return new Response(
        JSON.stringify({
          status: 'APPLIED',
          level: 'docs',
          entries: [entry('a.md', 'file', 'docs')],
          page: { limit: 200, cursor: '200', nextCursor: null, total: 201 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const outcome = await client.listTree('project-a', 'docs', '200', 200);
    assert.equal(outcome.status, 'APPLIED');
    if (outcome.status === 'APPLIED') {
      assert.equal(outcome.page.nextCursor, null);
      assert.equal(outcome.page.total, 201);
      assert.equal(outcome.entries[0].relPath, 'docs/a.md');
    }
    assert.match(urls[0], /\/api\/tree\?/);
    assert.match(urls[0], /projectId=project-a/);
    assert.match(urls[0], /dir=docs/);
    assert.match(urls[0], /cursor=200/);
    assert.match(urls[0], /limit=200/);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: 'REJECTED', errorCode: 'ERR_DIR_UNREADABLE' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const rejected = await client.listTree('project-a', 'docs');
    assert.equal(rejected.status, 'REJECTED');
    if (rejected.status === 'REJECTED') assert.equal(rejected.errorCode, 'ERR_DIR_UNREADABLE');
  } finally {
    globalThis.fetch = original;
  }
});

test('S-51-12 demo.listTree 一页返回静态层，不触碰网络', async () => {
  const demo = createDemoClient(
    [
      {
        id: 'dir:docs',
        name: 'docs',
        kind: 'folder',
        path: 'docs',
        children: [{ id: 'doc:docs/a.md', name: 'a.md', kind: 'file', extension: '.md', path: 'docs/a.md' }],
      },
    ],
    {},
  );
  const root = await demo.listTree(null, '');
  assert.equal(root.status, 'APPLIED');
  if (root.status === 'APPLIED') {
    assert.equal(root.page.nextCursor, null);
    assert.deepEqual(root.entries.map((e) => e.name), ['docs']);
  }
  const sub = await demo.listTree(null, 'docs');
  assert.equal(sub.status, 'APPLIED');
  if (sub.status === 'APPLIED') assert.deepEqual(sub.entries.map((e) => e.relPath), ['docs/a.md']);
});

/* --------------------- T-20 UI 接线（源码级，不冒充像素验证） --------------------- */

test('S-51-13 TreeBranch 先问查看器再打开，且 link 不进入打开链路', async () => {
  const source = await readFile(
    resolve(ROOT, 'apps/shell/src/components/TreeBranch.tsx'),
    'utf8',
  );
  assert.match(source, /resolveViewer\(/, '必须按扩展名问一次能力注册表');
  assert.match(source, /暂不支持预览/, '不支持预览必须给可理解提示');
  assert.match(source, /node\.kind === 'link'/, '链接必须单独分支');
  assert.match(source, /loadTreeLevel\(/, '展开目录必须触发逐层加载');
  assert.match(source, /ERR_DIR_UNREADABLE/, '不可读必须与空目录区分');
  assert.match(source, /继续加载/, '分页必须提供"继续加载"入口');
  // 链接分支里不得出现 openNode
  const linkBranch = source.slice(source.indexOf("node.kind === 'link'"), source.indexOf('const docId'));
  assert.doesNotMatch(linkBranch, /openNode\(/, '链接绝不可打开');
});

test('S-51-14 真实模式与演示模式的根行都从同一组件、depth 0 出发', async () => {
  const list = await readFile(resolve(ROOT, 'apps/shell/src/components/ProjectList.tsx'), 'utf8');
  const tree = await readFile(resolve(ROOT, 'apps/shell/src/components/ProjectTree.tsx'), 'utf8');
  for (const [name, source] of [
    ['ProjectList', list],
    ['ProjectTree', tree],
  ] as const) {
    assert.match(source, /<TreeRow[\s\S]*?depth=\{0\}/, `${name} 的项目根必须是 depth 0 的 TreeRow`);
    assert.match(source, /TreeBranch/, `${name} 必须复用共享树分支`);
  }
  assert.doesNotMatch(list, /project__root/, 'Multi 不得再自绘项目卡片式根行');
});
