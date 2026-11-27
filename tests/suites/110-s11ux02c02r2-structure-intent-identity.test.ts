/**
 * UX-02C-02-R2：真实改名 / 移动的**资源意图身份闭环**。
 *
 * 基线缺陷（R2 复审）：
 * 1. Shell 打开改名输入行 / 移动对话框时丢掉了那一行的资源锚，提交时只发
 *    `projectId + 相对路径 + 名称`，于是 Host 无从知道"用户当初指的是哪个对象"；
 * 2. Host 收到请求后直接进屏障做磁盘操作，从不读源身份，也从不核验任何锚；
 * 3. Provider 的 `moveEntry` 同样不接收预期身份，rename 前不复核，
 *    外部"删除后重建同名文件"的替换会被当成原对象搬走。
 *
 * 本套件分四段：
 * - S：Shell 意图绑定与提交前核验（纯 TS 编排，零请求也要可断言）；
 * - H：正常路径（5 类，证明加固没有把正常改名打死）；
 * - I：身份变化（8 类，必须明确拒绝且零副作用）；
 * - R：安全回归（11 类，既有授权 / 会话 / 边界语义不变）。
 *
 * 取证口径：真实 Host（托管 Multi Runtime + 真实 LocalProvider + 真实临时磁盘），
 * 断言同时看 HTTP 状态、领域错误码、真实字节 / SHA-256 / inode 与整棵树指纹。
 * 锚一律从真实 `/api/tree` 取——**不复制生产侧的锚派生逻辑**。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
import { createLocalProvider, type StorageProvider } from '../../packages/storage/index.ts';
import { createFakePicker } from '../../apps/server/src/folder-picker/fake-picker.ts';
import { serializeConfig } from '../../apps/server/src/store/config.ts';
import {
  captureStructureIntent,
  structureIntentProblem,
  structureSessionApplies,
} from '../../apps/shell/src/state/structure-intent.ts';
import {
  createStructureRunner,
  type StructureEntryKind,
  type StructureRunResult,
} from '../../apps/shell/src/state/structure-change.ts';
import type { StructureChangeOutcome } from '../../apps/shell/src/client/client-api.ts';
import { identityVerificationOf } from '../../apps/shell/src/state/tree-commands.ts';
import { withSourceAnchor, type StructureBody } from '../helpers/structure-intent.ts';

const PROJ_A = 'project-a';
const PROJ_B = 'project-b';
const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');
const hex32 = (seed: string): string => sha(Buffer.from(seed)).slice(0, 32);

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

/**
 * 整棵树的指纹：相对路径 + 类型 + 大小 + **inode** + 文件内容 SHA-256。
 *
 * 用它断言"零副作用"比逐个 existsSync 强：`ino` 变化能抓出"删除重建"，
 * 内容摘要能抓出覆盖，路径集合能抓出多出来的占位残留。
 */
async function diskState(root: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
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

interface HarnessOptions {
  faults?: Parameters<typeof createLocalProvider>[0]['faults'];
  /** 记录 Provider 的 moveEntry 调用次数：证明绝不自动重发。 */
  onMove?: () => void;
  /**
   * 让 Provider **不具备**身份核验能力（`identityOf` 缺席）。
   *
   * 用来证明"无法确认源身份"时有明确领域结果，而不是静默降级成无锚路径操作。
   */
  withoutIdentity?: boolean;
  /**
   * 用真实 `FileProjectStore`（可读写 `workspace.json`）启动。
   *
   * 元数据 / 隐藏记录需要它；此模式不支持 `withoutIdentity` 与 `onMove`，
   * 因为 Provider 由 Host 自己构造（只能注入故障钩子）。
   */
  fileStore?: boolean;
}

interface Ctx {
  base: string;
  rootA: string;
  rootB: string;
  server: ShellServer;
  runtime: ProjectRuntime;
  token: string;
  api(path: string, init?: RequestInit): Promise<ApiResponse>;
  post(path: string, body: unknown, opts?: { token?: boolean; origin?: boolean }): Promise<ApiResponse>;
  rename(body: Record<string, unknown>, opts?: { token?: boolean; origin?: boolean }): Promise<ApiResponse>;
  move(body: Record<string, unknown>, opts?: { token?: boolean; origin?: boolean }): Promise<ApiResponse>;
  tree(projectId: string, dir?: string): Promise<ApiResponse>;
  /** 带 T1 令牌的只读 GET。 */
  get(path: string): Promise<ApiResponse>;
  /** 从真实 `/api/tree` 取某一行的锚。 */
  anchorOf(projectId: string, path: string): Promise<string>;
  open(projectId: string, path: string): Promise<ApiResponse>;
  disk(projectId?: string): Promise<string>;
}

async function withHost(fn: (ctx: Ctx) => Promise<void>, options: HarnessOptions = {}): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux02c02r2-'));
  const rootA = join(base, 'project-a');
  const rootB = join(base, 'project-b');
  await mkdir(join(rootA, 'docs', 'nested'), { recursive: true });
  await mkdir(join(rootA, 'archive'), { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(rootA, 'a.md'), 'A-CONTENT\n', 'utf8');
  await writeFile(join(rootA, 'twin.md'), 'TWIN-CONTENT\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'notes.md'), 'NOTES-CONTENT\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'nested', 'deep.md'), 'DEEP-CONTENT\n', 'utf8');
  await writeFile(join(rootB, 'b.md'), 'B-CONTENT\n', 'utf8');

  const store = new FakeStore([
    storedProject(PROJ_A, '项目 A', rootA),
    storedProject(PROJ_B, '项目 B', rootB),
  ]);
  const storeDir = join(base, 'store');
  await mkdir(storeDir, { recursive: true });
  let runtimeRef: ProjectRuntime | undefined;
  const factory = (input: { projectId: string; providerId: string; rootDir: string }): StorageProvider => {
    const provider = createLocalProvider({
      rootDir: input.rootDir,
      providerId: input.providerId,
      ...(options.faults ? { faults: options.faults } : {}),
    });
    if (options.withoutIdentity) {
      delete (provider as { identityOf?: unknown }).identityOf;
    }
    if (options.onMove) {
      const original = provider.moveEntry;
      assert.ok(original);
      provider.moveEntry = async (...args) => {
        options.onMove?.();
        return original!(...args);
      };
    }
    return provider;
  };
  if (options.fileStore) {
    // 真实 FileProjectStore：元数据 / 隐藏记录只有它能持久化
    await writeFile(
      join(storeDir, 'workspace.json'),
      serializeConfig({
        version: 4,
        commitSeq: 0,
        issuedIds: [PROJ_A, PROJ_B],
        revoked: [],
        projects: [
          { ...storedProject(PROJ_A, '项目 A', rootA) },
          { ...storedProject(PROJ_B, '项目 B', rootB) },
        ],
        hidden: [],
        trash: [],
      }),
      'utf8',
    );
  }
  const build = (): Promise<ShellServer> =>
    options.fileStore
      ? createShellServer({
          port: 0,
          managedStore: {
            dir: storeDir,
            picker: createFakePicker([]),
          },
          ...(options.faults ? { managedProviderFaults: options.faults } : {}),
        })
      : createShellServer({
          port: 0,
          managed: {
            create: (deps) => {
              const runtime = createProjectRuntime({
                ...deps,
                store,
                grantSource: 'os-dialog',
                allowEphemeralRevocation: true,
                providerFactory: factory,
              });
              runtimeRef = runtime;
              return runtime;
            },
          },
        });

  let server = await build();
  const api = async (path: string, init?: RequestInit): Promise<ApiResponse> => {
    const res = await fetch(`${server.url}${path}`, init);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  };
  const tokenRes = await api('/api/session-token');
  const token = (tokenRes.body as { token?: string }).token ?? '';
  assert.notEqual(token, '', '夹具必须拿到 T1 令牌');
  const post = (
    path: string,
    body: unknown,
    opts: { token?: boolean; origin?: boolean } = {},
  ): Promise<ApiResponse> =>
    api(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.token === false ? {} : { 'x-ws-token': token }),
        ...(opts.origin === false ? {} : { origin: new URL(server.url).origin }),
      },
      body: JSON.stringify(body),
    });

  const tree = (projectId: string, dir = ''): Promise<ApiResponse> =>
    api(`/api/tree?projectId=${encodeURIComponent(projectId)}${dir ? `&dir=${encodeURIComponent(dir)}` : ''}`);
  const get = (path: string): Promise<ApiResponse> => api(path, { headers: { 'x-ws-token': token } });

  const anchorOf = async (projectId: string, path: string): Promise<string> => {
    const slash = path.lastIndexOf('/');
    const dir = slash >= 0 ? path.slice(0, slash) : '';
    const page = await tree(projectId, dir);
    assert.equal(page.status, 200, `取锚失败: ${JSON.stringify(page.body)}`);
    const anchors = (page.body.anchors ?? {}) as Record<string, string>;
    const anchor = anchors[path];
    assert.equal(typeof anchor, 'string', `夹具取不到 ${path} 的锚（真实 tree 未给）`);
    return anchor;
  };

  const ctx: Ctx = {
    base,
    rootA,
    rootB,
    get server() {
      return server;
    },
    get runtime() {
      assert.ok(runtimeRef);
      return runtimeRef as ProjectRuntime;
    },
    token,
    api,
    post,
    tree,
    get,
    anchorOf,
    rename: (body, opts) => post('/api/files/rename', body, opts),
    move: async (body, opts) =>
      post('/api/files/move', await withSourceAnchor(body as unknown as StructureBody, tree), opts),
    open: (projectId, path) => post('/api/open', { projectId, path }),
    disk: (projectId = PROJ_A) => diskState(projectId === PROJ_A ? rootA : rootB),
  };
  try {
    await fn(ctx);
  } finally {
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true });
  }
}

