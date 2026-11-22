# UX-02C-03-P2-01-R2 定点安全修复 · 证据

- 分支：`wip/ux-02c-03-p2-01-r1-trash-safety-20261122`
- R1 基线：`6668e3470090ec745dfaf4632a2798d9557e6b47`（父 `52cc2a2`）
- R2 提交：本分支最新提交（`git log -1`），父提交即上面的 R1 基线
- 环境：Windows 11 / Node v22.22.2 / 真实本地 NTFS 磁盘
- 纪律：UI 未改、P2-02 未启动、无永久删除、无自动清理、`main` 未动

---

## 1. 缺陷与修复位置

| 编号 | 原因 | 修改位置 | 方式 |
|---|---|---|---|
| R2-01 | `/api/trash/entry` 的快速重放只比 `projectId + originalPath`，漏 `rootToken`，绕过 Store 的完整归属核验 | `apps/server/src/server.ts:2489` | 重放前补 `replay.rootToken !== handle.rootToken` 判定，任一归属不符 → 409 `ERR_OP_ID_CONFLICT`，不返回 APPLIED、不动磁盘、不改记录 |
| R2-02 | `trashEntry` / `restoreEntry` 的 `open('wx')` 占位在 `close` 失败时被外层 catch 映射成普通 REJECTED，而磁盘上已经产生了占位 | `packages/storage/local-provider.ts:1115`（`reservePlaceholderOwned`），调用点 `:2363`、`:2555`、`:1183` | 三处占位共用一段实现：`stat` 失败 / `close` 失败 / 归属无法证明 → UNKNOWN；close 失败先重试关闭（仅为尽力而为），只清理 `dev+ino` 可证明属于自己的占位，绝不继续 rename |
| R2-03 | `restoreEntry` 不做 opId 目录完整性检查，且 manifest 只校验 magic/opId/identity 三项 | `packages/storage/local-provider.ts:818`（`verifyRestoreSourceReadOnly`），调用点 `:2505`；通用安全读取 `:600` | 恢复前**只读**核验：三级父链（根内/真目录/非链接）+ 目录白名单（仅 `payload`、`manifest.json`）+ 清单经句柄读取并逐字段与本次事务对照（magic/opId/originalPath/entryKind/identity/size/deletedAt） |
| R2-04 | `writeOwnFileAtomically` 在 `rename(tmp, target)` 前未复核临时文件，句柄关闭后名字可被替换 | `packages/storage/local-provider.ts:573` + `tmpFileStillOwned:479` | rename 前复核：存在、普通文件、非链接/重解析点、`dev:ino` 一致、`nlink === 1`；不满足则不 rename、不覆盖目标、只清理可证明归属的临时文件 |
| R2-05 | 清理动作的 TOCTOU 未评估 | 本文 §4 | 技术评估 + 如实披露，未改行为、未引入原生依赖 |
| R2-06 | 并发用例没有同步屏障，`Promise.all` 不保证两边都越过重放检查 | `apps/server/src/server.ts:2535`（`managedTrashBarrier`）、`tests/suites/91-...ts` 新增用例 R2-06 | 在 `beginTrash()` 之前设测试屏障，两侧到齐后同时放行；屏障未被调用（被移除）时用 5s 超时 + `arrivals === 2` 断言失败而非挂起 |

诊断数据不新增输出面：本次修复只增加错误码分支与内部核验，未在响应里回传路径、项目归属或磁盘身份。

## 2. 红测 → 绿测

修复前证据：`before-91.txt`、`before-93.txt`、`before-94.txt`（实现文件被临时移出、测试保持原样运行）。
修复后：`after-91.txt`、`after-93.txt`、`after-94.txt`。

