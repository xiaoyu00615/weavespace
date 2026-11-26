# UX-02C-03-P2-03 · 回收区最终收敛与真实集成验收

> 基线：`dfe5d8d09c70570c339332d793102a1478fbd387`（分支 `wip/ux-02c-03-p2-02-trash-ui-20261126-r2`）
> 本目录是**本轮实跑**的证据，不是历史结论的转抄。所有数字都来自下面这些脚本。
> 未自行宣布验收：等 GPT 独立复审。

## 0. 怎么复跑

```bash
# 1) 停 Host → 重置专用测试 Workspace → 起 Host
node docs/evidence/ux-02c-03-p2-03/reset-fixture.mjs
node apps/server/src/main.ts --workspace-store "D:/Workspace/projects/weavespace-test/p203/store" 5287

# 2) 起 Shell（代理到该 Host）
cd apps/shell && WS_API_TARGET=http://127.0.0.1:5287 npx vite --port 5288 --strictPort

# 3) 起一个干净的无头 Chrome
chrome --headless=new --remote-debugging-port=9337 --user-data-dir=D:/tmp/p203-profile about:blank

# 4) 四段验证（CDP_PORT 默认 9335，这里显式指定）
cd docs/evidence/ux-02c-03-p2-03
CDP_PORT=9337 node verify-lifecycle.mjs     # B2/B3
CDP_PORT=9337 node verify-unknown.mjs       # B4
CDP_PORT=9337 node verify-tabs.mjs          # B5
PHASE=1 CDP_PORT=9337 node verify-restart.mjs   # 然后重启 Host
PHASE=2 CDP_PORT=9337 node verify-restart.mjs   # 然后重启 Host
PHASE=3 CDP_PORT=9337 node verify-restart.mjs

# 5) 汇总
node assemble-evidence.mjs
```

每个脚本都以"检查结果"决定退出码（全通过 0，任一失败 1），不会被门禁误判成成功。

**不要在页面里用 `indexedDB.deleteDatabase()` 清场**：页面自己握着连接，删除请求会一直挂着，
之后所有 `open()` 都排队等它，逼出一个假的"initializing 卡死"（本轮踩过，见 §5.3）。
`openApp({ fresh: true })` 用的是 CDP `Storage.clearDataForOrigin`，并且**先导航到该 origin 再清**。

## 1. 阶段 A：四项定点修复

### A1 异步预留期间的失效保护（`trash-ledger.ts` / `trash.ts` / `TrashContext.tsx`）

根因：`reserve` 在锁内 `await syncFromLayers()`（读保护记录 + 读主台账）与 `await persist()`
（先写 IndexedDB、再写 localStorage）之间没有任何失效检查。这段时间里 `storage` 事件可能已经把
`invalidated` 翻成 true——它是**同步**翻的，不需要等锁——而 `reserve` 读回来的数据看起来仍然"正常"，
于是照样写盘并返回 `reserved`，等于授权一次新的恢复 POST。

修复：

- `reserve` / `release` / `reconcile` 在**每个 `await` 之后**重新检查 `invalidated`。
- `persist()` 改成三态 `ok | failed | invalidated`：写保护记录期间失效 → **主台账一个字节都不写**
  （否则等于把被删掉的台账重建成"只剩这次新记录"的假账），已落盘的保护记录**保守保留**。
- 新增 `store.verifyPending(target)` + `host.verifyPending`：Controller 在真正的 POST 之前再问一次
  "这次授权还成立吗"。判据是 `invalidated | corrupt | unavailable | initializing` + "记录仍在册"，
  **不含 `full`**——这次预留已经把第 64 格占住了，容量是"不能再新增"，不能反过来否掉已占的授权。

红测（修复前真实失败）：
- `99-26` 等 `guard.read` 期间收到外部删除 → 实际返回 `reserved` 且写了主台账；
- `99-27` 等 `guard.write` 期间失效 → 实际照样写主台账；
- `99-28` 保护记录已写、主台账未写时失效 → 实际继续写主台账；
- `96-59` 预留成功、发 POST 之前台账被删 → 实际 `applied`，POST 真的发出去了。

### A2 运行期读取失败的状态同步（`trash-ledger.ts`）

