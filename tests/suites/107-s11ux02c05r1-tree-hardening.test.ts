/**
 * UX-02C-05-R1：双击仲裁与资源身份保护（纯 TS，先红后绿）。
 *
 * 为什么单独一组：106 钉的是"交互统一后的语义"，这一组钉的是**上一轮留下的三处
 * 不严谨**——双击窗口太短、仲裁器把"当前回调"当成"当初那个对象"、资源锚缺失时
 * 把"无法确认"当成"身份一致"。
 *
 * 覆盖：
 * W 组 双击窗口 500ms（含 200 / 250 / 350 / 450 的真实间隔语义、窗口边界、无残留定时器）；
 * J 组 点击绑定资源身份（锚变 / 同路径替换 / 项目变 / 身份未知 / 正常单击与双击）；
 * G 组 资源锚核验 fail-closed（接 106 的 G01–G05，这里补 G06 及边界）；
 * S 组 项目显示名编辑会话归属（scope 失效 / 项目消失 / 提交前复核 / 结果落地）；
 * M 组 源码守卫（仲裁器确实被喂了身份、会话确实被复核、不改名链路仍只有一条）。
 *
 * 组件（`.tsx`）按工程纪律不直接 import；这里断言纯模块与源码事实。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

/*
 * 命名空间导入而不是具名导入：本轮先写红测，新导出在旧实现里还不存在。
 * 具名导入会让整份文件在链接期就失败，看不出"到底哪条行为不成立"；
 * 命名空间导入能让每条用例各自失败在自己的断言上。
 */
import * as tc from '../../apps/shell/src/state/tree-commands.ts';

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

/** 一个稳定的行身份：工作区 + 项目 + 路径 + 资源锚。 */
const A = {
  workspaceKey: 'ws-1',
  projectId: 'p1',
  path: 'note.md',
  anchor: 'anchor-a1',
  // R1.1：身份状态是身份的一部分（这条固定的身份是"已核验"）
  verification: 'verified',
} as const;

/** 换锚：有锚 = 已核验；没有锚 = 无法确认（不是"Provider 不支持"）。 */
const withAnchor = (anchor: string | null) =>
  anchor === null
    ? ({ ...A, anchor: null, verification: 'unverified' } as const)
    : ({ ...A, anchor, verification: 'verified' } as const);
const otherProject = { ...A, projectId: 'p2' } as const;
const otherWorkspace = { ...A, workspaceKey: 'ws-2' } as const;

interface Clock {
  setTimer(fn: () => void, delay: number): unknown;
  clearTimer(handle: unknown): void;
  advance(ms: number): void;
  count(): number;
}

/** 可控时钟：`advance` 到点才执行，用来精确表达"间隔 N 毫秒"。 */
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

/**
 * 仲裁器 + 可变的"当前身份"。
 *
 * `current` 模拟"这一行现在指向谁"：React 可能复用同一个组件实例，
 * 只有身份变了才说明对象换了。
 */
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
    /** 现在这一行变成了谁（null = 身份不可确认）。 */
    setCurrent(next: tc.ActivationIdentity | null): void {
      current = next;
    },
  };
}

/* ================================================================== */
/* W 组：双击窗口                                                      */
/* ================================================================== */

test('W01 双击窗口默认 500ms（200ms 不足以覆盖真实双击间隔）', () => {
  assert.equal(tc.NAME_DOUBLE_CLICK_WINDOW, 500);
});

test('W02 单击后 200ms 不得提前激活（旧窗口会在这一刻把文件打开）', () => {
  const clock = fakeClock();
  const { arbiter, calls } = arbiterWith(clock);
  arbiter.click(1, A);
  clock.advance(200);
  assert.equal(calls.single, 0, '200ms 时第二下可能还在路上');
  assert.equal(arbiter.isPending(), true);
  clock.advance(300);
  assert.equal(calls.single, 1, '满 500ms 才激活');
});

test('W03 间隔 250ms 的双击：只改名，一次都不激活', () => {
  const clock = fakeClock();
  const { arbiter, calls } = arbiterWith(clock);
  arbiter.click(1, A);
  clock.advance(250);
  arbiter.click(2, A);
  arbiter.doubleClick(A);
  clock.advance(5000);
  assert.deepEqual(calls, { single: 0, double: 1 });
});

