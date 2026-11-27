/**
 * 多项目列表（G2-01 / UX-02A → UX-02B-TREE）。
 *
 * 结构是一棵**真正的目录树**，不是平铺列表，也不是一套独立的项目卡片：
 *   depth 0：每个项目根（与子文件夹使用同一个 `TreeRow`）
 *   depth 1：根下的直接子项
 *   depth 2+：按需展开的子层
 *
 * 与 Demo / Legacy 的 `ProjectTree` 共用 `TreeBranch` 与全部 `FileTreeRow` 原语，
 * 因此"真实模式与演示模式根行结构不同"这个问题在结构上不可能再出现（契约 C.2）。
 *
 * 数据来自 `treeByProject[projectId]` 的层表：根层在连接/刷新时加载，
 * 子层只在用户展开时加载；刷新只作废这一个项目（T-16）。
 */
import { useMemo } from 'react';
import type { ProjectSummary } from '../client/client-api.ts';
import type { ResourceNodeState } from '../state/types.ts';
import { useDocumentActions } from '../state/DocumentActionsContext.tsx';
import { useWorkspace } from '../state/WorkspaceContext.tsx';
import { activationIdentityOf } from '../state/tree-commands.ts';
import { AddProjectEntry } from './AddProjectEntry.tsx';
import { InlineCreateSlot } from './InlineCreateRow.tsx';
import { RemoveProjectEntry } from './RemoveProjectEntry.tsx';
import { TreeToolbar } from './TreeToolbar.tsx';
import { useTreeCommands } from './TreeCommandsContext.tsx';
import { LevelStatus, TreeBranch } from './TreeBranch.tsx';
import { TreeRow } from './FileTreeRow.tsx';
import { countLoadedEntries, emptyLevels, materializeTree } from './tree-model.ts';

/** 单个项目根：depth 0 的一个树行 + 它自己的子层。 */
function ProjectRoot({
  project,
  last,
  open,
  onToggle,
}: {
  project: ProjectSummary;
  last: boolean;
  open: boolean;
  onToggle(): void;
}) {
  const { state } = useWorkspace();
  const actions = useDocumentActions();
  const commands = useTreeCommands();
  const projectId = project.projectId;
  const active = state.activeProjectId === projectId;
  const ready = project.status === 'READY';
  const loading = state.loadingByProject[projectId] ?? false;

  /**
   * 行内显示名编辑（UX-02B-04A → UX-02C-05 上提）。
   *
   * 状态现在由命令编排持有，因此**右键菜单、铅笔按钮、双击项目根名称**三个入口
   * 打开的是同一份编辑会话、同一条 `renameProject` 业务链路。
   * 编辑器渲染在项目根行下方、缩进对齐名称列，而不是塞进标题按钮里：
   * `<button>` 内嵌 `<input>` 是无效 HTML。
   */
  const renaming = commands.projectRename?.projectId === projectId ? commands.projectRename : null;

  const levels = state.treeByProject[projectId] ?? emptyLevels();
  const nodes = useMemo(() => materializeTree(levels), [levels]);
  const rootLevel = levels[''];
  /**
   * 项目根行也要能标注（UX-02C-04）：根不是磁盘条目，它的标注来自根层的
   * `projectMeta`（用项目身份关联），因此这里把它当成普通节点字段传下去。
   */
  const rootMeta = rootLevel?.projectMeta;
  const rootNode: ResourceNodeState = {
    id: `project:${projectId}`,
    name: project.name,
    kind: 'folder',
    ...(rootMeta ? { meta: rootMeta } : {}),
  };
  /** 根的右键 / 焦点 / 双击共用同一个目标（UX-02C-05）。 */
  const rootTarget = {
    origin: 'project-root' as const,
    projectId,
    ...(rootMeta ? { nodeMeta: rootMeta } : {}),
    ...(rootLevel?.projectAnchor ? { nodeAnchor: rootLevel.projectAnchor } : {}),
  };

  return (
    <TreeRow
      node={rootNode}
      depth={0}
      last={last}
      trails={[]}
      expanded={open}
      selected={active}
      rowClassName="tree__row--with-rename"
      onContextMenu={(event) => commands.openContextMenu(event, rootTarget)}
      onFocus={(event) => commands.noteFocus(rootTarget, event.currentTarget)}
      // 双击项目根名称：只改**显示名称**，不改磁盘目录名，也不改标注名
      onRenameRequest={() => commands.beginProjectRename(projectId)}
      // 身份锚 = 根令牌（projectAnchor）：项目根被替换后旧点击不得继续
      activationIdentity={activationIdentityOf({
        workspaceKey: state.workspaceKey,
        projectId,
        path: '',
        anchor: rootLevel?.projectAnchor ?? null,
      })}
      onActivate={() => {
        // 切换当前项目只改焦点：不清标签、不动草稿、不影响其它项目（G2-05/G2-07）
        if (!active) void actions.switchProject(projectId);
        commands.noteSelection(projectId, 'folder', '');
        onToggle();
      }}
      actions={
        <>
          <span
            className={ready ? 'project__state' : 'project__state project__state--unavailable'}
            title={ready ? '可用' : `不可用${project.reason ? `：${project.reason}` : ''}`}
          >
            {loading ? '…' : ready ? '可用' : '不可用'}
          </span>
          {ready && (
            <button
              type="button"
              className="icon-button project__refresh"
              title={`刷新 ${project.name} 的文件树`}
              onClick={() => void actions.reloadResources(projectId)}
            >
              ↻
            </button>
          )}
          <button
            type="button"
            className="icon-button project__refresh project__rename"
            title={`修改「${project.name}」的显示名称`}
            aria-label={`修改「${project.name}」的显示名称`}
            onClick={renaming ? commands.cancelProjectRename : () => commands.beginProjectRename(projectId)}
          >
            {renaming ? '×' : '✎'}
          </button>
          <RemoveProjectEntry project={project} />
        </>
      }
    >
      {renaming && (
        <div className="tree__rename">
          <input
            className={renaming.error ? 'tree__rename-input tree__rename-input--invalid' : 'tree__rename-input'}
            value={renaming.draft}
            // 打开即聚焦：重命名是"点一下就开始打字"的动作
            autoFocus
            disabled={renaming.saving}
            aria-label="项目显示名称"
            aria-invalid={renaming.error !== null}
            maxLength={80}
            onChange={(event) => commands.setProjectRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void commands.submitProjectRename();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                commands.cancelProjectRename();
              }
            }}
          />
          <button
            type="button"
            className="icon-button project__refresh"
            title="保存名称（Enter）"
            aria-label="保存名称"
            disabled={renaming.saving}
            onClick={() => void commands.submitProjectRename()}
          >
            ✓
          </button>
          <button
            type="button"
            className="icon-button project__refresh"
            title="放弃修改（Esc）"
            aria-label="放弃修改"
            disabled={renaming.saving}
            onClick={commands.cancelProjectRename}
          >
            ×
          </button>
          <p className="tree__rename-hint">
            {renaming.error ?? (renaming.saving ? '正在保存…' : '只改显示名称：磁盘目录名、文件树与草稿都不变')}
          </p>
        </div>
      )}
      {open && (
        <>
          {!ready && (
            <p className="project__reason">
              根目录不可用{project.reason ? `（${project.reason}）` : ''} · 无法打开新的磁盘文件；已打开的标签与草稿仍保留
            </p>
          )}
          {ready && (
            <ul className="tree__children">
              <TreeBranch
                projectKey={projectId}
                projectId={projectId}
                nodes={nodes}
                levels={levels}
                depth={1}
                trails={[]}
                isDemo={false}
              />
              <InlineCreateSlot projectId={projectId} parentDir="" depth={1} />
              <LevelStatus
                level={rootLevel}
                depth={1}
                isDemo={false}
                onRetry={() => void actions.loadTreeLevel(projectId, '', false)}
                onMore={() => void actions.loadTreeLevel(projectId, '', true)}
              />
              <li className="tree__status tree__status--count" style={{ paddingLeft: '44px' }}>
                已加载 {countLoadedEntries(levels)} 个条目{active ? ' · 当前项目' : ''}
              </li>
            </ul>
          )}
        </>
      )}
    </TreeRow>
  );
}

