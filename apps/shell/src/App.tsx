import { ShellLayout } from './layout/ShellLayout';
import { WorkspaceProvider } from './state/WorkspaceContext';

export function App() {
  return (
    <WorkspaceProvider>
      <ShellLayout />
    </WorkspaceProvider>
  );
}
