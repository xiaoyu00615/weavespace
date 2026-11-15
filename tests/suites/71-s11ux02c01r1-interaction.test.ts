/**
 * UX-02C-01-R1：折叠目录中创建 / 预设扩展名空主名（纯 TS，先红后绿）。
 *
 * 组件（.tsx）不能被 node:test import，所以"开始创建时该展开什么"与
 * "预设主名为空时该不该提交"这两条判定都抽到纯模块 `state/create-entry.ts`：
 * - `createExpansionPlan()`：由目标目录 + 层表算出需要幂等展开的节点；
 * - `missingPresetStem()`：只在**预设扩展名模式**下挡住空主名，自由输入不额外限制；
 * - `createEntryRunner()`：即使调用方漏了预检，也不允许把 `.md` 发给 Host。
 *
 * 真实输入框是否可见/聚焦、Enter/Esc 是否可用由真实 Chrome 验收（见证据目录）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEntryRunner,
  createExpansionPlan,
  EMPTY_PRESET_STEM_MESSAGE,
  folderNodeIdOf,
  missingPresetStem,
  normalizeDir,
  type TreeLevelsView,
} from '../../apps/shell/src/state/create-entry.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import { validateEntryName } from '../../packages/storage/entry-name.ts';

const DOCS_ID = 'dir:project-a/docs';
const levels: TreeLevelsView = {
  '': {
    entries: [
      { id: DOCS_ID, kind: 'folder', path: 'docs' },
      { id: 'doc:project-a/a.md', kind: 'file', path: 'a.md' },
    ],
  },
  docs: {
    entries: [
      { id: 'dir:project-a/docs/nested', kind: 'folder', path: 'docs/nested' },
      { id: 'doc:project-a/docs/guide.md', kind: 'file', path: 'docs/guide.md' },
    ],
  },
};

/* ------------------------- R1-01 折叠目录中创建 ------------------------- */

test('R1-01 折叠文件夹：展开计划指向该文件夹自身，且要求打开所属项目根', () => {
  const plan = createExpansionPlan({
    projectId: 'project-a',
    parentDir: normalizeDir('docs'),
    levels,
    nodeId: DOCS_ID,
  });
  assert.deepEqual(plan, { rootProjectId: 'project-a', folderNodeId: DOCS_ID });
  assert.equal(plan.folderNodeId, folderNodeIdOf(levels, 'docs'));
});

test('R1-01 折叠项目根：计划只要求打开该项目的根，不展开任何文件夹、不跨项目', () => {
  assert.deepEqual(
    createExpansionPlan({ projectId: 'project-a', parentDir: '', levels }),
    { rootProjectId: 'project-a', folderNodeId: null },
  );
  assert.deepEqual(
    createExpansionPlan({ projectId: 'project-b', parentDir: '', levels: {} }),
    { rootProjectId: 'project-b', folderNodeId: null },
    '多项目下显式绑定目标项目，不借用活动项目',
  );
});

test('R1-01 空白区 / 工具栏选中折叠目录时，从层表解析目标节点；未加载到的分页不伪造节点', () => {
  assert.equal(folderNodeIdOf(levels, 'docs/nested'), 'dir:project-a/docs/nested');
  assert.equal(folderNodeIdOf(levels, 'missing'), null);
  assert.deepEqual(
    createExpansionPlan({ projectId: 'project-a', parentDir: 'docs', levels: {} }),
    { rootProjectId: 'project-a', folderNodeId: null },
  );
});

test('R1-01 展开是幂等的：重复展开不会把已展开目录折叠，也不动其它项目', () => {
  const once = workspaceReducer(INITIAL_STATE, {
    type: 'EXPAND_PROJECT_NODE',
    projectId: 'project-a',
    path: DOCS_ID,
  });
  const twice = workspaceReducer(once, {
    type: 'EXPAND_PROJECT_NODE',
    projectId: 'project-a',
    path: DOCS_ID,
  });
  assert.equal(once, twice, '幂等展开不产生新状态、更不会 toggle 回去');
  assert.equal(once.expandedByProject['project-a']?.[DOCS_ID], true);
  assert.equal(once.expandedByProject['project-b'], undefined);
  assert.equal(once.treeByProject, INITIAL_STATE.treeByProject, '不改任何层表/标签/草稿');
});

/* ------------------------- R1-02 预设文件名不能为空 ------------------------- */

test('R1-02 预设模式下主文件名为空时一律拦截', () => {
  assert.equal(missingPresetStem('.md', '.md'), true);
  assert.equal(missingPresetStem('.markdown', '.markdown'), true);
  assert.equal(missingPresetStem('.txt', '.txt'), true);
  assert.equal(missingPresetStem('', '.md'), true, '用户把初值整体删掉也不能提交');
  assert.equal(missingPresetStem(' .md', '.md'), true, '只有空白不算主文件名');
  assert.equal(EMPTY_PRESET_STEM_MESSAGE, '请先填写文件名');
});

test('R1-02 填了主名就放行；自由输入不额外禁止合法点文件名', () => {
  assert.equal(missingPresetStem('notes.md', '.md'), false);
  assert.equal(missingPresetStem('123.markdown', '.markdown'), false);
  assert.equal(missingPresetStem('notes', '.md'), false, '用户主动改掉扩展名不算空主名');
  assert.equal(missingPresetStem('.env'), false, '自由输入模式没有预设扩展名');
  assert.equal(missingPresetStem('.gitignore'), false);
  assert.equal(validateEntryName('.env').ok, true, 'Host 通用校验本就允许点文件名，本轮不改它');
});

test('R1-02 空主名绝不进入 Host 创建链路（编排器纵深防御）', async () => {
  const calls: string[] = [];
  const notices: string[] = [];
  const runner = createEntryRunner({
    create: async () => {
      calls.push('create');
      return { status: 'REJECTED', errorCode: null, message: '不该被调用', httpStatus: 0 };
    },
    checkDirectory: async () => { calls.push('check'); },
    onApplied: () => { calls.push('applied'); },
    onNotice: (message) => notices.push(message),
  });
  const result = await runner.submit({
    projectId: 'project-a',
    parentDir: '',
    name: '.md',
    kind: 'file',
    presetExtension: '.md',
  });
  assert.equal(result, 'rejected');
  assert.deepEqual(calls, [], '零 create、零只读核对');
  assert.deepEqual(notices, [EMPTY_PRESET_STEM_MESSAGE]);

  // 同一把 runner：填上主名后可以正常创建，且请求体不含 presetExtension
  const bodies: unknown[] = [];
  const runner2 = createEntryRunner({
    create: async (input) => {
      bodies.push(input);
      return {
        status: 'APPLIED',
        projectId: 'project-a',
        parentDir: '',
        name: 'notes.md',
        kind: 'file',
        relativePath: 'notes.md',
      };
    },
    checkDirectory: async () => {},
    onApplied: () => {},
    onNotice: () => {},
  });
  const ok = await runner2.submit({
    projectId: 'project-a',
    parentDir: '',
    name: 'notes.md',
    kind: 'file',
    presetExtension: '.md',
  });
  assert.equal(ok, 'applied');
  assert.deepEqual(bodies, [{ projectId: 'project-a', parentDir: '', name: 'notes.md', kind: 'file' }]);
});
