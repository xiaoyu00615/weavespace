# ADR-023 G-DISK / G-DRAFT 分离与项目移除状态机

- **ADR-ID**：ADR-023
- **状态**：PROPOSED（待用户正式批准）
- **日期**：2026-11-14
- **修订**：R2（2026-11-14）——移除门禁由"会话数为零"改为按 **View 生命周期**判定（`activeViews === 0` + 无危险会话 + 无在途 G-DISK，干净历史会话不阻止移除）；测试拆为 A 类（正常移除）与 B 类（异常失效）；修正 G-DRAFT 的路径表述（保留项目内相对 `path`，不泄露绝对根与令牌）。
- **修订**：R3（2026-11-14）——同步 ADR-022 安全勘误：新增 `REVOKE_UNKNOWN` 状态（墓碑写入结果不确定时该项目立即拒盘）；`RECOVERY_RESTRICTED` 明确为"G-DISK 全拒 + 禁止变更"，不再是"只读"。
- **基线**：`c3666b57f7ac50b5b70a2157ff885d6bf9c25792`
- **关联**：ADR-021（授权来源）、ADR-022（事务与持久化）
- **替代关系**：**落实**（非放宽）`docs/20 PR-26`「STALE 下合法 view 仍能取回正文」；局部细化 `docs/20 §5.5` 的草稿门禁描述。原文不改写。

---

## 1. 背景（事实）

| # | 事实 | 依据 |
|---|---|---|
| F1 | `GET /api/document`（读草稿正文）当前先做 `requireView` 再 `authorizeRead(sessionId)`，后者用 `permission.authorize(read, identity.path, providerId)` | `server.ts:729-741, 578-586` |
| F2 | `POST /api/close` 同样先做 `permission.authorize(read, …)`，未保存则 409 拒绝关闭 | `server.ts:974-1003` |
| F3 | `GET /api/document/disk` 在 `authorizeRead` 之后还要过 `assertSessionDiskUsable` | `server.ts:702-717` |
| F4 | `markProjectStale()` 只给会话打 `stale` 标记，**保留正文与 revision** | `document-service.ts:740-756` |
| F5 | `POST /api/edit`、`/api/save`、`/api/open`、`/api/reload` 经 CommandBus，受 `resolveProject → assertUsable` 门禁 | `server.ts:433-440` |
| F6 | `closeView()` 只从 `views` 表删除并 `session.views.delete(viewId)`，**Session 仍留在 `sessions` 表**；只有 `views.size <= 1 && dirty` 时拒绝关闭 | `document-service.ts:415-437, 212-214` |
| F7 | `GET /api/document` 的 `documentDto` 返回**项目内相对** `path`（`normalizeProjectPath` 拒绝绝对路径与越界），不返回 `rootDir`/`canonicalRoot`/`rootToken` | `server.ts:454-479, 741` |

**F1/F2 是本次裁决指出的真实缺陷**：一旦移除项目时撤销 grant，合法用户既读不回自己的草稿，也关不掉视图——草稿变成"只能随进程退出而消失"的孤儿。

## 2. 决策一：两道门，互不替代

| 门 | 判定依据 | 覆盖端点 | 移除后 |
|---|---|---|---|
| **G-DISK** | 项目存在于 Registry 且 `READY` + 根令牌未变 + `permission.authorize(action, identity.path, 'local:<pid>')` | `/api/resources`、`/api/open`、`/api/edit`、`/api/save`、`/api/reload`、`/api/document/disk` | **一律拒绝** |
| **G-DRAFT** | 会话存在 + `viewId` 属于当前 `actorId` + `sessionId/viewId` 绑定一致（**不查项目、不查磁盘权限**） | `GET /api/document`、`POST /api/close` | **仍允许**：读回内存草稿、关闭视图（**仅 B 类异常失效路径**，见 §5/§8.2） |

补充规则：

