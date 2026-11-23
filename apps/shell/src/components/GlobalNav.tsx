import { useTrash } from '../state/TrashContext.tsx';
import { useWorkspace } from '../state/WorkspaceContext';
import type { NavKey } from '../state/types';

const NAV_ITEMS: ReadonlyArray<{ key: NavKey; label: string; glyph: string; hint: string }> = [
  { key: 'projects', label: '项目', glyph: '项', hint: '项目与文件树' },
  // 回收区（UX-02C-03-P2-02）：按项目隔离；数量是真实记录数，未知时不显示
  { key: 'trash', label: '回收区', glyph: '收', hint: '已移入回收区的文件（可恢复，不会永久删除）' },
  { key: 'plugins', label: '插件', glyph: '插', hint: '插件中心（后续阶段）' },
  { key: 'diagnostics', label: '诊断', glyph: '诊', hint: '运行诊断（后续阶段）' },
];

/** 左侧全局导航：只负责切换一级入口与折叠自身，不含业务逻辑。 */
export function GlobalNav() {
  const { state, dispatch } = useWorkspace();
  const { badge } = useTrash();
  const collapsed = state.navCollapsed;

  return (
    <nav className={collapsed ? 'nav nav--collapsed' : 'nav'} aria-label="全局导航">
      <button
        type="button"
        className="nav__toggle"
        onClick={() => dispatch({ type: 'TOGGLE_NAV' })}
        aria-expanded={!collapsed}
        title={collapsed ? '展开导航' : '折叠导航'}
      >
        {collapsed ? '›' : '‹'}
      </button>

      <div className="nav__brand" title="织界 WeaveSpace">
        {collapsed ? '织' : '织界'}
      </div>

      <ul className="nav__list">
        {NAV_ITEMS.map((item) => {
          const active = state.navKey === item.key;
          return (
            <li key={item.key}>
              <button
                type="button"
                className={active ? 'nav__item nav__item--active' : 'nav__item'}
                aria-current={active ? 'page' : undefined}
                title={item.hint}
                onClick={() => dispatch({ type: 'SET_NAV_KEY', key: item.key })}
              >
                <span className="nav__glyph" aria-hidden="true">
                  {item.glyph}
                </span>
                {!collapsed && <span className="nav__label">{item.label}</span>}
                {/*
                  数量徽标：`null` 表示"还没读到"，此时不渲染数字。
                  显示 0 会让用户以为回收区是空的，从而漏掉需要人工核对的记录。
                */}
                {item.key === 'trash' && badge !== null && badge > 0 && (
                  <span className="nav__count" aria-label={`${badge} 条回收记录`}>
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="nav__footer">{collapsed ? 'S9' : 'S9-A 演示'}</div>
    </nav>
  );
}