`syncFromLayers()` 读到保护记录 `unavailable` 时只 `return false`，没有更新 `readStatus`：
初始化成功、运行期才坏掉时，`status()` 仍是 `ok`，界面继续给出"可恢复"的按钮，而每次点都失败。
现在落到 `unavailable`，由外层的 `publish()` 把快照与闸门一起更新（红测 `99-30`）。

### A3 异步失效合并后的快照同步（`trash-ledger.ts`）

`persistInvalidation()` 在锁内把另一页面刚预留的记录合并进 `current`，但**没有 `publish()`**：
`records()` 已经是对的，`snapshot().records` 还是旧的，而界面读的是快照——于是"Store 正确、
界面少一条"。现在合并完成后在 `finally` 里发布一次（红测 `99-31`）。

### A4 测试真实性修正（`tests/suites/96`）

旧的"第 64 个位置"用例中途把身份切到另一个项目，实际验证的是**项目切换**，从未走到 POST。
保留它，并新增两条真正覆盖容量的用例：

- `96-57`：预填 63 → 恢复 → 第 64 格**允许**一次真实 POST（`applied`，`calls.restore === 1`）；
- `96-58`：预填 64 → 第 65 个操作被拒（`已满`）且零 POST。

这两条在修复前**就是绿的**（容量逻辑本身没错），它们是回归保护而不是红测——如实记录。

### 阶段 A 结果

| 套件 | 修复前 | 修复后 |
|---|---|---|
| 95 | 33/33 | 33/33 |
| 96 | 59 例中 1 红（`96-59`） | 59/59 |
| 97 | 14/14 | 14/14 |
| 98 | 23/23 | 23/23 |
| 99 | 31 例中 5 红（26/27/28/30/31） | 31/31 |

## 2. 阶段 B：真实端到端（184/184）

环境：真实 Host（5287）+ 真实 Vite Shell（5288）+ 真实 headless Chrome + 真实文件系统
（`weavespace-test/p203/{projA,projB}`，两个项目各自有真实 `rootToken`）+ 真实 localStorage /
IndexedDB / Web Locks。**正常回收与恢复不拦截任何 `/api/trash/*`**。

### B2 普通文件完整生命周期（6 个文件 × 16 项 = 96 项）

`note.md`（Markdown）、`plain.txt`（文本）、`blob.bin`（1024 字节二进制，含 `0x00`/`0xFF`）、
`中文名.txt`、`with space.txt`、`notes/deep.md`（子目录）。

每个文件都验证：右键「移入回收区」→ 取消时磁盘**零变化**（整棵树路径集合 + 内容哈希都比对）→
确认后原位置消失、文件树不再显示、Host 记录 `stored`、回收区数量与磁盘 `trash/<opId>` 目录数一致、
`payload` 与 `manifest.json` 都在、**payload 字节哈希 = 原始哈希** → 恢复后原位置回来、
哈希一致、Host 记录 `restored`、行变「已恢复」且不再提供恢复、台账不留待核对。

逐文件事实见 `filesystem-verification.json`（含每次操作前后的路径、存在性、SHA-256）。

### B3 恢复冲突与安全保护

| 项 | 结果 |
|---|---|
| 原位置已有同名文件 | 不覆盖（冲突文件哈希不变，Host 仍 `stored`，界面给出可读说明）；删掉冲突文件后可正常恢复 |
| 已有活动 View | 二段确认里 `blocked`：`无法操作「note.md」：仍在标签中打开…`，磁盘零变化 |
| 目录 | `400 ERR_TRASH_KIND_UNSUPPORTED`「只有普通文件可以移入回收区」 |
| 保留内部路径 `.weavespace/.gitignore` | `403 ERR_PATH_RESERVED`「属于工作台内部目录，不参与回收」 |
| 越界 `../projB/b-only.md` | `400 ERR_COMMAND_INVALID`「父目录含空段或相对段」 |
| 符号链接 | `400 ERR_TRASH_KIND_UNSUPPORTED`，链接目标未被移动 |
| 跨项目 | 用 B 的 projectId 移 A 的文件 → `404 ERR_RESOURCE_NOT_FOUND`；B 的回收区不含 A 的记录 |

