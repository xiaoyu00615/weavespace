/**
 * UX-02B-TREE：Demo / Legacy / Multi **共用**的树分支渲染器（契约 C.2）。
 *
 * 以前 `ProjectTree.tsx`（单根）与 `ProjectList.tsx`（多根）各写了一份递归渲染，
 * 结果项目根行一个走 `TreeRow`、一个自绘卡片，缩进/箭头/图标必然走形。
 * 这里把它们收敛成同一条路径：根行与子行都是 `TreeRow`，层级只由 `depth` 驱动。
 *
 * 数据来自 `tree-model.ts` 的层表：
 * - 展开目录时才加载该层（不递归扫描整个项目）；
 * - 层状态（加载中 / 空 / 不可读 / 失败 / 还有下一页）在行内明确呈现；
 * - 链接显示为叶子，点击只给提示，绝不发起打开或展开。
 */
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import type { ResourceNodeState } from '../state/types.ts';
import { useDocumentActions } from '../state/DocumentActionsContext.tsx';
import { useQuickFile } from '../state/QuickFileContext.tsx';
import { useWorkspace } from '../state/WorkspaceContext.tsx';
import { makeDocId } from '../state/doc-identity.ts';
import { useCapabilities } from '../capabilities/CapabilityContext.tsx';
import { LinkGlyph, TreeRow } from './FileTreeRow.tsx';
import { descend, type TreeTrails } from './tree-trails';
import { normalizeDir, type TreeLevelState, type TreeLevels } from './tree-model.ts';

export interface TreeBranchProps {
  /** 层表键：`''` = Demo/Legacy 单根；否则是 projectId。 */
  projectKey: string;
  /** 打开文件时用的项目身份；Demo/Legacy 为 null。 */
  projectId: string | null;
  /** 本层节点（由层表物化而来）。 */
  nodes: readonly ResourceNodeState[];
  levels: TreeLevels;
  depth: number;
  trails: TreeTrails;
  /** Demo 数据是静态的，不发起任何网络请求。 */
  isDemo: boolean;
}

/** 状态行缩进：与同层 `TreeRow` 的"箭头列"对齐。 */
function StatusRow({ depth, children }: { depth: number; children: ReactNode }) {
  return (
    <li className="tree__status" style={{ paddingLeft: `${depth * 18 + 26}px` }}>
      {children}
    </li>
  );
}

/**
 * 一层的状态提示（契约 B.6 / B.2.1）。
 *
 * 这四行是"空 / 不可读 / 加载中 / 还有下一页"唯一的呈现位置：
 * 绝不能把 `UNREADABLE` 或 `ERROR` 渲染成"空文件夹"。
 */
export function LevelStatus({
  level,
  depth,
  isDemo,
  onRetry,
  onMore,
}: {
  level: TreeLevelState | undefined;
  depth: number;
  isDemo: boolean;
  onRetry(): void;
  onMore(): void;
}) {
  if (isDemo) return null;
  if (!level || (level.status === 'loading' && level.entries.length === 0)) {
    return <StatusRow depth={depth}>正在加载…</StatusRow>;
  }
  if (level.status === 'loading') {
    return <StatusRow depth={depth}>正在加载更多…</StatusRow>;
  }
  if (level.status === 'error') {
    return (
      <StatusRow depth={depth}>
        <span className="tree__status--error">
          {level.errorCode === 'ERR_DIR_UNREADABLE'
            ? '无法读取此文件夹'
            : level.errorCode === 'ERR_RESOURCE_NOT_FOUND'
              ? '该文件夹已不存在'
              : '加载失败'}
        </span>
        {' · '}
        <button type="button" className="tree__status-action" onClick={onRetry}>
          重试
        </button>
      </StatusRow>
    );
  }
  if (level.status === 'ready' && level.entries.length === 0) {
    return <StatusRow depth={depth}>空文件夹</StatusRow>;
  }
  if (level.status === 'ready' && level.nextCursor !== null) {
    return (
      <StatusRow depth={depth}>
        已显示 {level.entries.length} / {level.total} 项 ·{' '}
        <button type="button" className="tree__status-action" disabled={level.loadingMore} onClick={onMore}>
          继续加载
        </button>
      </StatusRow>
    );
  }
  return null;
}

