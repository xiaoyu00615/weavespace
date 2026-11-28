/**
 * UX-02C-02：Shell 侧改名 / 移动编排（纯 TS，先红后绿）。
 *
 * 覆盖：行内预填与选区、目标规则、移动候选目录、本地草稿门禁、
 * 单飞、UNKNOWN 恰好一次只读核对且不重发、只有 APPLIED 才刷新层表、
 * 请求体形状、Demo 不支持、层表按前缀作废与迟到请求失效、workspaceKey 不变。
 * 真实磁盘与 HTTP 由套件 72 覆盖，行内/菜单/选择器由真实 Chrome 覆盖。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { StructureChangeOutcome } from '../../apps/shell/src/client/client-api.ts';
import { createDemoClient } from '../../apps/shell/src/client/client-api.ts';
import {
  blockedText,
  createStructureRunner,
  displayPath,
  inputSurvivesStructureResult,
  localStructureBlockers,
  moveTargetOptions,
  renameDraftOf,
  selectionForRename,
  structureTargetCheck,
  type StructureSubmitInput,
} from '../../apps/shell/src/state/structure-change.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import { createTreeOwnershipGuard, type TreeLoadIdentity } from '../../apps/shell/src/state/tree-load.ts';
import type { StructureIntent } from '../../apps/shell/src/state/structure-intent.ts';
import { validateEntryName } from '../../packages/storage/entry-name.ts';

const applied = (over: Record<string, unknown> = {}): StructureChangeOutcome => ({
  status: 'APPLIED',
  projectId: 'project-a',
  sourcePath: 'docs/notes.md',
  targetPath: 'docs/数学笔记.md',
  targetParentDir: 'docs',
  targetName: '数学笔记.md',
  entryKind: 'file',
  contentSha256: 'sha256:a',
  ...over,
}) as StructureChangeOutcome;

/**
 * 冻结意图（UX-02C-02-R2.1）：锚 + 世界 + 票据。
 *
 * 这里是纯编排层，锚只需形状合法；世界与票据用来证明"提交前必须核验"这条链
 * 走的是真实对象，而不是重新查一次"当前最新意图"。
 */
const testIntent = (over: Partial<StructureIntent> = {}): StructureIntent => ({
  projectId: 'project-a',
  sourcePath: 'docs/notes.md',
  entryKind: 'file',
  anchor: '0123456789abcdef0123456789abcdef',
  verification: 'verified',
  world: { mode: 'live', workspaceMode: 'multi', workspaceKey: 'ws-1', epoch: 1 },
  sessionId: 1,
  ...over,
});

const baseSubmit = (over: Partial<StructureSubmitInput> = {}): StructureSubmitInput => ({
  kind: 'rename',
  projectId: 'project-a',
  sourcePath: 'docs/notes.md',
  targetParentDir: 'docs',
  targetName: '数学笔记.md',
  entryKind: 'file',
  intent: testIntent(),
  ...over,
});

/* ------------------------- 行内预填 / 目标规则 ------------------------- */

test('改名预填原名并只选中主文件名，扩展名保留', () => {
  assert.deepEqual(renameDraftOf('docs/notes.md'), {
    sourcePath: 'docs/notes.md',
    parentDir: 'docs',
    draft: 'notes.md',
    selection: [0, 5],
  });
  assert.deepEqual(selectionForRename('README'), [0, 6]);
  assert.deepEqual(selectionForRename('.env'), [0, 4], '点文件名没有主名可选');
  assert.deepEqual(renameDraftOf('a.txt').parentDir, '');
});

test('目标规则：目录不得移入自身/后代；非法名称与相对逃逸拒绝', () => {
  assert.deepEqual(
    structureTargetCheck({
      sourcePath: 'docs/notes.md',
      targetParentDir: 'archive',
      targetName: 'notes.md',
      entryKind: 'file',
    }),
    { ok: true },
  );
  const intoSelf = structureTargetCheck({
    sourcePath: 'docs',
    targetParentDir: 'docs/nested',
    targetName: 'docs',
    entryKind: 'directory',
  });
  assert.equal(intoSelf.ok, false);
  assert.match(intoSelf.ok === false ? intoSelf.reason : '', /自身/);
  assert.equal(validateEntryName('CON.txt').ok, false);
  for (const bad of ['..', '../escape', 'C:/x', '/abs']) {
    assert.equal(
      structureTargetCheck({
        sourcePath: 'a.md',
        targetParentDir: bad,
        targetName: 'a.md',
        entryKind: 'file',
      }).ok,
      false,
      bad,
    );
  }
});

