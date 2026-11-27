/**
 * UX-02C-04-R1-H1 变异探针（证据工具，不参与产品代码）。
 *
 * 做法与 R1 一致：把某一处关键判定改坏 → 跑对应套件 → 记录失败的用例 → 还原 → 逐字节比对 SHA。
 * 目的是证明新增用例**真的咬得住**这两处修复，而不是"改不改都绿"。
 *
 * 用法：node docs/evidence/ux-02c-04-r1-h1/mutate.mjs
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

const HOST_SUITE = 'tests/suites/103-s11ux02c04r1-metadata-identity-host.test.ts';
const GATE_SUITE = 'tests/suites/105-s11ux02c04r1h1-metadata-send-gate.test.ts';

const mutations = [
  {
    id: 'H1-M1',
    desc: 'H1-01：去掉令牌到手之后的最终归属复核（身份已变仍然发出 POST）',
    file: 'apps/shell/src/client/client-api.ts',
    from: `    const decision = evaluateMetadataSendGate(gate);
    if (!decision.ok) return { status: 'NOT_SENT', reason: decision.reason };`,
    to: `    void evaluateMetadataSendGate(gate); // 变异：不做最终复核`,
    suite: GATE_SUITE,
  },
  {
    id: 'H1-M2',
    desc: 'H1-01：发送前拒绝被当成 UNKNOWN（会去刷新一份与本次编辑无关的旧状态）',
    file: 'apps/shell/src/state/metadata-session.ts',
    from: `  if (outcome.status === 'NOT_SENT') {
    host.notice(metadataStaleNotice(outcome.reason, action));
    return { kind: 'stale', reason: outcome.reason };
  }`,
    to: `  if (outcome.status === 'NOT_SENT') {
    // 变异：与"结果未知"混为一谈
  }`,
    suite: GATE_SUITE,
  },
  {
    id: 'H1-M3',
    desc: 'H1-02：迁移去重退回"只按 path + identity"（别的项目/根令牌会挤掉本次记录）',
    file: 'apps/server/src/store/file-store.ts',
    from: `      const keyOf = (projectId: string, rootToken: string, path: string, identity: string): string =>
        \`\${projectId}\\u0000\${rootToken}\\u0000\${pathKey(path)}\\u0000\${identity}\`;`,
    to: `      const keyOf = (_projectId: string, _rootToken: string, path: string, identity: string): string =>
        \`\${pathKey(path)}\\u0000\${identity}\`; // 变异：退回 path + identity`,
    suite: HOST_SUITE,
  },
  {
    id: 'H1-M4',
    desc: 'H1-02：身份再绑定不检查目标四元组（写出重启后无法解析的配置）',
    file: 'apps/server/src/store/file-store.ts',
    from: `      if (collision) return { changed: false, outcome: 'skipped-conflict' as const };`,
    to: `      void collision; // 变异：不去重，直接写出重复四元组`,
    suite: HOST_SUITE,
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
