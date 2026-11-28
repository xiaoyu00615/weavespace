/**
 * ViewInstance 运行时状态（UI-F03-B3）：**纯结构 + 纯函数**，不依赖 React / DOM / 磁盘。
 *
 * 为什么需要它：B2 已经把「组」建成了真身份（`LayoutTree → ViewGroup → DocTab`），
 * 但同一个 `DocTab` 只有一个 `viewId`——同一份文档被左右两个组同时显示时，两个组
 * 实际上共用**同一个 Host View**。那是过渡状态，不是最终架构：
 *
 * ```
 * LayoutTree（哪些组在什么位置）
 *   → PaneNode.groupId
 *     → ViewGroupState（组内有哪些视图实例 / 当前活动实例 / 展示模式）
 *       → ViewInstanceState（客户端实例身份 + Host viewId + 所属组）
 *         → DocumentSessionState（= `tabs` 里那一条：缓冲 / 会话 / 版本 / dirty）
 * ```
 *
 * 三条纪律：
 *
 * 1. **文档只有一份**。`ViewInstance` 只保存 `docId` 引用，编辑缓冲、`sessionId`、
 *    `baseVersion`、`revision`、`dirty` 全都在 `tabs` 上，**绝不为第二个视图复制**。
 * 2. **视图身份由调用方注入**。`viewInstanceId` 一律从参数来，本模块绝不生成随机数或
 *    时间戳——否则同一份状态在两次渲染之间就会"换了一个视图"，恢复与测试都没法比对。
 * 3. **一个 Host View 只能属于一个实例**。Live 模式下两个实例共享同一个 `hostViewId`
 *    就等于"关掉左边连右边一起消失"，这正是本轮要消灭的缺陷，因此把它做成不变量：
 *    `viewInstanceProblems` 会把它当成错误报出来。
 *
 * 未分组实例（`groupId === null`）：Host 已经为它建了 View，但用户此刻没有把它放进任何
 * 组（典型的迟到响应、页面恢复期间的临时打开）。它**不是**某个组的活动视图，也不能被
 * 渲染成活动视图；它存在的意义是"Host 里那个 View 必须有主"，否则关闭/改名/移动的
 * 门禁会被一个没人认领的 View 永久拦住。
 */

/** 一个视图实例：客户端身份 + 它对应的 Host View + 当前所属组。 */
export interface ViewInstanceState {
  /** 客户端稳定身份。**不是** docId，也不是 hostViewId。 */
  readonly viewInstanceId: string;
  /** 指向唯一的 `DocumentSessionState`（`tabs` 里的那一条）。 */
  readonly docId: string;
  /** 所属组；`null` = 未分组（还没被放进任何窗格）。 */
  readonly groupId: string | null;
  /** Host 返回的真实 viewId；demo 模式或"尚未绑定"时为 `null`。 */
  readonly hostViewId: string | null;
}

/** 实例表：`viewInstanceId → ViewInstanceState`。 */
export type ViewInstances = Readonly<Record<string, ViewInstanceState>>;

/**
 * 实例身份的**构造规则**（由调用方在创建时使用；不是解析器）。
 *
 * 不做"从 id 反解组/文档"：`docId` 里允许出现 `/`、`:` 等字符，任何编码都可能
 * 与人手构造的夹具撞车。身份只需要**唯一且确定**，不需要可解析。
 */
export function viewInstanceIdOf(groupId: string | null, docId: string): string {
  return `vi:${groupId ?? 'none'}|${docId}`;
}

export interface ViewInstanceInput {
  viewInstanceId: string;
  docId: string;
  groupId: string | null;
  hostViewId: string | null;
}

export function createViewInstance(input: ViewInstanceInput): ViewInstanceState {
  return {
    viewInstanceId: input.viewInstanceId,
    docId: input.docId,
    groupId: input.groupId,
    hostViewId: input.hostViewId,
  };
}

/** 取一个实例；不存在返回 `null`（调用方据此 fail-closed，而不是凭空造一个）。 */
export function instanceOf(instances: ViewInstances, viewInstanceId: string): ViewInstanceState | null {
  return Object.prototype.hasOwnProperty.call(instances, viewInstanceId)
    ? instances[viewInstanceId]
    : null;
}

/** 某个组里"这一份文档"的实例。同一 (组, 文档) 最多一个。 */
export function instanceFor(
  instances: ViewInstances,
  groupId: string | null,
  docId: string,
): ViewInstanceState | null {
  for (const instance of Object.values(instances)) {
    if (instance.groupId !== groupId) continue;
    if (instance.docId === docId) return instance;
  }
  return null;
}

/** 某份文档的**未分组**实例（恢复与迟到响应会留下这种实例）。 */
export function ungroupedInstanceOfDoc(
  instances: ViewInstances,
  docId: string,
): ViewInstanceState | null {
  return instanceFor(instances, null, docId);
}

/** 某份文档的全部实例（顺序 = 插入顺序，供"从最早的开始关"使用）。 */
export function instancesOfDoc(instances: ViewInstances, docId: string): readonly ViewInstanceState[] {
  return Object.values(instances).filter((instance) => instance.docId === docId);
}

/** 某个组里的全部实例（顺序 = 插入顺序）。 */
export function instancesInGroup(instances: ViewInstances, groupId: string): readonly ViewInstanceState[] {
  return Object.values(instances).filter((instance) => instance.groupId === groupId);
}

/**
 * 注册实例：同一 `viewInstanceId` 已存在时只**补** `hostViewId`，不覆盖已有值。
 *
 * 为什么允许"补"：实例可能在 Host 视图建好之前就被登记（demo / 恢复占位），
 * 之后拿到真实 viewId 时要能落上去；反过来，把已有的 hostViewId 换成另一个，
 * 等于让上一个 Host View 变成孤儿——那种写入必须被拒绝。
 */
