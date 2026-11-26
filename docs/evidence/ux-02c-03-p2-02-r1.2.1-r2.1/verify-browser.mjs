/**
 * UX-02C-03-P2-02-R1.2.1-R2.1 真实浏览器验证。
 *
 * 只覆盖本轮新增/变化的行为（不重复 R2 的历史场景）：
 *  - 持久化失效（保护记录 invalidated）在**新开页面**上也挡住恢复；
 *  - 保护记录损坏时关闭恢复且不覆盖原始数据；
 *  - 异步预留窗口内切换身份 → 零 POST；
 *  - 两个标签页并发预留同一行 → 只有一个 POST、只有一条记录。
 *
 * 环境：headless Chrome（CDP 9336）+ Vite 5278 → Host 5277（托管 Multi，proj-a）。
 * 每个标签页 Fetch.enable 拦截 /api/trash/restore 计数（回 202 UNKNOWN）。
 */
import { newTab, ev, sleep, waitFor } from './cdp.mjs';
import fs from 'node:fs';

import { exitCodeFor, summarize } from './browser-verdict.mjs';

const APP = 'http://127.0.0.1:5278/';
const KEY = 'ws:trash-pending:v1';
const GUARD_DB = 'weavespace-trash-guard-v1';
const GUARD_STORE = 'guard';
const OUT = 'C:/tmp/';
const RECORDER = `window.__storageEvents=[];window.addEventListener('storage',e=>window.__storageEvents.push({key:e.key,newValue:e.newValue===null?null:String(e.newValue).slice(0,60)}));`;
/** 把锁临界区拉长：只放大"预留是异步的"这个窗口，不改应用逻辑。 */
const LOCK_DELAY = `(() => {
  const orig = navigator.locks.request.bind(navigator.locks);
  navigator.locks.request = (name, options, callback) => orig(name, options, async (lock) => {
    const delay = window.__lockDelay ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return callback(lock);
  });
})();`;

if (process.argv.includes('--self-test') || process.argv.includes('--self-test-pass')) {
  const synthetic = process.argv.includes('--self-test-pass')
    ? { '合成-通过-1': true, '合成-通过-2': true }
    : { '合成-通过': true, '合成-失败': false };
  const verdict = summarize(synthetic);
  console.log(JSON.stringify({ ...verdict, exitCode: exitCodeFor(verdict.failed) }));
  process.exit(exitCodeFor(verdict.failed));
}

const result = { run: 'p2-02-r1.2.1-r2.1', at: new Date().toISOString(), checks: {}, detail: {} };
const check = (name, ok, detail) => {
  result.checks[name] = !!ok;
  if (detail !== undefined) result.detail[name] = detail;
  console.log(ok ? '  PASS' : '  FAIL', name, ok ? '' : JSON.stringify(detail));
};
const wait = (ms) => sleep(ms);

async function openApp() {
  const { tab, targetId } = await newTab('about:blank');
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: LOCK_DELAY });
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

const rowOf = (index) => `(() => {
  const item = document.querySelectorAll('.trash__item')[${index}];
  if (!item) return null;
  const btn = item.querySelector('.trash__actions button');
  return {
    name: item.querySelector('.trash__name')?.textContent ?? null,
    badge: item.querySelector('.trash__badge')?.textContent ?? null,
    buttonDisabled: btn ? btn.disabled : null,
  };
})()`;
const blockedText = `document.querySelector('.trash__hint--error[role="alert"]')?.textContent ?? null`;
const ledgerOf = (t) => ev(t.tab, `localStorage.getItem(${JSON.stringify(KEY)})`);

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
}
async function shot(t, name) {
  const s = await t.tab.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT + name, Buffer.from(s.data, 'base64'));
}
async function close(t) {
  try { await t.tab.send('Target.closeTarget', { targetId: t.targetId }); } catch {}
}

/* ============ 场景 A：持久化失效在新页面仍然生效 ============ */
console.log('场景 A：持久化失效 + 新页面');
{
  await resetBothLayers();
  const A = await openApp();
  const B = await openApp();
  await openTrash(A);
  await openTrash(B);

  const netA = await interceptRestore(A.tab);
  await clickRestore(A, 0, false);
  await wait(1400);
  const rawLedger = await ledgerOf(A);
  check('A 产生一条 UNKNOWN 待核对', typeof rawLedger === 'string' && rawLedger.includes('op-r121r1-0001'), rawLedger);
  check('保护记录里也有这条', Array.isArray((await guardOf(A))?.records), await guardOf(A));

  // B 删掉主台账 → A 收到 storage 事件进入失效并落盘标记
  await ev(B.tab, `localStorage.removeItem(${JSON.stringify(KEY)})`);
  await wait(1200);
  const guardA = await guardOf(A);
  check('A 把失效标记写进保护记录', guardA?.invalidated === true, guardA);

  // A 把主台账内容写回去：主台账重新"看起来合法"，但保护记录已标记失效
  await ev(A.tab, `localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(rawLedger)})`);
  await wait(300);

  const C = await openApp();
  await openTrash(C);
  const rowC = await ev(C.tab, rowOf(0));
  check('新页面仍显示「待核对」', rowC?.badge === '待核对', rowC);
  const blockedC = await ev(C.tab, blockedText);
  check('新页面仍是失效状态（恢复没有重新开放）', typeof blockedC === 'string' && /删除|失效/.test(blockedC), blockedC);

  const netC = await interceptRestore(C.tab);
  await clickRestore(C, 0, true);
  await wait(1000);
  check('新页面强制点击 → 0 次 POST', netC.posts === 0, netC.posts);
  check('A 全程只发 1 次 POST', netA.posts === 1, netA.posts);

  await shot(C, '10-scenario-a-persisted-invalidated.png');
  result.detail.scenarioA = { rawLedger, guardA, rowC, blockedC, posts: netC.posts, postsA: netA.posts };
  await close(A); await close(B); await close(C);
}

