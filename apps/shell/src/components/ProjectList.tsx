import { useState } from 'react';
import type { ProjectSummary } from '../client/client-api';
import { makeDocId } from '../state/doc-identity';
import { useDocumentActions } from '../state/DocumentActionsContext';
import { useWorkspace } from '../state/WorkspaceContext';
import type { ResourceNodeState } from '../state/types';

/**
 * 多项目列表（G2-01）。
 *
 * 结构：项目 → 文件树，多个项目**同时可见**，各自独立展开/折叠/刷新/选中。
 * 单击项目标题切换"当前项目"（只改焦点），不会隐藏其他项目、不会关闭标签。
 *
 * 边界：
 * - UNAVAILABLE 项目不展示文件，只显示原因；已有标签与草稿不受影响；
 * - 不展示 rootDir / canonicalRoot / rootToken —— 服务端也不返回它们；
 * - 刷新只作用于当前项目，不覆盖其他项目的资源树。
 */

function FolderNode({
  projectId,
  node,
  depth,
}: {
  projectId: string;
  node: ResourceNodeState;
  depth: number;
}) {
  const { state, dispatch } = useWorkspace();
  const expanded = state.expandedByProject[projectId]?.[node.id] ?? false;

  return (
    <li>
      <button
        type="button"
        className="tree__row tree__row--folder"
        style={{ paddingLeft: 8 + depth * 14 }}
        aria-expanded={expanded}
        onClick={() => dispatch({ type: 'TOGGLE_PROJECT_NODE', projectId, path: node.id })}
      >
        <span className="tree__caret" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span className="tree__name">{node.name}</span>
        <span className="tree__count">{node.children?.length ?? 0}</span>
      </button>
      {expanded && node.children && (
        <ul className="tree__children">
          {node.children.map((child) =>
            child.kind === 'folder' ? (
              <FolderNode key={`${projectId}:${child.id}`} projectId={projectId} node={child} depth={depth + 1} />
            ) : (
              <FileNode key={`${projectId}:${child.id}`} projectId={projectId} node={child} depth={depth + 1} />
            ),
          )}
        </ul>
      )}
    </li>
  );
}

function FileNode({
  projectId,
  node,
  depth,
}: {
  projectId: string;
  node: ResourceNodeState;
  depth: number;
}) {
  const { state } = useWorkspace();
  const actions = useDocumentActions();
  const docId = makeDocId(projectId, node.path ?? node.id);
  const selected = state.selectedByProject[projectId] === docId;
  const tab = state.tabs.find((item) => item.docId === docId);

  return (
    <li>
      <button
        type="button"
        className={[
          'tree__row',
          'tree__row--file',
          selected ? 'tree__row--selected' : '',
          tab ? 'tree__row--open' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={() => void actions.openNode(node, projectId)}
      >
        <span className="tree__glyph" aria-hidden="true">
          ¶
        </span>
        <span className="tree__name">{node.name}</span>
        {tab && <span className="tree__dot" title={tab.dirty ? '已打开（有未保存修改）' : '已在标签中打开'} />}
      </button>
    </li>
  );
}

function ProjectSection({ project }: { project: ProjectSummary }) {
  const { state } = useWorkspace();
  const actions = useDocumentActions();
  // 分区展开是纯 UI 状态：各项目独立，互不影响（不持久化）
  const [open, setOpen] = useState(true);
  const active = state.activeProjectId === project.projectId;
  const ready = project.status === 'READY';
  const nodes = state.resourcesByProject[project.projectId] ?? [];
  const loading = state.loadingByProject[project.projectId] ?? false;
  const fileCount = countFiles(nodes);

  return (
    <li className={active ? 'project project--active' : 'project'}>
      <div className="project__header">
        <button
          type="button"
          className="project__caret"
          aria-expanded={open}
          aria-label={open ? `折叠 ${project.name}` : `展开 ${project.name}`}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? '▾' : '▸'}
        </button>
        <button
          type="button"
          className="project__title"
          onClick={() => void actions.switchProject(project.projectId)}
          title={active ? '当前项目' : '切换为当前项目'}
        >
          {project.name}
        </button>
        <span
          className={ready ? 'project__badge project__badge--ready' : 'project__badge project__badge--unavailable'}
          title={ready ? '可用' : `不可用${project.reason ? `：${project.reason}` : ''}`}
        >
          {ready ? 'READY' : 'UNAVAILABLE'}
        </span>
        {ready && (
          <button
            type="button"
            className="icon-button project__refresh"
            title={`刷新 ${project.name} 的文件树`}
            onClick={() => void actions.reloadResources(project.projectId)}
          >
            ↻
          </button>
        )}
      </div>

      {open && (
        <>
          {!ready && (
            <p className="project__reason">
              根目录不可用{project.reason ? `（${project.reason}）` : ''} · 无法打开新的磁盘文件；已打开的标签与草稿仍保留
            </p>
          )}
          {ready && loading && <p className="project__meta">正在加载…</p>}
          {ready && !loading && nodes.length === 0 && (
            <p className="project__meta">该项目下没有可编辑的文本文件</p>
          )}
          {ready && nodes.length > 0 && (
            <ul className="tree__root">
              {nodes.map((node) =>
                node.kind === 'folder' ? (
                  <FolderNode
                    key={`${project.projectId}:${node.id}`}
                    projectId={project.projectId}
                    node={node}
                    depth={0}
                  />
                ) : (
                  <FileNode
                    key={`${project.projectId}:${node.id}`}
                    projectId={project.projectId}
                    node={node}
                    depth={0}
                  />
                ),
              )}
            </ul>
          )}
          <div className="project__meta">
            {ready ? `${fileCount} 个文件` : '磁盘访问已被拒绝'}
            {active && ' · 当前项目'}
          </div>
        </>
      )}
    </li>
  );
}

function countFiles(nodes: ResourceNodeState[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.kind === 'folder') total += countFiles(node.children ?? []);
    else total += 1;
  }
  return total;
}

export function ProjectList() {
  const { state, dispatch } = useWorkspace();

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

      <ul className="projects">
        {state.projects.map((project) => (
          <ProjectSection key={project.projectId} project={project} />
        ))}
      </ul>

      <footer className="tree__footer">
        真实文件 · 每个项目独立授权与独立 Provider
      </footer>
    </aside>
  );
}
