/**
 * UX-02C-03-P2-01-R1：Provider 层回收/恢复的目标占位归属与内部路径安全。
 *
 * 取证方式：真实临时磁盘 + 真实 `LocalProvider`。本套件断言的是"磁盘上发生了什么"，
 * 不使用 mock —— 外部替换用真删真建、链接用真 `symlinkSync`/`linkSync`，
 * 外部 sentinel 用真字节比对。
 *
 * 本套件对应四个阻断缺陷：
 * - P1-01：`trashEntry` / `restoreEntry` 占位建立后没有复核归属（Windows rename 会覆盖）；
 * - P1-02：内部所有权标记（`.ws-internal`）被链接替换后可把写入引到项目根之外；
 * - P2-05：opId 目录内部对象未经核验就被纳入回收事务；
 * - P2-06：`.gitignore` 只在首次创建时写入，崩溃后不会补写。
 */
import assert from 'node:assert/strict';
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createLocalProvider, type StorageFaultHooks, type StorageProvider } from '../../packages/storage/index.ts';

const OP = 'op-r1-prov-0001';
const MARKER = '.ws-internal';
const TRASH_DIR = '.weavespace';
const OWNER_MAGIC = 'weavespace-internal-trash-v1';

interface Ctx {
  base: string;
  root: string;
  /** 项目根之外的同卷目录：所有"外部对象"都放这里，便于断言字节未变。 */
  outside: string;
  provider: StorageProvider;
  /** 在"排他占位已建立、最终归属复核尚未执行"时执行一次。 */
  onAfterReserve(fn: (() => void) | null): void;
  payloadPath(opId?: string): string;
  markerPath(): string;
  trashOpDir(opId?: string): string;
  identityOf(path: string): Promise<string>;
}

async function withProvider(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-p2r1-prov-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'a.md'), '# a.md\n', 'utf8');

  let hook: (() => void) | null = null;
  const faults: StorageFaultHooks = {
    afterMoveReserve: () => {
      hook?.();
    },
  };
  const provider = createLocalProvider({ rootDir: root, providerId: 'local:probe', faults });

  const ctx: Ctx = {
    base,
    root,
    outside,
    provider,
    onAfterReserve(next) {
      hook = next;
    },
    payloadPath: (opId = OP) => join(root, TRASH_DIR, 'trash', opId, 'payload'),
    markerPath: () => join(root, TRASH_DIR, MARKER),
    trashOpDir: (opId = OP) => join(root, TRASH_DIR, 'trash', opId),
    async identityOf(path) {
      const value = await provider.identityOf!(path);
      assert.ok(value, `无法取得 ${path} 的身份`);
      return value;
    },
  };

  try {
    await fn(ctx);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function markerJson(identity: string): string {
  return `${JSON.stringify({ magic: OWNER_MAGIC, identity, createdAt: '2026-11-22T00:00:00.000Z' }, null, 2)}\n`;
}

/* ================================================================== */
/* P1-01：回收 / 恢复的占位归属复核                                      */
/* ================================================================== */

test('R1-01a 回收：占位被同名 0 字节外部文件替换 → 拒绝且绝不覆盖外部对象', async () => {
  await withProvider(async (h) => {
    const sourceIdentity = await h.identityOf('a.md');

    let reservedIno = '';
    let foreignIno = '';
    h.onAfterReserve(() => {
      // 外部进程删掉我们的占位，并放一个**同样 0 字节**的文件占住这个名字
      const before = lstatSync(h.payloadPath());
      reservedIno = `${before.dev}:${before.ino}`;
      unlinkSync(h.payloadPath());
      writeFileSync(h.payloadPath(), '', 'utf8');
      const after = lstatSync(h.payloadPath());
      foreignIno = `${after.dev}:${after.ino}`;
    });

    const res = await h.provider.trashEntry!(OP, 'a.md', sourceIdentity);
    h.onAfterReserve(null);

    assert.equal(res.status, 'REJECTED', `必须拒绝：${JSON.stringify(res)}`);
    assert.equal(res.errorCode, 'ERR_ENTRY_EXISTS');

    // 两个对象大小都是 0，但身份不同 —— 外观无法区分，只有 dev+ino 能
    assert.notEqual(reservedIno, foreignIno, '外部对象必须是另一个 inode');
    assert.equal(lstatSync(h.payloadPath()).size, 0);
    assert.equal(`${lstatSync(h.payloadPath()).dev}:${lstatSync(h.payloadPath()).ino}`, foreignIno, '外部对象必须原样保留');
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '');
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# a.md\n', '源文件不得被移走');
  });
});

