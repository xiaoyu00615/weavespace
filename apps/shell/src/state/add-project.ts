/**
 * 添加项目：信任披露 → T1/T2/T3 目录选择 → 持久注册 → 立即可用（UX-02B-04A）。
 *
 * 为什么单独抽一个纯 TS 模块：
 * - 这条链路横跨"披露模态 / 一次性意图 / Host 进程内对话框 / 项目表刷新 / 工作区摘要"，
 *   塞进组件里就只能靠源码字符串断言，无法证明"点两下不会弹两个窗口"这类时序性质；
 * - 这里不 import React，也不直接 fetch：所有外部能力经 `AddProjectPort` 注入，
 *   测试可以用确定性替身把"新请求先返回、旧请求后返回"这类顺序真正演一遍。
 *
 * 三条不可混淆的事实链（与 ADR-021 一致）：
 * 1. L0 披露模态（本模块的 `disclosure` 阶段）只是**知情披露**，可以被脚本跳过；
 * 2. `token` + `intentId` 只证明"来自本机页面"与"这次意图没被重放"；
 * 3. 只有 Host 内部选择器返回的真实路径（T3）才产生授权 —— 浏览器永远不提供路径，
 *    本模块的请求体里也不会出现 rootDir / path / grantSource 之类的字段。
 */
import { ACKNOWLEDGE_SCOPE } from '../client/client-api.ts';
import type {
  PickQueryOutcome,
  PickStartOutcome,
  ProjectRegistrationSupport,
  ProjectSummary,
} from '../client/client-api.ts';
import type { ClientMode } from './types.ts';

/**
 * 协议形状定义在 `client/client-api.ts`（它是唯一的线上契约所在地），
 * 这里只做转发，避免出现两份"看起来一样"的标记常量。
 */
export { ACKNOWLEDGE_SCOPE };
export type { PickQueryOutcome, PickStartOutcome, ProjectRegistrationSupport };

/**
 * 信任披露正文（R1-01）。
 *
 * 放在纯 TS 里而不是 JSX 里，是为了让"披露到底说了什么"可以被断言：
 * 浏览范围 / 读取与保存 / 执行边界 / 可撤销 —— 少任何一条，
 * 用户在点「继续选择文件夹」时的知情程度就不成立。
 *
 * 措辞边界：既不能夸大（"可以访问你的所有文件"），也不能含糊到让人以为
 * "选了文件夹就等于允许执行程序"。保存必须写进来，否则用户不知道这是可写的授权。
 */
export const DISCLOSURE_LEAD =
  '接下来会让你选择一个本机文件夹作为项目根。继续之前，请先确认你已经了解下面三条：';

export const DISCLOSURE_POINTS = [
  'WeaveSpace 可以浏览你接下来选择的文件夹及其所有子目录，并在授权范围内读取和保存文件。',
  '这不代表允许自动运行程序、执行脚本，也不代表授予 AI 或任何插件权限。',
  '你可以随时移除这个项目；移除不会删除磁盘上的任何文件。',
] as const;

/**
 * 外部能力（由 `client-api` 适配）。
 *
 * 刻意做成四个窄方法而不是直接传 `WeaveSpaceClient`：这样测试不必实现整个客户端，
 * 也不会有人顺手在这里调用与添加项目无关的接口。
 */
export interface AddProjectPort {
  /** T1 + T2 引导。`intentId === null` 表示当前 Host 不发放意图（静态 / Legacy）。 */
  bootstrap(): Promise<{ token: string; intentId: string | null }>;
  /** 启动 Host 进程内的本机选择器（T3 入口）。 */
  startPick(input: {
    token: string;
    intentId: string;
    acknowledgeScope: typeof ACKNOWLEDGE_SCOPE;
    name?: string;
  }): Promise<PickStartOutcome>;
  /** 按 requestId 查询选择结果。 */
  queryPick(input: { token: string; requestId: string }): Promise<PickQueryOutcome>;
  /** APPLIED 之后重新取项目表（Host 是权威）。 */
  listProjects(): Promise<ProjectSummary[]>;
  /** 工作区摘要：项目集合变化后由 Host 重算，用于恢复记录匹配。 */
  workspaceKey(): Promise<string | null>;
}

