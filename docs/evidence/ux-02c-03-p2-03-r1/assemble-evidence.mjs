/**
 * 把本轮（P2-03-R1）四段浏览器验证 + 变异结果 + 门禁日志汇总成交付 JSON。
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
const sendBoundary = read('./send-boundary-raw.json');
const restarts = ['1', '2', '3'].map((phase) => read(`./restart-${phase}-raw.json`));

const parts = [
  { name: 'B2/B3 生命周期与安全保护（含 R1-05 错误码锁定）', result: lifecycle },
  { name: 'B4 UNKNOWN 三场景（含 R1-03 监听器生命周期与 202 真实回执）', result: unknown },
  { name: 'B5 真实跨标签页（含 R1-04 满仓释放目标校验）', result: tabs },
  { name: 'R1 会话令牌在途（切身份 / 台账失效，零 POST）', result: sendBoundary },
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
      run: 'ux-02c-03-p2-03-r1',
      baseline: '7177070156ce24fbfb684c04db2ed097b3489e90',
      at: new Date().toISOString(),
      environment: {
        chrome: 'Headless Chrome 158.0.8127.38（CDP 9337，独立 Profile D:/tmp/p203r1-profile）',
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
        ...(sendBoundary.injected ?? []),
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
      run: 'ux-02c-03-p2-03-r1',
      at: new Date().toISOString(),
      root: 'D:/Workspace/projects/weavespace-test/p203/projA',
      note:
        '每个文件都记录了：原路径与原始哈希 → 移入后原路径是否消失 / 回收区 payload 哈希 → ' +
        '恢复后原路径哈希。payload 哈希与原始哈希必须逐字节相同（二进制文件含 0x00/0xFF）。' +
        'R1 追加：满仓释放那一条记录（B5-25）记录了 opId、原路径、payload 哈希与恢复后哈希。',
      files: lifecycle.filesystem ?? [],
      finalTree: lifecycle.tree ?? [],
      trashDirs: lifecycle.trashDirs ?? [],
      fullCapacityRelease: tabs.detail?.['B5-25'] ?? null,
      checks: Object.fromEntries(
        Object.entries(lifecycle.checks).filter(([name]) => /^B2-|^B3-/.test(name)),
      ),
    },
    null,
    2,
  ),
);

if (existsSync('C:/tmp/mutations-r1.json')) copyFileSync('C:/tmp/mutations-r1.json', new URL('./mutations.json', here));

for (const [from, to] of [
  ['C:/tmp/gate-test-p0-r1.txt', './gate-test-p0.txt'],
  ['C:/tmp/gate-checks-r1.txt', './gate-checks.txt'],
]) {
  if (existsSync(from)) copyFileSync(from, new URL(to, here));
}

console.log(
  JSON.stringify({
    browser: { total: Object.keys(checks).length, failed: failed.length },
    parts: parts.map((part) => ({ name: part.name, ...part.result.summary })),
    gates: existsSync(new URL('./gate-test-p0.txt', here)),
    mutations: existsSync(new URL('./mutations.json', here)),
    notes: existsSync(new URL('./notes.md', here)),
    gateText: existsSync(new URL('./gate-checks.txt', here)) ? readText('./gate-checks.txt').length : 0,
  }),
);