test('R1-01b 回收：占位被删除（名字空出）→ 重新排他占位一次并成功移动', async () => {
  await withProvider(async (h) => {
    const sourceIdentity = await h.identityOf('a.md');
    h.onAfterReserve(() => {
      unlinkSync(h.payloadPath());
    });

    const res = await h.provider.trashEntry!(OP, 'a.md', sourceIdentity);
    h.onAfterReserve(null);

    assert.equal(res.status, 'MOVED', JSON.stringify(res));
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\n');
    assert.throws(() => lstatSync(join(h.root, 'a.md')), '源必须消失');
  });
});

test('R1-01c 恢复：目标占位被同名 0 字节外部文件替换 → 拒绝且外部文件字节不变', async () => {
  await withProvider(async (h) => {
    const sourceIdentity = await h.identityOf('a.md');
    assert.equal((await h.provider.trashEntry!(OP, 'a.md', sourceIdentity)).status, 'MOVED');
    const payloadIdentity = await h.identityOf(`.weavespace/trash/${OP}/payload`);

    h.onAfterReserve(() => {
      unlinkSync(join(h.root, 'a.md'));
      writeFileSync(join(h.root, 'a.md'), '', 'utf8');
    });

    const res = await h.provider.restoreEntry!(OP, 'a.md', payloadIdentity);
    h.onAfterReserve(null);

    assert.equal(res.status, 'REJECTED', `必须拒绝：${JSON.stringify(res)}`);
    assert.equal(res.errorCode, 'ERR_ENTRY_EXISTS');
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '', '外部 0 字节文件必须原样保留');
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\n', '回收区对象不得被消费');
  });
});

test('R1-01d 恢复：目标占位被删除 → 重新占位并成功恢复', async () => {
  await withProvider(async (h) => {
    const sourceIdentity = await h.identityOf('a.md');
    assert.equal((await h.provider.trashEntry!(OP, 'a.md', sourceIdentity)).status, 'MOVED');
    const payloadIdentity = await h.identityOf(`.weavespace/trash/${OP}/payload`);

    h.onAfterReserve(() => {
      unlinkSync(join(h.root, 'a.md'));
    });

    const res = await h.provider.restoreEntry!(OP, 'a.md', payloadIdentity);
    h.onAfterReserve(null);

    assert.equal(res.status, 'MOVED', JSON.stringify(res));
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# a.md\n');
    assert.throws(() => lstatSync(h.payloadPath()), 'payload 必须移出');
  });
});

/* ================================================================== */
/* P1-02：内部所有权标记不得把写入引到根外                                */
/* ================================================================== */

test('R1-02a marker 被符号链接替换（内容伪装成合法标记）→ 回收区不可用，外部 sentinel 一字节不变', async () => {
  await withProvider(async (h) => {
    const sentinel = join(h.outside, 'sentinel.json');
    // 内容合法但身份是伪造的：旧实现会"更新标记"并把写入穿透到外部文件
    const sentinelBytes = markerJson('0:0');
    writeFileSync(sentinel, sentinelBytes, 'utf8');
    mkdirSync(join(h.root, TRASH_DIR));
    await symlink(sentinel, h.markerPath(), 'file');

    const sourceIdentity = await h.identityOf('a.md');
    const res = await h.provider.trashEntry!(OP, 'a.md', sourceIdentity);

    assert.equal(res.status, 'REJECTED', JSON.stringify(res));
    assert.equal(res.errorCode, 'ERR_TRASH_UNAVAILABLE');
    assert.equal(readFileSync(sentinel, 'utf8'), sentinelBytes, '外部 sentinel 必须一字节不变');
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# a.md\n', '不得发生回收');
    assert.throws(() => lstatSync(h.payloadPath()), '不得创建 payload');
  });
});

