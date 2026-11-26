import { newTab, ev, sleep, waitFor } from './cdp.mjs';
import fs from 'node:fs';

import { exitCodeFor, summarize } from './browser-verdict.mjs';

/*
 * 退出码只由**实际检查结果**决定（R2-04）：全部通过才 0，任一失败返回 1。
 * 之前无条件 `process.exit(0)`，失败会被门禁误判为成功。
 *
 * `--self-test` / `--self-test-pass` 只跑判定逻辑本身（不连 Chrome），
 * 供套件 99 验证"失败一定非零、通过一定为零"。
 */
if (process.argv.includes('--self-test') || process.argv.includes('--self-test-pass')) {
  const synthetic = process.argv.includes('--self-test-pass')
    ? { '合成-通过-1': true, '合成-通过-2': true }
    : { '合成-通过': true, '合成-失败': false };
  const verdict = summarize(synthetic);
  console.log(JSON.stringify({ ...verdict, exitCode: exitCodeFor(verdict.failed) }));
  process.exit(exitCodeFor(verdict.failed));
}

const APP = 'http://127.0.0.1:5278/';
const KEY = 'ws:trash-pending:v1';
const OP = 'op-r121r1-0001';
const OUT = 'C:/tmp/';
const RECORDER = `window.__storageEvents=[];window.addEventListener('storage',e=>window.__storageEvents.push({key:e.key,newValue:e.newValue===null?null:String(e.newValue).slice(0,80)}));`;

const result = { run: 'p2-02-r1.2.1-r1', at: new Date().toISOString(), checks: {}, detail: {} };
const check = (name, ok, detail) => {
  result.checks[name] = !!ok;
  if (detail !== undefined) result.detail[name] = detail;
  console.log(ok ? '  PASS' : '  FAIL', name, ok ? '' : JSON.stringify(detail));
};

async function openLive() {
  const { tab, targetId } = await newTab('about:blank');
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
  await tab.send('Page.navigate', { url: APP });
  await sleep(3200);
  await ev(tab, `[...document.querySelectorAll('button')].find(b=>b.innerText.includes('真实文件')).click()`);
  await waitFor(tab, `document.body.innerText.includes('冒烟项目')`, 12000, 'live workspace');
  return { tab, targetId };
}

async function openTrash(t) {
  await ev(t.tab, `[...document.querySelectorAll('button')].find(b=>b.innerText.includes('回收区')).click()`);
  await waitFor(t.tab, `document.querySelector('.trash')`, 8000, 'trash panel');
  await sleep(900);
}

const rowOf = (index) => `(() => {
  const item = document.querySelectorAll('.trash__item')[${index}];
  if (!item) return null;
  const btn = item.querySelector('.trash__actions button');
  return {
    name: item.querySelector('.trash__name')?.textContent ?? null,
    badge: item.querySelector('.trash__badge')?.textContent ?? null,
    note: item.querySelector('.trash__note')?.textContent ?? null,
    hasButton: !!btn,
    buttonDisabled: btn ? btn.disabled : null,
    rowCount: document.querySelectorAll('.trash__item').length,
  };
})()`;

const blockedText = `document.querySelector('.trash__hint--error[role="alert"]')?.textContent ?? null`;
const ledgerOf = (t) => ev(t.tab, `localStorage.getItem(${JSON.stringify(KEY)})`);
const eventsOf = (t) => ev(t.tab, `window.__storageEvents.slice()`);

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
  await sleep(1300);
}

async function shot(t, name) {
  const s = await t.tab.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT + name, Buffer.from(s.data, 'base64'));
}
async function close(t) { try { await t.tab.send('Target.closeTarget', { targetId: t.targetId }); } catch {} }

async function resetLedger() {
  const m = await newTab(APP);
  await sleep(1500);
  await ev(m.tab, `localStorage.removeItem(${JSON.stringify(KEY)})`);
  await close(m);
}

/* ================= 场景 A：removeItem ================= */
console.log('场景 A：removeItem');
{
  await resetLedger();
  const A = await openLive();
  const B = await openLive();
  await openTrash(A); await openTrash(B);

  const netA = await interceptRestore(A.tab);
  await clickRestore(A, 0, false);
  const ledger = await ledgerOf(A);
  check('A 一次 UNKNOWN 恢复后写下台账记录 X', typeof ledger === 'string' && ledger.includes(OP), ledger);
  const rowA = await ev(A.tab, rowOf(0));
  check('A 的行显示「待核对」且禁用恢复', rowA?.badge === '待核对' && rowA?.buttonDisabled === true, rowA);
  await sleep(700);
  const rowB = await ev(B.tab, rowOf(0));
  check('B 已同步到 X（行显示「待核对」）', rowB?.badge === '待核对', rowB);

  await ev(A.tab, `localStorage.removeItem(${JSON.stringify(KEY)})`);
  await sleep(900);

  const events = await eventsOf(B);
  const delEvent = events.find((e) => e.key === KEY && e.newValue === null);
  check('B 收到 storage 事件：key=台账、newValue=null', !!delEvent, events);

  const blocked = await ev(B.tab, blockedText);
  check('B 显示「被删除/失效」提示', typeof blocked === 'string' && /删除|失效/.test(blocked), blocked);
  const after = await ev(B.tab, rowOf(0));
  check('B 仍保留 X 的待核对状态', after?.badge === '待核对', after);
  check('B 的恢复按钮被关闭', after?.buttonDisabled === true, after);
  const raw = await ledgerOf(B);
  check('磁盘上的台账确实已被删除（没有重建）', raw === null, raw);

  const netB = await interceptRestore(B.tab);
  await clickRestore(B, 0, true);
  check('B 强制绕过 disabled 点击 → 0 次 POST', netB.posts === 0, netB.posts);
  check('A 全程只发出 1 次 POST', netA.posts === 1, netA.posts);

  await shot(B, '10-scenario-a-remove-item.png');
  result.detail.scenarioA = { ledger, rowA, events, blocked, after, postsA: netA.posts, postsB: netB.posts };
  await close(A); await close(B);
}

