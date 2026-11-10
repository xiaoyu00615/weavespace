#!/usr/bin/env python3
"""Read-only package integrity checker. No network, Git, or business-code execution."""
from pathlib import Path
import json, sys, re
ROOT=Path(__file__).resolve().parents[1]
required=[
 'README.md','START_HERE_首次落地.md','.gitignore','.editorconfig','.gitattributes',
 'docs/00_基线状态与裁决.md','docs/02_总体架构.md','docs/03_模块职责与接口清单.md',
 'docs/04_核心数据契约.md','docs/05_插件SDK与生命周期.md','docs/09_日志监控诊断规范.md',
 'docs/11_工程阶段时间线.md','docs/12_工程硬约束与验收.md','docs/13_GitHub双电脑配置.md',
 'docs/14_测试策略与故障注入.md','docs/15_架构审查与剩余风险.md',
 'contracts/schemas/plugin-manifest.schema.json','contracts/schemas/command-envelope.schema.json',
 'references/user-ui-wireframe.png',
 'examples/weavespace-canvas-proposal.json',
 'examples/portable-project-proposal.json',
 'examples/plugin-manifest.json'
]
errors=[]
for p in required:
    if not (ROOT/p).is_file():errors.append('MISSING '+p)
for p in list((ROOT/'examples').glob('*.json'))+list((ROOT/'contracts').rglob('*.json')):
    try:json.loads(p.read_text(encoding='utf-8'))
    except Exception as e:errors.append(f'INVALID_JSON {p.relative_to(ROOT)}: {e}')
for i in range(1,7):
    files=list((ROOT/'diagrams').glob(f'{i:02d}_*.dot'))
    if len(files)!=1:errors.append(f'DIAGRAM_SOURCE_MISSING_{i:02d}');continue
    for suffix in ('.png','.svg'):
        if not files[0].with_suffix(suffix).is_file():errors.append(f'DIAGRAM_RENDER_MISSING_{i:02d}{suffix}')
    if files[0].stat().st_size<100:errors.append(f'DIAGRAM_TOO_SMALL_{i:02d}')
# Sanity-check the root README, repository path and candidate format names.
readme=(ROOT/'README.md').read_text(encoding='utf-8') if (ROOT/'README.md').is_file() else ''
if '织界 WeaveSpace' not in readme: errors.append('BRAND_MISSING_README')
if 'projects\\weavespace' not in readme: errors.append('REPO_PATH_MISSING_README')
for rel in ('examples/portable-project-proposal.json','examples/weavespace-canvas-proposal.json'):
    p=ROOT/rel
    if p.is_file():
        fmt=json.loads(p.read_text(encoding='utf-8')).get('format')
        if fmt not in ('wcanvas','wproject'):errors.append('INVALID_NEW_FORMAT '+rel)
if errors:
    print('PACKAGE CHECK FAILED:')
    for e in errors:print(' -',e)
    sys.exit(1)
print('PACKAGE_STRUCTURE_CHECK: PASS')
print('NOTE: static packaging check only; no implementation or reliability tests were run.')