> 这里踩过一次**假通过**：Node 侧直接 `fetch` 调写接口时没带 `Origin`，Host 回
> `403 ERR_PERMISSION_DENIED`（来源类拒绝）。旧断言只判"4xx 且非 APPLIED"，于是"目录被拒绝"
> 其实是"没有来源"通过的。现已给 `api()` 补上 `Origin`（取 Host 自身来源，落在白名单内），
> 并把断言加强为 **错误码不得是 `ERR_PERMISSION_DENIED`**。上表是加强后的真实错误码。

### B4 UNKNOWN 三场景（27 项）

| 场景 | 注入方式 | 磁盘事实 | 客户端 |
|---|---|---|---|
| 一 请求没到 Host | CDP Request 阶段 `failRequest` | 原位置仍空、payload 仍在、Host 仍 `stored` | 「待核对」、台账+保护记录各一条、强制点击零 POST、**重载后仍「待核对」** |
| 二 Host 已执行、响应丢失 | CDP **Response 阶段** `failRequest` | **原位置有文件、哈希一致**、Host 已 `restored` | 不误报失败：用 `GET /api/trash/op` 只读核对后收敛为「已恢复」，台账释放，**只发过 1 次 POST** |
| 三 Host 回 202 UNKNOWN | CDP 把回执换成 202 | 未动盘 | 「待核对」、台账保留；随后让 `GET /api/trash` 500（列表暂时刷不出来）→ 台账**不被清除**；列表恢复后仍「待核对」 |

场景二是本轮最值得记的一条：**响应丢失 ≠ 失败，也 ≠ 未确认**。控制器先按 UNKNOWN 处理，
再用 opId 去只读核对；Host 真的做完了，核对就会给出 `restored`，于是正常收敛。
这不违反"不自动重发"——全程只有一次 POST。

### B5 真实跨标签页（25 项）

- 同一记录在两个标签页**同时**点恢复 → 合计**只有 1 个** restore POST（CDP `Network` 观察，
  不拦截）。文件真的回到原位、哈希一致、两页台账都不再保留这条。
- 一页结清后另一页**刷新**收敛为「已恢复」，不退回"可恢复"。
- UNKNOWN（请求没到 Host）跨页面：B 通过 `storage` 事件同步到「待核对」，B 重载后仍是「待核对」，
  台账与保护记录都没丢。
- 满仓释放容量：用真实 Host 造 **64 条真实 stored 记录**（64 次真实磁盘移动），把两层台账写到 64，
  reload → 面板提示「已满」、**每一行都不能恢复**；让其中一条取得终态（一次真实 Host 恢复）
  再由成功列表对账 → 台账减到 63、提示消失、恢复按钮重新可用，并真的又恢复了一条。

### B6 退出与重启（18 项）

| 阶段 | 结果 |
|---|---|
| 回收后停 Host → 重启 | 记录仍在、状态 `stored`、恢复成功、哈希一致、转 `restored` |
| 恢复后停 Host → 重启 | 已恢复的记录仍「已恢复」且不可再恢复，文件哈希未变 |
| UNKNOWN 后停 Host → 重启 + 重开页面 | 仍「待核对」、台账仍在、Host 仍 `stored`、强制点击**零 POST**、无失效横幅 |

## 3. 变异测试（6/6 BITTEN）

| 编号 | 撤销的保护 | 结果 | 咬住的用例 |
|---|---|---|---|
| A | 异步读返回后不重新检查失效 | BITTEN | `99-26` |
| B | `persist` 忽略失效仍写主台账 | BITTEN | `99-27`、`99-28` |
| C | 运行期读失败不更新状态 | BITTEN | `99-30` |
| D | 失效合并后不发布快照 | BITTEN | `99-31` |
| E | `verifyPending` 把 `full` 当失效 | BITTEN | `96-47`、`96-57` |
| F | `verifyPending` 恒真 | BITTEN | `96-59` |

每次流程：写入变异 → 校验 SHA-256 变化 → 跑 95/96/98/99 → 记录失败用例 → 还原 →
校验 SHA-256 等于基线 → 再跑。明细 `mutations.json`（`baselineSha256` 是本轮源码的真实哈希）。