| 用例 | 修复前 | 修复后 |
|---|---|---|
| R2-01a 旧 rootToken 重放 | FAIL：409 但错误码为 `ERR_TRASH_STATE_CONFLICT` —— 旧记录被当成**本项目**的有效重放（未复现 200 APPLIED，见 §2.1） | PASS：409 `ERR_OP_ID_CONFLICT`，记录/提交序号/源文件/payload 全部不变 |
| R2-01b 同归属重放 | PASS（既有幂等） | PASS（保持幂等，不重复移动） |
| R2-02a 回收占位 close 失败 | FAIL：注入点 `fired` 期望 1 实际 0（不存在该语义），返回 MOVED | PASS：UNKNOWN，源文件未动、无清单、占位仅 0 字节 |
| R2-02b 恢复占位 close 失败 | FAIL：同上 | PASS：UNKNOWN，payload 字节与身份不变 |
| R2-02c 回收 UNKNOWN 落库 | FAIL：注入点未生效 | PASS：202 UNKNOWN，记录停在 `pending`，查询接口 `outcome=unknown` |
| R2-02d 恢复 UNKNOWN 落库 | FAIL：注入点未生效 | PASS：202 UNKNOWN，记录停在 `restoring`（未回退 stored） |
| R2-03a 陌生文件 | FAIL：`MOVED` —— 篡改后的回收区被照常恢复 | PASS：`ERR_TRASH_UNAVAILABLE`，陌生对象保留 |
| R2-03b 清单 identity 篡改 | FAIL：`MOVED` | PASS：`ERR_TRASH_STATE_CONFLICT` |
| R2-03c 清单 originalPath 篡改 | FAIL：`MOVED` | PASS：`ERR_TRASH_UNAVAILABLE` |
| R2-03d 清单 opId 篡改 | FAIL：`MOVED` | PASS：`ERR_TRASH_UNAVAILABLE` |
| R2-03e 清单缺失 | FAIL：`MOVED` | PASS：`ERR_TRASH_UNAVAILABLE` |
| R2-03f payload → 符号链接 | PASS（R1 已拦，保留为回归用例） | PASS：`ERR_TRASH_STATE_CONFLICT`，sentinel 不变 |
| R2-03g 清单 → 符号链接 | FAIL：`MOVED`（沿链接读清单） | PASS：`ERR_TRASH_UNAVAILABLE`，sentinel 不变 |
| R2-03h 遗留临时文件 | FAIL：`MOVED` | PASS：`ERR_TRASH_UNAVAILABLE`，不自动删除 |
| R2-03i 陌生子目录 | FAIL：`MOVED` | PASS：`ERR_TRASH_UNAVAILABLE` |
| R2-03z 正常恢复（对照） | PASS | PASS（安全校验未破坏正常路径） |
| R2-04a 临时文件换成普通文件 | FAIL：标记被伪造对象顶替，删除照常完成 | PASS：`ERR_TRASH_UNAVAILABLE`，无标记、源文件未动 |
| R2-04b 临时文件换成符号链接 | FAIL | PASS：sentinel 不变、无标记 |
| R2-04c 临时文件换成硬链接 | FAIL | PASS：`nlink > 1` 被拒、无标记 |
| R2-04d 临时文件被删除 | FAIL：钩子未接入，删除没有发生，返回 `MOVED` | PASS：`REJECTED`（纵深防御，见 §3 判别力说明） |
| R2-04e 正常写入（对照） | FAIL（钩子未接到） | PASS：标记正常写入 |
| R2-06 并发屏障 | FAIL：`arrivals` 期望 2 实际 0 | PASS：两侧到齐后同时提交，胜/负方结果与字节均正确 |

真实磁盘：全部 17（套件 93）+ 4（套件 94）用例都跑在真实临时目录上，外部对象用真 `symlink`/`linkSync`/
真删真建，sentinel 用真字节比对；没有 mock、没有 patch 全局 `fs`。
未覆盖分支：`size`/`deletedAt` 类型非法两条分支未单独立用例（由 R2-03b 同一段代码路径覆盖到
"逐字段拒绝"的形态，但未独立断言错误码），如实记录。

### 2.1 R2-01 证据口径修正（R2-Supplement / 任务 C）

初版 `notes.md` 与套件 94 的注释里出现过"修复前会返回 200 APPLIED"的说法。**那是不准确的**，
本轮更正，`before-94.txt` 作为历史输出保持原样、不改写。

- 修复前**实测**行为：`/api/trash/entry` 仍然进入快速重放分支（只比 `projectId + originalPath`），
  于是把这条旧记录当成本项目的有效重放；由于启动对账已经把"根令牌不一致"的记录收敛成
  `conflicted`，重放按状态回 `409 + ERR_TRASH_STATE_CONFLICT`（"这笔删除没有成功，请重新发起"）。
