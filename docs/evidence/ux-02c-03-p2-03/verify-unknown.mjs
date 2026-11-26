/**
 * UX-02C-03-P2-03-R1-03：UNKNOWN 完整链路（真实 Host + 真实磁盘）——三场景**相互独立**。
 *
 * 三个场景必须分开，因为"没到 Host"和"到了 Host 但响应丢了"在产品上完全不同：
 *
 * | 场景 | 手段 | 磁盘事实 |
 * | --- | --- | --- |
 * | 一 请求没到 Host | CDP `Fetch.failRequest`（**故障注入**） | 文件仍在回收区，原位置仍为空 |
 * | 二 Host 已执行、响应丢失 | CDP 在 **Response 阶段** `failRequest`（**故障注入**） | 文件已回到原位置 |
 * | 三 Host 返回 202 UNKNOWN | CDP 用**真实请求体里的 opId** 回 202（**故障注入**） | 不动盘 |
 *
 * R1-03 修正的三件事（每条都写进断言语义里，不是口头约定）：
 *
 * 1. **监听器必须注销**：`interceptRestore()` 返回 `stop()`，它同时做"注销监听器"与
 *    `Fetch.disable`；每个场景开始前断言 `listenerCount('Fetch.requestPaused') === 0`，
 *    避免上一场景的 `failRequest` 与本场景的 `fulfillRequest` 抢同一个 `requestId`。
 * 2. **202 必须是真实回执**：从实际 POST 的 `postData` 里取 `projectId` / `opId`，
 *    用同一对值回 202；再断言**客户端确实收到了 202**（页面侧 `fetch` 包装记录
 *    `res.status`），而不是只看界面出现「待核对」。
 * 3. **证据用独立快照**：每次写入 `result.detail` 的都是当时的拷贝，后续事件不会
 *    反过来修改此前已经记录的对象。
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
  queryOp,
  LEDGER_KEY,
} from './helpers.mjs';

const { result, check, section, summarize } = createReport('ux-02c-03-p2-03-r1-unknown');
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

/** 回收区目录里这个 opId 的 payload 是否还在（磁盘事实）。 */
const payloadPath = (opId) => `${ROOT_A}/.weavespace/trash/${opId}/payload`;

/**
 * 在页面里给 `fetch` 加一层"只读记录"：记下恢复请求的真实响应状态码。
 *
 * 这不是故障注入，也不改任何响应——它只是让我们能断言"客户端收到的确实是 202"，
 * 而不是凭界面文案猜。
 */
async function installRestoreRecorder(t) {
  const state = await ev(
    t.tab,
    `(() => {
      if (window.__restoreLog) return 'exists';
      window.__restoreLog = [];
      const orig = window.fetch;
      window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const isRestore = /\\/api\\/trash\\/restore/.test(url);
        const body = init && typeof init.body === 'string' ? init.body : null;
        let res;
        try {
          res = await orig.call(this, input, init);
        } catch (err) {
          if (isRestore) window.__restoreLog.push({ url, status: 0, error: String(err), body });
          throw err;
        }
        if (isRestore) window.__restoreLog.push({ url, status: res.status, body });
        return res;
      };
      return 'installed';
    })()`,
  );
  return state;
}

async function restoreLog(t) {
  return await ev(t.tab, `window.__restoreLog ? window.__restoreLog.slice() : []`, false);
}

/**
 * 拦截 `/api/trash/restore`。
 *
 * 返回 `{ state, stop }`：`stop()` 必须被调用（注销监听器 + 关闭 Fetch 拦截），
 * 否则下一个场景会和它抢同一个 `requestId`。
 */
