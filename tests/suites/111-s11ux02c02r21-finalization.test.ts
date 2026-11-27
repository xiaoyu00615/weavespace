/**
 * UX-02C-02-R2.1：结构变更的**身份闭环收尾**。
 *
 * R2 钉住的是"要改的是哪个源对象"；R2.1 补上另外三件事：
 * 1. **这条结果该不该写进这一屏**（世界票据 + 每次副作用前的闸门）；
 * 2. **搬进哪个目录**（移动目标文件夹身份）；
 * 3. **请求结束之后焦点在哪**（失焦之后 Escape / Enter 才有效）。
 *
 * 分段（前缀即断言语义）：
 * - W：世界票据与闸门（纯 TS，零 IO）；
 * - N：行内提示按会话票据路由（B02）；
 * - P：项目显示名改名的 A01 / A02 两个边界；
 * - A：结果落地的异步归属（B03）与单飞 / 票据绑定（B04）；
 * - F：文件系统身份（Provider 级，真实磁盘 + 确定性故障注入）；
 * - H：Host 侧目标目录身份核验（真实 Host + 真实 `/api/tree` 锚）；
 * - K：失焦与键盘交互的**判定**（真实按键在浏览器验证里）。
 *
 * 取证口径：一切"是否发生"都写成可数的副作用（invalidate / load / notice /
 * 请求次数 / 磁盘 inode + SHA-256），不靠源码字符串匹配。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createShellServer, type ShellServer } from '../../apps/server/src/server.ts';
import {
  createProjectRuntime,
  type ProjectRuntime,
  type ProjectStore,
  type StoredProject,
} from '../../apps/server/src/project-runtime.ts';
import { inspectProjectRoot } from '../../packages/project-registry/index.ts';
import {
  createLocalProvider,
  type StorageFaultHooks,
  type StorageProvider,
} from '../../packages/storage/index.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { serializeConfig } from '../../apps/server/src/store/config.ts';
import {
  captureStructureIntent,
  structureSessionApplies,
  structureSubmitIntentProblem,
  type StructureIntent,
} from '../../apps/shell/src/state/structure-intent.ts';
import {
  createStaleGuard,
  inlineNoticeTargets,
  structureWorldProblem,
  type StructureWorld,
} from '../../apps/shell/src/state/structure-ownership.ts';
import {
  ancestorDirsOf,
  applyStructureChangeWithOwnership,
  checkStructureLocationsWithOwnership,
  refreshStructureSourceParent,
  staleStructureNotice,
  structureRejectionInvalidatesSource,
  type StructureRefreshHost,
} from '../../apps/shell/src/state/structure-refresh.ts';
import {
  createStructureRunner,
  MISSING_TARGET_INTENT_NOTICE,
  type StructureRunnerHost,
} from '../../apps/shell/src/state/structure-change.ts';
import { projectRenameGateMessage, projectRenameGateOf } from '../../apps/shell/src/state/tree-commands.ts';
import {
  createProjectRenameFlow,
  type ProjectRenameFlowPort,
  type ProjectRenameResult,
  type ProjectRenameSessionView,
} from '../../apps/shell/src/state/project-rename.ts';
import { focusWhereOf, shouldRestoreFocus } from '../../apps/shell/src/components/focus-restore.ts';
import type { TreeLevels, TreeLevelState } from '../../apps/shell/src/components/tree-model.ts';
import type { ResourceNodeState } from '../../apps/shell/src/state/types.ts';
import type { StructureChangeOutcome } from '../../apps/shell/src/client/client-api.ts';
import { withSourceAnchor, type StructureBody } from '../helpers/structure-intent.ts';

const PROJ = 'project-a';
const PROJ_B = 'project-b';
const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');
const hex32 = (seed: string): string => sha(Buffer.from(seed)).slice(0, 32);

/** 世界票据夹具：四维都显式，改哪一维由用例决定。 */
const WORLD: StructureWorld = {
  mode: 'live',
  workspaceMode: 'multi',
  workspaceKey: 'ws-1',
  epoch: 1,
};

function world(overrides: Partial<StructureWorld> = {}): StructureWorld {
  return { ...WORLD, ...overrides };
}

function intentOf(overrides: Partial<StructureIntent> = {}): StructureIntent {
  const captured = captureStructureIntent({
    projectId: PROJ,
    sourcePath: 'docs/notes.md',
    entryKind: 'file',
    anchor: hex32('notes'),
    verification: 'verified',
    world: WORLD,
    sessionId: 1,
  });
  assert.equal(captured.ok, true, '夹具意图必须可冻结');
  assert.ok(captured.ok);
  return { ...captured.intent, ...overrides };
}

function appliedOutcome(): Extract<StructureChangeOutcome, { status: 'APPLIED' }> {
  return {
    status: 'APPLIED',
    projectId: PROJ,
    sourcePath: 'docs/notes.md',
    targetPath: 'archive/notes.md',
    targetParentDir: 'archive',
    targetName: 'notes.md',
    entryKind: 'file',
    contentSha256: null,
    metadataMigration: 'none',
  };
}

/* ================================================================== */
/* W：世界票据与闸门                                                    */
/* ================================================================== */

test('W-01 世界四维：任一维不同都判为不同世界，且文案指向那一维', () => {
  assert.equal(structureWorldProblem(WORLD, world()), null);
  assert.match(structureWorldProblem(WORLD, world({ mode: 'demo' })) ?? '', /工作区模式/);
  assert.match(structureWorldProblem(WORLD, world({ workspaceMode: 'legacy' })) ?? '', /工作区模式/);
  assert.match(structureWorldProblem(WORLD, world({ workspaceKey: 'ws-2' })) ?? '', /工作区已经切换/);
  assert.match(structureWorldProblem(WORLD, world({ epoch: 2 })) ?? '', /重新加载/);
});

test('W-02 Live→Demo→Live：模式回到 live，代次仍是唯一判据', () => {
  const start = world({ mode: 'live', epoch: 1 });
  // 中间经历了 demo（epoch 2），又回到 live（epoch 3）
  const back = world({ mode: 'live', epoch: 3 });
  assert.equal(structureWorldProblem(start, back), '工作区已重新加载，结果没有写入当前界面');
});

test('W-03 闸门：作废后 check() 恒为 true，且不回退（代次只增不减）', () => {
  let now = world();
  const guard = createStaleGuard(world(), () => now);
  assert.equal(guard.check(), false);
  assert.equal(guard.reason(), null);
  now = world({ workspaceKey: 'ws-2' });
  assert.equal(guard.check(), true);
  assert.match(guard.reason() ?? '', /工作区已经切换/);
  // 即使世界"看起来又变回来"，作废也不撤销：一次作废就是永久作废
  now = world();
  assert.equal(guard.check(), true, '作废不得被撤销');
  assert.equal(guard.stale, true);
});

test('W-04 世界票据刻意不含活动项目：同工作区切焦点不算换世界', () => {
  const start = world();
  // 活动项目是另一份状态（`activeProjectId`），票据看不到它
  const afterFocusSwitch = { ...start };
  assert.equal(structureWorldProblem(start, afterFocusSwitch), null);
  assert.equal(Object.hasOwn(start, 'activeProjectId'), false, '票据不得包含活动项目');
});

