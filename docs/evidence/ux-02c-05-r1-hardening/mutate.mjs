/**
 * UX-02C-05-R1 变异探针（证据工具，不参与产品代码）。
 *
 * 做法沿用 UX-02C-05 / UX-02C-04-R1-H1：把一处关键判定改坏 → 跑套件 107 →
 * 记录失败用例 → 还原 → 逐字节比对 SHA。
 *
 * 目的不是"跑一遍绿的"，而是证明这一轮的 31 个用例真的咬得住这六处：
 * 窗口长度、定时器到点的身份核对、双击两下的同源核对、锚缺失的 fail-closed、
 * 会话归属复核（纯模块）、以及组件里"复核结论真的挡住了提交"。
 *
 * 用法：node docs/evidence/ux-02c-05-r1-hardening/mutate.mjs
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

const SUITE = 'tests/suites/107-s11ux02c05r1-tree-hardening.test.ts';
const COMMANDS = 'apps/shell/src/state/tree-commands.ts';
const CONTEXT = 'apps/shell/src/components/TreeCommandsContext.tsx';

const mutations = [
  {
    id: 'C05R1-M1',
    desc: '双击窗口退回 200ms（普通用户 300–450ms 的连击会被当成单击，先打开再改名）',
    file: COMMANDS,
    from: `export const NAME_DOUBLE_CLICK_WINDOW = 500;`,
    to: `export const NAME_DOUBLE_CLICK_WINDOW = 200; // 变异：退回上一轮的窗口`,
    suite: SUITE,
  },
  {
    id: 'C05R1-M2',
    desc: '定时器到点不再核对资源身份（对象被替换后，旧点击照样打开新对象）',
    file: COMMANDS,
    from: `        // 到点再核一次：这 500ms 里对象可能已经被刷新/替换掉
        if (target === null || !stillSame(target)) return;
        input.onSingle();`,
    to: `        // 变异：到点直接激活，不核身份
        if (target === null) return;
        input.onSingle();`,
    suite: SUITE,
  },
  {
    id: 'C05R1-M3',
    desc: '双击第二下不核对"是否同一个资源"（第一次点击后换了文件，第二次照样改名）',
    file: COMMANDS,
    from: `      // 连击的第二下：必须和第一次属于**同一个资源**，否则整段手势作废
      if (detail >= 2) {
        if (armed !== null && !sameActivationResource(armed, identity)) {
          clear();
          armed = null;
          return;
        }
        clear();
        armed = identity;
        return;
      }`,
    to: `      // 变异：第二下无条件接管，不看和第一次是不是同一个资源
      if (detail >= 2) {
        clear();
        armed = identity;
        return;
      }`,
    suite: SUITE,
  },
  {
    id: 'C05R1-M4',
    desc: '锚缺失重新改为放行（"无法确认"被当成"身份一致"）',
    file: COMMANDS,
    from: `  if (target.nodeAnchor) {
    if (!input.currentAnchor) return '无法确认这一行的身份，命令没有执行';
    if (target.nodeAnchor !== input.currentAnchor) return '这一行对应的对象已经变化，命令没有执行';
  }`,
    to: `  if (target.nodeAnchor && input.currentAnchor && target.nodeAnchor !== input.currentAnchor) {
    // 变异：当前锚缺失时跳过比较，直接放行
    return '这一行对应的对象已经变化，命令没有执行';
  }`,
    suite: SUITE,
  },
  {
    id: 'C05R1-M5',
    desc: '会话归属不再比对工作区（旧世界的草稿可以提交到新世界）',
    file: COMMANDS,
    from: `  if (input.sessionScope !== input.currentScope) return 'scope-changed';`,
    to: `  // 变异：不检查工作区/模式归属`,
    suite: SUITE,
  },
  {
    id: 'C05R1-M6',
    desc: '组件算完归属却不拿结论挡住提交（复核退化成一次无用计算）',
    file: CONTEXT,
    from: `    if (gate !== 'ok') {
      setProjectRename(null);
      dispatch({ type: 'NOTICE', message: projectRenameGateMessage(gate) ?? '旧的改名会话已失效' });
      return;
    }`,
    to: `    // 变异：算完归属不复核，继续往下发请求`,
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
