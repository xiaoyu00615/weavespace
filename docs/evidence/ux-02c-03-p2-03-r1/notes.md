# UX-02C-03-P2-03-R1 · 真实发送边界与集成证据修正

> 基线：`7177070156ce24fbfb684c04db2ed097b3489e90`（分支 `wip/ux-02c-03-p2-02-trash-ui-20261126-r2`）
> 本轮分支：`wip/ux-02c-03-p2-03-r1-send-boundary-evidence-20261127`
> 本目录是本轮**实跑**的证据，不是历史结论的转抄。数字都来自下面这些脚本与原始 JSON。
> 未自行宣布验收：等 GPT 独立复审。

## 0. 怎么复跑

```bash
# 1) 停 Host → 重置专用测试 Workspace → 起 Host
node docs/evidence/ux-02c-03-p2-03-r1/reset-fixture.mjs
node apps/server/src/main.ts --workspace-store "D:/Workspace/projects/weavespace-test/p203/store" 5287

# 2) 起 Shell（代理到该 Host）
cd apps/shell && WS_API_TARGET=http://127.0.0.1:5287 npx vite --port 5288 --strictPort

# 3) 起一个干净的无头 Chrome
chrome --headless=new --remote-debugging-port=9337 --user-data-dir=D:/tmp/p203r1-profile about:blank

# 4) 六段验证（CDP_PORT 默认 9335，这里显式指定）
cd docs/evidence/ux-02c-03-p2-03-r1
CDP_PORT=9337 node verify-lifecycle.mjs       # B2/B3（含 R1-05 错误码锁定）
CDP_PORT=9337 node verify-unknown.mjs         # B4（含 R1-03 监听器生命周期）
CDP_PORT=9337 node verify-tabs.mjs            # B5（含 R1-04 满仓释放目标校验）
CDP_PORT=9337 node verify-send-boundary.mjs   # R1 新增：会话令牌在途
PHASE=1 CDP_PORT=9337 node verify-restart.mjs # 然后重启 Host
PHASE=2 CDP_PORT=9337 node verify-restart.mjs # 然后重启 Host
PHASE=3 CDP_PORT=9337 node verify-restart.mjs

# 5) 汇总
node assemble-evidence.mjs
```

**每个大段之间必须"停 Host → reset-fixture → 起 Host"**：`verify-lifecycle` 会把六个文件全部
恢复，`verify-unknown` / `verify-send-boundary` 会故意把文件留在回收区（那是断言的一部分），
`verify-tabs` 会往 `bulk/` 里塞 64 个文件。不重置就会出现"要删的文件已经不在磁盘上"的假失败。

脚本都以"检查结果"决定退出码（全通过 0，任一失败 1）。本轮六个脚本的退出码都是 0。

## 1. R1-01：把最终授权检查移到真正的 POST 边界

### 1.1 缺陷形状

`createTrashController` 在发 POST 前已经查过一轮（身份闸、本地阻断、`verifyPending`），
但 `restoreTrash()` **内部**还要先 `await sessionToken()`：

```ts
// 修复前：client-api.ts#postTrashAction
token = await sessionToken();     // ← 这里是一个可插入的窗口
response = await request(baseUrl, endpoint, { ... });   // 真正的 POST
```

这段窗口里用户切模式 / 切项目，或者另一个标签页 `removeItem` 台账，都不会被任何检查看到：
早先的检查那时已经通过，POST 照发。**磁盘本来不该动，却动了。**

### 1.2 修复

新增 `TrashSendGate`（`client-api.ts`）：一个**同步、无参、不返回 Promise** 的闭包，
由编排层提供、由传输层在令牌到手之后、`request()` 之前调用一次：

```ts
token = await sessionToken();
if (gate) {
  const decision = gate();          // ← 同步
  if (!decision.ok) return { status: 'NOT_SENT', ... };
}
response = await request(...);      // ← request() 第一句就是 fetch()
```

