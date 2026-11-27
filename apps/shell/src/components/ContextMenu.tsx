/**
 * 统一右键菜单基础框架（UX-02C-01）。
 *
 * 复用现有 `ProjectList` / `TreeBranch` / `TreeRow` 的文件树，不另造一套树。
 * 组件只负责"呈现 + 键盘鼠标导航 + 关闭"，**不调用任何磁盘接口**：每一项
 * 的命令回调都由 `TreeCommandsContext` 注入，菜单与工具栏共用同一条编排。
 *
 * 关键约束：
 * - 用 `createPortal` 挂到 `document.body`，避免被 `.tree` 的 overflow 裁切；
 * - 首屏定位用锚点，挂载后按实际尺寸夹到视口内；
 * - Esc / 点击外部关闭，输入框的原生文本右键不被树组件拦截；
 * - 子菜单支持鼠标悬停与键盘（→ 展开、← 返回、↑↓ 移动、Enter 执行）；
 * - 未来命令只在注册表里占位，**不渲染**成点了没反应的假菜单。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { menuPositionOf } from '../state/tree-commands.ts';

/** 本轮实现的命令（UX-02C-03-P1 起 `hide` / `unhide` 落地）。 */
export type ActiveTreeCommand =
  | 'new-file'
  | 'new-folder'
  | 'new-supported'
  | 'refresh'
  | 'rename'
  | 'move'
  | 'hide'
  | 'unhide';

/**
 * 未来命令注册表（占位，不实现、不渲染）。
 * 保留 id 是为了让后续阶段接到同一套 `TreeCommandsContext`，不必重做菜单框架。
 *
 * `hide-from-workspace` 已在 UX-02C-03-P1 落地为真实命令（`hide` / `unhide`），
 * 因此从占位表里移除——占位表只放"确实还没有实现"的东西。
 */
export const RESERVED_TREE_COMMANDS = [
  'delete-local',
  'set-alias',
  'set-tags',
  'set-row-color',
] as const;
export type ReservedTreeCommand = (typeof RESERVED_TREE_COMMANDS)[number];
export type TreeCommandId = ActiveTreeCommand | ReservedTreeCommand;

export interface MenuItem {
  /** 一级命令用 `TreeCommandId`；二级动态项（扩展名）带后缀。 */
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  /** 不支持时明确禁用（显示原因），而不是藏起来让人以为功能不存在。 */
  readonly disabled?: boolean;
  /** 当前上下文完全不适用的项直接隐藏（例如链接节点的"刷新此目录"）。 */
  readonly hidden?: boolean;
  readonly command?: () => void;
  readonly children?: readonly MenuItem[];
}

export interface ContextMenuProps {
  readonly x: number;
  readonly y: number;
  readonly items: readonly MenuItem[];
  /** 菜单所属的"世界"（模式/工作区/当前项目），只用于呈现与取证（`data-menu-identity`）。 */
  readonly identity?: string;
  /**
   * `reason` 让调用方区分"用户按了 Escape"与"点到外面/窗口失焦"：
   * 前者要把焦点还给触发菜单的那一行，后者不该抢焦点（UX-02C-05）。
   */
  onClose(reason?: 'escape' | 'other'): void;
}

const MENU_WIDTH = 224;
const EDGE = 8;

