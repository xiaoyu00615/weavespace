import { useWorkspace } from '../state/WorkspaceContext';

/** 底部状态栏：模式标识、最近提示、活动文档与布局状态。 */
export function StatusBar() {
  const { state } = useWorkspace();
  const activeDocId =
    state.focusedPane === 'secondary' ? state.panes.secondary.docId : state.panes.primary.docId;
  const tab = state.tabs.find((item) => item.docId === activeDocId) ?? null;
  const live = state.mode === 'live';

  return (
    <footer className="statusbar" aria-label="状态栏">
      <span className={live ? 'statusbar__badge statusbar__badge--live' : 'statusbar__badge'}>
        {live ? '真实文件 · 保存会写盘' : '演示数据 · 不写盘'}
      </span>
      <span className="statusbar__notice">{state.notice}</span>
      <span className="statusbar__spacer" />
      <span className="statusbar__item">{tab ? tab.path : '无活动文档'}</span>
      <span className="statusbar__item">{tab ? `${tab.buffer.length} 字符` : '—'}</span>
      <span className="statusbar__item">
        {tab
          ? tab.dirty
            ? live
              ? '未保存（真实文件）'
              : '未保存（演示）'
            : live
              ? '已保存'
              : '已同步（演示）'
          : '—'}
      </span>
      {tab?.mode === 'live' && tab.sessionId && (
        <span className="statusbar__item" title="Core 会话（仅展示，不是访问凭据）">
          {tab.sessionId} · rev {tab.revision}
        </span>
      )}
      <span className="statusbar__item">
        {state.layout === 'single' ? '单视图' : `分屏 ${state.splitRatio}/${100 - state.splitRatio}`}
      </span>
    </footer>
  );
}