/* ================= 场景 B：localStorage.clear ================= */
console.log('场景 B：localStorage.clear');
{
  await resetLedger();
  const A = await openLive();
  const B = await openLive();
  await openTrash(A); await openTrash(B);
  const netA = await interceptRestore(A.tab);
  await clickRestore(A, 0, false);

  await ev(A.tab, `localStorage.clear()`);
  await sleep(900);

  const events = await eventsOf(B);
  const clearEvent = events.find((e) => e.key === null);
  check('B 收到 key === null 的 storage 事件（clear）', !!clearEvent, events);
  const blocked = await ev(B.tab, blockedText);
  check('clear 之后 B 也进入失效保护', typeof blocked === 'string' && /删除|失效/.test(blocked), blocked);
  const after = await ev(B.tab, rowOf(0));
  check('clear 之后 B 仍保留 X 的待核对状态', after?.badge === '待核对', after);

  const netB = await interceptRestore(B.tab);
  await clickRestore(B, 0, true);
  check('clear 之后强制点击 → 0 次 POST', netB.posts === 0, netB.posts);

  await shot(B, '20-scenario-b-clear.png');
  result.detail.scenarioB = { postsA: netA.posts, events, blocked, after, postsB: netB.posts };
  await close(A); await close(B);
}

/* ================= 场景 C：外部写入损坏数据 ================= */
console.log('场景 C：外部写入非法 JSON');
{
  await resetLedger();
  const A = await openLive();
  const B = await openLive();
  await openTrash(A); await openTrash(B);
  const netA = await interceptRestore(A.tab);
  await clickRestore(A, 0, false);

  const broken = '{"version":1,"records":[{"workspaceKey":';
  await ev(A.tab, `localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(broken)})`);
  await sleep(900);

  const blocked = await ev(B.tab, blockedText);
  check('B 进入「已损坏」并关闭恢复', typeof blocked === 'string' && /损坏/.test(blocked), blocked);
  const after = await ev(B.tab, rowOf(0));
  check('B 保留内存里的待核对记录', after?.badge === '待核对', after);
  const raw = await ledgerOf(B);
  check('B 没有覆盖原始损坏字节', raw === broken, raw);

  const netB = await interceptRestore(B.tab);
  await clickRestore(B, 0, true);
  check('损坏时强制点击 → 0 次 POST', netB.posts === 0, netB.posts);

  await shot(B, '30-scenario-c-corrupt.png');
  result.detail.scenarioC = { postsA: netA.posts, blocked, after, raw, postsB: netB.posts };
  await close(A); await close(B);
}

/* ================= 场景 D：exists 与 UI 镜像 ================= */
console.log('场景 D：exists 与镜像');
{
  await resetLedger();
  const A = await openLive();
  await openTrash(A);
  const netA = await interceptRestore(A.tab);
  await clickRestore(A, 0, false);
  const ledger = await ledgerOf(A);
  await close(A);

  await resetLedger();
  const B = await openLive();
  await openTrash(B);
  const beforeB = await ev(B.tab, rowOf(0));
  check('D 前提：B 启动时读到空台账 → 显示「可恢复」', beforeB?.badge === '可恢复', beforeB);

  await ev(B.tab, `localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(ledger)})`);
  await sleep(300);
  const staleB = await ev(B.tab, rowOf(0));
  check('D 前提：写盘之后 B 的界面仍是「可恢复」（镜像未同步）', staleB?.badge === '可恢复', staleB);

  const netB = await interceptRestore(B.tab);
  await clickRestore(B, 0, false);
  check('B 的 Controller 在锁内读到 X → 零 POST（exists 不是授权）', netB.posts === 0, netB.posts);
  const afterB = await ev(B.tab, rowOf(0));
  check('B 的界面立刻同步成「待核对」', afterB?.badge === '待核对', afterB);
  const hint = await ev(B.tab, `document.querySelector('.tree.trash')?.innerText.includes('还没确认') ?? false`);
  check('B 给出"上一次结果还没确认"的说明', hint === true, hint);

  await ev(B.tab, `window.dispatchEvent(new StorageEvent('storage', { key: ${JSON.stringify(KEY)}, newValue: localStorage.getItem(${JSON.stringify(KEY)}) }))`);
  await sleep(400);
  const afterEvent = await ev(B.tab, rowOf(0));
  check('后续 storage 事件不会让 B 的界面倒退', afterEvent?.badge === '待核对', afterEvent);
  check('后续 storage 事件也不会产生 POST', netB.posts === 0, netB.posts);

  await shot(B, '40-scenario-d-exists-mirror.png');
  result.detail.scenarioD = { ledger, beforeB, staleB, afterB, hint, afterEvent, postsA: netA.posts, postsB: netB.posts };
  await close(B);
}

const failed = summarize(result.checks).failed;
result.summary = summarize(result.checks);
console.log('\nSUMMARY', JSON.stringify(result.summary));
fs.writeFileSync(OUT + 'browser-verification-raw.json', JSON.stringify(result, null, 2));
process.exit(exitCodeFor(failed));
