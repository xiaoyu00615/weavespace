# ADR-023 G-DISK / G-DRAFT 分离与项目移除状态机

- **ADR-ID**：ADR-023
- **状态**：PROPOSED（待用户正式批准）
- **日期**：2026-11-14
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

**F1/F2 是本次裁决指出的真实缺陷**：一旦移除项目时撤销 grant，合法用户既读不回自己的草稿，也关不掉视图——草稿变成"只能随进程退出而消失"的孤儿。

## 2. 决策一：两道门，互不替代

| 门 | 判定依据 | 覆盖端点 | 移除后 |
|---|---|---|---|
| **G-DISK** | 项目存在于 Registry 且 `READY` + 根令牌未变 + `permission.authorize(action, identity.path, 'local:<pid>')` | `/api/resources`、`/api/open`、`/api/edit`、`/api/save`、`/api/reload`、`/api/document/disk` | **一律拒绝** |
| **G-DRAFT** | 会话存在 + `viewId` 属于当前 `actorId` + `sessionId/viewId` 绑定一致（**不查项目、不查磁盘权限**） | `GET /api/document`、`POST /api/close` | **仍允许**：读回内存草稿、关闭视图 |

补充规则：

- **移除时立即撤销 read/write grant**（`permission.revoke` ×2）。**不允许**以"会话尚未回收"为由保留磁盘权限。
- `GET /api/document` 只返回**已在 Host 内存中**的正文；它不触碰磁盘，因此不构成新的文件访问授权。
- `POST /api/close` 的拒绝条件只剩"未保存修改"（`ERR_DOCUMENT_DIRTY`），不再因项目被移除而 403。
- G-DRAFT 不返回、不记录任何路径信息；响应仍不含 `rootDir`。
- 若 `viewId` 缺失或不属于该 actor → 403（沿用 `requireView`）；`GET /api/document` 在 multi 下仍要求 `viewId`。

## 3. 决策二：项目移除状态机

状态（拥有者 = `ProjectRuntime`，ADR-022 §2）：

```text
        ┌────────────── abort（零变更） ──────────────┐
        │                                             │
   ACTIVE ──begin quiesce──▶ QUIESCING ──commit──▶ REMOVING ──▶ REMOVED
      │                          │
      │                          └─ 超时/有 dirty → abort → ACTIVE
      │
      └──inspect 失败──▶ UNAVAILABLE（不可自动恢复；rebind 为 A2）

  任意状态 ──配置/提交异常──▶ DEGRADED（变更 503，重启自愈）
  加载异常（校验失败/备份回退）──▶ RECOVERY_RESTRICTED（只读，禁止变更）
```

### 3.1 移除的权威前置条件（Host 判定，Shell 计数仅 UX）

```
allowed =
     openSessions(projectId) === 0          // 首版最保守：无任何打开会话
  && dirtySessions(projectId) === 0        // 含未同步草稿的会话
  && savingSessions(projectId) === 0       // SAVE_STARTED 在途
  && unknownSessions(projectId) === 0      // SAVE_UNKNOWN（结果未知）
  && unsyncedEditOps(projectId) === 0      // 屏障 drain 后仍无在途 edit
```

Shell 的 `removal-precheck` 上报（`openTabs / dirtyTabs / savingTabs / unsyncedEdits / unknownTabs`）**只用于提前给出可读提示**，Host 不采信其数值做放行判断。二者不一致时以 Host 为准。

> 首版刻意要求 `openSessions === 0`：Shell 的 `edit-queue` 是批量提交，Host 的 `dirty` 会滞后于浏览器缓冲，服务端无法单方证明"浏览器侧没有未同步字节"。宁可要求用户先关闭标签，也不接受"看起来不脏"。

### 3.2 移除动作序列

```text
1. mutationLock 获取（失败 → 409 ERR_PROJECT_BUSY）
2. begin quiesce（G-DISK 全线 409 ERR_PROJECT_QUIESCING）
3. drain activeOps（≤2s）
4. Host 权威复检（§3.1）——不通过 → abort（回 ACTIVE，零变更，草稿保留）
5. PERSIST：追加墓碑 → 写配置（ADR-022 §3.1）
6. COMMIT（同步）：
     entries.delete(pid)
     permission.revoke(read/write, local:<pid>)   ← 立即撤销，无保留期
     providers.delete(providerId)
     document.markProjectStale(pid, 'PROJECT_REMOVED')
     commitSeq++ / workspaceKey 失效
7. 释放屏障，清 mutationLock
8. 通知 Shell（`SET_PROJECTS`）
```

REMOVED 之后：

