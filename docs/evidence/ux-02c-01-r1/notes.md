# UX-02C-01-R1 交互收尾 · 验收记录

基线 `0db95c8`；分支 `wip/s11-ux-02c-01-file-create-20261115`。只改 Shell 交互，
未触碰 StorageProvider / Host 创建端点 / 授权体系 / `packages/storage/entry-name.ts`。

## 1. 浏览器红测（基线，未修复）

真实 Chrome headless + CDP，Vite 5220 代理 Host 5221，fake-picker（非 Windows 原生弹窗）。
夹具：`weavespace-test/ux02c01r1-red3-projA|projB`（红）与 `ux02c01r1-green3-projA|projB`（绿），
各自独立目录、store、profile、调试端口。完整输出：`red/browser-verification.json`（`ok: false`，
17 项断言 14 false）。

| 场景 | 基线结果 |
|---|---|
| docs 折叠（`aria-expanded=false`）→ 右键 → 新建文件 | `input: null`、`docsExpandedAfter=false`（`red/01-collapsed-docs-create.png`） |
| 项目根折叠 → 右键 → 新建文件 | `input: null`、`rootExpandedAfter=false`（`red/02-collapsed-root-create.png`） |
| 预设 `.md` 未填主名 → Enter | `createRequestsDelta=1`，磁盘真实生成 `.md`，`inlineError=null`，输入行消失 |

基线上 `createBodies` 含 `{"name":".md"}`，以及自由输入的 `.env`（后者是本轮要**保留**的合法行为）。
另外三项为 true 的断言是「自由输入仍允许点文件名 / 不写入其它项目 / 不影响其它项目展开态」——
这些是**不应被改坏**的既有行为。

## 2. 定点修复

- `state/create-entry.ts`（纯 TS）：
  - `createExpansionPlan()` / `folderNodeIdOf()`：按目标目录与层表算出需**幂等展开**的节点，
    右键文件夹行直接用该行 `node.id`；分页未加载到的层返回 `null`，不展开幻影节点。
  - `missingPresetStem()` + `EMPTY_PRESET_STEM_MESSAGE`：只在**预设扩展名模式**挡住空主名；
    自由输入无 `presetExtension`，`.env` / `.gitignore` 仍由 Host 通用规则裁决。
  - `createEntryRunner.submit()` 增加纵深防御（漏预检也不发 Host），并显式拼装请求体，
    `presetExtension` 绝不进入 `/api/files/create`。
- `TreeCommandsContext.tsx`：项目根展开态上提到命令编排，`beginCreate` 在同一次渲染里
  `ensureRootOpen()` + `EXPAND_PROJECT_NODE`（幂等，绝不用 `TOGGLE_*`）+ 挂输入行；
  `submitNaming` 在置 `submitting` **之前**拦空主名，避免输入框被禁用而失焦。
- `TreeBranch.tsx`：文件夹右键目标带 `nodeId`。
- `ProjectList.tsx`：项目根 `open` / `onToggle` 改用编排里的 `isRootOpen` / `toggleRoot`。

## 3. 浏览器绿测（修复后）

完整输出：`green/browser-verification.json`（`ok: true`），18 项断言全绿
（比红测多一项「已展开目录不被误折叠」，它在基线上因输入行不存在而无法进入该分支）。

- R1-01a：docs 初始折叠 → 输入框 `value=""`、`focused=true`、`disabled=false`，
  `docsExpandedAfter=true`；Enter 后 `docs/inside-docs.md` 存在、项目根无同名文件；
  Esc 输入行消失且 `docs` 目录内容 SHA 对比前后目录列表不变。
- R1-01b：项目根初始折叠 → 输入框可见且聚焦、`rootExpandedAfter=true`；
  Enter 生成 `at-root-r1.md`；Esc 零磁盘变更。
- R1-02：`createRequestsDelta=0`、磁盘无 `.md`、`inlineError="请先填写文件名"`、
  输入行保留（截图 `green/03b-empty-stem-error.png`）；填入 `notes.md` 后创建成功；
  自由输入 `.env` 仍可创建。
- 其它项目 B 只有 `b.md`，未被写入，且项目根展开态前后一致；重复右键已展开的 docs
  不会把它折叠回去。4 次 POST 请求体都只有 `{projectId,parentDir,name}`，
  `parentDir` 分别为 `docs` / `''`，不含绝对路径、rootDir、rootToken 或 providerId。

## 4. 单测与变异探针

新增 `tests/suites/71-s11ux02c01r1-interaction.test.ts`（7 例）：折叠文件夹展开计划、
折叠项目根、空白区选中目录与未加载分页、幂等展开不动其它项目、预设空主名拦截、
自由输入点文件名、编排器零请求防御。基线先红（模块未提供这些导出），修复后 7/7 绿。
套件 69（17 例）、70（13 例）保持全绿。

| 探针 | 回退内容 | 结果 |
|---|---|---|
| P1 | `missingPresetStem` 恒 false | 用例 5、7 红 |
| P2 | `createExpansionPlan` 恒返回 `folderNodeId=null` | 用例 1 红 |
| P3 | 去掉 `createEntryRunner` 的空主名纵深防御 | 用例 7 红 |

三个探针都已还原，最终源码以 `git diff` 为准。

## 5. 门禁

`npm run test:p0` / `npm run typecheck` / `npm run typecheck:apps` /
`npm run build:shell` / `git diff --check` 全绿（详见提交说明）。

## 6. 边界

- Windows 原生目录对话框仍未自动化验证（fake-picker 沿用）。
- 展开的是"层表里真实存在"的节点；若目标目录所在分页尚未加载，不伪造可见性。
- 本轮没有引入 opId 证据链，UNKNOWN 仍是一次只读刷新 + 人工核对。
- 未来 7 个命令仍只是注册表占位，未渲染。