- **移除时立即撤销 read/write grant**（`permission.revoke` ×2）。**不允许**以"会话尚未回收"为由保留磁盘权限。
- `GET /api/document` 只返回**已在 Host 内存中**的正文；它不触碰磁盘，因此不构成新的文件访问授权。
- `POST /api/close` 的拒绝条件只剩"未保存修改"（`ERR_DOCUMENT_DIRTY`），不再因项目被移除而 403。
- **G-DRAFT 的信息边界（精确表述）**：不得返回或新增暴露 `rootDir` / `canonicalRoot` / `rootToken` / `providerId`。响应中的 `path` 是**项目内相对路径**（`normalizeProjectPath` 已拒绝绝对路径与越界，F7），属既有 `DocumentDto` 字段（Shell 用它标识文档），**不构成绝对路径泄露**，也无需在 G-DRAFT 中删除。ADR-022 §3.2 的"不泄露路径"仅指绝对根与令牌。
- G-DRAFT 不产生审计日志中的路径字段（日志只记 `sessionId` 的哈希前缀与 `projectId`）。
- 若 `viewId` 缺失或不属于该 actor → 403（沿用 `requireView`）；`GET /api/document` 在 multi 下仍要求 `viewId`。
- **范围限定**：正常移除要求 `activeViews === 0`（§3.2），因此正确执行的移除**不会留下活动 View**，G-DRAFT 在 A 类路径上没有服务对象。它存在是为了 B 类异常失效（`UNAVAILABLE`、崩溃残留，见 §5）。**不得**用"反正 G-DRAFT 能读"来放宽移除门禁。

## 3. 决策二：项目移除状态机

状态（拥有者 = `ProjectRuntime`，ADR-022 §2）：

```text
        ┌──────── abort（零变更，唯一可回滚点）────────┐
        │                                             │
   ACTIVE ──begin quiesce──▶ QUIESCING ──复检通过──▶ REVOKING
      │                          │                      │
      │                          │                      │ 墓碑 fsync 成功
      │                          │                      │ = 撤销生效（不可回滚）
      │                          │                      ▼
      │                          │                  REVOKED（内存已撤销）
      │                          │                      ├─ 配置写成功 ──▶ REMOVED
      │                          │                      └─ 配置写失败 ──▶ REVOKED_PENDING_CONFIG
      │                          │                                        （+ DEGRADED）
      │                          └─ 超时/复检不通过 → abort → ACTIVE
      │
      └──inspect 失败──▶ UNAVAILABLE（不可自动恢复；rebind 为 A2）

  任意状态 ──提交后编程异常──▶ DEGRADED（变更 503，重启自愈）
  REVOKING ──墓碑结果不确定──▶ REVOKE_UNKNOWN（该项目 G-DISK 403，核对证据后收敛）
  加载异常（校验失败 / 备份回退 / 日志缺失或链断）──▶ RECOVERY_RESTRICTED
                                                      （禁止一切变更；撤销集合可证 → 允许读写，
                                                        不可证 → G-DISK 全拒，仅 G-DRAFT）
```

**关键分界**：`QUIESCING` 之前任何失败都**零变更**；墓碑 fsync 成功之后**不存在回滚**——移除一旦生效，只能用"重新添加"恢复（新 `projectId`，见 ADR-022 §3 的 id 不复用规则），不允许把 `REVOKED` 改回 `ACTIVE`。

### 3.1 Session 与 View 的生命周期（先定义实体，再谈门禁）

`closeView()`（F6）只从 `views` 表删除记录并把 viewId 从 `session.views` 摘掉，**Session 本身留在 `sessions` 表**。因此移除门禁不能以"会话数为零"为准，必须区分三类实体：

| 实体 | 判据（Host 内存，`document-service.ts`） | 对移除的意义 |
|---|---|---|
| **活动 View** | `viewId ∈ views` 且 `session.views.has(viewId)` | 唯一代表"用户仍开着这个文件的标签/窗格"；非零即拒绝 |
| **危险会话** | 无 View 也可能存在：`dirty === true`，或 `state ∈ {SAVING, OUTCOME_UNKNOWN, CONFLICT, FAILED}` | 代表"可能有未落地的字节"；非零即拒绝 |
| **干净历史会话** | 无 View、`!dirty`、`state === 'CLEAN'`、`baseVersion` 与磁盘版本已对齐 | **不阻止移除**；移除后转为 detached（无 View，因此 G-DRAFT 也读不到），随进程退出释放 |

`CONFLICT` / `FAILED` 必须算危险：它们表示上一次落盘没有干净结论，缓冲仍可能与磁盘分叉，不能因为"不是 dirty"就放行。

### 3.2 移除的权威前置条件（Host 判定，Shell 计数仅 UX）

```text
allowed =
     activeViews(projectId) === 0        // 无任何活动 View（替代旧的 openSessions===0）
  && dirtySessions(projectId) === 0      // dirty 会话
  && savingSessions(projectId) === 0     // state === 'SAVING'
  && unknownSessions(projectId) === 0    // state === 'OUTCOME_UNKNOWN'
  && conflictedSessions(projectId) === 0 // state ∈ {CONFLICT, FAILED}
  && activeDiskOps(projectId) === 0      // 屏障 drain 后 G-DISK 在途操作归零
```