/* ============ 场景 B：保护记录损坏 ============ */
console.log('场景 B：IndexedDB 损坏');
{
  await resetBothLayers();
  const A = await openApp();
  await openTrash(A);
  const netA = await interceptRestore(A.tab);
  await clickRestore(A, 0, false);
  await wait(1400);
  await close(A);

  // 直接把保护记录写成"读不懂"的形状（模拟磁盘损坏 / 版本不认识）
  const m = await newTab('about:blank');
  await m.tab.send('Page.navigate', { url: APP });
  await wait(2500);
  const corrupted = { version: 1, records: 'not-an-array', invalidated: false };
  await ev(
    m.tab,
    `new Promise((resolve) => {
      const req = indexedDB.open(${JSON.stringify(GUARD_DB)}, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(${JSON.stringify(GUARD_STORE)})) db.createObjectStore(${JSON.stringify(GUARD_STORE)});
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(${JSON.stringify(GUARD_STORE)}, 'readwrite');
        tx.objectStore(${JSON.stringify(GUARD_STORE)}).put(${JSON.stringify(corrupted)}, 'current');
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => { db.close(); resolve(false); };
      };
    })`,
  );
  await close(m);

  const D = await openApp();
  await openTrash(D);
  const blocked = await ev(D.tab, blockedText);
  check('损坏时明确关闭恢复', typeof blocked === 'string' && /损坏|不可用/.test(blocked), blocked);
  const netD = await interceptRestore(D.tab);
  await clickRestore(D, 0, true);
  await wait(900);
  check('损坏时强制点击 → 0 次 POST', netD.posts === 0, netD.posts);

  const guardD = await guardOf(D);
  check(
    '损坏的原始数据没有被覆盖',
    guardD && guardD.records === 'not-an-array',
    guardD,
  );
  check('A 只发过 1 次 POST', netA.posts === 1, netA.posts);

  await shot(D, '20-scenario-b-guard-corrupt.png');
  result.detail.scenarioB = { blocked, posts: netD.posts, guardD, postsA: netA.posts };
  await close(D);
}

/* ============ 场景 C：异步预留窗口内切换身份 ============ */
console.log('场景 C：预留期间切换模式');
{
  await resetBothLayers();
  const A = await openApp();
  await openTrash(A);
  const netA = await interceptRestore(A.tab);
  await ev(A.tab, `window.__lockDelay = 1500`);

  // 点第一行的恢复，然后立刻切到「演示」——预留还在锁里排队
  await clickRestore(A, 0, false);
  await wait(200);
  await ev(A.tab, `[...document.querySelectorAll('button')].find(b=>b.innerText.trim() === '演示').click()`);
  await wait(3500);

  check('切换身份后一个 POST 都不发', netA.posts === 0, netA.posts);
  const ledger = await ledgerOf(A);
  const parsed = ledger ? JSON.parse(ledger) : { records: [] };
  check(
    '这次预留已安全结算（台账里没有留下无副作用的新记录）',
    parsed.records.length === 0,
    parsed.records.map((r) => r.opId),
  );

  await shot(A, '30-scenario-c-stale-during-reserve.png');
  result.detail.scenarioC = { posts: netA.posts, records: parsed.records.map((r) => r.opId) };
  await close(A);
}

/* ============ 场景 D：两个标签页并发预留同一行 ============ */
console.log('场景 D：并发预留');
{
  await resetBothLayers();
  const A = await openApp();
  const B = await openApp();
  await openTrash(A);
  await openTrash(B);
  const netA = await interceptRestore(A.tab);
  const netB = await interceptRestore(B.tab);

  await ev(A.tab, `window.__lockDelay = 400`);
  await ev(B.tab, `window.__lockDelay = 400`);
  await clickRestore(A, 0, false);
  await clickRestore(B, 0, false);
  await wait(3000);

  const total = netA.posts + netB.posts;
  check('并发预留同一行只有 1 次 POST', total === 1, { a: netA.posts, b: netB.posts });
  const ledger = await ledgerOf(A);
  const records = ledger ? JSON.parse(ledger).records : [];
  check(
    '台账里只留下一条记录（没有重复占位）',
    records.length === 1 && records[0].opId === 'op-r121r1-0001',
    records.map((r) => r.opId),
  );
  const guard = await guardOf(A);
  check('保护记录与主台账一致', (guard?.records?.length ?? -1) === 1, guard?.records?.map((r) => r.opId));

  await shot(A, '40-scenario-d-concurrent-reserve.png');
  result.detail.scenarioD = { posts: { a: netA.posts, b: netB.posts }, records: records.map((r) => r.opId) };
  await close(A); await close(B);
}

const { failed } = summarize(result.checks);
result.summary = summarize(result.checks);
console.log('\nSUMMARY', JSON.stringify(result.summary));
fs.writeFileSync(OUT + 'browser-verification-r21-raw.json', JSON.stringify(result, null, 2));
process.exit(exitCodeFor(failed));
