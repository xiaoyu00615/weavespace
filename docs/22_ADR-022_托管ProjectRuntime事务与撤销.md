# ADR-022 托管 ProjectRuntime：唯一协调器、事务与撤销

- **ADR-ID**：ADR-022
- **状态**：PROPOSED（待用户正式批准）
- **日期**：2026-11-14
- **修订**：R2（2026-11-14）——明确**撤销生效点**（墓碑 `fsync`）并把移除事务拆为 `PERSIST-REVOKE` / `COMMIT` / `PERSIST-CONFIG`；删除"移除失败即完全回滚"的错误表述；区分**首次初始化**与**日志意外缺失**；补 `opId` 结果查询。添加与移除的提交点因此不同（§4.0）。
- **基线**：`c3666b57f7ac50b5b70a2157ff885d6bf9c25792`
- **关联**：ADR-021（授权来源）、ADR-023（G-DISK / G-DRAFT 与移除状态机）
- **替代关系**：无。**新增**托管模式；不修改 Legacy 与静态 Multi 的任何既有语义。

---

## 1. 背景与目标

运行期增删项目需要同时更新**四类状态**：Registry 条目、Provider 表、Permission grants、workspaceKey。当前四者都在 `createShellServer()` 内一次性闭包算出（`server.ts:415-440`），因此不存在"运行期变更"的合法入口，也不存在并发或崩溃的定义。

本 ADR 定义唯一协调器与其事务语义，目标是：**任何时刻，内存状态都只能是磁盘权威状态的一个前缀，且不存在第二套 Registry。**

## 2. 所有权（谁拥有什么）

| 对象 | 拥有者 | 说明 |
|---|---|---|
| 项目状态机（ACTIVE / QUIESCING / REMOVED / UNAVAILABLE …） | `ProjectRuntime`（**唯一**） | 托管模式下 `ProjectRegistry` 只由 Runtime 内部持有；禁止再调用 `createProjectRegistry()` 产生第二份表 |
| Provider 表 | `ProjectRuntime.providers` | 由 Registry handle 派生，客户端不可指定 |
| Permission grants | `ProjectRuntime.permissions` | 与 providerId `local:<pid>` 一一对应 |
| `workspaceKey` | `ProjectRuntime`（**按请求求值**，不再是启动闭包） | 项目集合或根令牌变化后立即变化 |
| 变更互斥锁 | `ProjectRuntime.mutationLock` | 单飞：同一时刻只有一个变更事务 |
| 项目级 QUIESCING 屏障 | `ProjectRuntime.quiesce[projectId]` | 见 §6，与 ADR-023 共用 |
| 进程级单实例锁 | Host 启动时（`workspace.lock` 文件） | 防两个 Host 写同一配置 |
| 磁盘配置 | `ProjectStore`（Runtime 独占写入） | 唯一持久权威 |
| 会话编辑队列 / 保存锁 | Shell 的 `edit-queue` / `DocumentService` | Runtime **不**越过它们直接改文档 |

静态 Multi 模式：`ProjectRegistry`（不可变，`version()===1`）仍是唯一权威，Runtime 不参与。
Legacy 模式：单 Provider，Runtime 不存在。

## 3. 持久化模型（配置 v2）

路径：`--workspace-store <dir>` 指定的目录（默认建议 `%APPDATA%/weavespace/`，但**必须显式传参**，不静默启用）。

```jsonc
{
  "version": 2,
  "commitSeq": 17,                       // 单调递增；每次成功变更 +1
  "issuedIds": ["notes", "design", "project-3"],   // 只增不减，永不复用
  "revoked": [{ "projectId": "design", "revokedAtSeq": 16 }],
  "projects": [
    {
      "projectId": "notes",
      "name": "个人笔记",
      "rootDir": "C:/Users/me/notes",
      "canonicalRoot": "C:\\Users\\me\\notes",
      "rootToken": "<dev:ino>",
      "grantedAt": "2026-11-14T06:00:00.000Z",
      "grantSource": "os-dialog"
    }
  ],
  "checksum": "sha256(canonical payload without this field)"
}
```

规则：

