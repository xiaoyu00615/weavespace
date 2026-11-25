# UX-02C-03-P2-02-R1.2.1-R1 证据（台账外部失效保护 / 跨标签页状态一致性）

基线：`6b6c53d31aa4288b25f6a4ab6b3e02fb07920c74`（R1.2.1）。
本轮只改 `apps/shell/src/state/trash-ledger.ts`、`apps/shell/src/state/TrashContext.tsx`、
测试套件 95/96/98 与本目录；未改 `apps/server/**`、`packages/storage/**`、回收区磁盘事务、
Provider、导航/菜单、CSS、容量与永久删除策略，未碰 `main`。

## 一、R1-01：外部删除台账导致恢复保护失效

根因（旧实现）：`storage` 监听只把事件当"通知"，`refresh()` 直接把持久层读到的内容
替换内存镜像；`removeItem`（`newValue === null`）与 `localStorage.clear()`（`key === null`）
读回来都是 `{status:'ok', records:[]}`，与"首次使用的空台账"完全同形，于是已经打开的
另一个标签页把已知 UNKNOWN 换成空数组——保护被删除本身解除。

修复：

1. `applyExternalEvent({key,newValue})` 成为唯一入口，三种情况分开：
   - `key === null`（clear）或 `newValue === null`（removeItem）→ `invalidated = true`，
     **保留** `current`，**不写盘**、**不重建**，`publish()` 通知界面；
   - 匹配 key 且 `newValue` 可解析 → 采纳（沿用 `refresh` 语义）；
   - 无关 key → 原样返回 `false`。
2. `invalidated` 是页面级终态：`refresh()`、后续任何 `storage` 事件（包括"又写了一份
   合法空台账"）都不解除；`reserve/release/reconcile` 一律 `unavailable` 且不写盘。
3. `readTrashLedger()` 未改：首次启动读到 `null` 仍然是合法空台账（测试 17 钉住）。
4. 非 ok 读取（corrupt）保留内存记录，不再 `return false` 丢掉状态变化。
5. 追加一层纵深防御：`reserve` 在锁内重读时若"持久层突然变空而本页已知有记录"，
   判 `unavailable` 并保留内存记录——避免删除事件还没送达的那一帧把已知记录
   覆盖成"只剩新的这一条"。`release/reconcile` 不启用该判定（它们本来就是拿结论换记录）。

状态新增 `invalidated`，文案独立（"被其他页面删除或清空…请刷新页面重新核对"），
不引导用户清除站点数据。

## 二、R1-02：Store 与 React 镜像不同步

根因：`reservePending()` 只在 `trashReserveAuthorizes(outcome)` 成立时 `syncLedger()`；
而 store 在锁内重读时可能已经把别的页面写的记录读进 `current`。于是 `exists` 被拒绝、
store 正确、React 镜像仍是旧的；随后的 `storage` 事件因 `refresh()` 比较的是"记录签名"
（此时 store 与镜像的签名已经不同，但 `refresh()` 只与**自己**上一次的签名比）返回
false，界面再也追不上。

修复：

1. **单一状态源 + 订阅**：store 新增 `snapshot()` / `subscribe()` / `version`，
   Provider 改用 `useSyncExternalStore(store.subscribe, store.snapshot)`，
   删掉所有手写 `syncLedger()`。`reserve/release/reconcile` 无论返回
   `reserved|exists|full|write-failed|unavailable|changed|unchanged`，结束时都
   `publish()` 一次，只有"状态或记录真的变了"才 `version+1` 并通知。
2. **refresh() 判定改为"状态 + 记录"**：`ok → corrupt / invalidated / full` 即使记录
   集合一字未变也返回 `true`（旧实现 `if (fresh.status !== 'ok') return false`）。
3. **快照内含 `blockMessage`**：渲染不再二次读 store，避免同一帧两份口径。

## 三、红测（先写测试，修复前真实结果）

修复前：

| 套件 | 用例 | 结果 |
| --- | --- | --- |
| 98 | 23 | 16 pass / **7 fail**（`applyExternalEvent` 不存在 → TypeError；最后一条断言 `reserved !== unavailable` 是真实行为失败） |
| 95 | 33 | 31 pass / **2 fail**（状态变化不通知、`invalidated` 文案缺失） |
| 96 | 53 | 50 pass / **3 fail**（镜像不同步、失效后仍可继续） |

修复后：98 23/23、95 33/33、96 53/53 全绿。

新增用例（12 条）：

- 98：首次启动空台账合法；removeItem 保留记录+失效+三写路径全关+不重建；
  `clear()` 的 `key === null` 同样进入失效；失效后再写空台账不解除（`refresh` 也不解除）；
  外部写坏数据 → corrupt + 保留记录 + 不覆盖原字节；无关 key 不影响；
  删除事件未送达时 `reserve` 拒绝覆盖。
- 95：记录集合不变、仅状态变坏时 `refresh()` 必须返回 `true`；`invalidated` 文案独立且不引导清数据。
- 96：`exists` 后镜像立即同步且零 POST；外部删除后绕过界面调 Controller → 零 POST/GET/query；
  `release/reconcile` 即使结论是 `unchanged` 也要同步锁内读到的记录。