test('R1-02b marker 被硬链接替换（内容合法但 inode 外部共享）→ 拒绝，外部文件不变', async () => {
  await withProvider(async (h) => {
    const sentinel = join(h.outside, 'sentinel.json');
    const sentinelBytes = markerJson('0:0');
    writeFileSync(sentinel, sentinelBytes, 'utf8');
    mkdirSync(join(h.root, TRASH_DIR));
    linkSync(sentinel, h.markerPath());

    assert.ok(lstatSync(h.markerPath()).nlink >= 2, '前提：marker 必须是硬链接');

    const sourceIdentity = await h.identityOf('a.md');
    const res = await h.provider.trashEntry!(OP, 'a.md', sourceIdentity);

    assert.equal(res.status, 'REJECTED', JSON.stringify(res));
    assert.equal(res.errorCode, 'ERR_TRASH_UNAVAILABLE');
    assert.equal(readFileSync(sentinel, 'utf8'), sentinelBytes, '外部文件不得被写穿');
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# a.md\n');
  });
});

test('R1-02c marker 被目录替换 → 回收区不可用（不是"标记缺失"）', async () => {
  await withProvider(async (h) => {
    mkdirSync(join(h.root, TRASH_DIR));
    mkdirSync(h.markerPath());

    const sourceIdentity = await h.identityOf('a.md');
    const res = await h.provider.trashEntry!(OP, 'a.md', sourceIdentity);

    assert.equal(res.status, 'REJECTED', JSON.stringify(res));
    assert.equal(res.errorCode, 'ERR_TRASH_UNAVAILABLE', '异常类型必须明确拒绝，不能当作标记缺失去重建');
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# a.md\n');
  });
});

test('R1-02d marker 身份变化（项目被复制）→ 用临时文件 + rename 安全更新，内容与目录身份一致', async () => {
  await withProvider(async (h) => {
    mkdirSync(join(h.root, TRASH_DIR));
    writeFileSync(h.markerPath(), markerJson('0:0'), 'utf8');
    const beforeIno = lstatSync(h.markerPath()).ino;

    const sourceIdentity = await h.identityOf('a.md');
    const res = await h.provider.trashEntry!(OP, 'a.md', sourceIdentity);
    assert.equal(res.status, 'MOVED', JSON.stringify(res));

    const owner = lstatSync(join(h.root, TRASH_DIR));
    const ownerIdentity = `${owner.dev}:${owner.ino}`;
    const parsed = JSON.parse(readFileSync(h.markerPath(), 'utf8')) as { magic: string; identity: string };
    assert.equal(parsed.magic, OWNER_MAGIC);
    assert.equal(parsed.identity, ownerIdentity, '标记必须记录当前目录身份');
    assert.notEqual(lstatSync(h.markerPath()).ino, beforeIno, '更新必须是替换（临时文件 + rename），不是原地写');
  });
});

test('R1-02e .gitignore 被符号链接替换 → 拒绝初始化，外部 sentinel 不变', async () => {
  await withProvider(async (h) => {
    const sentinel = join(h.outside, 'gitignore-sentinel');
    const bytes = 'DO NOT TOUCH\n';
    writeFileSync(sentinel, bytes, 'utf8');

    mkdirSync(join(h.root, TRASH_DIR));
    const owner = lstatSync(join(h.root, TRASH_DIR));
    writeFileSync(h.markerPath(), markerJson(`${owner.dev}:${owner.ino}`), 'utf8');
    await symlink(sentinel, join(h.root, TRASH_DIR, '.gitignore'), 'file');

    const sourceIdentity = await h.identityOf('a.md');
    const res = await h.provider.trashEntry!(OP, 'a.md', sourceIdentity);

    assert.equal(res.status, 'REJECTED', JSON.stringify(res));
    assert.equal(res.errorCode, 'ERR_TRASH_UNAVAILABLE');
    assert.equal(readFileSync(sentinel, 'utf8'), bytes, '外部 sentinel 必须一字节不变');
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# a.md\n');
  });
});

