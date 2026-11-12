/**
 * 查看器错误边界（S10-A，S10A-08）。
 *
 * `renderViewerSafely` 只能挡住插件 `render()` 的同步抛错；组件树更深处的错误
 * 由这个边界兜住，表现为**该窗格**显示失败提示，工作台与文档缓冲继续可用。
 *
 * 明确边界：同进程、非沙箱。边界不阻止插件读取全局对象，只阻止错误向上扩散。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** 用于在错误提示里说明是哪个实现出了问题。 */
  providerId: string;
  children: ReactNode;
}

interface State {
  message: string | null;
}

export class ViewerBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(err: unknown): State {
    return { message: (err as Error)?.message ?? '查看器渲染失败' };
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    // 只做本地诊断输出：错误不进入 Core 日志链路，避免污染业务事实源。
    console.error(`[viewer:${this.props.providerId}] ${err.message}`, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.message !== null) {
      return (
        <div className="preview__error" role="alert">
          <strong>查看器渲染失败</strong>
          <div>{this.state.message}</div>
          <div className="preview__error-hint">
            已停用该查看器？可在左侧「插件」中切换；文档内容与未保存修改不受影响。
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
