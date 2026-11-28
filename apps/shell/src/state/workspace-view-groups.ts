/**
 * ViewGroup 运行时状态（UI-F03-B2）：**纯结构 + 纯函数**，不依赖 React / DOM / 磁盘。
 *
 * 为什么需要它：B1 把 `LayoutTree` 接进了工作区状态，但 `PaneNode.groupId` 当时只是
 * 结构身份——真正"这个窗格里有哪些标签、正在看哪一份、用源码还是预览"仍然挤在
 * `panes.primary / panes.secondary` 两个固定槽里。于是"树里有几个窗格"和"运行时有
 * 几组视图"是两套坐标，groupId 没有对应的实体。
 *
 * 本模块把三层关系钉死：
 *
 * ```
 * LayoutTree（哪些组在什么位置）
 *   → PaneNode.groupId
 *     → ViewGroupState（组内标签集合 / 当前活动文档 / 展示模式）
 *       → DocTab（文档缓冲、会话、版本；全局唯一一份）
 * ```
 *
 * 三条纪律：
 *
 * 1. **只存引用**。组里保存 `docId`，不复制 `DocTab`。同一份文档被两个组看着时，
 *    它们共享同一个缓冲与同一个 Host View——本轮不制造第二份 DocumentSession。
 * 2. **树决定位置，组决定内容**。加标签、切文档、换模式都不碰 `LayoutTree`；
 *    分屏、合并也不碰组内的标签集合。
 * 3. **身份由调用方注入**。`groupId` 一律来自 `LayoutTree`（或兼容桥的保留身份），
 *    本模块绝不生成随机值——否则同一份状态在两次渲染之间就会"换了一组"。
 *
 * 休眠组：`LayoutTree` 里暂时没有对应 Pane 的组（单视图时的 secondary）。
 * 它保留标签与模式，下次分屏原样回来；但**不能获得焦点**，也不参与旧 UI 投影之外
 * 的任何渲染。
 */
import { listPanes, type LayoutTree } from './layout-tree.ts';
import type { PaneId, PaneState, ViewMode } from './types.ts';

/** 一个视图组的运行时状态。`groupId` 与 `LayoutTree` 的 `PaneNode.groupId` 对应。 */
export interface ViewGroupState {
  readonly groupId: string;
  /** 本组关联的文档标签（引用，不是副本）。组内不重复。 */
  readonly tabDocIds: readonly string[];
  /** 本组当前显示的文档；必须是 `tabDocIds` 成员或 `null`。 */
  readonly activeDocId: string | null;
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
  tabDocIds: [],
  activeDocId: null,
  mode: defaultModeOf(groupId),
});

/**
 * 初始组表：两个组都存在。
 *
 * secondary 在初始（单视图）布局里是**休眠组**——`LayoutTree` 只有一个 Pane。
 * 它现在就存在，是为了让"打开分屏"不必凭空造一个组，也让用户在分屏期间的
 * 标签与模式在合并后仍然保留。
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

/** 补齐缺失的组（保留已有组的全部状态，不覆盖标签与模式）。 */
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
    current.activeDocId === next.activeDocId &&
    current.mode === next.mode &&
    current.tabDocIds === next.tabDocIds
  ) {
    return groups;
  }
  return { ...groups, [next.groupId]: next };
}

/** 把一个标签加进组并设为活动文档（组内去重；已存在则只改活动文档）。 */
export function addTab(groups: ViewGroups, groupId: string, docId: string): ViewGroups {
  const group = groupOf(groups, groupId);
  if (group === null) return groups;
  const tabDocIds = group.tabDocIds.includes(docId) ? group.tabDocIds : [...group.tabDocIds, docId];
  return replaceGroup(groups, { ...group, tabDocIds, activeDocId: docId });
}

/** 激活组内的文档：必要时先建立引用。`mode` 可选（恢复时保留记录的模式）。 */
export function activateTab(
  groups: ViewGroups,
  groupId: string,
  docId: string,
  mode?: ViewMode,
): ViewGroups {
  const group = groupOf(groups, groupId);
  if (group === null) return groups;
  const tabDocIds = group.tabDocIds.includes(docId) ? group.tabDocIds : [...group.tabDocIds, docId];
  return replaceGroup(groups, {
    ...group,
    tabDocIds,
    activeDocId: docId,
    mode: mode ?? group.mode,
  });
}

/**
 * 只改活动文档，不动引用（`null` = 这个组暂时没有打开的文档）。
 *
 * 非 `null` 时要求该文档已在组内：让"活动文档"指向一个组里根本没有的标签，
 * 等于制造一条无法解释的状态。
 */
