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
import { useMemo, useState } from 'react';
import type { ProjectSummary } from '../client/client-api.ts';
import type { ResourceNodeState } from '../state/types.ts';
import { useDocumentActions } from '../state/DocumentActionsContext.tsx';
import { useWorkspace } from '../state/WorkspaceContext.tsx';
import { validateProjectName } from '../state/add-project.ts';
import { AddProjectEntry } from './AddProjectEntry.tsx';
import { RemoveProjectEntry } from './RemoveProjectEntry.tsx';
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
  const projectId = project.projectId;
  const active = state.activeProjectId === projectId;
  const ready = project.status === 'READY';
  const loading = state.loadingByProject[projectId] ?? false;

  /**
   * 行内重命名（UX-02B-04A）。
   *
   * 编辑器渲染在项目根行**下方**、缩进对齐名称列，而不是塞进标题按钮里：
   * `<button>` 内嵌 `<input>` 是无效 HTML，点击/聚焦行为在各浏览器上都会走形。
   */
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const startRename = (): void => {
    setDraft(project.name);
    setError(null);
    setRenaming(true);
  };
  const cancelRename = (): void => {
    setRenaming(false);
    setError(null);
    setDraft(project.name);
  };
  const submit = async (): Promise<void> => {
    if (saving) return;
    const checked = validateProjectName(draft);
    // 本地预检只挡"注定失败"的请求；权威判断仍在 Host
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setSaving(true);
    const outcome = await actions.renameProject(projectId, checked.name);
    setSaving(false);
    if (outcome.status === 'APPLIED') {
      setRenaming(false);
      setError(null);
      return;
    }
    // 失败：界面保持原名（未派发任何改名），把输入框留在原处让用户修正
    setError(outcome.message);
  };

  const levels = state.treeByProject[projectId] ?? emptyLevels();
  const nodes = useMemo(() => materializeTree(levels), [levels]);
  const rootLevel = levels[''];
  const rootNode: ResourceNodeState = {
    id: `project:${projectId}`,
    name: project.name,
    kind: 'folder',
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
      onActivate={() => {
        // 切换当前项目只改焦点：不清标签、不动草稿、不影响其它项目（G2-05/G2-07）
        if (!active) void actions.switchProject(projectId);
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
            onClick={renaming ? cancelRename : startRename}
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
            className={error ? 'tree__rename-input tree__rename-input--invalid' : 'tree__rename-input'}
            value={draft}
            // 打开即聚焦：重命名是"点一下就开始打字"的动作
            autoFocus
            disabled={saving}
            aria-label="项目显示名称"
            aria-invalid={error !== null}
            maxLength={80}
            onChange={(event) => {
              setDraft(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelRename();
              }
            }}
          />
          <button
            type="button"
            className="icon-button project__refresh"
            title="保存名称（Enter）"
            aria-label="保存名称"
            disabled={saving}
            onClick={() => void submit()}
          >
            ✓
          </button>
          <button
            type="button"
            className="icon-button project__refresh"
            title="放弃修改（Esc）"
            aria-label="放弃修改"
            disabled={saving}
            onClick={cancelRename}
          >
            ×
          </button>
          <p className="tree__rename-hint">
            {error ?? (saving ? '正在保存…' : '只改显示名称：磁盘目录名、文件树与草稿都不变')}
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
  // 各项目根独立展开；刷新只作废该项目的层表，不重置这里的展开状态
  const [openRoots, setOpenRoots] = useState<Record<string, boolean>>({});
  const toggleRoot = (projectId: string): void =>
    setOpenRoots((current) => ({ ...current, [projectId]: !(current[projectId] ?? true) }));

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

      <ul className="tree__root">
        {state.projects.map((project, index) => (
          <ProjectRoot
            key={project.projectId}
            project={project}
            last={index === state.projects.length - 1}
            open={openRoots[project.projectId] ?? true}
            onToggle={() => toggleRoot(project.projectId)}
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
