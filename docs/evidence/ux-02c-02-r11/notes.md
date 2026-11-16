# UX-02C-02-R1.1 验收记录（四项审查缺陷修复）

基线：`049d1a4`。分支 `wip/ux-02c-02-r1-view-barrier-reservation-20261116`。

## R1-01 页面恢复与临时打开必须区分

**缺陷**：R1 让 Host 把"同一页面 + 同一资源"的**每一次** open 都当成页面恢复，
于是 `refreshCleanTab`（再次点击已打开文档、刷新项目、恢复后核对磁盘）建出来的
临时 View 一出现，就把当前标签持有的 `view-1` 关掉；临时 View 随即被释放，标签
手里只剩死 viewId —— 编辑、保存、关闭、改名全部失败。

**修复**：
- `/api/open` 新增 `reclaimPrevious`（严格布尔，非布尔 400）。只有它为 `true`
  且带 `clientInstanceId` 时才回收旧 View。
- 回收前的归属核对升级为**四连**：同页面实例 + 同 actor + 同会话 + 同资源。
- Shell：`OpenNodeOptions.reclaimPage` 透传为 `reclaimPrevious`；只有
  `workspace-restore`（`openInBackground`）传 true，普通点击与 `refreshCleanTab`
  一律不传。
- `document.open` 的磁盘版本复核、DIRTY 不回填规则未动。

**测试**：套件 76（真实 Host + 真实 reducer + 真实 live client + 真实磁盘）：
- 再次点击已打开文档 → view-1 仍可读/编辑/保存/关闭；
- 外部改磁盘 → `refreshOpenTabs` 同步内容且 viewId 不变，随后仍可编辑；
- 恢复流程（reclaimPage）→ 旧 View 被回收、新 View 可用；
- DIRTY 草稿重开不丢、外部改动只报告不覆盖、结构变更仍被拦。

## R1-02 页面实例真正隔离

**缺陷**：R1 只从 `sessionStorage` 读一个字符串。`window.open`（同源）与 Chrome
「复制标签页」都会**整体复制 sessionStorage**，于是两个活着的页面共用一个 id：
一个页面恢复就会把另一个页面正在用的 View 当成遗留物回收。

**修复**：新增 `apps/shell/src/client/page-instance.ts`（可注入端口、可单测）：
- 候选 id 存 `sessionStorage`；
- 用 **Web Locks** 独占 `weavespace.clientInstanceId` 对应的锁，锁持续持有到页面销毁；
- 抢不到锁 → 判定"另一个活着的页面在用同一个 id" → 换新 id（opener 复制 / 复制标签页）；
- 抢不到锁时**先重试一次**（80ms），跨过"刷新卸载窗口"，避免刷新误换身份；
- 无 Web Locks → 退化只信 sessionStorage（已记录局限）；
- 无 sessionStorage / 连新 id 都抢不到 → 返回 `null`，请求里省略该字段（绝不伪造）。

**踩坑并修复**：`navigator.locks.request` 脱离 `this` 调用会 **rejected
（Illegal invocation）**，直接导致每次都被判成"锁被占用"，身份退化为 `null`
（真实浏览器里表现为 `/api/open` 没有 clientInstanceId）。已改为 `bind(locks)`，
并在 notes 里记录该现象。

**测试**：套件 75（8 例，注入 storage/locks 端口）：刷新不变、独立页面不同、
opener 复制换 id、复制标签页换 id、卸载窗口重试、无 locks 退化、无 storage → null、
形状校验。真实 Chrome（`green/browser-verification.json`）6/6：
刷新前后 id 相同（`3e533173…`）、旧 View 403、复制页拿到独立 id
（`bcc2b4c5…`）、B 打开同一文件后 A 的 View 仍 200、刷新 B 后 A 仍 200。
headless 下 `window.open` 被拦截（`popupOpened=false`），脚本用"新建标签 + 写入
被复制的 id + 重载"的确定性回退来模拟 opener 复制，已如实记录。

