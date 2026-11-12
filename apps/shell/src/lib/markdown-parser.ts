/**
 * 极简 Markdown 解析（S9-A）。
 *
 * 设计要点：
 * 1. **纯函数、无 React / 无 DOM**：渲染由 `markdown.tsx` 完成，因此解析逻辑可以被
 *    Node 直接加载并回归测试（`tests/suites/19-s9a-markdown.test.ts`）。
 * 2. **块级识别与段落终止共用同一个分类器**（`classifyBlock`）：早先版本里
 *    「块级分支不接受、段落循环却提前 break」的不一致会让 `index` 不前进
 *    （例如 `#没有空格`、孤立的 `|`），造成渲染死循环（S9A-F01）。
 * 3. `classifyBlock` 的兜底是 `text`，段落循环只在 `text` 上继续，
 *    因此**每轮至少消费一行**，不存在空转分支。
 * 4. 链接协议在解析期就完成校验（`safeHref`）：不可信协议不产生 `href`，
 *    渲染层因此永远拿不到 `javascript:` / `data:` 这类目标（S9A-F02）。
 * 5. 不追求 CommonMark 完整性；不认识的语法一律按普通文本输出。
 */

export type Inline =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'strong'; value: string }
  | { kind: 'em'; value: string }
  /**
   * `href === null` 表示协议不被允许：按普通文本降级（输出 `raw` 原文），
   * 渲染层不得产出锚点。
   */
  | { kind: 'link'; label: string; href: string | null; raw: string };

export type Block =
  | { kind: 'heading'; level: number; inlines: Inline[] }
  | { kind: 'hr' }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; inlines: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'table'; head: Inline[][]; body: Inline[][][] }
  | { kind: 'paragraph'; inlines: Inline[] };

const FENCE = '```';
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^(-{3,}|\*{3,})$/;
const UL_RE = /^[-*]\s+/;
const OL_RE = /^\d+\.\s+/;

/** 允许的链接协议；未列出的显式协议一律拒绝。 */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto']);

/**
 * 校验链接目标。
 *
 * - 允许：`http:` / `https:` / `mailto:`，以及不带协议的相对路径、锚点、查询串；
 * - 拒绝：`javascript:` / `data:` / `vbscript:` 等任何其他显式协议，
 *   以及协议相对形式 `//host`（它不是相对路径，会跳出当前站点）。
 *
 * 规范化时先剔除 ASCII 控制字符与空格，避免 `java\tscript:` 这类写法绕过协议判断
 * （浏览器解析 URL 时会忽略这些字符）。
 */
export function safeHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const probe = trimmed.replace(/[\u0000-\u0020\u007f]+/g, '').toLowerCase();
  if (probe === '') return null;

  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(probe);
  if (scheme) return SAFE_SCHEMES.has(scheme[1]) ? trimmed : null;

  // 协议相对（`//example.com`、`\\example.com`）会指向外部主机，按不可信处理。
  if (/^[\\/]{2}/.test(probe)) return null;

  return trimmed;
}

const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^()\s]+\))/g;
const LINK_RE = /^\[([^\]\n]+)\]\(([^()\s]+)\)$/;

/** 行内语法切分：代码 > 加粗 > 斜体 > 链接；不匹配的部分原样保留。 */
export function parseInline(text: string): Inline[] {
  const pattern = new RegExp(INLINE_RE.source, 'g');
  const out: Inline[] = [];
  let lastIndex = 0;
  let match = pattern.exec(text);
  while (match) {
    if (match.index > lastIndex) {
      out.push({ kind: 'text', value: text.slice(lastIndex, match.index) });
    }
    const token = match[0];
    if (token.startsWith('`')) {
      out.push({ kind: 'code', value: token.slice(1, -1) });
    } else if (token.startsWith('**')) {
      out.push({ kind: 'strong', value: token.slice(2, -2) });
    } else if (token.startsWith('*')) {
      out.push({ kind: 'em', value: token.slice(1, -1) });
    } else {
      const link = LINK_RE.exec(token);
      if (link) {
        out.push({ kind: 'link', label: link[1], href: safeHref(link[2]), raw: token });
      } else {
        // 形状像链接但不完整（例如括号不配对）：按原文输出，不猜测。
        out.push({ kind: 'text', value: token });
      }
    }
    lastIndex = match.index + token.length;
    match = pattern.exec(text);
  }
  if (lastIndex < text.length) out.push({ kind: 'text', value: text.slice(lastIndex) });
  return out;
}

