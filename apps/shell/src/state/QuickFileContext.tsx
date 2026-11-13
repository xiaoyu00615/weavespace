/**
 * Quick File 上下文（S11-B）。
 *
 * 只做一件事：把纯状态模型 `state/quick-file.ts` 接到 React 上。
 * 文件内容**只存在于内存**，不进工作区 Reducer、不进 Core、不发 HTTP。
 */
import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  createQuickFileController,
  type QuickFileController,
  type QuickFileSource,
  type QuickFileState,
} from './quick-file';

export interface QuickFileContextValue {
  state: QuickFileState;
  /** 用户明确选择/拖入的文件（浏览器 `File`）。 */
  selectFiles(files: readonly File[], options?: { directory?: boolean }): Promise<void>;
  activate(): void;
  deactivate(): void;
  remove(): void;
}

const QuickFileContext = createContext<QuickFileContextValue | null>(null);

/** 浏览器 File → 纯模型的读取源：只暴露 name/size/read，不带任何路径信息。 */
function sourceOf(file: File): QuickFileSource {
  return {
    name: file.name,
    size: file.size,
    read: () => file.arrayBuffer(),
  };
}

export function QuickFileProvider({ children }: { children: ReactNode }) {
  const controllerRef = useRef<QuickFileController | null>(null);
  if (!controllerRef.current) controllerRef.current = createQuickFileController();
  const controller = controllerRef.current;

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  const value = useMemo<QuickFileContextValue>(
    () => ({
      state,
      async selectFiles(files, options) {
        await controller.open(files.map(sourceOf), { directory: options?.directory });
      },
      activate: () => {
        controller.activate();
      },
      deactivate: () => {
        controller.deactivate();
      },
      remove: () => {
        controller.remove();
      },
    }),
    [controller, state],
  );

  return <QuickFileContext.Provider value={value}>{children}</QuickFileContext.Provider>;
}

export function useQuickFile(): QuickFileContextValue {
  const value = useContext(QuickFileContext);
  if (!value) throw new Error('useQuickFile 必须在 QuickFileProvider 内使用');
  return value;
}

/** 当前是否有正在展示的 Quick File 预览（决定工作区显示预览还是文档）。 */
export function isQuickFileVisible(state: QuickFileState): boolean {
  return state.status === 'ready' && state.active && state.file !== null;
}
