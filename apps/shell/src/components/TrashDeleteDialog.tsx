/**
 * 「移入回收区」的二段确认模态（UX-02C-03-P2-02）。
 *
 * 与 `RemoveProjectEntry` 同一套阶段划分（checking / ready / blocked / confirming / result），
 * 同样用 portal 挂到 body、同样的 `modal` 语义，**不用** `window.confirm`：
 * 原生确认框无法承载"文件去了哪里、能不能恢复、取消会怎样"这三条必须说清的信息。
 *
 * 文案纪律（逐条对应产品约束）：
 * - 文件会移动到当前项目目录下的 `.weavespace/trash`（不是系统回收站）；
 * - **不会**被永久删除；
 * - 可以随时恢复到原位置；
 * - 取消不产生任何磁盘修改。
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTrash } from '../state/TrashContext.tsx';

export function TrashDeleteDialog() {
  const { deleteDialog, confirmDelete, cancelDelete } = useTrash();
  const phase = deleteDialog?.phase ?? null;

  useEffect(() => {
    if (!phase) return;
    const onKey = (event: KeyboardEvent): void => {
      // 确认中不允许 Esc 关闭：提交已经发出，关掉只会让用户以为"取消了"
      if (event.key === 'Escape' && (phase === 'ready' || phase === 'blocked' || phase === 'result')) {
        cancelDelete();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, cancelDelete]);

  if (!deleteDialog) return null;

  return createPortal(
    <div className="modal__backdrop" role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trash-delete-title"
        data-trash-delete={deleteDialog.phase}
      >
        <h2 className="modal__title" id="trash-delete-title">
          移入回收区「{deleteDialog.name}」
        </h2>

        {deleteDialog.phase === 'ready' && (
          <>
            <p className="modal__lead">
              该文件会移动到当前项目下的{' '}
              <code>.weavespace/trash</code>，<strong>不会被永久删除</strong>。
            </p>
            <ol className="modal__list">
              <li>它从文件树里消失，但内容仍在项目目录内，只是换了位置。</li>
              <li>你可以随时在「回收区」里把它恢复到原位置（原位置已有同名文件时不会覆盖）。</li>
              <li>本版本没有永久删除，也不会自动清理回收区。</li>
              <li>点「取消」不会产生任何磁盘修改。</li>
            </ol>
            <div className="modal__actions">
              <button type="button" className="chip chip--tiny" onClick={cancelDelete}>
                取消
              </button>
              <button
                type="button"
                className="chip chip--tiny chip--primary"
                data-trash-confirm="true"
                onClick={() => void confirmDelete()}
              >
                确认移入回收区
              </button>
            </div>
          </>
        )}

        {deleteDialog.phase === 'blocked' && (
          <>
            <p className="modal__lead modal__lead--error" role="alert">
              现在不能移入回收区：请先处理下列情况。
            </p>
            <ol className="modal__list">
              {(deleteDialog.reasons.length > 0
                ? deleteDialog.reasons
                : ['当前状态不允许回收这个文件。']
              ).map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ol>
            <p className="modal__hint">
              为保护未保存的内容，这里不提供"强制移除"。处理好之后可以再次尝试。
            </p>
            <div className="modal__actions">
              <button type="button" className="chip chip--tiny chip--primary" onClick={cancelDelete}>
                好的
              </button>
            </div>
          </>
        )}

        {(deleteDialog.phase === 'checking' || deleteDialog.phase === 'confirming') && (
          <p className="modal__lead" role="status">
            {deleteDialog.phase === 'checking' ? '正在检查…' : '正在移入回收区…'}
          </p>
        )}

        {deleteDialog.phase === 'result' && deleteDialog.result && (
          <>
            <p
              className={
                deleteDialog.result.tone === 'ok'
                  ? 'modal__lead'
                  : `modal__lead modal__lead--${deleteDialog.result.tone}`
              }
              role={deleteDialog.result.tone === 'ok' ? 'status' : 'alert'}
            >
              {deleteDialog.result.body}
            </p>
            <div className="modal__actions">
              <button type="button" className="chip chip--tiny chip--primary" onClick={cancelDelete} autoFocus>
                好的
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    // 项目行在树里（有 overflow 与堆叠上下文），原地渲染会让固定定位的模态被裁掉
    document.body,
  );
}
