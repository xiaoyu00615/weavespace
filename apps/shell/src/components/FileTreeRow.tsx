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
 * - 每级缩进 18px，引导线落在缩进列的中线（6.5px）上，与箭头/图标列严格对齐；
 * - 祖先是本层末项时，它的后代不再画这条竖线（见 `tree-trails.ts`）；
 * - 叶子行没有箭头，但保留同宽占位，保证文件名起点一致。
 */
import { useEffect, useMemo, useRef } from 'react';
import type { FocusEvent, MouseEvent, ReactNode } from 'react';
import type { ResourceNodeState } from '../state/types';
import { colorRowClassOf, tagBadges } from '../state/resource-metadata';
import {
  activationIdentityKey,
  createActivationArbiter,
  NAME_DOUBLE_CLICK_WINDOW,
  type ActivationIdentity,
} from '../state/tree-commands';
import { ancestorGuides, type TreeTrails } from './tree-trails';

/** 每一级的缩进步长（px）。行内计算与 CSS 都必须用这个值。 */
export const TREE_INDENT = 18;

/** 文件夹图标尺寸（px）：与箭头列同宽，避免图标挤压文件名。 */
const ICON_SIZE = 15;

/**
 * 缩进列 + 树状引导线。
 *
 * `last` 决定**自己**这一列的收尾方式：同级最后一项只画"上半段竖线 + 横线"（└），
 * 其余画"整段竖线 + 横线"（├），这样最后一项下方不会拖着一条悬空竖线。
 *
 * `trails` 决定**祖先列**是否继续：祖先已是本层末项时只留空白占位，不画线；
 * 占位仍然存在，所以缩进宽度与图标列不受影响。
 */
