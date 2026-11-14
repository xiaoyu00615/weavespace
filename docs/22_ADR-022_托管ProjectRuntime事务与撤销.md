# ADR-022 托管 ProjectRuntime：唯一协调器、事务与撤销

- **ADR-ID**：ADR-022
- **状态**：PROPOSED（待用户正式批准）
- **日期**：2026-11-14
- **修订**：R2（2026-11-14）——明确**撤销生效点**（墓碑 `fsync`）并把移除事务拆为 `PERSIST-REVOKE` / `COMMIT` / `PERSIST-CONFIG`；删除"移除失败即完全回滚"的错误表述；区分**首次初始化**与**日志意外缺失**；补 `opId` 结果查询。添加与移除的提交点因此不同（§4.0）。
- **修订**：R3（2026-11-14）——安全勘误三项：①日志缺失时**即使配置校验通过也不得继续授予 G-DISK**（§3.2）；②墓碑写入失败区分"确认未写入"与"结果不确定"，后者进入 `REVOKE_UNKNOWN` 并核对证据（§3.1.1）；③`opId` 查询只认与该 `opId` 精确匹配的持久证据，否则 `unknown`（§7.1）。
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
  "revoked": [{ "projectId": "design", "revokedAtSeq": 16, "opId": "op-3f19" }],
  "projects": [
    {
      "projectId": "notes",
      "name": "个人笔记",
      "rootDir": "C:/Users/me/notes",
      "canonicalRoot": "C:\\Users\\me\\notes",
      "rootToken": "<dev:ino>",
      "grantedAt": "2026-11-14T06:00:00.000Z",
      "grantSource": "os-dialog",
      "createdByOp": "op-7a02"            // 该条目由哪一次变更事务写入（结果查询凭据）
    }
  ],
  "checksum": "sha256(canonical payload without this field)"
}
```

`opId` **不是**通用的工作流标识，只是"这次变更是否被持久化证据承认"的关联键：添加落到 `createdByOp`，移除落到 `revoked[].opId` 与墓碑行（§3.1）。没有它就无法把一次请求和一条持久记录对应起来（§7.1）。

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
| step 1 **确认未写入**（打开文件失败、写入 0 字节即报错） | 无墓碑 | **能**：返回 5xx `ERR_PERSIST_FAILED`，零变更，可安全重试 |
| step 1 **写入结果不确定**（`fsync` 返回 `EIO`、部分写入后 `ENOSPC`、进程在 append/fsync 中途被杀） | **可能已有墓碑** | **不能当时断言"零变更"**：先按"已撤销"保守处理，再核对证据（见 §3.1.1） |
| step 1 fsync 成功 | 撤销已生效 | **不能**。即使 step 3 失败，项目也不可再访问 |
| step 3 失败 | `REVOKED_PENDING_CONFIG` | 不回滚；重启按墓碑补齐为 `REMOVED` |

墓碑行的格式（链式校验，防截断与乱序）：

```jsonc
{ "seq": 16, "projectId": "design", "at": "2026-11-14T06:12:00.000Z", "opId": "op-3f19",
  "prevHash": "<上一行的 hash 或 GENESIS>", "hash": "sha256(seq|projectId|at|opId|prevHash)" }
