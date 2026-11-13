/**
 * S11-A1-G0：Storage 根目录连续性安全回归。
 *
 * 纪律（与 S4/S8 一致）：
 * - 本文件先于修复编写；在基线上必须失败，修复后必须通过；
 * - 只操作自建临时目录（`os.tmpdir()/ws-g0-*`），绝不对真实项目根做删除/移动/替换；
 * - 每条断言同时检查「返回状态 + 真实文件系统副作用」，不只看错误字符串；
 * - 无法在当前环境构造的场景（junction）标记 NOT_RUN，**不记为 PASS**；
 * - 标注区分：`[FS]` 真实文件系统验证；`[INJECT]` 故障注入；`[STATIC]` 静态检查；
 *   `[UNIT]` 纯函数单元验证。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createDocumentService } from '../../packages/document/index.ts';
import { ALL_ERROR_CODES, ERROR_CODES } from '../../packages/contracts/errors.ts';
import {
  buildRootToken,
  createLocalProvider,
  mapStorageError,
  rootTokenOf,
} from '../../packages/storage/index.ts';

const sha256 = (b: Buffer | string): string => `sha256:${createHash('sha256').update(b).digest('hex')}`;

const errorCodeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return 'NO_ERROR';
  } catch (err) {
    return (err as { errorCode?: string }).errorCode ?? `RAW:${(err as NodeJS.ErrnoException).code}`;
  }
};

const exists = (p: string): boolean => existsSync(p);

/** 目录内的临时文件残留（`.ws-tmp-*`）；用于断言异常路径不留下垃圾。 */
const tempFilesIn = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((name) => name.startsWith('.ws-tmp-'));
  } catch {
    return [];
  }
};

interface Ctx {
  base: string;
  root: string;
  cleanup(): Promise<void>;
}

async function withBase(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-g0-'));
  const root = join(base, 'project');
  try {
    await fn({
      base,
      root,
      cleanup: async () => {
        await rm(base, { recursive: true, force: true }).catch(() => {});
      },
    });
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

/** 探测当前环境能否创建 junction（Windows 普通用户可建）。 */
async function canCreateJunction(): Promise<boolean> {
  const base = await mkdtemp(join(tmpdir(), 'ws-g0-cap-'));
  try {
    await mkdir(join(base, 'target'), { recursive: true });
    await symlink(join(base, 'target'), join(base, 'link'), 'junction');
    return true;
  } catch {
    return false;
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}
const HAS_JUNCTION = await canCreateJunction();
const NOT_RUN_J = HAS_JUNCTION ? false : 'NOT_RUN: 当前环境无法创建 junction';

// ---------------------------------------------------------------------------
// G0-01 [FS] 已建立根被删除：新建文件会话保存不得重建根（D-1 正向复现）
// ---------------------------------------------------------------------------
test('G0-01 已建立根被删除后，新建文件会话保存必须失败且不重建根', async () => {
  await withBase(async ({ root }) => {
    await mkdir(root, { recursive: true });
    const provider = createLocalProvider({ rootDir: root });
    const document = createDocumentService();
    const view = await document.openSession({ resourceId: 'G0-01', path: 'drafts/new.md', provider });
    document.applyEdit(view.sessionId, '# draft\n');

    await rm(root, { recursive: true, force: true });

    const saved = await document.save(view.sessionId, (buffer) => buffer);
    assert.equal(saved.status, 'FAILED', '根失效后不得报 COMMITTED');
    assert.equal(saved.errorCode, 'ERR_ROOT_CHANGED', '必须给出根错误，而不是伪造成功');
    assert.equal(exists(root), false, '已失效的根不得被写操作重建');
  });
});

// ---------------------------------------------------------------------------
// G0-02 [FS] 已建立根被移动：保存不得在旧路径重建根
// ---------------------------------------------------------------------------
test('G0-02 已建立根被移动后，保存不得在旧路径重建根', async () => {
  await withBase(async ({ base, root }) => {
    await mkdir(root, { recursive: true });
    const moved = join(base, 'project-moved');
    const provider = createLocalProvider({ rootDir: root });
    const document = createDocumentService();
    const view = await document.openSession({ resourceId: 'G0-02', path: 'drafts/new.md', provider });
    document.applyEdit(view.sessionId, '# draft\n');

    await rename(root, moved);

    const saved = await document.save(view.sessionId, (buffer) => buffer);
    assert.equal(saved.status, 'FAILED');
    assert.equal(saved.errorCode, 'ERR_ROOT_CHANGED');
    assert.equal(exists(root), false, '旧路径不得被重建');
    assert.equal(exists(join(moved, 'drafts', 'new.md')), false, '新位置也不得被写入');
  });
});

// ---------------------------------------------------------------------------
// G0-03 [FS] 已存在文件的根失效：必须报根错误而非版本冲突
// ---------------------------------------------------------------------------
test('G0-03 已存在文件的根失效，必须报告根错误而不是版本冲突', async () => {
  await withBase(async ({ root }) => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'a.md'), '# A\n', 'utf8');
    const provider = createLocalProvider({ rootDir: root });
    const document = createDocumentService();
    const view = await document.openSession({ resourceId: 'G0-03', path: 'a.md', provider });
    document.applyEdit(view.sessionId, '# A edited\n');

    await rm(root, { recursive: true, force: true });

    const saved = await document.save(view.sessionId, (buffer) => buffer);
    assert.equal(saved.status, 'FAILED', '根失效不是版本冲突');
    assert.notEqual(saved.errorCode, 'ERR_DOCUMENT_VERSION_CONFLICT', '不得误报版本冲突');
    assert.equal(saved.errorCode, 'ERR_ROOT_CHANGED');
    assert.equal(document.getSession(view.sessionId)?.dirty, true, '草稿必须保留');
  });
});