test('移动候选只含已加载层表里的真实普通文件夹，排除自身/后代与链接', () => {
  const options = moveTargetOptions(
    {
      '': {
        entries: [
          { id: 'dir:project-a/docs', kind: 'folder', path: 'docs' },
          { id: 'dir:project-a/archive', kind: 'folder', path: 'archive' },
          { id: 'doc:project-a/a.md', kind: 'file', path: 'a.md' },
          { id: 'link:project-a/escape', kind: 'link', path: 'escape' },
        ],
      },
      docs: {
        entries: [
          { id: 'dir:project-a/docs/nested', kind: 'folder', path: 'docs/nested' },
        ],
      },
    },
    'docs',
    'directory',
  );
  assert.deepEqual(options, ['', 'archive'], '未加载到的层不假装存在，链接不列入，后代被排除');
  assert.equal(displayPath(''), '（项目根）');
});

/* ------------------------- 本地草稿门禁 ------------------------- */

test('本地标签/草稿阻断（含 Host 重启后的脱节场景），只判不救', () => {
  const tabs = [
    { projectId: 'project-a', path: 'docs/notes.md', dirty: true, saving: false, documentState: 'EDITING_DIRTY', lastStatus: null },
    { projectId: 'project-a', path: 'other.md', dirty: false, saving: false, documentState: 'CLEAN', lastStatus: null },
    { projectId: 'project-b', path: 'docs/notes.md', dirty: true, saving: false, documentState: 'EDITING_DIRTY', lastStatus: null },
  ];
  const codes = localStructureBlockers(tabs, 'project-a', 'docs/notes.md', 'file');
  assert.deepEqual(codes, ['ACTIVE_VIEWS', 'DIRTY']);
  assert.match(blockedText(codes), /未保存修改/);
  // 目录：后代文件的草稿也必须拦
  const dirCodes = localStructureBlockers(tabs, 'project-a', 'docs', 'directory');
  assert.ok(dirCodes.includes('DIRTY'));
  assert.deepEqual(localStructureBlockers(tabs, 'project-b', 'b.md', 'file'), []);
  const unknown = localStructureBlockers(
    [{ projectId: 'project-a', path: 'docs/x.md', dirty: true, saving: false, documentState: 'OUTCOME_UNKNOWN', lastStatus: 'UNKNOWN' }],
    'project-a',
    'docs/x.md',
    'file',
  );
  assert.ok(unknown.includes('OUTCOME_UNKNOWN') && unknown.includes('DIRTY'));
});

/* ------------------------- runner：单飞 / UNKNOWN / APPLIED ------------------------- */

function harness(outcome: StructureChangeOutcome | (() => never), opts: { blocked?: string[] } = {}) {
  const calls: string[] = [];
  const notices: string[] = [];
  /** 提交前的身份核验记录：证明它发生在发请求之前，且阻断时一次都不发生。 */
  const verifications: string[] = [];
  /** 拒绝上报记录（UX-02C-02-R2）：Shell 据此把源所在的层判为过期。 */
  const rejections: Array<{ errorCode: string | null; projectId: string; sourcePath: string }> = [];
  const runner = createStructureRunner({
    rename: async () => {
      calls.push('rename');
      if (typeof outcome === 'function') throw new Error('ECONNRESET');
      return outcome;
    },
    move: async () => {
      calls.push('move');
      if (typeof outcome === 'function') throw new Error('ECONNRESET');
      return outcome;
    },
    localBlockers: () => opts.blocked ?? [],
    // 提交前的意图核验：`null` 表示"还是那个对象、还在那个世界"，可以发请求。
    verifyIntent: ({ intent }) => {
      verifications.push(`${intent.projectId}:${intent.sourcePath}:${intent.entryKind}`);
      return null;
    },
    onRejected: (outcome, target) => {
      rejections.push({
        errorCode: outcome.errorCode,
        projectId: target.projectId,
        sourcePath: target.sourcePath,
      });
    },
    checkLocations: async (pid, src, dst) => {
      calls.push(`check:${pid}:${src}:${dst}`);
      return 'applied';
    },
    onApplied: (value) => calls.push(`applied:${value.targetPath}`),
    onNotice: (message) => notices.push(message),
  });
  return { runner, calls, notices, verifications, rejections };
}

test('只有 Host 明确 APPLIED 才刷新层表；失败保留输入不刷新', async () => {
  const h = harness(applied());
  assert.equal(await h.runner.submit(baseSubmit()), 'applied');
  assert.deepEqual(h.calls, ['rename', 'applied:docs/数学笔记.md']);
  assert.deepEqual(h.verifications, ['project-a:docs/notes.md:file'], '发请求前核验过一次身份');
  assert.deepEqual(h.rejections, [], '成功不触发拒绝上报');

  const rejected = harness({
    status: 'REJECTED',
    errorCode: 'ERR_ENTRY_EXISTS',
    message: '同名冲突',
    httpStatus: 409,
  });
  assert.equal(await rejected.runner.submit(baseSubmit()), 'rejected');
  assert.deepEqual(rejected.calls, ['rename']);
  assert.match(rejected.notices[0] ?? '', /同名冲突/);
});

