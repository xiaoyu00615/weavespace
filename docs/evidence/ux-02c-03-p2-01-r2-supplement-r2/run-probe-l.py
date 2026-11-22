"""R2-Supplement-R2 单点变异：把最终 payload 复核移回"占位归属复核之前"。

只撤销本轮的唯一保护（复核位置），其余代码不动：
- 不删除 `payloadStillMatches` 本身；
- 不删除 `ensureReservationOwned` / C1 / `assertRootContinuity`；
- 只把那段 if 块整体移到 `afterMoveReserve` 之后。

预期：R2-02a / R2-02b 失败（MOVED），R1-01a/b 仍然通过（它们的注入点更早）。
"""
import io
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PROVIDER = ROOT / 'packages' / 'storage' / 'local-provider.ts'
SUITE = ROOT / 'tests' / 'suites' / '93-s11ux02c03p2r2-trash-provider-hardening.test.ts'

EARLY_ANCHOR = '      faults.afterMoveReserve?.();\n'
CHECK_START = '      /**\n       * 最终复核（R1-01 / R2-Supplement-R2 调整位置）'
RENAME_ANCHOR = '      try {\n        await rename(payloadAbs, targetAbs);'


def run_suite() -> tuple[int, set[str], list[str]]:
    env = dict(os.environ)
    tmp = 'C:/Users/Administrator/AppData/Local/Temp'
    env['TMP'] = env['TEMP'] = env['TMPDIR'] = tmp
    proc = subprocess.run(
        ['node', str(SUITE)],
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
    )
    text = (proc.stdout or '') + (proc.stderr or '')
    lines = text.splitlines()
    failed = {line.split(' - ', 1)[1] for line in lines if line.startswith('not ok')}
    summary = [line for line in lines if line.startswith('# ') and not line.startswith('# SKIP')]
    return proc.returncode, failed, summary


def main() -> int:
    original = PROVIDER.read_bytes()
    text = original.decode('utf-8')

    # 锚点必须只在 restoreEntry 的范围内找：`afterMoveReserve` 在 trashEntry 里也有，
    # 从文件开头 index() 会把代码块塞进回收路径（第一次就踩了这个坑，4 个用例连带失败）。
    scope = text.index('    async restoreEntry(')

    start = text.index(CHECK_START, scope)
    end = text.index(RENAME_ANCHOR, start)
    block = text[start:end]
    rest = text[:start] + text[end:]

    insert_at = rest.index(EARLY_ANCHOR, scope) + len(EARLY_ANCHOR)
    mutated = rest[:insert_at] + '\n' + block + rest[insert_at:]

    try:
        with io.open(PROVIDER, 'w', encoding='utf-8', newline='') as handle:
            handle.write(mutated)
            handle.flush()

        # 读回确认变异真的落盘，且顺序确实变成"复核在 guard 之前"
        on_disk = io.open(PROVIDER, encoding='utf-8').read()
        check_pos = on_disk.index(CHECK_START, on_disk.index('    async restoreEntry('))
        guard_pos = on_disk.index('      // P1-01：目标占位归属复核', check_pos)
        assert check_pos < guard_pos, '变异未生效：复核仍在归属复核之后'
        assert 'payloadStillMatches(payloadAbs, expectedIdentity, expectedSize, source.manifestSize)' in on_disk

        code, failed, summary = run_suite()
    finally:
        with io.open(PROVIDER, 'wb') as handle:
            handle.write(original)

    # 只应咬住这两个：R1-01a/b 的注入点更早，顺序调整不影响它们
    expected = {'R2-02a', 'R2-02b'}
    bitten = {row.split(' ', 1)[0] for row in failed}
    print('mutated-order-ok=True')
    print('exit', code)
    print('failed:', ', '.join(sorted(bitten)) or '(none)')
    print('\n'.join(summary))
    missing = expected - bitten
    extra = bitten - expected
    ok = not missing and not extra
    if extra:
        print('probe L: 咬到非预期用例', sorted(extra), '——变异范围不干净')
    print('probe L:', 'BITTEN' if ok else f'SURVIVED(未咬住 {sorted(missing)})')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
