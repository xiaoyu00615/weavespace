/**
 * UX-02C-02-R2 变异探针（证据工具，不参与产品代码）。
 *
 * 做法与前几轮一致：把一处关键判定改坏 → 跑相关套件 → 记录失败用例 → 还原 →
 * 逐字节比对 SHA-256（`restoreExact` 必须为 true）。
 *
 * 覆盖本阶段的三层缺口，每个探针只改一处：
 * - M01 Shell 丢原始锚（把预期锚换成空串）
 * - M02 Shell 不拦无锚（删掉本地那道"没有锚不发请求"）
 * - M03 Host 容许无锚 / 非法锚（形状校验整段跳过）
 * - M04 Host 忽略锚不匹配（只读身份、不比对）
 * - M05 Host 跳过 Provider 身份能力检查（退化成注定失败的路径操作）
 * - M06 Provider 忽略预期源身份（第一处比对）
 * - M07 Provider 删掉 rename 前的最终复核
 * - M08 Host 跳过会话保护
 * - M09 Shell 在 UNKNOWN 之后自动重发
 * - M10 Shell 不把"源对象已变"的拒绝上报给层表（旧锚永久留在缓存层里）
 * - M11 记录核验被绕过：路径上已经没有对象也当作"仍然成立"（旧记录跟着名字走）
 *
 * 用法：node docs/evidence/ux-02c-02-r2-structure-intent/mutate.mjs
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

const SUITE_R2 = 'tests/suites/110-s11ux02c02r2-structure-intent-identity.test.ts';
const SUITE_SHELL = 'tests/suites/73-s11ux02c02-structure-shell.test.ts';
const SHELL_STRUCTURE = 'apps/shell/src/state/structure-change.ts';
const HOST_STRUCTURE = 'apps/server/src/structure-change.ts';
const PROVIDER = 'packages/storage/local-provider.ts';
const HIDDEN = 'apps/server/src/hidden.ts';

const mutations = [
  {
    id: 'C02R2-M01',
    desc: 'Shell 丢原始锚：核验过了，但发请求时把预期换成空串',
    file: SHELL_STRUCTURE,
    suite: SUITE_R2,
    from: `              ? await host.rename(input.projectId, input.sourcePath, input.targetName, input.sourceAnchor)`,
    to: `              ? await host.rename(input.projectId, input.sourcePath, input.targetName, '')`,
  },
  {
    id: 'C02R2-M02',
    desc: 'Shell 不拦无锚：没有身份预期也照发请求',
    file: SHELL_STRUCTURE,
    suite: SUITE_R2,
    from: `        if (typeof input.sourceAnchor !== 'string' || input.sourceAnchor === '') {
          host.onNotice(MISSING_INTENT_NOTICE);
          return 'rejected';
        }`,
    to: `        // 变异：没有锚也照发`,
  },
  {
    id: 'C02R2-M03',
    desc: 'Host 容许无锚 / 非法锚：形状校验整段跳过',
    file: HOST_STRUCTURE,
    suite: SUITE_R2,
    from: `  const rawAnchor = typeof body.sourceAnchor === 'string' ? body.sourceAnchor.trim() : '';
  if (rawAnchor === '') {
    return {
      ok: false,
      errorCode: 'ERR_STRUCTURE_INTENT_MISSING',
      message: '缺少源文件的身份信息，未执行任何变更',
    };
  }
  if (!SOURCE_ANCHOR_RE.test(rawAnchor)) {
    return {
      ok: false,
      errorCode: 'ERR_COMMAND_INVALID',
      message: '源文件的身份信息形状非法',
    };
  }
  const anchor = rawAnchor;`,
    to: `  // 变异：缺锚与形状非法都当成"一个锚"往下走
  const anchor = typeof body.sourceAnchor === 'string' ? body.sourceAnchor.trim() : '';`,
  },
  {
    id: 'C02R2-M04',
    desc: 'Host 忽略锚不匹配：读了源身份却不比对',
    file: HOST_STRUCTURE,
    suite: SUITE_R2,
    from: `      if (expectedAnchor !== request.sourceAnchor) {
        return reject('ERR_ENTRY_SOURCE_CHANGED');
      }`,
    to: `      // 变异：读到了身份但不与预期比对`,
  },
  {
    id: 'C02R2-M05',
    desc: 'Host 跳过 Provider 身份能力检查：声明不支持时退化成路径操作',
    file: HOST_STRUCTURE,
    suite: SUITE_R2,
    from: `  if (typeof provider.identityOf !== 'function') {
    return reject('ERR_ENTRY_IDENTITY_UNVERIFIED');
  }`,
    to: `  // 变异：Provider 没有身份能力也照样往下走`,
  },
  {
    id: 'C02R2-M06',
    desc: 'Provider 忽略预期源身份（第一处比对）',
    file: PROVIDER,
    suite: SUITE_R2,
    from: `        sourceIdentity = \`\${info.dev}:\${info.ino}\`;
        if (sourceIdentity !== expectedIdentity) return reject('ERR_ENTRY_SOURCE_CHANGED');`,
    to: `        sourceIdentity = \`\${info.dev}:\${info.ino}\`;`,
  },
  {
    id: 'C02R2-M07',
    desc: 'Provider 删掉 rename 前的最终复核（占位期间被替换也照搬）',
    file: PROVIDER,
    suite: SUITE_R2,
    from: `      try {
        const again = await lstat(sourceAbs);
        if (\`\${again.dev}:\${again.ino}\` !== expectedIdentity) {
          return await rejectSourceChanged('ERR_ENTRY_SOURCE_CHANGED');
        }
      } catch (err) {
        if (isMissing(err)) return await rejectSourceChanged('ERR_RESOURCE_NOT_FOUND');
        // 读不出来又不确定是什么错：磁盘可能已被动过，不能宣称零副作用
        return await rejectSourceChanged('ERR_STORAGE_IO');
      }`,
    to: `      // 变异：删掉 rename 前的最终身份复核`,
  },
  {
    id: 'C02R2-M08',
    desc: 'Host 跳过会话保护（有活动 View / 危险草稿也照样搬）',
    file: HOST_STRUCTURE,
    suite: SUITE_R2,
    from: `      const blockedBy = structureSessionBlockers(sessions);
      if (blockedBy.length > 0) {
        return {
          status: 'REJECTED' as const,
          errorCode: 'ERR_STRUCTURE_SESSION_BUSY' as const,
          blockedBy,
        };
      }`,
    to: `      // 变异：跳过会话保护`,
  },
  {
    id: 'C02R2-M09',
    desc: 'Shell 在 UNKNOWN 之后自动重发一次',
    file: SHELL_STRUCTURE,
    suite: SUITE_SHELL,
    from: `        if (outcome.status === 'UNKNOWN') {
          await host
            .checkLocations(input.projectId, parentDirOfEntry(input.sourcePath), input.targetParentDir)
            .catch(() => {});`,
    to: `        if (outcome.status === 'UNKNOWN') {
          // 变异：把 UNKNOWN 当"没成功"，再发一次
          await host.rename(input.projectId, input.sourcePath, input.targetName, input.sourceAnchor).catch(() => {});
          await host
            .checkLocations(input.projectId, parentDirOfEntry(input.sourcePath), input.targetParentDir)
            .catch(() => {});`,
  },
  {
    id: 'C02R2-M10',
    desc: 'Shell 不把"源对象已变"的拒绝上报给层表（旧锚永久留在缓存层里，用户无法重试）',
    file: SHELL_STRUCTURE,
    suite: SUITE_SHELL,
    from: `        host.onRejected?.(outcome, { projectId: input.projectId, sourcePath: input.sourcePath });`,
    to: `        // 变异：拒绝只弹提示，不告诉层表"这一行的锚已经过期"`,
  },
  {
    id: 'C02R2-M11',
    desc: '记录核验被绕过：路径上已经没有对象，也当作"仍然成立"（旧记录被当成新对象的）',
    file: HIDDEN,
    suite: SUITE_R2,
    from: `    const now = await probe.identityOf(record.path);
    if (now === null) return 'missing';`,
    to: `    const now = await probe.identityOf(record.path);
    // 变异：找不到也当作仍然成立
    if (now === null) return 'active';`,
  },
];

const results = [];

for (const mutation of mutations) {
  const target = join(repo, mutation.file);
  const original = await readFile(target);
  const baselineSha = sha(original);
  const text = original.toString('utf8');
  /**
   * 仓库里有 CRLF 文件（`apps/server/src/structure-change.ts` 就是）。
   * 标记统一用 `\n` 写，落盘前按目标文件的实际换行还原，避免"改不动"被误报成探针失效。
   */
  const crlf = text.includes('\r\n');
  const from = crlf ? mutation.from.replace(/\n/g, '\r\n') : mutation.from;
  const to = crlf ? mutation.to.replace(/\n/g, '\r\n') : mutation.to;
  if (!text.includes(from)) {
    results.push({ id: mutation.id, verdict: 'MISSING_MARKER', file: mutation.file });
    continue;
  }
  const mutated = text.replace(from, to);
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
  console.log(`${mutation.id}: ${results[results.length - 1].verdict} (${failedTests.length} failed)`);
}

const report = { at: new Date().toISOString(), results };
await writeFile(join(here, 'mutations.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