## 四、变异探针（每个都确认写入源码、还原后 SHA 一致）

| 编号 | 变异 | 结果 | 咬住的用例 |
| --- | --- | --- | --- |
| A | 删除事件当作空台账（采纳空集合） | BITTEN | 98-18/19/20、96-52 |
| B | 删除事件后清空内存记录 | BITTEN | 98-18/19/20、96-52 |
| C | `key === null` 不做特殊处理 | BITTEN | 98-19 |
| D | `reserve` 仅在 `reserved` 时同步镜像 | BITTEN | 96-51 |
| E | `refresh` 只比较记录签名 | BITTEN | 95-32、98-21 |
| F | 非 ok 状态一律不通知 React | BITTEN | 95-32、96-52、98-18/19/20/21 |

明细见 `mutations.json`（含变异前后 SHA、每条失败用例名）。A/B 咬不到 98-23 是预期的：
那条走的是 `reserve` 的"持久层突然变空"判定，与事件入口互相独立。

## 五、真实 Chrome 双标签页（25/25）

两个同源标签页、同一 profile、真实 `localStorage` 与真实 `navigator.locks`；
每个标签页各自 `Fetch.enable` 拦截 `/api/trash/restore` 并回 202 UNKNOWN，POST 计数
即"真实副作用请求次数"。台账记录 X = `op-r121r1-0001`（由 `POST /api/trash/entry`
真实把 `p.md` 移入回收区产生）。

| 场景 | 断言 | 结果 |
| --- | --- | --- |
| A `removeItem` | A 一次 UNKNOWN 恢复后写下 X；A/B 两页都显示「待核对」；B 收到 `key=台账/newValue=null`；B 显示"被删除/失效"；B 保留 X；B 按钮关闭；磁盘台账确实为空（未重建）；B 强制绕过 disabled 点击 0 POST | ✅ 10/10 |
| B `localStorage.clear` | B 收到 `key === null`；进入失效；保留 X；强制点击 0 POST | ✅ 4/4 |
| C 外部写坏数据 | B 显示「已损坏」；保留内存记录；原始字节未被覆盖；强制点击 0 POST | ✅ 4/4 |
| D `exists` 与镜像 | B 启动时读到空台账（可恢复）；直接写盘后镜像仍过期；点击恢复 → **0 POST**；界面立刻变「待核对」并给出"上一次结果还没确认"；后续 storage 事件不让界面倒退、也不产生 POST | ✅ 7/7 |

截图：`10-scenario-a-remove-item.png`、`20-scenario-b-clear.png`、
`30-scenario-c-corrupt.png`、`40-scenario-d-exists-mirror.png`。
`browser-verification.json` 内含每个场景的 storage 事件数组、行状态、横幅文案与 POST 计数；
`verify-browser.mjs` 是本次运行的脚本（可重跑）。

> A 与 B 的截图字节相同：删除与 `clear()` 的可见后果按设计完全一致（同一条失效提示、
> 同一条待核对记录），区别只在事件形状，证据是 `detail.scenarioA/B.events`。

## 六、门禁（本轮实跑）

| 命令 | 结果 |
| --- | --- |
| `npm run test:p0` | **1199 例 / 1197 pass / 0 fail / 2 skip** |
| `npm run typecheck` | 通过 |
| `npm run typecheck:apps` | 通过 |
| `npm run build:shell` | 通过 |
| `git diff --check` | 通过 |

日志：`gate-test-p0.txt`、`gate-checks.txt`。

## 七、未解决风险（如实记录）

1. **删除事件与"另一页面释放最后一条"在持久层同形**：本实现按任务书以 `storage`
   事件为准。若另一个页面的恢复/收敛把记录清到 0 条，本页下一次 `reserve` 会被
   "持久层突然变空"判定拒绝一次（fail-closed），需要一次成功的列表收敛或刷新才恢复。
2. **事件到达前的极短窗口**：外部删除与 `storage` 事件投递之间，若本页恰好发起
   `release/reconcile`，仍可能采纳"空台账"（这两个操作按设计要采纳结论）。
   `reserve` 已被单独保护；其余路径只影响磁盘副本，本页仍会因事件进入失效保护。
3. **浏览器只证到 UI 层**：页面没有对外暴露 Controller，"绕过 UI"的可观测形态是
   "把 `disabled` 改回 false 再点 → 0 POST"；Controller 自身闸门由 96 直接驱动真实
   控制器证明。
4. **Node 侧两个 store 非同进程真实抢占**：跨标签页的互斥仍由真实 Chrome 补证，
   Node 侧证明的是"锁内重读"这一性质。
5. **失效后无应用内修复入口**：按要求不加清空按钮、不自动重建；用户只能刷新页面
   （刷新后读到的仍是空台账，会回到"干净的首次使用"——这是任务书允许的页面生命周期边界）。
6. 满仓时行徽标仍显示记录自身状态，"能不能点"由顶部横幅与禁用态表达（沿用 R1.2 结论）。
