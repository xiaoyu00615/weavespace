/**
 * UX-02C-04-R1-H1 真实浏览器复验：**发送前最终裁决**。
 *
 * 只补两个必要场景（其余 41 项身份一致性证据在 `ux-02c-04-r1-metadata-identity/`，
 * 本轮不重做、也不改动）：
 *   S1 令牌在途时切换工作区（模式）→ `POST /api/metadata/set` **零请求**；
 *   S2 正常标注保存**不受影响**（一次 POST、行上生效、配置落盘）。
 *
 * 为什么必须用真实浏览器：这一处修的正是"`await sessionToken()` 期间的窗口"。
 * 单测可以用受控 fetch 精确复现，但只有真实 Chrome + 真实 Vite 代理 + 真实 Host
 * 才能证明那段同步片段在生产链路上确实存在、且没有被别的 await 悄悄填回来。
 *
 * 取证手段：
 * - `Network.requestWillBeSent` 记录**真正发出去**的请求（不看返回值，看有没有发）；
 * - `Fetch.requestPaused` 把 `/api/session-token` 挂住，制造那个窗口，
 *   并在窗口里点"演示"（模式切换 = 换工作区身份），再放行令牌。
 *
 * 只碰 `D:/Workspace/projects/weavespace-test/h1`，不碰用户真实文件。
 *
 * 用法：node docs/evidence/ux-02c-04-r1-h1/verify-send-gate.mjs
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:/Workspace/projects/weavespace';
const BASE = 'D:/Workspace/projects/weavespace-test/h1';
const ROOT = join(BASE, 'projA');
const STORE = join(BASE, 'store/workspace.json');
const PROJECT = 'proj-a';

const HOST_PORT = 5399;
const APP_PORT = 5400;
const CDP_PORT = 9348;
const HOST = `http://127.0.0.1:${HOST_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}/`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

process.env.CDP_PORT = String(CDP_PORT);
const { ev, newTab, sleep, waitFor } = await import('./cdp.mjs');

/* ------------------------------ 报告 ------------------------------ */

const report = { run: 'ux-02c-04-r1-h1-send-gate', at: new Date().toISOString(), checks: {}, detail: {}, facts: {} };
const check = (name, ok, detail) => {
  report.checks[name] = !!ok;
  if (detail !== undefined) report.detail[name] = detail;
  console.log(ok ? '  PASS' : '  FAIL', name, ok ? '' : JSON.stringify(detail));
  return !!ok;
};
const section = (title) => console.log(`\n--- ${title} ---`);
const fact = (key, value) => {
  report.facts[key] = value;
};

/* ------------------------------ fixture ------------------------------ */

/**
 * 重建测试 Workspace（只碰 `weavespace-test/h1`）。
 *
 * 目录会被重建 → inode 变化 → **rootToken 必须重算**，否则 Host 判
 * `ROOT_TOKEN_CHANGED`，整轮验证测的是一个不可用的项目。
 */
async function resetFixture() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, 'dir'), { recursive: true });
  writeFileSync(join(ROOT, 'note.md'), '# note\n\n发送边界复验用的文件\n');
  writeFileSync(join(ROOT, 'dir', 'inner.md'), '# inner\n');
  writeFileSync(join(ROOT, '.gitignore'), '');

  const { serializeConfig } = await import(
    'file:///D:/Workspace/projects/weavespace/apps/server/src/store/config.ts'
  );
  const { rootTokenOf } = await import('file:///D:/Workspace/projects/weavespace/packages/storage/path-safety.ts');

  mkdirSync(join(BASE, 'store'), { recursive: true });
  let prior = null;
  if (existsSync(STORE)) {
    try {
      prior = JSON.parse(readFileSync(STORE, 'utf8'));
    } catch {
      prior = null;
    }
  }
  const config = {
    version: 5,
    commitSeq: prior?.commitSeq ?? 0,
    issuedIds: [PROJECT],
    revoked: [],
    projects: [
      {
        projectId: PROJECT,
        name: '项目A',
        rootDir: ROOT,
        canonicalRoot: ROOT,
        rootToken: rootTokenOf(ROOT),
        grantedAt: '2026-11-27T00:00:00.000Z',
        grantSource: 'os-dialog',
      },
    ],
    hidden: [],
    trash: [],
    metadata: [],
  };
  writeFileSync(STORE, serializeConfig(config));
  // 锁文件残留会让 Host 以 `ERR_STORE_LOCKED` 拒绝启动
  rmSync(join(BASE, 'store/workspace.lock'), { force: true });
  return config;
}

