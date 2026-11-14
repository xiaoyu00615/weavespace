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
        </>
      }
    >
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

      <footer className="tree__footer">真实文件 · 独立授权 · 逐层加载</footer>
    </aside>
  );
}
