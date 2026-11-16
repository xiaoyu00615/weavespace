# UX-02C-02-R1.2 验收记录（独立复审缺陷修复）

基线：`89bd9f2`。分支 `wip/ux-02c-02-r1-view-barrier-reservation-20261116`。
本轮只处理四项复审缺陷（R1-01 / R1-04 / R1-05 / R1-02），不进入 UX-02C-03。

---

## 一、R1-01 恢复被用户接管时遗留的 View

**缺陷**：页面刷新后旧 View 留在 Host。恢复流程逐个重开标签时会顺带回收每个文件的
旧 View（`/api/open` 的 `reclaimPrevious`）；但用户在恢复途中主动打开某个**尚未恢复**
的文件时，恢复立刻被接管中止，那个文件的旧 View 再也没人关。它是"幽灵 View"：
该会话 `activeViews > 0`，`projectStructureBlockers` 永远返回
`ERR_STRUCTURE_SESSION_BUSY / ACTIVE_VIEWS`，于是这个文件再也改不了名/移动，
直到下一次刷新。剩余那些"没来得及恢复"的标签同样留着旧 View。

**修复（三处，都是"当前活动 View"与"上轮历史 View"的显式分界）**

1. `open-document.ts` 新增 `OpenDocumentDeps.isRestoring()` 与判定函数
   `shouldReclaim(explicit, isRestoring)`：
   - 恢复自己的后台打开（`reclaimPage`）→ 回收；
   - **恢复期间**用户接管打开 → 同样回收（该文件本来就在待恢复列表里，
     被接管后恢复不会再重开它，旧 View 同样是孤儿）；
   - 窗口之外一律不回收（`refreshCleanTab` 的临时打开仍然保留标签当前的 View）。
   命中条件天然安全：只有"创建新标签"这条路径才会算 reclaim，已有标签走
   ACTIVATE / 临时刷新。
2. `workspace-restore.ts` 新增 `RestoreDeps.reclaimStaleViews`：恢复被接管、
   结算报告之前，把**还没处理完的标签**交给回收通道（`Superseded` 与
   `interrupted` 两条退出路径都覆盖）。`WorkspaceRestorer.isRestoring()` 的窗口
   终点是**报告落地**，不是 `noteInteraction()`——接管打开恰好发生在两者之间。
3. `open-document.ts` 新增 `DocumentOpener.reclaimStaleViews(entries)`：只关不开、
   不读盘、不建会话、不动草稿。它与打开共享一条**串行链**（`enqueueMaintenance`）：
   - 打开先、回收后 → 回收先等在途打开结算（含标签登记），`keep` 列表才完整；
   - 回收先、打开后 → 打开等这次维护完成，不会把刚建的 View 当遗留物。
   `keep` 来自执行时刻的 `state.tabs[].viewId`，Host 永不关闭这些 View。
   串行链只在真有维护任务时才 await，平时一次打开不多出任何微任务跳步
   （否则会打乱"调用方紧接着切模式"的既有同步语义，套件 30 R1-06/R1-07 会红）。

**Host**：新增 `POST /api/views/reclaim`（T1 令牌 + 同源）。只处理
`同一 clientInstanceId + 同一 actor + 同一 resourceId` 的 View，跳过
`keepViewIds`，`closeView` 被拒（最后一个脏视图）时如实记入 `blocked`。
门禁与 `/api/close` 同档：只操作 Host 内存、不碰磁盘，不要求项目 grant。

**边界逐条对应**
| 要求 | 落点 |
| --- | --- |
| 区分历史 View 与活动 View | `keepViewIds`（执行时刻的 tags.viewId）+ 只在"新建标签"路径回收 |
| 接管后不留已知待恢复文件的旧 View | `reclaimStaleViews(pendingTabs)` |
| 普通页面不能回收别的页面 | Host 四连核对（页面实例 + actor + 资源），套件 79-01c |
| 不能为回收丢 DIRTY 草稿 | `document.closeView` 对"最后一个脏视图"返回 closed:false，套件 79-01d |
| 不破坏 pendingTabs 结转 | 回收在 `pending` 赋值之后、只读使用，套件 79-01a/01d/01e 断言结转内容 |

**测试**：套件 79（真实 Host + 真实 opener + 真实 reducer + 真实磁盘，5 例）
- 01a 两个旧 View → 恢复暂停 → 用户打开第二个文件 → 第 2 个旧 View **当场**回收
  （不是等恢复收尾）→ 关标签后改名成功；
- 01b 对照组（关掉两条回收能力）→ 旧 View 留下、改名 409，证明用例有判别力；
- 01c 另一页面的 View 不被回收（改名仍被它拦住，关掉后才允许）；
- 01d `c.md` 的旧 View 是最后一个脏视图 → 回收被拒、草稿正文与磁盘零变更、
  改名仍被拦（保住草稿的正确代价，如实记录）；
- 01e 用户只接管 `b.md`，从未重新打开的 `c.md` 旧 View 也必须在结算时回收
  （这条只有批量回收能过，`b.md` 那条两条路径都能过）。