`request()` 的函数体在第一个 `await` 之前就会**同步调用** `fetch()`，所以
"gate() → request()" 是同一个不可分割的同步片段，中间没有任何 `await`。

判据（顺序即优先级，`trash.ts#finalSendDecision`）：

| # | 判据 | 结论 |
|---|---|---|
| 1 | 发起时的完整身份仍然有效（mode / workspaceMode / workspaceKey / epoch / activeProjectId） | `stale`（静默） |
| 2 | 项目仍然 READY | `blocked` + 文案 |
| 3 | 本地 blockers 仍为空 | `blocked` + 原始阻断码 |
| 4 | 这次预留的待核对记录仍在册，且台账不是 invalidated / corrupt / unavailable / initializing | `invalidated` |

**`full` 不参与判定**：第 64 格是合法授权，容量是"不能再新增"，不是"已占的不算"。

结算语义（`trash.ts` 新增 `NOT_SENT` 分支）：

| gate 结论 | 请求 | 待核对记录 | 返回值 |
|---|---|---|---|
| `stale` | 零 | 释放（零副作用） | `stale` |
| `blocked` | 零 | 释放 | `blocked` / `rejected` + 原因 |
| `invalidated` | 零 | **保守保留，不强行清除** | `rejected` + 原因 |

**早先的检查全部保留**（没有"用最终检查替代旧检查"）：快速失败仍然在预留之后立刻发生，
最终裁决是第二道门。套件 100 的"调用顺序"用例直接断言 `gate:verify` 出现**两次**。

### 1.3 红测（修复前真实失败）

把 `if (gate) {` 改成 `if (false && gate) {`（只摘掉最终裁决，其余一律不动），跑套件 100：

```
not ok 1 - R1-02A 会话令牌在途时切换项目：零恢复 POST，静默返回 stale
   真实恢复 POST 必须是 0（不是"按钮被禁用"）  1 !== 0
not ok 2 - R1-02A 会话令牌在途时换工作区（同项目 id、代次 +1）：零恢复 POST
not ok 3 - R1-02B 会话令牌在途时台账被外部删除：零恢复 POST，待核对记录保留
not ok 5 - R1-02C 调用顺序：令牌请求 → 最终裁决 → 真实 POST
ok     4 - R1-02C 身份不变、台账有效：恰好一次恢复 POST（控制组，本就不该红）
ok     6 - R1-02D 预留恰好占满第 64 格（控制组，本就不该红）
```

`1 !== 0` 就是缺陷本身：**一次真实的恢复 POST 发出去了**。还原后 6/6 全绿。

### 1.4 R1-02：真实发送链路测试（套件 100，6 例）

不是假端口：`createTrashController` + `createLiveClient` + 真实 `sessionToken()` await +
真实 `request()` → `fetch()`，只把 `globalThis.fetch` 换成一个**可放行**的桩。

| 用例 | 制造方式 | 断言 |
|---|---|---|
| R1-02A 切项目 | 令牌响应停在 deferred 上 → 改 `activeProjectId` → 放行 | POST 0、`stale`、台账释放、无提示 |
| R1-02A 换工作区 | 同上，只改 `workspaceKey` + `epoch`（**不动 mode**） | POST 0、`stale`、台账释放 |
| R1-02B 台账失效 | 令牌在途 → `removeItem` + 真实外部事件 | POST 0、`rejected`、**记录保留**、闸门文案存在 |
| R1-02C 控制组 | 身份不变、台账有效 | POST **恰好 1 次**，请求体只有 `{projectId, opId}` |
| R1-02C 顺序 | 同上，记录事件序 | `token:resolve → gate:verify → post:restore`（且 `gate:verify` 共 2 次） |
| R1-02D 第 64 格 | 预填 63 条 | POST **恰好 1 次**、台账 64 |

