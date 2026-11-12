import { useWorkspace } from '../state/WorkspaceContext';

/** 文件标签：切换活动文档、关闭标签（脏缓冲需确认）。 */
export function TabStrip() {
  const { state, dispatch } = useWorkspace();
  const activeDocId =
    state.focusedPane === 'secondary' ? state.panes.secondary.docId : state.panes.primary.docId;

  const closeTab = (docId: string, dirty: boolean) => {
    if (dirty && !window.confirm('该标签有未保存的演示修改，仍要关闭吗？')) return;
    dispatch({ type: 'CLOSE_TAB', docId });
  };

  if (state.tabs.length === 0) {
    return <div className="tabs tabs--empty">尚未打开文档 · 从左侧文件树选择</div>;
  }

  return (
    <div className="tabs" role="tablist" aria-label="已打开文档">
      {state.tabs.map((tab) => {
        const active = tab.docId === activeDocId;
        return (
          <div key={tab.docId} className={active ? 'tab tab--active' : 'tab'}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="tab__label"
              onClick={() => dispatch({ type: 'ACTIVATE_TAB', docId: tab.docId })}
            >
              {tab.title}
              {tab.dirty && <span className="tab__dirty" title="有未保存的演示修改" />}
            </button>
            <button
              type="button"
              className="tab__close"
              aria-label={`关闭 ${tab.title}`}
              onClick={() => closeTab(tab.docId, tab.dirty)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