>C 第一次跑出的"BITTEN"其实是**语法错误**导致整份文件加载失败（所有套件都 `not ok 1`）。
> 那不是变异被测试咬住，是变异写坏了。已改成"保留 if 块、只删 `readStatus = 'unavailable'`"
> 后重跑，得到真正的断言失败（只有 `99-30` 红）。

## 4. 门禁（本轮实跑）

| 命令 | 结果 |
|---|---|
| `npm run test:p0` | **1236 例 / 1234 pass / 0 fail / 2 skip** |
| `npm run typecheck` | 通过 |
| `npm run typecheck:apps` | 通过 |
| `npm run build:shell` | 通过（`dist/assets/index-CgKldV7A.js 453.65 kB`） |
| `git diff --check` | 通过 |
| 真实浏览器 | **184/184**（B2/B3 114 + B4 27 + B5 25 + B6 18） |

日志：`gate-test-p0.txt`、`gate-checks.txt`。

## 5. 未解决风险与未验证事项（如实）

### 5.1 已确认有意的边界

1. **失效是终态**：保护记录落下 `invalidated` 后本版本**没有应用内修复入口**（任务书要求"刷新不得
   重新开放"）。只能等后续的核对/修复流程，或人工核对磁盘后处理。
2. **真正"没到达 Host"的 UNKNOWN 没有自动收敛路径**：Host 从未见过这个 opId，列表里也就不存在
   终态，记录会一直停在「待核对」（B4 场景一、B6 阶段三都是这个形态）。这是"宁可多拦"的方向，
   但意味着这类记录需要人工决策——契约文档 §10 已写明。
3. **满仓时 UI 全部关闭**：本版本没有永久删除/自动清理，容量只能靠"某条记录取得终态 + 一次成功
   列表读取"来释放。B5-3 的释放就依赖一次真实 Host 恢复（因为 UI 此刻按设计是关的）。
4. **用户清除"所有站点数据"** 会连 IndexedDB 保护记录一起清掉，本机制无法抵御，不做任何
   "可抵御"的声称。
5. **IndexedDB 被策略禁用 / 没有 Web Locks** → 整层 `unavailable`，恢复全关（有意 fail-closed）。
6. **Node 文件系统的 TOCTOU**：三处"核验 → 动作"窗口未消除（契约文档 §7 最后一行），
   本阶段未引入原生依赖。

### 5.2 未能覆盖 / 覆盖较弱的地方

- 浏览器侧只证到 UI 层：所有"绕过 UI 强制点击"都是把 `disabled` 改回 false 再点，
  控制器闸门本身由套件 96 直接驱动真实控制器证明。
- `dirty / SAVING / OUTCOME_UNKNOWN / CONFLICT` 这四类阻断只在套件 96/88 里覆盖，
  浏览器里只实测了「活动 View」一种（其余状态需要编辑器与保存链路配合，构造成本高）。
- Host 的 500 条容量上限与"淘汰终态记录"策略本轮没有在浏览器里压测（只压了客户端 64 条台账）。
- 两个标签页"对同一 opId 同时预留"的窗口靠 Web Locks 串行化，浏览器里实测的是"几乎同时点击"，
  不是纳秒级同刻；更严格的有序性由套件 98/99 的确定性用例兜底。

### 5.3 环境坑（会影响复跑，已写进脚本注释）

- `export TMP=TEMP=TMPDIR=x` 这种一行的写法在 Git Bash 里只会把值赋给 `TMPDIR`，
  `os.tmpdir()` 仍可能返回 8.3 短路径，导致一批套件假红。必须逐条导出。
- 页面里 `indexedDB.deleteDatabase()` 会因自身连接而一直挂起，之后所有 `open()` 排队 → 假的
  "initializing 卡死"。清场请用 CDP `Storage.clearDataForOrigin`，且**先导航到该 origin**。
- Host 的写接口要求 `Origin` 且必须落在白名单（缺省 `http://<Host host>` + 本机 5178 的 Vite）。
  测试脚本从 Node 直连 Host 时要用 Host 自身作为来源，否则拿到的是"来源不被允许"而不是业务错误。
- 测试 Workspace 的 `rootToken` 是 `dev:ino:birthtimeNs`：重建目录后必须重算，
  否则 Host 判 `ROOT_TOKEN_CHANGED`、项目变 `UNAVAILABLE`（`reset-fixture.mjs` 每次都重算）。
