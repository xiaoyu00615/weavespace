# UX-02C-03-P2-02 · 回收区 Shell UI 接入 —— 证据

- 分支：`wip/ux-02c-03-p2-02-trash-ui-20261123`
- 基线：`e75f022`（P2-01-R2-Supplement-R2，后端已验收）
- 环境：Windows 11 / Node v22.22.2 / 真实本地 NTFS 磁盘 / 真实 Chrome 158（headless=new）
- 纪律：未改 `main`、未建 Worktree、未改后端事务与恢复安全逻辑、**没有**永久删除/目录递归/批量/自动清理/自动改名

---

## 1. 结论摘要

| 项 | 结果 |
| --- | --- |
| `npm run test:p0` | **1119 例 / 1117 pass / 0 fail / 2 skip**（`gate-test-p0.txt`） |
| `npm run typecheck` / `typecheck:apps` | 通过（`gate-checks.txt`） |
| `npm run build:shell` | 通过（434.68 kB / gzip 131.92 kB） |
| `git diff --check` | 通过（`gate-diff-check.txt`，0 字节输出） |
| 新增套件 | 95（13 例）/ 96（23 例）/ 97（7 例），编号 95 之后未占用 |
| 真实 Chrome 冒烟 | **29/29 断言通过**，10 张截图（`browser-verification.json`） |
| 后端 | 未改动 `apps/server/**`、`packages/storage/**` 任何文件（`git diff --stat` 可核） |

---

## 2. 改动清单

| 文件 | 作用 |
| --- | --- |
| `apps/shell/src/client/client-api.ts` | 新增 `TrashEntryState`（七态）、`TrashEntryDto`、`TrashListOutcome`、`TrashActionOutcome`、`TrashOpQueryOutcome`；四个接口方法 `listTrash/trashEntry/restoreTrash/queryTrashOp`；live 实现 `postTrashAction` 与严格 `parseTrashEntry`；Demo 桩统一 501 |
| `apps/shell/src/state/types.ts` | `NavKey` 增 `trash`；新增 `TrashProjectState`（按项目分桶）与 `TRASH_LOAD_BEGIN/LOADED/LOAD_ERROR/BUSY` |
| `apps/shell/src/state/workspace-reducer.ts` | 初始化 `trashByProject`；`PROJECT_REMOVED` 丢弃该项目视图；四个分支（失败不清空、刷新不解除 busy） |
| `apps/shell/src/state/workspace-persistence.ts` | `NAV_KEYS` 增 `trash`（重开工作台仍停在回收区） |
| `apps/shell/src/state/trash.ts`（新） | 七态展示模型、菜单可用性、文案、面板视图、编排器（单飞 / 归属快照 / UNKNOWN 只读核对一次） |
| `apps/shell/src/state/trash-dialog.ts`（新） | 二段确认状态机（`checking/ready/blocked/confirming/result`），取消零请求 |
| `apps/shell/src/state/TrashContext.tsx`（新） | 注入 state/dispatch/client、按 (模式, 项目) 触发读取、暴露面板视图与确认流程 |
| `apps/shell/src/state/DocumentActionsContext.tsx` | 转发四个回收接口；非 live+multi 一律 501（Demo 不假装"空回收区"） |
| `apps/shell/src/components/TreeCommandsContext.tsx` | 右键新增「移入回收区」：普通文件可点；目录/链接/项目根禁用并给出原因；`delete-local` 仍不渲染 |
| `apps/shell/src/components/GlobalNav.tsx` | 新增「回收区」入口与数量徽标（`null` 不显示数字） |
| `apps/shell/src/layout/ShellLayout.tsx` | `navKey==='trash'` 渲染 `TrashPanel` |
| `apps/shell/src/components/TrashPanel.tsx`（新） | 七态徽标、原名/原始位置/时间/大小、恢复按钮或禁用说明；恢复用状态里的真实记录 |
| `apps/shell/src/components/TrashDeleteDialog.tsx`（新） | 二段确认模态（portal），不用 `window.confirm`；Esc 在 `confirming` 时不关闭 |
| `apps/shell/src/App.tsx` | `TrashProvider` 包住 `TreeCommandsProvider`，并挂 `TrashDeleteDialog` |
| `apps/shell/src/styles/shell.css` | `.nav__count`、`.trash*` 样式 |

