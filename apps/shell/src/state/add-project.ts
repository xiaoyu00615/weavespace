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
  | { kind: 'failed'; message: string };

export interface AddProjectHost {
  port: AddProjectPort;
  /** 发起时的身份快照；每次 await 之后都要再问一次。 */
  identity(): { mode: ClientMode; workspaceKey: string | null };
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
      const origin = { mode: began.mode, workspaceKey: began.workspaceKey };
      const stale = (): boolean => {
        const current = host.identity();
        return origin.mode !== 'live' || current.mode !== 'live' || current.workspaceKey !== origin.workspaceKey;
      };

      try {
        let boot: { token: string; intentId: string | null };
        try {
          boot = await host.port.bootstrap();
        } catch {
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
          return { kind: 'failed', message: '无法启动文件夹选择' };
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
            return { kind: 'failed', message: '无法读取文件夹选择结果' };
          }
          if (stale()) return { kind: 'stale' };

          if (state.status === 'APPLIED') {
            const project = state.project;
            if (!project) return { kind: 'failed', message: '选择已完成，但 Host 没有返回项目信息' };
            // Host 才是权威：先重取项目表，再挂上新项目的根层
            let projects: ProjectSummary[];
            try {
              projects = await host.port.listProjects();
            } catch {
              return { kind: 'failed', message: '项目已添加，但读取项目列表失败：请刷新页面' };
            }
            if (stale()) return { kind: 'stale' };
            host.onProjects(projects);
            /**
             * 顺序不可交换：**先读根层，再更新工作区摘要**。
             *
             * `workspaceKey` 覆盖"项目集合 + 规范根 + 根身份令牌"，添加项目必然改变它；
             * 而逐层加载的归属票据会在提交时比对 `workspaceKey`。若先更新摘要，根层请求
             * 的票据在返回时就已经过期，结果会被当作"上一个工作区的迟到响应"丢弃 ——
             * 界面于是出现"项目加进来了，但点开是空的"。
             */
            await host.loadRoot(project.projectId);
            try {
              const key = await host.port.workspaceKey();
              if (!stale()) host.onWorkspaceKey(key);
            } catch {
              // 摘要只用于恢复记录匹配：取不到就保持原值，不影响"项目已添加"这个事实
            }
            return { kind: 'applied', project };
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
            return {
              kind: 'failed',
              message: '等待文件夹选择结果超时：请检查系统选择窗口是否仍在后台打开',
            };
          }
          await wait(pollIntervalMs);
          if (stale()) return { kind: 'stale' };
        }
      } finally {
        inFlight = false;
      }
    },
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
 * 尚未探测时返回 `null`，界面按"未知"给说明，绝不假定可用。
 */
export interface AddProjectHandle {
  readonly flow: AddProjectFlow;
  probe(): Promise<ProjectRegistrationSupport>;
  support(): ProjectRegistrationSupport | null;
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

      // 非托管模式：给明确说明，一个请求都不发（不假装失败、也不引导输入路径）
      const support = options.support();
      if (support !== 'managed') {
        const result: AddProjectResult = { kind: 'unsupported', support };
        set({ phase: 'done', result });
        return result;
      }

      // 先切到 picking 再 await：第二次点击此时必然被上面的分支挡住
      set({ phase: 'picking' });
      const result = await options.adder.add(name);
      set({ phase: 'done', result });
      return result;
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
