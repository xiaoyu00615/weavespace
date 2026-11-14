# apps/server — localhost Client API（S9-B / G1）

浏览器与 Core 之间的**唯一**本机通道。浏览器不接触文件系统，也不能选择磁盘目录。

## 启动

```bash
# 仓库根 —— 三种互斥模式
node apps/server/src/main.ts <项目根目录> [端口]                    # Legacy 单项目
node apps/server/src/main.ts --workspace <workspace.json> [端口]    # Multi 多项目（静态）
node apps/server/src/main.ts --workspace-store <dir> [端口]         # Multi 多项目（可运行期添加）
```

- 只绑定 `127.0.0.1`；端口优先取命令行，其次 `WS_PORT`，默认 `5177`。端口可省略
  （`--workspace <file>` 后不写端口即用默认端口，UX-00 起支持）。
- 项目根 / 工作区配置**只能**来自启动参数，请求无法指定；启动参数阶段同时给出两者
  直接拒绝（`ERR_STARTUP_MODE_CONFLICT`）。服务端编程式入口 `createShellServer()` 的
  同类冲突仍报 `ERR_PROJECT_CONFIG_INVALID`：前者是**命令行用法错误**，后者是**配置对象
  不合法**，两者错误码不同、不要混用。
- **Multi 模式的身份命名空间**（G1-04）：
  `providerId = local:<projectId>`、`resourceId = doc:<projectId>/<relativePath>`；
  Legacy 保持 `local` / `doc:<relativePath>` 不变。
- Multi 的 `projectId` 必须由客户端在 `/api/resources`、`/api/open` 显式提供；
  其余接口一律按**服务端会话身份**解析项目，客户端给的 `projectId` 只作一致性断言。
- Multi 的会话类接口（`/api/document`、`/api/document/disk`、`/api/edit`、`/api/save`）
  **必须带 `viewId`**：它绑定 actor 与该会话，缺失即 400 `ERR_COMMAND_INVALID`。
  Legacy 仍保持 `viewId` 可选（既有行为不变）。`viewId` 是归属校验标识，不是认证凭据。
- 只有 Registry 判定为 `READY` 的项目才有 Provider；`UNAVAILABLE`（根缺失/非目录/
  重解析点/身份不可确认/UNC）不会被自动创建或自动接管。
- 页面通过 Vite 同源代理访问：`apps/shell` 的 dev server 把 `/api` 转发到本服务，
  因此浏览器侧始终同源，不需要任何 CORS 头。

### 启动参数规则（UX-00 / UX-00-R1）

参数解析在 `src/startup-args.ts`（纯函数，`tests/suites/39-*` 覆盖），`main.ts` 只做
「解析 → 建服务」。全部非法参数都以 `exit 2` + 单行说明结束，不打印堆栈：

| 输入 | 结果 |
|---|---|
| `<root>` / `<root> <port>` | Legacy |
| `--workspace <file>` / `--workspace=<file>` | Multi，端口可省略 |
| `--workspace-store <dir>` / `--workspace-store=<dir>` | 托管 Multi，端口可省略 |
| `<port> --workspace <file>` | Multi（端口可写在选项前） |
| `--workspace <file> <port>` | Multi |
| 无参数 | `ERR_STARTUP_NO_TARGET` + 用法 |
| `--workspace` 缺值 / 空值 / 后面跟着另一个选项 | `ERR_STARTUP_WORKSPACE_MISSING_VALUE` |
| `--workspace-store` 缺值 / 空值 / 后面跟着另一个选项 | `ERR_STARTUP_WORKSPACE_STORE_MISSING_VALUE` |
| 同时给项目根与 `--workspace`、重复指定 `--workspace`、Multi 下多个位置参数 | `ERR_STARTUP_MODE_CONFLICT` |
| **`--workspace` 与 `--workspace-store` 同时出现** | `ERR_STARTUP_MODE_CONFLICT`（两套项目权威不得并存） |
| **Legacy 下第三个及之后的位置参数**（如 `<root> <port> typo`） | `ERR_STARTUP_UNEXPECTED_POSITIONAL` |
| 未知 `--xxx` 选项 | `ERR_STARTUP_UNKNOWN_OPTION` |
| 端口非整数 / 越界（`>65535`） | `ERR_STARTUP_INVALID_PORT` |

