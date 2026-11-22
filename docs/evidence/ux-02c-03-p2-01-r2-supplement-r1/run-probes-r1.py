"""UX-02C-03-P2-01-R2-Supplement-R1 变异探针（I / J / K）。

每个探针：施加单点变异（读回校验已落盘）→ 跑套件 93 → 记录 not ok 行与计数 → 立即还原。
不触碰上一轮 A–F / G–H 的脚本与证据。
"""
import io
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'docs' / 'evidence' / 'ux-02c-03-p2-01-r2-supplement-r1'
PROVIDER = ROOT / 'packages' / 'storage' / 'local-provider.ts'
CONFIG = ROOT / 'apps' / 'server' / 'src' / 'store' / 'config.ts'
SIZE_MOD = ROOT / 'packages' / 'storage' / 'trash-size.ts'
SUITE_93 = 'tests/suites/93-s11ux02c03p2r2-trash-provider-hardening.test.ts'

PROBES = [
    {
        'id': 'I',
        'desc': '最终复核只比身份、删掉字节数比较（R1-01）',
        'file': PROVIDER,
        'old': "  return info.size === expectedSize && info.size === manifestSize;",
        'new': "  return true;",
        'expect_fail': ['R1-01a', 'R1-01b'],
    },
    {
        'id': 'J',
        'desc': '配置解析退回 Number.isInteger（R1-02 / Store 侧）',
        'file': CONFIG,
        'old': "  if (!isTrashSizeSupported(size)) return undefined;",
        'new': "  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) return undefined;",
        'expect_fail': ['R1-02b'],
    },
    {
        'id': 'K',
        'desc': '共用长度判定退回 Number.isInteger（R1-02 / 判定本身）',
        'file': SIZE_MOD,
        'old': "  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;",
        'new': "  return typeof value === 'number' && Number.isInteger(value) && value >= 0;",
        'expect_fail': ['R1-02a'],
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
    backups = {p: p.read_bytes() for p in (PROVIDER, CONFIG, SIZE_MOD)}
    verdicts = []
    try:
        for probe in PROBES:
            path = probe['file']
            text = io.open(path, encoding='utf-8').read()
            assert text.count(probe['old']) == 1, f"探针 {probe['id']} 锚点不唯一"
            with io.open(path, 'w', encoding='utf-8', newline='') as handle:
                handle.write(text.replace(probe['old'], probe['new']))
                handle.flush()
            on_disk = io.open(path, encoding='utf-8').read()
            assert probe['new'] in on_disk and probe['old'] not in on_disk, f"探针 {probe['id']} 变异未落盘"
            try:
                out = run_suite(SUITE_93)
            finally:
                path.write_bytes(backups[path])
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
                f"# mutated: {path.name}",
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
        for path, blob in backups.items():
            path.write_bytes(blob)

    lines = ['# 变异探针汇总（R2-Supplement-R1）', '']
    for pid, verdict, bitten, expected in verdicts:
        lines.append(f'- {pid}: {verdict}（期望 {len(expected)} 个用例，咬住 {len(bitten)} 个）')
    (OUT / 'probe-summary.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return 0


if __name__ == '__main__':
    sys.exit(main())