- `version: 1` 只读兼容：内存迁移为 v2；**只有发生变更时才写回 v2**。
- `revoked` 是**墓碑**，永久保留；`issuedIds` 保证 `projectId` **不复用**（即使项目已撤销、即使名称相同）。
- `checksum` 用于识别截断/半写。
- `commitSeq` 与墓碑的关系有两种合法形态：
  - `commitSeq >= 全部 revokedAtSeq`：正常（配置已包含该次撤销）。
  - `墓碑 max(seq) === commitSeq + 1`：**已知滞后**——上一次移除的墓碑已落盘、配置未落盘（§3.1 step 3 失败）。这是 `REVOKED_PENDING_CONFIG` 的持久化形态，加载时按墓碑删除该条目，并在下一次成功写入时补齐；**不进入 `RECOVERY_RESTRICTED`**。
  - 其他差值（缺口 > 1、或缺失多条撤销）：无法解释为单次滞后 → 按日志链断裂处理（§3.2）。

### 3.1 写入顺序与**撤销生效点**（不可调换）

配置写入拆成两个独立持久化步骤，**中间夹着不可回滚点**。下面的 `step` 编号即 §4.2 表格中移除事务的阶段 2→4：

```text
step 1  PERSIST-REVOKE（仅移除）
        append 一行到 revocations.jsonl → fsync
        ★ fsync 返回成功 = 撤销生效（point of no return）
step 2  COMMIT（同步、无 await）：立即切断运行期访问权
        entries.delete + revoke grants + providers.delete + markProjectStale
        + commitSeq++ + workspaceKey 失效
step 3  PERSIST-CONFIG：写 workspace.json.tmp.<pid> → fsync → 备份 .bak → rename
step 4  PUBLISH / NOTIFY
```

**为什么墓碑先行**：备份（`.bak`）可能比主文件旧，若只依赖主文件里的 `revoked`，回退到旧备份就会**复活已撤销的授权**。墓碑日志独立且 append-only，加载时**墓碑优先于任何来源**。

**为什么生效点定在 step 1 而不是 step 3**：一旦墓碑可被任何一次重启读到，撤销事实上已经发生。若此时仍宣称"配置没写成 = 什么都没发生"，就会得到两种互相矛盾的真相——重启后项目消失，但本次响应说"失败、未变更"。因此本 ADR 明确规定：

| 时刻 | 状态 | 能否回滚 |
|---|---|---|
| step 1 之前（含 quiesce 失败） | 未发生任何持久化 | **能**：abort → ACTIVE，零变更 |
| step 1 fsync 返回 `ENOSPC`/`EIO` | 无墓碑 | **能**：返回 5xx `ERR_PERSIST_FAILED`，零变更 |
| step 1 fsync 成功 | 撤销已生效 | **不能**。即使 step 3 失败，项目也不可再访问 |
| step 3 失败 | `REVOKED_PENDING_CONFIG` | 不回滚；重启按墓碑补齐为 `REMOVED` |

墓碑行的格式（链式校验，防截断与乱序）：

```jsonc
{ "seq": 16, "projectId": "design", "at": "2026-11-14T06:12:00.000Z",
  "prevHash": "<上一行的 hash 或 GENESIS>", "hash": "sha256(seq|projectId|at|prevHash)" }
```

`seq` 必须严格递增；`hash` 链断裂即视为日志不可信（§3.2）。

### 3.2 加载与备份可信性（fail-closed）

```text
读 workspace.json
  ├─ 校验通过（schema + checksum + commitSeq 单调）→ 主文件有效
  └─ 失败 → 读 workspace.json.bak
        ├─ 通过 → 主文件损坏，进入 RECOVERY_RESTRICTED
        └─ 也失败 → RECOVERY_RESTRICTED + 空项目表（不提供任何磁盘访问）
读 revocations.jsonl
  ├─ 存在且 hash 链完整 → 撤销权威
  ├─ 存在但链断裂 / 不可解析 → 只信任断裂点之前的完整前缀，其后记为 UNKNOWN
  └─ 不存在 → 见下表（必须区分首次初始化与日志丢失）
撤销集合 = 日志前缀 ∪ config.revoked[]，取并集后从项目表移除
应用 issuedIds：即使项目被移除，其 id 也不再签发
```

**日志缺失必须分两种情况，不能一律当"从未撤销"**：