test('W-05 提交前核验顺序：票据 → 世界 → 源身份（三段文案不互相顶替）', () => {
  const intent = intentOf({ sessionId: 5 });
  const changed = { anchor: hex32('other'), verification: 'verified' as const };
  const same = { anchor: intent.anchor, verification: 'verified' as const };

  // 票据不符最优先：连世界都不看
  assert.match(
    structureSubmitIntentProblem({ intent, sessionCurrent: false, world: world({ epoch: 9 }), current: changed }) ?? '',
    /输入已经结束/,
  );
  // 票据正常、世界不符：说世界，不说对象
  assert.match(
    structureSubmitIntentProblem({ intent, sessionCurrent: true, world: world({ epoch: 9 }), current: changed }) ?? '',
    /重新加载/,
  );
  // 世界正常、身份不符：才说对象
  assert.match(
    structureSubmitIntentProblem({ intent, sessionCurrent: true, world: world(), current: changed }) ?? '',
    /对象已经变化/,
  );
  // 三项都正常：放行
  assert.equal(
    structureSubmitIntentProblem({ intent, sessionCurrent: true, world: world(), current: same }),
    null,
  );
});

test('W-06 structureSessionApplies：会话已收起（null）时旧结果绝不复活它', () => {
  assert.equal(structureSessionApplies({ sessionId: 3, currentSessionId: null }), false);
  assert.equal(structureSessionApplies({ sessionId: 3, currentSessionId: 4 }), false);
  assert.equal(structureSessionApplies({ sessionId: 3, currentSessionId: 3 }), true);
});

/* ================================================================== */
/* N：行内提示按会话票据路由（B02）                                     */
/* ================================================================== */

test('N-01 改名会话的票据 → 只写改名输入行，不碰移动对话框', () => {
  assert.deepEqual(inlineNoticeTargets({ sessionId: 7, namingSessionId: 7, moveSessionId: 9 }), {
    naming: true,
    move: false,
  });
});

test('N-02 移动会话的票据 → 只写移动对话框', () => {
  assert.deepEqual(inlineNoticeTargets({ sessionId: 9, namingSessionId: 7, moveSessionId: 9 }), {
    naming: false,
    move: true,
  });
});

test('N-03 旧会话的迟到结果 → 两个行内界面都不写（不污染新会话）', () => {
  assert.deepEqual(inlineNoticeTargets({ sessionId: 5, namingSessionId: 7, moveSessionId: 9 }), {
    naming: false,
    move: false,
  });
});

test('N-04 没有会话（编辑器命令）→ 两个行内界面都不写', () => {
  assert.deepEqual(inlineNoticeTargets({ sessionId: null, namingSessionId: 7, moveSessionId: 9 }), {
    naming: false,
    move: false,
  });
  assert.deepEqual(inlineNoticeTargets({ sessionId: null, namingSessionId: null, moveSessionId: null }), {
    naming: false,
    move: false,
  });
});

/* ================================================================== */
/* P：项目显示名改名 A01 / A02                                          */
/* ================================================================== */

test('P-01 A01：活动项目在提交前被切走 → 门判 active-project-changed', () => {
  const gate = projectRenameGateOf({
    sessionScope: 'live\u0000multi\u0000ws-1',
    currentScope: 'live\u0000multi\u0000ws-1',
    activeProjectAtStart: PROJ,
    currentActiveProject: PROJ_B,
    projectExists: true,
    projectSupported: true,
  });
  assert.equal(gate, 'active-project-changed');
  assert.match(projectRenameGateMessage(gate) ?? '', /当前项目已经切换/);
});

test('P-02 A01：改的可以是**非当前项目**，不比较 session.projectId 与活动项目', () => {
  // 右键给 B 改显示名，活动项目一直是 A：活动项目没变 → 放行
  const gate = projectRenameGateOf({
    sessionScope: 'live\u0000multi\u0000ws-1',
    currentScope: 'live\u0000multi\u0000ws-1',
    activeProjectAtStart: PROJ,
    currentActiveProject: PROJ,
    projectExists: true,
    projectSupported: true,
  });
  assert.equal(gate, 'ok');
  assert.equal(projectRenameGateMessage(gate), null);
});

test('P-03 A01：切换活动项目后提交 → 关闭会话 + 提示，rename 一次都不发', async () => {
  const harness = renameFlowHarness({ currentActiveProject: PROJ_B });
  await harness.flow.submit();
  assert.equal(harness.sent.length, 0, '门未过不得发出任何请求');
  assert.deepEqual(harness.closed, [11]);
  assert.match(harness.notices.join('\n'), /当前项目已经切换/);
});

test('P-04 A02：APPLIED 但列表未回填且会话仍在 → 明确告知三件事后关闭', async () => {
  const harness = renameFlowHarness({
    result: {
      outcome: {
        status: 'APPLIED',
        project: { projectId: PROJ, name: '新名字', status: 'READY' } as never,
      },
      backfill: 'stale',
      backfillProblem: '工作区已重新加载，重命名结果没有写入当前项目列表',
    },
  });
  await harness.flow.submit();
  const text = harness.notices.join('\n');
  assert.match(text, /新名字/, '要说清楚 Host 已经改成什么');
  assert.match(text, /已在工作区中更新/, '要说清楚磁盘/配置已经变了');
  assert.match(text, /未回填/, '要说清楚这一屏没跟着变');
  assert.match(text, /没有自动重发/, '要说清楚不会自动再来一次');
  assert.deepEqual(harness.closed, [11], '会话仍然要收起（不能留着让用户重复提交）');
});

interface RenameHarness {
  flow: ReturnType<typeof createProjectRenameFlow>;
  sent: Array<{ projectId: string; name: string }>;
  notices: string[];
  closed: number[];
  failed: Array<{ sessionId: number; message: string }>;
}

function renameFlowHarness(input: {
  currentActiveProject?: string | null;
  result?: ProjectRenameResult;
}): RenameHarness {
  const sent: RenameHarness['sent'] = [];
  const notices: string[] = [];
  const closed: number[] = [];
  const failed: RenameHarness['failed'] = [];
  const session: ProjectRenameSessionView = {
    sessionId: 11,
    scope: 'live\u0000multi\u0000ws-1',
    activeProjectAtStart: PROJ,
    projectId: PROJ,
    draft: '新名字',
    saving: false,
  };
  let locked = false;
  const port: ProjectRenameFlowPort = {
    session: () => session,
    currentScope: () => session.scope,
    currentActiveProject: () => input.currentActiveProject ?? PROJ,
    projects: () => [{ projectId: PROJ, name: '项目 A', status: 'READY' } as never],
    supported: () => true,
    rename: async (projectId, name) => {
      sent.push({ projectId, name });
      return (
        input.result ?? {
          outcome: { status: 'APPLIED', project: { projectId, name, status: 'READY' } as never },
          backfill: 'done',
          backfillProblem: null,
        }
      );
    },
    tryLock: () => {
      if (locked) return false;
      locked = true;
      return true;
    },
    unlock: () => {
      locked = false;
    },
    setSaving: () => {},
    close: (sessionId) => void closed.push(sessionId),
    fail: (sessionId, message) => void failed.push({ sessionId, message }),
    notice: (message) => void notices.push(message),
  };
  return { flow: createProjectRenameFlow(port), sent, notices, closed, failed };
}

/* ================================================================== */
/* A：结果落地的异步归属                                                */
/* ================================================================== */

interface RefreshHarness {
  host: StructureRefreshHost;
  state: { world: StructureWorld };
  effects: string[];
  loads: string[];
}

