/**
 * S9A-F01 / S9A-F02：工作台 Markdown 解析的终止性与链接协议安全。
 *
 * 为什么测 `blocks.ts` 而不是直接测组件：渲染层只做 AST → React 映射，
 * 全部判定（块级分类、链接协议）都在解析器里；解析器是纯 TS，可被 Node 直接加载，
 * 因此这些用例能在 `node tests/run-all.ts` 里同进程运行。
 *
 * 修复前的挂起形态：`#没有空格`、`##`、`|普通文本`、单独的 `|`。
 * 旧实现里块级分支不接受这些输入、段落的 `break` 条件却把它们当作块级起点，
 * `index` 不前进 → 渲染死循环。当前用例若回归，会因为**测试进程不再返回**
 * 而被外层 `timeout` 终止（不能靠断言捕获，故 CI 侧需保留超时执行）。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  classifyBlock,
  parseInline,
  parseMarkdown,
  safeHref,
  type Block,
  type Inline,
} from '../../plugins/markdown/blocks.ts';

const ROOT = process.cwd();

/** 取行内节点的可见文本（链接用 label，其余用 value）。 */
function inlineText(inlines: readonly Inline[]): string {
  return inlines
    .map((node) => (node.kind === 'link' ? node.label : node.value))
    .join('');
}

/** 取段落的可见文本；非文本类块返回空串。 */
function blockText(block: Block | undefined): string {
  if (!block) return '';
  if (block.kind === 'paragraph' || block.kind === 'heading' || block.kind === 'quote') {
    return inlineText(block.inlines);
  }
  return '';
}

// ---------------------------------------------------------------------------
// S9A-F01：块级识别与段落终止必须一致，每轮至少消费一行
// ---------------------------------------------------------------------------

test('S9A-F01a `#没有空格` 按普通文本渲染，且解析必然终止', () => {
  const blocks = parseMarkdown('#没有空格');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.kind, 'paragraph');
  assert.equal(blockText(blocks[0]), '#没有空格');
});

test('S9A-F01b `##` 与 `###` 这类无内容标题按普通文本渲染', () => {
  for (const source of ['##', '###', '######']) {
    const blocks = parseMarkdown(source);
    assert.equal(blocks.length, 1, `${source} 必须产出恰好一个块`);
    assert.equal(blocks[0]?.kind, 'paragraph', `${source} 不得被当作标题`);
    assert.equal(blockText(blocks[0]), source);
  }
});

test('S9A-F01c `|普通文本`（下一行不是表格）按普通文本渲染', () => {
  const blocks = parseMarkdown('|普通文本');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.kind, 'paragraph');
  assert.equal(blockText(blocks[0]), '|普通文本');
});

test('S9A-F01d 整行只有一个 `|` 时按普通文本渲染', () => {
  const blocks = parseMarkdown('|');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.kind, 'paragraph');
  assert.equal(blockText(blocks[0]), '|');
});

test('S9A-F01e 已识别的块级语法行为不变（标题/分隔线/引用/列表）', () => {
  assert.deepEqual(parseMarkdown('# 标题')[0], {
    kind: 'heading',
    level: 1,
    inlines: [{ kind: 'text', value: '标题' }],
  });
  assert.deepEqual(parseMarkdown('###### 六级')[0], {
    kind: 'heading',
    level: 6,
    inlines: [{ kind: 'text', value: '六级' }],
  });
  assert.equal(parseMarkdown('---')[0]?.kind, 'hr');
  assert.equal(parseMarkdown('> 引用')[0]?.kind, 'quote');

  const ul = parseMarkdown('- a\n- b')[0];
  assert.equal(ul?.kind, 'list');
  if (ul?.kind === 'list') assert.equal(ul.ordered, false);
  assert.equal(ul?.kind === 'list' ? ul.items.length : 0, 2);

  const ol = parseMarkdown('1. a\n2. b')[0];
  assert.equal(ol?.kind, 'list');
  if (ol?.kind === 'list') assert.equal(ol.ordered, true);
});

test('S9A-F01f 正常表格保留表头与数据行，分隔行被丢弃', () => {
  const table = parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')[0];
  assert.equal(table?.kind, 'table');
  if (table?.kind !== 'table') return;
  assert.equal(table.head.length, 2);
  assert.equal(inlineText(table.head[0] ?? []), 'a');
  assert.equal(table.body.length, 1, '分隔行不得进入表体');
  assert.equal(inlineText(table.body[0]?.[1] ?? []), '2');
});

test('S9A-F01g 未闭合代码围栏延续到文末，不丢内容也不越界', () => {
  const blocks = parseMarkdown('```\nconst a = 1;\n没有结束围栏');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.kind, 'code');
  if (blocks[0]?.kind === 'code') {
    assert.equal(blocks[0].text, 'const a = 1;\n没有结束围栏');
  }
});

test('S9A-F01h 普通文本与 Markdown 混合时块顺序正确', () => {
  const blocks = parseMarkdown('第一段\n第二段\n# 标题\n- 项\n结尾');
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['paragraph', 'heading', 'list', 'paragraph'],
  );
  assert.equal(blockText(blocks[0]), '第一段 第二段');
  assert.equal(blockText(blocks[3]), '结尾');
});