/* ================================================================== */
/* S：Shell 意图绑定与提交前核验                                        */
/* ================================================================== */

const INTENT_INPUT = {
  projectId: PROJ_A,
  sourcePath: 'docs/notes.md',
  entryKind: 'file' as StructureEntryKind,
};

/** S 段的世界票据（R2.1）：意图必须记住它在哪个世界打开。 */
const TEST_WORLD = {
  mode: 'live',
  workspaceMode: 'multi',
  workspaceKey: 'ws-1',
  epoch: 1,
} as const;

test('S-01 捕获意图：有锚且已核验 → 成功，锚与票据被原样保存', () => {
  const captured = captureStructureIntent({
    ...INTENT_INPUT,
    anchor: hex32('notes'),
    verification: 'verified',
    world: TEST_WORLD,
    sessionId: 7,
  });
  assert.equal(captured.ok, true);
  assert.ok(captured.ok);
  assert.equal(captured.intent.anchor, hex32('notes'));
  assert.equal(captured.intent.sessionId, 7);
  assert.equal(captured.intent.projectId, PROJ_A);
  assert.equal(captured.intent.sourcePath, 'docs/notes.md');
  // 冻结：输入期间的任何界面变动都改不到这份预期
  assert.equal(Object.isFrozen(captured.intent), true);
});

test('S-02 捕获意图：没有锚且身份未确认 → 拒绝（不得按路径身份继续）', () => {
  const captured = captureStructureIntent({
    ...INTENT_INPUT,
    anchor: null,
    verification: 'unverified',
    world: TEST_WORLD,
    sessionId: 1,
  });
  assert.equal(captured.ok, false);
  assert.ok(!captured.ok);
  assert.match(captured.reason, /无法确认/);
});

test('S-03 捕获意图：Provider 声明无身份能力 → 同样拒绝，不降级成路径操作', () => {
  const captured = captureStructureIntent({
    ...INTENT_INPUT,
    anchor: null,
    verification: 'unsupported',
    world: TEST_WORLD,
    sessionId: 1,
  });
  assert.equal(captured.ok, false);
  assert.ok(!captured.ok);
  assert.match(captured.reason, /身份/);
});

test('S-04 提交前：当前锚与捕获锚一致 → 放行', () => {
  const anchor = hex32('notes');
  const captured = captureStructureIntent({
    ...INTENT_INPUT,
    anchor,
    verification: 'verified',
    world: TEST_WORLD,
    sessionId: 1,
  });
  assert.ok(captured.ok);
  assert.equal(
    structureIntentProblem({
      intent: captured.intent,
      current: { anchor, verification: 'verified' },
    }),
    null,
  );
});

test('S-05 提交前：同路径换成新对象（锚变了）→ 对象已变化', () => {
  const captured = captureStructureIntent({
    ...INTENT_INPUT,
    anchor: hex32('notes'),
    verification: 'verified',
    world: TEST_WORLD,
    sessionId: 1,
  });
  assert.ok(captured.ok);
  const problem = structureIntentProblem({
    intent: captured.intent,
    current: { anchor: hex32('rebuilt'), verification: 'verified' },
  });
  assert.ok(problem);
  assert.match(problem, /对象已经变化/);
});