Host 的统计口径（**全部取自 Host 自身状态，不读 Shell 上报**）：

| 谓词 | 数据来源 | 说明 |
|---|---|---|
| `activeViews` | `document` 服务内部的 `views: Map<viewId, sessionId>` 反向过滤 `session.projectId` | 与 `GET /api/close` 用的是同一张表，无第二套口径 |
| `dirty` / `state` | 每个 `Session` 的 `dirty` 与 `state` 字段（六态） | `stale` 标记与六态正交，**不影响**这里的判定 |
| `activeDiskOps` | `ProjectRuntime.quiesce[pid].activeOps`（每个通过 G-DISK 的操作 +1/−1） | 屏障自己记账，drain 到 0 才算通过 |
| `openSessions` | **不再作为门禁** | 仅供诊断日志 |

Shell 的 `removal-precheck` 上报（`openTabs / dirtyTabs / savingTabs / conflictedTabs / unknownTabs`）**只用于提前给出可读提示**，Host 不采信其数值做放行判断；二者不一致时以 Host 为准。

> 为什么不再要求"会话数为零"：那会让一个曾经关闭过标签的干净会话**永久**阻止移除，而它既不持有 View 也没有未落地字节。真正的风险来自"还有人在编辑"和"还有字节没落地"，这两点已由 `activeViews` + 危险状态 + `activeDiskOps` 覆盖。
>
> 为什么仍然不采信 Shell 的 dirtyCount：Shell 的 `edit-queue` 是批量提交，Host 的 `dirty` 会滞后于浏览器缓冲。`activeViews === 0` 保证"浏览器侧已无输入通道"，`activeDiskOps === 0` 覆盖"已在途的 `/api/edit`"，两者叠加才构成服务端可自证的条件。

### 3.3 移除后会话的绑定禁令

移除（`REVOKED` 起）之后，遗留会话进入 `STALE(PROJECT_REMOVED)`，并被**冻结绑定**：

| 禁令 | 实现约束 |
|---|---|
| 不得重新绑定到新项目 | `Session.projectId` 在 `markProjectStale` 后不可改写；`openSession` 命中既有 sessionId 时若 `projectId` 与请求不一致 → 直接拒绝，不"迁移" |
| 不得重新绑定到新 Provider | `Session.providerScope`（创建时固定的 Provider 身份）继续参与校验；Provider 表已删除该 `local:<pid>`，任何需要 Provider 的路径都会失败 |
| 不得复用 `projectId` | 由 ADR-022 §3 的 `issuedIds` 保证：即使重新添加同一目录，也签发**新** id，因此不可能"碰巧命中"旧会话 |
| 不得复活 | 移除后 `entries` 已删除；`resolveProject` 先查表再查会话，故 G-DISK 一律 404，不会因会话残留而"看起来项目还在" |

这四条使得"历史 Session 残留"只影响内存占用，不构成任何权限或身份上的复用面。

### 3.4 移除动作序列（含不可回滚点）

```text
1. mutationLock 获取（失败 → 409 ERR_PROJECT_BUSY）
2. begin quiesce（G-DISK 全线 409 ERR_PROJECT_QUIESCING）
3. drain activeOps（≤2s）
4. Host 权威复检（§3.2）——不通过 → abort（回 ACTIVE，零变更，草稿保留）
   ───────────── 以上均可回滚；以下不可回滚 ─────────────
5. PERSIST-REVOKE：向 revocations.jsonl 追加墓碑 + fsync
   ★ 墓碑落盘成功 = 撤销生效（point of no return）
6. COMMIT（同步、无 await）：立即切断访问权
     entries.delete(pid)
     permission.revoke(read/write, local:<pid>)   ← 立即撤销，无保留期
     providers.delete(providerId)
     document.markProjectStale(pid, 'PROJECT_REMOVED')
     commitSeq++ / workspaceKey 失效
7. PERSIST-CONFIG：按 ADR-022 §3.1 写配置（移除条目）
     成功 → REMOVED
     失败 → REVOKED_PENDING_CONFIG + DEGRADED（项目已不可访问，重启自愈）
8. 释放屏障，清 mutationLock
9. 通知 Shell（`SET_PROJECTS`）+ 响应携带 `outcome` 与 `opId`
```