export type AddProjectResult =
  | { kind: 'applied'; project: ProjectSummary }
  | { kind: 'cancelled' }
  | { kind: 'rejected'; errorCode: string | null; message: string; httpStatus: number }
  | { kind: 'unsupported'; support: ProjectRegistrationSupport }
  /** 已有一次添加在途：**没有**发任何请求。 */
  | { kind: 'busy' }
  /** 工作区已经变了（切模式 / 重连 / 换了摘要）：结果已丢弃，界面未改动。 */
  | { kind: 'stale' }
  /**
   * Host 已明确 `APPLIED`（项目确实登记进工作区了），但 Shell 侧同步没走完：
   * 项目表读取或根层加载失败。**不能**说成"添加失败" —— 那会诱导用户
   * 重新选一次同一个文件夹，撞上重复根，反而更难恢复。
   */
  | { kind: 'registered-unsynced'; project: ProjectSummary; message: string }
  /**
   * 结果未知：轮询中断、等待超时、或流程内部异常。
   * 此时**既不能**说"已添加"**也不能**说"没添加"，更**不能**自动重发 pick
   * （那可能弹出第二个系统窗口）；只允许用户发起只读核对。
   */
  | { kind: 'unknown'; message: string }
  /** 确定没有发起授权：例如连不上 Host（`bootstrap` 是只读 GET，没有副作用）。 */
  | { kind: 'failed'; message: string };