| 情形 | 判定依据 | 结果 |
|---|---|---|
| **首次初始化** | `workspace.json` 不存在 **且** 日志不存在 | 空表，允许变更，正常启动（写第一份配置时同时创建日志头） |
| **托管冷启动（含 v1 迁移）** | 配置存在，但 `commitSeq === 0` **且** `revoked` 为空 | 视为"尚未发生任何变更事务"，撤销集合必为空，故日志缺失无信息损失 → 正常启动并立即创建日志头；允许变更 |
| **日志意外缺失（轻度）** | 日志缺失，但主文件有效且 `checksum` 通过，且 `commitSeq > 0` 或 `revoked` 非空 | `RECOVERY_RESTRICTED`：按 `config.revoked[]` 应用撤销（**不复活**），项目可读写，**全部变更端点 503**；日志需由维护动作重建后才能再次变更 |
| **日志意外缺失（重度）** | 日志缺失，且当前配置来自 `.bak` 回退 | `RECOVERY_RESTRICTED` **且全部项目置 UNAVAILABLE（G-DISK 拒绝）**：无法证明这份备份不早于任何一次撤销，故一份磁盘权限都不给；G-DRAFT 仍可读内存草稿 |
| **日志链断裂** | `seq` 不连续 / `prevHash` 不匹配 / 行不可解析 | 断裂点之前有效；之后视为 UNKNOWN → 按上面"重度"处理（宁可少给权限） |

区分"没有撤销历史"与"撤销历史可能丢了"的唯一依据是 `commitSeq`/`revoked`：**只要配置声称发生过任何变更事务（`commitSeq > 0`）或存在撤销条目，而日志却不见了，就必须走受限分支。** 允许 `commitSeq === 0` 走正常分支的前提是：能改写配置并重算 `checksum` 的攻击者已具备本机文件系统写权限，属于 ADR-021 §5 明确排除的威胁模型。

- **备份不得自动恢复已撤销授权**：墓碑与 `revoked[]` 的并集压倒一切；`RECOVERY_RESTRICTED` 下所有变更端点 503。
- **无权限恢复时不自动重新授权**：加载时对每个条目重新 `inspectProjectRoot`；`rootToken`/`canonicalRoot` 与配置不一致 → `UNAVAILABLE(CANONICAL_CHANGED|ROOT_TOKEN_CHANGED)`，**不 adopt、不改写配置**；只有用户显式 `rebind`（A2）才能换根。
- **配置不确定时一律 fail-closed**：宁可少一个项目，不多给一份权限；`RECOVERY_RESTRICTED` 不允许任何"自动修复"写入。

## 4. 变更事务（唯一顺序）

### 4.0 两种操作的提交点不同（刻意如此）

| 操作 | 提交点（point of no return） | 方向 | 理由 |
|---|---|---|---|
| 添加 | `rename` 成功（配置已含新条目） | **多给**一份权限 | 必须先有持久证据再让内存生效；写盘失败即零变更 |
| 移除 | 墓碑 `fsync` 成功（§3.1 step 1） | **收回**一份权限 | 必须先切断访问权再补记配置；配置写失败仍安全（宁可配置多留一条已撤销条目） |
| 重命名 | `rename` 成功 | 仅改显示名 | 不涉及权限方向，按添加处理 |

### 4.1 添加

| # | 阶段 | 内容 | 可失败？ | 失败后果 |
|---|---|---|---|---|
| 1 | VALIDATE | inspect、重复/嵌套、id 签发、grant 入参预校验 | 是（4xx） | 零副作用 |
| 2 | STAGE | `createLocalProvider()` 构造实例，**不放入** provider 表 | 是（422） | 丢弃实例，零副作用 |
| 3 | **PERSIST-CONFIG** | tmp → fsync → 备份 → rename（**提交点**） | 是（5xx） | 磁盘未变，内存未改，**完全回滚** |
| 4 | COMMIT | 同步、无 `await`：`entries.set` + `grant ×2` + `commitSeq=新值` + 失效 key 缓存 | 理论不可失败 | 见 §4.4 |
| 5 | PUBLISH | provider 入表（同一同步块） | 否 | — |
| 6 | NOTIFY | 响应 `{outcome:'created'}` + `SET_PROJECTS` | 是 | 不影响一致性 |

### 4.2 移除