test('W04 间隔 350ms 的双击：只改名', () => {
  const clock = fakeClock();
  const { arbiter, calls } = arbiterWith(clock);
  arbiter.click(1, A);
  clock.advance(350);
  arbiter.click(2, A);
  arbiter.doubleClick(A);
  clock.advance(5000);
  assert.deepEqual(calls, { single: 0, double: 1 });
});

test('W05 间隔 450ms 的双击：只改名（旧 200ms 窗口早就先打开了文件）', () => {
  const clock = fakeClock();
  const { arbiter, calls } = arbiterWith(clock);
  arbiter.click(1, A);
  clock.advance(450);
  arbiter.click(2, A);
  arbiter.doubleClick(A);
  clock.advance(5000);
  assert.deepEqual(calls, { single: 0, double: 1 });
});

test('W06 超出窗口的单击：正常激活且只激活一次', () => {
  const clock = fakeClock();
  const { arbiter, calls } = arbiterWith(clock);
  arbiter.click(1, A);
  clock.advance(500);
  assert.deepEqual(calls, { single: 1, double: 0 });
  clock.advance(10000);
  assert.deepEqual(calls, { single: 1, double: 0 }, '不许延迟触发第二次');
  assert.equal(arbiter.isPending(), false);
});

test('W07 双击之后不残留定时器（不会在 500ms 后再打开一次）', () => {
  const clock = fakeClock();
  const { arbiter, calls } = arbiterWith(clock);
  arbiter.click(1, A);
  clock.advance(250);
  arbiter.click(2, A);
  arbiter.doubleClick(A);
  assert.equal(clock.count(), 0, '定时器必须已被撤销');
  assert.equal(arbiter.isPending(), false);
  clock.advance(10000);
  assert.deepEqual(calls, { single: 0, double: 1 });
});

test('W08 键盘触发的 click（detail=0）仍然立即激活，不进入窗口', () => {
  const clock = fakeClock();
  const { arbiter, calls } = arbiterWith(clock);
  arbiter.click(0, A);
  assert.deepEqual(calls, { single: 1, double: 0 });
  assert.equal(clock.count(), 0);
});

/* ================================================================== */
/* J 组：点击绑定资源身份                                              */
/* ================================================================== */

test('J01 单击后资源锚变了：定时器不得打开"新的那个对象"', () => {
  const clock = fakeClock();
  const { arbiter, calls, setCurrent } = arbiterWith(clock);
  arbiter.click(1, A);
  // 同一路径的文件被替换：路径没变，锚变了
  setCurrent(withAnchor('anchor-a2'));
  clock.advance(1000);
  assert.deepEqual(calls, { single: 0, double: 0 }, '旧点击不能落到新对象上');
  assert.equal(arbiter.isPending(), false);
});

test('J02 第一次点击后同路径文件被替换：第二次点击不得对新文件改名', () => {
  const clock = fakeClock();
  const { arbiter, calls, setCurrent } = arbiterWith(clock);
  arbiter.click(1, A);
  const replaced = withAnchor('anchor-a2');
  setCurrent(replaced);
  arbiter.click(2, replaced);
  arbiter.doubleClick(replaced);
  clock.advance(5000);
  assert.deepEqual(calls, { single: 0, double: 0 }, '两次点击不是同一个对象，整段手势作废');
  assert.equal(arbiter.isPending(), false);
});

test('J03 项目身份变化：旧的单击与双击意图都失效', () => {
  const clock = fakeClock();
  const single = arbiterWith(clock);
  single.arbiter.click(1, A);
  single.setCurrent(otherProject);
  clock.advance(1000);
  assert.equal(single.calls.single, 0, '切了项目，旧单击不能打开新项目的文件');

  const double = arbiterWith(clock);
  double.arbiter.click(1, A);
  double.setCurrent(otherProject);
  double.arbiter.doubleClick(otherProject);
  clock.advance(1000);
  assert.equal(double.calls.double, 0, '切了项目，旧双击不能改名');
});

