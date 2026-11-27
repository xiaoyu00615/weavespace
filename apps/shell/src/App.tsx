import { CapabilityProvider } from './capabilities/CapabilityContext';
import { ShellLayout } from './layout/ShellLayout';
import { ResourceMetadataDialog } from './components/ResourceMetadataDialog.tsx';
import { TrashDeleteDialog } from './components/TrashDeleteDialog.tsx';
import { TreeCommandsProvider } from './components/TreeCommandsContext.tsx';
import { DocumentActionsProvider } from './state/DocumentActionsContext';
import { QuickFileProvider } from './state/QuickFileContext';
import { MetadataProvider } from './state/MetadataContext.tsx';
import { TrashProvider } from './state/TrashContext.tsx';
import { WorkspaceProvider } from './state/WorkspaceContext';

/**
 * Provider 层次：
 * - `Workspace`：纯 UI 状态（布局、标签、缓冲）。
 * - `Capability`：能力注册表（按扩展名解析查看器，与具体格式实现解耦）。
 * - `DocumentActions`：打开/编辑/保存的编排。
 * - `QuickFile`（S11-B）：浏览器本地临时文件的只读预览，独立于项目/会话。
 * - `Metadata`（UX-02C-04）：资源标注名 / 标签 / 行颜色的编辑会话（不含任何存储）。
 */
export function App() {
  return (
    <WorkspaceProvider>
      <CapabilityProvider>
        <DocumentActionsProvider>
          <QuickFileProvider>
            {/* 回收区编排要在文件树命令之前：右键「移入回收区」走它的二段确认 */}
            <TrashProvider>
              {/* 标注编辑会话要在文件树命令之前：右键「标注…」走它的对话框 */}
              <MetadataProvider>
                <TreeCommandsProvider>
                  <ShellLayout />
                </TreeCommandsProvider>
                <ResourceMetadataDialog />
              </MetadataProvider>
              <TrashDeleteDialog />
            </TrashProvider>
          </QuickFileProvider>
        </DocumentActionsProvider>
      </CapabilityProvider>
    </WorkspaceProvider>
  );
}
