/**
 * 冲突恢复入口（S9B-C）。
 *
 * 只在活动标签处于 CONFLICT 时出现，提供三件事：
 * 1. 只读查看磁盘当前版本；
 * 2. 复制草稿（含 sessionStorage 备份，避免误丢弃后无从恢复）；
 * 3. 「重新加载」——必须经 `window.confirm` 明确确认，确认前草稿原样保留。
 *
 * 不做自动覆盖：即使磁盘更新，也由用户决定；`reloadFromDisk` 失败时草稿保持不变。
 */
import { useEffect, useState } from 'react';
import { useDocumentActions } from '../state/DocumentActionsContext';
import { useWorkspace } from '../state/WorkspaceContext';

export function ConflictBanner() {
  const { state } = useWorkspace();
  const actions = useDocumentActions();
  const activeDocId =
    state.focusedPane === 'secondary' ? state.panes.secondary.docId : state.panes.primary.docId;
  const tab = state.tabs.find((item) => item.docId === activeDocId) ?? null;
  const conflicted = Boolean(tab) && (tab?.documentState === 'CONFLICT' || tab?.lastStatus === 'CONFLICT');

  const [disk, setDisk] = useState<{ content: string; contentVersion: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 换文档或冲突状态变化时清空只读面板，避免展示上一次的内容
  useEffect(() => {
    setDisk(null);
    setError(null);
  }, [tab?.docId, tab?.baseVersion, conflicted]);

  if (!tab || !conflicted) return null;

  const onShowDisk = async (): Promise<void> => {
    setError(null);
    const result = await actions.fetchDiskVersion(tab.docId);
    if (result.ok) setDisk({ content: result.content, contentVersion: result.contentVersion });
    else setError(`无法读取磁盘版本：${result.errorCode ?? '未知错误'}`);
  };

  const onCopy = async (): Promise<void> => {
    const copied = await actions.copyDraft(tab.docId);
    setError(copied ? null : '剪贴板不可用：草稿已尝试备份到本标签页，也可手动选择复制');
  };

  const onReload = async (): Promise<void> => {
    setError(null);
    const ok = await actions.reloadFromDisk(tab.docId);
    if (!ok) setError('未重新加载：草稿保持不变');
  };

  return (
    <section className="conflict" role="alert" aria-label="版本冲突恢复">
      <div className="conflict__head">
        <strong className="conflict__title">版本冲突</strong>
        <span className="conflict__hint">
          磁盘已被外部修改，当前草稿未被覆盖。可直接保存为冲突（不覆盖磁盘），或按需重新加载磁盘版本。
        </span>
      </div>
      <div className="conflict__actions">
        <button type="button" className="chip" onClick={() => void onShowDisk()}>
          查看磁盘版本
        </button>
        <button type="button" className="chip" onClick={() => void onCopy()}>
          复制草稿
        </button>
        <button type="button" className="chip chip--primary" onClick={() => void onReload()}>
          重新加载（丢弃草稿）
        </button>
      </div>
      {error && <p className="conflict__error">{error}</p>}
      {disk && (
        <div className="conflict__disk">
          <div className="conflict__disk-meta">
            磁盘版本 {disk.contentVersion.slice(0, 19)}…（只读，不会改动磁盘）
          </div>
          <pre className="conflict__pre">{disk.content}</pre>
        </div>
      )}
    </section>
  );
}
