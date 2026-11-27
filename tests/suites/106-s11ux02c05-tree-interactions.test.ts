/**
 * UX-02C-05：文件树交互契约（纯 TS 模块，先红后绿）。
 *
 * 覆盖本轮真正新增的判断，而不是重测已有链路：
 * A 组 四类目标的命令矩阵（文件 / 文件夹 / 项目根 / 空白区）+ 链接与不可用项目；
 * B 组 工具栏与右键菜单的目标解析、可用性同源；
 * C 组 禁用必须给原因，且禁用项在命令层不会被执行；
 * D 组 单击 / 双击仲裁（双击名称改名不与"单击打开"互相踩）；
 * E 组 键盘意图（F2 / Shift+F10 / 菜单键 / Escape）与"不劫持输入框/编辑器"；
 * G 组 失效目标（项目消失 / 不可用 / 行被移除 / 对象被替换）；
 * H 组 菜单视口夹取与"世界变了菜单就该失效"的身份键；
 * I 组 源码守卫：命令仍然只走既有业务链路，没有第二套实现。
 *
 * 组件（`.tsx`）按工程纪律不直接 import；这里断言的是它依赖的纯模块与源码事实。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  createActivationArbiter,
  menuIdentityOf,
  menuOrderOf,
  menuPositionOf,
  NAME_DOUBLE_CLICK_WINDOW,
  toolbarCommandState,
  toolbarTargetOf,
  treeCommandMatrix,
  treeKeyIntentOf,
  treeTargetProblemOf,
  type TreeCommandEnv,
  type TreeCommandId,
  type TreeCommandMatrix,
  type TreeCommandTarget,
} from '../../apps/shell/src/state/tree-commands.ts';
import { parentDirOf, resolveCreateTarget } from '../../apps/shell/src/state/create-entry.ts';

const ENV: TreeCommandEnv = { supported: true, supportedExtensionCount: 3 };
const UNSUPPORTED: TreeCommandEnv = { supported: false, supportedExtensionCount: 0 };

const fileTarget = (over: Partial<TreeCommandTarget> = {}): TreeCommandTarget => ({
  origin: 'file',
  projectId: 'p1',
  nodePath: 'docs/a.md',
  entryKind: 'file',
  ...over,
});

const folderTarget = (over: Partial<TreeCommandTarget> = {}): TreeCommandTarget => ({
  origin: 'folder',
  projectId: 'p1',
  nodePath: 'docs',
  entryKind: 'directory',
  ...over,
});

const rootTarget = (over: Partial<TreeCommandTarget> = {}): TreeCommandTarget => ({
  origin: 'project-root',
  projectId: 'p1',
  ...over,
});

const blankTarget = (projectId: string | null, over: Partial<TreeCommandTarget> = {}): TreeCommandTarget => ({
  origin: 'blank',
  projectId,
  ...over,
});

const linkTarget = (): TreeCommandTarget => ({
  origin: 'link',
  projectId: 'p1',
  nodePath: 'docs/ln',
  entryKind: 'link',
});

/** 矩阵里"会画出来"的命令 id（顺序 = 对象字面量顺序，稳定可测）。 */
function visibleIds(matrix: TreeCommandMatrix): TreeCommandId[] {
  return (Object.keys(matrix) as TreeCommandId[]).filter((id) => matrix[id].visible);
}

/* ================================================================== */
/* A 组：四类目标 + 特殊对象                                            */
/* ================================================================== */

test('A01 普通文件：改名/移动/隐藏/回收/标注/创建/刷新都在，根专有命令不在', () => {
  const matrix = treeCommandMatrix(fileTarget(), ENV);
  assert.deepEqual(visibleIds(matrix), [
    'rename',
    'move',
    'hide',
    'trash',
    'meta-alias',
    'meta-tags',
    'meta-color',
    'new-file',
    'new-folder',
    'new-supported',
    'refresh',
  ]);
  for (const id of visibleIds(matrix)) {
    assert.equal(matrix[id].disabled, false, `${id} 在可用文件上不应禁用`);
    assert.equal(matrix[id].hint, undefined, `${id} 可用时不应该带原因`);
  }
  assert.equal(matrix.unhide.visible, false, '未隐藏的行不给"取消隐藏"');
  assert.equal(matrix['rename-project'].visible, false, '根专有命令不出现在文件上');
  assert.equal(matrix['remove-project'].visible, false);
});

