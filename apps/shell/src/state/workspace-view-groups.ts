/**
 * ViewGroup 运行时状态（UI-F03-B2 建立，UI-F03-B3 迁移到视图实例）：**纯结构 + 纯函数**。
 *
 * 为什么需要它：B1 把 `LayoutTree` 接进了工作区状态，但 `PaneNode.groupId` 当时只是
 * 结构身份——真正"这个窗格里有哪些标签、正在看哪一份、用源码还是预览"仍然挤在
 * `panes.primary / panes.secondary` 两个固定槽里。于是"树里有几个窗格"和"运行时有
 * 几组视图"是两套坐标，groupId 没有对应的实体。
 *
 * 本模块把四层关系钉死：
 *
 * ```
 * LayoutTree（哪些组在什么位置）
 *   → PaneNode.groupId
 *     → ViewGroupState（组内视图实例集合 / 当前活动实例 / 展示模式）
 *       → ViewInstanceState（客户端实例身份 + Host viewId）
 *         → DocumentSessionState（`tabs` 里那一条：缓冲、会话、版本；全局唯一一份）
 * ```
 *
 * 四条纪律：
 *
 * 1. **组只存实例身份**。组里保存 `viewInstanceId`，既不是 `docId` 也不是 `viewId`：
 *    同一份文档在两个组里是**两个实例**（B3），所以 `docId` 不足以标识"组里的这一格"。
 * 2. **树决定位置，组决定内容**。加实例、切活动、换模式都不碰 `LayoutTree`；
 *    分屏、合并也不碰组内的实例集合。
 * 3. **身份由调用方注入**。`groupId` 一律来自 `LayoutTree`（或兼容桥的保留身份），
 *    `viewInstanceId` 一律来自调用方，本模块绝不生成随机值——否则同一份状态在两次
 *    渲染之间就会"换了一组/一格"。
 * 4. **不复制文档**。组与实例里没有任何缓冲、会话或版本字段；那条只有一个。
 *
 * 休眠组：`LayoutTree` 里暂时没有对应 Pane 的组（单视图时的 secondary）。
 * 它保留实例与模式，下次分屏原样回来；但**不能获得焦点**，也不参与旧 UI 投影之外的
 * 任何渲染。
 */
import { listPanes, type LayoutTree } from './layout-tree.ts';
import type { PaneId, PaneState, ViewMode } from './types.ts';
import {
  hostViewIdForDoc,
  instanceOf,
  type ViewInstances,
} from './workspace-view-instances.ts';

/** 一个视图组的运行时状态。`groupId` 与 `LayoutTree` 的 `PaneNode.groupId` 对应。 */
export interface ViewGroupState {
  readonly groupId: string;
  /** 本组关联的视图实例（引用，不是副本）。组内不重复。 */
  readonly viewInstanceIds: readonly string[];
  /** 本组当前显示的实例；必须是 `viewInstanceIds` 成员或 `null`。 */
  readonly activeViewInstanceId: string | null;
  /** 本组当前展示模式（源码 / 预览）。 */
  readonly mode: ViewMode;
}

/** 组表：`groupId → ViewGroupState`。键集可以比"可见组"更大（休眠组）。 */
export type ViewGroups = Readonly<Record<string, ViewGroupState>>;

/**
 * 兼容桥的保留身份（B1 起固定，现在集中到这里，reducer 与渲染层不再各写一份）。
 *
 * `legacy-` 前缀是**有意的**：这五个字符串是双窗格时代的映射，多窗格协议落地后
 * 会整体替换，而不是被当成永久的视图组身份。
 */
export const LEGACY_LAYOUT_IDS = {
  primaryNodeId: 'legacy-pane:primary',
  primaryGroupId: 'legacy-group:primary',
  secondaryNodeId: 'legacy-pane:secondary',
  secondaryGroupId: 'legacy-group:secondary',
  splitNodeId: 'legacy-split:root',
} as const;

/** 旧 `PaneId` → 组身份。旧 UI 的所有窗格操作都从这里映射，不再直接认 `primary`。 */
export function legacyGroupIdOf(pane: PaneId): string {
  return pane === 'secondary'
    ? LEGACY_LAYOUT_IDS.secondaryGroupId
    : LEGACY_LAYOUT_IDS.primaryGroupId;
}

/** 组身份 → 旧 `PaneId`：只有两个保留组能被旧 UI 表达，其余返回 `null`。 */
export function legacyPaneOf(groupId: string): PaneId | null {
  if (groupId === LEGACY_LAYOUT_IDS.primaryGroupId) return 'primary';
  if (groupId === LEGACY_LAYOUT_IDS.secondaryGroupId) return 'secondary';
  return null;
}

