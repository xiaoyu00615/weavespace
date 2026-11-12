import { useCallback, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useWorkspace } from '../state/WorkspaceContext';
import { EditorPane, PreviewPane } from './DocumentViews';
import type { PaneId, ViewMode } from '../state/types';

function PaneHeader({ pane, docId }: { pane: PaneId; docId: string }) {
  const { state, dispatch } = useWorkspace();
  const paneState = state.panes[pane];
  const tab = state.tabs.find((item) => item.docId === docId);

  const modes: ReadonlyArray<{ key: ViewMode; label: string }> = [
    { key: 'editor', label: '源码' },
    { key: 'preview', label: '预览' },
  ];

  return (
    <header className="pane__header">
      <button
        type="button"
        className="pane__title"
        onClick={() => dispatch({ type: 'FOCUS_PANE', pane })}
        aria-label={`聚焦${pane === 'primary' ? '左' : '右'}窗格`}
      >
        {pane === 'primary' ? '左' : '右'} · {tab?.title ?? '空'}
      </button>
      <div className="pane__modes" role="group" aria-label="视图模式">
        {modes.map((mode) => (
          <button
            key={mode.key}
            type="button"
            className={paneState.mode === mode.key ? 'chip chip--tiny chip--active' : 'chip chip--tiny'}
            aria-pressed={paneState.mode === mode.key}
            onClick={() => dispatch({ type: 'SET_PANE_MODE', pane, mode: mode.key })}
          >
            {mode.label}
          </button>
        ))}
      </div>
    </header>
  );
}

function Pane({ pane }: { pane: PaneId }) {
  const { state, dispatch } = useWorkspace();
  const docId = state.panes[pane].docId;
  const mode = state.panes[pane].mode;
  const active = state.focusedPane === pane && state.layout === 'vertical';

  if (!docId) {
    return (
      <section
        className={active ? 'pane pane--active' : 'pane'}
        onPointerDown={() => dispatch({ type: 'FOCUS_PANE', pane })}
      >
        <div className="pane__empty">
          <p>还没有打开文档</p>
          <p className="pane__hint">在左侧文件树中选择一个文件（演示数据）</p>
        </div>
      </section>
    );
  }

  return (
    <section
      className={active ? 'pane pane--active' : 'pane'}
      onPointerDown={() => dispatch({ type: 'FOCUS_PANE', pane })}
      aria-label={`${pane === 'primary' ? '左' : '右'}窗格`}
    >
      <PaneHeader pane={pane} docId={docId} />
      <div className="pane__body">
        {mode === 'editor' ? <EditorPane docId={docId} /> : <PreviewPane docId={docId} />}
      </div>
    </section>
  );
}

/** 主工作区：单视图 / 左右分屏，分隔条可拖动或用方向键微调。 */
export function SplitWorkspace() {
  const { state, dispatch } = useWorkspace();
  const containerRef = useRef<HTMLDivElement>(null);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        const ratio = ((ev.clientX - rect.left) / rect.width) * 100;
        dispatch({ type: 'SET_SPLIT_RATIO', ratio });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      event.preventDefault();
    },
    [dispatch],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft') {
        dispatch({ type: 'SET_SPLIT_RATIO', ratio: state.splitRatio - 2 });
        event.preventDefault();
      } else if (event.key === 'ArrowRight') {
        dispatch({ type: 'SET_SPLIT_RATIO', ratio: state.splitRatio + 2 });
        event.preventDefault();
      }
    },
    [dispatch, state.splitRatio],
  );

  if (state.layout === 'single') {
    return (
      <div className="workspace workspace--single" ref={containerRef}>
        <Pane pane="primary" />
      </div>
    );
  }

  return (
    <div
      className="workspace workspace--split"
      ref={containerRef}
      style={{ gridTemplateColumns: `minmax(0, ${state.splitRatio}%) 8px minmax(0, 1fr)` }}
    >
      <Pane pane="primary" />
      <div
        className="splitter"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={state.splitRatio}
        aria-valuemin={25}
        aria-valuemax={75}
        aria-label="调整分屏比例"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      >
        <span className="splitter__grip" aria-hidden="true" />
      </div>
      <Pane pane="secondary" />
    </div>
  );
}
