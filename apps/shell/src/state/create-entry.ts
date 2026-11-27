/**
 * UX-02C-01：Shell 侧创建编排（纯 TS，不碰 React / DOM / 磁盘）。
 *
 * 菜单、工具栏、行内输入框三者共用这里的**同一条**规则：
 * - `resolveCreateTarget()`：把"右键了什么 / 当前选中了什么"折算成显式
 *   `(projectId, parentDir)`，多项目下绝不借用别的项目活动状态；
 * - `createEntryRunner()`：提交期间单飞、只有 Host 明确 APPLIED 才算成功、
 *   UNKNOWN 只做一次只读目录核对并提示人工核对，绝不自动重发、绝不把"发现同名"
 *   推断成"本次创建成功"；
 * - `initialNamingDraft()` / `selectionForPreset()`：预设扩展名时保留扩展名并
 *   只选中主文件名，避免用户改名字时把 `.md` 一起删掉。
 *
 * 名称合法性复用 `packages/storage/entry-name.ts`：Host 与 Shell 同一条规则，
 * 不会漂移。这里只挡"注定失败"的输入，权威判定始终在 Host。
 */
import type { CreateEntryOutcome, CreateEntryKindDto } from '../client/client-api.ts';
import { validateEntryName } from '../../../../packages/storage/entry-name.ts';

