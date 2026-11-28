# UX-02C-02-R2.2 证据说明

基线 `f4350f2`（R2.1）。本轮只关闭 F01/F02/F03 三处缺陷。

## 一、改动范围

| 文件 | 改动 |
|---|---|
| `packages/storage/local-provider.ts` | 10b 重新占位前先认目录；`rejectSourceChanged` 占位已建立时先核目录连续性；10d 目录失效按"是否有占位"分叉（UNKNOWN / REJECTED） |
| `apps/shell/src/state/structure-refresh.ts` | 新增 `refreshStructureTargetParent`（目标所属父层）、`structureUnknownNotice` + `StructureCheckOutcome` |
| `apps/shell/src/state/structure-session.ts` | **新增**：`updateSessionIfOwned`（票据核验在函数式更新器内部） |
| `apps/shell/src/state/structure-change.ts` | `checkLocations` 返回核对结论；UNKNOWN 提示按真实结局；`onRejected` 带出 `targetParentDir` |
| `apps/shell/src/state/DocumentActionsContext.tsx` | 接线 `refreshStructureTargetParent` |
| `apps/shell/src/components/TreeCommandsContext.tsx` | 提示/状态/关闭三处写回全部改用 `updateSessionIfOwned`；目标被拒 → 标记 `targetStale` + 重取目标父层；新增 `reconfirmMoveTarget`；过期状态下本地挡住提交 |
| `apps/shell/src/components/MoveEntryDialog.tsx` | 「重新确认目标」显式入口；Enter 在次要按钮上走它们自己的动作 |
| `apps/shell/src/styles/shell.css` | `.move__stale` 样式 |
| `tests/suites/111-...` | F-08 业务预期修正为 UNKNOWN + 补磁盘断言；`checkLocations` 夹具返回结论 |
| `tests/suites/112-...` | **新增 24 例** |

## 二、红 / 绿

### 2.1 F-08：先红后绿（真实执行）

1. 先只改测试期望（REJECTED → UNKNOWN）→ 运行套件 111：**1 failed**（`not ok 35 F-08`）。
2. 再改 Provider 判定链 → 49 例全绿。

### 2.2 套件 112：修复前判定链下的红（`red-suite-112.txt`）

把 Provider 的占位收敛判定整体退回 R2.1（三处一起），运行套件 112：

```
not ok 2 - P-02 占位后目标目录被整体移走（afterMoveReserve）→ UNKNOWN
not ok 3 - P-03 占位后目标目录被整体移走（beforeMoveRename）→ 同样 UNKNOWN
not ok 4 - P-04 新目录里有外部同名文件 → UNKNOWN，外部对象一字节不动
not ok 6 - P-06 10b 重新占位前先认目录：不会在新同名目录里补一个占位
not ok 7 - P-07 目录被移走 + 源同时被换掉 → 仍只能 UNKNOWN
# tests 24 / # pass 19 / # fail 5
```

还原后 `restoreExact = true`（SHA-256 逐字节一致）。
P-01 / P-05 在修复前后都应为 REJECTED，所以它们不变红——这是预期，不是漏测。

N / R / S 三段测的是**本轮新增的契约**（`structureUnknownNotice`、
`refreshStructureTargetParent`、`updateSessionIfOwned`），修复前这些符号不存在，
无法"先红"，其判别力由变异探针 M34 / M35 与删除实现时编译失败共同保证。

### 2.3 变异探针（6/6 BITTEN，逐字节还原）

| 探针 | 移除的判定 | 咬住的用例 |
|---|---|---|
| C02R22-M31 | 目标父目录失效后仍**重新占位** | P-02、P-04、P-06 |
| C02R22-M32 | 占位收敛只看原路径 | P-07 |
| C02R22-M33 | 目标父目录失效后仍返回 **REJECTED** | P-03 |
| C02R22-M34 | UNKNOWN 跨世界仍称"已刷新" | N-02、N-04 |
| C02R22-M35 | 删除目标恢复路径（重取目标自己那层） | R-01、R-02 |
| C02R22-M36 | 删除**最终目标对象**身份核验 | 111 的 F-04、F-10 |

如实记录：M33 只咬住 P-03。原因不是测试弱，而是 P-02/P-04/P-06 在 10b 就被
目录核验拦下，根本走不到 10d；只有"10b 之后目录才被移走"的 P-03 能验证 10d 的分叉。

## 三、真实磁盘事实（`tests/suites/112`，Windows NTFS）

