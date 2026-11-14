/**
 * 单根项目树（Demo / Legacy，UX-02A → UX-02B-TREE）。
 *
 * 与 Multi 的 `ProjectList` **共用** `TreeBranch` + `TreeRow`：
 * 项目根就是 `depth 0` 的一个树行，子层从 `depth 1` 起，缩进/引导线/箭头/图标
 * 全部由同一套原语决定。数据来源不同（demo 静态 / live 逐层），渲染路径完全相同。
 *
 * - demo：把内置演示树拆成层表（不接触网络、不接触磁盘）；
 * - live：从 `treeByProject['']` 读取真实文件层，展开时才请求子层。
 */
import { useMemo, useState } from 'react';
import { DEMO_NODES, DEMO_PROJECT_NAME } from '../data/demo-project';
import type { ResourceNodeState } from '../state/types.ts';
import { useDocumentActions } from '../state/DocumentActionsContext.tsx';
import { useWorkspace } from '../state/WorkspaceContext.tsx';
import { LevelStatus, TreeBranch } from './TreeBranch.tsx';
import { TreeRow } from './FileTreeRow.tsx';
import { countLoadedEntries, emptyLevels, fromStaticTree, materializeTree } from './tree-model.ts';

const LEGACY_PROJECT_NAME = '本地测试项目';

export function ProjectTree() {
  const { state, dispatch } = useWorkspace();
  const actions = useDocumentActions();
  const isDemo = state.mode === 'demo';
  // 项目根的展开是纯 UI 状态；刷新文件树不会重置它
  const [rootOpen, setRootOpen] = useState(true);

  const levels = useMemo(
    () => (isDemo ? fromStaticTree(DEMO_NODES) : (state.treeByProject[''] ?? emptyLevels())),
    [isDemo, state.treeByProject],
  );
  const nodes = useMemo(() => materializeTree(levels), [levels]);
  const rootLevel = levels[''];
  const rootNode: ResourceNodeState = {
    id: '__project_root__',
    name: isDemo ? DEMO_PROJECT_NAME : LEGACY_PROJECT_NAME,
    kind: 'folder',
  };

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
          <div className="tree__project">项目树</div>
          <div className="tree__meta">
            {state.loadingResources
              ? '正在加载…'
              : `${countLoadedEntries(levels)} 个已加载条目${rootLevel?.nextCursor ? ' · 还有更多' : ''}`}
          </div>
        </div>
        <div className="tree__actions">
          {!isDemo && (
            <button
              type="button"
              className="icon-button"
              onClick={() => void actions.reloadResources()}
              title="重新读取项目根目录"
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
        <TreeRow
          node={rootNode}
          depth={0}
          last
          trails={[]}
          expanded={rootOpen}
          onActivate={() => setRootOpen((value) => !value)}
        >
          {rootOpen && (
            <ul className="tree__children">
              <TreeBranch
                projectKey=""
                projectId={null}
                nodes={nodes}
                levels={levels}
                depth={1}
                trails={[]}
                isDemo={isDemo}
              />
              <LevelStatus
                level={rootLevel}
                depth={1}
                isDemo={isDemo}
                onRetry={() => void actions.loadTreeLevel(null, '', false)}
                onMore={() => void actions.loadTreeLevel(null, '', true)}
              />
            </ul>
          )}
        </TreeRow>
      </ul>

      <footer className="tree__footer">
        {isDemo ? '演示数据 · 与真实磁盘无关' : '真实文件 · 逐层加载 · 仅相对路径'}
      </footer>
    </aside>
  );
}
