/**
 * UX-02C-04 真实浏览器验收的共享辅助（由 P2-03 的证据脚本演进而来）。
 *
 * 纪律：
 * - 正常标注 / 改名 / 移动 / 回收 / 恢复**不拦截**任何请求，只看真实 Host + 真实磁盘；
 * - 断言一律"取磁盘事实 / 取接口事实 / 取 DOM 事实"，不猜内部状态；
 * - 不碰用户真实工作文件：一切只发生在 `weavespace-test/c04`。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

import { ev, newTab, sleep, waitFor } from './cdp.mjs';

export const APP = process.env.APP_URL ?? 'http://127.0.0.1:5298/';
export const HOST = process.env.HOST_URL ?? 'http://127.0.0.1:5297';
export const ROOT_A = 'D:/Workspace/projects/weavespace-test/c04/projA';
export const ROOT_B = 'D:/Workspace/projects/weavespace-test/c04/projB';
export const PROJECT_A = 'proj-a';
export const PROJECT_B = 'proj-b';
export const LEDGER_KEY = 'ws:trash-pending:v1';

/* ------------------------------ 断言记录 ------------------------------ */

export function createReport(run) {
  const result = { run, at: new Date().toISOString(), checks: {}, detail: {}, injected: [] };
  const check = (name, ok, detail) => {
    result.checks[name] = !!ok;
    if (detail !== undefined) result.detail[name] = detail;
    console.log(ok ? '  PASS' : '  FAIL', name, ok ? '' : JSON.stringify(detail));
    return !!ok;
  };
  const section = (title) => console.log(`\n--- ${title} ---`);
  const summarize = () => {
    const failed = Object.entries(result.checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);
    result.summary = { total: Object.keys(result.checks).length, passed: Object.keys(result.checks).length - failed.length, failed };
    console.log('\nSUMMARY', JSON.stringify(result.summary));
    return result.summary;
  };
  return { result, check, section, summarize };
}

/* ------------------------------ 磁盘事实 ------------------------------ */

export const sha256 = (path) => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null);
export const sizeOf = (path) => (existsSync(path) ? statSync(path).size : null);

/** 递归列出目录下的相对文件路径（用于"取消时磁盘零变化"的整体比对）。 */
export function listTree(dir, prefix = '') {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listTree(`${dir}/${entry.name}`, rel));
    else out.push(rel);
  }
  return out.sort();
}

/* ------------------------------ Host 接口 ------------------------------ */

let cachedToken = null;
export async function token() {
  if (cachedToken) return cachedToken;
  const response = await fetch(`${HOST}/api/session-token`);
  const body = await response.json();
  cachedToken = body.token;
  return cachedToken;
}

/**
 * 调 Host 接口。
 *
 * 变更类请求（POST）**必须**带 `Origin`，且必须落在 Host 的来源白名单里
 * （缺省是 `http://<Host 自己的 host>` 与本机 5178 端口的 Vite）。这里直接以 Host 自身
 * 作为来源：等价于"从 Host 自己的页面发起的同源写请求"。
 * 不带 Origin 得到的 403 与"路径/形态非法"完全不是一回事——早期版本的断言曾经把
 * 这种 403 当成"目录被拒绝"的通过，属于假通过，这里显式补上。
 */