## R1-03 结构变更通道作用域

**缺陷**：`withStructureDiskOp(projectId, …)` 只检查 `structureBusy` 布尔值——
任何知道 projectId 的调用方都能在屏障期间借道。

**修复**：能力凭据 `StructureChangeCapability { projectId, token: symbol }`，
只由 `withStructureChange` 创建并交给本次回调；退出屏障即吊销。
`withStructureDiskOp(capability, fn)` 三重校验：形状（token 是 symbol）→ 当前性
（`structureCapabilities.get(projectId) === capability`）→ token 一致；任一不满足
返回 `ERR_PROJECT_BUSY`。生命周期 / 全局磁盘信任 / 根身份 / `activeOps` 门禁不变。

**测试**：套件 74 B-01（屏障内伪造凭据被拒、只传 projectId 被拒）、B-02（真实凭据
在屏障内可用、离开屏障立刻失效、普通通道不受影响）。

## R1-04 / R1-05 占位身份可靠性

**缺陷**：`open('wx')` 成功后若 `handle.stat()` 或 `handle.close()` 失败，旧实现
落进通用 catch → 返回普通 `REJECTED`，而磁盘上已经留下了本次的 0 字节占位：
既谎报"什么都没发生"，也没有任何清理/未知语义。

**修复**：
- 占位一旦建立，后续任何"拿不准"都返回 `UNKNOWN`（fail-closed），不再落到普通拒绝；
- `stat` 失败先尽力关句柄，再 UNKNOWN；`close` 失败直接 UNKNOWN（句柄可能仍打开）；
- 身份仍为 `dev+ino`，rename 前复核、`verify()` 只在 owned 时判 unchanged、
  清理只在 owned 时 unlink（R1 已建立，本轮保留）。

**「保持句柄直到 rename 完成」的评估结论（实测，Windows 11 / NTFS / Node 22.22.2）**：
| 实验 | 结果 |
| --- | --- |
| `open(wx)` 保持句柄打开时 `rename(src → dst)` | **EPERM**（无法覆盖自己打开的占位） |
| 删除后重建同名文件，200 次 | ino 复用 **0** 次 |
| 300 次创建/删除循环 | ino 复用 **0** 次 |
| 删除后立即重建（外部模拟）200 次 | 同 ino **0** 次 |
| `birthtime` 跨重建 | 同毫秒（**不可用于判重**） |

因此：**不能**在 Windows 上保持句柄到 rename 结束（会把成功路径变成 EPERM）；
采用"记录 dev+ino → 关闭句柄 → rename 前复核 → 事后按身份确认/清理"，并把
"NTFS 理论上可能复用文件 ID"这一剩余风险如实保留（fail-closed 兜底）。

**测试**：套件 74 C-01（外部换成同名 0 字节文件 → 409、外部文件保留、源不变）、
C-02（stat 失败 → UNKNOWN）、C-03（close 失败 → UNKNOWN）、C-04（POSIX 专用，
Windows 上 skip）。

## 红测/探针（修复前失败）

| 探针（把实现改回缺陷形态） | 结果 |
| --- | --- |
| P1 去掉 `reclaimPrevious` 门控（每次同页 open 都回收） | 套件 76 #1 #2 红 |
| P2 身份解析不看 Web Locks（只信 sessionStorage） | 套件 75 #3 #4 #5 红 |
| P3 凭据校验退化为"只看 structureBusy" | 套件 74 B-01/B-02 红 |
| P4 占位后 stat/close 失败退回普通 REJECTED | 套件 74 C-02/C-03 红 |

四个探针均已还原，源码无 `PROBE` 残留。

## 门禁

`test:p0` **889 tests / 887 pass / 0 fail / 2 skipped**（POSIX 条件测试 + 既有 skip）；
`typecheck`、`typecheck:apps`、`build:shell`、`git diff --check` 全绿。
套件 72（16）/73（11）/74（10）/75（8）/76（4）全部保留并通过。
