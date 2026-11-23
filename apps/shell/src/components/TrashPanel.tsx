/**
 * 回收区面板（UX-02C-03-P2-02）。
 *
 * 只渲染 `useTrash().panel` 算好的视图模型：状态徽标、能不能恢复、禁用原因
 * 全部来自 `state/trash.ts`，组件不重新判定一遍（否则两处规则必然走形）。
 *
 * 三条产品约束在这里体现为"没有对应控件"：
 * - 没有永久删除；
 * - 没有自动清理 / 批量；
 * - 没有"恢复到指定位置"——目标由 Host 记录决定。
 */
import { useMemo, useState } from 'react';
import { useTrash } from '../state/TrashContext.tsx';
import { useWorkspace } from '../state/WorkspaceContext.tsx';

export function TrashPanel() {
  const { state, dispatch } = useWorkspace();
  const { panel, load, restore, precheck, loading } = useTrash();
  const [message, setMessage] = useState<string | null>(null);

  const projectName = useMemo(() => {
    const project = state.projects.find((item) => item.projectId === state.activeProjectId);
    return project?.name ?? null;
  }, [state.projects, state.activeProjectId]);

  const onRestore = async (opId: string, path: string): Promise<void> => {
    const projectId = state.activeProjectId;
    if (!projectId) return;
    const row = panel.kind === 'list' ? panel.rows.find((item) => item.opId === opId) : undefined;
    // 在途 / 待核对的行一律不发起请求（按钮已禁用，这里再挡一层鼠标/键盘的边界情况）
    if (row && (row.busy || row.unconfirmed || !row.canRestore)) return;
    setMessage(null);
    // 先做本地阻断检查：正在编辑/未保存的文件不让移动，避免"恢复了但草稿指向老内容"
    const checked = precheck(projectId, path);
    if (!checked.ok) {
      setMessage(checked.reasons.join(' '));
      dispatch({ type: 'NOTICE', message: checked.reasons.join(' ') });
      return;
    }
    // 用状态里的**真实记录**（含 size/deletedAt/state），绝不在这里拼一条假的 DTO
    const entry = (state.trashByProject[projectId]?.entries ?? []).find((item) => item.opId === opId);
    if (!entry) return;
    const result = await restore(projectId, entry);
    if (result.status === 'blocked') {
      setMessage(result.reasons.join(' '));
    }
  };

  return (
    <aside className="tree trash" aria-label="回收区">
      <header className="tree__header">
        <div>
          <div className="tree__project">回收区</div>
          <div className="tree__meta">
            {projectName ? `${projectName} · ` : ''}
            {panel.kind === 'list' ? `${panel.count} 条记录` : '按项目隔离'}
          </div>
        </div>
        <div className="tree__actions">
          <button
            type="button"
            className="icon-button"
            onClick={() => void load()}
            disabled={loading}
            title="重新读取回收区（会先与磁盘核对）"
            aria-label="刷新回收区"
          >
            ⟳
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => dispatch({ type: 'SET_NAV_KEY', key: 'projects' })}
            title="返回项目"
            aria-label="返回项目"
          >
            ←
          </button>
        </div>
      </header>

      {panel.kind === 'unsupported' && (
        <p className="trash__hint" role="status">
          {panel.message}
        </p>
      )}

      {panel.kind === 'loading' && (
        <p className="trash__hint" role="status">
          {panel.message}
        </p>
      )}

      {panel.kind === 'error' && (
        <div className="trash__hint trash__hint--error" role="alert">
          <p>{panel.message}</p>
          <button type="button" className="chip chip--tiny" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}

      {panel.kind === 'list' && (
        <>
          {panel.degraded && (
            <p className="trash__hint trash__hint--warn" role="status">
              {panel.degraded}
            </p>
          )}
          {message && (
            <p className="trash__hint trash__hint--warn" role="status">
              {message}
            </p>
          )}
          {panel.rows.length === 0 ? (
            <p className="trash__hint">
              回收区是空的。移入回收区的文件会出现在这里，可随时恢复到原位置。
            </p>
          ) : (
            <ul className="trash__list">
              {panel.rows.map((row) => (
                <li key={row.opId} className="trash__item" data-trash-state={row.stateLabel}>
                  <div className="trash__row">
                    <span className="trash__name" title={row.name}>
                      {row.name}
                    </span>
                    <span className={`trash__badge trash__badge--${row.tone}`}>{row.stateLabel}</span>
                  </div>
                  <div className="trash__path" title={row.originalPath}>
                    原始位置：{row.originalPath}
                  </div>
                  <div className="trash__meta">
                    {row.deletedAtLabel} · {row.sizeLabel}
                  </div>
                  {row.hint && <div className="trash__note">{row.hint}</div>}
                  <div className="trash__actions">
                    {row.unconfirmed ? (
                      <button
                        type="button"
                        className="chip chip--tiny"
                        disabled
                        title="结果未确认：核对完成前不能再次恢复（不会自动重发）"
                      >
                        待核对
                      </button>
                    ) : row.busy ? (
                      <button type="button" className="chip chip--tiny" disabled>
                        恢复中…
                      </button>
                    ) : row.canRestore ? (
                      <button
                        type="button"
                        className="chip chip--tiny chip--primary"
                        onClick={() => void onRestore(row.opId, row.originalPath)}
                      >
                        恢复
                      </button>
                    ) : (
                      <span className="trash__disabled" title={row.hint}>
                        {row.stateLabel === '已恢复' ? '已恢复' : '不可恢复'}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}
