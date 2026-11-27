/**
 * UX-02C-05-R1.1：资源身份仲裁补强与身份状态（纯 TS，先红后绿）。
 *
 * 这一组钉的是 R1 之后仍然存在的四处不严谨：
 * - 仲裁器重建后，浏览器递来的 `detail=2` 被当成了"新一次双击的起点"，
 *   于是旧手势的残响可以给**新对象**改名（任务 A）；
 * - `anchor === null` 同时表示"Provider 不支持身份"与"身份探测失败"，
 *   两者被同一个"路径相同就算同一行"放行了（任务 B）；
 * - 项目改名请求在途时切换项目/工作区，`sessionId` 仍是旧的，
 *   结果可能写进"看起来还当前"的会话（任务 C）；
 * - 上述修复不能动摇 500ms 窗口、键盘立即激活、图标/空白立即激活（任务 D）。
 *
 * 组件（`.tsx`）按工程纪律不直接 import；这里断言纯模块与源码事实。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

/*
 * 命名空间导入：本轮先写红测，新导出在旧实现里还不存在。
 * 具名导入会让整份文件在链接期失败，看不出"哪条行为不成立"。
 */
import * as tc from '../../apps/shell/src/state/tree-commands.ts';

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

/** 已核验的行身份：工作区 + 项目 + 路径 + 资源锚。 */
const A = {
  workspaceKey: 'ws-1',
  projectId: 'p1',
  path: 'note.md',
  anchor: 'anchor-a1',
  verification: 'verified',
} as const;

const withAnchor = (anchor: string | null) =>
  anchor === null
    ? ({ ...A, anchor: null, verification: 'unverified' } as const)
    : ({ ...A, anchor, verification: 'verified' } as const);
const otherProject = { ...A, projectId: 'p2' } as const;
const otherWorkspace = { ...A, workspaceKey: 'ws-2' } as const;
/** Provider 明确不具备身份能力：路径身份是被批准的唯一降级。 */
const unsupportedRow = { ...A, anchor: null, verification: 'unsupported' } as const;

interface Clock {
  setTimer(fn: () => void, delay: number): unknown;
  clearTimer(handle: unknown): void;
  advance(ms: number): void;
  count(): number;
}