export function TreeIndent({
  depth,
  last,
  trails,
}: {
  depth: number;
  last?: boolean;
  trails?: TreeTrails;
}) {
  if (depth <= 0) return null;
  const guides = ancestorGuides(trails ?? [], depth);
  return (
    <span className="tree__indent" aria-hidden="true">
      {guides.map((guide, index) => (
        <span
          key={index}
          className={guide === 'line' ? 'tree__guide' : 'tree__guide tree__guide--blank'}
        />
      ))}
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

/**
 * 链接图标（UX-02B-TREE 契约 B.5）。
 *
 * 形状与文件/文件夹都不同：链接是"显示但不可用"的叶子（不展开、不打开、不预览），
 * 静默隐藏会让用户以为文件丢了，但把它画成普通文件又会诱导点击。
 */
export function LinkGlyph() {
  return (
    <svg className="tree__icon tree__icon--link" viewBox="0 0 16 16" width={ICON_SIZE} height={ICON_SIZE} aria-hidden="true">
      <path
        d="M6.6 9.4 9.4 6.6M6.9 4.9l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9.1 11.1l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeDasharray="2 1.4"
      />
    </svg>
  );
}

export interface TreeRowProps {
  node: ResourceNodeState;
  depth: number;
  /** 同级最后一项：决定引导线是否收尾。 */
  last: boolean;
  /** 各祖先层是否还有后续兄弟：决定祖先竖线是否继续画。 */
  trails?: TreeTrails;
  /** 文件夹才是可展开的；文件传 undefined。 */
  expanded?: boolean;
  selected?: boolean;
  /** 已在标签中打开。 */
  opened?: boolean;
  /** 已打开且有未保存修改。 */
  dirty?: boolean;
  /**
   * 右对齐的附加内容（项目根的状态芯片 / 刷新按钮）。
   *
   * 渲染在**按钮之外**、同一个 `<li>` 之内：HTML 不允许按钮套按钮，
   * 把它放进主按钮会让项目根行的刷新按钮变成无效交互元素。
   */
  actions?: ReactNode;
  /**
   * 追加到行上的类名（例如项目根有更多右侧操作时，需要单独放宽右内边距）。
   * 只做展示微调，不影响层级/缩进计算。
   */
  rowClassName?: string;
  onActivate(): void;
  /** 右键菜单（UX-02C-01）：由调用方按上下文决定命令；本组件不含任何命令逻辑。 */
  onContextMenu?(event: MouseEvent<HTMLButtonElement>): void;
  /**
   * 双击**名称文字**进入改名（UX-02C-05）。不传表示这一行不提供双击改名，
   * 单击立即激活（Demo / Legacy / 链接节点就是这种情形）。
   *
   * 为什么需要它：文件的单击会立刻打开活动 View，而改名保护要求"没有打开的标签"。
   * 因此名称上的单击要延后一个短窗口再激活，窗口内的第二次点击改为改名，
   * 详见 `tree-commands.ts::createActivationArbiter`。
   */
  onRenameRequest?(): void;
  /**
   * 这一行的资源身份（工作区 + 项目 + 路径 + 资源锚）。
   *
   * 双击改名必须绑定它：同路径的文件被替换时 React 会复用组件实例，
   * 只有身份能让在途的点击发现"对象已经换了"（UX-02C-05-R1）。
   * 不传表示这一行没有可绑定的身份，单击立即激活、不装配仲裁器。
   */
  activationIdentity?: ActivationIdentity;
  /** 焦点进入本行：F2 / Shift+F10 以"当前焦点行"为操作对象。 */
  onFocus?(event: FocusEvent<HTMLButtonElement>): void;
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
  trails,
  expanded,
  selected,
  opened,
  dirty,
  actions,
  rowClassName,
  onActivate,
  onContextMenu,
  onRenameRequest,
  activationIdentity,
  onFocus,
  children,
}: TreeRowProps) {
  const isFolder = node.kind === 'folder';
  const isLink = node.kind === 'link';

  /**
   * 单击 / 双击仲裁（UX-02C-05 / R1）。
   *
   * 回调放进 ref：仲裁器只在"是否提供双击改名 + 这一行是谁"变化时重建，
   * 因此不会拿着上一次渲染的 `onActivate` 去操作另一个项目。
   *
   * R1 起**不再只靠 ref 取最新回调**：每次点击都把发起时的
   * `activationIdentity` 交给仲裁器，定时器到点与双击落槌前各核一次身份。
   * 同路径文件被替换（锚变）、切了项目/工作区、或身份无法确认时，
   * 这一下什么都不做——旧点击绝不会被重新绑定到新对象上。
   */
  const latest = useRef({ onActivate, onRenameRequest, identity: activationIdentity });
  latest.current = { onActivate, onRenameRequest, identity: activationIdentity };
  const renameable = typeof onRenameRequest === 'function' && activationIdentity !== undefined;
  const identityKey = activationIdentityKey(activationIdentity);
  const arbiter = useMemo(
    () =>
      renameable
        ? createActivationArbiter({
            delay: NAME_DOUBLE_CLICK_WINDOW,
            setTimer: (fn, delay) => window.setTimeout(fn, delay),
            clearTimer: (handle) => window.clearTimeout(handle as number),
            currentIdentity: () => latest.current.identity ?? null,
            onSingle: () => latest.current.onActivate(),
            onDouble: () => latest.current.onRenameRequest?.(),
          })
        : null,
    // 身份变化 = 这一行已经不是刚才那个对象：重建仲裁器，旧实例的在途单击由
    // 下面的清理函数取消（结构上的作废 + 运行时的身份核对，两道都在）
    [renameable, identityKey],
  );
  // 卸载 / 身份变化时撤掉在途的单击：绝不能再触发一次"打开"
  useEffect(() => () => arbiter?.cancel(), [arbiter]);

  /** 只有名称（含标注名）区域参与双击改名；图标与行内空白保持"点了就动"。 */
  const onNameArea = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement && Boolean(target.closest('.tree__name, .tree__alias'));
  /**
   * 隐藏标记（UX-02C-03-P1）。
   *
   * 它是**展示**而不是禁用：隐藏的文件照样能点开、能编辑、能保存，
   * 所以这里只做"变淡 + 一枚小标签"，绝不给行加 disabled 或拦截点击。
   */
  const hiddenSelf = node.hidden === true;
  const hiddenBy = node.hiddenBy;
  /**
   * 资源标注（UX-02C-04）：标注名是**附加**信息，永远排在真实名称之后。
   *
   * 真实名称不加任何修饰：用户判断"这是哪个文件"靠它，标注名只用来帮人记住用途。
   * 颜色只落在 `color` 上（见样式表），不覆盖选中/焦点/禁用/错误态。
   */
  const meta = node.meta;
  const colorClass = colorRowClassOf(meta?.color);
  /*
   * 侧栏只有 260px，放不下"名称 + 标注名 + 标签"三样：
   * - 有标注名时，行内**不画**标签（它们进 `title`）——否则标注名会被挤成 `（…`，
   *   而标注名正是用户刚刚输入、最需要确认的东西；
   * - 没有标注名时，行内最多两枚标签 + `+N`。
   *
   * 标签本身没有丢：对话框里完整可编辑，行的 `title` 里也全列出来了。
   */
  const badges = tagBadges(meta?.tags ?? [], meta?.alias ? 0 : 2);
  const annotated = Boolean(meta?.alias) || badges.shown.length > 0;
  const baseTitle = isLink
    ? `${node.name}（链接不展开，避免越过项目根）`
    : hiddenSelf
      ? `${node.name}（已从文件树隐藏；文件仍在磁盘上，可正常打开与保存）`
      : hiddenBy
        ? `${node.name}（上级「${hiddenBy}」被隐藏；文件仍在磁盘上）`
        : node.name;
  const aliasTitle = meta?.alias ? `\n标注名：${meta.alias}` : '';
  const tagTitle = meta?.tags.length ? `\n标签：${meta.tags.join('、')}` : '';
  const rowTitle = annotated ? `${baseTitle}${aliasTitle}${tagTitle}` : baseTitle;
  return (
    <li className="tree__item">
      <div className="tree__row-wrap">
        <button
          type="button"
          className={[
            'tree__row',
            isFolder ? 'tree__row--folder' : 'tree__row--file',
            isLink ? 'tree__row--link' : '',
            selected ? 'tree__row--selected' : '',
            opened ? 'tree__row--opened' : '',
            hiddenSelf || hiddenBy ? 'tree__row--hidden' : '',
            colorClass ?? '',
            actions ? 'tree__row--with-actions' : '',
            rowClassName ?? '',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-expanded={isFolder ? expanded : undefined}
          title={rowTitle}
          onClick={(event) => {
            const identity = latest.current.identity;
            if (!arbiter || identity === undefined || !onNameArea(event.target)) {
              onActivate();
              return;
            }
            arbiter.click(event.detail, identity);
          }}
          onDoubleClick={(event) => {
            const identity = latest.current.identity;
            if (!arbiter || identity === undefined || !onNameArea(event.target)) return;
            arbiter.doubleClick(identity);
          }}
          onFocus={onFocus}
          onContextMenu={onContextMenu}
        >
          <TreeIndent depth={depth} last={last} trails={trails} />
          <TreeCaret expanded={isFolder ? expanded : undefined} />
          {isFolder ? (
            <FolderGlyph open={expanded === true} />
          ) : isLink ? (
            <LinkGlyph />
          ) : (
            <FileGlyph extension={node.extension} />
          )}
          <span className="tree__name">{node.name}</span>
          {meta?.alias && (
            <span className="tree__alias" title={`标注名：${meta.alias}（真实名称不变）`}>
              （{meta.alias}）
            </span>
          )}
          {badges.shown.map((tag) => (
            <span key={tag} className="tree__tag" title={`标签：${tag}`}>
              {tag}
            </span>
          ))}
          {badges.more > 0 && (
            <span className="tree__tag tree__tag--more" title={(meta?.tags ?? []).slice(2).join('、')}>
              +{badges.more}
            </span>
          )}
          {hiddenSelf && (
            <span className="tree__hidden-badge" title="已从文件树隐藏（磁盘文件未删除）">
              隐藏
            </span>
          )}
          {!hiddenSelf && hiddenBy && (
            <span className="tree__hidden-badge tree__hidden-badge--inherited" title={`上级「${hiddenBy}」被隐藏`}>
              随上级隐藏
            </span>
          )}
          {opened && (
            <span
              className={dirty ? 'tree__dot tree__dot--dirty' : 'tree__dot'}
              title={dirty ? '已打开（有未保存修改）' : '已在标签中打开'}
            />
          )}
        </button>
        {actions && <span className="tree__row-actions">{actions}</span>}
      </div>
      {children}
    </li>
  );
}
