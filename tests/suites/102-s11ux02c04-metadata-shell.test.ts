/**
 * UX-02C-04：资源标注的 Shell 侧逻辑（层表、草稿差异、客户端请求形状）。
 *
 * 与套件 101 的分工：
 * - 101 管 Host（配置、身份核验、迁移、回收兼容）；
 * - 这里管**浏览器侧**：树条目怎么带上标注、对话框草稿怎么算差异、
 *   右键入口在什么上下文可用、发送的请求体里到底有哪些字段。
 *
 * 全部是纯函数或可控 `fetch`，不启 Host。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyPage, emptyLevels, entryToNode, materializeTree } from '../../apps/shell/src/components/tree-model.ts';
import {
  addTagToDraft,
  colorLabelOf,
  colorRowClassOf,
  COLOR_OPTIONS,
  draftErrorOf,
  draftIsEmpty,
  draftOf,
  metadataCommandState,
  metadataNoopNotice,
  metadataSavedNotice,
  metadataUnknownNotice,
  patchIsEmpty,
  patchOfDraft,
  removeTagFromDraft,
  tagBadges,
} from '../../apps/shell/src/state/resource-metadata.ts';
import { createLiveClient } from '../../apps/shell/src/client/client-api.ts';
import type { TreeEntry } from '../../apps/shell/src/client/client-api.ts';
import type { MetadataDraft } from '../../apps/shell/src/state/resource-metadata.ts';

const PROJ = 'project-a';

function entry(overrides: Partial<TreeEntry> = {}): TreeEntry {
  return {
    id: 'doc:a.md',
    name: 'a.md',
    kind: 'file',
    extension: '.md',
    relPath: 'a.md',
    ...overrides,
  };
}

/* ================================================================== */
/* 层表：元数据必须穿过 entryToNode / applyPage / materializeTree        */
/* ================================================================== */

test('S-01 entryToNode 带上 meta；没有 meta 时不产生空对象', () => {
  const withMeta = entryToNode(entry({ meta: { alias: '核心架构', tags: ['重要'], color: 'blue' } }));
  assert.equal(withMeta.meta?.alias, '核心架构');
  assert.deepEqual(withMeta.meta?.tags, ['重要']);
  assert.equal(withMeta.meta?.color, 'blue');

  const without = entryToNode(entry());
  assert.equal(without.meta, undefined, '没有标注就是没有，不要造一个空对象');
});

test('S-02 applyPage 保存根层 projectMeta，且续页不带时沿用', () => {
  let levels = emptyLevels();
  levels = applyPage(levels, '', {
    entries: [entry()],
    cursor: null,
    nextCursor: '1',
    total: 2,
    projectMeta: { alias: '主项目', tags: [], color: 'purple' },
  });
  assert.equal(levels['']?.projectMeta?.alias, '主项目');

  levels = applyPage(levels, '', {
    entries: [entry({ id: 'doc:b.md', name: 'b.md', relPath: 'b.md' })],
    cursor: '1',
    nextCursor: null,
    total: 2,
  });
  assert.equal(levels['']?.projectMeta?.alias, '主项目', '续页不带 projectMeta 时不能清空');
});

test('S-03 子层没有 projectMeta：根标注不会串到子目录', () => {
  let levels = emptyLevels();
  levels = applyPage(levels, '', {
    entries: [entry({ kind: 'folder', name: 'docs', extension: '', relPath: 'docs' })],
    cursor: null,
    nextCursor: null,
    total: 1,
    projectMeta: { alias: '主项目', tags: [] },
  });
  levels = applyPage(levels, 'docs', {
    entries: [entry({ id: 'doc:docs/guide.md', name: 'guide.md', relPath: 'docs/guide.md' })],
    cursor: null,
    nextCursor: null,
    total: 1,
  });
  assert.equal(levels['docs']?.projectMeta, undefined);
  const tree = materializeTree(levels);
  assert.equal(tree[0]?.children?.[0]?.meta, undefined);
});

test('S-04 materializeTree 保留 folder 的 meta', () => {
  let levels = emptyLevels();
  levels = applyPage(levels, '', {
    entries: [
      entry({
        id: 'dir:docs',
        name: 'docs',
        kind: 'folder',
        extension: '',
        relPath: 'docs',
        meta: { alias: '文档', tags: ['资料'], color: 'gray' },
      }),
    ],
    cursor: null,
    nextCursor: null,
    total: 1,
  });
  const tree = materializeTree(levels);
  assert.equal(tree[0]?.meta?.alias, '文档');
  assert.deepEqual(tree[0]?.meta?.tags, ['资料']);
});

/* ================================================================== */
/* 草稿：只提交差异                                                     */
/* ================================================================== */

test('S-05 draftOf / patchOfDraft：未改动时补丁为空', () => {
  const meta = { alias: '架构', tags: ['重要'], color: 'blue' };
  const draft = draftOf(meta);
  assert.equal(draft.alias, '架构');
  assert.equal(draft.color, 'blue');
  assert.equal(patchIsEmpty(patchOfDraft(draft, meta)), true, '什么都没改就不该发请求');
});

