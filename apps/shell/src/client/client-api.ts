/**
 * Client API 边界（S9-B）。
 *
 * 浏览器**不得**直接访问文件系统或 SQLite。Shell 只依赖下面这组接口：
 * - `demo`：内置演示数据，绝不写盘（S9-A 行为）；
 * - `live`：访问 localhost 的 Client API（apps/server），由 Core 的
 *   CommandBus + PermissionService 判定并落盘。
 *
 * 约定：**HTTP 状态码不等于结果**。调用方必须读 `status`：
 * `APPLIED` / `COMMITTED` / `CONFLICT` / `FAILED` / `UNKNOWN`。
 * `UNKNOWN` 既不是成功也不是失败，不得自动重试。
 */

import {
  resolvePageInstance,
  type InstanceLockPort,
  type InstanceStoragePort,
} from './page-instance.ts';

export type ClientMode = 'demo' | 'live';

/** 服务端运行模式（G2-03）：不得假定连接的一定是 Multi。 */
export type WorkspaceMode = 'legacy' | 'multi';

/**
 * 本浏览器页面的稳定实例 id（UX-02C-02-R1 / R1.1）。
 *
 * 具体规则见 `page-instance.ts`：sessionStorage 保存候选 id，Web Locks 负责
 * 发现"另一个活着的页面用了同一个 id"（opener 复制、Chrome 复制标签页）。
 * 只解析一次并缓存：同一次页面生命里所有请求用同一个 id。
 *
 * **不是授权凭据**：服务端从不凭它放行任何操作。
 */
let pageInstanceResolved: Promise<string | null> | null = null;

export function pageInstanceId(): Promise<string | null> {
  pageInstanceResolved ??= resolvePageInstance({
    storage: browserSessionStorage(),
    locks: browserLockPort(),
  })
    // R1.2：没有任何"身份解析"异常值得让一次打开失败。拿不到就是没有身份，
    // Host 会退回旧语义（不回收、不猜测归属），绝不因此报"无法连接本地服务"。
    .then((resolved) => resolved.id)
    .catch(() => null);
  return pageInstanceResolved;
}

/** 仅测试用：清除缓存，让下一次调用重新解析（不用于生产路径）。 */
export function resetPageInstanceCache(): void {
  pageInstanceResolved = null;
}

/**
 * 仅测试用：固定页面实例 id。
 *
 * Node 集成测试里没有 sessionStorage / Web Locks，不注入就只能得到 `null`
 * （等于"旧客户端"），无法覆盖页面恢复与回收路径。
 */
export function setPageInstanceForTest(id: string | null): void {
  pageInstanceResolved = Promise.resolve(id);
}

function browserSessionStorage(): InstanceStoragePort | null {
  try {
    const storage = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

/**
 * Web Locks 适配：拿到锁后返回一个**永不 resolve** 的 Promise 把它持有到页面销毁；
 * 拿不到（别的页面在用）返回 false。
 */
function browserLockPort(): InstanceLockPort | null {
  const nav = (globalThis as {
    navigator?: {
      locks?: {
        request?: (
          name: string,
          options: { ifAvailable: boolean },
          callback: (lock: unknown) => Promise<void> | void,
        ) => Promise<void>;
      };
    };
  }).navigator;
  const locks = nav?.locks;
  if (!locks || typeof locks.request !== 'function') return null;
  // 绑定 this：Web IDL 方法脱离对象调用会 rejected（Illegal invocation）
  const request = locks.request.bind(locks);
  return {
    tryAcquire(name: string): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (value: boolean): void => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        try {
          // `request` 已在上面 bind(this)：Web IDL 方法脱离 this 会 rejected，
          // 那样每次都会误判成"锁被占用"，身份退化成 null。
          void request(name, { ifAvailable: true }, (lock) => {
              if (!lock) {
                settle(false);
                return undefined;
              }
              settle(true);
              // 持有到页面销毁：锁随上下文释放，刷新时新页面才能重新拿到同一把
              return new Promise<void>(() => {});
            })
            .catch(() => settle(false));
        } catch {
          settle(false);
        }
      });
    },
  };
}

export interface ProjectSummary {
  projectId: string;
  name: string;
  status: 'READY' | 'UNAVAILABLE';
  reason?: string;
}

export interface ResourceNode {
  id: string;
  name: string;
  /** 只区分目录/文件/链接；格式由 `extension` + 能力注册表决定（S10-A）。 */
  kind: TreeEntryKind;
  /** 文件扩展名（小写含点）；目录为空。 */
  extension?: string;
  /** 文件相对路径（live 用于 open）；demo 下与 id 相同。 */
  path?: string;
  children?: ResourceNode[];
}

/* ---- UX-02B-TREE：逐层、可分页的真实目录树（契约 B.2/B.3） ---- */

/** 三套事实类型，`link` 只显示、不展开、不打开。 */
export type TreeEntryKind = 'folder' | 'file' | 'link';

export interface TreeEntry {
  /** `dir:` / `doc:` / `link:` 三套互不重叠的命名空间。 */
  id: string;
  name: string;
  kind: TreeEntryKind;
  /** 小写含点；无扩展名与目录为空串。 */
  extension: string;
  /** 项目内相对路径；**永不是绝对路径**。 */
  relPath: string;
  /**
   * 该条目自身有一条（核验通过的）隐藏记录（UX-02C-03-P1）。
   * 只在 `includeHidden=1` 的请求里出现；默认视图直接过滤掉。
   */
  hidden?: boolean;
  /** 自身没有记录，但某个上级目录被隐藏：值是那个上级的相对路径。 */
  hiddenBy?: string;
  /**
   * 资源展示元数据（UX-02C-04）：标注名 / 标签 / 行颜色。
   *
   * Host 只下发**身份核验通过**的记录：路径上换了另一个对象时，旧标注不会出现。
   * 因此这里不需要（也不允许）客户端再做"是不是同一个文件"的判断。
   */
  meta?: ResourceMetadataDto;
}

/** 三个展示字段：都缺省表示"没有标注"（Host 不会下发空对象）。 */
export interface ResourceMetadataDto {
  alias?: string;
  tags: string[];
  color?: string;
}

export interface TreePageMeta {
  limit: number;
  cursor: string | null;
  /** 非 null 表示还有下一页，必须继续请求直到 null。 */
  nextCursor: string | null;
  total: number;
  /**
   * 本轮分页的**目录快照标识**（UX-02B-TREE-R1）。
   * 由服务端对"排序后的整层条目集合"计算，客户端原样回传给续页请求；
   * 目录在两页之间发生变化时服务端返回 `ERR_DIR_CHANGED`，客户端必须刷新整层。
   * 旧版服务端不返回该字段时为 null。
   */
  snapshot: string | null;
  /** 本层隐藏条目数（UX-02C-03-P1）；旧版服务端不返回时按 0 处理。 */
  hiddenCount?: number;
}

/**
 * 隐藏 / 取消隐藏的结果（UX-02C-03-P1）。
 *
 * `changed: false` 表示"这条指令没有改变任何记录"（幂等命中），**不是**失败；
 * 失败一定是 `REJECTED` 且带 `errorCode`。
 */
export type VisibilityOutcome =
  | {
      status: 'APPLIED';
      projectId: string;
      path: string;
      hidden: boolean;
      changed: boolean;
    }
  | {
      status: 'REJECTED';
      errorCode: string | null;
      message?: string;
      httpStatus?: number;
    }
  /**
   * 请求已发出但没拿到结论（网络中断/超时）。
   *
   * 隐藏是幂等操作，所以处理方式只有一条：**刷新该目录看真实结果**，
   * 不自动重发（重发也无害，但会让用户看到两次提示）。
   */
  | { status: 'UNKNOWN'; message: string };

/** 隐藏记录当前是否仍然成立：`missing` / `rebound` 都是"记录还在，但已不生效"。 */
export type HiddenEntryState = 'active' | 'missing' | 'rebound' | 'unverified';

export interface HiddenEntryDto {
  path: string;
  state: HiddenEntryState;
}

export type HiddenListOutcome =
  | { status: 'APPLIED'; projectId: string; entries: HiddenEntryDto[] }
  | { status: 'REJECTED'; errorCode: string | null; message?: string };

/* ---- UX-02C-04：资源标注名 / 标签 / 行颜色 ---- */

/**
 * 设置 / 清除资源元数据的结果。
 *
 * 与隐藏同一套语义：`changed: false` 是"这条指令没有改变任何记录"（幂等命中），
 * 不是失败；失败一定是 `REJECTED` 且带 `errorCode`。
 *
 * `UNKNOWN` 只用于"请求已发出但没拿到结论"：元数据写入是幂等的（同一份内容重复写
 * 结果相同），因此处理方式只有一条——**刷新该层看真实结果**，不自动重发。
 */
export type MetadataOutcome =
  | {
      status: 'APPLIED';
      projectId: string;
      path: string;
      changed: boolean;
      /** 写入后的完整展示状态；全空时为 `{ tags: [] }`。 */
      metadata: ResourceMetadataDto;
    }
  | {
      status: 'REJECTED';
      errorCode: string | null;
      message?: string;
      httpStatus?: number;
    }
  | { status: 'UNKNOWN'; message: string };

/** 一次增量修改：`undefined` = 不改这一项；`null` / `[]` = 清除这一项。 */
export interface ResourceMetadataPatch {
  alias?: string | null;
  tags?: string[];
  color?: string | null;
}

/** 元数据记录当前是否仍然成立（与隐藏同一套四态）。 */
export type MetadataEntryState = 'active' | 'missing' | 'rebound' | 'unverified';

export interface MetadataEntryDto extends ResourceMetadataDto {
  path: string;
  state: MetadataEntryState;
}

export type MetadataListOutcome =
  | { status: 'APPLIED'; projectId: string; entries: MetadataEntryDto[] }
  | { status: 'REJECTED'; errorCode: string | null; message?: string };

/* ---- UX-02C-03-P2-02：回收区（Shell） ---- */

/**
 * 回收记录的七个状态（与 Host `ConfigTrashEntry.state` 一一对应）。
 *
 * 客户端**不派生**新状态：`pending` / `restoring` 是"还在核对"，不是"成功"也不是"失败"；
 * 把它们折成任何一端都会让用户对文件到底在哪产生错误判断。
 */
export type TrashEntryState =
  | 'pending'
  | 'stored'
  | 'restoring'
  | 'restored'
  | 'aborted'
  | 'conflicted'
  | 'missing';

/** 一条回收记录（Host DTO）。`path` 是**原始相对路径**，不是回收区内部路径。 */
export interface TrashEntryDto {
  readonly opId: string;
  readonly path: string;
  readonly entryKind: 'file';
  readonly size: number;
  readonly deletedAt: string;
  readonly state: TrashEntryState;
  /** 只有 `stored` 才是 true；客户端不得自行放宽。 */
  readonly canRestore: boolean;
  readonly note?: string;
  readonly restoredAt?: string;
}

export type TrashListOutcome =
  | { status: 'APPLIED'; projectId: string; count: number; entries: TrashEntryDto[] }
  | { status: 'REJECTED'; errorCode: string | null; message?: string; httpStatus?: number };

/**
 * 发送前的最终裁决（UX-02C-03-P2-03-R1-01）。
 *
 * 由**编排层**提供、由**传输层**在 `sessionToken()` 之后、`fetch()` 之前**同步**调用一次。
 *
 * 为什么必须放在这里：Controller 早先那次 `verifyPending()` 与真正的 POST 之间还隔着
 * "取会话令牌"这个 await。用户完全可以在这段窗口里切项目 / 切模式，或者另一个标签页
 * 把台账删掉——那时早先的检查已经通过了，POST 会照发。只有把最后一次判断压到
 * fetch 的同一个同步片段里，才不存在可插入的窗口。
 *
 * 判据（顺序即优先级）：
 * 1. 发起时的完整身份仍然有效（mode / workspaceMode / workspaceKey / epoch / activeProjectId）；
 * 2. 项目仍然 READY；
 * 3. 本地 blockers 仍为空；
 * 4. 这次预留的待核对记录仍然在册，且台账不是 invalidated / corrupt / unavailable / initializing。
 *
 * `full` **不得**拒绝已经成功预留的第 64 条：容量是"不能再新增"，不是"已占的不算"。
 */
export type TrashSendDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `stale` 静默丢弃；`blocked` 给可读原因；`invalidated` 保守保留待核对记录。 */
      readonly kind: 'stale' | 'blocked' | 'invalidated';
      readonly message?: string;
      /** `blocked` 时的原始阻断码（界面按同一套文案翻译）。 */
      readonly reasons?: readonly string[];
    };

/** 无参、同步、不返回 Promise：**任何** `await` 都可能成为新的窗口。 */
export type TrashSendGate = () => TrashSendDecision;