/** 各保留组的默认展示模式（新工作区、切模式、新建组时使用）。 */
const DEFAULT_MODE: Readonly<Record<string, ViewMode>> = {
  [LEGACY_LAYOUT_IDS.primaryGroupId]: 'editor',
  [LEGACY_LAYOUT_IDS.secondaryGroupId]: 'preview',
};

export function defaultModeOf(groupId: string): ViewMode {
  return DEFAULT_MODE[groupId] ?? 'editor';
}

const EMPTY_GROUP = (groupId: string): ViewGroupState => ({
  groupId,
  viewInstanceIds: [],
  activeViewInstanceId: null,
  mode: defaultModeOf(groupId),
});

/**
 * 初始组表：两个组都存在。
 *
 * secondary 在初始（单视图）布局里是**休眠组**——`LayoutTree` 只有一个 Pane。
 * 它现在就存在，是为了让"打开分屏"不必凭空造一个组，也让用户在分屏期间的
 * 实例与模式在合并后仍然保留。
 */
export function createInitialViewGroups(): ViewGroups {
  return {
    [LEGACY_LAYOUT_IDS.primaryGroupId]: EMPTY_GROUP(LEGACY_LAYOUT_IDS.primaryGroupId),
    [LEGACY_LAYOUT_IDS.secondaryGroupId]: EMPTY_GROUP(LEGACY_LAYOUT_IDS.secondaryGroupId),
  };
}

/** 取一个组；不存在返回 `null`（调用方据此 fail-closed，而不是凭空造组）。 */
export function groupOf(groups: ViewGroups, groupId: string): ViewGroupState | null {
  return Object.prototype.hasOwnProperty.call(groups, groupId) ? groups[groupId] : null;
}

/**
 * `LayoutTree` 里真实可见的组身份（按左优先顺序）。
 *
 * 这是"焦点合法性"的唯一判据：休眠组不在这个列表里，因此拿不到焦点。
 */
export function visibleGroupIds(tree: LayoutTree): readonly string[] {
  return listPanes(tree).map((pane) => pane.groupId);
}

/** 可见组里的第一个（焦点兜底用；树非法时为空数组）。 */
export function firstVisibleGroupId(tree: LayoutTree): string | null {
  return visibleGroupIds(tree)[0] ?? null;
}

/** 补齐缺失的组（保留已有组的全部状态，不覆盖实例与模式）。 */
export function ensureGroups(groups: ViewGroups, groupIds: readonly string[]): ViewGroups {
  let next = groups;
  for (const groupId of groupIds) {
    if (groupOf(next, groupId) !== null) continue;
    next = { ...next, [groupId]: EMPTY_GROUP(groupId) };
  }
  return next;
}

/** 只替换一个组：其余组的引用保持不变（不可变更新的最小代价）。 */
function replaceGroup(groups: ViewGroups, next: ViewGroupState): ViewGroups {
  const current = groups[next.groupId];
  if (
    current !== undefined &&
    current.activeViewInstanceId === next.activeViewInstanceId &&
    current.mode === next.mode &&
    current.viewInstanceIds === next.viewInstanceIds
  ) {
    return groups;
  }
  return { ...groups, [next.groupId]: next };
}

/** 把一个实例加进组并设为活动实例（组内去重；已存在则只改活动实例）。 */
export function addInstance(
  groups: ViewGroups,
  groupId: string,
  viewInstanceId: string,
): ViewGroups {
  const group = groupOf(groups, groupId);
  if (group === null) return groups;
  const viewInstanceIds = group.viewInstanceIds.includes(viewInstanceId)
    ? group.viewInstanceIds
    : [...group.viewInstanceIds, viewInstanceId];
  return replaceGroup(groups, { ...group, viewInstanceIds, activeViewInstanceId: viewInstanceId });
}

/** 把一个实例加进组但**不改活动实例**（后台登记用：它在组里但还没被显示）。 */
export function linkInstance(
  groups: ViewGroups,
  groupId: string,
  viewInstanceId: string,
): ViewGroups {
  const group = groupOf(groups, groupId);
  if (group === null) return groups;
  if (group.viewInstanceIds.includes(viewInstanceId)) return groups;
  return replaceGroup(groups, {
    ...group,
    viewInstanceIds: [...group.viewInstanceIds, viewInstanceId],
  });
}

