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
  onNotice(message: string): void;
}

export type CreateRunResult = 'applied' | 'rejected' | 'unknown' | 'busy';

export interface CreateEntryRunner {
  submit(input: {
    projectId: string;
    parentDir: string;
    name: string;
    kind: CreateEntryKindDto;
  }): Promise<CreateRunResult>;
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
        const checked = validateEntryName(input.name);
        if (!checked.ok) {
          host.onNotice(checked.message);
          return 'rejected';
        }
        let outcome: CreateEntryOutcome;
        try {
          outcome = await host.create(input);
        } catch {
          // 传输层抛出：同样按"结果不明"收敛，绝不重发
          await host.checkDirectory(input.projectId, input.parentDir).catch(() => {});
          host.onNotice(unknownNotice);
          return 'unknown';
        }
        if (outcome.status === 'APPLIED') {
          host.onApplied(outcome);
          return 'applied';
        }
        if (outcome.status === 'UNKNOWN') {
          await host.checkDirectory(input.projectId, input.parentDir).catch(() => {});
          host.onNotice(unknownNotice);
          return 'unknown';
        }
        host.onNotice(outcome.message || '创建失败');
        return 'rejected';
      } finally {
        inflight = false;
      }
    },
  };
}