export function setActiveDoc(
  groups: ViewGroups,
  groupId: string,
  docId: string | null,
): ViewGroups {
  const group = groupOf(groups, groupId);
  if (group === null) return groups;
  if (docId !== null && !group.tabDocIds.includes(docId)) return groups;
  if (group.activeDocId === docId) return groups;
  return replaceGroup(groups, { ...group, activeDocId: docId });
}

/** 改展示模式：只影响这一个组。 */
export function setGroupMode(groups: ViewGroups, groupId: string, mode: ViewMode): ViewGroups {
  const group = groupOf(groups, groupId);
  if (group === null || group.mode === mode) return groups;
  return replaceGroup(groups, { ...group, mode });
}

/**
 * 从**所有**组里删除一个文档引用（关闭标签、移除项目都走这里）。
 *
 * 活动文档被删时按**组内**顺序选替代项：先右邻、再左邻、最后为 `null`。
 *
 * `adoptWhenEmptied` 是旧版行为的保留：如果一个组因为这次删除**一个引用都不剩**，
 * 旧版会把窗格指向全局还开着的第一个标签，而不是留一个空白窗格。仅在这种情况下
 * 采纳它（并建立引用），避免"另一个组刚好有标签"就让空组随便接管。
 */
export function removeDoc(
  groups: ViewGroups,
  docId: string,
  adoptWhenEmptied?: string | null,
): ViewGroups {
  let next = groups;
  for (const group of Object.values(groups)) {
    const index = group.tabDocIds.indexOf(docId);
    if (index < 0) continue;
    const remaining = group.tabDocIds.filter((id) => id !== docId);
    const wasActive = group.activeDocId === docId;
    let activeDocId = group.activeDocId;
    if (wasActive) {
      activeDocId = remaining[index] ?? remaining[index - 1] ?? null;
    }
    if (wasActive && activeDocId === null && adoptWhenEmptied && remaining.length === 0) {
      activeDocId = adoptWhenEmptied;
      next = replaceGroup(next, {
        ...group,
        tabDocIds: [adoptWhenEmptied],
        activeDocId,
      });
      continue;
    }
    next = replaceGroup(next, { ...group, tabDocIds: remaining, activeDocId });
  }
  return next;
}

/**
 * 换工作区（`SET_MODE`）：清空所有组的文档引用，**保留组身份**，模式复位到默认。
 *
 * 不删组：组的身份属于布局结构，不属于工作区；下个模式里同一个 Pane 还要用它。
 */
export function clearAllTabs(groups: ViewGroups): ViewGroups {
  let next = groups;
  for (const group of Object.values(groups)) {
    next = replaceGroup(next, {
      ...group,
      tabDocIds: [],
      activeDocId: null,
      mode: defaultModeOf(group.groupId),
    });
  }
  return next;
}

/** 旧 UI 的 `panes` 投影：primary / secondary 两个兼容槽。 */
export function projectPanes(groups: ViewGroups): Record<PaneId, PaneState> {
  const paneOf = (groupId: string, fallbackMode: ViewMode): PaneState => {
    const group = groupOf(groups, groupId);
    if (group === null) return { docId: null, mode: fallbackMode };
    return { docId: group.activeDocId, mode: group.mode };
  };
  return {
    primary: paneOf(LEGACY_LAYOUT_IDS.primaryGroupId, 'editor'),
    secondary: paneOf(LEGACY_LAYOUT_IDS.secondaryGroupId, 'preview'),
  };
}

/**
 * 一致性检查（测试与调试用，不在 reducer 热路径上调用）。
 *
 * 三条不变量：组内 docId 不重复、活动文档必须属于本组、组身份与键一致。
 * `existingDocIds` 可选：给了就顺带检查"每个引用都指向真实存在的 DocTab"。
 */
export function viewGroupProblems(
  groups: ViewGroups,
  existingDocIds?: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  for (const [key, group] of Object.entries(groups)) {
    if (group.groupId !== key) problems.push(`${key}：groupId 与键不一致（${group.groupId}）`);
    const unique = new Set(group.tabDocIds);
    if (unique.size !== group.tabDocIds.length) problems.push(`${key}：组内 docId 重复`);
    if (group.activeDocId !== null && !unique.has(group.activeDocId)) {
      problems.push(`${key}：活动文档不在组内（${group.activeDocId}）`);
    }
    if (existingDocIds) {
      for (const docId of group.tabDocIds) {
        if (!existingDocIds.has(docId)) problems.push(`${key}：引用了不存在的标签（${docId}）`);
      }
    }
  }
  return problems;
}
