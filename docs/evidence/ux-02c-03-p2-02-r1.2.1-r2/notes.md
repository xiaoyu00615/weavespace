# UX-02C-03-P2-02-R1.2.1-R2 证据（跨刷新失效保护 / StorageEvent 竞争）

基线：`856fa02d193b73327ffa8fecc169ec6f943462e8`（R1）。
分支：`wip/ux-02c-03-p2-02-trash-ui-20261126-r2`（从基线新建，不改写历史）。
范围：`trash-ledger.ts`、新增 `trash-ledger-guard.ts`、`TrashContext.tsx`（只加装配）、
新增套件 99、R2 证据目录，以及 R2-04 指定的 R1 验证脚本。未改 server / storage /
事务 / Controller / 导航 / 菜单 / CSS / 容量策略，未合并 `main`。

## 一、R2-01：失效状态跨刷新丢失 → 独立持久化保护记录

根因：`invalidated` 只活在页面内存里。刷新后新 store 读到的 localStorage 已经是空的，
`readTrashLedger()` 把它认成"首次使用的合法空台账"，UNKNOWN 就此消失、闸门重新打开。

修复：新增 **IndexedDB 保护记录**（库 `weavespace-trash-guard-v1` / 表 `guard` / 键 `current`）：

```
TrashGuardRecord = { version: 1, records: TrashPendingRecord[], invalidated: boolean }
```

它**独立于 localStorage**，外部 `removeItem` / `clear()` 动不到；读不出来时整层
`unavailable`（fail-closed），绝不退回 R1 的单层写法。

初始化规则（`initFromGuard`，与任务书的表一一对应）：

| 主台账 | 保护记录 | 行为 |
| --- | --- | --- |
| 空/不存在 | 不存在 | 首次使用：写一份空保护记录；写失败 → `unavailable` |
| 有记录 | 不存在 | **迁移**：把主台账记录写进保护记录（R1 升级不丢记录） |
| 空/不存在 | 有记录 | `invalidated`，内存保留保护记录里的记录 |
| 空/不存在 | 有失效标记 | `invalidated` |
| 空 | 空 | 正常 |
| 损坏 | 有记录 | `corrupt`（fail-closed），记录保留 |
| 任一读取失败 | — | `unavailable` |

写入顺序（`persist`）：**保护记录先 → 主台账后**，两者都成功才算"已保护"；
保护记录写失败直接 `write-failed`（不写主台账、不授权）；主台账写失败也 `write-failed`
（保护记录已落盘，属于"保守多拦一次"）。

"正常结清"与"被删除"的区分：结清走 `reconcile / release`，把**两层都写成合法空台账**；
`removeItem` 只会动主台账，所以"保护记录非空 + 主台账为空"就是外部删除的证据。

## 二、R2-02：StorageEvent 竞争导致记录丢失

根因：`applyExternalEvent()` 处理事件时回读**当前** localStorage。A 连续
`setItem` → `removeItem` 时，B 处理第一个事件读到的已经是空台账，先把内存清空，
再收到删除事件——记录已经没了。

修复：
1. 拆出 `parseTrashLedgerValue(raw)`，事件处理**只用 `event.newValue`**，绝不回读；
2. `newValue === null` = 外部删除、`key === null` = `clear()`，都进入 `invalidated` 并
   把标记与记录写进保护记录；
3. 外部写入只做**并集**（`unionRecords`），别的页面少一条不等于"已经结清"；
4. `invalidated` 是终态：后续任何事件、`refresh()`、旧事件都直接返回 `false`，
   连版本号都不再动；
5. 事件读不懂 → `corrupt`，保留内存记录与原始字节；无关 key 直接忽略。

## 三、R2-03：三个写路径统一处理"异常缺失"

`reserve / release / reconcile` 都先过同一个 `syncFromLayers()`（锁内）：

1. 读保护记录（耐久真相）：`records` 为空 → 说明另一页面正常结清，本页也清空；
2. 读主台账：读不到 / 读坏 → `false`（`unavailable`）；
3. **保护记录里还有记录、主台账却是空** → 异常缺失：`invalidated` + 保留记录 +
   写失效标记 + 返回 `false`（三个路径一视同仁，不再只有 `reserve` 有保护）；
4. 正常：`main ∪ guard` 合并（只增不减）。

任何一次状态变化都走 `publish()`（`version` + `subscribe`），React 与闸门同时更新；
异常缺失时**不写主台账**，也不碰保护记录里的记录。

## 四、R2-04：浏览器验证脚本退出码

`docs/evidence/ux-02c-03-p2-02-r1.2.1-r1/verify-browser.mjs` 原来无条件 `process.exit(0)`。
现在判定抽到 `browser-verdict.mjs`（`summarize` / `exitCodeFor`），脚本末尾改为
`process.exit(exitCodeFor(failed))`，并新增 `--self-test`（含一条合成失败 → 退出 1）
与 `--self-test-pass`（全通过 → 退出 0）。套件 99 用 `spawnSync` 真跑这两种模式，
**证明失败不会被当成功**。脚本内容除退出码与 helper 抽取外未改动；R1 的截图与
`browser-verification.json` 未改。为了让脚本能脱离 /tmp 复跑，同目录补了 `cdp.mjs`
与 `browser-verdict.mjs`。

## 五、红测（先写测试，修复前的真实结果）

