# ADR-022 托管 ProjectRuntime：唯一协调器、事务与撤销

- **ADR-ID**：ADR-022
- **状态**：PROPOSED（待用户正式批准）
- **日期**：2026-11-14
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
- `checksum` 用于识别截断/半写；`commitSeq` 必须 `>=` 全部 `revokedAtSeq`。

### 3.1 写入顺序（不可调换）

1. 若为移除：先向 `revocations.jsonl` **追加**一行 `{projectId, revokedAtSeq, at}` 并 `fsync`。
2. 写 `workspace.json.tmp.<pid>`（同目录，保证 rename 原子）→ `fsync` → `close`。
3. 把当前 `workspace.json` 复制为 `workspace.json.bak`（若存在）。
4. `rename(tmp → workspace.json)`。

**为什么墓碑先行**：备份（`.bak`）可能比主文件旧，若只依赖主文件里的 `revoked`，回退到旧备份就会**复活已撤销的授权**。墓碑日志独立且 append-only，加载时**墓碑优先于任何来源**。

### 3.2 加载与备份可信性（fail-closed）

```text
读 workspace.json
  ├─ 校验通过（schema + checksum + commitSeq 单调）→ 用它
  └─ 失败 → 读 workspace.json.bak
        ├─ 通过 → 用它，并进入 RECOVERY_RESTRICTED（配置曾损坏，禁止变更，仅可读写已通过复核的项目）
        └─ 也失败 → RECOVERY_RESTRICTED + 空项目表（不提供任何磁盘访问）
应用墓碑：任何 projectId 出现在 revocations.jsonl 或 revoked[] → 从项目表移除（无论来自主文件还是备份）
应用 issuedIds：即使项目被移除，其 id 也不再签发
```

- **备份不得自动恢复已撤销授权**：墓碑压倒一切；`RECOVERY_RESTRICTED` 下所有变更端点 503。
- **无权限恢复时不自动重新授权**：加载时对每个条目重新 `inspectProjectRoot`；`rootToken`/`canonicalRoot` 与配置不一致 → `UNAVAILABLE(CANONICAL_CHANGED|ROOT_TOKEN_CHANGED)`，**不 adopt、不改写配置**；只有用户显式 `rebind`（A2）才能换根。
- 配置不确定时（校验失败、墓碑不可读）→ 一律 fail-closed：宁可少一个项目，不多给一份权限。

## 4. 变更事务（唯一顺序）

```text
[T1..T3 校验] → VALIDATE → STAGE → PERSIST → COMMIT → PUBLISH → NOTIFY
```

| # | 阶段 | 内容 | 可失败？ | 失败后果 |
|---|---|---|---|---|
| 1 | VALIDATE | inspect、重复/嵌套、id 签发、grant 入参预校验（`requireCanonicalScope('')` 能通过的形态） | 是（4xx） | 零副作用 |
| 2 | STAGE | `createLocalProvider()` 构造实例，**不放入** provider 表 | 是（422） | 丢弃实例，零副作用 |
| 3 | PERSIST | 按 §3.1 写盘（移除时含墓碑） | 是（5xx） | 内存未改，完全回滚 |
| 4 | COMMIT | **同步、无 `await`、不可失败**：`entries.set/delete` + `grant/revoke` + `revision++` + `commitSeq=新值` + 失效 workspaceKey 缓存 | 理论不可失败 | 见 §5 |
| 5 | PUBLISH | provider 表增删 | 否（同一同步块内完成） | — |
| 6 | NOTIFY | 响应 + 可选 `SET_PROJECTS` 提示 | 是 | 不影响一致性；Shell 可重拉 |

**提交点是 PERSIST 成功。** 内存变更放在它之后、且是纯同步块，因此"写盘成功但内存提交失败"只可能来自编程错误；一旦发生，Runtime 进入 `DEGRADED`（所有变更端点 503，读写既有项目仍可用），并记录日志要求重启——**重启即自愈**（磁盘为权威）。

### 4.1 磁盘写成功但内存提交失败

| 情形 | 处理 |
|---|---|
| 添加：配置已有条目、内存无 | `DEGRADED`；重启后该条目正常加载（用户看到项目出现，符合预期）；不重复登记 |
| 移除：配置已删除、内存仍有 | `DEGRADED`；对外**立即**按已移除处理（G-DISK 拒绝），内存条目仅作墓碑；重启后消失 |
| 重命名同理 | `DEGRADED`；显示名以磁盘为准，重启修正 |

### 4.2 Provider 创建失败 / 权限注册失败

- Provider 创建在 STAGE，早于写盘 → 直接 422，无残留。
- 权限注册是纯内存数组插入且入参已预校验 → 视为不可失败；若抛出，走 §4.1 的 `DEGRADED`。

## 5. 崩溃点矩阵

