# document（P0 探针）

## 职责
同一 Resource 的**唯一权威编辑会话**：编辑缓冲、dirty、版本基线、条件保存、冲突与 UNKNOWN 结果、reconcile。

## 公开接口（`index.ts`）
- `createDocumentService({ logger?, clock? })` → `DocumentService`
- `openSession({ resourceId, path, provider })` → `ViewHandle`（同一 resourceId 复用同一 Session）
- `closeView(viewId)` → `{ closed, protectedDirty }`
- `applyEdit(sessionId, buffer)` / `getBuffer(sessionId)` / `getSession*`
- `save(sessionId, serializer)` → `SaveResult`
- `reconcile(sessionId, serializer)` → `APPLIED | NOT_APPLIED | UNKNOWN`
- `detectExternalChange(sessionId)` / `drainEvents()`

## 数据所有权
Session 是不可重建状态：未保存缓冲绝不能被静默丢弃（DATA-002）。磁盘字节仍归 storage；编码格式归插件。

## 失败路径
| 情形 | 会话状态 | dirty |
|---|---|---|
| 版本冲突 | `CONFLICT` | 保持 true |
| IO 失败 | `FAILED` | 保持 true |
| 已落盘但确认丢失 | `OUTCOME_UNKNOWN` | 保持 true，需 `reconcile` |
| 关闭最后一个视图且有未保存内容 | 不变 | 拒绝关闭，`ERR_DOCUMENT_DIRTY` |

## 已知限制
1. 会话仅存于内存；进程退出后缓冲不保留（恢复区未实现，docs/06「恢复策略」）。
2. `reconcile` 以**字节级 contentVersion**（序列化结果的 UTF-8 字节 SHA-256）与磁盘比较判定
   APPLIED，不再比较解码后的文本；无法读取或无法确认时保持 `UNKNOWN`。
3. 无 `watch`；外部变更需主动 `detectExternalChange`。
4. 编码安全在 storage 侧强制（S5）：非 UTF-8 / 二进制内容不会进入会话；
   `openSession` 只在「真正不存在」时创建空会话，**路径安全拒绝与编码/权限/IO 失败一律抛出**，
   不产生空会话（F01）。
5. 插件序列化器仍由调用方提供；核心只保证「文本可无损往返」，不解释具体格式。
6. **序列化异常的状态收敛（F02）**：`Serializer` 抛异常时按 `FAILED / ERR_SAVE_FAILED` 结束、
   保持 dirty 与原始 `baseVersion`（写请求未交给 Provider）；若写请求已交给 Provider 而抛出，
   则保守报 `UNKNOWN / ERR_OUTCOME_UNKNOWN`；`reconcile` 中序列化失败返回 `UNKNOWN`，不抛异常。

## 测试入口
`node tests/run-all.ts`（套件 `session-shared`、`save-conflict`、`save-failure`、`dirty-protection`、`s5-encoding-integrity`）。