async function interceptRestore(t, mode) {
  const state = { posts: 0, bodies: [], httpCodes: [], note: null };
  const off = t.tab.on('Fetch.requestPaused', (p) => {
    void (async () => {
      const isRestore = /\/api\/trash\/restore/.test(p.request.url);
      if (!isRestore) {
        try {
          await t.tab.send('Fetch.continueRequest', { requestId: p.requestId });
        } catch {}
        return;
      }
      state.posts += 1;
      const raw = p.request.postData ?? null;
      state.bodies.push(raw);
      try {
        if (mode === 'fail-response' && p.responseStatusCode) {
          // 响应阶段：Host 已经把磁盘事务做完了，这里只把回执掐掉
          state.note = 'response-stage-failRequest';
          await t.tab.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionReset' });
          return;
        }
        if (mode === 'unknown-202') {
          /*
           * 回执必须用**这次真实请求体**里的 projectId / opId：
           * 随便编一个 opId 会让"客户端进入 UNKNOWN"变成"客户端收到一条不相干的回执"，
           * 后者什么也证明不了。
           */
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = null;
          }
          const projectId = parsed && typeof parsed.projectId === 'string' ? parsed.projectId : PROJECT_A;
          const opId = parsed && typeof parsed.opId === 'string' ? parsed.opId : null;
          state.note = { echoed: { projectId, opId } };
          const body = Buffer.from(
            JSON.stringify({
              status: 'UNKNOWN',
              projectId,
              opId,
              message: '注入：Host 返回结果未确认（202）',
            }),
          ).toString('base64');
          state.httpCodes.push(202);
          await t.tab.send('Fetch.fulfillRequest', {
            requestId: p.requestId,
            responseCode: 202,
            responseHeaders: [{ name: 'content-type', value: 'application/json' }],
            body,
          });
          return;
        }
        state.note = 'request-stage-failRequest';
        await t.tab.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionFailed' });
      } catch (error) {
        state.note = `error:${String(error).slice(0, 120)}`;
      }
    })();
  });
  await t.tab.send('Fetch.enable', {
    patterns: [
      {
        urlPattern: '*/api/trash/restore*',
        requestStage: mode === 'fail-response' ? 'Response' : 'Request',
      },
    ],
  });
  const stop = async () => {
    // 顺序固定：先摘监听器，再关闭拦截（否则 disable 期间到达的事件没人处理）
    const removed = off();
    try {
      await t.tab.send('Fetch.disable');
    } catch {}
    return removed;
  };
  return { state, stop };
}

/* ================================================================== */
const t = await openApp({ fresh: true });
await installRestoreRecorder(t);

section('B4-场景一 · 请求没有到达 Host（副作用为零）');
{
  check('B4-0 场景一开始前没有任何遗留监听器', t.tab.listenerCount('Fetch.requestPaused') === 0, t.tab.listenerMethods());

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

  check('B4-2 只尝试了一次恢复 POST', net.state.posts === 1, { posts: net.state.posts, note: net.state.note });
  check('B4-3 磁盘没有变化：原位置仍为空', !existsSync(`${ROOT_A}/${target}`));
  check(
    'B4-4 磁盘没有变化：payload 仍在回收区',
    (await trashList(PROJECT_A)).body.entries.find((item) => item.opId === entry.opId)?.state === 'stored' &&
      existsSync(payloadPath(entry.opId)),
    { payload: existsSync(payloadPath(entry.opId)) },
  );

  const rows = await trashRows(t);
  const row = rows.find((item) => item.name === target);
  check('B4-5 界面进入「待核对」而不是「失败」', row?.badge === '待核对', row);
  check('B4-6 「待核对」时恢复按钮关闭', row?.hasButton === false || row.buttonDisabled === true, row);
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
  const before2 = net.state.posts;
  await restoreRow(t, target, { force: true });
  await sleep(1500);
  check('B4-9 待核对期间强制点击不会重发副作用请求', net.state.posts === before2, {
    before: before2,
    after: net.state.posts,
  });

  // 刷新页面后仍然保持
  await net.stop();
  check('B4-9b 场景一收尾：监听器已全部注销', t.tab.listenerCount('Fetch.requestPaused') === 0, t.tab.listenerMethods());
  await t.tab.send('Page.reload');
  await sleep(4000);
  await installRestoreRecorder(t);
  await openTrash(t);
  const afterReload = (await trashRows(t)).find((item) => item.name === target);
  check('B4-10 重载页面后仍显示「待核对」', afterReload?.badge === '待核对', afterReload);

  // 用一次成功列表读取收敛（记录已不在可恢复集合里）
  await ev(t.tab, `document.querySelector('[aria-label="刷新回收区"]')?.click()`, false);
  await sleep(2200);
  check('B4-11 拿到终态结论（stored）后记录不收敛（它确实还没结论）', (await ledger(t))?.length === 1, await ledger(t));
  result.detail['场景一'] = {
    target,
    hash: before,
    opId: entry.opId,
    posts: net.state.posts,
    httpCodes: [...net.state.httpCodes],
    pageLog: (await restoreLog(t)).map((item) => ({ status: item.status })),
    ledger: JSON.parse(JSON.stringify(await ledger(t))),
  };
}