function TreeItem({
  projectKey,
  projectId,
  node,
  levels,
  depth,
  last,
  trails,
  expandedMap,
  isDemo,
}: TreeBranchProps & {
  node: ResourceNodeState;
  last: boolean;
  expandedMap: Readonly<Record<string, boolean>>;
}) {
  const { state, dispatch } = useWorkspace();
  const actions = useDocumentActions();
  const quick = useQuickFile();
  const { ready, resolveViewer } = useCapabilities();
  const childTrails = descend(trails, last);
  const expanded = expandedMap[node.id] ?? false;

  /**
   * 已经处于展开态的目录（首次加载时的一级目录、恢复出来的展开状态、
   * 或刷新作废层表之后）必须把它的子层取回来；否则用户会看到"展开但一直正在加载"。
   * 失败态刻意**不**自动重试：那会造成"失败→重试→失败"的无限循环，重试由用户点按钮触发。
   */
  useEffect(() => {
    if (isDemo || !expanded || node.kind !== 'folder') return;
    const dir = normalizeDir(node.path ?? node.name);
    const level = levels[dir];
    if (!level || level.status === 'idle') void actions.loadTreeLevel(projectId, dir, false);
  }, [expanded, isDemo, node.kind, node.path, node.name, levels, projectId, actions]);

  const toggle = (): void => {
    if (projectKey === '') dispatch({ type: 'TOGGLE_NODE', path: node.id });
    else dispatch({ type: 'TOGGLE_PROJECT_NODE', projectId: projectKey, path: node.id });
  };

  if (node.kind === 'folder') {
    const dir = normalizeDir(node.path ?? node.name);
    const level = levels[dir];
    return (
      <TreeRow
        node={node}
        depth={depth}
        last={last}
        trails={trails}
        expanded={expanded}
        onActivate={() => {
          const willExpand = !expanded;
          toggle();
          // 只在首次展开（或失败后重试）时取该层；已缓存的层不重复请求（T-17）
          if (willExpand && !isDemo && (!level || level.status === 'idle' || level.status === 'error')) {
            void actions.loadTreeLevel(projectId, dir, false);
          }
        }}
      >
        {expanded && (
          <ul className="tree__children">
            {node.children && node.children.length > 0 && (
              <TreeBranch
                projectKey={projectKey}
                projectId={projectId}
                nodes={node.children}
                levels={levels}
                depth={depth + 1}
                trails={childTrails}
                isDemo={isDemo}
              />
            )}
            <LevelStatus
              level={level}
              depth={depth}
              isDemo={isDemo}
              onRetry={() => void actions.loadTreeLevel(projectId, dir, false)}
              onMore={() => void actions.loadTreeLevel(projectId, dir, true)}
            />
          </ul>
        )}
      </TreeRow>
    );
  }

  if (node.kind === 'link') {
    return (
      <TreeRow
        node={node}
        depth={depth}
        last={last}
        trails={trails}
        onActivate={() =>
          dispatch({ type: 'NOTICE', message: `「${node.name}」是链接，不展开也不打开（避免越过项目根）` })
        }
      />
    );
  }

  const docId = projectId
    ? makeDocId(projectId, node.path ?? node.id)
    : (node.path ?? node.id);
  const selected =
    projectKey === '' ? state.selectedPath === docId : state.selectedByProject[projectKey] === docId;
  const tab = state.tabs.find((item) => item.docId === docId);

  return (
    <TreeRow
      node={node}
      depth={depth}
      last={last}
      trails={trails}
      selected={selected}
      opened={Boolean(tab)}
      dirty={tab?.dirty ?? false}
      onActivate={() => {
        // 契约 B.1：不支持预览的文件仍是普通文件节点，但点击**不得**进入文本编辑器。
        // 能力注册表就绪时先问一次；未就绪时沿用既有打开链路，避免启动瞬间全部被挡。
        if (ready && !resolveViewer(node.extension ?? '').ok) {
          dispatch({
            type: 'NOTICE',
            message: `「${node.name}」此类型暂不支持预览或编辑，仍可在文件树中查看`,
          });
          return;
        }
        quick.deactivate();
        void actions.openNode(node, projectId);
      }}
    />
  );
}

/**
 * 一层的兄弟节点列表。
 *
 * `depth` 1 = 项目根的直接子项；`last` 让同层最后一项的引导线收尾；
 * `trails` 记录各祖先层是否还有后续兄弟（见 `tree-trails.ts`）。
 */
export function TreeBranch(props: TreeBranchProps) {
  const { state } = useWorkspace();
  const { nodes, depth, trails, projectKey } = props;
  const expandedMap =
    projectKey === '' ? state.expanded : (state.expandedByProject[projectKey] ?? {});
  return (
    <>
      {nodes.map((node, index) => (
        <TreeItem
          key={`${projectKey}:${node.id}`}
          {...props}
          node={node}
          last={index === nodes.length - 1}
          trails={trails}
          expandedMap={expandedMap}
          depth={depth}
        />
      ))}
    </>
  );
}

/** 链接图标单独导出，便于其它视图复用同一视觉语言。 */
export { LinkGlyph };
