/**
 * UX-02C-02-R2.2-PATCH 变异探针（证据工具，不参与产品代码）。
 *
 * 只补两个针对性探针，对应本轮两个缺陷：
 * - M41 普通改名跳过内部父目录连续性核验（`expectedTarget === null` 直接放行）
 * - M42 丢弃真实 TreeLoadOutcome，强制视为 applied
 *
 * 与 R2.2 的 `mutate.mjs` / `mutations.json` **分开**：历史证据不覆盖。
 * 判定方式相同：改坏一处 → 跑对应套件 → 记录失败用例 → 逐字节还原。
 *
 * 用法：node docs/evidence/ux-02c-02-r22-closure/mutate-patch.mjs
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

const mutations = [
  {
    id: 'C02R22P-M41',
    desc: '普通改名 / 项目根目标跳过内部父目录连续性核验',
    file: PROVIDER,
    from: `        if (targetBaseline === null) return false;`,
    to: `        // 变异：调用方没给预期就跳过目录连续性（R2.2-PATCH 前的行为）
        if (expectedTarget === null) return true;`,
    suite: SUITE_112,
  },
  {
    id: 'C02R22P-M42',
    desc: '丢弃真实 TreeLoadOutcome，只要没抛异常就视为已刷新',
    file: REFRESH,
    from: `  return structureLoadVerdict(outcomes, false);`,
    to: `  // 变异：不看底层结果，一律当作加载成功
  return 'applied';`,
    suite: SUITE_112,
  },
];

const results = [];

for (const mutation of mutations) {
  const target = join(repo, mutation.file);
  const original = await readFile(target);
  const baselineSha = sha(original);
  const text = original.toString('utf8');
  if (!text.includes(mutation.from)) {
    results.push({ id: mutation.id, verdict: 'MISSING_MARKER', file: mutation.file });
    continue;
  }
  const mutated = text.replace(mutation.from, mutation.to);
  await writeFile(target, mutated, 'utf8');
  const mutatedSha = sha(await readFile(target));

  let exitCode = 0;
  let stdout = '';
  try {
    const out = await run(process.execPath, ['--experimental-strip-types', '--test', mutation.suite], {
      cwd: repo,
      env: { ...process.env },
    });
    stdout = out.stdout;
  } catch (err) {
    exitCode = err.code ?? 1;
    stdout = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }

  await writeFile(target, original);
  const restoredSha = sha(await readFile(target));

  const failedTests = stdout
    .split('\n')
    .filter((line) => line.startsWith('not ok '))
    .map((line) => line.replace(/^not ok \d+ - /, '').trim());

  results.push({
    id: mutation.id,
    desc: mutation.desc,
    file: mutation.file,
    suite: mutation.suite,
    baselineSha256: baselineSha,
    mutatedSha256: mutatedSha,
    sourceChanged: mutatedSha !== baselineSha,
    restoredSha256: restoredSha,
    restoreExact: restoredSha === baselineSha,
    suiteExitCode: exitCode,
    failedTests,
    verdict: exitCode === 0 ? 'NOT_BITTEN' : failedTests.length > 0 ? 'BITTEN' : 'FAILED_WITHOUT_TEST_NAME',
  });
}

const report = { at: new Date().toISOString(), results };
await writeFile(join(here, 'mutations-patch.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
