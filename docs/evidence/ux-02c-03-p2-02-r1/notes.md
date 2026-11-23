# UX-02C-03-P2-02-R1 · 回收区状态与身份隔离修复 —— 证据

- 分支：`wip/ux-02c-03-p2-02-trash-ui-20261123`（在 P2-02 上继续，不重写原提交）
- 审查基线 / 父提交：`537885c`（GPT 独立复审）
- 环境：Windows 11 / Node v22.22.2 / 真实 NTFS / 真实 Chrome 158（headless=new + CDP）
- 范围：只改 `apps/shell/**` 与 `tests/suites/95-97`；**未**改 `apps/server/**`、`packages/storage/**`、`.weavespace` 结构、事务状态机、文件身份与恢复安全规则

---

## 1. 结论摘要

| 项 | 结果 |
| --- | --- |
| `npm run test:p0` | **1141 例 / 1139 pass / 0 fail / 2 skip**（`gate-test-p0.txt`） |
| `typecheck` / `typecheck:apps` / `build:shell` | 通过（439.01 kB / gzip 133.05 kB，`gate-checks.txt`） |
| `git diff --check` | 通过（`gate-diff-check.txt`） |
| 套件 95 / 96 / 97 | 13→**17** / 23→**36** / 7→**12** 例，全绿 |
| 真实 Chrome（延迟窗口 + 并发） | **11/11** 断言，4 张截图（`browser-verification.json`） |
| 未解决问题 | 见 §8（两条口径说明，非缺陷） |

---

## 2. 逐项修复

### R1-01 恢复忙碌状态提前解除

**根因**：`settle()` 里 APPLIED 分支用 `void load()` 发了一次"射后不管"的刷新，`restore()` 的 `finally` 立刻派发 `TRASH_BUSY(null)`。列表还没回来，旧 `stored` 记录已经重新拿到「恢复」按钮。

**修复**（`state/trash.ts`）：
- `load()` 改为返回 `TrashLoadResult`（`applied(entries)` / `failed` / `stale`），并保留单飞：并发调用共享同一个在途请求。
- 新增 `freshLoad()`：**先等掉在途的那次读取，再发一次新的**。在途那次可能是在 POST 之前发出的，拿它当"操作后的事实"就是读写竞态。
- `settle()` 在 APPLIED / UNKNOWN 两条路径上都 `await freshLoad()`，只有 `confirmedByList()` 为真才解除在途：
  - 列表读取成功，且该 `opId` 已落到**终态**（`restored/aborted/conflicted/missing`）或已不在列表里；
  - 读取失败、或记录仍是 `stored/pending/restoring` → **保持禁用**。APPLIED 但没确认到时派发 `TRASH_UNCONFIRMED(pending=true)`，界面显示「待核对」而不是「恢复中」。
- UNKNOWN 只做一次只读核对（`queryTrashOp`），仍然绝不重发 POST。
- 文案：APPLIED 但列表没确认到 → `已把「x」恢复到原位置，但回收区列表没能刷新；记录暂不可再次操作…`（既不说"可以再试"，也不否认 Host 的 APPLIED）。

**测试**：96「列表确认之前不解除在途（延迟 GET）」「列表刷新失败 → 旧 stored 不得重新开放恢复」「列表仍是 stored → 继续保持禁用」；Chrome「延迟窗口内显示恢复中 / 按钮禁用 / 徽标不是已恢复」。

### R1-02 多 opId 在途状态

**根因**：控制器按 opId 分键单飞（不同文件互不阻塞），状态层却只有一个 `busyOpId`；A 完成会抹掉 B。

**修复**：
- `TrashProjectState.busyOpIds` + `unconfirmedOpIds`（都是数组，保持可序列化/值相等）。
- 动作改为 `TRASH_BUSY {opId, busy}` / `TRASH_UNCONFIRMED {opId, pending}`，`toggleId()` 只增删一个 id；重复派发返回同一个 `state`。
- 列表刷新（`TRASH_LOADED` / `TRASH_LOAD_ERROR` / `TRASH_LOAD_BEGIN`）**一律不动**这两个集合；只有 `TRASH_BUSY(false)` 结束这一条。
- `TRASH_LOADED` 会收敛 `unconfirmedOpIds`：记录已到终态或已不在列表 → 清除（这是一次成功的列表读取给出的可靠结论）。
- 面板按行判断 `busy` / `unconfirmed`，不再有"项目级忙碌"。

**没有**改成全局单飞——并发契约保持不变。

**测试**：96「并发恢复：A 完成只解除 A，B 保持；刷新也不清 B」走完整序列 A→B→完成 A→刷新→完成 B，每一步用真实 reducer 折算成面板行；Chrome「两个 opId 可以同时在途」（两个 `恢复中…` 禁用按钮同时存在，第三行已恢复）。

### R1-03 APPLIED 响应结构异常不得报告 REJECTED

**根因**：`postTrashAction()` 在 `200 + APPLIED` 但 `entry` 缺失/非法时落到 REJECTED，用户会以为"什么都没发生"再点一次。

