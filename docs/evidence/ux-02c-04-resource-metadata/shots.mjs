/**
 * 采集 UX-02C-04 的关键截图（真实浏览器）。
 *
 * 只拍"能说明设计"的三张：已标注的文件树行、标注对话框、清除后的默认显示。
 * 不追求界面美观——这一阶段不是视觉设计轮次。
 */
import { writeFileSync } from 'node:fs';

import { ev, sleep, waitFor } from './cdp.mjs';
import { openApp, closeTab, openContextMenu, clickMenuItem, menuItem } from './helpers.mjs';

const ROW = process.env.ROW_NAME ?? 'note.md';
const t = await openApp({ fresh: false });
try {
  // 用真实窗口尺寸截图：默认 768px 宽会把五区外壳压成"每栏都很窄"的极端布局
  await t.tab.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(1200);
  const shotTree = await t.tab.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(process.env.SHOT_PREFIX ? `${process.env.SHOT_PREFIX}-tree.png` : '06-tree-annotated.png', Buffer.from(shotTree.data, 'base64'));

  if (await openContextMenu(t, ROW)) {
    const item = await menuItem(t, '设置标注名…');
    if (item && !item.disabled) {
      await clickMenuItem(t, '设置标注名…');
      await waitFor(t.tab, `!!document.querySelector('[aria-label="资源标注"]')`, 8000, 'metadata dialog');
      await sleep(400);
      const shotDialog = await t.tab.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(process.env.SHOT_PREFIX ? `${process.env.SHOT_PREFIX}-dialog.png` : '07-metadata-dialog.png', Buffer.from(shotDialog.data, 'base64'));
      await ev(t.tab, `[...document.querySelectorAll('.meta__dialog button')].find((b) => b.innerText.trim() === '取消（Esc）')?.click()`, false);
      await sleep(400);
    }
  }
  console.log('shots done');
} finally {
  await closeTab(t);
}
