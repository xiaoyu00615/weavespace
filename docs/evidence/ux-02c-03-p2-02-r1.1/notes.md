# UX-02C-03-P2-02-R1.1 · 跨工作区读取隔离与 UNKNOWN 持久保护 —— 证据

- 分支：`wip/ux-02c-03-p2-02-trash-ui-20261123`（继续开发，未重写历史）
- 基线 / 父提交：`75e677057d735b79f634b8c5afd2076f507d9664`
- 环境：Windows 11 / Node v22.22.2 / 真实 NTFS / 真实 Chrome 158（headless=new + CDP）
- 范围：只改 `apps/shell/**` 与 `tests/suites/95-97`；未改 `apps/server/**`、`packages/storage/**`、事务状态机、身份核验、Provider 的移动/恢复实现

---

## 1. 结论摘要

| 项 | 结果 |
| --- | --- |
| `npm run test:p0` | **1151 例 / 1149 pass / 0 fail / 2 skip**（`gate-test-p0.txt`） |
| `typecheck` / `typecheck:apps` / `build:shell` | 通过（443.10 kB / gzip 134.50 kB，`gate-checks.txt`） |
| `git diff --check` | 通过 |
| 套件 95 / 96 / 97 | 17→**23** / 36→**40** / 12（不变），全绿 |
| 真实 Chrome | **15/15** 断言（两阶段：两个 Host 存储），4 张截图 |
| 未解决 | 见 §7（台账损坏后的恢复手段只有"清理站点数据"，没有应用内提供） |

---

## 2. R1.1-01 跨工作区的读取 / 操作隔离

**根因**：`inflightLoad` / `loadSeq` 只按 `projectId` 索引。换工作区后 `workspaceKey`、`epoch` 变了，但同一个 `projectId` 仍会命中上一个工作区的在途 Promise：B 的读取被 A 的请求"顶替"，A 的结果回来又因 `owned()` 被判 stale——B 永远读不到，界面停在旧数据或加载中。副作用操作同理（B 可能拿到 A 的结论）。

**修复**（`state/trash.ts`）：
- 新增 `identityKeyOf(snapshot)`：`mode \0 workspaceMode \0 workspaceKey \0 epoch`。
- `loadKey = identityKeyOf + \0 + projectId`；`inflightLoad`、`loadSeq` 全部按 `loadKey` 索引。
- `load()` 每次用当前身份组键；`freshLoad()` 只 `await` **同身份**的在途请求，再发新的（不再空等别的工作区）。
- 结果落地前仍走 `loadSeq` 序号 + `owned()` 五维核对：旧工作区的迟到响应只会是 `stale`，不写任何桶。
- 操作键同样加身份前缀：`${identityKeyOf}\0${projectId}\0${path}`、`restore\0${identityKeyOf}\0${projectId}\0${opId}`。同一工作区仍单飞，跨工作区彻底隔离。
- reducer：`SET_WORKSPACE_MODE` 现在也清空 `trashByProject`（此前只清了 `SET_WORKSPACE_KEY` / `SET_MODE`）。

**测试**：
- 96「换工作区后各发一次，旧响应不写新桶」（2 次 GET，A 的迟到响应 stale，只有 B 的 `TRASH_LOADED` 落地且内容是 b.md）
- 96「A 未结束时在 B 用同 projectId/path 发起 → 两个请求，互不复用」（2 次 POST；A stale 不提示，B 才宣布成功）
- 96「同一 opId 跨工作区也不得复用 Promise」（2 次 POST）
- 95「切换工作区模式同样丢弃回收区缓存」

---

## 3. R1.1-02 UNKNOWN 待核对的跨重启保护

**根因**：`unconfirmedOpIds` 只在内存。重启后 Host 对账未完成、列表仍返回 `stored`，界面会重新给出「恢复」——而那次恢复可能已经动过盘。

### 3.1 存储格式（独立于 `PersistedUi`）

存储键：`ws:trash-pending:v1`（与 `ws:workspace:v1:*` 分开，互不影响解析/清理）

```json
{
  "version": 1,
  "records": [
    {
      "workspaceKey": "2b4fb470…a48982",
      "projectId": "proj-a",
      "opId": "op-d77017b6-e088-4c18-a33b-208961fb1731",
      "createdAt": "2026-11-23T18:21:16.464Z"
    }
  ]
}
```

- 只有这四个字段：**不存**正文、绝对路径、`rootToken`、`dev:ino`、错误文案。
- 校验：版本必须为 1；`workspaceKey` 为 16–128 位小写十六进制；`projectId` 匹配 Host 的项目 id 规则；`opId` 匹配 Host 的目录名规则；`createdAt` 可解析；条数 ≤ 64；原文 ≤ 16 KiB。
- **一条非法即整份 `corrupt`**：静默丢掉"看不懂的那条"等于把它重新开放。
- 读取结果三种：`ok(records)` / `corrupt` / `unavailable`（无存储或 `getItem` 抛异常）。

### 3.2 启动恢复（无"先可点、后禁用"窗口）

`localStorage` 是同步 API，因此在 `TrashProvider` 的**第一次渲染**里就完成读取：

```
const ledgerRead = useMemo(() => readTrashLedger(storage));   // 同步
const [ledger] = useState(() => ledgerRead.status === 'ok' ? ledgerRead.records : []);
const pendingFromLedger = pendingIdsOf(ledger, workspaceKey, projectId);
trashPanelView({ ..., extraUnconfirmed: pendingFromLedger });
```

