# apps/server — localhost Client API（S9-B / G1）

浏览器与 Core 之间的**唯一**本机通道。浏览器不接触文件系统，也不能选择磁盘目录。

## 启动

```bash
# 仓库根 —— 两种互斥模式
node apps/server/src/main.ts <项目根目录> [端口]                    # Legacy 单项目
node apps/server/src/main.ts --workspace <workspace.json> [端口]    # Multi 多项目
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
| `<port> --workspace <file>` | Multi（端口可写在选项前） |
| `--workspace <file> <port>` | Multi |
| 无参数 | `ERR_STARTUP_NO_TARGET` + 用法 |
| `--workspace` 缺值 / 空值 / 后面跟着另一个选项 | `ERR_STARTUP_WORKSPACE_MISSING_VALUE` |
| 同时给项目根与 `--workspace`、重复指定 `--workspace`、Multi 下多个位置参数 | `ERR_STARTUP_MODE_CONFLICT` |
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
| GET | `/api/resources` | 授权范围内的可编辑文本文件树；Legacy 无需参数，Multi 必须 `?projectId=` |
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

- **没有 CLI 入口**：`main.ts` 不提供该参数，托管模式只能由测试/内部接线注入；
  真实持久化（配置 v2 / 墓碑 / 崩溃恢复）属于 UX-02B-02，在那之前不存在生产可达的撤销路径。
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
**本轮不暴露任何 HTTP 变更端点，也不接 `--workspace-store` 启动参数**——没有本机选择器
（ADR-021 T3）之前，动态添加项目不得对网页开放；Store 目前只由内部接线与测试构造。

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
- **诚实的能力声明**：Windows 上 `fsync(文件)` + `rename` 只能做到"尽可能原子"，
  目录项无法 fsync，因此**不保证断电后 rename 一定可见**；单实例锁只防同机双写。
  上述两点是已知限制，不是"已保证"。

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
