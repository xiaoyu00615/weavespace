/**
 * UX-02C-04 真实浏览器验收：标注名 / 标签 / 行颜色 + 真实资源生命周期。
 *
 * 环境：
 * - 真实 Host（默认 5297）+ 真实 Vite（5298）+ 真实 Chrome（CDP 9347）；
 * - 测试 Workspace `D:/Workspace/projects/weavespace-test/c04`（两个项目）；
 * - 全程真实磁盘：每个关键断言都同时核对 **DOM / 接口 / 磁盘 SHA-256**。
 *
 * 分两段跑（Host 必须真的重启过）：
 *   PHASE=1 node verify-metadata.mjs   # 设置三项 → 刷新页面 → 记录状态
 *   （停 Host → 重启 Host）
 *   PHASE=2 node verify-metadata.mjs   # 重启后仍在 → 改名 → 移动 → 回收/恢复 → 隔离 → 清除
 *
 * 不使用用户真实工作文件。
 */
import { existsSync, readFileSync, rmSync, writeFileSync, cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ev, sleep, waitFor } from './cdp.mjs';
import {
  APP,
  HOST,
  PROJECT_A,
  PROJECT_B,
  ROOT_A,
  ROOT_B,
  api,
  closeTab,
  createReport,
  listTree,
  openApp,
  openContextMenu,
  clickMenuItem,
  menuItem,
  rowStateOf,
  sha256,
  backToTree,
  removeViaUi,
  openTrash,
  restoreRow,
  trashRows,
} from './helpers.mjs';

const PHASE = process.env.PHASE ?? '1';
const STATE_FILE = 'D:/Workspace/projects/weavespace/docs/evidence/ux-02c-04-resource-metadata/state.json';
const { result, check, section, summarize } = createReport(`metadata-phase-${PHASE}`);

const ALIAS = '核心架构';
const TAG1 = '重要';
const TAG2 = '架构';

/* ------------------------------ 页面操作 ------------------------------ */

/** React 受控输入必须走原生 setter + input 事件，直接改 value 不会触发 onChange。 */
const setInput = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

