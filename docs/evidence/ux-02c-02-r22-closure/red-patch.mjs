/**
 * UX-02C-02-R2.2-PATCH 红测取证（证据工具，不参与产品代码）。
 *
 * 做什么：把两处修复**按运行语义**退回 R2.2（补丁前）的状态，再跑套件 112，
 * 记录哪些用例真的变红；随后逐字节还原并核对 SHA-256。
 *
 * 为什么可以退回：P01 的修复点是"没有显式预期时用什么做基准"，P02 的修复点是
 * "底层 TreeLoadOutcome 要不要收集"。两处都只影响运行时行为，不做类型层回退
 * （`node --test` 只做类型剥离，不做类型检查）。
 *
 * 用法：node docs/evidence/ux-02c-02-r22-closure/red-patch.mjs
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const run = promisify(execFile);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const SUITE_112 = 'tests/suites/112-s11ux02c02r22-closure.test.ts';
const PROVIDER = 'packages/storage/local-provider.ts';
const REFRESH = 'apps/shell/src/state/structure-refresh.ts';

/** 补丁前的 P01：`expectedTarget === null`（改名 / 项目根）时直接放行。 */
const P01_OLD = `        if (targetBaseline === null) return false;`;
const P01_REVERTED = `        // 回退到 R2.2：没有显式预期就跳过目录连续性
        if (expectedTarget === null) return true;`;

/** 补丁前的 P02：只要没抛异常就是 applied，返回的 TreeLoadOutcome 被丢掉。 */
const P02_NEW = `  const dirs =
    input.targetParentDir !== input.sourceParentDir
      ? [input.sourceParentDir, input.targetParentDir]
      : [input.sourceParentDir];
  const outcomes: TreeLoadOutcome[] = [];
  for (const dir of dirs) {
    // 每次请求之前重新核验归属：中途换世界就不再发下一个
    if (guard.check()) return structureLoadVerdict(outcomes, true);
    outcomes.push(await input.host.load(input.projectId, dir));
  }
  // 最后这次看的是"数据到底进没进这一屏"：世界变了就不算完成
  if (guard.check()) return structureLoadVerdict(outcomes, true);
  return structureLoadVerdict(outcomes, false);`;
const P02_OLD = `  if (guard.check()) return 'stale';
  await input.host.load(input.projectId, input.sourceParentDir);
  if (guard.check()) return 'stale';
  if (input.targetParentDir !== input.sourceParentDir) {
    await input.host.load(input.projectId, input.targetParentDir);
    if (guard.check()) return 'stale';
  }
  return 'applied';`;

const originals = new Map();
let failed = null;

try {
  for (const [file, from, to] of [
    [PROVIDER, P01_OLD, P01_REVERTED],
    [REFRESH, P02_NEW, P02_OLD],
  ]) {
    const path = join(repo, file);
    const original = await readFile(path);
    originals.set(file, original);
    const text = original.toString('utf8');
    if (!text.includes(from)) throw new Error(`找不到回退锚点：${file}`);
    await writeFile(path, text.replace(from, to), 'utf8');
  }

  console.log('== 已把 P01 / P02 按运行语义退回补丁前 ==');
  for (const file of originals.keys()) {
    console.log(`  ${file}  sha256 = ${sha(await readFile(join(repo, file)))}`);
  }

  let stdout = '';
  try {
    const out = await run(process.execPath, ['--experimental-strip-types', '--test', SUITE_112], {
      cwd: repo,
      env: { ...process.env },
    });
    stdout = out.stdout;
  } catch (err) {
    stdout = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  console.log('== 套件 112 在补丁前代码上的结果 ==');
  console.log(
    stdout
      .split('\n')
      .filter((line) => line.startsWith('not ok ') || line.startsWith('# tests') || line.startsWith('# pass') || line.startsWith('# fail'))
      .join('\n'),
  );
} catch (err) {
  failed = err;
} finally {
  for (const [file, original] of originals) {
    const path = join(repo, file);
    const before = sha(original);
    await writeFile(path, original);
    const after = sha(await readFile(path));
    console.log(`  还原 ${file}: ${after}（逐字节一致 = ${after === before}）`);
  }
}

if (failed) {
  console.error('取证失败：', failed.message);
  process.exit(1);
}
