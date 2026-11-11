# permission（P0 探针）

## 职责
统一授权判定：actor × action × 资源范围。默认拒绝。

## 公开接口（`index.ts`）
- `createPermissionService({ grants })` → `PermissionService`
- `service.authorize({ actorId, action: 'read' | 'write', resourcePath })` → `AuthDecision`
- `service.grant(actorId, action, scope)` / `service.revoke(...)`

## 范围语法（探针草案，ADR 待定：docs/18 RSK-10）
| 写法 | 含义 |
|---|---|
| `''` | 整个项目 |
| `docs` | 前缀目录（按路径段匹配，`docsx` 不匹配） |
| `docs/a.md` | 单文件 |

## 数据所有权
只拥有「授权决策」这一判断，不拥有身份凭据。`actorId` 必须由 Gateway 绑定后传入，不接受客户端自述（docs/04、docs/18 RSK-04）。

## 失败路径
- 未授权 actor → `{ allowed: false, errorCode: 'ERR_PERMISSION_DENIED' }`
- 空 actorId → 同上（不把匿名当作可信）
- 插件 manifest 声明权限 ≠ 已授权（manifest 与 grants 是两套事实）。

## 已知限制
1. 无 TTL、无撤销传播、无审计持久化（由 command/observability 侧记录）。
2. 不校验资源是否存在；路径规范化由 storage 负责。
3. 无 LAN/多用户模型。

## 测试入口
`node tests/run-all.ts`（套件 `permission-unauthorized`）。
