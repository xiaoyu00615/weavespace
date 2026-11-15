# UX-02B-04B-R2E 真实浏览器验收记录

基线：`bb8c816`（R2 收尾）→ 本轮补两个连续操作边界。
环境：真实 Host（`apps/server` 托管模式 + fake picker）+ Chrome headless（CDP 驱动），
页面走 Vite dev server（`WS_API_TARGET` 指向 Host），夹具全部在
`D:\Workspace\projects\weavespace-test`（空托管存储 + `tree01-proj1/`、`tree01-proj2/`）。

脚本自己持有 Host 进程与浏览器，全部操作由 CDP 点击真实界面按钮完成，不调用内部接口。

## E-01 · 移除最后项目 → 重新添加

| 步骤 | 观察 | 结论 |
|---|---|---|
| 只有一个项目 | `initialProjects: ["tree01-proj1"]`，`initialKey: 82de4474…` | 前置成立 |
| 移除该项目 | `projectsAfterRemove: []`；`workspaceKeyAfterRemove: null`（`/api/health` 不再返回该字段） | 空集合没有身份 |
| 空窗口内的写入 | `writesWhileEmpty: []`，`writesUnderOldRecordWhileEmpty: 0` | 门禁生效：一条恢复记录都不写，且不伪造空摘要 |
| 再添加新项目 | `projectsAfterAdd: ["tree01-proj2"]`，`workspaceKeyAfterAdd: df149b07…` | Host 给出新身份 |
| 摘要落地 | `lastRecordAfterAdd === workspaceKeyAfterAdd`（`lastRecordMatchesHostAfterAdd: true`） | 记录挂在新摘要上 |
| 自动保存是否恢复 | `writesUnderNewRecordKey: 1`（`ws:workspace:v1:record:df14…` + `ws:last` 各一次） | **已恢复**（修复前这里恒为 0） |
| 文件树 | `treeRowsAfterAdd: [tree01-proj2, docs, guide.md, src, app.py, readme.md]` | 新项目可展开、可读文件 |
| 页面刷新 | `afterReload: ["tree01-proj2"]`，`afterReloadRecordMatches: true`，`afterReloadTreeRows` 同上一行 | 刷新后列表、摘要、文件树一致 |
| 状态提示 | 状态栏由"…；工作区身份待同步"变为"工作区身份已同步，自动保存已恢复" | 提示与事实一致（`03-after-readd.png`） |

截图：`01-one-project.png`、`02-empty-workspace.png`、`03-after-readd.png`、`04-after-reload.png`。

## E-02 · 单飞覆盖身份同步阶段

在只剩一个项目时，对同一次移除在**同一个 JS 任务里连点两次确认**
（`b.click(); b.click();`，比人手更快）：

| 指标 | 值 | 结论 |
|---|---|---|
| `removeRequestsForDoubleConfirm` | `1` | 只发了一个 `POST /api/projects/remove` |
| 该项目的墓碑条数 | `tombstonesForProj2: 1` | 只落了一条持久证据（没有第二个 opId 写第二条墓碑） |
| `projectsAfterDoubleConfirm` | `[]` | 状态清理只执行一次 |

截图：`05-after-double-confirm.png`。

> 说明：界面层的 `confirming` ref 也能挡住同一 tick 的连点；本轮把在途表提到
> **编排器最外层**后，即使绕过界面（同一操作窗口内再次调用 `actions.removeProject`）
> 也只会复用同一次操作，这一点由套件 61 的 E-02-01 精确覆盖。

## 磁盘与持久状态

- `tree01-proj1/`（E-01 移除）、`tree01-proj2/`（E-02 移除）目录与全部文件仍在，
  SHA-256 与测试前一致（`docs/guide.md`、`readme.md`、`src/*`）。
- Host 最终 `/api/projects` 为 `[]`；`revocations.jsonl` 中各一条墓碑。

## 未覆盖 / 边界

- 空工作区阶段，旧摘要（`82de…`）的本地记录**仍留在 localStorage**：`onDropRecord`
  只在"摘要从一个有效值换到另一个有效值"时触发。它不会被认领（恢复只跟随 `ws:last`，
  而 `last` 已指向新摘要），属于既有行为，本轮未改动。
- 真实 Windows 原生对话框仍未人工验证（安全策略禁止脚本拉起），本记录不代替它。
