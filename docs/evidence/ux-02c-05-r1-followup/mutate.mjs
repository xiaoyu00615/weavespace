/**
 * UX-02C-05-R1.1 变异探针（证据工具，不参与产品代码）。
 *
 * 做法沿用 UX-02C-05-R1：把一处关键判定改坏 → 跑套件 108 → 记录失败用例 →
 * 还原 → 逐字节比对 SHA-256。
 *
 * 目的：证明 108 的 24 个用例真的咬得住这一轮补的四处——
 * 仲裁器重建后的残响、身份三态、身份未知时的 fail-closed、异步会话的归属。
 *
 * 用法：node docs/evidence/ux-02c-05-r1-followup/mutate.mjs
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

const SUITE = 'tests/suites/108-s11ux02c05r11-activation-identity.test.ts';
const COMMANDS = 'apps/shell/src/state/tree-commands.ts';

const mutations = [
  {
    id: 'C05R11-M7',
    desc: '删掉"armed=null 时拒绝第二次点击"的保护（旧手势的残响被当成新手势起点，给新对象改名）',
    file: COMMANDS,
    from: `        if (armed === null) {
          clear();
          return;
        }`,
    to: `        // 变异：没有第一次点击也照单全收，并把它当作新的起点
        if (armed === null) {
          clear();
          armed = identity;
          return;
        }`,
    suite: SUITE,
  },
  {
    id: 'C05R11-M8',
    desc: '把 UNVERIFIED 错误降级成 UNSUPPORTED（缺锚被当成"Provider 不支持身份"，按路径放行）',
    file: COMMANDS,
    from: `  if (typeof input.anchor === 'string' && input.anchor !== '') return 'verified';
  if (input.support === 'unsupported') return 'unsupported';
  return 'unverified';`,
    to: `  if (typeof input.anchor === 'string' && input.anchor !== '') return 'verified';
  // 变异：不再区分"不支持"与"探测失败"，一律按路径身份降级
  return 'unsupported';`,
    suite: SUITE,
  },
  {
    id: 'C05R11-M9',
    desc: '身份探测失败时仍允许执行旧点击（unverified 重新参与"相等"推断）',
    file: COMMANDS,
    from: `  const stillSame = (identity: ActivationIdentity): boolean => {
    if (identity.verification === 'unverified') return false;
    const current = input.currentIdentity();
    if (current === null) return false;
    if (current.verification === 'unverified') return false;
    return sameActivationResource(identity, current);
  };`,
    to: `  const stillSame = (identity: ActivationIdentity): boolean => {
    // 变异：不看身份状态，只要字面相同就执行
    const current = input.currentIdentity();
    if (current === null) return false;
    return sameActivationResource(identity, current);
  };`,
    suite: SUITE,
  },
  {
    id: 'C05R11-M10',
    desc: '请求返回时忽略当前工作区归属（旧世界的结果写进新世界的会话）',
    file: COMMANDS,
    from: `  if (session.scope !== input.currentScope) return false;`,
    to: `  // 变异：不比对工作区/模式`,
    suite: SUITE,
  },
  {
    id: 'C05R11-M11',
    desc: '请求返回时忽略当前活动项目（切了项目，旧结果仍被当成当前会话）',
    file: COMMANDS,
    from: `  return session.activeProjectAtStart === input.activeProjectId;`,
    to: `  // 变异：不比对活动项目
  return true;`,
    suite: SUITE,
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

const report = { at: new Date().toISOString(), suite: SUITE, results };
await writeFile(join(here, 'mutations.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