function refreshHarness(input: {
  world?: StructureWorld;
  levels?: TreeLevels;
  /** 第一次 load 之后把世界换掉：模拟"多段 await 之间世界变了"。 */
  worldAfterFirstLoad?: StructureWorld;
} = {}): RefreshHarness {
  const state = { world: input.world ?? WORLD };
  const effects: string[] = [];
  const loads: string[] = [];
  const levels = input.levels ?? levelsFixture();
  const host: StructureRefreshHost = {
    world: () => state.world,
    levels: () => levels,
    invalidateLevel: (_projectId, dir) => void effects.push(`invalidate:${dir}`),
    markStructureChanged: (_projectId, source, target) => void effects.push(`mark:${source}->${target}`),
    expandFolder: (_projectId, path) => void effects.push(`expand:${path}`),
    load: async (_projectId, dir) => {
      loads.push(dir);
      effects.push(`load:${dir}`);
      if (input.worldAfterFirstLoad && loads.length === 1) state.world = input.worldAfterFirstLoad;
    },
    notice: (message) => void effects.push(`notice:${message}`),
  };
  return { host, state, effects, loads };
}

function levelOf(dir: string, entries: ResourceNodeState[] = []): TreeLevelState {
  return {
    dir,
    entries,
    nextCursor: null,
    total: entries.length,
    status: 'ready',
    errorCode: null,
    loadingMore: false,
    snapshot: null,
    hiddenCount: 0,
  };
}

function levelsFixture(): TreeLevels {
  return {
    '': levelOf('', [
      { id: 'dir-docs', name: 'docs', kind: 'folder', path: 'docs' },
      { id: 'dir-archive', name: 'archive', kind: 'folder', path: 'archive' },
    ]),
    docs: levelOf('docs', [{ id: 'f-notes', name: 'notes.md', kind: 'file', path: 'docs/notes.md' }]),
    archive: levelOf('archive'),
  };
}

test('A-01 改名请求在途切换工作区：APPLIED 落地零副作用（连层表都不作废）', async () => {
  const h = refreshHarness({ world: world({ workspaceKey: 'ws-2' }) });
  const result = await applyStructureChangeWithOwnership({
    start: world({ workspaceKey: 'ws-1' }),
    outcome: appliedOutcome(),
    host: h.host,
  });
  assert.equal(result, 'stale');
  assert.deepEqual(h.effects, [], '跨世界的 APPLIED 一个副作用都不许有（含状态栏提示）');
});

test('A-02 移动请求在途 Live→Demo→Live：UNKNOWN 的只读核对一次都不发', async () => {
  const h = refreshHarness({ world: world({ epoch: 3 }) });
  const result = await checkStructureLocationsWithOwnership({
    start: world({ epoch: 1 }),
    projectId: PROJ,
    sourceParentDir: 'docs',
    targetParentDir: 'archive',
    host: h.host,
  });
  assert.equal(result, 'stale');
  assert.deepEqual(h.loads, [], '旧世界的 UNKNOWN 不得让新工作区去读旧路径');
});

test('A-03 同工作区内切活动项目：真实结构变化照常同步（不阻止）', async () => {
  const h = refreshHarness();
  const result = await applyStructureChangeWithOwnership({
    start: world(),
    outcome: appliedOutcome(),
    host: h.host,
  });
  assert.equal(result, 'applied');
  assert.deepEqual(h.effects, [
    'invalidate:docs',
    'invalidate:archive',
    'mark:docs/notes.md->archive/notes.md',
    'load:docs',
    'load:archive',
    'expand:dir-archive',
    'notice:已把「docs/notes.md」变更为「archive/notes.md」（只刷新了相关目录）',
  ]);
});

test('A-04 多段 await 之间世界变化：后续 load / 展开 / 提示全部停止', async () => {
  const h = refreshHarness({ worldAfterFirstLoad: world({ epoch: 2 }) });
  const result = await applyStructureChangeWithOwnership({
    start: world(),
    outcome: appliedOutcome(),
    host: h.host,
  });
  assert.equal(result, 'stale');
  assert.deepEqual(h.loads, ['docs'], '第一段 load 之后就该停手');
  assert.equal(h.effects.filter((effect) => effect.startsWith('notice:')).length, 0);
});

test('A-05 拒绝后的源父层刷新：跨世界零请求；只有"源真的变了"才重取', async () => {
  const stale = refreshHarness({ world: world({ workspaceKey: 'ws-2' }) });
  assert.equal(
    await refreshStructureSourceParent({
      start: world(),
      projectId: PROJ,
      sourcePath: 'docs/notes.md',
      host: stale.host,
    }),
    'stale',
  );
  assert.deepEqual(stale.loads, []);

  const same = refreshHarness();
  assert.equal(
    await refreshStructureSourceParent({
      start: world(),
      projectId: PROJ,
      sourcePath: 'docs/notes.md',
      host: same.host,
    }),
    'applied',
  );
  assert.deepEqual(same.loads, ['docs']);

  // 判据：只有磁盘事实变了才重取；授权/忙/目标已存在都不动层表
  assert.equal(structureRejectionInvalidatesSource('ERR_ENTRY_SOURCE_CHANGED'), true);
  assert.equal(structureRejectionInvalidatesSource('ERR_RESOURCE_NOT_FOUND'), true);
  for (const code of [
    'ERR_ENTRY_TARGET_CHANGED',
    'ERR_ENTRY_EXISTS',
    'ERR_STRUCTURE_SESSION_BUSY',
    'ERR_PERMISSION_DENIED',
    'ERR_STRUCTURE_INTENT_MISSING',
    null,
    undefined,
  ]) {
    assert.equal(structureRejectionInvalidatesSource(code), false, `${String(code)} 不该触发重取`);
  }
});

test('A-06 跨世界提示：说清"已改完 / 没回填 / 不会重发"', () => {
  const text = staleStructureNotice(appliedOutcome(), '工作区已经切换，结果没有写入当前界面');
  assert.match(text, /已把「docs\/notes.md」变更为「archive\/notes.md」/);
  assert.match(text, /工作区已经切换/);
  assert.match(text, /未刷新文件树，不会自动重发/);
});

test('A-07 祖先展开顺序：逐级给出，根为空', () => {
  assert.deepEqual(ancestorDirsOf(''), []);
  assert.deepEqual(ancestorDirsOf('a'), ['a']);
  assert.deepEqual(ancestorDirsOf('a/b/c'), ['a', 'a/b', 'a/b/c']);
});

interface RunnerHarness {
  runner: ReturnType<typeof createStructureRunner>;
  requests: Array<{ kind: string; projectId: string; sourcePath: string; targetAnchor?: string }>;
  notices: Array<{ message: string; sessionId: number }>;
  checked: () => number;
  applied: StructureIntent[];
  rejected: Array<{ errorCode: string | null; sessionId: number }>;
  verified: StructureIntent[];
}