// ---------------------------------------------------------------------------
// G0-04 [FS] 同名目录被替换：身份变化必须被识别，不得接管
// ---------------------------------------------------------------------------
test('G0-04 删除后重建同名根：身份变化必须被识别，不得写入新根', async () => {
  await withBase(async ({ root }) => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'a.md'), '# A\n', 'utf8');
    const provider = createLocalProvider({ rootDir: root });

    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true }); // 同名、但已是另一个目录

    const readCode = await errorCodeOf(() => provider.read('a.md'));
    assert.equal(readCode, 'ERR_ROOT_CHANGED', '替换后的根不得被当作原根读取');

    const written = await provider.writeConditional('b.md', 'B\n', null);
    assert.equal(written.status, 'FAILED');
    assert.equal(written.errorCode, 'ERR_ROOT_CHANGED');
    assert.equal(exists(join(root, 'b.md')), false, '替换根内不得产生文件');
  });
});

// ---------------------------------------------------------------------------
// G0-05 [FS] 构造时根不存在：首次合法写入仍可初始化（保护 S4R-05）
// ---------------------------------------------------------------------------
test('G0-05 Provider 构造时根不存在，首次写入仍可合法初始化', async () => {
  await withBase(async ({ root }) => {
    assert.equal(exists(root), false);
    const provider = createLocalProvider({ rootDir: root });

    const first = await provider.writeConditional('notes/a.md', 'N\n', null);
    assert.equal(first.status, 'COMMITTED');
    assert.equal(await readFile(join(root, 'notes/a.md'), 'utf8'), 'N\n');

    const second = await provider.writeConditional('notes/b.md', 'M\n', null);
    assert.equal(second.status, 'COMMITTED', '建立后必须保持可写');
    assert.deepEqual(await provider.list('notes'), ['a.md', 'b.md']);
  });
});

// ---------------------------------------------------------------------------
// G0-06 [FS] 首次创建后再删除根：后续写入必须拒绝，不得二次初始化
// ---------------------------------------------------------------------------
test('G0-06 首次创建后根被删除，后续写入必须拒绝且不得二次初始化', async () => {
  await withBase(async ({ root }) => {
    const provider = createLocalProvider({ rootDir: root });
    assert.equal((await provider.writeConditional('notes/a.md', 'N\n', null)).status, 'COMMITTED');

    await rm(root, { recursive: true, force: true });

    const again = await provider.writeConditional('notes/b.md', 'M\n', null);
    assert.equal(again.status, 'FAILED', '已建立的根消失后不得重新初始化');
    assert.equal(again.errorCode, 'ERR_ROOT_CHANGED');
    assert.equal(exists(root), false, '不得重建根目录');
  });
});

