/**
 * UX-02C-02：Shell 侧真实改名 / 移动编排（纯 TS，不碰 React / DOM / 磁盘）。
 *
 * 菜单、行内输入框、移动选择器共用这里的**同一条**规则：
 * - `renameDraftOf()` / `selectionForRename()`：预填原名并只选中主文件名；
 * - `structureTargetCheck()`：目标目录规则（同项目、不进自身/后代、形状合法）；
 * - `moveTargetOptions()`：从当前已加载的层表推导可选目标目录，不递归扫描整棵树；
 * - `localStructureBlockers()`：Shell 本地标签/草稿第二道门（Host 重启后也不脱节）；
 * - `createStructureRunner()`：单飞、只有 Host 明确 APPLIED 才刷新层表、UNKNOWN
 *   恰好一次只读核对 + 人工核对提示，绝不自动重发、绝不因"目标存在"推断成功。
 *
 * 名称合法性复用 `packages/storage/entry-name.ts`：Host 与 Shell 同一条规则。
 * 这里只挡"注定失败"的输入；路径归属、会话保护与排他创建的权威判定始终在 Host。
 */
import type { StructureChangeOutcome } from '../client/client-api.ts';
import {
  entryNameOf,
  isEntryUnder,
  parentDirOfEntry,
  validateEntryName,
  validateParentDir,
} from '../../../../packages/storage/entry-name.ts';

export type StructureCommandKind = 'rename' | 'move';
export type StructureEntryKind = 'file' | 'directory';

export interface StructureTabView {
  readonly projectId: string | null;
  readonly path: string;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly documentState: string;
  readonly lastStatus?: string | null;
}

export interface TreeLevelView {
  readonly entries: readonly {
    readonly id: string;
    readonly kind: string;
    readonly path?: string | null;
  }[];
}
export type StructureLevelsView = Readonly<Record<string, TreeLevelView>>;

/** 预填原名的行内草稿：文件保留扩展名，选区只覆盖主文件名。 */
export function selectionForRename(name: string): [number, number] {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [0, dot] : [0, name.length];
}

export function renameDraftOf(sourcePath: string): {
  sourcePath: string;
  parentDir: string;
  draft: string;
  selection: [number, number];
} {
  const draft = entryNameOf(sourcePath);
  return {
    sourcePath,
    parentDir: parentDirOfEntry(sourcePath),
    draft,
    selection: selectionForRename(draft),
  };
}

export type StructureTargetCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * 目标规则：只在同一个项目内移动（projectId 由调用方显式绑定）、目标必须是
 * 已加载层表里的普通目录、目录不能移入自身或后代、名称形状必须合法。
 */
export function structureTargetCheck(input: {
  sourcePath: string;
  targetParentDir: string;
  targetName: string;
  entryKind: StructureEntryKind;
}): StructureTargetCheck {
  const source = validateParentDir(input.sourcePath);
  if (!source.ok || source.value === '') return { ok: false, reason: '源路径不合法' };
  const dir = validateParentDir(input.targetParentDir);
  if (!dir.ok) return { ok: false, reason: dir.message };
  const name = validateEntryName(input.targetName);
  if (!name.ok) return { ok: false, reason: name.message };
  if (input.entryKind === 'directory' && isEntryUnder(dir.value, source.value)) {
    return { ok: false, reason: '不能把文件夹移动到自身或它的子文件夹内' };
  }
  return { ok: true };
}

/**
 * 移动选择器候选目录：只包含**已加载层表里真实存在**的普通文件夹 + 项目根。
 * 未加载到的分页不假装存在；链接节点（kind='link'）不列为目标；
 * 目录自身的后代全部排除（否则会构成非法结构）。
 */
export function moveTargetOptions(
  levels: StructureLevelsView,
  sourcePath: string,
  entryKind: StructureEntryKind,
): string[] {
  const out = new Set<string>(['']);
  for (const level of Object.values(levels)) {
    for (const entry of level.entries) {
      if (entry.kind !== 'folder') continue;
      const path = (entry.path ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!path || path === sourcePath) continue;
      if (entryKind === 'directory' && isEntryUnder(path, sourcePath)) continue;
      out.add(path);
    }
  }
  return [...out].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'zh-Hans-CN')));
}

/** 项目内相对路径的展示形态（移动确认框里的"源 → 目标"）。 */
export function displayPath(path: string): string {
  return path === '' ? '（项目根）' : path;
}

export type StructureBlockerCode =
  | 'ACTIVE_VIEWS'
  | 'DIRTY'
  | 'SAVING'
  | 'OUTCOME_UNKNOWN'
  | 'CONFLICT';

export const STRUCTURE_BLOCKER_TEXT: Record<StructureBlockerCode, string> = {
  ACTIVE_VIEWS: '该文件（或目录内文件）仍有打开的编辑标签',
  DIRTY: '存在未保存修改',
  SAVING: '正在保存',
  OUTCOME_UNKNOWN: '上次保存结果未确认',
  CONFLICT: '存在内容版本冲突',
};

/**
 * Shell 本地第二道门：Host 重启后它的内存会话表会归零，但界面可能仍握有
 * 从未落盘的 buffer。这里只判不救——绝不关闭标签、丢弃草稿、自动保存或重绑会话。
 */