function runnerHarness(input: {
  outcome?: StructureChangeOutcome;
  gate?: (intent: StructureIntent) => string | null;
  pending?: () => Promise<void>;
} = {}): RunnerHarness {
  const requests: RunnerHarness['requests'] = [];
  const notices: RunnerHarness['notices'] = [];
  const applied: StructureIntent[] = [];
  const rejected: RunnerHarness['rejected'] = [];
  const verified: StructureIntent[] = [];
  const state = { checked: 0 };
  const host: StructureRunnerHost = {
    rename: async (projectId, sourcePath, _name, sourceAnchor) => {
      requests.push({ kind: 'rename', projectId, sourcePath });
      assert.match(sourceAnchor, /^[0-9a-f]{32}$/, '源锚必须原样发出');
      if (input.pending) await input.pending();
      return (
        input.outcome ?? {
          status: 'APPLIED',
          projectId,
          sourcePath,
          targetPath: sourcePath,
          targetParentDir: '',
          targetName: 'x',
          entryKind: 'file',
          contentSha256: null,
        }
      );
    },
    move: async (projectId, sourcePath, targetParentDir, _name, _sourceAnchor, targetAnchor) => {
      requests.push({ kind: 'move', projectId, sourcePath, targetAnchor });
      if (input.pending) await input.pending();
      return (
        input.outcome ?? {
          status: 'APPLIED',
          projectId,
          sourcePath,
          targetPath: `${targetParentDir}/${sourcePath}`,
          targetParentDir,
          targetName: 'x',
          entryKind: 'file',
          contentSha256: null,
        }
      );
    },
    localBlockers: () => [],
    verifyIntent: ({ intent }) => {
      verified.push(intent);
      return input.gate ? input.gate(intent) : null;
    },
    checkLocations: async () => {
      state.checked += 1;
    },
    onApplied: (_outcome, intent) => void applied.push(intent),
    onRejected: (outcome, _target, intent) =>
      void rejected.push({ errorCode: outcome.errorCode, sessionId: intent.sessionId }),
    onNotice: (message, sessionId) => void notices.push({ message, sessionId }),
  };
  return {
    runner: createStructureRunner(host),
    requests,
    notices,
    checked: () => state.checked,
    applied,
    rejected,
    verified,
  };
}

test('A-08 单飞锁：并发第二次提交返回 busy，只发出一个请求（Enter 不产生重复提交）', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = runnerHarness({ pending: () => gate });
  const first = h.runner.submit({
    kind: 'rename',
    projectId: PROJ,
    sourcePath: 'docs/notes.md',
    targetParentDir: '',
    targetName: 'b.md',
    entryKind: 'file',
    intent: intentOf(),
  });
  // 第一次还没回来就再按一次
  assert.equal(h.runner.busy(), true);
  const second = await h.runner.submit({
    kind: 'rename',
    projectId: PROJ,
    sourcePath: 'docs/notes.md',
    targetParentDir: '',
    targetName: 'c.md',
    entryKind: 'file',
    intent: intentOf(),
  });
  assert.equal(second, 'busy');
  release();
  assert.equal(await first, 'applied');
  assert.equal(h.requests.length, 1);
  assert.equal(h.runner.busy(), false);
});

test('A-09 同一 projectId+sourcePath 的两个会话：核验与提示都按**本次提交的票据**走', async () => {
  const oldIntent = intentOf({ sessionId: 3, anchor: hex32('old') });
  const newIntent = intentOf({ sessionId: 4, anchor: hex32('new') });
  // 场景：旧会话的请求在途，用户已经重开了这一行（新票据 4）。
  // runner 收到的必须是旧会话自己那份冻结意图——不能"按路径现查最新的"。
  const h = runnerHarness({
    gate: (intent) => (intent.sessionId === 3 ? null : '不该被问到新会话'),
  });
  const result = await h.runner.submit({
    kind: 'rename',
    projectId: PROJ,
    sourcePath: 'docs/notes.md',
    targetParentDir: '',
    targetName: 'notes2.md',
    entryKind: 'file',
    intent: oldIntent,
  });
  assert.equal(result, 'applied');
  assert.equal(h.verified.length, 1);
  assert.equal(h.verified[0]?.sessionId, 3, '核验的必须是本次提交的那一份意图');
  assert.equal(h.verified[0]?.anchor, oldIntent.anchor);
  assert.deepEqual(h.notices.map((item) => item.sessionId), [], '成功路径不写行内错误');
  assert.equal(h.applied[0]?.sessionId, 3);
  // 新会话的内容完全不受影响：它的锚与票据都没被触碰
  assert.equal(newIntent.anchor, hex32('new'));
});

test('A-10 意图与请求不是同一个对象 → 本地拒绝，零请求', async () => {
  const h = runnerHarness();
  const result = await h.runner.submit({
    kind: 'rename',
    projectId: PROJ,
    sourcePath: 'docs/other.md', // 与意图里的 sourcePath 不一致
    targetParentDir: '',
    targetName: 'x.md',
    entryKind: 'file',
    intent: intentOf(),
  });
  assert.equal(result, 'rejected');
  assert.equal(h.requests.length, 0);
  assert.match(h.notices[0]?.message ?? '', /身份信息/);
});

test('A-11 移动缺目标身份 / 形状非法 → 本地拒绝，零请求（不得静默移动）', async () => {
  for (const targetAnchor of [undefined, '', 'not-hex', 'A'.repeat(32)]) {
    const h = runnerHarness();
    const result = await h.runner.submit({
      kind: 'move',
      projectId: PROJ,
      sourcePath: 'docs/notes.md',
      targetParentDir: 'archive',
      targetName: 'notes.md',
      entryKind: 'file',
      intent: intentOf(),
      ...(targetAnchor === undefined ? {} : { targetAnchor }),
    });
    assert.equal(result, 'rejected', `targetAnchor=${String(targetAnchor)} 必须本地拒绝`);
    assert.equal(h.requests.length, 0, '目标身份未知时一个请求都不发');
    assert.equal(h.notices[0]?.message, MISSING_TARGET_INTENT_NOTICE);
  }
  // 合法目标锚才放行
  const ok = runnerHarness();
  assert.equal(
    await ok.runner.submit({
      kind: 'move',
      projectId: PROJ,
      sourcePath: 'docs/notes.md',
      targetParentDir: 'archive',
      targetName: 'notes.md',
      entryKind: 'file',
      intent: intentOf(),
      targetAnchor: hex32('archive'),
    }),
    'applied',
  );
  assert.equal(ok.requests.length, 1);
  assert.equal(ok.requests[0]?.targetAnchor, hex32('archive'), '目标锚必须原样发出');
});

test('A-12 UNKNOWN：恰好一次只读核对、只发一个请求、绝不自动重发', async () => {
  const h = runnerHarness({
    outcome: {
      status: 'UNKNOWN',
      errorCode: 'ERR_OUTCOME_UNKNOWN',
      message: '结果未确认',
      httpStatus: 0,
      projectId: PROJ,
      sourcePath: 'docs/notes.md',
      targetParentDir: 'archive',
      targetName: 'notes.md',
    },
  });
  const result = await h.runner.submit({
    kind: 'move',
    projectId: PROJ,
    sourcePath: 'docs/notes.md',
    targetParentDir: 'archive',
    targetName: 'notes.md',
    entryKind: 'file',
    intent: intentOf(),
    targetAnchor: hex32('archive'),
  });
  assert.equal(result, 'unknown');
  assert.equal(h.requests.length, 1, 'UNKNOWN 不得触发第二次请求');
  assert.equal(h.checked(), 1, '只读核对恰好一次');
  assert.equal(h.applied.length, 0, 'UNKNOWN 不得走 APPLIED 落地');
  assert.match(h.notices[0]?.message ?? '', /不会自动重试/);
});

