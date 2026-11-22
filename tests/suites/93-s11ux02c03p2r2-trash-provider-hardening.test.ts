/**
 * UX-02C-03-P2-01-R2：回收/恢复占位语义、恢复前完整性核验、内部写盘临时文件复核。
 *
 * 取证方式：真实临时磁盘 + 真实 `LocalProvider`，全部用真删真建、真 `symlink`/`link`、
 * 真字节比对，不使用 mock。故障注入只走 Provider 已有的测试钩子
 * （`reserveFault` / `beforeOwnWriteRename`），不 patch 全局 `fs`。
 *
 * 对应缺陷：
 * - R2-02：`trashEntry` / `restoreEntry` 的占位 `close` 失败被压成普通 REJECTED；
 * - R2-03：恢复前没有核验 opId 目录内容与 `manifest.json`；
 * - R2-04：`rename` 之前没有复核临时文件身份（可被换成任意对象顶替标记）。
 */
import assert from 'node:assert/strict';
import {
  appendFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createLocalProvider, type StorageFaultHooks, type StorageProvider } from '../../packages/storage/index.ts';

const OP = 'op-r2-prov-0001';
/** 夹具文件 `a.md` 的字节数（恢复时三方一致校验的基准）。 */
const SOURCE_SIZE = Buffer.byteLength('# a.md\n');
const MARKER = '.ws-internal';
const TRASH_DIR = '.weavespace';

type ReserveStage = 'beforeStat' | 'beforeClose';

interface Ctx {
  base: string;
  root: string;
  /** 项目根之外的同卷目录：所有"外部对象"与 sentinel 都放这里。 */
  outside: string;
  provider: StorageProvider;
  onReserveFault(fn: ((stage: ReserveStage, attempt: 1 | 2) => void) | null): void;
  onBeforeOwnWriteRename(fn: ((paths: { tmpAbs: string; targetAbs: string }) => Promise<void> | void) | null): void;
  payloadPath(opId?: string): string;
  opDir(opId?: string): string;
  manifestPath(opId?: string): string;
  markerPath(): string;
  identityOf(path: string): Promise<string>;
}