- 修复后的行为：`409 + ERR_OP_ID_CONFLICT`（"该操作编号已用于另一次回收"），零磁盘副作用。
- **200 APPLIED 没有被复现**：要让重放回 200，记录必须是 `stored`；而只要 `rootToken` 与当前句柄
  不一致，启动对账就会先把它改成 `conflicted`（`reconcileTrashRecord` 的根令牌分支）。
  因此这条路径在真实 Host 里不可达，本文件不把它写成已证实的事实。

为什么加了 `rootToken` 比较**仍然有必要**：

1. 归属判定不应该依赖"另一个子系统是否恰好先跑过"。重放分支在结构变更屏障之前，本身不做对账；
   对账的结论可能不存在（项目在启动时不可用 → 该轮不改状态；提交被跳过 → 状态不变）。
2. 重放会回传该记录的 `entry`（原路径、字节数、状态），等于以"当前根"的名义替另一份授权背书。
3. Store 侧 `beginTrash` / `commitTrashState` 已把归属定义为
   `opId + projectId + rootToken + originalPath + identity`；重放路径少比一个字段，就是同一件事两套判定。
4. 该判定让错误语义正确：调用方需要知道"这个 opId 不是我的事务"，而不是"我的事务失败了"。

## 3. 变异探针（`run-probes.py`，逐条自动还原）

| 探针 | 撤销的保护 | 结论 | 咬住用例 |
|---|---|---|---|
| A | 快速重放的 `rootToken` 比较 | BITTEN | R2-01a |
| B | 占位 close 失败改回 REJECTED | BITTEN | R2-02a/b/c/d |
| C | 删除恢复前目录完整性检查 | BITTEN | R2-03a/c/d/e/g/h/i |
| D | 删除清单 identity 比较 | BITTEN | R2-03b |
| E | 删除临时文件 `dev:ino` 复核 | BITTEN（3/4） | R2-04a/b/c |
| F | 移除并发屏障 | BITTEN | R2-06 |

合计：6 个探针全部 BITTEN，无未解释的 SURVIVED。明细见 `probe-A.txt` … `probe-F.txt`、`probe-summary.txt`。

**判别力说明（不夸大）**：
- R2-04d（临时文件被删除）**不是**判别用例。撤销 E 之后它仍然通过，因为 `rename` 自己会因源不存在
  而失败，外部表现一致。它作为纵深防御保留，本轮不宣称它对 E 有判别力。
- R2-03f（payload → 链接）在修复前就通过，属于 R1 已有保护的回归用例，不宣称是本轮缺陷的红测。
- 探针 C 未咬住 R2-03b 属预期：identity 比较在探针 D 单独负责。

## 4. R2-05：TOCTOU 技术评估（如实记录，未消除）

审查对象：`discardTmpFile`、`releaseReservation`、`writeOwnFileAtomically`（含新增的
`tmpFileStillOwned` 复核）以及三处占位的 `ensureReservationOwned`。

**问 1：外部替换后会不会误删其他对象？** 会，但范围受限。`lstat` 与 `unlink` 之间存在窗口：
身份核对通过后被替换成另一个对象，`unlink` 删掉的是**替换者**放进去的那个目录项。
影响面：`.weavespace/` 内部对象，以及恢复场景下的目标路径（即原本为空的位置）。
`unlink` 不跟随链接，符号链接只会被删掉链接本身；硬链接只减少本目录项，根外 inode 内容不变。

**问 2：外部替换后会不会覆盖其他目录项？** 会。`rename` 前复核与 `rename` 之间，目标位置可被换成
外部对象，Windows 上 `rename` 以 `MoveFileExW(REPLACE_EXISTING)` 覆盖它。这一窗口与 UX-02C-02-R1
的 `beforeMoveRename` 同源，已在既有证据里记录过 NTFS 实测语义。

**问 3：Node 现有 API 能否在 Windows 上原子解决？** 不能。缺三样能力：
- `unlinkat(dirfd, name)`：Node 未暴露目录句柄，也没有"按句柄删除指定目录项"；
- `renameat2(RENAME_NOREPLACE)`：Windows 侧没有 no-replace 变体可用；`fs.rename` 只有覆盖语义；
- 句柄级删除（`FILE_DISPOSITION_INFO` / `FILE_FLAG_DELETE_ON_CLOSE`）：`fs.open` 不暴露这些标志。

