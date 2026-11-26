/**
 * UX-02C-03-P2-03 阶段 B6：退出与重启（Host 停止/重启 + 页面重载/重开）。
 *
 * 分三段执行，中间由编排脚本重启真实 Host：
 *   PHASE=1  回收一条文件（真实磁盘），留下 stored 记录
 *   PHASE=2  Host 重启后：记录仍在、恢复成功、哈希一致；再造一条 UNKNOWN
 *   PHASE=3  Host 再次重启后：UNKNOWN 保护仍在、不自动重发、已恢复的记录不再可恢复
 *
 * 三段共享同一个 Chrome Profile（真实 localStorage / IndexedDB 跨页面重开保留）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

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
  trashBanner,
  trashList,
  trashRows,
  LEDGER_KEY,
} from './helpers.mjs';

const PHASE = process.env.PHASE ?? '1';
const STATE_FILE = new URL('./restart-state.json', import.meta.url);
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};

const { result, check, section, summarize } = createReport(`ux-02c-03-p2-03-restart-${PHASE}`);

async function ledger(t) {
  const raw = await ev(t.tab, `localStorage.getItem(${JSON.stringify(LEDGER_KEY)})`, false);
  if (raw === null) return [];
  try {
    return JSON.parse(raw).records ?? [];
  } catch {
    return null;
  }
}

const entryOf = async (opId) => (await trashList(PROJECT_A)).body.entries.find((item) => item.opId === opId);

if (PHASE === '1') {
  section('B6-1 · 回收一条文件后停 Host');
  const hash = sha256(`${ROOT_A}/note.md`);
  const t = await openApp({ fresh: true });
  await removeViaUi(t, 'note.md');
  const { body } = await trashList(PROJECT_A);
  const entry = (body.entries ?? []).find((item) => item.path === 'note.md' && item.state === 'stored');
  check('B6-1 回收成功且 Host 记录为 stored', !!entry, entry);
  check('B6-2 原文件已不在原位', !existsSync(`${ROOT_A}/note.md`));
  state.phase1 = { opId: entry?.opId, hash };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  result.detail.phase1 = state.phase1;
  await closeTab(t);
} else if (PHASE === '2') {
  section('B6-2 · Host 重启后：记录仍在、恢复可用');
  const t = await openApp();
  await openTrash(t);
  const row = (await trashRows(t)).find((item) => item.name === 'note.md');
  check('B6-3 重启后回收区仍列出这条（状态来自磁盘）', row?.badge === '可恢复', row);
  check('B6-4 重启后 Host 记录仍为 stored', (await entryOf(state.phase1.opId))?.state === 'stored');

  await restoreRow(t, 'note.md');
  await sleep(2500);
  check('B6-5 重启后恢复成功（原位置出现）', existsSync(`${ROOT_A}/note.md`));
  check('B6-6 恢复后哈希与原始一致', sha256(`${ROOT_A}/note.md`) === state.phase1.hash, {
    original: state.phase1.hash,
    restored: sha256(`${ROOT_A}/note.md`),
  });
  check('B6-7 Host 记录转为 restored', (await entryOf(state.phase1.opId))?.state === 'restored');

  // 再造一条 UNKNOWN：请求阶段掐掉（磁盘不变），只测"重启后保护还在"
  await ev(t.tab, `document.querySelector('[aria-label="返回项目"]')?.click()`, false);
  await sleep(1000);
  const hash2 = sha256(`${ROOT_A}/plain.txt`);
  await removeViaUi(t, 'plain.txt');
  const { body } = await trashList(PROJECT_A);
  const entry2 = (body.entries ?? []).find((item) => item.path === 'plain.txt' && item.state === 'stored');
  check('B6-8 前提：plain.txt 已在回收区', !!entry2, entry2);

  t.tab.on('Fetch.requestPaused', async (p) => {
    try {
      if (/\/api\/trash\/restore/.test(p.request.url)) {
        await t.tab.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionFailed' });
        return;
      }
      await t.tab.send('Fetch.continueRequest', { requestId: p.requestId });
    } catch {}
  });
  await t.tab.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/trash/restore*', requestStage: 'Request' }] });
  result.injected.push({ check: 'B6-8', how: 'CDP 在 Request 阶段 failRequest（请求未到达 Host）' });

  await openTrash(t);
  await restoreRow(t, 'plain.txt');
  await sleep(2500);
  await t.tab.send('Fetch.disable').catch(() => undefined);

  const row2 = (await trashRows(t)).find((item) => item.name === 'plain.txt');
  check('B6-9 UNKNOWN 后界面为「待核对」', row2?.badge === '待核对', row2);
  check('B6-10 台账留下这条待核对', (await ledger(t)).some((item) => item.opId === entry2.opId), await ledger(t));
  check('B6-11 磁盘未变（文件仍在回收区）', !existsSync(`${ROOT_A}/plain.txt`));

  state.phase2 = { opId: entry2?.opId, hash: hash2, unknownOpId: entry2?.opId };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  result.detail.phase2 = state.phase2;
  await closeTab(t);
} else {
  section('B6-3 · Host 再次重启后：UNKNOWN 保护仍在');
  const t = await openApp();
  await openTrash(t);

  const row = (await trashRows(t)).find((item) => item.name === 'plain.txt');
  check('B6-12 重启 + 重开页面后仍显示「待核对」', row?.badge === '待核对', row);
  check('B6-13 重启后台账仍有这条', (await ledger(t)).some((item) => item.opId === state.phase2.unknownOpId), await ledger(t));
  check('B6-14 重启后 Host 记录仍是 stored（磁盘从未被改）', (await entryOf(state.phase2.unknownOpId))?.state === 'stored');

  // 不自动重发：强制点一次仍然是零 POST（用 Network 观察）
  const posts = { count: 0 };
  await t.tab.send('Network.enable');
  t.tab.on('Network.requestWillBeSent', (event) => {
    if (event.request?.method === 'POST' && /\/api\/trash\/restore/.test(event.request.url)) posts.count += 1;
  });
  await restoreRow(t, 'plain.txt', { force: true });
  await sleep(1800);
  check('B6-15 重启后强制点击仍然零 POST（exists 不是授权）', posts.count === 0, posts);

  // 已恢复的记录重启后不再提供恢复
  const restoredRow = (await trashRows(t)).find((item) => item.name === 'note.md');
  check('B6-16 已恢复的记录重启后仍是「已恢复」且不可再恢复', restoredRow?.badge === '已恢复' && restoredRow?.hasButton === false, restoredRow);
  check('B6-17 已恢复文件仍在原位置且哈希未变', sha256(`${ROOT_A}/note.md`) === state.phase1.hash);
  check('B6-18 面板没有新的失效横幅', (await trashBanner(t)) === null, await trashBanner(t));

  result.detail.phase3 = { posts: posts.count, ledger: await ledger(t) };
  await closeTab(t);
}

const summary = summarize();
writeFileSync(new URL(`./restart-${PHASE}-raw.json`, import.meta.url), JSON.stringify(result, null, 2));
process.exit(summary.failed.length > 0 ? 1 : 0);
