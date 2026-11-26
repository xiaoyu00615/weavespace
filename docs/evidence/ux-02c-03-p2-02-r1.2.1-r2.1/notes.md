# UX-02C-03-P2-02-R1.2.1-R2.1 证据（双层台账事务收敛 / 异步授权）

基线：`700de7a6df9443b20ad59de9def4f90065fff318`（R2），在原分支
`wip/ux-02c-03-p2-02-trash-ui-20261126-r2` 上继续，不新建分支、不改写历史。

范围：`trash-ledger.ts`、`trash-ledger-guard.ts`、`trash.ts`（Controller 定点修复）、
套件 96/99、本证据目录。未改 server / packages/storage / 事务 / 导航 / 菜单 / CSS /
容量策略 / main。

## 一、R2.1-01：持久化失效必须阻断操作

根因：`syncFromLayers()` 读到 `record.invalidated === true` 时只把内存标记翻成 true，
主台账若仍合法（非空）就继续走到 `return true`，于是 `reserve` 照常写盘并返回 `reserved`——
持久化失效只影响界面提示，授权没有被阻断。

修复：读到 `invalidated` 立即 `invalidated = true; return false`，三个写路径都拿到 false →
`unavailable`、不写盘、返回 `reserved` 不可能。记录与保护记录原样保留，`publish()` 让
快照/闸门同步关闭。

测试：99「R2.1-01」（主台账仍合法、B 未收到事件 → reserve 直接 unavailable，零写盘）。

## 二、R2.1-02：失效写入不得覆盖新记录

根因：`writeInvalidation()` 直接 `guard.write({ records: current, ... })`。`current` 是本页
可能过期的镜像：另一页面刚预留的记录会被抹掉，等于把一条 UNKNOWN 从账本上删除。

修复：`mergeInvalidationLocked()`（同一把 Web Lock 内）：
1. 重新读保护记录（四态）；
2. `unavailable` / `corrupt` → **一个字节都不写**（不许用旧快照覆盖持久层）；
3. `existing ∪ current` 合并，`current = merged`（内存跟上耐久真相）；
4. 合并后超过 `MAX_TRASH_PENDING` → 不写（绝不淘汰）；
5. 只写 `invalidated: true`，没有写回 false 的分支；
6. 已经是失效且记录没变 → 不重复写。

测试：99「R2.1-02 锁内合并」（A 加 Y、B 未同步、B 失效落盘 → 最终 X+Y 都在，
重开仍 invalidated）、「读不出保护记录时不得写」。

## 三、R2.1-03：区分损坏与不存在

根因：`TrashGuardStorage.read()` 返回 `TrashGuardRecord | null`，`decodeTrashGuard` 解析失败
也返回 `null` → 损坏与"首次使用"同形，初始化逻辑会把损坏数据覆盖成一份新的空记录。

修复：读结果改为四态 `missing | valid | corrupt | unavailable`（`decodeTrashGuardValue`）：
- 只有 `undefined` / `null` 才是 `missing`；
- 版本不认识、字段非法、`records` 非数组、**条数超过 64** → `corrupt`；
- IndexedDB 读失败 → `unavailable`。
`initFromGuard` / `syncFromLayers` / `mergeInvalidationLocked` 三个读取分支都按四态处理：
`corrupt` → `status = 'corrupt'`、不写、不初始化、不当"缺失"；`unavailable` → `unavailable`。
容量边界在解析层拒绝而不是截断，保证"读不全就不认"。

测试：99「四态解析」「主台账有效+保护记录损坏」「主台账不存在+保护记录损坏」
「读不出来 → unavailable 且快照更新」。

## 四、R2.1-04：异步预留后的发送前身份复核

根因：`restore()` 在 `await host.reservePending()` 之后直接发 POST。预留是异步的
（跨标签页锁 + 两层持久化），等待期间用户可能切工作区 / 切项目，或本地多出阻断条件；
此时 POST 仍会打到旧项目。

修复：预留成功后、POST 之前重新核对：
1. `owned(projectId, snapshot)`（mode/workspaceMode/workspaceKey/epoch/activeProjectId）；
2. `host.preflight(projectId)`（live + multi + READY + 活动项目）；
3. `host.blockers(projectId, entry.path)`（本地阻断：活动标签/草稿/保存中/结果未知）。

任一不满足 → 用**发起时的身份**（`target`）`releasePending`，返回 `stale`（项目不可用返回
`rejected`，有本地阻断返回 `blocked`），**零 POST**。不重新预留，因此既不会多占一个位置，
也不会因为"这次预留恰好把台账填满"而反过来拒绝已经拿到的授权。释放用 `target`，碰不到
别的工作区/别的事务的同 opId；台账若已失效，`release` 被 store 拒绝（不写盘），记录保守保留。