两条容易混淆的边界：

- **位置参数数量是硬边界**。Legacy 只接受 `<root>` 与 `[端口]`；多余的第三个及之后
  一律拒绝且报 `ERR_STARTUP_UNEXPECTED_POSITIONAL`（UX-00-R1 修复：此前被静默忽略，
  拼错的命令会"看起来启动成功"）。多项结构错误同时存在时，报数量问题优先于报端口问题。
- `--workspace` 出现的**次数**决定是否 Multi，与是否带端口无关（UX-00 修复的缺陷：
  此前不带端口时 `--workspace` 会被静默丢弃并因"缺少项目根"退出）。

端口允许 `0`（交给系统分配临时端口，便于并行起实例）。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查：`{status,mode,workspaceMode}`；**不返回任何本机绝对路径** |
| GET | `/api/projects` | Multi：`{projects:[{projectId,name,status,reason?}]}`；Legacy：404 |
| GET | `/api/session-token` | **托管 Multi**：换一次性会话令牌 `{token, intent?}`；其他模式 501 |
| POST | `/api/projects/pick` | **托管 Multi**：`{requestId, intentId, name?}` → 请求 Host 弹本机目录选择器（202）；**不接受任何路径字段** |
| GET | `/api/projects/pick` | 托管 Multi：`?requestId=` → 查询该请求的终态（`PENDING`/`APPLIED`/`CANCELLED`/`REJECTED`） |
| GET | `/api/resources` | **旧端点，输出冻结**：授权范围内的可编辑文本文件树（递归、只列 `.md/.markdown/.txt`）；Legacy 无需参数，Multi 必须 `?projectId=`。新 UI 不用它 |
| GET | `/api/tree` | **UX-02B-TREE**：只读一层真实目录，支持分页；见下节 |
| POST | `/api/open` | Legacy `{path}` / Multi `{projectId,path}` → 经 CommandBus 建立会话 |
| GET | `/api/document` | `?sessionId&viewId` → **G-DRAFT**：按 actor + 会话 + 视图归属读回内存正文（不碰磁盘） |
| POST | `/api/edit` | `{sessionId, buffer, expectedVersion?}` → `document.applyEdit` |
| POST | `/api/save` | `{sessionId, expectedVersion}` → `document.save` 条件保存 |
| POST | `/api/close` | `{sessionId, viewId}` → 关闭视图（未保存则拒绝） |
| GET | `/api/document/disk` | `?sessionId&viewId` → 只读查看磁盘当前内容与版本（冲突恢复第一步） |
| POST | `/api/reload` | `{sessionId, viewId, discardDraft:true}` → 用磁盘内容覆盖会话；**缺 `discardDraft` 一律 409**，并回传 `previousDraft` |

**`status` 是权威结果，HTTP 状态码不是**：

