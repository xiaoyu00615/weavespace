/**
 * 极简 Markdown 渲染（S9-A）。
 *
 * 为什么自己写而不是引入依赖：本阶段只需要标题/列表/引用/代码/强调/链接；
 * 渲染结果全部走 React 节点，**不使用 dangerouslySetInnerHTML**，因此不存在 HTML 注入面。
 * 未来接入插件解析器时，这里整体替换为 Core 提供的 AST。
 */
import type { ReactElement, ReactNode } from 'react';

const INLINE_PATTERN = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;

function inlineNodes(text: string, keyBase: string): ReactNode[] {
  const pattern = new RegExp(INLINE_PATTERN.source, 'g');
  const out: ReactNode[] = [];
  let lastIndex = 0;
  let index = 0;
  let match = pattern.exec(text);
  while (match) {
    if (match.index > lastIndex) out.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyBase}-i${index}`;
    if (token.startsWith('`')) {
      out.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link) {
        out.push(
          <a key={key} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>,
        );
      } else {
        out.push(token);
      }
    }
    lastIndex = match.index + token.length;
    index += 1;
    match = pattern.exec(text);
  }
  if (lastIndex < text.length) out.push(text.slice(lastIndex));
  return out;
}

function heading(level: number, content: string, key: string): ReactElement {
  switch (level) {
    case 1:
      return <h1 key={key}>{inlineNodes(content, key)}</h1>;
    case 2:
      return <h2 key={key}>{inlineNodes(content, key)}</h2>;
    case 3:
      return <h3 key={key}>{inlineNodes(content, key)}</h3>;
    case 4:
      return <h4 key={key}>{inlineNodes(content, key)}</h4>;
    case 5:
      return <h5 key={key}>{inlineNodes(content, key)}</h5>;
    default:
      return <h6 key={key}>{inlineNodes(content, key)}</h6>;
  }
}

/** 把 Markdown 文本切成块级节点；不认识的行按普通段落处理。 */
export function MarkdownView({ source }: { source: string }): ReactElement {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    if (trimmed === '') {
      index += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith('```')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      blocks.push(
        <pre key={`b${key++}`}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (headingMatch) {
      blocks.push(heading(headingMatch[1].length, headingMatch[2], `b${key++}`));
      index += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      blocks.push(<hr key={`b${key++}`} />);
      index += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quote: string[] = [];
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('>')) {
        quote.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote key={`b${key++}`}>{inlineNodes(quote.join(' '), `b${key}`)}</blockquote>,
      );
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test((lines[index] ?? '').trim())) {
        items.push((lines[index] ?? '').trim().replace(/^[-*]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ul key={`b${key++}`}>
          {items.map((item, i) => (
            <li key={`li${i}`}>{inlineNodes(item, `b${key}-${i}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test((lines[index] ?? '').trim())) {
        items.push((lines[index] ?? '').trim().replace(/^\d+\.\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ol key={`b${key++}`}>
          {items.map((item, i) => (
            <li key={`li${i}`}>{inlineNodes(item, `b${key}-${i}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // 表格（仅支持场景清单这类简单两列/多列表格）
    if (trimmed.startsWith('|') && (lines[index + 1] ?? '').trim().startsWith('|')) {
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('|')) {
        const cells = (lines[index] ?? '')
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim());
        rows.push(cells);
        index += 1;
      }
      const [head, ...rest] = rows;
      const body = rest.filter((row) => !row.every((cell) => /^-{2,}$/.test(cell) || cell === ''));
      blocks.push(
        <table key={`b${key++}`}>
          <thead>
            <tr>
              {head.map((cell, i) => (
                <th key={`h${i}`}>{inlineNodes(cell, `b${key}-h${i}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={`r${r}`}>
                {row.map((cell, c) => (
                  <td key={`c${c}`}>{inlineNodes(cell, `b${key}-r${r}c${c}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    // 普通段落：连续非空行合并
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = (lines[index] ?? '').trim();
      if (
        current === '' ||
        current.startsWith('#') ||
        current.startsWith('```') ||
        current.startsWith('>') ||
        /^[-*]\s+/.test(current) ||
        /^\d+\.\s+/.test(current) ||
        current.startsWith('|') ||
        /^(-{3,}|\*{3,})$/.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push(<p key={`b${key++}`}>{inlineNodes(paragraph.join(' '), `b${key}`)}</p>);
  }

  return <div className="markdown">{blocks}</div>;
}
