/**
 * 采集 P2-03 的证据截图（真实页面，不裁剪、不美化）。
 *
 * 只做"看得见"的四件事：文件树 → 右键菜单 → 二段确认 → 回收区（可恢复 / 已恢复）。
 */
import { writeFileSync } from 'node:fs';

import { ev, sleep } from './cdp.mjs';
import { closeTab, openApp, openContextMenu, openTrash, removeViaUi, restoreRow, trashRows } from './helpers.mjs';

const shot = async (t, name) => {
  const image = await t.tab.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(new URL(`./${name}`, import.meta.url), Buffer.from(image.data, 'base64'));
  console.log('shot', name);
};

const t = await openApp({ fresh: true });
await shot(t, '01-tree-live.png');

await openContextMenu(t, 'blob.bin');
await sleep(400);
await shot(t, '02-context-menu.png');

await ev(t.tab, `[...document.querySelectorAll('[role=menu] [role=menuitem]')].find(b=>b.innerText.includes('移入回收区'))?.click()`);
await sleep(1200);
await shot(t, '03-confirm-dialog.png');
await ev(t.tab, `document.querySelector('[data-trash-delete] .modal__actions button')?.click()`, false);
await sleep(600);

await removeViaUi(t, 'blob.bin');
await openTrash(t);
await shot(t, '04-trash-restorable.png');

await restoreRow(t, 'blob.bin');
await sleep(2500);
await shot(t, '05-trash-restored.png');
console.log('rows', JSON.stringify(await trashRows(t)));

await closeTab(t);
process.exit(0);
