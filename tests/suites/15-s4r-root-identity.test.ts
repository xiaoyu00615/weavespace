/**
 * S4-R1：根目录身份固定（root identity pinning）与父级 junction 改向回归。
 *
 * 纪律：
 * - 本文件先于修复编写，修复前必须失败（H2/H1/根解析失败三组）；
 * - 断言必须同时检查「返回状态」与「真实文件系统副作用」（含 SHA-256）；
 * - 无法创建重解析点的环境 → 用例标 skip（NOT_RUN），不记为 PASS；
 * - 只在自建临时目录内操作，不接触项目资料或用户文件。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, rmdirSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalProvider, resolveInsideRoot } from '../../packages/storage/index.ts';

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

async function canCreateJunction(): Promise<boolean> {
  const base = await mkdtemp(join(tmpdir(), 's4r-cap-j-'));
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

/** 同步创建/改向 junction：供 faults.beforeCommit 这类同步钩子使用。 */
function pointAtSync(link: string, target: string): void {
  try {
    rmdirSync(link);
  } catch {
    /* 首次可能不存在 */
  }
  symlinkSync(target, link, 'junction');
}

interface Sandbox {
  base: string;
  A: string;
  B: string;
  link: string;
  secret: string;
  cleanup(): Promise<void>;
}