export function localStructureBlockers(
  tabs: readonly StructureTabView[],
  projectId: string,
  sourcePath: string,
  entryKind: StructureEntryKind,
): StructureBlockerCode[] {
  const norm = (value: string): string => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const target = norm(sourcePath);
  const own = tabs.filter((tab) => {
    if (tab.projectId !== projectId) return false;
    const path = norm(tab.path);
    if (path === target) return true;
    return entryKind === 'directory' && path.startsWith(`${target}/`);
  });
  if (own.length === 0) return [];
  const out: StructureBlockerCode[] = ['ACTIVE_VIEWS'];
  const push = (code: StructureBlockerCode): void => {
    if (!out.includes(code)) out.push(code);
  };
  for (const tab of own) {
    if (tab.dirty) push('DIRTY');
    if (tab.saving) push('SAVING');
    if (tab.documentState === 'CONFLICT' || tab.documentState === 'FAILED') push('CONFLICT');
    if (tab.documentState === 'OUTCOME_UNKNOWN' || tab.lastStatus === 'UNKNOWN') push('OUTCOME_UNKNOWN');
  }
  return out;
}

export function blockedText(codes: readonly string[]): string {
  const parts = codes
    .map((code) => STRUCTURE_BLOCKER_TEXT[code as StructureBlockerCode] ?? code)
    .join('、');
  return `无法改名或移动：${parts}。请先关闭相关标签并处理草稿，操作没有任何磁盘副作用。`;
}

export interface StructureRunnerHost {
  rename(projectId: string, sourcePath: string, name: string): Promise<StructureChangeOutcome>;
  move(
    projectId: string,
    sourcePath: string,
    targetParentDir: string,
    name: string,
  ): Promise<StructureChangeOutcome>;
  /** Shell 本地草稿阻断；先于任何请求。 */
  localBlockers(projectId: string, sourcePath: string, entryKind: StructureEntryKind): string[];
  /** UNKNOWN 时恰好一次的只读核对：只刷新源父层与目标父层，不重发、不改草稿。 */
  checkLocations(projectId: string, sourceParentDir: string, targetParentDir: string): Promise<void>;
  /** 只有 Host 明确 APPLIED 才调用：更新层表、作废旧路径、必要时展开目标。 */
  onApplied(outcome: Extract<StructureChangeOutcome, { status: 'APPLIED' }>): void;
  onNotice(message: string): void;
}

export interface StructureSubmitInput {
  readonly kind: StructureCommandKind;
  readonly projectId: string;
  readonly sourcePath: string;
  readonly targetParentDir: string;
  readonly targetName: string;
  readonly entryKind: StructureEntryKind;
}

export type StructureRunResult = 'applied' | 'rejected' | 'unknown' | 'busy' | 'blocked';

export const STRUCTURE_BUSY_MESSAGE = '已有结构变更正在进行，请稍后再试';

/**
 * 提交结果 → 行内输入行 / 移动对话框的去留（UX-02C-02 浏览器验收发现的缺陷）：
 *
 * - `applied` / `unknown` 收起：成功没有再改的理由；UNKNOWN 时提示由状态栏保持
 *   可辨认，输入行还开着只会暗示"可以再提交一次"，而 UNKNOWN 绝不自动重试。
 * - `blocked` / `rejected` / `busy` **保留**：brief §3 要求"权限不足时保留输入
 *   并显示原因"。原因由 onNotice 在提交期间写入行内错误（busy 由调用方补写），
 *   这里若收起就会把刚写入的错误一并抹掉——这正是活动 View 阻断时
 *   "磁盘保护住了、用户却看不到原因"的根因。
 */
export function inputSurvivesStructureResult(result: StructureRunResult): boolean {
  return result === 'blocked' || result === 'busy' || result === 'rejected';
}

export interface StructureRunner {
  submit(input: StructureSubmitInput): Promise<StructureRunResult>;
  busy(): boolean;
}

const UNKNOWN_NOTICE =
  '结构变更结果未确认：已只读刷新源位置与目标位置，请人工核对（不会自动重试、不会自行回滚）';

/**
 * 一次装配 = 一把单飞锁。菜单、行内改名、移动确认框都走这里，不实现第二套逻辑。
 */
export function createStructureRunner(host: StructureRunnerHost): StructureRunner {
  let inflight = false;
  return {
    busy: () => inflight,
    async submit(input) {
      if (inflight) return 'busy';
      inflight = true;
      try {
        const blockedBy = host.localBlockers(input.projectId, input.sourcePath, input.entryKind);
        if (blockedBy.length > 0) {
          host.onNotice(blockedText(blockedBy));
          return 'blocked';
        }
        const checked = structureTargetCheck({
          sourcePath: input.sourcePath,
          targetParentDir: input.targetParentDir,
          targetName: input.targetName,
          entryKind: input.entryKind,
        });
        if (!checked.ok) {
          host.onNotice(checked.reason);
          return 'rejected';
        }
        let outcome: StructureChangeOutcome;
        try {
          outcome =
            input.kind === 'rename'
              ? await host.rename(input.projectId, input.sourcePath, input.targetName)
              : await host.move(
                  input.projectId,
                  input.sourcePath,
                  input.targetParentDir,
                  input.targetName,
                );
        } catch {
          // 传输层抛出：磁盘可能已经变了，只能 UNKNOWN，绝不重发
          await host
            .checkLocations(input.projectId, parentDirOfEntry(input.sourcePath), input.targetParentDir)
            .catch(() => {});
          host.onNotice(UNKNOWN_NOTICE);
          return 'unknown';
        }
        if (outcome.status === 'APPLIED') {
          host.onApplied(outcome);
          return 'applied';
        }
        if (outcome.status === 'UNKNOWN') {
          await host
            .checkLocations(input.projectId, parentDirOfEntry(input.sourcePath), input.targetParentDir)
            .catch(() => {});
          host.onNotice(UNKNOWN_NOTICE);
          return 'unknown';
        }
        host.onNotice(outcome.message || '改名或移动失败');
        return 'rejected';
      } finally {
        inflight = false;
      }
    },
  };
}
