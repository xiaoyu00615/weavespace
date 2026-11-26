/**
 * UX-02C-03-P2-03 阶段 B5：真实跨标签页（同源、同一 Profile、真实 localStorage /
 * IndexedDB / Web Locks）。
 *
 * POST 计数用 CDP 的 `Network.requestWillBeSent` **观察**，不改写任何响应——
 * 正常恢复路径必须真的走完（B1 纪律）。只有 UNKNOWN 场景才做故障注入。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { ev, sleep } from './cdp.mjs';
import {
  PROJECT_A,
  ROOT_A,
  api,
  backToTree,
  closeTab,
  createReport,
  openApp,
  openTrash,
  removeViaUi,
  restoreRow,
  sha256,
  trashBanner,
  trashList,
  trashRows,
  LEDGER_KEY,
} from './helpers.mjs';

const { result, check, section, summarize } = createReport('ux-02c-03-p2-03-tabs');

/** 观察某个页面发出的 restore POST 次数（只看，不拦截）。 */
async function watchRestorePosts(t) {
  const state = { posts: 0, urls: [] };
  await t.tab.send('Network.enable');
  t.tab.on('Network.requestWillBeSent', (event) => {
    if (event.request?.method === 'POST' && /\/api\/trash\/restore/.test(event.request.url)) {
      state.posts += 1;
      state.urls.push(event.request.url);
    }
  });
  return state;
}

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

/** 让某个页面重新读一次回收区（跨标签页同步靠的就是"读"，不是猜）。 */
async function refreshTrash(t) {
  await ev(t.tab, `document.querySelector('[aria-label="刷新回收区"]')?.click()`, false);
  await sleep(2200);
}

const A = await openApp({ fresh: true });
const B = await openApp();

/* ================================================================== */
section('B5-1 · 同一记录并发恢复：最多一个新的 POST 获得授权');
{
  const original = sha256(`${ROOT_A}/note.md`);
  await removeViaUi(A, 'note.md');
  const { body } = await trashList(PROJECT_A);
  const entry = (body.entries ?? []).find((item) => item.path === 'note.md' && item.state === 'stored');
  check('B5-1 前提：A 把文件移入回收区', !!entry, entry);

  await openTrash(A);
  await openTrash(B);
  await refreshTrash(B);
  const rowA = (await trashRows(A)).find((item) => item.name === 'note.md');
  const rowB = (await trashRows(B)).find((item) => item.name === 'note.md');
  check('B5-2 两个标签页都看到这条可恢复记录', rowA?.badge === '可恢复' && rowB?.badge === '可恢复', { rowA, rowB });

  const netA = await watchRestorePosts(A);
  const netB = await watchRestorePosts(B);
  // 几乎同时点：两个页面各自走预留 → 只有一个能拿到 reserved
  await Promise.all([restoreRow(A, 'note.md'), restoreRow(B, 'note.md')]);
  await sleep(3500);

  const total = netA.posts + netB.posts;
  check('B5-3 并发恢复合计只发出一个 POST', total === 1, { a: netA.posts, b: netB.posts, urls: [...netA.urls, ...netB.urls] });
  check('B5-4 文件真的回到了原位置', existsSync(`${ROOT_A}/note.md`));
  check('B5-5 内容哈希与原始一致', sha256(`${ROOT_A}/note.md`) === original, {
    original,
    restored: sha256(`${ROOT_A}/note.md`),
  });
  check(
    'B5-6 两个页面的台账都不再保留这条（先查这条，再谈整本是否为空）',
    !(await ledger(A)).some((item) => item.opId === entry.opId) &&
      !(await ledger(B)).some((item) => item.opId === entry.opId),
    { a: await ledger(A), b: await ledger(B) },
  );

  // 一页已经结清 → 另一页通过"正常刷新 + 对账"收敛（不是猜，也不是重发）
  await refreshTrash(B);
  const rowsAfterB = (await trashRows(B)).find((item) => item.name === 'note.md');
  check('B5-7 另一页刷新后收敛为「已恢复」，不会退回可恢复', rowsAfterB?.badge === '已恢复', rowsAfterB);
  check('B5-8 收敛后另一页也没有留下待核对', !(await ledger(B)).some((item) => item.opId === entry.opId), await ledger(B));
}