```

`seq` 必须严格递增；`hash` 链断裂即视为日志不可信（§3.2）。`opId` 是该次事务与持久证据的关联键（§7.1）。

### 3.1.1 `step 1` 结果不确定时的核对（不可省略）

`append`/`fsync` 报错**不等于**没写进去：内核可能已把部分字节落盘，也可能在返回错误前完成落盘。因此不能"报错就当零变更"，必须区分两种情形并核对证据：

| 观测 | 判定 | 立即动作 | 最终结论 |
|---|---|---|---|
| 打开文件失败 / 写入返回 0 字节错误 | 明确未写入 | 不改变任何状态 | `aborted`，返回 `ERR_PERSIST_FAILED`，可重试 |
| `fsync` 报错、部分写入、崩溃边缘 | **不确定** | ① 该 `projectId` 进入**运行时拒绝名单**（G-DISK 一律 403 `ERR_PROJECT_REVOKE_UNKNOWN`）② 状态 `REVOKE_UNKNOWN` ③ 不释放屏障 | 读日志尾部核对（下） |

核对（在受限状态下同步执行，读完即决，不排队）：

```text
读 revocations.jsonl 尾部
  ├─ 存在完整且 hash 链合法的行，且 opId === 本次 opId
  │     → 撤销已生效：继续 step 2（COMMIT），并按 §3.1 的 step 3 收尾
  │       （若 step 3 也失败 → REVOKED_PENDING_CONFIG）
  ├─ 尾部完整、无本次 opId，且日志头/尾哈希与文件长度一致
  │     → 确认未写入：撤销该拒绝名单、状态回 ACTIVE、**零变更**
  └─ 尾部被截断 / 链断裂 / 无法读取
        → 无法判定：保持拒绝名单 + `RECOVERY_RESTRICTED`（变更端点 503），
          由重启或在下次成功写入时收敛；**绝不**据此恢复授权
