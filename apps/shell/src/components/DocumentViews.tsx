import { useDocumentActions } from '../state/DocumentActionsContext';
import { useWorkspace } from '../state/WorkspaceContext';
import { MarkdownView } from '../lib/markdown';

const STATUS_TEXT: Record<string, string> = {
  CLEAN: '已与磁盘一致',
  EDITING_DIRTY: '有未保存修改',
  SAVING: '保存中',
  CONFLICT: '版本冲突（内容已保留）',
  FAILED: '保存失败（内容已保留）',
  OUTCOME_UNKNOWN: '结果未确认（UNKNOWN）',
  DEMO: '演示缓冲（不写盘）',
};

/** 源码编辑视图：受控 textarea。修改立即进入本地缓冲，live 模式下按序同步到 Core。 */
export function EditorPane({ docId }: { docId: string }) {
  const { state } = useWorkspace();
  const actions = useDocumentActions();
  const tab = state.tabs.find((item) => item.docId === docId);
  if (!tab) return <div className="pane__empty">文档未打开</div>;

  const status = STATUS_TEXT[tab.documentState] ?? tab.documentState;
  const live = tab.mode === 'live';

  return (
    <div className="editor">
      <textarea
        className="editor__area"
        value={tab.buffer}
        spellCheck={false}
        aria-label={`${tab.title} 源码`}
        onChange={(event) => actions.editDoc(docId, event.target.value)}
      />
      <div className="editor__footer">
        {tab.buffer.length} 字符 · {tab.buffer.split('\n').length} 行 · {status}
        {live && tab.lastStatus ? ` · 上次保存：${tab.lastStatus}` : ''}
        {live && tab.errorCode ? ` · ${tab.errorCode}` : ''}
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
      <div className="preview__footer">
        {tab.mode === 'live'
          ? '预览由编辑缓冲实时渲染；磁盘内容以保存结果为准'
          : '预览由演示缓冲实时渲染，不读取磁盘'}
      </div>
    </div>
  );
}