| # | 阶段 | 内容 | 可失败？ | 失败后果 |
|---|---|---|---|---|
| 1 | VALIDATE + QUIESCE | 取 `mutationLock`、建屏障、drain、Host 复检（ADR-023 §3.2） | 是（409） | **零变更**，回 ACTIVE |
| 2 | **PERSIST-REVOKE** | 追加墓碑 + `fsync`（**提交点**） | 是（5xx） | 无墓碑，**零变更**，可安全重试 |
| 3 | COMMIT | 同步、无 `await`：`entries.delete` + `revoke ×2` + `providers.delete` + `markProjectStale` + `commitSeq++` + 失效 key | 理论不可失败 | 访问权已切断，见 §4.4 |
| 4 | PERSIST-CONFIG | 写配置（移除条目） | 是（5xx） | `REVOKED_PENDING_CONFIG` + `DEGRADED`；**不回滚**，重启补齐 |
| 5 | PUBLISH / NOTIFY | 释放屏障、响应 `{outcome:'revoked', opId}` | 是 | 不影响一致性 |

**关键点**：§4.2 的 3 与 4 之间，撤销**已经生效**。因此不能再用"PERSIST 失败 → 完全回滚"的表述描述移除；移除只有在第 2 步之前才可回滚。

### 4.3 重命名

`VALIDATE → PERSIST-CONFIG（提交点）→ COMMIT（改 name）→ NOTIFY`。失败回滚；不需要 quiesce。

### 4.4 持久化成功但内存提交失败

| 情形 | 磁盘 | 内存 | 处理 |
|---|---|---|---|
| 添加：配置已有条目、内存无 | 新 | 旧 | `DEGRADED`；重启后该条目正常加载（用户看到项目出现，符合预期）；不重复登记 |
| 移除：墓碑已有、配置未更新、内存已删 | 墓碑 + 旧配置 | 新（已删） | `REVOKED_PENDING_CONFIG` + `DEGRADED`；对外**立即**不可访问；重启后墓碑胜出，条目消失 |
| 移除：墓碑已有、COMMIT 抛错、内存仍有权 | 墓碑 + 旧配置 | 旧（仍授权） | **最危险的一格**：同一个同步块内必须"先删 `entries`、再 revoke、再删 provider"，且抛错时由 catch 兜底**强制** `permission.revoke` + `entries.delete` 重试一次；仍失败 → 进程内 `panic` 级日志 + 立即拒绝该 pid 的所有 G-DISK（用内存黑名单兜底），并 `DEGRADED` |
| 重命名：配置已改、内存未改 | 新 | 旧 | `DEGRADED`；显示名以磁盘为准，重启修正 |

### 4.5 Provider 创建失败 / 权限注册失败

- Provider 创建在 STAGE，早于提交点 → 直接 422，无残留。
- 权限注册是纯内存数组插入且入参已预校验 → 视为不可失败；若抛出，走 §4.4 的对应格。

## 5. 崩溃点矩阵

| 崩溃点 | 磁盘 | 内存 | 重启后 | 用户可见 |
|---|---|---|---|---|
| C1 选择器运行中 | 未变 | 未变 | 无变化 | 请求失败，可重试 |
| C2 VALIDATE / STAGE 之后、提交点之前 | 未变 | 未变 | 无变化 | 同上；移除场景已 abort |
| C3a 墓碑已写、COMMIT 未执行（移除） | 有墓碑 | 仍授权 | 墓碑胜出 → 项目消失 | 响应丢失；用 `opId` 查询得 `revoked` |
| C3b 墓碑已写、COMMIT 已执行、配置未写 | 墓碑 + 旧配置 | 已撤销 | 墓碑胜出 → 项目消失；配置条目被清理 | 同上；本次进程内项目已不可访问 |
| C4 tmp 写完、rename 前 | 旧配置 | 未变 | 无变化（tmp 被清理） | 添加：重试；移除：此点已过提交点，按 C3b 处理 |
| C5 rename 后、COMMIT 前（添加） | 新配置 | 旧 | 按新配置加载 → 项目出现 | 响应丢失；重试命中"已存在"并按幂等返回 |
| C6 COMMIT 后、响应前 | 已一致 | 已一致 | 一致 | 客户端超时；用 `opId` 查询 |

**结论**：所有崩溃点重启后都收敛到"墓碑 + 配置的并集"这一唯一权威；不存在"内存授权但磁盘已撤销"的状态能跨进程存活。

## 6. 项目级 QUIESCING 屏障（与 ADR-023 共用）

