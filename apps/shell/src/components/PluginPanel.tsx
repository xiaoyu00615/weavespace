/**
 * 插件面板（S10-A）——最小能力开关。
 *
 * 只展示注册表里的事实（状态、能力、扩展名）并提供启用/停用；
 * 不实现安装、市场、热更新（明确不在本轮范围）。
 */
import { useCapabilities } from '../capabilities/CapabilityContext';
import { useWorkspace } from '../state/WorkspaceContext';

const STATUS_LABEL: Record<string, string> = {
  REGISTERED: '未启用',
  ACTIVATING: '启用中',
  ACTIVE: '已启用',
  INACTIVE: '已停用',
  DEACTIVATING: '停用中',
  QUARANTINED: '已隔离',
  FAILED: '失败',
  BLOCKED_DEPENDENCY: '依赖缺失',
};

export function PluginPanel() {
  const { state, dispatch } = useWorkspace();
  const { registry, ready, revision, toggle, notice } = useCapabilities();
  // revision 是订阅信号：插件状态变化后重新读取注册表
  void revision;
  const plugins = ready ? registry.list() : [];

  return (
    <aside className="tree" aria-label="插件与能力">
      <header className="tree__header">
        <div>
          <div className="tree__project">插件与能力</div>
          <div className="tree__meta">{ready ? `${plugins.length} 个已注册` : '初始化…'}</div>
        </div>
        <div className="tree__actions">
          <button
            type="button"
            className="icon-button"
            onClick={() => dispatch({ type: 'SET_NAV_KEY', key: 'projects' })}
            title="返回项目"
          >
            «
          </button>
        </div>
      </header>

      <ul className="tree__root">
        {plugins.map((plugin) => {
          const active = plugin.status === 'ACTIVE';
          return (
            <li key={plugin.pluginId} className="plugin">
              <div className="plugin__head">
                <span className="plugin__name" title={plugin.pluginId}>
                  {plugin.pluginId}
                </span>
                <button
                  type="button"
                  className="chip chip--small"
                  data-plugin={plugin.pluginId}
                  data-active={active ? 'true' : 'false'}
                  onClick={() => void toggle(plugin.pluginId, !active)}
                  disabled={plugin.status === 'ACTIVATING' || plugin.status === 'DEACTIVATING'}
                >
                  {active ? '停用' : '启用'}
                </button>
              </div>
              <div className="plugin__meta">
                {STATUS_LABEL[plugin.status] ?? plugin.status} · v{plugin.version}
              </div>
              <div className="plugin__caps">
                能力：{plugin.capabilities.join('、') || '—'}
              </div>
              <div className="plugin__caps">
                扩展名：{plugin.fileExtensions.join(' ') || '—'}
              </div>
              {plugin.errorCode && (
                <div className="plugin__error">
                  {plugin.errorCode}
                  {plugin.errorMessage ? `：${plugin.errorMessage}` : ''}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <footer className="tree__footer">
        {notice || '停用 Markdown 后，.md 会回退到通用文本查看；草稿与保存不受影响'}
      </footer>
    </aside>
  );
}
