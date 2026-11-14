/**
 * S11-UX-02A-R1：目录树祖先连接线（引导线）回归。
 *
 * 被审查发现的缺陷：`TreeIndent` 只看自己的 `depth` 与 `last`，无条件为**所有**祖先
 * 绘制竖线。于是当某一层祖先本身就是末项（└）时，它的后代仍会在这条列上继续画线，
 * 视觉上像是"这一层后面还有兄弟"，层级读错。
 *
 * 组件是 `.tsx`（Node 无 JSX 变换，无法 import），因此把判断抽到纯模块
 * `apps/shell/src/components/tree-trails.ts`，在这里用真实的树结构驱动：
 * 遍历顺序与 `TreeLevel → TreeItem → TreeRow` 完全一致（同样用 `descend` 下推祖先标记）。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  ancestorGuides,
  descend,
  type TreeGuide,
  type TreeTrails,
} from '../../apps/shell/src/components/tree-trails.ts';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface Fixture {
  readonly id: string;
  readonly kind: 'folder' | 'file';
  readonly children?: readonly Fixture[];
}

interface Row {
  readonly id: string;
  readonly depth: number;
  readonly last: boolean;
  readonly guides: readonly TreeGuide[];
}

/**
 * 遍历顺序与组件一致：同一层的兄弟按数组顺序，`last` = 本层最后一项，
 * 子层拿到的是 `descend(trails, last)`。
 */
function walk(
  nodes: readonly Fixture[],
  depth: number,
  trails: TreeTrails,
  out: Row[] = [],
): Row[] {
  nodes.forEach((node, index) => {
    const last = index === nodes.length - 1;
    out.push({ id: node.id, depth, last, guides: ancestorGuides(trails, depth) });
    if (node.kind === 'folder' && node.children && node.children.length > 0) {
      walk(node.children, depth + 1, descend(trails, last), out);
    }
  });
  return out;
}

/**
 * 固定的多层夹具（4 层），刻意包含三种祖先：
 * - `docs`：非末项祖先（后面还有 `src`）→ 竖线必须延续；
 * - `architecture`：docs 内的末项子目录 → 其子文件那一层不得再画这条列；
 * - `src` / `inner`：层层末项 → blank 必须级联到更深层。
 */
const TREE: readonly Fixture[] = [
  {
    id: 'project-a',
    kind: 'folder',
    children: [
      {
        id: 'docs',
        kind: 'folder',
        children: [
          { id: 'docs/guide.md', kind: 'file' },
          {
            id: 'docs/architecture',
            kind: 'folder',
            children: [{ id: 'docs/architecture/layers.md', kind: 'file' }],
          },
        ],
      },
      {
        id: 'src',
        kind: 'folder',
        children: [
          {
            id: 'src/inner',
            kind: 'folder',
            children: [{ id: 'src/inner/notes.txt', kind: 'file' }],
          },
        ],
      },
    ],
  },
  { id: '123132.txt', kind: 'file' },
];

const rows = walk(TREE, 1, []);

function guidesOf(id: string): readonly TreeGuide[] {
  const row = rows.find((item) => item.id === id);
  assert.ok(row, `缺少行 ${id}`);
  return row.guides;
}

test('G-01 第 1 层没有祖先列：只画自己的 ├/└', () => {
  assert.deepEqual(guidesOf('project-a'), []);
  assert.deepEqual(guidesOf('123132.txt'), []);
  assert.equal(rows.find((row) => row.id === 'project-a')?.last, false);
  assert.equal(rows.find((row) => row.id === '123132.txt')?.last, true);
});

test('G-02 每行的祖先列数恒等于 depth-1（缩进宽度不随引导线增减）', () => {
  for (const row of rows) {
    assert.equal(row.guides.length, Math.max(0, row.depth - 1), `行 ${row.id} 的缩进列数不对`);
  }
  // 夹具确实覆盖到 4 层
  assert.equal(Math.max(...rows.map((row) => row.depth)), 4);
});

test('G-03 非末项祖先：竖线在其后代行里延续', () => {
  // docs 后面还有 src（第 1 列），docs 内部 guide.md 后面还有兄弟（第 2 列），两列都必须继续画
  assert.deepEqual(guidesOf('docs/guide.md'), ['line', 'line']);
  assert.deepEqual(guidesOf('docs/architecture'), ['line', 'line']);
});

test('G-04 末项祖先：后代不再绘制该祖先的连接线', () => {
  // architecture 是 docs 的末项子目录 → 第 3 列在 layers.md 行里应为空白占位
  assert.deepEqual(guidesOf('docs/architecture/layers.md'), ['line', 'line', 'blank']);
  // src 是 project-a 的末项子目录 → 第 2 列在 notes.txt 行里应为空白占位
  assert.deepEqual(guidesOf('src/inner'), ['line', 'blank']);
  assert.deepEqual(guidesOf('src/inner/notes.txt'), ['line', 'blank', 'blank']);
});

test('G-05 末项祖先的 blank 会级联，但不影响更深层的其他列', () => {
  const inner = rows.find((row) => row.id === 'src/inner');
  const architecture = rows.find((row) => row.id === 'docs/architecture');
  assert.ok(inner);
  assert.ok(architecture);
  assert.equal(inner.last, true, '夹具前提：inner 是末项');
  assert.equal(architecture.last, true, '夹具前提：architecture 是末项');
  // project-a 仍有后续兄弟 → 第 1 列保持 line；两个末项祖先各贡献一个 blank
  assert.deepEqual(guidesOf('src/inner/notes.txt'), ['line', 'blank', 'blank']);
  // 末项祖先只影响自己那一列：architecture 的父列（第 1、2 列）仍是 line
  assert.deepEqual(guidesOf('docs/architecture/layers.md'), ['line', 'line', 'blank']);
});

test('G-06 折叠不改变行形态：父项折叠后其后代不渲染，父行仍按 last 收尾', () => {
  // 这里只锁"父行自身形态由 last 决定"，与是否展开无关
  const src = rows.find((row) => row.id === 'src');
  const docs = rows.find((row) => row.id === 'docs');
  assert.equal(src?.last, true);
  assert.equal(docs?.last, false);
  assert.deepEqual(src?.guides, ['line']);
  assert.deepEqual(docs?.guides, ['line']);
});

test('G-07 三种模式共用同一规则：Multi 与 Legacy 都把 trails 传进行组件', async () => {
  // .tsx 无法 import 进 Node，只能对源码做接线检查，避免"规则对了但没接上"
  const list = await readFile(resolve(ROOT, 'apps/shell/src/components/ProjectList.tsx'), 'utf8');
  const tree = await readFile(resolve(ROOT, 'apps/shell/src/components/ProjectTree.tsx'), 'utf8');

  for (const [name, source] of [
    ['ProjectList', list],
    ['ProjectTree', tree],
  ] as const) {
    assert.ok(source.includes("from './tree-trails'"), `${name} 未引用 tree-trails`);
    assert.ok(/<TreeLevel[^>]*trails=/s.test(source), `${name} 的 TreeLevel 未传入 trails`);
    assert.ok(/<TreeRow[^>]*trails=/s.test(source), `${name} 的 TreeRow 未传入 trails`);
  }
  // Multi 必须用 descend 下推，而不是自己拼数组
  assert.ok(list.includes('descend(trails, last)'), 'ProjectList 未用 descend 下推祖先标记');
});