产品约束在结构上的体现：面板里**没有**永久删除、批量、自动清理、目录递归、"恢复到指定位置"这些控件，也没有对应的状态位——不是靠禁用藏起来。

---

## 3. 时序与归属（P2-02-04）

- **单飞按目标分键**：回收 `projectId\0path`、恢复 `restore\0projectId\0opId`；同一行连点只发一个请求，不同行互不阻塞。
- **归属快照**：发起前记 `{mode, workspaceKey, activeProjectId, epoch}`；结算前、`after()` 之后各核对一次，任何一维变化即 `stale`（不宣布成功/失败、不弹提示、不写回桶）。
- **读取只用 `loadSeq`**：同一项目的旧读取作废；切换项目/模式由 `owned()` 判定，两种机制不混用（否则"刚完成的操作"会被自己后续的刷新判成过期）。
- **UNKNOWN 只做一次只读核对**：`queryTrashOp` 恰好调用一次，绝不重发副作用请求。
- **刷新不解除 busy**：`TRASH_LOADED` / `TRASH_LOAD_ERROR` 保留 `busyOpId`，只有 `TRASH_BUSY(null)` 结束这一轮（套件 95 用例锁住）。
- **恢复只按记录原路径**：客户端请求体只有 `{projectId, opId}`；`targetPath` 不被接受也不被发送（套件 97 §七 逐键断言）。

---

## 4. 文案口径

| 场景 | 文案 | 断言位置 |
| --- | --- | --- |
| 回收成功 | 已把「a.md」移入回收区（未永久删除，可在回收区恢复） | 96 / Chrome |
| 恢复成功 | 已把「a.md」恢复到原位置 | 96 / Chrome |
| 同名冲突 | 原位置已有同名文件，请先改名或移走它。 | 96 / 97 / Chrome |
| 回收区满 | 回收区已满，请先恢复已有文件。 | 96 |
| 结果未确认 | 结果未确认：已按操作编号核对回收记录，请稍后在回收区查看（不会自动重发操作）。 | 96 / 97 |
| 本地阻断 | 无法操作「path」：仍在标签中打开/有未保存的修改…（本次操作没有任何磁盘副作用）。 | 96 |

七态徽标：`pending` 结果核对中 / `stored` 可恢复 / `restoring` 恢复核对中 / `restored` 已恢复 / `aborted` 未成功移入 / `conflicted` 需要人工核对 / `missing` 文件已丢失。
`pending`/`restoring` 用中性色，不写成成功也不写成失败；恢复在途时徽标显示「恢复中」，不写「可恢复」。

---

## 5. 测试

### 5.1 套件 95（纯逻辑，13 例）

七态 → 展示映射、名称/路径/大小/时间格式化（异常值不编造）、菜单可用性（文件/目录/链接/项目根/不支持模式）、面板视图（未读到 ≠ 空列表）、徽标（未知不显示数字）、reducer（失败不清空、刷新不解除 busy、项目分桶与移除）、导航持久化。

### 5.2 套件 96（编排 + 二段确认，23 例）

读取单飞、切项目/切模式后的迟到列表不落地、失败写错误不当空列表；回收成功刷新父层+列表、UNKNOWN 只核对一次、本地阻断零请求、满仓提示、同路径并发单飞、切走后 stale 不弹提示；恢复仅 `stored` 可恢复、冲突文案、UNKNOWN 不重发且 busy 解除、按 opId 分键；确认框打开零请求、取消零请求、ready 恰好提交一次、UNKNOWN→warn / REJECTED→error、打开后文件被占用→blocked。

### 5.3 套件 97（真实 Host + 真实磁盘 + 真实 HTTP，7 例）