> 为什么"换工作区"用例必须**只**改 `workspaceKey`/`epoch`：`preflight` 不看这两维，
> 改 mode 会先被 `preflight` 挡下，那样测到的是 preflight 而不是最终裁决——变异 B 一开始
> 就是因此"没被咬住"，见 §5。

### 1.5 真实浏览器里的同一件事（`verify-send-boundary.mjs`，26 项）

用 CDP 把 `/api/session-token` 的**响应按住 1.8 秒**（只延迟，不改内容），在这段时间里换身份：

| 场景 | 窗口内做了什么 | 结果 |
|---|---|---|
| S1 | 点工具栏「演示」→ `aria-pressed` 变 true（mode + epoch 真的变了） | **restore POST = 0**；原位置仍空、payload 仍在、Host 仍 `stored`；切回真实模式后该行仍「可恢复」；台账已释放 |
| S2 | 另一个标签页 `localStorage.removeItem(台账)`（真实跨标签页 `storage` 事件） | **restore POST = 0**；磁盘未动；面板给出"被其他页面删除"的关闭原因；该行按钮关闭；**IndexedDB 保护记录仍保留这条**；持久层台账没有被重建 |

S1 的 opId `op-7c23a72c…`、S2 的 opId `op-75d7003c…`，两次都是 `posts: 0`、`tokenSeen: 1`
（即"令牌请求确实被按住过"）。断言的是**网络层没有那个 POST**，不是"按钮变灰"。

## 2. R1-03：CDP 监听器生命周期 + 202 场景加强

### 2.1 监听器

`connect().on()` 现在**返回注销函数**，并新增 `off()` / `listenerCount()` / `listenerMethods()`。
`interceptRestore()` 返回 `stop()`：先摘监听器、再 `Fetch.disable`（顺序固定，否则 disable
期间到达的事件没人处理）。

每个场景开始前断言 `listenerCount('Fetch.requestPaused') === 0`，收尾再断言一次——
本轮的 `B4-0` / `B4-9b` / `B4-12a` / `B4-21a` / `B4-32b` / `B4-34` 就是这六条。
旧版只 `Fetch.disable`、不摘监听器：场景一的 `failRequest` 会一直活着，与场景三的
`fulfillRequest` 抢同一个 `requestId`，谁先赢取决于事件顺序。

### 2.2 202 场景

| 断言 | 取值 |
|---|---|
| 实际 POST 请求体只含 `projectId` + `opId` | `{"projectId":"proj-a","opId":"op-1012ed88-2f90-457a-9ed5-6886167195ae"}` |
| 202 回执用**同一个** projectId / opId | 同上（脚本从 `postData` 解析后原样回写） |
| 客户端**实际收到**的状态码 | `202`（页面侧 `fetch` 包装记录的 `res.status`，不是凭界面文案猜） |
| 磁盘 | 原位置仍为空、payload 仍在回收区 |
| Host 侧 | 只读核对仍是 `stored`（恢复没有被执行） |
| 台账 / 保护记录 | 两层都保留这条 |
| POST 次数 | 全程 1 次；待核对期间强制点击仍是 1 次 |

> 这里踩过一个**自己的错误假设**：最初写成"Host 从未见过这个 opId（`outcome === 'none'`）"，
> 实际 `outcome` 是 `trashed`——`opId` 是**回收**时生成的，Host 当然认识它。真正要证明的是
> "恢复没有执行"，也就是 `state` 仍为 `stored`。已改成这条（`B4-29`）。

## 3. R1-04：满仓释放后的恢复验证

旧断言 `restoredCount >= 2` 是**假通过**：它把"上面那次由 Node 直接调接口做的恢复"数了进去，
界面上点的那次即使完全没成功也会通过。本轮先把这件事查实（第一次重跑 `B5-25b..e` 全红），
根因是**台账里 64 条正好全是这 64 个 bulk opId**，所以释放容量之后**没有任何一行真的能点**
（`exists` 不是授权）——旧结论"释放后又真的恢复了一条"其实从未发生。

