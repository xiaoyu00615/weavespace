/**
 * UX-02C-03-P2-03-R1-06（真实浏览器）：**会话令牌在途**这个窗口。
 *
 * 缺陷的形状：Controller 检查完授权后，`restoreTrash()` 内部还要先取一次会话令牌
 * （`GET /api/session-token`），然后才发 POST。用户完全可以在这段时间里切模式 / 切项目，
 * 或者另一个标签页把「待核对」台账删掉——早先的检查已经通过了，POST 会照发。
 *
 * 本脚本用 CDP 把 `/api/session-token` 的**响应按住 1.8 秒**（不改内容，只延迟），
 * 在这段时间里做两件事：
 *
 * | 场景 | 窗口内做什么 | 必须证明 |
 * | --- | --- | --- |
 * | S1 | 点工具栏「演示」（mode + epoch 变化） | 恢复 POST = **0**；文件仍在回收区；台账释放 |
 * | S2 | 另一个标签页 `removeItem` 台账（真实跨标签页 storage 事件） | 恢复 POST = **0**；记录保守保留；恢复整体关闭 |
 *
 * 关键：断言的是 **网络层没有那个 POST**（CDP `Network.requestWillBeSent` 计数），
 * 不是"按钮变灰了"。按钮状态只是表象，缺陷就在按钮之后。
 */
import { existsSync } from 'node:fs';

import { ev, sleep } from './cdp.mjs';
import {
  LEDGER_KEY,
  PROJECT_A,
  ROOT_A,
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
} from './helpers.mjs';

const { result, check, section, summarize } = createReport('ux-02c-03-p2-03-r1-send-boundary');

const payloadOf = (opId) => `${ROOT_A}/.weavespace/trash/${opId}/payload`;

async function ledger(t) {
  const raw = await ev(t.tab, `localStorage.getItem(${JSON.stringify(LEDGER_KEY)})`, false);
  if (raw === null) return [];
  try {
    return JSON.parse(raw).records ?? [];
  } catch {
    return null;
  }
}

/** 持久层的**原始**字符串：`null` 才代表"键不存在"（`ledger()` 会把 null 归一成 []）。 */
async function rawLedger(t) {
  return await ev(t.tab, `localStorage.getItem(${JSON.stringify(LEDGER_KEY)})`, false);
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

/** 网络层观察：只计数，不拦截。 */
async function watchRestorePosts(t) {
  const state = {
    posts: 0,
    urls: [],
    stop() {
      off();
    },
  };
  await t.tab.send('Network.enable');
  const off = t.tab.on('Network.requestWillBeSent', (event) => {
    if (event.request?.method === 'POST' && /\/api\/trash\/restore/.test(event.request.url)) {
      state.posts += 1;
      state.urls.push(event.request.url);
    }
  });
  return state;
}

/**
 * 把会话令牌的响应按住 `delayMs`。
 *
 * 只延迟**第一次**（也就是这次恢复要用的那一次）：后续请求立刻放行，
 * 否则页面其余部分也会被一起冻住，反而看不出"只有 POST 没发"。
 */
async function delayNextSessionToken(t, delayMs) {
  const state = { seen: 0, released: 0 };
  const off = t.tab.on('Fetch.requestPaused', (p) => {
    void (async () => {
      if (!/\/api\/session-token/.test(p.request.url)) {
        try {
          await t.tab.send('Fetch.continueRequest', { requestId: p.requestId });
        } catch {}
        return;
      }
      state.seen += 1;
      if (state.seen > 1) {
        try {
          await t.tab.send('Fetch.continueRequest', { requestId: p.requestId });
        } catch {}
        return;
      }
      await sleep(delayMs);
      state.released += 1;
      try {
        await t.tab.send('Fetch.continueRequest', { requestId: p.requestId });
      } catch {}
    })();
  });
  await t.tab.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/session-token*', requestStage: 'Request' }] });
  return {
    state,
    async stop() {
      off();
      try {
        await t.tab.send('Fetch.disable');
      } catch {}
    },
  };
}

/** 轮询一个小条件（Node 侧），不用固定 sleep 猜时间。 */
async function waitTill(predicate, label, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(50);
  }
  throw new Error(`等待超时：${label}`);
}

