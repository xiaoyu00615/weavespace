/**
 * UX-02C-02-R2 真实浏览器验收（B7）。
 *
 * 只碰 `D:/Workspace/projects/weavespace-test/c02-r2`，不碰用户真实文件。
 *
 * 核心场景（改名）：
 *   行内改名框已打开（意图已冻结）→ 外部删除重建同名文件 → **界面不刷新** →
 *   提交 → Host 明确拒绝 → 新文件仍在原路径且内容不变 → 目标路径未创建 →
 *   零覆盖、零错误移动、零自动重试 → 刷新后对当前对象再次改名成功。
 * 移动走同一套断言（右键 → 移动到… → 确认移动）。
 *
 * 证据强度：
 * - 请求体里的 `sourceAnchor` 从 CDP 抓真实 POST，不是从界面属性推断；
 * - Host 的拒绝码从 `Network.getResponseBody` 读真实响应体，不靠界面文案反推；
 * - 磁盘事实用 SHA-256 + size + inode，逐项与替换后的对象比对。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:/Workspace/projects/weavespace';
const BASE = 'D:/Workspace/projects/weavespace-test/c02-r2';
const ROOT_A = join(BASE, 'projA');
const STORE = join(BASE, 'store/workspace.json');
const A_MD = join(ROOT_A, 'a.md');
const NOTES = join(ROOT_A, 'docs/notes.md');
const PROJECT_A = 'proj-r2-a';

const HOST_PORT = 5441;
const APP_PORT = 5442;
const CDP_PORT = 9381;
const HOST = `http://127.0.0.1:${HOST_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}/`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
/*
 * 每次运行一个**全新**的临时 profile，直接放在系统临时目录里。
 * 之前固定放在 fixture 下并按目录递归清空：第一次跑没问题，第二次跑就有
 * 600+ 个文件，会撞上宿主的批量删除保护而整个验证中止。临时目录本来就是
 * 一次性用途，不删也不会污染仓库与测试数据。
 */
const CHROME_PROFILE = join(tmpdir(), `ws-r2-chrome-${Date.now()}`);

process.env.CDP_PORT = String(CDP_PORT);
const { ev, newTab, sleep, waitFor } = await import('../ux-02c-05-r1-followup/cdp.mjs');

/* ------------------------------ 报告 ------------------------------ */

const report = { run: 'ux-02c-02-r2', at: new Date().toISOString(), checks: {}, detail: {}, facts: {} };
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
  mkdirSync(join(ROOT_A, 'docs'), { recursive: true });
  mkdirSync(join(ROOT_A, 'archive'), { recursive: true });
  writeFileSync(A_MD, '# A\n\n原始对象（R2 改名用）\n');
  writeFileSync(NOTES, '# NOTES\n\n原始对象（R2 移动用）\n');
  writeFileSync(join(ROOT_A, 'keep.md'), '# keep\n');
}

