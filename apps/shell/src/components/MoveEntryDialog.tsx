/**
 * 移动到…（UX-02C-02）：工作区内的目标文件夹选择界面。
 *
 * - 只在**同一个授权项目**内选择；候选来自 Shell 已加载层表里的真实普通文件夹，
 *   未加载到的分页不假装存在，链接节点不列入；
 * - 目录自身与它的全部后代被排除，根目录显示为「（项目根）」；
 * - 移动前明确展示源相对路径与目标相对路径，用户点「确认移动」才提交；
 * - Esc / 取消零磁盘变更；错误与阻断原因行内保留，不关闭对话框。
 *
 * 组件不 fetch、不碰磁盘：确认动作交给 `TreeCommandsContext` 的同一条编排。
 */
import { createPortal } from 'react-dom';
import { displayPath } from '../state/structure-change.ts';
import { useTreeCommands } from './TreeCommandsContext.tsx';

export function MoveEntryDialog() {
  const commands = useTreeCommands();
  const dialog = commands.moveDialog;
  if (!dialog) return null;

  const targetPath =
    dialog.targetParentDir === ''
      ? dialog.targetName
      : `${dialog.targetParentDir}/${dialog.targetName}`;

  return createPortal(
    <div className="modal__backdrop" role="presentation" onMouseDown={() => commands.cancelMove()}>
      <div
        className="modal move__dialog"
        role="dialog"
        aria-modal="true"
        aria-label="移动文件或文件夹"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            commands.cancelMove();
          }
        }}
      >
        <h2 className="modal__title">移动到…</h2>
        <p className="modal__lead">
          只在当前项目内移动，不会删除磁盘文件，也不会覆盖同名目标。跨项目移动暂不提供。
        </p>
        <dl className="move__paths">
          <dt>源位置</dt>
          <dd>{displayPath(dialog.sourcePath)}</dd>
          <dt>目标位置</dt>
          <dd>{displayPath(targetPath)}</dd>
        </dl>
        <label className="move__label" htmlFor="move-target-select">
          目标文件夹
        </label>
        <select
          id="move-target-select"
          className="move__select"
          value={dialog.targetParentDir}
          disabled={dialog.submitting}
          onChange={(event) => commands.setMoveTarget(event.target.value)}
        >
          {dialog.options.map((dir) => (
            <option key={dir || '__root__'} value={dir}>
              {displayPath(dir)}
            </option>
          ))}
        </select>
        {dialog.options.length === 0 && (
          <p className="modal__hint">当前项目还没有其它可选文件夹：请先展开目录加载后再试。</p>
        )}
        {dialog.error && <p className="move__error">{dialog.error}</p>}
        <div className="modal__actions">
          <button
            type="button"
            className="button button--ghost"
            disabled={dialog.submitting}
            onClick={commands.cancelMove}
          >
            取消（Esc）
          </button>
          <button
            type="button"
            className="button"
            disabled={dialog.submitting || dialog.options.length === 0}
            onClick={() => void commands.confirmMove()}
          >
            {dialog.submitting ? '正在移动…' : '确认移动'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