**权威在 Host，Shell 计数只是 UX 辅助。**

```text
begin(projectId)
  → quiesce[pid] = { startedAt, deadline: now + 2s }
  → 所有 G-DISK 门禁先查屏障：命中即 409 ERR_PROJECT_QUIESCING
  → 等待 activeOps[pid] 归零（每个通过的 G-DISK 操作 +1/−1）
  → Host 权威复检：activeViews===0 && dirtySessions===0
                  && savingSessions===0 && unknownSessions===0
                  && conflictedSessions===0 && activeDiskOps===0
  → 通过 → REVOKING；不通过 → abort()：清屏障、状态回 ACTIVE、**零变更**
```

- 复检口径详见 ADR-023 §3.1/§3.2（`activeViews` 取代早前的 `openSessions`；**无 View 的干净历史会话不阻止移除**）。
- 屏障是**唯一**的准入编排者：`begin` 之后新到的 G-DISK 请求一律 409，不需要各端点自己判断。
- G-DRAFT 端点（草稿读取、关闭视图）**不受屏障限制**，否则用户无法在移除过程中取回/关闭草稿（见 ADR-023 §3）。
- 超时（2s）未 drain → abort，返回 409 与阻塞原因。
- abort 后：会话、草稿、Provider、grant 全部保持原样；**不丢草稿**。

## 7. 并发、幂等与结果查询

| 场景 | 规则 |
|---|---|
| 两个变更并发 | `mutationLock` 单飞；后者 409 `ERR_PROJECT_BUSY` |
| 同一 `intentId` 重放 | 410（已消费） |
| 移除不存在的项目 | 404，幂等无副作用 |
| 移除已移除项目 | 404（墓碑命中） |
| 重命名相同名字 | 200，`commitSeq` 仍 +1（保持单调，不做特例） |
| 两个 Host 实例 | `workspace.lock`（pid + host + startedAt + 心跳）；第二个实例启动即拒绝托管模式 |

### 7.1 变更结果的确定与查询（`opId`）

每次变更事务分配一个 `opId`（也与 `intentId` 一对一）。客户端若收到 5xx 或超时，**不得**凭猜测重试，用 `opId` 查询：

| `GET /api/projects/op?opId=` 返回 | 含义 | 判定依据 |
|---|---|---|
| `{outcome:'created'}` | 添加已提交 | 配置中含该 `projectId` |
| `{outcome:'revoked'}` | 移除已生效 | 墓碑中含该 `projectId`（**不含**配置状态） |
| `{outcome:'aborted'}` | 未发生任何持久化 | 墓碑无记录且配置无该条目 |
| `{outcome:'unknown'}` | 进程在判定前崩溃 | `opId` 不在本次进程的完成表中；重启后只能由上面的磁盘判据归类 |

- 查询结果**只读磁盘**（墓碑 + 配置），不读内存，因此重启前后结论一致。
- `opId` 记录保留在进程内（重启后丢失），重启后的查询退化为"按 `projectId` 判定"：墓碑命中 → `revoked`；配置命中 → `created`；都没有 → `aborted`。
- 响应体始终带 `opId`，UI 用它做去重与结果确认，避免"失败但已生效"导致用户重复添加。

## 8. 与 workspaceKey 的关系

- `workspaceKey` 定义不变：`sha256(排序后的 "multi\0<pid>\0<canonicalRoot>\0<rootToken>" 或 "multi\0<pid>\0unavailable")`。
- 改为**按请求求值**（带缓存 + 变更时失效），不再启动时计算一次。
- 添加/移除必然改变 key；重命名**不**改变 key（只改 `name`）。
- key 变化**不得**用于"改写快照绕过校验"——见 ADR-023 §6。

## 9. 必须通过的安全测试