**修复**（`client/client-api.ts`）：
- `body.status === 'APPLIED'`：只有 `200` 且 `parseTrashEntry` 成功才算 APPLIED；否则 **UNKNOWN**，保留 `opId`、保留 `httpStatus`。
- 失败分支按 Host 契约分级：
  - 4xx（400/403/404/409/422）与 501 → 明确 REJECTED（这些只出现在动盘之前）；
  - 503 且 `errorCode` ∈ `ERR_PROJECT_UNAVAILABLE / ERR_ROOT_CHANGED / ERR_ROOT_IDENTITY_UNSUPPORTED / ERR_STORE_RESTRICTED` → REJECTED（前置拒绝）；
  - **其余 5xx / 读不懂的响应 → UNKNOWN**（可能发生在"正文已移动、状态没提交"之后，不能当零副作用）。
- 编排层对 UNKNOWN 只 `queryTrashOp` 一次，不重发 POST。

**测试**：97「APPLIED 但没有 entry → UNKNOWN」「APPLIED 但 entry 非法 → UNKNOWN」「500 → UNKNOWN；409 → REJECTED」「503 项目不可用 → REJECTED（不进入未确认）」+「编排：客户端给出 UNKNOWN 时只核对一次、绝不重发」（断言 POST=1、query=1）。

### R1-04 所有响应分支执行归属检查

**根因**：`settle()` 只在 APPLIED / UNKNOWN 里查 `stillOwned()`，REJECTED 直接提示——切走项目后旧项目的错误会弹到新项目上。

**修复**：`settle()` 第一行就核对归属（`mode` / `workspaceMode` / `workspaceKey` / `epoch` / `activeProjectId` 五维），任何一维不符直接 `stale`：不提示、不刷新旧项目目录、不写桶。

**测试**：96「切走项目后收到 REJECTED → stale」「恢复：切走项目后收到 REJECTED → stale」「切模式后 APPLIED → stale」「换 workspaceKey 后 APPLIED → stale」。

### R1-05 副作用请求发送前检查项目身份

**修复**：
- `TrashHost.preflight(projectId)`（`TrashContext` 实现）：`live` + `multi` + `activeProjectId === projectId` + 项目存在且 `READY`；归属不符 → `stale`，项目不可用 → `blocked` + 文案。`remove()` / `restore()` 都先过这道闸，**零 POST**。
- 恢复不再只看 `entry.state`：额外检查 `host.supported(projectId)`。
- 二段确认把"打开那一刻"的 `workspaceKey` / `epoch` 记进对话框；确认时用纯函数 `dialogBelongsTo()` 复核 `workspaceKey` / `epoch` / `activeProjectId`，不符 → 静默关闭、零请求。

**测试**：96「回收：项目已切走 → 零 POST、零刷新」「项目不可用 → 明确阻断，零 POST」「恢复：切走项目 → 零 POST」「恢复：项目不可用 → 零 POST」「确认框：切项目/换工作区/换代次 → 不属于当前界面」「归属不符时确认 = 零 POST、零磁盘修改」。
Chrome 侧没有构造"切换后确认"，因为那需要真实添加第二个项目；该路径由上述确定性用例覆盖（如实说明）。

### R1-06 工作区身份变化后的缓存隔离

**修复**：
- reducer：`SET_WORKSPACE_KEY`（键真的变了）与 `SET_MODE` 都清空 `trashByProject`；同一个 key 重复派发返回原 state（不闪空）。
- 自动加载：新增纯函数 `trashLoadKey({mode, workspaceMode, workspaceKey, projectId})`，把"该不该读、读哪个工作区的哪个项目"压成一个字符串，`useEffect` 只依赖它。换工作区（即使项目 id 相同）必然重新读取，也不会再出现"漏加依赖"。
- 读取失败时桶里没有旧工作区的数据（已被清空），面板显示 `error` 而不是旧列表。

**测试**：95「自动加载键：换工作区（同项目 id）必然重新读取」「reducer：换工作区 / 切模式都丢弃旧回收区缓存」「换工作区后读取失败显示错误，不回填旧工作区数据」；96「工作区身份变了（同项目 id）→ stale，不落地」。

---

## 3. 修改文件清单

| 文件 | 改动 |
| --- | --- |
| `apps/shell/src/state/types.ts` | `TRASH_TERMINAL_STATES`；`busyOpIds` / `unconfirmedOpIds`；`TRASH_BUSY{opId,busy}` / `TRASH_UNCONFIRMED` |
| `apps/shell/src/state/workspace-reducer.ts` | `toggleId()`；两个集合只改一条；`TRASH_LOADED` 收敛待核对；`SET_WORKSPACE_KEY` / `SET_MODE` 清缓存 |
| `apps/shell/src/state/trash.ts` | `TrashIdentity.workspaceMode`；`TrashPreflight`；`TrashLoadResult`；`trashLoadKey()`；`freshLoad()`；`settle()` 三分支归属 + 确认后才解除；`confirmedByList()`；行视图 `unconfirmed` |
| `apps/shell/src/state/TrashContext.tsx` | `preflight`；确认框记录并复核归属；自动加载改用 `trashLoadKey` |
| `apps/shell/src/state/trash-dialog.ts` | 对话框携带 `workspaceKey` / `epoch`；纯函数 `dialogBelongsTo()` |
| `apps/shell/src/client/client-api.ts` | APPLIED 不可验证 → UNKNOWN；4xx/501/前置 503 vs 其余 5xx 的分级 |
| `apps/shell/src/components/TrashPanel.tsx` | 「待核对」独立分支；恢复入口再挡一层 |
| `tests/suites/95-97` | 见 §4 |