/** 相对目录规范形态：'' = 项目根；其余为 `/` 分隔、无首尾斜杠。 */
export function normalizeDir(dir: string | null | undefined): string {
  if (!dir) return '';
  return dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/** 文件路径 → 父目录（项目内相对路径）。根下文件返回 ''。 */
export function parentDirOf(filePath: string): string {
  const normalized = normalizeDir(filePath);
  const slash = normalized.lastIndexOf('/');
  return slash <= 0 ? '' : normalized.slice(0, slash);
}

export type CreateOrigin =
  /** 右键项目根行 / 顶部按钮且没有选中目录。 */
  | 'project-root'
  /** 右键文件夹行。 */
  | 'folder'
  /** 右键普通文件行：创建在该文件的父目录。 */
  | 'file'
  /** 右键树的空白区。 */
  | 'blank'
  /** 顶部工具栏。 */
  | 'toolbar'
  /** 右键链接节点：一律不允许创建。 */
  | 'link';

export interface CreateTargetInput {
  readonly origin: CreateOrigin;
  /** 上下文所属项目；Demo / Legacy 为 null（不支持真实创建）。 */
  readonly projectId: string | null;
  /** folder：该文件夹自身的相对路径；file：该文件的相对路径。 */
  readonly nodePath?: string | null;
  readonly kind: CreateEntryKindDto;
  /** 当前明确选中的目录（按项目）。空串表示项目根。 */
  readonly selectedDirByProject: Readonly<Record<string, string>>;
  /** 当前活动项目（仅"空白区无上下文项目"时允许回落）。 */
  readonly activeProjectId: string | null;
  /** 是否有可用的真实项目（Demo / 不可用项目为 false）。 */
  readonly supported: boolean;
}

export type CreateTargetResolution =
  | { ok: true; projectId: string; parentDir: string }
  | { ok: false; reason: string };

/**
 * 目标目录解析。规则固定，不随"当前活动项目"漂移：
 * - 链接节点 → 拒绝（绝不沿链接创建）；
 * - 非托管 / 不可用项目 → 拒绝；
 * - 项目根 → 项目根；文件夹 → 该文件夹内部；普通文件 → 该文件父目录；
 * - 空白区 / 工具栏 → 当前明确选中的目录，否则活动项目根；
 * - 空白区允许用 `activeProjectId` 补一个**明确的** projectId；一旦上下文
 *   已经带有 projectId，就绝不改用别的项目。
 */
export function resolveCreateTarget(input: CreateTargetInput): CreateTargetResolution {
  if (input.origin === 'link') {
    return { ok: false, reason: '链接节点不能创建文件或文件夹（避免越过项目根）' };
  }
  if (!input.supported) {
    return { ok: false, reason: '当前模式不提供真实创建' };
  }
  const projectId = input.projectId ?? (input.origin === 'blank' ? input.activeProjectId : null);
  if (!projectId) {
    return { ok: false, reason: '没有明确的项目：请先选中一个项目' };
  }
  if (input.origin === 'project-root') return { ok: true, projectId, parentDir: '' };
  if (input.origin === 'folder') {
    return { ok: true, projectId, parentDir: normalizeDir(input.nodePath) };
  }
  if (input.origin === 'file') {
    return { ok: true, projectId, parentDir: parentDirOf(input.nodePath ?? '') };
  }
  // blank / toolbar：优先当前明确选中的目录，否则项目根
  const selected = normalizeDir(input.selectedDirByProject[projectId] ?? '');
  return { ok: true, projectId, parentDir: selected };
}

/** 预设扩展名时的初始输入：保留扩展名，主文件名留给用户命名。 */
export function initialNamingDraft(presetExtension?: string): string {
  return presetExtension ?? '';
}

/**
 * 预设扩展名的选区：只选中主文件名部分（长度通常为 0，即光标停在扩展名前）。
 * 返回 `[start, end]`，供 `<input>.setSelectionRange()` 使用。
 */
export function selectionForPreset(draft: string, presetExtension?: string): [number, number] {
  if (!presetExtension) return [0, 0];
  const stemLength = Math.max(0, draft.length - presetExtension.length);
  return [0, stemLength];
}

/**
 * 预设扩展名模式（UX-02C-01-R1 / R1-02）：**主文件名为空**时不得提交。
 *
 * 只在这一种模式下生效：初值 `.md` 只是一个待填的模板，直接 Enter 会生成
 * 一个名叫 `.md` 的隐藏文件，既不是用户想要的，也很难在文件树里发现。
 * 自由输入模式没有 `presetExtension`，因此 `.env` / `.gitignore` 这类合法的
 * 点文件名仍由 Host 通用规则裁决，Shell 不额外加禁。
 *
 * 这里**不改** `packages/storage/entry-name.ts`（Host 通用校验与磁盘 API 不变）。
 */
export const EMPTY_PRESET_STEM_MESSAGE = '请先填写文件名';

export function missingPresetStem(draft: string, presetExtension?: string): boolean {
  if (!presetExtension) return false;
  // 扩展名可能被用户手工改掉：此时剩下的整段就是主名，不能强行要求它带 .md
  const stem = draft.endsWith(presetExtension)
    ? draft.slice(0, draft.length - presetExtension.length)
    : draft;
  return stem.trim().length === 0;
}

/**
 * 层表条目的最小视图：state 层不反向依赖 `components/tree-model.ts`。
 */
export interface TreeEntryView {
  readonly id: string;
  readonly kind: string;
  readonly path?: string | null;
}

export interface TreeLevelsView {
  readonly [dir: string]: { readonly entries: readonly TreeEntryView[] };
}

/**
 * 在已加载的层表里找到目标目录对应的**真实**文件夹节点 id。
 *
 * 分页还没加载到的目录返回 `null`：绝不凭路径猜一个 id 去展开幻影节点。
 */
export function folderNodeIdOf(levels: TreeLevelsView, dir: string): string | null {
  if (dir === '') return null;
  for (const level of Object.values(levels)) {
    const found = level.entries.find(
      (entry) => entry.kind === 'folder' && (entry.path ?? '') === dir,
    );
    if (found) return found.id;
  }
  return null;
}

export interface CreateExpansionPlan {
  /** 需要打开的项目根容器（Multi 的项目 id）；本阶段创建只在托管 Multi 可用。 */
  readonly rootProjectId: string | null;
  /** 需要**幂等**展开的文件夹节点 id；`null` = 目标就是项目根。 */
  readonly folderNodeId: string | null;
}

/**
 * 创建开始时的可见性计划（UX-02C-01-R1 / R1-01）。
 *
 * 行内输入行只在展开的目录里渲染，所以 `beginCreate` 必须同时保证：
 * 1. 项目根容器是打开的（折叠的项目根右键创建同样要看得见输入框）；
 * 2. 目标文件夹是展开的（折叠的 docs 右键创建要立刻看到输入框）。
 *
 * 这里只返回**幂等展开**所需的节点：调用方用 `EXPAND_PROJECT_NODE`
 * （已展开则原样返回 state），绝不能用 `TOGGLE_*`，否则会把本来就展开的
 * 目录折叠回去。右键文件夹行时 `nodeId` 直接来自该行，最精确；
 * 空白区 / 工具栏走层表查找。
 */
export function createExpansionPlan(input: {
  readonly projectId: string;
  readonly parentDir: string;
  readonly levels: TreeLevelsView;
  readonly nodeId?: string | null;
}): CreateExpansionPlan {
  const dir = normalizeDir(input.parentDir);
  return {
    rootProjectId: input.projectId,
    folderNodeId:
      dir === '' ? null : input.nodeId ?? folderNodeIdOf(input.levels, dir),
  };
}

export interface CreateEntryRunnerHost {
  create(input: {
    projectId: string;
    parentDir: string;
    name: string;
    kind: CreateEntryKindDto;
  }): Promise<CreateEntryOutcome>;
  /** 只读核对目录（UNKNOWN 时恰好一次）：只刷新层表，不改草稿、不重发创建。 */
  checkDirectory(projectId: string, parentDir: string): Promise<void>;
  /** 只有 Host 明确 APPLIED 才调用：失效目标层并刷新、必要时展开目录。 */
  onApplied(outcome: Extract<CreateEntryOutcome, { status: 'APPLIED' }>): void;
  /**
   * 提示落地。`sessionId` 是发起这次请求的输入行票据（UX-02C-02-R2.1 / B02）：
   * 调用方据此只写进**对应的**那个输入行，而不是把错误写进所有打开着的行内界面。
   */
  onNotice(message: string, sessionId?: number): void;
}

export type CreateRunResult = 'applied' | 'rejected' | 'unknown' | 'busy';

/** 提交入参：`presetExtension` 只用于本地预检，绝不进入 Host 请求体。 */
export interface CreateSubmitInput {
  readonly projectId: string;
  readonly parentDir: string;
  readonly name: string;
  readonly kind: CreateEntryKindDto;
  readonly presetExtension?: string;
  /** 输入行票据：结果回来时用于核验"还是不是这一行"。 */
  readonly sessionId?: number;
}

export interface CreateEntryRunner {
  submit(input: CreateSubmitInput): Promise<CreateRunResult>;
  /** 是否正在提交（菜单/输入框据此禁用重复提交）。 */
  busy(): boolean;
}

/**
 * 创建编排器：**一次装配 = 一把单飞锁**。
 *
 * 注意 UNKNOWN 分支的三个"绝不"：
 * 1. 绝不再次调用 `create()`（网络断开时请求可能已经创建了对象）；
 * 2. 绝不因为 `checkDirectory()` 看到同名文件就宣称成功；
 * 3. 绝不把 UNKNOWN 折成 REJECTED（那会诱导用户再点一次，撞出重复创建）。
 */
export function createEntryRunner(host: CreateEntryRunnerHost): CreateEntryRunner {
  let inflight = false;
  const unknownNotice = '创建结果未确认：已只读刷新该目录，请人工核对（不会自动重试）';
  return {
    busy: () => inflight,
    async submit(input) {
      if (inflight) return 'busy';
      inflight = true;
      try {
        // 纵深防御：即使 UI 漏了预检，预设模式的空主名也绝不发给 Host。
        // 组件层还会提前拦一次，避免输入框因"提交中"禁用而失焦。
        if (missingPresetStem(input.name, input.presetExtension)) {
          host.onNotice(EMPTY_PRESET_STEM_MESSAGE, input.sessionId);
          return 'rejected';
        }
        const checked = validateEntryName(input.name);
        if (!checked.ok) {
          host.onNotice(checked.message, input.sessionId);
          return 'rejected';
        }
        // 显式拼装请求：presetExtension 等 UI 字段一概不进入 Host
        const request = {
          projectId: input.projectId,
          parentDir: input.parentDir,
          name: input.name,
          kind: input.kind,
        };
        let outcome: CreateEntryOutcome;
        try {
          outcome = await host.create(request);
        } catch {
          // 传输层抛出：同样按"结果不明"收敛，绝不重发
          await host.checkDirectory(input.projectId, input.parentDir).catch(() => {});
          host.onNotice(unknownNotice, input.sessionId);
          return 'unknown';
        }
        if (outcome.status === 'APPLIED') {
          host.onApplied(outcome);
          return 'applied';
        }
        if (outcome.status === 'UNKNOWN') {
          await host.checkDirectory(input.projectId, input.parentDir).catch(() => {});
          host.onNotice(unknownNotice, input.sessionId);
          return 'unknown';
        }
        host.onNotice(outcome.message || '创建失败', input.sessionId);
        return 'rejected';
      } finally {
        inflight = false;
      }
    },
  };
}