| 场景 | HTTP | `status` |
|---|---|---|
| 保存成功 | 200 | `COMMITTED` |
| 版本冲突 | 409 | `CONFLICT` |
| 保存失败（如目标变成二进制） | 422 | `FAILED` |
| 结果未确认 | 202 | `UNKNOWN` |
| 关闭被未保存内容阻止 | 409 | `REJECTED` + `ERR_DOCUMENT_DIRTY` |
| 未经确认的重载 | 409 | `REJECTED` + `ERR_DOCUMENT_DIRTY` |
| 重载时磁盘不可读/已删除 | 404 | `REJECTED`（草稿保持） |
| **项目根已失效/被替换**（G0-R2） | 503 | `FAILED` / `REJECTED` + `ERR_ROOT_CHANGED` |
| **项目不可用**（G1，Multi） | 503 | `FAILED` / `REJECTED` + `ERR_PROJECT_UNAVAILABLE` |
| **Multi 缺 `projectId`** | 400 | `REJECTED` + `ERR_PROJECT_REQUIRED` |
| **未知 `projectId`** | 404 | `REJECTED` + `ERR_PROJECT_NOT_FOUND` |
| **未获授权的项目** | 403 | `REJECTED` + `ERR_PERMISSION_DENIED` |
| **会话已失效且项目仍不可用** | 409 / 503 | `REJECTED` + `ERR_SESSION_STALE` / `ERR_PROJECT_UNAVAILABLE` |
| **Multi 会话接口缺 `viewId`** | 400 | `REJECTED` + `ERR_COMMAND_INVALID` |
| **项目正在移除（屏障内）** | 409 | `REJECTED` + `ERR_PROJECT_QUIESCING` |
| **移除前置条件不满足 / 并发变更** | 409 | `REJECTED` + `ERR_PROJECT_BUSY` |
| **撤销结果待核对**（`REVOKE_UNKNOWN`） | 403 | `REJECTED` + `ERR_PROJECT_REVOKE_UNKNOWN`（草稿仍可读） |
| **已有选择器在弹窗中**（single-flight） | 409 | `REJECTED` + `ERR_PICKER_BUSY` |
| **该平台/环境没有可用选择器** | 501 | `REJECTED` + `ERR_PICKER_UNAVAILABLE` |
| **意图过期 / 已用 / 不存在，或 `requestId` 未知** | 410 | `REJECTED` + `ERR_INTENT_EXPIRED` / `ERR_INTENT_CONSUMED` / `ERR_INTENT_INVALID` / `ERR_PICK_REQUEST_GONE` |
| **输入不合法**（名称过长/含控制字符/缺必填） | 400 | `REJECTED` + `ERR_COMMAND_INVALID` |
| **目录当前读不出来**（UX-02B-TREE） | 403 | `REJECTED` + `ERR_DIR_UNREADABLE`（"无法读取此文件夹"） |
| **请求展开链接节点** | 400 | `REJECTED` + `ERR_DIR_IS_LINK` |

## 逐层文件树 `GET /api/tree`（UX-02B-TREE）

```http
GET /api/tree?projectId=project-a&dir=docs&cursor=200&limit=200
```

```jsonc
{
  "status": "APPLIED",
  "level": "docs",
  "entries": [
    { "id": "dir:project-a/docs/sub", "name": "sub", "kind": "folder", "extension": "", "relPath": "docs/sub" },
    { "id": "doc:project-a/docs/a.md", "name": "a.md", "kind": "file", "extension": ".md", "relPath": "docs/a.md" }
  ],
  "page": { "limit": 200, "cursor": "200", "nextCursor": "400", "total": 423 }
}
```

- **一次只取一层**。`dir` 是项目内相对路径（省略/空串 = 根）；不接受绝对路径、盘符、
  UNC、`..`/`.` 段、反斜杠、NUL、空段 → `400 ERR_COMMAND_INVALID`，零 IO。
- **分页不是截断**：`limit` 缺省 200、范围 1–2000，只是每页条数。只要还有剩余条目，
  `nextCursor` 就必须非 `null`；客户端继续请求直到 `nextCursor === null`，
  此时该层所有可枚举条目都已可见。`page.total` 是该层真实总数。
  排序是服务端全序（目录/链接在前 → `zh-Hans-CN` → 码点兜底），先排完再切片，
  因此分页不会漂移。
- **三种节点**：`folder` / `file` / `link`，id 分别是 `dir:` / `doc:` / `link:` 命名空间。
  文件类型不决定是否显示；不支持预览的格式照样列出，由 Shell 的能力注册表决定能否打开。
  空目录正常返回 `entries: []`；`link`（符号链接 / junction / 重解析点）只显示、不跟随，
  把 `dir` 指向它 → `400 ERR_DIR_IS_LINK`。
- **三态不得混淆**：目录读不出来 → `403 ERR_DIR_UNREADABLE`（环境事实）；
  项目未授权 → `403 ERR_PERMISSION_DENIED`（策略事实）；
  目录不存在/不是目录 → `404 ERR_RESOURCE_NOT_FOUND`。
  绝不把不可读渲染成空文件夹。
- **门禁与 `/api/resources` 一致**：项目存在与 READY（404/503）→ 项目级读授权（403）
  → 参数校验（400）→ `withDiskOp` 包裹（屏障期 409）→ `StorageProvider.readDir()` 单层读取。
  **不返回、不接受任何本机绝对路径**；响应也不含 `providerId` / `rootToken`。
- `/api/resources` 保持兼容且输出冻结（既有链路与测试依赖它），但 Shell 的树已迁移到本端点。


