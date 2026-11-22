"""UX-02C-03-P2-01-R2 变异探针（A–F）。

每个探针：备份 → 施加单点变异 → 跑目标套件 → 记录 not ok 行与 PASS/FAIL 计数
→ 立即还原。任何一次运行结束后都必须保证工作区与运行前逐字节一致。
"""
import io
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'docs' / 'evidence' / 'ux-02c-03-p2-01-r2'
PROVIDER = ROOT / 'packages' / 'storage' / 'local-provider.ts'
SERVER = ROOT / 'apps' / 'server' / 'src' / 'server.ts'

SUITE_91 = 'tests/suites/91-s11ux02c03p2r1-trash-concurrency.test.ts'
SUITE_93 = 'tests/suites/93-s11ux02c03p2r2-trash-provider-hardening.test.ts'
SUITE_94 = 'tests/suites/94-s11ux02c03p2r2-trash-host-replay.test.ts'


def read(path: Path) -> str:
    return io.open(path, encoding='utf-8').read()


def write(path: Path, text: str) -> None:
    io.open(path, 'w', encoding='utf-8', newline='').write(text)


PROBES = [
    {
        'id': 'A',
        'desc': '删除快速重放的 rootToken 比较（R2-01）',
        'file': SERVER,
        'old': "            replay.rootToken !== handle.rootToken ||\n",
        'new': '',
        'suites': [SUITE_94],
        'expect_fail': ['R2-01a'],
    },
    {
        'id': 'B',
        'desc': "把占位 close 失败改回普通 REJECTED（R2-02）",
        'file': PROVIDER,
        'old': (
            "    const probe = await probeReservation(absPath, identity);\n"
            "    if (probe.status === 'owned') await releaseReservation(absPath, identity);\n"
            "    return { status: 'UNKNOWN' };"
        ),
        'new': "    return { status: 'REJECTED', errorCode: 'ERR_STORAGE_IO' };",
        'suites': [SUITE_93, SUITE_94],
        'expect_fail': ['R2-02a', 'R2-02b', 'R2-02c', 'R2-02d'],
    },
    {
        'id': 'C',
        'desc': '删除 restoreEntry 的目录完整性检查（R2-03 主体）',
        'file': PROVIDER,
        'old': (
            "      const source = await verifyRestoreSourceReadOnly(\n"
            "        boundary,\n"
            "        establishedToken,\n"
            "        opId,\n"
            "        target,\n"
            "        expectedIdentity,\n"
            "      );\n"
            "      if (!source.ok) return reject(source.errorCode);\n"
        ),
        'new': '',
        'suites': [SUITE_93],
        'expect_fail': ['R2-03a', 'R2-03c', 'R2-03d', 'R2-03e', 'R2-03g', 'R2-03h', 'R2-03i'],
    },
    {
        'id': 'D',
        'desc': '删除清单 identity 与记录身份的比对（R2-03b）',
        'file': PROVIDER,
        'old': (
            "  if (typeof row.identity !== 'string' || row.identity !== expectedIdentity) {\n"
            "    return { ok: false, errorCode: 'ERR_TRASH_STATE_CONFLICT' };\n"
            "  }"
        ),
        'new': (
            "  if (typeof row.identity !== 'string') {\n"
            "    return { ok: false, errorCode: 'ERR_TRASH_STATE_CONFLICT' };\n"
            "  }"
        ),
        'suites': [SUITE_93],
        'expect_fail': ['R2-03b'],
    },
    {
        'id': 'E',
        'desc': '删除临时文件 dev:ino 复核（R2-04）',
        'file': PROVIDER,
        'old': (
            "  if (!(await tmpFileStillOwned(tmpAbs, tmpIdentity))) {\n"
            "    await discardTmpFile(tmpAbs, tmpIdentity);\n"
            "    return { ok: false, errorCode: 'ERR_TRASH_UNAVAILABLE' };\n"
            "  }\n"
        ),
        'new': '',
        'suites': [SUITE_93],
        # R2-04d（临时文件被删除）不是判别用例：即便没有这一步复核，`rename` 本身
        # 也会因源不存在而失败，行为完全一致。它作为纵深防御保留，不宣称判别力。
        'expect_fail': ['R2-04a', 'R2-04b', 'R2-04c'],
    },
    {
        'id': 'F',
        'desc': '移除并发测试屏障（R2-06）',
        'file': SERVER,
        'old': (
            "            // 仅测试注入：并发用例在这里汇合，确保两边都已越过重放检查（R2-06）\n"
            "            await options.managedTrashBarrier?.({ projectId: request.projectId, opId: request.opId });\n"
        ),
        'new': '',
        'suites': [SUITE_91],
        'expect_fail': ['R2-06'],
    },
]


def run_suite(rel: str) -> str:
    env = dict(os.environ)
    tmp = 'C:/Users/Administrator/AppData/Local/Temp'
    env['TMP'] = env['TEMP'] = env['TMPDIR'] = tmp
    proc = subprocess.run(
        ['node', rel],
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
    )
    return proc.stdout + proc.stderr


def summarize(output: str) -> tuple[list[str], str]:
    fails = [line.strip() for line in output.splitlines() if line.startswith('not ok ')]
    counts = [line.strip() for line in output.splitlines() if line.startswith('# pass') or line.startswith('# fail')]
    return fails, ' | '.join(counts)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    backups = {}
    for path in (PROVIDER, SERVER):
        backups[path] = path.read_bytes()

    verdicts = []
    try:
        for probe in PROBES:
            path = probe['file']
            text = read(path)
            assert text.count(probe['old']) == 1, f"探针 {probe['id']} 锚点不唯一：{text.count(probe['old'])}"
            write(path, text.replace(probe['old'], probe['new']))
            try:
                report = [f"# 探针 {probe['id']}：{probe['desc']}", f"# mutated: {path.name}", '']
                all_fails: list[str] = []
                for suite in probe['suites']:
                    out = run_suite(suite)
                    fails, counts = summarize(out)
                    all_fails.extend(fails)
                    report.append(f"--- {suite}")
                    report.append(counts or '(no summary)')
                    report.extend(fails or ['(no failing test)'])
                    report.append('')
                expected = probe['expect_fail']
                bitten = [name for name in expected if any(name in line for line in all_fails)]
                verdict = 'BITTEN' if len(bitten) == len(expected) else 'SURVIVED'
                report.append(f"# 期望咬住：{', '.join(expected)}")
                report.append(f"# 实际咬住：{', '.join(bitten) if bitten else '(none)'}")
                report.append(f"# 结论：{verdict}")
                (OUT / f"probe-{probe['id']}.txt").write_text('\n'.join(report) + '\n', encoding='utf-8')
                verdicts.append((probe['id'], verdict, bitten, expected))
                print(f"probe {probe['id']}: {verdict} bitten={bitten}")
            finally:
                path.write_bytes(backups[path])
    finally:
        for path, blob in backups.items():
            path.write_bytes(blob)

    lines = ['# 变异探针汇总（UX-02C-03-P2-01-R2）', '']
    for pid, verdict, bitten, expected in verdicts:
        lines.append(f"- {pid}: {verdict}（期望 {len(expected)} 个用例，咬住 {len(bitten)} 个）")
    (OUT / 'probe-summary.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return 0


if __name__ == '__main__':
    sys.exit(main())
