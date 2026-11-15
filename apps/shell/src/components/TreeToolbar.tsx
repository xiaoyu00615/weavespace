/**
 * 文件树顶部高频操作（UX-02C-01）：新建文件 / 新建文件夹 / 刷新。
 *
 * 与右键菜单**共用** `TreeCommandsContext` 的同一条命令编排，不实现第二套创建逻辑。
 * 第一版保持 Obsidian 式简洁：三个小图标按钮，不做整页视觉重构。
 * Demo / Legacy / 静态 Multi 下按钮明确禁用并给出原因，不制造"点了会假成功"的入口。
 */
import { useWorkspace } from '../state/WorkspaceContext.tsx';
import { useTreeCommands } from './TreeCommandsContext.tsx';

export function TreeToolbar() {
  const { state } = useWorkspace();
  const commands = useTreeCommands();
  const projectId = state.activeProjectId;
  const usable =
    state.mode === 'live' &&
    state.workspaceMode === 'multi' &&
    Boolean(projectId) &&
    state.projects.some((project) => project.projectId === projectId && project.status === 'READY');
  const whyNot = usable ? undefined : '当前模式或项目不支持真实创建';

  return (
    <span className="tree__create-actions" role="group" aria-label="文件树操作">
      <button
        type="button"
        className="icon-button"
        title={whyNot ?? '在当前目录新建文件'}
        aria-label="新建文件"
        disabled={!usable}
        onClick={() => commands.toolbarCreate('file')}
      >
        ＋
      </button>
      <button
        type="button"
        className="icon-button"
        title={whyNot ?? '在当前目录新建文件夹'}
        aria-label="新建文件夹"
        disabled={!usable}
        onClick={() => commands.toolbarCreate('directory')}
      >
        ▣
      </button>
      <button
        type="button"
        className="icon-button"
        title={whyNot ?? '刷新当前目录'}
        aria-label="刷新当前目录"
        disabled={!usable}
        onClick={commands.toolbarRefresh}
      >
        ↻
      </button>
    </span>
  );
}
