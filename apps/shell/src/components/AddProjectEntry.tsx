/**
 * 「添加项目」入口 + 信任披露模态（UX-02B-04A / R1）。
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
 *
 * R1-02：**点击入口只打开模态，不发任何请求**。能力探测发生在组件初始化 /
 * 模式变化 / 工作区变化时；探测未完成时明确显示"待确认"，且不允许继续。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { AddProjectResult, ProjectRegistrationSupport } from '../state/add-project.ts';
import { DISCLOSURE_LEAD, DISCLOSURE_POINTS } from '../state/add-project.ts';
import { useDocumentActions } from '../state/DocumentActionsContext.tsx';
import { useWorkspace } from '../state/WorkspaceContext.tsx';

/** 非托管环境的说明：为什么不能添加，以及正当的下一步。 */
const SUPPORT_NOTES: Record<ProjectRegistrationSupport, string> = {
  managed: '',
  demo: '当前是演示模式：没有连接本地服务，因此不能选择本机文件夹。启动 Host 并切换到真实模式后再试。',
  legacy: '当前 Host 以单项目（Legacy）模式运行：根目录在启动时确定，界面里不能新增项目。请用 --workspace-store 以托管模式启动 Host。',
  static: '当前 Host 使用静态工作区配置：项目列表是只读的，界面里不能新增项目。请用 --workspace-store 以托管模式启动 Host。',
  unknown: '暂时无法确认当前环境能不能添加项目（本地服务可能未连接，或 Host 版本较旧）：这次操作不会启动任何系统窗口。',
};

/** 探测尚未结束时**不能**继续：这里说清楚"还没确认"，而不是暗示"应该可以"。 */
const PENDING_NOTE = '正在确认当前环境能否添加项目…确认完成前不能继续。';

interface ResultView {
  tone: 'ok' | 'warn' | 'error';
  title: string;
  body: string;
  /** 是否提供"只读核对"：只有"已注册未同步"与"结果未知"需要。 */
  canResync: boolean;
}

/**
 * 结果 → 界面文案。
 *
 * 关键区分（R1-03）：`registered-unsynced` / `unknown` **都**不能说成"添加失败"：
 * - 前者 Host 已经登记，只是页面没同步，重新选择同一目录只会撞上"重复根"；
 * - 后者连"有没有登记"都不知道，任何断言都是编造。
 */
function describe(result: AddProjectResult): ResultView {
  switch (result.kind) {
    case 'applied':
      return {
        tone: 'ok',
        title: `已添加「${result.project.name}」`,
        body: '项目已登记，左侧目录树正在读取它的根目录；不需要重启。',
        canResync: false,
      };
    case 'registered-unsynced':
      return {
        tone: 'warn',
        title: '项目已注册，但页面尚未同步',
        body: `${result.message}。「${result.project.name}」已经在 Host 端登记，不需要重新选择文件夹，点「重新读取」即可把列表同步过来。`,
        canResync: true,
      };
    case 'unknown':
      return {
        tone: 'warn',
        title: '暂时无法确认这次选择的结果',
        body: `${result.message}。这里没有重新提交选择请求，也没有据此认定"没有添加"：可以点「重新读取」核对项目列表，如果系统窗口还开着，请先在任务栏里处理它。`,
        canResync: true,
      };
    case 'cancelled':
      return {
        tone: 'warn',
        title: '已取消选择',
        body: '你在系统窗口里取消了选择：没有添加任何项目，也没有记录任何授权。',
        canResync: false,
      };
    case 'busy':
      return {
        tone: 'warn',
        title: '已有一次添加正在进行',
        body: '请等当前这次选择结束再试。',
        canResync: false,
      };
    case 'stale':
      return {
        tone: 'warn',
        title: '工作区已切换',
        body: '这次选择的结果属于上一个工作区，已丢弃：项目列表没有被改动。',
        canResync: false,
      };
    case 'unsupported':
      return {
        tone: 'warn',
        title: '当前环境不能添加项目',
        body: SUPPORT_NOTES[result.support],
        canResync: false,
      };
    case 'rejected':
      return { tone: 'error', title: '没有添加这个文件夹', body: result.message, canResync: false };
    case 'failed':
      return { tone: 'error', title: '添加没有完成', body: result.message, canResync: false };
  }
}

