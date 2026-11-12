import { DEMO_CONTENTS, DEMO_PROJECT_NAME, DEMO_TREE } from '../data/demo-project';
import type { DemoNode } from '../data/demo-project';
import { useWorkspace } from '../state/WorkspaceContext';

function FileRow({ node, depth }: { node: DemoNode; depth: number }) {
  const { state, dispatch } = useWorkspace();
  const selected = state.selectedPath === node.id;
  const activeDoc = state.tabs.some((tab) => tab.docId === node.id);

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
        onClick={() =>
          dispatch({
            type: 'OPEN_FILE',
            docId: node.id,
            path: node.name,
            title: node.name,
            kind: node.kind === 'markdown' ? 'markdown' : 'text',
            content: DEMO_CONTENTS[node.id] ?? '',
          })
        }
      >
        <span className="tree__glyph" aria-hidden="true">
          ¶
        </span>
        <span className="tree__name">{node.name}</span>
        {activeDoc && <span className="tree__dot" title="已在标签中打开" />}
      </button>
    </li>
  );
}

function FolderRow({ node, depth }: { node: DemoNode; depth: number }) {
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

/** 项目文件树：数据来自内置演示结构，不含真实文件访问。 */
export function ProjectTree() {
  const { state, dispatch } = useWorkspace();
  const expandedFolders = Object.values(state.expanded).filter(Boolean).length;

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
          <div className="tree__project">{DEMO_PROJECT_NAME}</div>
          <div className="tree__meta">
            {DEMO_TREE.length} 个分组 · {expandedFolders} 个已展开
          </div>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => dispatch({ type: 'TOGGLE_TREE' })}
          title="折叠项目树"
        >
          «
        </button>
      </header>

      <ul className="tree__root">
        {DEMO_TREE.map((node) =>
          node.kind === 'folder' ? (
            <FolderRow key={node.id} node={node} depth={0} />
          ) : (
            <FileRow key={node.id} node={node} depth={0} />
          ),
        )}
      </ul>

      <footer className="tree__footer">演示数据 · 与真实磁盘无关</footer>
    </aside>
  );
}