test('A-13 拒绝（源已变化）：上报错误码且不做只读核对；票据随之带出', async () => {
  const h = runnerHarness({
    outcome: {
      status: 'REJECTED',
      errorCode: 'ERR_ENTRY_SOURCE_CHANGED',
      message: '这一行对应的对象已经变化',
      httpStatus: 409,
    },
  });
  const result = await h.runner.submit({
    kind: 'rename',
    projectId: PROJ,
    sourcePath: 'docs/notes.md',
    targetParentDir: '',
    targetName: 'x.md',
    entryKind: 'file',
    intent: intentOf({ sessionId: 21 }),
  });
  assert.equal(result, 'rejected');
  assert.deepEqual(h.rejected, [{ errorCode: 'ERR_ENTRY_SOURCE_CHANGED', sessionId: 21 }]);
  assert.equal(h.notices[0]?.sessionId, 21);
  assert.equal(h.checked(), 0);
});

/* ================================================================== */
/* F：文件系统身份（Provider 级，真实磁盘）                             */
/* ================================================================== */

type MoveResult = Awaited<ReturnType<NonNullable<StorageProvider['moveEntry']>>>;

interface DiskCtx {
  base: string;
  root: string;
  provider: StorageProvider;
  move(source: string, targetDir: string, name: string, identity: string | null, target?: string | null): Promise<MoveResult>;
  identity(path: string): Promise<string | null>;
}

