/**
 * UX-02C-05 真实浏览器复验：文件树菜单 / 工具栏 / 双击与键盘 / 菜单生命周期。
 *
 * 为什么必须是真实 Chrome + 真实 Host + 真实磁盘：
 * - 双击改名这件事的全部难点是"单击会先打开文件，而改名保护要求没有打开的标签"。
 *   只有在真实浏览器里用 `Input.dispatchMouseEvent`（clickCount 1 → 2）才能产生
 *   真正的 click(1) → click(2) → dblclick 序列，单测只能证明仲裁器本身；
 * - 菜单失效同理：切模式是真实的状态切换，旧菜单是否还在 DOM 里必须眼见为实；
 * - 创建目标必须看**真正发出去的 POST 里的 parentDir**，不能看界面猜。
 *
 * 只碰 `D:/Workspace/projects/weavespace-test/c05`，不碰用户真实文件。
 *
 * 用法：node docs/evidence/ux-02c-05-tree-interactions/verify-tree-interactions.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:/Workspace/projects/weavespace';
const BASE = 'D:/Workspace/projects/weavespace-test/c05';
const ROOT = join(BASE, 'projA');
const STORE = join(BASE, 'store/workspace.json');
const PROJECT = 'proj-a';

const HOST_PORT = 5401;
const APP_PORT = 5402;
const CDP_PORT = 9349;
const HOST = `http://127.0.0.1:${HOST_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}/`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

process.env.CDP_PORT = String(CDP_PORT);
const { ev, newTab, sleep, waitFor } = await import('./cdp.mjs');

/* ------------------------------ 报告 ------------------------------ */

const report = {
  run: 'ux-02c-05-tree-interactions',
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
};

/* ------------------------------ fixture ------------------------------ */

async function resetFixture() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, 'dir'), { recursive: true });
  mkdirSync(join(ROOT, 'dir/deep'), { recursive: true });
  writeFileSync(join(ROOT, 'note.md'), '# note\n\n交互复验用的文件\n');
  writeFileSync(join(ROOT, 'dir/inner.md'), '# inner\n');
  writeFileSync(join(ROOT, 'dir/deep/leaf.md'), '# leaf\n');
  writeFileSync(join(ROOT, '.gitignore'), '');

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
  rmSync(join(BASE, 'store/workspace.lock'), { force: true });
  return config;
}

/* ------------------------------ 进程 ------------------------------ */

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

/* ------------------------------ 页面原语 ------------------------------ */

const MENU = '.ctx-menu:not(.ctx-menu--sub)';
const menuOpen = `!!document.querySelector('${MENU}')`;
const renameInputOpen = `!!document.querySelector('input[aria-label="新名称"]')`;

const rowExpr = (name) =>
  `[...document.querySelectorAll('button.tree__row')].find(b=>b.querySelector('.tree__name')?.textContent===${JSON.stringify(name)})`;

const rootRowExpr = `document.querySelector('.tree__root > li > .tree__row-wrap > button.tree__row')`;

const nameRect = (name) => `(() => {
  const row = ${rowExpr(name)};
  const span = row?.querySelector('.tree__name');
  if (!span) return null;
  const r = span.getBoundingClientRect();
  return { x: r.left + Math.min(24, r.width / 2), y: r.top + r.height / 2 };
})()`;