/** 激活组内实例：必要时先建立引用。`mode` 可选（恢复时保留记录的模式）。 */
export function activateInstance(
  groups: ViewGroups,
  groupId: string,
  viewInstanceId: string,
  mode?: ViewMode,
): ViewGroups {
  const group = groupOf(groups, groupId);
  if (group === null) return groups;
  const viewInstanceIds = group.viewInstanceIds.includes(viewInstanceId)
    ? group.viewInstanceIds
    : [...group.viewInstanceIds, viewInstanceId];
  return replaceGroup(groups, {
    ...group,
    viewInstanceIds,
    activeViewInstanceId: viewInstanceId,
    mode: mode ?? group.mode,
  });
}

/**
 * 只改活动实例，不动引用（`null` = 这个组暂时没有打开的文档）。
 *
 * 非 `null` 时要求该实例已在组内：让"活动实例"指向组里根本没有的一格，
 * 等于制造一条无法解释的状态。
 */
export function setActiveInstance(
  groups: ViewGroups,
  groupId: string,
  viewInstanceId: string | null,
): ViewGroups {
  const group = groupOf(groups, groupId);
  if (group === null) return groups;
  if (viewInstanceId !== null && !group.viewInstanceIds.includes(viewInstanceId)) return groups;
  if (group.activeViewInstanceId === viewInstanceId) return groups;
  return replaceGroup(groups, { ...group, activeViewInstanceId: viewInstanceId });
}

/** 改展示模式：只影响这一个组。 */
export function setGroupMode(groups: ViewGroups, groupId: string, mode: ViewMode): ViewGroups {
  const group = groupOf(groups, groupId);
  if (group === null || group.mode === mode) return groups;
  return replaceGroup(groups, { ...group, mode });
}

/**
 * 从**所有**组里删除一个实例引用（关闭实例、关闭标签、移除项目都走这里）。
 *
 * 活动实例被删时按**组内**顺序选替代项：先右邻、再左邻、最后为 `null`。
 *
 * `adoptWhenEmptied` 是旧版行为的保留：如果一个组因为这次删除**一个实例都不剩**，
 * 旧版会把窗格指向"还开着的第一个标签"，而不是留一个空白窗格。仅在这种情况下
 * 采纳它（并建立引用），避免"另一个组刚好有实例"就让空组随便接管。
 */
export function removeInstance(
  groups: ViewGroups,
  viewInstanceId: string,
  adoptWhenEmptied?: string | null,
): ViewGroups {
  let next = groups;
  for (const group of Object.values(groups)) {
    const index = group.viewInstanceIds.indexOf(viewInstanceId);
    if (index < 0) continue;
    const remaining = group.viewInstanceIds.filter((id) => id !== viewInstanceId);
    const wasActive = group.activeViewInstanceId === viewInstanceId;
    let activeViewInstanceId = group.activeViewInstanceId;
    if (wasActive) {
      activeViewInstanceId = remaining[index] ?? remaining[index - 1] ?? null;
    }
    if (
      wasActive &&
      activeViewInstanceId === null &&
      adoptWhenEmptied &&
      remaining.length === 0
    ) {
      next = replaceGroup(next, {
        ...group,
        viewInstanceIds: [adoptWhenEmptied],
        activeViewInstanceId: adoptWhenEmptied,
      });
      continue;
    }
    next = replaceGroup(next, { ...group, viewInstanceIds: remaining, activeViewInstanceId });
  }
  return next;
}

/**
 * 换工作区（`SET_MODE`）：清空所有组的实例引用，**保留组身份**，模式复位到默认。
 *
 * 不删组：组的身份属于布局结构，不属于工作区；下个模式里同一个 Pane 还要用它。
 */
export function clearAllGroups(groups: ViewGroups): ViewGroups {
  let next = groups;
  for (const group of Object.values(groups)) {
    next = replaceGroup(next, {
      ...group,
      viewInstanceIds: [],
      activeViewInstanceId: null,
      mode: defaultModeOf(group.groupId),
    });
  }
  return next;
}

/** 某组里全部实例对应的文档（按组内顺序，保留重复——同一文档可以是两格）。 */
export function docIdsInGroup(
  groups: ViewGroups,
  instances: ViewInstances,
  groupId: string,
): readonly string[] {
  const group = groupOf(groups, groupId);
  if (group === null) return [];
  return group.viewInstanceIds
    .map((id) => instanceOf(instances, id)?.docId ?? null)
    .filter((docId): docId is string => docId !== null);
}