test('S9A-F01i 分类器对任意输入都有确定结果，且每行至少被消费一次', () => {
  // 这些行在旧实现里会让段落循环「break 但 index 不前进」。
  const adversarial = ['#x', '##x', '###', '|x', '|', '>', '-', '1.', '``', '---x', '\t', '  #y'];
  const source = adversarial.join('\n');
  const lines = source.split('\n');

  // 分类器必须给出 10 种已知取值之一（不含空集/undefined 分支）
  for (let i = 0; i < lines.length; i += 1) {
    assert.ok(
      ['blank', 'fence', 'heading', 'hr', 'quote', 'ul', 'ol', 'table', 'text'].includes(
        classifyBlock(lines, i),
      ),
      `第 ${i} 行分类非法`,
    );
  }

  // 只有真正的块级起点才会被分类为非 text；其余必须落到 text 由段落消费
  assert.equal(classifyBlock(['#没有空格'], 0), 'text');
  assert.equal(classifyBlock(['|普通文本'], 0), 'text');

  const blocks = parseMarkdown(source);
  const rendered = blocks.map((b) => b.kind).join(',');
  assert.ok(rendered.includes('paragraph'), '未识别语法必须落到段落，而不是被丢弃');
});

test('S9A-F01j 大量未识别行不会导致解析不返回（规模回归）', () => {
  const source = Array.from({ length: 500 }, (_, i) => (i % 2 === 0 ? `#无空格${i}` : `|孤立${i}`)).join(
    '\n\n',
  );
  const started = Date.now();
  const blocks = parseMarkdown(source);
  assert.equal(blocks.length, 500, '每一行都必须被消费并产出一个块');
  assert.equal(
    blocks.every((b) => b.kind === 'paragraph'),
    true,
  );
  assert.ok(Date.now() - started < 2000, '解析耗时异常');
});

// ---------------------------------------------------------------------------
// S9A-F02：链接协议白名单
// ---------------------------------------------------------------------------

test('S9A-F02a 允许 http/https/mailto 与安全相对路径', () => {
  for (const href of [
    'https://example.com/a?b=1#c',
    'http://example.com',
    'mailto:a@example.com',
    './docs/a.md',
    '../a.md',
    '#section',
    '?q=1',
  ]) {
    assert.equal(safeHref(href), href, `${href} 应被允许`);
  }
});

test('S9A-F02b 拒绝 javascript/data/vbscript 等不可信协议', () => {
  for (const href of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'file:///C:/Windows/System32',
    'jar:http://x/y.zip!/z',
  ]) {
    assert.equal(safeHref(href), null, `${href} 必须被拒绝`);
  }
});

test('S9A-F02c 控制字符伪装的协议同样被拒绝', () => {
  // 浏览器解析 URL 时忽略 TAB/LF/CR，因此 `java\tscript:` 等价于 `javascript:`
  for (const href of ['java\tscript:alert(1)', 'java\nscript:alert(1)', 'java\rscript:alert(1)']) {
    assert.equal(safeHref(href), null);
  }
});

test('S9A-F02d 协议相对地址（//host）按不可信处理，不当成相对路径', () => {
  assert.equal(safeHref('//evil.example/x'), null);
  assert.equal(safeHref('\\\\evil.example\\x'), null);
});

test('S9A-F02e 不可信链接在解析结果中 href 为 null，且保留原文用于降级', () => {
  const inlines = parseInline('前 [点我](javascript:alert) 后');
  const link = inlines.find((i) => i.kind === 'link');
  assert.ok(link, '必须识别出链接节点');
  if (link?.kind !== 'link') return;
  assert.equal(link.href, null, '不可信协议不得进入 href');
  assert.equal(link.raw, '[点我](javascript:alert)', '降级时输出原文');

  const safe = parseInline('[文档](https://example.com/a)').find((i) => i.kind === 'link');
  assert.equal(safe?.kind === 'link' ? safe.href : 'MISSING', 'https://example.com/a');
});

test('S9A-F02f 解析结果中不存在任何未通过白名单的 href', () => {
  const source = [
    '[a](javascript:alert)',
    '[b](data:text/html,x)',
    '[c](https://ok.example)',
    '[d](./rel.md)',
    '段落里的 [e](vbscript:1) 混排',
  ].join('\n');
  const blocks = parseMarkdown(source);
  const links = blocks.flatMap((b) =>
    b.kind === 'paragraph' || b.kind === 'heading' || b.kind === 'quote' ? b.inlines : [],
  ).filter((i) => i.kind === 'link');

  assert.ok(links.length >= 4);
  for (const link of links) {
    if (link.kind !== 'link') continue;
    if (link.href === null) continue;
    assert.equal(safeHref(link.href), link.href, `href 必须来自白名单: ${link.href}`);
  }
});

// ---------------------------------------------------------------------------
// 渲染层约束：不得使用 dangerouslySetInnerHTML
// ---------------------------------------------------------------------------

test('S9A-F02g 渲染器不使用 dangerouslySetInnerHTML', async () => {
  const source = await readFile(resolve(ROOT, 'plugins/markdown/viewer.tsx'), 'utf8');
  // 注释里允许出现该词（用于说明策略），但不得作为属性/赋值真正使用。
  assert.equal(
    /dangerouslySetInnerHTML\s*[:=]/.test(source),
    false,
    '渲染层必须只产出 React 节点，禁止注入 HTML',
  );
});
