/**
 * UX-02C-03-P2-03 阶段 B2 + B3：普通文件完整生命周期与安全保护（真实端到端）。
 *
 * 真实 Host + 真实 Shell + 真实 Chrome + 真实文件系统 + 真实 localStorage / IndexedDB /
 * Web Locks。**不拦截**任何 `/api/trash/*`（正常路径必须真的走完）。
 *
 * 断言来源只有三种：磁盘事实（存在性 / 字节哈希）、Host 接口事实（state）、DOM 事实。
 */
import { existsSync, readdirSync } from 'node:fs';

import { ev, sleep } from './cdp.mjs';
import {
  backToTree,
  createReport,
  PROJECT_A,
  PROJECT_B,
  ROOT_A,
  ROOT_B,
  api,
  closeTab,
  hasRow,
  listTree,
  menuItem,
  openApp,
  openContextMenu,
  openTrash,
  removeViaUi,
  restoreRow,
  sha256,
  trashBanner,
  trashList,
  trashRows,
} from './helpers.mjs';

/** 每个文件的基线（在 reset-fixture 之后由脚本自己记录）。 */
const FILES = [
  { name: 'note.md', rel: 'note.md', kind: 'markdown' },
  { name: 'plain.txt', rel: 'plain.txt', kind: 'text' },
  { name: 'blob.bin', rel: 'blob.bin', kind: 'binary' },
  { name: '中文名.txt', rel: '中文名.txt', kind: 'cjk-name' },
  { name: 'with space.txt', rel: 'with space.txt', kind: 'space-name' },
  { name: 'deep.md', rel: 'notes/deep.md', kind: 'subdir' },
];

const { result, check, section, summarize } = createReport('ux-02c-03-p2-03-lifecycle');
/** 逐文件的磁盘事实（阶段 C4 要的 `filesystem-verification.json` 就来自它）。 */
const fsLog = [];

const trashOf = (rel) => `${ROOT_A}/.weavespace/trash`;
const opDirs = () => (existsSync(trashOf()) ? readdirSync(trashOf()) : []);

function manifestOf(opId) {
  const dir = `${trashOf()}/${opId}`;
  return {
    payload: existsSync(`${dir}/payload`),
    manifest: existsSync(`${dir}/manifest.json`),
    payloadHash: sha256(`${dir}/payload`),
    dir,
  };
}

async function entryState(opId) {
  const { body } = await trashList(PROJECT_A);
  const entry = (body.entries ?? []).find((item) => item.opId === opId);
  return entry ? entry.state : null;
}

// 这一轮从干净站点数据开始（同一 run 内的 reload / 新开页会保留状态，见 B6）
const t = await openApp({ fresh: true });

/* ================================================================== */
section('B2 · 六个真实文件的完整生命周期');

// 基线哈希（磁盘上此刻就是这些字节）
for (const file of FILES) file.hash = sha256(`${ROOT_A}/${file.rel}`);
check(
  'B2-0 六个文件都在磁盘上且哈希已记录',
  FILES.every((file) => file.hash !== null),
  Object.fromEntries(FILES.map((file) => [file.rel, file.hash?.slice(0, 12)])),
);