**问 4：是否存在跨平台替代方案？** 没有"零依赖"的。可选方案与代价：
1. 原生插件（`renameat2` / `NtSetInformationFile`）—— 本轮明令禁止引入未评估的原生依赖；
2. 目录级锁文件 —— 只能约束"同样遵守锁"的进程，对任意外部进程无效，且会引入新的崩溃残留问题；
3. `O_TMPFILE` + `linkat` —— Node 未暴露，且 Windows 无对应原语；
4. 写盘后读回比对 —— 只能发现"结果不对"，不能阻止覆盖，反而增加一次副作用。

**问 5：剩余风险的具体范围。** 前提是"外部进程已经能写项目目录/`.weavespace`"——
在这种前提下它可以**直接**改用户文件，本轮的窗口不扩大它的能力，只是让我们自己的清理动作
可能误删/误覆盖**它**放进去的对象。能够保证的是：
（a）任何写入都不会沿链接写到项目根外；
（b）只删除"至少被观测到属于自己（`dev:ino` 一致）"的对象；
（c）任一核验不通过即 fail-closed，不继续 rename；
（d）状态不确定时不动磁盘、报 UNKNOWN，由对账收敛。
不能保证的是：核验与动作之间"同一对象的同一性"在原子层面成立。

**网络文件系统（SMB/NFS）**：`nlink` 与 `dev:ino` 的可靠性依赖服务端实现，跨客户端可能不一致；
本轮的核验在这种环境里可能把合法对象判成 `foreign`（fail-closed，安全方向），但**不能**保证
`rename` 的原子性与身份稳定。当前只对本地 NTFS/APFS/ext4 作承诺。

**对账不是持续监控**：`reconcileTrash` 只在启动、列表、恢复三个时点运行，没有文件系统监视器。
空闲期的外部改动要到下一次读取才被发现，不能声称"实时检测"。

## 5. 全量门禁（本机实测）

| 门禁 | 结果 |
|---|---|
| `npm run test:p0` | 1059 例：1057 pass / 0 fail / 2 skip（`gate-test-p0.txt`） |
| `npm run typecheck` | 通过，无输出（`gate-typecheck.txt`） |
| `npm run typecheck:apps` | 通过（shell + server 各自 `tsc` 干净，`gate-typecheck-apps.txt`） |
| `npm run build:shell` | 通过，`✓ 86 modules transformed` / `built in 1.05s`（`gate-build-shell.txt`） |
| `git diff --check` | 干净 |
| 单独套件 90 | 17 / 17 pass（`gate-suites-90-91-92.txt`） |
| 单独套件 91 | 15 / 15 pass |
| 单独套件 92 | 12 / 12 pass |
| 单独套件 93（新） | 17 / 17 pass（`after-93.txt`） |
| 单独套件 94（新） | 4 / 4 pass（`after-94.txt`） |

两个 skip 均为既有平台条件：`S4R2-08`（需要改临时文件 ACL，未获授权）、`C-04`（POSIX ino 语义）。

## 6. 未解决事项

1. §4 的三处 TOCTOU 窗口仍在（未消除，只做了收窄与 fail-closed）。
2. `TRASH_TMP_RE` 形态的崩溃残骸在**回收**路径被 `validateOpDir` 拒绝，但在 `.weavespace` 根层被
   `prepareTrashRoot` 当成"自己的残骸"接受（这是 R1 的既定行为，本轮未改）。
3. 项目被整体复制/移动后，`payload` 的 `dev:ino` 必然变化，恢复会在 R1 既有的"payload 身份与记录
   不符"判定处被拒（`ERR_TRASH_STATE_CONFLICT`）；R2-03 的清单核验不会额外放行也不会额外拒绝
   （清单里的 `identity` 与记录身份同源，两者始终一致）。这是既有的 fail-closed 行为，
   用户可见的解释文案与迁移指引留给 P2-02/P3。
4. R2-02 的 close 故障注入在 Windows 上走的是"钩子抛错→重试关闭成功→清理占位"，真实 EPERM 场景
   （句柄关不掉）无法用现有钩子确定性复现，只有代码路径保障，没有端到端证据。
