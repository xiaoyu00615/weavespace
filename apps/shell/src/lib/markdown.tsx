/**
 * 极简 Markdown 渲染（S9-A）。
 *
 * 解析逻辑在 `markdown-parser.ts`（纯函数、可被 Node 直接测试），本文件只做
 * AST → React 节点的映射，**始终不使用 dangerouslySetInnerHTML**，因此不存在 HTML 注入面。
 * 链接的协议白名单在解析期完成（`safeHref`），这里只判断 `href` 是否存在：
 * `href === null` 的链接按原始文本输出，不会产出任何可执行/可跳转的锚点。
 */
import type { ReactElement, ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from './markdown-parser';

function inlineNodes(inlines: Inline[], keyBase: string): ReactNode[] {
  return inlines.map((node, i) => {
    const key = `${keyBase}-i${i}`;
    switch (node.kind) {
      case 'code':
        return <code key={key}>{node.value}</code>;
      case 'strong':
        return <strong key={key}>{node.value}</strong>;
      case 'em':
        return <em key={key}>{node.value}</em>;
      case 'link':
        if (node.href === null) {
          // 协议不被允许：降级为普通文本原文，不渲染锚点。
          return node.raw;
        }
        return (
          <a key={key} href={node.href} target="_blank" rel="noopener noreferrer">
            {node.label}
          </a>
        );
      default:
        return node.value;
    }
  });
}

function headingTag(level: number, content: ReactNode[], key: string): ReactElement {
  switch (level) {
    case 1:
      return <h1 key={key}>{content}</h1>;
    case 2:
      return <h2 key={key}>{content}</h2>;
    case 3:
      return <h3 key={key}>{content}</h3>;
    case 4:
      return <h4 key={key}>{content}</h4>;
    case 5:
      return <h5 key={key}>{content}</h5>;
    default:
      return <h6 key={key}>{content}</h6>;
  }
}

function renderBlock(block: Block, key: string): ReactElement {
  switch (block.kind) {
    case 'heading':
      return headingTag(block.level, inlineNodes(block.inlines, key), key);
    case 'hr':
      return <hr key={key} />;
    case 'code':
      return (
        <pre key={key}>
          <code>{block.text}</code>
        </pre>
      );
    case 'quote':
      return <blockquote key={key}>{inlineNodes(block.inlines, key)}</blockquote>;
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={`li${i}`}>{inlineNodes(item, `${key}-${i}`)}</li>
      ));
      return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
    case 'table':
      return (
        <table key={key}>
          <thead>
            <tr>
              {block.head.map((cell, i) => (
                <th key={`h${i}`}>{inlineNodes(cell, `${key}-h${i}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.body.map((row, r) => (
              <tr key={`r${r}`}>
                {row.map((cell, c) => (
                  <td key={`c${c}`}>{inlineNodes(cell, `${key}-r${r}c${c}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    default:
      return <p key={key}>{inlineNodes(block.inlines, key)}</p>;
  }
}

/** 把 Markdown 文本渲染为块级节点；不认识的行按普通段落处理。 */
export function MarkdownView({ source }: { source: string }): ReactElement {
  const blocks = parseMarkdown(source);
  return (
    <div className="markdown">
      {blocks.map((block, i) => renderBlock(block, `b${i}`))}
    </div>
  );
}