async function writeConfig() {
  const { serializeConfig } = await import(`file:///${REPO}/apps/server/src/store/config.ts`);
  const { rootTokenOf } = await import(`file:///${REPO}/packages/storage/path-safety.ts`);
  mkdirSync(join(BASE, 'store'), { recursive: true });
  const config = {
    version: 5,
    commitSeq: 0,
    issuedIds: [PROJECT_A],
    revoked: [],
    projects: [
      {
        projectId: PROJECT_A,
        name: '项目R2',
        rootDir: ROOT_A,
        canonicalRoot: ROOT_A,
        rootToken: rootTokenOf(ROOT_A),
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
const moveDialogOpen = `!!document.querySelector('#move-target-select')`;
const renameInputValue = `document.querySelector('input[aria-label="新名称"]')?.value ?? null`;
const noticeText = `document.querySelector('.statusbar__notice')?.textContent ?? ''`;
const moveErrorText = `document.querySelector('.move__error')?.textContent ?? ''`;

const rowExpr = (name) =>
  `[...document.querySelectorAll('button.tree__row')].find(b=>b.querySelector('.tree__name')?.textContent===${JSON.stringify(name)})`;

const nameRect = (name) => `(() => {
  const row = ${rowExpr(name)};
  const span = row?.querySelector('.tree__name');
  if (!span) return null;
  const r = span.getBoundingClientRect();
  return { x: r.left + Math.min(24, r.width / 2), y: r.top + r.height / 2 };
})()`;

const rowAnchor = (name) => `(() => {
  const row = ${rowExpr(name)};
  if (!row) return null;
  return { anchor: row.getAttribute('data-resource-anchor'), verification: row.getAttribute('data-resource-identity') };
})()`;

const menuItemRect = (label) => `(() => {
  const el = [...document.querySelectorAll('.ctx-menu button, .ctx-menu__item')]
    .find((b) => (b.textContent ?? '').includes(${JSON.stringify(label)}));
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 };
})()`;

const confirmMoveRect = `(() => {
  const el = [...document.querySelectorAll('.modal button')].find((b) => (b.textContent ?? '').includes('确认移动'));
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

const rectOf = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

const refreshRect = `(() => {
  const el = document.querySelector('button[aria-label="刷新当前目录"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

async function realClick(tab, pos, clickCount = 1) {
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y, button: 'none', clickCount: 0 });
  await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount });
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount });
}

async function realRightClick(tab, pos) {
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y, button: 'none', clickCount: 0 });
  await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'right', clickCount: 1 });
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'right', clickCount: 1 });
  await sleep(300);
  /*
   * headless Chrome 不一定会把 CDP 的右键翻译成 `contextmenu`。菜单没出来时补一个
   * **真实语义**的 contextmenu 事件（同一坐标、同一行元素），而不是直接调组件内部
   * 函数——那样就不是"用户操作"了。
   */
  const menuCount = await ev(tab, `document.querySelectorAll('.ctx-menu').length`, false);
  if (!menuCount) {
    await ev(
      tab,
      `(() => {
        const row = document.elementFromPoint(${pos.x}, ${pos.y})?.closest('button.tree__row');
        if (!row) return false;
        row.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, button: 2, buttons: 2,
          clientX: ${pos.x}, clientY: ${pos.y},
        }));
        return true;
      })()`,
      false,
    );
    await sleep(350);
  }
}

const KEYS = {
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
};

async function pressKey(tab, name) {
  const k = KEYS[name];
  for (const type of ['rawKeyDown', 'keyUp']) {
    await tab.send('Input.dispatchKeyEvent', {
      type,
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.windowsVirtualKeyCode,
      nativeVirtualKeyCode: k.windowsVirtualKeyCode,
    });
  }
  await sleep(180);
}

/** React 受控输入：必须走原生 setter。 */
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
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

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
  await waitFor(t.tab, `document.body.innerText.includes('项目R2')`, 25000, 'live workspace');
  await waitFor(t.tab, `document.querySelectorAll('button.tree__row--file').length > 0`, 25000, 'tree rows');
  await sleep(900);
  return t;
}

/* ------------------------------ 目录展开 ------------------------------ */

const hasChildRows = `[...document.querySelectorAll('button.tree__row--file')].some((b) => (b.querySelector('.tree__indent')?.children.length ?? 0) > 0)`;

const folderState = (name) => `(() => {
  const b = [...document.querySelectorAll('button.tree__row--folder')]
    .find((x) => x.querySelector('.tree__name')?.textContent === ${JSON.stringify(name)});
  if (!b) return 'no-folder';
  return b.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed';
})()`;

const clickFolder = (name, wantExpanded) => `(() => {
  const b = [...document.querySelectorAll('button.tree__row--folder')]
    .find((x) => x.querySelector('.tree__name')?.textContent === ${JSON.stringify(name)}
      && x.getAttribute('aria-expanded') === ${wantExpanded ? "'true'" : "'false'"});
  if (!b) return false;
  b.click();
  return true;
})()`;

/**
 * 确保目录**真的展开且有子行**。
 *
 * 结构变更后层表会被整层作废，但节点的展开状态还留着：此时 `aria-expanded="true"`
 * 却没有子行。只按 aria 属性判断，会得到"目录已展开但其实一行都没有"的假象。
 */