注意 5 与 6 的顺序：**墓碑先落盘，权限先切断，配置最后写**。这样"配置写失败"的最坏结果是"磁盘上还留着一个已撤销条目"，而不会出现"磁盘已删、内存仍授权"。§3.2 的准入判定保证进入第 5 步时已无任何活动 View 或危险会话，因此第 6 步不会打断任何进行中的编辑。

撤销生效后：

- 该项目的 G-DISK 全部 404 `ERR_PROJECT_NOT_FOUND`（`entries` 已删除）；
- 若存在**异常路径遗留**的 STALE 会话（见 §5 B 类），正文 + revision + viewId 保留，仅供 G-DRAFT 读取；
- 视图关闭（`POST /api/close`）→ 会话从内存移除，草稿随之消失（**明确的数据边界**，见 §5）；
- 会话绑定被冻结（§3.3），不复用、不迁移、不复活；
- **磁盘零操作**：移除链路不得 `import` 任何删除/移动 API（架构测试断言 D-A-10）。

### 3.5 重命名

`ACTIVE → ACTIVE'`：只改 `name`；`projectId`、`rootDir`、`canonicalRoot`、`rootToken` 与 `workspaceKey` 全部不变；`commitSeq++`。不需要 quiesce（不触碰 Provider 与会话）。空名 / 超长 / 控制字符 → 400。

## 4. 每个请求的准入表

| 端点 | 门 | QUIESCING 期间 | 移除后 |
|---|---|---|---|
| `GET /api/health` | 无 | 200 | 200（key 已变） |
| `GET /api/projects` | 无 | 200 | 200（不含该项目） |
| `GET /api/resources` | G-DISK | 409 | 404 |
| `GET /api/document/disk` | G-DISK | 409 | 拒绝（grant 已撤销 → 403；项目已移除 → 404，取决于先命中的门） |
| `GET /api/document` | **G-DRAFT** | 200 | **200** |
| `POST /api/open` | G-DISK | 409 | 404 |
| `POST /api/edit` | G-DISK | 409 | 404 |
| `POST /api/save` | G-DISK | 409 | 404 |
| `POST /api/reload` | G-DISK（+ 显式 `discardDraft`） | 409 | 404 |
| `POST /api/close` | **G-DRAFT** | 200 | 200 |
| `POST /api/projects/*` | T1/T2（ADR-021） | 409 | 见 ADR-022 |
| `GET /api/projects/op?opId=` | T1（只读） | 200 | 200（查最终结果，ADR-022 §7） |

## 5. 草稿的保留与丢失边界（必须写进用户可见文案）

移除分两类场景，**不得混为一谈**：

### A 类：正常移除（门禁通过）

前置条件 §3.2 已保证 `activeViews === 0` 且无危险会话，因此**正常移除成功后不存在活动 View**。此时：

| 场景 | 结果 |
|---|---|
| 移除被拒绝（仍有 View / dirty / SAVING / UNKNOWN / CONFLICT / FAILED） | 草稿、revision、会话、Provider **全部原样**；用户可继续编辑/保存 |
| 移除成功 | 该项目已无活动 View，故无"移除后还能读草稿"的正常路径；可能残留的只有**干净历史会话**（无 View、`CLEAN`、不 dirty），它们不持有任何未落地字节 |
| 用户先关闭标签再移除 | Shell 关闭标签时必须先保存或明确放弃草稿；若放弃，那是用户已在关闭动作里确认的丢弃，与移除无关 |

### B 类：项目异常失效（存在合法 STALE View）

只可能来自崩溃恢复、根被移动/替换（`UNAVAILABLE`）、或历史遗留的失效项目。此时 G-DRAFT 的价值才体现：

| 场景 | 结果 |
|---|---|
| 项目 `UNAVAILABLE`（根被移动/删除/令牌变化），仍开着标签 | G-DISK 拒绝；`GET /api/document` 仍 200 返回内存正文；`POST /api/close` 非 dirty 可关、dirty 按 `ERR_DOCUMENT_DIRTY` 拒绝 |
| `PROJECT_REMOVED` 且存在遗留 STALE View（异常路径） | 同上；正文可导出直到视图关闭或 Host 退出 |
| Host 进程退出 | 内存草稿消失；**唯一兜底是 Shell 的 `ws:draft-backup:<pid>:<path>` 本地备份**，与 Host 无关 |

