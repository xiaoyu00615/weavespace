/**
 * UX-02C-02-R2.1 真实浏览器复验（Chrome headless + 真实 Host + 真实 Vite Shell）。
 *
 * 本轮必须用**真实按键**取证的地方（不能再用"点取消按钮"掩盖失焦）：
 * - 行内改名：Enter 提交 / 被拒后焦点回到输入框 / 焦点回来之后 Escape 才有效；
 * - 提交中连按 Enter：只发一个请求（单飞 + preventDefault 挡掉按钮原生激活）；
 * - 移动对话框：Escape 取消、Enter 提交；目标目录被外部替换后拒绝且源不动；
 * - 正文编辑器里打字与 Enter 不被文件树的键盘处理抢走。
 *
 * 只碰 `D:/Workspace/projects/weavespace-test/c02-r21`，不碰用户真实文件。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:/Workspace/projects/weavespace';
const BASE = 'D:/Workspace/projects/weavespace-test/c02-r21';
const ROOT_A = join(BASE, 'projA');
const ROOT_B = join(BASE, 'projB');
const STORE = join(BASE, 'store/workspace.json');
const PROJECT_A = 'proj-a';
const PROJECT_B = 'proj-b';

const HOST_PORT = 5441;
const APP_PORT = 5442;
const CDP_PORT = 9381;
const HOST = `http://127.0.0.1:${HOST_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}/`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

process.env.CDP_PORT = String(CDP_PORT);
const { ev, newTab, sleep, waitFor } = await import('../ux-02c-05-r1-followup/cdp.mjs');

const report = { run: 'ux-02c-02-r21', at: new Date().toISOString(), checks: {}, detail: {}, facts: {} };
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
  writeFileSync(join(ROOT_A, 'note.md'), '# note\n\nR2.1 浏览器验证用\n');
  writeFileSync(join(ROOT_A, 'other.md'), '# other\n');
  writeFileSync(join(ROOT_A, 'dup.md'), '# dup\n');
  writeFileSync(join(ROOT_A, 'docs/inner.md'), '# inner\n');
  writeFileSync(join(ROOT_A, 'archive/keep.md'), 'KEEP\n');
  writeFileSync(join(ROOT_B, 'b.md'), '# b\n');
}

const storeConfig = () => {
  const { serializeConfig } = configModule;
  const { rootTokenOf } = pathModule;
  return serializeConfig({
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
        rootToken: rootTokenOf(ROOT_A),
        grantedAt: '2026-11-28T00:00:00.000Z',
        grantSource: 'os-dialog',
      },
      {
        projectId: PROJECT_B,
        name: '项目B',
        rootDir: ROOT_B,
        canonicalRoot: ROOT_B,
        rootToken: rootTokenOf(ROOT_B),
        grantedAt: '2026-11-28T00:00:00.000Z',
        grantSource: 'os-dialog',
      },
    ],
    hidden: [],
    trash: [],
    metadata: [],
  });
};

const configModule = await import(`file:///${REPO}/apps/server/src/store/config.ts`);
const pathModule = await import(`file:///${REPO}/packages/storage/path-safety.ts`);

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
const nameRect = (name) => `(() => {
  const row = ${rowExpr(name)};
  const span = row?.querySelector('.tree__name');
  if (!span) return null;
  const r = span.getBoundingClientRect();
  return { x: r.left + Math.min(24, r.width / 2), y: r.top + r.height / 2 };
})()`;
const rowRect = (name) => `(() => {
  const row = ${rowExpr(name)};
  if (!row) return null;
  const r = row.getBoundingClientRect();
  return { x: r.left + 40, y: r.top + r.height / 2 };
})()`;

const renameInputOpen = `!!document.querySelector('input[aria-label="新名称"]')`;
const renameFocus = `(() => {
  const el = document.activeElement;
  return el ? { tag: el.tagName, label: el.getAttribute('aria-label'), cls: el.className } : null;
})()`;
const renameError = `(() => {
  const el = document.querySelector('.tree__create-hint--error');
  return el ? el.textContent : null;
})()`;
const moveDialogOpen = `!!document.querySelector('[aria-label="移动文件或文件夹"]')`;
const moveError = `(() => {
  const el = document.querySelector('.move__error');
  return el ? el.textContent : null;
})()`;
const confirmIsFocused = `(() => {
  const dialog = document.querySelector('[aria-label="移动文件或文件夹"]');
  const primary = dialog?.querySelector('.modal__actions .button:not(.button--ghost)');
  return !!primary && document.activeElement === primary;
})()`;

const setInputValue = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
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

/**
 * 在 textarea 里按 Enter：必须带 `text: '\r'`，否则 CDP 只发 keydown/keyup，
 * 浏览器不会插入换行——那是取证工具的细节，不是应用行为。
 */
