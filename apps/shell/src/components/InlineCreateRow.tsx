/**
 * 行内命名（UX-02C-01 创建 / UX-02C-02 改名）：**临时输入行，不立即修改磁盘**。
 *
 * - 打开即聚焦；创建时预设扩展名只选中主文件名，改名时预填原名并选中主文件名；
 * - Enter 提交 / Esc 取消（磁盘零变更），非法名称显示行内错误并保留输入；
 * - 提交中禁用输入并挡住重复提交；只有 Host 明确确认才由树刷新呈现真实节点，
 *   绝不预先插一个"看起来已经成功"的假节点。
 *
 * 改名的输入行渲染在**被右键那一行的下方**（`InlineRenameSlot`），而不是塞进
 * `<button>` 里，也不做"先把节点名字改了"的乐观更新。
 */
import { useEffect, useRef } from 'react';
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
  if (
    !naming ||
    naming.mode !== 'create' ||
    naming.projectId !== projectId ||
    naming.parentDir !== parentDir
  ) {
    return null;
  }
  return <InlineNamingRow state={naming} depth={depth} commands={commands} />;
}

/** 改名：只出现在源节点所在层、且紧跟在源节点之后。 */
export function InlineRenameSlot({
  projectId,
  sourcePath,
  depth,
}: {
  projectId: string;
  sourcePath: string;
  depth: number;
}) {
  const commands = useTreeCommands();
  const naming = commands.naming;
  if (
    !naming ||
    naming.mode !== 'rename' ||
    naming.projectId !== projectId ||
    naming.sourcePath !== sourcePath
  ) {
    return null;
  }
  return <InlineNamingRow state={naming} depth={depth} commands={commands} />;
}

function InlineNamingRow({
  state,
  depth,
  commands,
}: {
  state: NamingState;
  depth: number;
  commands: ReturnType<typeof useTreeCommands>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const renaming = state.mode === 'rename';

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(state.selection[0], state.selection[1]);
    // 只在挂载时设定初值/选区；之后用户自己编辑的输入不被重设
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <li className="tree__create" style={{ paddingLeft: `${depth * 18 + 26}px` }}>
      <div className="tree__create-line">
        <span className="tree__create-glyph" aria-hidden="true">
          {renaming ? '✎' : state.kind === 'directory' ? '▸' : '+'}
        </span>
        <input
          ref={inputRef}
          className={state.error ? 'tree__create-input tree__create-input--invalid' : 'tree__create-input'}
          value={state.draft}
          disabled={state.submitting}
          aria-label={renaming ? '新名称' : state.kind === 'directory' ? '新文件夹名称' : '新文件名称'}
          aria-invalid={state.error !== null}
          maxLength={255}
          placeholder={
            renaming
              ? '新名称（保留扩展名）'
              : state.kind === 'directory'
                ? '文件夹名称'
                : '文件名（含扩展名）'
          }
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
          title={renaming ? '确认改名（Enter）' : '创建（Enter）'}
          aria-label="确认"
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
          aria-label="取消"
          disabled={state.submitting}
          onMouseDown={(event) => event.preventDefault()}
          onClick={commands.cancelNaming}
        >
          ×
        </button>
      </div>
      <p className={state.error ? 'tree__create-hint tree__create-hint--error' : 'tree__create-hint'}>
        {state.error ?? (state.submitting ? '正在提交…' : 'Enter 确认 · Esc 取消')}
      </p>
    </li>
  );
}
