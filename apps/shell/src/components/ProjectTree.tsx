/**
 * 项目文件树（Legacy / Demo，UX-02A）。
 *
 * 与 Multi 的 `ProjectList` 共用同一套行组件（`FileTreeRow`）：
 * 第 1 层是项目根本身，第 2 层起是它的文件与文件夹，之后按 `children` 递归。
 * 这样 Demo / Legacy / Multi 三种状态的层级、缩进与图标完全一致。
 *
 * - demo 模式渲染内置演示树（不接触磁盘）；
 * - live 模式渲染服务端返回的授权资源树（只包含 Core 允许的文本文件）。
 */
import { useState } from 'react';
import { DEMO_NODES, DEMO_PROJECT_NAME } from '../data/demo-project';
import { useDocumentActions } from '../state/DocumentActionsContext';
import { useQuickFile } from '../state/QuickFileContext';
import { useWorkspace } from '../state/WorkspaceContext';
import type { ResourceNodeState } from '../state/types';
import { TreeRow } from './FileTreeRow';

/** 文件行：点击后由动作层决定「演示读取」还是「经 Core 打开」。 */
function FileItem({ node, depth, last }: { node: ResourceNodeState; depth: number; last: boolean }) {
  const { state } = useWorkspace();
  const actions = useDocumentActions();
  const quick = useQuickFile();
  const docId = node.path ?? node.id;
  const selected = state.selectedPath === docId;
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
        void actions.openNode(node);
      }}
    />
  );
}

function FolderItem({ node, depth, last }: { node: ResourceNodeState; depth: number; last: boolean }) {
  const { state, dispatch } = useWorkspace();
  const expanded = state.expanded[node.id] ?? false;

  return (
    <TreeRow
      node={node}
      depth={depth}
      last={last}
      expanded={expanded}
      onActivate={() => dispatch({ type: 'TOGGLE_NODE', path: node.id })}
    >
      {/* 折叠时后代整棵不渲染 */}
      {expanded && node.children && node.children.length > 0 && (
        <TreeLevel nodes={node.children} depth={depth + 1} />
      )}
    </TreeRow>
  );
}

function TreeLevel({ nodes, depth }: { nodes: readonly ResourceNodeState[]; depth: number }) {
  return (
    <ul className="tree__children">
      {nodes.map((node, index) =>
        node.kind === 'folder' ? (
          <FolderItem key={node.id} node={node} depth={depth} last={index === nodes.length - 1} />
        ) : (
          <FileItem key={node.id} node={node} depth={depth} last={index === nodes.length - 1} />
        ),
      )}
    </ul>
  );
}

export function ProjectTree() {
  const { state, dispatch } = useWorkspace();
  const actions = useDocumentActions();
  const nodes = state.mode === 'live' ? state.resources : DEMO_NODES;
  const expandedFolders = Object.values(state.expanded).filter(Boolean).length;
  const projectName = state.mode === 'live' ? '本地测试项目' : DEMO_PROJECT_NAME;
  // 项目根的展开是纯 UI 状态；刷新文件树不会重置它
  const [rootOpen, setRootOpen] = useState(true);

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

  /** 项目根在第 1 层：它自己也走同一套行组件，缩进与图标才不会错位。 */
  const rootNode: ResourceNodeState = { id: '__project_root__', name: projectName, kind: 'folder' };

  return (
    <aside className="tree" aria-label="项目树">
      <header className="tree__header">
        <div>
          <div className="tree__project">项目树</div>
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
        <TreeRow node={rootNode} depth={0} last expanded={rootOpen} onActivate={() => setRootOpen((v) => !v)}>
          {rootOpen && nodes.length > 0 && <TreeLevel nodes={nodes} depth={1} />}
        </TreeRow>
      </ul>

      <footer className="tree__footer">
        {state.mode === 'live'
          ? '真实文件 · 仅显示服务端授权的项目范围'
          : '演示数据 · 与真实磁盘无关'}
      </footer>
    </aside>
  );
}
