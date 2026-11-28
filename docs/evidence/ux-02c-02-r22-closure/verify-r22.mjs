/**
 * UX-02C-02-R2.2 真实浏览器复验（Chrome headless + 真实 Host + 真实 Vite Shell）。
 *
 * 本轮浏览器要证明的事（F02）：目标身份被拒之后，对话框**真的**能恢复——
 * 打开 → 选目标 → 外部替换目标 → 提交被拒 → 目标所属父层被刷新 →
 * 用户点「重新确认目标」（捕获新锚）→ 再提交 → 真的移动成功。
 *
 * 同时核对：两次请求的 targetAnchor 不同；第一次请求源文件不动、目标未创建；
 * 第二次请求只能来自用户明确操作（点击 / Enter），不是自动重发。
 *
 * 只碰 `D:/Workspace/projects/weavespace-test/c02-r22`，不碰用户真实文件。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:/Workspace/projects/weavespace';
const BASE = 'D:/Workspace/projects/weavespace-test/c02-r22';
const ROOT_A = join(BASE, 'projA');
const ROOT_B = join(BASE, 'projB');
const STORE = join(BASE, 'store/workspace.json');
const PROJECT_A = 'proj-a';
const PROJECT_B = 'proj-b';

const HOST_PORT = 5451;
const APP_PORT = 5452;
const CDP_PORT = 9391;
const HOST = `http://127.0.0.1:${HOST_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}/`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

process.env.CDP_PORT = String(CDP_PORT);
const { ev, newTab, sleep, waitFor } = await import('../ux-02c-05-r1-followup/cdp.mjs');

const report = { run: 'ux-02c-02-r22', at: new Date().toISOString(), checks: {}, detail: {}, facts: {} };
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

function resetFixture() {
  rmSync(ROOT_A, { recursive: true, force: true });
  rmSync(ROOT_B, { recursive: true, force: true });
  mkdirSync(join(ROOT_A, 'docs'), { recursive: true });
  mkdirSync(join(ROOT_A, 'archive'), { recursive: true });
  mkdirSync(ROOT_B, { recursive: true });
  writeFileSync(join(ROOT_A, 'note.md'), '# note\n');
  writeFileSync(join(ROOT_A, 'move-me.md'), '# move me\n');
  writeFileSync(join(ROOT_A, 'docs/inner.md'), '# inner\n');
  writeFileSync(join(ROOT_A, 'archive/keep.md'), 'KEEP\n');
  writeFileSync(join(ROOT_B, 'b.md'), '# b\n');
}

const configModule = await import(`file:///${REPO}/apps/server/src/store/config.ts`);
const pathModule = await import(`file:///${REPO}/packages/storage/path-safety.ts`);

const storeConfig = () =>
  configModule.serializeConfig({
    version: 5,
    commitSeq: 0,
    issuedIds: [PROJECT_A, PROJECT_B],
    revoked: [],
    projects: [
      {
        projectId: PROJECT_A,
        name: '项目A',
        rootDir: ROOT_A,
        canonicalRoot: ROOT_A,
        rootToken: pathModule.rootTokenOf(ROOT_A),
        grantedAt: '2026-11-28T00:00:00.000Z',
        grantSource: 'os-dialog',
      },
      {
        projectId: PROJECT_B,
        name: '项目B',
        rootDir: ROOT_B,
        canonicalRoot: ROOT_B,
        rootToken: pathModule.rootTokenOf(ROOT_B),
        grantedAt: '2026-11-28T00:00:00.000Z',
        grantSource: 'os-dialog',
      },
    ],
    hidden: [],
    trash: [],
    metadata: [],
  });

/* ------------------------------ 进程 ------------------------------ */

const children = new Set();
function spawnLogged(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  child.stdout.on('data', (d) => chunks.push(d.toString()));
  child.stderr.on('data', (d) => chunks.push(d.toString()));
  children.add(child);
  return child;
}
function stopAll() {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已经退出 */
    }
  }
  children.clear();
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

const rowExpr = (name) =>
  `[...document.querySelectorAll('button.tree__row')].find(b=>b.querySelector('.tree__name')?.textContent===${JSON.stringify(name)})`;
const rowRect = (name) => `(() => {
  const row = ${rowExpr(name)};
  if (!row) return null;
  const r = row.getBoundingClientRect();
  return { x: r.left + 40, y: r.top + r.height / 2 };
})()`;

const moveDialogOpen = `!!document.querySelector('[aria-label="移动文件或文件夹"]')`;
const moveError = `(() => {
  const el = document.querySelector('.move__error');
  return el ? el.textContent : null;
})()`;
const staleHint = `(() => {
  const el = document.querySelector('.move__stale');
  return el ? el.textContent : null;
})()`;
const reconfirmButton = `[...document.querySelectorAll('.move__stale button')].find(b=>b.textContent.trim()==='重新确认目标') ?? null`;
const confirmIsFocused = `(() => {
  const dialog = document.querySelector('[aria-label="移动文件或文件夹"]');
  const primary = dialog?.querySelector('.modal__actions .button:not(.button--ghost)');
  return !!primary && document.activeElement === primary;
})()`;

