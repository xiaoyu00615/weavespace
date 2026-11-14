/**
 * 多项目列表（G2-01 / UX-02A）。
 *
 * 结构是一棵**真正的目录树**，不是平铺列表：
 *   第 1 层：项目根（根文件夹图标 + 名称 + 状态）
 *   第 2 层：项目根下的文件与文件夹
 *   第 3 层及以后：按 `ResourceNodeState.children` 递归
 *
 * 多个项目**同时可见**，各自独立展开/折叠/刷新/选中。
 * 单击项目标题 = 切换"当前项目"（只改焦点），不会隐藏其他项目、不会关闭标签。
 *
 * 边界：
 * - UNAVAILABLE 项目不展示文件，只显示原因；已有标签与草稿不受影响；
 * - 不展示 rootDir / canonicalRoot / rootToken —— 服务端也不返回它们；
 * - 刷新只作用于当前项目，不覆盖其他项目的资源树；
 * - 层级完全由数据树的 `children` 与注入的 `depth` 决定，**不解析路径字符串**。
 */
import { useState } from 'react';
import type { ProjectSummary } from '../client/client-api';
import { makeDocId } from '../state/doc-identity';
import { useDocumentActions } from '../state/DocumentActionsContext';
import { useQuickFile } from '../state/QuickFileContext';
import { useWorkspace } from '../state/WorkspaceContext';
import type { ResourceNodeState } from '../state/types';
import { FolderGlyph, TreeRow } from './FileTreeRow';

/**
 * 一层的兄弟节点列表。
 *
 * `depth` 1 = 项目根的直接子项（箭头/图标列右移一级），依次递归；
 * `last` 让同层最后一项的引导线收尾，避免下方拖着一条悬空竖线。
 */
function TreeLevel({
  projectId,
  nodes,
  depth,
}: {
  projectId: string;
  nodes: readonly ResourceNodeState[];
  depth: number;
}) {
  return (
    <ul className="tree__children">
      {nodes.map((node, index) => (
        <TreeItem
          key={`${projectId}:${node.id}`}
          projectId={projectId}
          node={node}
          depth={depth}
          last={index === nodes.length - 1}
        />
      ))}
    </ul>
  );
}

function TreeItem({
  projectId,
  node,
  depth,
  last,
}: {
  projectId: string;
  node: ResourceNodeState;
  depth: number;
  last: boolean;
}) {
  const { state, dispatch } = useWorkspace();
  const actions = useDocumentActions();
  const quick = useQuickFile();

  if (node.kind === 'folder') {
    const expanded = state.expandedByProject[projectId]?.[node.id] ?? false;
    return (
      <TreeRow
        node={node}
        depth={depth}
        last={last}
        expanded={expanded}
        onActivate={() => dispatch({ type: 'TOGGLE_PROJECT_NODE', projectId, path: node.id })}
      >
        {/* 折叠时整棵后代都不渲染：不是靠 CSS 隐藏 */}
        {expanded && node.children && node.children.length > 0 && (
          <TreeLevel projectId={projectId} nodes={node.children} depth={depth + 1} />
        )}
      </TreeRow>
    );
  }

  const docId = makeDocId(projectId, node.path ?? node.id);
  const selected = state.selectedByProject[projectId] === docId;
  const tab = state.tabs.find((item) => item.docId === docId);

  return (
    <TreeRow
      node={node}
      depth={depth}
      last={last}
      selected={selected}
      opened={Boolean(tab)}
      dirty={tab?.dirty ?? false}
      onActivate={() => {
        // 打开项目文件即离开 Quick File 预览（Quick File 本身不被清除）
        quick.deactivate();
        void actions.openNode(node, projectId);
      }}
    />
  );
}

function ProjectSection({ project }: { project: ProjectSummary }) {
  const { state } = useWorkspace();
  const actions = useDocumentActions();
  // 项目根的展开是纯 UI 状态：各项目独立，互不影响；刷新不会重置它
  const [open, setOpen] = useState(true);
  const active = state.activeProjectId === project.projectId;
  const ready = project.status === 'READY';
  const nodes = state.resourcesByProject[project.projectId] ?? [];
  const loading = state.loadingByProject[project.projectId] ?? false;
  const fileCount = countFiles(nodes);

  return (
    <li className={active ? 'project project--active' : 'project'}>
      {/* 第 1 层：项目根。箭头 / 图标 / 名称与其他层级严格对齐 */}
      <div className="project__root">
        <button
          type="button"
          className="project__caret"
          aria-expanded={open}
          aria-label={open ? `折叠 ${project.name}` : `展开 ${project.name}`}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? '▾' : '▸'}
        </button>
        <span className="tree__icon-slot" aria-hidden="true">
          <FolderGlyph open={open} />
        </span>
        <button
          type="button"
          className="project__title"
          onClick={() => void actions.switchProject(project.projectId)}
          title={`${project.name}${active ? '（当前项目）' : '（点击切换为当前项目）'}`}
        >
          {project.name}
        </button>
        <span
          className={ready ? 'project__state' : 'project__state project__state--unavailable'}
          title={ready ? '可用' : `不可用${project.reason ? `：${project.reason}` : ''}`}
        >
          {ready ? '可用' : '不可用'}
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
            <TreeLevel projectId={project.projectId} nodes={nodes} depth={1} />
          )}
          <p className="project__meta">
            {ready ? `${fileCount} 个文件` : '磁盘访问已被拒绝'}
            {active && ' · 当前项目'}
          </p>
        </>
      )}
    </li>
  );
}

function countFiles(nodes: readonly ResourceNodeState[]): number {
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