test('A02 文件夹：命令与文件一致，但「移入回收区」可见且禁用并说明只支持普通文件', () => {
  const matrix = treeCommandMatrix(folderTarget(), ENV);
  assert.deepEqual(visibleIds(matrix), visibleIds(treeCommandMatrix(fileTarget(), ENV)));
  assert.equal(matrix.trash.visible, true, '目录不提供回收时要显示原因，而不是藏起来');
  assert.equal(matrix.trash.disabled, true);
  assert.match(matrix.trash.hint ?? '', /目录/);
  assert.equal(matrix.rename.disabled, false, '文件夹可以改名');
  assert.equal(matrix.refresh.disabled, false, '文件夹可以刷新');
});

test('A03 项目根：创建 / 显示名 / 标注 / 刷新 / 移除；不出现改名·移动·回收·隐藏', () => {
  const matrix = treeCommandMatrix(rootTarget(), ENV);
  assert.deepEqual(visibleIds(matrix), [
    'meta-alias',
    'meta-tags',
    'meta-color',
    'new-file',
    'new-folder',
    'new-supported',
    'refresh',
    'rename-project',
    'remove-project',
  ]);
  for (const id of ['rename', 'move', 'hide', 'unhide', 'trash'] as TreeCommandId[]) {
    assert.equal(matrix[id].visible, false, `${id} 对项目根不适用`);
  }
  assert.equal(matrix['rename-project'].disabled, false);
  assert.equal(matrix['remove-project'].disabled, false);
  // 两者是不同命令：一个是显示名，一个是从工作台移除；都不碰磁盘目录
  assert.deepEqual(menuOrderOf('project-root').slice(0, 4), [
    'new-file',
    'new-folder',
    'new-supported',
    'rename-project',
  ]);
});

test('A04 空白区：只有创建与刷新；没有明确项目时禁用并提示"先选中一个项目"', () => {
  const withProject = treeCommandMatrix(blankTarget('p1'), ENV);
  assert.deepEqual(visibleIds(withProject), ['new-file', 'new-folder', 'new-supported', 'refresh']);
  assert.equal(withProject['new-file'].disabled, false);

  const noProject = treeCommandMatrix(blankTarget(null), UNSUPPORTED);
  assert.deepEqual(visibleIds(noProject), ['new-file', 'new-folder', 'new-supported', 'refresh']);
  for (const id of ['new-file', 'new-folder'] as TreeCommandId[]) {
    assert.equal(noProject[id].disabled, true, '没有项目时必须禁用，绝不猜一个磁盘目标');
    assert.match(noProject[id].hint ?? '', /先选中一个项目/);
  }
  assert.match(noProject.refresh.hint ?? '', /先选中一个项目/);
  /*
   * 同一个菜单里的三条创建命令对**同一种**"没有项目"必须给同一句话：
   * 一条说"请先选中一个项目"、另一条说"模式不支持"，用户会以为这是两个不同的限制，
   * 于是跑去翻模式开关——而真正要做的只是选一个项目。
   */
  assert.equal(noProject['new-supported'].hint, noProject['new-file'].hint);
  assert.equal(noProject['new-folder'].hint, noProject['new-file'].hint);
  // 空白区没有任何"对条目动手"的命令
  for (const id of ['rename', 'move', 'hide', 'trash', 'meta-alias'] as TreeCommandId[]) {
    assert.equal(withProject[id].visible, false);
  }
});

test('A05 链接节点：不提供改名/移动/隐藏/标注/刷新，创建与回收显示为禁用并说明原因', () => {
  const matrix = treeCommandMatrix(linkTarget(), ENV);
  assert.deepEqual(visibleIds(matrix), ['trash', 'new-file', 'new-folder', 'new-supported']);
  for (const id of ['rename', 'move', 'hide', 'unhide', 'meta-alias', 'refresh'] as TreeCommandId[]) {
    assert.equal(matrix[id].visible, false, `${id} 不应出现在链接菜单里`);
  }
  assert.match(matrix.trash.hint ?? '', /链接/);
  assert.match(matrix['new-file'].hint ?? '', /链接/);
  assert.equal(matrix['new-file'].disabled, true, '绝不沿链接创建');
});

test('A06 不可用项目：保留入口但禁用并给出原因（不是悄悄消失）', () => {
  const matrix = treeCommandMatrix(fileTarget(), UNSUPPORTED);
  for (const id of ['rename', 'move', 'hide', 'meta-alias', 'new-file', 'refresh'] as TreeCommandId[]) {
    assert.equal(matrix[id].visible, true, `${id} 在不支持的模式下仍然可见`);
    assert.equal(matrix[id].disabled, true);
    assert.ok(matrix[id].hint, `${id} 必须说明为什么不能点`);
  }
  const root = treeCommandMatrix(rootTarget(), UNSUPPORTED);
  assert.equal(root['rename-project'].disabled, true);
  assert.match(root['rename-project'].hint ?? '', /不支持/);
  assert.equal(root['remove-project'].disabled, true);
});

