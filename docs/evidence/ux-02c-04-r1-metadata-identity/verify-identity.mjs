/**
 * UX-02C-04-R1 真实浏览器复验：**资源元数据身份一致性**。
 *
 * 一条链走到底（全部在真实 Chrome + 真实 Host + 真实磁盘上）：
 *   原文件 A 标注 → 回收 A → 同名新文件 B 落到原路径 → B 打**不同**标注
 *   → 把 B 移动走 → 从回收区恢复 A → 两行各自保留 → 重启 Host 后仍一致
 *
 * 取证纪律：
 * - 每个断言取三类事实：**DOM**（树上那一行）、**接口**（/api/metadata）、**磁盘**（dev:ino + SHA-256）；
 * - 全程不拦截、不改写任何请求：看的是真实 Host 的真实结论；
 * - 只碰 `weavespace-test/c04r1`，不碰用户真实文件。
 *
 * 进程编排（Host / Vite / Chrome 都由本脚本自己拉起与关闭）：
 * 这样"重启 Host"是本脚本的一步，而不是让操作者手工插一段——手工那一步最容易漏。
 *
 * 用法：node docs/evidence/ux-02c-04-r1-metadata-identity/verify-identity.mjs
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:/Workspace/projects/weavespace';
const BASE = 'D:/Workspace/projects/weavespace-test/c04r1';
const ROOT = join(BASE, 'projA');
const STORE = join(BASE, 'store/workspace.json');
const PROJECT = 'proj-a';

const HOST_PORT = 5397;
const APP_PORT = 5398;
const CDP_PORT = 9347;
const HOST = `http://127.0.0.1:${HOST_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}/`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

// cdp.mjs 在模块加载时读 CDP_PORT，必须先设好再动态 import
process.env.CDP_PORT = String(CDP_PORT);
const { ev, newTab, sleep, waitFor } = await import('./cdp.mjs');

/* ------------------------------ 报告 ------------------------------ */

const report = { run: 'ux-02c-04-r1-identity', at: new Date().toISOString(), checks: {}, detail: {}, facts: {} };
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

/* ------------------------------ 原子事实 ------------------------------ */

const sha256 = (path) =>
  existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;

/** 磁盘上的对象身份，与 Host 的 `identityOf` 同一个口径：`${dev}:${ino}`。 */
const identityOf = (path) => {
  if (!existsSync(path)) return null;
  const st = statSync(path);
  return `${st.dev}:${st.ino}`;
};

const objectFacts = (path) => ({ path, exists: existsSync(path), identity: identityOf(path), sha256: sha256(path) });

const configRaw = () => JSON.parse(readFileSync(STORE, 'utf8'));
const recordsAt = (raw, path) => (raw.metadata ?? []).filter((entry) => entry.path === path);

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
    headers: {
      ...(init.headers ?? {}),
      'x-ws-token': await token(),
      origin: new URL(HOST).origin,
    },
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
  /*
   * 必须用 `--workspace-store <dir>`（托管 Multi），**不是** `--workspace <file>`：
   * 后者读的是 `packages/project-registry` 的**静态 v1 工作区文件**，与
   * `store/config.ts` 的 v5 存储配置是两套格式。指错参数 Host 会直接
   * `不支持的工作区配置版本: 5` 退出——第一版脚本就撞在这上面。
   */
  const child = spawnLogged(
    process.execPath,
    ['--experimental-strip-types', 'apps/server/src/main.ts', '--workspace-store', join(BASE, 'store'), String(HOST_PORT)],
    { cwd: REPO, env: { ...process.env } },
  );
  hostLogs.push({ tag, child });
  return child;
}

async function stopHost() {
  const last = hostLogs[hostLogs.length - 1];
  if (!last) return;
  const child = last.child;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
      resolve();
    }, 5000);
  });
  await sleep(600);
}

/* ------------------------------ 页面操作 ------------------------------ */

const metaDialogOpen = `!!document.querySelector('[aria-label="资源标注"]')`;

