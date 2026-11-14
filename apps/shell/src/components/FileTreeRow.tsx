/**
 * 目录树的共享行组件（S11-UX-02A）。
 *
 * 为什么抽出来：Multi（`ProjectList`）与 Legacy / Demo（`ProjectTree`）要呈现**同一种**
 * 目录层级——同样的缩进步长、引导线、图标列与省略规则。两处各写一份必然逐渐走形，
 * 所以这里只做展示原语（不带任何状态与请求），数据仍由各自组件注入。
 *
 * 约定：
 * - 层级只由 `depth` 决定，**绝不**从文件名或路径字符串里猜层级；
 * - `depth` 0 = 项目根自己，1 = 项目根的直接子项，依次递归；
 * - 每级缩进 18px，引导线落在缩进列的中线（9px）上，与箭头/图标列严格对齐；
 * - 叶子行没有箭头，但保留同宽占位，保证文件名起点一致。
 */
import type { ReactNode } from 'react';
import type { ResourceNodeState } from '../state/types';

/** 每一级的缩进步长（px）。行内计算与 CSS 都必须用这个值。 */
export const TREE_INDENT = 18;

/** 文件夹图标尺寸（px）：与箭头列同宽，避免图标挤压文件名。 */
const ICON_SIZE = 15;

/**
 * 缩进列 + 树状引导线。
 *
 * `last` 决定引导线的收尾方式：同级最后一项只画"上半段竖线 + 横线"（└），
 * 其余画"整段竖线 + 横线"（├），这样最后一项下方不会拖着一条悬空竖线。
 */
export function TreeIndent({ depth, last }: { depth: number; last?: boolean }) {
  if (depth <= 0) return null;
  const guides = [];
  for (let level = 1; level < depth; level += 1) {
    guides.push(<span key={level} className="tree__guide" aria-hidden="true" />);
  }
  return (
    <span className="tree__indent" aria-hidden="true">
      {guides}
      <span className={last ? 'tree__elbow tree__elbow--last' : 'tree__elbow'} />
    </span>
  );
}

/** 展开箭头；叶子行传 `expanded={undefined}`，渲染同宽空占位。 */
export function TreeCaret({ expanded }: { expanded?: boolean }) {
  return (
    <span className="tree__caret" aria-hidden="true">
      {expanded === undefined ? '' : expanded ? '▾' : '▸'}
    </span>
  );
}

/** 文件夹图标：展开/闭合两种形态，用 `currentColor` 跟随主题。 */
export function FolderGlyph({ open }: { open: boolean }) {
  return open ? (
    <svg className="tree__icon" viewBox="0 0 16 16" width={ICON_SIZE} height={ICON_SIZE} aria-hidden="true">
      <path
        d="M1.75 4.25A1.25 1.25 0 0 1 3 3h3.1l1.3 1.6h4.6a1.25 1.25 0 0 1 1.25 1.25v.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M2.1 6.25h11.3a.75.75 0 0 1 .72.95l-1.16 4.7a1.25 1.25 0 0 1-1.22.95H3.2a1.25 1.25 0 0 1-1.25-1.25V6.55a.3.3 0 0 1 .15-.3Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg className="tree__icon" viewBox="0 0 16 16" width={ICON_SIZE} height={ICON_SIZE} aria-hidden="true">
      <path
        d="M1.75 4.1A1.35 1.35 0 0 1 3.1 2.75h3.05l1.3 1.6h5.45A1.35 1.35 0 0 1 14.25 5.7v6.2a1.35 1.35 0 0 1-1.35 1.35H3.1A1.35 1.35 0 0 1 1.75 11.9Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 文件图标：`md` 带一个向下的折角（Markdown 语义），`txt` 用纯文本行，
 * 其余格式统一用通用文档图标。区分只是"扫一眼能分开"，不引入颜色噪音。
 */
export function FileGlyph({ extension }: { extension?: string }) {
  const ext = (extension ?? '').toLowerCase();
  return (
    <svg className="tree__icon" viewBox="0 0 16 16" width={ICON_SIZE} height={ICON_SIZE} aria-hidden="true">
      <path
        d="M3.6 2.4h5.05L11.9 5.6v8A.9.9 0 0 1 11 14.5H3.6a.9.9 0 0 1-.9-.9V3.3a.9.9 0 0 1 .9-.9Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M8.6 2.5v3.2h3.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      {ext === '.md' || ext === '.markdown' ? (
        <path d="M4.9 12.1V9.2l1.25 1.55L7.4 9.2v2.9" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M4.9 9.3h4.2M4.9 11.1h3" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      )}
    </svg>
  );
}

export interface TreeRowProps {
  node: ResourceNodeState;
  depth: number;
  /** 同级最后一项：决定引导线是否收尾。 */
  last: boolean;
  /** 文件夹才是可展开的；文件传 undefined。 */
  expanded?: boolean;
  selected?: boolean;
  /** 已在标签中打开。 */
  opened?: boolean;
  /** 已打开且有未保存修改。 */
  dirty?: boolean;
  onActivate(): void;
  /** 展开后的子层（渲染在同一个 `<li>` 内，保证语义与缩进引导线连续）。 */
  children?: ReactNode;
}

/**
 * 一行：缩进 → 箭头 → 图标 → 名称 →（右对齐的）打开/脏标记。
 *
 * 名称 `flex:1 + min-width:0 + ellipsis`，`title` 给出完整路径名，
 * 因此在 260px 侧栏里长文件名不会把标记挤出可视区。
 */
export function TreeRow({
  node,
  depth,
  last,
  expanded,
  selected,
  opened,
  dirty,
  onActivate,
  children,
}: TreeRowProps) {
  const isFolder = node.kind === 'folder';
  return (
    <li className="tree__item">
      <button
        type="button"
        className={[
          'tree__row',
          isFolder ? 'tree__row--folder' : 'tree__row--file',
          selected ? 'tree__row--selected' : '',
          opened ? 'tree__row--opened' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-expanded={isFolder ? expanded : undefined}
        title={node.name}
        onClick={onActivate}
      >
        <TreeIndent depth={depth} last={last} />
        <TreeCaret expanded={isFolder ? expanded : undefined} />
        {isFolder ? <FolderGlyph open={expanded === true} /> : <FileGlyph extension={node.extension} />}
        <span className="tree__name">{node.name}</span>
        {opened && (
          <span
            className={dirty ? 'tree__dot tree__dot--dirty' : 'tree__dot'}
            title={dirty ? '已打开（有未保存修改）' : '已在标签中打开'}
          />
        )}
      </button>
      {children}
    </li>
  );
}
