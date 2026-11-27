/**
 * 汇总 UX-02C-04 的浏览器证据。
 *
 * 只做"把已经发生的真实结果整理成 JSON"，不产生任何新的判定：
 * 每一条 PASS/FAIL 都直接来自 `phase1.log` / `phase2.log`。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const BASE = 'D:/Workspace/projects/weavespace-test/c04';
const ROOT_A = join(BASE, 'projA');
const ROOT_B = join(BASE, 'projB');

const parse = (file) => {
  const text = readFileSync(file, 'utf8');
  const checks = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s+(PASS|FAIL) (C-[\w-]+.*)$/.exec(line);
    if (match) checks.push({ ok: match[1] === 'PASS', name: match[2].trim() });
  }
  const summary = /SUMMARY (\{.*\})/.exec(text);
  return { checks, summary: summary ? JSON.parse(summary[1]) : null };
};

const phase1 = parse('phase1.log');
const phase2 = parse('phase2.log');
const state = JSON.parse(readFileSync('state.json', 'utf8'));
const store = JSON.parse(readFileSync(join(BASE, 'store/workspace.json'), 'utf8'));

const sha = (path) => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null);
const walk = (dir, prefix = '') => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else out.push({ path: rel, size: statSync(join(dir, entry.name)).size, sha256: sha(join(dir, entry.name)) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
};

const allChecks = [...phase1.checks, ...phase2.checks];
const failed = allChecks.filter((check) => !check.ok).map((check) => check.name);

const payload = {
  run: 'ux-02c-04-resource-metadata',
  at: new Date().toISOString(),
  environment: {
    host: 'http://127.0.0.1:5297',
    app: 'http://127.0.0.1:5298',
    chrome: 'headless via CDP 9347',
    workspace: BASE,
    note: '真实 Host + 真实 Vite + 真实 Chrome + 真实文件系统；未使用用户真实工作文件',
  },
  phases: {
    phase1: { ...phase1.summary, checks: phase1.checks },
    phase2: { ...phase2.summary, checks: phase2.checks },
  },
  summary: {
    total: allChecks.length,
    passed: allChecks.length - failed.length,
    failed,
  },
  filesystem: {
    annotatedFileAfterPhase1: {
      path: 'projA/note.md',
      sha256: state.sha,
    },
    afterPhase2: {
      // 改名 + 移动 + 回收 + 恢复之后，文件应当在 docs 里、内容一字未变
      restoredPath: 'projA/docs/renamed.md',
      sha256: sha(join(ROOT_A, 'docs/renamed.md')),
      sameAsBefore: sha(join(ROOT_A, 'docs/renamed.md')) === state.sha,
      projAFiles: walk(ROOT_A).filter((file) => !file.path.startsWith('.weavespace')),
      projBFiles: walk(ROOT_B).filter((file) => !file.path.startsWith('.weavespace')),
    },
  },
  workspaceConfig: {
    version: store.version,
    metadataEntries: (store.metadata ?? []).length,
    hiddenEntries: (store.hidden ?? []).length,
    trashEntries: (store.trash ?? []).length,
    note: 'phase2 结束时标注已全部清除，配置里 metadata 为空；回收记录保留（恢复过的历史）',
  },
};

writeFileSync('browser-verification.json', `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(payload.summary));
console.log('files', payload.filesystem.afterPhase2.projAFiles.map((file) => file.path).join(','));
