# UX-02B-05 多项目完整集成验收记录

基线：`4f27eda`（04B-R2E 收尾）→ 本阶段分支 `wip/s11-ux-02b-05-integration-20261115`。

## 一、集成测试矩阵（Node，真实 Host / 真实 reducer）

| 套件 | 覆盖 | 结果 |
|---|---|---|
| 62 | 05-01 跨项目并发与 workspaceKey（7 例） | 全绿 |
| 63 | 05-02 项目管理连续操作（1 条长链） | 全绿 |
| 64 | 05-03 多项目编辑与保存（6 例） | 全绿 |
| 65 | 05-04 文件树集成（8 例） | 全绿 |
| 66 | 05-05 持久化与异常恢复（4 例） | 全绿 |
| 67 | 05-06 安全回归（7 例） | 全绿 |

既有 56–61（04B 系列）与 00–55 全部保留未改；合计 `test:p0` 801 例
（800 pass / 0 fail / 1 skip）。

### 本阶段发现并修复的缺陷（1 处）

**05-01-03：只读健康检查乱序返回时，较旧的一次会覆盖当前工作区摘要。**

复现：先移除 A（身份检查未返回）→ 再移除 B → 两次 `/api/health` 乱序返回 →
先发起的那次（对应"只剩 B"的集合）后到，把摘要写成了 `hash({B})`，
而当前项目集合已是空 —— 界面摘要与实际工作区不一致，随后会写出一条认错身份的恢复记录。

修复：`createWorkspaceIdentitySync` 增加单调序号（`issued`）；每次 `refresh`
领一个 ticket，**只有最新一次**允许写摘要 / 释放写入门禁，被取代的那次返回 `stale`
（一个 dispatch 都不发）。未改 Host 侧任何校验。

## 二、真实浏览器端到端（`docs/evidence/ux-02b-05/`）

环境：真实托管 Host（`apps/server`，managed store 在 `weavespace-test`）
+ Vite dev server + Chrome headless（CDP 点真实按钮）。
**文件夹选择使用 fake-picker（自动化选择器），不是真实 Windows 原生对话框**；
PA-12 原生弹窗已由用户人工验收，本阶段不重复。

| 步骤 | 证据 |
|---|---|
| 添加两个项目 | `projectsAdded: [tree01-proj1, tree01-proj2]` |
| 展开两棵树 | 两棵都出现 `docs/guide.md`、`src/*`、`readme.md` |
| 同时打开两个同名文件 | 2 个标签，标签上分别标注项目名（`01/02` 截图） |
| 改并保存 A | `dirtyAfterEdit: true`；保存后 `diskAChanged: true`、`diskAContentHasAppended: true` |
| 打开视图时 Host 门禁 | `precheckWithOpenView.allowed: false`，`blockedBy: [ACTIVE_VIEWS, DIRTY]` |
| 切换项目 | 编辑器显示 B 的内容，`bBufferUnchanged: true`，`activeProjectLabel: tree01-proj2` |
| 关闭标签 | `closeA/closeB: OK`，`tabsAfterClose: []` |
| 移除 A | `projectsAfterRemove: [tree01-proj2]`，B 的树仍在，`removedProjectDiskIntact: true` |
| 添加新项目 | `projectsAfterReadd: [tree01-proj2, tree01-proj3]`，`lastRecordMatchesHost: true` |
| 刷新页面 | 列表一致，`afterReloadRecordMatches: true` |
| 重启 Host | 列表与摘要一致，`afterHostRestartMatches: true` |

## 三、磁盘字节一致性

- 被移除的 `tree01-proj1/docs/guide.md`：内容与"保存后"完全一致
  （`removedProjectUntouched: true`）。
- 未被操作的 `tree01-proj2/docs/guide.md`：SHA-256 与操作前一致
  （`otherProjectUntouched: true`）。
- 移除流程未删除、移动或改名任何文件（目录与 `src/*` 均在原位）。

## 四、未覆盖 / 已知边界

- 真实 Windows 原生文件夹对话框仍未由脚本拉起（安全策略），本记录不代替它。
- 「目录不可读（EACCES / EPERM）」在普通用户权限下无法稳定复现；
  该分支由存储层故障注入用例（套件 50/53）覆盖，本阶段只验证
  「空目录 / 不存在 / 不是目录」三态可区分。
- 只读端点（`/api/tree`、`/api/projects`）不带 T1 令牌是既有契约（本机回环 + 同源策略，
  且只返回摘要与相对路径）；变更端点一律要求令牌 + 同源 Origin，本阶段复核未放宽。
- 空工作区阶段旧摘要的本地记录仍留在 localStorage（恢复只跟随 `ws:last`，不会被认领）。