test('S-06 提交前：当前探测失败（unverified）→ 无法确认，不当成对象一致', () => {
  const anchor = hex32('notes');
  const captured = captureStructureIntent({
    ...INTENT_INPUT,
    anchor,
    verification: 'verified',
    world: TEST_WORLD,
    sessionId: 1,
  });
  assert.ok(captured.ok);
  const problem = structureIntentProblem({
    intent: captured.intent,
    current: { anchor: null, verification: 'unverified' },
  });
  assert.ok(problem);
  assert.match(problem, /无法确认/);
});

test('S-07 提交前：当前声明改口（unsupported）→ 身份状态已变化', () => {
  const anchor = hex32('notes');
  const captured = captureStructureIntent({
    ...INTENT_INPUT,
    anchor,
    verification: 'verified',
    world: TEST_WORLD,
    sessionId: 1,
  });
  assert.ok(captured.ok);
  const problem = structureIntentProblem({
    intent: captured.intent,
    current: { anchor: null, verification: 'unsupported' },
  });
  assert.ok(problem);
  assert.match(problem, /身份状态已经变化/);
});

test('S-08 提交前：声明 supported 但已探不到对象 → 对象已变化', () => {
  const captured = captureStructureIntent({
    ...INTENT_INPUT,
    anchor: hex32('notes'),
    verification: 'verified',
    world: TEST_WORLD,
    sessionId: 1,
  });
  assert.ok(captured.ok);
  const problem = structureIntentProblem({
    intent: captured.intent,
    current: { anchor: null, verification: 'verified' },
  });
  assert.ok(problem);
  assert.match(problem, /对象已经变化/);
});

test('S-09 会话票据：结果回来时票据已换 → 不得写进新会话', () => {
  assert.equal(structureSessionApplies({ sessionId: 3, currentSessionId: 3 }), true);
  assert.equal(structureSessionApplies({ sessionId: 3, currentSessionId: 4 }), false);
  // 输入行已被收起（null）：旧结果同样不得把它重新打开
  assert.equal(structureSessionApplies({ sessionId: 3, currentSessionId: null }), false);
});

test('S-10 输入期间改草稿不改变捕获的锚（预期不可自动刷新）', () => {
  const anchor = hex32('notes');
  const captured = captureStructureIntent({
    ...INTENT_INPUT,
    anchor,
    verification: 'verified',
    world: TEST_WORLD,
    sessionId: 1,
  });
  assert.ok(captured.ok);
  const draft = { value: 'notes.md' };
  for (const next of ['n.md', 'n', 'notes2.md']) {
    draft.value = next;
    assert.equal(
      structureIntentProblem({
        intent: captured.intent,
        current: { anchor, verification: 'verified' },
      }),
      null,
      '草稿变化不能影响提交前的身份核验',
    );
    assert.equal(captured.intent.anchor, anchor, '锚必须保持打开意图时的那一个');
  }
});

/* ---------------------- 编排：提交时带锚、拒绝时零请求 ---------------------- */

interface RunnerProbe {
  renames: Array<{ projectId: string; sourcePath: string; name: string; sourceAnchor: string }>;
  moves: Array<{
    projectId: string;
    sourcePath: string;
    targetParentDir: string;
    name: string;
    sourceAnchor: string;
    targetAnchor: string;
  }>;
  applied: number;
  notices: string[];
}

function makeRunner(options: {
  verify?: (intent: {
    projectId: string;
    sourcePath: string;
    entryKind: StructureEntryKind;
  }) => string | null;
  outcome?: (input: { kind: 'rename' | 'move' }) => StructureChangeOutcome;
} = {}): { runner: ReturnType<typeof createStructureRunner>; probe: RunnerProbe } {
  const probe: RunnerProbe = { renames: [], moves: [], applied: 0, notices: [] };
  const runner = createStructureRunner({
    rename: async (projectId, sourcePath, name, sourceAnchor) => {
      probe.renames.push({ projectId, sourcePath, name, sourceAnchor });
      return (
        options.outcome?.({ kind: 'rename' }) ?? {
          status: 'APPLIED',
          projectId,
          sourcePath,
          targetPath: `docs/${name}`,
          targetParentDir: 'docs',
          targetName: name,
          entryKind: 'file',
          contentSha256: null,
        }
      );
    },
    move: async (projectId, sourcePath, targetParentDir, name, sourceAnchor, targetAnchor) => {
      probe.moves.push({ projectId, sourcePath, targetParentDir, name, sourceAnchor, targetAnchor });
      return (
        options.outcome?.({ kind: 'move' }) ?? {
          status: 'APPLIED',
          projectId,
          sourcePath,
          targetPath: name,
          targetParentDir,
          targetName: name,
          entryKind: 'file',
          contentSha256: null,
        }
      );
    },
    localBlockers: () => [],
    verifyIntent: (input) => (options.verify ? options.verify(input.intent) : null),
    checkLocations: async () => {},
    onApplied: () => {
      probe.applied += 1;
    },
    onNotice: (message) => {
      probe.notices.push(message);
    },
  });
  return { runner, probe };
}

const RENAME_INPUT = {
  kind: 'rename' as const,
  projectId: PROJ_A,
  sourcePath: 'docs/notes.md',
  targetParentDir: 'docs',
  targetName: 'n.md',
  entryKind: 'file' as StructureEntryKind,
  intent: {
    projectId: PROJ_A,
    sourcePath: 'docs/notes.md',
    entryKind: 'file' as StructureEntryKind,
    anchor: hex32('notes'),
    verification: 'verified' as const,
    world: TEST_WORLD,
    sessionId: 1,
  },
  sessionId: 1,
};

test('S-11 提交时没有锚 → 本地拒绝，一个请求都不发', async () => {
  const { runner, probe } = makeRunner();
  const result: StructureRunResult = await runner.submit({
    ...RENAME_INPUT,
    intent: { ...RENAME_INPUT.intent, anchor: '' },
  });
  assert.equal(result, 'rejected');
  assert.equal(probe.renames.length, 0, '缺少身份预期时不得发出请求');
  assert.equal(probe.moves.length, 0);
  assert.match(probe.notices.join('\n'), /身份|刷新/);
});