function fakeClock(): Clock {
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

function arbiterWith(clock: Clock, identity: tc.ActivationIdentity = A) {
  let current: tc.ActivationIdentity | null = identity;
  const calls = { single: 0, double: 0 };
  const arbiter = tc.createActivationArbiter({
    delay: tc.NAME_DOUBLE_CLICK_WINDOW,
    setTimer: (fn, delay) => clock.setTimer(fn, delay),
    clearTimer: (handle) => clock.clearTimer(handle),
    currentIdentity: () => current,
    onSingle: () => {
      calls.single += 1;
    },
    onDouble: () => {
      calls.double += 1;
    },
  });
  return {
    arbiter,
    calls,
    setCurrent(next: tc.ActivationIdentity | null): void {
      current = next;
    },
  };
}

/* ================================================================== */
/* A 组：仲裁器重建（旧手势的残响不得落到新对象上）                     */
/* ================================================================== */

test('A01 身份变化后新建的仲裁器收到 detail=2：不得改名，也不得打开', () => {
  const clock = fakeClock();
  const first = arbiterWith(clock, A);
  first.arbiter.click(1, A); // 旧仲裁器收到第一次点击
  first.setCurrent(withAnchor('anchor-a2')); // 同路径文件被替换
  first.arbiter.cancel(); // React 重建：旧实例在途手势整段作废

  const replaced = withAnchor('anchor-a2');
  const second = arbiterWith(clock, replaced); // 新仲裁器：armed = null
  // 浏览器仍按双击计数，把第二下报成 detail=2
  second.arbiter.click(2, replaced);
  second.arbiter.doubleClick(replaced);
  clock.advance(5000);
  assert.deepEqual(second.calls, { single: 0, double: 0 }, '没有第一次点击的手势不能成为新起点');
  assert.equal(second.arbiter.isPending(), false);
});

test('A02 detail=2 在 armed=null 时不得被重新解释为"新的第一次点击"', () => {
  const clock = fakeClock();
  const { arbiter, calls } = arbiterWith(clock);
  arbiter.click(2, A); // 孤立连击：此前这个仲裁器没收到过第一次点击
  arbiter.doubleClick(A);
  clock.advance(5000);
  assert.deepEqual(calls, { single: 0, double: 0 });
  assert.equal(arbiter.isPending(), false, '更不许顺手武装出一个定时器');
});

test('A03 残响之后的**新**手势仍然正常（不能把仲裁器永久打死）', () => {
  const clock = fakeClock();
  const first = arbiterWith(clock, A);
  first.arbiter.click(1, A);
  first.arbiter.cancel();
  const replaced = withAnchor('anchor-a2');
  const second = arbiterWith(clock, replaced);
  second.arbiter.click(2, replaced); // 残响
  // 用户真的又点了一次：detail=1 才开始新手势
  second.arbiter.click(1, replaced);
  clock.advance(200);
  second.arbiter.click(2, replaced);
  second.arbiter.doubleClick(replaced);
  clock.advance(5000);
  assert.deepEqual(second.calls, { single: 0, double: 1 });
});

test('A04 第二次点击与第一次不是同一身份：整段手势作废，且不重新绑定', () => {
  const clock = fakeClock();
  const { arbiter, calls, setCurrent } = arbiterWith(clock);
  arbiter.click(1, A);
  setCurrent(withAnchor('anchor-a2'));
  // 第二下带着新身份进来：不得把 old armed 改写成新身份
  arbiter.click(2, withAnchor('anchor-a2'));
  arbiter.doubleClick(withAnchor('anchor-a2'));
  clock.advance(5000);
  assert.deepEqual(calls, { single: 0, double: 0 });
  assert.equal(arbiter.isPending(), false);
});

test('A05 detail=2 与 armed 同身份：保留 armed 供 dblclick 落槌（正常双击不回归）', () => {
  const clock = fakeClock();
  const { arbiter, calls } = arbiterWith(clock);
  arbiter.click(1, A);
  clock.advance(120);
  arbiter.click(2, A);
  assert.equal(arbiter.isPending(), false, '第二下必须撤掉在途单击');
  arbiter.doubleClick(A);
  clock.advance(5000);
  assert.deepEqual(calls, { single: 0, double: 1 });
});

/* ================================================================== */
/* B 组：身份状态（VERIFIED / UNSUPPORTED / UNVERIFIED）                */
/* ================================================================== */

test('B01 identityVerificationOf：有锚即已核验', () => {
  assert.equal(tc.identityVerificationOf({ anchor: 'anchor-a1', support: 'supported' }), 'verified');
  assert.equal(tc.identityVerificationOf({ anchor: 'anchor-a1', support: 'unsupported' }), 'verified');
});

test('B02 无锚时区分"Provider 不支持"与"探测失败"', () => {
  assert.equal(tc.identityVerificationOf({ anchor: null, support: 'supported' }), 'unverified');
  assert.equal(tc.identityVerificationOf({ anchor: null, support: 'unsupported' }), 'unsupported');
  // 空串不是锚：不能当成"有一个身份"
  assert.equal(tc.identityVerificationOf({ anchor: '', support: 'supported' }), 'unverified');
  // 没有能力声明（旧响应 / 未知 Provider）一律 fail-closed
  assert.equal(tc.identityVerificationOf({ anchor: null }), 'unverified');
});

test('B03 身份探测失败（本地真实项目缺锚）：在途单击不得执行', () => {
  const clock = fakeClock();
  const unknown = withAnchor(null); // anchor=null, verification='unverified'
  const { arbiter, calls } = arbiterWith(clock, unknown);
  arbiter.click(1, unknown);
  clock.advance(5000);
  assert.deepEqual(calls, { single: 0, double: 0 }, 'UNVERIFIED 必须 fail-closed');
});

test('B04 同路径文件被删除重建、前后都拿不到锚：路径相同也不得放行', () => {
  const clock = fakeClock();
  const before = withAnchor(null);
  const { arbiter, calls } = arbiterWith(clock, before);
  arbiter.click(1, before);
  // 前后"身份"在字面上完全一样（同工作区/项目/路径，都没有锚）——
  // 这正是旧实现把"无法确认"当成"身份一致"的空档
  clock.advance(5000);
  assert.deepEqual(calls, { single: 0, double: 0 });

  const double = arbiterWith(clock, before);
  double.arbiter.click(1, before);
  double.arbiter.doubleClick(before);
  clock.advance(5000);
  assert.equal(double.calls.double, 0, '身份未知时不得改名');
});

test('B05 身份从已核验变为未知：旧单击与旧双击都不执行', () => {
  const clock = fakeClock();
  const single = arbiterWith(clock, A);
  single.arbiter.click(1, A);
  single.setCurrent(withAnchor(null));
  clock.advance(5000);
  assert.equal(single.calls.single, 0);

  const double = arbiterWith(clock, A);
  double.arbiter.click(1, A);
  double.setCurrent(withAnchor(null));
  double.arbiter.doubleClick(A);
  clock.advance(5000);
  assert.equal(double.calls.double, 0);
});

test('B06 UNSUPPORTED 是唯一被批准的降级：按路径身份仍可单击/双击', () => {
  const clock = fakeClock();
  const single = arbiterWith(clock, unsupportedRow);
  single.arbiter.click(1, unsupportedRow);
  clock.advance(500);
  assert.equal(single.calls.single, 1, 'Provider 明确无身份能力时按路径身份降级');

  const double = arbiterWith(clock, unsupportedRow);
  double.arbiter.click(1, unsupportedRow);
  clock.advance(200);
  double.arbiter.click(2, unsupportedRow);
  double.arbiter.doubleClick(unsupportedRow);
  clock.advance(5000);
  assert.deepEqual(double.calls, { single: 0, double: 1 });
});

const fileTarget = (over: Partial<tc.TreeCommandTarget> = {}): tc.TreeCommandTarget => ({
  origin: 'file',
  projectId: 'p1',
  nodePath: 'docs/a.md',
  entryKind: 'file',
  ...over,
});

test('B07 菜单失效检测区分三种身份状态', () => {
  const base = { projectExists: true, projectReady: true, entryPresent: true } as const;

  // VERIFIED + 当前锚一致 → 放行
  assert.equal(
    tc.treeTargetProblemOf({
      ...base,
      target: fileTarget({ nodeAnchor: 'anchor-a1', nodeIdentity: 'verified' }),
      currentAnchor: 'anchor-a1',
    }),
    null,
  );

  // UNVERIFIED（本地真实项目缺锚）→ 拒绝，且不得当成"路径相同所以还是它"
  assert.match(
    tc.treeTargetProblemOf({
      ...base,
      target: fileTarget({ nodeIdentity: 'unverified' }),
      currentAnchor: null,
    }) ?? '',
    /无法确认/,
  );

  // UNSUPPORTED（Provider 明确无身份能力）→ 按已批准降级放行
  assert.equal(
    tc.treeTargetProblemOf({
      ...base,
      target: fileTarget({ nodeIdentity: 'unsupported' }),
      currentAnchor: null,
    }),
    null,
  );
});

test('B08 目标声称有锚、当前状态却不是已核验：拒绝（不得退回路径身份）', () => {
  const base = { projectExists: true, projectReady: true, entryPresent: true } as const;
  assert.match(
    tc.treeTargetProblemOf({
      ...base,
      target: fileTarget({ nodeAnchor: 'anchor-a1', nodeIdentity: 'verified' }),
      currentAnchor: null,
      currentIdentity: 'unverified',
    }) ?? '',
    /无法确认/,
  );
  // 当前 Provider 变成"不支持身份"也不能把旧锚当成匹配成功
  assert.match(
    tc.treeTargetProblemOf({
      ...base,
      target: fileTarget({ nodeAnchor: 'anchor-a1', nodeIdentity: 'verified' }),
      currentAnchor: null,
      currentIdentity: 'unsupported',
    }) ?? '',
    /无法确认/,
  );
});

test('B09 未声明身份的旧目标（无锚）不再默认放行：fail-closed', () => {
  assert.match(
    tc.treeTargetProblemOf({
      target: fileTarget(),
      projectExists: true,
      projectReady: true,
      entryPresent: true,
      currentAnchor: null,
    }) ?? '',
    /无法确认/,
  );
});

/* ================================================================== */
/* C 组：项目改名异步会话（请求在途时世界变了）                         */
/* ================================================================== */

const ticket = { sessionId: 7, scope: 'live\u0000multi\u0000ws-1', activeProjectAtStart: 'p1' } as const;

test('C01 请求在途时切换当前项目：旧结果只能 notice-only', () => {
  const stillCurrent = tc.projectRenameSessionStillCurrent({
    session: ticket,
    sessionId: 7,
    currentScope: ticket.scope,
    activeProjectId: 'p2',
  });
  assert.equal(stillCurrent, false);
  assert.equal(tc.projectRenameResultEffect({ applied: true, sessionStillCurrent: stillCurrent }), 'notice-only');
});

test('C02 请求在途时切换工作区：旧结果只能 notice-only', () => {
  const stillCurrent = tc.projectRenameSessionStillCurrent({
    session: ticket,
    sessionId: 7,
    currentScope: 'live\u0000multi\u0000ws-2',
    activeProjectId: 'p1',
  });
  assert.equal(stillCurrent, false);
  assert.equal(tc.projectRenameResultEffect({ applied: false, sessionStillCurrent: stillCurrent }), 'notice-only');
});

test('C03 会话仍当前：成功 close / 失败 keep-error', () => {
  const stillCurrent = tc.projectRenameSessionStillCurrent({
    session: ticket,
    sessionId: 7,
    currentScope: ticket.scope,
    activeProjectId: 'p1',
  });
  assert.equal(stillCurrent, true);
  assert.equal(tc.projectRenameResultEffect({ applied: true, sessionStillCurrent: true }), 'close');
  assert.equal(tc.projectRenameResultEffect({ applied: false, sessionStillCurrent: true }), 'keep-error');
});

test('C04 旧票据不得写进新会话，会话已收起也不得复活', () => {
  const reopened = { ...ticket, sessionId: 8 } as const;
  assert.equal(
    tc.projectRenameSessionStillCurrent({
      session: reopened,
      sessionId: 7, // 旧请求的票据
      currentScope: ticket.scope,
      activeProjectId: 'p1',
    }),
    false,
  );
  assert.equal(
    tc.projectRenameSessionStillCurrent({
      session: null,
      sessionId: 7,
      currentScope: ticket.scope,
      activeProjectId: 'p1',
    }),
    false,
  );
});

test('C05 源码守卫：提交结果按"票据 + 世界 + 活动项目"核对，且 notice-only 不写状态', async () => {
  const source = await readFile(join(process.cwd(), 'apps/shell/src/components/TreeCommandsContext.tsx'), 'utf8');
  assert.match(source, /projectRenameSessionStillCurrent\(/, '在途结果必须用同一判定核对');
  assert.match(source, /activeProjectAtStart/, '会话必须记住开始时的活动项目');
  assert.match(source, /scopeRef/, '工作区归属必须同步核对，不能只依赖 effect');
  // notice-only 分支只允许提示，绝不能再 setProjectRename
  const notice = source.slice(source.indexOf("// notice-only"));
  assert.ok(notice.length > 0, '必须有 notice-only 分支');
  const tail = notice.slice(0, notice.indexOf('} catch'));
  assert.doesNotMatch(tail, /setProjectRename\(/, 'notice-only 不得写回任何编辑会话');
});

/* ================================================================== */
/* D 组：回归（窗口、间隔、键盘、项目根）                               */
/* ================================================================== */

test('D01 窗口仍是 500ms：200ms 时不提前激活', () => {
  assert.equal(tc.NAME_DOUBLE_CLICK_WINDOW, 500);
  const clock = fakeClock();
  const { arbiter, calls } = arbiterWith(clock);
  arbiter.click(1, A);
  clock.advance(200);
  assert.equal(calls.single, 0);
  clock.advance(300);
  assert.equal(calls.single, 1);
});

test('D02 250 / 350 / 450ms 的连击都只改名', () => {
  for (const gap of [250, 350, 450]) {
    const clock = fakeClock();
    const { arbiter, calls } = arbiterWith(clock);
    arbiter.click(1, A);
    clock.advance(gap);
    arbiter.click(2, A);
    arbiter.doubleClick(A);
    clock.advance(5000);
    assert.deepEqual(calls, { single: 0, double: 1 }, `${gap}ms 应只改名`);
  }
});

test('D03 键盘 detail=0 仍然立即激活', () => {
  const clock = fakeClock();
  const { arbiter, calls } = arbiterWith(clock);
  arbiter.click(0, A);
  assert.deepEqual(calls, { single: 1, double: 0 });
  assert.equal(clock.count(), 0);
});

test('D04 项目根的正常操作不被身份检查误伤', () => {
  const root = { origin: 'project-root', projectId: 'p1', nodeIdentity: 'unverified' } as const;
  assert.equal(
    tc.treeTargetProblemOf({
      target: root,
      projectExists: true,
      projectReady: true,
      entryPresent: true,
      currentAnchor: null,
    }),
    null,
  );
  const matrix = tc.treeCommandMatrix(root, { supported: true, supportedExtensionCount: 2 });
  assert.equal(matrix['rename-project'].disabled, false);
  assert.equal(matrix['remove-project'].disabled, false);
});

test('D05 源码守卫：图标/空白仍立即激活，只有名称区进入仲裁', async () => {
  const source = await readFile(join(process.cwd(), 'apps/shell/src/components/FileTreeRow.tsx'), 'utf8');
  assert.match(source, /onNameArea\(event\.target\)/, '只有名称区参与单击/双击仲裁');
  assert.match(source, /identity === undefined \|\| !onNameArea\(event\.target\)/, '非名称区保持立即激活');
  assert.match(source, /cancel\(\)/, '身份变化 / 卸载时必须撤掉在途手势');
});