```

保守原则：`REVOKE_UNKNOWN` 期间**不授予任何磁盘权限**，但 G-DRAFT 与 `POST /api/close` 不受影响（用户仍可取回/关闭草稿，见 ADR-023 §2）。该状态**不放宽**任何既有门禁，只是在无法证明时选择"不给"。

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

**`RECOVERY_RESTRICTED` 分两档，由"撤销集合是否可证"决定**（这是唯一的判据，不看配置自身校验是否通过）：

| 档位 | 条件 | G-DISK | 变更 |
|---|---|---|---|
| **可证档** | 日志完整可读（即使配置来自 `.bak`） | **允许**（按 日志 ∪ `revoked[]` 应用撤销后正常工作） | 503 |
| **不可证档** | 日志缺失、或链断裂无法确定完整撤销集合 | **全线拒绝**；只保留 G-DRAFT 与 `POST /api/close` | 503 |

"配置 `checksum` 通过"只说明这份配置自身没被截断，**不能**把不可证档提升为可证档。

**日志缺失必须分类，不能一律当"从未撤销"**。关键判据是能否**证明**主配置包含全部历史撤销：

| 情形 | 判定依据 | 结果 |
|---|---|---|
| **首次初始化** | `workspace.json` 不存在 **且** 日志不存在 | 空表，允许变更，正常启动（写第一份配置时同时创建日志头）。**该判定必须独立成立**：不依赖任何其他文件的存在性，也不因其他分支受限而改变 |
| **托管冷启动（含 v1 迁移）** | 配置存在，但 `commitSeq === 0` **且** `revoked` 为空 | 视为"尚未发生任何变更事务"，撤销集合必为空，故日志缺失无信息损失 → 正常启动并立即创建日志头；允许变更 |
| **日志意外缺失（配置可用，但完整性不可证）** | 日志缺失，主文件有效且 `checksum` 通过，且 `commitSeq > 0` 或 `revoked` 非空 | `RECOVERY_RESTRICTED` + **全部项目置 UNAVAILABLE（G-DISK 一律拒绝）**。理由见下 |
| **日志意外缺失（配置来自 `.bak`）** | 日志缺失，且当前配置是 `.bak` 回退 | 同上，且项目表不作为可信输入（只列出以便诊断），G-DRAFT 仍可读内存草稿 |
| **日志链断裂** | `seq` 不连续 / `prevHash` 不匹配 / 行不可解析 | 断裂点之前有效；之后视为 UNKNOWN → 按"完整性不可证"处理 |

**为什么"配置校验通过"不足以继续授予磁盘权限**：`checksum` 只能证明这份配置**自身**没被截断，不能证明它是**最新**的。墓碑与配置允许存在"已知滞后"（`墓碑 seq === commitSeq + 1`，§3 规则），也就是说，**最近一次撤销完全可以只存在于日志里而不在主配置里**。日志一旦缺失，就无法排除这种情况；此时"按 `config.revoked[]` 应用撤销后继续读写"等于默认"没有丢掉任何撤销"，而这正是不能假设的。

因此日志缺失且完整性不可证时，**只禁止变更是远远不够的**——被撤销的项目会以"仍在配置里"的形态继续拿到读权限。正确处置是：保留项目条目用于诊断与草稿救援，但**一份 G-DISK 权限都不发**；`RECOVERY_RESTRICTED` 期间变更端点 503，日志由维护动作重建（或由下一次成功写入收敛）后才恢复。

区分"没有撤销历史"与"撤销历史可能丢了"的唯一依据是 `commitSeq`/`revoked`：**只要配置声称发生过任何变更事务（`commitSeq > 0`）或存在撤销条目，而日志却不见了，就必须走受限分支。** 允许 `commitSeq === 0` 走正常分支的前提是：能改写配置并重算 `checksum` 的攻击者已具备本机文件系统写权限，属于 ADR-021 §5 明确排除的威胁模型。

- **备份不得自动恢复已撤销授权**：墓碑与 `revoked[]` 的并集压倒一切；`RECOVERY_RESTRICTED` 下所有变更端点 503，G-DISK 是否可用按上面的两档判定。
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
| 2 | **PERSIST-REVOKE** | 追加墓碑（含 `opId`）+ `fsync`（**提交点**） | 是（5xx） | 分两支：**确认未写入** → 零变更可重试；**结果不确定** → `REVOKE_UNKNOWN`，见 §3.1.1 |
| 3 | COMMIT | 同步、无 `await`：`entries.delete` + `revoke ×2` + `providers.delete` + `markProjectStale` + `commitSeq++` + 失效 key | 理论不可失败 | 访问权已切断，见 §4.4 |
| 4 | PERSIST-CONFIG | 写配置（移除条目，`revoked[]` 记 `opId`） | 是（5xx） | `REVOKED_PENDING_CONFIG` + `DEGRADED`；**不回滚**，重启补齐 |
| 5 | PUBLISH / NOTIFY | 释放屏障、响应 `{outcome:'revoked', opId}` | 是 | 不影响一致性 |

**关键点**：§4.2 的 3 与 4 之间，撤销**已经生效**。因此不能再用"PERSIST 失败 → 完全回滚"的表述描述移除；移除只有在第 2 步**确认未写入**时才可回滚。第 2 步结果不确定时，按 §3.1.1 先拒绝该项目的磁盘访问，再核对证据决定是继续提交还是回 ACTIVE。

第 2 步的三种结局（互斥，且都必须有明确对外语义）：

| 结局 | 依据 | 对外 |
|---|---|---|
| 撤销已生效 | 日志尾部存在本次 `opId` 的完整合法行 | 继续 3→5，响应 `{outcome:'revoked'}` |
| 确认未写入 | 日志尾部完整且无本次 `opId`，文件长度与头/尾哈希自洽 | 回 ACTIVE，响应 5xx `ERR_PERSIST_FAILED`，`outcome:'aborted'` |
| 无法判定 | 尾部截断 / 链断裂 / 不可读 | 保持拒绝 + `RECOVERY_RESTRICTED`，响应 5xx `outcome:'unknown'`，由重启或后续写入收敛 |

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
| C2b 墓碑 append / fsync 中途被杀（移除） | **可能半行、可能完整、可能空** | 未撤销 | 加载时按链完整性判定：完整合法 → 该项目 `revoked`；尾部半行/链断 → `RECOVERY_RESTRICTED` + G-DISK 全拒（不授予任何权限） | 响应丢失；`opId` 查询在无法证明时返回 `unknown` |
| C3a 墓碑已写、COMMIT 未执行（移除） | 有墓碑 | 仍授权 | 墓碑胜出 → 项目消失 | 响应丢失；`opId` 在日志中命中 → `revoked` |
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

每次变更事务分配一个 `opId`（与 `intentId` 一对一）。客户端若收到 5xx 或超时，**不得**凭猜测重试，用 `opId` 查询：

| `GET /api/projects/op?opId=` 返回 | 判定依据（必须**按本次 `opId` 匹配**） |
|---|---|
| `{outcome:'created'}` | 配置中存在 `createdByOp === opId` 的条目 |
| `{outcome:'revoked'}` | 墓碑日志中存在 `opId === opId` 的完整合法行（或 `revoked[]` 中同 `opId` 的记录） |
| `{outcome:'aborted'}` | **仅当**本次进程记录了该 `opId` 已 abort（内存表），且磁盘无匹配证据 |
| `{outcome:'unknown'}` | 其余全部情形：证据缺失、证据不可读、日志链断裂、或进程重启后无法确认 |

**不得**用"该项目现在在不在"来推断某次操作的结果。同一 `projectId` 可以被多次操作（添加 → 移除 → 再添加得到新 id，或重命名多次），旧 `opId` 与新状态之间没有对应关系。例如：`notes` 现在存在，只能说明某次添加成功，不能说明**这一次**添加成功；把 `projectId` 存在当作 `created` 会把一个实际失败（且从未落盘）的旧请求误报为成功，进而让 UI 跳过重试。

规则细化：

- 查询结果**只读磁盘**（墓碑 + 配置），不读内存，因此重启前后结论一致。
- 证据必须与 `opId` 精确相等；`opId` 恰好出现在一条**链不合法**的行里 → 仍返回 `unknown`（不可信证据不算证据）。
- `aborted` 只在进程内可判（重启后无法证明"没发生"，故返回 `unknown`）。
- 无匹配证据且本进程无记录 → `unknown`，**不是** `aborted`：缺证据只能说明"没找到"，不能说明"没发生"。
- 响应体始终带 `opId`，UI 用它做去重与结果确认，避免"失败但已生效"导致用户重复添加；`unknown` 时 UI 的正确动作是**重新拉取 `/api/projects` 并提示用户确认**，而不是自动重试同一个变更。

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
| R-06c | 崩溃点 C2b：墓碑 append 中途被杀 → 完整合法行则该项目 `revoked`；半行/链断则 `RECOVERY_RESTRICTED` 且 G-DISK 全拒 |
| R-07 | 主配置被截断、**日志完整** → 回落 `.bak`，`RECOVERY_RESTRICTED` **可证档**：按 日志 ∪ `revoked[]` 应用撤销后可正常读写，仅变更 503 |
| R-07b | **日志缺失、完整性不可证**：日志不存在但主配置有效且 `commitSeq > 0`（或 `revoked` 非空）→ RECOVERY_RESTRICTED；**项目仍不可读写**（`/api/resources`、`/api/open`、`/api/save` 全拒），仅 G-DRAFT 可用，变更 503 |
| R-07c | **日志缺失且配置来自 `.bak`** → 同上（G-DISK 全拒），项目表仅作诊断列出 |
| R-07d | **首次初始化**：配置与日志都不存在 → 正常空表启动，允许变更；该判定不依赖上两例的任何条件 |
| R-07e | **托管冷启动 / v1 迁移**：配置存在但 `commitSeq === 0` 且 `revoked` 为空、日志缺失 → 正常启动并创建日志头，允许变更 |
| R-08 | 备份含已撤销项目 → 墓碑/`revoked[]` 生效，**不复活** |
| R-08b | 日志 hash 链断裂 → 裂缝后视为 UNKNOWN，按"完整性不可证"处理，不授予任何磁盘权限 |
| R-09 | 旧 projectId 不复用：移除 `notes` 后再添加同名目录 → 新 id ≠ `notes` |
| R-10 | 根令牌变化 → UNAVAILABLE，**不自动 adopt**，配置不被改写 |
| R-11 | 并发两次添加 → 一次 200、一次 409，配置只 +1 条 |
| R-12 | 静态 Multi / Legacy 调变更端点 → 501，既有套件全绿 |
| R-13 | `version()` 仍返回 1（静态注册表断言不变），可变性由 `revision()` 表达 |
| R-14 | `/api/projects`、`/api/health`、`/api/document` 不泄露 `rootDir`/`canonicalRoot`/`rootToken`/`providerId`（项目内相对 `path` 允许） |
| R-15 | 墓碑**确认未写入**（打开失败 / 0 字节错误）→ 零变更、无墓碑、可安全重试（`ERR_PERSIST_FAILED`） |
| R-15b | 墓碑**结果不确定**（`fsync` 报 `EIO` / 部分写入 / 中途被杀）→ 该项目立即 `REVOKE_UNKNOWN`（G-DISK 403）；核对日志尾部：命中本次 `opId` → 继续提交；确认无本次行 → 回 ACTIVE；无法判定 → `RECOVERY_RESTRICTED` 且**不恢复授权** |
| R-16 | 墓碑成功、配置写失败 → 项目立即不可访问；响应含 `outcome:'revoked'` + `opId`；重启后为 `REMOVED` |
| R-17 | `opId` 查询**按证据匹配**：`created` 需 `createdByOp === opId`；`revoked` 需日志/`revoked[]` 中同 `opId` 行；只在无匹配证据时返回 `unknown`（**不得**因 `projectId` 存在而返回 `created` 或因不存在而返回 `aborted`） |
| R-17b | 同一项目多次操作：`notes` 添加（`op-A`）→ 移除（`op-B`）→ 用新 id 再添加（`op-C`）。`op-A` 的条目已被删除、证据不复存在 → `unknown`（**不得**因当前存在同名或同目录条目而回报 `created`）；`op-B` → `revoked`；`op-C` → `created`；从未发生的 `op-D` → `unknown` |

## 10. 本轮不实现（边界）

- 不做 rebind / adopt（A2）；根变化一律 UNAVAILABLE。
- 不做项目级并发（同一时刻仍只有一个变更事务）。
- 不做配置加密（路径非秘密；配置目录由用户画像保护）。
- 不做会话回收（A2）；移除后会话保留至视图关闭或进程退出。
- 不做跨平台选择器与安装器集成。
- 不做日志重建 CLI（`RECOVERY_RESTRICTED` 下由人工处理，后续立项）。

## 11. 待用户批准点

1. 采用 `--workspace-store` 作为托管模式唯一开关（与 `--workspace` 互斥）。
2. 接受配置 v2 的 `commitSeq / issuedIds / revoked / checksum`、`createdByOp` 与链式校验的墓碑日志（含 `opId`）。
3. 接受三个受限状态：`DEGRADED`（需重启）、`RECOVERY_RESTRICTED`（禁止变更；日志不可证时 G-DISK 全拒，仅 G-DRAFT 可用）、`REVOKE_UNKNOWN`（单项目拒盘，等待证据核对）。
4. 接受**两种操作提交点不同**：添加以配置 `rename` 为提交点、移除以墓碑 `fsync` 为提交点；移除在提交点之后不可回滚。
5. 接受 `opId` 结果查询语义：只认与本次 `opId` 精确匹配的持久证据，缺失即 `unknown`（不推断、不猜测）。
6. 接受**日志缺失即不授予磁盘权限**，即使主配置 `checksum` 校验通过——因为无法证明配置包含全部历史撤销。代价是这份配置损坏时需人工重建日志后才能恢复读写；收益是任何情况下都不会复活已撤销授权。
7. 接受`首次初始化`判定的独立性：仅由"配置与日志都不存在"（或 `commitSeq === 0 && revoked` 为空）成立，不受其他受限分支影响。