const clickByText = (selector, text) => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.innerText.trim() === ${JSON.stringify(text)});
  if (!el) return 'missing';
  el.click();
  return 'clicked';
})()`;

const metaDialogOpen = `!!document.querySelector('[aria-label="资源标注"]')`;

async function openMeta(t, name, itemText) {
  if (!(await openContextMenu(t, name))) return 'no-row';
  const item = await menuItem(t, itemText);
  if (!item) return 'no-menu-item';
  if (item.disabled) return 'menu-disabled';
  await clickMenuItem(t, itemText);
  try {
    await waitFor(t.tab, metaDialogOpen, 8000, 'metadata dialog');
  } catch {
    return 'no-dialog';
  }
  return 'open';
}

async function saveDialog(t) {
  const clicked = await ev(t.tab, clickByText('.meta__dialog button', '保存'), false);
  await waitFor(t.tab, `!(${metaDialogOpen})`, 15000, 'dialog closed after save');
  await sleep(900);
  return clicked;
}

async function rowState(t, name) {
  return await ev(t.tab, rowStateOf(name), false);
}

/* ------------------------------ 断言工具 ------------------------------ */

/**
 * 行断言。
 *
 * 三个字段分开判：
 * - `alias`：行首括号里的文本；
 * - `tags`：**在 `title` 里**全都在（有标注名时行内只显示 `+N`，标签进 title）；
 * - `chips`：行内胶囊的确切内容（只在"没有标注名"时才逐项比较）；
 * - `color`：行上的颜色类名。
 */
async function expectRow(t, name, expect, label) {
  const state = await rowState(t, name);
  const aliasOk =
    expect.alias === undefined || state?.alias === (expect.alias === null ? null : `（${expect.alias}）`);
  const chipsOk = expect.chips === undefined || JSON.stringify(state?.tags) === JSON.stringify(expect.chips);
  const tagsOk =
    expect.tags === undefined || (expect.tags ?? []).every((tag) => (state?.title ?? '').includes(tag));
  const colorOk = expect.color === undefined || state?.color === expect.color;
  return check(label, !!state && aliasOk && chipsOk && tagsOk && colorOk, state);
}

/**
 * 展开某个文件的祖先目录（**只在折叠时**点一下）。
 *
 * 直接"点一下 docs"会在它已经展开时把它折叠起来，接下来所有行断言都会拿到 null——
 * 这是上一版失败的真实原因（不是功能坏了）。
 */
async function ensurePathVisible(t, relPath) {
  const segments = relPath.split('/').filter(Boolean);
  for (let i = 1; i < segments.length; i += 1) {
    const name = segments[i - 1];
    await ev(
      t.tab,
      `(() => {
        const row = [...document.querySelectorAll('button.tree__row--folder')].find(
          (b) => b.querySelector('.tree__name')?.textContent === ${JSON.stringify(name)} &&
            b.getAttribute('aria-expanded') === 'false',
        );
        row?.click();
        return !!row;
      })()`,
      false,
    );
    await sleep(1100);
  }
}

/* ================================================================== */
/* PHASE 1：设置三项 → 刷新页面                                          */
/* ================================================================== */

if (PHASE === '1') {
  section('前提');
  const t = await openApp({ fresh: true });
  try {
    const before = await rowState(t, 'note.md');
    check('C-01 初始状态：note.md 存在且没有任何标注', before !== null && before.alias === null && before.tags.length === 0, before);

    const shaBefore = sha256(join(ROOT_A, 'note.md'));
    const treeBefore = listTree(ROOT_A);

    section('标注名');
    const opened = await openMeta(t, 'note.md', '设置标注名…');
    check('C-02 右键文件 → 「设置标注名…」打开标注对话框', opened === 'open', opened);
    check(
      'C-03 对话框把焦点放在标注名输入框',
      await ev(t.tab, `document.activeElement?.id === 'meta-alias'`, false),
    );
    await ev(t.tab, setInput('#meta-alias', ALIAS), false);
    const saved = await saveDialog(t);
    check('C-04 点「保存」后对话框关闭', saved === 'clicked', saved);
    await expectRow(t, 'note.md', { alias: ALIAS }, 'C-05 行上显示真实名称 +（标注名）');
    const named = await rowState(t, 'note.md');
    check('C-06 真实名称仍是 note.md（标注名不替代文件名）', named?.name === 'note.md', named);

    section('标签');
    check('C-07 再次右键 → 「编辑标签…」', (await openMeta(t, 'note.md', '编辑标签…')) === 'open');
    for (const tag of [TAG1, TAG2]) {
      await ev(t.tab, setInput('[aria-label="新增标签"]', tag), false);
      await ev(t.tab, clickByText('.meta__dialog button', '添加'), false);
      await sleep(200);
    }
    check(
      'C-08 对话框里两枚标签已就位',
      (await ev(t.tab, `document.querySelectorAll('.meta__tag').length`, false)) === 2,
    );
    await saveDialog(t);
    /*
     * 行宽只有 260px：已经有标注名时，标签折成 `+2`（内容进 `title`），
     * 否则"名称 + 标注名 + 两枚标签"三样放不下，文件名会被挤成 `note...`。
     * 标签本身没丢：对话框里可编辑、`title` 里全列出来了。
     */
    await expectRow(t, 'note.md', { tags: [TAG1, TAG2], chips: ['+2'] }, 'C-09 行上有两枚标签（折叠为 +2，title 里全列）');

    section('颜色');
    check('C-10 再次右键 → 「设置颜色…」', (await openMeta(t, 'note.md', '设置颜色…')) === 'open');
    await ev(t.tab, `document.querySelector('.meta__swatch--blue')?.click()`, false);
    await saveDialog(t);
    await expectRow(t, 'note.md', { color: 'tree__row--color-blue' }, 'C-11 行带上 blue 颜色类名');

    section('磁盘零变更');
    check('C-12 文件内容 SHA-256 未变', sha256(join(ROOT_A, 'note.md')) === shaBefore);
    check('C-13 目录结构未变（元数据不落任何用户目录）', JSON.stringify(listTree(ROOT_A)) === JSON.stringify(treeBefore), {
      before: treeBefore,
      after: listTree(ROOT_A),
    });

    section('接口与配置事实');
    const listed = await api(`/api/metadata?projectId=${PROJECT_A}`);
    const record = (listed.body?.entries ?? [])[0];
    check('C-14 GET /api/metadata 返回 active 记录', listed.status === 200 && record?.state === 'active', record);
    check(
      'C-15 记录字段正确（path/alias/tags/color）',
      record?.path === 'note.md' && record?.alias === ALIAS && record?.color === 'blue' &&
        JSON.stringify(record?.tags) === JSON.stringify([TAG1, TAG2]),
      record,
    );

    const storePath = 'D:/Workspace/projects/weavespace-test/c04/store/workspace.json';
    const raw = JSON.parse(readFileSync(storePath, 'utf8'));
    check('C-16 工作区配置升到 v5', raw.version === 5, raw.version);
    check('C-17 配置里只有一条元数据且带对象身份', raw.metadata?.length === 1 && typeof raw.metadata[0].identity === 'string' && raw.metadata[0].identity.length > 0, raw.metadata);
    check('C-18 旧字段仍在（projects / hidden / trash）', Array.isArray(raw.projects) && Array.isArray(raw.hidden) && Array.isArray(raw.trash));

    section('刷新浏览器');
    await t.tab.send('Page.reload');
    await sleep(3500);
    await ev(t.tab, `[...document.querySelectorAll('button')].find(b=>b.innerText.includes('真实文件'))?.click()`);
    await waitFor(t.tab, `document.querySelectorAll('button.tree__row--file').length > 0`, 20000, 'tree rows after reload');
    await sleep(600);
    await expectRow(t, 'note.md', { alias: ALIAS, tags: [TAG1, TAG2], color: 'tree__row--color-blue' }, 'C-19 刷新后三项仍在');

    writeFileSync(
      STATE_FILE,
      JSON.stringify(
        {
          alias: ALIAS,
          tags: [TAG1, TAG2],
          sha: shaBefore,
          tree: treeBefore,
          note: 'phase1 结束状态：note.md 已标注三项，磁盘未变',
        },
        null,
        2,
      ),
    );
  } finally {
    await closeTab(t);
  }
}

/* ================================================================== */
/* PHASE 2：重启后 → 改名 → 移动 → 回收/恢复 → 隔离 → 清除               */
/* ================================================================== */

if (PHASE === '2') {
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const t = await openApp({ fresh: false });
  try {
    section('Host 重启后');
    await expectRow(t, 'note.md', { alias: state.alias, tags: state.tags, color: 'tree__row--color-blue' }, 'C-20 重启 Host 后三项仍在');
    check('C-21 文件内容仍然一字未改', sha256(join(ROOT_A, 'note.md')) === state.sha);

    section('真实改名');
    check('C-22 右键 → 「重命名」', (await openContextMenu(t, 'note.md')) && (await menuItem(t, '重命名')) !== null);
    await clickMenuItem(t, '重命名');
    await waitFor(t.tab, `!!document.querySelector('[aria-label="新名称"]')`, 8000, 'rename input');
    await ev(t.tab, setInput('[aria-label="新名称"]', 'renamed.md'), false);
    await ev(t.tab, `document.querySelector('[aria-label="确认"]')?.click()`, false);
    await waitFor(t.tab, `!![...document.querySelectorAll('button.tree__row--file')].find(b=>b.querySelector('.tree__name')?.textContent==='renamed.md')`, 20000, 'renamed row');
    await sleep(700);
    await expectRow(t, 'renamed.md', { alias: state.alias, tags: state.tags, color: 'tree__row--color-blue' }, 'C-23 改名后标注跟随到新名称');
    check('C-24 旧名称已不在磁盘上', !existsSync(join(ROOT_A, 'note.md')) && existsSync(join(ROOT_A, 'renamed.md')));

    section('真实移动');
    check('C-25 右键 → 「移动到…」', (await openContextMenu(t, 'renamed.md')) && (await menuItem(t, '移动到…')) !== null);
    await clickMenuItem(t, '移动到…');
    await waitFor(t.tab, `!!document.querySelector('.move__select')`, 8000, 'move dialog');
    await ev(
      t.tab,
      `(() => {
        const select = document.querySelector('.move__select');
        const option = [...select.options].find((o) => o.value === 'docs');
        if (!option) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(select, 'docs');
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
      false,
    );
    await sleep(300);
    await ev(t.tab, clickByText('.move__dialog button', '确认移动'), false);
    await waitFor(t.tab, `!document.querySelector('.move__dialog')`, 20000, 'move dialog closed');
    await sleep(1200);
    // 展开 docs 才能看到里面那一行（已展开时不要再点，否则会折叠）
    await ensurePathVisible(t, 'docs/renamed.md');
    await expectRow(t, 'renamed.md', { alias: state.alias, tags: state.tags, color: 'tree__row--color-blue' }, 'C-26 移动后标注跟随');
    check('C-27 文件已在 docs 目录里', existsSync(join(ROOT_A, 'docs/renamed.md')));

    section('回收 → 同名新文件 → 恢复');
    await ensurePathVisible(t, 'docs/renamed.md');
    const moveBack = await removeViaUi(t, 'renamed.md');
    check('C-28 通过右键「移入回收区」把已标注文件回收', moveBack.stage === 'confirmed', moveBack.stage);
    const configAfterTrash = JSON.parse(readFileSync('D:/Workspace/projects/weavespace-test/c04/store/workspace.json', 'utf8'));
    check('C-29 回收后标注记录仍在配置里（不随回收丢失）', (configAfterTrash.metadata ?? []).length === 1, (configAfterTrash.metadata ?? []).length);

    writeFileSync(join(ROOT_A, 'docs/renamed.md'), '# 全新文件（不是被回收的那一个）\n', 'utf8');
    await ev(t.tab, `document.querySelector('.project__refresh')?.click()`, false);
    await sleep(1600);
    await ensurePathVisible(t, 'docs/renamed.md');
    await expectRow(t, 'renamed.md', { alias: null, tags: [], chips: [], color: null }, 'C-30 同名新文件不继承标注（rebound）');
    rmSync(join(ROOT_A, 'docs/renamed.md'));

    await openTrash(t);
    const rows = await trashRows(t);
    check('C-31 回收区里能看到这一条', Array.isArray(rows) && rows.length >= 1, rows);
    const restored = await restoreRow(t, 'renamed.md');
    await sleep(2200);
    await backToTree(t);
    await sleep(900);
    await ensurePathVisible(t, 'docs/renamed.md');
    await expectRow(t, 'renamed.md', { alias: state.alias, tags: state.tags, color: 'tree__row--color-blue' }, 'C-32 恢复后标注重新生效');
    check('C-33 恢复的是同一份内容（SHA 一致）', sha256(join(ROOT_A, 'docs/renamed.md')) === state.sha, {
      restored: restored,
      sha: sha256(join(ROOT_A, 'docs/renamed.md')),
    });

    section('跨项目隔离');
    /*
     * 同名文件隔离是 Host + 树的性质：两个项目里都有 `same.md`。
     * 这里用真实接口给 A 的那一个设置标注，再看**两行**的展示差异——
     * 用 UI 逐个项目点右键也可以，但两行同名，行定位会变成"第一条"，
     * 断言就会失去判别力。
     */
    const isolated = await api('/api/metadata/set', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: PROJECT_A, path: 'same.md', alias: 'A 同名文件', color: 'red' }),
    });
    check('C-34a 接口给 A 的 same.md 设置标注', isolated.status === 200 && isolated.body?.status === 'APPLIED', isolated.body);

    await ev(t.tab, `document.querySelectorAll('.project__refresh').forEach((b) => b.click())`, false);
    await sleep(2200);
    const sameRows = await ev(
      t.tab,
      `(() => {
        const rows = [...document.querySelectorAll('button.tree__row--file')];
        return rows
          .filter((b) => b.querySelector('.tree__name')?.textContent === 'same.md')
          .map((b) => ({
            alias: b.querySelector('.tree__alias')?.textContent ?? null,
            color: [...b.classList].find((c) => c.startsWith('tree__row--color-')) ?? null,
          }));
      })()`,
      false,
    );
    check(
      'C-34b 只有 A 的 same.md 带标注，B 的同名文件保持干净',
      Array.isArray(sameRows) && sameRows.length === 2 && sameRows.filter((row) => row.alias === '（A 同名文件）').length === 1,
      sameRows,
    );
    check(
      'C-34c A 的行有颜色、B 的行没有',
      Array.isArray(sameRows) && sameRows.filter((row) => row.color === 'tree__row--color-red').length === 1,
      sameRows,
    );

    // 清掉这条隔离用例的记录，后面"配置里没有元数据"的断言才有意义
    const cleaned = await api('/api/metadata/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: PROJECT_A, path: 'same.md' }),
    });
    check('C-34d 清除 A 的 same.md 标注', cleaned.status === 200 && cleaned.body?.changed === true, cleaned.body);

    section('清除全部标注');
    await ensurePathVisible(t, 'docs/renamed.md');
    check('C-35 打开标注对话框', (await openMeta(t, 'renamed.md', '设置标注名…')) === 'open');
    await ev(t.tab, clickByText('.meta__dialog button', '清除全部标注'), false);
    await waitFor(t.tab, `!(${metaDialogOpen})`, 15000, 'dialog closed after clear');
    await sleep(1000);
    await expectRow(t, 'renamed.md', { alias: null, tags: [], color: null }, 'C-36 清除后恢复默认显示');
    const finalConfig = JSON.parse(readFileSync('D:/Workspace/projects/weavespace-test/c04/store/workspace.json', 'utf8'));
    check('C-37 配置里已没有元数据记录', (finalConfig.metadata ?? []).length === 0, (finalConfig.metadata ?? []).length);
    check('C-38 清除标注不影响文件本身', existsSync(join(ROOT_A, 'docs/renamed.md')) && sha256(join(ROOT_A, 'docs/renamed.md')) === state.sha);
  } finally {
    await closeTab(t);
  }
}

const summary = summarize();
process.exit(summary.failed.length === 0 ? 0 : 1);