/**
 * 回收 / 恢复的共同结论。
 *
 * `UNKNOWN` 是独立一种：磁盘可能已经变了，只允许按 `opId` 做**一次只读**核对，
 * 绝不自动重发（重发会真的再移动一次文件）。
 *
 * `NOT_SENT` 是 R1-01 新增的一种：请求**没有发出去**（被发送前的最终裁决拒绝）。
 * 它既不是成功也不是失败，更不能当成 `UNKNOWN` 去核对——磁盘一个字节都没动。
 */
export type TrashActionOutcome =
  | { status: 'APPLIED'; projectId: string; opId: string; entry: TrashEntryDto; replayed: boolean }
  | { status: 'UNKNOWN'; projectId: string; opId: string; message: string; httpStatus: number }
  | {
      status: 'REJECTED';
      projectId: string;
      opId: string;
      errorCode: string | null;
      message: string;
      httpStatus: number;
      blockedBy?: string[];
    }
  | {
      status: 'NOT_SENT';
      projectId: string;
      opId: string;
      reason: 'stale' | 'blocked' | 'invalidated';
      message: string | null;
      reasons?: readonly string[];
    };

/** 结算只接受"真的发出去过"的结论。 */
export type TrashSentOutcome = Exclude<TrashActionOutcome, { status: 'NOT_SENT' }>;

/** 按 `opId` 只读核对真实结果（不重发、不改任何东西）。 */
export type TrashOpQueryOutcome =
  | {
      status: 'APPLIED';
      opId: string;
      /** `none` = 没有这条记录；`unknown` = 记录还在核对中。 */
      outcome: 'trashed' | 'restored' | 'aborted' | 'conflicted' | 'missing' | 'unknown' | 'none';
      state: TrashEntryState | null;
    }
  | { status: 'REJECTED'; errorCode: string | null; message?: string; httpStatus: number };

export type TreeQueryOutcome =
  | {
      status: 'APPLIED';
      level: string;
      entries: TreeEntry[];
      page: TreePageMeta;
      /** 项目根展示项的元数据（只在 `level === ''` 且项目有标注时出现）。 */
      projectMeta?: ResourceMetadataDto;
    }
  | {
      status: 'REJECTED';
      errorCode: string | null;
      message?: string;
    };

/** Core 的会话快照：版本与状态语义与 DocumentStateView 对齐。 */
export interface DocumentSnapshot {
  sessionId: string;
  viewId: string | null;
  resourceId: string;
  path: string;
  content: string;
  baseVersion: string | null;
  revision: number;
  dirty: boolean;
  /** CLEAN | EDITING_DIRTY | SAVING | CONFLICT | FAILED | OUTCOME_UNKNOWN（demo 为 DEMO） */
  documentState: string;
  /** 会话所属项目（Multi）；Legacy 不返回。 */
  projectId?: string;
  /** 会话失效标记（与 documentState 正交）：磁盘访问已被拒绝，草稿仍保留。 */
  stale?: { reason: string; since: string };
}

export type SaveStatus = 'COMMITTED' | 'CONFLICT' | 'FAILED' | 'UNKNOWN' | 'DEMO';

export interface OpenOutcome {
  status: 'APPLIED' | 'REJECTED';
  errorCode?: string | null;
  message?: string;
  document?: DocumentSnapshot;
  /** true 表示服务端检测到磁盘变化，已把会话内容与基线刷新为磁盘版本。 */
  reloaded?: boolean;
}

/** 磁盘上的当前版本（冲突恢复时只读查看，不写任何东西）。 */
export interface DiskSnapshot {
  content: string;
  contentVersion: string;
}

export interface ReloadOutcome {
  status: 'APPLIED' | 'REJECTED';
  errorCode?: string | null;
  message?: string;
  document?: DocumentSnapshot;
  /** 覆盖前的草稿（服务端回传，供 UI 备份）。 */
  previousDraft?: string;
}

export interface SaveOutcome {
  status: SaveStatus;
  errorCode?: string | null;
  contentVersion?: string | null;
  document?: DocumentSnapshot;
  /**
   * 保存后"隐藏记录身份"的刷新结论（UX-02C-03-P1-R1）。
   *
   * 与正文保存结论**无关**：`skipped` / `failed` 只说明该文件的隐藏状态需要
   * 人工核对（文件会重新出现在树里），正文仍然已经写入磁盘。旧版服务端不返回。
   */
  hiddenRefresh?: 'none' | 'refreshed' | 'skipped' | 'failed';
  hiddenRefreshReason?: string;
}

export interface CloseOutcome {
  status: 'APPLIED' | 'REJECTED';
  errorCode?: string | null;
  message?: string;
}

/**
 * "回收本页面遗留 View"的结果（UX-02C-02-R1.2）。
 *
 * `closed` 是真正被关掉的 View 数；`blocked` 是 Host 明确拒绝关闭的数量
 * （目前只可能是"最后一个视图且有未保存草稿"）。两者相加才等于命中的 View 数，
 * 因此 `blocked > 0` 表示**回收没做完**——调用方不得把它当成成功。
 */
export interface ReclaimViewsOutcome {
  status: 'APPLIED' | 'REJECTED';
  closed: number;
  blocked: number;
  errorCode?: string | null;
}

/**
 * Host 的工作区身份（S11-C）。
 *
 * `workspaceKey` 是 Host 对"项目组合 + 规范根 + 根身份令牌"做的摘要，
 * **只用于判断本地恢复记录是否属于同一个工作区**，不能当作读写授权凭据：
 * 真正的授权仍由每次请求的 G0/G1 检查完成。
 */
export interface WorkspaceIdentity {
  workspaceMode: WorkspaceMode;
  /** 摘要；Host 无法可靠确认身份（旧版服务端、根缺失）时为 `null`。 */
  workspaceKey: string | null;
}

/* ---- UX-02B-04A：项目注册、本机目录选择、显示名称 ---- */

/**
 * 信任披露的协议标记（与 Host 侧常量一字不差）。
 *
 * **它不是授权凭据**：Host 不会因为它存在就多授予一毫秒的目录权限，也不会把它写进
 * 任何持久记录。它唯一的作用，是让"客户端跳过了披露这一步"在协议层可被发现。
 */
export const ACKNOWLEDGE_SCOPE = 'browse-subtree' as const;

/**
 * Host 是否支持"在界面里添加项目"。
 *
 * - `managed`：带 `--workspace-store` 启动的托管模式，可以弹本机目录选择；
 * - `static` / `legacy`：配置是只读的，动态注册不可能成功；
 * - `demo`：演示模式，根本没有 Host；
 * - `unknown`：旧版/异常 Host —— 一律按"不支持"处理，绝不假定可用。
 */
export type ProjectRegistrationSupport = 'managed' | 'static' | 'legacy' | 'demo' | 'unknown';

export interface ProjectRegistrationInfo {
  support: ProjectRegistrationSupport;
  /** Host 上报的原始模式（`managed` / `multi` / `static` / `legacy`），仅用于解释原因。 */
  mode: string;
}

/** 启动本机选择器的结果：只有 `PENDING` 才代表"对话框已经打开"。 */
export interface PickStartOutcome {
  status: 'PENDING' | 'REJECTED';
  requestId?: string;
  errorCode?: string | null;
  message?: string;
  httpStatus: number;
}

/**
 * 选择结果的四态（契约 D.4）。
 *
 * `CANCELLED` / `REJECTED` 都是**零副作用**：没有项目被注册，没有授权被记录。
 */
export interface PickQueryOutcome {
  status: 'PENDING' | 'APPLIED' | 'CANCELLED' | 'REJECTED';
  requestId?: string;
  /** 仅 `APPLIED` 携带；不含任何本机路径。 */
  project?: ProjectSummary;
  errorCode?: string | null;
  /** Host 记录的机读原因（如 `timeout` / `unavailable`），供界面区分文案。 */
  reason?: string;
  message?: string;
  httpStatus: number;
}

/**
 * 重命名显示名称的结果。
 *
 * `APPLIED` 时以 Host 返回的 `project` 为权威（名称已 trim、已校验），
 * 客户端不得自行"乐观改名"。
 */
export type RenameOutcome =
  | { status: 'APPLIED'; project: ProjectSummary }
  | { status: 'REJECTED'; errorCode: string | null; message: string; httpStatus: number };

/** 移除阻断原因（与 Host `RemoveBlocker` 对齐，ADR-023 §3.2）。 */
export type RemoveBlockerCode =
  | 'ACTIVE_VIEWS'
  | 'DIRTY'
  | 'SAVING'
  | 'OUTCOME_UNKNOWN'
  | 'CONFLICT'
  | 'IN_FLIGHT_DISK_OPS'
  | 'DRAIN_TIMEOUT';

/** 移除前置检查结果（只读）。仅用于提前给出可读提示，**不是**放行凭据。 */
export type RemovalPrecheckOutcome =
  | {
      status: 'APPLIED';
      projectId: string;
      allowed: boolean;
      blockedBy: RemoveBlockerCode[];
      state: string;
    }
  | { status: 'REJECTED'; errorCode: string | null; message: string; httpStatus: number };

/**
 * 移除项目的结果。
 *
 * - `APPLIED`：Host 明确撤销（`configPersisted=false` 表示墓碑已生效但配置待补齐，
 *   项目**已不可访问**，重启后按墓碑收敛）；
 * - `ABORTED`：Host 复检未通过，零变更（附具体阻断原因）；
 * - `REJECTED`：其余失败（含超时/未知），调用方**不得**据此断言"已移除"。
 */
export type RemoveProjectOutcome =
  | { status: 'APPLIED'; projectId: string; opId: string; configPersisted: boolean }
  | { status: 'ABORTED'; projectId: string; blockedBy: RemoveBlockerCode[] }
  | { status: 'REJECTED'; errorCode: string | null; message: string; httpStatus: number };

/**
 * `opId` 的持久证据结论（ADR-022 §7.1）；`unknown` 时不得反推具体结果。
 *
 * `projectId` 是该证据**归属的项目**（`unknown` 时恒为 `null`）：调用方必须比对
 * 它才能认领结果，否则"另一个项目的撤销证据"会被错算成本次移除。
 */
export type RemovalOpOutcome =
  | {
      status: 'APPLIED';
      opId: string;
      outcome: 'revoked' | 'created' | 'aborted' | 'unknown';
      projectId: string | null;
    }
  | { status: 'REJECTED'; errorCode: string | null; message: string; httpStatus: number };

/**
 * 真实创建（UX-02C-01）的客户端结论。
 *
 * `UNKNOWN` 是**独立**的一种，不能折成 REJECTED：网络断开 / 5xx / Host 明确报告
 * "副作用可能已发生但无法确认"，都只许做一次**只读**目录核对并提示人工确认，
 * 绝不自动重发创建，更不能因为"目录里出现了同名文件"就宣称本次操作成功。
 */
export type CreateEntryKindDto = 'file' | 'directory';
export type CreateEntryOutcome =
  | {
      status: 'APPLIED';
      projectId: string;
      parentDir: string;
      name: string;
      kind: CreateEntryKindDto;
      relativePath: string;
    }
  | {
      status: 'UNKNOWN';
      errorCode: 'ERR_OUTCOME_UNKNOWN';
      message: string;
      httpStatus: number;
    }
  | { status: 'REJECTED'; errorCode: string | null; message: string; httpStatus: number };

/**
 * 真实改名 / 移动（UX-02C-02）的客户端结论。与创建一样，`UNKNOWN` 是独立一种：
 * 磁盘可能已经变了但响应链断了，只许一次只读核对 + 人工确认，绝不自动重发。
 */
export interface StructureChangeApplied {
  status: 'APPLIED';
  projectId: string;
  sourcePath: string;
  targetPath: string;
  targetParentDir: string;
  targetName: string;
  entryKind: CreateEntryKindDto;
  contentSha256: string | null;
  /**
   * 元数据是否随这次结构变更迁移（UX-02C-04）。
   *
   * - `moved`：路径已随文件走；
   * - `none`：这个文件本来就没有标注（或没有任何记录受影响）；
   * - `failed`：磁盘确实变了，但标注没能写进配置 —— 界面必须提示，
   *   不能让用户以为"标注还在"。
   *
   * 缺省（旧版服务端）= 未知，按 `none` 处理但不承诺。
   */
  metadataMigration?: 'moved' | 'none' | 'failed';
  metadataMoved?: number;
}
export type StructureChangeOutcome =
  | StructureChangeApplied
  | {
      status: 'UNKNOWN';
      errorCode: 'ERR_OUTCOME_UNKNOWN';
      message: string;
      httpStatus: number;
      projectId: string;
      sourcePath: string;
      targetParentDir: string;
      targetName: string;
    }
  | {
      status: 'REJECTED';
      errorCode: string | null;
      message: string;
      httpStatus: number;
      /** Host 会话保护给出的阻断原因（活动 View / DIRTY / SAVING / …）。 */
      blockedBy?: string[];
    };

