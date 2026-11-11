/**
 * S4：Windows 路径安全回归（junction / 符号链接 / 根目录边界）。
 *
 * 纪律：
 * - 本文件先于修复编写，修复前必须失败；
 * - 所有断言都检查「结果 + 真实文件系统副作用」，不只查状态字符串；
 * - 无法在当前环境创建的重解析点 → 该用例标记 skip（NOT_RUN），**不记为 PASS**；
 * - 测试只创建/清理自己管理的临时目录，不接触项目资料或用户文件。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDocumentService } from '../../packages/document/index.ts';
import { createLocalProvider, resolveInsideRoot } from '../../packages/storage/index.ts';

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** 探测当前环境能否创建 junction（Windows 普通用户可建，无需管理员）。 */
async function canCreateJunction(): Promise<boolean> {
  const base = await mkdtemp(join(tmpdir(), 's4-cap-j-'));
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

/** 探测当前环境能否创建文件/目录符号链接（Windows 通常需要管理员或开发者模式）。 */
async function canCreateSymlink(kind: 'dir' | 'file'): Promise<boolean> {
  const base = await mkdtemp(join(tmpdir(), 's4-cap-s-'));
  try {
    if (kind === 'dir') {
      await mkdir(join(base, 'target'), { recursive: true });
      await symlink(join(base, 'target'), join(base, 'link'), 'dir');
    } else {
      await writeFile(join(base, 'target.txt'), 'x', 'utf8');
      await symlink(join(base, 'target.txt'), join(base, 'link.txt'), 'file');
    }
    return true;
  } catch {
    return false;
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

const HAS_JUNCTION = await canCreateJunction();
const HAS_DIR_SYMLINK = await canCreateSymlink('dir');
const HAS_FILE_SYMLINK = await canCreateSymlink('file');

const NOT_RUN_J = HAS_JUNCTION ? false : 'NOT_RUN: 当前环境无法创建 junction';
const NOT_RUN_SD = HAS_DIR_SYMLINK ? false : 'NOT_RUN: 当前环境无法创建目录符号链接';
const NOT_RUN_SF = HAS_FILE_SYMLINK ? false : 'NOT_RUN: 当前环境无法创建文件符号链接';

interface Sandbox {
  root: string;
  outside: string;
  secretPath: string;
  cleanup(): Promise<void>;
}

/** 建「项目根 + 根外目录 + 根外秘密文件」的隔离沙箱。 */
async function makeSandbox(tag: string): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), `s4t-${tag}-root-`));
  const outside = await mkdtemp(join(tmpdir(), `s4t-${tag}-outside-`));
  const secretPath = join(outside, 'secret.md');
  await writeFile(secretPath, 'OUTSIDE-SECRET-CONTENT\n', 'utf8');
  return {
    root,
    outside,
    secretPath,
    async cleanup() {
      await rm(root, { recursive: true, force: true }).catch(() => {});
      await rm(outside, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** 安全调用，返回错误码或 'OK'，便于断言而不依赖异常类型。 */
async function errCodeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'OK';
  } catch (err) {
    return (err as { errorCode?: string }).errorCode ?? `THROW:${(err as Error).message}`;
  }
}

// ---------------------------------------------------------------------------
// S4-01：junction 指向根外已存在文件 —— 读取必须被拒绝
// ---------------------------------------------------------------------------
test('S4-01 junction 指向根外已存在文件：read 必须拒绝且不返回根外内容', { skip: NOT_RUN_J }, async () => {
  const sb = await makeSandbox('read');
  try {
    await symlink(sb.outside, join(sb.root, 'escape'), 'junction');
    const provider = createLocalProvider({ rootDir: sb.root });

    const code = await errCodeOf(() => provider.read('escape/secret.md'));
    assert.equal(code, 'ERR_PATH_OUTSIDE_ROOT', 'read 必须抛 ERR_PATH_OUTSIDE_ROOT');

    // 副作用：内容绝不能被读出（用读取成功与否判断，而不只是看错误码）
    let leaked = '';
    try {
      leaked = (await provider.read('escape/secret.md')).content;
    } catch {
      leaked = '';
    }
    assert.equal(leaked, '', '根外内容不得通过任何返回路径泄漏');
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S4-02：经 junction 创建新文件 —— 必须被拒绝
// ---------------------------------------------------------------------------
test('S4-02 经 junction 创建新文件：writeConditional 必须拒绝且根外不产生文件', { skip: NOT_RUN_J }, async () => {
  const sb = await makeSandbox('create');
  try {
    await symlink(sb.outside, join(sb.root, 'escape'), 'junction');
    const provider = createLocalProvider({ rootDir: sb.root });

    const result = await provider.writeConditional('escape/created.md', 'PWNED\n', null);
    assert.equal(result.status, 'FAILED', '越界写入必须是 FAILED，而不是 COMMITTED');
    assert.equal(result.errorCode, 'ERR_PATH_OUTSIDE_ROOT');

    const created = await stat(join(sb.outside, 'created.md')).then(() => true, () => false);
    assert.equal(created, false, '根外新文件必须未被创建');
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S4-03：根外文件内容与 SHA-256 在全部攻击后完全不变
// ---------------------------------------------------------------------------
test('S4-03 全部越界尝试之后：根外文件内容与 SHA-256 完全不变', { skip: NOT_RUN_J }, async () => {
  const sb = await makeSandbox('integrity');
  try {
    await symlink(sb.outside, join(sb.root, 'escape'), 'junction');
    const provider = createLocalProvider({ rootDir: sb.root });

    const before = sha256(await readFile(sb.secretPath));

    // 尝试覆盖：先拿到（错误的）版本号也不能得逞
    await provider.writeConditional('escape/secret.md', 'OVERWRITTEN\n', null).catch(() => {});
    const st = await provider.stat('escape/secret.md').catch(() => null);
    if (st && st.contentVersion) {
      await provider.writeConditional('escape/secret.md', 'OVERWRITTEN\n', st.contentVersion).catch(() => {});
    }
    await provider.read('escape/secret.md').catch(() => {});

    const afterBuf = await readFile(sb.secretPath);
    assert.equal(sha256(afterBuf), before, '根外文件的 SHA-256 必须完全不变');
    assert.equal(afterBuf.toString('utf8'), 'OUTSIDE-SECRET-CONTENT\n', '内容必须保持原样');
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S4-04：根外不存在的目标在测试后仍不存在（含 mkdir 递归创建）
// ---------------------------------------------------------------------------
test('S4-04 经 junction 递归建目录并写文件：根外不得出现任何新对象', { skip: NOT_RUN_J }, async () => {
  const sb = await makeSandbox('mkdir');
  try {
    await symlink(sb.outside, join(sb.root, 'escape'), 'junction');
    const provider = createLocalProvider({ rootDir: sb.root });

    const r = await provider.writeConditional('escape/nested/deep/new.md', 'X\n', null);
    assert.equal(r.status, 'FAILED');
    assert.equal(r.errorCode, 'ERR_PATH_OUTSIDE_ROOT');

    assert.equal(await stat(join(sb.outside, 'nested')).then(() => true, () => false), false, '根外不得创建 nested/');
    assert.equal(
      await stat(join(sb.outside, 'nested/deep/new.md')).then(() => true, () => false),
      false,
      '根外不得创建嵌套文件',
    );
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S4-05：多级嵌套目录中存在的 junction —— 必须被拒绝
// ---------------------------------------------------------------------------
test('S4-05 多级嵌套目录中的 junction：读取与写入都必须拒绝', { skip: NOT_RUN_J }, async () => {
  const sb = await makeSandbox('nested');
  try {
    await mkdir(join(sb.root, 'a', 'b', 'c'), { recursive: true });
    await symlink(sb.outside, join(sb.root, 'a', 'b', 'c', 'escape'), 'junction');
    const provider = createLocalProvider({ rootDir: sb.root });
    const rel = 'a/b/c/escape/secret.md';

    assert.equal(await errCodeOf(() => provider.read(rel)), 'ERR_PATH_OUTSIDE_ROOT');

    const w = await provider.writeConditional('a/b/c/escape/deep.md', 'X\n', null);
    assert.equal(w.errorCode, 'ERR_PATH_OUTSIDE_ROOT');
    assert.equal(await stat(join(sb.outside, 'deep.md')).then(() => true, () => false), false);
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S4-06：正常项目目录、普通文件与合法创建必须保持可用（防过度修复）
// ---------------------------------------------------------------------------
test('S4-06 正常路径与合法创建不受影响（防过度修复）', async () => {
  const sb = await makeSandbox('normal');
  try {
    const provider = createLocalProvider({ rootDir: sb.root });
    await mkdir(join(sb.root, 'docs', 'sub'), { recursive: true });
    await writeFile(join(sb.root, 'docs', 'a.md'), 'v1\n', 'utf8');

    assert.equal((await provider.read('docs/a.md')).content, 'v1\n');
    assert.equal((await provider.stat('docs/a.md')).exists, true);

    const created = await provider.writeConditional('docs/sub/new.md', 'hello\n', null);
    assert.equal(created.status, 'COMMITTED');
    assert.equal(await readFile(join(sb.root, 'docs/sub/new.md'), 'utf8'), 'hello\n');

    // 合法递归创建
    const deep = await provider.writeConditional('docs/x/y/z/deep.md', 'deep\n', null);
    assert.equal(deep.status, 'COMMITTED');
    assert.equal(await readFile(join(sb.root, 'docs/x/y/z/deep.md'), 'utf8'), 'deep\n');

    // 条件写入的版本语义不变
    const v = (await provider.read('docs/a.md')).contentVersion;
    const updated = await provider.writeConditional('docs/a.md', 'v2\n', v);
    assert.equal(updated.status, 'COMMITTED');
    const stale = await provider.writeConditional('docs/a.md', 'v3\n', v);
    assert.equal(stale.status, 'CONFLICT', '过期版本仍必须 CONFLICT');

    assert.deepEqual(await provider.list(), ['docs/a.md', 'docs/sub/new.md', 'docs/x/y/z/deep.md']);
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S4-07：list 不得穿越不可信重解析点
// ---------------------------------------------------------------------------
test('S4-07 list 不得穿越 junction 访问根外内容', { skip: NOT_RUN_J }, async () => {
  const sb = await makeSandbox('list');
  try {
    await writeFile(join(sb.root, 'plain.md'), 'p\n', 'utf8');
    await mkdir(join(sb.root, 'normal'), { recursive: true });
    await writeFile(join(sb.root, 'normal', 'inner.md'), 'i\n', 'utf8');
    await writeFile(join(sb.outside, 'outside-only.md'), 'o\n', 'utf8');
    await symlink(sb.outside, join(sb.root, 'escape'), 'junction');

    const provider = createLocalProvider({ rootDir: sb.root });
    const listed = await provider.list();

    assert.ok(listed.includes('plain.md'), '正常文件必须被列出');
    assert.ok(listed.includes('normal/inner.md'), '正常子目录必须被递归列出');
    assert.equal(
      listed.some((p) => p.includes('outside-only') || p.startsWith('escape/')),
      false,
      `list 不得列出根外内容，实际: ${JSON.stringify(listed)}`,
    );
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S4-08：resolveInsideRoot 直接判定（边界函数的单元级证据）
// ---------------------------------------------------------------------------
test('S4-08 resolveInsideRoot 必须拒绝 junction 路径与其下的新路径', { skip: NOT_RUN_J }, async () => {
  const sb = await makeSandbox('resolve');
  try {
    await symlink(sb.outside, join(sb.root, 'escape'), 'junction');

    for (const rel of ['escape', 'escape/secret.md', 'escape/new.md', 'escape/a/b/c.md']) {
      const check = resolveInsideRoot(sb.root, rel);
      assert.equal(check.ok, false, `必须拒绝: ${rel}`);
      if (!check.ok) assert.equal(check.errorCode, 'ERR_PATH_OUTSIDE_ROOT');
    }

    // 正常路径仍可解析
    const ok = resolveInsideRoot(sb.root, 'docs/a.md');
    assert.equal(ok.ok, true);
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S4-09：stat 不得泄漏根外元数据，且必须以可识别错误拒绝
// ---------------------------------------------------------------------------
test('S4-09 stat 不得返回根外元数据（不得静默当作“不存在”）', { skip: NOT_RUN_J }, async () => {
  const sb = await makeSandbox('stat');
  try {
    await symlink(sb.outside, join(sb.root, 'escape'), 'junction');
    const provider = createLocalProvider({ rootDir: sb.root });

    const code = await errCodeOf(() => provider.stat('escape/secret.md'));
    assert.equal(code, 'ERR_PATH_OUTSIDE_ROOT', 'stat 必须以 ERR_PATH_OUTSIDE_ROOT 拒绝（可识别）');

    // 明确：不得以 exists:false 静默吞掉安全错误
    const st = await provider.stat('escape/secret.md').catch(() => null);
    assert.equal(st, null, 'stat 不得返回对象把安全错误伪装成“文件不存在”');
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S4-10 / S4-11：符号链接（与 junction 分开验证，不混为一个用例）
// ---------------------------------------------------------------------------
test('S4-10 目录符号链接指向根外：读取与写入必须拒绝', { skip: NOT_RUN_SD }, async () => {
  const sb = await makeSandbox('symdir');
  try {
    await symlink(sb.outside, join(sb.root, 'sydir'), 'dir');
    const provider = createLocalProvider({ rootDir: sb.root });

    assert.equal(await errCodeOf(() => provider.read('sydir/secret.md')), 'ERR_PATH_OUTSIDE_ROOT');
    const w = await provider.writeConditional('sydir/new.md', 'X\n', null);
    assert.equal(w.errorCode, 'ERR_PATH_OUTSIDE_ROOT');
    assert.equal(await stat(join(sb.outside, 'new.md')).then(() => true, () => false), false);
  } finally {
    await sb.cleanup();
  }
});

test('S4-11 文件符号链接指向根外文件：读取与写入必须拒绝', { skip: NOT_RUN_SF }, async () => {
  const sb = await makeSandbox('symfile');
  try {
    await symlink(sb.secretPath, join(sb.root, 'link.md'), 'file');
    const provider = createLocalProvider({ rootDir: sb.root });

    assert.equal(await errCodeOf(() => provider.read('link.md')), 'ERR_PATH_OUTSIDE_ROOT');

    const before = sha256(await readFile(sb.secretPath));
    await provider.writeConditional('link.md', 'OVERWRITTEN\n', null).catch(() => {});
    assert.equal(sha256(await readFile(sb.secretPath)), before, '根外文件不得被改写');
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S4-12：绝对 / UNC / 盘符相对 / 设备路径一律拒绝
// ---------------------------------------------------------------------------
test('S4-12 绝对路径、UNC、盘符相对与设备路径一律拒绝', () => {
  const root = process.cwd();
  const hostile = [
    'C:/Windows/win.ini',
    'C:relative-on-drive.md',
    '\\\\server\\share\\x.md',
    '\\rooted\\x.md',
    '\\\\?\\C:\\long\\x.md',
    '/etc/passwd',
    '../outside.md',
    'docs/../../outside.md',
  ];
  for (const p of hostile) {
    const check = resolveInsideRoot(root, p);
    assert.equal(check.ok, false, `必须拒绝: ${p}`);
    if (!check.ok) assert.equal(check.errorCode, 'ERR_PATH_OUTSIDE_ROOT');
  }
});

// ---------------------------------------------------------------------------
// S4-13：指向根内的 junction —— 本阶段保守策略（拒绝），并记录为既定行为
// ---------------------------------------------------------------------------
test('S4-13 指向根内的 junction：保守策略下同样拒绝（可预测，不静默放行）', { skip: NOT_RUN_J }, async () => {
  const sb = await makeSandbox('internal');
  try {
    await mkdir(join(sb.root, 'real'), { recursive: true });
    await writeFile(join(sb.root, 'real', 'x.md'), 'x\n', 'utf8');
    await symlink(join(sb.root, 'real'), join(sb.root, 'alias'), 'junction');

    const provider = createLocalProvider({ rootDir: sb.root });
    const code = await errCodeOf(() => provider.read('alias/x.md'));
    assert.equal(code, 'ERR_PATH_OUTSIDE_ROOT', '保守策略：根内 junction 也拒绝，避免信任边界歧义');

    // 直接路径仍可用
    assert.equal((await provider.read('real/x.md')).content, 'x\n');
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S4-14：list 显式指定 junction 目录 —— 必须拒绝，不得返回根外内容
// ---------------------------------------------------------------------------
test('S4-14 list 显式指定 junction 目录必须拒绝，不得返回根外内容', { skip: NOT_RUN_J }, async () => {
  const sb = await makeSandbox('listdir');
  try {
    await writeFile(join(sb.outside, 'outside-only.md'), 'OUTSIDE\n', 'utf8');
    await mkdir(join(sb.root, 'normal'), { recursive: true });
    await symlink(sb.outside, join(sb.root, 'escape'), 'junction');
    await symlink(sb.outside, join(sb.root, 'normal', 'escape2'), 'junction');

    const provider = createLocalProvider({ rootDir: sb.root });

    for (const dir of ['escape', 'escape/', 'normal/escape2']) {
      const code = await errCodeOf(() => provider.list(dir));
      assert.equal(code, 'ERR_PATH_OUTSIDE_ROOT', `list(${JSON.stringify(dir)}) 必须以 ERR_PATH_OUTSIDE_ROOT 拒绝`);

      // 副作用：绝不返回根外条目
      let listing: string[] = [];
      try {
        listing = await provider.list(dir);
      } catch {
        listing = [];
      }
      assert.equal(
        listing.some((p) => p.includes('outside-only')),
        false,
        `list(${JSON.stringify(dir)}) 不得列出根外内容: ${JSON.stringify(listing)}`,
      );
    }
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S4-15：正常目录（无任何链接）下四类操作行为不变
// ---------------------------------------------------------------------------
test('S4-15 正常项目目录中 read/stat/writeConditional/list 既有行为不变', async () => {
  const sb = await makeSandbox('unchanged');
  try {
    await mkdir(join(sb.root, 'normal', 'sub'), { recursive: true });
    await writeFile(join(sb.root, 'normal', 'a.md'), 'A\n', 'utf8');
    await writeFile(join(sb.root, 'normal', 'sub', 'b.md'), 'B\n', 'utf8');
    const provider = createLocalProvider({ rootDir: sb.root });

    // read
    assert.equal((await provider.read('normal/a.md')).content, 'A\n');

    // stat：存在 → exists:true；正常缺失 → exists:false（不得因为安全加固而抛错）
    assert.equal((await provider.stat('normal/a.md')).exists, true);
    assert.equal((await provider.stat('normal/missing.md')).exists, false, '正常缺失仍应是 exists:false');

    // writeConditional：新建与递归创建
    assert.equal((await provider.writeConditional('normal/c.md', 'C\n', null)).status, 'COMMITTED');
    assert.equal((await provider.writeConditional('normal/x/y/z.md', 'Z\n', null)).status, 'COMMITTED');

    // list：根、相对子目录都正常
    assert.deepEqual(await provider.list('normal/sub'), ['b.md']);
    assert.deepEqual(await provider.list('normal'), ['a.md', 'c.md', 'sub/b.md', 'x/y/z.md']);
    assert.ok((await provider.list()).includes('normal/a.md'));
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S4-16：stat 的安全错误在唯一调用方（document.detectExternalChange）不得被误认为“文件不存在”
// ---------------------------------------------------------------------------
test('S4-16 stat 安全错误不得被调用方误认为普通文件不存在', { skip: NOT_RUN_J }, async () => {
  const sb = await makeSandbox('caller');
  try {
    await symlink(sb.outside, join(sb.root, 'escape'), 'junction');
    const provider = createLocalProvider({ rootDir: sb.root });
    const doc = createDocumentService();

    // 经 junction 的会话：openSession 的 read 被拒 → 空缓冲（P1-8 既有行为，无内容泄漏）
    const v = await doc.openSession({
      resourceId: 'r-s4-16',
      path: 'escape/secret.md',
      provider,
    });
    assert.equal(doc.getBuffer(v.sessionId), '', 'openSession 不得读入根外内容');

    // 关键断言：安全错误必须冒泡为可识别错误，而不是被吞成 changed:false
    let thrown: string | null = null;
    let swallowed: { changed: boolean } | null = null;
    try {
      swallowed = await doc.detectExternalChange(v.sessionId);
    } catch (err) {
      thrown = (err as { errorCode?: string }).errorCode ?? 'THROW';
    }
    assert.equal(thrown, 'ERR_PATH_OUTSIDE_ROOT', '安全错误必须可被调用方识别');
    assert.equal(swallowed, null, '不得把安全错误静默转成 changed:false（等价于“文件不存在”）');

    // 正常文件仍返回 changed 结构
    await writeFile(join(sb.root, 'ok.md'), 'ok\n', 'utf8');
    const v2 = await doc.openSession({ resourceId: 'r-s4-16-ok', path: 'ok.md', provider });
    const normal = await doc.detectExternalChange(v2.sessionId);
    assert.equal(normal.changed, false);
    assert.match(String(normal.diskVersion), /^sha256:/);
  } finally {
    await sb.cleanup();
  }
});
