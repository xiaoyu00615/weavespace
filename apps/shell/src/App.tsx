import { CapabilityProvider } from './capabilities/CapabilityContext';
import { ShellLayout } from './layout/ShellLayout';
import { TrashDeleteDialog } from './components/TrashDeleteDialog.tsx';
import { TreeCommandsProvider } from './components/TreeCommandsContext.tsx';
import { DocumentActionsProvider } from './state/DocumentActionsContext';
import { QuickFileProvider } from './state/QuickFileContext';
import { TrashProvider } from './state/TrashContext.tsx';
import { WorkspaceProvider } from './state/WorkspaceContext';

/**
 * Provider 层次：
 * - `Workspace`：纯 UI 状态（布局、标签、缓冲）。
 * - `Capability`：能力注册表（按扩展名解析查看器，与具体格式实现解耦）。
 * - `DocumentActions`：打开/编辑/保存的编排。
 * - `QuickFile`（S11-B）：浏览器本地临时文件的只读预览，独立于项目/会话。
 */
export function App() {
  return (
    <WorkspaceProvider>
      <CapabilityProvider>
        <DocumentActionsProvider>
          <QuickFileProvider>
            {/* 回收区编排要在文件树命令之前：右键「移入回收区」走它的二段确认 */}
            <TrashProvider>
              <TreeCommandsProvider>
                <ShellLayout />
              </TreeCommandsProvider>
              <TrashDeleteDialog />
            </TrashProvider>
          </QuickFileProvider>
        </DocumentActionsProvider>
      </CapabilityProvider>
    </WorkspaceProvider>
  );
}
