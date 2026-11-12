# document（P0 探针）

## 职责
同一 Resource 的**唯一权威编辑会话**：编辑缓冲、dirty、版本基线、条件保存、冲突与 UNKNOWN 结果、reconcile。

## 公开接口（`index.ts`）
- `createDocumentService({ logger?, clock? })` → `DocumentService`
- `openSession({ resourceId, path, provider })` → `ViewHandle`（同一 resourceId 复用同一 Session，但必须先通过身份校验）
- `closeView(viewId)` → `{ closed, protectedDirty }`
- `applyEdit(sessionId, buffer)` / `getBuffer(sessionId)` / `getSession*`
- `save(sessionId, serializer)` → `SaveResult`
- `reconcile(sessionId, serializer)` → `APPLIED | NOT_APPLIED | UNKNOWN`
- `detectExternalChange(sessionId)` / `drainEvents()`

## 重开与冲突恢复（S9-B 补正）

- **重开时校验磁盘（A）**：复用的会话只要**不是 dirty**，`openSession` 就重新读取磁盘；
  版本不一致就用磁盘内容刷新 `buffer`/`baseVersion`，并在 `ViewHandle.reloaded` 上标注。
  否则用户会拿着旧版本去保存，必然 CONFLICT。
  这里刻意不看「有没有视图」：页面刷新/崩溃会留下无人认领的旧视图，若因此跳过刷新，
  缺陷会以另一种形式复现。
- **dirty 时绝不刷新（B）**：不能用磁盘内容覆盖正在编辑的草稿。
- **读取错误必须分类（F01）**：只有「从未存在的新文件」（`baseVersion === null` 且
  `ERR_RESOURCE_NOT_FOUND`）可以按空会话继续；文件被删除、权限/路径/IO/编码错误
  一律原样抛出，且不增加视图、不改 `buffer`/`baseVersion`/`revision`。
- **读盘前后核对代次（F02）**：`await` 前记录 `revision`/`baseVersion`/`dirty`，
  回来若发现被编辑、基线变化或转 dirty，就放弃这次回填，避免旧磁盘内容覆盖新草稿。
- **显式重载（C）**：`reload(sessionId, { discardDirty: true })` 用磁盘内容覆盖会话，
  返回 `previousContent` 供调用方备份；未传 `discardDirty` 且会话 dirty 时抛
  `ERR_DOCUMENT_DIRTY`。Core 不会自行丢弃草稿，也不会用空内容伪装成功。
- 重载后 `revision` 递增、`dirty=false`、`state=CLEAN`，后续编辑与条件保存恢复正常（D）。

## 资源身份绑定（S8-01）
`Session` 在创建时固定 `providerScope`（providerId + 规范根目录）与 `resourceKey`（规范相对路径）。
`openSession` 命中已有 `resourceId` 时必须两者都一致，否则抛
`ERR_RESOURCE_IDENTITY_CONFLICT`——**不隐式复用、不隐式重绑定**；相同资源的多视图共享不变。

只读身份查询（供 CommandBus 在授权前判断，不暴露 Provider 对象或缓冲）：
- `identityFor({ resourceId, path, provider })` → `{status:'none'|'match'|'conflict', ...}`
- `inspectSession(sessionId)` → `SessionIdentity`
- `matchesSessionPath(sessionId, candidatePath)` → `boolean`

**可信边界**：`getBuffer/applyEdit/save/reconcile` 是可信内部 API；未授权调用方必须经
CommandBus（每次操作按实际资源重新授权）。`sessionId` / `viewId` 都不是访问凭证（S8-04）。

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
3. 无 `watch`；外部变更需主动 `detectExternalChange`。已建立基线（`baseVersion` 非空）的文件
   消失时 `changed` 为 `true`；从未存在的新建会话仍为 `false`（S8-06）。
4. 编码安全在 storage 侧强制（S5）：非 UTF-8 / 二进制内容不会进入会话；
   `openSession` 只在「真正不存在」时创建空会话，**路径安全拒绝与编码/权限/IO 失败一律抛出**，
   不产生空会话（F01）。
5. 插件序列化器仍由调用方提供；核心只保证「文本可无损往返」，不解释具体格式。
6. **序列化异常的状态收敛（F02）**：`Serializer` 抛异常时按 `FAILED / ERR_SAVE_FAILED` 结束、
   保持 dirty 与原始 `baseVersion`（写请求未交给 Provider）；若写请求已交给 Provider 而抛出，
   则保守报 `UNKNOWN / ERR_OUTCOME_UNKNOWN`；`reconcile` 中序列化失败返回 `UNKNOWN`，不抛异常。

## 测试入口
`node tests/run-all.ts`（套件 `session-shared`、`save-conflict`、`save-failure`、`dirty-protection`、`s5-encoding-integrity`）。