| ID | 用例 |
|---|---|
| R-01 | 添加成功后 `/api/resources?projectId=<new>` 立即可用，`/api/projects` 出现 READY |
| R-02 | 移除后该项目的 G-DISK 端点全部拒绝，`/api/projects` 消失（**前置：无活动 View**，见 ADR-023 §8.1） |
| R-03 | **异常失效**（`UNAVAILABLE` 而非正常移除）时，合法 View 仍能 `GET /api/document`；非 dirty 可 `POST /api/close`，dirty 按 `ERR_DOCUMENT_DIRTY` 拒绝（ADR-023 §8.2） |
| R-04 | 移除后 read/write grant 立即不存在（`grantsOf(actor)` 无该 providerId） |
| R-05 | 移除被拒（仍有活动 View / dirty / SAVING / UNKNOWN / CONFLICT / FAILED）后状态回 ACTIVE，草稿字节与 revision 不变 |
| R-06 | 崩溃点 C3a：只有墓碑、COMMIT 未执行 → 重启后项目不可见且**无任何 grant** |
| R-06b | 崩溃点 C3b：墓碑 + 旧配置、COMMIT 已执行 → 重启后项目消失，配置条目被清理 |
| R-07 | 主配置被截断 → 回落 `.bak` 且进入 RECOVERY_RESTRICTED，变更 503 |
| R-07b | **日志缺失（轻度）**：日志不存在但主配置有效且含撤销 → RECOVERY_RESTRICTED，撤销仍生效，变更 503 |
| R-07c | **日志缺失（重度）**：日志不存在且配置来自 `.bak` → RECOVERY_RESTRICTED 且全部项目 G-DISK 拒绝 |
| R-07d | **首次初始化**：配置与日志都不存在 → 正常空表启动，允许变更（与上面两例区分） |
| R-07e | **托管冷启动 / v1 迁移**：配置存在但 `commitSeq === 0` 且 `revoked` 为空、日志缺失 → 正常启动并创建日志头，允许变更 |
| R-08 | 备份含已撤销项目 → 墓碑/`revoked[]` 生效，**不复活** |
| R-08b | 日志 hash 链断裂 → 裂缝后视为 UNKNOWN，按"重度"处理，不授予任何磁盘权限 |
| R-09 | 旧 projectId 不复用：移除 `notes` 后再添加同名目录 → 新 id ≠ `notes` |
| R-10 | 根令牌变化 → UNAVAILABLE，**不自动 adopt**，配置不被改写 |
| R-11 | 并发两次添加 → 一次 200、一次 409，配置只 +1 条 |
| R-12 | 静态 Multi / Legacy 调变更端点 → 501，既有套件全绿 |
| R-13 | `version()` 仍返回 1（静态注册表断言不变），可变性由 `revision()` 表达 |
| R-14 | `/api/projects`、`/api/health`、`/api/document` 不泄露 `rootDir`/`canonicalRoot`/`rootToken`/`providerId`（项目内相对 `path` 允许） |
| R-15 | 墓碑 `fsync` 失败 → 零变更、无墓碑、可安全重试（`ERR_PERSIST_FAILED`） |
| R-16 | 墓碑成功、配置写失败 → 项目立即不可访问；响应含 `outcome:'revoked'` + `opId`；重启后为 `REMOVED` |
| R-17 | `GET /api/projects/op?opId=` 在"5xx 但已生效"场景返回 `revoked`；对未发生变更的 `opId` 返回 `aborted` |
| R-18 | 重命名：仅 `name` 变化，`projectId`/`rootToken`/`workspaceKey` 不变；`commitSeq` 仍 +1；空名 / 超长 / 控制字符 → 400 |

## 10. 本轮不实现（边界）

- 不做 rebind / adopt（A2）；根变化一律 UNAVAILABLE。
- 不做项目级并发（同一时刻仍只有一个变更事务）。
- 不做配置加密（路径非秘密；配置目录由用户画像保护）。
- 不做会话回收（A2）；移除后会话保留至视图关闭或进程退出。
- 不做跨平台选择器与安装器集成。
- 不做日志重建 CLI（`RECOVERY_RESTRICTED` 下由人工处理，后续立项）。

## 11. 待用户批准点

1. 采用 `--workspace-store` 作为托管模式唯一开关（与 `--workspace` 互斥）。
2. 接受配置 v2 的 `commitSeq / issuedIds / revoked / checksum` 与链式校验的墓碑日志。
3. 接受 `DEGRADED`（需重启）与 `RECOVERY_RESTRICTED`（只读 + 禁止变更）两个受限状态。
4. 接受**两种操作提交点不同**：添加以配置 `rename` 为提交点、移除以墓碑 `fsync` 为提交点；移除在提交点之后不可回滚。
5. 接受 `opId` 结果查询语义（以磁盘为准，不以内存为准）。
