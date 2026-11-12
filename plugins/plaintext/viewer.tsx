/**
 * 通用纯文本查看器（S10-A）。
 *
 * 存在的意义：证明「查看能力可以由**另一个实现**提供」。当 Markdown 插件被停用时，
 * `.md` 仍然有安全的展示路径（原样显示文本），文件树、草稿与保存链路都不受影响。
 *
 * 只读：不声明写能力、不提供 serializer；保存仍走 Core 的 CommandBus。
 */
import type { ReactElement } from 'react';
import type { ViewerCapability } from '../../packages/contracts/types.ts';

/** 始终按纯文本渲染，不做任何语法解释。 */
export function PlainTextView({ source }: { source: string }): ReactElement {
  return <pre className="preview__plain">{source}</pre>;
}

export function createPlaintextViewer(): ViewerCapability {
  return {
    apiVersion: '1',
    // 声明 `.md` 是为了在 Markdown 插件不可用时提供**回退**，
    // 注册顺序决定优先级：Markdown 先注册，因此正常情况下由它胜出。
    extensions: ['.md', '.markdown', '.txt'],
    render: ({ content }) => <PlainTextView source={content} />,
  };
}