const setInput = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
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
    tags: [...row.querySelectorAll('.tree__tag')].map((el) => el.textContent),
    color: [...row.classList].find((cls) => cls.startsWith('tree__row--color-')) ?? null,
    title: row.getAttribute('title'),
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
  await ev(t.tab, `[...document.querySelectorAll('button')].find(b=>b.innerText.includes('真实文件'))?.click()`);
  await waitFor(t.tab, `document.body.innerText.includes('项目A')`, 25000, 'live workspace');
  await waitFor(t.tab, `document.querySelectorAll('button.tree__row--file').length > 0`, 25000, 'tree rows');
  await sleep(700);
  return t;
}

async function reloadApp(t) {
  await t.tab.send('Page.reload');
  await sleep(3000);
  await ev(t.tab, `[...document.querySelectorAll('button')].find(b=>b.innerText.includes('真实文件'))?.click()`);
  await waitFor(t.tab, `document.querySelectorAll('button.tree__row--file').length > 0`, 25000, 'tree rows after reload');
  await sleep(700);
}

async function shot(t, name) {
  const { data } = await t.tab.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(HERE, name), Buffer.from(data, 'base64'));
}

async function openContextMenu(t, name) {
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
  await sleep(400);
  return ok;
}

async function menuItem(t, text) {
  return await ev(
    t.tab,
    `(() => {
      const item = [...document.querySelectorAll('[role=menu] [role=menuitem]')].find(b=>b.innerText.trim().startsWith(${JSON.stringify(text)}));
      return item ? { text: item.innerText.trim(), disabled: item.disabled } : null;
    })()`,
    false,
  );
}

async function clickMenuItem(t, text) {
  const result = await ev(
    t.tab,
    `(() => {
      const item = [...document.querySelectorAll('[role=menu] [role=menuitem]')].find(b=>b.innerText.trim().startsWith(${JSON.stringify(text)}));
      if (!item) return 'missing';
      item.click();
      return 'clicked';
    })()`,
    false,
  );
  await sleep(300);
  return result;
}

async function openMeta(t, name, itemText) {
  if (!(await openContextMenu(t, name))) return 'no-row';
  const item = await menuItem(t, itemText);
  if (!item) return 'no-menu-item';
  if (item.disabled) return 'menu-disabled';
  await clickMenuItem(t, itemText);
  try {
    await waitFor(t.tab, metaDialogOpen, 8000, 'metadata dialog');
  } catch {
    return 'no-dialog';
  }
  await sleep(300);
  return 'open';
}

async function saveDialog(t) {
  const clicked = await ev(t.tab, clickByText('.meta__dialog button', '保存'), false);
  await waitFor(t.tab, `!(${metaDialogOpen})`, 15000, 'dialog closed after save');
  await sleep(900);
  return clicked;
}

async function rowState(t, name) {
  return await ev(t.tab, rowStateOf(name), false);
}

/** 三个字段分开判：有标注名时标签折成 `+N`，内容只能去 `title` 里找。 */
async function expectRow(t, name, expect, label) {
  const state = await rowState(t, name);
  const aliasOk =
    expect.alias === undefined || state?.alias === (expect.alias === null ? null : `（${expect.alias}）`);
  const tagsOk =
    expect.tags === undefined || (expect.tags ?? []).every((tag) => (state?.title ?? '').includes(tag));
  const chipsOk =
    expect.chips === undefined || JSON.stringify(state?.tags) === JSON.stringify(expect.chips);
  const colorOk = expect.color === undefined || state?.color === expect.color;
  return check(label, !!state && aliasOk && tagsOk && chipsOk && colorOk, state);
}

/**
 * 折叠全部目录。
 *
 * 为什么需要：这一轮里 `same.md` **同时存在两份**（根下的 A、`dir/` 下的 B），
 * 而树行只有 `.tree__name` 可用来定位。按名字取"第一个"会命中 DOM 里靠前的那一行
 * （`dir` 字母序在 `same.md` 前面 → 先出现的是**子目录里**那份），断言就会看着像
 * "A 显示了 B 的标注"。这不是产品的错，是取证的错：**先收窄可见范围，再断言**。
 */