export interface WeaveSpaceClient {
  readonly mode: ClientMode;
  /** 服务端运行模式（`/api/health`）；demo 恒为 `legacy`。 */
  workspaceMode(): Promise<WorkspaceMode>;
  /** 运行模式 + 工作区摘要（一次请求取回）；demo 的摘要恒为 `null`。 */
  workspaceIdentity(): Promise<WorkspaceIdentity>;
  /** 仅 Multi 有项目列表；Legacy 返回 `[]`。 */
  listProjects(): Promise<ProjectSummary[]>;
  /**
   * 旧端点 `/api/resources`：递归整棵树、只含可编辑文本。
   *
   * **保持冻结**，Legacy 恢复链路与既有测试仍依赖它；新 UI 不要用。
   */
  listResources(projectId?: string): Promise<ResourceNode[]>;
  /**
   * UX-02B-TREE：只读**一层**目录，`cursor` 省略为第一页。
   *
   * `projectId` 为 null 表示 Legacy 单根。`dir` 是项目内相对路径（根为空串），
   * **绝不接受绝对路径**。调用方必须用 `page.nextCursor` 继续加载直到 null。
   */
  listTree(
    projectId: string | null,
    dir: string,
    cursor?: string | null,
    limit?: number,
    /** 本轮分页的目录快照（仅续页传入，第一页为 null）。 */
    snapshot?: string | null,
    /**
     * `includeHidden`（UX-02C-03-P1）：仅"显示隐藏项"打开时为 true。
     *
     * 它不是过滤开关而是**视图**开关：Host 在分页之前决定返回哪些条目，
     * 因此 total / nextCursor / snapshot 始终与这一份视图自洽。
     */
    options?: { includeHidden?: boolean },
  ): Promise<TreeQueryOutcome>;
  /**
   * 打开（或重新打开）一个文档。
   *
   * `options.reclaimPrevious`（UX-02C-02-R1.1）只有**页面恢复**流程才允许传
   * `true`：它表示"本页面上一轮的 View 已经没有人会关闭，请 Host 回收"。
   * 普通打开与 `refreshCleanTab` 这类临时打开绝不传，否则会把当前标签正在用的
   * View 当成遗留物关掉。
   */
  openDocument(
    path: string,
    projectId?: string,
    options?: { reclaimPrevious?: boolean },
  ): Promise<OpenOutcome>;
  readDocument(sessionId: string, viewId?: string | null): Promise<OpenOutcome>;
  applyEdit(
    sessionId: string,
    buffer: string,
    expectedVersion?: string | null,
    viewId?: string | null,
  ): Promise<OpenOutcome>;
  saveDocument(sessionId: string, expectedVersion: string, viewId?: string | null): Promise<SaveOutcome>;
  closeDocument(sessionId: string, viewId: string): Promise<CloseOutcome>;
  /**
   * 回收**本页面**遗留的 View（UX-02C-02-R1.2）：只关闭、不打开、不读盘。
   *
   * 用于"恢复被用户接管"：剩下的待恢复文件不会再被重开，它们的旧 View 只能
   * 通过这条通道回收，否则会永久拦住该项目的改名/移动。
   *
   * `keepViewIds` 是调用方此刻**正在用**的 View（标签持有的那些）：Host 永不关闭
   * 它们。没有页面身份（`clientInstanceId` 拿不到）时直接跳过——宁可留下旧 View，
   * 也不能在不知道"这是谁的 View"的情况下去关别人的。
   */
  reclaimPageViews(input: {
    projectId?: string | null;
    paths: readonly string[];
    keepViewIds?: readonly string[];
  }): Promise<ReclaimViewsOutcome>;
  /** 只读查看磁盘当前内容（冲突恢复入口的第一步）。 */
  readDisk(sessionId: string, viewId?: string | null): Promise<
    | { status: 'APPLIED'; content: string; contentVersion: string }
    | { status: 'REJECTED'; errorCode: string | null; message?: string }
  >;
  /**
   * 用磁盘内容覆盖会话。**调用方必须已经取得用户明确确认**（服务端也会强制校验
   * `discardDraft: true`），否则草稿会被丢弃。
   */
  reloadDocument(sessionId: string, viewId: string): Promise<ReloadOutcome>;

  /* ---- UX-02B-04A ---- */

  /**
   * 只读能力探测：这个 Host 能不能在界面里注册新项目。
   *
   * 必须在用户点「添加项目」**之前**就能回答，否则只能让用户读完披露再撞一次 501，
   * 把"不支持"伪装成"操作失败"。只读端点，不需要令牌，也不涉及任何路径。
   */
  registrationSupport(): Promise<ProjectRegistrationInfo>;
  /**
   * T1 + T2 引导：取会话令牌（证明来自本机页面）与一次性意图（证明这次操作没被重放）。
   *
   * 两者都**不是**目录授权证据。`intentId === null` 表示当前 Host 不发放意图
   * （静态 / Legacy），此时调用方必须直接放弃，而不是继续发 pick 请求。
   */
  bootstrapPick(): Promise<{ token: string; intentId: string | null }>;
  /**
   * 启动 Host 进程内的本机目录选择器（T3 唯一入口）。
   *
   * 请求体只允许 `intentId` / `acknowledgeScope` / `name`：**绝不**提交
   * `rootDir` / `path` / `grantSource` —— 目标目录只能由用户在系统对话框里选。
   */
  startPick(input: {
    token: string;
    intentId: string;
    acknowledgeScope: typeof ACKNOWLEDGE_SCOPE;
    name?: string;
  }): Promise<PickStartOutcome>;
  /** 按 `requestId` 查询选择结果；`PENDING` 表示系统对话框还开着。 */
  queryPick(input: { token: string; requestId: string }): Promise<PickQueryOutcome>;
  /**
   * 修改项目的**显示名称**。
   *
   * 只改名称：`projectId`、磁盘目录名、文件树、标签与草稿都不变。校验（trim / 64 字 /
   * 控制字符）由 Host 的 `ProjectRuntime` 执行，这里不复制一份规则。
   */
  renameProject(projectId: string, name: string): Promise<RenameOutcome>;

  /* ---- UX-02B-04B：项目移除 ---- */

  /** 只读移除前置检查：返回放行与否、阻断原因与生命周期状态。 */
  removalPrecheck(projectId: string): Promise<RemovalPrecheckOutcome>;
  /**
   * 移除项目（只解除注册与授权，**不删除磁盘文件**）。
   *
   * `opId` 由调用方**在提交前**生成并持有：超时/5xx 时才能用 `queryRemovalOp(opId)`
   * 查询持久事务证据，而不是凭列表差异猜测结果。
   */
  removeProject(projectId: string, opId: string): Promise<RemoveProjectOutcome>;
  /** 按 `opId` 查询持久事务证据（只读磁盘）；证据缺失即 `unknown`。 */
  queryRemovalOp(opId: string): Promise<RemovalOpOutcome>;

  /* ---- UX-02C-01：真实创建 ---- */

  /**
   * 在**已授权项目**的指定相对目录里创建一个空文件 / 空目录。
   *
   * 请求体只有 `projectId / parentDir / name`：绝不含绝对路径、rootDir、
   * rootToken、providerId 或正文。名称合法性与目录边界都由 Host 判定。
   */
  createEntry(
    projectId: string,
    parentDir: string,
    name: string,
    kind: CreateEntryKindDto,
  ): Promise<CreateEntryOutcome>;

  /* ---- UX-02C-02：真实改名 / 移动 ---- */

  /** 同一目录内改名：目标目录由 Host 从 sourcePath 派生，浏览器无法偷偷换目录。 */
  /**
   * 从文件树隐藏（UX-02C-03-P1）：只改工作台可见性，**不删除、不移动任何磁盘对象**。
   *
   * 幂等：重复隐藏同一路径返回 `APPLIED + changed:false`。
   */
  hideEntry(projectId: string, path: string): Promise<VisibilityOutcome>;
  /** 取消隐藏（幂等；目标文件已不存在时同样可以清掉记录）。 */
  unhideEntry(projectId: string, path: string): Promise<VisibilityOutcome>;
  /** 查询隐藏记录及其当前状态（只读；含 missing / rebound 这类失效态）。 */
  hiddenEntries(projectId: string): Promise<HiddenListOutcome>;

  /* ---- UX-02C-04：资源标注名 / 标签 / 行颜色 ---- */

  /**
   * 增量设置一个资源的展示元数据。
   *
   * 只提交用户改过的字段：没传的字段保持原值——两个窗口同时改同一个文件时，
   * "只改颜色"不会把对方刚写的标签覆盖回旧值。
   */
  setResourceMetadata(
    projectId: string,
    path: string,
    patch: ResourceMetadataPatch,
  ): Promise<MetadataOutcome>;
  /** 清除整条元数据记录（不要求对象仍存在）。 */
  clearResourceMetadata(projectId: string, path: string): Promise<MetadataOutcome>;
  /** 查询元数据记录及其当前状态（只读；含 missing / rebound 这类失效态）。 */
  resourceMetadata(projectId: string): Promise<MetadataListOutcome>;

  /* ---- UX-02C-03-P2-02：回收区 ---- */

  /**
   * 读取当前项目的回收记录（只读；Host 会先做一次对账）。
   *
   * `projectId` 必填：没有它，Host 无法判断这批记录属于谁，也不知道该用哪份授权。
   */
  listTrash(projectId: string): Promise<TrashListOutcome>;
  /**
   * 把一个**普通文件**移入回收区。
   *
   * `opId` 由调用方在提交前生成并持有：超时/202 时才能用 `queryTrashOp` 核对，
   * 而不是凭"文件还在不在"猜。同一 opId 重试不会再次移动文件。
   */
  trashEntry(projectId: string, path: string, opId: string): Promise<TrashActionOutcome>;
  /**
   * 恢复一条回收记录到它的**原始路径**。
   *
   * 目标由 Host 记录决定，客户端不提供 `targetPath`；原位置已有同名对象时
   * Host 返回 409 `ERR_ENTRY_EXISTS`，绝不覆盖。
   *
   * `gate` 是发送前的最终裁决（R1-01），**必填**（R1-H1）：
   * - 它在会话令牌到手之后、`fetch()` 之前**同步**执行；
   * - 返回不允许时一个字节都不会发出去（结果为 `NOT_SENT`）。
   *
   * 为什么是必填而不是可选：可选参数会让"漏传"变成一次静默的、无授权的真实恢复。
   * 运行时仍会再兜一层（见 `evaluateSendGate`）：JS 调用方 / 旧适配层漏传时 fail-closed。
   */
  restoreTrash(projectId: string, opId: string, gate: TrashSendGate): Promise<TrashActionOutcome>;
  /** 只读核对某个 opId 的真实结果。 */
  queryTrashOp(projectId: string, opId: string): Promise<TrashOpQueryOutcome>;

  renameEntry(projectId: string, sourcePath: string, name: string): Promise<StructureChangeOutcome>;
  /** 同一授权项目内移动：只提交项目内相对目录 + 单段名称。 */
  moveEntry(
    projectId: string,
    sourcePath: string,
    targetParentDir: string,
    name: string,
  ): Promise<StructureChangeOutcome>;
}

interface ApiEnvelope {
  status?: string;
  errorCode?: string | null;
  message?: string;
  document?: DocumentSnapshot;
  contentVersion?: string | null;
  /** 可见性端点回执（UX-02C-03-P1）。 */
  projectId?: string;
  path?: string;
  hidden?: boolean;
  changed?: boolean;
  /** 保存后隐藏记录身份的刷新结论（UX-02C-03-P1-R1）。 */
  hiddenRefresh?: string;
  hiddenRefreshReason?: string;
}

/** 单次请求上限：请求挂住时也要让保存流程收敛为 UNKNOWN，而不是永久锁定（F02）。 */
const REQUEST_TIMEOUT_MS = 20_000;

async function request(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<{ httpStatus: number; body: ApiEnvelope }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    credentials: 'same-origin',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  let body: ApiEnvelope = {};
  try {
    body = (await res.json()) as ApiEnvelope;
  } catch {
    body = {};
  }
  return { httpStatus: res.status, body };
}

const TRASH_STATES = ['pending', 'stored', 'restoring', 'restored', 'aborted', 'conflicted', 'missing'] as const;

/**
 * 明确"零磁盘副作用"的 HTTP 状态（UX-02C-03-P2-02-R1-03）。
 *
 * 依据 Host 的回收端点契约：这些状态只会在进入事务**之前**产生。
 */
const ZERO_SIDE_EFFECT_STATUS: ReadonlySet<number> = new Set([400, 403, 404, 409, 422, 501]);

