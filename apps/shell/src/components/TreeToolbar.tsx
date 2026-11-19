/**
 * 文件树顶部高频操作（UX-02C-01 创建 / UX-02C-03-P1 显示隐藏项）。
 *
 * 与右键菜单**共用** `TreeCommandsContext` 的同一条命令编排，不实现第二套创建逻辑。
 * 第一版保持 Obsidian 式简洁：几个小图标按钮 + 一个"隐藏项"开关，不做整页视觉重构。
 * Demo / Legacy / 静态 Multi 下按钮明确禁用并给出原因，不制造"点了会假成功"的入口。
 */
import { useWorkspace } from '../state/WorkspaceContext.tsx';
import { useDocumentActions } from '../state/DocumentActionsContext.tsx';
import { countHiddenInLoadedLevels } from './tree-model.ts';
import { useTreeCommands } from './TreeCommandsContext.tsx';

export function TreeToolbar() {
  const { state } = useWorkspace();
  const actions = useDocumentActions();
  const commands = useTreeCommands();
  const projectId = state.activeProjectId;
  const usable =
    state.mode === 'live' &&
    state.workspaceMode === 'multi' &&
    Boolean(projectId) &&
    state.projects.some((project) => project.projectId === projectId && project.status === 'READY');
  const whyNot = usable ? undefined : '当前模式或项目不支持真实创建';

  /**
   * "隐藏项"开关（UX-02C-03-P1 / R1）。
   *
   * 数字口径 = **已加载目录层合计**，只来自服务端的逐层 `hiddenCount`：
   * 默认视图里隐藏条目不在 `entries` 里，没有这个数字用户就不知道有东西被收起来了；
   * 但它**不是全项目总数**（没展开的目录不计入），所以标题里必须写明，
   * 不能让局部数字被读成"整个项目只有这么多"。
   */
  const levels = projectId ? (state.treeByProject[projectId] ?? {}) : {};
  const hiddenCount = countHiddenInLoadedLevels(levels);
  const toggleTitle = usable
    ? state.showHidden
      ? `隐藏项已显示（已加载层合计 ${hiddenCount} 项）；点击恢复默认视图`
      : hiddenCount > 0
        ? `显示隐藏项（已加载层合计 ${hiddenCount} 项；未展开的目录不计入）`
        : '显示隐藏项（已加载层中没有隐藏项）'
    : '当前模式或项目不支持工作台隐藏';

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
      {/*
        图标按钮（与 ＋/▣/↻ 同一节奏）：侧栏只有 260px，带文字的胶囊会把这一排挤到换行
        ——真实浏览器里已复现，所以这里用"状态字形 + 计数"，完整语义放在 title/aria-label。
      */}
      <button
        type="button"
        className="tree__visibility-toggle"
        aria-pressed={state.showHidden}
        aria-label={
          state.showHidden
            ? `隐藏项已显示（已加载层合计 ${hiddenCount} 项），点击恢复默认视图`
            : hiddenCount > 0
              ? `显示隐藏项（已加载层合计 ${hiddenCount} 项）`
              : '显示隐藏项'
        }
        title={toggleTitle}
        disabled={!usable}
        // 真实交互：切换后由编排层作废层表并重新拉取，不是静态按钮
        onClick={() => void actions.setShowHidden(!state.showHidden)}
      >
        <span aria-hidden="true">{state.showHidden ? '◉' : '◌'}</span>
        {hiddenCount > 0 && (
          <span
            className="tree__visibility-count"
            aria-hidden="true"
            title={`已加载层中 ${hiddenCount} 项被隐藏（未展开目录不计入）`}
          >
            {hiddenCount}
          </span>
        )}
      </button>
    </span>
  );
}