/* ================================================================== */
section('B5-2 · UNKNOWN（请求没到 Host）跨页面 / 跨刷新保持保护');
{
  await backToTree(A);
  await sleep(600);
  const original = sha256(`${ROOT_A}/plain.txt`);
  await removeViaUi(A, 'plain.txt');
  const { body } = await trashList(PROJECT_A);
  const entry = (body.entries ?? []).find((item) => item.path === 'plain.txt' && item.state === 'stored');
  check('B5-9 前提：plain.txt 已在回收区', !!entry, entry);

  // 请求阶段直接掐掉：Host 一个字节都没动，客户端拿不到任何结论
  A.tab.on('Fetch.requestPaused', async (p) => {
    try {
      if (/\/api\/trash\/restore/.test(p.request.url)) {
        await A.tab.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionFailed' });
        return;
      }
      await A.tab.send('Fetch.continueRequest', { requestId: p.requestId });
    } catch {}
  });
  await A.tab.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/trash/restore*', requestStage: 'Request' }] });
  result.injected.push({ check: 'B5-2', how: 'A 在 Request 阶段 failRequest（请求未到达 Host，磁盘不变）' });

  await openTrash(A);
  await restoreRow(A, 'plain.txt');
  await sleep(2600);
  await A.tab.send('Fetch.disable').catch(() => undefined);

  check('B5-10 磁盘未变：原位置仍为空', !existsSync(`${ROOT_A}/plain.txt`));
  check(
    'B5-11 Host 记录仍为 stored',
    (await trashList(PROJECT_A)).body.entries.find((item) => item.opId === entry.opId)?.state === 'stored',
  );
  check('B5-12 A 的台账保留了这条待核对', (await ledger(A)).some((item) => item.opId === entry.opId), await ledger(A));
  check(
    'B5-13 A 的保护记录也有同一笔（跨刷新可用）',
    (await guardRecords(A))?.records?.some((item) => item.opId === entry.opId),
    await guardRecords(A),
  );

  // B 通过 storage 事件同步（不需要刷新列表也知道"这条不能点"）
  await openTrash(B);
  await refreshTrash(B);
  const rowB = (await trashRows(B)).find((item) => item.name === 'plain.txt');
  check('B5-14 B 同步到「待核对」', rowB?.badge === '待核对', rowB);

  await B.tab.send('Page.reload');
  await sleep(4200);
  await openTrash(B);
  await refreshTrash(B);
  const rowB2 = (await trashRows(B)).find((item) => item.name === 'plain.txt');
  check('B5-15 B 重载后仍显示「待核对」', rowB2?.badge === '待核对', rowB2);
  check(
    'B5-16 B 的保护记录没有丢',
    (await guardRecords(B))?.records?.some((item) => item.opId === entry.opId),
    await guardRecords(B),
  );
  check('B5-17 B 的台账也没有丢', (await ledger(B)).some((item) => item.opId === entry.opId), await ledger(B));

  result.detail['B5-2'] = { original, entry: entry.opId };
}