test('R1-02f 崩溃在"marker 已写、.gitignore 未写"之间：下次初始化必须补写', async () => {
  await withProvider(async (h) => {
    mkdirSync(join(h.root, TRASH_DIR));
    const owner = lstatSync(join(h.root, TRASH_DIR));
    writeFileSync(h.markerPath(), markerJson(`${owner.dev}:${owner.ino}`), 'utf8');
    assert.equal(readdirSync(join(h.root, TRASH_DIR)).includes('.gitignore'), false, '前提：尚无 .gitignore');

    const sourceIdentity = await h.identityOf('a.md');
    const res = await h.provider.trashEntry!(OP, 'a.md', sourceIdentity);
    assert.equal(res.status, 'MOVED', JSON.stringify(res));

    assert.equal(readFileSync(join(h.root, TRASH_DIR, '.gitignore'), 'utf8'), '*\n', '必须补写自忽略文件');
  });
});

/* ================================================================== */
/* P2-05：opId 目录内部对象核验                                          */
/* ================================================================== */

test('R1-05a opId 目录里存在陌生文件 → 拒绝，陌生文件与源文件都不变', async () => {
  await withProvider(async (h) => {
    mkdirSync(h.trashOpDir(), { recursive: true });
    const stranger = join(h.trashOpDir(), 'notes.md');
    writeFileSync(stranger, 'USER NOTES\n', 'utf8');

    const sourceIdentity = await h.identityOf('a.md');
    const res = await h.provider.trashEntry!(OP, 'a.md', sourceIdentity);

    assert.equal(res.status, 'REJECTED', JSON.stringify(res));
    assert.equal(res.errorCode, 'ERR_TRASH_UNAVAILABLE');
    assert.equal(readFileSync(stranger, 'utf8'), 'USER NOTES\n', '陌生文件不得被覆盖或删除');
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# a.md\n');
    assert.throws(() => lstatSync(h.payloadPath()));
  });
});

test('R1-05b manifest 的 opId 与目录不匹配 → 拒绝（不把别人的清单当自己的）', async () => {
  await withProvider(async (h) => {
    mkdirSync(h.trashOpDir(), { recursive: true });
    writeFileSync(
      join(h.trashOpDir(), 'manifest.json'),
      `${JSON.stringify({ magic: OWNER_MAGIC, opId: 'op-other-0002', originalPath: 'a.md', identity: '1:1' })}\n`,
      'utf8',
    );

    const sourceIdentity = await h.identityOf('a.md');
    const res = await h.provider.trashEntry!(OP, 'a.md', sourceIdentity);

    assert.equal(res.status, 'REJECTED', JSON.stringify(res));
    assert.equal(res.errorCode, 'ERR_TRASH_UNAVAILABLE');
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# a.md\n');
  });
});

test('R1-05c opId 目录被符号链接替换到根外 → 拒绝，外部目录不被写入', async () => {
  await withProvider(async (h) => {
    const externalDir = join(h.outside, 'external-op');
    mkdirSync(externalDir);
    mkdirSync(join(h.root, TRASH_DIR, 'trash'), { recursive: true });
    await symlink(externalDir, h.trashOpDir(), 'junction');

    const sourceIdentity = await h.identityOf('a.md');
    const res = await h.provider.trashEntry!(OP, 'a.md', sourceIdentity);

    assert.equal(res.status, 'REJECTED', JSON.stringify(res));
    assert.deepEqual(readdirSync(externalDir), [], '根外目录不得被写入任何内容');
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# a.md\n');
  });
});

test('R1-05d payload 位置被目录占据 → 拒绝，目录不被删除', async () => {
  await withProvider(async (h) => {
    mkdirSync(h.payloadPath(), { recursive: true });

    const sourceIdentity = await h.identityOf('a.md');
    const res = await h.provider.trashEntry!(OP, 'a.md', sourceIdentity);

    assert.equal(res.status, 'REJECTED', JSON.stringify(res));
    assert.equal(res.errorCode, 'ERR_TRASH_UNAVAILABLE');
    assert.ok(lstatSync(h.payloadPath()).isDirectory(), '目录必须原样保留');
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# a.md\n');
  });
});