| 崩溃点 | 磁盘 | 内存 | 重启后 | 用户可见 |
|---|---|---|---|---|
| C1 选择器运行中 | 未变 | 未变 | 无变化 | 请求失败，可重试 |
| C2 VALIDATE/STAGE 之后、PERSIST 之前 | 未变 | 未变 | 无变化 | 同上 |
| C3 墓碑已写、配置未写（移除） | 有墓碑 | 未变 | 项目被墓碑删除 | 项目已消失（符合用户意图） |
| C4 tmp 写完、rename 前 | 旧配置 | 未变 | 无变化（tmp 被清理） | 重试 |
| C5 rename 后、COMMIT 前 | 新配置 | 旧 | 按新配置加载 | 与磁盘一致 |
| C6 COMMIT 后、响应前 | 新配置 | 新 | 一致 | 客户端超时，重试可能 409/幂等命中 |

## 6. 项目级 QUIESCING 屏障（与 ADR-023 共用）

**权威在 Host，Shell 计数只是 UX 辅助。**

```text
begin(projectId)
  → quiesce[pid] = { startedAt, deadline: now + 2s }
  → 所有 G-DISK 门禁先查屏障：命中即 409 ERR_PROJECT_QUIESCING
  → 等待 activeOps[pid] 归零（每个通过的 G-DISK 操作 +1/−1）
  → Host 权威复检：dirtySessions===0 && savingSessions===0 && unknownSessions===0 && openSessions===0
  → 通过 → REMOVING；不通过 → abort()：清屏障、状态回 ACTIVE、**零变更**
```

- G-DRAFT 端点（草稿读取、关闭视图）**不受屏障限制**，否则用户无法在移除过程中取回/关闭草稿（见 ADR-023 §3）。
- 超时（2s）未 drain → abort，返回 409 与阻塞原因。
- abort 后：会话、草稿、Provider、grant 全部保持原样；**不丢草稿**。

## 7. 并发与幂等

| 场景 | 规则 |
|---|---|
| 两个变更并发 | `mutationLock` 单飞；后者 409 `ERR_PROJECT_BUSY` |
| 同一 `intentId` 重放 | 410（已消费） |
| 移除不存在的项目 | 404，幂等无副作用 |
| 移除已移除项目 | 404（墓碑命中） |
| 重命名相同名字 | 200，`commitSeq` 仍 +1（保持单调，不做特例） |
| 两个 Host 实例 | `workspace.lock`（pid + host + startedAt + 心跳）；第二个实例启动即拒绝托管模式 |

## 8. 与 workspaceKey 的关系

- `workspaceKey` 定义不变：`sha256(排序后的 "multi\0<pid>\0<canonicalRoot>\0<rootToken>" 或 "multi\0<pid>\0unavailable")`。
- 改为**按请求求值**（带缓存 + 变更时失效），不再启动时计算一次。
- 添加/移除必然改变 key；重命名**不**改变 key（只改 `name`）。
- key 变化**不得**用于"改写快照绕过校验"——见 ADR-023 §6。

## 9. 必须通过的安全测试

| ID | 用例 |
|---|---|
| R-01 | 添加成功后 `/api/resources?projectId=<new>` 立即可用，`/api/projects` 出现 READY |
| R-02 | 移除后该项目的 G-DISK 端点全部拒绝，`/api/projects` 消失 |
| R-03 | 移除后其合法 View 仍能 `GET /api/document`（G-DRAFT）；非 dirty 视图可正常 `POST /api/close`，dirty 视图按既有 `ERR_DOCUMENT_DIRTY` 拒绝 |
| R-04 | 移除后 read/write grant 立即不存在（`grantsOf(actor)` 无该 providerId） |
| R-05 | 移除失败（有 dirty）后状态回 ACTIVE，草稿字节与 revision 不变 |
| R-06 | 崩溃点 C3：只有墓碑、无配置 → 重启后项目不可见 |
| R-07 | 主配置被截断 → 回落 `.bak` 且进入 RECOVERY_RESTRICTED，变更 503 |
| R-08 | 备份含已撤销项目 → 墓碑生效，**不复活** |
| R-09 | 旧 projectId 不复用：移除 `notes` 后再添加同名目录 → 新 id ≠ `notes` |
| R-10 | 根令牌变化 → UNAVAILABLE，**不自动 adopt**，配置不被改写 |
| R-11 | 并发两次添加 → 一次 200、一次 409，配置只 +1 条 |
| R-12 | 静态 Multi / Legacy 调变更端点 → 501，既有套件全绿 |
| R-13 | `version()` 仍返回 1（静态注册表断言不变），可变性由 `revision()` 表达 |
| R-14 | `/api/projects`、`/api/health` 不泄露路径/令牌/providerId |

## 10. 本轮不实现（边界）

- 不做 rebind / adopt（A2）；根变化一律 UNAVAILABLE。
- 不做项目级并发（同一时刻仍只有一个变更事务）。
- 不做配置加密（路径非秘密；配置目录由用户画像保护）。
- 不做会话回收（A2）；移除后会话保留至视图关闭或进程退出。
- 不做跨平台选择器与安装器集成。

## 11. 待用户批准点

1. 采用 `--workspace-store` 作为托管模式唯一开关（与 `--workspace` 互斥）。
2. 接受配置 v2 的 `commitSeq / issuedIds / revoked / checksum` 与墓碑日志。
3. 接受 `DEGRADED`（需重启）与 `RECOVERY_RESTRICTED`（只读 + 禁止变更）两个受限状态。
4. 接受"提交点 = 写盘成功、内存变更同步且不可失败"的事务顺序。
