/**
 * UX-02C-05-R1.2 真实浏览器复验。
 *
 * 与 R1.1 的差别（复审 E01/E02 指出的三处证据不足，这里逐条补上）：
 *
 * 1. **V-15**：替换前后都保存内容 SHA-256 + size + inode，点击后逐项比较；
 *    原来只比 inode 与 size，而"原地覆盖写"能让大小恰好相同。
 * 2. **V-06/V-07**：分成两件事分别取证——
 *    - "Host 已返回新锚"（直接问 `/api/tree`）；
 *    - "Shell 已把新锚消费进这一行"（读行上的 `data-resource-anchor`）。
 *    只有后者才能证明刷新响应真的进了组件，而不是只到了网络层。
 * 3. **Y-03**：先确认活动项目是 B，再点 A；最终严格要求为 A，不接受 null。
 * 4. **Z**：新增真实的**异步项目改名**场景——请求发出后被 CDP 按住，
 *    期间切换活动项目，再放行，观察"旧响应只能 notice、列表仍然回填、只发一次请求"。
 *
 * 只碰 `D:/Workspace/projects/weavespace-test/c05-r12`，不碰用户真实文件。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:/Workspace/projects/weavespace';
const BASE = 'D:/Workspace/projects/weavespace-test/c05-r12';
const ROOT_A = join(BASE, 'projA');
const ROOT_B = join(BASE, 'projB');
const STORE = join(BASE, 'store/workspace.json');
const NOTE = join(ROOT_A, 'note.md');
const PROJECT_A = 'proj-a';
const PROJECT_B = 'proj-b';

const HOST_PORT = 5431;
const APP_PORT = 5432;
const CDP_PORT = 9371;
const HOST = `http://127.0.0.1:${HOST_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}/`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

process.env.CDP_PORT = String(CDP_PORT);
const { ev, newTab, sleep, waitFor } = await import('../ux-02c-05-r1-followup/cdp.mjs');

/* ------------------------------ 报告 ------------------------------ */