const rectOf = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + 8, y: r.top + Math.min(10, r.height / 2) };
})()`;

/** 顶层菜单快照（不含二级）。 */
const menuSnapshot = `(() => {
  const root = document.querySelector('${MENU}');
  if (!root) return null;
  return [...root.querySelectorAll('.ctx-menu__item-wrap > button[role="menuitem"]')].map((b) => ({
    id: b.dataset.command ?? null,
    label: b.querySelector('span')?.textContent ?? b.innerText.trim(),
    disabled: b.disabled === true || b.dataset.disabled === 'true',
    hint: b.querySelector('.ctx-menu__hint')?.textContent ?? null,
  }));
})()`;

const setInputValue = (value) => `(() => {
  const el = document.querySelector('input[aria-label="新名称"], input[aria-label="新文件名称"], input[aria-label="新文件夹名称"]');
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
  return true;
})()`;

/**
 * 在"某个元素表达式"上派发 contextmenu。
 *
 * 传表达式而不是选择器：同名命令要按**行名**定位（`button.tree__row--folder`
 * 的第一条命中是项目根行，不是 `dir`），选择器做不到这件事。
 */
async function rightClick(tab, elExpr, offset = { dx: 8, dy: 8 }) {
  const ok = await ev(
    tab,
    `(() => {
      const el = ${elExpr};
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + ${offset.dx}, y: r.top + ${offset.dy} };
    })()`,
    false,
  );
  if (!ok) return null;
  await ev(
    tab,
    `(() => {
      const el = ${elExpr};
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${ok.x}, clientY: ${ok.y} }));
      return true;
    })()`,
    false,
  );
  await sleep(320);
  return ok;
}

async function realClick(tab, x, y, clickCount = 1) {
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount });
}

async function realDoubleClick(tab, x, y) {
  await realClick(tab, x, y, 1);
  await realClick(tab, x, y, 2);
  // Chrome 在第二次 mouseReleased 后合成 dblclick
  await sleep(60);
}

const KEYS = {
  F2: { key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 },
  F10: { key: 'F10', code: 'F10', windowsVirtualKeyCode: 121 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
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
  await sleep(120);
}

async function clickMenuCommand(tab, command) {
  const result = await ev(
    tab,
    `(() => {
      const item = document.querySelector('${MENU} button[data-command="' + ${JSON.stringify(command)} + '"]');
      if (!item) return 'missing';
      if (item.disabled) return 'disabled';
      item.click();
      return 'clicked';
    })()`,
    false,
  );
  await sleep(360);
  return result;
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
  await sleep(800);
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
    stop: off,
  };
}

/* ------------------------------ 主流程 ------------------------------ */

let exitCode = 0;

try {
  section('环境');
  const baseConfig = await resetFixture();
  check('E-00 fixture 就绪（v5 配置 / 零隐藏 / 零回收 / 零元数据）',
    baseConfig.version === 5 && baseConfig.hidden.length === 0 && baseConfig.trash.length === 0 && baseConfig.metadata.length === 0,
    baseConfig);

  const hostChild = spawnLogged(process.execPath,
    ['--experimental-strip-types', 'apps/server/src/main.ts', '--workspace-store', join(BASE, 'store'), String(HOST_PORT)],
    { cwd: REPO, env: { ...process.env } });
  hostLogs.push({ tag: 'host', child: hostChild });
  await waitHttp(`${HOST}/api/session-token`, 30000, 'host');

  const viteChild = spawnLogged('npm', ['--prefix', 'apps/shell', 'run', 'dev', '--', '--port', String(APP_PORT), '--strictPort'],
    { cwd: REPO, env: { ...process.env, WS_API_TARGET: HOST }, shell: true });
  hostLogs.push({ tag: 'vite', child: viteChild });
  await waitHttp(APP, 60000, 'vite');

  rmSync(join(BASE, 'chrome-profile'), { recursive: true, force: true });
  const chromeChild = spawnLogged(CHROME,
    ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(BASE, 'chrome-profile')}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank'],
    { env: { ...process.env } });
  hostLogs.push({ tag: 'chrome', child: chromeChild });
  await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 30000, 'chrome');

  const t = await openApp();
  await t.tab.send('Network.enable');
  const net = watchRequests(t.tab);

  /* ================= A：四类目标菜单 ================= */
  section('A 四类目标的右键菜单');

  await rightClick(t.tab, rowExpr('note.md'));
  const fileMenu = await ev(t.tab, menuSnapshot, false);
  fact('menuFile', fileMenu);
  const ids = (menu) => (menu ?? []).map((item) => item.id);
  check('A-01 文件菜单含 改名/移动/隐藏/回收/标注×3/创建×3/刷新',
    ['rename', 'move', 'hide', 'trash', 'meta-alias', 'meta-tags', 'meta-color', 'new-file', 'new-folder', 'new-supported', 'refresh']
      .every((id) => ids(fileMenu).includes(id)),
    ids(fileMenu));
  check('A-02 文件菜单不出现项目根专有命令',
    !ids(fileMenu).includes('rename-project') && !ids(fileMenu).includes('remove-project'), ids(fileMenu));
  check('A-03 文件菜单里没有任何"可见但禁用"的项（真实项目、普通文件）',
    (fileMenu ?? []).every((item) => !item.disabled),
    (fileMenu ?? []).filter((item) => item.disabled));
  await shot(t.tab, '01-file-menu.png');
  await pressKey(t.tab, 'Escape');
  check('A-04 Escape 关闭文件菜单', (await ev(t.tab, menuOpen, false)) === false);

  await rightClick(t.tab, rowExpr('dir'), { dx: 8, dy: 16 });
  const folderMenu = await ev(t.tab, menuSnapshot, false);
  fact('menuFolder', folderMenu);
  const folderTrash = (folderMenu ?? []).find((item) => item.id === 'trash');
  check('A-05 文件夹菜单：改名/移动/标注/创建/刷新都在',
    ['rename', 'move', 'meta-alias', 'new-file', 'new-folder', 'refresh'].every((id) => ids(folderMenu).includes(id)),
    ids(folderMenu));
  check('A-06 文件夹菜单的「移入回收区」可见、禁用、并说明只支持普通文件',
    Boolean(folderTrash) && folderTrash.disabled === true && /普通文件/.test(folderTrash.hint ?? ''),
    folderTrash);
  check('A-07 文件夹菜单没有伪造目录删除/项目根命令',
    !ids(folderMenu).includes('remove-project') && !ids(folderMenu).includes('rename-project'),
    ids(folderMenu));
  await shot(t.tab, '02-folder-menu.png');
  await pressKey(t.tab, 'Escape');

  await rightClick(t.tab, rootRowExpr, { dx: 10, dy: 14 });
  const rootMenu = await ev(t.tab, menuSnapshot, false);
  fact('menuRoot', rootMenu);
  check('A-08 项目根菜单：创建×3 / 显示名 / 标注×3 / 刷新 / 移除',
    ['new-file', 'new-folder', 'new-supported', 'rename-project', 'meta-alias', 'meta-tags', 'meta-color', 'refresh', 'remove-project']
      .every((id) => ids(rootMenu).includes(id)),
    ids(rootMenu));
  check('A-09 项目根菜单不出现 改名/移动/回收/隐藏（根不是磁盘条目）',
    !['rename', 'move', 'trash', 'hide', 'unhide'].some((id) => ids(rootMenu).includes(id)),
    ids(rootMenu));
  const rootRename = (rootMenu ?? []).find((item) => item.id === 'rename-project');
  const rootRemove = (rootMenu ?? []).find((item) => item.id === 'remove-project');
  check('A-10 「修改项目显示名称」与「从工作台移除项目」文案互相独立（不是删除磁盘）',
    /显示名称/.test(rootRename?.label ?? '') && /移除项目/.test(rootRemove?.label ?? '') && !/删除/.test(rootRemove?.label ?? ''),
    { rootRename, rootRemove });
  await shot(t.tab, '03-root-menu.png');
  await pressKey(t.tab, 'Escape');

  await rightClick(t.tab, "document.querySelector('ul.tree__root')", { dx: 40, dy: 240 });
  const blankMenu = await ev(t.tab, menuSnapshot, false);
  fact('menuBlank', blankMenu);
  check('A-11 空白区菜单只有创建×3 与刷新',
    JSON.stringify(ids(blankMenu)) === JSON.stringify(['new-file', 'new-folder', 'new-supported', 'refresh']),
    ids(blankMenu));
  check('A-12 空白区（有活动项目）创建与刷新都可用',
    (blankMenu ?? []).every((item) => !item.disabled), blankMenu);
  await shot(t.tab, '04-blank-menu.png');
  await pressKey(t.tab, 'Escape');

  /* ================= B：工具栏 ================= */
  section('B 工具栏与菜单共享同一份可用性');

  const toolbar = await ev(t.tab, `(() => [...document.querySelectorAll('[data-toolbar-command]')].map((b) => ({
    id: b.dataset.toolbarCommand,
    disabled: b.disabled === true,
    title: b.getAttribute('title'),
    aria: b.getAttribute('aria-label'),
  })))()`, false);
  fact('toolbar', toolbar);
  check('B-01 工具栏含 新建文件/新建文件夹/刷新/显示隐藏项 四个入口',
    ['new-file', 'new-folder', 'refresh', 'show-hidden'].every((id) => toolbar.some((b) => b.id === id)),
    toolbar.map((b) => b.id));
  check('B-02 每个按钮都有 aria-label 与 title（可访问名称 + 说明）',
    toolbar.every((b) => Boolean(b.aria) && Boolean(b.title)), toolbar);

  // 选中文件夹 dir → 空白区与工具栏必须解析出同一个 parentDir（看真实 POST body）
  const dirRect = await ev(t.tab, rectOf('button.tree__row--folder:nth-of-type(1)'), false);
  const folderRow = await ev(t.tab, `(() => {
    const row = [...document.querySelectorAll('button.tree__row--folder')].find(b=>b.querySelector('.tree__name')?.textContent==='dir');
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.left + 6, y: r.top + r.height / 2 };
  })()`, false);
  check('B-03 找到文件夹行 dir（准备把它设为当前目录）', folderRow !== null, { dirRect, folderRow });
  await realClick(t.tab, folderRow.x, folderRow.y, 1);
  await sleep(700);

  const createPosts = () => net.posts('/api/files/create');
  const bodyOf = (post) => {
    try {
      return JSON.parse(post.postData ?? '{}');
    } catch {
      return {};
    }
  };

  const beforeBlank = createPosts().length;
  await rightClick(t.tab, "document.querySelector('ul.tree__root')", { dx: 40, dy: 240 });
  check('B-04 空白区点「新建文件」', (await clickMenuCommand(t.tab, 'new-file')) === 'clicked');
  await waitFor(t.tab, `!!document.querySelector('input[aria-label="新文件名称"]')`, 6000, 'create input');
  await ev(t.tab, setInputValue('from-blank-menu.md'), false);
  await pressKey(t.tab, 'Enter');
  await waitFor(t.tab, `!document.querySelector('input[aria-label="新文件名称"]')`, 12000, 'create input closed');
  await sleep(400);
  const afterBlank = createPosts();
  const blankBody = afterBlank.length > beforeBlank ? bodyOf(afterBlank[afterBlank.length - 1]) : null;
  check('B-05 空白区创建发到 parentDir=dir（当前选中的目录）', blankBody?.parentDir === 'dir', blankBody);
  check('B-06 磁盘上确实落在 dir/ 里', existsSync(join(ROOT, 'dir/from-blank-menu.md')), null);

  await realClick(t.tab, folderRow.x, folderRow.y, 1);
  await sleep(500);
  const beforeToolbar = createPosts().length;
  await ev(t.tab, `document.querySelector('[data-toolbar-command="new-file"]').click()`, false);
  await waitFor(t.tab, `!!document.querySelector('input[aria-label="新文件名称"]')`, 6000, 'toolbar create input');
  await ev(t.tab, setInputValue('from-toolbar.md'), false);
  await pressKey(t.tab, 'Enter');
  await waitFor(t.tab, `!document.querySelector('input[aria-label="新文件名称"]')`, 12000, 'toolbar create closed');
  await sleep(400);
  const afterToolbar = createPosts();
  const toolbarBody = afterToolbar.length > beforeToolbar ? bodyOf(afterToolbar[afterToolbar.length - 1]) : null;
  fact('createTargets', { blank: blankBody, toolbar: toolbarBody });
  check('B-07 工具栏创建与空白区解析出同一个 parentDir（同一条 resolveCreateTarget）',
    toolbarBody !== null && toolbarBody.parentDir === blankBody?.parentDir,
    { blank: blankBody?.parentDir, toolbar: toolbarBody?.parentDir });
  check('B-08 磁盘上确实落在 dir/ 里（工具栏）', existsSync(join(ROOT, 'dir/from-toolbar.md')), null);

  // 文件上右键创建：绝不能把文件路径当目录
  const beforeFile = createPosts().length;
  await rightClick(t.tab, rowExpr('note.md'));
  check('B-09 文件右键点「新建文件」', (await clickMenuCommand(t.tab, 'new-file')) === 'clicked');
  await waitFor(t.tab, `!!document.querySelector('input[aria-label="新文件名称"]')`, 6000, 'file-target create input');
  await ev(t.tab, setInputValue('from-file-menu.md'), false);
  await pressKey(t.tab, 'Enter');
  await waitFor(t.tab, `!document.querySelector('input[aria-label="新文件名称"]')`, 12000, 'file-target create closed');
  await sleep(400);
  const afterFile = createPosts();
  const fileBody = afterFile.length > beforeFile ? bodyOf(afterFile[afterFile.length - 1]) : null;
  check('B-10 对文件右键创建 → 目标是它的父目录，不是文件路径',
    fileBody?.parentDir === '' && !String(fileBody?.parentDir ?? '').includes('note.md'),
    fileBody);

  /* ================= D：双击名称改名 ================= */
  section('D 双击名称改名（不破坏单击打开）');

  const namePos = await ev(t.tab, nameRect('note.md'), false);
  check('D-01 找到 note.md 的名称文字', namePos !== null, namePos);
  await realDoubleClick(t.tab, namePos.x, namePos.y);
  await waitFor(t.tab, renameInputOpen, 6000, 'rename input');
  const openedAfterDouble = await ev(t.tab, `(() => {
    const row = ${rowExpr('note.md')};
    if (!row) return null;
    return {
      opened: row.classList.contains('tree__row--opened'),
      classes: row.className,
    };
  })()`, false);
  check('D-02 双击后进入改名，且文件**没有**被打开（单击未提前触发）',
    openedAfterDouble?.opened === false, openedAfterDouble);
  await shot(t.tab, '05-name-edit-dblclick.png');

  const beforeRename = net.posts('/api/files/rename').length;
  await pressKey(t.tab, 'Escape');
  await sleep(600);
  check('D-03 Escape 取消改名：输入行关闭', (await ev(t.tab, renameInputOpen, false)) === false);
  check('D-04 Escape 零写入（没有发出任何 files/rename）',
    net.posts('/api/files/rename').length === beforeRename,
    net.posts('/api/files/rename').length);
  check('D-05 磁盘文件名未变', existsSync(join(ROOT, 'note.md')), null);

  await realDoubleClick(t.tab, namePos.x, namePos.y);
  await waitFor(t.tab, renameInputOpen, 6000, 'rename input again');
  await ev(t.tab, setInputValue('note-renamed.md'), false);
  await pressKey(t.tab, 'Enter');
  await waitFor(t.tab, `!document.querySelector('input[aria-label="新名称"]')`, 15000, 'rename closed');
  await sleep(600);
  const renamePosts = net.posts('/api/files/rename');
  const renameBodies = renamePosts.map(bodyOf);
  fact('renameBodies', renameBodies);
  check('D-06 确认后只发一次 files/rename，且新名称正确',
    renamePosts.length === beforeRename + 1 &&
      renameBodies[renameBodies.length - 1]?.name === 'note-renamed.md',
    renameBodies);
  check('D-07 磁盘上真的改名了', existsSync(join(ROOT, 'note-renamed.md')) && !existsSync(join(ROOT, 'note.md')), null);

  /* ---- F2 + 重复 Enter 不双重提交（用 Fetch 挂住请求制造"提交中"窗口）---- */
  const innerRect = await ev(t.tab, `(() => {
    const row = ${rowExpr('inner.md')};
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.left + 6, y: r.top + r.height / 2 };
  })()`, false);
  check('D-08 找到 dir/inner.md 行', innerRect !== null, innerRect);
  // 关键：只用 focus() 把焦点放到这一行，**不点击**。
  // 点击会立刻打开文件进入活动 View，而改名保护要求"没有打开的标签"——
  // 那样测到的就不是 F2，而是"被自己的保护挡住"。
  const focused = await ev(t.tab, `(() => { const row = ${rowExpr('inner.md')}; if (!row) return false; row.focus(); return document.activeElement === row; })()`, false);
  check('D-08b 焦点落在这一行（未打开文件）', focused === true, focused);
  await sleep(200);
  await pressKey(t.tab, 'F2');
  await sleep(300);
  check('D-09 F2 在当前焦点行上打开改名（键盘入口）',
    (await ev(t.tab, renameInputOpen, false)) === true);

  let paused = [];
  const pausedPromise = new Promise((resolve) => {
    const off = t.tab.on('Fetch.requestPaused', (params) => {
      if (!params.request.url.includes('/api/files/rename')) return;
      paused.push(params);
      if (paused.length >= 1) resolve('paused');
    });
    t.tab.pausedOff = off;
  });
  await t.tab.send('Fetch.enable', { patterns: [{ urlPattern: '*files/rename*' }] });
  const beforeInner = net.posts('/api/files/rename').length;
  await ev(t.tab, setInputValue('inner-renamed.md'), false);
  await pressKey(t.tab, 'Enter');
  await Promise.race([pausedPromise, sleep(8000)]);
  check('D-10 改名请求已被挂住（正处在"提交中"窗口）', paused.length === 1, paused.length);
  await pressKey(t.tab, 'Enter');
  await pressKey(t.tab, 'Enter');
  await sleep(500);
  check('D-11 提交中连按两次 Enter 不产生第二次请求（单飞）', paused.length === 1, paused.length);

  t.tab.pausedOff?.();
  if (paused.length > 0) {
    await t.tab.send('Fetch.continueRequest', { requestId: paused[0].requestId });
  }
  await t.tab.send('Fetch.disable');
  await sleep(1200);
  check('D-12 放行后恰好一次 files/rename',
    net.posts('/api/files/rename').length === beforeInner + 1,
    net.posts('/api/files/rename').length - beforeInner);
  check('D-13 磁盘上 inner.md 已改名为 inner-renamed.md',
    existsSync(join(ROOT, 'dir/inner-renamed.md')), null);

  /* ================= H：菜单生命周期 ================= */
  section('H 菜单生命周期（关闭 / 视口 / 失效）');

  await rightClick(t.tab, rowExpr('dir'), { dx: 8, dy: 16 });
  const identityBefore = await ev(t.tab, `document.querySelector('${MENU}')?.dataset.menuIdentity ?? null`, false);
  check('H-01 菜单带身份标记（模式/工作区/当前项目）', typeof identityBefore === 'string' && identityBefore.length > 0, identityBefore);

  // 外部点击关闭：点到树页脚（无副作用）
  const footer = await ev(t.tab, `(() => {
    const el = document.querySelector('.tree__footer');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`, false);
  if (footer) await realClick(t.tab, footer.x, footer.y, 1);
  await sleep(400);
  check('H-02 外部点击关闭菜单', (await ev(t.tab, menuOpen, false)) === false);

  // 视口夹取：靠近右下角
  const vp = await ev(t.tab, `({ w: window.innerWidth, h: window.innerHeight })`, false);
  await ev(t.tab, `(() => {
    const el = document.querySelector('ul.tree__root');
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${vp.w} - 4, clientY: ${vp.h} - 4 }));
    return true;
  })()`, false);
  await sleep(400);
  const menuRect = await ev(t.tab, `(() => {
    const el = document.querySelector('${MENU}');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  })()`, false);
  check('H-03 靠近右下角时菜单仍完全在视口内',
    menuRect !== null && menuRect.left >= 0 && menuRect.top >= 0 && menuRect.right <= vp.w && menuRect.bottom <= vp.h,
    { menuRect, vp });

  // 切模式 → 旧菜单必须消失
  await pressKey(t.tab, 'Escape');
  await rightClick(t.tab, rowExpr('dir'), { dx: 8, dy: 16 });
  check('H-04 再次打开菜单', (await ev(t.tab, menuOpen, false)) === true);
  await ev(t.tab, `[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='演示')?.click()`, false);
  await sleep(900);
  const staleGone = await ev(t.tab, `({ menu: !!document.querySelector('${MENU}'), identity: document.querySelector('${MENU}')?.dataset.menuIdentity ?? null })`, false);
  check('H-05 切换到演示模式后旧菜单立即失效（不向别的工作区发旧命令）',
    staleGone.menu === false, staleGone);
  await shot(t.tab, '06-stale-menu-closed.png');

  /* ================= C：禁用与原因（演示模式） ================= */
  section('C 不可用上下文：入口保留 + 原因明确 + 键盘也不越权');

  await waitFor(t.tab, `document.querySelectorAll('button.tree__row--file').length > 0`, 15000, 'demo rows');
  await sleep(600);
  await rightClick(t.tab, "document.querySelector('button.tree__row--file')");
  const demoMenu = await ev(t.tab, menuSnapshot, false);
  fact('menuDemo', demoMenu);
  const demoVisible = demoMenu ?? [];
  const demoDisabled = demoVisible.filter((item) => item.disabled);
  check('C-01 演示模式：命令入口保留（不是全部消失）', demoVisible.length > 0, demoVisible.map((i) => i.id));
  check('C-02 每个可见但禁用的命令都带原因（用户不用猜）',
    demoDisabled.length > 0 && demoDisabled.every((item) => typeof item.hint === 'string' && item.hint.length > 0),
    demoDisabled);
  const demoCreate = demoVisible.find((item) => item.id === 'new-file');
  check('C-03 没有明确项目时创建给的是「先选中一个项目」，不是含糊的模式提示',
    demoCreate?.disabled === true && /请先选中一个项目/.test(demoCreate.hint ?? ''),
    demoCreate);
  await shot(t.tab, '07-demo-disabled-reasons.png');
  await pressKey(t.tab, 'Escape');

  const demoFiles = await ev(t.tab, `(() => {
    const row = document.querySelector('button.tree__row--file');
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.left + 6, y: r.top + r.height / 2 };
  })()`, false);
  await realClick(t.tab, demoFiles.x, demoFiles.y, 1);
  await sleep(400);
  await pressKey(t.tab, 'F2');
  await sleep(500);
  check('C-04 F2 在禁用上下文里不执行改名（禁用项不因键盘被执行）',
    (await ev(t.tab, renameInputOpen, false)) === false,
    await ev(t.tab, `document.querySelector('input[aria-label="新名称"]')?.value ?? null`, false));

  const demoToolbar = await ev(t.tab, `(() => {
    const b = document.querySelector('[data-toolbar-command="new-file"]');
    return b ? { disabled: b.disabled === true, title: b.getAttribute('title') } : null;
  })()`, false);
  check('C-05 演示模式下工具栏按钮禁用并给出同一句原因',
    demoToolbar?.disabled === true && /请先选中一个项目|不支持/.test(demoToolbar.title ?? ''),
    demoToolbar);

  /* ---- 回到真实模式，确认没有残留 ---- */
  await ev(t.tab, `[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='真实文件')?.click()`, false);
  await waitFor(t.tab, `document.querySelectorAll('button.tree__row--file').length > 0`, 25000, 'live rows back');
  await sleep(900);
  const finalNames = await ev(t.tab, `[...document.querySelectorAll('button.tree__row .tree__name')].map((s) => s.textContent)`, false);
  fact('finalNames', finalNames);
  check('C-06 回到真实模式后目录内容与磁盘一致（改名/创建都已落地）',
    finalNames.includes('note-renamed.md') && finalNames.includes('from-blank-menu.md'), finalNames);
  check('C-07 没有过期菜单残留', (await ev(t.tab, menuOpen, false)) === false);

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
  writeFileSync(join(HERE, 'host-logs.txt'),
    hostLogs.map(({ tag, child }) => `### ${tag}\n${child.collected()}`).join('\n'), 'utf8');
  writeFileSync(join(HERE, 'browser-verification.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await sleep(1200);
  process.exit(exitCode);
}
