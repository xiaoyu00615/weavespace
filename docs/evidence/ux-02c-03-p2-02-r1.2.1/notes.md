# UX-02C-03-P2-02-R1.2.1 证据（恢复授权闸 / 跨标签页原子性 / UTF-8 字节）

基线：`05b97c8`（R1.2）。本轮只改台账、Provider、Controller 与测试，未改 Host 事务、
存储 Provider、文件身份核验、导航、菜单、CSS，未碰 `main`。

## 一、门禁

| 命令 | 结果 |
| --- | --- |
| `npm run test:p0` | 1187 例 / 1185 pass / 0 fail / 2 skip（95:31、96:50、97:14、98:16） |
| `npm run typecheck` | 通过 |
| `npm run typecheck:apps` | 通过 |
| `npm run build:shell` | 通过（见 `gate-checks.txt`） |
| `git diff --check` | 通过（只有 CRLF 提示，无空白错误） |

日志：`gate-test-p0.txt`、`gate-checks.txt`。

## 二、真实 Chrome：两个同源标签页（20/20）

环境：headless Chrome 158（CDP 9335）+ Vite 5278 + 真实 Host（managed store，5277）。
**两个标签页同源、同一浏览器 profile、共享 localStorage 与 `navigator.locks`。**
数据在 `weavespace-test/p202-r121`，未碰任何用户文件。

网络层：每个标签页各自 `Fetch.enable`，统计并挂起 `/api/trash/restore`；需要时构造 202 UNKNOWN。
锁层：把 `navigator.locks.request` 包一层，记录调用并在临界区内加 60ms 延迟——
**只放大竞争窗口，不改应用逻辑**。

| 断言 | 结果 |
| --- | --- |
| 两个标签页共享同一份 63 条台账 | ✅ |
| 并发申请最后一个位置：只有一个发出副作用 POST（`posts = 1`） | ✅ |
| 最终台账恰好 64 条，没有互相覆盖 | ✅ |
| 只有拿到授权的那一条留在台账里 | ✅ |
| 两个标签页都通过 `weavespace-trash-ledger-v1`（exclusive，共 3 次） | ✅ |
| 满仓后至少一个标签页显示「已满」 | ✅ |
| 另一个标签页里同一 opId 已显示「待核对」并禁用（storage 事件同步） | ✅ |
| 在该标签页强制点击（把 `disabled` 改回 false 再点）→ 零 POST | ✅ |
| 赢家的 POST 被挂起（证明全程只发了一次） | ✅ |
| 成功恢复后该 opId 从台账清除 | ✅ |
| UNKNOWN → 重载 → 仍「待核对」且禁用 | ✅ |
| 重载后强制点击 → 零 POST | ✅ |
| 构造台账：字符数 6035（≤16384）、UTF-8 字节 18035（>16384） | ✅ |
| 该台账被判定「已损坏」并关闭恢复 | ✅ |
| 损坏时原字节未被覆盖（仍含「汉」） | ✅ |
| 损坏时任何点击零 POST | ✅ |
| 还原台账后不再显示「已损坏」 | ✅ |
| 没有 Web Locks：面板说明"无法跨标签页协调"并关闭恢复 | ✅ |
| 没有 Web Locks：任何行都没有恢复按钮 | ✅ |
| 没有 Web Locks：点击零 POST | ✅ |

截图：`10-race-1-post.png`、`11-race-other-tab.png`、`20-after-reload-pending.png`、
`30-utf8-corrupt.png`、`40-no-web-locks.png`；逐条断言在 `browser-verification.json`。

## 三、跨标签页原子性怎么保证

1. **互斥**：`navigator.locks.request('weavespace-trash-ledger-v1', {mode:'exclusive'})`。
   名字固定且带版本，同源所有标签页抢同一把锁。
2. **锁内重读**：`reserve` / `release` / `reconcile` 三个写操作都在锁内
   `readTrashLedger()` 重新读一遍，再判断容量/是否存在、再写盘。本地镜像只用于渲染。
3. **只有 `reserved` 授权**：`trashReserveAuthorizes()` 是唯一判定入口（Provider 与测试共用）。
4. **`storage` 事件只是通知**：别的标签页写了台账 → 本页 `refresh()` 重读并刷新 UI；
   它不参与并发安全，真正的判断永远在锁内。
5. **没有 Web Locks → fail-closed**：`status()` 直接 `unavailable`，恢复整体关闭，
   不会退回"各写各的 localStorage"。文案不引导用户清除数据。

## 四、判别力（变异探针，全部先红后绿）

| 探针 | 结果 |
| --- | --- |
| 去掉锁内的 `current = fresh.records`（不重读） | 98 的 5 条跨标签页用例全红 |
| `byteLengthOf` 改回 `value.length` | 98 的 2 条 UTF-8 用例红 |
| `isCanonicalIsoUtc` 改回 `Date.parse` | 98 的 2 条时间用例红 |
| `trashReserveAuthorizes` 改成"非 write-failed 就算授权" | 96 + 98 共 10 条用例红 |

## 五、未覆盖 / 限制（如实记录）

1. **浏览器只证明到 UI 层**：页面里没有对外暴露 Controller，所以"直接调 Controller 再发一次"
   的可观测形态是"强制绕过 `disabled` 点击 → 零 POST"。Controller 自身的闸门由套件 96
   的三条用例（存在即拒绝 / UNKNOWN 后再拒绝 / 终态后放行）直接驱动真实控制器证明。
2. **Node 侧的"两个标签页"** 是两个 store 共享同一份 storage + 同一把协调器；它证明的是
   "锁内重读"这一关键性质，但单进程无法复现两个浏览器进程的真实抢占——那部分由上面的
   Chrome 双标签页验证补上（并把临界区人为拉长 60ms 放大竞争窗口）。
3. 容量满时行徽标仍显示记录自身状态（如「可恢复」），是否可点由操作区与顶部横幅说明。
4. 台账损坏 / 无 Web Locks 时没有应用内修复入口（按要求不加清空按钮、不引导清数据）。