async function collapseAll(t) {
  await ev(
    t.tab,
    `(() => {
      /*
       * **必须跳过项目根行**：它同样是 \`button.tree__row--folder\` + aria-expanded，
       * 点它等于折叠整棵树（第一版脚本就是这么把行全点没的）。
       * 判据：直接父级 ul 是 \`tree__root\` 的那一行就是项目根。
       */
      const isRootRow = (b) => b.closest('li')?.parentElement?.classList.contains('tree__root') === true;
      for (const b of [...document.querySelectorAll('button.tree__row--folder')]) {
        if (!isRootRow(b) && b.getAttribute('aria-expanded') === 'true') b.click();
      }
      return true;
    })()`,
    false,
  );
  await sleep(900);
}

const hasChildRows = `[...document.querySelectorAll('button.tree__row--file')].some((b) => (b.querySelector('.tree__indent')?.children.length ?? 0) > 0)`;

/**
 * 确保某个目录**真的展开了且有子行**。
 *
 * 结构变更后层表会被整层作废，但节点的展开状态还留着：此时 `aria-expanded="true"`
 * 却没有子行（第一次在这里踩到，表现为"移动后看不到新位置的行"）。
 * 所以不能只看 `aria-expanded`，必须看"有没有子行"；空的话折叠再展开，触发重新取层。
 */
async function ensureExpanded(t, name) {
  const state = await ev(
    t.tab,
    `(() => {
      const b = [...document.querySelectorAll('button.tree__row--folder')].find((x) => x.querySelector('.tree__name')?.textContent === ${JSON.stringify(name)});
      if (!b) return 'no-folder';
      return b.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed';
    })()`,
    false,
  );
  if (state === 'no-folder') return state;
  if (state === 'expanded' && (await ev(t.tab, hasChildRows, false))) return 'expanded';

  if (state === 'expanded') {
    // 展开但空：先收起再展开，逼它重新取层
    await ev(
      t.tab,
      `(() => {
        const b = [...document.querySelectorAll('button.tree__row--folder')].find((x) => x.querySelector('.tree__name')?.textContent === ${JSON.stringify(name)});
        b?.click();
        return !!b;
      })()`,
      false,
    );
    await sleep(600);
  }
  await ev(
    t.tab,
    `(() => {
      const b = [...document.querySelectorAll('button.tree__row--folder')].find((x) => x.querySelector('.tree__name')?.textContent === ${JSON.stringify(name)} && x.getAttribute('aria-expanded') === 'false');
      b?.click();
      return !!b;
    })()`,
    false,
  );
  await sleep(1500);
  return (await ev(t.tab, hasChildRows, false)) ? 'expanded' : 'still-empty';
}

async function refreshTree(t) {
  await ev(t.tab, `document.querySelector('.project__refresh')?.click()`, false);
  await sleep(1800);
}

async function dialogPhase(t) {
  return await ev(t.tab, `document.querySelector('[data-trash-delete]')?.getAttribute('data-trash-delete') ?? null`, false);
}

async function removeViaUi(t, name) {
  if (!(await openContextMenu(t, name))) return { stage: 'no-row' };
  const item = await menuItem(t, '移入回收区');
  if (!item) return { stage: 'no-menu-item' };
  if (item.disabled) return { stage: 'menu-disabled', item };
  await clickMenuItem(t, '移入回收区');
  await sleep(1200);
  const phase = await dialogPhase(t);
  if (phase !== 'ready') return { stage: phase };
  await ev(t.tab, `document.querySelector('[data-trash-confirm]')?.click()`, false);
  await waitFor(
    t.tab,
    `document.querySelector('[data-trash-delete]')?.getAttribute('data-trash-delete') === 'result'`,
    25000,
    'dialog result',
  );
  const text = await ev(t.tab, `document.querySelector('[data-trash-delete]')?.innerText ?? null`, false);
  await ev(t.tab, `document.querySelector('[data-trash-delete] button')?.click()`, false);
  await waitFor(t.tab, `document.querySelector('[data-trash-delete]') === null`, 10000, 'dialog closed');
  await sleep(1000);
  return { stage: 'confirmed', text };
}