面板第一次算出来的行就已经带着「待核对」；不存在"先渲染可恢复按钮、下一帧才补状态"的一帧。

### 3.3 清除规则（与任务书逐条对应）

| Host 列表结论 | 台账 |
| --- | --- |
| `restored` / `aborted` / `conflicted` / `missing` | 解除 |
| 成功读取后记录不存在 | 解除 |
| `stored` / `pending` / `restoring` | **保留** |
| GET 失败（`loaded=false` 或 `errorCode!=null`） | **保留** |
| 应用重启 / 组件卸载 / 内存清理 | **绝不解除**（只在成功的列表读取里收敛） |

实现：`reconcileTrashPending(records, {workspaceKey, projectId, entries, loaded})`，由 Provider 在 `loaded && !loading && errorCode === null` 时调用；收敛结果同步落盘。

### 3.4 工作区隔离

`pendingIdsOf` 与 `reconcileTrashPending` 都只处理 `workspaceKey + projectId` 命中的记录；A 的待核对不影响 B，切回 A 时 A 的记录仍在（重启后也一样，走的是同一份 storage）。

### 3.5 持久化异常（fail-closed）

| 情况 | 行为 |
| --- | --- |
| 读取 `corrupt` / `unavailable` | **关闭全部恢复**：`TrashHost.restoreGate()` 返回说明，控制器在一切判断之前直接拒绝（零 GET/POST）；面板顶部红色说明 + 每行禁用并给出"暂时不能恢复" |
| 写入失败（配额/隐私模式） | 记录仍在内存（本次会话内继续禁用），面板给黄色提示"重开后可能失去保护"；不假装已持久化 |
| 没有 `workspaceKey` 时收到 UNKNOWN | 如实标记写入失败（保护降级），不伪造归属 |

`restoreGate()` 是真正的门：按钮禁用只是表象，控制器里它先于 `entry.state` 判断。

---

## 4. 新增 / 修改测试

| 套件 | 例数 | 本轮新增 |
| --- | --- | --- |
| 95 | 17 → **23** | 台账结构校验（缺省/损坏/版本/单条非法/超量/存储异常）；按工作区分区与去重/上限/写入失败；清除规则全表；"重启后仅凭台账仍禁用"；台账不可用 → 全部关闭；`SET_WORKSPACE_MODE` 清缓存 |
| 96 | 36 → **40** | 换工作区各发一次且旧响应不落地；同 projectId/path 跨工作区各发一次；同 opId 跨工作区各发一次；`restoreGate` 先于 `entry.state` 且零请求 |
| 97 | 12（不变） | 上一轮的客户端收敛用例继续覆盖 POST 不重发 |

所有异步时序用 `deferred`，没有随机延时。

---

## 5. 门禁

```
npm run test:p0       1151 例 / 1149 pass / 0 fail / 2 skip
npm run typecheck     pass
npm run typecheck:apps pass
npm run build:shell   pass（443.10 kB / gzip 134.50 kB）
git diff --check      pass
```

---

## 6. 真实 Chrome（15/15，两阶段）

因为要换工作区，验证分成两个阶段（同一个 Vite/Chrome，只换 Host 的存储目录）：

**阶段 A（store-a）**：切到真实模式 → 回收 a.md → 回收区 1 条「可恢复」；台账为空。

**阶段 B（store-b，同 projectId、不同根目录 → workspaceKey 改变）**

| 截图 | 场景 | 断言 |
| --- | --- | --- |
| `20-cross-workspace-loading.png` | 首次 `/api/trash` 读取被 CDP 延迟 2.6s | 窗口内**没有任何行**、面板只有"正在读取回收区…"，不出现 A 的 a.md；确认发起了新的读取 |
| （同上之后） | 读取完成 | B 的回收区为空，不是 A 的记录 |
| `21-unknown-pending.png` | 用 `Fetch.fulfillRequest` 构造 202 UNKNOWN | 行变「待核对」+ 按钮禁用；`ws:trash-pending:v1` 出现 1 条记录，字段为当前 workspaceKey/projectId/opId/createdAt |
| `22-after-reload-pending.png` | **页面重新加载**（内存全丢） | 仍然是「待核对」+ 禁用，台账记录仍在 |
| `23-terminal-cleared.png` | 让 Host 真正恢复到 `restored`，点刷新 | 行变「已恢复」、无按钮；台账变为 `{"version":1,"records":[]}` |

真实恢复用页面内 `fetch('/api/trash/restore')` 完成（此前那次 UNKNOWN 是构造的，Host 从未收到请求，文件没动过）。

---

## 7. 尚未解决（如实记录）

1. **台账损坏后没有应用内的修复入口**：现在会如实关闭全部恢复并提示"清除本应用的数据"。没有提供"核对后清空台账"的按钮——那需要一个新的确认流程，超出本轮范围，也未与 Host 的对账结论联动。
2. **`unavailable`（完全没有 localStorage）时恢复长期关闭**：这是 fail-closed 的直接后果；隐私模式下该功能不可用，但不会静默放开。
3. **Provider 的"首帧即带台账"只有浏览器证据**：`node:test` 不加载 React，因此"第一帧"由 Chrome 重载截图证明；纯函数层的等价断言（fresh state + extraUnconfirmed）在套件 95。
4. 浏览器阶段 B 的"换工作区"是通过**换 Host 存储 + 重新加载页面**实现的；"不重载、仅靠 health 轮询发现换区"的路径由套件 96 的控制器用例覆盖。