test('A07 隐藏 / 取消隐藏互斥：任何上下文都不会同时出现两条', () => {
  const contexts: TreeCommandTarget[] = [
    fileTarget(),
    folderTarget(),
    rootTarget(),
    blankTarget('p1'),
    linkTarget(),
    toolbarTargetOf('p1'),
    fileTarget({ nodeHidden: true }),
  ];
  for (const target of contexts) {
    const matrix = treeCommandMatrix(target, ENV);
    assert.equal(
      matrix.hide.visible && matrix.unhide.visible,
      false,
      `${target.origin} 上不该同时给出隐藏与取消隐藏`,
    );
  }
  const hidden = treeCommandMatrix(fileTarget({ nodeHidden: true }), ENV);
  assert.equal(hidden.unhide.visible, true);
  assert.equal(hidden.hide.visible, false);
});

/* ================================================================== */
/* B 组：工具栏与菜单同源                                              */
/* ================================================================== */

test('B01 工具栏与空白区对同一选中目录解析出同一个创建目标', () => {
  const selected = { p1: 'docs/guides' };
  const base = {
    kind: 'file' as const,
    selectedDirByProject: selected,
    activeProjectId: 'p1',
    supported: true,
  };
  const viaToolbar = resolveCreateTarget({ ...base, origin: 'toolbar', projectId: 'p1' });
  const viaBlank = resolveCreateTarget({ ...base, origin: 'blank', projectId: 'p1' });
  assert.deepEqual(viaToolbar, { ok: true, projectId: 'p1', parentDir: 'docs/guides' });
  assert.deepEqual(viaBlank, viaToolbar, '两个入口不许各有一套目标规则');

  // 没有选中目录时都落到项目根，而不是"上一个文件的父目录"之类的残留
  const fresh = { ...base, selectedDirByProject: {} };
  assert.deepEqual(
    resolveCreateTarget({ ...fresh, origin: 'toolbar', projectId: 'p1' }),
    { ok: true, projectId: 'p1', parentDir: '' },
  );
});

test('B02 选中/右键的是文件时，创建目标是它的父目录（绝不把文件路径当目录）', () => {
  const base = {
    kind: 'file' as const,
    selectedDirByProject: { p1: 'docs' },
    activeProjectId: 'p1',
    supported: true,
  };
  assert.deepEqual(
    resolveCreateTarget({ ...base, origin: 'file', projectId: 'p1', nodePath: 'docs/a.md' }),
    { ok: true, projectId: 'p1', parentDir: 'docs' },
  );
  assert.deepEqual(
    resolveCreateTarget({ ...base, origin: 'file', projectId: 'p1', nodePath: 'readme.md' }),
    { ok: true, projectId: 'p1', parentDir: '' },
    '根下文件的父目录是项目根',
  );
  // 选中的目录只影响 blank/toolbar，不能影响"右键的是文件"
  assert.deepEqual(
    resolveCreateTarget({ ...base, origin: 'file', projectId: 'p1', nodePath: 'other/b.md' }),
    { ok: true, projectId: 'p1', parentDir: 'other' },
  );
  assert.equal(parentDirOf('docs/a.md'), 'docs');
});

test('B03 工具栏按钮直接取菜单矩阵的同一格，原因是同一句文案', () => {
  const menu = treeCommandMatrix(toolbarTargetOf('p1'), UNSUPPORTED);
  for (const id of ['new-file', 'new-folder', 'refresh'] as const) {
    assert.deepEqual(toolbarCommandState(menu, id), menu[id]);
    assert.equal(menu[id].disabled, true);
    assert.ok(menu[id].hint);
  }
});

/* ================================================================== */
/* C 组：禁用必须有原因                                                */
/* ================================================================== */