export function ProjectList() {
  const { state, dispatch } = useWorkspace();
  const commands = useTreeCommands();
  // 项目根展开态由命令编排统一持有（UX-02C-01-R1）：右键折叠的项目根开始创建时，
  // "打开根"与"挂上输入行"在同一次渲染里完成，输入框立刻可见并聚焦。

  if (state.treeCollapsed) {
    return (
      <aside className="tree tree--collapsed" aria-label="项目列表（已折叠）">
        <button
          type="button"
          className="tree__expand"
          onClick={() => dispatch({ type: 'TOGGLE_TREE' })}
          title="展开项目列表"
        >
          »
        </button>
        <span className="tree__collapsed-label">项目</span>
      </aside>
    );
  }

  const ready = state.projects.filter((project) => project.status === 'READY').length;

  return (
    <aside className="tree" aria-label="项目列表">
      <header className="tree__header">
        <div>
          <div className="tree__project">项目</div>
          <div className="tree__meta">
            {state.projects.length === 0
              ? '正在读取项目…'
              : `${state.projects.length} 个项目 · ${ready} 个可用`}
          </div>
        </div>
        <div className="tree__actions">
          <TreeToolbar />
          <AddProjectEntry />
          <button
            type="button"
            className="icon-button"
            onClick={() => dispatch({ type: 'TOGGLE_TREE' })}
            title="折叠项目列表"
          >
            «
          </button>
        </div>
      </header>

      <ul
        className="tree__root"
        onContextMenu={(event) =>
          commands.openContextMenu(event, { origin: 'blank', projectId: state.activeProjectId })
        }
        // 键盘只在树范围内生效：焦点在编辑器/输入框时事件根本不会到这里
        onKeyDown={commands.onTreeKeyDown}
      >
        {state.projects.map((project, index) => (
          <ProjectRoot
            key={project.projectId}
            project={project}
            last={index === state.projects.length - 1}
            open={commands.isRootOpen(project.projectId)}
            onToggle={() => commands.toggleRoot(project.projectId)}
          />
        ))}
      </ul>

      {state.projects.length === 0 && (
        <p className="tree__empty">
          工作区里还没有项目。点右上角的「添加项目」，选择一个本机文件夹作为项目根。
        </p>
      )}

      <footer className="tree__footer">真实文件 · 独立授权 · 逐层加载</footer>
    </aside>
  );
}
