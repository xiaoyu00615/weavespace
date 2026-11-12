import { useWorkspace } from '../state/WorkspaceContext';
import type { AuxTab } from '../state/types';

const TABS: ReadonlyArray<{ key: AuxTab; label: string }> = [
  { key: 'ai', label: 'AI' },
  { key: 'tasks', label: '任务' },
  { key: 'diagnostics', label: '诊断' },
];

const PLACEHOLDER: Record<AuxTab, { title: string; lines: string[] }> = {
  ai: {
    title: 'AI 辅助（预留位置）',
    lines: [
      '后续由 Core 的命令通道接入，UI 只提交受控命令。',
      '当前阶段不接入任何模型，也不会外发内容。',
    ],
  },
  tasks: {
    title: '任务与进度（预留位置）',
    lines: ['用于展示解析、索引、批量保存等长任务的进度。', 'S9-A 仅呈现占位结构。'],
  },
  diagnostics: {
    title: '诊断（预留位置）',
    lines: ['预留 traceId / 错误码 / 日志入口。', '真实数据将由 observability 模块提供。'],
  },
};

/** 右侧可折叠辅助面板：仅提供位置与分区切换。 */
export function AuxPanel() {
  const { state, dispatch } = useWorkspace();

  if (state.auxCollapsed) {
    return (
      <aside className="aux aux--collapsed" aria-label="辅助面板（已折叠）">
        <button
          type="button"
          className="aux__expand"
          onClick={() => dispatch({ type: 'TOGGLE_AUX' })}
          title="展开辅助面板"
        >
          «
        </button>
        <span className="aux__collapsed-label">辅助面板</span>
      </aside>
    );
  }

  const current = PLACEHOLDER[state.auxTab];

  return (
    <aside className="aux" aria-label="辅助面板">
      <header className="aux__header">
        <div className="aux__tabs" role="tablist" aria-label="辅助面板分区">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={state.auxTab === tab.key}
              className={state.auxTab === tab.key ? 'chip chip--tiny chip--active' : 'chip chip--tiny'}
              onClick={() => dispatch({ type: 'SET_AUX_TAB', tab: tab.key })}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => dispatch({ type: 'TOGGLE_AUX' })}
          title="折叠辅助面板"
        >
          »
        </button>
      </header>

      <div className="aux__body">
        <h2 className="aux__title">{current.title}</h2>
        <ul className="aux__list">
          {current.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="aux__note">S9-A 阶段：结构就位，数据未接入。</p>
      </div>
    </aside>
  );
}