- 该项目的 G-DISK 全部 404 `ERR_PROJECT_NOT_FOUND`（列表已无此项目）；
- 遗留会话保持 `STALE(PROJECT_REMOVED)`，正文 + revision + viewId 保留，供 G-DRAFT 读取；
- 视图关闭（`POST /api/close`）→ 会话从内存移除，草稿随之消失（**这是明确的数据边界**，见 §5）；
- **磁盘零操作**：移除链路不得 `import` 任何删除/移动 API（架构测试断言）。

### 3.3 重命名

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

## 5. 草稿的保留与丢失边界（必须写进用户可见文案）

| 场景 | 结果 |
|---|---|
| 移除被拒绝（有 dirty） | 草稿、revision、会话、Provider 全部原样；用户可继续编辑/保存 |
| 移除成功且用户此前已关闭全部标签 | 无草稿可言 |
| 移除成功但存在 STALE 会话（仅可能来自崩溃/异常路径） | 可用 `GET /api/document` 导出正文，直到视图关闭（非 dirty）或 Host 退出；dirty 视图无 discard 契约，导出后随进程退出释放 |
| Host 进程退出 | 内存草稿消失；**唯一兜底是 Shell 的 `ws:draft-backup:<pid>:<path>` 本地备份**，与 Host 无关 |

因此 UI 的移除对话框必须显示：**"移除只从工作台移除该项目，不会删除磁盘文件；未保存的修改会随进程退出丢失，请先保存或导出。"**

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
| quiesce 超时 | abort → ACTIVE；返回 409 + 阻塞原因；草稿不动 |
| 移除中用户又发 open/edit | 409 `ERR_PROJECT_QUIESCING`；Shell 按普通失败提示，不重试循环 |
| 移除中进程崩溃（C3/C5） | 见 ADR-022 §5：墓碑/配置为权威，重启后不复活 |
| 移除成功后 Shell 仍持有旧标签 | 下一次 G-DISK 调用 404；Shell 将标签标记为 `stale` 并允许导出/关闭（G-DRAFT），不自动丢弃 |
| 根被移动/替换 | UNAVAILABLE；G-DISK 拒绝、G-DRAFT 仍可读；不自动 adopt |
| 恢复时 key 不匹配 | 只恢复 UI，不认领标签（§6） |

## 8. 必须通过的安全测试

| ID | 用例 | 断言 |
|---|---|---|
| D-01 | 移除后 `GET /api/document` | 200，正文与移除前一致 |
| D-02 | 移除后 `POST /api/close`（会话**非 dirty**） | 200；视图从内存消失 |
| D-02b | 移除后 `POST /api/close`（会话 **dirty**） | 409 `ERR_DOCUMENT_DIRTY`——仓库无 `discard` 契约，必须由用户先导出再由进程退出释放，**不得**静默丢草稿 |
| D-03 | 移除后 `GET /api/resources` / `/api/document/disk` / `/api/save` | 404 / 403·404 / 404 |
| D-04 | 移除后 `grantsOf(actor)` | 不含 `local:<pid>` 的 read/write |
| D-05 | 他 actor 用猜到的 viewId 读草稿 | 403（G-DRAFT 仍绑定 actor） |
| D-06 | 移除被拒（dirty） | 409；正文、revision、grant、Provider 全不变 |
| D-07 | quiesce 期间 open/edit/save | 409 `ERR_PROJECT_QUIESCING`，且未产生任何磁盘写入 |
| D-08 | quiesce 期间 close/document | 200（不被屏障阻塞） |
| D-09 | 移除后重启 | 项目不在列表；无墓碑复活；旧草稿按 §5 消失 |
| D-10 | key 变化后启动 | 不恢复标签、只恢复 UI，且快照 key 未被改写 |
| D-11 | 静态/legacy | 上述行为不适用；既有套件全绿 |
| D-12 | 移除链路静态检查 | 相关模块无 `fs.rm*`/`unlink`/`rename` 引用 |

## 9. 本轮不实现（边界）

- 不做 rebind（根变化只能重启 + 手工重加）。
- 不做"移除后自动导出草稿"的批处理（只提供 G-DRAFT 读取 + UI 手动导出）。
- 不做会话回收（A2），STALE 会话保留至视图关闭或进程退出。
- 不做逐标签恢复（§6 目标态），首版是 UI-only。
- 不修改任何既有文件读写、草稿与保存流程；G-DISK 的判定内容与现状一致，只是把 G-DRAFT 从它里面**拆出来**。

## 10. 待用户批准点

1. 移除后**立即**撤销 read/write grant（放弃"会话回收后再生效"的方案）。
2. 首版移除要求 `openSessions === 0`（比"仅要求不脏"更严）。
3. 首版恢复策略：项目集合变化 → 只恢复 UI，不认领标签（不做 key 改写）。
4. 接受 G-DRAFT 以 `actor + session + view` 作为唯一凭据（落实 PR-26）。