test('C01 任何可见但禁用的命令都必须带原因（否则用户只能猜）', () => {
  const contexts: TreeCommandTarget[] = [
    fileTarget(),
    folderTarget(),
    rootTarget(),
    blankTarget('p1'),
    blankTarget(null),
    linkTarget(),
    toolbarTargetOf('p1'),
    toolbarTargetOf(null),
  ];
  for (const env of [ENV, UNSUPPORTED, { supported: true, supportedExtensionCount: 0 }]) {
    for (const target of contexts) {
      const matrix = treeCommandMatrix(target, env);
      for (const id of Object.keys(matrix) as TreeCommandId[]) {
        const cell = matrix[id];
        if (!cell.visible || !cell.disabled) continue;
        assert.ok(
          typeof cell.hint === 'string' && cell.hint.length > 0,
          `${target.origin}/${env.supported ? 'supported' : 'unsupported'} 的 ${id} 禁用却没有原因`,
        );
      }
    }
  }
});

test('C02 禁用项在执行层不产生任何副作用：目标解析本身也会拒绝', () => {
  // 链接 / 无项目 / 不支持模式三种"禁用"的原因，与编排器真正的拒绝理由一致
  for (const input of [
    { origin: 'link' as const, projectId: 'p1', nodePath: 'docs/ln', supported: true, activeProjectId: 'p1' },
    { origin: 'blank' as const, projectId: null, supported: false, activeProjectId: null },
    { origin: 'toolbar' as const, projectId: 'p1', supported: false, activeProjectId: 'p1' },
  ]) {
    const resolved = resolveCreateTarget({
      ...input,
      kind: 'file',
      selectedDirByProject: {},
    });
    assert.equal(resolved.ok, false, `${input.origin} 不该解析出可写目标`);
  }
});

/* ================================================================== */
/* D 组：单击 / 双击仲裁                                               */
/* ================================================================== */

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  const clearTimer = (handle: unknown): void => {
    const index = timers.findIndex((timer) => timer.id === handle);
    if (index >= 0) timers.splice(index, 1);
  };
  return {
    setTimer(fn: () => void, delay: number): unknown {
      seq += 1;
      timers.push({ id: seq, at: now + delay, fn });
      return seq;
    },
    clearTimer,
    advance(ms: number): void {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.at > now) continue;
        clearTimer(timer.id);
        timer.fn();
      }
    },
    count: () => timers.length,
  };
}

function arbiterWith(clock: ReturnType<typeof fakeClock>) {
  const calls = { single: 0, double: 0 };
  const arbiter = createActivationArbiter({
    delay: NAME_DOUBLE_CLICK_WINDOW,
    setTimer: (fn, delay) => clock.setTimer(fn, delay),
    clearTimer: (handle) => clock.clearTimer(handle),
    onSingle: () => {
      calls.single += 1;
    },
    onDouble: () => {
      calls.double += 1;
    },
  });
  return { arbiter, calls };
}

test('D01 名称上单击一次：延迟窗口结束后恰好激活一次', () => {
  const clock = fakeClock();
  const { arbiter, calls } = arbiterWith(clock);
  arbiter.click(1);
  assert.deepEqual(calls, { single: 0, double: 0 }, '窗口内先不激活，等第二下');
  assert.equal(arbiter.isPending(), true);
  clock.advance(NAME_DOUBLE_CLICK_WINDOW);
  assert.deepEqual(calls, { single: 1, double: 0 });
  assert.equal(arbiter.isPending(), false);
  clock.advance(5000);
  assert.deepEqual(calls, { single: 1, double: 0 }, '不许延迟触发第二次');
});

test('D02 双击：零激活 + 一次改名（文件不会被"先打开"而把自己挡住）', () => {
  const clock = fakeClock();
  const { arbiter, calls } = arbiterWith(clock);
  arbiter.click(1);
  arbiter.click(2);
  arbiter.doubleClick();
  assert.deepEqual(calls, { single: 0, double: 1 });
  clock.advance(5000);
  assert.deepEqual(calls, { single: 0, double: 1 }, '在途单击必须已被取消');
});

test('D03 键盘触发的 click（detail=0）立即激活，不进入窗口', () => {
  const clock = fakeClock();
  const { arbiter, calls } = arbiterWith(clock);
  arbiter.click(0);
  assert.deepEqual(calls, { single: 1, double: 0 });
  assert.equal(clock.count(), 0, '键盘激活不排定时器');
});

test('D04 一次双击之后仲裁器仍可正常使用（不残留状态）', () => {
  const clock = fakeClock();
  const { arbiter, calls } = arbiterWith(clock);
  arbiter.click(1);
  arbiter.click(2);
  arbiter.doubleClick();
  arbiter.click(1);
  clock.advance(NAME_DOUBLE_CLICK_WINDOW);
  assert.deepEqual(calls, { single: 1, double: 1 });
});