const report = {
  run: 'ux-02c-05-r1.2',
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
  writeFileSync(NOTE, '# note\n\nR1.2 同路径替换用的文件（原始对象）\n');
  writeFileSync(join(ROOT_A, 'dir/inner.md'), '# inner\n');
  writeFileSync(join(ROOT_B, 'docs/other.md'), '# other\n');

  const { serializeConfig } = await import(`file:///${REPO}/apps/server/src/store/config.ts`);
  const { rootTokenOf } = await import(`file:///${REPO}/packages/storage/path-safety.ts`);

  mkdirSync(join(BASE, 'store'), { recursive: true });
  const config = {
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

/** 这一行**当前被消费**的身份（R1.2 新增的数据属性）。 */
const rowIdentity = (name) => `(() => {
  const row = ${rowExpr(name)};
  if (!row) return null;
  return {
    identity: row.getAttribute('data-resource-identity'),
    anchor: row.getAttribute('data-resource-anchor'),
  };
})()`;

/** 当前活动项目行（项目行专用类名，避免与文件行的 selected 混淆）。 */
const activeProject = `(() => {
  const el = document.querySelector('button.tree__row--selected.tree__row--with-rename .tree__name');
  return el ? el.textContent : null;
})()`;

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

const KEYS = {
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
  await sleep(150);
}

/** React 受控输入：必须走原生 setter，否则 onChange 不会触发。 */
const setInputValue = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
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

/** 直接问 Host 要一页树：用来核对"Host 到底返回了哪个锚"。 */
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

/** 磁盘事实：内容摘要 + 字节数 + inode（E01 要求"真的比内容"）。 */
function diskFacts(path) {
  const bytes = readFileSync(path);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    ino: lstatSync(path).ino,
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
  const rowBefore = await ev(t.tab, rowIdentity('note.md'), false);
  fact('rowIdentityBefore', rowBefore);
  check('V-01 Host 声明了身份能力（identitySupport=supported）', before.support === 'supported', before);
  check('V-02 替换前 note.md 有锚（已核验身份）', typeof before.anchor === 'string' && before.anchor.length > 0, before.anchor);
  check('V-02b 行上已消费同一个锚（组件真的拿到了身份）', rowBefore?.anchor === before.anchor, {
    row: rowBefore?.anchor,
    host: before.anchor,
  });

  const notePos = await ev(t.tab, nameRect('note.md'), false);
  check('V-03 找到 note.md 的名称文字', notePos !== null, notePos);
  check('V-04 开始前 note.md 未被打开', (await ev(t.tab, rowOpened('note.md'), false)) === false);

  const diskBefore = diskFacts(NOTE);
  fact('diskBefore', diskBefore);
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
  writeFileSync(NOTE, '# note\n\n这是删除后重建的另一个对象，内容与原来不同（R1.2）\n', 'utf8');
  const diskReplaced = diskFacts(NOTE);
  fact('diskReplaced', diskReplaced);

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
  /*
   * 注意：这里**不能**再往窗口里塞一次 Host 往返（两跳 HTTP 会把真实间隔顶过 500ms，
   * 那样第二下就不再是"连击"了，场景本身失效）。所以：
   * - 页面内的读（行的身份属性）先做，它只花几毫秒；
   * - "Host 返回的锚"放到第二下之后再问，那时它仍然能证明刷新拿到了新锚。
   */
  const rowAfter = await ev(t.tab, rowIdentity('note.md'), false);
  fact('rowIdentityAfter', rowAfter);

  // 浏览器仍按连击计数：第二下带 detail=2 进来（这是"残响"，不是新手势的起点）
  const notePos2 = await ev(t.tab, nameRect('note.md'), false);
  await realClick(t.tab, notePos2.x, notePos2.y, 2);
  await sleep(80);
  const secondClickAt = Date.now();
  await sleep(700);

  const seq = await readClicks(t.tab);
  fact('clickSequenceReplace', seq);

  const after = await anchorOf(PROJECT_A, 'note.md');
  fact('identityAfter', after);
  const refreshHappened = net.trees().length > treeCountBefore;
  const anchorChanged = typeof before.anchor === 'string' && after.anchor !== before.anchor;
  check('V-06 Host 已返回新锚（刷新真的走了真实目录）', refreshHappened && anchorChanged, {
    treesBefore: treeCountBefore,
    treesAfter: net.trees().length,
    before: before.anchor,
    after: after.anchor,
  });
  /*
   * 这一条是 E01 的核心补强：网络层拿到新锚 ≠ 组件消费了新锚。
   * 只有行上的 identity 已经换成新锚，才说明刷新响应真的进了这一行
   * （否则"仲裁器重建"根本无从发生，后面的结论也就没有意义）。
   */
  check('V-07 Shell 已把新锚消费进这一行（行的身份 == Host 的新锚，且 != 旧锚）', rowAfter?.anchor === after.anchor && rowAfter?.anchor !== before.anchor, {
    row: rowAfter?.anchor,
    host: after.anchor,
    old: before.anchor,
  });
  check('V-08 重建确实换了对象（inode 与内容摘要都变了）', diskBefore.ino !== diskReplaced.ino && diskBefore.sha256 !== diskReplaced.sha256, {
    inodeBefore: diskBefore.ino,
    inodeAfter: diskReplaced.ino,
    shaBefore: diskBefore.sha256.slice(0, 12),
    shaAfter: diskReplaced.sha256.slice(0, 12),
  });
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
  /*
   * E01：必须真的比内容。原地覆盖写可以保持 size 不变、inode 也不变
   * （取决于写入方式），所以只比 inode/size 是不足以证明"没被改过"的。
   */
  const diskAfter = diskFacts(NOTE);
  fact('diskAfter', diskAfter);
  check('V-15 残响没有改动磁盘文件（SHA-256 / size / inode 三项逐项一致）',
    diskAfter.sha256 === diskReplaced.sha256 && diskAfter.size === diskReplaced.size && diskAfter.ino === diskReplaced.ino,
    diskAfter,
  );
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

  const activeAtStart = await ev(t.tab, activeProject, false);
  fact('activeAtStart', activeAtStart);

  // 先把活动项目切到 B（下面 Y-03 要有"真的从 B 切到 A"的起点）
  const rootBPos0 = await ev(t.tab, nameRect('项目B'), false);
  check('Y-00 找到项目B的根行名称', rootBPos0 !== null, rootBPos0);
  if (activeAtStart !== '项目B') {
    await realClick(t.tab, rootBPos0.x, rootBPos0.y, 1);
    await sleep(900);
  }
  const activeBeforeY3 = await ev(t.tab, activeProject, false);
  fact('activeBeforeY3', activeBeforeY3);
  check('Y-00b 点击前活动项目确实是 B', activeBeforeY3 === '项目B', activeBeforeY3);

  const rootBPos = await ev(t.tab, nameRect('项目B'), false);
  await slowDoubleClick(t.tab, rootBPos.x, rootBPos.y, 300);
  await sleep(600);
  check('Y-02 项目根双击进入显示名编辑', (await ev(t.tab, projectRenameOpen, false)) === true);
  await shot(t.tab, '04-project-root-rename.png');
  await pressKey(t.tab, 'Escape');
  await sleep(400);

  const switchBefore = net.all.length;
  const rootAPos = await ev(t.tab, nameRect('项目A'), false);
  await realClick(t.tab, rootAPos.x, rootAPos.y, 1);
  await sleep(900);
  const activeIsA = await ev(t.tab, activeProject, false);
  fact('activeProjectRow', activeIsA);
  /*
   * E02：原来是 `=== '项目A' || === null`，null 被当成通过。
   * 现在严格要求真的切到了 A，并且记录这次切换确实打了请求/改了状态。
   */
  check('Y-03 项目根单击把活动项目从 B 切到 A（不接受 null）', activeIsA === '项目A', {
    expected: '项目A',
    actual: activeIsA,
    requestsBefore: switchBefore,
    requestsAfter: net.all.length,
  });
  await shot(t.tab, '05-root-single-click.png');

  /* ================= Z：真实异步项目改名 ================= */
  section('Z 项目改名请求在途 → 切换活动项目 → 放行旧响应');

  /*
   * 用 CDP 的 Fetch 域把 POST /api/projects/rename **按住**：
   * 这不是"人为 sleep"，而是让真实请求停在网络上，直到我们明确放行。
   * 这样"响应在途时用户切了活动项目"就是真实时序，而不是脚本凑出来的顺序。
   */
  const paused = [];
  const order = [];
  let pausedRequests = 0;
  await t.tab.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/projects/rename*', requestStage: 'Request' }],
  });
  const offPaused = t.tab.on('Fetch.requestPaused', (params) => {
    pausedRequests += 1;
    order.push('paused');
    paused.push(params.requestId);
  });

  /*
   * 这一段要"改名**当前**项目、然后在途切到**另一个**项目"：
   * 先确认活动项目是被改名的那个，否则"切活动项目"只会是一次 no-op，
   * 会话根本不会因为归属变化而收起（上一版脚本就踩了这个坑，Z-05 假通过）。
   */
  const activeBeforeZ = await ev(t.tab, activeProject, false);
  fact('activeBeforeZ', activeBeforeZ);
  check('Z-00 改名开始时活动项目是 A', activeBeforeZ === '项目A', activeBeforeZ);

  const postsRenameProjectBefore = net.posts('/api/projects/rename').length;
  const pencil = `document.querySelector('button[aria-label="修改「项目A」的显示名称"]')`;
  const pencilPos = await ev(t.tab, rectCenter(pencil), false);
  check('Z-01 找到项目A的改名入口', pencilPos !== null, pencilPos);
  await realClick(t.tab, pencilPos.x, pencilPos.y, 1);
  await sleep(400);
  check('Z-02 改名输入行已打开', (await ev(t.tab, projectRenameOpen, false)) === true);
  const typed = await ev(t.tab, setInputValue('input[aria-label="项目显示名称"]', '项目A-新名'), false);
  check('Z-03 输入了新名称', typed === true);
  await pressKey(t.tab, 'Enter');

  // 等请求真的被按住（而不是"等一会儿大概发了"）
  const waitPaused = async (timeoutMs) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (paused.length > 0) return true;
      await sleep(50);
    }
    return false;
  };
  const didPause = await waitPaused(5000);
  check('Z-04 请求已发出并被按住（真实在途，不是伪造顺序）', didPause, { pausedRequests });

  if (didPause) {
    fact('renameInFlight', {
      requestPaused: true,
      draft: '项目A-新名',
      activeProjectBeforeSwitch: await ev(t.tab, activeProject, false),
    });
    // 在途期间切换活动项目（同工作区）：会话按票据失效，但 Host 结果仍然有效
    const rootBPos2 = await ev(t.tab, nameRect('项目B'), false);
    await realClick(t.tab, rootBPos2.x, rootBPos2.y, 1);
    await sleep(600);
    order.push('switched');
    const activeDuring = await ev(t.tab, activeProject, false);
    fact('activeDuringRename', activeDuring);
    check('Z-05 在途期间活动项目已从 A 切成 B', activeDuring === '项目B', activeDuring);
    check('Z-06 会话已按归属收起（不再显示输入行）', (await ev(t.tab, projectRenameOpen, false)) === false);

    // 放行旧响应
    await t.tab.send('Fetch.continueRequest', { requestId: paused[0] });
    order.push('released');
    await sleep(1200);

    const projectNames = await ev(
      t.tab,
      `[...document.querySelectorAll('button.tree__row--with-rename .tree__name')].map((el) => el.textContent)`,
      false,
    );
    const notice = await ev(t.tab, `document.querySelector('.statusbar__notice')?.textContent ?? ''`, false);
    fact('renameAfterRelease', { projectNames, notice, order });

    check('Z-07 Host 的新名称已回填到项目列表（界面的活动项目切换不影响真实改名）', Array.isArray(projectNames) && projectNames.includes('项目A-新名'), projectNames);
    check('Z-08 旧结果只提示，不重新打开/污染会话', notice.includes('显示名称已更新'), notice);
    check('Z-09 全程只发了一次改名请求（绝不自动重发）', net.posts('/api/projects/rename').length === postsRenameProjectBefore + 1, {
      before: postsRenameProjectBefore,
      after: net.posts('/api/projects/rename').length,
    });
    check('Z-10 顺序是"请求在途 → 切换活动项目 → 放行响应"', order.join('>') === 'paused>switched>released', order);
    await shot(t.tab, '06-async-rename-after-release.png');
  }

  offPaused();
  await t.tab.send('Fetch.disable').catch(() => undefined);

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