> B 类是**容错**，不是正常流程：不允许为了让 B 类测试通过，而让 A 类移除绕过 `activeViews === 0` 门禁。

因此 UI 的移除对话框必须显示：**"移除只从工作台移除该项目，不会删除磁盘文件。请先保存或关闭该项目下所有文件。"**（若仍有活动标签，对话框不给出可点击的"移除"按钮，只显示阻塞原因。）

## 6. 恢复策略（禁止改写 `workspaceKey`）

- `workspaceKey` 是**身份**，不是可迁移的标签：它由"项目集合 + 每个根的令牌"派生（`server.ts` `computeWorkspaceKey`）。**任何情况下都不得**为了恢复旧标签而把快照里的 key 改写成新值——那等于绕过身份不匹配门禁。
- 首版（保守）：

```text
snapshot.workspaceKey === host.workspaceKey
  ├─ 相等 → 逐标签复核后恢复（沿用现有 restore 流程）
  └─ 不等 → 只恢复 UI（分屏比例、展开状态、活动项目若仍存在）
            标签一律不自动认领，明示："工作区已变更（新增/移除项目），本次未恢复标签"
```

- 目标态（02B-05 之后）才引入"逐标签重新验证"：

```text
对每个待恢复标签：
  1. snapshot 记录该标签所属 projectId 与当时的 rootToken
  2. 当前 Runtime 中该 projectId 仍 READY，且 rootToken 与快照一致
  3. 文件仍存在，且 contentVersion === baseVersion（未被外部修改）
  4. 三者全过 → 认领；任一不过 → 记为"未恢复（原因）"，不阻塞其他标签
```

- **任何写入"新身份快照"的标签，都必须走上面 1–4 的复核**；不允许"因为用户刚加了项目，就把旧标签整体搬进新快照"。
- 快照 v2 因此需要新增 `projects: [{projectId, rootToken}]`（只记录摘要与令牌，不记录路径）。

## 7. 失败、取消、崩溃的恢复规则

| 事件 | 恢复 |
|---|---|
| quiesce 超时 / 复检不通过 | abort → ACTIVE；返回 409 + 阻塞原因；草稿、grant、Provider 全不动 |
| 移除中用户又发 open/edit | 409 `ERR_PROJECT_QUIESCING`；Shell 按普通失败提示，不重试循环 |
| 墓碑写入**确认失败**（打开失败 / 0 字节错误） | **尚未生效**，零变更，返回 5xx `ERR_PERSIST_FAILED`；可安全重试 |
| 墓碑写入**结果不确定**（`fsync` 报错 / 部分写入 / 中途被杀） | 不能断言"零变更"：该项目进入 `REVOKE_UNKNOWN`（G-DISK 一律 403 `ERR_PROJECT_REVOKE_UNKNOWN`），随后核对日志尾部；命中本次 `opId` → 按已撤销继续；确认无本次行 → 回 ACTIVE；无法判定 → `RECOVERY_RESTRICTED`（ADR-022 §3.1.1） |
| 墓碑成功、配置写失败 | `REVOKED_PENDING_CONFIG` + `DEGRADED`：项目立即不可访问（第 6 步已生效），返回 5xx 且响应体标 `outcome: 'revoked'` 与 `opId`；重启后按墓碑补齐为 `REMOVED` |
| 客户端超时 / 不知道结果 | `GET /api/projects/op?opId=` 查最终结果，判定来源为**磁盘**（墓碑是否含该 id），不是内存 |
| 移除中进程崩溃（C3a / C3b / C4） | 见 ADR-022 §5：墓碑胜出，重启后不复活；C3b 的配置滞后按"已知滞后"补齐 |
| 移除成功后 Shell 仍持有旧标签 | 下一次 G-DISK 调用 404；Shell 将标签标记为 `stale`，**仅在异常路径下**才有 View 可导出（§5 B 类） |
| 根被移动/替换 | UNAVAILABLE；G-DISK 拒绝、G-DRAFT 仍可读；不自动 adopt |
| 恢复时 key 不匹配 | 只恢复 UI，不认领标签（§6） |

## 8. 必须通过的安全测试

### 8.1 A 类：正常移除（前置 `activeViews === 0`，无危险会话）