Multi 下项目级失败（根失效/会话失效）的 `/api/save` 响应**省略 `document.content`**：
只返回 `dirty` / `baseVersion` / `revision` / `stale` 等状态，避免把草稿正文复制进错误响应；
草稿正文仍可通过合法的 `/api/document?sessionId&viewId` 取回。

`UNKNOWN` 既不是成功也不是失败：不写收据、不自动重试，需人工核对磁盘。

**根连续性错误统一为 503**（`ERR_ROOT_CHANGED` / `ERR_ROOT_IDENTITY_UNSUPPORTED`），
覆盖 `/api/open`、`/api/save`、`/api/resources`、`/api/document/disk`、`/api/reload`。
未预期异常不再回传原始 `message`（Storage 的根错误消息含本机绝对路径）：
已知领域错误码按语义映射状态并使用固定文案，未知异常收敛为 `500 / ERR_COMMAND_INTERNAL / 内部错误`。
因此响应体中不会出现 `rootDir`、`canonicalRoot` 或任何盘符路径。

## 托管模式（UX-02B-01）

`createShellServer({ managed })` 把项目权威交给 `src/project-runtime.ts` 的 `ProjectRuntime`：
Registry 条目、Provider 表、Permission grants 与 `workspaceKey` 全由它持有，Host 只负责使用，
**不存在第二套项目表**。

- **CLI 入口**：UX-02B-01 落定时 `main.ts` 还没有这个参数；UX-02B-02 补上真实持久化，
  UX-02B-03 才接上 `--workspace-store <dir>`（与 `--workspace` 互斥）。托管模式下 Host
  自建 `FileProjectStore`，`workspaceKey` 按请求重新求值。
- `ProjectStore.durability === 'memory'` 时 `removeProject()` 直接拒绝，
  只有显式 `allowEphemeralRevocation: true`（仅测试）才执行。
- 项目级屏障：`QUIESCING` 期间所有 G-DISK 操作 409 `ERR_PROJECT_QUIESCING`；
  每个已准入操作计入 `activeDiskOps`，屏障 `drain` 到 0 后再由 Host 复检
  （活动 View / dirty / SAVING / OUTCOME_UNKNOWN / CONFLICT / FAILED）。
  复检不通过即 abort：Provider、grant、正文、revision 一律不动（状态精确回到进入前）。
- 撤销提交失败按**证据强度**分两支（ADR-022 §3.1.1）：
  - Store 显式声明 `commitState: 'not-committed'`（打开失败 / 0 字节写入）→ 零变更、
    回原状态、抛 `ERR_PERSIST_FAILED`，可安全重试；
  - `'unknown'` 或**未声明** → 不能把"报错"当成"没写"：立即收回 grant、释放 Provider、
    条目转 `REVOKE_UNKNOWN`，G-DISK 一律 403 `ERR_PROJECT_REVOKE_UNKNOWN`，
    且**不再接受第二次撤销**（否则会伪造第二条持久证据）。证据核对属于 UX-02B-02。
- `UNAVAILABLE` / `REVOKE_UNKNOWN` 的项目**仍占用**其注册时确认的根身份：
  同一路径、父目录、子目录都不得再注册成新项目（不自动恢复、不改写原始身份）。
- `workspaceKey` 在**每次** `/api/health` 时重算根身份：根被删除/替换后，即使没有
  请求过 `/api/projects` 或 `/api/resources`，也不会继续返回旧的 READY 摘要。
  Legacy 与静态 Multi 仍使用启动快照（行为不变）。
- 由显示名派生的 `projectId` 在追加序号后仍满足 `^[a-z0-9][a-z0-9_-]{0,31}$`
  （截断词干、保留完整序号），因此运行期签发的 id 一定能被下次启动的配置校验接受。
- **G-DRAFT 与 G-DISK 分离**：Multi 的 `GET /api/document` 与 `POST /api/close` 只凭
  actor + session + viewId，不查项目 grant —— 项目被撤销或根失效后，
  磁盘权限已收回，但用户仍可取回自己的内存草稿、关闭自己的视图；
  `POST /api/close` 的 dirty 保护保持不变。
  **Legacy 例外**：没有 viewId 绑定（viewId 非必填），`GET /api/document` 仍执行原有的
  `read` 授权判定，不放宽。
