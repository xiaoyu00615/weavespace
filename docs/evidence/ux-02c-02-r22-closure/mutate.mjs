/**
 * UX-02C-02-R2.2 变异探针（证据工具，不参与产品代码）。
 *
 * 做法沿用前几轮：把一处关键判定改坏 → 跑对应套件 → 记录失败用例 →
 * 还原 → 逐字节比对 SHA-256。每个探针都必须由**行为测试**捕获。
 *
 * 覆盖本轮四条必须咬住的判定，另加两条：
 * - M31 目标父目录失效后仍**重新占位**（在新同名目录里留下痕迹）
 * - M32 占位收敛只看原路径（目录被移走也敢说 REJECTED）
 * - M33 目标父目录失效后仍返回 **REJECTED**（占位残留在旧目录却宣称零副作用）
 * - M34 UNKNOWN 跨世界仍声称"已刷新"
 * - M35 目标恢复路径取错层（重取目标自己那一层，锚永远刷不到）
 * - M36 删除**最终目标对象**身份核验（不是目标目录身份核验）
 *
 * 用法：node docs/evidence/ux-02c-02-r22-closure/mutate.mjs
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
const SUITE_111 = 'tests/suites/111-s11ux02c02r21-finalization.test.ts';
const PROVIDER = 'packages/storage/local-provider.ts';
const REFRESH = 'apps/shell/src/state/structure-refresh.ts';

const mutations = [
  {
    id: 'C02R22-M31',
    desc: '目标父目录失效后仍重新占位（在新同名目录里留下痕迹）',
    file: PROVIDER,
    from: `        if (!(await targetDirStillMatches())) return unknown();
        const state = await reservationState();`,
    to: `        // 变异：不认目录就重新占位
        const state = await reservationState();`,
    suite: SUITE_112,
  },
  {
    id: 'C02R22-M32',
    desc: '占位收敛只看原路径（目录被整体移走也敢说零副作用）',
    file: PROVIDER,
    from: `        if (!(await targetDirStillMatches())) return unknown();
        const owned = await reservationState();`,
    to: `        // 变异：占位收敛只看原路径
        const owned = await reservationState();`,
    suite: SUITE_112,
  },
  {
    id: 'C02R22-M33',
    desc: '目标父目录失效后仍返回 REJECTED（占位残留在旧目录却宣称零副作用）',
    file: PROVIDER,
    from: `        return reserved ? unknown() : reject('ERR_ENTRY_TARGET_CHANGED');`,
    to: `        // 变异：目录失效一律按普通拒绝返回
        return reject('ERR_ENTRY_TARGET_CHANGED');`,
    suite: SUITE_112,
  },
  {
    id: 'C02R22-M34',
    desc: 'UNKNOWN 跨世界仍声称"已只读刷新"',
    file: REFRESH,
    from: `  if (check === 'stale') {
    return \`结构变更结果未确认：当前界面已经切换，没有执行只读核对，请手动刷新后核对\${tail}\`;
  }`,
    to: `  // 变异：不管核对有没有执行，都说已刷新
  if (check === 'stale') {
    return \`结构变更结果未确认：已只读刷新源位置与目标位置，请人工核对\${tail}\`;
  }`,
    suite: SUITE_112,
  },
  {
    id: 'C02R22-M35',
    desc: '删除目标恢复路径（重取目标自己那一层而不是父层，锚永远刷不到）',
    file: REFRESH,
    from: `  const dir = input.targetParentDir === '' ? '' : parentDirOfEntry(input.targetParentDir);`,
    to: `  // 变异：重取目标自己那一层
  const dir = input.targetParentDir;`,
    suite: SUITE_112,
  },
  {
    id: 'C02R22-M36',
    desc: '删除最终**目标对象**身份核验（内容相同即算搬运成功）',
    file: PROVIDER,
    from: `          if (\`\${targetInfo.dev}:\${targetInfo.ino}\` !== expectedIdentity) return 'ambiguous';`,
    to: `          // 变异：不核验目标对象身份`,
    suite: SUITE_111,
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
      env: { ...process.env, TMP: process.env.TMP, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR },
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
await writeFile(join(here, 'mutations.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