for (const file of FILES) {
  section(`B2 · ${file.rel}（${file.kind}）`);

  // 1) 取消：磁盘零变化
  const before = listTree(ROOT_A);
  const cancelled = await removeViaUi(t, file.name, { cancel: true });
  check(`B2-1 ${file.name} 取消确认后对话框消失`, cancelled.stage === 'cancelled', cancelled);
  check(
    `B2-2 ${file.name} 取消时磁盘零变化`,
    JSON.stringify(listTree(ROOT_A)) === JSON.stringify(before) && sha256(`${ROOT_A}/${file.rel}`) === file.hash,
    { before, after: listTree(ROOT_A) },
  );

  // 2) 正式确认：原位置消失、payload/manifest 存在、Host 状态 stored
  const removed = await removeViaUi(t, file.name);
  check(`B2-3 ${file.name} 确认后被移入回收区`, removed.stage === 'confirmed', removed);
  check(`B2-4 ${file.name} 原位置已消失`, !existsSync(`${ROOT_A}/${file.rel}`), `${ROOT_A}/${file.rel}`);
  check(`B2-5 ${file.name} 文件树不再显示它`, !(await hasRow(t, file.name)));

  const { body: listed } = await trashList(PROJECT_A);
  const entry = (listed.entries ?? []).find((item) => item.path === file.rel);
  check(`B2-6 ${file.name} Host 记录为 stored`, entry?.state === 'stored', entry);
  check(`B2-7 ${file.name} 回收区数量与列表同步`, (listed.entries ?? []).length === opDirs().length, {
    entries: (listed.entries ?? []).length,
    opDirs: opDirs().length,
  });

  const artifact = entry ? manifestOf(entry.opId) : { payload: false, manifest: false };
  fsLog.push({
    file: file.rel,
    kind: file.kind,
    originalPath: `${ROOT_A}/${file.rel}`,
    originalHash: file.hash,
    afterRemove: { pathExists: existsSync(`${ROOT_A}/${file.rel}`) },
    trashDir: artifact.dir ?? null,
    payload: { exists: artifact.payload, hash: artifact.payloadHash ?? null },
    manifest: { exists: artifact.manifest },
    hostStateAfterRemove: entry?.state ?? null,
  });
  check(`B2-8 ${file.name} payload 与 manifest 都在磁盘上`, artifact.payload && artifact.manifest, artifact);
  check(
    `B2-9 ${file.name} payload 字节哈希与原始文件一致`,
    artifact.payloadHash === file.hash,
    { original: file.hash, payload: artifact.payloadHash },
  );

  // 3) 恢复：原位置回来、哈希一致、Host 状态 restored
  await openTrash(t);
  const rows = await trashRows(t);
  check(`B2-10 ${file.name} 回收区显示「可恢复」`, rows.some((row) => row.badge === '可恢复'), rows);

  const clicked = await restoreRow(t, file.name);
  check(`B2-11 ${file.name} 恢复按钮可点击`, clicked === 'clicked', clicked);
  await sleep(2200);

  check(`B2-12 ${file.name} 原位置重新出现`, existsSync(`${ROOT_A}/${file.rel}`), `${ROOT_A}/${file.rel}`);
  check(
    `B2-13 ${file.name} 恢复后内容哈希与原始一致`,
    sha256(`${ROOT_A}/${file.rel}`) === file.hash,
    { original: file.hash, restored: sha256(`${ROOT_A}/${file.rel}`) },
  );
  check(`B2-14 ${file.name} Host 记录为 restored`, entry ? (await entryState(entry.opId)) === 'restored' : false);

  const logEntry = fsLog.find((item) => item.file === file.rel);
  if (logEntry) {
    logEntry.afterRestore = {
      pathExists: existsSync(`${ROOT_A}/${file.rel}`),
      hash: sha256(`${ROOT_A}/${file.rel}`),
      hashMatches: sha256(`${ROOT_A}/${file.rel}`) === file.hash,
    };
    logEntry.hostStateAfterRestore = entry ? await entryState(entry.opId) : null;
  }

  const afterRows = await trashRows(t);
  check(
    `B2-15 ${file.name} 回收区行变为「已恢复」且不再提供恢复`,
    afterRows.some((row) => row.name === file.name && row.badge === '已恢复' && row.buttonDisabled === null),
    afterRows.filter((row) => row.name === file.name),
  );
  check(
    `B2-16 ${file.name} 台账未留下待核对记录（真实成功路径不写 UNKNOWN）`,
    await ev(t.tab, `(() => { const raw = localStorage.getItem('ws:trash-pending:v1'); if (raw === null) return true; try { return (JSON.parse(raw).records ?? []).length === 0; } catch { return false; } })()`, false),
  );
  await backToTree(t);
}

/* ================================================================== */
section('B3 · 恢复冲突与安全保护');

