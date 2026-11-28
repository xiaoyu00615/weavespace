/**
 * UX-02C-02-R2.2：占位收敛与异常恢复。
 *
 * 分四段（前缀即断言语义）：
 * - P：占位残留的结果语义（真实磁盘 + 确定性故障注入，Provider 级）；
 * - N：UNKNOWN 提示的真实性（已核对 / 未核对 / 核对失败三态）；
 * - R：目标身份变化后的恢复（重取目标所属父层，按世界票据）；
 * - S：会话写入守卫（旧会话不得改写/关闭新会话）。
 *
 * 取证口径：磁盘副作用一律写成可数事实（路径集合 + size + inode + SHA-256），
 * 不靠"看起来没变"。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createLocalProvider, type StorageFaultHooks, type StorageProvider } from '../../packages/storage/index.ts';
import {
  captureStructureIntent,
  type StructureIntent,
} from '../../apps/shell/src/state/structure-intent.ts';
import type { StructureWorld } from '../../apps/shell/src/state/structure-ownership.ts';
import {
  refreshStructureTargetParent,
  structureUnknownNotice,
  type StructureRefreshHost,
} from '../../apps/shell/src/state/structure-refresh.ts';
import {
  createStructureRunner,
  type StructureRunnerHost,
} from '../../apps/shell/src/state/structure-change.ts';
import { updateSessionIfOwned } from '../../apps/shell/src/state/structure-session.ts';
import type { TreeLevels, TreeLevelState } from '../../apps/shell/src/components/tree-model.ts';
import type { ResourceNodeState } from '../../apps/shell/src/state/types.ts';
import type { StructureChangeOutcome } from '../../apps/shell/src/client/client-api.ts';

const PROJ = 'project-a';
const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

const WORLD: StructureWorld = { mode: 'live', workspaceMode: 'multi', workspaceKey: 'ws-1', epoch: 1 };
const world = (overrides: Partial<StructureWorld> = {}): StructureWorld => ({ ...WORLD, ...overrides });

function intentOf(overrides: Partial<StructureIntent> = {}): StructureIntent {
  const captured = captureStructureIntent({
    projectId: PROJ,
    sourcePath: 'docs/notes.md',
    entryKind: 'file',
    anchor: 'a'.repeat(32),
    verification: 'verified',
    world: WORLD,
    sessionId: 1,
  });
  assert.ok(captured.ok);
  return { ...captured.intent, ...overrides };
}

/* ================================================================== */
/* P：占位残留的结果语义（真实磁盘）                                    */
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
  const base = await mkdtemp(join(tmpdir(), 'ws-ux02c02r22-'));
  const root = join(base, 'root');
  await mkdir(join(root, 'archive'), { recursive: true });
  await writeFile(join(root, 'a.md'), 'A-CONTENT\n', 'utf8');
  await writeFile(join(root, 'archive', 'keep.md'), 'KEEP\n', 'utf8');
  const provider = createLocalProvider({
    rootDir: root,
    providerId: `local:${PROJ}`,
    ...(options.faults ? { faults: options.faults({ root, base }) } : {}),
  });
  try {
    await fn({
      base,
      root,
      provider,
      move: (source, targetDir, name, expected, target) =>
        provider.moveEntry!(source, targetDir, name, expected ?? '', target),
      identity: provider.identityOf!.bind(provider),
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function entryIdentity(path: string): Promise<string> {
  const stats = await lstat(path);
  return `${String(stats.dev)}:${String(stats.ino)}`;
}

/** 磁盘事实：路径 → (类型|大小|inode|内容摘要)。缺路径就是缺席，不假装。 */
async function facts(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(dir, item.name);
      const childRel = rel === '' ? item.name : `${rel}/${item.name}`;
      const stats = await lstat(child);
      const isDir = item.isDirectory();
      out[childRel] = `${isDir ? 'd' : 'f'}|${stats.size}|${String(stats.ino)}|${
        isDir ? '' : sha(await readFile(child))
      }`;
      if (isDir) await walk(child, childRel);
    }
  };
  await walk(root, '');
  return out;
}

test('P-01 占位**前**目标目录被替换 → REJECTED（零副作用，源与新目录都干净）', async () => {
  await withProvider(async (ctx) => {
    const expected = await ctx.identity('a.md');
    const selected = await ctx.identity('archive');
    assert.equal(typeof selected, 'string');
    // 用户在对话框里选完之后，外部把目录删掉又建了一个同名目录
    await rm(join(ctx.root, 'archive'), { recursive: true, force: true });
    await mkdir(join(ctx.root, 'archive'), { recursive: true });
    const result = await ctx.move('a.md', 'archive', 'a.md', expected, selected);
    assert.equal(result.status, 'REJECTED', JSON.stringify(result));
    assert.equal(result.status === 'REJECTED' ? result.errorCode : '', 'ERR_ENTRY_TARGET_CHANGED');
    const disk = await facts(ctx.root);
    assert.equal(disk['a.md']?.startsWith('f|10|'), true, '源文件必须原样留在原位');
    assert.deepEqual(Object.keys(disk).filter((key) => key.startsWith('archive/')), [], '新目录里不得留下任何东西');
  });
});

test('P-02 占位后目标目录被整体移走（afterMoveReserve）→ UNKNOWN，旧目录里留着占位', async () => {
  await withProvider(
    async (ctx) => {
      const expected = await ctx.identity('a.md');
      const selected = await ctx.identity('archive');
      const result = await ctx.move('a.md', 'archive', 'a.md', expected, selected);
      assert.equal(result.status, 'UNKNOWN', JSON.stringify(result));
      const disk = await facts(ctx.root);
      // 源：原样
      assert.equal(disk['a.md']?.startsWith('f|10|'), true);
      // 原路径（新目录）下的 a.md 是 missing —— 这正是旧实现误判"零副作用"的地方
      assert.equal(disk['archive/a.md'], undefined, '新目录里不得有同名对象');
      // 旧目录里我们的占位还在：无法证明收敛，只能 UNKNOWN
      assert.equal(disk['archive-old/a.md']?.startsWith('f|0|'), true, '占位随目录被移走，仍在旧目录里');
      assert.equal(await readFile(join(ctx.root, 'archive-old/keep.md'), 'utf8'), 'KEEP\n', '外部原有文件不动');
    },
    {
      faults: ({ root }) => ({
        afterMoveReserve: () => {
          renameSync(join(root, 'archive'), join(root, 'archive-old'));
          mkdirSync(join(root, 'archive'), { recursive: true });
        },
      }),
    },
  );
});

test('P-03 占位后目标目录被整体移走（beforeMoveRename）→ 同样 UNKNOWN', async () => {
  await withProvider(
    async (ctx) => {
      const expected = await ctx.identity('a.md');
      const selected = await ctx.identity('archive');
      const result = await ctx.move('a.md', 'archive', 'a.md', expected, selected);
      assert.equal(result.status, 'UNKNOWN', JSON.stringify(result));
      const disk = await facts(ctx.root);
      assert.equal(disk['archive/a.md'], undefined);
      assert.equal(disk['archive-old/a.md']?.startsWith('f|0|'), true, '占位仍在旧目录');
    },
    {
      faults: ({ root }) => ({
        beforeMoveRename: () => {
          renameSync(join(root, 'archive'), join(root, 'archive-old'));
          mkdirSync(join(root, 'archive'), { recursive: true });
        },
      }),
    },
  );
});

test('P-04 新目录里有外部同名文件 → UNKNOWN，外部对象一字节不动', async () => {
  let externalIdentity = '';
  await withProvider(
    async (ctx) => {
      const expected = await ctx.identity('a.md');
      const selected = await ctx.identity('archive');
      const result = await ctx.move('a.md', 'archive', 'a.md', expected, selected);
      assert.equal(result.status, 'UNKNOWN', JSON.stringify(result));
      assert.equal(existsSync(join(ctx.root, 'archive/a.md')), true, '外部同名文件必须还在');
      assert.equal(await readFile(join(ctx.root, 'archive/a.md'), 'utf8'), 'EXTERNAL\n');
      assert.equal(await entryIdentity(join(ctx.root, 'archive/a.md')), externalIdentity, '不得删除重建');
      assert.equal(await readFile(join(ctx.root, 'a.md'), 'utf8'), 'A-CONTENT\n', '源保持原位');
    },
    {
      faults: ({ root }) => ({
        afterMoveReserve: () => {
          renameSync(join(root, 'archive'), join(root, 'archive-old'));
          mkdirSync(join(root, 'archive'), { recursive: true });
          writeFileSync(join(root, 'archive', 'a.md'), 'EXTERNAL\n', 'utf8');
          const stats = lstatSync(join(root, 'archive', 'a.md'));
          externalIdentity = `${String(stats.dev)}:${String(stats.ino)}`;
        },
      }),
    },
  );
});

test('P-05 目标目录连续、占位可安全清理 → 仍允许 REJECTED（不滥用 UNKNOWN）', async () => {
  await withProvider(
    async (ctx) => {
      const expected = await ctx.identity('a.md');
      const selected = await ctx.identity('archive');
      const result = await ctx.move('a.md', 'archive', 'a.md', expected, selected);
      assert.equal(result.status, 'REJECTED', JSON.stringify(result));
      assert.equal(result.status === 'REJECTED' ? result.errorCode : '', 'ERR_ENTRY_SOURCE_CHANGED');
      const disk = await facts(ctx.root);
      // 占位被清理干净：目标目录只剩原有文件
      assert.deepEqual(Object.keys(disk).filter((key) => key.startsWith('archive/')), ['archive/keep.md']);
      // 外部换上的新源对象还在，不是我们删的
      assert.equal(await readFile(join(ctx.root, 'a.md'), 'utf8'), 'A-CONTENT\n');
      assert.notEqual(await entryIdentity(join(ctx.root, 'a.md')), expected, '夹具必须真的换了对象');
    },
    {
      faults: ({ root }) => ({
        beforeMoveRename: () => {
          rmSync(join(root, 'a.md'), { force: true });
          writeFileSync(join(root, 'a.md'), 'A-CONTENT\n', 'utf8');
        },
      }),
    },
  );
});

test('P-06 10b 重新占位前先认目录：不会在新同名目录里补一个占位', async () => {
  await withProvider(
    async (ctx) => {
      const expected = await ctx.identity('a.md');
      const selected = await ctx.identity('archive');
      const result = await ctx.move('a.md', 'archive', 'a.md', expected, selected);
      assert.equal(result.status, 'UNKNOWN', JSON.stringify(result));
      const disk = await facts(ctx.root);
      // 关键：新目录必须**空**——旧实现会在新目录里重新占位（用户从未确认过的目录）
      assert.deepEqual(Object.keys(disk).filter((key) => key.startsWith('archive/')), []);
      assert.equal(disk['a.md']?.startsWith('f|10|'), true);
    },
    {
      faults: ({ root }) => ({
        afterMoveReserve: () => {
          // 外部先删掉我们的占位，再把整个目录挪走，然后建一个新的同名目录
          rmSync(join(root, 'archive', 'a.md'), { force: true });
          renameSync(join(root, 'archive'), join(root, 'archive-old'));
          mkdirSync(join(root, 'archive'), { recursive: true });
        },
      }),
    },
  );
});

test('P-07 目录被移走 + 源同时被换掉 → 仍只能 UNKNOWN（不能宣称零副作用）', async () => {
  await withProvider(
    async (ctx) => {
      const expected = await ctx.identity('a.md');
      const selected = await ctx.identity('archive');
      const result = await ctx.move('a.md', 'archive', 'a.md', expected, selected);
      assert.equal(result.status, 'UNKNOWN', JSON.stringify(result));
      const disk = await facts(ctx.root);
      // 10c 先发现源变了；但占位已随旧目录离开，清理路径不可证明 → 不是 REJECTED
      assert.equal(disk['archive-old/a.md']?.startsWith('f|0|'), true, '占位仍在旧目录里');
      assert.equal(await readFile(join(ctx.root, 'a.md'), 'utf8'), 'A-CONTENT\n', '外部换上的新对象还在');
    },
    {
      faults: ({ root }) => ({
        beforeMoveRename: () => {
          renameSync(join(root, 'archive'), join(root, 'archive-old'));
          mkdirSync(join(root, 'archive'), { recursive: true });
          rmSync(join(root, 'a.md'), { force: true });
          writeFileSync(join(root, 'a.md'), 'A-CONTENT\n', 'utf8');
        },
      }),
    },
  );
});

/* ================================================================== */
/* N：UNKNOWN 提示的真实性                                              */
/* ================================================================== */
test('N-01 已执行只读核对：才可以说"已刷新"', () => {
  const text = structureUnknownNotice('applied');
  assert.match(text, /已只读刷新源位置与目标位置/);
  assert.match(text, /不会自动重试/);
});

test('N-02 世界已切换：必须说明"没有执行只读核对"', () => {
  const text = structureUnknownNotice('stale');
  assert.match(text, /没有执行只读核对/);
  assert.doesNotMatch(text, /已只读刷新/);
  assert.match(text, /不会自动重试/);
});

test('N-03 核对失败：必须说明"核对没有完成"', () => {
  const text = structureUnknownNotice('failed');
  assert.match(text, /只读核对没有完成/);
  assert.doesNotMatch(text, /已只读刷新/);
  assert.match(text, /不会自动重试/);
});

interface CheckHarness {
  runner: ReturnType<typeof createStructureRunner>;
  requests: number;
  notices: string[];
}

function runnerWithCheck(
  check: () => Promise<'applied' | 'stale'> ,
  outcome: StructureChangeOutcome,
): CheckHarness {
  const state = { requests: 0, notices: [] as string[] };
  const host: StructureRunnerHost = {
    rename: async (projectId, sourcePath) => {
      state.requests += 1;
      return outcome;
    },
    move: async (projectId, sourcePath) => {
      state.requests += 1;
      return outcome;
    },
    localBlockers: () => [],
    verifyIntent: () => null,
    checkLocations: check,
    onApplied: () => {},
    onNotice: (message) => void state.notices.push(message),
  };
  return {
    runner: createStructureRunner(host),
    get requests() {
      return state.requests;
    },
    get notices() {
      return state.notices;
    },
  };
}

const UNKNOWN_OUTCOME: StructureChangeOutcome = {
  status: 'UNKNOWN',
  errorCode: 'ERR_OUTCOME_UNKNOWN',
  message: '结果未确认',
  httpStatus: 0,
  projectId: PROJ,
  sourcePath: 'docs/notes.md',
  targetParentDir: 'archive',
  targetName: 'notes.md',
};

const RENAME_INPUT = {
  kind: 'rename' as const,
  projectId: PROJ,
  sourcePath: 'docs/notes.md',
  targetParentDir: '',
  targetName: 'x.md',
  entryKind: 'file' as const,
  intent: intentOf(),
};

test('N-04 UNKNOWN + 核对被闸门作废 → 提示不得声称已刷新，且不重发', async () => {
  const h = runnerWithCheck(async () => 'stale', UNKNOWN_OUTCOME);
  const result = await h.runner.submit(RENAME_INPUT);
  assert.equal(result, 'unknown');
  assert.equal(h.requests, 1, '核对不执行不代表可以重发结构变更');
  assert.match(h.notices.at(-1) ?? '', /没有执行只读核对/);
  assert.doesNotMatch(h.notices.at(-1) ?? '', /已只读刷新/);
});

test('N-05 UNKNOWN + 核对抛错 → 提示说明"核对没有完成"，不重发', async () => {
  const h = runnerWithCheck(async () => {
    throw new Error('offline');
  }, UNKNOWN_OUTCOME);
  const result = await h.runner.submit(RENAME_INPUT);
  assert.equal(result, 'unknown');
  assert.equal(h.requests, 1);
  assert.match(h.notices.at(-1) ?? '', /只读核对没有完成/);
});

test('N-06 UNKNOWN + 核对成功 → 提示"已只读刷新"，Host 的 UNKNOWN 语义不变', async () => {
  const h = runnerWithCheck(async () => 'applied', UNKNOWN_OUTCOME);
  const result = await h.runner.submit(RENAME_INPUT);
  assert.equal(result, 'unknown');
  assert.equal(h.requests, 1);
  assert.match(h.notices.at(-1) ?? '', /已只读刷新源位置与目标位置/);
});

/* ================================================================== */
/* R：目标身份变化后的恢复                                              */
/* ================================================================== */

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
      { id: 'dir-archive', name: 'archive', kind: 'folder', path: 'archive' },
      { id: 'dir-a', name: 'a', kind: 'folder', path: 'a' },
    ]),
    a: levelOf('a', [{ id: 'dir-b', name: 'b', kind: 'folder', path: 'a/b' }]),
  };
}

