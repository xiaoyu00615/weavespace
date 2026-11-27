/**
 * UX-02C-05-R1 真实浏览器复验：慢速双击、同路径文件替换、正常单击/双击回归、
 * 项目显示名编辑会话归属。
 *
 * 为什么必须真实 Chrome + 真实 Host + 真实磁盘：
 * - 本轮改的正是"**真实间隔**的双击"。上一轮的 `realDoubleClick()` 是连续派发
 *   clickCount 1 → 2（间隔趋近 0），恰好吃不到"200ms 窗口太短"这个问题。
 *   这里改成两次真实点击之间真的等 300 / 450ms，并用捕获阶段监听器把浏览器
 *   实际产生的 `click(detail)` → `dblclick` 序列记下来；
 * - 同路径文件替换必须真的改磁盘：只有对象身份（锚）变了，才能验证在途点击
 *   会不会落到新对象上；
 * - 项目显示名会话归属要验证"切换当前项目后旧会话收起且零请求"。
 *
 * 只碰 `D:/Workspace/projects/weavespace-test/c05-r1`，不碰用户真实文件。
 *
 * 用法：node docs/evidence/ux-02c-05-r1-hardening/verify-tree-r1.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:/Workspace/projects/weavespace';
const BASE = 'D:/Workspace/projects/weavespace-test/c05-r1';
const ROOT_A = join(BASE, 'projA');
const ROOT_B = join(BASE, 'projB');
const STORE = join(BASE, 'store/workspace.json');
const PROJECT_A = 'proj-a';
const PROJECT_B = 'proj-b';

const HOST_PORT = 5411;
const APP_PORT = 5412;
const CDP_PORT = 9351;
const HOST = `http://127.0.0.1:${HOST_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}/`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

process.env.CDP_PORT = String(CDP_PORT);
const { ev, newTab, sleep, waitFor } = await import('./cdp.mjs');

/* ------------------------------ 报告 ------------------------------ */