test('拒绝上报：源对象变了/不在了才上报，Shell 据此只重取源父层（UX-02C-02-R2）', async () => {
  /*
   * 为什么需要这条上报：`ERR_ENTRY_SOURCE_CHANGED` 是一条磁盘事实——层表里那一行
   * 还挂着替换前的锚。工具栏的「刷新当前目录」只重取项目根层，嵌套文件的旧锚
   * 没有任何界面途径能刷掉，用户重试多少次都会被同一个旧锚挡住。
   */
  const changed = harness({
    status: 'REJECTED',
    errorCode: 'ERR_ENTRY_SOURCE_CHANGED',
    message: '该路径上的文件已被外部替换，未执行任何移动',
    httpStatus: 409,
  });
  assert.equal(await changed.runner.submit(baseSubmit()), 'rejected');
  assert.deepEqual(changed.rejections, [
    { errorCode: 'ERR_ENTRY_SOURCE_CHANGED', projectId: 'project-a', sourcePath: 'docs/notes.md' },
  ]);

  const vanished = harness({
    status: 'REJECTED',
    errorCode: 'ERR_RESOURCE_NOT_FOUND',
    message: '源文件已经不存在',
    httpStatus: 404,
  });
  assert.equal(await vanished.runner.submit(baseSubmit()), 'rejected');
  assert.deepEqual(
    vanished.rejections.map((item) => item.errorCode),
    ['ERR_RESOURCE_NOT_FOUND'],
  );

  // 同名冲突这类拒绝不代表"对象变了"：照样上报，由 Shell 自己决定要不要重取。
  const exists = harness({
    status: 'REJECTED',
    errorCode: 'ERR_ENTRY_EXISTS',
    message: '目标已存在',
    httpStatus: 409,
  });
  assert.equal(await exists.runner.submit(baseSubmit()), 'rejected');
  assert.deepEqual(
    exists.rejections.map((item) => item.errorCode),
    ['ERR_ENTRY_EXISTS'],
    '上报只陈述事实，不替调用方做决定',
  );

  // 本地阻断、缺锚、UNKNOWN 都不算"Host 明确拒绝"，一次都不上报。
  const blocked = harness(applied(), { blocked: ['DIRTY'] });
  assert.equal(await blocked.runner.submit(baseSubmit()), 'blocked');
  assert.deepEqual(blocked.rejections, []);

  const unknown = harness({
    status: 'UNKNOWN',
    errorCode: 'ERR_OUTCOME_UNKNOWN',
    message: '不确定',
    httpStatus: 0,
    projectId: 'project-a',
    sourcePath: 'docs/notes.md',
    targetParentDir: 'docs',
    targetName: '数学笔记.md',
  });
  assert.equal(await unknown.runner.submit(baseSubmit()), 'unknown');
  assert.deepEqual(unknown.rejections, [], 'UNKNOWN 不能当作"已经变了"，只做只读核对');
});

test('网络断开 / UNKNOWN：恰好一次只读核对，绝不重发、不据目标存在推断成功', async () => {
  const network = harness(() => {
    throw new Error('ECONNRESET');
  });
  assert.equal(
    await network.runner.submit(
      baseSubmit({
        kind: 'move',
        targetParentDir: 'archive',
        targetAnchor: 'fedcba9876543210fedcba9876543210',
      }),
    ),
    'unknown',
  );
  assert.deepEqual(network.calls, ['move', 'check:project-a:docs:archive']);
  assert.match(network.notices[0] ?? '', /人工核对/);
  assert.doesNotMatch(network.notices[0] ?? '', /已创建|已移动/);

  const unknown = harness({
    status: 'UNKNOWN',
    errorCode: 'ERR_OUTCOME_UNKNOWN',
    message: '结果未确认',
    httpStatus: 202,
    projectId: 'project-a',
    sourcePath: 'docs/notes.md',
    targetParentDir: 'docs',
    targetName: '数学笔记.md',
  });
  assert.equal(await unknown.runner.submit(baseSubmit()), 'unknown');
  assert.deepEqual(unknown.calls, ['rename', 'check:project-a:docs:docs']);
});

test('本地阻断 / 非法目标：零请求；并发提交只有一个真正发请求', async () => {
  const blocked = harness(applied(), { blocked: ['ACTIVE_VIEWS', 'DIRTY'] });
  assert.equal(await blocked.runner.submit(baseSubmit()), 'blocked');
  assert.deepEqual(blocked.calls, []);
  assert.deepEqual(blocked.verifications, [], '本地阻断比身份核验更早，一次都不做');
  assert.match(blocked.notices[0] ?? '', /打开的编辑标签/);

  const invalid = harness(applied());
  assert.equal(await invalid.runner.submit(baseSubmit({ targetName: 'CON.txt' })), 'rejected');
  assert.deepEqual(invalid.calls, []);

  const concurrent = harness(applied());
  const [a, b] = await Promise.all([
    concurrent.runner.submit(baseSubmit()),
    concurrent.runner.submit(baseSubmit()),
  ]);
  assert.ok([a, b].includes('applied'));
  assert.ok([a, b].includes('busy'));
  assert.equal(concurrent.calls.filter((c) => c === 'rename').length, 1);
});

