/**
 * 「添加项目」入口 + 信任披露模态（UX-02B-04A）。
 *
 * 三条事实链在这里必须保持分离，不能"看起来像一条"：
 * 1. **本模态只是知情披露**（L0）：可以点取消，也可以在 DevTools 里直接跳过；
 *    跳过它并不会让 Host 多授予任何权限。
 * 2. 点「继续选择文件夹」之后才发 T1（会话令牌）与 T2（一次性意图）请求，
 *    它们只证明"来自本机页面"和"这次意图没被重放"。
 * 3. 真正的授权证据只有 T3：Host 在自己的进程里弹出系统对话框，拿到用户选中的
 *    真实路径并复核。**网页不提交、也提交不了任何路径**。
 *
 * 因此：非托管环境（Demo / Legacy / 静态配置 / 未知旧版）一律给**明确说明**，
 * 不弹假窗口、不假装成功、也不提供"手动输入绝对路径"这种绕过 T3 的入口。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { AddProjectResult, ProjectRegistrationSupport } from '../state/add-project.ts';
import { useDocumentActions } from '../state/DocumentActionsContext.tsx';
import { useWorkspace } from '../state/WorkspaceContext.tsx';

/** 非托管环境的说明：为什么不能添加，以及正当的下一步。 */
const SUPPORT_NOTES: Record<ProjectRegistrationSupport, string> = {
  managed: '',
  demo: '当前是演示模式：没有连接本地服务，因此不能选择本机文件夹。启动 Host 并切换到真实模式后再试。',
  legacy: '当前 Host 以单项目（Legacy）模式运行：根目录在启动时确定，界面里不能新增项目。请用 --workspace-store 以托管模式启动 Host。',
  static: '当前 Host 使用静态工作区配置：项目列表是只读的，界面里不能新增项目。请用 --workspace-store 以托管模式启动 Host。',
  unknown: '当前 Host 没有提供「添加项目」能力（可能是旧版本）：这次操作不会启动任何系统窗口。',
};

const UNKNOWN_SUPPORT = '正在确认当前环境能否添加项目…';

interface ResultView {
  tone: 'ok' | 'warn' | 'error';
  title: string;
  body: string;
}

function describe(result: AddProjectResult): ResultView {
  switch (result.kind) {
    case 'applied':
      return {
        tone: 'ok',
        title: `已添加「${result.project.name}」`,
        body: '项目已登记，左侧目录树正在读取它的根目录；不需要重启。',
      };
    case 'cancelled':
      return {
        tone: 'warn',
        title: '已取消选择',
        body: '你在系统窗口里取消了选择：没有添加任何项目，也没有记录任何授权。',
      };
    case 'busy':
      return { tone: 'warn', title: '已有一次添加正在进行', body: '请等当前这次选择结束再试。' };
    case 'stale':
      return {
        tone: 'warn',
        title: '工作区已切换',
        body: '这次选择的结果属于上一个工作区，已丢弃：项目列表没有被改动。',
      };
    case 'unsupported':
      return { tone: 'warn', title: '当前环境不能添加项目', body: SUPPORT_NOTES[result.support] };
    case 'rejected':
      return { tone: 'error', title: '没有添加这个文件夹', body: result.message };
    case 'failed':
      return { tone: 'error', title: '添加没有完成', body: result.message };
  }
}

export function AddProjectEntry() {
  const { state } = useWorkspace();
  const actions = useDocumentActions();
  const { flow } = actions.addProject;
  // 模态状态在纯 TS 编排器里：这里只订阅，不复制一份 React 状态
  const ui = useSyncExternalStore(flow.subscribe, flow.state);
  const [support, setSupport] = useState<ProjectRegistrationSupport | null>(null);

  // 进入界面就先问一次能力：让按钮的 title 与模态里的说明都有真实依据
  useEffect(() => {
    let cancelled = false;
    void actions.addProject.probe().then((next) => {
      if (!cancelled) setSupport(next);
    });
    return () => {
      cancelled = true;
    };
  }, [actions.addProject, state.mode, state.workspaceMode, state.workspaceKey]);

  const available = support === 'managed';
  const note = support === null ? UNKNOWN_SUPPORT : SUPPORT_NOTES[support];

  /**
   * 打开披露模态：**零请求**（PA-01）。
   * 同时再探测一次能力，避免"Host 重启成托管模式后按钮仍按旧答案说话"。
   */
  const onOpen = useCallback(() => {
    flow.open();
    void actions.addProject.probe().then(setSupport);
  }, [actions.addProject, flow]);

  const onConfirm = useCallback(() => {
    void flow.confirm();
  }, [flow]);

  const onDismiss = useCallback(() => {
    flow.dismiss();
  }, [flow]);

  return (
    <>
      <button
        type="button"
        className="chip chip--tiny tree__add"
        onClick={onOpen}
        title={available ? '选择一个本机文件夹作为新项目' : note || UNKNOWN_SUPPORT}
      >
        添加项目
      </button>

      {ui.phase !== 'closed' && (
        <div className="modal__backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="add-project-title">
            {ui.phase === 'disclosure' && (
              <>
                <h2 className="modal__title" id="add-project-title">
                  添加项目
                </h2>
                <p className="modal__lead">
                  接下来会让你选择一个本机文件夹作为项目根。继续之前，请先确认你已经了解下面三条：
                </p>
                <ol className="modal__list">
                  <li>WeaveSpace 可以浏览你接下来选择的这个文件夹及其所有子目录，并读取其中的文件内容。</li>
                  <li>这不代表允许自动运行程序、执行脚本，也不代表授予 AI 或任何插件权限。</li>
                  <li>你可以随时移除这个项目；移除不会删除磁盘上的任何文件。</li>
                </ol>
                {!available && (
                  <p className="modal__note" role="status">
                    {note}
                  </p>
                )}
                <p className="modal__hint">
                  选择窗口由本机 Host 弹出。网页不会、也不能提交文件夹路径，因此没有"直接填路径"的替代入口。
                </p>
                <div className="modal__actions">
                  <button type="button" className="chip chip--tiny" onClick={() => flow.cancel()}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="chip chip--tiny chip--primary"
                    onClick={onConfirm}
                    disabled={!available}
                    title={available ? undefined : note}
                  >
                    继续选择文件夹
                  </button>
                </div>
              </>
            )}

            {ui.phase === 'picking' && (
              <>
                <h2 className="modal__title" id="add-project-title">
                  请在系统窗口中选择文件夹
                </h2>
                <p className="modal__lead">
                  本机文件夹选择窗口已经打开。如果没看到它，请在任务栏里找一下（它可能被其它窗口挡住）。
                </p>
                <p className="modal__hint">
                  只有你在系统窗口里确认之后，这个目录才会被登记为项目；取消或关闭窗口不会产生任何改动。这里不提供「取消」按钮，因为系统窗口已经打开，关掉这个面板并不会关掉它。
                </p>
              </>
            )}

            {ui.phase === 'done' && (
              <ResultPanel result={ui.result} onDismiss={onDismiss} />
            )}
          </div>
        </div>
      )}
    </>
  );
}

function ResultPanel({ result, onDismiss }: { result: AddProjectResult; onDismiss(): void }) {
  const view = describe(result);
  return (
    <>
      <h2 className="modal__title" id="add-project-title">
        {view.title}
      </h2>
      <p className={view.tone === 'ok' ? 'modal__lead' : `modal__lead modal__lead--${view.tone}`}>{view.body}</p>
      <div className="modal__actions">
        <button type="button" className="chip chip--tiny chip--primary" onClick={onDismiss} autoFocus>
          好的
        </button>
      </div>
    </>
  );
}
