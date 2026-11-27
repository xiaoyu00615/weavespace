/**
 * UX-02C-04-R1 变异探针（证据工具，不参与产品代码）。
 *
 * 做法：把某一处关键判定改坏 → 跑对应套件 → 记录失败的用例 → 还原 → 逐字节比对 SHA。
 * 目的是证明新增用例**真的咬得住**这次修复，而不是"改不改都绿"。
 *
 * 用法：node docs/evidence/ux-02c-04-r1-metadata-identity/mutate.mjs
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
const SHELL_SUITE = 'tests/suites/104-s11ux02c04r1-metadata-session-shell.test.ts';

const mutations = [
  {
    id: 'R1-A',
    desc: 'R1-01：增量合并退回"只按项目 + 路径"匹配（同名新对象会继承旧标注）',
    file: 'apps/server/src/store/file-store.ts',
    from: `          entry.rootToken === input.rootToken &&
          entry.identity === input.identity,
      );

      // 只有当记录真的属于**同一个对象**时才做增量合并；否则本次是一条新记录`,
    to: `          entry.rootToken === input.rootToken,
      );

      // 只有当记录真的属于**同一个对象**时才做增量合并；否则本次是一条新记录`,
    suite: HOST_SUITE,
  },
  {
    id: 'R1-B',
    desc: 'R1-02：迁移不再核验目标位置的对象身份（按路径前缀无条件迁移）',
    file: 'apps/server/src/server.ts',
    from: `                    if (now === null || now !== record.identity) continue;`,
    to: `                    void now; // 变异：不核验身份`,
    suite: HOST_SUITE,
  },
  {
    id: 'R1-C',
    desc: 'R1-03：设置端点忽略资源锚（过期会话仍能写到新对象上）',
    file: 'apps/server/src/server.ts',
    from: `  if (input.anchor === undefined) return;`,
    to: `  return; // 变异：忽略资源锚`,
    suite: HOST_SUITE,
  },
  {
    id: 'R1-D',
    desc: 'R1-03：清除一律按"清理失效记录"执行（会删掉同路径别的身份）',
    file: 'apps/server/src/server.ts',
    from: `      const scope: 'object' | 'stale' = request.scope === 'stale' ? 'stale' : identity === null ? 'stale' : 'object';`,
    to: `      const scope: 'object' | 'stale' = 'stale'; // 变异：清除一律走失效清理`,
    suite: HOST_SUITE,
  },
  {
    id: 'R1-E',
    desc: 'R1-03：请求返回后不再核对工作区归属（旧结果会刷新新工作区）',
    file: 'apps/shell/src/state/metadata-session.ts',
    from: `  if (host.identityKey() !== binding.key) {
    return { kind: 'stale', reason: 'workspace-switched' };
  }

  if (outcome.status === 'UNKNOWN') {`,
    to: `  if (false) {
    return { kind: 'stale', reason: 'workspace-switched' };
  }

  if (outcome.status === 'UNKNOWN') {`,
    suite: SHELL_SUITE,
  },
  {
    id: 'R1-F',
    desc: 'R1-04：client 丢弃真实的 metadataMigration（一律当 none）',
    file: 'apps/shell/src/client/client-api.ts',
    from: `          metadataMigration: migration,`,
    to: `          metadataMigration: 'none' as const, // 变异：丢弃真实结论`,
    suite: SHELL_SUITE,
  },
  {
    id: 'R1-G',
    desc: 'R1-01：内容保存后不再把标注绑到新身份（标注会在编辑一次后消失）',
    file: 'apps/server/src/server.ts',
    from: `          if (metadataPrepared) await applyMetadataRefresh(metadataPrepared, savedIdentity);`,
    to: `          void metadataPrepared; // 变异：不做身份再绑定`,
    suite: HOST_SUITE,
  },
  {
    id: 'R1-H',
    desc: 'R1-01：校验和的 canonical 投影多带一个字段（既有 v5 配置的校验和失效）',
    file: 'apps/server/src/store/config.ts',
    from: `      color: entry.color ?? null,
      updatedAt: entry.updatedAt,
    }));`,
    to: `      color: entry.color ?? null,
      updatedAt: entry.updatedAt,
      pathKey: entry.path,
    }));`,
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
    const out = await run(
      process.execPath,
      ['--experimental-strip-types', '--test', mutation.suite],
      { cwd: repo, env: { ...process.env, TMP: process.env.TMP, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR } },
    );
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
