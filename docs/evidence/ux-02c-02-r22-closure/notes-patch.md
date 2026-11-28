# UX-02C-02-R2.2-PATCH 记录

基线 `5d1c161`（R2.2）。只修 P01 / P02 两处生产链路缺口，其余冻结项未动。

## 1. 本轮改了什么

| 缺陷 | 修复 | 文件 |
|---|---|---|
| P01 `targetDirStillMatches()` 在 `expectedTarget === null` 时恒真 → 普通改名与项目根目标完全没有目录连续性保护 | 用第 4 步已有的父目录 `lstat` 保存**内部基准**；基准缺失一律 fail-closed；初次占位前也认一次目录 | `packages/storage/local-provider.ts` |
| P02 `StructureRefreshHost.load` 返回 `Promise<unknown>`，`treeLoader.load()` 的真实 `TreeLoadOutcome` 被丢弃 → 底层 `failed` 也宣称"已刷新" | `load` 类型改 `Promise<TreeLoadOutcome>` 并原样返回；核对结论按真实结果合并为 `applied/partial/stale/failed` | `structure-refresh.ts`、`DocumentActionsContext.tsx`、`structure-change.ts` |
| 连带：重取目标父层失败时，旧锚被当成"最新身份"交给「重新确认目标」 | 对话框记 `targetRefresh`；放行条件抽成纯函数 `moveTargetReconfirmProblem` | `structure-session.ts`、`TreeCommandsContext.tsx` |

## 2. 红 → 绿

- **红**（`red-patch.mjs` → `red-suite-112-patch.txt`）：把 P01 的判定与 P02 的收集
  按**运行语义**退回补丁前，套件 112 从 42 例掉到 **29 pass / 8 fail**：
  `Q-01`、`Q-02`、`N-07`、`N-08`、`N-09`、`N-10`、`N-11`、`N-14`。
  还原后 SHA-256 逐字节一致（`local-provider.ts` `2f4bc301…`、`structure-refresh.ts`
  `2905c35b…`）。
- **绿**：42 例全通过（原 24 + 新增 18）。
- 新用例编号与含义：
  - `Q-*`（5）：内部目录基准。Q-01 改名占位后父目录被移走 → `UNKNOWN`；Q-02
    初次占位前目录被换 → `REJECTED` 且**一次占位都不尝试**；Q-03/Q-04 改名与移动
    成功回归；Q-05 外部同名对象一字节不动。
  - `N-07..N-14`（8）：真实 `TreeLoadOutcome` 传递。`failed` / `rejected` /
    `skipped-inflight` / 一层成功一层失败 / 途中换世界 / 两层成功 / 零请求 / 生产编排
    只发一次结构变更。
  - `T-01..T-05`（5）：重新确认目标的新鲜度。

## 3. 变异（2/2 BITTEN，`mutations-patch.json`）

| 编号 | 变异 | 咬住 |
|---|---|---|
| C02R22P-M41 | 改名/根目标跳过内部目录连续性（恢复成 `expectedTarget === null → true`） | `Q-01`、`Q-02` |
| C02R22P-M42 | 丢弃真实 `TreeLoadOutcome`，一律 `applied` | `N-07`、`N-08`、`N-09`、`N-10`、`N-14` |

两条 `sourceChanged = true`、`restoreExact = true`（SHA-256 前后一致）。
如实说明：M42 只改了成功路径的返回，`N-11`（途中换世界 → `partial`）走的是早退分支，
因此**没有被 M42 咬住**——这不是漏测，是这条变异的覆盖面只到那里。

## 4. 门禁

| 命令 | 结果 | 日志 |
|---|---|---|
| `npm run test:p0` | **1614 tests / 1612 pass / 0 fail / 2 skipped** | `gate-patch-test-p0.txt` |
| `npm run typecheck` | 0 | `gate-patch-typecheck.txt` |
| `npm run typecheck:apps` | 0 | `gate-patch-typecheck-apps.txt` |
| `npm run build:shell` | 0 | `gate-patch-build-shell.txt` |
| `git diff --check` | 0（无输出） | `gate-patch-diff-check.txt`（空文件） |
| `git diff --cached --check` | 0（无输出） | `gate-patch-diff-cached-check.txt`（空文件） |

两个 `git diff --check` 的**真实输出就是空**：第一次跑出的是"证据日志行尾空格"，
清理证据日志后重跑即通过；`gate-patch-diff-*.txt` 记录的是清理后的最终输出，
命令退出码 0。两个 skip 仍是既有用例（`S4R2-08` 需 ACL 授权、`C-04` 仅 POSIX）。

## 5. 浏览器回归（同一脚本重跑）

`verify-r22.mjs` 重跑 **23/23 全 PASS**（`browser-regression-patch.txt`）。
关键事实：

- 目标 `docs` 被外部删除重建 → 提交被拒
  `目标文件夹已被外部替换，未执行任何移动（请重新选择目标）`；
- 被拒后确实发出了新的 `/api/tree`（父层重取），随后「重新确认目标」可用且点击后
  过期说明消失；
- 过期状态下按 Enter **零请求**；
- 两次移动请求，`targetAnchor` 分别为 `8558e6c1…`、`e4e77ce9…`（不同）；
- 第一次请求后源文件 inode `1407374884771225` 与 SHA-256 `804d44e3…` 完全不变、
  目标未创建；第二次才真正移动。

历史证据未被覆盖：`browser-verification.json`、`01..03-*.png`、`gate-*.txt`、
`mutations.json`、`red-suite-112.txt` 保持原样，本轮产物一律带 `-patch` 后缀。

## 6. 剩余风险

| 编号 | 风险 | 状态 |
|---|---|---|
| R22P-R1 | 占位可能随被移走的目录留在磁盘上（`UNKNOWN` 的必然代价） | 沿用 R22-R1，不扫描、不擅自删除 |
| R22P-R2 | 10d 之后到 `rename` 之间仍有 OS 级 TOCTOU | 未消除，本轮不宣称消除 |
| R22P-R3 | `skipped-inflight` 造成 `partial` 时，用户需手动刷新才能重新确认目标 | 已用 `MOVE_TARGET_UNREFRESHED` 明确告知，不自动重试 |
| R22P-R4 | `dev:ino` 双精度、网络文件系统上的 ino 稳定性 | 沿用 `docs/34` §六 C04 / §十 |