export function ContextMenu({ x, y, items, identity, onClose }: ContextMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const [active, setActive] = useState(0);
  const [submenu, setSubmenu] = useState<number | null>(null);
  const [subIndex, setSubIndex] = useState(0);
  const visible = useMemo(() => items.filter((item) => !item.hidden), [items]);
  const submenuItems = useMemo(
    () => (submenu === null ? [] : (visible[submenu]?.children ?? []).filter((child) => !child.hidden)),
    [submenu, visible],
  );

  // 挂载后按真实尺寸夹到视口内：菜单靠近右/下边缘时自动向左/上翻转
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    // 夹取规则在纯模块里（`menuPositionOf`），组件只把测量值交给它
    setPosition(
      menuPositionOf({
        x,
        y,
        width: rect.width,
        height: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        edge: EDGE,
      }),
    );
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) onClose('other');
    };
    const onBlur = (): void => onClose('other');
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [onClose]);

  const selectable = (index: number): boolean => {
    const item = visible[index];
    return Boolean(item) && !item.disabled && (!item.children || item.children.length > 0);
  };
  const moveMain = (delta: number): void => {
    if (visible.length === 0) return;
    setActive((current) => {
      let next = current;
      for (let i = 0; i < visible.length; i += 1) {
        next = (next + delta + visible.length) % visible.length;
        if (selectable(next)) break;
      }
      return next;
    });
    setSubmenu(null);
  };
  const moveSub = (delta: number): void => {
    if (submenuItems.length === 0) return;
    setSubIndex((current) => (current + delta + submenuItems.length) % submenuItems.length);
  };
  const runSub = (index: number): void => {
    const child = submenuItems[index];
    if (!child || child.disabled) return;
    onClose('other');
    child.command?.();
  };
  const activate = (index: number): void => {
    const item = visible[index];
    if (!item || item.disabled) return;
    if (item.children && item.children.length > 0) {
      setSubmenu(index);
      setSubIndex(0);
      return;
    }
    onClose('other');
    item.command?.();
  };

  return createPortal(
      <div
        ref={rootRef}
        className="ctx-menu"
        role="menu"
        aria-label="文件树命令"
        data-menu-identity={identity ?? ''}
        style={{ left: position.left, top: position.top, minWidth: MENU_WIDTH }}
        onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const inSub = submenu !== null && submenuItems.length > 0;
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose('escape');
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          if (inSub) moveSub(1);
          else moveMain(1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          if (inSub) moveSub(-1);
          else moveMain(-1);
        } else if (event.key === 'ArrowRight' || event.key === 'Enter') {
          event.preventDefault();
          if (inSub) runSub(subIndex);
          else activate(active);
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          setSubmenu(null);
        }
      }}
    >
      {visible.map((item, index) => (
        <div
          key={item.id}
          className="ctx-menu__item-wrap"
          onMouseEnter={() => {
            setActive(index);
            setSubIndex(0);
            setSubmenu(item.children?.length ? index : null);
          }}
          onMouseOver={() => {
            // 真实鼠标移动先触发 mouseover 再合成 mouseenter；两条都接上，
            // 避免不同浏览器/合成事件下二级菜单需要"点一下"才展开
            if (item.children?.length && submenu !== index) {
              setActive(index);
              setSubIndex(0);
              setSubmenu(index);
            }
          }}
        >
          <button
            type="button"
            role="menuitem"
            data-command={item.id}
            data-disabled={item.disabled ? 'true' : 'false'}
            className={[
              'ctx-menu__item',
              active === index ? 'ctx-menu__item--active' : '',
              item.disabled ? 'ctx-menu__item--disabled' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            disabled={item.disabled}
            aria-haspopup={item.children?.length ? 'menu' : undefined}
            aria-expanded={item.children?.length ? submenu === index : undefined}
            onClick={() => activate(index)}
          >
            <span>{item.label}</span>
            {item.hint && <span className="ctx-menu__hint">{item.hint}</span>}
            {item.children?.length ? <span className="ctx-menu__arrow">›</span> : null}
          </button>
          {item.children && submenu === index && (
            <div
              className={`ctx-menu ctx-menu--sub${position.left + MENU_WIDTH * 2 > window.innerWidth ? ' ctx-menu--sub-left' : ''}`}
              role="menu"
              aria-label={item.label}
            >
              {submenuItems.map((child, childIndex) => (
                <button
                  key={child.id}
                  type="button"
                  role="menuitem"
                  className={[
                    'ctx-menu__item',
                    childIndex === subIndex ? 'ctx-menu__item--active' : '',
                    child.disabled ? 'ctx-menu__item--disabled' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  disabled={child.disabled}
                  onMouseEnter={() => setSubIndex(childIndex)}
                  onClick={() => runSub(childIndex)}
                >
                  <span>{child.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      {/* 输入框的原生文本右键不会被本菜单拦截：树组件只对非输入元素绑定 onContextMenu */}
      <div className="ctx-menu__focus-trap" tabIndex={-1} ref={(node) => node?.focus()} />
    </div>,
    document.body,
  );
}
