import type { ReactNode } from 'react';
import { useDocumentActions } from '../state/DocumentActionsContext';
import { useViewer } from '../capabilities/CapabilityContext';
import { renderViewerSafely } from '../capabilities/safe-render';
import { ViewerBoundary } from '../capabilities/ViewerBoundary';
import { useWorkspace } from '../state/WorkspaceContext';

const STATUS_TEXT: Record<string, string> = {
  CLEAN: '已与磁盘一致',
  EDITING_DIRTY: '有未保存修改',
  SAVING: '保存中',
  CONFLICT: '版本冲突（内容已保留）',
  FAILED: '保存失败（内容已保留）',
  OUTCOME_UNKNOWN: '结果未确认（UNKNOWN）',
  DEMO: '演示缓冲（不写盘）',
};

/** 源码编辑视图：受控 textarea。修改立即进入本地缓冲，live 模式下按序同步到 Core。 */
export function EditorPane({ docId }: { docId: string }) {
  const { state } = useWorkspace();
  const actions = useDocumentActions();
  const tab = state.tabs.find((item) => item.docId === docId);
  if (!tab) return <div className="pane__empty">文档未打开</div>;

  const status = STATUS_TEXT[tab.documentState] ?? tab.documentState;
  const live = tab.mode === 'live';

  return (
    <div className="editor">
      <textarea
        className="editor__area"
        value={tab.buffer}
        spellCheck={false}
        // 保存期间锁定输入：Core 正在比较版本，缓冲不能在保存途中变化（F02）
        disabled={tab.saving}
        aria-busy={tab.saving}
        aria-label={`${tab.title} 源码`}
        onChange={(event) => actions.editDoc(docId, event.target.value)}
      />
      <div className="editor__footer">
        {tab.buffer.length} 字符 · {tab.buffer.split('\n').length} 行 · {status}
        {tab.saving ? ' · 正在保存（已锁定输入）' : ''}
        {live && tab.lastStatus ? ` · 上次保存：${tab.lastStatus}` : ''}
        {live && tab.errorCode ? ` · ${tab.errorCode}` : ''}
      </div>
    </div>
  );
}

/**
 * 预览视图（S10-A）：**不**直接依赖任何格式实现，只按扩展名向能力注册表要查看器。
 *
 * 三种情况都只影响本窗格：
 * - 有提供者 → 渲染它返回的节点；
 * - 没有提供者（插件被停用且无回退）→ 显示原因，文档缓冲与保存不受影响；
 * - 提供者抛错 → 局部错误提示（`renderViewerSafely` + `ViewerBoundary`）。
 */
export function PreviewPane({ docId }: { docId: string }) {
  const { state } = useWorkspace();
  const tab = state.tabs.find((item) => item.docId === docId);
  // Hook 必须无条件执行：未打开文档时用空扩展名占位
  const viewer = useViewer(tab?.extension ?? '');
  if (!tab) return <div className="pane__empty">文档未打开</div>;

  const rendered = viewer.ok
    ? renderViewerSafely(viewer.viewer, { content: tab.buffer, path: tab.path })
    : null;

  return (
    <div className="preview">
      {!viewer.ok && (
        <div className="preview__error" role="alert">
          <strong>没有可用的查看器</strong>
          <div>{viewer.reason}</div>
          <div className="preview__error-hint">
            可在左侧「插件」中启用对应能力；文档内容与未保存修改不受影响。
          </div>
        </div>
      )}
      {viewer.ok && rendered && !rendered.ok && (
        <div className="preview__error" role="alert">
          <strong>查看器渲染失败</strong>
          <div>
            {rendered.errorCode}：{rendered.message}
          </div>
          <div className="preview__error-hint">文档内容与未保存修改不受影响。</div>
        </div>
      )}
      {viewer.ok && rendered?.ok && (
        <ViewerBoundary
          // 稳定身份 key：换文档或换查看器时必须重建边界。
          // 否则 state.message 一旦置位，切换到另一篇文档仍会显示旧错误。
          key={`${docId}:${viewer.providerId}`}
          providerId={viewer.providerId}
        >
          {rendered.node as ReactNode}
        </ViewerBoundary>
      )}
      <div className="preview__footer">
        {viewer.ok ? `查看器：${viewer.providerId}` : '查看器：无'}
        {tab.mode === 'live'
          ? ' · 预览由编辑缓冲实时渲染；磁盘内容以保存结果为准'
          : ' · 预览由演示缓冲实时渲染，不读取磁盘'}
      </div>
    </div>
  );
}