async function ensureExpanded(tab, name) {
  const state = await ev(tab, folderState(name), false);
  if (state === 'no-folder') return state;
  if (state === 'expanded' && (await ev(tab, hasChildRows, false))) return 'expanded';
  if (state === 'expanded') {
    await ev(tab, clickFolder(name, false), false);
    await sleep(600);
  }
  await ev(tab, clickFolder(name, true), false);
  await sleep(1500);
  return (await ev(tab, hasChildRows, false)) ? 'expanded' : 'still-empty';
}

/* ------------------------------ 网络观察 ------------------------------ */

function watchNetwork(tab) {
  const sent = [];
  const responses = [];
  const offSent = tab.on('Network.requestWillBeSent', (params) => {
    sent.push({ method: params.request.method, url: params.request.url, postData: params.request.postData ?? null });
  });
  const offResponse = tab.on('Network.responseReceived', (params) => {
    if (!params.response.url.includes('/api/files/')) return;
    responses.push({ requestId: params.requestId, url: params.response.url, status: params.response.status, body: undefined });
  });
  const offFinished = tab.on('Network.loadingFinished', (params) => {
    const hit = responses.find((item) => item.requestId === params.requestId && item.body === undefined);
    if (!hit) return;
    tab
      .send('Network.getResponseBody', { requestId: params.requestId })
      .then((result) => {
        hit.body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
      })
      .catch(() => {
        hit.body = null;
      });
  });
  return {
    posts: (needle) => sent.filter((item) => item.method === 'POST' && item.url.includes(needle)),
    answers: (needle) => responses.filter((item) => item.url.includes(needle)),
    stop: () => {
      offSent();
      offResponse();
      offFinished();
    },
  };
}

async function treePage() {
  const tokenBody = await (await fetch(`${HOST}/api/session-token`)).json();
  const response = await fetch(`${HOST}/api/tree?projectId=${encodeURIComponent(PROJECT_A)}`, {
    headers: { 'x-ws-token': tokenBody.token },
  });
  return response.json();
}

/**
 * 取某个路径的真实锚。
 *
 * `/api/tree` 是**按层**返回的：根层响应只带根层条目的 `anchors`，所以
 * `docs/notes.md` 必须查 `dir=docs` 那一页。早期版本只查根层，拿到 null
 * 被误当成"没有锚"。
 */
async function hostAnchorOf(path) {
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash) : '';
  const tokenBody = await (await fetch(`${HOST}/api/session-token`)).json();
  const url = `${HOST}/api/tree?projectId=${encodeURIComponent(PROJECT_A)}${dir ? `&dir=${encodeURIComponent(dir)}` : ''}`;
  const page = await (await fetch(url, { headers: { 'x-ws-token': tokenBody.token } })).json();
  return page.anchors?.[path] ?? null;
}

/** 磁盘事实：内容 SHA-256 + 字节数 + inode。 */
function diskFacts(path) {
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, ino: lstatSync(path).ino };
}

const waitResponses = async (net, needle, expected, timeoutMs = 6000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hits = net.answers(needle).filter((item) => item.body !== undefined);
    if (hits.length >= expected) return hits;
    await sleep(80);
  }
  return net.answers(needle);
};

/**
 * 等**请求真的发出去**（不是等响应）。
 *
 * `waitResponses` 超时会返回"已有的响应"，若第二次请求根本没发，读到的就是第一次的
 * 响应——那会把"没发请求"误判成"发了但被拒"。所以第二次及以后必须先把条数等够。
 */
const waitPosts = async (net, needle, expected, timeoutMs = 8000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (net.posts(needle).length >= expected) return true;
    await sleep(80);
  }
  return false;
};

/* ------------------------------ 主流程 ------------------------------ */

let exitCode = 0;

