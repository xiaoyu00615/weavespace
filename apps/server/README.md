# apps/server — localhost Client API（S9-B）

浏览器与 Core 之间的**唯一**本机通道。浏览器不接触文件系统，也不能选择磁盘目录。

## 启动

```bash
# 仓库根
node apps/server/src/main.ts <项目根目录> [端口]     # 或 npm run start:server -- <项目根目录>
```

- 只绑定 `127.0.0.1`；端口默认 `5177`。
- 项目根**只能**来自启动参数 / `WS_PROJECT_ROOT`，请求无法指定。
- 页面通过 Vite 同源代理访问：`apps/shell` 的 dev server 把 `/api` 转发到本服务，
  因此浏览器侧始终同源，不需要任何 CORS 头。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查，返回当前服务根（仅本机可见） |
| GET | `/api/resources` | 授权范围内的可编辑文本文件树（`md/markdown/txt`） |
| POST | `/api/open` | `{path}` → 经 CommandBus `document.open` 建立会话，返回正文与版本 |
| GET | `/api/document` | `?sessionId&viewId` → 按会话实际资源重新授权后读取正文 |
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

`UNKNOWN` 既不是成功也不是失败：不写收据、不自动重试，需人工核对磁盘。

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
