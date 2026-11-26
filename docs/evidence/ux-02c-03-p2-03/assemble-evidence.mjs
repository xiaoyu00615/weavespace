/**
 * 把四段浏览器验证的原始结果 + 变异结果 + 门禁日志汇总成两份交付 JSON。
 *
 * 只做汇总与重排，不改任何断言结果：`checks` 原样搬运，`summary` 重新计数。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, here), 'utf8'));
const readText = (name) => readFileSync(new URL(name, here), 'utf8');

const lifecycle = read('./lifecycle-raw.json');
const unknown = read('./unknown-raw.json');
const tabs = read('./tabs-raw.json');
const restarts = ['1', '2', '3'].map((phase) => read(`./restart-${phase}-raw.json`));

const parts = [
  { name: 'B2/B3 生命周期与安全保护', result: lifecycle },
  { name: 'B4 UNKNOWN 三场景', result: unknown },
  { name: 'B5 真实跨标签页', result: tabs },
  ...restarts.map((item, index) => ({ name: `B6 重启阶段 ${index + 1}`, result: item })),
];

const checks = {};
for (const part of parts) Object.assign(checks, part.result.checks);
const failed = Object.entries(checks)
  .filter(([, ok]) => !ok)
  .map(([name]) => name);

writeFileSync(
  new URL('./browser-verification.json', here),
  JSON.stringify(
    {
      run: 'ux-02c-03-p2-03',
      baseline: 'dfe5d8d09c70570c339332d793102a1478fbd387',
      at: new Date().toISOString(),
      environment: {
        chrome: 'Headless Chrome 158.0.8127.38（CDP 9337，独立 Profile D:/tmp/p203-profile）',
        shell: 'Vite 127.0.0.1:5288 → 代理 Host 127.0.0.1:5287',
        host: '真实 Host（node apps/server/src/main.ts --workspace-store weavespace-test/p203/store）',
        projects: 'proj-a（项目A）、proj-b（项目B），均为真实目录 + 真实 rootToken',
        storage: '真实 localStorage + 真实 IndexedDB（weavespace-trash-guard-v1）+ 真实 navigator.locks',
        filesystem: 'D:/Workspace/projects/weavespace-test/p203/{projA,projB}',
        network: '正常回收/恢复链路不拦截；POST 计数用 CDP Network.requestWillBeSent 观察',
      },
      injected: [
        ...(unknown.injected ?? []),
        ...(tabs.injected ?? []),
        ...restarts.flatMap((item) => item.injected ?? []),
      ],
      summary: { total: Object.keys(checks).length, passed: Object.keys(checks).length - failed.length, failed },
      parts: parts.map((part) => ({
        name: part.name,
        summary: part.result.summary,
        checks: part.result.checks,
        detail: part.result.detail,
      })),
    },
    null,
    2,
  ),
);

writeFileSync(
  new URL('./filesystem-verification.json', here),
  JSON.stringify(
    {
      run: 'ux-02c-03-p2-03',
      at: new Date().toISOString(),
      root: 'D:/Workspace/projects/weavespace-test/p203/projA',
      note:
        '每个文件都记录了：原路径与原始哈希 → 移入后原路径是否消失 / 回收区 payload 哈希 → ' +
        '恢复后原路径哈希。payload 哈希与原始哈希必须逐字节相同（二进制文件含 0x00/0xFF）。',
      files: lifecycle.filesystem ?? [],
      finalTree: lifecycle.tree ?? [],
      trashDirs: lifecycle.trashDirs ?? [],
      checks: Object.fromEntries(
        Object.entries(lifecycle.checks).filter(([name]) => /^B2-|^B3-/.test(name)),
      ),
    },
    null,
    2,
  ),
);

copyFileSync('C:/tmp/mutations-p203.json', new URL('./mutations.json', here));

for (const [from, to] of [
  ['C:/tmp/gate-test-p0-p203.txt', './gate-test-p0.txt'],
  ['C:/tmp/gate-checks-p203.txt', './gate-checks.txt'],
]) {
  if (existsSync(from)) copyFileSync(from, new URL(to, here));
}

console.log(
  JSON.stringify({
    browser: { total: Object.keys(checks).length, failed: failed.length },
    files: (lifecycle.filesystem ?? []).length,
    gates: existsSync(new URL('./gate-test-p0.txt', here)),
    mutations: existsSync(new URL('./mutations.json', here)),
    notes: existsSync(new URL('./notes.md', here)),
    gateText: readText('./gate-checks.txt').length,
  }),
);
