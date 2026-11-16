/**
 * UX-02C-02-R1.2：排他占位的**统一失败语义**（R1-04）+ rename 原子性边界（R1-05）。
 *
 * R1-04 复审缺陷：初次占位走了"stat/close 失败 → UNKNOWN"，而**重新占位**那一段
 * （占位被外部删除后重新收紧窗口）仍然是 `catch → REJECTED`。同一条磁盘上已经
 * 留下本次副作用的两条路径给出两种语义：一次普通的 EPERM 会被报成"什么都没发生"，
 * 客户端因此可以安全重试/继续操作，而磁盘上其实已经有一个 0 字节占位了。
 *
 * 本套件锁定：初次与重新占位**共用同一段实现**，四个失败点全部收敛为 UNKNOWN；
 * 源文件完整；身份未知时绝不删除目标。唯一例外是"外部对象占住了目标名"——
 * 那时必须普通拒绝（零副作用），且绝不覆盖/删除外部文件。
 *
 * R1-05：身份复核与 rename 之间仍存在竞争窗口。Node 在 Windows 上没有原子
 * no-replace rename（实测见 docs/evidence/ux-02c-02-r12/notes.md）。本套件不制造
 * "lstat + rename 就是原子保护"的假象，而是把真实行为钉成可观测断言：
 * 窗口内被外部替换的同名文件**会被覆盖**——这是**已知未解决风险**，不是已修复项。
 */
import assert from 'node:assert/strict';
import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

const PROJ_A = 'project-a';

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

interface Ctx {
  rootA: string;
  runtime: ProjectRuntime;
  api(path: string, init?: RequestInit): Promise<ApiResponse>;
  post(path: string, body: unknown): Promise<ApiResponse>;
  move(body: unknown): Promise<ApiResponse>;
  rename(body: unknown): Promise<ApiResponse>;
}

async function withHost(
  fn: (ctx: Ctx) => Promise<void>,
  options: { faults?: Parameters<typeof createLocalProvider>[0]['faults'] } = {},
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-ux02c02r12-'));
  const rootA = join(base, 'project-a');
  await mkdir(join(rootA, 'docs'), { recursive: true });
  await mkdir(join(rootA, 'archive'), { recursive: true });
  await writeFile(join(rootA, 'a.md'), '# A\n', 'utf8');
  await writeFile(join(rootA, 'docs', 'notes.md'), 'NOTES-CONTENT\n', 'utf8');

  const store = new FakeStore([storedProject(PROJ_A, '项目 A', rootA)]);
  let runtimeRef: ProjectRuntime | undefined;
  const factory = (input: { projectId: string; providerId: string; rootDir: string }): StorageProvider =>
    createLocalProvider({
      rootDir: input.rootDir,
      providerId: input.providerId,
      ...(options.faults ? { faults: options.faults } : {}),
    });

  const server: ShellServer = await createShellServer({
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

  const api = async (path: string, init?: RequestInit): Promise<ApiResponse> => {
    const res = await fetch(`${server.url}${path}`, init);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  };
  const tokenRes = await api('/api/session-token');
  const token = (tokenRes.body as { token?: string }).token ?? '';
  assert.notEqual(token, '', '夹具必须拿到 T1 令牌');
  const post = (path: string, body: unknown): Promise<ApiResponse> =>
    api(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ws-token': token,
        origin: new URL(server.url).origin,
      },
      body: JSON.stringify(body),
    });

  try {
    await fn({
      rootA,
      get runtime() {
        assert.ok(runtimeRef);
        return runtimeRef as ProjectRuntime;
      },
      api,
      post,
      move: (body) => post('/api/files/move', body),
      rename: (body) => post('/api/files/rename', body),
    });
  } finally {
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true });
  }
}

/* ---------------------- R1-04：初次占位的失败语义 ---------------------- */