/* ------------------------------ 原子事实 ------------------------------ */

const configRaw = () => JSON.parse(readFileSync(STORE, 'utf8'));
const recordsAt = (raw, path) => (raw.metadata ?? []).filter((entry) => entry.path === path);
const sha256 = (path) =>
  existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;

/* ------------------------------ Host 接口 ------------------------------ */

let cachedToken = null;
async function token(force = false) {
  if (cachedToken && !force) return cachedToken;
  const response = await fetch(`${HOST}/api/session-token`);
  const body = await response.json();
  cachedToken = body.token;
  return cachedToken;
}

async function api(path, init = {}) {
  const response = await fetch(`${HOST}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), 'x-ws-token': await token(), origin: new URL(HOST).origin },
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

const metadataList = () => api(`/api/metadata?projectId=${encodeURIComponent(PROJECT)}`);

/* ------------------------------ 进程编排 ------------------------------ */

const children = new Set();
const hostLogs = [];

function spawnLogged(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  child.stdout.on('data', (d) => chunks.push(d.toString()));
  child.stderr.on('data', (d) => chunks.push(d.toString()));
  child.collected = () => chunks.join('');
  children.add(child);
  return child;
}

async function waitHttp(url, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.status < 500) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label} (${url})`);
}

function startHost(tag) {
  // 托管 Multi 必须用 `--workspace-store <dir>`（静态 v1 工作区文件是另一套格式）
  const child = spawnLogged(
    process.execPath,
    [
      '--experimental-strip-types',
      'apps/server/src/main.ts',
      '--workspace-store',
      join(BASE, 'store'),
      String(HOST_PORT),
    ],
    { cwd: REPO, env: { ...process.env } },
  );
  hostLogs.push({ tag, child });
  return child;
}

/* ------------------------------ 页面操作 ------------------------------ */

const metaDialogOpen = `!!document.querySelector('[aria-label="资源标注"]')`;

const setInput = (value) => `(() => {
  const el = document.querySelector('#meta-alias');
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

const clickByText = (selector, text) => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.innerText.trim() === ${JSON.stringify(text)});
  if (!el) return 'missing';
  el.click();
  return 'clicked';
})()`;

const rowExpr = (name) =>
  `[...document.querySelectorAll('button.tree__row--file')].find(b=>b.querySelector('.tree__name')?.textContent===${JSON.stringify(name)})`;

const rowStateOf = (name) => `(() => {
  const row = ${rowExpr(name)};
  if (!row) return null;
  return {
    name: row.querySelector('.tree__name')?.textContent ?? null,
    alias: row.querySelector('.tree__alias')?.textContent ?? null,
    color: [...row.classList].find((cls) => cls.startsWith('tree__row--color-')) ?? null,
  };
})()`;

