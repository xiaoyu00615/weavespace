/**
 * UX-02C-03-P2-02-R1.2.1-R2 真实浏览器验证（两个同源标签页 + 真实 IndexedDB）。
 *
 * 环境：headless Chrome（CDP 9335）+ Vite 5278 → Host 5277（托管 Multi，proj-a）。
 * 每个标签页各自 `Fetch.enable` 拦截 `/api/trash/restore`，计数并回 202 UNKNOWN——
 * POST 计数就是"真实副作用请求次数"。
 *
 * 与 R1 不同的关键点：台账的耐久保护记录在 IndexedDB 里，所以
 * 「删 localStorage → 刷新 → 仍无效」才是本轮真正要证明的东西。
 */
import { newTab, ev, sleep, waitFor } from './cdp.mjs';
import fs from 'node:fs';

import { exitCodeFor, summarize } from './browser-verdict.mjs';

const APP = 'http://127.0.0.1:5278/';
const KEY = 'ws:trash-pending:v1';
const GUARD_DB = 'weavespace-trash-guard-v1';
const GUARD_STORE = 'guard';
const OUT = 'C:/tmp/';
const RECORDER = `window.__storageEvents=[];window.addEventListener('storage',e=>window.__storageEvents.push({key:e.key,newValue:e.newValue===null?null:String(e.newValue).slice(0,80)}));`;

if (process.argv.includes('--self-test') || process.argv.includes('--self-test-pass')) {
  const synthetic = process.argv.includes('--self-test-pass')
    ? { '合成-通过-1': true, '合成-通过-2': true }
    : { '合成-通过': true, '合成-失败': false };
  const verdict = summarize(synthetic);
  console.log(JSON.stringify({ ...verdict, exitCode: exitCodeFor(verdict.failed) }));
  process.exit(exitCodeFor(verdict.failed));
}

const result = { run: 'p2-02-r1.2.1-r2', at: new Date().toISOString(), checks: {}, detail: {} };
const check = (name, ok, detail) => {
  result.checks[name] = !!ok;
  if (detail !== undefined) result.detail[name] = detail;
  console.log(ok ? '  PASS' : '  FAIL', name, ok ? '' : JSON.stringify(detail));
};

const wait = (ms) => sleep(ms);

