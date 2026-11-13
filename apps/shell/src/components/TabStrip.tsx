import { useDocumentActions } from '../state/DocumentActionsContext';
import { projectLabelOf } from '../state/doc-identity';
import { useQuickFile } from '../state/QuickFileContext';
import { useWorkspace } from '../state/WorkspaceContext';

/** 文件标签：切换活动文档、关闭标签（关闭规则由动作层按模式判定）。 */
export function TabStrip() {
  const { state, dispatch } = useWorkspace();
  const actions = useDocumentActions();
  const quick = useQuickFile();
  const activeDocId =
    state.focusedPane === 'secondary' ? state.panes.secondary.docId : state.panes.primary.docId;

  if (state.tabs.length === 0) {
    return (
      <div className="tabs tabs--empty">
        尚未打开文档 · 从左侧文件树选择
        {state.mode === 'live' ? '（真实文件）' : '（演示）'}
      </div>
    );
  }

  return (
    <div className="tabs" role="tablist" aria-label="已打开文档">
      {state.tabs.map((tab) => {
        const active = tab.docId === activeDocId;
        // 跨项目同名文件必须可区分：标签上显式标注项目名（G2-07）
        const projectLabel = projectLabelOf(state.projects, tab.projectId);
        return (
          <div key={tab.docId} className={active ? 'tab tab--active' : 'tab'}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="tab__label"
              onClick={() => {
                // 切到文档标签 = 离开 Quick File 预览（文件本身仍保留在左列）
                quick.deactivate();
                dispatch({ type: 'ACTIVATE_TAB', docId: tab.docId });
              }}
            >
              {projectLabel && <span className="tab__project">{projectLabel}</span>}
              {tab.title}
              {tab.dirty && (
                <span
                  className="tab__dirty"
                  title={
                    tab.mode === 'live' ? '有未保存的真实文件修改' : '有未保存的演示修改'
                  }
                />
              )}
              {tab.mode === 'live' && <span className="tab__mode">真实</span>}
            </button>
            <button
              type="button"
              className="tab__close"
              aria-label={`关闭 ${tab.title}`}
              onClick={() => void actions.closeTab(tab.docId)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