const clickChip = (t, text) =>
  ev(
    t.tab,
    `(() => {
      const button = [...document.querySelectorAll('[role=toolbar] button.chip')].find((b) => b.innerText.trim() === ${JSON.stringify(text)});
      if (!button) return 'missing';
      button.click();
      return 'clicked';
    })()`,
    false,
  );

/** 工具栏 chip 的 `aria-pressed`：用来确认"模式真的切过去了"。 */
const chipPressed = (t, text) =>
  ev(
    t.tab,
    `(() => {
      const button = [...document.querySelectorAll('[role=toolbar] button.chip')].find((b) => b.innerText.trim() === ${JSON.stringify(text)});
      return button ? button.getAttribute('aria-pressed') : null;
    })()`,
    false,
  );

/* ================================================================== */
const A = await openApp({ fresh: true });

section('S1 · 会话令牌在途时切到演示模式（epoch 变化）');
{
  const target = 'note.md';
  const original = sha256(`${ROOT_A}/${target}`);
  check('S1-1 前提：文件在磁盘上且哈希已记录', original !== null, original);

  await removeViaUi(A, target);
  const { body } = await trashList(PROJECT_A);
  const entry = (body.entries ?? []).find((item) => item.path === target && item.state === 'stored');
  check('S1-2 前提：已移入回收区（Host 记录 stored）', !!entry, entry);

  await openTrash(A);
  const before = (await trashRows(A)).find((row) => row.name === target);
  check('S1-3 前提：界面上这一行可恢复', before?.badge === '可恢复', before);

  const net = await watchRestorePosts(A);
  const token = await delayNextSessionToken(A, 1800);

  // 点恢复 → 控制器预留 → 取令牌（被按住）→ 这个窗口里切模式
  await restoreRow(A, target);
  await waitTill(() => token.state.seen === 1, '会话令牌请求已被按住');
  check('S1-4 令牌请求确实被按住（窗口已打开）', token.state.released === 0, token.state);

  const switched = await clickChip(A, '演示');
  check('S1-5 窗口内点到「演示」并真的切过去了', switched === 'clicked' && (await chipPressed(A, '演示')) === 'true', {
    switched,
    pressed: await chipPressed(A, '演示'),
  });

  await sleep(3200);
  await token.stop();

  check('S1-6 真实恢复 POST 数量为 0（不是"按钮被禁用"）', net.posts === 0, { posts: net.posts, urls: net.urls });
  check('S1-7 磁盘未变：原位置仍为空', !existsSync(`${ROOT_A}/${target}`));
  check('S1-8 磁盘未变：payload 仍在回收区', existsSync(payloadOf(entry.opId)), payloadOf(entry.opId));
  const hostState = (await trashList(PROJECT_A)).body.entries.find((item) => item.opId === entry.opId)?.state;
  check('S1-9 Host 记录仍是 stored', hostState === 'stored', hostState);

  // 切回真实模式：什么都没有发生，所以这一行必须还是"可恢复"
  await clickChip(A, '真实文件');
  await sleep(2600);
  check('S1-10a 已切回真实模式', (await chipPressed(A, '真实文件')) === 'true', await chipPressed(A, '真实文件'));
  await backToTree(A);
  await openTrash(A);
  await ev(A.tab, `document.querySelector('[aria-label="刷新回收区"]')?.click()`, false);
  await sleep(2200);
  const after = (await trashRows(A)).find((row) => row.name === target);
  check('S1-10 切回真实模式后这一行仍「可恢复」（这次恢复确实没发生）', after?.badge === '可恢复', after);
  check(
    'S1-11 台账里没有留下这条（stale 是零副作用，预留已安全结算）',
    !(await ledger(A)).some((item) => item.opId === entry.opId),
    await ledger(A),
  );

  result.detail['S1'] = {
    target,
    opId: entry.opId,
    originalSha256: original,
    tokenSeen: token.state.seen,
    posts: net.posts,
    hostState,
    uiAfter: after?.badge ?? null,
    ledger: JSON.parse(JSON.stringify(await ledger(A))),
  };
}