test('D05 取消（关闭菜单 / 卸载）后不再有延迟激活', () => {
  const clock = fakeClock();
  const { arbiter, calls } = arbiterWith(clock);
  arbiter.click(1);
  arbiter.cancel();
  clock.advance(5000);
  assert.deepEqual(calls, { single: 0, double: 0 });
  assert.equal(arbiter.isPending(), false);
});

test('D06 连续两次"双击"不会顺带激活（重复确认也不产生第二次副作用）', () => {
  const clock = fakeClock();
  const { arbiter, calls } = arbiterWith(clock);
  arbiter.click(2);
  arbiter.doubleClick();
  arbiter.click(2);
  arbiter.doubleClick();
  clock.advance(5000);
  assert.deepEqual(calls, { single: 0, double: 2 }, '每次手势各一次，绝不额外触发单击');
});

/* ================================================================== */
/* E 组：键盘意图                                                      */
/* ================================================================== */

test('E01 F2 / Shift+F10 / 菜单键 / Escape 的意图映射', () => {
  const base = { inEditable: false, hasTarget: true };
  assert.equal(treeKeyIntentOf({ ...base, key: 'F2' }), 'rename');
  assert.equal(treeKeyIntentOf({ ...base, key: 'F2', shiftKey: true }), 'rename');
  assert.equal(treeKeyIntentOf({ ...base, key: 'F10', shiftKey: true }), 'context-menu');
  assert.equal(treeKeyIntentOf({ ...base, key: 'F10' }), null, '单独的 F10 不是菜单键');
  assert.equal(treeKeyIntentOf({ ...base, key: 'ContextMenu' }), 'context-menu');
  assert.equal(treeKeyIntentOf({ ...base, key: 'Escape' }), 'escape');
  for (const key of ['Enter', 'Delete', 'a', 'ArrowDown', 'F5']) {
    assert.equal(treeKeyIntentOf({ ...base, key }), null, `${key} 不是树的快捷键`);
  }
});

test('E02 输入框 / 正文编辑器里不抢任何键', () => {
  for (const key of ['F2', 'F10', 'ContextMenu', 'Escape', 'Enter']) {
    assert.equal(
      treeKeyIntentOf({ key, shiftKey: key === 'F10', inEditable: true, hasTarget: true }),
      null,
      `${key} 在可编辑区域必须交给原控件`,
    );
  }
});

test('E03 没有当前焦点行时不给意图（不对空气动手）', () => {
  for (const key of ['F2', 'Escape', 'ContextMenu']) {
    assert.equal(treeKeyIntentOf({ key, inEditable: false, hasTarget: false }), null);
  }
});

/* ================================================================== */
/* G 组：失效目标                                                      */
/* ================================================================== */

test('G01 项目已不在工作区：任何行命令都不执行', () => {
  const problem = treeTargetProblemOf({
    target: fileTarget(),
    projectExists: false,
    projectReady: false,
    entryPresent: true,
    currentAnchor: null,
  });
  assert.match(problem ?? '', /已不在工作区/);
});

test('G02 项目当前不可用：命令不执行', () => {
  const problem = treeTargetProblemOf({
    target: folderTarget(),
    projectExists: true,
    projectReady: false,
    entryPresent: true,
    currentAnchor: null,
  });
  assert.match(problem ?? '', /不可用/);
});

test('G03 这一行已被移除：命令不执行（刷新/删除之后不许执行旧命令）', () => {
  const problem = treeTargetProblemOf({
    target: fileTarget(),
    projectExists: true,
    projectReady: true,
    entryPresent: false,
    currentAnchor: null,
  });
  assert.match(problem ?? '', /移除或替换/);
});

test('G04 同一路径换了对象（锚不同）：命令不执行', () => {
  const problem = treeTargetProblemOf({
    target: fileTarget({ nodeAnchor: 'a'.repeat(32) }),
    projectExists: true,
    projectReady: true,
    entryPresent: true,
    currentAnchor: 'b'.repeat(32),
  });
  assert.match(problem ?? '', /对象已经变化/);
});

test('G05 一切正常 / 空白区 / 工具栏 / 项目根：不阻断', () => {
  const ok = treeTargetProblemOf({
    target: fileTarget({ nodeAnchor: 'a'.repeat(32) }),
    projectExists: true,
    projectReady: true,
    entryPresent: true,
    currentAnchor: 'a'.repeat(32),
  });
  assert.equal(ok, null);
  for (const target of [blankTarget('p1'), toolbarTargetOf('p1'), linkTarget(), rootTarget()]) {
    assert.equal(
      treeTargetProblemOf({
        target,
        projectExists: true,
        projectReady: true,
        entryPresent: true,
        currentAnchor: null,
      }),
      null,
      `${target.origin} 不该被误判成失效`,
    );
  }
});

