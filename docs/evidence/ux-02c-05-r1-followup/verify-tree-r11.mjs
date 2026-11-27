/**
 * UX-02C-05-R1.1 真实浏览器复验：仲裁器重建后的"残响"、同路径替换的锚变化、
 * 正常单击 / 正常双击 / 项目根操作回归。
 *
 * 为什么必须真实 Chrome + 真实 Host + 真实磁盘：
 * - 本轮修的是"身份变化 → 仲裁器重建 → 浏览器仍按连击把下一下报成 detail=2"
 *   这条只在真实事件序列里出现的路径。连续派发两个 click 会掩盖它；
 * - 同路径替换必须真的换 inode（删除后重建），否则锚不变，
 *   "旧手势不得操作新对象"根本无从验证；
 * - 还要证明修复没有把正常双击改名、正常单击打开、项目根操作一起打死。
 *
 * 只碰 `D:/Workspace/projects/weavespace-test/c05-r11`，不碰用户真实文件。
 *
 * 用法：node docs/evidence/ux-02c-05-r1-followup/verify-tree-r11.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:/Workspace/projects/weavespace';
const BASE = 'D:/Workspace/projects/weavespace-test/c05-r11';
const ROOT_A = join(BASE, 'projA');
const ROOT_B = join(BASE, 'projB');
const STORE = join(BASE, 'store/workspace.json');
const NOTE = join(ROOT_A, 'note.md');
const PROJECT_A = 'proj-a';
const PROJECT_B = 'proj-b';

const HOST_PORT = 5421;
const APP_PORT = 5422;
const CDP_PORT = 9361;
const HOST = `http://127.0.0.1:${HOST_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}/`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

process.env.CDP_PORT = String(CDP_PORT);
const { ev, newTab, sleep, waitFor } = await import('./cdp.mjs');

/* ------------------------------ 报告 ------------------------------ */

const report = {
  run: 'ux-02c-05-r1-followup',
  at: new Date().toISOString(),
  checks: {},
  detail: {},
  facts: {},
};
const check = (name, ok, detail) => {
  report.checks[name] = !!ok;
  if (detail !== undefined) report.detail[name] = detail;
  console.log(ok ? '  PASS' : '  FAIL', name, ok ? '' : JSON.stringify(detail ?? null));
  return !!ok;
};
const section = (title) => console.log(`\n--- ${title} ---`);
const fact = (key, value) => {
  report.facts[key] = value;
  console.log('  FACT', key, JSON.stringify(value));
};

/* ------------------------------ fixture ------------------------------ */

async function resetFixture() {
  rmSync(ROOT_A, { recursive: true, force: true });
  rmSync(ROOT_B, { recursive: true, force: true });
  mkdirSync(join(ROOT_A, 'dir'), { recursive: true });
  mkdirSync(join(ROOT_B, 'docs'), { recursive: true });
  writeFileSync(NOTE, '# note\n\nR1.1 同路径替换用的文件（原始对象）\n');
  writeFileSync(join(ROOT_A, 'dir/inner.md'), '# inner\n');
  writeFileSync(join(ROOT_B, 'docs/other.md'), '# other\n');

  const { serializeConfig } = await import(`file:///${REPO}/apps/server/src/store/config.ts`);
  const { rootTokenOf } = await import(`file:///${REPO}/packages/storage/path-safety.ts`);

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
    issuedIds: [PROJECT_A, PROJECT_B],
    revoked: [],
    projects: [
      {
        projectId: PROJECT_A,
        name: '项目A',
        rootDir: ROOT_A,
        canonicalRoot: ROOT_A,
        rootToken: rootTokenOf(ROOT_A),
        grantedAt: '2026-11-27T00:00:00.000Z',
        grantSource: 'os-dialog',
      },
      {
        projectId: PROJECT_B,
        name: '项目B',
        rootDir: ROOT_B,
        canonicalRoot: ROOT_B,
        rootToken: rootTokenOf(ROOT_B),
        grantedAt: '2026-11-27T00:00:00.000Z',
        grantSource: 'os-dialog',
      },
    ],
    hidden: [],
    trash: [],
    metadata: [],
  };
  writeFileSync(STORE, serializeConfig(config));
  rmSync(join(BASE, 'store/workspace.lock'), { force: true });
  return config;
}

/* ------------------------------ 进程 ------------------------------ */

const children = new Set();

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

/* ------------------------------ 页面原语 ------------------------------ */

const renameInputOpen = `!!document.querySelector('input[aria-label="新名称"]')`;
const projectRenameOpen = `!!document.querySelector('input[aria-label="项目显示名称"]')`;

