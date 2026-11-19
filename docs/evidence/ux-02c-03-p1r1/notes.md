# UX-02C-03-P1-R1 · 定点修复说明

基线 `a36eb928`（P1 交付），本轮只修独立复审的 P1-A / P1-B / P1-C，
外加与它们直接相关的"隐藏元数据刷新失败"提示（R1-04）。**未**开发 UX-02C-03-P2。

## 1. 三项缺陷的根因与修复点

### R1-01 `hiddenCount` 装载断链（P1-A）

根因：Host 每个分页都返回 `page.hiddenCount`，`client-api` 也解析了，但
`TREE_LEVEL_PAGE` 这个 action **没有该字段**：

- `apps/shell/src/state/tree-load.ts:310`（逐层加载）
- `apps/shell/src/state/workspace-load.ts:186`（首次加载根层）
- `apps/shell/src/state/workspace-load.ts:313`（刷新项目根层）
- `apps/shell/src/state/refresh-project.ts:180`（Legacy 刷新）

四处派发都不带它 → `workspace-reducer.ts:501` 调 `applyPage` 时也没有 →
`tree-model.ts:163` 的 `page.hiddenCount ?? previous.hiddenCount` 永远取到初值 0 →
`TreeToolbar` 的徽标永不渲染。

修复：

- `types.ts`：`TREE_LEVEL_PAGE` 增加 `hiddenCount?: number`，并写明
  **`undefined`（旧版服务端/未提供）与真实的 `0` 必须区别处理**。
- 上述四处派发全部传 `outcome.page.hiddenCount`。
- `workspace-reducer.ts`：原样交给 `applyPage`。
- `tree-model.ts`：`typeof page.hiddenCount === 'number' ? … : previous.hiddenCount`。
- `client-api.ts`：旧版服务端不返回该字段时**不再伪造成 0**（保持缺失）。
- 新增纯函数 `countHiddenInLoadedLevels(levels)`，`TreeToolbar` 改用它，并把
  口径写进 title / aria-label：**已加载目录层合计，未展开目录不计入**。
  这样既不会把"某层"说成"全项目"，也不会为了凑总数去递归扫描磁盘。

### R1-02 rebound 对象被保存"重新绑定"（P1-B）

根因：保存是"临时文件 + rename"，必然换 inode；旧实现保存后读一次同路径
`identityOf()` 就回写记录 —— 等于"现在谁占着这个路径，谁就是用户当初隐藏的对象"。
记录已是 `rebound`（同名新对象）时，用户打开新对象保存，就被旧记录吞掉，
与 `apps/server/src/hidden.ts` 里"绝不隐藏新对象"的书面承诺矛盾。

修复（三份证据，缺一不可，判定集中在 `apps/server/src/hidden-refresh.ts`）：

1. **保存前**（`server.ts#prepareHiddenRefresh`）：记录存在、`rootToken` 一致、
   路径上的身份仍等于记录身份（否则 `rebound`/`missing`/`pre-read-failed` 直接跳过）；
2. **提交侧**：`SaveResult.identity`——Provider 在 rename **之前**对临时文件取
   `lstat`（`packages/storage/local-provider.ts#writeEstablished`）。这是唯一能
   证明"路径上这个对象是本次写入产生的"的证据；
3. **保存后**：路径身份必须正好等于 `SaveResult.identity`，否则
   `post-mismatch`（提交后被外部替换）→ 跳过。

判定为 `update` 时才做 update-only CAS；其余一律跳过并记诊断。
正文保存的成功/冲突/失败语义完全未改（响应仍是 200/409/202/422）。

> Provider 能力限制（如实记录）：`SaveResult` 原本只有 `contentVersion`（内容哈希），
> **无法证明提交对象的身份**。本轮给 `LocalProvider` 增加了 rename 前的临时文件身份，
> 因此托管模式（隐藏记录唯一存在的模式）可以证明；不提供该字段的 Provider 一律跳过，
> 绝不用"保存后的同路径身份"顶替。

### R1-03 保存与取消隐藏的竞争（P1-C）

根因：刷新走的是 `commitHidden({hidden:true})`，它在"记录已不存在"时**追加**。
用户在刷新等待期间取消隐藏，迟到的刷新会把记录重新创建出来。

修复：`FileProjectStore.commitHiddenUpdate()`（`store/file-store.ts`）——update-only + CAS：

| 情况 | 结果 | 副作用 |
| --- | --- | --- |
| 记录不存在（用户取消隐藏） | `skipped-missing` | 零写入，**绝不创建** |
| 记录 `rootToken` 不同 | `skipped-conflict` | 零写入 |
| 记录身份 ≠ 调用方预期旧身份（取消后又重新隐藏） | `skipped-conflict` | 零写入，新记录保留 |
| 身份已等于新值 | `unchanged` | 不写盘、不推进 `commitSeq` |
| 其余 | `updated` | 原子写（tmp→fsync→备份→rename），`commitSeq + 1` |

提交块内无 `await`（`StoreIo` 是同步端口），因此与其它配置提交之间不存在
"读旧值—写新值"的交错；不引入新锁。写失败抛 `ERR_PERSIST_FAILED`，内存投影不变。

### R1-04 保存成功但元数据刷新失败

- 诊断事件：`createShellServer({ diagnostics })`，事件形如
  `{ type:'hidden-refresh', projectId, path, result, reason }`（只有相对路径）。
  缺省写 stderr 单行；测试注入收集器。