test('S-12 提交前核验不通过 → 本地拒绝，一个请求都不发', async () => {
  const { runner, probe } = makeRunner({
    verify: () => '这一行对应的对象已经变化，操作没有执行',
  });
  const result = await runner.submit(RENAME_INPUT);
  assert.equal(result, 'rejected');
  assert.equal(probe.renames.length, 0);
  assert.match(probe.notices.join('\n'), /对象已经变化/);
});

test('S-13 正常提交：发出的请求带着同一个锚，成功才 onApplied', async () => {
  const { runner, probe } = makeRunner();
  const result = await runner.submit(RENAME_INPUT);
  assert.equal(result, 'applied');
  assert.equal(probe.renames.length, 1);
  assert.equal(probe.renames[0]!.sourceAnchor, RENAME_INPUT.intent.anchor, '必须把捕获的锚原样发出');
  assert.equal(probe.renames[0]!.sourcePath, 'docs/notes.md');
  assert.equal(probe.applied, 1);
});

test('S-14 Host 拒绝（源已变化）：保留输入、只发一次、不自动重发', async () => {
  const { runner, probe } = makeRunner({
    outcome: () => ({
      status: 'REJECTED',
      errorCode: 'ERR_ENTRY_SOURCE_CHANGED',
      message: '该路径上的文件已被外部替换，未执行任何移动',
      httpStatus: 409,
    }),
  });
  const result = await runner.submit(RENAME_INPUT);
  assert.equal(result, 'rejected');
  assert.equal(probe.renames.length, 1, '绝不自动重发');
  assert.equal(probe.applied, 0);
  assert.match(probe.notices.join('\n'), /已被外部替换/);
});

test('S-15 移动提交同样带锚；verifySource 拿到的是源项目与源路径', async () => {
  const seen: Array<{ projectId: string; sourcePath: string }> = [];
  const { runner, probe } = makeRunner({
    verify: (intent) => {
      seen.push({ projectId: intent.projectId, sourcePath: intent.sourcePath });
      return null;
    },
  });
  const result = await runner.submit({
    ...RENAME_INPUT,
    kind: 'move',
    targetParentDir: 'archive',
    targetAnchor: hex32('archive'),
  });
  assert.equal(result, 'applied');
  assert.equal(probe.moves.length, 1);
  assert.equal(probe.moves[0]!.sourceAnchor, RENAME_INPUT.intent.anchor);
  assert.equal(probe.moves[0]!.targetAnchor, hex32('archive'));
  assert.deepEqual(
    seen.map((item) => [item.projectId, item.sourcePath]),
    [[PROJ_A, 'docs/notes.md']],
  );
});

/* ================================================================== */
/* H：正常路径（加固不得误伤）                                          */
/* ================================================================== */

test('H-01 文件改名：200 APPLIED，路径变化但内容与 inode 都不变（同一个对象搬家）', async () => {
  await withHost(async (h) => {
    const before = await lstat(join(h.rootA, 'docs', 'notes.md'));
    const shaBefore = sha(await readFile(join(h.rootA, 'docs', 'notes.md')));
    const anchor = await h.anchorOf(PROJ_A, 'docs/notes.md');
    const res = await h.rename({ projectId: PROJ_A, sourcePath: 'docs/notes.md', name: '数学笔记.md', sourceAnchor: anchor });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'APPLIED');
    assert.equal(existsSync(join(h.rootA, 'docs', 'notes.md')), false);
    const after = await lstat(join(h.rootA, 'docs', '数学笔记.md'));
    assert.equal(sha(await readFile(join(h.rootA, 'docs', '数学笔记.md'))), shaBefore);
    assert.equal(String(after.ino), String(before.ino), '改名不该换 inode');
    assert.equal(res.body.contentSha256, shaBefore);
  });
});

test('H-02 目录改名：后代路径跟着走，内容不变，锚校验不误伤', async () => {
  await withHost(async (h) => {
    const deepBefore = sha(await readFile(join(h.rootA, 'docs', 'nested', 'deep.md')));
    const anchor = await h.anchorOf(PROJ_A, 'docs');
    const res = await h.rename({ projectId: PROJ_A, sourcePath: 'docs', name: '文档', sourceAnchor: anchor });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(existsSync(join(h.rootA, 'docs')), false);
    assert.equal(sha(await readFile(join(h.rootA, '文档', 'nested', 'deep.md'))), deepBefore);
  });
});

test('H-03 大小写仅变化：带锚照样通过，磁盘上只留一个目录项', async () => {
  await withHost(async (h) => {
    const anchor = await h.anchorOf(PROJ_A, 'a.md');
    const res = await h.rename({ projectId: PROJ_A, sourcePath: 'a.md', name: 'A.md', sourceAnchor: anchor });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const names = await readdir(h.rootA);
    const matched = names.filter((name) => name.toLowerCase() === 'a.md');
    assert.equal(matched.length, 1, `大小写仅变化后应只有一个目录项: ${names.join(',')}`);
    assert.equal(await readFile(join(h.rootA, 'A.md'), 'utf8'), 'A-CONTENT\n');
  });
});

