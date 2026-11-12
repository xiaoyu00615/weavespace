/**
 * S4-R2：stat / 版本读取的错误语义回归。
 *
 * 规则：只有「目标确实不存在」才是 exists:false；无法判定（EPERM/EACCES/EBUSY/…）
 * 必须以可识别错误码抛出，不得伪装成文件不存在。
 *
 * 环境限制：
 * - EBUSY 用「另一个进程独占打开该文件」构造（PowerShell 同步 API，不涉及 ACL、不提权）；
 * - EPERM/EACCES 需要修改临时文件 ACL，本轮未获授权 → 标记 NOT_RUN，仅用映射单元测试覆盖分类。
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalProvider } from '../../packages/storage/index.ts';
import * as LP from '../../packages/storage/local-provider.ts';
import { createDocumentService } from '../../packages/document/index.ts';

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 新 API 在修复前不存在：用宽松访问避免整个套件因导入失败而中断。 */
const mapStorageError = (LP as unknown as {
  mapStorageError?: (err: unknown) => string | undefined;
}).mapStorageError;

const HAS_POWERSHELL =
  process.platform === 'win32' &&
  (() => {
    try {
      return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
        windowsHide: true,
      }).status === 0;
    } catch {
      return false;
    }
  })();

interface Lock {
  release(): Promise<void>;
}

/**
 * 由外部进程以 FileShare.None 独占打开文件，制造真实的共享冲突（EBUSY）。
 * 通过就绪标记文件确认句柄已持有，避免时序竞态。
 */
async function acquireExclusiveLock(filePath: string): Promise<Lock | null> {
  const marker = `${filePath}.lock-ready`;
  const script =
    `$f=[IO.File]::Open('${filePath}','Open','ReadWrite','None'); ` +
    `Set-Content -LiteralPath '${marker}' -Value 1 -Encoding ascii; ` +
    `Start-Sleep -Seconds 30; $f.Close()`;
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: 'ignore',
  });
  const release = async (): Promise<void> => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    await rm(marker, { force: true }).catch(() => {});
  };

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(marker)) return { release };
    if (child.exitCode !== null) break;
    await sleep(50);
  }
  await release();
  return null;
}

const codeOf = (err: unknown): string | undefined => (err as { errorCode?: string }).errorCode;

/** 进程被终止后句柄释放是异步的：等到目标重新可读再断言磁盘内容。 */
async function waitUntilReadable(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await readFile(file);
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await sleep(50);
    }
  }
}

async function makeRoot(tag: string) {
  const base = await mkdtemp(join(tmpdir(), `s4r2-${tag}-`));
  const file = join(base, 'doc.md');
  await writeFile(file, 'ORIGINAL\n', 'utf8');
  return { base, file };
}

const NOT_RUN_PS = 'NOT_RUN: 无法启动 PowerShell 持有独占句柄（不涉及 ACL/提权，仅共享冲突）';
const NOT_RUN_ACL = 'NOT_RUN: 需要修改临时文件 ACL（EPERM/EACCES），未获本轮授权';