/* ================================================================== */
/* H 组：菜单几何与身份                                                */
/* ================================================================== */

test('H01 靠近右下边缘时向左上翻转，且始终留在视口内', () => {
  const flipped = menuPositionOf({
    x: 900,
    y: 700,
    width: 224,
    height: 300,
    viewportWidth: 1000,
    viewportHeight: 800,
  });
  assert.deepEqual(flipped, { left: 1000 - 224 - 8, top: 800 - 300 - 8 });
  const normal = menuPositionOf({
    x: 10,
    y: 12,
    width: 224,
    height: 300,
    viewportWidth: 1000,
    viewportHeight: 800,
  });
  assert.deepEqual(normal, { left: 10, top: 12 });
});

test('H02 菜单比视口还大时仍然给出可用位置（不出现负坐标）', () => {
  const position = menuPositionOf({
    x: 500,
    y: 400,
    width: 1400,
    height: 1200,
    viewportWidth: 1000,
    viewportHeight: 800,
  });
  assert.equal(position.left, 8);
  assert.equal(position.top, 8);
});

test('H03 模式 / 工作区 / 当前项目变化都会换一个"世界"，菜单必须失效', () => {
  const base = { mode: 'live', workspaceMode: 'multi', workspaceKey: 'wk-1', activeProjectId: 'p1' };
  const key = menuIdentityOf(base);
  assert.notEqual(menuIdentityOf({ ...base, mode: 'demo' }), key);
  assert.notEqual(menuIdentityOf({ ...base, workspaceMode: 'legacy' }), key);
  assert.notEqual(menuIdentityOf({ ...base, workspaceKey: 'wk-2' }), key);
  assert.notEqual(menuIdentityOf({ ...base, activeProjectId: 'p2' }), key);
  assert.equal(menuIdentityOf({ ...base }), key, '同样的世界必须是同一个键');
  assert.equal(menuIdentityOf({ ...base, workspaceKey: null }), menuIdentityOf({ ...base, workspaceKey: '' }));
});

/* ================================================================== */
/* I 组：源码守卫（命令仍然只有一条链路）                                */
/* ================================================================== */

const component = (name: string): Promise<string> =>
  readFile(join(process.cwd(), 'apps/shell/src/components', name), 'utf8');

test('I01 命令编排不直接发请求：不出现 fetch / 客户端实例', async () => {
  const source = await component('TreeCommandsContext.tsx');
  assert.doesNotMatch(source, /\bfetch\s*\(/, '命令编排不得自己发请求');
  assert.doesNotMatch(source, /createLiveClient|createDemoClient/, '也不得新建客户端');
  assert.match(source, /createEntryRunner/, '创建仍走既有编排器');
  assert.match(source, /createStructureRunner/, '改名/移动仍走既有编排器');
});

test('I02 工具栏与键盘共用同一条命令入口，不各自实现一遍', async () => {
  const source = await component('TreeCommandsContext.tsx');
  assert.match(
    source,
    /const toolbarCreate = useCallback\(\s*\(kind: CreateEntryKindDto\) => beginCreate\(kind, activeTarget\(\)\)/,
    '工具栏创建必须直接调用 beginCreate',
  );
  assert.match(source, /beginRename\(target\)/, 'F2 / 双击必须走 beginRename');
  assert.match(source, /treeCommandMatrix\(/, '菜单与工具栏都要用共享矩阵');
  const toolbar = await component('TreeToolbar.tsx');
  assert.match(toolbar, /treeCommandMatrix\(/, '工具栏不得自算可用性');
  assert.doesNotMatch(toolbar, /isSupported\(/, '工具栏不应再复制一份 supported 判定之外的分支');
});

test('I03 项目显示名改名走命令编排（菜单与铅笔按钮同一会话）', async () => {
  const list = await component('ProjectList.tsx');
  assert.match(list, /commands\.beginProjectRename/, '铅笔按钮与双击都从命令编排开始');
  assert.match(list, /commands\.submitProjectRename/, '提交走同一份会话');
  assert.doesNotMatch(list, /actions\.renameProject/, '不得在组件里另开一条改名链路');
  const context = await component('TreeCommandsContext.tsx');
  assert.match(context, /actions\.renameProject/, '真实链路仍然只有 renameProject');
});