section('S2 · 会话令牌在途时台账被另一个标签页删除（真实 storage 事件）');
{
  // 第二个标签页：同源、同一 Profile，用它做"外部删除"（真实的跨标签页 storage 事件）
  const B = await openApp();
  await sleep(1200);

  const target = 'plain.txt';
  const original = sha256(`${ROOT_A}/${target}`);
  await backToTree(A);
  await removeViaUi(A, target);
  const { body } = await trashList(PROJECT_A);
  const entry = (body.entries ?? []).find((item) => item.path === target && item.state === 'stored');
  check('S2-1 前提：已移入回收区', !!entry, entry);

  await openTrash(A);
  await ev(A.tab, `document.querySelector('[aria-label="刷新回收区"]')?.click()`, false);
  await sleep(2000);
  check('S2-2 前提：界面上这一行可恢复', (await trashRows(A)).find((row) => row.name === target)?.badge === '可恢复');

  const net = await watchRestorePosts(A);
  const token = await delayNextSessionToken(A, 1800);

  await restoreRow(A, target);
  await waitTill(() => token.state.seen === 1, '会话令牌请求已被按住');
  check('S2-3 令牌请求确实被按住（窗口已打开）', token.state.released === 0, token.state);
  check(
    'S2-4 前提：这次预留已经写进台账',
    (await ledger(A)).some((item) => item.opId === entry.opId),
    await ledger(A),
  );

  // 另一个标签页删掉整本台账：A 会收到真实的 `storage` 事件（newValue === null）
  const removed = await ev(B.tab, `(() => { localStorage.removeItem(${JSON.stringify(LEDGER_KEY)}); return localStorage.getItem(${JSON.stringify(LEDGER_KEY)}); })()`, false);
  check('S2-5 另一个标签页真的删掉了台账', removed === null, removed);
  await sleep(400);
  /*
   * 删完就关掉第二个页面：它自己**没有**失效（同一页面内的 removeItem 不会给自己发事件），
   * 留着它就有可能在下一次对账时把台账"重建"出来，反而把 A 的失效证据搅浑。
   */
  await closeTab(B);

  await sleep(3200);
  await token.stop();

  check('S2-6 真实恢复 POST 数量为 0', net.posts === 0, { posts: net.posts, urls: net.urls });
  check('S2-7 磁盘未变：原位置仍为空', !existsSync(`${ROOT_A}/${target}`));
  check('S2-8 磁盘未变：payload 仍在回收区', existsSync(payloadOf(entry.opId)), payloadOf(entry.opId));
  const hostState = (await trashList(PROJECT_A)).body.entries.find((item) => item.opId === entry.opId)?.state;
  check('S2-9 Host 记录仍是 stored（没有任何磁盘事务）', hostState === 'stored', hostState);

  const banner = await trashBanner(A);
  check('S2-10 恢复被整体关闭并给出可读原因', typeof banner === 'string' && banner.length > 0, banner);
  const rows = await trashRows(A);
  const row = rows.find((item) => item.name === target);
  check('S2-11 这一行仍然关闭恢复（不得因为失效而放开）', row?.hasButton === false || row?.buttonDisabled === true, row);

  /*
   * 记录必须**保守保留**：台账被外部删掉之后又不许重建，所以持久层是空的；
   * 但内存记录与 IndexedDB 保护记录都还在——那是"这条可能有一次没结论的恢复"的唯一凭据。
   */
  const guard = await guardRecords(A);
  check(
    'S2-12 IndexedDB 保护记录仍保留这条',
    guard?.records?.some((item) => item.opId === entry.opId) === true,
    guard,
  );
  const persistedAfter = await rawLedger(A);
  check('S2-13 持久层台账没有被重建（不得假装没事）', persistedAfter === null, persistedAfter);

  // 再点一次：已经关闭，仍然零 POST
  const before2 = net.posts;
  await restoreRow(A, target, { force: true });
  await sleep(1500);
  check('S2-14 失效之后强制点击也不会发请求', net.posts === before2, { before: before2, after: net.posts });

  result.detail['S2'] = {
    target,
    opId: entry.opId,
    originalSha256: original,
    tokenSeen: token.state.seen,
    posts: net.posts,
    hostState,
    banner,
    guard: guard ? { status: guard.status, invalidated: guard.invalidated, count: guard.records?.length ?? 0 } : null,
    uiAfter: row ?? null,
  };
}

await closeTab(A);
const summary = summarize();
const { writeFileSync } = await import('node:fs');
writeFileSync(new URL('./send-boundary-raw.json', import.meta.url), JSON.stringify(result, null, 2));
process.exit(summary.failed.length > 0 ? 1 : 0);