function refreshHarness(initial: StructureWorld = WORLD): {
  host: StructureRefreshHost;
  loads: string[];
  state: { world: StructureWorld };
} {
  const state = { world: initial };
  const loads: string[] = [];
  const levels = levelsFixture();
  return {
    state,
    loads,
    host: {
      world: () => state.world,
      levels: () => levels,
      invalidateLevel: () => {},
      markStructureChanged: () => {},
      expandFolder: () => {},
      load: async (_projectId, dir) => void loads.push(dir),
      notice: () => {},
    },
  };
}

test('R-01 目标身份被拒后重取**目标所属父层**（顶层目录 → 根层）', async () => {
  const h = refreshHarness();
  const result = await refreshStructureTargetParent({
    start: world(),
    projectId: PROJ,
    targetParentDir: 'archive',
    host: h.host,
  });
  assert.equal(result, 'applied');
  assert.deepEqual(h.loads, [''], '顶层目录的锚在根层，必须重取根层');
});

test('R-02 嵌套目标重取它的父目录层，而不是目标自己那一层', async () => {
  const h = refreshHarness();
  await refreshStructureTargetParent({
    start: world(),
    projectId: PROJ,
    targetParentDir: 'a/b',
    host: h.host,
  });
  assert.deepEqual(h.loads, ['a']);
});