export function AddProjectEntry() {
  const { state, dispatch } = useWorkspace();
  const actions = useDocumentActions();
  const { flow } = actions.addProject;
  // 模态状态在纯 TS 编排器里：这里只订阅，不复制一份 React 状态
  const ui = useSyncExternalStore(flow.subscribe, flow.state, flow.state);
  /**
   * 能力探测结果同样来自句柄（R1-02）：`null` 表示"还没问出答案"。
   * 用外部存储而不是本地 state，是因为两个树组件会分别挂载，答案必须共享。
   */
  const support = useSyncExternalStore(
    actions.addProject.subscribeSupport,
    actions.addProject.support,
    actions.addProject.support,
  );

  /**
   * 只在**初始化 / 模式变化 / 工作区变化**时探测：点击入口不再探测（PA-01）。
   * `invalidate` 让界面先回到"待确认"，再等这一次探测给答案 —— 不沿用旧答案，
   * 否则 Host 从 Legacy 变成托管后，界面会一直按旧结论说话。
   */
  useEffect(() => {
    actions.addProject.invalidateSupport();
    void actions.addProject.probe();
  }, [actions.addProject, state.mode, state.workspaceMode, state.workspaceKey]);

  const pending = support === null;
  const available = support === 'managed';
  const note = pending ? PENDING_NOTE : SUPPORT_NOTES[support];

  /** 用户显式要求重新确认（不是自动重试）：只读探测，不会启动任何窗口。 */
  const reprobe = useCallback(() => {
    actions.addProject.invalidateSupport();
    void actions.addProject.probe();
  }, [actions.addProject]);

  /** 打开披露模态：**零请求**（PA-01）。 */
  const onOpen = useCallback(() => {
    flow.open();
  }, [flow]);

  const onConfirm = useCallback(() => {
    void flow.confirm();
  }, [flow]);

  const onDismiss = useCallback(() => {
    flow.dismiss();
  }, [flow]);

  const [resyncing, setResyncing] = useState(false);
  const [resyncError, setResyncError] = useState<string | null>(null);

  /**
   * 只读核对：重新读取 /api/projects（与 /api/health 的摘要）。
   * 不重发 pick、不弹窗口；成功后关闭面板，列表会自己长出项目行。
   */
  const onResync = useCallback(
    async (projectId?: string) => {
      if (resyncing) return;
      setResyncing(true);
      setResyncError(null);
      const outcome = await actions.addProject.resync(projectId);
      setResyncing(false);
      if (outcome.ok) {
        flow.dismiss();
        dispatch({ type: 'NOTICE', message: '已重新读取项目列表' });
        return;
      }
      setResyncError(outcome.message);
    },
    [actions.addProject, dispatch, flow, resyncing],
  );

  return (
    <>
      <button
        type="button"
        className="chip chip--tiny tree__add"
        onClick={onOpen}
        title={pending ? PENDING_NOTE : available ? '选择一个本机文件夹作为新项目' : note}
      >
        添加项目
      </button>

      {ui.phase !== 'closed' && (
        <div className="modal__backdrop" role="presentation">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-project-title"
            // 供真实浏览器验证断言"待确认 / 明确答案"这两种状态
            data-add-project={ui.phase === 'disclosure' ? (pending ? 'probing' : support) : ui.phase}
          >
            {ui.phase === 'disclosure' && (
              <>
                <h2 className="modal__title" id="add-project-title">
                  添加项目
                </h2>
                <p className="modal__lead">{DISCLOSURE_LEAD}</p>
                <ol className="modal__list">
                  {DISCLOSURE_POINTS.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
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
                  {support === 'unknown' && !pending && (
                    <button type="button" className="chip chip--tiny" onClick={reprobe}>
                      重新确认环境
                    </button>
                  )}
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
                    {pending ? '确认环境后再继续' : '继续选择文件夹'}
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
              <ResultPanel
                result={ui.result}
                onDismiss={onDismiss}
                onResync={onResync}
                resyncing={resyncing}
                resyncError={resyncError}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}

function ResultPanel({
  result,
  onDismiss,
  onResync,
  resyncing,
  resyncError,
}: {
  result: AddProjectResult;
  onDismiss(): void;
  onResync(projectId?: string): void;
  resyncing: boolean;
  resyncError: string | null;
}) {
  const view = describe(result);
  const projectId = result.kind === 'registered-unsynced' ? result.project.projectId : undefined;
  return (
    <>
      <h2 className="modal__title" id="add-project-title">
        {view.title}
      </h2>
      <p className={view.tone === 'ok' ? 'modal__lead' : `modal__lead modal__lead--${view.tone}`}>{view.body}</p>
      {resyncError && <p className="modal__lead modal__lead--error">{resyncError}</p>}
      <div className="modal__actions">
        {view.canResync && (
          <button
            type="button"
            className="chip chip--tiny"
            onClick={() => onResync(projectId)}
            disabled={resyncing}
          >
            {resyncing ? '正在读取…' : '重新读取'}
          </button>
        )}
        <button type="button" className="chip chip--tiny chip--primary" onClick={onDismiss} autoFocus>
          好的
        </button>
      </div>
    </>
  );
}