section('B4-场景二 · Host 已执行磁盘事务，但客户端收不到响应');
{
  check('B4-12a 场景二开始前没有任何遗留监听器', t.tab.listenerCount('Fetch.requestPaused') === 0, t.tab.listenerMethods());
  await ev(t.tab, `document.querySelector('[aria-label="返回项目"]')?.click()`, false);
  await sleep(1200);
  await ev(t.tab, `window.__restoreLog = []`, false);

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
  check('B4-17 终态结论成立后台账释放这条（不留假的待核对）', !records.some((item) => item.opId === entry.opId), {
    records,
    row,
  });
  check('B4-18 仍然只发出一次 POST（响应丢失没有触发重发）', net.state.posts === 1, {
    posts: net.state.posts,
    note: net.state.note,
  });

  // 收敛：成功列表读取 → 记录已是 restored 终态 → 台账释放
  await net.stop();
  await ev(t.tab, `document.querySelector('[aria-label="刷新回收区"]')?.click()`, false);
  await sleep(2500);
  const after = (await trashRows(t)).find((item) => item.name === target);
  check('B4-19 一次成功列表读取后收敛为「已恢复」', after?.badge === '已恢复', after);
  check(
    'B4-20 收敛后台账不再保留这条',
    !(await ledger(t))?.some((item) => item.opId === entry.opId),
    await ledger(t),
  );
  result.detail['场景二'] = { target, original, opId: entry.opId, posts: net.state.posts, hostState };
}