try {
  section('环境');
  resetFixture();
  const config = await writeConfig();
  const initial = diskFacts(A_MD);
  fact('initialAMd', initial);
  check('R2-01 fixture 就绪（1 个真实项目 / 原始 a.md 已落盘）', config.projects.length === 1 && initial !== null, {
    root: ROOT_A,
    size: initial?.size,
  });

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

  mkdirSync(CHROME_PROFILE, { recursive: true });
  spawnLogged(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${CHROME_PROFILE}`,
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
  const net = watchNetwork(t.tab);

  /* ======================= A：改名 ======================= */
  section('A 改名：意图冻结 → 外部替换 → 不刷新 → 提交 → Host 拒绝');

  const hostAnchorBefore = await hostAnchorOf('a.md');
  const rowBefore = await ev(t.tab, rowAnchor('a.md'), false);
  fact('anchorBeforeReplace', { host: hostAnchorBefore, row: rowBefore });
  check('A-01 Host 给出 a.md 的真实锚', typeof hostAnchorBefore === 'string' && hostAnchorBefore.length === 32, hostAnchorBefore);
  check('A-02 行上已消费同一个锚（组件真的拿到了身份）', rowBefore?.anchor === hostAnchorBefore, rowBefore);

  const renamePostsBefore = net.posts('/api/files/rename').length;
  const movePostsBefore = net.posts('/api/files/move').length;

  const aPos = await ev(t.tab, nameRect('a.md'), false);
  check('A-03 找到 a.md 的名称文字', aPos !== null, aPos);
  await realRightClick(t.tab, aPos);
  const renameItem = await ev(t.tab, menuItemRect('重命名'), false);
  check('A-04 右键菜单出现「重命名」', renameItem !== null, renameItem);
  await realClick(t.tab, renameItem);
  await sleep(350);
  const opened = await ev(t.tab, renameInputOpen, false);
  const prefilled = await ev(t.tab, renameInputValue, false);
  check('A-05 行内改名框已打开并预填原名', opened === true && prefilled === 'a.md', { opened, prefilled });

  // 外部替换：同一个路径，另一个对象。界面此刻**不刷新**。
  const REPLACED = '# A\n\n外部替换后的对象（不是同一 inode）\n';
  rmSync(A_MD, { force: true });
  writeFileSync(A_MD, REPLACED);
  const replacedFacts = diskFacts(A_MD);
  fact('afterReplace', replacedFacts);
  const hostAnchorAfter = await hostAnchorOf('a.md');
  const rowAfterReplace = await ev(t.tab, rowAnchor('a.md'), false);
  fact('anchorAfterReplace', { host: hostAnchorAfter, row: rowAfterReplace });
  check('A-06 替换后 Host 的锚真的变了（换了对象）', hostAnchorAfter !== hostAnchorBefore, {
    before: hostAnchorBefore,
    after: hostAnchorAfter,
  });
  check('A-07 界面不刷新：行上仍是旧锚（前提成立，不是刷过之后才点）', rowAfterReplace?.anchor === hostAnchorBefore, rowAfterReplace);
  check('A-08 替换前后 inode 不同（不是原地覆盖写）', replacedFacts !== null && replacedFacts.ino !== initial.ino, {
    before: initial.ino,
    after: replacedFacts?.ino,
  });

  // 提交
  await ev(t.tab, setInputValue('input[aria-label="新名称"]', 'renamed.md'), false);
  await pressKey(t.tab, 'Enter');
  const renameAnswers = await waitResponses(net, '/api/files/rename', 1);
  const renamePost = net.posts('/api/files/rename')[renamePostsBefore] ?? null;
  const renameBody = renamePost ? JSON.parse(renamePost.postData ?? '{}') : {};
  fact('renameRequest', { sourceAnchor: renameBody.sourceAnchor, name: renameBody.name, sourcePath: renameBody.sourcePath });
  check('A-09 请求体带着旧锚（冻结的意图，不随外部变化）', renameBody.sourceAnchor === hostAnchorBefore, renameBody.sourceAnchor);
  check('A-10 请求里没有客户端自述路径/令牌/身份', !('absolutePath' in renameBody) && !('rootToken' in renameBody) && !('identity' in renameBody), Object.keys(renameBody));

  const renameAnswer = renameAnswers[0] ?? null;
  let renameParsed = {};
  try {
    renameParsed = JSON.parse(renameAnswer?.body ?? '{}');
  } catch {
    renameParsed = {};
  }
  fact('renameResponse', { status: renameAnswer?.status, body: renameParsed });
  check('A-11 Host 明确拒绝：409', renameAnswer?.status === 409, renameAnswer?.status);
  check('A-12 拒绝码是 ERR_ENTRY_SOURCE_CHANGED（不是靠界面文案反推）', renameParsed.errorCode === 'ERR_ENTRY_SOURCE_CHANGED', renameParsed.errorCode);

  const afterFacts = diskFacts(A_MD);
  check('A-13 新 a.md 仍在原路径，且字节与替换后逐项一致', afterFacts !== null && afterFacts.sha256 === replacedFacts.sha256 && afterFacts.size === replacedFacts.size, {
    after: afterFacts,
    expected: replacedFacts,
  });
  check('A-14 目标路径 renamed.md 没有被创建（零错误移动）', existsSync(join(ROOT_A, 'renamed.md')) === false);
  check('A-15 旧的 a.md 没有被搬走（源保持原位）', existsSync(A_MD) === true);

  await sleep(1200);
  check('A-16 只发了一次改名请求（绝不自动重试）', net.posts('/api/files/rename').length === renamePostsBefore + 1, {
    before: renamePostsBefore,
    after: net.posts('/api/files/rename').length,
  });
  check('A-17 全程零 move 请求（拒绝后没有换条路再试）', net.posts('/api/files/move').length === movePostsBefore, net.posts('/api/files/move').length);

  const stillOpen = await ev(t.tab, renameInputOpen, false);
  const notice = await ev(t.tab, noticeText, false);
  fact('afterReject', { stillOpen, notice });
  check('A-18 被拒绝后输入行保留（不是静默收起）', stillOpen === true, stillOpen);
  // 文案必须如实说明「对象被替换、命令未执行」，不能像旧行为那样谎报成功或含糊其辞。
  check('A-19 状态栏如实说明「对象已变化、未执行」', /替换|变化|未执行/.test(notice), notice);
  await shot(t.tab, '01-rename-rejected.png');

  // 刷新 → 行锚变成新锚 → 对当前对象再次改名
  /*
   * 先记一条**既有**行为（本轮未改、也不在本轮修复范围内）：提交期间输入框是
   * `disabled`，焦点会掉到 body；结果回来后组件也不会重新聚焦。此时按 Escape / Enter
   * 都不会触发——`InlineNamingRow` 的 focus 只在挂载时做一次。
   * 所以这里走用户界面上真实存在的「×」取消按钮，取消会卸载输入行，
   * 再打开时是**新的挂载**，焦点与 Enter 都恢复。
   */
  const escapeProbe = await (async () => {
    await pressKey(t.tab, 'Escape');
    return await ev(t.tab, renameInputOpen, false);
  })();
  fact('escapeWhileFocusLost', { stillOpen: escapeProbe, why: '提交中 disabled 夺走焦点，Escape 无人接收（既有行为）' });
  const cancelRect = await ev(t.tab, rectOf('button.tree__create-cancel'), false);
  check('A-19a 找得到输入行的「×」取消按钮', cancelRect !== null, cancelRect);
  await realClick(t.tab, cancelRect);
  await sleep(400);
  const closedByCancel = await ev(t.tab, renameInputOpen, false);
  check('A-19b 取消后输入行真的收起（不带着旧意图继续）', closedByCancel === false, closedByCancel);
  const refresh = await ev(t.tab, refreshRect, false);
  check('A-20 找到"刷新当前目录"入口', refresh !== null, refresh);
  await realClick(t.tab, refresh);
  await sleep(1200);
  const rowAfterRefresh = await ev(t.tab, rowAnchor('a.md'), false);
  fact('anchorAfterRefresh', { host: hostAnchorAfter, row: rowAfterRefresh });
  check('A-21 刷新后行锚变成新对象真正的锚', rowAfterRefresh?.anchor === hostAnchorAfter, {
    row: rowAfterRefresh?.anchor,
    host: hostAnchorAfter,
  });

  const aPos2 = await ev(t.tab, nameRect('a.md'), false);
  await realRightClick(t.tab, aPos2);
  const renameItem2 = await ev(t.tab, menuItemRect('重命名'), false);
  await realClick(t.tab, renameItem2);
  await sleep(350);
  const reopened = await ev(t.tab, renameInputOpen, false);
  check('A-22a 取消后重新打开改名框（不是拿第一次的残留状态再提交）', reopened === true, reopened);
  const secondDraft = await ev(t.tab, setInputValue('input[aria-label="新名称"]', 'renamed.md'), false);
  const draftValue = await ev(t.tab, renameInputValue, false);
  check('A-22d 输入框确实可写且已填入新名字', secondDraft === true && draftValue === 'renamed.md', { secondDraft, draftValue });
  await pressKey(t.tab, 'Enter');
  const sent2 = await waitPosts(net, '/api/files/rename', renamePostsBefore + 2, 3000);
  fact('secondAttemptTrace', {
    posts: net.posts('/api/files/rename').length,
    expected: renamePostsBefore + 2,
    notice: await ev(t.tab, noticeText, false),
  });
  check('A-22b 第二次提交确实发出了请求（不靠旧响应冒充结果）', sent2 === true, net.posts('/api/files/rename').length);
  await waitResponses(net, '/api/files/rename', renamePostsBefore + 2);
  const renamePost2 = net.posts('/api/files/rename')[renamePostsBefore + 1] ?? null;
  const renameBody2 = renamePost2 ? JSON.parse(renamePost2.postData ?? '{}') : {};
  fact('renameRequest2', { sourceAnchor: renameBody2.sourceAnchor, name: renameBody2.name });
  check('A-22c 第二次请求带的是刷新后的新锚', renameBody2.sourceAnchor === hostAnchorAfter, {
    sent: renameBody2.sourceAnchor,
    expected: hostAnchorAfter,
  });
  const renameAnswers2 = net.answers('/api/files/rename');
  const renameAnswer2 = renameAnswers2[renameAnswers2.length - 1] ?? null;
  let renameParsed2 = {};
  try {
    renameParsed2 = JSON.parse(renameAnswer2?.body ?? '{}');
  } catch {
    renameParsed2 = {};
  }
  fact('renameResponse2', { status: renameAnswer2?.status, body: renameParsed2 });
  check('A-22 对当前对象再次改名成功（200 APPLIED）', renameAnswer2?.status === 200 && renameParsed2.status === 'APPLIED', renameParsed2);

  const movedFacts = diskFacts(join(ROOT_A, 'renamed.md'));
  check('A-23 磁盘真的搬了：a.md 消失、renamed.md 内容与替换后一致', !existsSync(A_MD) && movedFacts !== null && movedFacts.sha256 === replacedFacts.sha256, {
    exists: existsSync(join(ROOT_A, 'renamed.md')),
    after: movedFacts,
    expected: replacedFacts.sha256,
  });
  await shot(t.tab, '02-rename-after-refresh-applied.png');

  /* ======================= B：移动（等价） ======================= */
  section('B 移动：意图冻结 → 外部替换 → 不刷新 → 确认移动 → Host 拒绝');

  // 先让 docs 层加载出来，移动源才在层表里
  const docsState = await ensureExpanded(t.tab, 'docs');
  const notesRect = await ev(t.tab, nameRect('notes.md'), false);
  check('B-01 docs 层真正展开了（有子行），notes.md 可见', docsState === 'expanded' && notesRect !== null, {
    docsState,
    notesRect,
  });

  const hostNotesBefore = await hostAnchorOf('docs/notes.md');
  const notesFactsBefore = diskFacts(NOTES);
  const notesRowBefore = await ev(t.tab, rowAnchor('notes.md'), false);
  fact('moveAnchorBefore', { host: hostNotesBefore, row: notesRowBefore });
  check('B-02 notes.md 有真实锚且行上已消费', typeof hostNotesBefore === 'string' && notesRowBefore?.anchor === hostNotesBefore, {
    host: hostNotesBefore,
    row: notesRowBefore?.anchor,
  });

  const movePostsBeforeB = net.posts('/api/files/move').length;
  const renamePostsBeforeB = net.posts('/api/files/rename').length;

  await realRightClick(t.tab, notesRect);
  const moveItem = await ev(t.tab, menuItemRect('移动到'), false);
  check('B-03 右键菜单出现「移动到…」', moveItem !== null, moveItem);
  await realClick(t.tab, moveItem);
  await sleep(400);
  const dialogOpen = await ev(t.tab, moveDialogOpen, false);
  check('B-04 移动对话框打开', dialogOpen === true, dialogOpen);
  const options = await ev(t.tab, `[...document.querySelectorAll('#move-target-select option')].map(o=>o.value)`, false);
  fact('moveOptions', options);
  check('B-05 目标候选里有 archive（来自已加载层表，不递归扫描）', Array.isArray(options) && options.includes('archive'), options);

  // 外部替换源对象；对话框保持打开、界面不刷新
  const NOTES_REPLACED = '# NOTES\n\n外部替换后的对象（移动场景）\n';
  rmSync(NOTES, { force: true });
  writeFileSync(NOTES, NOTES_REPLACED);
  const notesReplacedFacts = diskFacts(NOTES);
  const hostNotesAfter = await hostAnchorOf('docs/notes.md');
  fact('moveAnchorAfterReplace', { host: hostNotesAfter, before: hostNotesBefore, replaced: notesReplacedFacts });
  check('B-06 替换后 Host 的锚变了', hostNotesAfter !== hostNotesBefore, { before: hostNotesBefore, after: hostNotesAfter });

  await ev(t.tab, setSelectValue('#move-target-select', 'archive'), false);
  await sleep(200);
  const confirm = await ev(t.tab, confirmMoveRect, false);
  check('B-07 找到"确认移动"按钮', confirm !== null, confirm);
  await realClick(t.tab, confirm);
  const moveAnswers = await waitResponses(net, '/api/files/move', 1);
  const movePost = net.posts('/api/files/move')[movePostsBeforeB] ?? null;
  const moveBody = movePost ? JSON.parse(movePost.postData ?? '{}') : {};
  fact('moveRequest', { sourceAnchor: moveBody.sourceAnchor, targetParentDir: moveBody.targetParentDir });
  check('B-08 移动请求也带着旧锚', moveBody.sourceAnchor === hostNotesBefore, moveBody.sourceAnchor);

  const moveAnswer = moveAnswers[0] ?? null;
  let moveParsed = {};
  try {
    moveParsed = JSON.parse(moveAnswer?.body ?? '{}');
  } catch {
    moveParsed = {};
  }
  fact('moveResponse', { status: moveAnswer?.status, body: moveParsed });
  check('B-09 Host 明确拒绝移动：409 ERR_ENTRY_SOURCE_CHANGED', moveAnswer?.status === 409 && moveParsed.errorCode === 'ERR_ENTRY_SOURCE_CHANGED', moveParsed);

  const notesAfterFacts = diskFacts(NOTES);
  check('B-10 源仍在原路径且字节一致（零覆盖）', notesAfterFacts !== null && notesAfterFacts.sha256 === notesReplacedFacts.sha256, {
    after: notesAfterFacts,
    expected: notesReplacedFacts.sha256,
  });
  check('B-11 目标 archive/notes.md 没有被创建（零错误移动）', existsSync(join(ROOT_A, 'archive/notes.md')) === false);

  await sleep(1200);
  check('B-12 只发了一次移动请求（绝不自动重试）', net.posts('/api/files/move').length === movePostsBeforeB + 1, {
    before: movePostsBeforeB,
    after: net.posts('/api/files/move').length,
  });
  check('B-13 全程零改名请求（拒绝后没有换条路再试）', net.posts('/api/files/rename').length === renamePostsBeforeB, net.posts('/api/files/rename').length);

  const dialogStillOpen = await ev(t.tab, moveDialogOpen, false);
  const moveErr = await ev(t.tab, moveErrorText, false);
  fact('moveAfterReject', { dialogStillOpen, moveErr });
  check('B-14 对话框保留并显示原因（不静默关闭）', dialogStillOpen === true && moveErr.length > 0, { dialogStillOpen, moveErr });
  await shot(t.tab, '03-move-rejected.png');

  // 取消 → 刷新 → 对当前对象重新移动
  /*
   * 同上：对话框的 Escape 处理挂在 dialog 的 onKeyDown 上，需要焦点在对话框内；
   * 点「确认移动」后该按钮变为 disabled，焦点落回 body，Escape 不再生效（既有行为）。
   * 走界面上真实存在的「取消（Esc）」按钮。
   */
  const escapeProbeMove = await (async () => {
    await pressKey(t.tab, 'Escape');
    return await ev(t.tab, moveDialogOpen, false);
  })();
  fact('escapeWhileFocusLostMove', {
    stillOpen: escapeProbeMove,
    why: 'Escape 处理挂在 dialog 的 onKeyDown 上，需要焦点在对话框内；提交时按钮 disabled 使焦点回到 body（既有行为）',
  });
  const cancelMoveBtn = await ev(t.tab, rectOf('.modal__actions button.button--ghost'), false);
  check('B-14d 找得到对话框的「取消」按钮', cancelMoveBtn !== null, cancelMoveBtn);
  await realClick(t.tab, cancelMoveBtn);
  await sleep(450);
  const dialogClosed = await ev(t.tab, moveDialogOpen, false);
  check('B-14e 取消后对话框真的关闭', dialogClosed === false, dialogClosed);
  const refresh2 = await ev(t.tab, refreshRect, false);
  await realClick(t.tab, refresh2);
  await sleep(1200);
  // 结构变更被拒后层表仍可能整层作废：按"有没有子行"重新确保展开。
  const docsState2 = await ensureExpanded(t.tab, 'docs');
  const notesRect2 = await ev(t.tab, nameRect('notes.md'), false);
  const notesRowAfter = await ev(t.tab, rowAnchor('notes.md'), false);
  const hostNotesNow = await hostAnchorOf('docs/notes.md');
  fact('notesRowAfterRefresh', { row: notesRowAfter, host: hostNotesNow, hostAtReplace: hostNotesAfter });
  check('B-14a 取消后 docs 层重新加载出子行', docsState2 === 'expanded' && notesRect2 !== null, { docsState2, notesRect2 });
  check('B-14b 刷新后 notes.md 行上的锚就是新对象的锚', notesRowAfter?.anchor === hostNotesNow, {
    row: notesRowAfter?.anchor,
    host: hostNotesNow,
  });
  await realRightClick(t.tab, notesRect2);
  const moveItem2 = await ev(t.tab, menuItemRect('移动到'), false);
  await realClick(t.tab, moveItem2);
  await sleep(400);
  await ev(t.tab, setSelectValue('#move-target-select', 'archive'), false);
  await sleep(200);
  const confirm2 = await ev(t.tab, confirmMoveRect, false);
  await realClick(t.tab, confirm2);
  const moveSent2 = await waitPosts(net, '/api/files/move', movePostsBeforeB + 2);
  check('B-15a 第二次移动确实发出了请求', moveSent2 === true, net.posts('/api/files/move').length);
  await waitResponses(net, '/api/files/move', movePostsBeforeB + 2);
  const movePost2 = net.posts('/api/files/move')[movePostsBeforeB + 1] ?? null;
  const moveBody2 = movePost2 ? JSON.parse(movePost2.postData ?? '{}') : {};
  fact('moveRequest2', { sourceAnchor: moveBody2.sourceAnchor, expected: hostNotesAfter });
  check('B-15b 第二次移动带的是刷新后的新锚', moveBody2.sourceAnchor === hostNotesAfter, {
    sent: moveBody2.sourceAnchor,
    expected: hostNotesAfter,
  });
  const moveAnswers2 = net.answers('/api/files/move');
  const moveAnswer2 = moveAnswers2[moveAnswers2.length - 1] ?? null;
  let moveParsed2 = {};
  try {
    moveParsed2 = JSON.parse(moveAnswer2?.body ?? '{}');
  } catch {
    moveParsed2 = {};
  }
  fact('moveResponse2', { status: moveAnswer2?.status, body: moveParsed2 });
  check('B-15 对当前对象重新移动成功（200 APPLIED）', moveAnswer2?.status === 200 && moveParsed2.status === 'APPLIED', moveParsed2);

  const archivedFacts = diskFacts(join(ROOT_A, 'archive/notes.md'));
  check('B-16 磁盘真的搬了：notes.md 消失、archive/notes.md 内容一致', !existsSync(NOTES) && archivedFacts !== null && archivedFacts.sha256 === notesReplacedFacts.sha256, {
    exists: existsSync(join(ROOT_A, 'archive/notes.md')),
    after: archivedFacts,
  });
  await shot(t.tab, '04-move-after-refresh-applied.png');

  net.stop();
  const failed = Object.entries(report.checks).filter(([, ok]) => !ok).map(([name]) => name);
  report.summary = { total: Object.keys(report.checks).length, passed: Object.keys(report.checks).length - failed.length, failed };
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
