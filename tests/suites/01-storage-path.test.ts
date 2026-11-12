/**
 * 路径边界（docs/08 Path Traversal、docs/12 SEC-001）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAbsolute, join, relative, sep } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { createHarness } from '../helpers.ts';
import { resolveInsideRoot } from '../../packages/storage/index.ts';

test('STORAGE-01 根内相对路径可解析', () => {
  const root = process.cwd();
  const ok = resolveInsideRoot(root, 'docs/00_基线状态与裁决.md');
  assert.equal(ok.ok, true);
  if (ok.ok) {
    // 用 path.relative 做目录边界判定，而不是裸 startsWith：
    // 裸前缀会把 `D:\foobar` 误判为位于 `D:\foo` 之内。
    // 该函数在 Windows 上大小写不敏感，正好覆盖 realpath 返回磁盘真实大小写的情况。
    const rel = relative(root, ok.absolutePath);
    assert.equal(isAbsolute(rel), false, `解析结果不得逃逸到其他盘符: ${rel}`);
    assert.notEqual(rel, '..', `解析结果不得位于根的父目录: ${ok.absolutePath}`);
    assert.equal(rel.startsWith(`..${sep}`), false, `解析结果必须在根内: ${ok.absolutePath}`);
    assert.equal(rel, join('docs', '00_基线状态与裁决.md'));
  }
});

test('STORAGE-02 拒绝 .. 逃逸', () => {
  const r = resolveInsideRoot(process.cwd(), '../../Windows/System32/config');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.errorCode, 'ERR_PATH_OUTSIDE_ROOT');
});

test('STORAGE-03 拒绝绝对路径输入', () => {
  const r = resolveInsideRoot(process.cwd(), 'C:/Windows/win.ini');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.errorCode, 'ERR_PATH_OUTSIDE_ROOT');
});

test('STORAGE-04 写入与读取往返一致，内容版本随内容变化', async () => {
  const h = await createHarness();
  try {
    const first = await h.provider.writeConditional('notes/a.md', '# A\n', null);
    assert.equal(first.status, 'COMMITTED');
    // COMMITTED 必须携带内容版本，否则后续条件写入无从取值（类型与运行时都要能发现缺失）
    assert.ok(first.contentVersion, 'COMMITTED 必须返回 contentVersion');
    assert.match(String(first.contentVersion), /^sha256:[0-9a-f]{64}$/);

    const read = await h.provider.read('notes/a.md');
    assert.equal(read.content, '# A\n');
    assert.equal(read.contentVersion, first.contentVersion);

    const second = await h.provider.writeConditional('notes/a.md', '# A2\n', first.contentVersion);
    assert.equal(second.status, 'COMMITTED');
    assert.notEqual(second.contentVersion, first.contentVersion);
  } finally {
    await h.cleanup();
  }
});

test('STORAGE-05 创建语义：expectedVersion=null 且文件已存在 → CONFLICT', async () => {
  const h = await createHarness();
  try {
    await h.provider.writeConditional('x.md', 'one', null);
    const again = await h.provider.writeConditional('x.md', 'two', null);
    assert.equal(again.status, 'CONFLICT');
    assert.equal(again.errorCode, 'ERR_DOCUMENT_VERSION_CONFLICT');
    const read = await h.provider.read('x.md');
    assert.equal(read.content, 'one', '冲突时不得覆盖既有内容');
  } finally {
    await h.cleanup();
  }
});

test('STORAGE-06 越界写入被拒绝且不产生文件', async () => {
  const h = await createHarness();
  try {
    const result = await h.provider.writeConditional('../escape.md', 'x', null);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, 'ERR_PATH_OUTSIDE_ROOT');
    const list = await h.provider.list();
    assert.deepEqual(list, []);
  } finally {
    await h.cleanup();
  }
});

test('STORAGE-07 list 递归返回相对路径并按字典序排列', async () => {
  const h = await createHarness();
  try {
    await mkdir(join(h.root, 'b/sub'), { recursive: true });
    await writeFile(join(h.root, 'b/sub/two.md'), '2', 'utf8');
    await writeFile(join(h.root, 'a.md'), '1', 'utf8');
    const list = await h.provider.list();
    assert.deepEqual(list, ['a.md', 'b/sub/two.md']);
  } finally {
    await h.cleanup();
  }
});