修法：填台账时**故意留一条不在台账里**（第 64 格用一个属于 `proj-b` 的记录补位，
它不会被 proj-a 的对账碰掉），于是"哪一行能点"有唯一答案：

| 项 | 值 |
|---|---|
| 目标 opId | `op-bulk-00000000`（`bulk/bulk-00.txt`） |
| 恢复前 payload SHA-256 | `0e68640b51d00fb9ab2cc52fb1eb755437a84a1e44125601113c702ca81fce02` |
| 恢复前原位置 | 不存在 |
| 点击的那一行 | 必须是它（`B5-25a`：`recovered.name === 'bulk-00.txt'`） |
| Host 状态 | `restored` |
| 恢复后原位置 SHA-256 | `0e68640b51d00fb9ab2cc52fb1eb755437a84a1e44125601113c702ca81fce02`（逐字节相同） |
| 台账 | 63 条，且**不含**这个 opId |

## 4. R1-05：B3 具体错误码

| 场景 | 断言 | 实测 |
|---|---|---|
| 目录 `notes` | 400 + `ERR_TRASH_KIND_UNSUPPORTED` | 一致 |
| 保留路径 `.weavespace/.gitignore` | 403 + `ERR_PATH_RESERVED` | 一致 |
| 越界 `../projB/b-only.md` | 400 + `ERR_COMMAND_INVALID` | 一致 |
| 符号链接 `link-to-b.md` | 400 + `ERR_TRASH_KIND_UNSUPPORTED` | 一致（本轮环境允许建链接） |
| 跨项目（B 的 projectId 移 A 的文件） | 404 + `ERR_RESOURCE_NOT_FOUND` | 一致 |

每条都保留磁盘哨兵：目录里的文件没被移动、内部文件没被移动、B 的文件没被移动、
链接目标没被移动、链接本身还在、**回收目录数没有增加**。

## 5. 变异探针（5/5 BITTEN）

每次流程：写入变异 → 校验 SHA-256 变化 → 跑 96/99/100 → 记录失败用例 → 还原 →
校验 SHA-256 等于基线 → **再跑一次必须全绿**。明细见 `mutations.json`（含 `baselineSha256`）。

| 编号 | 撤销的保护 | 结果 | 咬住的用例 |
|---|---|---|---|
| A | 传输层不执行最终裁决 | BITTEN | 100-1、100-2、100-3、100-5 |
| B | 最终裁决不核对身份（去掉 `owned`） | BITTEN | 100-2（换工作区） |
| C | 最终裁决忽略台账裁决 | BITTEN | 100-3（台账失效） |
| D | 最终裁决把"容量已满"当失效 | BITTEN | 100-6（第 64 格） |
| E | Controller 把 `NOT_SENT` 当"已发出" | BITTEN | 100-1、100-2、100-3 |

两条如实记录的过程：

1. **B 第一次 NOT-BITTEN**：只摘 `owned` 时，切项目仍被 `preflight` 挡下（`activeProjectId`
   不一致），切 mode 也被 `preflight` 挡下——两道门互相兜底。改成"只换 workspaceKey/epoch"
   的用例后，`preflight` 看不见这两维，`owned` 才是唯一的一道，B 才咬得住。
   顺带发现测试夹具自身的一个假绿：`setIdentity` 原本用 `Object.assign` 就地改字段，
   编排器手里的"发起时快照"是同一个对象引用，`owned()` 永远为真。改成换新对象后，
   那条用例才是真的。
2. **E 第一次 NOT-BITTEN**：锚点 `if (outcome.status === 'NOT_SENT') {` 命中了 `remove()` 里
   同名分支（缩进 6 空格），并不是恢复路径（10 空格）。改成带缩进的锚点后咬住 3 条用例。

## 6. 全量门禁（本轮实跑）

