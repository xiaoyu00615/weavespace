/**
 * UX-02C-02-R2.1 变异探针（证据工具，不参与产品代码）。
 *
 * 做法沿用前几轮：把一处关键判定改坏 → 跑套件 111 → 记录失败用例 →
 * 还原 → 逐字节比对 SHA-256。
 *
 * 覆盖本轮六条"必须被行为测试咬住"的判定，另加一条提交前票据核验：
 * - M21 删除结构变更的**工作区**归属检查（旧 APPLIED 作废新层表）
 * - M22 删除**加载代次**检查（Live→Demo→Live 之后旧 UNKNOWN 仍刷新）
 * - M23 删除行内结果的**会话票据**检查（错误写进另一个输入框）
 * - M24 删除 Provider 的**目标最终身份**核验（搬进用户没确认的目录）
 * - M25 删除 Provider 的**最终类型**核验（把目录当成文件搬走）
 * - M26 删除 Host 的**移动目标身份**检查（不核验就搬）
 * - M27 删除提交前的**会话票据**检查（旧输入行的结果落到新输入行）
 *
 * 每个探针都必须由**具体用例**捕获；只断言"源码里有这行"一律不算。
 *
 * 用法：node docs/evidence/ux-02c-02-r21-finalization/mutate.mjs
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

const SUITE = 'tests/suites/111-s11ux02c02r21-finalization.test.ts';
const OWNERSHIP = 'apps/shell/src/state/structure-ownership.ts';
const INTENT = 'apps/shell/src/state/structure-intent.ts';
const PROVIDER = 'packages/storage/local-provider.ts';
const HOST = 'apps/server/src/structure-change.ts';

const mutations = [
  {
    id: 'C02R21-M21',
    desc: '删除结构变更的工作区归属检查（切工作区后旧 APPLIED 仍写新层表）',
    file: OWNERSHIP,
    from: `  if (start.workspaceKey !== now.workspaceKey) return '工作区已经切换，结果没有写入当前界面';`,
    to: `  // 变异：不比对工作区摘要`,
    suite: SUITE,
  },
  {
    id: 'C02R21-M22',
    desc: '删除加载代次检查（Live→Demo→Live 之后旧结果仍被当成当前）',
    file: OWNERSHIP,
    from: `  if (start.epoch !== now.epoch) return '工作区已重新加载，结果没有写入当前界面';`,
    to: `  // 变异：不比对加载代次`,
    suite: SUITE,
  },
  {
    id: 'C02R21-M23',
    desc: '行内提示不看会话票据（两个输入框同时收到同一条错误）',
    file: OWNERSHIP,
    from: `  const { sessionId } = input;
  if (sessionId === null) return { naming: false, move: false };
  return {
    naming: input.namingSessionId !== null && input.namingSessionId === sessionId,
    move: input.moveSessionId !== null && input.moveSessionId === sessionId,
  };`,
    to: `  // 变异：只要有会话就同时写两个行内界面
  const any = input.sessionId !== null;
  return {
    naming: any && input.namingSessionId !== null,
    move: any && input.moveSessionId !== null,
  };`,
    suite: SUITE,
  },
  {
    id: 'C02R21-M24',
    desc: '删除 Provider 最后一次目标目录身份核验（占位阶段被换掉也照样搬）',
    file: PROVIDER,
    from: `      if (!(await targetDirStillMatches())) {
        return await rejectSourceChanged('ERR_ENTRY_TARGET_CHANGED');
      }`,
    to: `      // 变异：最后一次目标核验被删掉`,
    suite: SUITE,
  },
  {
    id: 'C02R21-M25',
    desc: '删除 Provider 的最终类型核验（目录/文件类型变了仍按身份判）',
    file: PROVIDER,
    from: `        if (sourceIsDir ? !again.isDirectory() : !again.isFile()) {
          return await rejectSourceChanged('ERR_ENTRY_SOURCE_INVALID');
        }`,
    to: `        // 变异：不核验最终类型`,
    suite: SUITE,
  },
  {
    id: 'C02R21-M26',
    desc: '删除 Host 的移动目标身份检查（客户端的错锚被忽略）',
    file: HOST,
    from: `          if (targetAnchor !== request.targetAnchor) return reject('ERR_ENTRY_TARGET_CHANGED');`,
    to: `          // 变异：不比对目标锚`,
    suite: SUITE,
  },
  {
    id: 'C02R21-M27',
    desc: '删除提交前的会话票据核验（旧输入行的结果落到新输入行）',
    file: INTENT,
    from: `  if (!input.sessionCurrent) return '这次操作所属的输入已经结束，命令没有执行';`,
    to: `  // 变异：不看票据是否还属于当前会话`,
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
      env: {
        ...process.env,
        TMP: process.env.TMP,
        TEMP: process.env.TEMP,
        TMPDIR: process.env.TMPDIR,
      },
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