test('J04 工作区身份变化：旧的仲裁意图不得执行', () => {
  const clock = fakeClock();
  const { arbiter, calls, setCurrent } = arbiterWith(clock);
  arbiter.click(1, A);
  setCurrent(otherWorkspace);
  clock.advance(1000);
  assert.deepEqual(calls, { single: 0, double: 0 });
});

test('J05 正常双击（同一身份）：只改名，不打开', () => {
  const clock = fakeClock();
  const { arbiter, calls } = arbiterWith(clock);
  arbiter.click(1, A);
  clock.advance(200);
  arbiter.click(2, A);
  arbiter.doubleClick(A);
  clock.advance(5000);
  assert.deepEqual(calls, { single: 0, double: 1 });
});

test('J06 正常单击（同一身份）：照常打开一次', () => {
  const clock = fakeClock();
  const { arbiter, calls } = arbiterWith(clock);
  arbiter.click(1, A);
  clock.advance(500);
  assert.deepEqual(calls, { single: 1, double: 0 });
});

test('J07 身份不可确认（currentIdentity 为 null）：fail-closed，不打开也不改名', () => {
  const clock = fakeClock();
  const { arbiter, calls, setCurrent } = arbiterWith(clock);
  arbiter.click(1, A);
  setCurrent(null);
  clock.advance(1000);
  assert.deepEqual(calls, { single: 0, double: 0 }, '无法确认身份时不得激活');

  const second = arbiterWith(clock);
  second.arbiter.click(1, A);
  second.setCurrent(null);
  second.arbiter.doubleClick(A);
  clock.advance(1000);
  assert.equal(second.calls.double, 0);
});

test('J08 没有第一次点击时，孤立的 dblclick 不改名（无可核对的对象）', () => {
  const clock = fakeClock();
  const { arbiter, calls } = arbiterWith(clock);
  arbiter.doubleClick(A);
  clock.advance(1000);
  assert.deepEqual(calls, { single: 0, double: 0 });
});

/* ================================================================== */
/* G 组：资源锚核验 fail-closed（接 106 的 G01–G05）                    */
/* ================================================================== */

const fileTarget = (nodeAnchor?: string): tc.TreeCommandTarget => ({
  origin: 'file',
  projectId: 'p1',
  nodePath: 'docs/a.md',
  entryKind: 'file',
  ...(nodeAnchor === undefined ? {} : { nodeAnchor }),
});

test('G06 原目标有锚、当前锚拿不到：拒绝（不得把"无法确认"当成"身份一致"）', () => {
  const problem = tc.treeTargetProblemOf({
    target: fileTarget('anchor-a1'),
    projectExists: true,
    projectReady: true,
    entryPresent: true,
    currentAnchor: null,
  });
  assert.notEqual(problem, null, '锚缺失时必须 fail-closed');
  assert.match(problem ?? '', /无法确认/);
});

test('G07 两个锚不同：拒绝（对象已被替换）', () => {
  const problem = tc.treeTargetProblemOf({
    target: fileTarget('anchor-a1'),
    projectExists: true,
    projectReady: true,
    entryPresent: true,
    currentAnchor: 'anchor-a2',
  });
  assert.match(problem ?? '', /已经变化/);
});

test('G08 锚相同：放行', () => {
  assert.equal(
    tc.treeTargetProblemOf({
      target: fileTarget('anchor-a1'),
      projectExists: true,
      projectReady: true,
      entryPresent: true,
      currentAnchor: 'anchor-a1',
    }),
    null,
  );
});

