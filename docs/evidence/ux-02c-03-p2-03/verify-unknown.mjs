/**
 * UX-02C-03-P2-03 阶段 B4：UNKNOWN 完整链路（真实 Host + 真实磁盘）。
 *
 * 三个场景必须分开，因为"没到 Host"和"到了 Host 但响应丢了"在产品上完全不同：
 *
 * | 场景 | 手段 | 磁盘事实 |
 * | --- | --- | --- |
 * | 一 请求没到 Host | CDP `Fetch.failRequest`（**故障注入**） | 文件仍在回收区，原位置仍为空 |
 * | 二 Host 已执行、响应丢失 | CDP 在 **Response 阶段** `failRequest`（**故障注入**） | 文件已回到原位置 |
 * | 三 Host 返回 UNKNOWN / 列表刷不出来 | 用 202 UNKNOWN 回执 + 让列表 500（**故障注入**） | 不动盘 |
 *
 * 每种注入都在报告里标 `injected: true`，不冒充"正常路径"。
 */
import { existsSync } from 'node:fs';

import { ev, sleep } from './cdp.mjs';
import {
  PROJECT_A,
  ROOT_A,
  closeTab,
  createReport,
  openApp,
  openTrash,
  removeViaUi,
  restoreRow,
  sha256,
  trashRows,
  trashList,
  LEDGER_KEY,
} from './helpers.mjs';

const { result, check, section, summarize } = createReport('ux-02c-03-p2-03-unknown');
const mark = (name, how) => {
  result.injected.push({ check: name, how });
};

/** 当前台账记录（真实 localStorage）。 */
async function ledger(t) {
  const raw = await ev(t.tab, `localStorage.getItem(${JSON.stringify(LEDGER_KEY)})`, false);
  if (raw === null) return [];
  try {
    return JSON.parse(raw).records ?? [];
  } catch {
    return null;
  }
}

async function guardRecords(t) {
  return await ev(
    t.tab,
    `(async () => new Promise((resolve) => {
      const req = indexedDB.open('weavespace-trash-guard-v1');
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('guard')) { resolve(null); return; }
        const g = db.transaction('guard','readonly').objectStore('guard').get('current');
        g.onsuccess = () => resolve(g.result ?? null);
        g.onerror = () => resolve(null);
      };
      req.onerror = () => resolve(null);
      setTimeout(() => resolve(null), 3000);
    }))()`,
  );
}

/** 拦截 `/api/trash/restore`：`mode=fail-request` / `fail-response` / `unknown-202`。 */
async function interceptRestore(t, mode) {
  const state = { posts: 0, bodies: [] };
  t.tab.on('Fetch.requestPaused', async (p) => {
    const isRestore = /\/api\/trash\/restore/.test(p.request.url);
    if (!isRestore) {
      try {
        await t.tab.send('Fetch.continueRequest', { requestId: p.requestId });
      } catch {}
      return;
    }
    state.posts += 1;
    state.bodies.push(p.request.postData ?? null);
    try {
      if (mode === 'fail-response' && p.responseStatusCode) {
        // 响应阶段：Host 已经把磁盘事务做完了，这里只把回执掐掉
        await t.tab.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionReset' });
        return;
      }
      if (mode === 'unknown-202') {
        const body = Buffer.from(
          JSON.stringify({ status: 'UNKNOWN', projectId: PROJECT_A, opId: 'op-injected', message: '结果未确认' }),
        ).toString('base64');
        await t.tab.send('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: 202,
          responseHeaders: [{ name: 'content-type', value: 'application/json' }],
          body,
        });
        return;
      }
      await t.tab.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionFailed' });
    } catch {}
  });
  await t.tab.send('Fetch.enable', {
    patterns: [
      {
        urlPattern: '*/api/trash/restore*',
        requestStage: mode === 'fail-response' ? 'Response' : 'Request',
      },
    ],
  });
  return state;
}

async function stopIntercept(t) {
  try {
    await t.tab.send('Fetch.disable');
  } catch {}
}

/* ================================================================== */
const t = await openApp({ fresh: true });