/** 某组当前活动实例对应的文档；没有活动实例时为 `null`。 */
export function activeDocIdInGroup(
  groups: ViewGroups,
  instances: ViewInstances,
  groupId: string,
): string | null {
  const group = groupOf(groups, groupId);
  if (group === null || group.activeViewInstanceId === null) return null;
  return instanceOf(instances, group.activeViewInstanceId)?.docId ?? null;
}

/** 某组当前活动实例；没有时为 `null`。 */
export function activeInstanceIdInGroup(groups: ViewGroups, groupId: string): string | null {
  return groupOf(groups, groupId)?.activeViewInstanceId ?? null;
}

/**
 * 旧 UI 的 `panes` 投影：primary / secondary 两个兼容槽。
 *
 * 组里存的是实例身份，投影必须经过实例表才能拿到 `docId`——这正是 B3 与 B2 的差别：
 * 从前"组的活动文档"直接就是 `docId`，现在它只是某个实例的一个属性。
 */
export function projectPanes(
  groups: ViewGroups,
  instances: ViewInstances,
): Record<PaneId, PaneState> {
  const paneOf = (groupId: string, fallbackMode: ViewMode): PaneState => {
    const group = groupOf(groups, groupId);
    if (group === null) return { docId: null, mode: fallbackMode };
    const active =
      group.activeViewInstanceId === null
        ? null
        : (instanceOf(instances, group.activeViewInstanceId)?.docId ?? null);
    return { docId: active, mode: group.mode };
  };
  return {
    primary: paneOf(LEGACY_LAYOUT_IDS.primaryGroupId, 'editor'),
    secondary: paneOf(LEGACY_LAYOUT_IDS.secondaryGroupId, 'preview'),
  };
}

/**
 * 一致性检查（测试与调试用，不在 reducer 热路径上调用）。
 *
 * 四条不变量：组身份与键一致、组内实例不重复、活动实例必须属于本组、
 * 每个引用都指向真实存在的实例（给了 `existingDocIds` 时顺带检查文档存在）。
 */
export function viewGroupProblems(
  groups: ViewGroups,
  instances: ViewInstances,
  existingDocIds?: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  for (const [key, group] of Object.entries(groups)) {
    if (group.groupId !== key) problems.push(`${key}：groupId 与键不一致（${group.groupId}）`);
    const unique = new Set(group.viewInstanceIds);
    if (unique.size !== group.viewInstanceIds.length) problems.push(`${key}：组内实例重复`);
    if (
      group.activeViewInstanceId !== null &&
      !unique.has(group.activeViewInstanceId)
    ) {
      problems.push(`${key}：活动实例不在组内（${group.activeViewInstanceId}）`);
    }
    for (const viewInstanceId of group.viewInstanceIds) {
      const instance = instanceOf(instances, viewInstanceId);
      if (instance === null) {
        problems.push(`${key}：引用了不存在的实例（${viewInstanceId}）`);
        continue;
      }
      if (instance.groupId !== key) {
        problems.push(`${key}：实例 ${viewInstanceId} 实际属于 ${instance.groupId ?? 'none'}`);
      }
      if (existingDocIds && !existingDocIds.has(instance.docId)) {
        problems.push(`${key}：引用了不存在的文档（${instance.docId}）`);
      }
    }
  }
  return problems;
}

/** 便捷：某组里"这一份文档"的活动实例（渲染层与动作层都只关心这个）。 */
export function instanceInGroupForDoc(
  groups: ViewGroups,
  instances: ViewInstances,
  groupId: string,
  docId: string,
): string | null {
  const group = groupOf(groups, groupId);
  if (group === null) return null;
  for (const viewInstanceId of group.viewInstanceIds) {
    if (instanceOf(instances, viewInstanceId)?.docId === docId) return viewInstanceId;
  }
  return null;
}

/**
 * 某份文档此刻在界面上是否还"有地方显示"（任何组里都有实例）。
 *
 * 关闭最后一个实例时必须同时收掉文档记录；只剩未分组实例时则**不**收——那个 Host
 * View 还在，文档也还在，只是没被摆进窗格。
 */
export function hasVisibleInstance(instances: ViewInstances, docId: string): boolean {
  return Object.values(instances).some(
    (instance) => instance.docId === docId && instance.groupId !== null,
  );
}

/** 便捷：某文档的 Host View（文档级操作要用，优先非空且最早的那个）。 */
export function hostViewIdOfDoc(instances: ViewInstances, docId: string): string | null {
  return hostViewIdForDoc(instances, docId);
}
