/**
 * UX-02C-05 变异探针（证据工具，不参与产品代码）。
 *
 * 做法沿用 UX-02C-04-R1-H1：把一处关键判定改坏 → 跑套件 106 → 记录失败用例 → 还原 → 逐字节比对 SHA。
 * 目的不是"跑一遍绿的"，而是证明这 32 个用例**真的咬得住**这五处：
 * 矩阵守卫、hint 语义、双击仲裁、资源锚比对、菜单身份。
 *
 * 这一轮全部判定被抽到纯模块 `apps/shell/src/state/tree-commands.ts`，
 * 所以五个探针都打在这个文件上——如果哪天有人把判定搬回组件里，套件就再也咬不住了。
 *
 * 用法：node docs/evidence/ux-02c-05-tree-interactions/mutate.mjs
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

const SUITE = 'tests/suites/106-s11ux02c05-tree-interactions.test.ts';
const COMMANDS = 'apps/shell/src/state/tree-commands.ts';

const mutations = [
  {
    id: 'C05-M1',
    desc: '项目根菜单混入「移入回收区」（根的移除是 remove-project，不是扔回收区）',
    file: COMMANDS,
    from: `    trash: state(
      trash.visible && target.origin !== 'project-root',
      trash.disabled,
      trash.hint,
    ),`,
    to: `    trash: state(
      trash.visible, // 变异：不再排除项目根
      trash.disabled,
      trash.hint,
    ),`,
    suite: SUITE,
  },
  {
    id: 'C05-M2',
    desc: '可点的命令也带禁用原因（菜单上出现"能点却写着不支持"的自相矛盾）',
    file: COMMANDS,
    from: `  if (!disabled) return { visible, disabled: false };`,
    to: `  // 变异：可点也继续往下走，把 hint 透传出去`,
    suite: SUITE,
  },
  {
    id: 'C05-M3',
    desc: '名称单击不再延后（双击的第一下就把文件打开，改名随即被自己的会话保护挡住）',
    file: COMMANDS,
    from: `      clear();
      pending = input.setTimer(() => {
        pending = null;
        input.onSingle();
      }, input.delay);`,
    to: `      clear();
      input.onSingle(); // 变异：不等待，直接激活`,
    suite: SUITE,
  },
  {
    id: 'C05-M4',
    desc: '执行前不比对资源锚（同名新对象替换后仍执行旧命令）',
    file: COMMANDS,
    from: `  if (target.nodeAnchor && input.currentAnchor && target.nodeAnchor !== input.currentAnchor) {
    return '这一行对应的对象已经变化，命令没有执行';
  }`,
    to: `  // 变异：不比锚，只看路径还在不在`,
    suite: SUITE,
  },
  {
    id: 'C05-M5',
    desc: '菜单身份不含当前项目（切了项目，旧菜单里的命令还能执行到新项目上）',
    file: COMMANDS,
    from: `    input.workspaceKey ?? '',
    input.activeProjectId ?? '',
  ].join('\\u0000');`,
    to: `    input.workspaceKey ?? '',
    // 变异：不看当前项目
  ].join('\\u0000');`,
    suite: SUITE,
  },
  {
    /*
     * 纵深防御，如实记录：这一条**单独**退掉时套件仍然通过。
     *
     * 为什么：`doubleClick()` 自己也会 `clear()`，所以只要浏览器按标准顺序
     * 发出 click(1) → click(2) → dblclick，"第二下不再排定时器"这条就是冗余的。
     * 保留它是因为两个理由：dblclick 可能因为没有落在同一行/被组件卸载而缺席，
     * 那时它挡住的是"第二下又排一次单击"；以及 JSX 里 `onDoubleClick` 与
     * `onClick` 的绑定顺序不受我们控制。
     *
     * 不作为"判别力"计入结论——只证明我们知道自己防护了几层。
     */
    id: 'C05-M6',
    desc: '（纵深防御）去掉"连击第二下不排定时器"这条冗余守卫',
    file: COMMANDS,
    from: `      // 连击的第二下：交给 doubleClick，绝不在这里再激活一次
      if (detail >= 2) {
        clear();
        return;
      }`,
    to: `      // 变异：连击第二下也走"等一下再单击"`,
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