async function pressEnterWithText(tab) {
  const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: '\r', unmodifiedText: '\r' });
  await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(150);
}

async function typeText(tab, text) {
  for (const char of text) {
    await tab.send('Input.dispatchKeyEvent', { type: 'char', text: char });
    await sleep(20);
  }
}

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
    stop: off,
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
  check('S-01 fixture 就绪（两个真实项目 / 三份根文件 / 两个子目录）', existsSync(join(ROOT_A, 'docs/inner.md')));

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
  check('S-02 真实工作区已加载（项目A 有文件行）', (await ev(t.tab, `document.querySelectorAll('button.tree__row--file').length`, false)) > 0);

  /* ================= A：行内改名（Enter / 失焦 / Escape） ================= */
  section('A 行内改名：Enter 提交、被拒后焦点回到输入框、Escape 才有效');

  const notePos = await ev(t.tab, nameRect('note.md'), false);
  check('A-00 找到 note.md 名称', notePos !== null, notePos);
  await slowDoubleClick(t.tab, notePos.x, notePos.y, 300);
  await sleep(500);
  check('A-01 双击进入改名输入行', (await ev(t.tab, renameInputOpen, false)) === true);
  check(
    'A-02 打开即聚焦（Escape 有接收者）',
    (await ev(t.tab, renameFocus, false))?.label === '新名称',
    await ev(t.tab, renameFocus, false),
  );

  const postsRenameStart = net.posts('/api/files/rename').length;
  await ev(t.tab, setInputValue('input[aria-label="新名称"]', 'bad/name'), false);
  await pressKey(t.tab, 'Enter');
  await sleep(400);
  check('A-03 非法名称 + Enter：行内错误可见', /名称|非法|不能/.test((await ev(t.tab, renameError, false)) ?? ''), await ev(t.tab, renameError, false));
  check('A-04 非法名称零请求（本地形状校验先挡）', net.posts('/api/files/rename').length === postsRenameStart);
  check('A-05 被拒后输入行保留（不抹掉刚写的错误）', (await ev(t.tab, renameInputOpen, false)) === true);
  await shot(t.tab, '01-rename-inline-error.png');

  await pressKey(t.tab, 'Escape');
  await sleep(400);
  check('A-06 焦点在输入框时 Escape 正常取消', (await ev(t.tab, renameInputOpen, false)) === false);
  check('A-07 取消没有发出任何改名请求', net.posts('/api/files/rename').length === postsRenameStart);

  // 真实 Host 拒绝（目标同名已存在）→ 焦点必须回到输入框，Escape 才有接收者
  const dupPos = await ev(t.tab, nameRect('dup.md'), false);
  await slowDoubleClick(t.tab, dupPos.x, dupPos.y, 300);
  await sleep(500);
  check('A-08 打开 dup.md 的改名输入行', (await ev(t.tab, renameInputOpen, false)) === true);
  const postsRenameBeforeConflict = net.posts('/api/files/rename').length;
  await ev(t.tab, setInputValue('input[aria-label="新名称"]', 'note.md'), false);
  await pressKey(t.tab, 'Enter');
  await waitFor(t.tab, `!!document.querySelector('.tree__create-hint--error')`, 8000, 'rename conflict error');
  await sleep(500);
  const conflictError = await ev(t.tab, renameError, false);
  const focusAfterConflict = await ev(t.tab, renameFocus, false);
  fact('conflictError', conflictError);
  fact('focusAfterConflict', focusAfterConflict);
  check('A-09 Host 拒绝（同名已存在）后错误可见', /已存在|同名|目标/.test(conflictError ?? ''), conflictError);
  check('A-10 请求确实发出过一次并被拒绝', net.posts('/api/files/rename').length === postsRenameBeforeConflict + 1);
  check('A-11 输入行仍在（保留输入供修正）', (await ev(t.tab, renameInputOpen, false)) === true);
  check(
    'A-12 提交结束后焦点回到输入框（Escape / Enter 才有接收者）',
    focusAfterConflict?.label === '新名称',
    focusAfterConflict,
  );
  await shot(t.tab, '02-rename-rejected-focus.png');

  await pressKey(t.tab, 'Escape');
  await sleep(400);
  check('A-13 焦点恢复后 Escape 真正取消（不是点按钮）', (await ev(t.tab, renameInputOpen, false)) === false);

  // 提交中连按 Enter：只发一个请求
  const dupPos2 = await ev(t.tab, nameRect('dup.md'), false);
  await slowDoubleClick(t.tab, dupPos2.x, dupPos2.y, 300);
  await sleep(500);
  await ev(t.tab, setInputValue('input[aria-label="新名称"]', 'dup-renamed.md'), false);
  await t.tab.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/files/rename*', requestStage: 'Request' }],
  });
  const paused = [];
  const offPaused = t.tab.on('Fetch.requestPaused', (params) => paused.push(params.requestId));
  const postsBeforeDoubleEnter = net.posts('/api/files/rename').length;
  await pressKey(t.tab, 'Enter');
  await sleep(120);
  await pressKey(t.tab, 'Enter');
  for (let i = 0; i < 40 && paused.length === 0; i += 1) await sleep(150);
  await sleep(600);
  fact('renameRequestsDuringDoubleEnter', net.posts('/api/files/rename').length - postsBeforeDoubleEnter);
  check('A-14 提交中再按 Enter 不产生第二个请求', net.posts('/api/files/rename').length - postsBeforeDoubleEnter === 1, {
    paused: paused.length,
    requests: net.posts('/api/files/rename').length - postsBeforeDoubleEnter,
  });
  for (const requestId of paused) await t.tab.send('Fetch.continueRequest', { requestId }).catch(() => {});
  await t.tab.send('Fetch.disable').catch(() => undefined);
  offPaused?.();
  await waitFor(t.tab, `!document.querySelector('input[aria-label="新名称"]')`, 10000, 'rename applied');
  const renamedDisk = diskFacts(join(ROOT_A, 'dup-renamed.md'));
  fact('renamedDisk', renamedDisk);
  check('A-15 Enter 提交成功且磁盘真的改名（不是只有界面变了）', renamedDisk.exists && !existsSync(join(ROOT_A, 'dup.md')));

  /* ================= M：移动对话框（Escape / Enter） ================= */
  section('M 移动对话框：Escape 取消、Enter 提交、目标被外部替换后拒绝');

  const otherPos = await ev(t.tab, rowRect('other.md'), false);
  check('M-00 找到 other.md 行', otherPos !== null, otherPos);
  await rightClick(t.tab, otherPos.x, otherPos.y);
  const menuVisible = `document.body.innerText.includes('移动到…')`;
  check('M-01 右键菜单出现', (await ev(t.tab, menuVisible, false)) === true);
  await ev(
    t.tab,
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('移动到…'))?.click()`,
    false,
  );
  await sleep(500);
  check('M-02 移动对话框打开', (await ev(t.tab, moveDialogOpen, false)) === true);
  check('M-03 打开即聚焦确认按钮（Escape / Enter 有接收者）', (await ev(t.tab, confirmIsFocused, false)) === true);
  await shot(t.tab, '03-move-dialog.png');

  const postsMoveStart = net.posts('/api/files/move').length;
  await pressKey(t.tab, 'Escape');
  await sleep(400);
  check('M-04 Escape 关闭对话框', (await ev(t.tab, moveDialogOpen, false)) === false);
  check('M-05 Escape 零移动请求', net.posts('/api/files/move').length === postsMoveStart);

  await rightClick(t.tab, otherPos.x, otherPos.y);
  await ev(
    t.tab,
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('移动到…'))?.click()`,
    false,
  );
  await sleep(500);
  await ev(t.tab, setSelectValue('#move-target-select', 'archive'), false);
  await sleep(200);
  await pressKey(t.tab, 'Enter');
  await waitFor(t.tab, `!document.querySelector('[aria-label="移动文件或文件夹"]')`, 10000, 'move applied');
  const movedDisk = diskFacts(join(ROOT_A, 'archive/other.md'));
  fact('movedDisk', movedDisk);
  check('M-06 Enter 提交移动：磁盘真的搬进 archive', movedDisk.exists && !existsSync(join(ROOT_A, 'other.md')));

  // 目标目录被外部删除重建 → 旧锚失效 → 拒绝，源保持原位
  const movedRowPos = await ev(t.tab, rowRect('dup-renamed.md'), false);
  check('M-07 找到仍留在根目录的文件行', movedRowPos !== null, movedRowPos);
  await rightClick(t.tab, movedRowPos.x, movedRowPos.y);
  await ev(
    t.tab,
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('移动到…'))?.click()`,
    false,
  );
  await sleep(500);
  const archiveOption = await ev(
    t.tab,
    `[...document.querySelectorAll('#move-target-select option')].map(o=>o.value)`,
    false,
  );
  fact('moveOptions', archiveOption);
  await ev(t.tab, setSelectValue('#move-target-select', 'docs'), false);
  await sleep(150);
  // 外部把 docs 挪走再建一个同名目录（新 inode）
  rmSync(join(ROOT_A, 'docs'), { recursive: true, force: true });
  mkdirSync(join(ROOT_A, 'docs'), { recursive: true });
  const postsMoveBeforeStale = net.posts('/api/files/move').length;
  await pressKey(t.tab, 'Enter');
  await waitFor(t.tab, `!!document.querySelector('.move__error')`, 10000, 'move error');
  await sleep(400);
  const staleError = await ev(t.tab, moveError, false);
  fact('targetChangedError', staleError);
  check('M-08 目标目录被替换后 Host 拒绝并给出明确原因', /目标文件夹已被外部替换/.test(staleError ?? ''), staleError);
  check('M-09 只发出一次移动请求（拒绝后不自动重发）', net.posts('/api/files/move').length === postsMoveBeforeStale + 1);
  check('M-10 源文件仍原地（没有被搬进用户没确认的目录）', existsSync(join(ROOT_A, 'dup-renamed.md')));
  check('M-11 新目录保持空（没有留下痕迹）', !existsSync(join(ROOT_A, 'docs/dup-renamed.md')));
  check('M-12 对话框保留（错误行内可见，输入不丢）', (await ev(t.tab, moveDialogOpen, false)) === true);
  check('M-13 被拒后焦点回到确认按钮（Escape 可再取消）', (await ev(t.tab, confirmIsFocused, false)) === true);
  await shot(t.tab, '04-move-target-changed.png');
  await pressKey(t.tab, 'Escape');
  await sleep(400);
  check('M-14 被拒后 Escape 仍能关闭对话框', (await ev(t.tab, moveDialogOpen, false)) === false);

  /* ================= T：正文编辑器不被抢 ================= */
  section('T 正文编辑器：打字 / Enter / Escape 不被文件树的键盘处理截走');

  const editorRowPos = await ev(t.tab, rowRect('dup-renamed.md'), false);
  await realClick(t.tab, editorRowPos.x, editorRowPos.y, 1);
  await sleep(1200);
  const editorOpen = `!!document.querySelector('textarea.editor__area')`;
  check('T-01 单击打开编辑器', (await ev(t.tab, editorOpen, false)) === true);
  const beforeText = await ev(t.tab, `document.querySelector('textarea.editor__area')?.value ?? null`, false);
  await ev(t.tab, `document.querySelector('textarea.editor__area')?.focus()`, false);
  await typeText(t.tab, 'XY');
  await pressEnterWithText(t.tab);
  await pressKey(t.tab, 'Escape');
  await sleep(400);
  const afterText = await ev(t.tab, `document.querySelector('textarea.editor__area')?.value ?? null`, false);
  fact('editorBefore', beforeText);
  fact('editorAfter', afterText);
  check('T-02 按键真的进了编辑器（XY 与换行都写进了缓冲）', typeof afterText === 'string' && afterText.includes('XY') && afterText.split('\n').length > (beforeText ?? '').split('\n').length);
  check('T-03 树的改名输入行没有被打开', (await ev(t.tab, renameInputOpen, false)) === false);
  check('T-04 移动对话框没有被打开', (await ev(t.tab, moveDialogOpen, false)) === false);
  check(
    'T-05 焦点仍在编辑器里（没有被树抢走）',
    (await ev(t.tab, `document.activeElement?.className ?? ''`, false)).includes('editor__area'),
  );
  await shot(t.tab, '05-editor-keys.png');

  report.facts.requestTotals = {
    rename: net.posts('/api/files/rename').length,
    move: net.posts('/api/files/move').length,
  };
  const failed = Object.entries(report.checks).filter(([, ok]) => !ok).map(([name]) => name);
  report.failed = failed;
  report.ok = failed.length === 0;
  if (failed.length > 0) exitCode = 1;
  console.log(`\n${report.ok ? 'ALL PASS' : 'FAILED'}: ${Object.keys(report.checks).length} checks, ${failed.length} failed`);
} catch (err) {
  exitCode = 1;
  report.error = String(err && err.stack ? err.stack : err);
  console.error('\n[verify-r21] 异常：', report.error);
} finally {
  writeFileSync(join(HERE, 'browser-verification.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  stopAll();
  process.exit(exitCode);
}
