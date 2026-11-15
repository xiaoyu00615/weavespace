# UX-02B-04B-R2 · 集成边界（真实浏览器证据）

真实 Host（托管模式）+ 真实 Chrome（headless + CDP）。脚本自己持有 Host 进程，
因此在流程中途**真的重启**了 Host —— 这是 R2-02 场景成立的前提。

- Harness：`%TEMP%\tree01-r2.mjs`（临时，不进仓库）
- Host：`%TEMP%\tree01-host-r2.ts`（端口 + pick 次数；重启时用 0）
- 夹具：`D:\Workspace\projects\weavespace-test\tree01-store-empty`、`tree01-proj1`、`tree01-proj2`

## R2-02 · Host 重启后仍不得丢本地草稿

页面先打开 `tree01-proj1/readme.md` 并输入一行未保存内容，然后重启 Host：

| 时点 | Host 前检（removal-precheck） |
|---|---|
| 重启前（View 还活着） | `allowed:false`，`blockedBy:["ACTIVE_VIEWS","DIRTY"]` |
| **重启后**（View 已消失） | **`allowed:true`，`blockedBy:[]`** ← 危险窗口 |

此时点「移除项目」：

- 模态直接进入 `blocked`，**没有**确认按钮；
- 原因三条：文件还打开着 / 有未保存修改 / **这些是本地界面里的内容，Host 侧可能已经看不到**；
- 本次点击期间 `/api/projects/remove` 请求数 = **0**（本地守卫先于任何请求）；
- 编辑器里的未保存内容逐字保留（`bufferKeptIntact: true`）。

见 `02-local-draft-blocks-removal.png`。

## R2-01 · 身份同步窗口内没有旧摘要写入

对页面 `Storage.prototype.setItem` 插桩，记录每一次恢复记录写入的键与时间戳；
移除另一个项目（`tree01-proj2`）期间：

| 观测点 | 结果 |
|---|---|
| 旧摘要记录（`record:eca489d7…`）写入次数 | **0** |
| 新摘要记录（`record:82de4474…`）写入次数 | 1 |
| `ws:last` | 指向新摘要 |
| 移除后 localStorage 里的记录键 | 只有新摘要一条 |

只有两次写入，且都发生在健康检查返回之后（同毫秒）。见 `03-after-remove.png`。

## 回归

- 刷新页面后：项目列表与摘要一致（`04-after-reload.png`）；
- 磁盘文件未被触碰（移除只解除注册，见 R1 证据的哈希对比）。

完整观测值见 `browser-verification.json`。