async function openApp() {
  const t = await newTab('about:blank');
  await t.tab.send('Emulation.setDeviceMetricsOverride', {
    width: 1320,
    height: 860,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await t.tab.send('Page.navigate', { url: APP });
  await sleep(2200);
  await ev(t.tab, `[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='真实文件')?.click()`);
  await waitFor(t.tab, `document.body.innerText.includes('项目A')`, 25000, 'live workspace');
  await waitFor(t.tab, `document.querySelectorAll('button.tree__row--file').length > 0`, 25000, 'tree rows');
  await sleep(700);
  return t;
}

async function shot(t, name) {
  const { data } = await t.tab.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(HERE, name), Buffer.from(data, 'base64'));
}

async function openMeta(t, name, itemText) {
  const ok = await ev(
    t.tab,
    `(() => {
      const row = ${rowExpr(name)};
      if (!row) return false;
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + 8 }));
      return true;
    })()`,
    false,
  );
  if (!ok) return 'no-row';
  await sleep(400);
  const clicked = await ev(
    t.tab,
    `(() => {
      const item = [...document.querySelectorAll('[role=menu] [role=menuitem]')].find(b=>b.innerText.trim().startsWith(${JSON.stringify(itemText)}));
      if (!item) return 'missing';
      item.click();
      return 'clicked';
    })()`,
    false,
  );
  if (clicked !== 'clicked') return 'no-menu-item';
  try {
    await waitFor(t.tab, metaDialogOpen, 8000, 'metadata dialog');
  } catch {
    return 'no-dialog';
  }
  await sleep(300);
  return 'open';
}

async function rowState(t, name) {
  return await ev(t.tab, rowStateOf(name), false);
}

/* ------------------------------ 请求观察 ------------------------------ */

/**
 * 观察真正发出去的请求。
 *
 * 判据是 `Network.requestWillBeSent`：它只关心"浏览器有没有把请求交出去"，
 * 与响应无关——这正是本场景要断言的东西（零 POST，而不是"POST 失败"）。
 */
function watchRequests(tab) {
  const sent = [];
  const off = tab.on('Network.requestWillBeSent', (params) => {
    sent.push({ method: params.request.method, url: params.request.url, ts: params.timestamp });
  });
  return {
    sent,
    posts: (needle) => sent.filter((item) => item.method === 'POST' && item.url.includes(needle)),
    stop: off,
  };
}

/* ------------------------------ 主流程 ------------------------------ */

let exitCode = 0;
let chrome = null;

try {
  section('环境');
  const baseConfig = await resetFixture();
  fact('configBefore', baseConfig);
  check('E-00 fixture 就绪：v5 配置、零元数据记录', baseConfig.version === 5 && baseConfig.metadata.length === 0);

  startHost('host-1');
  await waitHttp(`${HOST}/api/session-token`, 30000, 'host');
  await token(true);
  fact('fileSha256Before', sha256(join(ROOT, 'note.md')));

  spawnLogged('npm', ['--prefix', 'apps/shell', 'run', 'dev', '--', '--port', String(APP_PORT), '--strictPort'], {
    cwd: REPO,
    env: { ...process.env, WS_API_TARGET: HOST },
    shell: true,
  });
  await waitHttp(APP, 60000, 'vite');

  rmSync(join(BASE, 'chrome-profile'), { recursive: true, force: true });
  chrome = spawnLogged(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${join(BASE, 'chrome-profile')}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      'about:blank',
    ],
    { env: { ...process.env } },
  );
  await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 30000, 'chrome');

  const t = await openApp();
  await t.tab.send('Network.enable');
  const net = watchRequests(t.tab);

  /* ------------------------- S2：正常保存不受影响 ------------------------- */
  section('S2 正常标注保存（不制造窗口）');
  const initial = await rowState(t, 'note.md');
  check('E-01 初始：note.md 没有标注', initial !== null && initial.alias === null, initial);

  check('E-02 右键 →「设置标注名…」打开对话框', (await openMeta(t, 'note.md', '设置标注名…')) === 'open');
  await ev(t.tab, setInput('令牌窗口外'), false);
  check('E-03 点击保存', (await ev(t.tab, clickByText('.meta__dialog button', '保存'), false)) === 'clicked');
  await waitFor(t.tab, `!(${metaDialogOpen})`, 15000, 'dialog closed');
  await sleep(900);

  const normalPosts = net.posts('/api/metadata/set');
  check('E-04 恰好发出一次 POST /api/metadata/set（身份未变，正常放行）', normalPosts.length === 1, normalPosts);
  const afterSave = await rowState(t, 'note.md');
  check('E-05 行上生效：note.md（令牌窗口外）', afterSave?.alias === '（令牌窗口外）', afterSave);
  const cfgAfterSave = configRaw();
  check(
    'E-06 配置里落了一条记录，且指向真实对象',
    recordsAt(cfgAfterSave, 'note.md').length === 1 && recordsAt(cfgAfterSave, 'note.md')[0].alias === '令牌窗口外',
    recordsAt(cfgAfterSave, 'note.md'),
  );
  await shot(t, '01-normal-save.png');
  fact('configAfterNormalSave', cfgAfterSave.metadata);

  /* ------------------------- S1：令牌在途时切换工作区 ------------------------- */
  section('S1 令牌在途时切换模式 → 零 POST');

  let paused = null;
  const pausedPromise = new Promise((resolve) => {
    const off = t.tab.on('Fetch.requestPaused', (params) => {
      if (!params.request.url.includes('/api/session-token')) return;
      paused = params;
      off();
      resolve('paused');
    });
  });
  await t.tab.send('Fetch.enable', { patterns: [{ urlPattern: '*session-token*' }] });

  check('E-07 再次打开对话框（目标仍是 note.md）', (await openMeta(t, 'note.md', '设置标注名…')) === 'open');
  await ev(t.tab, setInput('不该落盘的标注'), false);
  check('E-08 点击保存', (await ev(t.tab, clickByText('.meta__dialog button', '保存'), false)) === 'clicked');

  // 令牌请求被挂住 = runner 的提交前核验已经通过，我们正处在那个窗口里
  await Promise.race([pausedPromise, sleep(10000)]);
  check('E-09 令牌请求已被挂起（证明前置核验已通过、正处在可见窗口内）', paused !== null);

  const beforeSwitch = net.posts('/api/metadata/set').length;
  check('E-10 此刻还没有发出任何新的 metadata/set', beforeSwitch === 1, beforeSwitch);

  // 窗口内切换工作区身份：模式 live → demo（identity key 里的 mode 变了）
  check('E-11 窗口内点击「演示」（换工作区身份）', (await ev(t.tab, clickByText('button.chip', '演示'), false)) === 'clicked');
  await sleep(500);
  await shot(t, '02-token-paused-and-switched.png');

  // 放行令牌：真正的 POST 边界就发生在这之后
  await t.tab.send('Fetch.continueRequest', { requestId: paused.requestId });
  await sleep(2500);
  await t.tab.send('Fetch.disable');

  const afterSwitchPosts = net.posts('/api/metadata/set').length;
  check('E-12 放行令牌后仍然零 POST（发送前裁决把它挡在 fetch 之前）', afterSwitchPosts === 1, {
    total: afterSwitchPosts,
    detail: net.posts('/api/metadata/set'),
  });

  const cfgAfterGate = configRaw();
  check(
    'E-13 配置没有被改动：仍然只有 E-06 那一条',
    JSON.stringify(cfgAfterGate.metadata) === JSON.stringify(cfgAfterSave.metadata),
    cfgAfterGate.metadata,
  );

  // 回到真实模式，确认标注仍是 E-05 那条（而不是被"不该落盘的标注"覆盖）
  await ev(t.tab, `[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='真实文件')?.click()`);
  await waitFor(t.tab, `document.querySelectorAll('button.tree__row--file').length > 0`, 25000, 'tree rows after live');
  await sleep(900);
  const finalRow = await rowState(t, 'note.md');
  check('E-14 回到真实模式后仍是原来的标注', finalRow?.alias === '（令牌窗口外）', finalRow);
  await shot(t, '03-back-to-live.png');

  const listed = await metadataList();
  check(
    'E-15 接口只承认一条记录，状态 active',
    listed.status === 200 &&
      listed.body?.entries?.length === 1 &&
      listed.body.entries[0].alias === '令牌窗口外' &&
      listed.body.entries[0].state === 'active',
    listed.body?.entries,
  );
  fact('configAfterAll', configRaw().metadata);
  fact('fileSha256After', sha256(join(ROOT, 'note.md')));
  check(
    'E-16 正文没有被改动（元数据从不写文件内容）',
    report.facts.fileSha256Before === report.facts.fileSha256After,
    { before: report.facts.fileSha256Before, after: report.facts.fileSha256After },
  );

  const failed = Object.entries(report.checks).filter(([, ok]) => !ok).map(([name]) => name);
  report.summary = {
    total: Object.keys(report.checks).length,
    passed: Object.keys(report.checks).length - failed.length,
    failed,
  };
  console.log('\nSUMMARY', JSON.stringify(report.summary));
  exitCode = failed.length === 0 ? 0 : 1;
} catch (err) {
  console.error('\nABORT', err?.stack ?? err);
  report.aborted = String(err?.message ?? err);
  exitCode = 1;
} finally {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已经退出 */
    }
  }
  writeFileSync(
    join(HERE, 'host-logs.txt'),
    hostLogs.map(({ tag, child }) => `### ${tag}\n${child.collected()}`).join('\n'),
    'utf8',
  );
  writeFileSync(join(HERE, 'browser-verification.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await sleep(1200);
  process.exit(exitCode);
}