async function withProvider(
  fn: (ctx: DiskCtx) => Promise<void>,
  options: { faults?: (paths: { root: string; base: string }) => StorageFaultHooks } = {},
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux02c02r21-'));
  const root = join(base, 'root');
  await mkdir(join(root, 'docs', 'nested'), { recursive: true });
  await mkdir(join(root, 'archive'), { recursive: true });
  await writeFile(join(root, 'a.md'), 'A-CONTENT\n', 'utf8');
  await writeFile(join(root, 'docs', 'notes.md'), 'NOTES-CONTENT\n', 'utf8');
  await writeFile(join(root, 'archive', 'keep.md'), 'KEEP\n', 'utf8');
  const provider = createLocalProvider({
    rootDir: root,
    providerId: `local:${PROJ}`,
    ...(options.faults ? { faults: options.faults({ root, base }) } : {}),
  });
  const move = provider.moveEntry!.bind(provider);
  const identity = provider.identityOf!.bind(provider);
  try {
    await fn({
      base,
      root,
      provider,
      move: (source, targetDir, name, expected, target) =>
        move(source, targetDir, name, expected ?? '', target),
      identity,
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function entryIdentity(path: string): Promise<string> {
  const stats = await lstat(path);
  return `${String(stats.dev)}:${String(stats.ino)}`;
}

/** 整棵子树的 (路径|类型|大小|inode|内容摘要)：能抓出"删除重建"与"覆盖"。 */
async function snapshot(root: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    const items = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const child = join(dir, item.name);
      const childRel = rel === '' ? item.name : `${rel}/${item.name}`;
      const stats = await lstat(child);
      const isDir = item.isDirectory();
      lines.push(
        `${childRel}|${isDir ? 'd' : 'f'}|${stats.size}|${String(stats.ino)}|${
          isDir ? '' : sha(await readFile(child))
        }`,
      );
      if (isDir) await walk(child, childRel);
    }
  };
  await walk(root, '');
  return lines.join('\n');
}

test('F-01 源终检失败（同路径换成内容一样的新对象）→ 拒绝且零副作用', async () => {
  let replaced = '';
  await withProvider(
    async (ctx) => {
      const expected = await ctx.identity('a.md');
      assert.equal(typeof expected, 'string');
      const result = await ctx.move('a.md', '', 'b.md', expected);
      assert.equal(result.status, 'REJECTED', JSON.stringify(result));
      assert.equal(result.status === 'REJECTED' ? result.errorCode : '', 'ERR_ENTRY_SOURCE_CHANGED');
      // 目标没留下任何东西：占位被清理干净
      assert.equal(existsSync(join(ctx.root, 'b.md')), false, '拒绝后目标位置不得残留占位');
      // 外部换上的新对象还在，且**不是**被我们删掉的那个
      assert.equal(existsSync(join(ctx.root, 'a.md')), true);
      assert.equal(await entryIdentity(join(ctx.root, 'a.md')), replaced);
      assert.equal(await readFile(join(ctx.root, 'a.md'), 'utf8'), 'A-CONTENT\n');
      assert.notEqual(replaced, expected, '夹具必须真的换了 inode（同内容不同身份）');
    },
    {
      faults: ({ root }) => ({
        // 这个钩子是**同步**契约（Provider 不 await 它），因此夹具也用同步 API
        beforeMoveRename: () => {
          // 内容一模一样、大小一模一样，只有身份不同
          rmSync(join(root, 'a.md'), { force: true });
          writeFileSync(join(root, 'a.md'), 'A-CONTENT\n', 'utf8');
          const stats = lstatSync(join(root, 'a.md'));
          replaced = `${String(stats.dev)}:${String(stats.ino)}`;
        },
      }),
    },
  );
});

test('F-02 源被换成同路径的目录 → ERR_ENTRY_SOURCE_INVALID，且不删除外部目录', async () => {
  await withProvider(
    async (ctx) => {
      const expected = await ctx.identity('a.md');
      const result = await ctx.move('a.md', '', 'b.md', expected);
      assert.equal(result.status, 'REJECTED', JSON.stringify(result));
      assert.equal(result.status === 'REJECTED' ? result.errorCode : '', 'ERR_ENTRY_SOURCE_INVALID');
      assert.equal(existsSync(join(ctx.root, 'b.md')), false);
      // 外部换上的是目录：类型不对必须比"身份不符"更早判出来，且绝不删除它
      const stats = await lstat(join(ctx.root, 'a.md'));
      assert.equal(stats.isDirectory(), true);
    },
    {
      faults: ({ root }) => ({
        beforeMoveRename: () => {
          rmSync(join(root, 'a.md'), { force: true });
          mkdirSync(join(root, 'a.md'), { recursive: true });
        },
      }),
    },
  );
});

test('F-03 源被换成链接（junction）→ ERR_ENTRY_SOURCE_INVALID，不跟随、不删除', async (t) => {
  let swapFailed = false;
  await withProvider(
    async (ctx) => {
      if (swapFailed) {
        t.skip('本机无法创建 junction，链接替换用例跳过（其余用例不受影响）');
        return;
      }
      const expected = await ctx.identity('docs/nested');
      const result = await ctx.move('docs/nested', '', 'nested', expected);
      assert.equal(result.status, 'REJECTED', JSON.stringify(result));
      assert.equal(result.status === 'REJECTED' ? result.errorCode : '', 'ERR_ENTRY_SOURCE_INVALID');
      assert.equal(existsSync(join(ctx.root, 'nested')), false, '拒绝后不得把链接搬过去');
      // 链接本身还在（不是我们的东西，不删）；它指向的根外目录内容没被动过
      const stats = await lstat(join(ctx.root, 'docs', 'nested'));
      assert.equal(stats.isSymbolicLink(), true);
      assert.equal(existsSync(join(ctx.base, 'outside', 'secret.md')), true);
    },
    {
      faults: ({ root, base }) => ({
        beforeMoveRename: () => {
          try {
            mkdirSync(join(base, 'outside'), { recursive: true });
            writeFileSync(join(base, 'outside', 'secret.md'), 'SECRET\n', 'utf8');
            rmSync(join(root, 'docs', 'nested'), { recursive: true, force: true });
            symlinkSync(join(base, 'outside'), join(root, 'docs', 'nested'), 'junction');
          } catch {
            swapFailed = true;
          }
        },
      }),
    },
  );
});

test('F-04 rename 之后目标被换成内容相同的新对象 → UNKNOWN（绝不当 MOVED）', async () => {
  let replaced = '';
  await withProvider(
    async (ctx) => {
      const expected = await ctx.identity('a.md');
      const result = await ctx.move('a.md', '', 'b.md', expected);
      assert.equal(result.status, 'UNKNOWN', JSON.stringify(result));
      // 外部对象不被删除：结果未确认时只能留给人工核对
      assert.equal(existsSync(join(ctx.root, 'b.md')), true);
      assert.equal(await entryIdentity(join(ctx.root, 'b.md')), replaced);
      assert.equal(await readFile(join(ctx.root, 'b.md'), 'utf8'), 'A-CONTENT\n');
      assert.notEqual(replaced, expected, '夹具必须真的换了 inode（同内容不同身份）');
    },
    {
      faults: ({ root }) => ({
        afterRename: async () => {
          const target = join(root, 'b.md');
          await rm(target, { force: true });
          await writeFile(target, 'A-CONTENT\n', 'utf8');
          replaced = await entryIdentity(target);
        },
      }),
    },
  );
});

test('F-05 目标身份读不到（rename 后目标消失）→ UNKNOWN', async () => {
  await withProvider(
    async (ctx) => {
      const expected = await ctx.identity('a.md');
      const result = await ctx.move('a.md', '', 'b.md', expected);
      assert.equal(result.status, 'UNKNOWN', JSON.stringify(result));
      assert.equal(existsSync(join(ctx.root, 'b.md')), false);
    },
    {
      faults: ({ root }) => ({
        afterRename: async () => {
          await rm(join(root, 'b.md'), { force: true });
        },
      }),
    },
  );
});

test('F-06 大小写仅变化：目标名称正确但身份不同 → UNKNOWN', async () => {
  let replaced = '';
  await withProvider(
    async (ctx) => {
      const expected = await ctx.identity('a.md');
      const result = await ctx.move('a.md', '', 'A.md', expected);
      assert.equal(result.status, 'UNKNOWN', JSON.stringify(result));
      const names = (await readdir(ctx.root)).filter((name) => name.toLowerCase() === 'a.md');
      assert.deepEqual(names, ['A.md'], '目录里只能有一个目录项');
      assert.equal(await entryIdentity(join(ctx.root, 'A.md')), replaced);
    },
    {
      faults: ({ root }) => ({
        afterRename: async () => {
          const target = join(root, 'A.md');
          await rm(target, { force: true });
          await writeFile(target, 'A-CONTENT\n', 'utf8');
          replaced = await entryIdentity(target);
        },
      }),
    },
  );
});

test('F-07 目标目录被删除重建（同路径、新身份）→ ERR_ENTRY_TARGET_CHANGED，源原地不动', async () => {
  await withProvider(async (ctx) => {
    const expected = await ctx.identity('a.md');
    const targetIdentity = await ctx.identity('archive');
    assert.equal(typeof targetIdentity, 'string');
    // 用户选中目标之后，外部把目录删掉又建了一个同名目录
    await rm(join(ctx.root, 'archive'), { recursive: true, force: true });
    await mkdir(join(ctx.root, 'archive'), { recursive: true });
    const result = await ctx.move('a.md', 'archive', 'a.md', expected, targetIdentity);
    assert.equal(result.status, 'REJECTED', JSON.stringify(result));
    assert.equal(result.status === 'REJECTED' ? result.errorCode : '', 'ERR_ENTRY_TARGET_CHANGED');
    assert.equal(existsSync(join(ctx.root, 'a.md')), true, '源必须保持原位');
    assert.equal(await readFile(join(ctx.root, 'a.md'), 'utf8'), 'A-CONTENT\n');
    assert.deepEqual(await readdir(join(ctx.root, 'archive')), [], '不得在用户未确认的新目录里留下文件');
  });
});

test('F-08 占位阶段目标目录被换掉 → 拒绝；新目录里没有本次操作的痕迹', async () => {
  await withProvider(
    async (ctx) => {
      const expected = await ctx.identity('a.md');
      // 用户选中的是**替换前**那一个目录
      const targetIdentity = await ctx.identity('archive');
      assert.equal(typeof targetIdentity, 'string');
      const result = await ctx.move('a.md', 'archive', 'a.md', expected, targetIdentity);
      assert.equal(result.status, 'REJECTED', JSON.stringify(result));
      assert.equal(result.status === 'REJECTED' ? result.errorCode : '', 'ERR_ENTRY_TARGET_CHANGED');
      assert.equal(existsSync(join(ctx.root, 'a.md')), true, '源必须保持原位');
      // rename 之前就发现了：没有搬进新目录，新目录保持空
      assert.deepEqual(await readdir(join(ctx.root, 'archive')), []);
      // 旧目录（被外部挪走）里留着占位与原有文件，但它已经不在用户选择的位置上
      assert.deepEqual((await readdir(join(ctx.root, 'archive-old'))).sort(), ['a.md', 'keep.md']);
    },
    {
      faults: ({ root }) => ({
        beforeMoveRename: () => {
          // 占位已建立：把整个目录挪走，再造一个同路径的新目录
          renameSync(join(root, 'archive'), join(root, 'archive-old'));
          mkdirSync(join(root, 'archive'), { recursive: true });
        },
      }),
    },
  );
});

test('F-09 已有同名目标 → ERR_ENTRY_EXISTS，外部对象一个字节都不动', async () => {
  await withProvider(async (ctx) => {
    const expected = await ctx.identity('a.md');
    const existingBefore = await entryIdentity(join(ctx.root, 'archive', 'keep.md'));
    const result = await ctx.move('a.md', 'archive', 'keep.md', expected);
    assert.equal(result.status, 'REJECTED', JSON.stringify(result));
    assert.equal(result.status === 'REJECTED' ? result.errorCode : '', 'ERR_ENTRY_EXISTS');
    assert.equal(await entryIdentity(join(ctx.root, 'archive', 'keep.md')), existingBefore);
    assert.equal(await readFile(join(ctx.root, 'archive', 'keep.md'), 'utf8'), 'KEEP\n');
    assert.equal(existsSync(join(ctx.root, 'a.md')), true);
  });
});

test('F-10 UNKNOWN 之后没有第二次尝试：占位只建立一次、目标保持外部对象', async () => {
  let attempts = 0;
  let replaced = '';
  await withProvider(
    async (ctx) => {
      const expected = await ctx.identity('a.md');
      const result = await ctx.move('a.md', '', 'b.md', expected);
      assert.equal(result.status, 'UNKNOWN', JSON.stringify(result));
      assert.equal(attempts, 1, 'UNKNOWN 不得触发内部重试');
      // 目标仍是外部换上的那个对象（没有被第二次 rename 覆盖，也没有被删除）
      assert.equal(await entryIdentity(join(ctx.root, 'b.md')), replaced);
      assert.equal(existsSync(join(ctx.root, 'a.md')), false, '源已经被第一次 rename 搬走');
      assert.deepEqual((await readdir(ctx.root)).sort(), ['archive', 'b.md', 'docs']);
    },
    {
      faults: ({ root }) => ({
        // 每建立一次占位调用一次：用它证明"只尝试过一次"
        afterMoveReserve: () => {
          attempts += 1;
        },
        afterRename: async () => {
          const target = join(root, 'b.md');
          await rm(target, { force: true });
          await writeFile(target, 'A-CONTENT\n', 'utf8');
          replaced = await entryIdentity(target);
        },
      }),
    },
  );
});

/* ================================================================== */
/* H：Host 侧目标目录身份（真实 Host + 真实 /api/tree 锚）              */
/* ================================================================== */

interface ApiResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

class FakeStore implements ProjectStore {
  readonly durability = 'memory' as const;
  private projects: StoredProject[];
  constructor(initial: readonly StoredProject[]) {
    this.projects = initial.map((project) => ({ ...project }));
  }
  load(): readonly StoredProject[] {
    return this.projects.map((project) => ({ ...project }));
  }
  async commitAdd(entry: StoredProject & { opId: string }): Promise<void> {
    const { opId: _opId, ...rest } = entry;
    this.projects.push(rest);
  }
  async commitRename(input: { projectId: string; name: string; opId: string }): Promise<void> {
    this.projects = this.projects.map((project) =>
      project.projectId === input.projectId ? { ...project, name: input.name } : project,
    );
  }
  async commitRevoke(input: { projectId: string; opId: string }): Promise<void> {
    this.projects = this.projects.filter((project) => project.projectId !== input.projectId);
  }
}

function storedProject(projectId: string, name: string, rootDir: string): StoredProject {
  const inspected = inspectProjectRoot(rootDir);
  assert.equal(inspected.status, 'READY', `夹具根必须 READY: ${projectId}`);
  return {
    projectId,
    name,
    rootDir,
    canonicalRoot: inspected.canonicalRoot,
    rootToken: inspected.rootToken,
    grantedAt: new Date().toISOString(),
    grantSource: 'os-dialog',
  };
}

interface HostCtx {
  base: string;
  root: string;
  server: ShellServer;
  runtime: ProjectRuntime;
  token: string;
  post(path: string, body: unknown): Promise<ApiResponse>;
  get(path: string): Promise<ApiResponse>;
  tree(dir?: string): Promise<ApiResponse>;
  anchorOf(path: string): Promise<string>;
  move(body: Record<string, unknown>): Promise<ApiResponse>;
  rename(body: Record<string, unknown>): Promise<ApiResponse>;
  disk(): Promise<string>;
}

async function withHost(
  fn: (ctx: HostCtx) => Promise<void>,
  options: { fileStore?: boolean } = {},
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux02c02r21h-'));
  const root = join(base, 'project-a');
  await mkdir(join(root, 'docs', 'nested'), { recursive: true });
  await mkdir(join(root, 'archive'), { recursive: true });
  await writeFile(join(root, 'a.md'), 'A-CONTENT\n', 'utf8');
  await writeFile(join(root, 'docs', 'notes.md'), 'NOTES-CONTENT\n', 'utf8');
  await writeFile(join(root, 'archive', 'keep.md'), 'KEEP\n', 'utf8');

  const storeDir = join(base, 'store');
  await mkdir(storeDir, { recursive: true });
  let runtimeRef: ProjectRuntime | undefined;
  const build = (): Promise<ShellServer> =>
    options.fileStore
      ? createShellServer({ port: 0, managedStore: { dir: storeDir, picker: createFakePicker([]) } })
      : createShellServer({
          port: 0,
          managed: {
            create: (deps) => {
              const runtime = createProjectRuntime({
                ...deps,
                store: new FakeStore([storedProject(PROJ, '项目 A', root)]),
                grantSource: 'os-dialog',
                allowEphemeralRevocation: true,
                providerFactory: (input: { projectId: string; providerId: string; rootDir: string }) =>
                  createLocalProvider({ rootDir: input.rootDir, providerId: input.providerId }),
              });
              runtimeRef = runtime;
              return runtime;
            },
          },
        });
  if (options.fileStore) {
    await writeFile(
      join(storeDir, 'workspace.json'),
      serializeConfig({
        version: 4,
        commitSeq: 0,
        issuedIds: [PROJ],
        revoked: [],
        projects: [storedProject(PROJ, '项目 A', root)],
        hidden: [],
        trash: [],
      }),
      'utf8',
    );
  }

  const server = await build();
  const api = async (path: string, init?: RequestInit): Promise<ApiResponse> => {
    const res = await fetch(`${server.url}${path}`, init);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  };
  const token = ((await api('/api/session-token')).body as { token?: string }).token ?? '';
  assert.notEqual(token, '', '夹具必须拿到 T1 令牌');
  const post = (path: string, body: unknown): Promise<ApiResponse> =>
    api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ws-token': token, origin: new URL(server.url).origin },
      body: JSON.stringify(body),
    });
  const get = (path: string): Promise<ApiResponse> => api(path, { headers: { 'x-ws-token': token } });
  const tree = (dir = ''): Promise<ApiResponse> =>
    api(`/api/tree?projectId=${encodeURIComponent(PROJ)}${dir ? `&dir=${encodeURIComponent(dir)}` : ''}`);
  const anchorOf = async (path: string): Promise<string> => {
    const slash = path.lastIndexOf('/');
    const dir = slash >= 0 ? path.slice(0, slash) : '';
    const page = await tree(dir);
    assert.equal(page.status, 200, `取锚失败: ${JSON.stringify(page.body)}`);
    const anchor = ((page.body.anchors ?? {}) as Record<string, string>)[path];
    assert.equal(typeof anchor, 'string', `夹具取不到 ${path} 的锚`);
    return anchor as string;
  };
  const ctx: HostCtx = {
    base,
    root,
    server,
    get runtime() {
      assert.ok(runtimeRef);
      return runtimeRef as ProjectRuntime;
    },
    token,
    post,
    get,
    tree,
    anchorOf,
    move: async (body) =>
      post('/api/files/move', await withSourceAnchor(body as unknown as StructureBody, (_pid, dir) => tree(dir))),
    rename: (body) => post('/api/files/rename', body),
    disk: () => snapshot(root),
  };
  try {
    await fn(ctx);
  } finally {
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true });
  }
}