真实移动 → 文件树立刻消失 → 列表出现 `stored`（字节逐字比对）；恢复回原路径、payload 消失、状态 `restored` 且 `canRestore=false`；同名冲突 409 `ERR_ENTRY_EXISTS` 且双方内容都不变、记录仍可恢复；项目隔离（B 的回收区为空、不产生 `.weavespace`）；四种终态记录原样回传且 `canRestore=false`；`/api/trash/op` 三种结果（trashed / none / 跨项目 409）；请求体逐键断言无路径/身份/目标路径。

> Node 的 `fetch` 不发 `Origin`，而 Host 的变更端点要求显式 Origin（防 CSRF）。套件 97 用 `installBrowserOrigin()` 只为同一 Host 的非 GET 请求补上 Origin，不覆盖调用方已给出的值——测的是 Shell 的行为，不是"Node 不发 Origin"。

---

## 6. 真实 Chrome 冒烟（29/29）

`browser-verification.json` 是逐条断言的原始记录；截图：

| 截图 | 内容 |
| --- | --- |
| `00-boot.png` | 启动（默认演示模式，导航已含「回收区」） |
| `01-tree-root.png` | 切到「真实文件」后的项目树 |
| `02-menu-file.png` | 文件右键菜单含可点的「移入回收区」 |
| `03-dialog-ready.png` | 二段确认：`.weavespace/trash`、不会永久删除、可恢复、取消零修改 |
| `04-after-cancel.png` | 取消后：对话框关闭、文件仍在、**没有**创建回收区目录 |
| `05-after-trash.png` | 回收结果屏 + 导航徽标 1 |
| `06-panel-stored.png` | 回收区列表：原名、原始位置、时间、大小、可恢复、恢复按钮 |
| `07-panel-restored.png` | 恢复后：已恢复徽标、无恢复按钮、字节一致 |
| `08-restore-conflict.png` | 同名冲突：状态栏显示规定文案，记录仍可恢复、原位置未被覆盖 |
| `09-menu-folder.png` | 目录右键：「移入回收区」可见但禁用，附「目录暂不支持（本阶段只处理普通文件）」 |

冒烟用的项目在 `D:/Workspace/projects/weavespace-test/p202-ui-smoke`（真实磁盘、真实 Host 托管存储），**没有**触碰任何真实用户文件。

---

## 7. 未覆盖与已知限制（如实记录）

1. **恢复在途的界面态**由 `busyOpId` 表达（徽标「恢复中」+ 按钮禁用），未在真实 Chrome 里构造出"请求在途"的窗口——该时序由套件 96 的 deferred 端口与 95 的视图断言覆盖。
2. **`conflicted` / `missing` / `aborted`** 的真实界面渲染只在套件 97 里核对了 Host → 客户端回执，未在浏览器里逐个种下这些记录截图；展示映射由套件 95 覆盖。
3. **回收区满（`ERR_TRASH_FULL`）** 只在编排层用假端口验证文案，未在浏览器里造 500 条记录。
4. **项目根右键**：真实项目根行的右键菜单里「移入回收区」为禁用并提示"项目根不能移入回收区"，该分支只在套件 95 覆盖，浏览器只截取了目录分支。
5. 浏览器冒烟期间状态栏出现过一次「当前工作区与上次记录不一致…」——这是新开浏览器配置下的既有布局保护提示，与本轮功能无关，未做处理。

---

## 8. 禁止项自查

| 禁止项 | 结果 |
| --- | --- |
| 修改 P2-01 后端事务/状态机/恢复安全 | 未改（`git diff --stat` 无 `apps/server`、`packages/storage`） |
| 改动 `.weavespace` 结构 | 未改；回收区目录内容由 Host 既有实现决定 |
| 永久删除 / 目录递归 / 批量 / 自动清理 / 自动改名 | 未实现、无入口、无对应状态位 |
| 绕过权限 | 未改权限路径；客户端只传 `projectId + 相对路径 + opId` |
| 改 `main` / 建 Worktree / 用真实用户文件测试 | 未做 |
| `window.confirm` | 未使用（自建模态，portal） |