test('G09 原目标没有锚（Provider 明确无身份能力）：不误伤，继续放行', () => {
  /*
   * R1.1：'没有锚'本身不足以证明'Provider 没有身份能力'——它也可能是探测失败。
   * 因此这条用例必须**显式声明** `nodeIdentity: 'unsupported'`（Host 的能力声明），
   * 才允许按路径身份降级。声明缺失或为 'unverified' 时不放行（见 108 B09）。
   *
   * R1.2 把这条降级改成**两侧对称**：当前侧也必须是明确的 `unsupported`。
   * 这里补上 `currentIdentity`（由同一层的 `identitySupport` 推导），
   * 断言本身没有放宽——下面新增的"当前侧无法确认"一条就是它的反面。
   */
  const unsupported = { ...fileTarget(), nodeIdentity: 'unsupported' as const };
  assert.equal(
    tc.treeTargetProblemOf({
      target: unsupported,
      projectExists: true,
      projectReady: true,
      entryPresent: true,
      currentAnchor: null,
      currentIdentity: 'unsupported',
    }),
    null,
  );
  // 空串等同于"拿不到锚"，不能当成一个有效身份去比较
  assert.equal(
    tc.treeTargetProblemOf({
      target: unsupported,
      projectExists: true,
      projectReady: true,
      entryPresent: true,
      currentAnchor: '',
      currentIdentity: 'unsupported',
    }),
    null,
  );
  // R1.2：当前侧无法确认时，同一条路径身份降级**不再**放行
  assert.equal(
    typeof tc.treeTargetProblemOf({
      target: unsupported,
      projectExists: true,
      projectReady: true,
      entryPresent: true,
      currentAnchor: null,
      currentIdentity: 'unverified',
    }),
    'string',
  );
});

test('G10 空串锚也算"无法确认"：原目标有锚时同样拒绝', () => {
  const problem = tc.treeTargetProblemOf({
    target: fileTarget('anchor-a1'),
    projectExists: true,
    projectReady: true,
    entryPresent: true,
    currentAnchor: '',
  });
  assert.notEqual(problem, null);
});

test('G11 blank / toolbar / link / project-root 不受锚核验影响', () => {
  const shared = {
    projectExists: true,
    projectReady: true,
    entryPresent: true,
    currentAnchor: null,
  };
  for (const origin of ['blank', 'toolbar', 'link'] as const) {
    assert.equal(
      tc.treeTargetProblemOf({
        ...shared,
        target: { origin, projectId: 'p1', nodePath: 'docs/a.md', nodeAnchor: 'anchor-a1' },
      }),
      null,
      `${origin} 没有"条目身份"可比`,
    );
  }
  // 项目根：身份由根令牌（projectAnchor）表达，根行不进入条目锚比较
  assert.equal(
    tc.treeTargetProblemOf({
      ...shared,
      target: { origin: 'project-root', projectId: 'p1', nodeAnchor: 'anchor-root' },
    }),
    null,
  );
});

test('G12 项目消失 / 不可用 / 行被移除：仍然先于锚判断给出原因', () => {
  const base = { target: fileTarget('anchor-a1'), currentAnchor: null };
  assert.match(
    tc.treeTargetProblemOf({ ...base, projectExists: false, projectReady: true, entryPresent: true }) ?? '',
    /不在工作区/,
  );
  assert.match(
    tc.treeTargetProblemOf({ ...base, projectExists: true, projectReady: false, entryPresent: true }) ?? '',
    /不可用/,
  );
  assert.match(
    tc.treeTargetProblemOf({ ...base, projectExists: true, projectReady: true, entryPresent: false }) ?? '',
    /移除或替换/,
  );
});

/* ================================================================== */
/* S 组：项目显示名编辑会话归属                                        */
/* ================================================================== */

test('S01 会话归属一致、项目可用：放行提交', () => {
  assert.equal(
    tc.projectRenameGateOf({
      sessionScope: 'live\u0000multi\u0000ws-1',
      currentScope: 'live\u0000multi\u0000ws-1',
      projectExists: true,
      projectSupported: true,
    }),
    'ok',
  );
});

test('S02 工作区 / 模式变化：旧会话不得在新世界里提交', () => {
  assert.equal(
    tc.projectRenameGateOf({
      sessionScope: tc.workspaceScopeOf({ mode: 'live', workspaceMode: 'multi', workspaceKey: 'ws-1' }),
      currentScope: tc.workspaceScopeOf({ mode: 'live', workspaceMode: 'multi', workspaceKey: 'ws-2' }),
      projectExists: true,
      projectSupported: true,
    }),
    'scope-changed',
  );
  // scope 优先于"项目还在不在"：旧世界的会话不能因为新世界有同名项目就继续
  assert.equal(
    tc.projectRenameGateOf({
      sessionScope: 'old',
      currentScope: 'new',
      projectExists: false,
      projectSupported: false,
    }),
    'scope-changed',
  );
});