async function backToTree(t) {
  const inTrash = await ev(t.tab, `!!document.querySelector('[aria-label="返回项目"]')`, false);
  if (!inTrash) return false;
  await ev(t.tab, `document.querySelector('[aria-label="返回项目"]')?.click()`, false);
  await sleep(900);
  return true;
}

async function openTrash(t) {
  const already = await ev(t.tab, `!!document.querySelector('[aria-label="返回项目"]')`, false);
  if (!already) {
    await ev(t.tab, `[...document.querySelectorAll('button')].find(b=>/回收区/.test(b.innerText))?.click()`);
  }
  await waitFor(t.tab, `document.querySelector('.trash')`, 12000, 'trash panel');
  await sleep(800);
}

const trashRows = () =>
  `[...document.querySelectorAll('.trash__item')].map((item) => ({
    name: item.querySelector('.trash__name')?.textContent ?? null,
    action: item.querySelector('.trash__actions button')?.innerText.trim() ?? null,
  }))`;

async function restoreRow(t, name) {
  const clicked = await ev(
    t.tab,
    `(() => {
      const item = [...document.querySelectorAll('.trash__item')].find((row) => (row.querySelector('.trash__name')?.textContent ?? '') === ${JSON.stringify(name)});
      if (!item) return 'no-row';
      const btn = item.querySelector('.trash__actions button');
      if (!btn) return 'no-button';
      btn.click();
      return 'clicked';
    })()`,
    false,
  );
  await sleep(1500);
  const hasConfirm = await ev(
    t.tab,
    `!!document.querySelector('[data-trash-restore-confirm], .modal [data-trash-confirm-restore]')`,
    false,
  );
  if (hasConfirm) {
    await ev(
      t.tab,
      `document.querySelector('[data-trash-restore-confirm], .modal [data-trash-confirm-restore]').click()`,
      false,
    );
    await sleep(1600);
  }
  return { clicked, hasConfirm };
}

/* ------------------------------ 主流程 ------------------------------ */

let exitCode = 0;
let host = null;
let vite = null;
let chrome = null;