export function registerInstance(
  instances: ViewInstances,
  input: ViewInstanceInput,
): { instances: ViewInstances; instance: ViewInstanceState; created: boolean } {
  const existing = instanceOf(instances, input.viewInstanceId);
  if (existing !== null) {
    const hostViewId = existing.hostViewId ?? input.hostViewId;
    const groupId = existing.groupId ?? input.groupId;
    if (hostViewId === existing.hostViewId && groupId === existing.groupId) {
      return { instances, instance: existing, created: false };
    }
    const next: ViewInstanceState = { ...existing, hostViewId, groupId };
    return { instances: { ...instances, [next.viewInstanceId]: next }, instance: next, created: false };
  }
  const instance = createViewInstance(input);
  return { instances: { ...instances, [instance.viewInstanceId]: instance }, instance, created: true };
}

/** 把实例挂到另一个组（恢复时"收养"未分组实例就靠它）。身份与 hostViewId 不变。 */
export function assignGroup(
  instances: ViewInstances,
  viewInstanceId: string,
  groupId: string | null,
): ViewInstances {
  const instance = instanceOf(instances, viewInstanceId);
  if (instance === null || instance.groupId === groupId) return instances;
  return { ...instances, [viewInstanceId]: { ...instance, groupId } };
}

/** 只改 `hostViewId`（用于"Host 视图建立后回填"）。 */
export function bindHostView(
  instances: ViewInstances,
  viewInstanceId: string,
  hostViewId: string | null,
): ViewInstances {
  const instance = instanceOf(instances, viewInstanceId);
  if (instance === null || instance.hostViewId === hostViewId) return instances;
  return { ...instances, [viewInstanceId]: { ...instance, hostViewId } };
}

/** 删除一个实例；不存在时原样返回（调用方可以据此判"没变化"）。 */
export function removeInstance(instances: ViewInstances, viewInstanceId: string): ViewInstances {
  if (instanceOf(instances, viewInstanceId) === null) return instances;
  const next = { ...instances };
  delete next[viewInstanceId];
  return next;
}

/** 删除某份文档的全部实例（关闭标签 / 移除项目 / 换工作区）。 */
export function removeInstancesOfDoc(instances: ViewInstances, docId: string): ViewInstances {
  const doomed = instancesOfDoc(instances, docId);
  if (doomed.length === 0) return instances;
  const next = { ...instances };
  for (const instance of doomed) delete next[instance.viewInstanceId];
  return next;
}

/**
 * 某份文档此刻"可以用哪个 Host View"（文档级操作的 selector）。
 *
 * 语义：编辑/保存/读盘只需要**一个属于这个会话**的有效 View，任意一个都行。
 * 优先返回非空且最早登记的那个。返回 `null` 表示"这份文档当前没有 Host View"
 * （demo、或尚未绑定），调用方必须按无 viewId 的方式发请求。
 */
export function hostViewIdForDoc(instances: ViewInstances, docId: string): string | null {
  for (const instance of instancesOfDoc(instances, docId)) {
    if (instance.hostViewId !== null && instance.hostViewId !== '') return instance.hostViewId;
  }
  return null;
}

/** 某个 `hostViewId` 是否已经被别的实例占用（用于拒绝"一个 View 挂两个实例"）。 */
export function hostViewIdTaken(
  instances: ViewInstances,
  hostViewId: string | null,
  exceptViewInstanceId?: string,
): boolean {
  if (hostViewId === null || hostViewId === '') return false;
  for (const instance of Object.values(instances)) {
    if (instance.viewInstanceId === exceptViewInstanceId) continue;
    if (instance.hostViewId === hostViewId) return true;
  }
  return false;
}

/**
 * 一致性检查（测试与调试用，不在 reducer 热路径上调用）。
 *
 * 五条不变量：
 * 1. 键与 `viewInstanceId` 一致；
 * 2. `docId` 非空；
 * 3. `hostViewId` 只能是 `null` 或非空字符串；
 * 4. **两个实例不得共享同一个非空 `hostViewId`**（Live 下那就是"关一个死两个"）；
 * 5. 同一个 (组, 文档) 最多一个实例（否则活动视图形同虚设）。
 */
export function viewInstanceProblems(
  instances: ViewInstances,
  existingDocIds?: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  const byHost = new Map<string, string>();
  const byGroupDoc = new Set<string>();
  for (const [key, instance] of Object.entries(instances)) {
    if (instance.viewInstanceId !== key) {
      problems.push(`${key}：实例 id 与键不一致（${instance.viewInstanceId}）`);
    }
    if (instance.docId === '') problems.push(`${key}：docId 为空`);
    if (instance.hostViewId !== null && instance.hostViewId === '') {
      problems.push(`${key}：hostViewId 不能是空串（应为 null 或真实 id）`);
    }
    if (instance.hostViewId !== null) {
      const owner = byHost.get(instance.hostViewId);
      if (owner !== undefined) {
        problems.push(`${key}：与 ${owner} 共用同一个 hostViewId（${instance.hostViewId}）`);
      } else {
        byHost.set(instance.hostViewId, key);
      }
    }
    const slot = `${instance.groupId ?? 'none'}\u0000${instance.docId}`;
    if (byGroupDoc.has(slot)) problems.push(`${key}：同一个组里重复持有同一份文档`);
    byGroupDoc.add(slot);
    if (existingDocIds && !existingDocIds.has(instance.docId)) {
      problems.push(`${key}：指向不存在的文档（${instance.docId}）`);
    }
  }
  return problems;
}