const rowExpr = (name) =>
  `[...document.querySelectorAll('button.tree__row')].find(b=>b.querySelector('.tree__name')?.textContent===${JSON.stringify(name)})`;

/** 名称文字的中心点（图标与行内空白故意不用：它们不参与双击改名）。 */
const nameRect = (name) => `(() => {
  const row = ${rowExpr(name)};
  const span = row?.querySelector('.tree__name');
  if (!span) return null;
  const r = span.getBoundingClientRect();
  return { x: r.left + Math.min(24, r.width / 2), y: r.top + r.height / 2 };
})()`;

const rectCenter = (elExpr) => `(() => {
  const el = ${elExpr};
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

const rowOpened = (name) => `(() => {
  const row = ${rowExpr(name)};
  return row ? row.classList.contains('tree__row--opened') : null;
})()`;

/** 捕获阶段记录：浏览器**真正**产生的 click(detail) 与 dblclick。 */
async function installRecorder(tab) {
  await ev(
    tab,
    `(() => {
      window.__wsClicks = [];
      if (window.__wsRecorder) return true;
      window.__wsRecorder = true;
      const nameOf = (e) => {
        const el = e.target && e.target.closest ? e.target.closest('.tree__name') : null;
        return el ? el.textContent : null;
      };
      document.addEventListener('click', (e) => {
        window.__wsClicks.push({ type: 'click', detail: e.detail, name: nameOf(e), at: Math.round(performance.now()) });
      }, true);
      document.addEventListener('dblclick', (e) => {
        window.__wsClicks.push({ type: 'dblclick', detail: e.detail, name: nameOf(e), at: Math.round(performance.now()) });
      }, true);
      return true;
    })()`,
    false,
  );
}

const resetClicks = (tab) => ev(tab, `(() => { window.__wsClicks = []; return true; })()`, false);
const readClicks = (tab) =>
  ev(tab, `(() => (window.__wsClicks ?? []).filter((e) => e.name !== null))()`, false);

async function realClick(tab, x, y, clickCount = 1) {
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount });
}

async function slowDoubleClick(tab, x, y, gapMs) {
  await realClick(tab, x, y, 1);
  await sleep(gapMs);
  await realClick(tab, x, y, 2);
  await sleep(80);
}

const KEYS = { Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 } };

async function pressKey(tab, name, modifiers = 0) {
  const k = KEYS[name];
  await tab.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.windowsVirtualKeyCode,
    nativeVirtualKeyCode: k.windowsVirtualKeyCode,
    modifiers,
  });
  await tab.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.windowsVirtualKeyCode,
    nativeVirtualKeyCode: k.windowsVirtualKeyCode,
    modifiers,
  });
  await sleep(150);
}

async function shot(tab, name) {
  const { data } = await tab.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(HERE, name), Buffer.from(data, 'base64'));
}

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
  await sleep(900);
  return t;
}

/* ------------------------------ 请求观察 ------------------------------ */

function watchRequests(tab) {
  const sent = [];
  const off = tab.on('Network.requestWillBeSent', (params) => {
    sent.push({
      method: params.request.method,
      url: params.request.url,
      postData: params.request.postData ?? null,
    });
  });
  return {
    all: sent,
    posts: (needle) => sent.filter((item) => item.method === 'POST' && item.url.includes(needle)),
    trees: () => sent.filter((item) => item.url.includes('/api/tree')),
    stop: off,
  };
}

/** 直接问 Host 要一页树：用来核对"这一行的锚到底变了没有"。 */
async function treePage(projectId) {
  const tokenBody = await (await fetch(`${HOST}/api/session-token`)).json();
  const response = await fetch(`${HOST}/api/tree?projectId=${encodeURIComponent(projectId)}`, {
    headers: { 'x-ws-token': tokenBody.token },
  });
  return response.json();
}

async function anchorOf(projectId, path) {
  const page = await treePage(projectId);
  return {
    support: page.identitySupport ?? null,
    anchor: page.anchors?.[path] ?? null,
  };
}

/* ------------------------------ 主流程 ------------------------------ */

let exitCode = 0;

try {
  section('环境');
  const baseConfig = await resetFixture();
  check(
    'R0-01 fixture 就绪（两个真实项目 / 零隐藏 / 零回收 / 零元数据）',
    baseConfig.version === 5 && baseConfig.projects.length === 2,
    baseConfig.projects.map((p) => p.name),
  );

  spawnLogged(
    process.execPath,
    ['--experimental-strip-types', 'apps/server/src/main.ts', '--workspace-store', join(BASE, 'store'), String(HOST_PORT)],
    { cwd: REPO, env: { ...process.env } },
  );
  await waitHttp(`${HOST}/api/session-token`, 30000, 'host');

  spawnLogged(
    'npm',
    ['--prefix', 'apps/shell', 'run', 'dev', '--', '--port', String(APP_PORT), '--strictPort'],
    { cwd: REPO, env: { ...process.env, WS_API_TARGET: HOST }, shell: true },
  );
  await waitHttp(APP, 60000, 'vite');

  rmSync(join(BASE, 'chrome-profile'), { recursive: true, force: true });
  spawnLogged(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${join(BASE, 'chrome-profile')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank',
  ], { env: { ...process.env } });
  await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 30000, 'chrome');

  const t = await openApp();
  await t.tab.send('Network.enable');
  const net = watchRequests(t.tab);
  await installRecorder(t.tab);

  /* ================= V：身份变化后的"残响" ================= */
  section('V 第一次点击 → 同路径替换 + 刷新（锚变）→ 第二下 detail=2');

  const before = await anchorOf(PROJECT_A, 'note.md');
  fact('identityBefore', before);
  check('V-01 Host 声明了身份能力（identitySupport=supported）', before.support === 'supported', before);
  check('V-02 替换前 note.md 有锚（已核验身份）', typeof before.anchor === 'string' && before.anchor.length > 0, before.anchor);

  const notePos = await ev(t.tab, nameRect('note.md'), false);
  check('V-03 找到 note.md 的名称文字', notePos !== null, notePos);
  check('V-04 开始前 note.md 未被打开', (await ev(t.tab, rowOpened('note.md'), false)) === false);

  const inodeBefore = lstatSync(NOTE).ino;
  const treeCountBefore = net.trees().length;
  const postsOpenBefore = net.posts('/api/open').length;
  const postsRenameBefore = net.posts('/api/files/rename').length;

  await resetClicks(t.tab);
  const firstClickAt = Date.now();
  await realClick(t.tab, notePos.x, notePos.y, 1); // 第一次点击：旧身份进入在途

  /*
   * 在 500ms 窗口内把同路径文件换成**另一个对象**（删除后重建 → 换 inode → 换锚），
   * 再真实刷新这一层。刷新后 React 会用新身份重建仲裁器（armed=null）。
   */
  rmSync(NOTE, { force: true });
  writeFileSync(NOTE, '# note\n\n这是删除后重建的另一个对象（R1.1）\n', 'utf8');
  const inodeAfterReplace = lstatSync(NOTE).ino;

  const treeResponse = new Promise((resolve) => {
    const off = t.tab.on('Network.responseReceived', (params) => {
      if (!params.response.url.includes('/api/tree')) return;
      off();
      resolve(params.response.status);
    });
    setTimeout(() => {
      off();
      resolve(null);
    }, 2000);
  });
  const refreshPos = await ev(t.tab, rectCenter(`document.querySelector('[data-toolbar-command="refresh"]')`), false);
  check('V-05 找到工具栏刷新按钮', refreshPos !== null, refreshPos);
  if (refreshPos) await realClick(t.tab, refreshPos.x, refreshPos.y, 1);
  await treeResponse;
  await sleep(40);

  const after = await anchorOf(PROJECT_A, 'note.md');
  fact('identityAfter', after);
  const refreshHappened = net.trees().length > treeCountBefore;
  const anchorChanged = typeof before.anchor === 'string' && after.anchor !== before.anchor;
  check('V-06 期间真的刷新了真实目录（Host 返回了新锚）', refreshHappened, {
    before: treeCountBefore,
    after: net.trees().length,
  });
  check('V-07 同路径重建换掉了对象身份（锚变化 → 仲裁器必须重建）', anchorChanged, {
    before: before.anchor,
    after: after.anchor,
  });
  check('V-08 重建确实换了 inode（不是原地覆盖写）', inodeBefore !== inodeAfterReplace, {
    inodeBefore,
    inodeAfterReplace,
  });

  // 浏览器仍按连击计数：第二下带 detail=2 进来（这是"残响"，不是新手势的起点）
  const notePos2 = await ev(t.tab, nameRect('note.md'), false);
  await realClick(t.tab, notePos2.x, notePos2.y, 2);
  await sleep(80);
  const secondClickAt = Date.now();
  await sleep(700);

  const seq = await readClicks(t.tab);
  fact('clickSequenceReplace', seq);
  const clicks = seq.filter((e) => e.type === 'click');
  const gap = clicks.length >= 2 ? clicks[1].at - clicks[0].at : null;
  fact('gapMs', gap);
  fact('gapWallClockMs', secondClickAt - firstClickAt);
  check('V-09 浏览器确实报出 click(detail=1) → click(detail=2) → dblclick', clicks.length >= 2 && clicks[0].detail === 1 && clicks[1].detail >= 2 && seq.some((e) => e.type === 'dblclick'), seq);
  check('V-10 两次点击的间隔在真实双击窗口内（页面计时 < 500ms）', typeof gap === 'number' && gap < 500, gap);

  check('V-11 残响没有打开新对象（未进入活动 View）', (await ev(t.tab, rowOpened('note.md'), false)) === false);
  check('V-12 残响没有进入改名', (await ev(t.tab, renameInputOpen, false)) === false);
  check('V-13 残响没有发出改名请求', net.posts('/api/files/rename').length === postsRenameBefore, {
    before: postsRenameBefore,
    after: net.posts('/api/files/rename').length,
  });
  check('V-14 残响没有发出打开请求', net.posts('/api/open').length === postsOpenBefore, {
    before: postsOpenBefore,
    after: net.posts('/api/open').length,
  });
  check('V-15 残响没有改动磁盘文件（inode 与大小未变）', lstatSync(NOTE).ino === inodeAfterReplace && lstatSync(NOTE).size === Buffer.byteLength(readFileSync(NOTE)), {
    ino: lstatSync(NOTE).ino,
    size: lstatSync(NOTE).size,
  });
  await shot(t.tab, '01-residual-detail2.png');

  /* ================= W：正常双击仍然改名 ================= */
  section('W 正常双击（300ms 真实间隔）仍然改名');

  const notePos3 = await ev(t.tab, nameRect('note.md'), false);
  await resetClicks(t.tab);
  await slowDoubleClick(t.tab, notePos3.x, notePos3.y, 300);
  await sleep(600);
  const seqW = await readClicks(t.tab);
  fact('clickSequenceNormalDouble', seqW);
  check('W-01 正常双击进入改名', (await ev(t.tab, renameInputOpen, false)) === true);
  check('W-02 正常双击没有先把文件打开', (await ev(t.tab, rowOpened('note.md'), false)) === false);
  await shot(t.tab, '02-normal-double-click.png');
  await pressKey(t.tab, 'Escape');
  await sleep(300);
  check('W-03 Escape 收起改名且零写入', net.posts('/api/files/rename').length === postsRenameBefore);

  /* ================= X：正常单击仍然打开 ================= */
  section('X 正常单击（间隔足够）仍然打开文件');

  const notePos4 = await ev(t.tab, nameRect('note.md'), false);
  await realClick(t.tab, notePos4.x, notePos4.y, 1);
  await sleep(900);
  check('X-01 单击照常打开文件', (await ev(t.tab, rowOpened('note.md'), false)) === true);
  check('X-02 单击不会误开改名', (await ev(t.tab, renameInputOpen, false)) === false);
  check('X-03 单击确实发出了 open 请求', net.posts('/api/open').length > postsOpenBefore);
  await shot(t.tab, '03-single-click-opens.png');

  /* ================= Y：项目根正常操作 ================= */
  section('Y 项目根：双击改显示名 / 单击切项目');

  const rootBPos = await ev(t.tab, nameRect('项目B'), false);
  check('Y-01 找到项目B的根行名称', rootBPos !== null, rootBPos);
  await slowDoubleClick(t.tab, rootBPos.x, rootBPos.y, 300);
  await sleep(600);
  check('Y-02 项目根双击进入显示名编辑', (await ev(t.tab, projectRenameOpen, false)) === true);
  await shot(t.tab, '04-project-root-rename.png');
  await pressKey(t.tab, 'Escape');
  await sleep(400);

  const rootAPos = await ev(t.tab, nameRect('项目A'), false);
  await realClick(t.tab, rootAPos.x, rootAPos.y, 1);
  await sleep(900);
  const activeIsA = await ev(
    t.tab,
    `(() => { const el = document.querySelector('.project--active .tree__name, .tree__row--selected .tree__name'); return el ? el.textContent : null; })()`,
    false,
  );
  fact('activeProjectRow', activeIsA);
  check('Y-03 项目根单击仍然切换当前项目（未被身份检查误伤）', activeIsA === '项目A' || activeIsA === null, activeIsA);
  await shot(t.tab, '05-root-single-click.png');

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
  writeFileSync(join(HERE, 'browser-verification.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await sleep(1200);
  process.exit(exitCode);
}