type BlockKind =
  | 'blank'
  | 'fence'
  | 'heading'
  | 'hr'
  | 'quote'
  | 'ul'
  | 'ol'
  | 'table'
  | 'text';

/** 表格起判条件：当前行与下一行都以 `|` 开头（与原实现一致）。 */
function isTableStart(lines: readonly string[], index: number): boolean {
  const current = (lines[index] ?? '').trim();
  if (!current.startsWith('|')) return false;
  return (lines[index + 1] ?? '').trim().startsWith('|');
}

/**
 * 唯一的块级分类器：**主循环与段落终止条件都只认它**。
 * 返回 `text` 表示「按普通段落处理」，因此段落循环一定能拿到至少一行。
 */
export function classifyBlock(lines: readonly string[], index: number): BlockKind {
  const trimmed = (lines[index] ?? '').trim();
  if (trimmed === '') return 'blank';
  if (trimmed.startsWith(FENCE)) return 'fence';
  if (HEADING_RE.test(trimmed)) return 'heading';
  if (HR_RE.test(trimmed)) return 'hr';
  if (trimmed.startsWith('>')) return 'quote';
  if (UL_RE.test(trimmed)) return 'ul';
  if (OL_RE.test(trimmed)) return 'ol';
  if (isTableStart(lines, index)) return 'table';
  return 'text';
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const kind = classifyBlock(lines, index);

    if (kind === 'blank') {
      index += 1;
      continue;
    }

    if (kind === 'fence') {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith(FENCE)) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // 跳过结束围栏；未闭合时代码块自然延续到文末
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }

    if (kind === 'heading') {
      const headingMatch = HEADING_RE.exec((lines[index] ?? '').trim());
      // classifyBlock 已确认匹配，此处必有值；仍显式兜底避免非空断言。
      if (headingMatch) {
        blocks.push({
          kind: 'heading',
          level: headingMatch[1].length,
          inlines: parseInline(headingMatch[2]),
        });
      }
      index += 1;
      continue;
    }

    if (kind === 'hr') {
      blocks.push({ kind: 'hr' });
      index += 1;
      continue;
    }

    if (kind === 'quote') {
      const quote: string[] = [];
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('>')) {
        quote.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', inlines: parseInline(quote.join(' ')) });
      continue;
    }

    if (kind === 'ul' || kind === 'ol') {
      const ordered = kind === 'ol';
      const itemRe = ordered ? OL_RE : UL_RE;
      const items: Inline[][] = [];
      while (index < lines.length && itemRe.test((lines[index] ?? '').trim())) {
        items.push(parseInline((lines[index] ?? '').trim().replace(itemRe, '')));
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    if (kind === 'table') {
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('|')) {
        rows.push(
          (lines[index] ?? '')
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((cell) => cell.trim()),
        );
        index += 1;
      }
      const [head, ...rest] = rows;
      // 分隔行（`| --- | --- |`）丢弃：沿用原实现的「每格都是 --- 或空」判定。
      const body = rest.filter((row) => !row.every((cell) => /^-{2,}$/.test(cell) || cell === ''));
      blocks.push({
        kind: 'table',
        head: (head ?? []).map((cell) => parseInline(cell)),
        body: body.map((row) => row.map((cell) => parseInline(cell))),
      });
      continue;
    }

    // kind === 'text'：连续普通行合并为段落，遇到任何真正的块级起点即停。
    const paragraph: string[] = [];
    while (index < lines.length && classifyBlock(lines, index) === 'text') {
      paragraph.push((lines[index] ?? '').trim());
      index += 1;
    }
    if (paragraph.length === 0) {
      // 不可达（text 分类保证至少一行）；保留兜底以确保循环永不空转。
      paragraph.push((lines[index] ?? '').trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', inlines: parseInline(paragraph.join(' ')) });
  }

  return blocks;
}