try {
  section('环境');
  // 每次从干净 fixture 开始：残留的回收区记录会让"回收区里只有一条"这类断言失去判别力
  rmSync(join(BASE, 'projA'), { recursive: true, force: true });
  mkdirSync(join(BASE, 'projA'), { recursive: true });

  await import('./reset-fixture.mjs');
  const baseConfig = configRaw();
  fact('configBefore', baseConfig);
  check('E-00 fixture 就绪：v5 配置、零元数据记录', baseConfig.version === 5 && (baseConfig.metadata ?? []).length === 0);

  host = startHost('host-1');
  await waitHttp(`${HOST}/api/session-token`, 30000, 'host');
  await token(true);

  vite = spawnLogged('npm', ['--prefix', 'apps/shell', 'run', 'dev', '--', '--port', String(APP_PORT), '--strictPort'], {
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

  section('原文件 A 标注');
  const initial = await rowState(t, 'same.md');
  check('E-01 初始：same.md 存在且没有任何标注', initial !== null && initial.alias === null && initial.tags.length === 0, initial);

  check('E-02 右键 → 「设置标注名…」打开标注对话框', (await openMeta(t, 'same.md', '设置标注名…')) === 'open');
  await ev(t.tab, setInput('#meta-alias', '原文件A'), false);
  check('E-03 保存后行上显示「原文件A」', (await saveDialog(t)) === 'clicked');
  await expectRow(t, 'same.md', { alias: '原文件A' }, 'E-04 真实名称仍是 same.md，标注名在括号里');

  check('E-05 右键 → 「编辑标签…」', (await openMeta(t, 'same.md', '编辑标签…')) === 'open');
  await ev(t.tab, setInput('[aria-label="新增标签"]', '原件'), false);
  await ev(t.tab, clickByText('.meta__dialog button', '添加'), false);
  await sleep(250);
  await saveDialog(t);
  await expectRow(t, 'same.md', { tags: ['原件'], chips: ['+1'] }, 'E-06 标签「原件」已就位（有标注名时折成 +1）');

  check('E-07 右键 → 「设置颜色…」', (await openMeta(t, 'same.md', '设置颜色…')) === 'open');
  await ev(t.tab, `document.querySelector('.meta__swatch--red')?.click()`, false);
  await saveDialog(t);
  await expectRow(t, 'same.md', { color: 'tree__row--color-red' }, 'E-08 行带上 red 颜色类名');

  const aFacts = objectFacts(join(ROOT, 'same.md'));
  fact('objectA', aFacts);
  const configAfterA = configRaw();
  const aRecords = recordsAt(configAfterA, 'same.md');
  check('E-09 配置里恰好一条记录，且身份 = 磁盘上 A 的 dev:ino', aRecords.length === 1, aRecords);
  check(
    'E-10 记录带完整身份（项目 + 路径 + 根令牌 + 对象身份），且根令牌与项目一致',
    aRecords[0]?.identity === aFacts.identity &&
      aRecords[0]?.rootToken === configAfterA.projects[0].rootToken &&
      aRecords[0]?.projectId === PROJECT,
    aRecords[0],
  );
  await shot(t, '01-object-a-labeled.png');

  section('回收 A → 同名新文件 B');
  const removed = await removeViaUi(t, 'same.md');
  check('E-11 通过右键「移入回收区」回收 A', removed.stage === 'confirmed', removed);
  check('E-12 A 已不在原路径上（磁盘事实）', !existsSync(join(ROOT, 'same.md')) || identityOf(join(ROOT, 'same.md')) !== aFacts.identity);
  const configAfterTrash = configRaw();
  check('E-13 回收不删元数据：A 的记录还在配置里', recordsAt(configAfterTrash, 'same.md').length === 1, recordsAt(configAfterTrash, 'same.md'));

  // 同名的**另一个对象**落到原路径：内容不同 → inode 必然不同
  writeFileSync(join(ROOT, 'same.md'), '# B new file\n\n同名，但不是被回收的那一个\n', 'utf8');
  await refreshTree(t);
  const bFacts = objectFacts(join(ROOT, 'same.md'));
  fact('objectB', bFacts);
  check('E-14 新文件确实是另一个对象（身份与 A 不同）', bFacts.exists && bFacts.identity !== aFacts.identity, { a: aFacts.identity, b: bFacts.identity });
  await expectRow(t, 'same.md', { alias: null, tags: [], color: null }, 'E-15 B 不继承 A 的标注名 / 标签 / 颜色');

  section('给 B 打不同标注');
  check('E-16 右键 → 「设置标注名…」', (await openMeta(t, 'same.md', '设置标注名…')) === 'open');
  await ev(t.tab, setInput('#meta-alias', '新文件B'), false);
  await saveDialog(t);
  check('E-17 右键 → 「编辑标签…」', (await openMeta(t, 'same.md', '编辑标签…')) === 'open');
  await ev(t.tab, setInput('[aria-label="新增标签"]', '新件'), false);
  await ev(t.tab, clickByText('.meta__dialog button', '添加'), false);
  await sleep(250);
  await saveDialog(t);
  check('E-18 右键 → 「设置颜色…」', (await openMeta(t, 'same.md', '设置颜色…')) === 'open');
  await ev(t.tab, `document.querySelector('.meta__swatch--blue')?.click()`, false);
  await saveDialog(t);
  await collapseAll(t);
  await expectRow(t, 'same.md', { alias: '新文件B', tags: ['新件'], color: 'tree__row--color-blue' }, 'E-19 行上是 B 自己的标注');

  const configTwo = configRaw();
  const twoRecords = recordsAt(configTwo, 'same.md');
  fact('recordsAtSamePath', twoRecords);
  check('E-20 同一路径上两条记录共存（身份不同）', twoRecords.length === 2, twoRecords);
  check(
    'E-21 两条记录各归各的身份：A 的仍是「原文件A/red/原件」，B 的是「新文件B/blue/新件」',
    twoRecords.some((r) => r.identity === aFacts.identity && r.alias === '原文件A' && r.color === 'red' && r.tags.includes('原件')) &&
      twoRecords.some((r) => r.identity === bFacts.identity && r.alias === '新文件B' && r.color === 'blue' && r.tags.includes('新件')),
    twoRecords,
  );
  const listed = await metadataList();
  /*
   * A 的记录在该路径上是 `rebound` 而不是 `missing`：
   * 路径上**有对象**，只是不是它（§5.4 的四种状态就是这么分的）。
   * 断言要钉的是"它绝不 `active`"，而不是钉死某一个失效态的名字。
   */
  const aEntry = (listed.body?.entries ?? []).find((e) => e.alias === '原文件A');
  check(
    'E-22 接口只把 active 那条（B）标成生效，A 的那条如实报失效（rebound）',
    listed.status === 200 &&
      listed.body?.entries?.some((e) => e.path === 'same.md' && e.state === 'active' && e.alias === '新文件B') &&
      aEntry?.state === 'rebound',
    listed.body?.entries,
  );
  await shot(t, '02-b-labeled-same-path.png');

  section('移动 B（只迁移真实移动的对象）');
  check('E-23 右键 → 「移动到…」', (await openContextMenu(t, 'same.md')) && (await menuItem(t, '移动到…')) !== null);
  await clickMenuItem(t, '移动到…');
  await waitFor(t.tab, `!!document.querySelector('.move__select')`, 8000, 'move dialog');
  await ev(
    t.tab,
    `(() => {
      const select = document.querySelector('.move__select');
      const option = [...select.options].find((o) => o.value === 'dir');
      if (!option) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'dir');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
    false,
  );
  await sleep(300);
  await ev(t.tab, clickByText('.move__dialog button', '确认移动'), false);
  await waitFor(t.tab, `!document.querySelector('.move__dialog')`, 25000, 'move dialog closed');
  await sleep(1400);

  const movedFacts = objectFacts(join(ROOT, 'dir/same.md'));
  fact('objectBAfterMove', movedFacts);
  check('E-24 磁盘上 B 已在 dir/same.md，且身份不变（还是同一个对象）', movedFacts.exists && movedFacts.identity === bFacts.identity, {
    before: bFacts,
    after: movedFacts,
  });
  await collapseAll(t);
  await ensureExpanded(t, 'dir');
  await expectRow(t, 'same.md', { alias: '新文件B', tags: ['新件'], color: 'tree__row--color-blue' }, 'E-25 移动后标注跟着走');

  const configAfterMove = configRaw();
  fact('recordsAfterMove', configAfterMove.metadata);
  check('E-26 迁移只改路径、不改身份：B 的记录指向 dir/same.md', recordsAt(configAfterMove, 'dir/same.md').some((r) => r.identity === bFacts.identity), configAfterMove.metadata);
  check(
    'E-27 A 的记录仍留在原路径（失效记录不随别人的移动一起搬走）',
    recordsAt(configAfterMove, 'same.md').length === 1 && recordsAt(configAfterMove, 'same.md')[0].identity === aFacts.identity,
    configAfterMove.metadata,
  );
  check('E-28 迁移没有伪造出第三条记录', (configAfterMove.metadata ?? []).length === 2, (configAfterMove.metadata ?? []).length);

  section('恢复 A（同一个对象回到原路径）');
  await openTrash(t);
  const rows = await ev(t.tab, trashRows(), true);
  check('E-29 回收区里能看到 A 那一条', Array.isArray(rows) && rows.some((r) => r.name === 'same.md'), rows);
  const restored = await restoreRow(t, 'same.md');
  check('E-30 点「恢复」并完成确认', restored.clicked === 'clicked', restored);
  await sleep(2000);
  await backToTree(t);
  await sleep(1000);
  await refreshTree(t);

  const restoredFacts = objectFacts(join(ROOT, 'same.md'));
  fact('objectAAfterRestore', restoredFacts);
  check('E-31 回到原路径的是同一个对象（身份与最初一致）', restoredFacts.exists && restoredFacts.identity === aFacts.identity, {
    original: aFacts,
    restored: restoredFacts,
  });
  check('E-32 恢复的是同一份内容（SHA-256 一致）', restoredFacts.sha256 === aFacts.sha256, { before: aFacts.sha256, after: restoredFacts.sha256 });

  // 根层与 dir 层各断言一次：先收窄到"只看根"，再收窄到"只看 dir"
  await collapseAll(t);
  await expectRow(t, 'same.md', { alias: '原文件A', tags: ['原件'], color: 'tree__row--color-red' }, 'E-33 恢复后 A 的标注重新生效');
  await ensureExpanded(t, 'dir');
  await expectRow(t, 'same.md', { alias: '新文件B', tags: ['新件'], color: 'tree__row--color-blue' }, 'E-34 同时 B 在自己的新位置保留自己的标注');
  await shot(t, '03-both-kept.png');

  const configBoth = configRaw();
  fact('configBothKept', configBoth);
  const finalRecords = configBoth.metadata ?? [];
  check('E-35 配置里两条记录、两个身份、两个路径，各自标注正确', finalRecords.length === 2 &&
    finalRecords.some((r) => r.path === 'same.md' && r.identity === aFacts.identity && r.alias === '原文件A') &&
    finalRecords.some((r) => r.path === 'dir/same.md' && r.identity === bFacts.identity && r.alias === '新文件B'), finalRecords);
  check(
    'E-36 磁盘上两个文件内容互不相同（不是同一个文件被挪来挪去）',
    objectFacts(join(ROOT, 'same.md')).sha256 !== objectFacts(join(ROOT, 'dir/same.md')).sha256,
    { a: objectFacts(join(ROOT, 'same.md')).sha256, b: objectFacts(join(ROOT, 'dir/same.md')).sha256 },
  );

  section('重启 Host');
  await stopHost();
  host = startHost('host-2');
  await waitHttp(`${HOST}/api/session-token`, 30000, 'host after restart');
  await token(true);
  await reloadApp(t);

  const afterRestart = configRaw();
  fact('configAfterRestart', afterRestart);
  check(
    'E-37 重启后配置里的记录集合没有变化（两条、身份不变、路径不变）',
    JSON.stringify(afterRestart.metadata) === JSON.stringify(configBoth.metadata),
    { before: configBoth.metadata, after: afterRestart.metadata },
  );
  await collapseAll(t);
  await expectRow(t, 'same.md', { alias: '原文件A', tags: ['原件'], color: 'tree__row--color-red' }, 'E-38 重启后 A 仍显示自己的标注');
  await ensureExpanded(t, 'dir');
  await expectRow(t, 'same.md', { alias: '新文件B', tags: ['新件'], color: 'tree__row--color-blue' }, 'E-39 重启后 B 仍显示自己的标注');
  await shot(t, '04-after-host-restart.png');

  const listedAfterRestart = await metadataList();
  check(
    'E-40 重启后接口结论一致：A 与 B 都是 active',
    listedAfterRestart.status === 200 &&
      listedAfterRestart.body?.entries?.filter((e) => e.state === 'active').length === 2,
    listedAfterRestart.body?.entries,
  );

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
    // Chrome 会派生子进程，`kill` 只到主进程；关掉整个树由任务管理器兜底，这里只保证主进程退出
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已经退出 */
    }
  }
  const hostDump = hostLogs.map(({ tag, child }) => `### ${tag}\n${child.collected()}`).join('\n');
  writeFileSync(join(HERE, 'host-logs.txt'), hostDump, 'utf8');
  writeFileSync(join(HERE, 'browser-verification.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await sleep(1200);
  process.exit(exitCode);
}