/** 503 里属于"前置拒绝"的错误码；其余 5xx 可能发生在移动之后。 */
const ZERO_SIDE_EFFECT_503_CODES: ReadonlySet<string> = new Set([
  'ERR_PROJECT_UNAVAILABLE',
  'ERR_ROOT_CHANGED',
  'ERR_ROOT_IDENTITY_UNSUPPORTED',
  'ERR_STORE_RESTRICTED',
]);

/* ---------------- 发送前裁决的运行时保护（R1-H1） ---------------- */

/** 运行时漏传 gate（JS 调用方 / 旧适配层）：不可用即拒绝，绝不"假装检查过"。 */
const TRASH_GATE_UNAVAILABLE_MESSAGE = '发送前授权检查不可用，已取消恢复（未发送请求）。';
/** gate 自己抛了异常：它与"没有授权"同性质，不能冒泡成 UNKNOWN。 */
const TRASH_GATE_THREW_MESSAGE = '发送前授权检查执行失败，已取消恢复（未发送请求）。';
/** gate 返回了无法识别的形状：同样按拒绝处理（fail-closed）。 */
const TRASH_GATE_INVALID_MESSAGE = '发送前授权检查返回了无法识别的结果，已取消恢复（未发送请求）。';

/** 拒绝裁决里允许的三个 `kind`，与 `TrashSendDecision` 的联合类型一一对应。 */
const TRASH_SEND_DECISION_KINDS: ReadonlySet<string> = new Set(['stale', 'blocked', 'invalidated']);

/** 构造一条"检查坏了"的拒绝裁决：统一走 `blocked`，只有文案不同。 */
const refuseSend = (message: string): TrashSendDecision => ({ ok: false, kind: 'blocked', message });

/**
 * 同步执行发送前裁决，并把三类"检查本身坏了"的情况收敛成**拒绝**（R1-H1-02 / H1-03）。
 *
 * 三条硬约束：
 * 1. **同步**：不返回 Promise、不 `await`——它必须与紧随其后的 `fetch()` 处于同一个
 *    同步片段里，否则又出现"检查通过、请求未发"的窗口；
 * 2. **不抛**：异常在这里咽掉并转成 `blocked`。若让它冒泡，Controller 的
 *    `catch` 会把它当成"网络中断"，于是一笔**根本没发出去**的恢复被写成待核对记录，
 *    用户看到「待核对」而磁盘其实什么都没发生；
 * 3. **fail-closed**：漏传 / 非函数 / 返回垃圾 → 一律拒绝（`blocked`，零请求）。
 *
 * R1-H1-RV1：受保护的不只是 `gate()` 这一次调用，而是**整段**取值与规范化——
 * 判断返回值是不是对象、读 `ok` / `kind` / `message` / `reasons`、逐字段校验、
 * 生成新裁决，全在同一个 `try` 里。理由：gate 的返回值不是可信数据，
 * 四个字段都可能是 getter，整个对象还可能是 `Proxy`；只包住 `gate()` 的话，
 * 一次属性访问抛异常照样会冒到调用方的 `catch`，被误判成 UNKNOWN。
 *
 * 同样地，**不把 gate 的原始对象传下去**：裁决一律是新构造的普通对象，
 * 免得调用方读到的字段与这里校验时看到的不是同一份值（或者干脆读到别的东西）。
 *
 * 只把"检查坏了"和"检查说不行"归到同一个 `blocked`：两者对调用方的处理完全相同
 * （零请求、可读原因、预留可安全释放），区别只在文案。
 */
function evaluateSendGate(gate: TrashSendGate | undefined): TrashSendDecision {
  if (typeof gate !== 'function') {
    return refuseSend(TRASH_GATE_UNAVAILABLE_MESSAGE);
  }
  try {
    const raw: unknown = gate();
    // 非对象（null / number / string / boolean / function / undefined）一律无法识别
    if (typeof raw !== 'object' || raw === null) return refuseSend(TRASH_GATE_INVALID_MESSAGE);
    const source = raw as { ok?: unknown; kind?: unknown; message?: unknown; reasons?: unknown };

    // 允许：只认 `ok === true`，其余字段一个都不读（它们可能是会抛异常的 getter）
    if (source.ok === true) return { ok: true };

    // 拒绝：`ok` 必须严格为 `false`；缺失或非布尔都算无法识别
    if (source.ok !== false) return refuseSend(TRASH_GATE_INVALID_MESSAGE);

    const kind = source.kind;
    if (typeof kind !== 'string' || !TRASH_SEND_DECISION_KINDS.has(kind)) {
      return refuseSend(TRASH_GATE_INVALID_MESSAGE);
    }

    const message = source.message;
    if (message !== undefined && typeof message !== 'string') {
      return refuseSend(TRASH_GATE_INVALID_MESSAGE);
    }

    const reasons = source.reasons;
    let normalizedReasons: string[] | undefined;
    if (reasons !== undefined) {
      // 逐项检查并**拷贝**：gate 之后改数组不能影响已经做出的裁决
      if (!Array.isArray(reasons)) return refuseSend(TRASH_GATE_INVALID_MESSAGE);
      const copy: string[] = [];
      for (const item of reasons as unknown[]) {
        if (typeof item !== 'string') return refuseSend(TRASH_GATE_INVALID_MESSAGE);
        copy.push(item);
      }
      normalizedReasons = copy;
    }

    return {
      ok: false,
      kind: kind as 'stale' | 'blocked' | 'invalidated',
      ...(message !== undefined ? { message } : {}),
      ...(normalizedReasons !== undefined ? { reasons: normalizedReasons } : {}),
    };
  } catch {
    return refuseSend(TRASH_GATE_THREW_MESSAGE);
  }
}

/** 仅供测试与文档引用：三条固定文案。 */
export const TRASH_SEND_GATE_MESSAGES = {
  unavailable: TRASH_GATE_UNAVAILABLE_MESSAGE,
  threw: TRASH_GATE_THREW_MESSAGE,
  invalid: TRASH_GATE_INVALID_MESSAGE,
} as const;



/**
 * 把一条回收记录收窄成 DTO（UX-02C-03-P2-02）。
 *
 * 形状不合法时返回 `null`，调用方按"响应不可信"整份拒绝——半条记录渲染出来，
 * 用户会以为"文件名丢了/大小是 0"，比直接说"读取失败"更糟。
 *
 * `path` 只接受项目内相对路径：绝对路径、盘符、`..` 段一律视为不可信
 * （Host 不会发这种值，出现就说明来源不对，不该拿去拼提示文案）。
 */
function parseTrashEntry(raw: unknown): TrashEntryDto | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.opId !== 'string' || row.opId === '') return null;
  if (typeof row.path !== 'string' || row.path === '') return null;
  if (/^[a-zA-Z]:|^[\\/]/.test(row.path)) return null;
  if (row.path.split('/').some((segment) => segment === '..')) return null;
  if (row.entryKind !== 'file') return null;
  if (typeof row.size !== 'number' || !Number.isSafeInteger(row.size) || row.size < 0) return null;
  if (typeof row.deletedAt !== 'string' || row.deletedAt === '') return null;
  const state = TRASH_STATES.find((item) => item === row.state);
  if (!state) return null;
  return {
    opId: row.opId,
    path: row.path,
    entryKind: 'file',
    size: row.size,
    deletedAt: row.deletedAt,
    state,
    // 服务端没说 canRestore 时按状态推导；绝不在非 stored 上给出 true
    canRestore: row.canRestore === true && state === 'stored',
    ...(typeof row.note === 'string' ? { note: row.note } : {}),
    ...(typeof row.restoredAt === 'string' ? { restoredAt: row.restoredAt } : {}),
  };
}

/**
 * live 客户端：同源 `/api`（开发时由 Vite 代理到 apps/server）。
 * 不缓存任何内容；每次操作都以服务端返回的会话状态为准。
 */
/**
 * 展示字段的窄化（UX-02C-04）。
 *
 * 三个字段都来自 Host，但仍然逐字段校验：形状不对就当"这一项没有"，
 * 绝不把 `undefined` / 数字 / 对象塞进 `className` 或 JSX（那会渲染出 `color-undefined`）。
 */
function metadataFieldsOf(raw: unknown): ResourceMetadataDto {
  if (typeof raw !== 'object' || raw === null) return { tags: [] };
  const row = raw as { alias?: unknown; tags?: unknown; color?: unknown };
  const tags: string[] = [];
  if (Array.isArray(row.tags)) {
    for (const item of row.tags as unknown[]) {
      if (typeof item === 'string' && item !== '') tags.push(item);
    }
  }
  return {
    ...(typeof row.alias === 'string' && row.alias !== '' ? { alias: row.alias } : {}),
    tags,
    ...(typeof row.color === 'string' && row.color !== '' ? { color: row.color } : {}),
  };
}

/** 三个字段全空时返回 `undefined`（"没有标注"只有一种表示）。 */
function metadataFieldsOrUndefined(raw: unknown): ResourceMetadataDto | undefined {
  if (raw === undefined || raw === null) return undefined;
  const fields = metadataFieldsOf(raw);
  if (fields.alias === undefined && fields.tags.length === 0 && fields.color === undefined) return undefined;
  return fields;
}

/**
 * 树条目的窄化：元数据字段形状不对就当"没有标注"。
 *
 * 这里**不推导**任何东西（不做路径猜测、不做继承）：Host 已经按对象身份核验过，
 * 客户端多推一步只会在将来引入第二种"什么算同一个文件"的判定。
 */
function normalizeTreeEntry(entry: TreeEntry): TreeEntry {
  if (typeof entry !== 'object' || entry === null) return entry;
  const meta = metadataFieldsOrUndefined((entry as { meta?: unknown }).meta);
  const { meta: _ignored, ...rest } = entry as TreeEntry & { meta?: unknown };
  return (meta ? { ...rest, meta } : rest) as TreeEntry;
}

