/**
 * 项目移除入口与确认模态（UX-02B-04B）。
 *
 * 交互纪律（ADR-023 §5 / docs/26 PB-01…PB-10）：
 * - 打开时先做**只读前置检查**，有活动标签/危险状态时只显示阻断原因与引导动作，
 *   **不提供绕过检查的强制移除按钮**；
 * - 确认文案必须写明"只从工作台移除，不删除磁盘上的任何文件"；
 * - 不得自动关闭未保存文件、丢弃草稿或强制保存；
 * - 只有 Host 明确撤销后才从列表移除；结果不确定时提示人工核对，**不自动重试**。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectSummary, RemoveBlockerCode } from '../client/client-api.ts';
import { useDocumentActions } from '../state/DocumentActionsContext.tsx';
import type { RemoveUiResult } from '../state/remove-project.ts';

type Phase = 'closed' | 'checking' | 'ready' | 'blocked' | 'removing' | 'result';

const BLOCKER_TEXT: Record<RemoveBlockerCode, string> = {
  ACTIVE_VIEWS: '该项目下还有文件正打开着。请先关闭这些文件，再移除项目。',
  DIRTY: '该项目下有未保存的修改。请先保存（或按你的意愿处理）后再移除。',
  SAVING: '该项目下有文件正在保存。请稍候再试。',
  OUTCOME_UNKNOWN: '该项目下有文件的保存结果尚未确认。请先处理这些提示。',
  CONFLICT: '该项目下有文件存在冲突。请先解决冲突。',
  IN_FLIGHT_DISK_OPS: '该项目上还有正在进行的磁盘操作。请稍候再试。',
  DRAIN_TIMEOUT: '磁盘操作未在时限内结束。请稍候再试。',
};

function blockedText(blockedBy: readonly RemoveBlockerCode[], state: string): string[] {
  if (state === 'REVOKE_UNKNOWN') {
    return ['该项目上一次撤销的结果尚待核对，暂时不能再次移除。请重启 Host 或等待核对完成。'];
  }
  if (blockedBy.length === 0) return ['当前状态不允许移除该项目。'];
  return blockedBy.map((code) => BLOCKER_TEXT[code] ?? `存在阻断原因：${code}`);
}

export function RemoveProjectEntry({ project }: { project: ProjectSummary }) {
  const actions = useDocumentActions();
  const [phase, setPhase] = useState<Phase>('closed');
  const [blocked, setBlocked] = useState<{ reasons: string[] } | null>(null);
  const [result, setResult] = useState<
    { tone: 'ok' | 'warn' | 'error'; title: string; body: string } | null
  >(null);

  const close = useCallback(() => {
    setPhase('closed');
    setBlocked(null);
    setResult(null);
  }, []);

  /**
   * 在途标记用 ref（而不是 `phase`）：`setPhase('removing')` 要等一次渲染才生效，
   * 手快连点两次会在同一个 tick 里都读到 `phase === 'ready'`，从而发出两次确认。
   * 编排层还有一层"同项目复用同一 promise"的兜底，两处都不依赖渲染时序。
   */
  const confirming = useRef(false);

  const open = useCallback(async () => {
    setPhase('checking');
    setBlocked(null);
    setResult(null);
    const pre = await actions.removalPrecheck(project.projectId);
    if (pre.status === 'APPLIED' && pre.allowed) {
      setPhase('ready');
      return;
    }
    if (pre.status === 'APPLIED') {
      setBlocked({ reasons: blockedText(pre.blockedBy, pre.state) });
    } else {
      setBlocked({ reasons: [pre.message || '当前无法移除该项目'] });
    }
    setPhase('blocked');
  }, [actions, project.projectId]);

  const confirm = useCallback(async () => {
    if (phase !== 'ready' || confirming.current) return;
    confirming.current = true;
    setPhase('removing');
    let outcome: RemoveUiResult;
    try {
      outcome = await actions.removeProject(project.projectId);
    } catch {
      /**
       * 兜底：编排层已经把断线/超时收敛成 `unknown`，这里再挡一层，
       * 保证模态绝不会永久停在"正在移除…"（用户连"好的"都点不到）。
       */
      setResult({
        tone: 'warn',
        title: '移除结果待核对',
        body: '与本地服务的连接中断，无法确认本次移除是否生效。请刷新页面核对（不会自动重试移除）。',
      });
      setPhase('result');
      return;
    } finally {
      confirming.current = false;
    }
    if (outcome.kind === 'removed') {
      // 项目已从列表移除：组件会随 ProjectRoot 卸载；这里收敛状态即可
      setResult({
        tone: outcome.configPersisted === false ? 'warn' : 'ok',
        title: '已移除项目',
        body:
          outcome.configPersisted === false
            ? '撤销已生效，项目已不可访问；配置补写待完成，磁盘上的文件没有被删除。'
            : outcome.configPersisted === null
              ? '该项目已从工作台移除（已按操作编号核对：撤销生效）。磁盘上的文件没有被删除或修改。'
              : '该项目已从工作台移除。磁盘上的文件没有被删除或修改。',
      });
      setPhase('result');
      return;
    }
    if (outcome.kind === 'blocked') {
      setBlocked({ reasons: blockedText(outcome.blockedBy, outcome.state) });
      setPhase('blocked');
      return;
    }
    if (outcome.kind === 'unknown') {
      setResult({ tone: 'warn', title: '移除结果待核对', body: outcome.message });
      setPhase('result');
      return;
    }
    // unsupported / failed
    setResult({
      tone: 'error',
      title: '未能移除',
      body: outcome.message,
    });
    setPhase('result');
  }, [actions, phase, project.projectId]);

  useEffect(() => {
    if (phase === 'closed') return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && (phase === 'ready' || phase === 'blocked')) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, close]);

  return (
    <>
      <button
        type="button"
        className="icon-button project__refresh project__remove"
        title={`从工作台移除「${project.name}」（不会删除磁盘文件）`}
        aria-label={`从工作台移除「${project.name}」`}
        onClick={() => void open()}
      >
        🗑
      </button>

      {phase !== 'closed' &&
        createPortal(
          <div className="modal__backdrop" role="presentation">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-project-title"
            data-remove-project={phase}
          >
            <h2 className="modal__title" id="remove-project-title">
              移除项目「{project.name}」
            </h2>

            {phase === 'checking' && (
              <p className="modal__lead" role="status">
                正在检查是否可以安全移除…
              </p>
            )}

            {phase === 'ready' && (
              <>
                <p className="modal__lead">
                  移除只会从 WeaveSpace 工作台移除该项目，不会删除磁盘上的任何文件。
                </p>
                <ol className="modal__list">
                  <li>磁盘上该文件夹及其内容保持原样，不被删除、移动或修改。</li>
                  <li>移除后该项目不再出现在工作台，也不会再被读取。</li>
                  <li>若将来需要，可以重新添加这个文件夹（会作为一个新项目）。</li>
                </ol>
                <div className="modal__actions">
                  <button type="button" className="chip chip--tiny" onClick={close}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="chip chip--tiny chip--primary"
                    data-remove-confirm="true"
                    onClick={() => void confirm()}
                  >
                    确认移除
                  </button>
                </div>
              </>
            )}

            {phase === 'blocked' && (
              <>
                <p className="modal__lead modal__lead--error" role="alert">
                  现在不能移除：请先处理下列情况。
                </p>
                <ol className="modal__list">
                  {(blocked?.reasons ?? ['当前状态不允许移除该项目。']).map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ol>
                <p className="modal__hint">
                  为保护未保存的内容，这里不提供"强制移除"。处理好之后可以再次尝试。
                </p>
                <div className="modal__actions">
                  <button type="button" className="chip chip--tiny chip--primary" onClick={close}>
                    好的
                  </button>
                </div>
              </>
            )}

            {phase === 'removing' && (
              <p className="modal__lead" role="status">
                正在移除…
              </p>
            )}

            {phase === 'result' && result && (
              <>
                <p
                  className={
                    result.tone === 'ok'
                      ? 'modal__lead'
                      : `modal__lead modal__lead--${result.tone}`
                  }
                >
                  {result.body}
                </p>
                <div className="modal__actions">
                  <button type="button" className="chip chip--tiny chip--primary" onClick={close} autoFocus>
                    好的
                  </button>
                </div>
              </>
            )}
          </div>
          </div>,
          // 用 portal 挂到 body：项目行在树里（有 overflow/裁剪与堆叠上下文），
          // 原地渲染会让 position:fixed 的模态被裁掉，用户看不到阻断/确认框。
          document.body,
        )}
    </>
  );
}
