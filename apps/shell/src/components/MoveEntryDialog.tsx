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
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { displayPath } from '../state/structure-change.ts';
import { focusWhereOf, shouldRestoreFocus, type FocusWhere } from './focus-restore.ts';
import { useTreeCommands } from './TreeCommandsContext.tsx';

export function MoveEntryDialog() {
  const commands = useTreeCommands();
  const dialog = commands.moveDialog;
  /**
   * 焦点锚点（R2.1 / E）：对话框打开时落在「确认移动」，提交结束后再还回去。
   *
   * 必须在提前 return **之前**声明 hooks：对话框关闭时组件仍然挂在这个位置，
   * hooks 顺序不能因为 `dialog === null` 而变。
   */
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const prevSubmitting = useRef(false);
  const focusAtStart = useRef<FocusWhere>('body');
  const sessionId = dialog?.intent.sessionId ?? null;

  // 打开 / 换会话：把焦点放进对话框，Escape 才有接收者
  useEffect(() => {
    if (sessionId === null) return;
    primaryRef.current?.focus();
  }, [sessionId]);

  // 提交结束（true → false）：只还给同一个会话，且不抢别人已经拿走的焦点
  useEffect(() => {
    const submitting = dialog?.submitting ?? false;
    const ended = prevSubmitting.current && !submitting;
    prevSubmitting.current = submitting;
    if (submitting) {
      focusAtStart.current = focusWhereOf(document.activeElement, primaryRef.current);
      return;
    }
    if (!ended) return;
    if (
      !shouldRestoreFocus({
        ended: true,
        sessionCurrent: sessionId !== null,
        atStart: focusAtStart.current,
        now: focusWhereOf(document.activeElement, primaryRef.current),
      })
    ) {
      return;
    }
    primaryRef.current?.focus();
  }, [dialog?.submitting, sessionId]);

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
            return;
          }
          /**
           * Enter = 按既有契约提交（R2.1 / E）。
           *
           * 只在对话框内生效；`preventDefault` 同时挡掉按钮的原生激活，
           * 因此不会出现"一次 Enter 提交两次"。提交中一律忽略（单飞已在编排层）。
           */
          if (event.key === 'Enter') {
            if (event.target instanceof HTMLElement && event.target.tagName === 'TEXTAREA') return;
            event.preventDefault();
            if (dialog.submitting || dialog.options.length === 0) return;
            void commands.confirmMove();
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
            ref={primaryRef}
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