| ID | 用例 | 断言 |
|---|---|---|
| D-A-01 | 正常移除成功 | `/api/projects` 不含该项目；`entries`、Provider、grant 全部消失；**磁盘文件字节不变** |
| D-A-02 | 移除后 `GET /api/resources` / `/api/document/disk` / `/api/save` | 404 / 拒绝 / 404 |
| D-A-03 | 移除后 `grantsOf(actor)` | 不含 `local:<pid>` 的 read/write |
| D-A-04 | **存在无 View 的干净历史会话时移除** | 允许移除（这是本 ADR 修订的核心回归：会话残留不阻止移除） |
| D-A-05 | 存在活动 View 时移除 | 409 且带 `blockedBy: 'ACTIVE_VIEWS'`；项目状态、View、正文全部不变 |
| D-A-06 | `SAVING` / `OUTCOME_UNKNOWN` / `CONFLICT` / `FAILED` 任一存在时移除 | 409，逐个状态各一例；零变更 |
| D-A-07 | `dirty`（无 View）时移除 | 409；正文、revision、grant、Provider 全不变 |
| D-A-08 | 移除后重启 | 项目不在列表；墓碑生效；干净历史会话随进程退出消失（本就不含未落地字节） |
| D-A-09 | 移除后重新添加同一目录 | 签发**新** `projectId`；旧 `projectId` 不复用；旧 sessionId 无法被新项目 `open` 命中 |
| D-A-10 | 移除链路静态检查 | 相关模块无 `fs.rm*` / `unlink` / `rename` 引用 |

### 8.2 B 类：项目异常失效（存在合法 STALE View，容错路径）

> 用于验证 `UNAVAILABLE` / 崩溃残留场景的草稿可救回，**不得**用它反推"正常移除可以带活动 View"。

| ID | 用例 | 断言 |
|---|---|---|
| D-B-01 | 项目 `UNAVAILABLE`（根被移动）后 `GET /api/document` | 200，正文与失效前一致；响应不含 `rootDir`/`canonicalRoot`/`rootToken` |
| D-B-02 | 同上，`POST /api/close`（**非 dirty**） | 200；视图消失，会话保留（F6 语义不变） |
| D-B-03 | 同上，`POST /api/close`（**dirty**） | 409 `ERR_DOCUMENT_DIRTY`——仓库无 `discard` 契约，不得静默丢草稿 |
| D-B-04 | 同上，`GET /api/resources` / `/api/save` | 拒绝（G-DISK 不放行） |
| D-B-05 | 他 actor 用猜到的 `viewId` 读草稿 | 403（G-DRAFT 仍绑定 actor + session + view） |
| D-B-06 | 项目 `UNAVAILABLE` 后重启 | 会话消失（内存态）；项目仍不可用；不自动 adopt、不改写配置 |

### 8.3 通用

| ID | 用例 | 断言 |
|---|---|---|
| D-C-01 | quiesce 期间 open/edit/save | 409 `ERR_PROJECT_QUIESCING`，且未产生任何磁盘写入 |
| D-C-02 | quiesce 期间 close/document | 200（G-DRAFT 不被屏障阻塞） |
| D-C-03 | key 变化后启动 | 不恢复标签、只恢复 UI，且快照 key 未被改写 |
| D-C-04 | 静态 Multi / Legacy | 上述变更行为不适用（端点 501）；既有套件全绿 |

## 9. 本轮不实现（边界）

- 不做 rebind（根变化只能重启 + 手工重加）。
- 不做"移除后自动导出草稿"的批处理（只提供 G-DRAFT 读取 + UI 手动导出）。
- 不做会话回收（A2），STALE 会话保留至视图关闭或进程退出。
- 不做逐标签恢复（§6 目标态），首版是 UI-only。
- 不修改任何既有文件读写、草稿与保存流程；G-DISK 的判定内容与现状一致，只是把 G-DRAFT 从它里面**拆出来**。

## 10. 待用户批准点

1. 移除后**立即**撤销 read/write grant（放弃"会话回收后再生效"的方案）。
2. 移除门禁改为 `activeViews === 0` + 无危险会话 + `activeDiskOps === 0`；**干净历史会话不再阻止移除**（取代早前"会话数为零"的保守表述）。
3. 墓碑 fsync 为**不可回滚点**；`abort` 只能在 `QUIESCING` 阶段发生，移除生效后不可撤回。
4. 首版恢复策略：项目集合变化 → 只恢复 UI，不认领标签（不做 key 改写）。
5. 接受 G-DRAFT 以 `actor + session + view` 作为唯一凭据（落实 PR-26），且不返回绝对根与令牌（项目内相对 `path` 保留）。
