import { CapabilityProvider } from './capabilities/CapabilityContext';
import { ShellLayout } from './layout/ShellLayout';
import { DocumentActionsProvider } from './state/DocumentActionsContext';
import { WorkspaceProvider } from './state/WorkspaceContext';

/**
 * Provider 层次：
 * - `Workspace`：纯 UI 状态（布局、标签、缓冲）。
 * - `Capability`：能力注册表（按扩展名解析查看器，与具体格式实现解耦）。
 * - `DocumentActions`：打开/编辑/保存的编排。
 */
export function App() {
  return (
    <WorkspaceProvider>
      <CapabilityProvider>
        <DocumentActionsProvider>
          <ShellLayout />
        </DocumentActionsProvider>
      </CapabilityProvider>
    </WorkspaceProvider>
  );
}