test('S03 项目已不在工作区 / 已不可用：分别给出原因', () => {
  const scope = 'live\u0000multi\u0000ws-1';
  assert.equal(
    tc.projectRenameGateOf({ sessionScope: scope, currentScope: scope, projectExists: false, projectSupported: true }),
    'project-missing',
  );
  assert.equal(
    tc.projectRenameGateOf({ sessionScope: scope, currentScope: scope, projectExists: true, projectSupported: false }),
    'unsupported',
  );
});

test('S04 每个不放行的原因都有可展示的文案，ok 没有文案', () => {
  assert.equal(tc.projectRenameGateMessage('ok'), null);
  for (const gate of ['scope-changed', 'project-missing', 'unsupported'] as const) {
    const message = tc.projectRenameGateMessage(gate);
    assert.equal(typeof message, 'string');
    assert.ok((message ?? '').length > 0, `${gate} 必须有说明`);
  }
});

test('S05 结果落地：已发出的请求不得被伪装成未发送，也不自动重试', () => {
  assert.equal(tc.projectRenameResultEffect({ applied: true, sessionStillCurrent: true }), 'close');
  assert.equal(tc.projectRenameResultEffect({ applied: false, sessionStillCurrent: true }), 'keep-error');
  // 会话已失效（切了工作区/项目）：只提示，不写回新会话，也不重发
  assert.equal(tc.projectRenameResultEffect({ applied: true, sessionStillCurrent: false }), 'notice-only');
  assert.equal(tc.projectRenameResultEffect({ applied: false, sessionStillCurrent: false }), 'notice-only');
});

/* ================================================================== */
/* M 组：源码守卫                                                      */
/* ================================================================== */

const component = (name: string): Promise<string> =>
  readFile(join(process.cwd(), 'apps/shell/src/components', name), 'utf8');

test('M01 行组件把点击绑定到身份，而不是只调用"最新回调"', async () => {
  const source = await component('FileTreeRow.tsx');
  assert.match(source, /activationIdentity/, '行必须接收资源身份');
  assert.match(source, /arbiter\.click\(event\.detail, identity\)/, '单击必须带发起时的身份');
  assert.match(source, /arbiter\.doubleClick\(identity\)/, '双击必须带第二次点击的身份');
  assert.match(source, /currentIdentity: \(\) => latest\.current\.identity/, '仲裁器读的是当前身份');
});

test('M02 项目改名提交前复核会话归属，提交后按会话核对结果', async () => {
  /*
   * R1.2：会话归属编排从组件搬进了 `state/project-rename.ts`（为了能跑真实异步测试），
   * 所以断言改指向**实现所在的那个模块**，强度不变：
   * 提交前必须复核并真的挡住、结果必须按票据核对、落地必须走同一判定。
   * 同时守住组件只剩注入，不允许把判定抄回来两处各一份。
   */
  const source = await readFile(
    join(process.cwd(), 'apps/shell/src/state/project-rename.ts'),
    'utf8',
  );
  assert.match(source, /projectRenameGateOf\(/, '提交前必须复核归属');
  // 光"调用了"不算：结论必须真的挡住提交，否则就只是算了一遍又放行
  assert.match(source, /if \(gate !== 'ok'\) \{\s*port\.close/, '不放行时必须收起会话并中止');
  assert.match(source, /projectRenameSessionStillCurrent\(/, '结果必须按会话票据核对');
  assert.match(source, /projectRenameResultEffect\(/, '结果落地走同一判定');
  const context = await component('TreeCommandsContext.tsx');
  assert.match(context, /workspaceScopeOf\(/, '工作区身份变化要让会话失效');
  assert.match(context, /createProjectRenameFlow\(/, '组件只做注入，判定在纯模块里');
  assert.doesNotMatch(context, /projectRenameGateOf\(/, '不得在组件里再抄一份提交前复核');
});

test('M03 改名链路仍然只有一条，且没有自动重试', async () => {
  const source = await component('TreeCommandsContext.tsx');
  const calls = source.match(/actions\.renameProject\(/g) ?? [];
  assert.equal(calls.length, 1, '只有一个 renameProject 调用点');
  assert.doesNotMatch(source, /setTimeout\([^)]*renameProject/, '不得定时重发');
  assert.doesNotMatch(source, /for\s*\([^)]*\)\s*\{[^}]*renameProject/, '不得循环重试');
});