test('R-03 项目根作为目标：重取根层（根锚来自 projectAnchor）', async () => {
  const h = refreshHarness();
  await refreshStructureTargetParent({
    start: world(),
    projectId: PROJ,
    targetParentDir: '',
    host: h.host,
  });
  assert.deepEqual(h.loads, ['']);
});

test('R-04 跨工作区/跨代次 → 不重取（旧世界的结果不得读新工作区的层）', async () => {
  for (const moved of [world({ workspaceKey: 'ws-2' }), world({ epoch: 2 }), world({ mode: 'demo' })]) {
    const h = refreshHarness(moved);
    const result = await refreshStructureTargetParent({
      start: world(),
      projectId: PROJ,
      targetParentDir: 'archive',
      host: h.host,
    });
    assert.equal(result, 'stale');
    assert.deepEqual(h.loads, [], '作废后一个请求都不发');
  }
});

test('R-05 拒绝上报会带出目标父目录（否则调用方只能刷源层）', async () => {
  const seen: Array<{ errorCode: string | null; targetParentDir: string; sessionId: number }> = [];
  const host: StructureRunnerHost = {
    rename: async () => {
      throw new Error('unreachable');
    },
    move: async () => ({
      status: 'REJECTED',
      errorCode: 'ERR_ENTRY_TARGET_CHANGED',
      message: '目标文件夹已被外部替换',
      httpStatus: 409,
    }),
    localBlockers: () => [],
    verifyIntent: () => null,
    checkLocations: async () => 'applied',
    onApplied: () => {},
    onRejected: (outcome, target, intent) =>
      void seen.push({
        errorCode: outcome.errorCode,
        targetParentDir: target.targetParentDir,
        sessionId: intent.sessionId,
      }),
    onNotice: () => {},
  };
  const runner = createStructureRunner(host);
  const result = await runner.submit({
    kind: 'move',
    projectId: PROJ,
    sourcePath: 'docs/notes.md',
    targetParentDir: 'archive',
    targetName: 'notes.md',
    entryKind: 'file',
    intent: intentOf({ sessionId: 9 }),
    targetAnchor: 'b'.repeat(32),
  });
  assert.equal(result, 'rejected');
  assert.deepEqual(seen, [{ errorCode: 'ERR_ENTRY_TARGET_CHANGED', targetParentDir: 'archive', sessionId: 9 }]);
});

