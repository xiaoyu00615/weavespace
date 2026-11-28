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
import type { StructureIntent } from './structure-intent.ts';
import { structureUnknownNotice, type StructureCheckOutcome } from './structure-refresh.ts';
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

/**
 * 结构变更结果里的"标注迁移"结论（UX-02C-04-R1 / R1-04）。
 *
 * 三种结论必须说清楚，尤其是 `failed`：
 * **磁盘已经变了**，只是配置没写进去。若把它说成"改名失败"，用户会去重试一次
 * 真实操作（那时源路径已经不存在），或者以为文件没动。文案里必须同时出现
 * "文件已移动"和"资源标注未能迁移"两件事。
 */
export type StructureMetadataMigration = 'moved' | 'none' | 'failed';

export function structureMetadataNote(migration: StructureMetadataMigration | undefined): string {
  if (migration === 'failed') return '文件已移动，但资源标注未能随文件迁移。';
  if (migration === 'moved') return '资源标注已随文件迁移。';
  return '';
}

/** 改名 / 移动成功的完整提示（含标注迁移结论）。 */
export function structureChangeNotice(outcome: {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly metadataMigration?: StructureMetadataMigration | undefined;
}): string {
  const base = `已把「${outcome.sourcePath}」变更为「${outcome.targetPath}」（只刷新了相关目录）`;
  const note = structureMetadataNote(outcome.metadataMigration);
  return note ? `${base}；${note}` : base;
}

export interface StructureRunnerHost {
  rename(
    projectId: string,
    sourcePath: string,
    name: string,
    sourceAnchor: string,
  ): Promise<StructureChangeOutcome>;
  /**
   * `targetAnchor` 是**移动目标文件夹**的身份预期（UX-02C-02-R2.1 / D）。
   *
   * 与源锚同一套语义：用户在对话框里选中的那个目录，到 Host 动手时还必须
   * 还是那一个；否则"删除重建同名目录"会让文件被搬进一个用户没确认过的目录。
   */
  move(
    projectId: string,
    sourcePath: string,
    targetParentDir: string,
    name: string,
    sourceAnchor: string,
    targetAnchor: string,
  ): Promise<StructureChangeOutcome>;
  /** Shell 本地草稿阻断；先于任何请求。 */
  localBlockers(projectId: string, sourcePath: string, entryKind: StructureEntryKind): string[];
  /**
   * 提交前的意图核验（UX-02C-02-R2 / R2.1）：票据、世界、源身份三件事。
   *
   * 传进来的是**这次提交实际使用的那一份冻结意图**（`intent`），不是按
   * `projectId + sourcePath` 现查一遍"当前最新的意图"——同一行先后开过两个会话时，
   * 后者会把前者顶掉，于是核验的对象根本不是要提交的那个。
   *
   * 返回 `null` 才能发请求；返回文案表示本地直接拒绝（零请求）。
   * 它**不替代** Host 的核验：权威判据始终在 Host（客户端只看自己看到的树）。
   */
  verifyIntent(input: { readonly intent: StructureIntent }): string | null;
  /**
   * UNKNOWN 时恰好一次的只读核对：只刷新源父层与目标父层，不重发、不改草稿。
   *
   * 返回值是**核对本身的结论**，不是结构变更的结论（UX-02C-02-R2.2 / F03）：
   * - `applied`：真的发了刷新请求并且完成；
   * - `stale`：世界已经换了，闸门作废，一个请求都没发；
   * - `failed`：请求失败或没跑完（抛错）。
   * 提示文案必须按它来写，不能零请求还宣称"已刷新"。
   */
  checkLocations(
    projectId: string,
    sourceParentDir: string,
    targetParentDir: string,
    intent: StructureIntent,
  ): Promise<StructureCheckOutcome>;
  /** 只有 Host 明确 APPLIED 才调用：更新层表、作废旧路径、必要时展开目标。 */
  onApplied(
    outcome: Extract<StructureChangeOutcome, { status: 'APPLIED' }>,
    intent: StructureIntent,
  ): void;
  /**
   * Host 明确 REJECTED 时调用（UX-02C-02-R2）。
   *
   * 拒绝**不只是"命令没被执行"**：`ERR_ENTRY_SOURCE_CHANGED` / `ERR_RESOURCE_NOT_FOUND`
   * 同时是一条事实——这个路径上的对象已经不是我们缓存里那一个了。调用方据此把
   * 源所在的**那一层**判为过期并重取，否则旧锚会一直挂在这一行上，用户无论
   * 重试多少次都会被同一个旧锚挡住。
   *
   * 只在拒绝时上报，不做任何磁盘动作；是否重取由 Shell 决定。
   */
  onRejected?(
    outcome: Extract<StructureChangeOutcome, { status: 'REJECTED' }>,
    /**
     * `targetParentDir` 是这次请求的**目标父目录**（R2.2 / F02）。
     *
     * 目标身份被拒时，过期的不是源那一层，而是目标所属父层：没有它，
     * 调用方只能刷源层，用户永远无法重新确认目标。
     */
    target: {
      readonly projectId: string;
      readonly sourcePath: string;
      readonly targetParentDir: string;
    },
    intent: StructureIntent,
  ): void;
  /**
   * 提示落地。`sessionId` 是发起这次请求的会话票据：
   * 调用方据此决定写进**哪一个**输入行 / 移动对话框（而不是两个都写）。
   */
  onNotice(message: string, sessionId: number): void;
}

