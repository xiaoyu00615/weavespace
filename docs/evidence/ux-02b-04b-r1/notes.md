# UX-02B-04B-R1 · 定点修复（真实浏览器证据）

三个结果一致性问题，全部**先红测后修复**。证据由真实 Host（托管模式）+ 真实 Chrome
（headless + CDP）产生，页面经 Vite dev 代理访问同一 Host。

## 复现 / 验证脚本（临时，不进仓库）

- Harness：`%TEMP%\tree01-r1.mjs`（CDP 驱动；`Network.setBlockedURLs` 屏蔽端点）
- Host：`%TEMP%\tree01-host-add.ts`（空托管存储 + 可编程选择器，依次 pick proj1 / proj2）
- 夹具：`D:\Workspace\projects\weavespace-test\tree01-store-empty`、`tree01-proj1`、`tree01-proj2`

## 1. R1-01 · 真实网络异常恢复

把 `/api/projects/remove` 在网络层屏蔽（`Network.setBlockedURLs`），点「确认移除」：

| 观测点 | 结果 |
|---|---|
| 模态阶段 | `result`（**不是** `removing`） |
| 文案 | 「无法确认本次移除是否生效：已按操作编号查询并重新读取项目列表，请人工核对（不会自动重试移除）」 |
| 项目列表 | 仍是 2 个项目（Host 未收到请求，零变更） |
| 自动重试 | 无（`remove` 只发一次；查询只用原 opId） |

见 `02-network-failure-reconciled.png`。恢复网络后重新确认即成功。

## 2. R1-03 · 移除后的 workspaceKey 同步

| 观测点 | 结果 |
|---|---|
| 移除前 Host 摘要 | `eca489d7…c792` |
| 移除后 Host 摘要 | `df149b07…7498`（按项目集合重算，必然变化） |
| 本地 `ws:workspace:v1:last` | `df149b07…7498`（与 Host 一致） |
| 旧摘要记录 | 已清除（`record:eca489d7…` 不存在） |
| 刷新页面后 | 列表 1 个项目；`last` 与 `/api/health` 仍一致 |

见 `03-after-remove.png`、`05-after-reload.png`。

## 3. 回归

- 第二个项目仍可用：树正常展开，`readme.md` 可打开（标签数 1），见 `04-second-project-usable.png`；
- 三个磁盘文件 SHA-256 前后一致（`diskUnchanged: true`）；
- 刷新后项目列表与摘要一致，无打不开的残留标签。

## 数据

完整观测值见 `browser-verification.json`。
