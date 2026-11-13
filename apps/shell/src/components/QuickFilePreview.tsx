/**
 * Quick File 只读预览（S11-B）。
 *
 * 格式路由**完全复用 S10-A 的能力注册表**：`useViewer(extension)` →
 * `renderViewerSafely` → `ViewerBoundary`。这里不 import 任何解析实现，
 * 也没有第二套"按扩展名分支"的逻辑。
 *
 * 只读是结构性的：本组件只渲染查看器输出，没有 textarea、没有保存入口，
 * 也不持有任何 sessionId / projectId。
 */
import type { ReactNode } from 'react';
import { useViewer } from '../capabilities/CapabilityContext';
import { renderViewerSafely } from '../capabilities/safe-render';
import { ViewerBoundary } from '../capabilities/ViewerBoundary';
import { isQuickFileVisible, useQuickFile } from '../state/QuickFileContext';
import { formatQuickFileSize } from '../state/quick-file';

export function QuickFilePreview() {
  const quick = useQuickFile();
  const file = isQuickFileVisible(quick.state) ? quick.state.file : null;
  // Hook 必须无条件执行：没有文件时用空扩展名占位
  const viewer = useViewer(file?.extension ?? '');
  if (!file) return null;

  const rendered = viewer.ok
    ? renderViewerSafely(viewer.viewer, { content: file.content, path: file.name })
    : null;

  return (
    <section className="quick-preview" aria-label="Quick File 只读预览">
      <header className="quick-preview__header">
        <span className="quick-preview__badge">Quick File · 只读</span>
        <strong className="quick-preview__name">{file.name}</strong>
        <span className="quick-preview__meta">
          {file.extension} · {formatQuickFileSize(file.size)} · 不属于任何项目
        </span>
        <button type="button" className="chip chip--tiny" onClick={() => quick.deactivate()}>
          返回文档
        </button>
        <button type="button" className="chip chip--tiny" onClick={() => quick.remove()}>
          关闭
        </button>
      </header>

      <div className="preview quick-preview__body">
        {!viewer.ok && (
          <div className="preview__error" role="alert">
            <strong>没有可用的查看器</strong>
            <div>{viewer.reason}</div>
            <div className="preview__error-hint">
              可在左侧「插件」中启用对应能力；Quick File 内容仍在内存中，不受影响。
            </div>
          </div>
        )}
        {viewer.ok && rendered && !rendered.ok && (
          <div className="preview__error" role="alert">
            <strong>查看器渲染失败</strong>
            <div>
              {rendered.errorCode}：{rendered.message}
            </div>
            <div className="preview__error-hint">
              Quick File 内容仍在内存中，不受影响；项目文档与草稿也没有被改动。
            </div>
          </div>
        )}
        {viewer.ok && rendered?.ok && (
          <ViewerBoundary
            // 换文件或换查看器都重建边界，避免旧错误残留
            key={`quick:${file.id}:${viewer.providerId}`}
            providerId={viewer.providerId}
          >
            {rendered.node as ReactNode}
          </ViewerBoundary>
        )}
      </div>

      <footer className="quick-preview__footer">
        只读预览：内容来自你本机选择的文件，不会写回磁盘、不会上传，也不会成为项目的一部分。
        {viewer.ok ? ` · 查看器：${viewer.providerId}` : ''}
      </footer>
    </section>
  );
}