- 保存响应新增 `hiddenRefresh: 'none'|'refreshed'|'skipped'|'failed'` 与
  `hiddenRefreshReason`；**不改变** `status`。
- Shell：只有 `skipped`/`failed` 时在既有状态栏提示里追加一句
  "已保存到磁盘；该文件的隐藏记录未能更新（文件会重新显示，可在「显示隐藏项」中核对）"，
  不新增弹窗、不自动重试。

## 2. 测试

新增套件 `tests/suites/86-s11ux02c03p1r1-visibility-fixes.test.ts`（17 例）：

| 用例 | 覆盖 |
| --- | --- |
| R1-01a | 真实 HTTP → client → tree-load → reducer → 层表 → 工具栏计数 = 1 |
| R1-01b | 切换"显示隐藏项"后计数仍 1，条目标记 `hidden` |
| R1-01c | 展开子目录：每层各自计数，合计 = 各层之和（口径不是全项目） |
| R1-01d | 分页续页不重置、不累加计数 |
| R1-01e | `0` 与"字段缺失"区别处理 |
| R1-01f | 取消隐藏归零；重启后计数来自 Host |
| R1-02a | 正常隐藏文件保存后仍隐藏、`hiddenRefresh=refreshed` |
| R1-02b | rebound 对象保存后仍是 rebound、`skipped/rebound`、新对象可见 |
| R1-02c | Provider 提交身份：正常等于磁盘对象；提交后被替换则不等 |
| R1-02d | 判定表九个分支（含 `pre-read-failed` / `post-mismatch`） |
| R1-03a | 取消隐藏后旧刷新 `skipped-missing`，零写入、序号不涨 |
| R1-03b | 取消后重新隐藏：旧刷新 `skipped-conflict`，新身份 `1:300` 保留 |
| R1-03c | 条件提交写盘失败：内存与磁盘字节都不变 |
| R1-03d | 条件提交与普通隐藏交错：三条记录全部落盘，无"后写覆盖前写" |
| R1-04a | 配置写失败：正文 `COMMITTED` + `failed` + 诊断事件 |
| R1-04b | 跳过的原因可诊断（`rebound`）且不改保存结论 |
| R1-10a | 另一项目与其会话不受影响；无记录时 `hiddenRefresh=none` |

修前状态：套件因 `apps/server/src/hidden-refresh.ts` 不存在而**无法加载**（全红）；
补齐实现后 17/17 全绿。

门禁（本轮独立复跑）：`test:p0` **974 / 972 pass / 0 fail / 2 skip**；
`typecheck`、`typecheck:apps`、`build:shell`（409.91 kB / gzip 125.37 kB）、
`git diff --check` 全绿。

## 3. 变异探针（跑完自动还原；PROBE-FAILURES=0）

| 探针 | 退回的行为 | 被咬住的用例 |
| --- | --- | --- |
| A | `tree-load` 不传 `hiddenCount` | 86-01a/01b/01c/01d/01f（5 例） |
| B | reducer 不把 `hiddenCount` 交给 `applyPage` | 同上 5 例 |
| C | rebound 也允许刷新（盲目重绑定） | 86-02b/02d/04b（3 例） |
| D | 去掉写入侧提交身份校验 | 86-02d（1 例） |
| E | 身份刷新在记录不存在时重新创建（回到旧行为） | 86-03a（1 例） |
| F | 条件提交忽略 `expectIdentity` | 86-03b（1 例） |

## 4. 真实浏览器（Chrome headless + CDP）

`browser-verification.json`：**13/13 checks**，截图 4 张：

- `01-count-one.png`：隐藏 b.md 后工具栏徽标显示 **1**，标题写明"已加载层合计 1 项"；
- `02-shown-with-count.png`：切换"显示隐藏项"后条目回来、带"隐藏"徽标、计数仍 1；
- `03-saved-while-hidden.png`：在 UI 里打开隐藏文件 → 编辑 → 点保存 → 提示"已保存到磁盘"，
  磁盘内容更新，文件仍然隐藏；
- `04-rebound-notice.png`：外部替换同名文件后保存，提示
  "已保存到磁盘；该文件的隐藏记录未能更新（…可在「显示隐藏项」中核对）"，
  正文已落盘，记录仍是 `rebound`，新对象保持可见。

## 5. 剩余风险

| 级别 | 项 | 说明 |
| --- | --- | --- |
| P3 | `post-mismatch` 分支只有单测覆盖，没有端到端故障注入 | 托管模式不暴露 Provider 故障钩子；"提交后被替换"的判定由 `decideHiddenRefresh` 的表驱动用例 + Provider 证据用例组合证明 |
| P3 | 不提供 `identity` 的 Provider 一律不刷新 | 现状只有 LocalProvider 有隐藏记录能力，实际不可达；若将来接入新 Provider，保存后隐藏会变 `rebound`（安全方向：文件重新可见） |
| P3 | 每次保存多两次 `lstat`（仅当该路径有隐藏记录） | 无隐藏记录时只做一次内存查找，不额外碰磁盘 |
| P3 | 计数是"已加载层合计" | 未展开目录不计入；界面文案已写明，避免被读成全项目总数 |
| — | 目录递归删除 / 回收站 / 项目根真实删除 | 仍属 P2/P3，本轮未动 |

## 6. 交付边界

- 未修改 `main`（仍 `79b99e5`），未新建 Worktree/Clone，未生成 ZIP。
- `apps/shell/package-lock.json` 的版本噪声保持原样（未提交）。
- 未新增任何磁盘删除/移动能力。
