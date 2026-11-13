import { useDocumentActions } from '../state/DocumentActionsContext';
import { isQuickFileVisible, useQuickFile } from '../state/QuickFileContext';
import { useWorkspace } from '../state/WorkspaceContext';
import { DEMO_PROJECT_NAME } from '../data/demo-project';

/** 顶部上下文工具栏：模式切换、布局切换、保存、辅助面板开关。 */
export function DocumentToolbar() {
  const { state, dispatch } = useWorkspace();
  const actions = useDocumentActions();
  const quick = useQuickFile();
  // Quick File 预览期间不提供任何保存入口：它不是可保存的文档
  const quickVisible = isQuickFileVisible(quick.state);
  const activeDocId =
    state.focusedPane === 'secondary' ? state.panes.secondary.docId : state.panes.primary.docId;
  const activeTab = state.tabs.find((tab) => tab.docId === activeDocId) ?? null;
  const live = state.mode === 'live';
  // 多项目：标题显示当前项目；不做成项目下拉（项目列表在左侧同时可见）
  const multi = live && state.workspaceMode === 'multi';
  const activeProject = multi
    ? state.projects.find((project) => project.projectId === state.activeProjectId)
    : undefined;
  const projectLabel = multi
    ? (activeProject?.name ?? '多项目工作区')
    : live
      ? '本地测试项目'
      : DEMO_PROJECT_NAME;

  return (
    <header className="toolbar" role="toolbar" aria-label="工作台工具栏">
      <div className="toolbar__left">
        <span className="toolbar__project">{projectLabel}</span>
        <span
          className={live ? 'badge badge--live' : 'badge badge--demo'}
          title={live ? '真实文件：保存会写入本机测试项目' : '所有内容均为内置演示数据'}
        >
          {live ? '真实文件' : '演示模式'}
        </span>
      </div>

      <div className="toolbar__group" role="group" aria-label="模式">
        <button
          type="button"
          className={!live ? 'chip chip--active' : 'chip'}
          aria-pressed={!live}
          onClick={() => void actions.switchMode('demo')}
          title="使用内置演示数据，不写盘"
        >
          演示
        </button>
        <button
          type="button"
          className={live ? 'chip chip--active' : 'chip'}
          aria-pressed={live}
          onClick={() => void actions.switchMode('live')}
          title="读取本机测试项目（需要先启动 apps/server）"
        >
          真实文件
        </button>
      </div>

      <div className="toolbar__group" role="group" aria-label="布局">
        <button
          type="button"
          className={state.layout === 'single' ? 'chip chip--active' : 'chip'}
          aria-pressed={state.layout === 'single'}
          onClick={() => dispatch({ type: 'SET_LAYOUT', layout: 'single' })}
        >
          单视图
        </button>
        <button
          type="button"
          className={state.layout === 'vertical' ? 'chip chip--active' : 'chip'}
          aria-pressed={state.layout === 'vertical'}
          onClick={() => dispatch({ type: 'SET_LAYOUT', layout: 'vertical' })}
        >
          左右分屏
        </button>
        {state.layout === 'vertical' && (
          <span className="toolbar__ratio" title="当前分屏比例（可拖动分隔条调整）">
            {state.splitRatio}% / {100 - state.splitRatio}%
          </span>
        )}
      </div>

      <div className="toolbar__right">
        {quickVisible ? (
          <span
            className="chip chip--active"
            title="Quick File 只读预览：内容来自本机临时选择的文件，不写盘、不可保存"
          >
            Quick File · 只读
          </span>
        ) : (
          <button
            type="button"
            className={live ? 'chip chip--primary' : 'chip'}
            disabled={!activeTab || activeTab.saving}
            title={live ? '经 Core 条件保存到磁盘（需要版本基线）' : '演示保存：只清除未保存标记，不写磁盘'}
            onClick={() => activeTab && void actions.saveTab(activeTab.docId)}
          >
            {activeTab?.saving ? '保存中…' : live ? '保存' : '保存（演示）'}
          </button>
        )}
        <button
          type="button"
          className={state.auxCollapsed ? 'chip' : 'chip chip--active'}
          aria-pressed={!state.auxCollapsed}
          onClick={() => dispatch({ type: 'TOGGLE_AUX' })}
        >
          辅助面板
        </button>
      </div>
    </header>
  );
}