test('R1.2-04a 初次占位后 stat 失败 → UNKNOWN；源完整、身份未知不删目标', async () => {
  let targetAbs = '';
  const calls: string[] = [];
  await withHost(
    async (h) => {
      targetAbs = join(h.rootA, 'archive', 'stat-failed.md');
      const res = await h.move({
        projectId: PROJ_A,
        sourcePath: 'docs/notes.md',
        targetParentDir: 'archive',
        name: 'stat-failed.md',
      });
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(res.body.status, 'UNKNOWN');
      assert.deepEqual(calls, ['1:beforeStat'], '必须走初次占位，且只失败一次');
      assert.equal(await readFile(join(h.rootA, 'docs', 'notes.md'), 'utf8'), 'NOTES-CONTENT\n');
      assert.equal(existsSync(targetAbs), true, '身份无法确认时不得删除目标');
      assert.equal((await stat(targetAbs)).size, 0, '目标上只有本次占位残留，如实暴露副作用');
    },
    {
      faults: {
        reserveFault: (stage, attempt) => {
          calls.push(`${attempt}:${stage}`);
          if (stage === 'beforeStat') throw new Error('stat 失败（测试注入）');
        },
      },
    },
  );
});

test('R1.2-04b 初次占位后 close 失败 → UNKNOWN；句柄被再次尽力释放', async () => {
  let targetAbs = '';
  await withHost(
    async (h) => {
      targetAbs = join(h.rootA, 'archive', 'close-failed.md');
      const res = await h.move({
        projectId: PROJ_A,
        sourcePath: 'docs/notes.md',
        targetParentDir: 'archive',
        name: 'close-failed.md',
      });
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(res.body.status, 'UNKNOWN');
      assert.equal(existsSync(join(h.rootA, 'docs', 'notes.md')), true);
      /**
       * 关闭失败后必须再尽力释放一次句柄。可观测信号：Windows 上"仍有打开句柄"
       * 会让**替换该名字**的 rename 报 EPERM（用户随后重试就会撞上这个错误），
       * 因此这里用一次替换性 rename 验证句柄真的被放开了。
       */
      const probe = join(h.rootA, 'archive', 'probe.md');
      writeFileSync(probe, '');
      assert.doesNotThrow(() => renameSync(probe, targetAbs), '关闭失败后必须再次尽力释放句柄');
      assert.equal(existsSync(targetAbs), true);
    },
    {
      faults: {
        reserveFault: (stage) => {
          if (stage === 'beforeClose') throw new Error('close 失败（测试注入）');
        },
      },
    },
  );
});

/* ---------------------- R1-04：重新占位的失败语义 ---------------------- */

/** 模拟外部进程：删掉本次占位，把名字空出来（不创建任何外部对象）。 */
function dropPlaceholder(targetAbs: string): void {
  unlinkSync(targetAbs);
}

test('R1.2-04c 占位被外部删除后，第二次占位 stat 失败 → UNKNOWN（不是 REJECTED）', async () => {
  let targetAbs = '';
  const calls: string[] = [];
  let firstReserved = false;
  await withHost(
    async (h) => {
      targetAbs = join(h.rootA, 'archive', 're-stat-failed.md');
      const res = await h.move({
        projectId: PROJ_A,
        sourcePath: 'docs/notes.md',
        targetParentDir: 'archive',
        name: 're-stat-failed.md',
      });
      assert.equal(firstReserved, true, '第一次占位必须成功（否则这条用例没覆盖到重新占位）');
      assert.deepEqual(calls, ['1:beforeStat', '1:beforeClose', '2:beforeStat']);
      // 关键：磁盘上已有本次副作用（重新建好的占位），语义必须是 UNKNOWN
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(res.body.status, 'UNKNOWN');
      assert.equal(await readFile(join(h.rootA, 'docs', 'notes.md'), 'utf8'), 'NOTES-CONTENT\n');
      assert.equal(existsSync(join(h.rootA, 'archive', 're-stat-failed.md')), true, '身份未知不得删除目标');
    },
    {
      faults: {
        afterMoveReserve: () => {
          firstReserved = true;
          dropPlaceholder(targetAbs);
        },
        reserveFault: (stage, attempt) => {
          calls.push(`${attempt}:${stage}`);
          if (attempt === 2 && stage === 'beforeStat') throw new Error('第二次占位 stat 失败（测试注入）');
        },
      },
    },
  );
});