/* ================================================================== */
/* P1-04：回收区身份探测必须是判别结果，不能把异常混成"不存在"            */
/* ================================================================== */

test('R1-06a trashPayloadFacts 区分 present / missing / unsafe', async () => {
  await withProvider(async (h) => {
    const sourceIdentity = await h.identityOf('a.md');
    assert.equal((await h.provider.trashEntry!(OP, 'a.md', sourceIdentity)).status, 'MOVED');

    const present = await h.provider.trashPayloadFacts!(OP);
    assert.equal(present.status, 'present');
    assert.equal(present.status === 'present' && present.identity, sourceIdentity);
    assert.equal(present.status === 'present' && present.size, '# a.md\n'.length);

    // 1) 被符号链接替换 → unsafe（不是 missing）
    unlinkSync(h.payloadPath());
    await symlink(join(h.outside, 'sentinel'), h.payloadPath(), 'file');
    const linked = await h.provider.trashPayloadFacts!(OP);
    assert.equal(linked.status, 'unsafe', JSON.stringify(linked));

    // 2) 被目录替换 → unsafe
    unlinkSync(h.payloadPath());
    mkdirSync(h.payloadPath());
    const asDir = await h.provider.trashPayloadFacts!(OP);
    assert.equal(asDir.status, 'unsafe', JSON.stringify(asDir));

    // 3) 真缺失 → missing
    await rm(h.payloadPath(), { recursive: true, force: true });
    const missing = await h.provider.trashPayloadFacts!(OP);
    assert.equal(missing.status, 'missing', JSON.stringify(missing));
  });
});

test('R1-06b payload 的父目录被符号链接替换到根外：unsafe，不得沿链接读出外部对象', async () => {
  await withProvider(async (h) => {
    const sourceIdentity = await h.identityOf('a.md');
    assert.equal((await h.provider.trashEntry!(OP, 'a.md', sourceIdentity)).status, 'MOVED');

    // 把 op 目录整体搬到根外，再用链接指回去：链接里的 payload 内容仍与原对象一致
    const externalDir = join(h.outside, 'external-op');
    mkdirSync(externalDir);
    writeFileSync(join(externalDir, 'payload'), '# a.md\n', 'utf8');
    await rm(h.trashOpDir(), { recursive: true, force: true });
    await symlink(externalDir, h.trashOpDir(), 'junction');

    const probe = await h.provider.trashPayloadFacts!(OP);
    assert.equal(probe.status, 'unsafe', '父链是链接时必须报 unsafe，绝不能报 present/missing');
  });
});

test('R1-02g 标记被链接替换后，恢复同样必须拒绝（回收区整体不可用）', async () => {
  await withProvider(async (h) => {
    const sourceIdentity = await h.identityOf('a.md');
    assert.equal((await h.provider.trashEntry!(OP, 'a.md', sourceIdentity)).status, 'MOVED');
    const payloadIdentity = await h.provider.trashPayloadFacts!(OP);
    assert.equal(payloadIdentity.status, 'present');

    const sentinel = join(h.outside, 'sentinel-restore.json');
    const sentinelBytes = markerJson('0:0');
    writeFileSync(sentinel, sentinelBytes, 'utf8');
    unlinkSync(h.markerPath());
    await symlink(sentinel, h.markerPath(), 'file');

    const res = await h.provider.restoreEntry!(OP, 'a.md', sourceIdentity);
    assert.equal(res.status, 'REJECTED', JSON.stringify(res));
    assert.equal(res.errorCode, 'ERR_TRASH_UNAVAILABLE');
    assert.equal(readFileSync(sentinel, 'utf8'), sentinelBytes, '外部 sentinel 必须一字节不变');
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\n', '回收区对象不得被搬走');
    assert.throws(() => lstatSync(join(h.root, 'a.md')), '不得恢复出文件');
  });
});