test('S-06 只改颜色：补丁里没有 alias / tags（不覆盖别人刚写的字段）', () => {
  const meta = { alias: '架构', tags: ['重要'], color: 'blue' };
  const draft = { ...draftOf(meta), color: 'red' as const };
  const patch = patchOfDraft(draft, meta);
  assert.equal(patch.color, 'red');
  assert.equal(patch.alias, undefined);
  assert.equal(patch.tags, undefined);
});

test('S-07 清空标注名 → alias: null；清空颜色 → color: null', () => {
  const meta = { alias: '架构', tags: ['重要'], color: 'blue' };
  const patch = patchOfDraft({ alias: '   ', tags: ['重要'], color: undefined }, meta);
  assert.equal(patch.alias, null);
  assert.equal(patch.color, null);
  assert.equal(patch.tags, undefined);
});

test('S-08 标签增删：重复/空白被拒绝，大小写不敏感', () => {
  const draft = { alias: '', tags: ['重要'], color: undefined };

  const dup = addTagToDraft(draft, ' 重要 ');
  assert.equal(dup.ok, false);

  const caseDup = addTagToDraft(draft, 'Arch');
  assert.equal(caseDup.ok, true);
  if (!caseDup.ok) return;
  const upper = addTagToDraft(caseDup.draft, 'ARCH');
  assert.equal(upper.ok, false, '大小写不同视为同一个标签');

  const blank = addTagToDraft(draft, '   ');
  assert.equal(blank.ok, false);

  const removed = removeTagFromDraft(caseDup.draft, 'Arch');
  assert.deepEqual(removed.tags, ['重要']);
});

test('S-09 标签超过 16 个：拒绝并给出原因（不是静默截断）', () => {
  let draft: MetadataDraft = draftOf(undefined);
  for (let i = 0; i < 16; i += 1) {
    const result = addTagToDraft(draft, `t${i}`);
    assert.equal(result.ok, true, `第 ${i + 1} 个标签应当允许`);
    if (!result.ok) return;
    draft = result.draft;
  }
  const overflow = addTagToDraft(draft, 't16');
  assert.equal(overflow.ok, false);
  if (overflow.ok) return;
  assert.match(overflow.message, /最多 16 个标签/);
});

test('S-10 draftIsEmpty / draftErrorOf', () => {
  assert.equal(draftIsEmpty({ alias: '  ', tags: [], color: undefined }), true);
  assert.equal(draftIsEmpty({ alias: 'x', tags: [], color: undefined }), false);
  assert.equal(draftErrorOf({ alias: 'x'.repeat(81), tags: [], color: undefined }) !== null, true);
  assert.equal(draftErrorOf({ alias: '正常', tags: ['a'], color: 'red' }), null);
});

/* ================================================================== */
/* 颜色与菜单可用性                                                     */
/* ================================================================== */

test('S-11 颜色 token：映射到类名，未知值不产生类名', () => {
  assert.equal(colorRowClassOf('blue'), 'tree__row--color-blue');
  assert.equal(colorRowClassOf('nope'), null);
  assert.equal(colorRowClassOf(undefined), null);
  assert.equal(colorLabelOf('nope'), '默认');
  // 调色板与契约 token 完全一致（顺序即展示顺序）
  assert.deepEqual(
    COLOR_OPTIONS.map((option) => option.token),
    ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'],
  );
});

test('S-12 标签摘要：最多两颗 + 剩余计数', () => {
  assert.deepEqual(tagBadges(['a', 'b', 'c', 'd']), { shown: ['a', 'b'], more: 2 });
  assert.deepEqual(tagBadges(['a']), { shown: ['a'], more: 0 });
  assert.deepEqual(tagBadges([], 2), { shown: [], more: 0 });
});

test('S-13 右键入口：链接不给、项目根给、未授权项目给但禁用', () => {
  assert.equal(metadataCommandState({ origin: 'link', entryKind: 'link', supported: true }).visible, false);
  assert.equal(metadataCommandState({ origin: 'file', entryKind: 'link', supported: true }).visible, false);

  const root = metadataCommandState({ origin: 'project-root', supported: true });
  assert.equal(root.visible, true);
  assert.equal(root.disabled, false);

  const unsupported = metadataCommandState({ origin: 'file', entryKind: 'file', supported: false });
  assert.equal(unsupported.visible, true);
  assert.equal(unsupported.disabled, true);
  assert.ok(unsupported.hint);

  // 工具栏/空白区没有具体资源，不给入口
  assert.equal(metadataCommandState({ origin: 'toolbar', supported: true }).visible, false);
  assert.equal(metadataCommandState({ origin: 'blank', supported: true }).visible, false);
});

test('S-14 提示文案：保存/无变化/未确认三态可区分', () => {
  assert.match(metadataSavedNotice('架构'), /架构/);
  assert.notEqual(metadataNoopNotice(), metadataSavedNotice(undefined));
  assert.match(metadataUnknownNotice(), /未确认/);
});