export function createLiveClient(baseUrl = ''): WeaveSpaceClient {
  /**
   * 取一个会话令牌（T1）。
   *
   * 令牌只证明"请求来自本机 Host 的页面"，不证明任何目录权限；它会被放在
   * `x-ws-token` 头里，由 Host 在每个变更类请求上重新校验。
   */
  const sessionToken = async (): Promise<string> => {
    const { httpStatus, body } = await request(baseUrl, '/api/session-token');
    const token = (body as { token?: unknown }).token;
    if (httpStatus !== 200 || typeof token !== 'string' || token === '') {
      throw new Error(`session-token ${httpStatus}`);
    }
    return token;
  };

  return {
    mode: 'live',
    async workspaceMode() {
      const { body } = await request(baseUrl, '/api/health');
      const mode = (body as { workspaceMode?: string }).workspaceMode;
      // 旧版服务端没有该字段 → 只能是 legacy；不得假定 Multi
      return mode === 'multi' ? 'multi' : 'legacy';
    },
    async workspaceIdentity() {
      const { httpStatus, body } = await request(baseUrl, '/api/health');
      /**
       * 必须是**成功的**健康响应才算"连上了 Host"。
       *
       * 开发代理在 Host 未启动时会返回 5xx/非 JSON，`request()` 会把它降级成空 body；
       * 若在这里当成"旧版服务端（没有摘要）"继续走，就会出现"以为连上了、其实是空工作区"
       * 的假象。因此这里直接抛错，由调用方按"Host 不可用"降级。
       */
      if (httpStatus !== 200) throw new Error(`health ${httpStatus}`);
      const asHealth = body as { status?: string; workspaceMode?: string; workspaceKey?: unknown };
      if (asHealth.status !== 'APPLIED') throw new Error('health not applied');
      const mode: WorkspaceMode = asHealth.workspaceMode === 'multi' ? 'multi' : 'legacy';
      // 只接受"像摘要"的字符串；其余一律视为"身份不可确认"
      const key =
        typeof asHealth.workspaceKey === 'string' && /^[0-9a-zA-Z_-]{16,128}$/.test(asHealth.workspaceKey)
          ? asHealth.workspaceKey
          : null;
      return { workspaceMode: mode, workspaceKey: key };
    },
    async listProjects() {
      const { httpStatus, body } = await request(baseUrl, '/api/projects');
      if (httpStatus === 404) return [];
      const projects = (body as { projects?: ProjectSummary[] }).projects;
      return Array.isArray(projects) ? projects : [];
    },
    async listResources(projectId?: string) {
      const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
      const { body } = await request(baseUrl, `/api/resources${query}`);
      return Array.isArray((body as { nodes?: ResourceNode[] }).nodes)
        ? ((body as { nodes: ResourceNode[] }).nodes ?? [])
        : [];
    },
    async listTree(projectId, dir, cursor, limit, snapshot, options) {
      const query = new URLSearchParams();
      if (projectId) query.set('projectId', projectId);
      if (dir) query.set('dir', dir);
      if (cursor !== null && cursor !== undefined) query.set('cursor', cursor);
      if (limit !== undefined) query.set('limit', String(limit));
      if (snapshot !== null && snapshot !== undefined) query.set('snapshot', snapshot);
      if (options?.includeHidden) query.set('includeHidden', '1');
      const suffix = query.toString();
      const { httpStatus, body } = await request(baseUrl, `/api/tree${suffix ? `?${suffix}` : ''}`);
      if (httpStatus !== 200 || body.status !== 'APPLIED') {
        return { status: 'REJECTED' as const, errorCode: body.errorCode ?? null, message: body.message };
      }
      const asTree = body as unknown as {
        level?: string;
        entries?: TreeEntry[];
        page?: Partial<TreePageMeta>;
        projectMeta?: unknown;
      };
      // 响应形状不完整时按"拒绝"处理，绝不把半截数据渲染成一棵不完整的树
      const entries = Array.isArray(asTree.entries) ? asTree.entries.map(normalizeTreeEntry) : null;
      const page = asTree.page;
      if (!entries || !page || typeof page.total !== 'number') {
        return { status: 'REJECTED' as const, errorCode: 'ERR_COMMAND_INTERNAL', message: '目录响应不完整' };
      }
      const projectMeta = metadataFieldsOrUndefined(asTree.projectMeta);
      return {
        status: 'APPLIED' as const,
        level: typeof asTree.level === 'string' ? asTree.level : dir,
        entries,
        ...(projectMeta ? { projectMeta } : {}),
        page: {
          limit: typeof page.limit === 'number' ? page.limit : entries.length,
          cursor: page.cursor ?? null,
          nextCursor: page.nextCursor ?? null,
          total: page.total,
          snapshot: typeof page.snapshot === 'string' ? page.snapshot : null,
          // 旧版服务端不返回该字段：保持"缺失"，不要伪造成真实的 0（R1-01 要求 6）
          ...(typeof page.hiddenCount === 'number' ? { hiddenCount: page.hiddenCount } : {}),
        },
      };
    },
    async openDocument(path: string, projectId?: string, options?: { reclaimPrevious?: boolean }) {
      // 页面实例 id：只用于归属识别（Host 不会据此放行任何操作）。
      // 解析失败（无 sessionStorage / 抢不到锁）就不带该字段，服务端退回旧语义。
      const instanceId = await pageInstanceId();
      const reclaim = options?.reclaimPrevious === true && instanceId !== null;
      const { body } = await request(baseUrl, '/api/open', {
        method: 'POST',
        body: JSON.stringify({
          ...(projectId ? { projectId } : {}),
          path,
          ...(instanceId ? { clientInstanceId: instanceId } : {}),
          // 只有页面恢复才申请回收：普通打开 / 临时打开一律不提这个要求
          ...(reclaim ? { reclaimPrevious: true } : {}),
        }),
      });
      return {
        status: body.status === 'APPLIED' ? 'APPLIED' : 'REJECTED',
        errorCode: body.errorCode ?? null,
        message: body.message,
        document: body.document,
        reloaded: (body as { reloaded?: boolean }).reloaded === true,
      };
    },
    async readDocument(sessionId: string, viewId?: string | null) {
      const query = new URLSearchParams({ sessionId });
      if (viewId) query.set('viewId', viewId);
      const { body } = await request(baseUrl, `/api/document?${query.toString()}`);
      return {
        status: body.status === 'APPLIED' ? 'APPLIED' : 'REJECTED',
        errorCode: body.errorCode ?? null,
        message: body.message,
        document: body.document,
      };
    },
    async applyEdit(
      sessionId: string,
      buffer: string,
      expectedVersion?: string | null,
      viewId?: string | null,
    ) {
      const { body } = await request(baseUrl, '/api/edit', {
        method: 'POST',
        body: JSON.stringify({
          sessionId,
          buffer,
          expectedVersion: expectedVersion ?? undefined,
          // Multi 必须带 viewId（会话归属校验）；Legacy 允许省略
          ...(viewId ? { viewId } : {}),
        }),
      });
      return {
        status: body.status === 'APPLIED' ? 'APPLIED' : 'REJECTED',
        errorCode: body.errorCode ?? null,
        message: body.message,
        document: body.document,
      };
    },
    async saveDocument(sessionId: string, expectedVersion: string, viewId?: string | null) {
      const { body } = await request(baseUrl, '/api/save', {
        method: 'POST',
        body: JSON.stringify({ sessionId, expectedVersion, viewId: viewId ?? undefined }),
      });
      const status: SaveStatus =
        body.status === 'COMMITTED' || body.status === 'CONFLICT' || body.status === 'FAILED' || body.status === 'UNKNOWN'
          ? body.status
          : 'FAILED';
      return {
        status,
        errorCode: body.errorCode ?? null,
        contentVersion: body.contentVersion ?? null,
        document: body.document,
        ...(body.hiddenRefresh === 'none' ||
        body.hiddenRefresh === 'refreshed' ||
        body.hiddenRefresh === 'skipped' ||
        body.hiddenRefresh === 'failed'
          ? { hiddenRefresh: body.hiddenRefresh }
          : {}),
        ...(typeof body.hiddenRefreshReason === 'string'
          ? { hiddenRefreshReason: body.hiddenRefreshReason }
          : {}),
      };
    },
    async closeDocument(sessionId: string, viewId: string) {
      const { body } = await request(baseUrl, '/api/close', {
        method: 'POST',
        body: JSON.stringify({ sessionId, viewId }),
      });
      return {
        status: body.status === 'APPLIED' ? 'APPLIED' : 'REJECTED',
        errorCode: body.errorCode ?? null,
        message: body.message,
      };
    },
    async reclaimPageViews(input) {
      // 没有页面身份 → 不知道这些 View 是不是"本页面上轮"的，宁可不回收。
      const instanceId = await pageInstanceId();
      if (!instanceId || input.paths.length === 0) {
        return { status: 'REJECTED', closed: 0, blocked: 0, errorCode: null };
      }
      let token: string;
      try {
        token = await sessionToken();
      } catch {
        return { status: 'REJECTED', closed: 0, blocked: 0, errorCode: 'ERR_PERMISSION_DENIED' };
      }
      const { httpStatus, body } = await request(baseUrl, '/api/views/reclaim', {
        method: 'POST',
        headers: { 'x-ws-token': token },
        body: JSON.stringify({
          ...(input.projectId ? { projectId: input.projectId } : {}),
          clientInstanceId: instanceId,
          paths: input.paths,
          ...(input.keepViewIds && input.keepViewIds.length > 0
            ? { keepViewIds: input.keepViewIds }
            : {}),
        }),
      });
      const asReclaim = body as { closed?: unknown; blocked?: unknown };
      const blocked = Array.isArray(asReclaim.blocked) ? asReclaim.blocked.length : 0;
      return {
        status: httpStatus === 200 && body.status === 'APPLIED' ? 'APPLIED' : 'REJECTED',
        closed: typeof asReclaim.closed === 'number' ? asReclaim.closed : 0,
        blocked,
        errorCode: body.errorCode ?? null,
      };
    },
    async readDisk(sessionId: string, viewId?: string | null) {
      const query = new URLSearchParams({ sessionId });
      if (viewId) query.set('viewId', viewId);
      const { body } = await request(baseUrl, `/api/document/disk?${query.toString()}`);
      const asDisk = body as { content?: string; contentVersion?: string };
      if (body.status === 'APPLIED' && typeof asDisk.content === 'string') {
        return {
          status: 'APPLIED' as const,
          content: asDisk.content,
          contentVersion: asDisk.contentVersion ?? '',
        };
      }
      return { status: 'REJECTED' as const, errorCode: body.errorCode ?? null, message: body.message };
    },
    async reloadDocument(sessionId: string, viewId: string) {
      const { body } = await request(baseUrl, '/api/reload', {
        method: 'POST',
        body: JSON.stringify({ sessionId, viewId, discardDraft: true }),
      });
      return {
        status: body.status === 'APPLIED' ? 'APPLIED' : 'REJECTED',
        errorCode: body.errorCode ?? null,
        message: body.message,
        document: body.document,
        previousDraft: (body as { previousDraft?: string }).previousDraft,
      };
    },

    async registrationSupport() {
      const { httpStatus, body } = await request(baseUrl, '/api/projects/registration');
      const asReg = body as { supported?: unknown; mode?: unknown };
      const mode = typeof asReg.mode === 'string' ? asReg.mode : '';
      if (httpStatus !== 200 || body.status !== 'APPLIED') {
        // 旧版 Host 没有这个端点：不得假定"可以添加"，也不得猜一个模式
        return { support: 'unknown' as const, mode: mode || 'unknown' };
      }
      const support: ProjectRegistrationSupport =
        asReg.supported === true
          ? 'managed'
          : mode === 'static'
            ? 'static'
            : mode === 'legacy'
              ? 'legacy'
              : 'unknown';
      return { support, mode: mode || support };
    },

    async bootstrapPick() {
      const { httpStatus, body } = await request(baseUrl, '/api/session-token');
      const token = (body as { token?: unknown }).token;
      if (httpStatus !== 200 || typeof token !== 'string' || token === '') {
        throw new Error(`session-token ${httpStatus}`);
      }
      const intent = (body as { intent?: { intentId?: unknown } }).intent;
      const intentId =
        intent && typeof intent.intentId === 'string' && intent.intentId !== '' ? intent.intentId : null;
      return { token, intentId };
    },

    async startPick(input) {
      const { httpStatus, body } = await request(baseUrl, '/api/projects/pick', {
        method: 'POST',
        headers: { 'x-ws-token': input.token },
        // 只发协议字段：目录与授权凭据只能由 Host 内部产生
        body: JSON.stringify({
          intentId: input.intentId,
          acknowledgeScope: input.acknowledgeScope,
          ...(input.name && input.name.trim() !== '' ? { name: input.name.trim() } : {}),
        }),
      });
      const requestId = (body as { requestId?: unknown }).requestId;
      if (httpStatus === 202 && body.status === 'PENDING' && typeof requestId === 'string' && requestId !== '') {
        return { status: 'PENDING' as const, requestId, httpStatus };
      }
      return {
        status: 'REJECTED' as const,
        errorCode: body.errorCode ?? null,
        message: body.message,
        httpStatus,
      };
    },

    async queryPick(input) {
      const query = new URLSearchParams({ requestId: input.requestId });
      const { httpStatus, body } = await request(baseUrl, `/api/projects/pick?${query.toString()}`, {
        headers: { 'x-ws-token': input.token },
      });
      const asPick = body as { requestId?: unknown; project?: ProjectSummary };
      /**
       * 判定依据是 **HTTP 2xx + body.status**，不是"200"。
       *
       * `PENDING` 记录的 HTTP 状态是 `202 Accepted`（已受理、尚未完成）。若把 202 当错误，
       * 用户在系统窗口里慢慢挑文件夹时，界面会立刻报"添加失败"并停止轮询 —— 而这一次
       * 选择其实完全正常。非 2xx（403/410/501）才是真的拒绝。
       */
      const accepted = httpStatus >= 200 && httpStatus < 300;
      if (accepted) {
        if (body.status === 'APPLIED' && asPick.project) {
          return {
            status: 'APPLIED' as const,
            project: asPick.project,
            requestId: typeof asPick.requestId === 'string' ? asPick.requestId : input.requestId,
            httpStatus,
          };
        }
        if (body.status === 'PENDING') {
          return { status: 'PENDING' as const, requestId: input.requestId, httpStatus };
        }
        if (body.status === 'CANCELLED') {
          return { status: 'CANCELLED' as const, requestId: input.requestId, httpStatus };
        }
      }
      return {
        status: 'REJECTED' as const,
        requestId: input.requestId,
        errorCode: body.errorCode ?? null,
        reason: (body as { reason?: string }).reason,
        message: body.message,
        httpStatus,
      };
    },

    async renameProject(projectId: string, name: string) {
      // 重命名属于变更类请求：先取令牌，Host 会重新校验（T1），不是"取过一次就长期有效"
      let token: string;
      try {
        token = await sessionToken();
      } catch {
        return { status: 'REJECTED' as const, errorCode: 'ERR_PERMISSION_DENIED', message: '无法获取会话令牌', httpStatus: 403 };
      }
      const { httpStatus, body } = await request(baseUrl, '/api/projects/rename', {
        method: 'POST',
        headers: { 'x-ws-token': token },
        body: JSON.stringify({ projectId, name }),
      });
      const project = (body as { project?: ProjectSummary }).project;
      if (httpStatus === 200 && body.status === 'APPLIED' && project) {
        return { status: 'APPLIED' as const, project };
      }
      return {
        status: 'REJECTED' as const,
        errorCode: body.errorCode ?? null,
        message: body.message ?? '重命名失败',
        httpStatus,
      };
    },

    async removalPrecheck(projectId: string) {
      let token: string;
      try {
        token = await sessionToken();
      } catch {
        return { status: 'REJECTED' as const, errorCode: 'ERR_PERMISSION_DENIED', message: '无法获取会话令牌', httpStatus: 403 };
      }
      const { httpStatus, body } = await request(baseUrl, '/api/projects/removal-precheck', {
        method: 'POST',
        headers: { 'x-ws-token': token },
        body: JSON.stringify({ projectId }),
      });
      const asPre = body as {
        allowed?: unknown;
        blockedBy?: unknown;
        state?: unknown;
        errorCode?: string | null;
        message?: string;
      };
      if (httpStatus === 200 && body.status === 'APPLIED' && typeof asPre.allowed === 'boolean') {
        return {
          status: 'APPLIED' as const,
          projectId,
          allowed: asPre.allowed,
          blockedBy: Array.isArray(asPre.blockedBy) ? (asPre.blockedBy as RemoveBlockerCode[]) : [],
          state: typeof asPre.state === 'string' ? asPre.state : 'ACTIVE',
        };
      }
      return {
        status: 'REJECTED' as const,
        errorCode: asPre.errorCode ?? null,
        message: asPre.message ?? '前置检查失败',
        httpStatus,
      };
    },

    async removeProject(projectId: string, opId: string) {
      let token: string;
      try {
        token = await sessionToken();
      } catch {
        return { status: 'REJECTED' as const, errorCode: 'ERR_PERMISSION_DENIED', message: '无法获取会话令牌', httpStatus: 403 };
      }
      let response: { httpStatus: number; body: ApiEnvelope };
      try {
        response = await request(baseUrl, '/api/projects/remove', {
          method: 'POST',
          headers: { 'x-ws-token': token },
          // 确认字段是硬性契约：缺失即 400；opId 由调用方先落定，超时后才能查证据
          body: JSON.stringify({ projectId, confirm: 'remove-from-workspace', opId }),
        });
      } catch {
        /**
         * 断线 / AbortError（20s 超时）/ 代理重置：请求**可能已经到达 Host**。
         * 这里不能抛：调用方需要拿到"结果不明"这个结论，才能用同一个 `opId`
         * 去查持久证据。抛出去只会让界面停在"正在移除…"。
         */
        return {
          status: 'REJECTED' as const,
          errorCode: 'ERR_OUTCOME_UNKNOWN',
          message: '网络中断或请求超时，移除结果未知',
          httpStatus: 0,
        };
      }
      const { httpStatus, body } = response;
      const asRemove = body as {
        outcome?: unknown;
        blockedBy?: unknown;
        opId?: unknown;
        configPersisted?: unknown;
        errorCode?: string | null;
        message?: string;
      };
      // 判定以 body.outcome 为准（配置补写失败时是 5xx，但移除**已生效**）
      if (asRemove.outcome === 'revoked') {
        return {
          status: 'APPLIED' as const,
          projectId,
          opId: typeof asRemove.opId === 'string' ? asRemove.opId : opId,
          configPersisted: asRemove.configPersisted !== false,
        };
      }
      if (asRemove.outcome === 'aborted') {
        return {
          status: 'ABORTED' as const,
          projectId,
          blockedBy: Array.isArray(asRemove.blockedBy) ? (asRemove.blockedBy as RemoveBlockerCode[]) : [],
        };
      }
      return {
        status: 'REJECTED' as const,
        errorCode: asRemove.errorCode ?? null,
        message: asRemove.message ?? '移除失败',
        httpStatus,
      };
    },

    async queryRemovalOp(opId: string) {
      let token: string;
      try {
        token = await sessionToken();
      } catch {
        return { status: 'REJECTED' as const, errorCode: 'ERR_PERMISSION_DENIED', message: '无法获取会话令牌', httpStatus: 403 };
      }
      let response: { httpStatus: number; body: ApiEnvelope };
      try {
        response = await request(baseUrl, `/api/projects/op?opId=${encodeURIComponent(opId)}`, {
          headers: { 'x-ws-token': token },
        });
      } catch {
        // 只读查询失败同样是"没有证据"，不抛：调用方会退到"只读刷新列表 + 人工核对"
        return {
          status: 'REJECTED' as const,
          errorCode: 'ERR_STORAGE_IO',
          message: '无法查询操作结果',
          httpStatus: 0,
        };
      }
      const { httpStatus, body } = response;
      const asOp = body as {
        outcome?: unknown;
        projectId?: unknown;
        errorCode?: string | null;
        message?: string;
      };
      if (
        httpStatus === 200 &&
        (asOp.outcome === 'revoked' ||
          asOp.outcome === 'created' ||
          asOp.outcome === 'aborted' ||
          asOp.outcome === 'unknown')
      ) {
        return {
          status: 'APPLIED' as const,
          opId,
          outcome: asOp.outcome,
          // 归属由 Host 的持久证据给出；缺失即视为"没有归属"，调用方不得据此认领
          projectId: typeof asOp.projectId === 'string' && asOp.projectId !== '' ? asOp.projectId : null,
        };
      }
      return {
        status: 'REJECTED' as const,
        errorCode: asOp.errorCode ?? null,
        message: asOp.message ?? '结果查询失败',
        httpStatus,
      };
    },

    async createEntry(projectId, parentDir, name, kind) {
      let token: string;
      try {
        token = await sessionToken();
      } catch {
        return {
          status: 'REJECTED' as const,
          errorCode: 'ERR_PERMISSION_DENIED',
          message: '无法获取会话令牌',
          httpStatus: 403,
        };
      }
      const endpoint = kind === 'file' ? '/api/files/create' : '/api/directories/create';
      let response: { httpStatus: number; body: ApiEnvelope };
      try {
        response = await request(baseUrl, endpoint, {
          method: 'POST',
          headers: { 'x-ws-token': token },
          // 只提交相对目录 + 单段名称：没有任何路径/根/令牌/providerId 字段
          body: JSON.stringify({ projectId, parentDir, name }),
        });
      } catch {
        /**
         * 断线 / AbortError / 代理重置：请求**可能已经到达 Host 并创建了对象**。
         * 只能是 UNKNOWN：不许重发，由编排层做一次只读目录核对 + 人工确认提示。
         */
        return {
          status: 'UNKNOWN' as const,
          errorCode: 'ERR_OUTCOME_UNKNOWN',
          message: '网络中断或请求超时，创建结果未知',
          httpStatus: 0,
        };
      }
      const { httpStatus, body } = response;
      if (httpStatus === 202 && body.status === 'UNKNOWN') {
        return {
          status: 'UNKNOWN' as const,
          errorCode: 'ERR_OUTCOME_UNKNOWN',
          message: body.message ?? '创建结果未确认，请刷新目录人工核对',
          httpStatus,
        };
      }
      if (httpStatus === 200 && body.status === 'APPLIED') {
        const applied = body as unknown as { relativePath?: unknown };
        // 回执形状不完整时不冒充成功：客户端不能自己猜相对路径
        if (typeof applied.relativePath === 'string' && applied.relativePath !== '') {
          return {
            status: 'APPLIED' as const,
            projectId,
            parentDir,
            name,
            kind,
            relativePath: applied.relativePath,
          };
        }
      }
      return {
        status: 'REJECTED' as const,
        errorCode: body.errorCode ?? (httpStatus === 200 ? 'ERR_COMMAND_INTERNAL' : null),
        message: body.message ?? '创建失败',
        httpStatus,
      };
    },

    async renameEntry(projectId, sourcePath, name) {
      return postStructureChange(
        '/api/files/rename',
        { projectId, sourcePath, name },
        { projectId, sourcePath, targetParentDir: '', targetName: name },
      );
    },

    async moveEntry(projectId, sourcePath, targetParentDir, name) {
      return postStructureChange(
        '/api/files/move',
        { projectId, sourcePath, targetParentDir, name },
        { projectId, sourcePath, targetParentDir, targetName: name },
      );
    },

    async hideEntry(projectId, path) {
      return postVisibility('/api/workspace/hide', projectId, path, true);
    },

    async unhideEntry(projectId, path) {
      return postVisibility('/api/workspace/unhide', projectId, path, false);
    },

    async hiddenEntries(projectId) {
      let token: string;
      try {
        token = await sessionToken();
      } catch {
        return {
          status: 'REJECTED' as const,
          errorCode: 'ERR_PERMISSION_DENIED',
          message: '无法获取会话令牌',
        };
      }
      let response: { httpStatus: number; body: ApiEnvelope };
      try {
        response = await request(
          baseUrl,
          `/api/workspace/hidden?projectId=${encodeURIComponent(projectId)}`,
          { headers: { 'x-ws-token': token } },
        );
      } catch {
        return { status: 'REJECTED' as const, errorCode: 'ERR_STORAGE_IO', message: '读取隐藏记录失败' };
      }
      const { httpStatus, body } = response;
      if (httpStatus !== 200 || body.status !== 'APPLIED') {
        return {
          status: 'REJECTED' as const,
          errorCode: body.errorCode ?? null,
          message: body.message,
        };
      }
      const raw = (body as unknown as { entries?: unknown }).entries;
      const entries: HiddenEntryDto[] = [];
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (typeof item !== 'object' || item === null) continue;
          const path = (item as { path?: unknown }).path;
          const state = (item as { state?: unknown }).state;
          if (typeof path !== 'string') continue;
          entries.push({
            path,
            state:
              state === 'missing' || state === 'rebound' || state === 'unverified'
                ? state
                : 'active',
          });
        }
      }
      return { status: 'APPLIED' as const, projectId, entries };
    },

    /* ---- UX-02C-03-P2-02：回收区 ---- */

    async listTrash(projectId) {
      let token: string;
      try {
        token = await sessionToken();
      } catch {
        return {
          status: 'REJECTED' as const,
          errorCode: 'ERR_PERMISSION_DENIED',
          message: '无法获取会话令牌',
          httpStatus: 403,
        };
      }
      let response: { httpStatus: number; body: ApiEnvelope };
      try {
        response = await request(
          baseUrl,
          `/api/trash?projectId=${encodeURIComponent(projectId)}`,
          { headers: { 'x-ws-token': token } },
        );
      } catch {
        return { status: 'REJECTED' as const, errorCode: 'ERR_STORAGE_IO', message: '读取回收区失败，请稍后重试', httpStatus: 0 };
      }
      const { httpStatus, body } = response;
      if (httpStatus !== 200 || body.status !== 'APPLIED') {
        return {
          status: 'REJECTED' as const,
          errorCode: body.errorCode ?? null,
          message: body.message ?? '读取回收区失败',
          httpStatus,
        };
      }
      const raw = (body as unknown as { entries?: unknown }).entries;
      // 形状不完整时按拒绝处理：绝不把半截列表渲染成"回收区里只剩这些"
      if (!Array.isArray(raw)) {
        return { status: 'REJECTED' as const, errorCode: 'ERR_COMMAND_INTERNAL', message: '回收区响应不完整', httpStatus };
      }
      const entries: TrashEntryDto[] = [];
      for (const item of raw) {
        const parsed = parseTrashEntry(item);
        if (!parsed) {
          return { status: 'REJECTED' as const, errorCode: 'ERR_COMMAND_INTERNAL', message: '回收区记录形状不合法', httpStatus };
        }
        entries.push(parsed);
      }
      const count = typeof (body as unknown as { count?: unknown }).count === 'number'
        ? ((body as unknown as { count: number }).count)
        : entries.length;
      // count 与 entries 不一致时以 entries 为准并明确拒绝——两个数不可能都对
      if (count !== entries.length) {
        return { status: 'REJECTED' as const, errorCode: 'ERR_COMMAND_INTERNAL', message: '回收区数量与列表不一致', httpStatus };
      }
      return { status: 'APPLIED' as const, projectId, count, entries };
    },

    async trashEntry(projectId, path, opId) {
      // 移入回收区不依赖 R1 的最终裁决：没有"待核对预留"这回事（H1-01 注意条款）
      return postTrashAction('/api/trash/entry', { projectId, path, opId }, projectId, opId, null);
    },

    async restoreTrash(projectId, opId, gate) {
      /*
       * 恢复**必须**带裁决（R1-H1）。这里传的是包装对象而不是裸的 gate：
       * 只有"恢复"这条路径会走到 `evaluateSendGate`，而 `trashEntry` 明确传 `null`，
       * 于是"要不要检查"在类型与代码上都只有一种解释，不靠调用方自觉。
       */
      return postTrashAction('/api/trash/restore', { projectId, opId }, projectId, opId, { gate });
    },


    /* ---- UX-02C-04：资源标注名 / 标签 / 行颜色 ---- */

    async setResourceMetadata(projectId, path, patch) {
      // 只把**用户真的改过**的字段发出去：没传的字段由 Host 保持原值
      const payload: Record<string, unknown> = { projectId, path };
      if (patch.alias !== undefined) payload.alias = patch.alias;
      if (patch.tags !== undefined) payload.tags = patch.tags;
      if (patch.color !== undefined) payload.color = patch.color;
      return postMetadata('/api/metadata/set', payload);
    },

    async clearResourceMetadata(projectId, path) {
      return postMetadata('/api/metadata/clear', { projectId, path });
    },

    async resourceMetadata(projectId) {
      let token: string;
      try {
        token = await sessionToken();
      } catch {
        return { status: 'REJECTED' as const, errorCode: 'ERR_PERMISSION_DENIED', message: '无法获取会话令牌' };
      }
      let response: { httpStatus: number; body: ApiEnvelope };
      try {
        response = await request(baseUrl, `/api/metadata?projectId=${encodeURIComponent(projectId)}`, {
          headers: { 'x-ws-token': token },
        });
      } catch {
        return { status: 'REJECTED' as const, errorCode: 'ERR_STORAGE_IO', message: '读取资源标注失败' };
      }
      const { httpStatus, body } = response;
      if (httpStatus !== 200 || body.status !== 'APPLIED') {
        return { status: 'REJECTED' as const, errorCode: body.errorCode ?? null, message: body.message };
      }
      const raw = (body as unknown as { entries?: unknown }).entries;
      const entries: MetadataEntryDto[] = [];
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (typeof item !== 'object' || item === null) continue;
          const row = item as { path?: unknown; state?: unknown };
          if (typeof row.path !== 'string') continue;
          entries.push({
            path: row.path,
            state:
              row.state === 'missing' || row.state === 'rebound' || row.state === 'unverified'
                ? row.state
                : 'active',
            ...metadataFieldsOf(item),
          });
        }
      }
      return { status: 'APPLIED' as const, projectId, entries };
    },

    async queryTrashOp(projectId, opId) {
      let token: string;
      try {
        token = await sessionToken();
      } catch {
        return { status: 'REJECTED' as const, errorCode: 'ERR_PERMISSION_DENIED', message: '无法获取会话令牌', httpStatus: 403 };
      }
      let response: { httpStatus: number; body: ApiEnvelope };
      try {
        response = await request(
          baseUrl,
          `/api/trash/op?opId=${encodeURIComponent(opId)}&projectId=${encodeURIComponent(projectId)}`,
          { headers: { 'x-ws-token': token } },
        );
      } catch {
        return { status: 'REJECTED' as const, errorCode: 'ERR_STORAGE_IO', message: '无法核对回收结果', httpStatus: 0 };
      }
      const { httpStatus, body } = response;
      const asOp = body as unknown as { outcome?: unknown; state?: unknown; errorCode?: string | null; message?: string };
      const outcomes = ['trashed', 'restored', 'aborted', 'conflicted', 'missing', 'unknown', 'none'] as const;
      const outcome = outcomes.find((item) => item === asOp.outcome);
      if ((httpStatus === 200 || httpStatus === 202) && outcome) {
        const state = asOp.state;
        const validStates = ['pending', 'stored', 'restoring', 'restored', 'aborted', 'conflicted', 'missing'];
        return {
          status: 'APPLIED' as const,
          opId,
          outcome,
          state: typeof state === 'string' && validStates.includes(state) ? (state as TrashEntryState) : null,
        };
      }
      return {
        status: 'REJECTED' as const,
        errorCode: asOp.errorCode ?? null,
        message: asOp.message ?? '核对回收结果失败',
        httpStatus,
      };
    },
  };

  /**
   * 回收 / 恢复共用的请求与收敛（UX-02C-03-P2-02）。
   *
   * 与结构变更同一纪律：**磁盘可能已经变了**的三种情况（网络异常、超时、202 UNKNOWN）
   * 一律返回 UNKNOWN 并保留 `opId`，由编排层做一次只读核对 + 人工确认提示。
   *
   * R1-01：`sendGuard` 非空时，`gate` 在**令牌到手之后、请求发出之前**同步执行一次。
   * 从 `await sessionToken()` 结束到 `request(...)` 之间**不允许**再有任何 `await`——
   * `request()` 的第一句就是 `fetch()`，因此这里的同步片段就是真正的 POST 边界。
   *
   * R1-H1：`sendGuard` 用"包装对象 / null"而不是可选参数表达——
   * - `null` ＝ 这条路径不需要裁决（只有 `trashEntry` 是这样）；
   * - `{ gate }` ＝ 必须有裁决，且 `gate` 漏传 / 抛异常 / 返回垃圾一律 fail-closed。
   */
  async function postTrashAction(
    endpoint: string,
    requestBody: { projectId: string; path?: string; opId: string },
    projectId: string,
    opId: string,
    sendGuard: { readonly gate: TrashSendGate } | null,
  ): Promise<TrashActionOutcome> {
    let token: string;
    try {
      token = await sessionToken();
    } catch {
      return {
        status: 'REJECTED',
        projectId,
        opId,
        errorCode: 'ERR_PERMISSION_DENIED',
        message: '无法获取会话令牌',
        httpStatus: 403,
      };
    }
    /*
     * 最终裁决（R1-01 / R1-H1-03）。这一段到下面 `request(...)` 之间**必须**保持同步：
     * 一旦插入 `await`，就又出现"检查通过、请求未发"的窗口，等于什么都没修。
     * `evaluateSendGate` 自己把异常咽掉并转成 `blocked`，所以这里不会抛。
     */
    if (sendGuard) {
      const decision = evaluateSendGate(sendGuard.gate);
      if (!decision.ok) {
        return {
          status: 'NOT_SENT',
          projectId,
          opId,
          reason: decision.kind,
          message: decision.message ?? null,
          ...(decision.reasons ? { reasons: decision.reasons } : {}),
        };
      }
    }
    let response: { httpStatus: number; body: ApiEnvelope };
    try {
      response = await request(baseUrl, endpoint, {
        method: 'POST',
        headers: { 'x-ws-token': token },
        // 只有 projectId + 项目内相对路径 + opId：没有目标路径、没有身份、没有绝对路径
        body: JSON.stringify(requestBody),
      });
    } catch {
      return {
        status: 'UNKNOWN',
        projectId,
        opId,
        message: '网络中断或请求超时，结果未确认',
        httpStatus: 0,
      };
    }
    const { httpStatus, body } = response;
    if (httpStatus === 202 && body.status === 'UNKNOWN') {
      return {
        status: 'UNKNOWN',
        projectId,
        opId,
        message: body.message ?? '结果未确认，请在回收区核对（不会自动重发）',
        httpStatus,
      };
    }

    /*
     * Host 说 APPLIED，但回执里没有一条能验证的记录（字段缺失/形状非法）。
     *
     * 这**不是**"被拒绝"：Host 已经声明这次操作成功，磁盘大概率已经变了。
     * 报 REJECTED 会让用户以为"什么都没发生"然后再点一次——那才是真正会重复移动文件
     * 的路径。所以按 UNKNOWN 处理：保留 opId，交给编排层做一次只读核对。
     */
    if (body.status === 'APPLIED') {
      const entry = httpStatus === 200
        ? parseTrashEntry((body as unknown as { entry?: unknown }).entry)
        : null;
      if (entry) {
        return {
          status: 'APPLIED',
          projectId,
          opId,
          entry,
          replayed: (body as unknown as { replayed?: unknown }).replayed === true,
        };
      }
      return {
        status: 'UNKNOWN',
        projectId,
        opId,
        message: '服务端已确认操作成功，但回执无法核验；请到回收区核对（不会自动重发）。',
        httpStatus,
      };
    }

    /*
     * 哪些失败能确认"零磁盘副作用"（依据 Host 的事务契约，不是猜）：
     * - 4xx：回收/恢复端点的 400/403/404/409/422 全部出现在**动盘之前**的校验
     *   （形状、会话、授权、路径边界、条目种类、同名冲突、忙碌屏障）；
     * - 501：当前运行模式不支持，端点根本没进入事务；
     * - 503：只有"项目/根不可用"这类前置拒绝是零副作用，其余 5xx 可能发生在
     *   `trashEntry`/`restoreEntry` 之后（正文已移动、状态没提交），必须按未确认处理。
     *
     * 因此不能简单地"5xx = 失败"：那会把一次真实的移动报告成"没有发生"。
     */
    const zeroSideEffect =
      ZERO_SIDE_EFFECT_STATUS.has(httpStatus) ||
      (httpStatus === 503 &&
        typeof body.errorCode === 'string' &&
        ZERO_SIDE_EFFECT_503_CODES.has(body.errorCode));
    if (body.status === 'REJECTED' && zeroSideEffect) {
      const blocked = (body as unknown as { blockedBy?: unknown }).blockedBy;
      return {
        status: 'REJECTED',
        projectId,
        opId,
        errorCode: body.errorCode ?? null,
        message: body.message ?? '回收操作失败',
        httpStatus,
        ...(Array.isArray(blocked) ? { blockedBy: blocked.filter((item): item is string => typeof item === 'string') } : {}),
      };
    }

    return {
      status: 'UNKNOWN',
      projectId,
      opId,
      message: body.message ?? '结果未确认，请在回收区核对（不会自动重发）',
      httpStatus,
    };
  }

  /**
   * 隐藏 / 取消隐藏共用的请求与收敛（UX-02C-03-P1）。
   *
   * 与结构变更不同，这里**没有 UNKNOWN 的磁盘副作用**：隐藏只写工作台配置，
   * 且是幂等的。因此网络中断只报告"未确认"，由调用方刷新目录核对。
   */

  /**
   * 元数据写入的共享收口（UX-02C-04）。
   *
   * 与可见性同一纪律：网络中断/超时时**不重发**（虽然写入幂等，但重发会让用户看到
   * 两次结果、也可能覆盖别人刚改的字段），返回 `UNKNOWN`，由调用方刷新该层核对真实结果。
   */
  async function postMetadata(
    endpoint: string,
    payload: Record<string, unknown>,
  ): Promise<MetadataOutcome> {
    const projectId = typeof payload.projectId === 'string' ? payload.projectId : '';
    const path = typeof payload.path === 'string' ? payload.path : '';
    let token: string;
    try {
      token = await sessionToken();
    } catch {
      return {
        status: 'REJECTED',
        errorCode: 'ERR_PERMISSION_DENIED',
        message: '无法获取会话令牌',
        httpStatus: 403,
      };
    }
    let response: { httpStatus: number; body: ApiEnvelope };
    try {
      response = await request(baseUrl, endpoint, {
        method: 'POST',
        headers: { 'x-ws-token': token },
        body: JSON.stringify(payload),
      });
    } catch {
      return { status: 'UNKNOWN', message: '网络中断或请求超时，资源标注的结果未确认' };
    }
    const { httpStatus, body } = response;
    if (httpStatus === 200 && body.status === 'APPLIED') {
      const raw = (body as unknown as { metadata?: unknown }).metadata;
      return {
        status: 'APPLIED',
        projectId: typeof body.projectId === 'string' ? body.projectId : projectId,
        path: typeof body.path === 'string' ? body.path : path,
        changed: body.changed === false ? false : true,
        metadata: raw === null ? { tags: [] } : metadataFieldsOf(raw),
      };
    }
    return {
      status: 'REJECTED',
      errorCode: body.errorCode ?? (httpStatus === 200 ? 'ERR_COMMAND_INTERNAL' : null),
      message: body.message ?? '资源标注保存失败',
      httpStatus,
    };
  }

  async function postVisibility(
    endpoint: string,
    projectId: string,
    path: string,
    hidden: boolean,
  ): Promise<VisibilityOutcome> {
    let token: string;
    try {
      token = await sessionToken();
    } catch {
      return {
        status: 'REJECTED',
        errorCode: 'ERR_PERMISSION_DENIED',
        message: '无法获取会话令牌',
        httpStatus: 403,
      };
    }
    let response: { httpStatus: number; body: ApiEnvelope };
    try {
      response = await request(baseUrl, endpoint, {
        method: 'POST',
        headers: { 'x-ws-token': token },
        body: JSON.stringify({ projectId, path }),
      });
    } catch {
      return { status: 'UNKNOWN', message: '网络中断或请求超时，隐藏状态未确认' };
    }
    const { httpStatus, body } = response;
    if (httpStatus === 200 && body.status === 'APPLIED') {
      return {
        status: 'APPLIED',
        projectId: typeof body.projectId === 'string' ? body.projectId : projectId,
        path: typeof body.path === 'string' ? body.path : path,
        hidden: body.hidden === true ? true : body.hidden === false ? false : hidden,
        // 缺失 `changed` 时按"这次改了"处理：宁可提示一次，也不假装什么都没发生
        changed: body.changed === false ? false : true,
      };
    }
    return {
      status: 'REJECTED',
      errorCode: body.errorCode ?? (httpStatus === 200 ? 'ERR_COMMAND_INTERNAL' : null),
      message: body.message ?? (hidden ? '隐藏失败' : '取消隐藏失败'),
      httpStatus,
    };
  }

  /**
   * 两个结构变更端点共用的请求/收敛逻辑。
   *
   * - 令牌获取失败：连请求都没发出，明确 REJECTED（不是 UNKNOWN）；
   * - 网络异常 / 超时 / 202 UNKNOWN：磁盘**可能已变**，只返回 UNKNOWN，
   *   绝不重发；由编排层做一次只读核对并提示人工确认；
   * - 200 APPLIED 但回执形状不完整：不冒充成功，客户端不猜路径。
   */
  async function postStructureChange(
    endpoint: string,
    requestBody: Record<string, string>,
    identity: {
      projectId: string;
      sourcePath: string;
      targetParentDir: string;
      targetName: string;
    },
  ): Promise<StructureChangeOutcome> {
    let token: string;
    try {
      token = await sessionToken();
    } catch {
      return {
        status: 'REJECTED',
        errorCode: 'ERR_PERMISSION_DENIED',
        message: '无法获取会话令牌',
        httpStatus: 403,
      };
    }
    let response: { httpStatus: number; body: ApiEnvelope };
    try {
      response = await request(baseUrl, endpoint, {
        method: 'POST',
        headers: { 'x-ws-token': token },
        // 只有 projectId + 项目内相对路径 + 单段名称
        body: JSON.stringify(requestBody),
      });
    } catch {
      return {
        status: 'UNKNOWN',
        errorCode: 'ERR_OUTCOME_UNKNOWN',
        message: '网络中断或请求超时，结构变更结果未知',
        httpStatus: 0,
        ...identity,
      };
    }
    const { httpStatus, body } = response;
    if (httpStatus === 202 && body.status === 'UNKNOWN') {
      return {
        status: 'UNKNOWN',
        errorCode: 'ERR_OUTCOME_UNKNOWN',
        message: body.message ?? '结构变更结果未确认，请人工核对',
        httpStatus,
        ...identity,
      };
    }
    if (httpStatus === 200 && body.status === 'APPLIED') {
      const applied = body as unknown as {
        sourcePath?: unknown;
        targetPath?: unknown;
        targetParentDir?: unknown;
        targetName?: unknown;
        entryKind?: unknown;
        contentSha256?: unknown;
      };
      if (
        typeof applied.sourcePath === 'string' &&
        typeof applied.targetPath === 'string' &&
        typeof applied.targetParentDir === 'string' &&
        typeof applied.targetName === 'string' &&
        (applied.entryKind === 'file' || applied.entryKind === 'directory')
      ) {
        return {
          status: 'APPLIED',
          projectId: identity.projectId,
          sourcePath: applied.sourcePath,
          targetPath: applied.targetPath,
          targetParentDir: applied.targetParentDir,
          targetName: applied.targetName,
          entryKind: applied.entryKind,
          contentSha256: typeof applied.contentSha256 === 'string' ? applied.contentSha256 : null,
        };
      }
    }
    const blockedBy = (body as unknown as { blockedBy?: unknown }).blockedBy;
    return {
      status: 'REJECTED',
      errorCode: body.errorCode ?? (httpStatus === 200 ? 'ERR_COMMAND_INTERNAL' : null),
      message: body.message ?? '改名或移动失败',
      httpStatus,
      ...(Array.isArray(blockedBy) ? { blockedBy: blockedBy.filter((x): x is string => typeof x === 'string') } : {}),
    };
  }
}