section('B4-场景三 · Host 返回 202 UNKNOWN / 列表暂时无法刷新');
{
  check('B4-21a 场景三开始前没有任何遗留监听器', t.tab.listenerCount('Fetch.requestPaused') === 0, t.tab.listenerMethods());
  await ev(t.tab, `document.querySelector('[aria-label="返回项目"]')?.click()`, false);
  await sleep(1200);
  await ev(t.tab, `window.__restoreLog = []`, false);

  const target = 'blob.bin';
  const original = sha256(`${ROOT_A}/${target}`);
  await removeViaUi(t, target);
  const { body } = await trashList(PROJECT_A);
  const entry = (body.entries ?? []).find((item) => item.path === target && item.state === 'stored');
  check('B4-21 前提：文件已在回收区', !!entry, entry);

  const net = await interceptRestore(t, 'unknown-202');
  mark('B4 场景三', 'CDP 用真实 POST 请求体里的 projectId/opId 回 202 UNKNOWN（Host 未执行磁盘事务）');
  await openTrash(t);
  await restoreRow(t, target);
  await sleep(2600);

  /* 1) 回执身份必须来自真实请求体 */
  const postedBody = net.state.bodies[0] ?? null;
  let posted = null;
  try {
    posted = postedBody ? JSON.parse(postedBody) : null;
  } catch {
    posted = null;
  }
  check(
    'B4-22 实际 POST 请求体只含 projectId + opId，且 opId 就是这条记录',
    !!posted &&
      Object.keys(posted).sort().join(',') === 'opId,projectId' &&
      posted.opId === entry.opId &&
      posted.projectId === PROJECT_A,
    { posted, entry: entry.opId },
  );
  check(
    'B4-23 202 回执用的是同一个 projectId / opId（不是编造的）',
    JSON.stringify(net.state.note?.echoed ?? null) === JSON.stringify({ projectId: PROJECT_A, opId: entry.opId }),
    net.state.note,
  );

  /* 2) 真实 HTTP 202：既看"我们回了什么"，也看"页面收到了什么" */
  const pageLog = await restoreLog(t);
  const firstRestore = pageLog[0] ?? null;
  check('B4-24 客户端实际收到的 HTTP 状态是 202', firstRestore?.status === 202, { pageLog, serverSide: net.state.httpCodes });
  check('B4-25 只发出一次 POST', net.state.posts === 1, net.state.posts);

  /* 3) 客户端进入 UNKNOWN：待核对 + 两层记录都在 + 磁盘没动 */
  check('B4-26 界面保持「待核对」', (await trashRows(t)).find((item) => item.name === target)?.badge === '待核对');
  check('B4-27 202 UNKNOWN 时磁盘未被改动（原位置仍为空）', !existsSync(`${ROOT_A}/${target}`));
  check('B4-28 payload 仍在回收区（Host 从未执行）', existsSync(payloadPath(entry.opId)));
  /*
   * 只读核对是"这个 opId 的真实结论"。注意 opId 是**回收**时生成的，所以它本来就是
   * `trashed` —— 要证明的是"恢复没有被执行"，因此看的是 `state` 仍然是 `stored`，
   * 而不是指望 Host 说"没见过这个 opId"。
   */
  const probe = await queryOp(PROJECT_A, entry.opId);
  check(
    'B4-29 只读核对：Host 记录仍是 stored（恢复没有被执行）',
    probe.body?.state === 'stored' && probe.body?.outcome === 'trashed',
    probe.body,
  );
  check(
    'B4-30 台账保留这条（待核对跨会话可用）',
    (await ledger(t))?.some((item) => item.opId === entry.opId),
    await ledger(t),
  );
  check(
    'B4-31 IndexedDB 保护记录保留同一条',
    (await guardRecords(t))?.records?.some((item) => item.opId === entry.opId),
    await guardRecords(t),
  );

  // 不自动重发（强制点击）
  const before2 = net.state.posts;
  await restoreRow(t, target, { force: true });
  await sleep(1500);
  check('B4-32 待核对期间强制点击不会重发（仍然只有一次 POST）', net.state.posts === before2, {
    before: before2,
    after: net.state.posts,
  });

  await net.stop();
  check('B4-32b 场景三（202 阶段）收尾：监听器已注销', t.tab.listenerCount('Fetch.requestPaused') === 0, t.tab.listenerMethods());

  /* 4) 列表暂时无法刷新：把 GET /api/trash 打成 500 */
  const listOff = t.tab.on('Fetch.requestPaused', (p) => {
    void (async () => {
      try {
        if (/\/api\/trash\?/.test(p.request.url)) {
          await t.tab.send('Fetch.fulfillRequest', {
            requestId: p.requestId,
            responseCode: 500,
            responseHeaders: [{ name: 'content-type', value: 'application/json' }],
            body: Buffer.from(
              JSON.stringify({ status: 'REJECTED', errorCode: 'ERR_INJECTED', message: '注入：列表读取失败' }),
            ).toString('base64'),
          });
          return;
        }
        await t.tab.send('Fetch.continueRequest', { requestId: p.requestId });
      } catch {}
    })();
  });
  await t.tab.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/trash?*', requestStage: 'Request' }] });
  mark('B4 场景三', 'CDP 让 GET /api/trash 返回 500（列表暂时无法刷新）');
  await ev(t.tab, `document.querySelector('[aria-label="刷新回收区"]')?.click()`, false);
  await sleep(2500);
  check(
    'B4-33 列表读取失败不构成结论：台账记录不被清除',
    (await ledger(t))?.some((item) => item.opId === entry.opId),
    await ledger(t),
  );

  listOff();
  try {
    await t.tab.send('Fetch.disable');
  } catch {}
  check('B4-34 列表注入收尾：监听器已注销', t.tab.listenerCount('Fetch.requestPaused') === 0, t.tab.listenerMethods());

  await ev(t.tab, `document.querySelector('[aria-label="刷新回收区"]')?.click()`, false);
  await sleep(2500);
  const finalRow = (await trashRows(t)).find((item) => item.name === target);
  check('B4-35 列表恢复后仍是「待核对」（Host 从未执行）', finalRow?.badge === '待核对', finalRow);
  check('B4-36 文件仍在回收区、未回到原位置', !existsSync(`${ROOT_A}/${target}`));
  result.detail['场景三'] = {
    target,
    original,
    opId: entry.opId,
    posts: net.state.posts,
    httpStatusFromPage: firstRestore?.status ?? null,
    httpCodesServerSide: [...net.state.httpCodes],
    postedBody,
  };
}

await closeTab(t);
const summary = summarize();
const { writeFileSync } = await import('node:fs');
writeFileSync(new URL('./unknown-raw.json', import.meta.url), JSON.stringify(result, null, 2));
process.exit(summary.failed.length > 0 ? 1 : 0);