未改 `apps/shell/src/components/GlobalNav.tsx`、`ShellLayout.tsx`、`App.tsx`、`TreeCommandsContext.tsx`、`shell.css`：本轮不动视觉与导航结构。

---

## 4. 新增 / 修改测试

| 套件 | 例数 | 本轮新增覆盖 |
| --- | --- | --- |
| 95（纯逻辑） | 13 → **17** | 待核对行视图；刷新不解除在途 + 只动一个 opId；待核对只由终态列表收敛；换工作区/切模式丢缓存；读失败不回填；自动加载键 |
| 96（编排 + 确认框） | 23 → **36** | 延迟 GET 期间禁用；GET 失败不重开；APPLIED 但列表仍 stored；A/B 并发逐步；stale REJECTED ×2；零 POST 前置检查 ×4；workspaceKey 变化；对话框归属 ×2 |
| 97（真实 Host + 客户端收敛） | 7 → **12** | APPLIED 缺 entry / entry 非法；UNKNOWN 只核对一次且不重发（POST=1、query=1）；500 → UNKNOWN；409 / 503 仍是 REJECTED |

全部使用**真实控制器 + 确定性 deferred**；stale 由"中途改变身份快照"驱动，不是让假端口直接返回 `stale`。

---

## 5. 门禁

```
npm run test:p0       1141 例 / 1139 pass / 0 fail / 2 skip
npm run typecheck     pass
npm run typecheck:apps pass
npm run build:shell   pass（439.01 kB / gzip 133.05 kB）
git diff --check      pass
```

> 说明：任务书写的是 `pnpm ...`，本仓库的脚本入口是 npm（`package.json` 只提供 `npm run *`，没有 pnpm-lock），因此按仓库实际入口执行，命令与之等价。

---

## 6. 真实 Chrome 冒烟（11/11）

用 CDP `Fetch` 域在**网络层**制造延迟（不改应用代码）：

| 截图 | 场景 | 断言 |
| --- | --- | --- |
| `10-restore-inflight.png` | POST 已返回 APPLIED，列表 GET 被推迟 2s | 该行徽标「恢复中」、按钮「恢复中…」禁用、无「已恢复」文案 |
| `11-restore-confirmed.png` | 延迟结束、列表给出 restored | 徽标「已恢复」、无恢复按钮、磁盘字节回到 `# A\n` |
| `12-two-inflight.png` | 两次恢复 POST 各延迟 1.2s，先后点击两行 | 两行**同时**「恢复中」+ 禁用（R1-02） |
| `13-two-confirmed.png` | 两条都完成 | 都「已恢复」、无按钮、两个文件字节都回到原值 |

项目在 `D:/Workspace/projects/weavespace-test/p202-ui-smoke`（真实磁盘、真实 Host 托管存储），未触碰任何用户文件。

---

## 7. 禁止项自查

| 禁止项 | 结果 |
| --- | --- |
| 改 `apps/server/**` / `packages/storage/**` | 未改（`git diff --stat` 可核） |
| 改事务状态机 / `.weavespace` / 身份与恢复安全规则 | 未改 |
| 新增永久删除 / 目录递归 / 自动清理 / 批量 | 未新增，也无对应入口 |
| 改视觉设计与导航结构 | 未改（本轮 0 行 CSS / 0 行 Nav） |
| 覆盖 `package-lock.json` 噪声 | 未暂存（仍是既有的 s9a→s9b 两行差异） |

---

## 8. 尚未解决的问题（如实记录）

1. **UNKNOWN 后的"待核对"可能保持到应用重启**：如果 Host 的列表一直显示 `stored`（既不是终态，也不是"记录消失"），该记录会一直禁用。这是安全优先的取舍——`stored` 不足以证明"恢复没有发生"，放开就可能重复恢复。可行的收敛路径是 Host 侧对账给出终态，或用户重开应用（内存标记不持久化）。本轮没有为此新增接口或自动重试。
2. **"切项目后点确认"只有确定性用例覆盖**，没有在真实浏览器里复现：需要第二个真实项目（要么走本机目录选择器，要么改 store 配置并重启 Host）。该路径的核心判定已抽成纯函数并有 4 条断言，控制器的"发送前闸"另有 4 条零 POST 断言。
3. 未对 `TRASH_LOADED` 收敛待核对之外的其它边界（例如记录在两次刷新之间被 Host 淘汰）单独造用例；这些分支由"记录不存在即收敛"的同一段代码覆盖，但没有独立断言。