- 撤销只动内存与 Store：**不删除、不移动任何项目目录内容**。

## 存储 v2（UX-02B-02）

真实实现位于 `src/store/`（`io.ts` / `config.ts` / `revocation-log.ts` / `file-store.ts`）。
UX-02B-02 落盘时**尚未**开放任何 HTTP 变更端点；UX-02B-03 起，`--workspace-store <dir>`
可用，且只开放**一条**变更路径：`POST /api/projects/pick`（Host 自己弹目录选择器）。
网页仍然不能提交路径、不能改名、不能删除项目——见下文「目录选择与授权信任边界」。

存储目录中的文件：

| 文件 | 作用 |
|---|---|
| `workspace.json` | 配置 v2：`commitSeq` / `issuedIds` / `revoked[]` / `projects[].createdByOp` / `checksum` |
| `workspace.json.bak` | **上一版**配置（写新配置前复制），用于主文件损坏时回退 |
| `revocations.jsonl` | 撤销墓碑：`{seq, projectId, at, opId, prevHash, hash}`，首行为日志头，hash 链校验 |
| `workspace.lock` | 单实例锁（pid + host + startedAt + token）；陈旧锁可接管，正常关闭即释放 |

- **两种提交点**：添加/重命名 = 配置 `rename` 成功；移除 = 墓碑 `fsync` 成功。
  之后配置补写失败只返回 `configPersisted: false` 并 `DEGRADED`，**不回滚、不重新授权**。
- **写入结果不确定**：只有 `StoreIoError.committedBytes === 0`（打开失败 / 0 字节）才判
  "确认未写入"；否则一律读日志尾部核对——命中本次 `opId` → 视为已撤销；确认没有 → 未写入；
  日志断裂/不可读 → `RECOVERY_RESTRICTED`（全拒）。
- **加载判定**（撤销集合是否可证是唯一判据，配置 `checksum` 通过不代表可授权）：
  首次初始化 / 冷启动（`commitSeq === 0` 且无撤销）→ 正常；主配置损坏但日志完整 →
  回退 `.bak`，可读但禁变更；主配置与备份都损坏 → 空表 + 全拒；日志缺失且配置声称
  有变更历史 → 全拒；日志链断裂 → 全拒；墓碑领先配置一个序号 → 视为已知滞后，按墓碑补齐。
- **`opId` 查询**（`store.queryOp`）：只认 `createdByOp` / `revoked[].opId` / 可信墓碑行；
  证据缺失即 `unknown`，不按 `projectId` 是否存在推断。
### 授权与准入加固（UX-02B-02-R1）

- **全局拒盘**：`assertUsable` / `withDiskOp` 每次都重新读取 Store 的 `diskTrusted`；
  日志在运行期被删除/截断/断裂后，**所有**项目的 G-DISK 一律 503
  `ERR_STORE_RESTRICTED`，已发出的 grant 不能成为绕过门禁的路径；G-DRAFT 不受影响。
- **id 账本**：Runtime 启动时继承 `store.issuedIds()`（含已撤销），不再只从活动项目重建；
  重启后同名目录必然得到新 id。
- **写前复核**：add/rename/revoke 在提交前重新校验日志——缺失/断裂/空文件（且有历史事务）
  一律拒绝并进入 `RECOVERY_RESTRICTED`，绝不补写一条伪造的新链。
- **撤销提交点的证据强度（UX-02B-02-R2）**：`append + fsync` 抛错时不许把"日志里能看到
  本次 opId"当成已提交。
  - 确认零字节写入 → `ERR_PERSIST_FAILED`，零变更、可重试；
  - 行完整可读但同步未确认 → **只对同一文件重新 fsync**（绝不重复追加墓碑）：
    成功才算提交；仍失败 → `ERR_PROJECT_REVOKE_UNKNOWN`，该项目拒盘、保持
    `REVOKE_UNKNOWN`（不恢复 ACTIVE），Store 转 `DEGRADED` 并停止后续变更；
  - 日志无法读取（读 I/O 异常）/ 尾部损坏 / 日志消失 → 日志不可证，
    `RECOVERY_RESTRICTED` + 全部项目拒盘；读取失败**不得**当成"没有撤销"。