// ---------------------------------------------------------------------------
// G0-07 [FS] 并发首次初始化：不得各自认领根身份
// ---------------------------------------------------------------------------
test('G0-07 并发首次初始化必须串行协调，完成后只有唯一根身份', async () => {
  await withBase(async ({ root }) => {
    const provider = createLocalProvider({ rootDir: root });

    const [a, b] = await Promise.all([
      provider.writeConditional('x/a.md', 'A\n', null),
      provider.writeConditional('y/b.md', 'B\n', null),
    ]);
    assert.equal(a.status, 'COMMITTED');
    assert.equal(b.status, 'COMMITTED', '并发首次初始化不得因竞争而失败');
    assert.equal(await readFile(join(root, 'x/a.md'), 'utf8'), 'A\n');
    assert.equal(await readFile(join(root, 'y/b.md'), 'utf8'), 'B\n');

    // 唯一身份：删除后不得有任何一条路径能够重新初始化根
    await rm(root, { recursive: true, force: true });
    const after = await provider.writeConditional('z/c.md', 'C\n', null);
    assert.equal(after.status, 'FAILED');
    assert.equal(after.errorCode, 'ERR_ROOT_CHANGED');
    assert.equal(exists(root), false, '并发完成后仍必须按"已建立"处理');
  });
});

// ---------------------------------------------------------------------------
// G0-08 [UNIT] BigInt 令牌精度：绝不经过 Number
// ---------------------------------------------------------------------------
test('G0-08 根令牌必须用 BigInt 精确构造，Number 精度丢失不得影响身份', () => {
  // 实测值：该目录 ino 在 number 模式被读成 ...950，bigint 实为 ...946（相差 4）
  const ino = 242631429925785946n;
  assert.equal(Number.isSafeInteger(Number(ino)), false, '前提：该 inode 超出 Number 安全整数范围');
  assert.notEqual(String(Number(ino)), ino.toString(), '前提：Number 往返确实会丢精度');

  const token = buildRootToken({
    dev: 1992047887n,
    ino,
    birthtimeNs: 1794543857343n,
    isDirectory: () => true,
  });
  assert.equal(token, `1992047887:${ino.toString()}:1794543857343`);

  // 相邻 inode 必须得到不同令牌（Number 路径会把它们折叠成同一个）
  const sibling = buildRootToken({
    dev: 1992047887n,
    ino: ino + 1n,
    birthtimeNs: 1794543857343n,
    isDirectory: () => true,
  });
  assert.notEqual(token, sibling);
});

test('G0-08b [FS] 运行时令牌与 bigint stat 逐字段一致', async () => {
  await withBase(async ({ root }) => {
    await mkdir(root, { recursive: true });
    const s = statSync(root, { bigint: true });
    const token = rootTokenOf(root);
    assert.equal(token, `${s.dev}:${s.ino}:${s.birthtimeNs}`);
    assert.doesNotMatch(token, /e\+|\.\d/, '令牌不得是科学计数法或浮点形式');
  });
});