test('R1.2-04d 占位被外部删除后，第二次占位 close 失败 → UNKNOWN，且句柄被释放', async () => {
  let targetAbs = '';
  const calls: string[] = [];
  await withHost(
    async (h) => {
      targetAbs = join(h.rootA, 'archive', 're-close-failed.md');
      const res = await h.move({
        projectId: PROJ_A,
        sourcePath: 'docs/notes.md',
        targetParentDir: 'archive',
        name: 're-close-failed.md',
      });
      assert.deepEqual(
        calls,
        ['1:beforeStat', '1:beforeClose', '2:beforeStat', '2:beforeClose'],
        '两次占位必须都走到 close 前注入点',
      );
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(res.body.status, 'UNKNOWN');
      assert.equal(await readFile(join(h.rootA, 'docs', 'notes.md'), 'utf8'), 'NOTES-CONTENT\n');
      assert.equal(existsSync(targetAbs), true, '身份未知不得删除目标');
      const probe = join(h.rootA, 'archive', 'probe2.md');
      writeFileSync(probe, '');
      assert.doesNotThrow(() => renameSync(probe, targetAbs), '第二次占位关闭失败后同样要再尽力释放句柄');
    },
    {
      faults: {
        afterMoveReserve: () => dropPlaceholder(targetAbs),
        reserveFault: (stage, attempt) => {
          calls.push(`${attempt}:${stage}`);
          if (attempt === 2 && stage === 'beforeClose') throw new Error('第二次占位 close 失败（测试注入）');
        },
      },
    },
  );
});

test('R1.2-04e 外部文件占住目标名：零副作用拒绝，外部文件完整保留', async () => {
  let targetAbs = '';
  await withHost(
    async (h) => {
      targetAbs = join(h.rootA, 'archive', 'foreign.md');
      const res = await h.move({
        projectId: PROJ_A,
        sourcePath: 'docs/notes.md',
        targetParentDir: 'archive',
        name: 'foreign.md',
      });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.errorCode, 'ERR_ENTRY_EXISTS');
      assert.equal(await readFile(targetAbs, 'utf8'), 'FOREIGN-CONTENT\n', '绝不覆盖外部文件');
      assert.equal(await readFile(join(h.rootA, 'docs', 'notes.md'), 'utf8'), 'NOTES-CONTENT\n');
    },
    {
      faults: {
        afterMoveReserve: () => {
          dropPlaceholder(targetAbs);
          writeFileSync(targetAbs, 'FOREIGN-CONTENT\n');
        },
      },
    },
  );
});

/* ---------------------- R1-05：rename 原子性边界 ---------------------- */

test('R1.2-05a 身份复核后、rename 前被外部替换：hook 位置正确，覆盖行为如实记录', async () => {
  let targetAbs = '';
  let hookCalls = 0;
  await withHost(
    async (h) => {
      targetAbs = join(h.rootA, 'archive', 'window.md');
      const res = await h.move({
        projectId: PROJ_A,
        sourcePath: 'docs/notes.md',
        targetParentDir: 'archive',
        name: 'window.md',
      });
      assert.equal(hookCalls, 1, '新注入点必须被触发且只触发一次');
      /**
       * hook 在归属复核**之后**才触发：若它早于复核，注入了外部文件的那次操作
       * 会以 ERR_ENTRY_EXISTS 收场（见 R1.2-04e）。
       */
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.status, 'APPLIED');
      // 已知未解决风险：窗口内被外部替换的同名文件会被 rename 覆盖。
      assert.equal(
        await readFile(targetAbs, 'utf8'),
        'NOTES-CONTENT\n',
        '外部文件已被覆盖：Node/Windows 没有原子 no-replace rename（见 notes.md）',
      );
      assert.equal(existsSync(join(h.rootA, 'docs', 'notes.md')), false);
    },
    {
      faults: {
        beforeMoveRename: () => {
          hookCalls += 1;
          dropPlaceholder(targetAbs);
          writeFileSync(targetAbs, 'FOREIGN-CONTENT\n');
        },
      },
    },
  );
});

test('R1.2-05b 正常路径不受新注入点影响：hook 触发一次且改名成功', async () => {
  let hookCalls = 0;
  await withHost(
    async (h) => {
      const res = await h.rename({
        projectId: PROJ_A,
        sourcePath: 'docs/notes.md',
        name: 'plain.md',
      });
      assert.equal(hookCalls, 1);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.status, 'APPLIED');
      assert.equal(await readFile(join(h.rootA, 'docs', 'plain.md'), 'utf8'), 'NOTES-CONTENT\n');
    },
    { faults: { beforeMoveRename: () => void (hookCalls += 1) } },
  );
});