/**
 * demo 客户端：与 live 同构，但全部在内存里。
 *
 * - `saveDocument` 返回 `DEMO`，**不是** `COMMITTED`：演示态不得冒充真实保存；
 * - 不接触任何真实文件，也不写入磁盘。
 */
function extensionFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase() : '';
}

/**
 * demo 的"单层"视图：从嵌套演示树里取出指定层的直接子项。
 *
 * 这样 Demo / Legacy / Multi 三条路径都向同一套 UI 提供 `TreeEntry[]`，
 * 根行与子行的结构差异就没有机会再出现（契约 C.2）。
 */
function demoEntriesAt(nodes: readonly ResourceNode[], dir: string): TreeEntry[] {
  let level = nodes;
  for (const segment of dir.split('/').filter(Boolean)) {
    const folder = level.find((node) => node.kind === 'folder' && node.name === segment);
    if (!folder?.children) return [];
    level = folder.children;
  }
  return level.map((node) => ({
    id: node.id,
    name: node.name,
    kind: node.kind === 'folder' ? ('folder' as const) : ('file' as const),
    extension: node.extension ?? extensionFromName(node.name),
    relPath: node.path ?? (dir ? `${dir}/${node.name}` : node.name),
  }));
}

export function createDemoClient(
  nodes: ResourceNode[],
  contents: Readonly<Record<string, string>>,
): WeaveSpaceClient {
  const versions = new Map<string, string>();

  const find = (id: string): ResourceNode | undefined => {
    const walk = (list: ResourceNode[]): ResourceNode | undefined => {
      for (const node of list) {
        if (node.id === id) return node;
        if (node.children) {
          const hit = walk(node.children);
          if (hit) return hit;
        }
      }
      return undefined;
    };
    return walk(nodes);
  };

  return {
    mode: 'demo',
    // 演示模式不接触 Host：模式恒为 legacy，也没有项目列表
    async workspaceMode() {
      return 'legacy' as const;
    },
    // 演示模式没有工作区身份：不写恢复记录，也不参与身份比对
    async workspaceIdentity() {
      return { workspaceMode: 'legacy' as const, workspaceKey: null };
    },
    async listProjects() {
      return [];
    },
    async listResources() {
      return nodes;
    },
    async listTree(_projectId, dir) {
      const entries = demoEntriesAt(nodes, dir);
      return {
        status: 'APPLIED' as const,
        level: dir,
        entries,
        page: {
          limit: Math.max(entries.length, 1),
          cursor: null,
          nextCursor: null,
          total: entries.length,
          snapshot: null,
          hiddenCount: 0,
        },
      };
    },
    async openDocument(path: string) {
      const node = find(path);
      if (!node || node.kind === 'folder') {
        return { status: 'REJECTED', errorCode: 'ERR_RESOURCE_NOT_FOUND', message: '演示资源不存在' };
      }
      const id = node.id;
      const content = contents[id] ?? '';
      return {
        status: 'APPLIED',
        document: {
          sessionId: `demo-session:${id}`,
          viewId: `demo-view:${id}`,
          resourceId: id,
          path: node.path ?? id,
          content,
          baseVersion: versions.get(id) ?? null,
          revision: 0,
          dirty: false,
          documentState: 'DEMO',
        },
      };
    },
    async readDocument(sessionId: string) {
      const id = sessionId.replace('demo-session:', '');
      const content = contents[id] ?? '';
      return {
        status: 'APPLIED',
        document: {
          sessionId,
          viewId: `demo-view:${id}`,
          resourceId: id,
          path: id,
          content,
          baseVersion: versions.get(id) ?? null,
          revision: 0,
          dirty: false,
          documentState: 'DEMO',
        },
      };
    },
    async applyEdit() {
      return { status: 'APPLIED' };
    },
    async saveDocument(sessionId: string) {
      const id = sessionId.replace('demo-session:', '');
      versions.set(id, `demo:${id}:saved`);
      return { status: 'DEMO', contentVersion: versions.get(id) ?? null };
    },
    async closeDocument() {
      return { status: 'APPLIED' };
    },
    // 演示模式没有任何真实 View：回收是空操作，不假装做过什么
    async reclaimPageViews() {
      return { status: 'APPLIED' as const, closed: 0, blocked: 0 };
    },
    async readDisk(sessionId: string) {
      const id = sessionId.replace('demo-session:', '');
      return {
        status: 'APPLIED' as const,
        content: contents[id] ?? '',
        contentVersion: `demo:${id}`,
      };
    },
    async reloadDocument(sessionId: string, viewId: string) {
      const id = sessionId.replace('demo-session:', '');
      return {
        status: 'APPLIED' as const,
        document: {
          sessionId,
          viewId,
          resourceId: id,
          path: id,
          content: contents[id] ?? '',
          baseVersion: `demo:${id}`,
          revision: 0,
          dirty: false,
          documentState: 'DEMO',
        },
      };
    },

    /*
     * 演示模式没有任何 Host：不弹对话框、不注册项目、不改名称。
     * 返回值刻意不是"失败"而是"不支持"，界面据此给出说明而不是报错。
     */
    async registrationSupport() {
      return { support: 'demo' as const, mode: 'demo' };
    },
    async bootstrapPick() {
      return { token: '', intentId: null };
    },
    async startPick() {
      return { status: 'REJECTED' as const, errorCode: 'ERR_COMMAND_UNSUPPORTED', httpStatus: 501 };
    },
    async queryPick() {
      return { status: 'REJECTED' as const, errorCode: 'ERR_COMMAND_UNSUPPORTED', httpStatus: 501 };
    },
    async renameProject() {
      return {
        status: 'REJECTED' as const,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示数据没有真实项目，无法重命名',
        httpStatus: 501,
      };
    },

    async removalPrecheck() {
      return {
        status: 'REJECTED' as const,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示数据没有真实项目，无法移除',
        httpStatus: 501,
      };
    },

    async removeProject() {
      return {
        status: 'REJECTED' as const,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示数据没有真实项目，无法移除',
        httpStatus: 501,
      };
    },

    async queryRemovalOp() {
      return {
        status: 'REJECTED' as const,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示数据没有真实项目，无法查询移除结果',
        httpStatus: 501,
      };
    },

    async createEntry() {
      return {
        status: 'REJECTED' as const,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示模式不创建真实文件',
        httpStatus: 501,
      };
    },

    async renameEntry() {
      return {
        status: 'REJECTED' as const,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示模式不改名真实文件',
        httpStatus: 501,
      };
    },
    async moveEntry() {
      return {
        status: 'REJECTED' as const,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示模式不移动真实文件',
        httpStatus: 501,
      };
    },

    // 演示模式没有工作台配置：绝不"假装隐藏"，也不在演示树里凭空消失一行
    /* ---- UX-02C-04：演示模式没有工作区配置，标注名/标签/颜色一概不支持 ---- */

    async setResourceMetadata(projectId, path) {
      return {
        status: 'REJECTED' as const,
        projectId,
        path,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示模式没有工作区配置，无法保存资源标注',
        httpStatus: 501,
      };
    },

    async clearResourceMetadata(projectId, path) {
      return {
        status: 'REJECTED' as const,
        projectId,
        path,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示模式没有工作区配置，无法保存资源标注',
        httpStatus: 501,
      };
    },

    async resourceMetadata() {
      return {
        status: 'REJECTED' as const,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示模式没有工作区配置，无法读取资源标注',
      };
    },

    async hideEntry() {
      return {
        status: 'REJECTED' as const,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示模式不支持隐藏（没有真实工作区配置）',
        httpStatus: 501,
      };
    },

    async unhideEntry() {
      return {
        status: 'REJECTED' as const,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示模式不支持取消隐藏',
        httpStatus: 501,
      };
    },

    async hiddenEntries() {
      return {
        status: 'REJECTED' as const,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示模式没有隐藏记录',
      };
    },

    // 演示模式没有磁盘、也没有工作区配置：回收区必须明确"不支持"，
    // 绝不在演示树里演一遍"移入回收区"的假动作
    async listTrash() {
      return {
        status: 'REJECTED' as const,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示模式没有回收区',
        httpStatus: 501,
      };
    },

    async trashEntry(projectId: string, _path: string, opId: string) {
      return {
        status: 'REJECTED' as const,
        projectId,
        opId,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示模式不会移动任何文件',
        httpStatus: 501,
      };
    },

    /**
     * 演示模式没有真实回收记录，也**不执行** gate（R1-H1-04）：
     * 这里没有任何请求要发，跑一次授权检查只会让"演示"看起来像"真能恢复"。
     * 结果永远是明确的"不支持"，不制造假成功、不产生任何磁盘副作用。
     */
    async restoreTrash(projectId: string, opId: string, _gate: TrashSendGate) {
      return {
        status: 'REJECTED' as const,
        projectId,
        opId,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示模式没有可恢复的文件',
        httpStatus: 501,
      };
    },

    async queryTrashOp() {
      return {
        status: 'REJECTED' as const,
        errorCode: 'ERR_COMMAND_UNSUPPORTED',
        message: '演示模式没有回收事务',
        httpStatus: 501,
      };
    },
  };
}