## 二、R1-04 两条占位建立路径的统一

**缺陷**：初次占位失败走 "stat/close 失败 → UNKNOWN"，而**重新占位**（占位被外部
删除后重新收紧窗口）仍是 `catch → REJECTED`。同一块磁盘上已经多了一个 0 字节
占位，却报"什么都没发生"：调用方可以安全重试，于是留下第二个占位。

**修复**：抽出一段 `reserveExclusive(attempt: 1 | 2)`，两条路径共用：

| 阶段 | 结果 |
| --- | --- |
| `open('wx')` EEXIST | `REJECTED / ERR_ENTRY_EXISTS`（零副作用） |
| `open('wx')` 其它错误 | `REJECTED` + `moveErrorOf` 映射（零副作用） |
| 占位已建立，`stat` 失败 | `UNKNOWN`；句柄尽力关闭；**不删除目标** |
| 占位已建立，`close` 失败 | `UNKNOWN`；**再次**尽力关闭句柄；不删除目标 |

`reserveFault(stage, attempt)` 多一个 `attempt` 参数（1 初次 / 2 重新），
因此四个失败点都能被独立注入。身份仍是 `dev+ino`（不使用 birthtime）。

**测试**：套件 78（真实 Host + 真实 LocalProvider + 真实临时磁盘，7 例）
- 04a 初次 stat 失败 → 202/UNKNOWN、源完整、目标（0 字节占位）**没有被删除**；
- 04b 初次 close 失败 → UNKNOWN，且用"替换性 rename"证明句柄**确实被放开**
  （Windows 上仍有打开句柄时替换该名字会 EPERM——本轮实测）；
- 04c 外部删除占位后，第二次占位 stat 失败 → UNKNOWN（修复前是 REJECTED）；
- 04d 同上 close 失败 → UNKNOWN + 句柄释放；
- 04e 外部文件占住目标名 → 409/ERR_ENTRY_EXISTS，外部文件内容不变。

## 三、R1-05 rename 的原子性边界（**未解决风险，不宣称 fail-closed**）

新增 `beforeMoveRename` 注入点：**身份复核之后、`rename` 之前**。

**实测（Windows 11 / NTFS / Node 22.22.2，见本目录 `notes.md` 的探针表）**

| 实验 | 结果 |
| --- | --- |
| `rename(src → 已存在文件)` | **静默覆盖**（`MoveFileExW(REPLACE_EXISTING)`） |
| `rename` 后 `dev+ino` | 文件、目录都**保持不变** |
| `link(src, 已存在目标)` | `EEXIST`（文件级"原子 no-replace"） |
| `link(目录)` | `EPERM`（目录不支持硬链接） |
| 跨卷 `link` | `EXDEV` |
| 保持自己占位句柄打开时 `rename` 覆盖它 | `EPERM` |
| 删除后重建同名文件（Windows） | `ino` 变化（可用于归属判定） |
| Node 是否有 no-replace rename | **没有**（`constants` 里只有 `O_EXCL`/`COPYFILE_EXCL`） |

**结论**：Node 没有对目录也可用的原子 no-replace rename。`link` 只能覆盖"同卷文件"，
且需要"link 后再 unlink 源"——unlink 失败会留下两份副本（比覆盖更难解释），
目录则完全不可用。因此**不采用**，也**不把 `lstat` + `rename` 描述成原子保护**。

保留的窗口：身份复核后、`rename` 前，外部进程删掉占位并放入同名对象 → 该对象会被
覆盖。测试 `78 R1.2-05a` 把这一行为**钉成可观测断言**（外部内容确实被覆盖），
并同时证明注入点位于复核之后（若在之前，会以 409 收场）。这是已知未解决风险。

## 四、R1-02 页面实例身份的存储异常边界

**缺陷**：`getItem` 抛错会直接把异常冒到 `/api/open`（表现为"无法连接本地服务"）；
"新 id 已生成但没写进 sessionStorage"仍被返回，等于声称"刷新后还是同一身份"。

**修复**：`resolvePageInstance(ports) → { id, degraded }`，`resolvePageInstanceId`
作为薄包装。判定只有一条：

- `getItem` 抛错 → `null`（`storage-read-failed`），**不生成**候选 id；
- 新 id 的 `setItem` 抛错 → `null`（`storage-write-failed`）；
- 旧 id 本来就在存储里（读得到 ⇒ 已持久化）→ 照旧返回，重写失败只降级为一次
  无效写入（`degraded: null`）；
- 连新 id 都抢不到锁 → `null`（`lock-contended`）。

`client-api.pageInstanceId()` 也兜住异常并缓存结果：任何身份解析异常都不允许让
一次打开失败（Host 会退回"没有页面归属"的旧语义）。

**测试**：套件 77（6 例）。

---

## 红测 / 绿测

**修复前（红）**

| 套件 | 修复前 |
| --- | --- |
| 77 页面实例存储边界 | 模块不存在 `resolvePageInstance`（红：导入失败）；`getItem` 抛错直接冒泡 |
| 78 占位/改名 | 04a 04b 04c 04d 05a 05b 全红（6 fail / 1 pass） |
| 79 接管回收 | 01a「第 2 个旧 View 必须被回收」、01c「本页面旧 View 必须回收」红 |