| 命令 | 结果 |
|---|---|
| `npm run test:p0` | **1242 例 / 1240 pass / 0 fail / 2 skip**（较上一轮 +6，来自套件 100） |
| `npm run typecheck`（根 `tsc -p tsconfig.json`） | 通过 |
| `npm run typecheck:apps` | 通过 |
| `npm run build:shell` | 通过（`dist/assets/index-BCtgVDYf.js 454.60 kB`） |
| `git diff --check` | 通过（退出码 0；只有 CRLF/LF 归一化提示，不是空白错误） |
| 真实浏览器 | **238/238**（B2/B3 122 + B4 41 + B5 31 + R1 26 + B6 18） |

日志：`gate-test-p0.txt`、`gate-checks.txt`。

## 7. 改动文件

| 文件 | 为什么 |
|---|---|
| `apps/shell/src/client/client-api.ts` | `TrashSendGate` / `TrashSendDecision` / `NOT_SENT`；`postTrashAction` 在令牌后同步裁决；`restoreTrash(..., gate?)` |
| `apps/shell/src/state/trash.ts` | `finalSendDecision()`（同步闭包）；`NOT_SENT` 结算分支；`remove()` 对 `NOT_SENT` 的显式处理；`settle` 只接受"真的发出去过"的结论 |
| `apps/shell/src/state/DocumentActionsContext.tsx` | 透传 `gate`（两处签名 + 一处调用） |
| `apps/shell/src/state/TrashContext.tsx` | 透传 `gate` 到 `actions.restoreTrash` |
| `tests/suites/100-…send-boundary.test.ts` | 新增：真实 Controller + 真实 Client API + 可控 fetch 的 6 例 |
| `docs/27_UX-02C-03-P2_回收区契约.md` | 新增 §9.2.1（最终裁决位置/顺序/结算语义）+ §12 套件 100 |
| `docs/evidence/ux-02c-03-p2-03/{cdp,verify-unknown,verify-tabs,verify-lifecycle,verify-restart,verify-send-boundary}.mjs` | R1-03/04/05 要求的脚本修正（原地修，保证旧目录也可复跑） |
| `docs/evidence/ux-02c-03-p2-03-r1/**` | 本轮证据（脚本副本 + 原始 JSON + 汇总 + 截图 + 门禁日志） |

`apps/server/**`、`packages/storage/**`、磁盘事务、导航/菜单/CSS 一律未动。

## 8. 未解决风险（如实）

1. **gate 到 `fetch()` 是"同一同步片段"，不是"同一个系统调用"**：JS 是单线程，中间不可能插入
   用户事件，但浏览器仍可能在这条宏任务结束后、网络栈实际发出前丢包——那属于传输层失败，
   已被 UNKNOWN 路径覆盖，不属于"授权过期"。
2. **`invalidated` 仍是终态**：本版本没有应用内修复入口（与 P2-03 一致，没有扩大范围）。
3. **真正的 UNKNOWN（Host 从未见过该 opId）没有自动收敛路径**：记录会一直停在「待核对」，
   需要人工决策（`§10`）。
4. **保护记录损坏不自愈**：`corrupt` 只关不放。
5. **满仓释放依赖"某条取得终态 + 一次成功列表读取"**：本轮实测只有**不在台账里**的那一行
   能借这次释放被点（其余 63 行各自都是「待核对」）。这是设计使然，但意味着"满仓之后"
   仍然是一个需要逐条核对的局面，不是"腾出一格就恢复自由"。
6. **Node 文件系统的 TOCTOU** 未消除（未引入原生依赖）。
7. **浏览器只证到 UI 层**：R1 的两条浏览器用例证的是"网络层没有 POST"；控制器内部的分支
   由套件 100 直接驱动真实控制器 + 真实 Client API 证明。
8. `verify-send-boundary` 的 S2 用"另一个真实标签页 `removeItem`"制造跨标签页事件；
   若复跑时该标签页的 `storage` 事件送达延迟超过 400ms 窗口，`S2-4` 的前提断言会先红
   （而不是给出假绿）——本轮实测 1 次通过，未做重复压测。
