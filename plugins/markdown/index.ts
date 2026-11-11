/**
 * Markdown 插件（P0 探针版）。
 * 只依赖 contracts 中的数据结构，不 import 任何其他插件的实现目录（ENG-002）。
 *
 * 序列化策略：**恒等**（原样返回）。因此 CRLF、BOM、行尾空格不会被改写；
 * 代价是不做格式化，也未做编码转换（只支持 UTF-8）。
 */
export interface MarkdownParseResult {
  title: string | null;
  headings: { level: number; text: string; offset: number }[];
  wordCount: number;
  /** 探测到的行尾风格，供诊断使用；保存时不做转换。 */
  eol: 'CRLF' | 'LF' | 'NONE';
  hasBom: boolean;
}

export function parseMarkdown(text: string): MarkdownParseResult {
  const hasBom = text.charCodeAt(0) === 0xfeff;
  const body = hasBom ? text.slice(1) : text;
  const eol: MarkdownParseResult['eol'] = body.includes('\r\n')
    ? 'CRLF'
    : body.includes('\n')
      ? 'LF'
      : 'NONE';

  const headings: MarkdownParseResult['headings'] = [];
  const headingRe = /^(#{1,6})[ \t]+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(body)) !== null) {
    headings.push({ level: match[1].length, text: match[2].trim(), offset: match.index });
  }

  const words = body
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);

  return {
    title: headings[0]?.text ?? null,
    headings,
    wordCount: words.length,
    eol,
    hasBom,
  };
}

/** 恒等序列化：保证不静默改写用户内容。 */
export function serializeMarkdown(buffer: string): string {
  return buffer;
}

export function createMarkdownPlugin() {
  let active = false;
  return {
    activate() {
      active = true;
    },
    deactivate() {
      active = false;
    },
    isActive() {
      return active;
    },
    parse: parseMarkdown,
    serialize: serializeMarkdown,
  };
}
