/**
 * 能力上下文（S10-A）。
 *
 * 提供：注册表实例、可用性版本号、初始激活状态，以及按扩展名取查看器的钩子。
 * 组件只依赖本上下文，不 import 任何插件实现。
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createShellCapabilityRegistry, type ShellCapabilityRegistry, type ViewerResolution } from './registry';
import { useWorkspace } from '../state/WorkspaceContext';

interface CapabilityContextValue {
  registry: ShellCapabilityRegistry;
  /** 初始激活是否完成；未完成时不要假设查看器可用。 */
  ready: boolean;
  /** 注册表状态变更计数，用于触发订阅组件重渲染。 */
  revision: number;
  /** 启用/停用插件；返回失败原因供 UI 展示。 */
  setEnabled(pluginId: string, enabled: boolean): Promise<{ ok: boolean; errorCode?: string; reason?: string }>;
  toggle(pluginId: string, enabled: boolean): Promise<void>;
  resolveViewer(extension: string): ViewerResolution;
  notice: string;
  setNotice(message: string): void;
}

const CapabilityContext = createContext<CapabilityContextValue | null>(null);

export function CapabilityProvider({ children }: { children: ReactNode }) {
  const { state } = useWorkspace();
  const [registry] = useState(() => createShellCapabilityRegistry());
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState('');

  // 停用插件前判断是否仍有未保存内容：用 ref 读取最新标签状态（回调不是渲染期执行的）
  const tabsRef = useRef(state.tabs);
  tabsRef.current = state.tabs;

  useEffect(() => {
    registry.setDirtyChecker((pluginId) => {
      const extensions = registry.runtime.status(pluginId)?.fileExtensions ?? [];
      return tabsRef.current.some((tab) => tab.dirty && extensions.includes(tab.extension));
    });
  }, [registry]);

  useEffect(() => {
    let alive = true;
    void registry.ready.then(() => {
      if (!alive) return;
      setReady(true);
      setRevision((value) => value + 1);
    });
    return () => {
      alive = false;
    };
  }, [registry]);

  const value = useMemo<CapabilityContextValue>(
    () => ({
      registry,
      ready,
      revision,
      setEnabled: (pluginId, enabled) => registry.setEnabled(pluginId, enabled),
      async toggle(pluginId, enabled) {
        const result = await registry.setEnabled(pluginId, enabled);
        setRevision((value) => value + 1);
        if (!result.ok) {
          setNotice(
            result.reason ??
              `无法${enabled ? '启用' : '停用'} ${pluginId}：${result.errorCode ?? '未知错误'}`,
          );
          return;
        }
        setNotice(enabled ? `已启用 ${pluginId}` : `已停用 ${pluginId}`);
      },
      resolveViewer: (extension) => registry.resolveViewer(extension),
      notice,
      setNotice,
    }),
    [registry, ready, revision, notice],
  );

  return <CapabilityContext.Provider value={value}>{children}</CapabilityContext.Provider>;
}

export function useCapabilities(): CapabilityContextValue {
  const value = useContext(CapabilityContext);
  if (!value) throw new Error('useCapabilities 必须在 CapabilityProvider 内使用');
  return value;
}

/** 按扩展名取当前查看器；`revision` 变化时自动重新解析。 */
export function useViewer(extension: string): ViewerResolution {
  const { resolveViewer, revision, ready } = useCapabilities();
  return useMemo(
    () =>
      ready
        ? resolveViewer(extension)
        : { ok: false, errorCode: 'ERR_CAPABILITY_MISSING', reason: '能力尚未就绪' },
    // revision 参与依赖：插件启用/停用后必须重新解析
    [resolveViewer, revision, ready, extension],
  );
}