export interface StructureSubmitInput {
  readonly kind: StructureCommandKind;
  readonly projectId: string;
  readonly sourcePath: string;
  readonly targetParentDir: string;
  readonly targetName: string;
  readonly entryKind: StructureEntryKind;
  /**
   * 打开意图时冻结的**整份**预期（UX-02C-02-R2 / R2.1）。
   *
   * **必填**：它同时携带源锚、身份状态、所在世界（模式/工作区/代次）与会话票据。
   * 声明为必填而不是可选，是为了让"漏传"变成编译错误，而不是一次静默的
   * 无锚路径操作（与 `restoreTrash` 的 `gate` 同一处理）。
   */
  readonly intent: StructureIntent;
  /**
   * move 专用：对话框里选中的目标文件夹身份（项目根用 `projectAnchor`）。
   *
   * 缺失 / 形状非法一律本地拒绝——"目标身份未知时不得静默移动"。
   * rename 的目标父目录由 Host 派生，不需要也不接受这一项。
   */
  readonly targetAnchor?: string;
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

/** 没有身份预期就不发请求（与 Host 的 `ERR_STRUCTURE_INTENT_MISSING` 同义，只是更早）。 */
const MISSING_INTENT_NOTICE = '缺少源文件的身份信息：请刷新文件树后重新发起操作';
/** 目标目录身份未知：绝不"先搬过去再说"。 */
export const MISSING_TARGET_INTENT_NOTICE = '目标文件夹的身份无法核验：请重新选择目标后再试';

/** 资源锚形状（与 Host 的 `SOURCE_ANCHOR_RE` 同一规则）。 */
const ANCHOR_RE = /^[0-9a-f]{32}$/;

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
      const sessionId = input.intent.sessionId;
      const notify = (message: string): void => host.onNotice(message, sessionId);
      try {
        const blockedBy = host.localBlockers(input.projectId, input.sourcePath, input.entryKind);
        if (blockedBy.length > 0) {
          notify(blockedText(blockedBy));
          return 'blocked';
        }
        const checked = structureTargetCheck({
          sourcePath: input.sourcePath,
          targetParentDir: input.targetParentDir,
          targetName: input.targetName,
          entryKind: input.entryKind,
        });
        if (!checked.ok) {
          notify(checked.reason);
          return 'rejected';
        }
        /**
         * 意图核验（UX-02C-02-R2 / R2.1）：先确认"要改的是哪个对象、在哪个世界"，
         * 再谈怎么改。两道都在**发请求之前**：票据/世界/锚任一不成立，
         * 一个字节都不发出去。Host 侧仍会独立核验（这里只是尽早给原因）。
         */
        if (typeof input.intent.anchor !== 'string' || input.intent.anchor === '') {
          notify(MISSING_INTENT_NOTICE);
          return 'rejected';
        }
        if (
          input.intent.projectId !== input.projectId ||
          input.intent.sourcePath !== input.sourcePath
        ) {
          // 意图与本次请求不是同一个对象：宁可拒绝，也不要拿 A 的锚去改 B
          notify(MISSING_INTENT_NOTICE);
          return 'rejected';
        }
        if (input.kind === 'move') {
          const targetAnchor = input.targetAnchor;
          if (typeof targetAnchor !== 'string' || !ANCHOR_RE.test(targetAnchor)) {
            notify(MISSING_TARGET_INTENT_NOTICE);
            return 'rejected';
          }
        }
        const intentProblem = host.verifyIntent({ intent: input.intent });
        if (intentProblem) {
          notify(intentProblem);
          return 'rejected';
        }
        /**
         * UNKNOWN 的只读核对（R2.2 / F03）：真的发了没有、发成功没有，
         * 都要如实反映在提示里；它**不是**重发，也不是自动重试。
         */
        const runReadOnlyCheck = async (): Promise<StructureCheckOutcome> => {
          try {
            const checked = await host.checkLocations(
              input.projectId,
              parentDirOfEntry(input.sourcePath),
              input.targetParentDir,
              input.intent,
            );
            return checked === 'stale' ? 'stale' : 'applied';
          } catch {
            return 'failed';
          }
        };
        let outcome: StructureChangeOutcome;
        try {
          outcome =
            input.kind === 'rename'
              ? await host.rename(
                  input.projectId,
                  input.sourcePath,
                  input.targetName,
                  input.intent.anchor,
                )
              : await host.move(
                  input.projectId,
                  input.sourcePath,
                  input.targetParentDir,
                  input.targetName,
                  input.intent.anchor,
                  input.targetAnchor as string,
                );
        } catch {
          // 传输层抛出：磁盘可能已经变了，只能 UNKNOWN，绝不重发
          notify(structureUnknownNotice(await runReadOnlyCheck()));
          return 'unknown';
        }
        if (outcome.status === 'APPLIED') {
          host.onApplied(outcome, input.intent);
          return 'applied';
        }
        if (outcome.status === 'UNKNOWN') {
          notify(structureUnknownNotice(await runReadOnlyCheck()));
          return 'unknown';
        }
        host.onRejected?.(
          outcome,
          {
            projectId: input.projectId,
            sourcePath: input.sourcePath,
            targetParentDir: input.targetParentDir,
          },
          input.intent,
        );
        notify(outcome.message || '改名或移动失败');
        return 'rejected';
      } finally {
        inflight = false;
      }
    },
  };
}