const setSelectValue = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

const KEYS = {
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
};
async function pressKey(tab, name) {
  const k = KEYS[name];
  await tab.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.windowsVirtualKeyCode,
    nativeVirtualKeyCode: k.windowsVirtualKeyCode,
  });
  await tab.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.windowsVirtualKeyCode,
    nativeVirtualKeyCode: k.windowsVirtualKeyCode,
  });
  await sleep(150);
}

async function realClick(tab, x, y) {
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
async function rightClick(tab, x, y) {
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
  await sleep(300);
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

function watchRequests(tab) {
  const sent = [];
  tab.on('Network.requestWillBeSent', (params) => {
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
  };
}

const diskFacts = (path) => {
  if (!existsSync(path)) return { exists: false };
  const stats = lstatSync(path);
  return {
    exists: true,
    size: stats.size,
    ino: String(stats.ino),
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
};

/* ------------------------------ 主流程 ------------------------------ */

let exitCode = 0;

try {
  section('环境');
  resetFixture();
  mkdirSync(join(BASE, 'store'), { recursive: true });
  writeFileSync(STORE, storeConfig());
  rmSync(join(BASE, 'store/workspace.lock'), { force: true });
  check('S-01 fixture 就绪', existsSync(join(ROOT_A, 'move-me.md')) && existsSync(join(ROOT_A, 'docs/inner.md')));

  spawnLogged(
    process.execPath,
    ['--experimental-strip-types', 'apps/server/src/main.ts', '--workspace-store', join(BASE, 'store'), String(HOST_PORT)],
    { cwd: REPO, env: { ...process.env } },
  );
  await waitHttp(`${HOST}/api/session-token`, 30000, 'host');

  spawnLogged('npm', ['--prefix', 'apps/shell', 'run', 'dev', '--', '--port', String(APP_PORT), '--strictPort'], {
    cwd: REPO,
    env: { ...process.env, WS_API_TARGET: HOST },
    shell: true,
  });
  await waitHttp(APP, 60000, 'vite');

  rmSync(join(BASE, 'chrome-profile'), { recursive: true, force: true });
  spawnLogged(
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
  const net = watchRequests(t.tab);
  await t.tab.send('Network.enable');
  check('S-02 工作区已加载', (await ev(t.tab, `document.querySelectorAll('button.tree__row--file').length`, false)) > 0);

  /* ============ M：目标身份变化后的恢复（F02） ============ */
  section('M 目标被外部替换 → 拒绝 → 刷新父层 → 用户重新确认 → 成功');

  const rowPos = await ev(t.tab, rowRect('move-me.md'), false);
  check('M-00 找到 move-me.md', rowPos !== null, rowPos);
  await rightClick(t.tab, rowPos.x, rowPos.y);
  await ev(t.tab, `[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('移动到…'))?.click()`, false);
  await sleep(500);
  check('M-01 移动对话框打开', (await ev(t.tab, moveDialogOpen, false)) === true);
  await ev(t.tab, setSelectValue('#move-target-select', 'docs'), false);
  await sleep(200);
  await shot(t.tab, '01-move-dialog-target-docs.png');

  // 记录选择后（对话框冻结）的锚：它来自 /api/tree 的 anchors.docs
  const treeBefore = net.trees().length;
  const sourceBefore = diskFacts(join(ROOT_A, 'move-me.md'));
  const postsBefore = net.posts('/api/files/move').length;

  // 外部把 docs 挪走，再建一个同名目录：身份变了，路径不变
  rmSync(join(ROOT_A, 'docs'), { recursive: true, force: true });
  mkdirSync(join(ROOT_A, 'docs'), { recursive: true });
  check('M-02 外部替换后目标目录仍存在但已是新对象', existsSync(join(ROOT_A, 'docs')));

  await pressKey(t.tab, 'Enter');
  await waitFor(t.tab, `!!document.querySelector('.move__error')`, 10000, 'rejection');
  await sleep(600);
  const firstError = await ev(t.tab, moveError, false);
  fact('firstError', firstError);
  check('M-03 第一次提交被拒且原因明确', /目标文件夹已被外部替换/.test(firstError ?? ''), firstError);
  check('M-04 只发出一次移动请求', net.posts('/api/files/move').length === postsBefore + 1, {
    before: postsBefore,
    after: net.posts('/api/files/move').length,
  });

  const sourceAfterFirst = diskFacts(join(ROOT_A, 'move-me.md'));
  fact('sourceBefore', sourceBefore);
  fact('sourceAfterFirst', sourceAfterFirst);
  check(
    'M-05 第一次请求源文件不动（inode 与摘要都不变）',
    sourceAfterFirst.ino === sourceBefore.ino && sourceAfterFirst.sha256 === sourceBefore.sha256,
  );
  check('M-06 第一次请求目标未创建', existsSync(join(ROOT_A, 'docs/move-me.md')) === false);

  // 目标所属父层被重取（根层）：这是"能恢复"的前提
  await sleep(800);
  check(
    'M-07 被拒后重取了目标所属父层（新的 /api/tree 请求）',
    net.trees().length > treeBefore,
    { before: treeBefore, after: net.trees().length },
  );

  const hint = await ev(t.tab, staleHint, false);
  fact('staleHint', hint);
  check('M-08 对话框出现"目标已过期"的说明', /已经在磁盘上被替换或移动过/.test(hint ?? ''), hint);
  check('M-09 提供了明确的"重新确认目标"入口', (await ev(t.tab, `!!(${reconfirmButton})`, false)) === true);
  await shot(t.tab, '02-move-target-stale.png');

  // 过期状态下按 Enter：本地挡住，不发请求（不自动重发）
  const postsBeforeEnter = net.posts('/api/files/move').length;
  await pressKey(t.tab, 'Enter');
  await sleep(500);
  const staleEnterError = await ev(t.tab, moveError, false);
  fact('staleEnterError', staleEnterError);
  check('M-10 目标过期时按 Enter 不发请求', net.posts('/api/files/move').length === postsBeforeEnter);
  check('M-11 并且明确要求先重新确认', /请先点「重新确认目标」/.test(staleEnterError ?? ''), staleEnterError);

  // 用户显式重新确认目标：捕获新锚
  await ev(t.tab, `(${reconfirmButton})?.click()`, false);
  await sleep(700);
  check('M-12 重新确认后"已过期"说明消失', (await ev(t.tab, staleHint, false)) === null);
  await shot(t.tab, '03-move-target-reconfirmed.png');

  // 第二次提交：必须是用户动作（Enter），且带新锚
  await pressKey(t.tab, 'Enter');
  await waitFor(t.tab, `!document.querySelector('[aria-label="移动文件或文件夹"]')`, 12000, 'move applied');
  await sleep(600);
  const moved = diskFacts(join(ROOT_A, 'docs/move-me.md'));
  fact('moved', moved);
  check('M-13 第二次提交真的移动成功', moved.exists && !existsSync(join(ROOT_A, 'move-me.md')));

  const moves = net.posts('/api/files/move');
  const anchors = moves
    .map((item) => {
      try {
        return JSON.parse(item.postData ?? '{}').targetAnchor ?? null;
      } catch {
        return null;
      }
    })
    .filter((value) => typeof value === 'string');
  fact('moveTargetAnchors', anchors);
  check('M-14 一共只有两次移动请求（没有自动重发）', moves.length === 2, moves.length);
  check('M-15 两次请求的目标锚不同（第二次是新身份）', anchors.length === 2 && anchors[0] !== anchors[1], anchors);
  check('M-16 第二次请求的锚不是第一次那个（冻结锚没有被悄悄替换）', anchors[1] !== anchors[0]);

  /* ============ E：Escape 回归（键盘路径仍然可用） ============ */
  section('E Escape 回归');

  const rowPos2 = await ev(t.tab, rowRect('note.md'), false);
  await rightClick(t.tab, rowPos2.x, rowPos2.y);
  await ev(t.tab, `[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('移动到…'))?.click()`, false);
  await sleep(500);
  check('E-01 对话框可再次打开', (await ev(t.tab, moveDialogOpen, false)) === true);
  check('E-02 打开即聚焦确认按钮', (await ev(t.tab, confirmIsFocused, false)) === true);
  const postsBeforeEscape = net.posts('/api/files/move').length;
  await pressKey(t.tab, 'Escape');
  await sleep(400);
  check('E-03 Escape 关闭对话框', (await ev(t.tab, moveDialogOpen, false)) === false);
  check('E-04 Escape 零请求', net.posts('/api/files/move').length === postsBeforeEscape);

  report.facts.requestTotals = { move: net.posts('/api/files/move').length, tree: net.trees().length };
  const failed = Object.entries(report.checks).filter(([, ok]) => !ok).map(([name]) => name);
  report.failed = failed;
  report.ok = failed.length === 0;
  if (failed.length > 0) exitCode = 1;
  console.log(`\n${report.ok ? 'ALL PASS' : 'FAILED'}: ${Object.keys(report.checks).length} checks, ${failed.length} failed`);
} catch (err) {
  exitCode = 1;
  report.error = String(err && err.stack ? err.stack : err);
  console.error('\n[verify-r22] 异常：', report.error);
} finally {
  writeFileSync(join(HERE, 'browser-verification.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  stopAll();
  process.exit(exitCode);
}