- **日志前缀对账（UX-02B-02-R2）**：`config.revoked[]` 的每一条都必须在日志里有
  `projectId + opId + seq` 完全对应的墓碑（不只比最大序号）；日志必须能被读到，
  且前缀只允许增长，
  运行期已确认的位置不得回退。任一不满足即 `RECOVERY_RESTRICTED`，不重建链、不覆盖证据。
  合法的"墓碑领先配置一个序号"仍然接受。
- **授权凭据**：只有 `grantSource === 'os-dialog'` 且 `grantedAt`/`canonicalRoot`/`rootToken`
  齐备、且与当前根身份一致的记录才发 G-DISK；缺失或 `unspecified` 一律 UNAVAILABLE。
  `grantSource` 是**逐次**写入的参数（`addProject({ ..., grantSource })`），不是进程级开关：
  UX-02B-03 起唯一能写 `'os-dialog'` 的地方是 `runPick()` 中 T3 选择器返回成功之后，
  其余所有 `addProject` 调用（启动加载、测试、内部接线）仍落到 `'unspecified'`。
- **加载期根独立性**：配置里的重复根/嵌套根按配置顺序只授权第一个，其余降级为
  UNAVAILABLE。
- **诚实的能力声明**：Windows 上 `fsync(文件)` + `rename` 只能做到"尽可能原子"，
  目录项无法 fsync，因此**不保证断电后 rename 一定可见**；单实例锁只防同机双写。
  上述两点是已知限制，不是"已保证"。

## 目录选择与授权信任边界（UX-02B-03）

托管模式（`--workspace-store <dir>`）下，添加项目的唯一路径是「Host 自己弹本机目录选择器」。
网页只能**发起意图**，永远不能提供路径。三个判定彼此独立，任何一项都不能替代另一项：

| 边界 | 证明什么 | **不**证明什么 | 实现位置 |
|---|---|---|---|
| **T1** 请求来源 | 请求来自本机 Host 的页面：回环绑定 + `Host` 白名单 + `Origin` / `Sec-Fetch-Site` + `X-WS-Token`（只存 SHA-256 摘要，`timingSafeEqual` 比对） | 任何目录授权 | `src/session-token.ts`、`handle()` 前段、`requireSessionToken()` |
| **T2** 意图一次性 | 这次「添加」意图没有被重放或并发使用：`intentId` 120s TTL、绑定 `actorId`、consume-once | 「人类真的点了按钮」 | `src/project-intents.ts`、`intents.claim()` |
| **T3** 人工目录确认 | 用户在本机对话框里选定的真实目录：`FolderPicker` 返回的路径 + `inspectProjectRoot()` 复核 | —— | `src/folder-picker/*`、`runPick()` |

链路顺序不可交换：`GET /api/session-token` → `POST /api/projects/pick`（T1 → T2）→
Host 进程内弹窗（T3）→ 根身份复核 → `ProjectRuntime.addProject` → Store 持久提交 → 授权生效。
任一步失败都不会产生 Provider 或 grant。

- **路径永不经过 HTTP**：`POST /api/projects/pick` 的请求体只接受 `requestId` / `intentId` / `name`。
  出现 `rootDir` / `root` / `path` / `directory` / `canonicalRoot` / `rootToken` / `grantSource` /
  `actorId` / `providerId` 任一字段即 400（这与 `/api/open` 的 `path` 是**项目内相对路径**不冲突，
  两条规则分开写就是为了不误伤后者）。响应体同样不回传选择到的绝对路径。
- **逐次授权来源**：`grantSource: 'os-dialog'` 只在 `runPick()` 中、T3 成功返回**之后**作为
  参数传给 `addProject()`；没有进程级开关，也没有第二个能写这个值的地方。
- **四态结果**：`picked` / `cancelled` / `unavailable` / `timeout`。后三者**零副作用**——
  不建项目、不写 Store、不发 grant。
- **串行**：同一时刻只允许一个对话框（否则 409 `ERR_PICKER_BUSY`）。`requestId` 记录只在
  内存，Host 重启后查询 → 410 `ERR_PICK_REQUEST_GONE`。