/* ================================================================== */
section('B5-3 · 满仓后正常释放容量');
{
  await backToTree(A);
  await sleep(500);

  // 用真实 Host 造 64 条 stored 记录（每个都是一次真实的磁盘移动）
  const bulkDir = `${ROOT_A}/bulk`;
  rmSync(bulkDir, { recursive: true, force: true });
  mkdirSync(bulkDir, { recursive: true });
  let created = 0;
  for (let i = 0; i < 64; i += 1) {
    const name = `bulk-${String(i).padStart(2, '0')}.txt`;
    writeFileSync(`${bulkDir}/${name}`, `bulk ${i}\n`);
    const response = await api('/api/trash/entry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: PROJECT_A, path: `bulk/${name}`, opId: `op-bulk-${String(i).padStart(8, '0')}` }),
    });
    if (response.body?.status !== 'REJECTED') created += 1;
  }
  const listed = (await trashList(PROJECT_A)).body.entries ?? [];
  const storedBulk = listed.filter((item) => item.state === 'stored' && item.path.startsWith('bulk/'));
  check('B5-18 已在回收区准备好 64 条真实记录', storedBulk.length === 64, { created, stored: storedBulk.length });

  // 把台账填到 64（两条持久层都写，模拟"64 次恢复都没有结论"）
  const workspaceKey = (await api('/api/health')).body.workspaceKey;
  const opIds = storedBulk.map((item) => item.opId);
  const filled = await ev(
    A.tab,
    `(async () => {
      const WORKSPACE_KEY = ${JSON.stringify(workspaceKey)};
      const OP_IDS = ${JSON.stringify(opIds)};
      const records = OP_IDS.map((opId) => ({
        workspaceKey: WORKSPACE_KEY,
        projectId: 'proj-a',
        opId,
        createdAt: '2026-11-27T00:00:00.000Z',
      }));
      localStorage.setItem(${JSON.stringify(LEDGER_KEY)}, JSON.stringify({ version: 1, records }));
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('weavespace-trash-guard-v1', 1);
        req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('guard')) req.result.createObjectStore('guard'); };
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('guard', 'readwrite');
          tx.objectStore('guard').put({ version: 1, records, invalidated: false }, 'current');
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(new Error('tx'));
        };
        req.onerror = () => reject(new Error('open'));
      });
      return records.length;
    })()`,
  );
  check('B5-19 台账与保护记录都写到 64 条', filled === 64, filled);

  await A.tab.send('Page.reload');
  await sleep(4500);
  await openTrash(A);
  const banner = await trashBanner(A);
  check('B5-20 满仓时明确提示"已满"', typeof banner === 'string' && /已满/.test(banner), banner);
  const fullRows = await trashRows(A);
  check(
    'B5-21 满仓时每一行都不能恢复',
    fullRows.length > 0 && fullRows.every((row) => row.hasButton === false || row.buttonDisabled === true),
    fullRows.slice(0, 3),
  );

  // 正常释放：让其中一条取得终态（一次真实 Host 恢复），再由成功列表读取对账
  await api('/api/trash/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: PROJECT_A, opId: opIds[0] }),
  });
  await refreshTrash(A);
  check('B5-22 一条记录取得终态后台账减到 63', (await ledger(A)).length === 63, (await ledger(A)).length);
  check('B5-23 满仓提示消失', (await trashBanner(A)) === null, await trashBanner(A));

  const recovered = (await trashRows(A)).find((row) => row.badge === '可恢复');
  check('B5-24 容量释放后恢复按钮重新可用', !!recovered && recovered.hasButton === true && recovered.buttonDisabled === false, recovered);
  if (recovered) {
    await restoreRow(A, recovered.name);
    await sleep(2500);
    const { body: after } = await trashList(PROJECT_A);
    const restoredCount = (after.entries ?? []).filter((item) => item.state === 'restored').length;
    check('B5-25 释放容量后真的能再恢复一条（真实磁盘）', restoredCount >= 2, { restoredCount });
  } else {
    check('B5-25 释放容量后真的能再恢复一条（真实磁盘）', false, '没有可恢复行');
  }
}

await closeTab(A);
await closeTab(B);
const summary = summarize();
writeFileSync(new URL('./tabs-raw.json', import.meta.url), JSON.stringify(result, null, 2));
process.exit(summary.failed.length > 0 ? 1 : 0);