test('H-04 文件移动：源消失、目标出现、字节一致', async () => {
  await withHost(async (h) => {
    const shaBefore = sha(await readFile(join(h.rootA, 'docs', 'notes.md')));
    const anchor = await h.anchorOf(PROJ_A, 'docs/notes.md');
    const res = await h.move({
      projectId: PROJ_A,
      sourcePath: 'docs/notes.md',
      targetParentDir: 'archive',
      name: 'notes.md',
      sourceAnchor: anchor,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(existsSync(join(h.rootA, 'docs', 'notes.md')), false);
    assert.equal(sha(await readFile(join(h.rootA, 'archive', 'notes.md'))), shaBefore);
  });
});

test('H-05 标注随改名迁移到新路径，旧路径不再有它的记录', async () => {
  await withHost(async (h) => {
    const anchor = await h.anchorOf(PROJ_A, 'docs/notes.md');
    const set = await h.post('/api/metadata/set', {
      projectId: PROJ_A,
      path: 'docs/notes.md',
      alias: '数学笔记',
      anchor,
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const res = await h.rename({ projectId: PROJ_A, sourcePath: 'docs/notes.md', name: 'math.md', sourceAnchor: anchor });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.metadataMigration, 'moved');
    const page = await h.tree(PROJ_A, 'docs');
    const entry = (page.body.entries as Array<{ name: string; meta?: { alias?: string } }>).find(
      (item) => item.name === 'math.md',
    );
    assert.equal(entry?.meta?.alias, '数学笔记');
    const list = await h.get(`/api/metadata?projectId=${encodeURIComponent(PROJ_A)}`);
    const paths = (list.body.entries as Array<{ path: string }>).map((record) => record.path);
    assert.equal(paths.includes('docs/notes.md'), false, '旧路径的记录必须迁走');
  }, { fileStore: true });
});

/* ================================================================== */
/* M：元数据与隐藏记录不得跟着"换了个对象"而继承（B5）                  */
/* ================================================================== */

test('M-01 隐藏记录：隐藏前的锚仍可改名，旧记录变 missing 且不跟到新路径', async () => {
  await withHost(async (h) => {
    // 隐藏行不再出现在 `/api/tree` 里，锚只能来自隐藏前那一页——真实时序正是如此。
    const anchor = await h.anchorOf(PROJ_A, 'docs/notes.md');
    const hide = await h.post('/api/workspace/hide', { projectId: PROJ_A, path: 'docs/notes.md' });
    assert.equal(hide.status, 200, JSON.stringify(hide.body));
    const before = await h.get(`/api/workspace/hidden?projectId=${encodeURIComponent(PROJ_A)}`);
    assert.deepEqual(
      (before.body.entries as Array<{ path: string; state: string }>).map((e) => [e.path, e.state]),
      [['docs/notes.md', 'active']],
      '隐藏记录此刻对应的仍是那个真实对象',
    );

    const res = await h.rename({
      projectId: PROJ_A,
      sourcePath: 'docs/notes.md',
      name: 'math.md',
      sourceAnchor: anchor,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const after = await h.get(`/api/workspace/hidden?projectId=${encodeURIComponent(PROJ_A)}`);
    assert.deepEqual(
      (after.body.entries as Array<{ path: string; state: string }>).map((e) => [e.path, e.state]),
      [['docs/notes.md', 'missing']],
      '记录仍挂在旧路径上并如实标为 missing，绝不改写路径跟到新对象',
    );
    const page = await h.tree(PROJ_A, 'docs');
    const names = (page.body.entries as Array<{ name: string }>).map((e) => e.name);
    assert.ok(names.includes('math.md'), '改名后的新对象必须是可见的（旧记录只作用于旧路径）');
    assert.equal(names.includes('notes.md'), false);
    assert.equal(existsSync(join(h.rootA, 'docs', 'math.md')), true);
    assert.equal(existsSync(join(h.rootA, 'docs', 'notes.md')), false);
  }, { fileStore: true });
});

test('M-02 对象已被外部替换：改名被拒后，旧标注既不迁移也不继承到新对象', async () => {
  await withHost(async (h) => {
    const oldAnchor = await h.anchorOf(PROJ_A, 'a.md');
    const set = await h.post('/api/metadata/set', {
      projectId: PROJ_A,
      path: 'a.md',
      alias: '旧对象的标注',
      anchor: oldAnchor,
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));

    // 外部删除并重建同名文件：同一个路径，另一个对象
    rmSync(join(h.rootA, 'a.md'));
    writeFileSync(join(h.rootA, 'a.md'), 'BRAND-NEW-OBJECT\n', 'utf8');
    const beforeDisk = await h.disk();

    const res = await h.rename({
      projectId: PROJ_A,
      sourcePath: 'a.md',
      name: 'renamed.md',
      sourceAnchor: oldAnchor,
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_ENTRY_SOURCE_CHANGED');

    // 零副作用：路径与字节都不变，目标不存在
    assert.equal(await h.disk(), beforeDisk);
    assert.equal(readFileSync(join(h.rootA, 'a.md'), 'utf8'), 'BRAND-NEW-OBJECT\n');
    assert.equal(existsSync(join(h.rootA, 'renamed.md')), false);

    // 旧标注留在原路径并如实标为 rebound；新对象不得带着别人的标注出现
    const list = await h.get(`/api/metadata?projectId=${encodeURIComponent(PROJ_A)}`);
    const records = list.body.entries as Array<{ path: string; state: string; alias?: string }>;
    assert.deepEqual(
      records.map((r) => [r.path, r.state]),
      [['a.md', 'rebound']],
      '记录不得被迁移到目标路径，也不能被静默删掉',
    );
    const page = await h.tree(PROJ_A);
    const entry = (page.body.entries as Array<{ name: string; meta?: { alias?: string } }>).find(
      (item) => item.name === 'a.md',
    );
    assert.equal(entry?.meta, undefined, '换了个对象之后，旧标注不得继续显示');
  }, { fileStore: true });
});

/* ================================================================== */
/* I：身份变化（明确拒绝 + 零副作用）                                   */
/* ================================================================== */

test('I-01 缺少 sourceAnchor（未提供或空串）：400 ERR_STRUCTURE_INTENT_MISSING，磁盘零变更', async () => {
  await withHost(async (h) => {
    const before = await h.disk();
    for (const body of [
      { projectId: PROJ_A, sourcePath: 'docs/notes.md', name: 'x.md' },
      { projectId: PROJ_A, sourcePath: 'docs/notes.md', name: 'x.md', sourceAnchor: '' },
      { projectId: PROJ_A, sourcePath: 'docs/notes.md', name: 'x.md', sourceAnchor: '   ' },
    ]) {
      const res = await h.rename(body);
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.errorCode, 'ERR_STRUCTURE_INTENT_MISSING', JSON.stringify(body));
    }
    assert.equal(await h.disk(), before, '缺锚必须零副作用');
  });
});

test('I-02 锚形状非法（长度 / 大写 / 非 hex）：400 ERR_COMMAND_INVALID，零副作用', async () => {
  await withHost(async (h) => {
    const before = await h.disk();
    for (const sourceAnchor of ['a'.repeat(31), 'A'.repeat(32), 'z'.repeat(32), 'a'.repeat(33), 'a'.repeat(31) + '-']) {
      const res = await h.rename({ projectId: PROJ_A, sourcePath: 'docs/notes.md', name: 'x.md', sourceAnchor });
      assert.equal(res.status, 400, `${sourceAnchor} 应被拒绝: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.errorCode, 'ERR_COMMAND_INVALID', `形状非法: ${sourceAnchor}`);
    }
    assert.equal(await h.disk(), before);
  });
});

test('I-03 锚属于另一个文件：409 ERR_ENTRY_SOURCE_CHANGED，零副作用', async () => {
  await withHost(async (h) => {
    const before = await h.disk();
    const twinAnchor = await h.anchorOf(PROJ_A, 'twin.md');
    const res = await h.rename({ projectId: PROJ_A, sourcePath: 'docs/notes.md', name: 'x.md', sourceAnchor: twinAnchor });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_ENTRY_SOURCE_CHANGED');
    assert.equal(await h.disk(), before);
    assert.equal(existsSync(join(h.rootA, 'docs', 'x.md')), false);
  });
});

test('I-04 外部删除重建同名文件：旧锚失效 → 拒绝，新对象原位且内容不变', async () => {
  await withHost(async (h) => {
    const staleAnchor = await h.anchorOf(PROJ_A, 'docs/notes.md');
    const inoBefore = String((await lstat(join(h.rootA, 'docs', 'notes.md'))).ino);
    // 外部：删掉再建一个新的同名文件（内容完全不同）
    await rm(join(h.rootA, 'docs', 'notes.md'));
    await writeFile(join(h.rootA, 'docs', 'notes.md'), 'EXTERNAL-REBUILD\n', 'utf8');
    const inoAfter = String((await lstat(join(h.rootA, 'docs', 'notes.md'))).ino);
    assert.notEqual(inoAfter, inoBefore, '夹具必须真的换了对象');

    const res = await h.rename({ projectId: PROJ_A, sourcePath: 'docs/notes.md', name: 'x.md', sourceAnchor: staleAnchor });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_ENTRY_SOURCE_CHANGED');
    assert.equal(await readFile(join(h.rootA, 'docs', 'notes.md'), 'utf8'), 'EXTERNAL-REBUILD\n');
    assert.equal(existsSync(join(h.rootA, 'docs', 'x.md')), false, '目标路径不得被创建');
  });
});

test('I-05 源已被删除：404 ERR_RESOURCE_NOT_FOUND，不创建目标', async () => {
  await withHost(async (h) => {
    const anchor = await h.anchorOf(PROJ_A, 'docs/notes.md');
    await rm(join(h.rootA, 'docs', 'notes.md'));
    const res = await h.rename({ projectId: PROJ_A, sourcePath: 'docs/notes.md', name: 'x.md', sourceAnchor: anchor });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_RESOURCE_NOT_FOUND');
    assert.equal(existsSync(join(h.rootA, 'docs', 'x.md')), false);
  });
});

test('I-06 Provider 无身份能力：409 ERR_ENTRY_IDENTITY_UNVERIFIED，绝不降级为无锚操作', async () => {
  await withHost(
    async (h) => {
      const before = await h.disk();
      const res = await h.rename({
        projectId: PROJ_A,
        sourcePath: 'docs/notes.md',
        name: 'x.md',
        sourceAnchor: hex32('anything'),
      });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.errorCode, 'ERR_ENTRY_IDENTITY_UNVERIFIED');
      assert.equal(await h.disk(), before, '无法核验身份时不得有任何磁盘副作用');
    },
    { withoutIdentity: true },
  );
});

test('I-07 占位建立后源被外部替换：rename 前复核拦下，占位清理干净', async () => {
  let sourceAbs = '';
  let targetAbs = '';
  await withHost(
    async (h) => {
      sourceAbs = join(h.rootA, 'docs', 'notes.md');
      targetAbs = join(h.rootA, 'docs', 'moved.md');
      const anchor = await h.anchorOf(PROJ_A, 'docs/notes.md');
      const res = await h.move({
        projectId: PROJ_A,
        sourcePath: 'docs/notes.md',
        targetParentDir: 'docs',
        name: 'moved.md',
        sourceAnchor: anchor,
      });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.errorCode, 'ERR_ENTRY_SOURCE_CHANGED');
      // 被换上的新对象必须原地不动
      assert.equal(await readFile(sourceAbs, 'utf8'), 'RACED-REPLACEMENT\n');
      assert.equal(existsSync(targetAbs), false, '占位必须被清理（零残留）');
    },
    {
      faults: {
        // 模拟"身份复核通过之后、rename 之前"源被外部替换（同步落盘，顺序确定）
        beforeMoveRename: () => {
          rmSync(sourceAbs, { force: true });
          writeFileSync(sourceAbs, 'RACED-REPLACEMENT\n');
        },
      },
    },
  );
});

test('I-08 占位建立后源被删除：404，占位清理干净（不残留 0 字节文件）', async () => {
  let sourceAbs = '';
  await withHost(
    async (h) => {
      sourceAbs = join(h.rootA, 'docs', 'notes.md');
      const anchor = await h.anchorOf(PROJ_A, 'docs/notes.md');
      const res = await h.move({
        projectId: PROJ_A,
        sourcePath: 'docs/notes.md',
        targetParentDir: 'archive',
        name: 'notes.md',
        sourceAnchor: anchor,
      });
      assert.equal(res.status, 404, JSON.stringify(res.body));
      assert.equal(existsSync(join(h.rootA, 'archive', 'notes.md')), false);
      assert.equal(existsSync(sourceAbs), false);
    },
    { faults: { afterMoveReserve: () => rmSync(sourceAbs, { force: true }) } },
  );
});

test('I-09 大小写仅变化也必须核验源身份：锚不符时照样拒绝', async () => {
  await withHost(async (h) => {
    const before = await h.disk();
    const twinAnchor = await h.anchorOf(PROJ_A, 'twin.md');
    const res = await h.rename({ projectId: PROJ_A, sourcePath: 'a.md', name: 'A.md', sourceAnchor: twinAnchor });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_ENTRY_SOURCE_CHANGED');
    assert.equal(await h.disk(), before);
  });
});

/* ================================================================== */
/* R：安全回归（既有语义不变）                                          */
/* ================================================================== */

test('I-10 绕开 Host 直接调 Provider：预期身份不符也拒绝（分层不互相顶替）', async () => {
  // 占位次数是"第一处核对发生在任何副作用之前"的可观测点：
  // 身份不符时连排他占位都不该建立（事后清理干净 ≠ 从未建立）。
  let reservations = 0;
  await withHost(
    async (h) => {
      const provider = h.runtime.providerOf(`local:${PROJ_A}`);
      assert.ok(provider, '夹具必须拿到 A 的 Provider');
      assert.equal(typeof provider!.moveEntry, 'function');
      // 先取出方法本身：可选方法不能直接以 `provider!.moveEntry(...)` 调用（TS 要求先判空）
      const moveEntry = provider!.moveEntry!.bind(provider);
      const identityOf = provider!.identityOf!.bind(provider);
      const before = await h.disk();

      // 形状合法但内容不对的预期：Provider 自己就要拒，不能指望 Host 已经查过
      const wrong = await moveEntry('docs/notes.md', 'docs', 'x.md', 'deadbeef'.repeat(4));
      assert.equal(wrong.status, 'REJECTED', JSON.stringify(wrong));
      assert.equal(wrong.status === 'REJECTED' ? wrong.errorCode : '', 'ERR_ENTRY_SOURCE_CHANGED');
      assert.equal(await h.disk(), before, '身份不符时零副作用');
      assert.equal(reservations, 0, '身份不符必须挡在排他占位之前（零副作用，不只是清理干净）');

      // 预期为空 / 未提供同样不得降级成"按路径移动"
      for (const empty of ['', '   ']) {
        const res = await moveEntry('docs/notes.md', 'docs', 'x.md', empty);
        assert.equal(res.status, 'REJECTED', `空预期必须拒绝: ${JSON.stringify(res)}`);
        assert.equal(res.status === 'REJECTED' ? res.errorCode : '', 'ERR_ENTRY_IDENTITY_UNVERIFIED');
      }
      assert.equal(await h.disk(), before);
      assert.equal(reservations, 0, '空预期同样不建立占位');

      // 真实身份（Host 用的同一套 dev:ino）传入时才允许移动
      const identity = await identityOf('docs/notes.md');
      assert.equal(typeof identity, 'string');
      const ok = await moveEntry('docs/notes.md', 'docs', 'moved.md', identity!);
      assert.equal(ok.status, 'MOVED', JSON.stringify(ok));
      assert.equal(existsSync(join(h.rootA, 'docs', 'moved.md')), true);
      assert.equal(reservations, 1, '只有真正动手时才占位一次');
    },
    { faults: { afterMoveReserve: () => void (reservations += 1) } },
  );
});

test('R-01 有活动编辑 View：409 ERR_STRUCTURE_SESSION_BUSY，零磁盘变更', async () => {
  await withHost(async (h) => {
    const opened = await h.open(PROJ_A, 'docs/notes.md');
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const before = await h.disk();
    const anchor = await h.anchorOf(PROJ_A, 'docs/notes.md');
    const res = await h.rename({ projectId: PROJ_A, sourcePath: 'docs/notes.md', name: 'x.md', sourceAnchor: anchor });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_STRUCTURE_SESSION_BUSY');
    assert.ok(Array.isArray(res.body.blockedBy) && res.body.blockedBy.includes('ACTIVE_VIEWS'));
    assert.equal(await h.disk(), before);
  });
});

test('R-02 跨项目：用 B 的 projectId 改 A 的相对路径，两个项目都零副作用', async () => {
  await withHost(async (h) => {
    const beforeA = await h.disk(PROJ_A);
    const beforeB = await h.disk(PROJ_B);
    // 拿 A 里真实存在的 a.md 的锚，但把项目指到 B：路径在 B 里不存在
    const anchor = await h.anchorOf(PROJ_A, 'a.md');
    const res = await h.rename({ projectId: PROJ_B, sourcePath: 'a.md', name: 'x.md', sourceAnchor: anchor });
    assert.ok(res.status >= 400, JSON.stringify(res.body));
    assert.equal(await h.disk(PROJ_A), beforeA);
    assert.equal(await h.disk(PROJ_B), beforeB);
  });
});

test('R-03 保留命名空间（回收区）：403 ERR_PATH_RESERVED，零副作用', async () => {
  await withHost(async (h) => {
    const before = await h.disk();
    const res = await h.rename({
      projectId: PROJ_A,
      sourcePath: '.weavespace/trash/payload',
      name: 'leak.md',
      sourceAnchor: hex32('trash'),
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_PATH_RESERVED');
    assert.equal(await h.disk(), before);
  });
});

test('R-04 客户端自述路径 / 根令牌 / 身份一律不被采信', async () => {
  await withHost(async (h) => {
    const before = await h.disk();
    const anchor = await h.anchorOf(PROJ_A, 'docs/notes.md');
    for (const extra of [{ absolutePath: 'C:/evil' }, { rootToken: 'x' }]) {
      const res = await h.move({
        projectId: PROJ_A,
        sourcePath: 'docs/notes.md',
        targetParentDir: 'archive',
        name: 'x.md',
        sourceAnchor: anchor,
        ...extra,
      });
      assert.equal(res.status, 400, `${JSON.stringify(extra)} 应被拒绝: ${JSON.stringify(res.body)}`);
    }
    // providerId 在更早的全局守卫就被拒（不是结构变更自己的禁字段），同样是拒绝
    const providerClaim = await h.move({
      projectId: PROJ_A,
      sourcePath: 'docs/notes.md',
      targetParentDir: 'archive',
      name: 'x.md',
      sourceAnchor: anchor,
      providerId: 'local:project-b',
    });
    assert.ok(providerClaim.status >= 400, JSON.stringify(providerClaim.body));
    /**
     * 关键一条：客户端**自报身份**不能替代锚核验。
     * 这里带着错误的锚 + 一个"看起来对"的 expectedIdentity，仍然必须被拒——
     * 身份只能由 Host 自己读，客户端给的东西最多是前置条件。
     */
    const selfClaim = await h.move({
      projectId: PROJ_A,
      sourcePath: 'docs/notes.md',
      targetParentDir: 'archive',
      name: 'x.md',
      sourceAnchor: hex32('forged'),
      expectedIdentity: '1:2',
    });
    assert.equal(selfClaim.status, 409, JSON.stringify(selfClaim.body));
    assert.equal(selfClaim.body.errorCode, 'ERR_ENTRY_SOURCE_CHANGED');
    assert.equal(await h.disk(), before);
  });
});

test('R-05 改名端点不得被当成移动端点：400', async () => {
  await withHost(async (h) => {
    const before = await h.disk();
    const anchor = await h.anchorOf(PROJ_A, 'docs/notes.md');
    const res = await h.rename({
      projectId: PROJ_A,
      sourcePath: 'docs/notes.md',
      name: 'x.md',
      targetParentDir: 'archive',
      sourceAnchor: anchor,
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(await h.disk(), before);
  });
});

test('R-06 目标已存在：409 ERR_ENTRY_EXISTS，源与目标都保持原样', async () => {
  await withHost(async (h) => {
    const sourceBefore = await readFile(join(h.rootA, 'docs', 'notes.md'), 'utf8');
    const targetBefore = await readFile(join(h.rootA, 'twin.md'), 'utf8');
    const anchor = await h.anchorOf(PROJ_A, 'docs/notes.md');
    const res = await h.move({
      projectId: PROJ_A,
      sourcePath: 'docs/notes.md',
      targetParentDir: '',
      name: 'twin.md',
      sourceAnchor: anchor,
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_ENTRY_EXISTS');
    assert.equal(await readFile(join(h.rootA, 'docs', 'notes.md'), 'utf8'), sourceBefore);
    assert.equal(await readFile(join(h.rootA, 'twin.md'), 'utf8'), targetBefore);
  });
});

test('R-07 目录移入自身后代：400 ERR_MOVE_INTO_DESCENDANT，零副作用', async () => {
  await withHost(async (h) => {
    const before = await h.disk();
    const anchor = await h.anchorOf(PROJ_A, 'docs');
    const res = await h.move({
      projectId: PROJ_A,
      sourcePath: 'docs',
      targetParentDir: 'docs/nested',
      name: 'docs',
      sourceAnchor: anchor,
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_MOVE_INTO_DESCENDANT');
    assert.equal(await h.disk(), before);
  });
});

test('R-08 源是符号链接 / junction：拒绝且不沿链接改名', async () => {
  await withHost(async (h) => {
    const outside = join(h.base, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'SECRET');
    await symlink(outside, join(h.rootA, 'escape'), 'junction');
    // 根内的 junction：它不会被"路径越界"提前挡掉，必须由"链接不得改名"兜住
    await symlink(join(h.rootA, 'archive'), join(h.rootA, 'docs', 'inner-link'), 'junction');

    /**
     * 链接行在 `/api/tree` 里**没有锚**（身份判不出对象），所以界面根本不会给它
     * 改名入口。这里先证明 HTTP 层照样拒绝（fail-closed，不降级成路径操作）。
     */
    const http = await h.rename({
      projectId: PROJ_A,
      sourcePath: 'escape',
      name: 'escape2',
      sourceAnchor: hex32('escape'),
    });
    assert.ok(http.status >= 400, JSON.stringify(http.body));
    assert.equal(existsSync(join(outside, 'escape2')), false);

    /**
     * 再越过界面直接问 Provider：根内链接必须先被"链接"这一类拒绝，
     * 而不是被"身份不符"顶掉——那证明不了链接检查还在。
     *
     * 两种错误码都算通过，因为拒绝发生在不同层：
     * - `ERR_PATH_OUTSIDE_ROOT`：`resolveInBoundary` 逐级校验时发现前缀是重解析点；
     * - `ERR_ENTRY_SOURCE_INVALID`：边界解析通过后 `lstat` 发现末段是链接。
     * 无论哪一层，都**没有**沿链接去改外面的对象。
     */
    const provider = h.runtime.providerOf(`local:${PROJ_A}`);
    assert.ok(provider && typeof provider.moveEntry === 'function');
    const direct = await provider.moveEntry('docs/inner-link', '', 'renamed-link', '0:0');
    assert.equal(direct.status, 'REJECTED');
    const code = (direct as { errorCode?: string }).errorCode;
    assert.ok(
      code === 'ERR_ENTRY_SOURCE_INVALID' || code === 'ERR_PATH_OUTSIDE_ROOT',
      `链接必须被拒绝，实际: ${code}`,
    );
    assert.equal(existsSync(join(h.rootA, 'renamed-link')), false);
    assert.equal(existsSync(join(outside, 'secret.txt')), true);
  });
});

test('R-09 占位被外部对象替换：绝不删除外部对象', async () => {
  let targetAbs = '';
  await withHost(
    async (h) => {
      targetAbs = join(h.rootA, 'archive', 'foreign.md');
      const anchor = await h.anchorOf(PROJ_A, 'docs/notes.md');
      const res = await h.move({
        projectId: PROJ_A,
        sourcePath: 'docs/notes.md',
        targetParentDir: 'archive',
        name: 'foreign.md',
        sourceAnchor: anchor,
      });
      assert.notEqual(res.status, 200, '占位被别人占走时不得宣称成功');
      assert.equal(existsSync(targetAbs), true, '外部对象必须还在');
      assert.equal(await readFile(targetAbs, 'utf8'), 'FOREIGN\n');
      assert.equal(await readFile(join(h.rootA, 'docs', 'notes.md'), 'utf8'), 'NOTES-CONTENT\n');
    },
    {
      faults: {
        // 占位已建立：外部删掉它并放入自己的同名文件（同步落盘，顺序确定）
        afterMoveReserve: () => {
          rmSync(targetAbs, { force: true });
          writeFileSync(targetAbs, 'FOREIGN\n');
        },
      },
    },
  );
});

test('R-10 结果不确定（UNKNOWN）不自动重发：Provider 只被调用一次', async () => {
  let moves = 0;
  await withHost(
    async (h) => {
      const anchor = await h.anchorOf(PROJ_A, 'docs/notes.md');
      const res = await h.move({
        projectId: PROJ_A,
        sourcePath: 'docs/notes.md',
        targetParentDir: 'archive',
        name: 'notes.md',
        sourceAnchor: anchor,
      });
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(res.body.status, 'UNKNOWN');
      assert.equal(moves, 1, 'UNKNOWN 绝不自动重试');
    },
    {
      onMove: () => {
        moves += 1;
      },
      faults: {
        afterMove: () => {
          throw Object.assign(new Error('确认链失败'), { code: 'EIO' });
        },
      },
    },
  );
});

test('R-11 目标父目录不存在：409/400 明确拒绝，源不动', async () => {
  await withHost(async (h) => {
    const before = await h.disk();
    const anchor = await h.anchorOf(PROJ_A, 'docs/notes.md');
    const res = await h.move({
      projectId: PROJ_A,
      sourcePath: 'docs/notes.md',
      targetParentDir: 'no-such-dir',
      name: 'notes.md',
      sourceAnchor: anchor,
      // 目录早就不在了，取不到真锚：给一个形状合法的占位，
      // 让这条用例真的走到"目标父目录不存在"，而不是被"缺目标身份"提前拦下
      targetAnchor: hex32('no-such-dir'),
    });
    assert.ok(res.status >= 400, JSON.stringify(res.body));
    assert.equal(res.body.errorCode, 'ERR_ENTRY_PARENT_INVALID');
    assert.equal(await h.disk(), before);
  });
});
