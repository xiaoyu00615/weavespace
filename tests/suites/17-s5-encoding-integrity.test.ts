/**
 * S5：文件编码与数据完整性回归。
 *
 * 纪律：
 * - 本文件先于修复编写，基线源码上必须失败；
 * - 断言必须检查「真实磁盘字节 / SHA」与「返回状态」，不能只比对错误字符串；
 * - 只在自建临时目录内操作；不接触用户资产、不改 ACL、不提权；
 * - 无法构造的环境条件 → 该用例标 skip（NOT_RUN），不记为 PASS。
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalProvider } from '../../packages/storage/index.ts';
import { createDocumentService } from '../../packages/document/index.ts';
import { createHarness } from '../helpers.ts';

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const UFFFD = '\uFFFD';

const GBK = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]); // GBK「中文\n」
const LATIN1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // Latin-1「café\n」
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const NUL_TEXT = Buffer.from([0x61, 0x00, 0x62, 0x0a]); // 合法 UTF-8 但含 NUL

interface Sandbox {
  root: string;
  cleanup(): Promise<void>;
}

async function sandbox(tag: string): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), `s5-${tag}-`));
  return { root, cleanup: async () => rm(root, { recursive: true, force: true }).catch(() => {}) };
}

async function put(root: string, rel: string, bytes: Buffer): Promise<string> {
  const full = join(root, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, bytes);
  return full;
}

const errorCodeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return 'NO_ERROR';
  } catch (err) {
    return (err as { errorCode?: string }).errorCode ?? `RAW:${(err as NodeJS.ErrnoException).code}`;
  }
};

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

/** 由外部进程独占打开文件，制造真实的 EBUSY（不涉及 ACL / 提权）。 */
async function acquireExclusiveLock(filePath: string): Promise<{ release(): Promise<void> } | null> {
  const marker = `${filePath}.lock-ready`;
  const script =
    `$f=[IO.File]::Open('${filePath}','Open','ReadWrite','None'); ` +
    `Set-Content -LiteralPath '${marker}' -Value 1 -Encoding ascii; Start-Sleep -Seconds 30; $f.Close()`;
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: 'ignore',
  });
  const release = async () => {
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

// ---------------------------------------------------------------------------
// S5-01：GBK 原始字节 —— 读取必须拒绝，且不得被替换后返回
// ---------------------------------------------------------------------------
test('S5-01 GBK 字节：read 必须抛 ERR_ENCODING_UNSUPPORTED 且不返回替换字符', async () => {
  const sb = await sandbox('gbk');
  try {
    const file = await put(sb.root, 'gbk.txt', GBK);
    const provider = createLocalProvider({ rootDir: sb.root });

    assert.equal(await errorCodeOf(() => provider.read('gbk.txt')), 'ERR_ENCODING_UNSUPPORTED');

    // 副作用：读取被拒不得改变磁盘字节
    assert.equal(sha256(await readFile(file)), sha256(GBK));
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S5-02：Latin-1 单字节 —— 同上
// ---------------------------------------------------------------------------
test('S5-02 Latin-1 字节：read 必须抛 ERR_ENCODING_UNSUPPORTED', async () => {
  const sb = await sandbox('latin1');
  try {
    const file = await put(sb.root, 'latin1.txt', LATIN1);
    const provider = createLocalProvider({ rootDir: sb.root });

    assert.equal(await errorCodeOf(() => provider.read('latin1.txt')), 'ERR_ENCODING_UNSUPPORTED');
    assert.equal(sha256(await readFile(file)), sha256(LATIN1));
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S5-03 / S5-08：PNG 与含 NUL 的内容 —— 文本 API 必须拒绝，写入不得覆盖
// ---------------------------------------------------------------------------
test('S5-03 PNG 内容：read 抛 ERR_RESOURCE_NOT_TEXT，writeConditional 拒绝覆盖且字节不变', async () => {
  const sb = await sandbox('png');
  try {
    const file = await put(sb.root, 'image.png', PNG);
    const before = sha256(await readFile(file));
    const provider = createLocalProvider({ rootDir: sb.root });

    assert.equal(await errorCodeOf(() => provider.read('image.png')), 'ERR_RESOURCE_NOT_TEXT');

    const w = await provider.writeConditional('image.png', 'NOT-A-PNG\n', null);
    assert.equal(w.status, 'FAILED');
    assert.equal(w.errorCode, 'ERR_RESOURCE_NOT_TEXT');
    assert.equal(sha256(await readFile(file)), before, '被拒绝的写入不得改变字节');
  } finally {
    await sb.cleanup();
  }
});

test('S5-04 含 NUL 的内容：read 与 writeConditional 都必须拒绝（按非文本处理）', async () => {
  const sb = await sandbox('nul');
  try {
    const file = await put(sb.root, 'nul.txt', NUL_TEXT);
    const before = sha256(await readFile(file));
    const provider = createLocalProvider({ rootDir: sb.root });

    assert.equal(await errorCodeOf(() => provider.read('nul.txt')), 'ERR_RESOURCE_NOT_TEXT');

    const w = await provider.writeConditional('nul.txt', 'plain\n', null);
    assert.equal(w.status, 'FAILED');
    assert.equal(w.errorCode, 'ERR_RESOURCE_NOT_TEXT');
    assert.equal(sha256(await readFile(file)), before);

    // 直接写入含 NUL 的新内容同样必须拒绝（不得用文本 API 造二进制）
    const w2 = await provider.writeConditional('fresh.txt', 'a\u0000b\n', null);
    assert.equal(w2.status, 'FAILED');
    assert.equal(w2.errorCode, 'ERR_RESOURCE_NOT_TEXT');
    assert.equal(existsSync(join(sb.root, 'fresh.txt')), false);
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S5-05：BOM + CRLF 必须原样保留（不得删除或规范化）
// ---------------------------------------------------------------------------
test('S5-05 UTF-8 BOM 与 CRLF：往返字节完全一致，BOM 保留在内容中', async () => {
  const sb = await sandbox('bom');
  try {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 标题\r\n正文\r\n', 'utf8')]);
    const file = await put(sb.root, 'doc.md', bytes);
    const before = sha256(await readFile(file));

    const provider = createLocalProvider({ rootDir: sb.root });
    const read = await provider.read('doc.md');
    assert.equal(read.content.startsWith('\uFEFF'), true, 'BOM 必须保留为内容首字符');
    assert.equal(read.content.includes('\r\n'), true, 'CRLF 不得被规范化');
    assert.equal(read.contentVersion, `sha256:${before}`, 'contentVersion 必须基于原始磁盘字节');

    const doc = createDocumentService();
    const view = await doc.openSession({ resourceId: 'r-bom', path: 'doc.md', provider });
    const saved = await doc.save(view.sessionId, (b) => b);

    assert.equal(saved.status, 'COMMITTED');
    assert.equal(sha256(await readFile(file)), before, '未编辑保存后字节必须完全一致');
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S5-06：合法 U+FFFD 与非法字节必须区分（不得靠“含替换符”判定）
// ---------------------------------------------------------------------------
test('S5-06 合法 U+FFFD 可正常读写；非法字节被拒绝（两者必须区分）', async () => {
  const sb = await sandbox('fffd');
  try {
    const valid = Buffer.from(`替换符:${UFFFD}😀\n`, 'utf8');
    const file = await put(sb.root, 'valid.txt', valid);
    const before = sha256(await readFile(file));

    const provider = createLocalProvider({ rootDir: sb.root });
    const read = await provider.read('valid.txt');
    assert.equal(read.content.includes(UFFFD), true, '合法 U+FFFD 必须能读出来');

    const doc = createDocumentService();
    const view = await doc.openSession({ resourceId: 'r-fffd', path: 'valid.txt', provider });
    assert.equal((await doc.save(view.sessionId, (b) => b)).status, 'COMMITTED');
    assert.equal(sha256(await readFile(file)), before, '合法内容往返必须字节一致');

    // 同一 root 下的非法字节仍必须被拒绝
    await put(sb.root, 'bad.txt', LATIN1);
    assert.equal(await errorCodeOf(() => provider.read('bad.txt')), 'ERR_ENCODING_UNSUPPORTED');
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S5-07：openSession 不得把编码错误 / EBUSY 伪装成新建空会话
// ---------------------------------------------------------------------------
test('S5-07 openSession 遇编码错误：必须抛出且不创建会话；真正缺失仍可新建', async () => {
  const sb = await sandbox('open');
  try {
    await put(sb.root, 'gbk.txt', GBK);
    const provider = createLocalProvider({ rootDir: sb.root });
    const doc = createDocumentService();

    assert.equal(
      await errorCodeOf(() =>
        doc.openSession({ resourceId: 'r-gbk', path: 'gbk.txt', provider }),
      ),
      'ERR_ENCODING_UNSUPPORTED',
    );
    assert.equal(doc.getSessionByResource('r-gbk'), undefined, '失败时不得留下会话');

    // 真正不存在 → 合法新建空会话
    const fresh = await doc.openSession({ resourceId: 'r-new', path: 'new.md', provider });
    assert.equal(doc.getBuffer(fresh.sessionId), '');
    assert.equal(doc.getSession(fresh.sessionId)?.baseVersion, null);
  } finally {
    await sb.cleanup();
  }
});

test('S5-08 openSession 遇 EBUSY：必须抛 ERR_STORAGE_IO，不得生成虚假 CLEAN 会话', async (t) => {
  if (!HAS_POWERSHELL) {
    t.skip('NOT_RUN: 无法启动 PowerShell 持有独占句柄');
    return;
  }
  const sb = await sandbox('open-ebusy');
  let lock: { release(): Promise<void> } | null = null;
  try {
    const file = await put(sb.root, 'busy.md', Buffer.from('x\n', 'utf8'));
    const provider = createLocalProvider({ rootDir: sb.root });
    const doc = createDocumentService();

    lock = await acquireExclusiveLock(file);
    if (!lock) {
      t.skip('NOT_RUN: 独占句柄未能在超时内建立');
      return;
    }

    assert.equal(
      await errorCodeOf(() =>
        doc.openSession({ resourceId: 'r-busy', path: 'busy.md', provider }),
      ),
      'ERR_STORAGE_IO',
    );
    assert.equal(doc.getSessionByResource('r-busy'), undefined, '失败时不得留下 CLEAN 会话');
  } finally {
    await lock?.release();
    await sleep(100);
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S5-09：reconcile 必须按字节判断；无法确认时保持 UNKNOWN
// ---------------------------------------------------------------------------
test('S5-09 reconcile：磁盘被换成非法字节时必须 UNKNOWN，不得报 APPLIED', async () => {
  const sb = await sandbox('reconcile');
  try {
    const file = await put(sb.root, 'doc.md', Buffer.from('v1\n', 'utf8'));
    const provider = createLocalProvider({ rootDir: sb.root });
    const doc = createDocumentService();
    const view = await doc.openSession({ resourceId: 'r-rec', path: 'doc.md', provider });

    // 基线行为：APPLIED / NOT_APPLIED 二选一，绝不会是 UNKNOWN
    // 修复后：磁盘无法按文本读取 → UNKNOWN
    await writeFile(file, Buffer.from([0xff, 0xfe, 0x00]));

    const rec = await doc.reconcile(view.sessionId, (b) => b);
    assert.equal(rec.outcome, 'UNKNOWN', '无法确认磁盘状态时必须保持 UNKNOWN');
    assert.equal(doc.getSession(view.sessionId)?.state, 'CLEAN', 'UNKNOWN 不得自动改变会话状态');
  } finally {
    await sb.cleanup();
  }
});

test('S5-10 reconcile：内容未变时仍必须 APPLIED（防过度修复）', async () => {
  const sb = await sandbox('reconcile-ok');
  try {
    await put(sb.root, 'doc.md', Buffer.from('v1\n', 'utf8'));
    const provider = createLocalProvider({ rootDir: sb.root });
    const doc = createDocumentService();
    const view = await doc.openSession({ resourceId: 'r-rec-ok', path: 'doc.md', provider });

    const rec = await doc.reconcile(view.sessionId, (b) => b);
    assert.equal(rec.outcome, 'APPLIED');
    assert.equal(rec.dirty, false);
    assert.equal(doc.getSession(view.sessionId)?.state, 'CLEAN');
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S5-11：未配对代理项不得被静默编码成替换字符
// ---------------------------------------------------------------------------
test('S5-11 未配对代理项：save 与 writeConditional 都必须拒绝，磁盘不变', async () => {
  const sb = await sandbox('surrogate');
  try {
    const file = await put(sb.root, 'doc.md', Buffer.from('ok\n', 'utf8'));
    const before = sha256(await readFile(file));
    const provider = createLocalProvider({ rootDir: sb.root });
    const doc = createDocumentService();
    const view = await doc.openSession({ resourceId: 'r-sur', path: 'doc.md', provider });

    doc.applyEdit(view.sessionId, 'bad\uD800text');
    const saved = await doc.save(view.sessionId, (b) => b);
    assert.equal(saved.status, 'FAILED', '未配对代理项不得被静默替换后落盘');
    assert.equal(saved.errorCode, 'ERR_ENCODING_UNSUPPORTED');
    assert.equal(sha256(await readFile(file)), before, '失败时磁盘字节不得变化');

    const direct = await provider.writeConditional('doc.md', 'x\uDC00y', null);
    assert.equal(direct.status, 'FAILED');
    assert.equal(direct.errorCode, 'ERR_ENCODING_UNSUPPORTED');
    assert.equal(sha256(await readFile(file)), before);
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S5-12：正常 UTF-8 流程（创建 / 编辑 / 保存 / 冲突 / UNKNOWN）不受影响
// ---------------------------------------------------------------------------
test('S5-12 正常 UTF-8：创建、编辑、保存、冲突与 UNKNOWN 行为不变', async () => {
  const h = await createHarness();
  try {
    const created = await h.provider.writeConditional('a.md', 'v1\n', null);
    assert.equal(created.status, 'COMMITTED');

    const view = await h.document.openSession({ resourceId: 'r-normal', path: 'a.md', provider: h.provider });
    h.document.applyEdit(view.sessionId, 'v2\n');
    const saved = await h.document.save(view.sessionId, (b) => b);
    assert.equal(saved.status, 'COMMITTED');
    assert.equal(await readFile(join(h.root, 'a.md'), 'utf8'), 'v2\n');

    const createdVersion = created.contentVersion;
    assert.ok(createdVersion, 'COMMITTED 必须返回 contentVersion');
    const stale = await h.provider.writeConditional('a.md', 'v3\n', createdVersion);
    assert.equal(stale.status, 'CONFLICT', '版本冲突语义不得改变');
    assert.equal(await readFile(join(h.root, 'a.md'), 'utf8'), 'v2\n');
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// S5-13：Command 入口不得把未知 serializerId 静默回退为 identity
// ---------------------------------------------------------------------------
test('S5-13 document.save：未知 serializerId 必须 REJECTED，不得回退 identity 直写', async () => {
  const h = await createHarness();
  try {
    h.permission.grant({ actorId: 'user-a', action: 'read', scope: '' });
    h.permission.grant({ actorId: 'user-a', action: 'write', scope: '' });
    await h.provider.writeConditional('cmd.md', 'v1\n', null);

    const opened = await h.bus.dispatch(
      { commandId: 'cmd-open', type: 'document.open', payload: { path: 'cmd.md' } },
      { actorId: 'user-a' },
    );
    assert.equal(opened.status, 'APPLIED');
    const sessionId = (opened.result as { sessionId: string }).sessionId;

    const rejected = await h.bus.dispatch(
      {
        commandId: 'cmd-save-unknown',
        type: 'document.save',
        expectedVersion: h.document.getSession(sessionId)!.baseVersion!,
        payload: { sessionId, serializerId: 'no-such-serializer' },
      },
      { actorId: 'user-a' },
    );
    assert.equal(rejected.status, 'REJECTED', '未知 serializerId 不得静默回退 identity');
    assert.equal(rejected.errorCode, 'ERR_COMMAND_INVALID');
    assert.equal(await readFile(join(h.root, 'cmd.md'), 'utf8'), 'v1\n');
  } finally {
    await h.cleanup();
  }
});