// 1) 原路径已有同名文件 → 不覆盖
{
  const target = 'plain.txt';
  const hash = sha256(`${ROOT_A}/${target}`);
  await backToTree(t);
  await removeViaUi(t, target);
  const { body } = await trashList(PROJECT_A);
  const entry = (body.entries ?? []).find((item) => item.path === target && item.state === 'stored');

  // 用户重新创建了一个同名文件（内容不同）
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${ROOT_A}/${target}`, 'conflict content: do not overwrite\n');
  const conflictHash = sha256(`${ROOT_A}/${target}`);

  await openTrash(t);
  await restoreRow(t, target);
  await sleep(2000);

  check(
    'B3-1 原位置已有同名文件时恢复不覆盖它',
    sha256(`${ROOT_A}/${target}`) === conflictHash && conflictHash !== hash,
    { before: hash, conflict: conflictHash, after: sha256(`${ROOT_A}/${target}`) },
  );
  check('B3-2 冲突时 Host 记录仍为 stored（不动盘）', entry ? (await entryState(entry.opId)) === 'stored' : false);
  const rows = await trashRows(t);
  const row = rows.find((item) => item.name === target);
  check('B3-3 冲突时界面给出可读说明', typeof row?.note === 'string' && row.note.length > 0, row);
  // 收尾：删掉冲突文件，把回收记录恢复回去
  const { rmSync } = await import('node:fs');
  rmSync(`${ROOT_A}/${target}`, { force: true });
  await restoreRow(t, target);
  await sleep(1800);
  check('B3-4 冲突解除后可以正常恢复（同一记录未被破坏）', sha256(`${ROOT_A}/${target}`) === hash, sha256(`${ROOT_A}/${target}`));
  await backToTree(t);
}

// 2) 已有活动 View → 移入被阻止
{
  const target = 'note.md';
  await backToTree(t);
  await ev(t.tab, `(() => {
    const row = [...document.querySelectorAll('button.tree__row--file')].find(b=>b.innerText.trim()===${JSON.stringify(target)});
    row?.click();
    return true;
  })()`);
  await sleep(1800);
  const opened = await ev(t.tab, `document.querySelectorAll('.tab, .doc-tab, [role=tab]').length > 0`, false);
  await sleep(1200);
  // 菜单本身仍可点（它不预判标签状态），真正的门在二段确认里：必须是 blocked
  const blocked = await removeViaUi(t, target);
  check(
    'B3-5 已有活动 View 时移入被阻止（对话框给出原因，不是静默失败）',
    blocked.stage === 'blocked' && /标签|打开/.test(blocked.text ?? ''),
    { opened, blocked },
  );
  await ev(t.tab, `document.querySelector('[data-trash-delete] button')?.click()`, false);
  await sleep(500);
  check('B3-6 被阻止时文件仍在原位置', existsSync(`${ROOT_A}/${target}`));
  // 关掉标签页，避免影响后续
  await ev(t.tab, `[...document.querySelectorAll('.tab__close, .doc-tab__close')].forEach(b=>b.click())`, false);
  await sleep(600);
}

// 3) 目录 / 保留内部路径 / 符号链接：普通文件接口必须拒绝
{
  const dirTry = await api('/api/trash/entry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: PROJECT_A, path: 'notes', opId: 'op-dir-00000001' }),
  });
  check(
    'B3-7 目录不能通过普通文件接口移入',
    dirTry.status >= 400 && dirTry.body?.status !== 'APPLIED' && dirTry.body?.errorCode !== 'ERR_PERMISSION_DENIED',
    { status: dirTry.status, code: dirTry.body?.errorCode, message: dirTry.body?.message },
  );

  const innerTry = await api('/api/trash/entry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: PROJECT_A, path: '.weavespace/.gitignore', opId: 'op-inner-00001' }),
  });
  check(
    'B3-8 保留内部路径不能移入',
    innerTry.status >= 400 && innerTry.body?.status !== 'APPLIED' && innerTry.body?.errorCode !== 'ERR_PERMISSION_DENIED',
    { status: innerTry.status, code: innerTry.body?.errorCode, message: innerTry.body?.message },
  );

  const traversal = await api('/api/trash/entry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: PROJECT_A, path: '../projB/b-only.md', opId: 'op-escape-0001' }),
  });
  check(
    'B3-9 越界路径（../）不能移入',
    traversal.status >= 400 && traversal.body?.status !== 'APPLIED' && traversal.body?.errorCode !== 'ERR_PERMISSION_DENIED',
    { status: traversal.status, code: traversal.body?.errorCode, message: traversal.body?.message },
  );

  // 符号链接：需要真实创建（Windows 上通常需要开发者模式/管理员）
  const { symlinkSync, rmSync } = await import('node:fs');
  const link = `${ROOT_A}/link-to-b.md`;
  let linkCreated = false;
  try {
    symlinkSync(`${ROOT_B}/b-only.md`, link);
    linkCreated = true;
  } catch (err) {
    linkCreated = false;
    result.detail['B3-10'] = { note: '当前环境不允许创建符号链接', error: String(err).slice(0, 120) };
  }
  if (linkCreated) {
    const linkTry = await api('/api/trash/entry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: PROJECT_A, path: 'link-to-b.md', opId: 'op-link-0000001' }),
    });
    check(
      'B3-10 符号链接不能通过普通文件接口移入',
      linkTry.status >= 400 && linkTry.body?.status !== 'APPLIED' && linkTry.body?.errorCode !== 'ERR_PERMISSION_DENIED',
      { status: linkTry.status, code: linkTry.body?.errorCode, message: linkTry.body?.message },
    );
    check('B3-10b 链接目标本身未被移动', existsSync(`${ROOT_B}/b-only.md`));
    rmSync(link, { force: true });
  } else {
    check('B3-10 符号链接不能通过普通文件接口移入（环境不支持建链接，跳过）', true, 'skipped');
  }
}

// 4) 跨项目隔离：项目 A 的回收记录不得出现在项目 B
{
  const { body: bList } = await trashList(PROJECT_B);
  check('B3-11 项目 B 的回收区不含项目 A 的记录', (bList.entries ?? []).length === 0, bList.entries);

  const wrongProject = await api('/api/trash/entry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: PROJECT_B, path: 'note.md', opId: 'op-cross-0000001' }),
  });
  check(
    'B3-12 用 B 的项目 id 移入 A 的文件被拒绝（不是"来源不被允许"）',
    wrongProject.status >= 400 &&
      wrongProject.body?.status !== 'APPLIED' &&
      wrongProject.body?.errorCode !== 'ERR_PERMISSION_DENIED',
    { status: wrongProject.status, code: wrongProject.body?.errorCode, message: wrongProject.body?.message },
  );
  check('B3-13 A 的文件没有因此消失', existsSync(`${ROOT_A}/note.md`));
}

/* ================================================================== */
section('B2收尾 · 磁盘与列表一致');
{
  const { body } = await trashList(PROJECT_A);
  const stored = (body.entries ?? []).filter((item) => item.state === 'stored');
  check('B2-17 收尾时没有遗留 stored 记录（六个文件都已恢复）', stored.length === 0, stored);
  check(
    'B2-18 六个文件都在原位置且哈希未变',
    FILES.every((file) => sha256(`${ROOT_A}/${file.rel}`) === file.hash),
    Object.fromEntries(FILES.map((file) => [file.rel, sha256(`${ROOT_A}/${file.rel}`) === file.hash])),
  );
  check('B2-19 回收区面板没有失效横幅', (await trashBanner(t)) === null, await trashBanner(t));
}

await closeTab(t);
const summary = summarize();
const { writeFileSync } = await import('node:fs');
writeFileSync(
  new URL('./lifecycle-raw.json', import.meta.url),
  JSON.stringify({ ...result, filesystem: fsLog, tree: listTree(ROOT_A), trashDirs: opDirs() }, null, 2),
);
process.exit(summary.failed.length > 0 ? 1 : 0);
