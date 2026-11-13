import { DEMO_NODES, DEMO_PROJECT_NAME } from '../data/demo-project';
import { useDocumentActions } from '../state/DocumentActionsContext';
import { useQuickFile } from '../state/QuickFileContext';
import { useWorkspace } from '../state/WorkspaceContext';
import type { ResourceNodeState } from '../state/types';

/** 文件行：点击后由动作层决定「演示读取」还是「经 Core 打开」。 */
function FileRow({ node, depth }: { node: ResourceNodeState; depth: number }) {
  const { state } = useWorkspace();
  const actions = useDocumentActions();
  const quick = useQuickFile();
  const docId = node.path ?? node.id;
  const selected = state.selectedPath === docId;
  const activeDoc = state.tabs.some((tab) => tab.docId === docId);
  const liveOpen = state.tabs.find((tab) => tab.docId === docId)?.mode === 'live';

  return (
    <li>
      <button
        type="button"
        className={[
          'tree__row',
          'tree__row--file',
          selected ? 'tree__row--selected' : '',
          activeDoc ? 'tree__row--open' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={() => {
          // 打开项目文件即离开 Quick File 预览（Quick File 本身不被清除）
          quick.deactivate();
          void actions.openNode(node);
        }}
      >
        <span className="tree__glyph" aria-hidden="true">
          ¶
        </span>
        <span className="tree__name">{node.name}</span>
        {activeDoc && (
          <span className="tree__dot" title={liveOpen ? '已打开（真实文件）' : '已在标签中打开'} />
        )}
      </button>
    </li>
  );
}

function FolderRow({ node, depth }: { node: ResourceNodeState; depth: number }) {
  const { state, dispatch } = useWorkspace();
  const expanded = state.expanded[node.id] ?? false;

  return (
    <li>
      <button
        type="button"
        className="tree__row tree__row--folder"
        style={{ paddingLeft: 8 + depth * 14 }}
        aria-expanded={expanded}
        onClick={() => dispatch({ type: 'TOGGLE_NODE', path: node.id })}
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
              <FolderRow key={child.id} node={child} depth={depth + 1} />
            ) : (
              <FileRow key={child.id} node={child} depth={depth + 1} />
            ),
          )}
        </ul>
      )}
    </li>
  );
}

/**
 * 项目文件树：
 * - demo 模式渲染内置演示树（不接触磁盘）；
 * - live 模式渲染服务端返回的授权资源树（只包含 Core 允许的文本文件）。
 */
export function ProjectTree() {
  const { state, dispatch } = useWorkspace();
  const actions = useDocumentActions();
  const nodes = state.mode === 'live' ? state.resources : DEMO_NODES;
  const expandedFolders = Object.values(state.expanded).filter(Boolean).length;
  const projectName = state.mode === 'live' ? '本地测试项目' : DEMO_PROJECT_NAME;

  if (state.treeCollapsed) {
    return (
      <aside className="tree tree--collapsed" aria-label="项目树（已折叠）">
        <button
          type="button"
          className="tree__expand"
          onClick={() => dispatch({ type: 'TOGGLE_TREE' })}
          title="展开项目树"
        >
          »
        </button>
        <span className="tree__collapsed-label">项目树</span>
      </aside>
    );
  }

  return (
    <aside className="tree" aria-label="项目树">
      <header className="tree__header">
        <div>
          <div className="tree__project">{projectName}</div>
          <div className="tree__meta">
            {state.loadingResources
              ? '正在加载…'
              : `${nodes.length} 个分组 · ${expandedFolders} 个已展开`}
          </div>
        </div>
        <div className="tree__actions">
          {state.mode === 'live' && (
            <button
              type="button"
              className="icon-button"
              onClick={() => void actions.reloadResources()}
              title="重新读取资源树"
            >
              ↻
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            onClick={() => dispatch({ type: 'TOGGLE_TREE' })}
            title="折叠项目树"
          >
            «
          </button>
        </div>
      </header>

      <ul className="tree__root">
        {nodes.map((node) =>
          node.kind === 'folder' ? (
            <FolderRow key={node.id} node={node} depth={0} />
          ) : (
            <FileRow key={node.id} node={node} depth={0} />
          ),
        )}
      </ul>

      <footer className="tree__footer">
        {state.mode === 'live'
          ? '真实文件 · 仅显示服务端授权的项目范围'
          : '演示数据 · 与真实磁盘无关'}
      </footer>
    </aside>
  );
}