// ---------------------------------------------------------------------------
// S4R2-01：正常缺失仍是 exists:false（防过度修复）
// ---------------------------------------------------------------------------
test('S4R2-01 stat 正常缺失返回 exists:false', async () => {
  const { base } = await makeRoot('missing');
  try {
    const provider = createLocalProvider({ rootDir: base });
    const st = await provider.stat('nope.md');
    assert.deepEqual(st, { exists: false, size: 0, mtimeMs: 0, contentVersion: null });
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// S4R2-02：正常存在仍是 exists:true 且带内容版本
// ---------------------------------------------------------------------------
test('S4R2-02 stat 已存在文件返回 exists:true 与内容版本', async () => {
  const { base } = await makeRoot('exists');
  try {
    const provider = createLocalProvider({ rootDir: base });
    const st = await provider.stat('doc.md');
    assert.equal(st.exists, true);
    assert.equal(st.contentVersion, `sha256:${sha256('ORIGINAL\n')}`);
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// S4R2-03：EBUSY —— 已存在但无法读取内容时，stat 不得返回 exists:false
// ---------------------------------------------------------------------------
test('S4R2-03 stat 遇到 EBUSY：必须抛 ERR_STORAGE_IO，不得伪装成不存在', async (t) => {
  if (!HAS_POWERSHELL) {
    t.skip(NOT_RUN_PS);
    return;
  }
  const { base, file } = await makeRoot('ebusy-stat');
  let lock: Lock | null = null;
  try {
    const provider = createLocalProvider({ rootDir: base });
    lock = await acquireExclusiveLock(file);
    if (!lock) {
      t.skip('NOT_RUN: 独占句柄未能在超时内建立');
      return;
    }

    await assert.rejects(
      () => provider.stat('doc.md'),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_STORAGE_IO',
      'EBUSY 必须映射为 ERR_STORAGE_IO，而不是 exists:false',
    );
  } finally {
    await lock?.release();
    await waitUntilReadable(file).catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// S4R2-04：read 的错误映射必须与 stat 一致
// ---------------------------------------------------------------------------
test('S4R2-04 read 遇到 EBUSY：必须抛 ERR_STORAGE_IO（与 stat 一致）', async (t) => {
  if (!HAS_POWERSHELL) {
    t.skip(NOT_RUN_PS);
    return;
  }
  const { base, file } = await makeRoot('ebusy-read');
  let lock: Lock | null = null;
  try {
    const provider = createLocalProvider({ rootDir: base });
    lock = await acquireExclusiveLock(file);
    if (!lock) {
      t.skip('NOT_RUN: 独占句柄未能在超时内建立');
      return;
    }

    await assert.rejects(
      () => provider.read('doc.md'),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_STORAGE_IO',
    );
  } finally {
    await lock?.release();
    await waitUntilReadable(file).catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// S4R2-05：writeConditional 的版本读取失败不得导致覆盖
// ---------------------------------------------------------------------------
test('S4R2-05 writeConditional 版本读取失败：FAILED 且磁盘内容与 SHA 不变', async (t) => {
  if (!HAS_POWERSHELL) {
    t.skip(NOT_RUN_PS);
    return;
  }
  const { base, file } = await makeRoot('ebusy-write');
  let lock: Lock | null = null;
  try {
    const provider = createLocalProvider({ rootDir: base });
    const before = sha256(await readFile(file));
    lock = await acquireExclusiveLock(file);
    if (!lock) {
      t.skip('NOT_RUN: 独占句柄未能在超时内建立');
      return;
    }

    const result = await provider.writeConditional('doc.md', 'OVERWRITE\n', null);
    assert.equal(result.status, 'FAILED', '版本无法确认时不得当作“创建”放行');
    assert.notEqual(result.errorCode, undefined);

    await lock.release();
    lock = null;
    await waitUntilReadable(file);
    assert.equal(sha256(await readFile(file)), before, '磁盘内容必须保持原样');
    assert.equal(await readFile(file, 'utf8'), 'ORIGINAL\n');
  } finally {
    await lock?.release();
    await waitUntilReadable(file).catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// S4R2-06：detectExternalChange 遇到无法确认的磁盘状态必须抛错，不得 changed:false
// ---------------------------------------------------------------------------
test('S4R2-06 detectExternalChange 遇 EBUSY：必须抛出可识别错误，不得返回 changed:false', async (t) => {
  if (!HAS_POWERSHELL) {
    t.skip(NOT_RUN_PS);
    return;
  }
  const { base, file } = await makeRoot('ebusy-detect');
  let lock: Lock | null = null;
  try {
    const provider = createLocalProvider({ rootDir: base });
    const doc = createDocumentService();
    const view = await doc.openSession({ resourceId: 'r-ebusy', path: 'doc.md', provider });
    lock = await acquireExclusiveLock(file);
    if (!lock) {
      t.skip('NOT_RUN: 独占句柄未能在超时内建立');
      return;
    }

    let returned: unknown = null;
    let thrown: string | undefined;
    try {
      returned = await doc.detectExternalChange(view.sessionId);
    } catch (err) {
      thrown = codeOf(err);
    }
    assert.equal(returned, null, '不得把无法确认的磁盘状态报成 changed:false');
    assert.equal(thrown, 'ERR_STORAGE_IO', '必须以可识别错误冒泡');
  } finally {
    await lock?.release();
    await waitUntilReadable(file).catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// S4R2-07：错误分类的单元级证据（EPERM/EACCES 集成需 ACL，未获授权）
// ---------------------------------------------------------------------------
test('S4R2-07 mapStorageError：EPERM/EACCES→权限，EBUSY/EIO→IO，ENOENT→不存在', () => {
  assert.equal(typeof mapStorageError, 'function', '必须提供统一的 OS 错误映射函数');
  const withCode = (code: string) => Object.assign(new Error(`mock ${code}`), { code });

  for (const code of ['EPERM', 'EACCES']) {
    assert.equal(mapStorageError?.(withCode(code)), 'ERR_PERMISSION_DENIED', `${code} 应映射为权限错误`);
  }
  for (const code of ['EBUSY', 'EIO', 'ENOSPC', 'EMFILE', 'ENAMETOOLONG']) {
    assert.equal(mapStorageError?.(withCode(code)), 'ERR_STORAGE_IO', `${code} 应映射为 IO 错误`);
  }
  assert.equal(mapStorageError?.(withCode('ENOENT')), 'ERR_RESOURCE_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// S4R2-08：EPERM/EACCES 的真实集成用例（需要 ACL，等待授权）
// ---------------------------------------------------------------------------
test('S4R2-08 stat 遇到 EACCES：必须抛 ERR_PERMISSION_DENIED', { skip: NOT_RUN_ACL }, async () => {
  // 说明：构造 EACCES 需要对本进程拒绝 READ_DATA 的 ACL；本轮禁止修改 ACL / 使用真实用户令牌，
  // 因此本用例保持 NOT_RUN。分类逻辑已由 S4R2-07 覆盖。
  //
  // 将来授权后必须重新实现真正的断言（设置 ACL → 断言 stat 抛 ERR_PERMISSION_DENIED →
  // finally 回滚 ACE），不得仅删除 skip 标记就计为 PASS。
  const base = await mkdtemp(join(tmpdir(), 's4r2-eacces-'));
  try {
    const provider = createLocalProvider({ rootDir: base });
    await provider.stat('unreachable.md');
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// S4R2-09（F01）：可控窗口 —— stat 已确认普通文件后、读版本前被外部删除
//   修复后：不得返回 { exists:true, contentVersion:null }；
//           重新核验确认消失 → 返回一致的 exists:false。
// ---------------------------------------------------------------------------
test('S4R2-09 窗口内文件被删除：stat 不得返回 exists:true + contentVersion:null', async () => {
  const { base, file } = await makeRoot('f01-delete');
  try {
    const provider = createLocalProvider({
      rootDir: base,
      faults: {
        // 精确注入「stat 已确认存在、版本尚未读取」的窗口
        afterStat: () => {
          rmSync(file, { force: true });
        },
      },
    });

    const st = await provider.stat('doc.md');
    assert.equal(
      st.exists === true && st.contentVersion === null,
      false,
      '不得返回自相矛盾的 { exists:true, contentVersion:null }',
    );
    assert.deepEqual(st, { exists: false, size: 0, mtimeMs: 0, contentVersion: null });

    // 一致性：同一目标此时确实不在磁盘上
    assert.equal(existsSync(file), false);

    // 创建语义保留：写入一个确实不存在的路径仍然 COMMITTED
    const created = await provider.writeConditional('fresh.md', 'FRESH\n', null);
    assert.equal(created.status, 'COMMITTED');

    // 已存在文件仍然 CONFLICT，不会因窗口注入而放宽
    const conflict = await provider.writeConditional('fresh.md', 'AGAIN\n', null);
    assert.equal(conflict.status, 'CONFLICT');
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// S4R2-10（F01）：同一注入窗口下，**修复前算法**的结果快照
//   目的：固定缺陷形态——旧实现 stat 成功 + versionAt(ENOENT→null) 会产出
//   { exists:true, contentVersion:null }。此用例复现旧算法，不对应修复后产品路径。
// ---------------------------------------------------------------------------
test('S4R2-10 旧实现算法在同一窗口下确实产出 exists:true + contentVersion:null', async () => {
  const { base, file } = await makeRoot('f01-legacy');
  try {
    const s = await stat(file); // 旧实现第一步：确认存在
    rmSync(file, { force: true }); // 窗口内被外部删除

    // 旧实现第二步：versionAt() 把 ENOENT 解释成 null，并原样放进 exists:true 的结果里
    let legacyVersion: string | null = null;
    try {
      legacyVersion = `sha256:${sha256(await readFile(file))}`;
    } catch (err) {
      const osCode = (err as NodeJS.ErrnoException).code;
      legacyVersion = osCode === 'ENOENT' ? null : `ERR:${osCode}`;
    }

    const legacyShape = { exists: true, size: s.size, mtimeMs: s.mtimeMs, contentVersion: legacyVersion };
    assert.equal(legacyShape.exists, true);
    assert.equal(legacyShape.contentVersion, null, '旧算法在此窗口下必然返回 contentVersion:null');
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// S4R2-11（F01）：窗口内被替换为目录 —— 非 ENOENT 失败不得被当作“不存在”
// ---------------------------------------------------------------------------
test('S4R2-11 窗口内被替换为目录：stat 必须抛 ERR_STORAGE_IO，不得当作不存在', async () => {
  const { base, file } = await makeRoot('f01-replace');
  try {
    const provider = createLocalProvider({
      rootDir: base,
      faults: {
        afterStat: () => {
          rmSync(file, { force: true });
          mkdirSync(file); // 同名目录替换原文件
        },
      },
    });

    await assert.rejects(
      () => provider.stat('doc.md'),
      (err: { errorCode?: string; code?: string }) =>
        err.errorCode === 'ERR_STORAGE_IO' || err.errorCode === 'ERR_PERMISSION_DENIED',
      'EISDIR/EPERM 等非 ENOENT 失败不得退化成 exists:false',
    );
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// S4R2-12（F05）：版本读取得到 ENOENT、重新核验时目标已变成非普通文件
//   已确认存在的对象变成目录/其他类型，不得解释为“不存在”（返回 null）。
// ---------------------------------------------------------------------------
test('S4R2-12 重新核验时目标变为非普通文件：必须抛 ERR_STORAGE_IO，不得当作不存在', async () => {
  const { base, file } = await makeRoot('f05-notfile');
  try {
    const provider = createLocalProvider({
      rootDir: base,
      faults: {
        // 版本读取阶段：文件已被删除 → readFile 得到 ENOENT
        afterStat: () => {
          rmSync(file, { force: true });
        },
        // 重新核验之前：同路径被建为目录 → re-stat 看到的是非普通文件
        beforeReverify: () => {
          mkdirSync(file);
        },
      },
    });

    await assert.rejects(
      () => provider.stat('doc.md'),
      (err: { errorCode?: string }) => err.errorCode === 'ERR_STORAGE_IO',
      '从普通文件变为目录属于无法确认的一致状态，必须抛可识别错误',
    );

    // 不得因为该窗口而删除/伪造任何对象：目录仍然存在
    assert.equal(existsSync(file), true);
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});