/* ================================================================== */
/* 客户端请求形状                                                       */
/* ================================================================== */

interface Captured {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/**
 * 把 `globalThis.fetch` 换成一个"记账 + 固定回执"的桩。
 *
 * 这里要证明的是**请求体里有哪些字段**：多带一个字段就可能覆盖用户在另一个窗口里
 * 刚写下的值，少带一个字段则会让"清除"变成"没改"。
 */
/**
 * 这些用例只钉请求体形状，不涉及发送前裁决（那在套件 105）：
 * 给一个恒通过的 gate，保证调用链完整但不引入第二个变量。
 */
const allowSend = () => ({ ok: true as const });

function installFetch(status = 200): { calls: Captured[]; restore(): void; fail(): void } {
  const original = globalThis.fetch;
  const calls: Captured[] = [];
  let failing = false;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/session-token')) {
      return { status: 200, json: async () => ({ status: 'APPLIED', token: 't1' }) };
    }
    if (failing) throw new Error('network down');
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    return {
      status,
      json: async () => ({
        status: status === 200 ? 'APPLIED' : 'REJECTED',
        projectId: PROJ,
        path: 'a.md',
        changed: true,
        metadata:
          status === 200
            ? { alias: '架构', tags: ['重要'], color: 'blue' }
            : undefined,
        errorCode: status === 200 ? undefined : 'ERR_COMMAND_INVALID',
        message: status === 200 ? undefined : '注入：拒绝',
      }),
    };
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
    fail() {
      failing = true;
    },
  };
}

test('S-15 setResourceMetadata 只发送用户改过的字段', async () => {
  const net = installFetch();
  try {
    const client = createLiveClient('http://host.test');
    const outcome = await client.setResourceMetadata(PROJ, 'a.md', { color: 'blue' }, undefined, allowSend);
    assert.equal(outcome.status, 'APPLIED');
    assert.equal(net.calls.length, 1);
    assert.equal(net.calls[0]?.url, 'http://host.test/api/metadata/set');
    assert.deepEqual(net.calls[0]?.body, { projectId: PROJ, path: 'a.md', color: 'blue' });
    assert.equal('alias' in (net.calls[0]?.body ?? {}), false, '没改的字段不许出现在请求体里');
  } finally {
    net.restore();
  }
});

test('S-16 清除单项：alias / color 以 null 发送，tags 以空数组发送', async () => {
  const net = installFetch();
  try {
    const client = createLiveClient('http://host.test');
    await client.setResourceMetadata(PROJ, 'a.md', { alias: null, tags: [], color: null }, undefined, allowSend);
    assert.deepEqual(net.calls[0]?.body, { projectId: PROJ, path: 'a.md', alias: null, tags: [], color: null });
  } finally {
    net.restore();
  }
});

test('S-17 网络中断 → UNKNOWN（不是失败，也不自动重试）', async () => {
  const net = installFetch();
  try {
    net.fail();
    const client = createLiveClient('http://host.test');
    const outcome = await client.setResourceMetadata(PROJ, 'a.md', { alias: 'x' }, undefined, allowSend);
    assert.equal(outcome.status, 'UNKNOWN');
    assert.equal(net.calls.filter((call) => call.url.endsWith('/api/metadata/set')).length, 0);
  } finally {
    net.restore();
  }
});

test('S-18 清除接口：只发 projectId + path', async () => {
  const net = installFetch();
  try {
    const client = createLiveClient('http://host.test');
    const outcome = await client.clearResourceMetadata(PROJ, 'a.md', undefined, undefined, allowSend);
    assert.equal(outcome.status, 'APPLIED');
    assert.equal(net.calls[0]?.url, 'http://host.test/api/metadata/clear');
    assert.deepEqual(net.calls[0]?.body, { projectId: PROJ, path: 'a.md' });
  } finally {
    net.restore();
  }
});

test('S-19 列表响应里的非法展示字段被丢弃（不会渲染 color-undefined）', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/api/session-token')) {
      return { status: 200, json: async () => ({ status: 'APPLIED', token: 't1' }) };
    }
    return {
      status: 200,
      json: async () => ({
        status: 'APPLIED',
        projectId: PROJ,
        entries: [
          { path: 'a.md', state: 'active', alias: 42, tags: ['ok', 3, ''], color: null },
          { path: 'b.md', state: 'weird', tags: [] },
        ],
      }),
    };
  }) as typeof fetch;
  try {
    const client = createLiveClient('http://host.test');
    const outcome = await client.resourceMetadata(PROJ);
    assert.equal(outcome.status, 'APPLIED');
    if (outcome.status !== 'APPLIED') return;
    assert.equal(outcome.entries[0]?.alias, undefined, '非字符串标注名丢掉');
    assert.deepEqual(outcome.entries[0]?.tags, ['ok'], '非字符串/空标签丢掉');
    assert.equal(outcome.entries[0]?.color, undefined);
    assert.equal(outcome.entries[1]?.state, 'active', '未知状态按 active 处理，不伪造失效');
  } finally {
    globalThis.fetch = original;
  }
});