test('G0-08c [STATIC] 令牌实现不得经过 Number/parseInt', () => {
  const source = readFileSync(join(process.cwd(), 'packages/storage/path-safety.ts'), 'utf8');
  const start = source.indexOf('export function buildRootToken');
  assert.ok(start > 0, '必须存在 buildRootToken');
  const end = source.indexOf('\n}', start);
  const body = source.slice(start, end);
  assert.match(body, /bigint|BigInt|`\$\{/, '令牌必须由 BigInt 字段拼接');
  assert.doesNotMatch(body, /\bNumber\s*\(/, '禁止 Number() 转换身份字段');
  assert.doesNotMatch(body, /parseInt|parseFloat/, '禁止字符串数值解析');
});

// ---------------------------------------------------------------------------
// G0-09 [FS] 根被替换为 junction：禁止跟随到别处
// ---------------------------------------------------------------------------
test('G0-09 根被替换为 junction 后，读写不得跟随到替换目标', { skip: NOT_RUN_J }, async () => {
  await withBase(async ({ base, root }) => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'a.md'), '# A\n', 'utf8');
    const provider = createLocalProvider({ rootDir: root });

    const moved = join(base, 'project-real');
    await rename(root, moved);
    const elsewhere = join(base, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, 'a.md'), '# ATTACKER\n', 'utf8');
    await symlink(elsewhere, root, 'junction');

    const readCode = await errorCodeOf(() => provider.read('a.md'));
    assert.ok(
      readCode === 'ERR_ROOT_CHANGED' || readCode === 'ERR_PATH_OUTSIDE_ROOT',
      `必须拒绝跟随替换后的根，实际: ${readCode}`,
    );
    const written = await provider.writeConditional('a.md', '# ATTACK\n', sha256('# A\n'));
    assert.notEqual(written.status, 'COMMITTED');
    assert.equal(await readFile(join(elsewhere, 'a.md'), 'utf8'), '# ATTACKER\n', '替换目标内容不得被改动');
  });
});

// ---------------------------------------------------------------------------
// G0-10 [INJECT] C1/C2/C3 故障注入：不得产生非授权副作用
// ---------------------------------------------------------------------------
test('G0-10a [INJECT] C1 处根被删除：返回 FAILED 且不重建根', async () => {
  await withBase(async ({ root }) => {
    await mkdir(root, { recursive: true });
    const provider = createLocalProvider({
      rootDir: root,
      faults: {
        atCheckpoint: (id) => {
          if (id === 'C1') rmSync(root, { recursive: true, force: true });
        },
      },
    });
    const result = await provider.writeConditional('deep/a.md', '# NEW\n', null);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, 'ERR_ROOT_CHANGED');
    assert.equal(exists(root), false, 'C1 拦截后不得创建任何目录');
  });
});

test('G0-10b [INJECT] C2（mkdir 后、写临时文件前）根被替换：不得写入', async () => {
  await withBase(async ({ base, root }) => {
    await mkdir(root, { recursive: true });
    const moved = join(base, 'old-root');
    const provider = createLocalProvider({
      rootDir: root,
      faults: {
        atCheckpoint: (id) => {
          if (id !== 'C2') return;
          renameSync(root, moved);
          mkdirSync(root);
        },
      },
    });
    const result = await provider.writeConditional('sub/a.md', '# NEW\n', null);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, 'ERR_ROOT_CHANGED');
    assert.equal(exists(join(root, 'sub', 'a.md')), false, '替换根内不得写入');
    assert.deepEqual(tempFilesIn(root), [], '不得残留临时文件');
    assert.deepEqual(tempFilesIn(join(moved, 'sub')), [], '旧根内也不得残留临时文件');
  });
});

test('G0-10c [INJECT] C3（rename 前）根被替换：不得提交', async () => {
  await withBase(async ({ base, root }) => {
    await mkdir(root, { recursive: true });
    const moved = join(base, 'old-root');
    const provider = createLocalProvider({
      rootDir: root,
      faults: {
        atCheckpoint: (id) => {
          if (id !== 'C3') return;
          renameSync(root, moved);
          mkdirSync(root);
        },
      },
    });
    const result = await provider.writeConditional('sub/a.md', '# NEW\n', null);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, 'ERR_ROOT_CHANGED');
    assert.equal(exists(join(root, 'sub', 'a.md')), false, '替换根内不得出现文件');
    assert.equal(exists(join(moved, 'sub', 'a.md')), false, '旧根内也不得出现文件');
    // 当前授权根内必须干净（这是可保证的安全属性）
    assert.deepEqual(tempFilesIn(root), [], '当前授权根内不得残留临时文件');
    // 已知残余（见 storage/README「已知限制」）：临时文件在被移走的目录里，
    // 路径型 API 无法回收它。这里只断言"不累积、且绝不出现在仍被授权的根内"。
    assert.ok(
      tempFilesIn(join(moved, 'sub')).length <= 1,
      '被移走目录中的临时文件最多一个，不得累积',
    );
  });
});

// ---------------------------------------------------------------------------
// G0-11 [INJECT] C4（rename 后）结果不确定 → UNKNOWN
// ---------------------------------------------------------------------------
test('G0-11 C4 提交后根身份变化，必须返回 UNKNOWN 而不是 COMMITTED', async () => {
  await withBase(async ({ base, root }) => {
    await mkdir(root, { recursive: true });
    const moved = join(base, 'committed-elsewhere');
    const provider = createLocalProvider({
      rootDir: root,
      faults: {
        atCheckpoint: (id) => {
          if (id !== 'C4') return;
          renameSync(root, moved);
          mkdirSync(root);
        },
      },
    });
    const result = await provider.writeConditional('a.md', '# NEW\n', null);
    assert.equal(result.status, 'UNKNOWN', '副作用可能已发生，不得报确定失败或成功');
    assert.equal(result.errorCode, 'ERR_OUTCOME_UNKNOWN');
    assert.equal(
      await readFile(join(moved, 'a.md'), 'utf8'),
      '# NEW\n',
      '文件确实已落到提交时的根（证明 UNKNOWN 判定是必要的）',
    );
    assert.equal(exists(join(root, 'a.md')), false, '替换根内不得出现文件');
  });
});

// ---------------------------------------------------------------------------
// G0-12 [FS] 根失效后 read/stat/list 必须给出可识别的根错误
// ---------------------------------------------------------------------------
test('G0-12 根失效后 read/stat/list 必须报告根错误，不得伪装成文件不存在或空目录', async () => {
  await withBase(async ({ root }) => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'a.md'), '# A\n', 'utf8');
    const provider = createLocalProvider({ rootDir: root });

    await rm(root, { recursive: true, force: true });

    assert.equal(await errorCodeOf(() => provider.read('a.md')), 'ERR_ROOT_CHANGED');
    assert.equal(await errorCodeOf(() => provider.stat('a.md')), 'ERR_ROOT_CHANGED');
    assert.equal(await errorCodeOf(() => provider.list()), 'ERR_ROOT_CHANGED');
  });
});

// ---------------------------------------------------------------------------
// G0-13 [FS] 正常路径不受影响（新建子目录 / 保存 / 重新打开）
// ---------------------------------------------------------------------------
test('G0-13 正常读写、递归建目录与重新打开不受连续性检查影响', async () => {
  await withBase(async ({ root }) => {
    await mkdir(root, { recursive: true });
    const provider = createLocalProvider({ rootDir: root });

    const created = await provider.writeConditional('a/b/c.md', '# C\n', null);
    assert.equal(created.status, 'COMMITTED');
    const read = await provider.read('a/b/c.md');
    assert.equal(read.content, '# C\n');
    assert.equal(read.contentVersion, created.contentVersion);

    const updated = await provider.writeConditional('a/b/c.md', '# C2\n', created.contentVersion ?? null);
    assert.equal(updated.status, 'COMMITTED');

    const stale = await provider.writeConditional('a/b/c.md', '# C3\n', created.contentVersion ?? null);
    assert.equal(stale.status, 'CONFLICT', '正常版本冲突语义必须保留');

    const reopened = createLocalProvider({ rootDir: root });
    assert.equal((await reopened.read('a/b/c.md')).content, '# C2\n');
    assert.deepEqual(await reopened.list(), ['a/b/c.md']);
    assert.deepEqual(tempFilesIn(join(root, 'a', 'b')), []);
  });
});

test('G0-13b [FS] 构造时根不存在的 Provider 仍保持"文件不存在"语义', async () => {
  await withBase(async ({ root }) => {
    const provider = createLocalProvider({ rootDir: root });
    assert.equal(await errorCodeOf(() => provider.read('missing.md')), 'ERR_RESOURCE_NOT_FOUND');
    const st = await provider.stat('missing.md');
    assert.equal(st.exists, false, '未初始化的根不得被报告为根错误');
    assert.deepEqual(await provider.list(), [], '空目录语义必须保留');
  });
});

// ---------------------------------------------------------------------------
// G0-14 [UNIT/FS] 根身份无法确认时安全拒绝
// ---------------------------------------------------------------------------
test('G0-14a [UNIT] ino 不可用时拒绝构造令牌', () => {
  assert.throws(
    () =>
      buildRootToken({ dev: 1n, ino: 0n, birthtimeNs: 1n, isDirectory: () => true }),
    (err: { errorCode?: string }) => err.errorCode === 'ERR_ROOT_IDENTITY_UNSUPPORTED',
  );
  assert.throws(
    () => buildRootToken({ dev: 1n, ino: 2n, birthtimeNs: 1n, isDirectory: () => false }),
    (err: { errorCode?: string }) => err.errorCode === 'ERR_ROOT_CHANGED',
  );
});

test('G0-14b [FS] 根路径不是目录时构造即拒绝', async () => {
  await withBase(async ({ base }) => {
    const fileRoot = join(base, 'not-a-dir.md');
    await writeFile(fileRoot, 'x', 'utf8');
    assert.throws(
      () => createLocalProvider({ rootDir: fileRoot }),
      (err: { errorCode?: string }) =>
        err.errorCode === 'ERR_ROOT_CHANGED' || err.errorCode === 'ERR_PATH_OUTSIDE_ROOT',
    );
  });
});

// ---------------------------------------------------------------------------
// G0-15 [INJECT] 异常路径不残留临时文件，初始化锁不得卡死
// ---------------------------------------------------------------------------
test('G0-15 首次初始化在 C1 抛错后：不留残留、不误置已建立、后续写入可恢复', async () => {
  await withBase(async ({ root }) => {
    let fail = true;
    const provider = createLocalProvider({
      rootDir: root,
      faults: {
        atCheckpoint: (id) => {
          if (id === 'C1' && fail) throw Object.assign(new Error('injected'), { errorCode: 'ERR_STORAGE_IO' });
        },
      },
    });

    const failed = await provider.writeConditional('a.md', '# A\n', null);
    assert.equal(failed.status, 'FAILED');
    assert.equal(exists(root), false, '初始化失败不得留下根目录');
    assert.deepEqual(tempFilesIn(root), []);

    fail = false;
    const ok = await provider.writeConditional('a.md', '# A\n', null);
    assert.equal(ok.status, 'COMMITTED', '失败后不得卡死或误判为已建立');
    assert.equal(await readFile(join(root, 'a.md'), 'utf8'), '# A\n');
  });
});

test('G0-15b [INJECT] C3 失败后不残留临时文件', async () => {
  await withBase(async ({ root }) => {
    await mkdir(join(root, 'sub'), { recursive: true });
    const provider = createLocalProvider({
      rootDir: root,
      faults: {
        atCheckpoint: (id) => {
          if (id === 'C3') throw Object.assign(new Error('injected'), { errorCode: 'ERR_STORAGE_IO' });
        },
      },
    });
    const result = await provider.writeConditional('sub/a.md', '# A\n', null);
    assert.equal(result.status, 'FAILED');
    assert.equal(exists(join(root, 'sub', 'a.md')), false);
    assert.deepEqual(tempFilesIn(join(root, 'sub')), [], 'C3 失败必须清理临时文件');
  });
});

// ---------------------------------------------------------------------------
// G0-16 [UNIT] 新错误码进入注册表且映射不被折叠
// ---------------------------------------------------------------------------
test('G0-16 根连续性错误码必须注册，并在映射中保持原样', () => {
  assert.equal(ERROR_CODES.ERR_ROOT_CHANGED, 'ERR_ROOT_CHANGED');
  assert.equal(ERROR_CODES.ERR_ROOT_IDENTITY_UNSUPPORTED, 'ERR_ROOT_IDENTITY_UNSUPPORTED');
  assert.ok(ALL_ERROR_CODES.includes('ERR_ROOT_CHANGED'));
  assert.ok(ALL_ERROR_CODES.includes('ERR_ROOT_IDENTITY_UNSUPPORTED'));

  assert.equal(mapStorageError({ errorCode: 'ERR_ROOT_CHANGED' }), 'ERR_ROOT_CHANGED');
  assert.equal(
    mapStorageError({ errorCode: 'ERR_ROOT_IDENTITY_UNSUPPORTED' }),
    'ERR_ROOT_IDENTITY_UNSUPPORTED',
  );
  // 不得被折叠成"不存在/IO"（那会让 UI 误判为用户删了文件）
  assert.notEqual(mapStorageError({ errorCode: 'ERR_ROOT_CHANGED' }), 'ERR_RESOURCE_NOT_FOUND');
});
