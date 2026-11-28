# UI-F03-B3：ViewInstance 与 DocumentSession 分离

**状态**：已实现（等待独立复审）
**前置**：UI-F03-A-R4（`1cfd48d`）、UI-F03-B1（`22dd831`）、UI-F03-B2（`ad50b5e`）
**本轮基线**：`ad50b5ed9145ab45d2f2c36a1997467d15f96f6b`

---

## 1. 要解决的问题

B2 把"组"建成了真身份（`LayoutTree → ViewGroup → DocTab`），但同一份 `DocTab`
只有一个 `viewId`。当左右两个窗格显示同一份文档时：

- 两个组共用**同一个 Host View** —— 关左边，右边跟着失效；
- 关标签只关掉一个 View，另一个继续在 Host 里活动，Shell 以为关了；
- Host 的"项目还有活动编辑会话"门禁因此永久拦住改名/移动。

这不是"UI 少画了一个窗格"，而是状态模型缺一层：文档与会话是**一份**，视图必须是**多份**。

## 2. Host 的真实契约（实测，不是假设）

| 项 | 结论 | 依据 |
|---|---|---|
| 同 `resourceId` 多次 `openSession` | **同一个** `sessionId`；每次生成**新的** `viewId`；`session.views` 是 `Set` | `packages/document/document-service.ts:331-458` |
| 缓冲 / revision / dirty | 全在 `Session` 上，与视图数量无关 | 同上 `applyEdit` / `save` |
| `closeView(viewId)` | 只移除**这一个**视图；仅当 `views.size <= 1 && dirty` 时拒绝（`protectedDirty`） | 同上 `460-484` |
| `/api/close` | 必带 `sessionId + viewId`，先 `requireView(sessionId, viewId)` 核验归属 | `apps/server/src/server.ts:4080` |
| `/api/open` 的 `reclaimPrevious` | 只有**页面恢复**才传；它按 `clientInstanceId + actor + session + resource` 四连回收旧 View | 同上 `3820-3862` |
| Demo 客户端 | `viewId = demo-view:${id}`（**确定性**），`closeDocument` 是空操作 | `apps/shell/src/client/client-api.ts:2632` |

结论：**Host 早已支持"一会话多视图"**，缺的只是 Shell 的记账。Demo 无法提供两个不同的
`viewId`，因此模型只要求"不共用同一个非空 hostViewId"，不要求 Demo 也有两个。

## 3. 数据模型

```
LayoutTree（哪些组在什么位置）
  → PaneNode.groupId
    → ViewGroupState { viewInstanceIds, activeViewInstanceId, mode }
      → ViewInstanceState { viewInstanceId, docId, groupId, hostViewId }
        → DocTab（共享 DocumentSession：buffer / sessionId / baseVersion / revision / dirty）
```

- `tabs` 保留原名但语义收紧为**文档记录**：每个文档一份，绝不为第二个视图复制。
- `DocTab.viewId` 保留为**兼容投影**（该文档最初打开时的 Host View），文档级操作
  （edit / save / readDisk / reload）只需要"一个属于这个会话的有效 View"，因此可以用它；
  **关闭**绝不使用它——关闭走实例。
- 实例身份由调用方注入（`viewInstanceIdOf(groupId, docId)`），模块内无随机数、无时间戳。

### 不变量（`viewInstanceProblems` / `viewGroupProblems` 检查，测试逐条钉住）

1. 键与 `viewInstanceId` 一致；`docId` 非空；`hostViewId` 只能是 `null` 或非空串。
2. **两个实例不得共享同一个非空 `hostViewId`** —— 这条就是本轮消灭的缺陷本身。
3. 同一 (组, 文档) 最多一个实例。
4. 组内实例不重复；活动实例必须属于本组；每个引用都指向真实存在的实例与文档。
5. 组的活动实例必须可见（休眠组拿不到焦点）；`panes` 是投影，不是第二真相。

## 4. ADR：后台 / 迟到响应的 Host View 怎么办

**问题**：异步打开在 Host 里建了 View，响应回来时用户已经切走。若 Shell 不记账，
那个 View 就成了孤儿——它会永久把"该项目还有活动编辑会话"顶在门禁上。

两种安全处理：

- **A. 保留为 ViewInstance**（记录在案、可关闭、可被回收的 keep 列表保护）；
- **B. 立刻释放该 View，只保留文档记录**（下次需要时重新 open）。

**决定：采用 A，并按"发起时的目标组"分组；只有连目标组都没有时才未分组。**

理由：
1. B 释放后会留下"文档开着、但没有 Host View"的中间态，编辑/保存必须再开一次视图，
   等于把一次失败重试藏进用户的下一次输入；而 A 的状态是自洽的（有记录就有主）。
2. A 让"项目还有活动 View"的计数与 Shell 的认知一致，改名/移动门禁不会因为
   "幽灵视图"被永久拦住。
3. 分组归属用**发起时**的 `targetGroupId`，不是响应回来时的 `focusedGroupId`：
   用户切走了，文档仍然落回他当初指的那一格，只是**不激活**——显示不被抢走。

复现路径（`tests/suites/116` B3-E03）：请求期间切组 → 实例记录在发起组、
`activeViewInstanceId` 不变；B3-E01（同文档并发向两组打开）→ 两个 Host View、
一条会话。

## 5. 关闭语义

- **关一格**（`CLOSE_VIEW_INSTANCE`）：只关它的 `hostViewId`，只从它所属组里摘掉；
  若这是该文档的最后一个实例，文档记录一并清理（没有视图的文档记录只会变成幽灵标签）。
- **关标签**（全局标签栏 `closeTab(docId)`）：关闭该文档在**所有**组里的实例。
  逐个关闭、逐个摘除：
  - 先关掉的那些，Host 与 Shell 同时消失；
  - 被 Host 拒绝的那一格（最后一个脏视图）原样保留，**不回滚**已关的，也不删状态；
  - 因此不存在"Shell 以为全关了、Host 还留着一个"的分叉。
- 最后一个脏视图的 `ERR_DOCUMENT_DIRTY` 是结论，不是可重试的错误。

## 6. V1 恢复兼容（不升级协议）

- `PERSIST_VERSION` 仍为 1，`PersistedPane.tabIndex/mode` 不变，本地存储键不变。
- 每个恢复出来的视图各自获得一个 `ViewInstance`。
- **两个 Pane 指向同一 `docId`** 时：先让 Host 真开第二个 Window
  （`openViewInGroup`），拿到的 `viewId` 记在第二个实例上；开不出来就退化为
  `hostViewId: null`（显示正确、没有第二个 Host View），**绝不复制**第一个 viewId。
- **B2-R2（休眠 secondary）**：单视图快照里 `panes.secondary.tabIndex` 可能是非空的
  （那是合并前留在右窗格的东西）。既然 V1 已经写下来了，恢复时把它放回**休眠组**：
  不可见、拿不到焦点，但重新分屏时原样回来。没有新增任何持久化字段。

## 7. 已知限制

1. `DocTab.viewId` 仍存在（兼容投影）。所有关闭路径已改为走实例；但它是"可以误用"的
   字段，B4 接多窗格 UI 时应移除，改为 selector。
2. ViewGroup 仍只映射两个保留身份（`legacy-group:primary` / `secondary`），
   更多组的旧 UI 表达尚未定义。
3. 同文件的两个 View 共享同一个 `DocumentSession`：滚动位置、光标等**视图局部状态**
   仍由组件自己管，没有进状态模型。
4. Demo 模式没有真实 View 生命周期，"两个视图"在 Demo 下只是两条记录。
5. 未做浏览器验证（本轮不接 UI）。