/** 沙箱：A/B 两个真实目录 + 指向 A 的 junction（模拟“根位于 junction 父目录下”）。 */
async function makeSandbox(tag: string): Promise<Sandbox> {
  const base = await mkdtemp(join(tmpdir(), `s4r-${tag}-`));
  const A = join(base, 'A');
  const B = join(base, 'B');
  await mkdir(A, { recursive: true });
  await mkdir(B, { recursive: true });
  const secret = join(base, 'secret.md');
  await writeFile(secret, 'ROOT-OUTSIDE-SECRET\n', 'utf8');
  const link = join(base, 'jlink');
  await symlink(A, link, 'junction');
  return {
    base,
    A,
    B,
    link,
    secret,
    async cleanup() {
      try {
        rmdirSync(link);
      } catch {
        /* ignore */
      }
      await rm(base, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// S4R-01：父级 junction 在落盘前由 A 改向 B —— 不得在 B 产生任何副作用，
//          且不得返回 COMMITTED（旧实现会把内容写进 B 并报成功）。
// ---------------------------------------------------------------------------
test('S4R-01 根不存在时父级 junction 改向：必须拒绝，A/B 均不得产生文件', { skip: NOT_RUN_J }, async () => {
  const sb = await makeSandbox('h2');
  try {
    const root = join(sb.link, 'newproj'); // 尚不存在 → 旧实现回退字面路径
    const provider = createLocalProvider({
      rootDir: root,
      faults: { beforeCommit: () => pointAtSync(sb.link, sb.B) },
    });

    const result = await provider.writeConditional('p.md', 'H2-PAYLOAD\n', null);

    assert.equal(result.status, 'FAILED', '根身份改变时不得返回 COMMITTED');
    assert.equal(result.errorCode, 'ERR_PATH_OUTSIDE_ROOT');

    // 副作用：A 与 B 都不得出现目标文件；B 不得被写入任何内容
    assert.equal(existsSync(join(sb.A, 'newproj', 'p.md')), false, 'A 侧不得写入');
    assert.equal(existsSync(join(sb.B, 'newproj', 'p.md')), false, 'B 侧不得写入（关键）');
    assert.equal(existsSync(join(sb.B, 'newproj')), false, 'B 侧不得被创建目录');

    // 根外秘密文件保持原值
    assert.equal(sha256(await readFile(sb.secret)), sha256('ROOT-OUTSIDE-SECRET\n'));
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S4R-02：根已存在（边界已由 realpath 钉住），父级 junction 改向 → 必须拒绝
// ---------------------------------------------------------------------------
test('S4R-02 根已存在时父级 junction 改向：必须拒绝且两侧均无新文件', { skip: NOT_RUN_J }, async () => {
  const sb = await makeSandbox('h1');
  try {
    await mkdir(join(sb.A, 'proj'), { recursive: true });
    const root = join(sb.link, 'proj');
    const provider = createLocalProvider({
      rootDir: root,
      faults: { beforeCommit: () => pointAtSync(sb.link, sb.B) },
    });

    const result = await provider.writeConditional('p.md', 'H1-PAYLOAD\n', null);

    assert.equal(result.status, 'FAILED', '根身份改变时不得返回 COMMITTED');
    assert.equal(result.errorCode, 'ERR_PATH_OUTSIDE_ROOT');
    assert.equal(existsSync(join(sb.A, 'proj', 'p.md')), false, 'A 侧不得写入');
    assert.equal(existsSync(join(sb.B, 'proj', 'p.md')), false, 'B 侧不得写入');
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S4R-03：无漂移的正常路径必须保持可用（防过度修复）
// ---------------------------------------------------------------------------
test('S4R-03 正常根：读写与递归创建仍然可用，物理落点正确', async () => {
  const base = await mkdtemp(join(tmpdir(), 's4r-normal-'));
  try {
    const provider = createLocalProvider({ rootDir: base });

    const created = await provider.writeConditional('docs/x/y/z/deep.md', 'DEEP\n', null);
    assert.equal(created.status, 'COMMITTED');
    assert.equal(await readFile(join(base, 'docs/x/y/z/deep.md'), 'utf8'), 'DEEP\n');

    const read = await provider.read('docs/x/y/z/deep.md');
    assert.equal(read.content, 'DEEP\n');
    assert.equal(read.contentVersion, created.contentVersion);

    const conflict = await provider.writeConditional('docs/x/y/z/deep.md', 'AGAIN\n', null);
    assert.equal(conflict.status, 'CONFLICT', '创建语义不得因边界固定而放宽');

    assert.deepEqual(await provider.list('docs/x'), ['y/z/deep.md']);
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// S4R-04：根目录自身是 junction —— 既定策略（边界取真实目标）必须保留
// ---------------------------------------------------------------------------
test('S4R-04 根目录自身为 junction：读写正常且边界为真实目标', { skip: NOT_RUN_J }, async () => {
  const base = await mkdtemp(join(tmpdir(), 's4r-rootlink-'));
  try {
    const real = join(base, 'real');
    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'a.md'), 'A\n', 'utf8');
    const rootLink = join(base, 'rootlink');
    await symlink(real, rootLink, 'junction');

    const provider = createLocalProvider({ rootDir: rootLink });
    assert.equal((await provider.read('a.md')).content, 'A\n');
    assert.equal((await provider.stat('a.md')).exists, true);

    const w = await provider.writeConditional('b.md', 'B\n', null);
    assert.equal(w.status, 'COMMITTED');
    assert.equal(existsSync(join(real, 'b.md')), true, '写入必须落在真实目标内');

    // 越界仍被拒绝
    await assert.rejects(
      () => provider.read('../secret.md'),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PATH_OUTSIDE_ROOT',
    );
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// S4R-05：根不存在时的初始化 —— provider 可用，后续创建落在预期位置
// ---------------------------------------------------------------------------
test('S4R-05 根不存在时的初始化：允许创建，落点固定在解析后的根内', async () => {
  const base = await mkdtemp(join(tmpdir(), 's4r-init-'));
  try {
    const root = join(base, 'newroot');
    assert.equal(existsSync(root), false);

    const provider = createLocalProvider({ rootDir: root });
    const w = await provider.writeConditional('notes/a.md', 'N\n', null);
    assert.equal(w.status, 'COMMITTED');
    assert.equal(await readFile(join(root, 'notes/a.md'), 'utf8'), 'N\n');

    // 根创建后边界仍一致：后续写入照常
    const w2 = await provider.writeConditional('notes/b.md', 'M\n', null);
    assert.equal(w2.status, 'COMMITTED');
    assert.deepEqual(await provider.list('notes'), ['a.md', 'b.md']);
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// S4R-06：根真实路径无法解析（非 ENOENT）—— 必须 fail closed，不得回退字面路径
// ---------------------------------------------------------------------------
test('S4R-06 根路径解析失败（ENAMETOOLONG）：构造即拒绝，不得回退字面路径', () => {
  const tooLong = `${process.cwd().slice(0, 3)}${'a'.repeat(40000)}`;

  assert.throws(
    () => createLocalProvider({ rootDir: tooLong }),
    (err: { errorCode?: string }) => err.errorCode === 'ERR_PATH_OUTSIDE_ROOT',
    '根目录真实路径无法确认时必须 fail closed',
  );

  const check = resolveInsideRoot(tooLong, 'a.md');
  assert.equal(check.ok, false);
  if (!check.ok) assert.equal(check.errorCode, 'ERR_PATH_OUTSIDE_ROOT');
});

// ---------------------------------------------------------------------------
// S4R-07：根内悬空 junction —— 必须拒绝，且不得在根外重建目标
// ---------------------------------------------------------------------------
test('S4R-07 根内悬空 junction：拒绝写入且根外目标不被重建', { skip: NOT_RUN_J }, async () => {
  const base = await mkdtemp(join(tmpdir(), 's4r-dangle-'));
  try {
    const root = join(base, 'root');
    await mkdir(root, { recursive: true });
    const gone = join(base, 'gone-target');
    await mkdir(gone, { recursive: true });
    await symlink(gone, join(root, 'dangle'), 'junction');
    await rm(gone, { recursive: true, force: true });

    const provider = createLocalProvider({ rootDir: root });
    const result = await provider.writeConditional('dangle/new.md', 'X\n', null);

    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, 'ERR_PATH_OUTSIDE_ROOT', '悬空重解析点必须可识别');
    assert.equal(existsSync(gone), false, '根外目标不得被重建');
    assert.equal((await stat(root)).isDirectory(), true);
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// S4R-08（F04）：根位于「悬空 junction + 多层不存在目录」之下
//   祖先回溯时每一级 ENOENT 都必须判断它是否其实是无法解析的已存在条目。
// ---------------------------------------------------------------------------
test('S4R-08 悬空 junction 作为多级缺失目录的祖先：构造必须 fail closed', { skip: NOT_RUN_J }, async () => {
  const base = await mkdtemp(join(tmpdir(), 's4r-ancestor-'));
  const link = join(base, 'dangle');
  try {
    const target = join(base, 'vanished-target');
    await mkdir(target, { recursive: true });
    await symlink(target, link, 'junction');
    await rm(target, { recursive: true, force: true }); // 目标删除 → junction 悬空

    const root = join(link, 'a', 'b', 'c'); // 多层不存在，祖先里藏着悬空 junction

    assert.throws(
      () => createLocalProvider({ rootDir: root }),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_PATH_OUTSIDE_ROOT',
      '悬空 junction 作为祖先时必须拒绝，不得当作普通缺失目录拼入 canonicalRoot',
    );

    const check = resolveInsideRoot(root, 'x.md');
    assert.equal(check.ok, false, '一次性解析同样必须拒绝');
    if (!check.ok) assert.equal(check.errorCode, 'ERR_PATH_OUTSIDE_ROOT');

    // 不得创建任何根外对象（含 junction 目标位置）
    assert.equal(existsSync(target), false, 'junction 目标不得被重建');
    assert.equal(existsSync(join(link, 'a')), false, 'junction 下不得创建目录');
    assert.equal(existsSync(join(base, 'a')), false, '不得在根外创建目录');
  } finally {
    try {
      rmdirSync(link);
    } catch {
      /* ignore */
    }
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// S4R-09（F06）：边界漂移必须优先于版本冲突判断
//   Provider 建好后父级 junction 改向；即使期望版本是过期的，也必须先报边界错误。
// ---------------------------------------------------------------------------
test('S4R-09 边界漂移优先于版本冲突：必须 FAILED/ERR_PATH_OUTSIDE_ROOT 而非 CONFLICT', { skip: NOT_RUN_J }, async () => {
  const sb = await makeSandbox('f06');
  try {
    await mkdir(join(sb.A, 'proj'), { recursive: true });
    await writeFile(join(sb.A, 'proj', 'doc.md'), 'A-ORIGINAL\n', 'utf8');
    await mkdir(join(sb.B, 'proj'), { recursive: true });
    await writeFile(join(sb.B, 'proj', 'doc.md'), 'B-DIFFERENT\n', 'utf8');

    const provider = createLocalProvider({ rootDir: join(sb.link, 'proj') });
    const staleVersion = `sha256:${'0'.repeat(64)}`; // 必然与磁盘版本不一致

    pointAtSync(sb.link, sb.B); // 父级 junction 改向 B

    const result = await provider.writeConditional('doc.md', 'NEW\n', staleVersion);

    assert.equal(result.status, 'FAILED', '必须按边界错误拒绝，不得返回普通 CONFLICT');
    assert.equal(result.errorCode, 'ERR_PATH_OUTSIDE_ROOT');

    // 副作用：两侧内容都必须保持原样
    assert.equal(await readFile(join(sb.A, 'proj', 'doc.md'), 'utf8'), 'A-ORIGINAL\n');
    assert.equal(await readFile(join(sb.B, 'proj', 'doc.md'), 'utf8'), 'B-DIFFERENT\n');
  } finally {
    await sb.cleanup();
  }
});