section('B4-场景一 · 请求没有到达 Host（副作用为零）');
{
  const target = 'note.md';
  const before = sha256(`${ROOT_A}/${target}`);
  await removeViaUi(t, target);
  const { body } = await trashList(PROJECT_A);
  const entry = (body.entries ?? []).find((item) => item.path === target && item.state === 'stored');
  check('B4-1 前提：文件已在回收区', !!entry, entry);

  const net = await interceptRestore(t, 'fail-request');
  mark('B4 场景一', 'CDP 在 Request 阶段 failRequest（请求未到达 Host）');
  await openTrash(t);
  await restoreRow(t, target);
  await sleep(2500);

  check('B4-2 只尝试了一次恢复 POST', net.posts === 1, net);
  check('B4-3 磁盘没有变化：原位置仍为空', !existsSync(`${ROOT_A}/${target}`));
  check('B4-4 磁盘没有变化：payload 仍在回收区', (await trashList(PROJECT_A)).body.entries.find((item) => item.opId === entry.opId)?.state === 'stored');

  const rows = await trashRows(t);
  const row = rows.find((item) => item.name === target);
  check('B4-5 界面进入「待核对」而不是「失败」', row?.badge === '待核对', row);
  check('B4-6 「待核对」时恢复按钮关闭', row?.hasButton === false || row?.buttonDisabled === true, row);
  check(
    'B4-7 台账写入了一条待核对记录',
    (await ledger(t))?.length === 1 && (await ledger(t))[0].opId === entry.opId,
    await ledger(t),
  );
  check(
    'B4-8 保护记录也写了同一笔（跨刷新可用）',
    (await guardRecords(t))?.records?.length === 1,
    await guardRecords(t),
  );

  // 不自动重发：再点一次（强制）仍然零 POST
  const before2 = net.posts;
  await restoreRow(t, target, { force: true });
  await sleep(1500);
  check('B4-9 待核对期间强制点击不会重发副作用请求', net.posts === before2, { before: before2, after: net.posts });

  // 刷新页面后仍然保持
  await stopIntercept(t);
  await t.tab.send('Page.reload');
  await sleep(4000);
  await openTrash(t);
  const afterReload = (await trashRows(t)).find((item) => item.name === target);
  check('B4-10 重载页面后仍显示「待核对」', afterReload?.badge === '待核对', afterReload);

  // 用一次成功列表读取收敛（记录已不在可恢复集合里）
  await ev(t.tab, `document.querySelector('[aria-label="刷新回收区"]')?.click()`, false);
  await sleep(2200);
  check('B4-11 拿到终态结论（stored）后记录不收敛（它确实还没结论）', (await ledger(t))?.length === 1, await ledger(t));
  result.detail['场景一'] = { target, hash: before, posts: net.posts, ledger: await ledger(t) };
}

section('B4-场景二 · Host 已执行磁盘事务，但客户端收不到响应');
{
  await stopIntercept(t);
  await ev(t.tab, `document.querySelector('[aria-label="返回项目"]')?.click()`, false);
  await sleep(1200);

  const target = 'plain.txt';
  const original = sha256(`${ROOT_A}/${target}`);
  await removeViaUi(t, target);
  const { body } = await trashList(PROJECT_A);
  const entry = (body.entries ?? []).find((item) => item.path === target && item.state === 'stored');
  check('B4-12 前提：文件已在回收区', !!entry, entry);

  const net = await interceptRestore(t, 'fail-response');
  mark('B4 场景二', 'CDP 在 Response 阶段 failRequest（Host 已执行，回执丢失）');
  await openTrash(t);
  await restoreRow(t, target);
  await sleep(3000);

  // 磁盘事实：Host 真的做完了
  check('B4-13 原文件真的回到了原位置（磁盘事实）', existsSync(`${ROOT_A}/${target}`), `${ROOT_A}/${target}`);
  check('B4-14 恢复后的内容哈希与原始一致', sha256(`${ROOT_A}/${target}`) === original, {
    original,
    restored: sha256(`${ROOT_A}/${target}`),
  });
  const hostState = (await trashList(PROJECT_A)).body.entries.find((item) => item.opId === entry.opId)?.state;
  check('B4-15 Host 记录已是 restored（不是 stored）', hostState === 'restored', hostState);

  /*
   * 响应丢了不等于结论没了：控制器会拿 opId 去**只读核对**（`GET /api/trash/op`），
   * Host 已经执行过，核对就会给出 `restored`。这是正确路径——真正的错误是把网络失败
   * 当成"磁盘失败"或者干脆重发一次 POST。
   */
  const row = (await trashRows(t)).find((item) => item.name === target);
  check('B4-16 客户端经只读核对收敛为「已恢复」，没有误报失败', row?.badge === '已恢复', row);
  const records = await ledger(t);
  check(
    'B4-17 终态结论成立后台账释放这条（不留假的待核对）',
    !records.some((item) => item.opId === entry.opId),
    { records, row },
  );
  check('B4-18 仍然只发出一次 POST（响应丢失没有触发重发）', net.posts === 1, net);

  // 收敛：成功列表读取 → 记录已是 restored 终态 → 台账释放
  await stopIntercept(t);
  await ev(t.tab, `document.querySelector('[aria-label="刷新回收区"]')?.click()`, false);
  await sleep(2500);
  const after = (await trashRows(t)).find((item) => item.name === target);
  check('B4-19 一次成功列表读取后收敛为「已恢复」', after?.badge === '已恢复', after);
  check(
    'B4-20 收敛后台账不再保留这条',
    !(await ledger(t))?.some((item) => item.opId === entry.opId),
    await ledger(t),
  );
  result.detail['场景二'] = { target, original, posts: net.posts, hostState };
}

