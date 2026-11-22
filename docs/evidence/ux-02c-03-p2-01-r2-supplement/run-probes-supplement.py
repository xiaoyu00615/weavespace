"""UX-02C-03-P2-01-R2-Supplement 变异探针（G / G2 / H）。

与上一轮的 `../ux-02c-03-p2-01-r2/run-probes.py` 相互独立：本轮只针对新增的
"清单字节数三方一致"与"时间戳严格格式"两项保护，不重复修改原有 A–F 的实现。

每个探针：施加单点变异 → 跑套件 93 → 记录 not ok 行与计数 → 立即还原。
"""
import io
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'docs' / 'evidence' / 'ux-02c-03-p2-01-r2-supplement'
PROVIDER = ROOT / 'packages' / 'storage' / 'local-provider.ts'
SUITE_93 = 'tests/suites/93-s11ux02c03p2r2-trash-provider-hardening.test.ts'

PROBES = [
    {
        'id': 'G',
        'desc': '删除"清单 size 与 payload 实际大小"的比较（A1 / 磁盘侧）',
        'old': "      if (source.manifestSize !== payloadStats.size) {",
        'new': "      if (false) {",
        'expect_fail': ['R2-03j', 'R2-03k'],
    },
    {
        'id': 'G2',
        'desc': '删除"清单 size 与配置记录 size"的比较（A1 / 记录侧）',
        'old': "  if (row.size !== expectedSize) {",
        'new': "  if (row.size < 0) {",
        'expect_fail': ['R2-03q'],
    },
    {
        'id': 'H',
        'desc': '把严格 ISO 校验退回 Date.parse（A2）',
        'old': "  if (!isSystemIsoTimestamp(row.deletedAt)) {",
        'new': "  if (Number.isNaN(Date.parse(String(row.deletedAt)))) {",
        'expect_fail': ['R2-03n', 'R2-03o'],
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


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    backup = PROVIDER.read_bytes()
    verdicts = []
    try:
        for probe in PROBES:
            text = io.open(PROVIDER, encoding='utf-8').read()
            assert text.count(probe['old']) == 1, f"探针 {probe['id']} 锚点不唯一"
            mutated = text.replace(probe['old'], probe['new'])
            with io.open(PROVIDER, 'w', encoding='utf-8', newline='') as handle:
                handle.write(mutated)
                handle.flush()
            # 读回确认变异真的落盘：否则跑的是未变异的代码，结论会假阳性
            on_disk = io.open(PROVIDER, encoding='utf-8').read()
            assert probe['new'] in on_disk and probe['old'] not in on_disk, f"探针 {probe['id']} 变异未落盘"
            try:
                out = run_suite(SUITE_93)
            finally:
                PROVIDER.write_bytes(backup)
            fails = [line.strip() for line in out.splitlines() if line.startswith('not ok ')]
            counts = [
                line.strip()
                for line in out.splitlines()
                if line.startswith('# pass') or line.startswith('# fail')
            ]
            expected = probe['expect_fail']
            bitten = [name for name in expected if any(name in line for line in fails)]
            verdict = 'BITTEN' if len(bitten) == len(expected) else 'SURVIVED'
            report = [
                f"# 探针 {probe['id']}：{probe['desc']}",
                f"# mutated: {PROVIDER.name}",
                '',
                ' | '.join(counts),
                *fails,
                '',
                f"# 期望咬住：{', '.join(expected)}",
                f"# 实际咬住：{', '.join(bitten) if bitten else '(none)'}",
                f"# 结论：{verdict}",
            ]
            (OUT / f'probe-{probe["id"]}.txt').write_text('\n'.join(report) + '\n', encoding='utf-8')
            verdicts.append((probe['id'], verdict, bitten, expected))
            print(f"probe {probe['id']}: {verdict} bitten={bitten}")
    finally:
        PROVIDER.write_bytes(backup)

    lines = ['# 变异探针汇总（R2-Supplement）', '']
    for pid, verdict, bitten, expected in verdicts:
        lines.append(f'- {pid}: {verdict}（期望 {len(expected)} 个用例，咬住 {len(bitten)} 个）')
    (OUT / 'probe-summary.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return 0


if __name__ == '__main__':
    sys.exit(main())