async function withProvider(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-p2r2-prov-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'a.md'), '# a.md\n', 'utf8');

  let reserveHook: ((stage: ReserveStage, attempt: 1 | 2) => void) | null = null;
  let ownWriteHook: ((paths: { tmpAbs: string; targetAbs: string }) => Promise<void> | void) | null = null;
  const faults: StorageFaultHooks = {
    reserveFault: (stage, attempt) => reserveHook?.(stage, attempt),
    beforeOwnWriteRename: async (paths) => {
      await ownWriteHook?.(paths);
    },
  };
  const provider = createLocalProvider({ rootDir: root, providerId: 'local:r2', faults });

  const ctx: Ctx = {
    base,
    root,
    outside,
    provider,
    onReserveFault(next) {
      reserveHook = next;
    },
    onBeforeOwnWriteRename(next) {
      ownWriteHook = next;
    },
    payloadPath: (opId = OP) => join(root, TRASH_DIR, 'trash', opId, 'payload'),
    opDir: (opId = OP) => join(root, TRASH_DIR, 'trash', opId),
    manifestPath: (opId = OP) => join(root, TRASH_DIR, 'trash', opId, 'manifest.json'),
    markerPath: () => join(root, TRASH_DIR, MARKER),
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

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function sizeOf(path: string): number {
  return lstatSync(path).size;
}

/** 磁盘上的真实对象身份（Provider 的 `identityOf` 只接受项目内相对路径）。 */
function diskIdentity(path: string): string {
  const info = lstatSync(path);
  return `${info.dev}:${info.ino}`;
}

/* ================================================================== */
/* R2-02：占位 close 失败必须收敛为 UNKNOWN                              */
/* ================================================================== */

test('R2-02a 回收：占位 close 失败 → UNKNOWN，不 rename、不谎报零变更', async () => {
  await withProvider(async (h) => {
    const identity = await h.identityOf('a.md');
    let fired = 0;
    h.onReserveFault((stage) => {
      if (stage !== 'beforeClose') return;
      fired += 1;
      throw new Error('注入：占位句柄关闭失败');
    });

    const res = await h.provider.trashEntry!(OP, 'a.md', identity);
    h.onReserveFault(null);

    assert.equal(fired, 1, '注入点必须真的被执行（否则等于没测）');
    assert.equal(res.status, 'UNKNOWN', `必须是不确定，而不是失败或成功：${JSON.stringify(res)}`);
    assert.equal(res.errorCode, 'ERR_OUTCOME_UNKNOWN');
    assert.notEqual(res.status, 'REJECTED', '已经创建了占位就不能再报"什么都没发生"');

    // 源文件没有被搬走：rename 不得执行
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# a.md\n');
    // 占位只能是我们自己的 0 字节对象，绝不能是源文件内容
    if (exists(h.payloadPath())) {
      assert.equal(sizeOf(h.payloadPath()), 0, '回收区里不得出现源文件的字节');
    }
    // 清单不得被写入：事务没有推进到那一步
    assert.equal(exists(h.manifestPath()), false, '占位未确认时不得写清单');
  });
});

test('R2-02b 恢复：占位 close 失败 → UNKNOWN，回收区对象不被移动', async () => {
  await withProvider(async (h) => {
    const sourceIdentity = await h.identityOf('a.md');
    assert.equal((await h.provider.trashEntry!(OP, 'a.md', sourceIdentity)).status, 'MOVED');
    const payloadIdentity = diskIdentity(h.payloadPath());
    assert.equal(payloadIdentity, sourceIdentity);

    let fired = 0;
    h.onReserveFault((stage) => {
      if (stage !== 'beforeClose') return;
      fired += 1;
      throw new Error('注入：目标占位关闭失败');
    });

    const res = await h.provider.restoreEntry!(OP, 'a.md', payloadIdentity, SOURCE_SIZE);
    h.onReserveFault(null);

    assert.equal(fired, 1);
    assert.equal(res.status, 'UNKNOWN', JSON.stringify(res));
    // 回收区对象原样留在原处（字节与身份都不变）
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\n');
    assert.equal(diskIdentity(h.payloadPath()), payloadIdentity);
    // 目标位置绝不能出现源文件内容
    if (exists(join(h.root, 'a.md'))) {
      assert.equal(sizeOf(join(h.root, 'a.md')), 0, '恢复未完成时目标位置只能是占位');
    }
  });
});

/* ================================================================== */
/* R2-03：恢复前的只读完整性核验                                         */
/* ================================================================== */

/** 先正常回收，再由 `tamper` 破坏回收区，最后尝试恢复。 */
async function trashTamperRestore(
  h: Ctx,
  tamper: (ctx: Ctx) => void | Promise<void>,
): Promise<{ result: Awaited<ReturnType<NonNullable<StorageProvider['restoreEntry']>>>; identity: string }> {
  const identity = await h.identityOf('a.md');
  assert.equal((await h.provider.trashEntry!(OP, 'a.md', identity)).status, 'MOVED');
  await tamper(h);
  const result = await h.provider.restoreEntry!(OP, 'a.md', identity, SOURCE_SIZE);
  return { result, identity };
}

function manifestOf(h: Ctx): Record<string, unknown> {
  return JSON.parse(readFileSync(h.manifestPath(), 'utf8')) as Record<string, unknown>;
}

function writeManifest(h: Ctx, row: Record<string, unknown>): void {
  writeFileSync(h.manifestPath(), `${JSON.stringify(row, null, 2)}\n`, 'utf8');
}

test('R2-03z 正常回收后恢复仍然成功（安全校验没有破坏原有功能）', async () => {
  await withProvider(async (h) => {
    const identity = await h.identityOf('a.md');
    assert.equal((await h.provider.trashEntry!(OP, 'a.md', identity)).status, 'MOVED');
    const res = await h.provider.restoreEntry!(OP, 'a.md', identity, SOURCE_SIZE);
    assert.equal(res.status, 'MOVED', JSON.stringify(res));
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# a.md\n');
    assert.equal(exists(h.payloadPath()), false);
  });
});

test('R2-03a opId 目录被塞入陌生文件 → 拒绝恢复且不删除陌生对象', async () => {
  await withProvider(async (h) => {
    const { result, identity } = await trashTamperRestore(h, (ctx) => {
      writeFileSync(join(ctx.opDir(), 'notes.txt'), '外部内容 A', 'utf8');
    });

    assert.equal(result.status, 'REJECTED', JSON.stringify(result));
    assert.equal(result.errorCode, 'ERR_TRASH_UNAVAILABLE');
    assert.equal(readFileSync(join(h.opDir(), 'notes.txt'), 'utf8'), '外部内容 A', '陌生对象必须原样保留');
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\n');
    assert.equal(diskIdentity(h.payloadPath()), identity, 'payload 身份不得变化');
    assert.equal(exists(join(h.root, 'a.md')), false, '不得恢复出文件');
  });
});

test('R2-03b 清单 identity 被篡改 → 拒绝恢复', async () => {
  await withProvider(async (h) => {
    const { result, identity } = await trashTamperRestore(h, (ctx) => {
      writeManifest(ctx, { ...manifestOf(ctx), identity: '9:999' });
    });
    assert.equal(result.status, 'REJECTED', JSON.stringify(result));
    assert.equal(result.errorCode, 'ERR_TRASH_STATE_CONFLICT');
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\n');
    assert.equal(diskIdentity(h.payloadPath()), identity);
    assert.equal(exists(join(h.root, 'a.md')), false);
  });
});

test('R2-03c 清单 originalPath 被篡改 → 拒绝恢复', async () => {
  await withProvider(async (h) => {
    const { result } = await trashTamperRestore(h, (ctx) => {
      writeManifest(ctx, { ...manifestOf(ctx), originalPath: 'b.md' });
    });
    assert.equal(result.status, 'REJECTED', JSON.stringify(result));
    assert.equal(result.errorCode, 'ERR_TRASH_UNAVAILABLE');
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\n');
    assert.equal(exists(join(h.root, 'a.md')), false);
  });
});

test('R2-03d 清单 opId 被篡改 → 拒绝恢复', async () => {
  await withProvider(async (h) => {
    const { result } = await trashTamperRestore(h, (ctx) => {
      writeManifest(ctx, { ...manifestOf(ctx), opId: 'op-other-0002' });
    });
    assert.equal(result.status, 'REJECTED', JSON.stringify(result));
    assert.equal(result.errorCode, 'ERR_TRASH_UNAVAILABLE');
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\n');
    assert.equal(exists(join(h.root, 'a.md')), false);
  });
});

test('R2-03e 清单缺失 → 拒绝恢复', async () => {
  await withProvider(async (h) => {
    const { result } = await trashTamperRestore(h, (ctx) => {
      unlinkSync(ctx.manifestPath());
    });
    assert.equal(result.status, 'REJECTED', JSON.stringify(result));
    assert.equal(result.errorCode, 'ERR_TRASH_UNAVAILABLE');
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\n');
    assert.equal(exists(join(h.root, 'a.md')), false);
  });
});

test('R2-03f payload 被替换为符号链接 → 拒绝恢复，外部 sentinel 字节不变', async () => {
  await withProvider(async (h) => {
    const sentinel = join(h.outside, 'sentinel-f.md');
    writeFileSync(sentinel, '外部内容 F', 'utf8');
    const { result } = await trashTamperRestore(h, async (ctx) => {
      unlinkSync(ctx.payloadPath());
      await symlink(sentinel, ctx.payloadPath(), 'file');
    });
    assert.equal(result.status, 'REJECTED', JSON.stringify(result));
    assert.equal(result.errorCode, 'ERR_TRASH_STATE_CONFLICT');
    assert.equal(readFileSync(sentinel, 'utf8'), '外部内容 F', 'sentinel 必须一字节不变');
    assert.equal(exists(join(h.root, 'a.md')), false, '不得沿链接把外部对象搬进项目');
  });
});

test('R2-03g 清单被替换为符号链接 → 拒绝恢复，外部 sentinel 字节不变', async () => {
  await withProvider(async (h) => {
    const sentinel = join(h.outside, 'sentinel-g.json');
    let forged = '';
    const { result } = await trashTamperRestore(h, async (ctx) => {
      // 伪造一份"看上去合法"的清单放在根外，再把清单替换成指向它的链接
      forged = `${JSON.stringify({ ...manifestOf(ctx), identity: '0:0' }, null, 2)}\n`;
      writeFileSync(sentinel, forged, 'utf8');
      unlinkSync(ctx.manifestPath());
      await symlink(sentinel, ctx.manifestPath(), 'file');
    });
    assert.equal(result.status, 'REJECTED', JSON.stringify(result));
    assert.equal(result.errorCode, 'ERR_TRASH_UNAVAILABLE');
    assert.equal(readFileSync(sentinel, 'utf8'), forged, 'sentinel 必须一字节不变');
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\n');
    assert.equal(exists(join(h.root, 'a.md')), false);
  });
});

test('R2-03h opId 目录里出现陌生目录或遗留临时文件 → 拒绝恢复', async () => {
  await withProvider(async (h) => {
    const { result } = await trashTamperRestore(h, (ctx) => {
      writeFileSync(join(ctx.opDir(), '.ws-tmp-1234.deadbeef'), '', 'utf8');
    });
    assert.equal(result.status, 'REJECTED', JSON.stringify(result));
    assert.equal(result.errorCode, 'ERR_TRASH_UNAVAILABLE');
    assert.equal(exists(join(h.opDir(), '.ws-tmp-1234.deadbeef')), true, '不得自动删除陌生对象');
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\n');
    assert.equal(exists(join(h.root, 'a.md')), false);
  });
});

test('R2-03i opId 目录里出现陌生子目录 → 拒绝恢复', async () => {
  await withProvider(async (h) => {
    const { result } = await trashTamperRestore(h, (ctx) => {
      mkdirSync(join(ctx.opDir(), 'nested'));
    });
    assert.equal(result.status, 'REJECTED', JSON.stringify(result));
    assert.equal(lstatSync(join(h.opDir(), 'nested')).isDirectory(), true);
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\n');
    assert.equal(exists(join(h.root, 'a.md')), false);
  });
});

/* ================================================================== */
/* R2-Supplement A1/A2：清单的字节数与时间戳必须与磁盘、记录一致          */
/* ================================================================== */

test('R2-03j payload 被追加字节（清单 size 小于实际大小）→ 拒绝恢复', async () => {
  await withProvider(async (h) => {
    const { result } = await trashTamperRestore(h, (ctx) => {
      // 只改磁盘，清单与记录都还是原始长度：只有"真实大小"能揭穿
      appendFileSync(ctx.payloadPath(), 'x');
    });
    assert.equal(result.status, 'REJECTED', JSON.stringify(result));
    assert.equal(result.errorCode, 'ERR_TRASH_STATE_CONFLICT');
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\nx', '被改动过的 payload 不得被搬走');
    assert.equal(exists(join(h.root, 'a.md')), false, '目标位置不得出现文件');
  });
});

test('R2-03k payload 被截断（清单 size 大于实际大小）→ 拒绝恢复', async () => {
  await withProvider(async (h) => {
    const { result } = await trashTamperRestore(h, (ctx) => {
      truncateSync(ctx.payloadPath(), 3);
    });
    assert.equal(result.status, 'REJECTED', JSON.stringify(result));
    assert.equal(result.errorCode, 'ERR_TRASH_STATE_CONFLICT');
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a');
    assert.equal(exists(join(h.root, 'a.md')), false);
  });
});

test('R2-03l 清单 size 为负数 → 拒绝恢复（形状不可信）', async () => {
  await withProvider(async (h) => {
    const { result } = await trashTamperRestore(h, (ctx) => {
      writeManifest(ctx, { ...manifestOf(ctx), size: -1 });
    });
    assert.equal(result.status, 'REJECTED', JSON.stringify(result));
    assert.equal(result.errorCode, 'ERR_TRASH_UNAVAILABLE');
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\n');
    assert.equal(exists(join(h.root, 'a.md')), false);
  });
});

test('R2-03m 清单 size 为非整数或非法类型 → 拒绝恢复（形状不可信）', async () => {
  // 每个变体用独立的临时项目：一次拒绝不会恢复文件，同一个项目无法重复利用
  for (const bad of [1.5, '7', null, true]) {
    await withProvider(async (h) => {
      const { result } = await trashTamperRestore(h, (ctx) => {
        writeManifest(ctx, { ...manifestOf(ctx), size: bad });
      });
      assert.equal(result.status, 'REJECTED', `size=${JSON.stringify(bad)} 必须拒绝：${JSON.stringify(result)}`);
      assert.equal(result.errorCode, 'ERR_TRASH_UNAVAILABLE');
      assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\n');
      assert.equal(exists(join(h.root, 'a.md')), false);
    });
  }
});

test('R2-03n 清单 deletedAt 为非法日期 → 拒绝恢复', async () => {
  for (const bad of ['2026-13-45T99:99:99.999Z', '2026-02-31T00:00:00.000Z', '不是时间', '']) {
    await withProvider(async (h) => {
      const { result } = await trashTamperRestore(h, (ctx) => {
        writeManifest(ctx, { ...manifestOf(ctx), deletedAt: bad });
      });
      assert.equal(result.status, 'REJECTED', `deletedAt=${JSON.stringify(bad)} 必须拒绝：${JSON.stringify(result)}`);
      assert.equal(result.errorCode, 'ERR_TRASH_UNAVAILABLE');
      assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\n');
      assert.equal(exists(join(h.root, 'a.md')), false);
    });
  }
});

test('R2-03o 清单 deletedAt 能被 Date.parse 解析但不是约定格式 → 拒绝恢复', async () => {
  const parseable = [
    // 下面每一条 `Date.parse` 都能解析，但不是 `toISOString()` 的写法
    '2026-11-22T00:00:00Z',
    '2026-11-22T00:00:00.000+00:00',
    'November 22, 2026 00:00:00 UTC',
    '2026-11-22',
  ];
  for (const bad of parseable) {
    assert.equal(Number.isNaN(Date.parse(bad)), false, `夹具必须可被 Date.parse 解析：${bad}`);
    await withProvider(async (h) => {
      const { result } = await trashTamperRestore(h, (ctx) => {
        writeManifest(ctx, { ...manifestOf(ctx), deletedAt: bad });
      });
      assert.equal(result.status, 'REJECTED', `deletedAt=${JSON.stringify(bad)} 必须拒绝：${JSON.stringify(result)}`);
      assert.equal(result.errorCode, 'ERR_TRASH_UNAVAILABLE');
      assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\n');
      assert.equal(exists(join(h.root, 'a.md')), false);
    });
  }
});

test('R2-03q 记录里的 size 与清单不一致 → 拒绝恢复（清单不能自证）', async () => {
  await withProvider(async (h) => {
    const identity = await h.identityOf('a.md');
    assert.equal((await h.provider.trashEntry!(OP, 'a.md', identity)).status, 'MOVED');

    // 清单与磁盘都还是 7 字节，但"记录"（调用方传入）说是 107：只有记录这一维能发现
    const res = await h.provider.restoreEntry!(OP, 'a.md', identity, SOURCE_SIZE + 100);
    assert.equal(res.status, 'REJECTED', JSON.stringify(res));
    assert.equal(res.errorCode, 'ERR_TRASH_STATE_CONFLICT');
    assert.equal(readFileSync(h.payloadPath(), 'utf8'), '# a.md\n', '回收区对象不得被搬走');
    assert.equal(exists(join(h.root, 'a.md')), false, '目标位置不得出现文件');
  });
});

test('R2-03p 系统生成的时间戳与正确 size 可以正常恢复（格式校验不误伤）', async () => {
  await withProvider(async (h) => {
    const identity = await h.identityOf('a.md');
    assert.equal((await h.provider.trashEntry!(OP, 'a.md', identity)).status, 'MOVED');

    const manifest = manifestOf(h);
    assert.equal(typeof manifest.deletedAt, 'string');
    const stamp = manifest.deletedAt as string;
    // 系统唯一写法：UTC + 毫秒 3 位 + Z，且往返一致
    assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(new Date(stamp).toISOString(), stamp);
    assert.equal(manifest.size, SOURCE_SIZE, '清单里的 size 必须等于真实字节数');

    const res = await h.provider.restoreEntry!(OP, 'a.md', identity, SOURCE_SIZE);
    assert.equal(res.status, 'MOVED', JSON.stringify(res));
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# a.md\n');
    assert.equal(exists(h.payloadPath()), false);
  });
});

/* ================================================================== */
/* R2-04：内部写盘临时文件的 rename 前身份复核                            */
/* ================================================================== */

test('R2-04a 临时文件被换成另一个普通文件 → 不写标记、不搬源文件', async () => {
  await withProvider(async (h) => {
    /**
     * 替换对象必须是一个**身份确定不同**的对象：用 `rename` 把一个事先建好的文件
     * 覆盖到临时文件的名字上。若改成"先删再建"，理论上可能复用刚释放的 inode，
     * 那样测的就不是"另一个对象"，而是"同一个 inode"——那是夹具退化，不是保护失效。
     */
    const forged = join(h.outside, 'forged-marker.json');
    writeFileSync(forged, '伪造标记', 'utf8');
    let fired = 0;
    let tmpInode = '';
    let forgedInode = '';
    h.onBeforeOwnWriteRename(({ tmpAbs, targetAbs }) => {
      if (targetAbs !== h.markerPath()) return;
      fired += 1;
      tmpInode = `${lstatSync(tmpAbs).dev}:${lstatSync(tmpAbs).ino}`;
      renameSync(forged, tmpAbs);
      forgedInode = `${lstatSync(tmpAbs).dev}:${lstatSync(tmpAbs).ino}`;
    });

    const identity = await h.identityOf('a.md');
    const res = await h.provider.trashEntry!(OP, 'a.md', identity);
    h.onBeforeOwnWriteRename(null);

    assert.equal(fired, 1);
    assert.notEqual(forgedInode, tmpInode, '夹具前提：替换对象必须是另一个身份');
    assert.equal(res.status, 'REJECTED', JSON.stringify(res));
    assert.equal(res.errorCode, 'ERR_TRASH_UNAVAILABLE');
    assert.equal(exists(h.markerPath()), false, '标记绝不能被未核验的对象顶替');
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# a.md\n', '源文件不得移动');
  });
});

test('R2-04b 临时文件被换成符号链接 → 不写标记、外部 sentinel 不变', async () => {
  await withProvider(async (h) => {
    const sentinel = join(h.outside, 'sentinel-marker.json');
    writeFileSync(sentinel, '外部标记内容', 'utf8');
    h.onBeforeOwnWriteRename(async ({ tmpAbs, targetAbs }) => {
      if (targetAbs !== h.markerPath()) return;
      unlinkSync(tmpAbs);
      await symlink(sentinel, tmpAbs, 'file');
    });

    const identity = await h.identityOf('a.md');
    const res = await h.provider.trashEntry!(OP, 'a.md', identity);
    h.onBeforeOwnWriteRename(null);

    assert.equal(res.status, 'REJECTED', JSON.stringify(res));
    assert.equal(readFileSync(sentinel, 'utf8'), '外部标记内容', 'sentinel 必须一字节不变');
    assert.equal(exists(h.markerPath()), false);
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# a.md\n');
  });
});

test('R2-04c 临时文件被换成硬链接（nlink > 1）→ 不写标记', async () => {
  await withProvider(async (h) => {
    const sentinel = join(h.outside, 'sentinel-hard.txt');
    writeFileSync(sentinel, '硬链接来源内容', 'utf8');
    h.onBeforeOwnWriteRename(({ tmpAbs, targetAbs }) => {
      if (targetAbs !== h.markerPath()) return;
      unlinkSync(tmpAbs);
      linkSync(sentinel, tmpAbs);
    });

    const identity = await h.identityOf('a.md');
    const res = await h.provider.trashEntry!(OP, 'a.md', identity);
    h.onBeforeOwnWriteRename(null);

    assert.equal(res.status, 'REJECTED', JSON.stringify(res));
    assert.equal(readFileSync(sentinel, 'utf8'), '硬链接来源内容');
    assert.equal(exists(h.markerPath()), false);
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# a.md\n');
  });
});

test('R2-04d 临时文件被删除 → 不写标记、不抛异常', async () => {
  await withProvider(async (h) => {
    h.onBeforeOwnWriteRename(({ tmpAbs, targetAbs }) => {
      if (targetAbs !== h.markerPath()) return;
      unlinkSync(tmpAbs);
    });

    const identity = await h.identityOf('a.md');
    const res = await h.provider.trashEntry!(OP, 'a.md', identity);
    h.onBeforeOwnWriteRename(null);

    assert.equal(res.status, 'REJECTED', JSON.stringify(res));
    assert.equal(exists(h.markerPath()), false);
    assert.equal(readFileSync(join(h.root, 'a.md'), 'utf8'), '# a.md\n');
  });
});

test('R2-04e 临时文件未被替换时标记正常写入（复核不误伤正常路径）', async () => {
  await withProvider(async (h) => {
    let observed: string[] = [];
    h.onBeforeOwnWriteRename(({ tmpAbs }) => {
      observed = readdirSync(join(h.root, TRASH_DIR));
      assert.ok(exists(tmpAbs), '钩子执行时临时文件应当已存在');
    });

    const identity = await h.identityOf('a.md');
    const res = await h.provider.trashEntry!(OP, 'a.md', identity);
    h.onBeforeOwnWriteRename(null);

    assert.equal(res.status, 'MOVED', JSON.stringify(res));
    assert.ok(observed.length > 0);
    const marker = JSON.parse(readFileSync(h.markerPath(), 'utf8')) as { magic: string };
    assert.equal(marker.magic, 'weavespace-internal-trash-v1');
  });
});
