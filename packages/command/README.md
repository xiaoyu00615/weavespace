# command（P0 探针）

## 职责
唯一变更入口：信封校验 → 幂等查收据 → 授权门禁 → 处理 → 审计。UI 与 AI 走同一条路径（docs/07、ADR-005）。

## 公开接口（`index.ts`）
- `createCommandBus({ document, permission, resolveProvider, resolveSerializer?, logger? })` → `CommandBus`
- `dispatch(envelope, ctx{actorId, traceId?, operationId?})` → `CommandDispatchOutcome`
- `getResult(idempotencyKey)` / `receiptCount()`
- `validateEnvelope(envelope)` → `EnvelopeViolation[]`

## 已支持命令（探针范围）
| type | 动作 | 需要 expectedVersion |
|---|---|---|
| `document.open` | 打开视图（read 授权） | 否 |
| `document.applyEdit` | 修改会话缓冲（write 授权） | 是 |
| `document.save` | 条件保存（write 授权） | 是 |

## 判定顺序
1. 信封非法 → `REJECTED / ERR_COMMAND_INVALID`
2. `commandId` 重复 → `REJECTED`
3. `idempotencyKey` 命中 → 返回原收据（`deduplicated: true`），无副作用
4. 未知命令 → `REJECTED / ERR_COMMAND_UNSUPPORTED`
5. 写命令缺 `expectedVersion` → `REJECTED / ERR_COMMAND_INVALID`
6. 授权拒绝 → `REJECTED / ERR_PERMISSION_DENIED`（并写审计）
7. 执行：`APPLIED / REJECTED / FAILED / UNKNOWN`

## 已知限制
1. 收据仅内存保存，重启后幂等去重失效（RSK-08，待 ADR）。
2. `UNKNOWN` 不入收据、不自动重放，需经 `document.reconcile`。
3. 无任务调度、无 `dryRun`、无批量/多文件提交（PARTIAL/UNKNOWN 编排未实现）。
4. 无 Gateway 身份绑定实现：`actorId` 由调用方在 ctx 传入。

## 测试入口
`node tests/run-all.ts`（套件 `command-idempotency`、`permission-unauthorized`、`command-validation`）。