/* ================================================================== */
/* S：会话写入守卫                                                      */
/* ================================================================== */

interface SessionState {
  readonly sessionId: number;
  readonly error: string | null;
  readonly submitting: boolean;
}

const stateOf = (sessionId: number, extra: Partial<SessionState> = {}): SessionState => ({
  sessionId,
  error: null,
  submitting: true,
  ...extra,
});

test('S-01 票据相符才执行更新', () => {
  const current = stateOf(7);
  const next = updateSessionIfOwned(current, 7, (state) => state.sessionId, (state) => ({
    ...state,
    error: '对象已变化',
  }));
  assert.equal(next?.error, '对象已变化');
});

test('S-02 旧票据不得改写新会话的错误位', () => {
  const current = stateOf(8);
  const next = updateSessionIfOwned(current, 7, (state) => state.sessionId, (state) => ({
    ...state,
    error: '对象已变化',
  }));
  assert.equal(next, current, '原样返回：一个字段都不许改');
  assert.equal(next?.error, null);
});

test('S-03 旧票据不得关闭新会话（update 返回 null 也不生效）', () => {
  const current = stateOf(8);
  const next = updateSessionIfOwned(current, 7, (state) => state.sessionId, () => null);
  assert.equal(next, current);
});

test('S-04 旧票据不得把新会话的 submitting 改回 false', () => {
  const current = stateOf(8, { submitting: true });
  const next = updateSessionIfOwned(current, 7, (state) => state.sessionId, (state) => ({
    ...state,
    submitting: false,
  }));
  assert.equal(next?.submitting, true);
});

test('S-05 会话已收起（null）时旧结果不能把它复活', () => {
  const next = updateSessionIfOwned<SessionState>(null, 7, (state) => state.sessionId, (state) => ({
    ...state,
    error: '迟到的结果',
  }));
  assert.equal(next, null);
});

test('S-06 移动会话按 intent.sessionId 判定，与行内改名叫法不同但同一张票', () => {
  const moveState = { intent: intentOf({ sessionId: 11 }), submitting: true };
  const stale = updateSessionIfOwned(moveState, 10, (state) => state.intent.sessionId, (state) => ({
    ...state,
    submitting: false,
  }));
  assert.equal(stale, moveState);
  const fresh = updateSessionIfOwned(moveState, 11, (state) => state.intent.sessionId, (state) => ({
    ...state,
    submitting: false,
  }));
  assert.equal(fresh?.submitting, false);
});
