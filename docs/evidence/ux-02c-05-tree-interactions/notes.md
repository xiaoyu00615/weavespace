# UX-02C-05 证据：文件树菜单、工具栏与快捷交互统一

父提交 `ab73286`（UX-02C-04-R1-H1），分支 `wip/ux-02c-05-tree-interactions-20261127`。
本轮**没有新增任何文件系统操作**：只把已有能力收敛成一套统一交互（矩阵 + 入口 + 失效守卫）。

## 1. 做了什么（一句话版）

| 项 | 之前 | 之后 |
|---|---|---|
| 可用性 | 菜单里现算 `usable` + 每项手写 `disabled`；工具栏另算一份 | `tree-commands.ts::treeCommandMatrix` 一份，菜单/工具栏/键盘都取它 |
| 项目根菜单 | 只有创建/标注/刷新 | 加 `rename-project`（显示名）与 `remove-project`（解除注册） |
| 双击名称 | 没有（且与改名保护冲突） | 名称区单击延后 200ms + 双击改名；图标/空白仍立即激活 |
| 键盘 | 没有 | F2 / Shift+F10 / 菜单键 / Escape，只在树范围生效 |
| 项目显示名会话 | `ProjectList` 的局部 `useState` | 上提到编排：菜单、铅笔、双击共用一份会话 |
| 菜单失效 | 切模式后菜单仍在 | `menuIdentityOf` 变化即关；执行前 `treeTargetProblemOf` 再核一次 |
| 菜单夹取 | 组件内联 `Math.min/max` | `menuPositionOf` 纯函数，可断言 |

## 2. 修改文件

新增：

- `apps/shell/src/state/tree-commands.ts`（纯 TS，258 行：矩阵/顺序/失效/键盘/几何/身份/仲裁）
- `tests/suites/106-s11ux02c05-tree-interactions.test.ts`（32 例）
- `docs/29_UX-02C-05_文件树交互契约.md`

修改：

- `apps/shell/src/components/TreeCommandsContext.tsx`（重写菜单装配 + 执行前失效检测 + 键盘 + 项目显示名会话）
- `apps/shell/src/components/ContextMenu.tsx`（`identity` prop、`onClose(reason)`、`menuPositionOf`、`data-command` / `data-disabled` / `data-menu-identity`）
- `apps/shell/src/components/FileTreeRow.tsx`（`onRenameRequest` / `onFocus` / 单击双击仲裁）
- `apps/shell/src/components/TreeBranch.tsx`（三种节点各自提取目标常量，右键与焦点共用）
- `apps/shell/src/components/ProjectList.tsx`（根目标、显示名会话上提、树键盘入口）
- `apps/shell/src/components/TreeToolbar.tsx`（只取矩阵三格 + `data-toolbar-command`）
- `apps/shell/src/components/RemoveProjectEntry.tsx`（拆出受控 `RemoveProjectDialog`）
- `apps/shell/src/components/ProjectTree.tsx`（树键盘入口）

## 3. 定向测试

`tests/suites/106-s11ux02c05-tree-interactions.test.ts`，32 例全绿：

- A01–A07：四类目标 + 链接 + 不可用项目 + 隐藏互斥
- B01–B03：工具栏与空白区同一目标、文件右键落父目录、工具栏取矩阵同一格
- C01–C02：禁用必带原因、禁用项在执行层也拒绝
- D01–D06：仲裁器（单击延迟一次 / 双击零激活 / detail=0 立即 / 不残留 / cancel / 连续双击不额外激活）
- E01–E03：键盘意图、可编辑区不抢键、无焦点不给意图
- G01–G05：项目消失 / 不可用 / 行被移除 / 锚变化 / 正常不阻断
- H01–H03：视口夹取、超视口、身份键变化
- I01–I03：源码守卫（命令编排不发请求、工具栏不自算可用性、项目改名走命令编排）

## 4. 变异探针（`mutate.mjs` → `mutations.json`）

| id | 变异 | 结果 |
|---|---|---|
| C05-M1 | 项目根菜单混入「移入回收区」 | **BITTEN** → A03 |
| C05-M2 | 可点的命令也带禁用原因 | **BITTEN** → A01 |
| C05-M3 | 名称单击不再延后（立即激活） | **BITTEN** → D01/D02/D04/D05 |
| C05-M4 | 执行前不比对资源锚 | **BITTEN** → G04 |
| C05-M5 | 菜单身份不含当前项目 | **BITTEN** → H03 |
| C05-M6 | （纵深防御）去掉"连击第二下不排定时器" | **NOT_BITTEN**（`doubleClick()` 自己会 `clear()`；如实记录，不计入判别力） |

每次变异后文件都逐字节还原（`restoreExact: true`）。

## 5. 真实浏览器（`verify-tree-interactions.mjs` → `browser-verification.json`）

真实 Chrome（headless=new，CDP）+ 真实 Host（`--workspace-store`）+ 独立测试 Workspace
`D:/Workspace/projects/weavespace-test/c05`，**49/49 通过**。

| 图 | 内容 |
|---|---|
| `01-file-menu.png` | 文件右键：改名/移动到/隐藏/回收/标注×3/创建×3/刷新，无根专有命令 |
| `02-folder-menu.png` | 文件夹右键：回收可见但因"只处理普通文件"禁用 |
| `03-root-menu.png` | 项目根右键：创建×3 / 修改项目显示名称 / 标注×3 / 刷新项目根 / 从工作台移除项目 |
| `04-blank-menu.png` | 空白区：只有创建×3 与刷新 |
| `05-name-edit-dblclick.png` | 双击名称进入改名；**文件未被打开**（标签栏空、行上无"已打开"点） |
| `06-stale-menu-closed.png` | 切到演示模式后旧菜单已消失 |
| `07-demo-disabled-reasons.png` | 演示模式：每条禁用命令右侧都有原因；四条创建/刷新统一为"请先选中一个项目" |

关键事实（`facts`）：

- `createTargets = { blank: {parentDir:'dir'}, toolbar: {parentDir:'dir'} }` —— 工具栏与空白区**同一个目标**；
- 对根上文件右键创建：`parentDir: ''`（不是 `note.md`）；
- 改名请求体 `{ projectId, sourcePath, name }`，一次确认只发一次；用 `Fetch.requestPaused` 挂住请求后连按两次 Enter，`paused.length === 1`。

## 6. 全量门禁

| 命令 | 结果 |
|---|---|
| `npm run test:p0` | **1390 例 / 1388 pass / 0 fail / 2 skip**（基线 1358 + 新增 32） |
| `npm run typecheck` | 通过 |
| `npm run typecheck:apps` | 通过（shell + server） |
| `npm run build:shell` | 通过 |
| `git diff --check` | 通过（修掉 `TreeCommandsContext.tsx` 末尾多余空行） |

原始输出：`gate-test-p0.txt`、`gate-typecheck-build.txt`。

没有删除任何旧用例，没有放宽任何安全断言。

## 7. 未解决风险

见 `docs/29_UX-02C-05_文件树交互契约.md` §9（C05-R1～R7），其中 R4 / R5 / R7 记入 ARCH-01：

- R4：`trash.ts` 里"项目根不能回收"的分支已被矩阵短路，成为不可达代码；
- R5：`ContextMenu` 的 `MENU_WIDTH = 224` 与 CSS `min-width` 是两处数字；
- R7：`show-hidden` 仍自算 `usable`（它还需要 `hiddenCount`，尚未进矩阵）。
