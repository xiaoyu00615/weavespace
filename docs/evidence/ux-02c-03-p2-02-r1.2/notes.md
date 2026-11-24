# UX-02C-03-P2-02-R1.2 证据（待核对台账原子性 / 容量 / 跨工作区隔离）

基线：`d1d22e0`（R1.1）。本轮只改 Shell 与测试，未改 Host 事务、存储 Provider、文件身份核验，
未改视觉与导航，未碰 `main`。

## 一、门禁

| 命令 | 结果 |
| --- | --- |
| `npm run test:p0` | 1168 例 / 1166 pass / 0 fail / 2 skip（套件 95:31、96:47、97:14） |
| `npm run typecheck` | 通过 |
| `npm run typecheck:apps` | 通过 |
| `npm run build:shell` | 通过（见 `gate-checks.txt`） |
| `git diff --check` | 通过（只有 CRLF 提示，无空白错误） |

日志：`gate-test-p0.txt`、`gate-checks.txt`。

## 二、真实 Chrome 验证（29/29）

环境：headless Chrome 158（CDP 9334）+ Vite 5278 + 真实 Host（managed store，端口 5277）。
数据全部在 `D:/Workspace/projects/weavespace-test/p202-r12`（store-a / store-b，项目 id 都是
`proj-a`，根目录不同 → `workspaceKey` 不同）。网络层只用 CDP `Fetch` 暂停/构造响应，不改应用代码。

两个脚本按顺序跑在**同一个浏览器 profile** 上（第二阶段的"跨会话"依赖第一阶段的 localStorage）：

| 脚本 | 覆盖 | 结果 |
| --- | --- | --- |
| `p202-r12-cross.mjs` | 换工作区 + 迟到响应 + 跨区 busy + 双 UNKNOWN + 重载 | 18/18 |
| `p202-r12-capacity.mjs` | 跨会话待核对 + 64 条满仓 + 零 POST + 解除后恢复 | 11/11 |

### 逐条断言（`browser-verification.json`）

1. A 工作区里真有一条回收记录（`a.md`，`stored`）。
2. A 的一次列表读取被 CDP 挂起（请求已发出、未返回）。
3. 换 Host 存储后 `workspaceKey` 不同。
4. 不重载页面切到 B：B **自己**发起了新的列表读取（GET 计数增加）。
5. B 的读取窗口内不显示 A 的记录。
6. 用**成功的** A 回执（内容是 `a.md`）释放挂起的请求后，B 的回收区仍然没有 `a.md` —— 迟到响应不落地。
7. A 的恢复在途：行显示「恢复中」且按钮禁用（POST 被挂起，未到 Host）。
8. B 用**同一个 opId** 造出自己的记录并开始恢复，同样在途。
9. A 的迟到收尾（409 零副作用）**没有**清掉 B 的「恢复中」。
10. A 的拒绝只释放 A 工作区的预留：B 的同 opId 记录仍在台账里。
11. B 自己的恢复完成后，台账里不再有它的 opId（成功列表终态才释放）。
12. 两条 UNKNOWN 同时落进台账（2 条，不互相覆盖）。
13. 页面重载后两条仍是「待核对」+ 禁用，台账仍在。

### 容量阶段（`capacity-verification.json`）

1. 上一次浏览器会话留下的 2 条待核对在**新页面会话**里仍然存在（不只是重载）。
2. 容量未满时 `e.md` 可以恢复。
3. 台账被填到 64 条（62 条属于另一个项目，不会被本项目的列表收敛掉）。
4. 满仓时面板明确显示「已满（64 条）…恢复操作暂时关闭」。
5. 满仓时 `e.md` 不提供恢复操作（按钮消失），并说明"暂时不能恢复"。
6. 满仓时点击（含强制派发 click）**零 POST**。
7. 手工解除一条（63 条）后不再显示「已满」，`e.md` 恢复按钮重新可用。

截图：`10-workspace-a.png`、`20-cross-workspace.png`、`21-after-stale-response.png`、
`30-a-restore-inflight.png`、`31-b-restore-inflight.png`、`32-a-finally-isolated.png`、
`33-b-restored.png`、`40-two-unknown.png`、`41-after-reload.png`、`50-before-full.png`、
`51-ledger-full.png`、`52-after-freeing-one.png`。

## 三、如实说明：这一轮"换工作区"是怎么做的

Shell **没有**周期性的 health 轮询（`workspaceIdentity` 只在加载工作区、移除/添加项目后的
身份同步、以及 resync 时读）。因此"靠轮询发现换区"在当前代码里不存在，本轮也没有新增轮询
（那属于扩大功能范围）。

实际做法：脚本换掉 Host 的 `--workspace-store`（同一个端口），自己轮询 `/api/health`
确认新 Host 就绪（**这就是"health 轮询"在本轮的位置**），然后在页面里走一次
`演示 → 真实文件`。这条路径会调用 `loadWorkspace()` → `client.workspaceIdentity()` →
`SET_WORKSPACE_KEY`，是应用**既有的、不重载页面**的重新识别工作区路径。

因此本轮证明的是"换工作区后读取/操作/在途状态按身份隔离"，而不是"应用会自己发现换区"。
后者若要做，需要单独立项加轮询。

## 四、未覆盖 / 已知边界

1. A 的迟到响应是 CDP **构造**的成功回执（旧 Host 已被换掉，真实回执拿不到）。构造体与
   Host 的 DTO 同形，且走的是真实客户端解析路径；真实"两个 Host 同时在线"的场景无法在
   单端口代理下复现。
2. 容量满时行徽标仍显示记录自身状态（如「可恢复」），操作区显示"暂时不能恢复"。
   徽标描述的是记录状态，不是"此刻能不能点"；全局原因由顶部横幅说明。
3. 满仓后没有"一键清理"入口（按要求不提供），只能等对账/终态释放容量。
4. 台账损坏时同样没有应用内修复入口（R1.2-05 明确禁止引导用户清数据，也没加清空按钮）。
