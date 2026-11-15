/**
 * 行内命名（UX-02C-01）：临时输入行，**不立即修改磁盘**。
 *
 * - 打开即聚焦；预设扩展名时只选中主文件名，扩展名保留在原处；
 * - Enter 提交 / Esc 取消（磁盘零变更），非法名称显示行内错误并保留输入；
 * - 提交中禁用输入并挡住重复提交；只有 Host 明确确认才由树刷新呈现真实节点，
 *   绝不预先插一个"看起来已经成功"的假节点。
 */
import { useEffect, useRef } from 'react';
import { selectionForPreset } from '../state/create-entry.ts';
import { useTreeCommands, type NamingState } from './TreeCommandsContext.tsx';

export function InlineCreateSlot({
  projectId,
  parentDir,
  depth,
}: {
  /** `''` = Demo/Legacy 单根；否则是项目 id。 */
  projectId: string;
  parentDir: string;
  depth: number;
}) {
  const commands = useTreeCommands();
  const naming = commands.naming;
  if (!naming || naming.projectId !== projectId || naming.parentDir !== parentDir) return null;
  return <InlineCreateRow state={naming} depth={depth} commands={commands} />;
}

function InlineCreateRow({
  state,
  depth,
  commands,
}: {
  state: NamingState;
  depth: number;
  commands: ReturnType<typeof useTreeCommands>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const [start, end] = selectionForPreset(state.draft, state.presetExtension);
    input.setSelectionRange(start, end);
    // 只在挂载时设定初值/选区；之后用户自己编辑的输入不被重设
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <li className="tree__create" style={{ paddingLeft: `${depth * 18 + 26}px` }}>
      <div className="tree__create-line">
        <span className="tree__create-glyph" aria-hidden="true">
          {state.kind === 'directory' ? '▸' : '+'}
        </span>
        <input
          ref={inputRef}
          className={state.error ? 'tree__create-input tree__create-input--invalid' : 'tree__create-input'}
          value={state.draft}
          disabled={state.submitting}
          aria-label={state.kind === 'directory' ? '新文件夹名称' : '新文件名称'}
          aria-invalid={state.error !== null}
          maxLength={255}
          placeholder={state.kind === 'directory' ? '文件夹名称' : '文件名（含扩展名）'}
          onChange={(event) => commands.setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void commands.submitNaming();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              commands.cancelNaming();
            }
          }}
          onBlur={() => {
            // 提交中失焦不收起：否则异步结果回来时输入行已经消失
            if (!state.submitting) commands.cancelNaming();
          }}
        />
        <button
          type="button"
          className="icon-button tree__create-ok"
          title="创建（Enter）"
          aria-label="确认创建"
          disabled={state.submitting}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void commands.submitNaming()}
        >
          ✓
        </button>
        <button
          type="button"
          className="icon-button tree__create-cancel"
          title="取消（Esc）"
          aria-label="取消创建"
          disabled={state.submitting}
          onMouseDown={(event) => event.preventDefault()}
          onClick={commands.cancelNaming}
        >
          ×
        </button>
      </div>
      <p className={state.error ? 'tree__create-hint tree__create-hint--error' : 'tree__create-hint'}>
        {state.error ?? (state.submitting ? '正在创建…' : 'Enter 创建 · Esc 取消')}
      </p>
    </li>
  );
}