section('B4-场景三 · Host 返回 UNKNOWN / 列表暂时无法刷新');
{
  await stopIntercept(t);
  await ev(t.tab, `document.querySelector('[aria-label="返回项目"]')?.click()`, false);
  await sleep(1200);

  const target = 'blob.bin';
  const original = sha256(`${ROOT_A}/${target}`);
  await removeViaUi(t, target);
  const { body } = await trashList(PROJECT_A);
  const entry = (body.entries ?? []).find((item) => item.path === target && item.state === 'stored');

  const net = await interceptRestore(t, 'unknown-202');
  mark('B4 场景三', 'CDP 把回执替换成 202 UNKNOWN（Host 未执行磁盘事务）');
  await openTrash(t);
  await restoreRow(t, target);
  await sleep(2600);

  check('B4-21 只发出一次 POST', net.posts === 1, net);
  check('B4-22 202 UNKNOWN 时磁盘未被改动', !existsSync(`${ROOT_A}/${target}`));
  const row = (await trashRows(t)).find((item) => item.name === target);
  check('B4-23 界面保持「待核对」', row?.badge === '待核对', row);
  check(
    'B4-24 台账保留这条（待核对跨会话可用）',
    (await ledger(t))?.some((item) => item.opId === entry.opId),
    await ledger(t),
  );

  // 列表暂时无法刷新：把 GET /api/trash 打成 500
  await stopIntercept(t);
  t.tab.on('Fetch.requestPaused', async (p) => {
    try {
      if (/\/api\/trash\?/.test(p.request.url)) {
        await t.tab.send('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: 500,
          responseHeaders: [{ name: 'content-type', value: 'application/json' }],
          body: Buffer.from(JSON.stringify({ status: 'REJECTED', errorCode: 'ERR_INJECTED', message: '注入：列表读取失败' })).toString('base64'),
        });
        return;
      }
      await t.tab.send('Fetch.continueRequest', { requestId: p.requestId });
    } catch {}
  });
  await t.tab.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/trash?*', requestStage: 'Request' }] });
  mark('B4 场景三', 'CDP 让 GET /api/trash 返回 500（列表暂时无法刷新）');
  await ev(t.tab, `document.querySelector('[aria-label="刷新回收区"]')?.click()`, false);
  await sleep(2500);
  check(
    'B4-25 列表读取失败不构成结论：台账记录不被清除',
    (await ledger(t))?.some((item) => item.opId === entry.opId),
    await ledger(t),
  );

  await stopIntercept(t);
  await ev(t.tab, `document.querySelector('[aria-label="刷新回收区"]')?.click()`, false);
  await sleep(2500);
  const after = (await trashRows(t)).find((item) => item.name === target);
  check('B4-26 列表恢复后仍是「待核对」（Host 从未执行）', after?.badge === '待核对', after);
  check('B4-27 文件仍在回收区、未回到原位置', !existsSync(`${ROOT_A}/${target}`));
  result.detail['场景三'] = { target, original, posts: net.posts };
}

await stopIntercept(t);
await closeTab(t);
const summary = summarize();
const { writeFileSync } = await import('node:fs');
writeFileSync(new URL('./unknown-raw.json', import.meta.url), JSON.stringify(result, null, 2));
process.exit(summary.failed.length > 0 ? 1 : 0);