测试：96「切到别的工作区」「切到同工作区另一个项目」「预留恰好占满第 64 个位置」。
断言零 POST、返回 stale、不写 TRASH_BUSY、无提示、B 的同 opId 记录不被误删。

## 五、红测

新增 10 例（99 七例、96 三例）。修复前：99 **19 pass / 6 fail**、96 **53 pass / 3 fail**；
修复后 99 25/25、96 56/56。失败形态包括：`reserve` 返回 `reserved`（01）、保护记录只剩 X
丢 Y（02）、损坏被当首次使用覆盖（03）、切换身份后仍发 POST（04）。

## 六、定向变异（全部 BITTEN，还原后 SHA-256 与基线一致）

| 编号 | 变异 | 咬住的用例 |
| --- | --- | --- |
| A | 持久化失效只改内存标记、不阻断 | 99-R2.1-01 |
| B | 失效写入用本页旧快照覆盖（不合并） | 99-R2.1-02 锁内合并 |
| C | 保护记录损坏当成"首次使用"重新初始化 | 99-R2.1-03 ×2 |
| D | 预留完成后不复核身份 | 96-R2.1-04 ×3 |
| E | 复核失败时用"当前身份"释放（误删别的工作区） | 96-R2.1-04 ×2 + 96-29 |
| F | 读不到保护记录时仍用旧快照写盘 | 99-R2.1-02 读失败 |

明细（变异后 SHA 前缀、失败用例名、`restored: true`）见 `mutations.json`。
D 第一次用"只关掉 owned 检查"的方式变异时 SURVIVED——因为 `preflight` 是第二道独立检查，
两处都基于同一身份，单点关掉仍被另一处挡住。改成"整块移除发送前复核"后 BITTEN，
如实记录这条过程。

## 七、真实 Chrome（16/16）

| 场景 | 断言 | 结果 |
| --- | --- | --- |
| A 持久化失效 + 新页面 | A 产生 UNKNOWN；保护记录有这条；B 删主台账 → A 落失效标记；A 把主台账写回（**主台账重新合法**）；新开页面仍「待核对」、仍失效、强制点击 0 POST | ✅ 7/7 |
| B IndexedDB 损坏 | 面板显示"已损坏"；强制点击 0 POST；损坏的原始值 `records: 'not-an-array'` 未被覆盖 | ✅ 4/4 |
| C 预留期间切换身份 | 锁内加 1.5s 延时放大窗口；点恢复后立刻切「演示」→ 0 POST；台账里没有留下无副作用的新记录 | ✅ 2/2 |
| D 并发预留同一行 | 两个标签页同时点同一行（各 400ms 锁延时）：合计 1 次 POST；台账与保护记录各只有 1 条 | ✅ 3/3 |

截图：`10-scenario-a-persisted-invalidated.png`、`20-scenario-b-guard-corrupt.png`、
`30-scenario-c-stale-during-reserve.png`、`40-scenario-d-concurrent-reserve.png`。
明细在 `browser-verification.json`。

## 八、门禁（本轮实跑）

| 命令 | 结果 |
| --- | --- |
| `npm run test:p0` | **1227 例 / 1225 pass / 0 fail / 2 skip** |
| `npm run typecheck` | 通过 |
| `npm run typecheck:apps` | 通过 |
| `npm run build:shell` | 通过 |
| `git diff --check` | 通过 |

日志：`gate-test-p0.txt`、`gate-checks.txt`。

## 九、未解决风险

1. **失效仍是终态**：R2 的设计没变，`invalidated` 落盘后没有应用内解锁路径（任务书
   要求刷新不得重开）。本轮只保证它"一定阻断"，不提供修复入口。
2. **保护记录损坏后无法自愈**：`corrupt` 一律不写、不覆盖，用户只能等专门修复流程
   或清除站点数据（独立存储边界）。
3. **`mergeInvalidationLocked` 超过容量时不写**：内存会保留合并结果（只增不减），
   但保护记录可能仍是旧的一份；此时状态已是 invalidated，恢复全关，属于安全方向。
4. **Controller 复核与 POST 之间仍有极小窗口**：复核后到 `fetch` 发出之间不再加锁。
   要彻底消除需要一个"带身份的发送票据"，超出本轮定点修复范围。
5. **浏览器只证到 UI 层**：Controller 闸门由 96 直接驱动真实控制器证明。