- **意图类失败统一 410**（过期 / 已用 / 不存在不加区分），避免把状态码变成探测面。
- **输入不合法是 400**：项目名为空 / 过长（>64）/ 含控制字符、缺必填参数，一律
  `400 ERR_COMMAND_INVALID`，零副作用（不建项目、不写配置、不发 grant）。同一个
  错误码在命令分派路径上也映射 400——不接受"同一个码因端点不同而给出两种状态"。
- **监听失败即释放锁**：`server.listen()` 失败（如 `EADDRINUSE`）时 `createShellServer()`
  先关闭本次自建的 `FileProjectStore`（只释放 `workspace.lock`）再抛错。否则调用方
  拿不到句柄去 `close()`，同进程换端口重试会被自己的锁挡住（`ERR_STORE_LOCKED`）。
  不删除配置、墓碑或项目文件，也不触碰其他进程/其他服务的监听。
- **写请求必须带 `Origin`**：浏览器对 POST 一律发送 `Origin`（含同源），缺失即 403；
  这与「Origin 可选」的通用规则不同，只对本端点生效。

选择器适配器（`src/folder-picker/`，由 `createHostFolderPicker()` 按平台分派）：

| 平台 / 环境 | 实现 | 行为 |
|---|---|---|
| Windows | `windows-powershell.ts` | `execFile` + 固定参数数组（`-NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -Command <常量脚本>`）+ `shell: false`，**无任何字符串插值**；退出码 0/1/2 → `picked` / `cancelled` / `unavailable` |
| 任意平台 + TTY | `stdin-prompt.ts` | 交互式提示读一行；`isTTY !== true` 即 `unavailable`。受 `timeoutMs` 约束：超时立即返回 `timeout` 并 abort（关闭 readline、移除输入监听器），迟到输入不再产生结果 |
| 非 TTY / 未支持平台 | `createUnavailablePicker()` | 恒定 `unavailable` → 501，**不猜测路径** |

Windows 路径以 Base64 回传（避免编码/换行污染），解码失败一律 `unavailable`，不做启发式补救。

## 安全边界

- **绑定地址**：只接受 `127.0.0.1` / `::1` / `localhost`；`0.0.0.0`、`::`、`192.168.x.x` 等
  在**创建监听之前**直接抛 `ERR_PERMISSION_DENIED`。请求侧 Host 检查不能替代绑定限制。
- **Host**：必须是 `127.0.0.1[:port]` / `localhost[:port]` / `[::1][:port]`，其余 403（防 DNS rebinding）。
- **Origin**：写请求若带 `Origin`，必须在白名单内（缺省为同源 + `127.0.0.1:5178`）；`Sec-Fetch-Site` 为 `cross-site` 一律拒绝。
- **CORS**：不发送任何 `Access-Control-Allow-Origin`，跨源页面无法直接调用。
- **方法**：只接受 `GET` / `POST`，其余 405；`OPTIONS` 不放行（不需要预检）。
- **请求体**：必须 `application/json`，上限 1 MiB。
- **身份**：`actorId` 由服务端固定绑定；请求体出现 `actorId` / `rootDir` / 非 `local` 的 `providerId` 直接拒绝。
- **不暴露**：没有静态文件服务、没有裸 `StorageProvider`、没有「传路径就读写」的接口；
  所有读写都经 `CommandBus` + `PermissionService`，路径边界由 S4 的 storage 强制。

## 与 Core 的关系

```
HTTP ─→ 参数校验/规范化 ─→ CommandBus.dispatch(actorId 固定)
                                   │
                     PermissionService（按实际资源授权）
                                   │
                     DocumentService（会话/revision/baseVersion）
                                   │
                     StorageProvider（S4 路径边界 + S5 文本安全）
```

## 已知限制

1. 单进程内存会话：服务重启后会话丢失（磁盘内容不受影响）。
2. 无 `discard` 契约：关闭有未保存修改的最后一个视图会被拒绝，不提供强制丢弃。
3. 会话在最后一个视图关闭后仍留在内存（Core 既有行为），重开复用同一会话。
4. 只服务文本文件（`md/markdown/txt`）；二进制不进树、也不能被文本接口覆盖。
5. 未实现多用户/鉴权体系：`actorId` 固定为本地用户，服务只在回环地址可用。
