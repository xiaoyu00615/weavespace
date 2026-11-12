import { useWorkspace } from '../state/WorkspaceContext';
import { MarkdownView } from '../lib/markdown';

/** 源码编辑视图：受控 textarea，修改直接写入演示缓冲。 */
export function EditorPane({ docId }: { docId: string }) {
  const { state, dispatch } = useWorkspace();
  const tab = state.tabs.find((item) => item.docId === docId);
  if (!tab) return <div className="pane__empty">文档未打开</div>;

  return (
    <div className="editor">
      <textarea
        className="editor__area"
        value={tab.buffer}
        spellCheck={false}
        aria-label={`${tab.title} 源码`}
        onChange={(event) => dispatch({ type: 'EDIT_DOC', docId, text: event.target.value })}
      />
      <div className="editor__footer">
        {tab.buffer.length} 字符 · {tab.buffer.split('\n').length} 行 · 演示缓冲（不写盘）
      </div>
    </div>
  );
}

/** 预览视图：Markdown 渲染或纯文本原样显示。 */
export function PreviewPane({ docId }: { docId: string }) {
  const { state } = useWorkspace();
  const tab = state.tabs.find((item) => item.docId === docId);
  if (!tab) return <div className="pane__empty">文档未打开</div>;

  return (
    <div className="preview">
      {tab.kind === 'markdown' ? (
        <MarkdownView source={tab.buffer} />
      ) : (
        <pre className="preview__plain">{tab.buffer}</pre>
      )}
      <div className="preview__footer">预览由演示缓冲实时渲染，不读取磁盘</div>
    </div>
  );
}
