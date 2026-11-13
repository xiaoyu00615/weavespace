import { AuxPanel } from '../components/AuxPanel';
import { ConflictBanner } from '../components/ConflictBanner';
import { DocumentToolbar } from '../components/DocumentToolbar';
import { GlobalNav } from '../components/GlobalNav';
import { PluginPanel } from '../components/PluginPanel';
import { ProjectTree } from '../components/ProjectTree';
import { SplitWorkspace } from '../components/SplitWorkspace';
import { StatusBar } from '../components/StatusBar';
import { TabStrip } from '../components/TabStrip';
import { useWorkspace } from '../state/WorkspaceContext';

/**
 * 五区外壳：全局导航 | 项目树 | 主工作区（工具栏 + 标签 + 窗格） | 辅助面板。
 * 布局用 CSS Grid 表达，各区域是独立组件，可单独替换而不影响其余部分。
 */
export function ShellLayout() {
  const { state } = useWorkspace();

  const columns = [
    state.navCollapsed ? '56px' : '176px',
    state.treeCollapsed ? '36px' : '260px',
    'minmax(0, 1fr)',
    state.auxCollapsed ? '36px' : '300px',
  ].join(' ');

  return (
    <div className="shell" style={{ gridTemplateColumns: columns }}>
      <GlobalNav />
      {/* 第二列按导航切换：项目资源树 / 插件与能力面板（S10-A） */}
      {state.navKey === 'plugins' ? <PluginPanel /> : <ProjectTree />}

      <main className="main">
        <DocumentToolbar />
        <TabStrip />
        <ConflictBanner />
        <SplitWorkspace />
      </main>

      <AuxPanel />
      <StatusBar />
    </div>
  );
}