套件 99 共 18 例，修复前 **0 pass / 17 fail**（第 18 例是 R2-04 退出码用例，随脚本修复转绿；
其余 17 例失败原因包括 `store.ready is not a function` 与"保护记录根本不存在"）。
修复后 18/18；95(33)/96(53)/97(14)/98(23) 全部保持通过。

覆盖：A 组 8 例（首次使用 / R1 迁移 / removeItem 重开 / clear 重开 / 正常结清 /
保护记录写失败 / 主台账写失败 / 保护记录读失败）、B 组 5 例（事件快照、失效 sticky、
clear、损坏、无关 key）、C 组 4 例（三路径异常缺失 + 正常空台账不误判）、R2-04 1 例。

## 六、变异测试（每个都确认写入、跑测、还原、SHA 一致）

| 编号 | 变异 | 结果 | 咬住的用例 |
| --- | --- | --- | --- |
| A | `persist` 不再写保护记录 | BITTEN | 99-A3/A4/A6/A7、C×3 |
| B | 事件用回读的 localStorage 代替 `newValue` | BITTEN | 99-B1 |
| C | 移除 `invalidated` 的 sticky 保护 | BITTEN | 99-B2 |
| D | `release` 不做异常缺失检查 | BITTEN | 99-C(release) |
| E | `reconcile` 不做异常缺失检查 | BITTEN | 99-C(reconcile) |
| F | 保护记录写入失败仍然授权 | BITTEN | 99-A6 |

明细（含变异后 SHA 前缀、还原后与基线 SHA-256 一致）见 `mutations.json`。
注：C 首次运行时 SURVIVED——原 B2 只重放同一份记录，移除 sticky 后 `publish()` 仍返回
`false`。已把 B2 加强为"失效后再收到带**额外记录**的旧事件"，断言记录与版本号都不许变，
变异随即 BITTEN（这是加强断言，不是放宽）。

## 七、真实 Chrome 双标签页（20/20）

两个同源标签页、同一 profile、真实 `localStorage` + 真实 IndexedDB + 真实 `navigator.locks`；
每个标签页 `Fetch.enable` 拦截 `/api/trash/restore` 并回 202 UNKNOWN，POST 计数即副作用次数。

| 场景 | 断言 | 结果 |
| --- | --- | --- |
| A `removeItem` | 两层都有 X；B 同步；收到 `newValue=null`；显示失效；失效标记落进 IndexedDB；**刷新后仍「待核对」**；**刷新后仍失效**；刷新后强制点击 0 POST | ✅ 10/10 |
| B `clear` + 重新打开 | 全新页面仍「待核对」、仍失效、强制点击 0 POST、主台账未被重建 | ✅ 4/4 |
| C 连续 `setItem→removeItem` | B 保留 X、进入失效、0 POST、刷新后仍「待核对」 | ✅ 4/4 |
| D IndexedDB 不可用 | 明确关闭恢复（"本机存储不可用"）、强制点击 0 POST | ✅ 2/2 |

截图：`10-scenario-a-removeitem-after-reload.png`、`20-scenario-b-clear-reopen.png`、
`30-scenario-c-race.png`、`40-scenario-d-guard-unavailable.png`。
逐条明细（storage 事件、保护记录内容、行状态、横幅文案、POST 数）在 `browser-verification.json`。

> 事件延迟竞争另有**确定性**用例（99-B1）：先把持久层删空，再按顺序喂两个事件，
> 第一个事件必须采纳自己的 `newValue`。浏览器里的自然调度只作为补充。

## 八、门禁（本轮实跑）

| 命令 | 结果 |
| --- | --- |
| `npm run test:p0` | **1217 例 / 1215 pass / 0 fail / 2 skip** |
| `npm run typecheck` | 通过 |
| `npm run typecheck:apps` | 通过 |
| `npm run build:shell` | 通过 |
| `git diff --check` | 通过（仅 CRLF 提示） |

日志：`gate-test-p0.txt`、`gate-checks.txt`。

## 九、未解决风险与边界

1. **失效是终态**：任务书要求"刷新后不得重新开放"，因此一旦保护记录落下
   `invalidated`，本版本**没有应用内解锁路径**（不能加按钮、不能自动重建）。用户只能等
   后续核对/修复流程，或清除站点数据（那属于独立存储边界，本机制不声称能抵御）。
   这是 fail-closed 的代价，已在代码注释里写明。
2. **主台账写入失败会升级为失效**：保护记录已写入、主台账写失败时，下一次
   `syncFromLayers` 会看到"保护记录有、主台账空"而判异常缺失。任务书允许"保守地多拦一次"；
   代价是配额异常后该 origin 进入失效终态。
3. **IndexedDB 被策略禁用**（无痕/第三方上下文）：整层 `unavailable`，回收区恢复全关。
   这是有意的 fail-closed，不是退化。
4. **两个标签页同时写保护记录**：仍在同一把 Web Locks 锁内，最后写者为准；
   单个标签页的镜像可能短暂落后，但下一次操作会并集回来（只增不减），不会丢 UNKNOWN。
5. **用户清除"所有站点数据"**（同时清 localStorage 与 IndexedDB）超出本机制边界。
6. 浏览器只证到 UI 层："绕过"的可观测形态仍是把 `disabled` 改回 false 再点 → 0 POST；
   Controller 闸门由 96 直接驱动证明。