export async function api(path, init = {}) {
  const headers = {
    ...(init.headers ?? {}),
    'x-ws-token': await token(),
    origin: new URL(HOST).origin,
  };
  const response = await fetch(`${HOST}${path}`, { ...init, headers });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

export const trashList = (projectId) => api(`/api/trash?projectId=${encodeURIComponent(projectId)}`);
export const projects = () => api('/api/projects');
export const queryOp = (projectId, opId) => api(`/api/trash/op?projectId=${encodeURIComponent(projectId)}&opId=${encodeURIComponent(opId)}`);

/* ------------------------------ 页面操作 ------------------------------ */

/**
 * 打开一个真实文件模式的应用页。
 *
 * `fresh: true` 会**先导航到该 origin**、再用 CDP `Storage.clearDataForOrigin` 清掉它的
 * localStorage / IndexedDB / Cache，然后 reload — 只在"这一轮要从干净状态开始"时用。
 * （顺序不能反：在 about:blank 上清是静默无效的。）
 * **不要**用页面里的 `indexedDB.deleteDatabase`：页面自己还握着连接，删除请求会一直挂着，
 * 之后所有 `open()` 都排队等它，逼出一个假的"initializing 卡死"。
 */
export async function openApp({ recorder = true, fresh = false } = {}) {
  const { tab, targetId } = await newTab('about:blank');
  if (recorder) {
    await tab.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__storageEvents=[];window.addEventListener('storage',e=>window.__storageEvents.push({key:e.key,newValue:e.newValue===null?null:String(e.newValue).slice(0,80)}));`,
    });
  }
  await tab.send('Page.navigate', { url: APP });
  await sleep(1500);
  if (fresh) {
    /*
     * 必须**先**导航到这个 origin 再清：在 about:blank 上发
     * `Storage.clearDataForOrigin` 不会真的清掉该 origin 的存储（试过，静默无效），
     * 结果就是上一轮的台账被当成本轮的初始状态。
     */
    await tab.send('Storage.clearDataForOrigin', {
      origin: new URL(APP).origin,
      storageTypes: 'local_storage,indexeddb,cache_storage,service_workers',
    });
    await tab.send('Page.reload');
    await sleep(3200);
  }
  await sleep(1500);
  await ev(tab, `[...document.querySelectorAll('button')].find(b=>b.innerText.includes('真实文件'))?.click()`);
  await waitFor(tab, `document.body.innerText.includes('项目A')`, 20000, 'live workspace');
  // 导航状态会持久化：上一次停在回收区时，这里要先切回文件树
  await backToTree({ tab, targetId });
  await waitFor(tab, `document.querySelectorAll('button.tree__row--file').length > 0`, 20000, 'tree rows');
  await sleep(500);
  return { tab, targetId };
}

export async function closeTab(t) {
  try {
    await t.tab.send('Target.closeTarget', { targetId: t.targetId });
  } catch {
    /* 已关闭 */
  }
}

/**
 * 文件树里某个项目下的文件行（按**真实文件名**）。
 *
 * 不能用 `innerText` 精确匹配：UX-02C-04 起行文本会变成
 * `note.md（核心架构）重要`（标注名 + 标签都在按钮里），
 * 拿整行文本当文件名会在"已标注"之后立刻失配。
 */
const rowExpr = (name) =>
  `[...document.querySelectorAll('button.tree__row--file')].find(b=>b.querySelector('.tree__name')?.textContent===${JSON.stringify(name)})`;

/** 行上的展示事实：真实名称、标注名、标签、颜色类名。 */
export const rowStateOf = (name) => `(() => {
  const row = ${rowExpr(name)};
  if (!row) return null;
  const alias = row.querySelector('.tree__alias')?.textContent ?? null;
  const tags = [...row.querySelectorAll('.tree__tag')].map((el) => el.textContent);
  const color = [...row.classList].find((cls) => cls.startsWith('tree__row--color-')) ?? null;
  return {
    name: row.querySelector('.tree__name')?.textContent ?? null,
    alias,
    tags,
    color,
    title: row.getAttribute('title'),
  };
})()`;

export async function hasRow(t, name) {
  return await ev(t.tab, `!!(${rowExpr(name)})`, false);
}

export async function openContextMenu(t, name) {
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

export async function menuItem(t, text) {
  return await ev(
    t.tab,
    `(() => {
      const item = [...document.querySelectorAll('[role=menu] [role=menuitem]')].find(b=>b.innerText.trim().startsWith(${JSON.stringify(text)}));
      if (!item) return null;
      return { text: item.innerText.trim(), disabled: item.disabled };
    })()`,
    false,
  );
}

export async function clickMenuItem(t, text) {
  return await ev(
    t.tab,
    `(() => {
      const item = [...document.querySelectorAll('[role=menu] [role=menuitem]')].find(b=>b.innerText.trim().startsWith(${JSON.stringify(text)}));
      if (!item) return 'missing';
      item.click();
      return 'clicked';
    })()`,
    false,
  );
}

export async function dialogPhase(t) {
  return await ev(t.tab, `document.querySelector('[data-trash-delete]')?.getAttribute('data-trash-delete') ?? null`, false);
}

export async function dialogText(t) {
  return await ev(t.tab, `document.querySelector('[data-trash-delete]')?.innerText ?? null`, false);
}

export async function cancelDialog(t) {
  await ev(t.tab, `document.querySelector('[data-trash-delete] .modal__actions button')?.click()`, false);
  await sleep(400);
}

/**
 * 确认 → 等结果阶段 → 点「好的」关闭。
 *
 * 结果阶段**不会自动关**（故意：让用户看到"文件去哪了"这句话再走），
 * 所以这里必须显式收尾，否则后续断言会看见一个悬着的模态。
 */
export async function confirmDialog(t) {
  await ev(t.tab, `document.querySelector('[data-trash-confirm]')?.click()`, false);
  await waitFor(
    t.tab,
    `document.querySelector('[data-trash-delete]')?.getAttribute('data-trash-delete') === 'result'`,
    25000,
    'dialog result',
  );
  const text = await dialogText(t);
  await ev(t.tab, `document.querySelector('[data-trash-delete] button')?.click()`, false);
  await waitFor(t.tab, `document.querySelector('[data-trash-delete]') === null`, 10000, 'dialog closed');
  await sleep(900);
  return text;
}

/** 右键 → 移入回收区（可选取消）；返回对话框阶段。 */
export async function removeViaUi(t, name, { cancel = false } = {}) {
  if (!(await openContextMenu(t, name))) return { stage: 'no-row' };
  const item = await menuItem(t, '移入回收区');
  if (!item) return { stage: 'no-menu-item' };
  if (item.disabled) return { stage: 'menu-disabled', item };
  await clickMenuItem(t, '移入回收区');
  await sleep(1200);
  const phase = await dialogPhase(t);
  if (cancel) {
    await cancelDialog(t);
    return { stage: 'cancelled', phase };
  }
  if (phase !== 'ready') return { stage: phase, text: await dialogText(t) };
  const text = await confirmDialog(t);
  return { stage: 'confirmed', text };
}

/** 从回收区切回文件树（导航键 `projects`）。 */
export async function backToTree(t) {
  const inTrash = await ev(t.tab, `!!document.querySelector('[aria-label="返回项目"]')`, false);
  if (!inTrash) return false;
  await ev(t.tab, `document.querySelector('[aria-label="返回项目"]')?.click()`, false);
  await sleep(900);
  return true;
}

export async function openTrash(t) {
  const already = await ev(t.tab, `!!document.querySelector('[aria-label="返回项目"]')`, false);
  if (!already) {
    await ev(t.tab, `[...document.querySelectorAll('button')].find(b=>/回收区/.test(b.innerText))?.click()`);
  }
  await waitFor(t.tab, `document.querySelector('.trash')`, 12000, 'trash panel');
  await sleep(800);
}

export async function trashRows(t) {
  return await ev(
    t.tab,
    `[...document.querySelectorAll('.trash__item')].map((item) => {
      const btn = item.querySelector('.trash__actions button');
      return {
        name: item.querySelector('.trash__name')?.textContent ?? null,
        badge: item.querySelector('.trash__badge')?.textContent ?? null,
        note: item.querySelector('.trash__note')?.textContent ?? null,
        hasButton: !!btn,
        buttonDisabled: btn ? btn.disabled : null,
      };
    })`,
  );
}

export async function trashBanner(t) {
  return await ev(
    t.tab,
    `document.querySelector('.trash__hint--error[role="alert"]')?.textContent ?? null`,
    false,
  );
}

/** 在回收区里恢复某一行（按钮 disabled 时可选强制点击）。 */
export async function restoreRow(t, name, { force = false } = {}) {
  return await ev(
    t.tab,
    `(() => {
      const item = [...document.querySelectorAll('.trash__item')].find((row) => (row.querySelector('.trash__name')?.textContent ?? '') === ${JSON.stringify(name)});
      if (!item) return 'no-row';
      const btn = item.querySelector('.trash__actions button');
      if (!btn) return 'no-button';
      ${force ? 'btn.disabled = false; btn.removeAttribute("disabled");' : ''}
      btn.click();
      return 'clicked';
    })()`,
    false,
  );
}

/** 恢复对话框（回收区的二段确认）是否出现，以及它的确认按钮。 */
export async function confirmRestoreDialog(t) {
  const has = await ev(t.tab, `!!document.querySelector('[data-trash-restore-confirm], .modal [data-trash-confirm-restore]')`, false);
  if (!has) return 'none';
  await ev(t.tab, `document.querySelector('[data-trash-restore-confirm], .modal [data-trash-confirm-restore]').click()`, false);
  await sleep(1200);
  return 'confirmed';
}