test('H-01 移动到用户选中的目录（真实锚）→ 200，文件真的搬过去', async () => {
  await withHost(async (h) => {
    const target = await h.anchorOf('archive');
    const res = await h.move({
      projectId: PROJ,
      sourcePath: 'docs/notes.md',
      targetParentDir: 'archive',
      name: 'notes.md',
      targetAnchor: target,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(existsSync(join(h.root, 'docs', 'notes.md')), false);
    assert.equal(await readFile(join(h.root, 'archive', 'notes.md'), 'utf8'), 'NOTES-CONTENT\n');
  });
});

test('H-02 目标锚指向另一个目录 → 409 ERR_ENTRY_TARGET_CHANGED，零磁盘变更', async () => {
  await withHost(async (h) => {
    const otherDirAnchor = await h.anchorOf('docs');
    const before = await h.disk();
    const res = await h.move({
      projectId: PROJ,
      sourcePath: 'docs/notes.md',
      targetParentDir: 'archive',
      name: 'notes.md',
      targetAnchor: otherDirAnchor,
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_ENTRY_TARGET_CHANGED');
    assert.equal(await h.disk(), before);
  });
});

test('H-03 目标目录被删除重建后旧锚失效 → 409 ERR_ENTRY_TARGET_CHANGED，源原地不动', async () => {
  await withHost(async (h) => {
    const oldAnchor = await h.anchorOf('archive');
    await rm(join(h.root, 'archive'), { recursive: true, force: true });
    await mkdir(join(h.root, 'archive'), { recursive: true });
    const newAnchor = await h.anchorOf('archive');
    assert.notEqual(newAnchor, oldAnchor, '夹具必须真的换了目录身份（否则本用例没有判别力）');
    const res = await h.move({
      projectId: PROJ,
      sourcePath: 'docs/notes.md',
      targetParentDir: 'archive',
      name: 'notes.md',
      targetAnchor: oldAnchor,
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_ENTRY_TARGET_CHANGED');
    assert.equal(await readFile(join(h.root, 'docs', 'notes.md'), 'utf8'), 'NOTES-CONTENT\n');
    assert.deepEqual(await readdir(join(h.root, 'archive')), []);
  });
});

test('H-04 目标目录不存在 → ERR_ENTRY_PARENT_INVALID（按"重选目标"处理，不是"目标变了"）', async () => {
  await withHost(async (h) => {
    const before = await h.disk();
    const res = await h.move({
      projectId: PROJ,
      sourcePath: 'docs/notes.md',
      targetParentDir: 'ghost',
      name: 'notes.md',
      targetAnchor: hex32('ghost'),
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_ENTRY_PARENT_INVALID');
    assert.equal(await h.disk(), before);
  });
});

test('H-05 移动到项目根：目标身份是根令牌摘要，错锚同样拒绝', async () => {
  await withHost(async (h) => {
    const rootPage = await h.tree();
    const rootAnchor = (rootPage.body as { projectAnchor?: string }).projectAnchor;
    assert.equal(typeof rootAnchor, 'string', '根层必须给出 projectAnchor');

    const bad = await h.move({
      projectId: PROJ,
      sourcePath: 'docs/notes.md',
      targetParentDir: '',
      name: 'notes.md',
      targetAnchor: hex32('not-the-root'),
    });
    assert.equal(bad.status, 409, JSON.stringify(bad.body));
    assert.equal(bad.body.errorCode, 'ERR_ENTRY_TARGET_CHANGED');

    const ok = await h.move({
      projectId: PROJ,
      sourcePath: 'docs/notes.md',
      targetParentDir: '',
      name: 'notes.md',
      targetAnchor: rootAnchor,
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(await readFile(join(h.root, 'notes.md'), 'utf8'), 'NOTES-CONTENT\n');
  });
});

test('H-06 改名不受目标锚影响：仍走 Host 派生目标目录', async () => {
  await withHost(async (h) => {
    const anchor = await h.anchorOf('docs/notes.md');
    const res = await h.rename({ projectId: PROJ, sourcePath: 'docs/notes.md', name: 'math.md', sourceAnchor: anchor });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(existsSync(join(h.root, 'docs', 'math.md')), true);
  });
});

test('H-07 移动时既有标注随文件迁移（成功路径不被目标核验打断）', async () => {
  await withHost(
    async (h) => {
      const sourceAnchor = await h.anchorOf('docs/notes.md');
      const set = await h.post('/api/metadata/set', {
        projectId: PROJ,
        path: 'docs/notes.md',
        alias: '数学笔记',
        anchor: sourceAnchor,
      });
      assert.equal(set.status, 200, JSON.stringify(set.body));
      const target = await h.anchorOf('archive');
      const res = await h.move({
        projectId: PROJ,
        sourcePath: 'docs/notes.md',
        targetParentDir: 'archive',
        name: 'notes.md',
        targetAnchor: target,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.metadataMigration, 'moved');
      const page = await h.tree('archive');
      const entry = (page.body.entries as Array<{ name: string; meta?: { alias?: string } }>).find(
        (item) => item.name === 'notes.md',
      );
      assert.equal(entry?.meta?.alias, '数学笔记', '标注必须跟到新路径');
      const list = await h.get(`/api/metadata?projectId=${encodeURIComponent(PROJ)}`);
      const paths = (list.body.entries as Array<{ path: string }>).map((record) => record.path);
      assert.equal(paths.includes('docs/notes.md'), false, '旧路径的记录必须迁走');
    },
    { fileStore: true },
  );
});

/* ================================================================== */
/* K：失焦与键盘交互的判定                                              */
/* ================================================================== */

test('K-01 改名被拒后：提交结束、会话仍在、焦点在 body → 应该还回去', () => {
  assert.equal(focusWhereOf({ tagName: 'BODY' }, { tagName: 'INPUT' }), 'body');
  assert.equal(focusWhereOf(null, { tagName: 'INPUT' }), 'body');
  assert.equal(
    shouldRestoreFocus({ ended: true, sessionCurrent: true, atStart: 'self', now: 'body' }),
    true,
  );
  // 用户是按 Enter 提交的：开始时焦点就在输入框里
  assert.equal(
    shouldRestoreFocus({ ended: true, sessionCurrent: true, atStart: 'body', now: 'body' }),
    true,
    'disabled 先一步把焦点扔到 body 时也要还',
  );
});

test('K-02 移动被拒后 Escape 可取消：焦点已回到对话框主按钮', () => {
  const primary = { tagName: 'BUTTON' };
  assert.equal(focusWhereOf(primary, primary), 'self');
  assert.equal(
    shouldRestoreFocus({ ended: true, sessionCurrent: true, atStart: 'self', now: 'self' }),
    true,
  );
  // 提交尚未结束（还有一次渲染在途）时不还，避免反复抢
  assert.equal(
    shouldRestoreFocus({ ended: false, sessionCurrent: true, atStart: 'self', now: 'body' }),
    false,
  );
});

test('K-03 Enter 不产生重复提交（与 A-08 同一把锁，这里断言"结束后可再来一次"）', async () => {
  const h = runnerHarness();
  const input = {
    kind: 'rename' as const,
    projectId: PROJ,
    sourcePath: 'docs/notes.md',
    targetParentDir: '',
    targetName: 'x.md',
    entryKind: 'file' as const,
    intent: intentOf(),
  };
  assert.equal(await h.runner.submit(input), 'applied');
  // 锁在 finally 里释放：下一次真实按键仍然可以提交
  assert.equal(h.runner.busy(), false);
  assert.equal(await h.runner.submit(input), 'applied');
  assert.equal(h.requests.length, 2);
});

test('K-04 请求返回时旧会话已取消 → 不抢夺新会话的焦点', () => {
  // 会话票据已经不是这一条：不还焦点（可能正开着一个新会话）
  assert.equal(
    shouldRestoreFocus({ ended: true, sessionCurrent: false, atStart: 'self', now: 'body' }),
    false,
  );
  // 新会话有自己的输入框，焦点此刻在它那里：绝不能抢过来
  assert.equal(
    shouldRestoreFocus({ ended: true, sessionCurrent: false, atStart: 'body', now: 'elsewhere' }),
    false,
  );
});

test('K-05 正文编辑器里的键盘事件不被抢：焦点在别处时永不 programmatic focus', () => {
  assert.equal(focusWhereOf({ tagName: 'TEXTAREA' }, { tagName: 'INPUT' }), 'elsewhere');
  assert.equal(
    shouldRestoreFocus({ ended: true, sessionCurrent: true, atStart: 'elsewhere', now: 'elsewhere' }),
    false,
  );
  // 提交开始后才切到正文编辑器：同样不抢
  assert.equal(
    shouldRestoreFocus({ ended: true, sessionCurrent: true, atStart: 'self', now: 'elsewhere' }),
    false,
  );
});