**修复后（绿）**

```
72-s11ux02c02-structure-host.test.ts              pass=16 fail=0 skip=0
73-s11ux02c02-structure-shell.test.ts             pass=11 fail=0 skip=0
74-s11ux02c02r1-view-barrier-reservation.test.ts  pass=9  fail=0 skip=1   ← 保留
75-s11ux02c02r11-page-instance.test.ts            pass=8  fail=0 skip=0   ← 保留
76-s11ux02c02r11-shell-host-integration.test.ts   pass=4  fail=0 skip=0   ← 保留
77-s11ux02c02r12-page-instance-storage.test.ts    pass=6  fail=0 skip=0   ← 新增
78-s11ux02c02r12-reservation-rename.test.ts       pass=7  fail=0 skip=0   ← 新增
79-s11ux02c02r12-restore-takeover.test.ts         pass=5  fail=0 skip=0   ← 新增
合计 `npm run test:p0`                            tests 907 / pass 905 / fail 0 / skip 2
```

## 变异探针（把实现改回缺陷形态，确认测试真的会红）

| 探针 | 改动 | 结果 |
| --- | --- | --- |
| P1 | 重新占位失败退回 `REJECTED` | 78-04c/04d 红（2/2） |
| P2 | close 失败后不再尽力关句柄 | 78-04b/04d 红（2/2） |
| P3 | 去掉 `beforeMoveRename` 注入点 | 78-05a 红（1/1） |
| P4 | `shouldReclaim` 只认显式 `reclaimPage` | 79-01a 红（即时回收这条）；01c/01e 仍绿——它们由批量回收兜住，故另设 P5 |
| P5 | `reclaimStaleViews` 变成空操作 | 79-01e 红（1/1） |
| P6 | `keepViewIds` 传空数组 | 79-01a 红（用户刚建的 View 被当成遗留物关掉） |
| P7 | 未持久化的新 id 也返回 | 77-02b 红（1/1） |

七个探针均已还原（`git diff` 无 `probe`/`PROBE` 残留）。

## 真实 Chrome 证据（`green/browser-verification.json`，12/12 通过）

`docs/evidence/ux-02c-02-r12/green/`：`00-opened-14.png`、`01-after-reload.png`、
`02-pageB.png`。场景（14 个真实文件 + 独立 `g01..g03` 未打开文件 + 外部 `victim.md`）：

| 检查 | 证据 |
| --- | --- |
| 编辑与保存 | 保存提示"已保存到磁盘"，`f14.md` 磁盘内容 = 编辑后的文本 |
| 重复打开 | 标签数 14 → 14（多一次临时 open），首个 View 仍 200 |
| 双页面隔离 | A 页 `view-2`、B 页 `view-16` 同时有效，互不影响 |
| 页面刷新 | 身份 id 不变（`a1efe43e…`）、旧 View 403、另一页面仍 200、恢复 14/14 |
| 恢复中断 | 注入脚本在树出现 700ms 后点 `f10.md`；通知链出现"恢复被中断：原记录已保留；本次恢复了 4 个文件标签"，标签数 6 < 14 |
| 遗留 View 回收 | 中断后 `f13.md`（从未被重新打开）改名 **200 成功**（无幽灵 View） |
| 文件改名（UI） | 右键 → 重命名 → `g01.md → g01-renamed.md`，磁盘落盘 |
| 文件移动（UI） | 右键 → 移动到… → `docs/`，`docs/g02.md` 内容正确 |
| 外部同名文件 | `g03.md → victim.md` 返回 409 `ERR_ENTRY_EXISTS`，`victim.md` 内容不变 |

**说明（如实记录）**：
- 恢复中断依赖"用户点得比恢复快"，脚本用 CDP 网络延迟（220ms）+ 注入脚本延迟
  700ms 点击来稳定复现这一时序；连续两次运行结果一致（同为 6 个标签、
  `f13` 改名 200）。关闭延迟后 14 个标签在几百毫秒内就恢复完，无法复现接管——
  这也是该缺陷此前没被自动化发现的原因。
- **外部文件替换竞争**（R1-05 的窗口中段）无法从浏览器驱动（需要在本进程内、
  `rename` 前的一瞬间插入外部动作）；浏览器只验证了"目标已存在时零覆盖"这一
  可确定性部分，窗口本身由套件 78-05a 的故障注入锁住。
- 本轮 03/04 两张截图在 headless 下 `Page.captureScreenshot` 超时未取到
  （连试 3 次），JSON 与三张截图已足以为上述断言提供证据；这是截图工具问题，
  不影响断言本身。

## 门禁

`npm run test:p0`（907/905 pass, 0 fail, 2 skip）、`npm run typecheck`、
`npm run typecheck:apps`、`npm run build:shell`、`git diff --check` 全绿。
套件 72–76 全部保留并通过；未修改 `main`；未生成 ZIP。
