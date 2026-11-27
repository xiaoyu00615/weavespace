/**
 * UX-02C-05-R1.2 变异探针（证据工具，不参与产品代码）。
 *
 * 做法沿用前几轮：把一处关键判定改坏 → 跑套件 109 → 记录失败用例 →
 * 还原 → 逐字节比对 SHA-256。
 *
 * 覆盖复审的三条 F 加上"首屏根锚"这一处：
 * - M12 旧 unsupported 无条件放行（F01）
 * - M13 首屏继承旧 unsupported（F02）
 * - M17 首屏继承旧根锚（F02 第二处）
 * - M14 删除底层工作区归属检查（F03）
 * - M15 删除加载代次检查（F03）
 * - M16 旧结果无条件当成当前会话（F03 会话层）
 *
 * 用法：node docs/evidence/ux-02c-05-r12-identity-ownership/mutate.mjs
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

const SUITE = 'tests/suites/109-s11ux02c05r12-identity-and-rename-ownership.test.ts';
const COMMANDS = 'apps/shell/src/state/tree-commands.ts';
const MODEL = 'apps/shell/src/components/tree-model.ts';
const RENAME = 'apps/shell/src/state/project-rename.ts';

const mutations = [
  {
    id: 'C05R12-M12',
    desc: '旧 unsupported 无条件放行（不核验当前身份状态，F01）',
    file: COMMANDS,
    from: `  if (targetIdentity === 'unsupported') {
    // 自称没有身份能力却带着锚：声明自相矛盾，不能当成"按路径降级"的凭据
    if (target.nodeAnchor) return IDENTITY_STATE_CHANGED;
    if (currentIdentity === 'unverified') return UNCONFIRMED;
    if (currentIdentity !== 'unsupported') return IDENTITY_STATE_CHANGED;
    // 当前侧同样不能有任何锚信息，否则"无能力"与"有锚"互相矛盾
    if (input.currentAnchor) return IDENTITY_STATE_CHANGED;
    return null;
  }`,
    to: `  // 变异：只要目标声称无能力就放行，完全不看当前状态
  if (targetIdentity === 'unsupported') return null;`,
    suite: SUITE,
  },
  {
    id: 'C05R12-M13',
    desc: '首屏整层替换仍继承旧的能力声明（F02）',
    file: MODEL,
    from: `  const identitySupport = first
    ? page.identitySupport
    : (page.identitySupport ?? previous.identitySupport);`,
    to: `  // 变异：不看是不是首屏，一律沿用旧声明
  const identitySupport = page.identitySupport ?? previous.identitySupport;`,
    suite: SUITE,
  },
  {
    id: 'C05R12-M17',
    desc: '首屏整层替换仍继承旧的根锚（F02 第二处）',
    file: MODEL,
    from: `        : !first && previous.projectAnchor
          ? { projectAnchor: previous.projectAnchor }
          : {}),`,
    to: `        : previous.projectAnchor
          ? { projectAnchor: previous.projectAnchor }
          : {}),`,
    suite: SUITE,
  },
  {
    id: 'C05R12-M14',
    desc: '删除底层工作区归属检查（切了工作区，旧结果仍回填新列表）',
    file: RENAME,
    from: `  if (input.workspaceKey !== ownership.workspaceKey) {
    return '工作区已经切换，重命名结果没有写入当前项目列表';
  }`,
    to: `  // 变异：不比对工作区摘要`,
    suite: SUITE,
  },
  {
    id: 'C05R12-M15',
    desc: '删除加载代次检查（Live→Demo→Live 之后旧结果仍回填）',
    file: RENAME,
    from: `  if (input.epoch !== ownership.epoch) {
    return '工作区已重新加载，重命名结果没有写入当前项目列表';
  }`,
    to: `  // 变异：不比对加载代次`,
    suite: SUITE,
  },
  {
    id: 'C05R12-M16',
    desc: '旧结果无条件当成当前会话（切了活动项目/开了新会话也照样写）',
    file: RENAME,
    from: `        const stillCurrent =
          projectPresent &&
          projectRenameSessionStillCurrent({
            session: live ? ticketOf(live) : null,
            sessionId: session.sessionId,
            currentScope: port.currentScope(),
            activeProjectId: port.currentActiveProject(),
          });`,
    to: `        // 变异：只要项目还在就当成当前会话，票据与世界一概不看
        const stillCurrent = projectPresent;`,
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