async function openApp(options = {}) {
  const { tab, targetId } = await newTab('about:blank');
  if (options.blockIdb) {
    await tab.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { indexedDB.open = () => { throw new Error('blocked by policy (验证用)'); }; } catch (e) {}`,
    });
  }
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
  await tab.send('Page.navigate', { url: APP });
  await wait(3400);
  await ev(tab, `[...document.querySelectorAll('button')].find(b=>b.innerText.includes('真实文件')).click()`);
  await waitFor(tab, `document.body.innerText.includes('冒烟项目')`, 12000, 'live workspace');
  return { tab, targetId };
}

async function openTrash(t) {
  await ev(t.tab, `[...document.querySelectorAll('button')].find(b=>b.innerText.includes('回收区')).click()`);
  await waitFor(t.tab, `document.querySelector('.trash')`, 8000, 'trash panel');
  await wait(900);
}

async function reload(t) {
  await t.tab.send('Page.reload');
  await wait(3400);
  await ev(t.tab, `[...document.querySelectorAll('button')].find(b=>b.innerText.includes('真实文件')).click()`);
  await waitFor(t.tab, `document.body.innerText.includes('冒烟项目')`, 12000, 'live workspace after reload');
  await openTrash(t);
}

const rowOf = (index) => `(() => {
  const item = document.querySelectorAll('.trash__item')[${index}];
  if (!item) return null;
  const btn = item.querySelector('.trash__actions button');
  return {
    name: item.querySelector('.trash__name')?.textContent ?? null,
    badge: item.querySelector('.trash__badge')?.textContent ?? null,
    buttonDisabled: btn ? btn.disabled : null,
    rowCount: document.querySelectorAll('.trash__item').length,
  };
})()`;

const blockedText = `document.querySelector('.trash__hint--error[role="alert"]')?.textContent ?? null`;
const ledgerOf = (t) => ev(t.tab, `localStorage.getItem(${JSON.stringify(KEY)})`);
const eventsOf = (t) => ev(t.tab, `window.__storageEvents.slice()`);

/** 直接读保护记录（IndexedDB），用来证明它不是 React state 里的临时标记。 */
const guardOf = (t) =>
  ev(
    t.tab,
    `new Promise((resolve) => {
      const req = indexedDB.open(${JSON.stringify(GUARD_DB)}, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(${JSON.stringify(GUARD_STORE)})) db.createObjectStore(${JSON.stringify(GUARD_STORE)});
      };
      req.onerror = () => resolve({ error: 'open' });
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(${JSON.stringify(GUARD_STORE)}, 'readonly');
        const g = tx.objectStore(${JSON.stringify(GUARD_STORE)}).get('current');
        g.onsuccess = () => { resolve(g.result ?? null); db.close(); };
        g.onerror = () => { resolve({ error: 'get' }); db.close(); };
      };
    })`,
  );

/** 维护页：清空两层（不属于被测页面）。真正的清除必须同时动 IndexedDB，否则上一场会串味。 */
async function resetBothLayers() {
  const m = await newTab('about:blank');
  await m.tab.send('Page.navigate', { url: APP });
  await wait(2500);
  await ev(
    m.tab,
    `new Promise((resolve) => {
      localStorage.removeItem(${JSON.stringify(KEY)});
      const req = indexedDB.open(${JSON.stringify(GUARD_DB)}, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(${JSON.stringify(GUARD_STORE)})) db.createObjectStore(${JSON.stringify(GUARD_STORE)});
      };
      req.onerror = () => resolve(false);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(${JSON.stringify(GUARD_STORE)}, 'readwrite');
        tx.objectStore(${JSON.stringify(GUARD_STORE)}).put({ version: 1, records: [], invalidated: false }, 'current');
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => { db.close(); resolve(false); };
      };
    })`,
  );
  await close(m);
}

async function interceptRestore(tab) {
  const state = { posts: 0, bodies: [] };
  tab.on('Fetch.requestPaused', async (p) => {
    state.posts += 1;
    state.bodies.push(p.request.postData ?? null);
    const body = Buffer.from(JSON.stringify({ status: 'UNKNOWN', message: '结果未确认（验证用：请求已被拦截）' })).toString('base64');
    try {
      await tab.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: 202,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body,
      });
    } catch {}
  });
  await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/trash/restore*', requestStage: 'Request' }] });
  return state;
}

async function clickRestore(t, index, force) {
  await ev(t.tab, `(() => {
    const item = document.querySelectorAll('.trash__item')[${index}];
    const btn = item.querySelector('.trash__actions button');
    ${force ? 'btn.disabled = false; btn.removeAttribute("disabled");' : ''}
    btn.click();
    return true;
  })()`);
  await wait(1300);
}

async function shot(t, name) {
  const s = await t.tab.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT + name, Buffer.from(s.data, 'base64'));
}
async function close(t) {
  try {
    await t.tab.send('Target.closeTarget', { targetId: t.targetId });
  } catch {}
}

/** A 页面真实发起一次恢复（被拦成 202 UNKNOWN）→ 两层都写下同一条待核对。 */
async function makeUnknown(t) {
  const net = await interceptRestore(t.tab);
  await clickRestore(t, 0, false);
  const ledger = await ledgerOf(t);
  const guard = await guardOf(t);
  return { net, ledger, guard };
}

/* ================= 场景 A：removeItem → 刷新仍然失效 ================= */
console.log('场景 A：removeItem + 刷新');
{
  await resetBothLayers();
  const A = await openApp();
  const B = await openApp();
  await openTrash(A);
  await openTrash(B);

  const made = await makeUnknown(A);
  check('A 一次 UNKNOWN 恢复后两层都有 X', typeof made.ledger === 'string' && made.ledger.includes('op-r121r1-0001'), made.ledger);
  check(
    'A 的保护记录（IndexedDB）里也有 X',
    Array.isArray(made.guard?.records) && made.guard.records.some((r) => r.opId === 'op-r121r1-0001'),
    made.guard,
  );

  await wait(700);
  const rowB = await ev(B.tab, rowOf(0));
  check('B 打开时就同步到 X', rowB?.badge === '待核对', rowB);

  await ev(A.tab, `localStorage.removeItem(${JSON.stringify(KEY)})`);
  await wait(900);

  const eventsB = await eventsOf(B);
  check('B 收到 newValue=null 的删除事件', eventsB.some((e) => e.key === KEY && e.newValue === null), eventsB);
  const blockedB = await ev(B.tab, blockedText);
  check('B 显示失效提示', typeof blockedB === 'string' && /删除|失效/.test(blockedB), blockedB);
  const guardB = await guardOf(B);
  check('失效标记已落到 B 的保护记录里', guardB?.invalidated === true, guardB);

  await reload(B);
  const rowAfterReload = await ev(B.tab, rowOf(0));
  check('刷新后仍显示「待核对」（记录没丢）', rowAfterReload?.badge === '待核对', rowAfterReload);
  const blockedAfterReload = await ev(B.tab, blockedText);
  check('刷新后仍是失效状态（恢复没有重新开放）', typeof blockedAfterReload === 'string' && /删除|失效/.test(blockedAfterReload), blockedAfterReload);

  const netB = await interceptRestore(B.tab);
  await clickRestore(B, 0, true);
  check('刷新后强制点击 → 0 次 POST', netB.posts === 0, netB.posts);
  check('A 全程只有 1 次 POST（拦截回 202）', made.net.posts === 1, made.net.posts);

  await shot(B, '10-scenario-a-removeitem-after-reload.png');
  result.detail.scenarioA = { ledger: made.ledger, guard: made.guard, eventsB, blockedAfterReload, rowAfterReload, posts: netB.posts };
  await close(A);
  await close(B);
}

/* ================= 场景 B：clear → 新开页面仍然失效 ================= */
console.log('场景 B：clear + 重新打开页面');
{
  await resetBothLayers();
  const A = await openApp();
  await openTrash(A);
  const made = await makeUnknown(A);

  await ev(A.tab, `localStorage.clear()`);
  await wait(400);
  await close(A);

  // 重新打开一个全新的页面（不是刷新）：只能靠 IndexedDB 里的保护记录
  const C = await openApp();
  await openTrash(C);
  const rowC = await ev(C.tab, rowOf(0));
  check('重新打开页面后仍显示「待核对」', rowC?.badge === '待核对', rowC);
  const blockedC = await ev(C.tab, blockedText);
  check('重新打开页面后仍是失效状态', typeof blockedC === 'string' && /删除|失效/.test(blockedC), blockedC);

  const netC = await interceptRestore(C.tab);
  await clickRestore(C, 0, true);
  check('重新打开页面后强制点击 → 0 次 POST', netC.posts === 0, netC.posts);
  check('主台账没有被自动重建', (await ledgerOf(C)) === null, await ledgerOf(C));

  await shot(C, '20-scenario-b-clear-reopen.png');
  result.detail.scenarioB = { posts: netC.posts, blockedC, rowC, ledger: await ledgerOf(C) };
  await close(C);
}

/* ================= 场景 C：连续写入 + 删除（事件竞争） ================= */
console.log('场景 C：连续 setItem → removeItem');
{
  await resetBothLayers();
  const A = await openApp();
  const B = await openApp();
  await openTrash(A);
  await openTrash(B);
  const made = await makeUnknown(A);
  await wait(600);

  // A 连续两次写：先写一条新的，再整条删掉（B 可能还没来得及处理第一个事件）
  await ev(
    A.tab,
    `(() => {
      const raw = localStorage.getItem(${JSON.stringify(KEY)});
      const body = JSON.parse(raw);
      body.records.push({ workspaceKey: body.records[0].workspaceKey, projectId: body.records[0].projectId, opId: 'op-race-second-1', createdAt: '2026-11-26T00:00:00.000Z' });
      localStorage.setItem(${JSON.stringify(KEY)}, JSON.stringify(body));
      localStorage.removeItem(${JSON.stringify(KEY)});
      return true;
    })()`,
  );
  await wait(1200);

  const events = await eventsOf(B);
  const rowAfter = await ev(B.tab, rowOf(0));
  check('竞争之后 B 仍保留 X', rowAfter?.badge === '待核对', rowAfter);
  const blocked = await ev(B.tab, blockedText);
  check('竞争之后 B 进入失效（不会停在"可恢复"）', typeof blocked === 'string' && /删除|失效/.test(blocked), blocked);

  const netB = await interceptRestore(B.tab);
  await clickRestore(B, 0, true);
  check('竞争之后强制点击 → 0 次 POST', netB.posts === 0, netB.posts);

  await reload(B);
  const rowReload = await ev(B.tab, rowOf(0));
  check('竞争之后刷新仍「待核对」', rowReload?.badge === '待核对', rowReload);

  await shot(B, '30-scenario-c-race.png');
  result.detail.scenarioC = { events, rowAfter, blocked, rowReload, posts: netB.posts, upstream: made.net.posts };
  await close(A);
  await close(B);
}

/* ================= 场景 D：保护存储不可用 → fail-closed ================= */
console.log('场景 D：IndexedDB 不可用');
{
  await resetBothLayers();
  const A = await openApp();
  await openTrash(A);
  const made = await makeUnknown(A);
  await close(A);

  const D = await openApp({ blockIdb: true });
  await openTrash(D);
  const blocked = await ev(D.tab, blockedText);
  check('保护记录不可用时明确关闭恢复', typeof blocked === 'string' && /不可用|保护记录/.test(blocked), blocked);

  const netD = await interceptRestore(D.tab);
  await clickRestore(D, 0, true);
  check('保护记录不可用时强制点击 → 0 次 POST', netD.posts === 0, netD.posts);

  await shot(D, '40-scenario-d-guard-unavailable.png');
  result.detail.scenarioD = { blocked, posts: netD.posts, upstream: made.net.posts };
  await close(D);
}

const { failed } = summarize(result.checks);
result.summary = summarize(result.checks);
console.log('\nSUMMARY', JSON.stringify(result.summary));
fs.writeFileSync(OUT + 'browser-verification-r2-raw.json', JSON.stringify(result, null, 2));
process.exit(exitCodeFor(failed));