const report = {
  run: 'ux-02c-05-r1-hardening',
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
  writeFileSync(join(ROOT_A, 'note.md'), '# note\n\nR1 同路径替换用的文件\n');
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

/**
 * 捕获阶段的点击记录器。
 *
 * 不修改任何业务行为，只把浏览器**真正**产生的 click(detail) 与 dblclick 记下来：
 * 这样才能证明"两次点击之间真的隔了 300ms"，而不是自己派发两下就宣布测过了。
 */
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

/** 真实间隔的双击：两次按下之间真的等 `gapMs`。 */
async function slowDoubleClick(tab, x, y, gapMs) {
  await realClick(tab, x, y, 1);
  await sleep(gapMs);
  await realClick(tab, x, y, 2);
  await sleep(80);
}

const KEYS = {
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
};

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
  await sleep(140);
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

  const hostChild = spawnLogged(
    process.execPath,
    ['--experimental-strip-types', 'apps/server/src/main.ts', '--workspace-store', join(BASE, 'store'), String(HOST_PORT)],
    { cwd: REPO, env: { ...process.env } },
  );
  await waitHttp(`${HOST}/api/session-token`, 30000, 'host');

  const viteChild = spawnLogged(
    'npm',
    ['--prefix', 'apps/shell', 'run', 'dev', '--', '--port', String(APP_PORT), '--strictPort'],
    { cwd: REPO, env: { ...process.env, WS_API_TARGET: HOST }, shell: true },
  );
  await waitHttp(APP, 60000, 'vite');

  rmSync(join(BASE, 'chrome-profile'), { recursive: true, force: true });
  const chromeChild = spawnLogged(CHROME, [
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

  /* ================= P：真实间隔的双击 ================= */
  section('P 真实间隔双击（300ms）');

  const innerPos = await ev(t.tab, nameRect('inner.md'), false);
  check('P-01 找到 dir/inner.md 的名称文字', innerPos !== null, innerPos);
  await resetClicks(t.tab);
  const beforeRenamePosts = net.posts('/api/files/rename').length;
  await slowDoubleClick(t.tab, innerPos.x, innerPos.y, 300);
  await sleep(700);

  const seq300 = await readClicks(t.tab);
  fact('clickSequence300', seq300);
  const clicks300 = seq300.filter((e) => e.type === 'click');
  const gap300 = clicks300.length >= 2 ? clicks300[1].at - clicks300[0].at : null;
  fact('gap300ms', gap300);
  check(
    'P-02 浏览器真的产生了 click(detail=1) → click(detail=2) → dblclick',
    clicks300.length >= 2 &&
      clicks300[0].detail === 1 &&
      clicks300[1].detail >= 2 &&
      seq300.some((e) => e.type === 'dblclick'),
    seq300,
  );
  check(
    'P-03 两次点击之间是**真实间隔**（≥250ms），不是连发的合成事件',
    typeof gap300 === 'number' && gap300 >= 250,
    gap300,
  );
  check('P-04 间隔 300ms 的双击进入改名', (await ev(t.tab, renameInputOpen, false)) === true);
  check('P-05 双击没有先把文件打开（.tree__row--opened 仍为 false）', (await ev(t.tab, rowOpened('inner.md'), false)) === false);
  await shot(t.tab, '01-slow-dblclick-300ms.png');
  await pressKey(t.tab, 'Escape');
  await sleep(400);
  check('P-06 Escape 收起改名，零写入', net.posts('/api/files/rename').length === beforeRenamePosts);

  /* ================= Q：450ms（贴近窗口上界）================= */
  section('Q 真实间隔双击（450ms）');

  await resetClicks(t.tab);
  await slowDoubleClick(t.tab, innerPos.x, innerPos.y, 450);
  await sleep(800);
  const seq450 = await readClicks(t.tab);
  fact('clickSequence450', seq450);
  const clicks450 = seq450.filter((e) => e.type === 'click');
  const gap450 = clicks450.length >= 2 ? clicks450[1].at - clicks450[0].at : null;
  fact('gap450ms', gap450);
  const recognizedAsDouble = clicks450.some((e) => e.detail >= 2) && seq450.some((e) => e.type === 'dblclick');
  if (recognizedAsDouble) {
    check('Q-01 间隔 450ms 的双击也只改名，不打开文件', (await ev(t.tab, rowOpened('inner.md'), false)) === false);
    check('Q-02 间隔 450ms 的双击进入改名', (await ev(t.tab, renameInputOpen, false)) === true);
    await pressKey(t.tab, 'Escape');
  } else {
    // 浏览器按系统双击阈值（可能 < 450ms）判成了两次独立单击：这不是我们的窗口问题，
    // 如实记录，不伪造通过。
    fact('note450', '本机 Chrome 未把 450ms 两连击判为双击（系统双击阈值 < 450ms），不作为失败项');
    console.log('  NOTE 450ms 未被判为双击，记录为系统阈值限制');
  }

  /* ================= R：同路径文件替换 ================= */
  section('R 同路径文件被替换（锚变）时在途单击必须作废');

  // 先确保没有残留的改名输入行
  await pressKey(t.tab, 'Escape');
  await sleep(300);
  const notePos = await ev(t.tab, nameRect('note.md'), false);
  check('R-01 找到 note.md 的名称文字', notePos !== null, notePos);
  check('R-02 开始前 note.md 未被打开', (await ev(t.tab, rowOpened('note.md'), false)) === false);

  const treesBefore = net.trees().length;
  await resetClicks(t.tab);
  await realClick(t.tab, notePos.x, notePos.y, 1); // 单击 → 500ms 后在途
  /*
   * 在这个窗口里把同路径文件换成**另一个对象**：删除后重建。
   * 不能用原地覆盖写——同一 inode 上的内容变化是"同一个对象的保存"，
   * 锚（dev + ino）不会变，打开它是正确的；只有重建才会换掉对象身份。
   */
  rmSync(join(ROOT_A, 'note.md'), { force: true });
  writeFileSync(join(ROOT_A, 'note.md'), '# note\n\n这是删除后重建的另一个对象\n', 'utf8');
  // 刷新根层，让界面拿到新锚
  const refreshPos = await ev(t.tab, rectCenter(`document.querySelector('[data-toolbar-command="refresh"]')`), false);
  if (refreshPos) await realClick(t.tab, refreshPos.x, refreshPos.y, 1);
  await sleep(1200);

  const refreshHappened = net.trees().length > treesBefore;
  const seqReplace = await readClicks(t.tab);
  fact('clickSequenceReplace', seqReplace);
  check('R-03 期间确实刷新了真实目录（拿到了新锚）', refreshHappened, {
    before: treesBefore,
    after: net.trees().length,
  });
  check(
    'R-04 在途单击没有把（已被替换的）文件打开',
    (await ev(t.tab, rowOpened('note.md'), false)) === false,
    await ev(t.tab, `(() => { const r = ${rowExpr('note.md')}; return r ? r.className : null; })()`, false),
  );
  check('R-05 也没有误开改名输入行', (await ev(t.tab, renameInputOpen, false)) === false);
  await shot(t.tab, '02-same-path-replaced.png');

  /* ================= S：正常单击回归 ================= */
  section('S 正常单击仍然打开文件');

  const notePos2 = await ev(t.tab, nameRect('note.md'), false);
  await realClick(t.tab, notePos2.x, notePos2.y, 1);
  await sleep(900);
  check('S-01 单击（间隔足够）照常打开文件', (await ev(t.tab, rowOpened('note.md'), false)) === true);
  check('S-02 单击不会误开改名输入行', (await ev(t.tab, renameInputOpen, false)) === false);
  await shot(t.tab, '03-single-click-opens.png');

  /* ================= U：项目显示名会话归属 ================= */
  section('U 切换当前项目 → 旧改名会话收起且零请求');

  const beforeProjectRename = net.posts('/api/projects/rename').length;
  const pencilPos = await ev(t.tab, rectCenter(`document.querySelectorAll('button.project__rename')[0]`), false);
  check('U-01 找到项目A的铅笔按钮', pencilPos !== null, pencilPos);
  await realClick(t.tab, pencilPos.x, pencilPos.y, 1);
  await sleep(500);
  check('U-02 项目A进入显示名编辑', (await ev(t.tab, projectRenameOpen, false)) === true);
  await ev(
    t.tab,
    `(() => {
      const el = document.querySelector('input[aria-label="项目显示名称"]');
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '项目A（草稿）');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
    false,
  );
  await shot(t.tab, '04-project-rename-draft.png');

  const projectBPos = await ev(t.tab, nameRect('项目B'), false);
  check('U-03 找到项目B的根行名称', projectBPos !== null, projectBPos);
  await realClick(t.tab, projectBPos.x, projectBPos.y, 1);
  // 根行名称单击也要过 500ms 仲裁窗口，等它真的切过去
  await sleep(1400);

  check('U-04 切换当前项目后旧编辑会话已收起', (await ev(t.tab, projectRenameOpen, false)) === false);
  check(
    'U-05 会话收起后没有发出任何 projects/rename（不自动提交、不自动重试）',
    net.posts('/api/projects/rename').length === beforeProjectRename,
    net.posts('/api/projects/rename').length,
  );
  await shot(t.tab, '05-project-rename-collapsed.png');

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