/**
 * 浏览器验收发现的缺陷：活动 View 阻断（blocked）时输入行被收起，
 * onNotice 刚写入的行内错误随之被抹掉——磁盘保护住了，用户却看不到原因。
 * 锚定：blocked / busy / rejected 必须保留输入并显示原因，applied / unknown 才收起。
 */
test('提交结果 → 输入行去留：blocked/busy/rejected 保留，applied/unknown 收起', () => {
  assert.equal(inputSurvivesStructureResult('blocked'), true, '活动 View 阻断要保留输入并显示原因');
  assert.equal(inputSurvivesStructureResult('busy'), true, '并发繁忙不得无声收起输入');
  assert.equal(inputSurvivesStructureResult('rejected'), true, '重名/非法名保留输入供修正');
  assert.equal(inputSurvivesStructureResult('applied'), false, '成功后收起');
  assert.equal(inputSurvivesStructureResult('unknown'), false, 'UNKNOWN 收起但提示留在状态栏，绝不暗示可重试');
});

/* ------------------------- reducer / 归属票据 / Demo ------------------------- */

test('TREE_STRUCTURE_CHANGED 只作废旧路径的层与展开/选择，不动其它项目', () => {
  const levels = {
    '': { entries: [], dir: '', status: 'ready' as const, nextCursor: null, total: 0, errorCode: null, loadingMore: false, snapshot: null },
    docs: { entries: [], dir: 'docs', status: 'ready' as const, nextCursor: null, total: 0, errorCode: null, loadingMore: false, snapshot: null },
    'docs/nested': { entries: [], dir: 'docs/nested', status: 'ready' as const, nextCursor: null, total: 0, errorCode: null, loadingMore: false, snapshot: null },
    archive: { entries: [], dir: 'archive', status: 'ready' as const, nextCursor: null, total: 0, errorCode: null, loadingMore: false, snapshot: null },
  };
  const start = {
    ...INITIAL_STATE,
    treeByProject: { 'project-a': levels, 'project-b': levels },
    expandedByProject: {
      'project-a': { 'dir:project-a/docs': true, 'dir:project-a/docs/nested': true, 'dir:project-a/archive': true },
    },
    selectedByProject: { 'project-a': 'doc:project-a/docs/notes.md' },
    tabs: INITIAL_STATE.tabs,
  } as unknown as typeof INITIAL_STATE;
  const next = workspaceReducer(start, {
    type: 'TREE_STRUCTURE_CHANGED',
    projectId: 'project-a',
    sourcePath: 'docs',
    targetPath: 'archive/docs',
  });
  assert.deepEqual(Object.keys(next.treeByProject['project-a']!).sort(), ['', 'archive']);
  assert.equal(next.treeByProject['project-b'], levels, '其它项目层表引用不变');
  assert.equal(next.expandedByProject['project-a']?.['dir:project-a/docs'], undefined);
  assert.equal(next.expandedByProject['project-a']?.['dir:project-a/archive'], true);
  assert.equal(next.selectedByProject['project-a'], null);
  assert.equal(next.tabs, start.tabs, '标签与草稿一概不动');
  assert.equal(next.workspaceKey, start.workspaceKey, '项目注册集合没变，摘要不得变化');
});

test('invalidateLevel 使旧路径的迟到响应失效', () => {
  const identity: TreeLoadIdentity = {
    mode: 'live',
    syncMode: 'live',
    workspaceKey: 'k',
    epoch: 1,
  };
  const guard = createTreeOwnershipGuard(() => identity);
  const old = guard.begin('project-a', 'docs');
  assert.ok(old);
  guard.invalidateLevel('project-a', 'docs');
  assert.equal(guard.isCurrent(old), false, '旧路径在途票据作废');
  const fresh = guard.begin('project-a', 'archive');
  assert.ok(fresh && guard.isCurrent(fresh), '新位置的新请求仍属当前代');
});

test('Demo 客户端明确不支持真实改名/移动', async () => {
  const demo = createDemoClient([], {});
  assert.equal((await demo.renameEntry('p', 'a.md', 'b.md', '0123456789abcdef0123456789abcdef')).status, 'REJECTED');
  assert.equal((await demo.moveEntry('p', 'a.md', '', 'a.md', '0123456789abcdef0123456789abcdef', 'fedcba9876543210fedcba9876543210')).status, 'REJECTED');
});
