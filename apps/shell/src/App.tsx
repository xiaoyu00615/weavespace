import { ShellLayout } from './layout/ShellLayout';
import { DocumentActionsProvider } from './state/DocumentActionsContext';
import { WorkspaceProvider } from './state/WorkspaceContext';

export function App() {
  return (
    <WorkspaceProvider>
      <DocumentActionsProvider>
        <ShellLayout />
      </DocumentActionsProvider>
    </WorkspaceProvider>
  );
}
