# command（P0 探针）

## 职责
唯一变更入口：信封校验 → 幂等查收据 → 授权门禁 → 处理 → 审计。UI 与 AI 走同一条路径（docs/07、ADR-005）。

## 公开接口（`index.ts`）
- `createCommandBus({ document, permission, resolveProvider, resolveSerializer?, logger? })` → `CommandBus`
- `dispatch(envelope, ctx{actorId, traceId?, operationId?})` → `CommandDispatchOutcome`
- `getResult(idempotencyKey, actorId?)` / `receiptCount()`（无 actorId 一律不返回，S8-07）
  - **限制**：`actorId` 只能来自可信调用上下文。当前没有 Gateway，本方法**无法**自行验证
    调用者身份；若把不可信输入直接当作 `actorId` 传入，隔离即失效。
- `validateEnvelope(envelope)` → `EnvelopeViolation[]`

## 已支持命令（探针范围）
| type | 动作 | 需要 expectedVersion |
|---|---|---|
| `document.open` | 打开视图（read 授权） | 否 |
| `document.applyEdit` | 修改会话缓冲（write 授权） | 是 |
| `document.save` | 条件保存（write 授权） | 是 |

## 判定顺序（S8 之后）
1. 信封非法 → `REJECTED / ERR_COMMAND_INVALID`
2. `commandId` 重复 → `REJECTED`
3. 未知命令 → `REJECTED / ERR_COMMAND_UNSUPPORTED`
4. 写命令缺 `expectedVersion` → `REJECTED / ERR_COMMAND_INVALID`
5. **解析实际目标**（S8-02）：target 与 payload 声明必须一致；`open` 需 `path`；
   `save/applyEdit` 由 `sessionId` 取会话的真实身份，`payload.path` / `target.resourceId`
   若提供必须与会话一致，否则 `REJECTED / ERR_COMMAND_INVALID`
6. `idempotencyKey` 命中 → 校验**语义指纹**一致后再**重新授权**，通过才返回原收据
   （`deduplicated: true`）；授权已撤销 → `REJECTED`，不返回旧结果。
   指纹 = 命令类型 + 读写方向 + Provider + 资源 + 会话 + 本次语义：
   `applyEdit` 含 `expectedVersion` 与 `buffer` 的 SHA-256；`save` 含 `expectedVersion`、
   `serializerId` 与待保存缓冲的 SHA-256。只存哈希，不存原文；`commandId` 不参与指纹。
7. 授权：对**实际资源**判定（会话绑定的 path + providerId）→ 拒绝即 `REJECTED / ERR_PERMISSION_DENIED`
8. 执行：`APPLIED / REJECTED / FAILED / UNKNOWN`

## 资源身份（S8）
- `document.open` 命中已有 `resourceId` 时，若 Provider 身份或规范路径不一致，
  直接 `REJECTED / ERR_RESOURCE_IDENTITY_CONFLICT`，不隐式复用、不隐式重绑定。
- 审计字段记录**实际** `resourceId` 与 `resourcePath/providerId`；身份冲突拒绝额外记录
  `claimedResourceId` / `claimedPath` 与 `verifiedPath`。
- `sessionId` 只是定位标识，不是访问凭证；`getResult` 按 actor 隔离。
- `resolveProvider(providerId)` 返回的 Provider 必须与会话创建时绑定的存储根一致
  （同 `providerId` 不同根 → `REJECTED / ERR_RESOURCE_IDENTITY_CONFLICT`）；
  显式声明错误的 `providerId` → `REJECTED / ERR_COMMAND_INVALID`（F01）。

## 已知限制
1. 收据仅内存保存，重启后幂等去重失效（RSK-08，待 ADR）。
2. `UNKNOWN` 不入收据、不自动重放，需经 `document.reconcile`。
3. 无任务调度、无 `dryRun`、无批量/多文件提交（PARTIAL/UNKNOWN 编排未实现）。
4. 无 Gateway 身份绑定实现：`actorId` 由调用方在 ctx 传入。
5. **「会话不存在」的状态码不统一**（P0 遗留，已由 CONTRACT-06/07 固定）：
   `document.save` 返回 `REJECTED`，`document.applyEdit` 返回 `FAILED`；统一需 ADR。
6. `resourceId` 缺省时按 `derived:<providerId>:<path>` 派生，路径写法不同（`./a.md` 与 `a.md`）
   会派生出不同标识；显式 resourceId 由上层资源登记表负责唯一性。
7. 收据的重放判定依赖当前权限：授权变更后旧收据不再可用（这是刻意的安全取舍）。
8. 幂等指纹含内容哈希，因此「同一幂等键 + 已变化的缓冲/版本/序列化器」按**新请求**处理并被拒绝；
   客户端需为新语义分配新的 `idempotencyKey`（旧行为已被安全要求收紧）。

## 测试入口
`node tests/run-all.ts`（套件 `command-idempotency`、`permission-unauthorized`、`command-validation`、`s8-resource-identity`）。