export interface AddProjectHost {
  port: AddProjectPort;
  /**
   * 发起时的身份快照；每次 await 之后都要再问一次。
   *
   * `epoch` 是**加载代次**（见 `workspace-load.ts` 的 `LoadEpoch`）：模式切换、
   * Host 重连、切换工作区都会让它 +1，旧代次永远过期。归属判定以它为权威，而不是
   * 比较 `workspaceKey` —— 因为**本次提交本身**就会让 `workspaceKey` 变化（Host APPLIED
   * 后摘要必然改变），把它当成"外部切换"会误杀正常的添加（R2-02）。
   */
  identity(): { mode: ClientMode; workspaceKey: string | null; epoch: number };
  onProjects(projects: ProjectSummary[]): void;
  onWorkspaceKey(key: string | null): void;
  /** 新项目的根层（UI 立刻可展开）。 */
  loadRoot(projectId: string): Promise<void>;
  wait?(ms: number): Promise<void>;
  now?(): number;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface ProjectAdder {
  add(name?: string): Promise<AddProjectResult>;
  busy(): boolean;
}

/**
 * 错误码 → 用户能读懂的一句话。
 *
 * 优先用这张表而不是 Host 的 `message`：Host 的文案面向"配置/协议"，
 * 例如重复根会写成"工作区配置中存在重复的项目根"，对本机对话框场景是误导。
 * 所有文案都不含路径，也不暗示"可以手动输入路径绕过"。
 */
const REJECT_MESSAGES: Record<string, string> = {
  ERR_COMMAND_UNSUPPORTED: '当前模式下不能添加项目',
  ERR_PICKER_UNAVAILABLE: '当前环境无法打开系统文件夹选择窗口，因此无法添加项目',
  ERR_PICKER_BUSY: '已经有一次文件夹选择正在进行，请等它结束',
  ERR_INTENT_EXPIRED: '这次选择已过期，请重新点击「添加项目」',
  ERR_INTENT_CONSUMED: '这次选择已经被使用过，请重新点击「添加项目」',
  ERR_INTENT_INVALID: '选择请求无效，请重新点击「添加项目」',
  ERR_PICK_REQUEST_GONE: '选择结果已不存在（Host 可能已重启），请重新点击「添加项目」',
  ERR_PROJECT_DUPLICATE_ROOT: '这个文件夹已经在项目列表里了',
  ERR_PROJECT_NESTED_ROOT: '这个文件夹与已有项目互相包含，不能重复添加',
  ERR_PROJECT_UNAVAILABLE: '这个文件夹当前不可用',
  ERR_PROJECT_BUSY: 'Host 正在处理其它项目变更，请稍后再试',
  ERR_PERMISSION_DENIED: '请求未被信任，请从 WeaveSpace 页面重新操作',
  ERR_STORE_LOCKED: '工作区存储被另一个 Host 占用',
  ERR_STORE_RESTRICTED: '工作区存储处于受限状态，暂时不能添加项目',
};

function messageFor(errorCode: string | null | undefined, fallback?: string): string {
  const known = errorCode ? REJECT_MESSAGES[errorCode] : undefined;
  if (known) return known;
  if (fallback && fallback.trim() !== '') return fallback;
  return '添加项目失败，请稍后重试';
}

/**
 * 编排一次完整的添加。
 *
 * 单飞（`busy()`）在这里而不只在按钮上：只要有一次在途，第二次调用直接返回
 * `busy` 且**一个请求都不发** —— 否则连点两下会在 Host 侧撞出第二个选择器。
 */
export function createProjectAdder(host: AddProjectHost): ProjectAdder {
  const wait = host.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = host.now ?? (() => Date.now());
  const pollIntervalMs = host.pollIntervalMs ?? 300;
  const timeoutMs = host.timeoutMs ?? 180_000;
  let inFlight = false;

  return {
    busy: () => inFlight,
    async add(name?: string): Promise<AddProjectResult> {
      if (inFlight) return { kind: 'busy' };
      inFlight = true;
      // 身份在**发起时**固定：之后每一次 await 都用它比对，迟到的结果一律丢弃。
      // 必须**按值拷贝**：`identity()` 通常返回状态对象本身，直接持有引用会让
      // "快照"跟着后续改动一起变，归属判定就永远为真（R1-02 同类陷阱）。
      const began = host.identity();
      const origin = { mode: began.mode, workspaceKey: began.workspaceKey, epoch: began.epoch };
      /**
       * 归属判定以**加载代次**为权威（R2-02）。
       *
       * 不能用 `workspaceKey` 比对：本次 Host APPLIED 之后 `onWorkspaceKey` 会**合法地**
       * 把界面摘要更新成新值，此时 `current.workspaceKey !== origin.workspaceKey` 纯属
       * "我们自己提交造成的转移"，不是外部切换。若用 key 比对，正常的添加会被误判成
       * `stale` 而丢失。
       *
       * 外部切模式 / 重连 / 切换其它工作区都会让 `LoadEpoch` +1，旧代次立即过期——
       * 这一条同时覆盖了"代次变了但 mode 仍是 live"的替换场景（R2-01 同款机制）。
       */
      const stale = (): boolean => {
        const current = host.identity();
        return origin.mode !== 'live' || current.mode !== 'live' || current.epoch !== origin.epoch;
      };

      /**
       * Host 已经 APPLIED：从这里开始只剩"把结果搬进界面"。
       *
       * 三个副作用（项目表 / 根层 / 工作区摘要）各自都可能失败，但它们**都不改变
       * "Host 已经登记了这个项目"这个事实**。因此这一段的异常必须收敛成
       * `registered-unsynced`（可以只读恢复），而不是 `failed` —— 后者会让用户
       * 重新选同一个文件夹，撞上"重复根"，把一个可恢复的状态变成更难收拾的状态。
       */
      const settleApplied = async (project: ProjectSummary | undefined): Promise<AddProjectResult> => {
        if (!project) {
          // 没有摘要就无法做界面同步；但 Host 说 APPLIED，注册事实仍然成立
          return { kind: 'unknown', message: 'Host 报告已登记，但没有返回项目信息' };
        }

        let unsynced: string | null = null;
        try {
          const projects = await host.port.listProjects();
          if (stale()) return { kind: 'stale' };
          host.onProjects(projects);
        } catch {
          unsynced = '项目已注册，但读取项目列表失败';
        }

        if (unsynced === null) {
          /**
           * 顺序不可交换：**先读根层，再更新工作区摘要**。
           *
           * `workspaceKey` 覆盖"项目集合 + 规范根 + 根身份令牌"，添加项目必然改变它；
           * 而逐层加载的归属票据会在提交时比对 `workspaceKey`。若先更新摘要，根层请求
           * 的票据在返回时就已经过期，结果会被当作"上一个工作区的迟到响应"丢弃 ——
           * 界面于是出现"项目加进来了，但点开是空的"。
           */
          try {
            await host.loadRoot(project.projectId);
          } catch {
            unsynced = '项目已注册，但新项目的目录树暂时读取失败';
          }
        }

        /**
         * 摘要只用于恢复记录匹配：取不到或写不进都不改变"项目已添加"这个结论，
         * 下一次 `/api/health` 会给出正确摘要。但**写入时必须仍然属于同一个工作区**，
         * 否则会把旧工作区的摘要盖到新工作区上。
         */
        try {
          const key = await host.port.workspaceKey();
          if (!stale()) host.onWorkspaceKey(key);
        } catch {
          // 保持原值即可
        }

        if (stale()) return { kind: 'stale' };
        if (unsynced) return { kind: 'registered-unsynced', project, message: unsynced };
        return { kind: 'applied', project };
      };

      try {
        let boot: { token: string; intentId: string | null };
        try {
          boot = await host.port.bootstrap();
        } catch {
          // `bootstrap` 是只读 GET（令牌 + 意图），失败时确定没有启动任何选择器
          return { kind: 'failed', message: '无法连接本地服务：请先启动 Host' };
        }
        if (stale()) return { kind: 'stale' };
        if (!boot.intentId) {
          // 防御：正常流程会在进到这里之前就按 support() 判定"不支持"，
          // 但 Host 也可能在能力探测之后才降级。没有意图就绝不发 pick 请求。
          return { kind: 'unsupported', support: 'unknown' };
        }

        let started: PickStartOutcome;
        try {
          started = await host.port.startPick({
            token: boot.token,
            intentId: boot.intentId,
            acknowledgeScope: ACKNOWLEDGE_SCOPE,
            ...(name && name.trim() !== '' ? { name: name.trim() } : {}),
          });
        } catch {
          /**
           * 传输层失败 ≠ 没有发起：请求可能已经到了 Host，窗口可能已经弹出来。
           * 因此这里只能说"未知"，不能说"失败"，更不能重发（会撞上第二个窗口）。
           */
          return {
            kind: 'unknown',
            message: '无法确认选择窗口是否已经打开：请先在任务栏确认有没有多出文件夹窗口，再回来核对项目列表',
          };
        }
        if (stale()) return { kind: 'stale' };
        if (started.status !== 'PENDING' || !started.requestId) {
          return {
            kind: 'rejected',
            errorCode: started.errorCode ?? null,
            message: messageFor(started.errorCode, started.message),
            httpStatus: started.httpStatus,
          };
        }

        const requestId = started.requestId;
        const deadline = now() + timeoutMs;
        for (;;) {
          let state: PickQueryOutcome;
          try {
            state = await host.port.queryPick({ token: boot.token, requestId });
          } catch {
            // 轮询中断：用户可能已经把窗口关掉、也可能刚点完确定。结果不可知。
            return {
              kind: 'unknown',
              message: '与本地服务的连接中断，暂时无法确认这次选择的结果',
            };
          }
          if (stale()) return { kind: 'stale' };

          if (state.status === 'APPLIED') {
            return await settleApplied(state.project);
          }
          if (state.status === 'CANCELLED') return { kind: 'cancelled' };
          if (state.status === 'REJECTED') {
            return {
              kind: 'rejected',
              errorCode: state.errorCode ?? null,
              message: messageFor(state.errorCode, state.message),
              httpStatus: state.httpStatus,
            };
          }
          if (now() >= deadline) {
            // 超时不等于"没添加"：用户可能还开着窗口，稍后才点确定。
            return {
              kind: 'unknown',
              message: '等待选择结果超时：系统窗口可能仍在后台，这次选择的最终结果暂时未知',
            };
          }
          try {
            await wait(pollIntervalMs);
          } catch {
            // 等待函数异常（被注入的宿主依赖炸了）：流程只能收敛为"未知"
            return { kind: 'unknown', message: '等待选择结果时流程中断：这次选择的结果暂时未知' };
          }
          if (stale()) return { kind: 'stale' };
        }
      } finally {
        inFlight = false;
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* 只读重新同步（R2-01）                                                */
/* ------------------------------------------------------------------ */

/**
 * 重新同步的宿主依赖（由 `DocumentActionsContext` 注入）。
 *
 * 与添加流程共用同一套"加载代次"归属机制（`identity().epoch` + `isCurrent`）：
 * Demo/Live 切换、Host 重连、工作区被替换都会让代次失效，旧 resync **不得**回填
 * 项目列表、目录树或工作区摘要。这里不复制任何状态机——归属判定完全交给调用方
 * 提供的 `isCurrent`，与逐层加载、工作区加载链同一条代次。
 */
export interface ResyncHost {
  port: AddProjectPort;
  /** 与 `AddProjectHost.identity()` 同形状；resync 在发起时固定捕获。 */
  identity(): { mode: ClientMode; workspaceKey: string | null; epoch: number };
  /** 给定的代次令牌是否仍是当前代（切模式 / 重连 / 换工作区都会失效）。 */
  isCurrent(epoch: number): boolean;
  onProjects(projects: ProjectSummary[]): void;
  onWorkspaceKey(key: string | null): void;
  loadRoot(projectId: string): Promise<void>;
  /** 返回"根层从未加载"的项目 id：未指定 projectId 时这些项目需要补齐（避免显示成空目录）。 */
  missingRoots(projects: ProjectSummary[]): string[];
}

/**
 * 只读核对（R1-03 / R2-01）。
 *
 * 用于「已注册但未同步」与「结果未知」之后的恢复：**不重发 pick、不弹窗口、
 * 不改任何授权**——用户不需要重新选择同一个文件夹。
 *
 * 纪律（与 `settleApplied` 一致，且复用其代次归属机制）：
 * - 只在 `live` 模式有意义；Demo 直接拒绝；
 * - 请求开始捕获代次，每个 await 返回之后重新核对；过期结果一律不回填；
 * - 指定 `projectId` 时只补那一个根层；未指定时补齐**缺失**根层（从未加载的），
 *   不让"还没读根层"被误显示成空目录；
 * - 末尾 `onWorkspaceKey` 带来的摘要更新属于合法状态转移，不依赖 React dispatch
 *   的异步时机来判定正确性（代次在读取期间没有变化就一定是本工作区的数据）。
 */
export function createResyncRunner(host: ResyncHost) {
  return async function resync(projectId?: string): Promise<ResyncOutcome> {
    const origin = host.identity();
    if (origin.mode !== 'live') {
      return { ok: false, message: '演示模式没有真实项目列表' };
    }
    // 捕获本次读取所属代次；期间任何一代变化都让结果作废
    const epoch = origin.epoch;
    const current = (): boolean => {
      const id = host.identity();
      return id.mode === 'live' && host.isCurrent(epoch);
    };

    let projects: ProjectSummary[];
    try {
      projects = await host.port.listProjects();
    } catch {
      return { ok: false, message: '仍然无法连接本地服务：请确认 Host 正在运行' };
    }
    // 读取期间工作区已变：结果不属于当前界面，绝不回填
    if (!current()) return { ok: false, message: '工作区已切换，已取消重新读取' };
    host.onProjects(projects);

    // 需要补根层的项目集合：指定时只补那一个；未指定时补齐"从未加载"的根层
    const targets = projectId
      ? (projects.some((project) => project.projectId === projectId) ? [projectId] : [])
      : host.missingRoots(projects);

    for (const pid of targets) {
      try {
        await host.loadRoot(pid);
      } catch {
        // 根层读不到不致命：项目行已经在列表里
      }
      // 补根层期间工作区也可能被换走：这一层的迟到响应不得回填到新工作区
      if (!current()) return { ok: false, message: '工作区已切换，已取消重新读取' };
    }

    try {
      const key = await host.port.workspaceKey();
      if (!current()) return { ok: false, message: '工作区已切换，已取消重新读取' };
      host.onWorkspaceKey(key);
    } catch {
      // 摘要取不到不影响项目列表
    }
    return { ok: true, projects };
  };
}

/* ------------------------------------------------------------------ */
/* 披露模态的状态机                                                     */
/* ------------------------------------------------------------------ */

export type AddProjectUiState =
  | { phase: 'closed' }
  | { phase: 'disclosure'; support: ProjectRegistrationSupport }
  | { phase: 'picking' }
  | { phase: 'done'; result: AddProjectResult };

export interface AddProjectFlow {
  state(): AddProjectUiState;
  /** 只打开披露模态：**不发任何请求**（PA-01）。 */
  open(): AddProjectUiState;
  /** 取消：关闭模态，不发请求、不注册项目（PA-02）。 */
  cancel(): AddProjectUiState;
  /** 用户点了「继续选择文件夹」：从这里才开始 T1/T2/T3。 */
  confirm(name?: string): Promise<AddProjectResult>;
  /** 结果面板关闭。 */
  dismiss(): void;
  subscribe(listener: () => void): () => void;
}

/**
 * 界面持有的「添加项目」句柄。
 *
 * `support()` 必须能**同步**回答（`flow.open()` 要立刻决定模态里显示什么），
 * 因此能力探测的结果缓存在句柄内部；`probe()` 幂等，可以随模式 / 工作区变化重复调用。
 * 尚未探测时返回 `null`，界面按"待确认"处理，绝不假定可用。
 */
export interface AddProjectHandle {
  readonly flow: AddProjectFlow;
  probe(): Promise<ProjectRegistrationSupport>;
  support(): ProjectRegistrationSupport | null;
  /** 订阅能力探测结果：界面据此从"待确认"变成明确答案。 */
  subscribeSupport(listener: () => void): () => void;
  /** 身份变化时把缓存置空，界面回到"待确认"（**不**取消在途探测）。 */
  invalidateSupport(): void;
  /**
   * 只读核对：重新读取项目列表与工作区摘要，可选补齐某个项目的根层。
   *
   * 用于「已注册但未同步」与「结果未知」之后的恢复：**不重发 pick、不弹窗口、
   * 不改任何授权**。用户不需要重新选择同一个文件夹。
   */
  resync(projectId?: string): Promise<ResyncOutcome>;
}

export type ResyncOutcome =
  | { ok: true; projects: ProjectSummary[] }
  | { ok: false; message: string };

/**
 * 能力探测（R1-02）。
 *
 * 抽成纯 TS 的理由：这条约束是"**点击入口不得额外发请求**"，而探测本身必须
 * 发生在组件初始化 / 模式变化 / 工作区变化时。把"何时探测"和"探测几次"放进
 * 一个可确定性测试的对象里，才能证明连挂载两次（StrictMode）也只发一个请求。
 */
export interface SupportProbe {
  probe(): Promise<ProjectRegistrationSupport>;
  support(): ProjectRegistrationSupport | null;
  subscribe(listener: () => void): () => void;
  invalidate(): void;
}

export function createSupportProbe(options: {
  mode(): ClientMode;
  workspaceKey(): string | null;
  fetchSupport(): Promise<ProjectRegistrationSupport>;
}): SupportProbe {
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  /** 缓存只在"身份一致"时有效：模式或工作区摘要变了就必须重新问。 */
  let cached: ProjectRegistrationSupport | null = null;
  let cachedKey: string | null = null;
  let inFlight: { key: string; promise: Promise<ProjectRegistrationSupport> } | null = null;

  const keyOf = (): string | null => {
    const mode = options.mode();
    return mode === 'live' ? `live|${options.workspaceKey() ?? ''}` : null;
  };

  return {
    support() {
      if (options.mode() !== 'live') return 'demo';
      const key = keyOf();
      return key !== null && cachedKey === key ? cached : null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invalidate() {
      // 只清答案，不动在途探测：StrictMode 会把 effect 跑两遍，
      // 若这里连 inFlight 一起清，就会凭空多出一个请求。
      cached = null;
      cachedKey = null;
      notify();
    },
    async probe() {
      if (options.mode() !== 'live') {
        // 演示模式没有 Host，也没有真实目录：不访问任何网络
        return 'demo';
      }
      const key = keyOf();
      if (key === null) return 'unknown';
      if (inFlight && inFlight.key === key) return inFlight.promise;

      const entry: { key: string; promise: Promise<ProjectRegistrationSupport> } = {
        key,
        promise: Promise.resolve('unknown'),
      };
      entry.promise = (async () => {
        let answer: ProjectRegistrationSupport;
        try {
          answer = await options.fetchSupport();
        } catch {
          // 探测失败不等于"可以添加"：保持未知，让用户看到的是说明而不是失败
          answer = 'unknown';
        } finally {
          if (inFlight === entry) inFlight = null;
        }
        // 探测期间身份又变了：这次答案不属于当前工作区，不写缓存
        if (keyOf() === key) {
          cached = answer;
          cachedKey = key;
          notify();
        }
        return answer;
      })();
      inFlight = entry;
      return entry.promise;
    },
  };
}

export function createAddProjectFlow(options: {
  adder: ProjectAdder;
  support(): ProjectRegistrationSupport;
  onChange?(state: AddProjectUiState): void;
}): AddProjectFlow {
  let state: AddProjectUiState = { phase: 'closed' };
  const listeners = new Set<() => void>();

  const set = (next: AddProjectUiState): AddProjectUiState => {
    state = next;
    options.onChange?.(next);
    for (const listener of listeners) listener();
    return state;
  };

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open() {
      // 选择进行中再点一次不能开第二个模态（那会诱导用户以为可以并行选两次）
      if (state.phase === 'picking' || state.phase === 'disclosure') return state;
      return set({ phase: 'disclosure', support: options.support() });
    },
    cancel() {
      // 系统对话框已经打开时"取消模态"并不能关掉它：此时不提供这个假动作
      if (state.phase !== 'disclosure') return state;
      return set({ phase: 'closed' });
    },
    async confirm(name?: string) {
      if (state.phase === 'picking' || options.adder.busy()) return { kind: 'busy' };
      if (state.phase !== 'disclosure') return { kind: 'busy' };

      let support: ProjectRegistrationSupport;
      try {
        support = options.support();
      } catch {
        // 能力未知时**不能**默认允许继续
        support = 'unknown';
      }

      // 非托管模式：给明确说明，一个请求都不发（不假装失败、也不引导输入路径）
      if (support !== 'managed') {
        const result: AddProjectResult = { kind: 'unsupported', support };
        set({ phase: 'done', result });
        return result;
      }

      // 先切到 picking 再 await：第二次点击此时必然被上面的分支挡住
      set({ phase: 'picking' });
      try {
        const result = await options.adder.add(name);
        set({ phase: 'done', result });
        return result;
      } catch {
        /**
         * 统一异常终态（R1-04）。
         *
         * 注入的宿主依赖（`loadRoot` / `onProjects` / `onWorkspaceKey` / `wait`）
         * 或编排层自身抛出时，模态不能永久停在 picking；同时**不得**凭异常推断
         * "Host 没登记" —— 异常很可能发生在 APPLIED 之后。因此这里只说"未知"，
         * 由用户通过只读核对（重新读取项目列表）收敛，绝不自动重发 pick。
         */
        const result: AddProjectResult = {
          kind: 'unknown',
          message: '添加流程异常中断：Host 是否已经登记这次选择暂时未知',
        };
        set({ phase: 'done', result });
        return result;
      }
    },
    dismiss() {
      if (state.phase === 'done') set({ phase: 'closed' });
    },
  };
}

/* ------------------------------------------------------------------ */
/* 名称校验（与 Host 的 assertName 同规则）                             */
/* ------------------------------------------------------------------ */

export type NameValidation = { ok: true; name: string } | { ok: false; message: string };

/**
 * 本地预检只为了"别把一个注定失败的请求发出去"；**权威仍是 Host**。
 * 规则与 `ProjectRuntime.assertName` 一致：trim 后非空、≤64 字符、不含控制字符。
 */
export function validateProjectName(raw: string): NameValidation {
  const name = raw.trim();
  if (name === '') return { ok: false, message: '项目名称不能为空' };
  if (name.length > 64) return { ok: false, message: '项目名称最长 64 个字符' };
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, message: '项目名称不能包含控制字符' };
  return { ok: true, name };
}