| 用例 | 场景 | 结果 | 磁盘事实 |
|---|---|---|---|
| P-01 | 选完目标后目录被删除重建 | REJECTED `ERR_ENTRY_TARGET_CHANGED` | 源 `a.md` 原样；`archive/` 下零条目 |
| P-02 | 占位建立后目录被整体移走 | UNKNOWN | `archive/a.md` 不存在；`archive-old/a.md` 存在且 `size=0`（我们的占位）；`archive-old/keep.md` 内容 `KEEP\n` 未动 |
| P-03 | `beforeMoveRename` 阶段移走 | UNKNOWN | 同上（占位仍在旧目录） |
| P-04 | 新目录里有外部同名文件 | UNKNOWN | 外部 `archive/a.md` 内容 `EXTERNAL\n`、inode 不变（未被删除/覆盖）；源不变 |
| P-05 | 目录连续、源被替换 | REJECTED `ERR_ENTRY_SOURCE_CHANGED` | `archive/` 只剩 `keep.md`（占位已清理）；新源对象不被删 |
| P-06 | 占位被删 + 目录被移走 | UNKNOWN | 新 `archive/` **零条目**（没有在新目录里补占位）；源不变 |
| P-07 | 目录移走 + 源同时被换 | UNKNOWN | 占位在 `archive-old/`；新源对象还在 |

## 四、真实浏览器（`browser-verification.json`，23/23）

环境：真实 Host + 真实 Vite Shell + Chrome headless，夹具在
`D:/Workspace/projects/weavespace-test/c02-r22`。

| 检查 | 事实 |
|---|---|
| M-03 | 第一次提交被拒：`目标文件夹已被外部替换，未执行任何移动（请重新选择目标）` |
| M-04 / M-14 | 全程只有 **2 次** `/api/files/move`（没有自动重发） |
| M-05 / M-06 | 第一次请求后源文件 inode `1407374884770247` 与 SHA-256 都不变；`docs/move-me.md` 未创建 |
| M-07 | 被拒后出现新的 `/api/tree` 请求（目标所属父层真的被重取） |
| M-08 / M-09 | 对话框出现"已经在磁盘上被替换或移动过"说明 + 「重新确认目标」按钮 |
| M-10 / M-11 | 过期状态下按 Enter：**零请求**，并提示"请先点「重新确认目标」再提交" |
| M-12 | 点击重新确认后，过期说明消失 |
| M-13 | 再按 Enter：移动成功，`docs/move-me.md` 存在、根上的 `move-me.md` 消失，inode 仍是 `1407374884770247`（同一个对象搬家） |
| M-15 / M-16 | 两次请求的 `targetAnchor` 分别为 `f43fb9617422dee3bb80eee2a4d9570b` 与 `057689b331f02f88493ea595d93e4f8f`（不同，且冻结锚没有被悄悄替换） |
| E-01…E-04 | 对话框再次打开即聚焦确认按钮；Escape 关闭且零请求（键盘路径无回归） |

截图：`01-move-dialog-target-docs.png`、`02-move-target-stale.png`、
`03-move-target-reconfirmed.png`。

## 五、门禁

| 命令 | 结果 | 输出 |
|---|---|---|
| `npm run test:p0` | **PASS** — 1596 tests / 1594 pass / 0 fail / 2 skipped | `gate-test-p0.txt` |
| `npm run typecheck` | **PASS** | `gate-typecheck.txt` |
| `npm run typecheck:apps` | **PASS** | `gate-typecheck-apps.txt` |
| `npm run build:shell` | **PASS**（仅既有 chunk 体积提示） | `gate-build-shell.txt` |
| `git diff --check` | **PASS** | `gate-diff-check.txt` |
| `git diff --cached --check` | **PASS** | `gate-diff-cached-check.txt` |
| 变异探针 | **6/6 BITTEN** | `mutations.json` |
| 真实浏览器 | **23/23 PASS** | `browser-verification.json` |

两个 skip 是既有用例（`S4R2-08` 需 ACL 授权、`C-04` 仅 POSIX），本轮未新增 skip。

## 六、边界

- 不扫描项目寻找占位、不删除移动后目录中的对象、不自动回滚、不自动重试；
- 不自动替换对话框里的冻结目标锚；恢复只由用户显式动作触发；
- 不改双击时间窗口、不重写资源身份系统、不改元数据迁移、不做 bigint 迁移；
- 不开始 UX-02C-06、不实施 ARCH-01、不改 main、不合并、不重写历史。
