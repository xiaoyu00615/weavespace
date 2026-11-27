# UX-02C-02-R2.1 证据说明

基线 `de11804`（R2）。本轮只关闭 R2 复审确认的缺陷，主体方案未变。

## 一、改动范围（都是"最小必要"）

| 文件 | 改动 |
|---|---|
| `apps/shell/src/state/structure-ownership.ts` | **新增**：世界票据（mode/workspaceMode/workspaceKey/epoch）、多段 await 闸门、行内提示按票据路由 |
| `apps/shell/src/state/structure-intent.ts` | 意图增加 `world`；新增 `structureIntentScopeProblem` / `structureSubmitIntentProblem`（票据→世界→身份） |
| `apps/shell/src/state/structure-refresh.ts` | **新增**：APPLIED / UNKNOWN / REJECTED 三条落地路径的归属编排，每段 await 前过闸门 |
| `apps/shell/src/state/structure-change.ts` | `verifyIntent` 改收整份意图；move 增加 `targetAnchor`；`onNotice(message, sessionId)`；`onRejected` 带意图 |
| `apps/shell/src/state/DocumentActionsContext.tsx` | `structureWorld()` / `structureRefreshHost()`；三个落地方法委托纯模块；跨世界提示 |
| `apps/shell/src/components/TreeCommandsContext.tsx` | `noticeFor(message, sessionId)`；`targetIdentityOf`；runner 改 `useRef` 只装配一次；删除按路径现查意图 |
| `apps/shell/src/state/tree-commands.ts` | `projectRenameGateOf` 增 `activeProjectAtStart` 核验（A01） |
| `apps/shell/src/state/project-rename.ts` | A01 传活动项目快照；A02 `APPLIED + stale` 三件事提示 |
| `apps/shell/src/state/create-entry.ts` | `onNotice` 透传会话票据 |
| `apps/shell/src/components/focus-restore.ts` | **新增**：焦点归属三态与"该不该还焦点" |
| `apps/shell/src/components/MoveEntryDialog.tsx` | hooks 前置；打开聚焦确认按钮；结束后按纪律恢复；Enter 提交（排除 TEXTAREA，`preventDefault`） |
| `apps/shell/src/components/InlineCreateRow.tsx` | 提交结束后恢复焦点与选区（核验同一会话） |
| `apps/server/src/structure-change.ts` | move 零 IO 强制 `targetAnchor`；屏障内读目标身份、重算锚比对 |
| `apps/server/src/server.ts` | 接线 `readTargetIdentity`；`ERR_ENTRY_TARGET_CHANGED` → 409；补公开文案 |
| `packages/contracts/errors.ts` | 新增 `ERR_ENTRY_TARGET_CHANGED`（与源变化分开） |
| `packages/storage/local-provider.ts` | 目标目录连续性核验（首次 + 10d 最终）；源终检补类型/链接；`verify()` 只认身份；`afterRename` 注入点 |
| `apps/shell/src/client/client-api.ts` | `moveEntry` 携带 `targetAnchor` |
| `tests/suites/111-...test.ts` | **新增 49 例** |

## 二、红 / 绿

### 2.1 既有套件在实现变化后真实变红 → 修好后转绿

| 现象（红） | 原因 | 处理（绿） |
|---|---|---|
| 101/103/110 共 28 例 `ERR_STRUCTURE_INTENT_MISSING` | move 现在强制要求目标锚 | 夹具 `withSourceAnchor` 从真实 `/api/tree` 补 `targetAnchor`（不足处仍原样放行，由 Host 拒绝） |
| 110 R-11 期望 `ERR_ENTRY_PARENT_INVALID`，实得 `ERR_STRUCTURE_INTENT_MISSING` | 负例请求体没有目标锚 | 双侧修正：Host 把"目标读不到"归为 `ERR_ENTRY_PARENT_INVALID`，用例给形状合法的锚 |
| 73「网络断开 → UNKNOWN」实得 `rejected` | move 缺目标锚被本地拒绝 | 用例补合法 `targetAnchor` |
| 78 R1.2-05a 从 200 变 409 | 新增 10d 最终目标核验后，注入的外部同名对象在 rename 前被识别 | 改写为"409 `ERR_ENTRY_EXISTS` + 外部对象不被覆盖 + 源保持原位"，注释说明窗口从"整个占位阶段"收缩到"10d 之后" |

### 2.2 套件 111 的判别力（本轮不伪造"先写红"）

套件 111 是在实现完成之后写的，所以这里**不声称**"先红后绿"的时间顺序。
判别力用**变异探针**证明：每个探针把一处修复移除，套件必须变红并咬住具体用例
（`mutate.mjs` → `mutations.json`，全部 `restoreExact: true`）。

| 探针 | 移除的判定 | 结果 | 咬住的用例 |
|---|---|---|---|
| C02R21-M21 | 工作区归属检查 | BITTEN | W-01、W-03、A-01、A-05 |
| C02R21-M22 | 加载代次检查 | BITTEN | W-01、W-02、W-05、A-02、A-04 |
| C02R21-M23 | 行内提示的会话票据 | BITTEN | N-01、N-02、N-03 |
| C02R21-M24 | Provider 最后一次目标身份核验 | BITTEN | F-08 |
| C02R21-M25 | Provider 最终类型核验 | BITTEN | F-02 |
| C02R21-M26 | Host 移动目标身份检查 | BITTEN | H-02、H-03 |
| C02R21-M27 | 提交前会话票据核验 | BITTEN | W-05 |

如实记录两点：

- **M24 只咬住 F-08**：10b 的首次目标核验仍在，所以"调用前就被换掉"（F-07）
  在变异后依然变绿。这不是测试弱，而是两道防线的分工——它们各自保护不同的窗口。
- **F-07 在 M24 下依然通过**，说明"同路径删除重建"在进入 Provider 前就被拦住了；
  真正只有 10d 能抓的是"占位阶段被换掉"。

## 三、真实浏览器事实（`browser-verification.json`，38/38）

环境：真实 Host（`apps/server/src/main.ts` + 真实 `workspace.json`）、真实 Vite Shell、
Chrome headless，夹具在 `D:/Workspace/projects/weavespace-test/c02-r21`。
**全部用真实按键（`Input.dispatchKeyEvent`）完成，没有用"点取消按钮"代替 Escape。**

| 检查 | 事实 |
|---|---|
| A-02 | 双击进入改名后 `document.activeElement` 就是 `input[aria-label="新名称"]` |
| A-03…A-07 | 非法名称 + Enter：行内错误可见、零请求、输入保留；**焦点仍在输入框**时 Escape 有效 |
| A-09…A-13 | Host 拒绝（同名已存在）：错误 `该位置已有同名文件或文件夹，未覆盖任何内容`、只发 1 次请求、输入保留、**焦点回到输入框**（`aria-invalid` 输入框），随后 Escape 真正取消 |
| A-14 | 请求被 CDP 按住期间再按 Enter：`renameRequestsDuringDoubleEnter = 1`（单飞 + `preventDefault` 一起生效） |
| A-15 | Enter 提交成功后磁盘真的改名：`dup-renamed.md` 存在、`dup.md` 不存在，记录 size/inode/SHA-256 |
| M-03/M-04/M-05 | 移动对话框打开即聚焦确认按钮；Escape 关闭且零请求 |
| M-06 | Enter 提交移动：`archive/other.md` 出现、根上的 `other.md` 消失 |
| M-08…M-13 | 目标 `docs` 被外部删除重建后按 Enter：`目标文件夹已被外部替换，未执行任何移动（请重新选择目标）`，只发 1 次请求，源仍在根，新目录为空，对话框保留且焦点回到确认按钮 |
| M-14 | 被拒后 Escape 仍能关闭对话框 |
| T-02…T-05 | 编辑器里 `XY` + Enter 真的写进缓冲（`"XY\n# dup\n"`），树的改名行与移动对话框都没被打开，焦点仍在 `editor__area` |

截图：`01-rename-inline-error.png`、`02-rename-rejected-focus.png`、
`03-move-dialog.png`、`04-move-target-changed.png`、`05-editor-keys.png`。

## 四、门禁（本机 Windows，`TMP/TEMP/TMPDIR` 指向长路径）

| 命令 | 结果 | 输出 |
|---|---|---|
| `npm run test:p0` | **PASS** — 1572 tests / 1570 pass / 0 fail / 2 skipped | `gate-test-p0.txt` |
| `npm run typecheck` | **PASS**（0 error） | `gate-typecheck.txt` |
| `npm run typecheck:apps` | **PASS**（shell + server） | `gate-typecheck-apps.txt` |
| `npm run build:shell` | **PASS**（仅既有 chunk 体积提示） | `gate-build-shell.txt` |
| `git diff --check` | **PASS** | `gate-diff-check.txt` |
| `git diff --cached --check` | **PASS** | `gate-diff-cached-check.txt` |
| 变异探针 | **7/7 BITTEN**，源码逐字节还原 | `mutations.json` |
| 真实浏览器 | **38/38 PASS** | `browser-verification.json` |

两个 skip 都是既有用例、与本轮无关（`S4R2-08` 需改临时文件 ACL、未获授权；
`C-04` 只在 POSIX 验证 ino 语义），本轮未新增 skip；F-03 的 junction 用例在本机
真实创建成功，没有走到 skip 分支。

## 五、边界与未做的事

- 不开始 UX-02C-06，不实施 ARCH-01；
- 不改 `main`、不合并、不重写历史；不提交 `apps/shell/package-lock.json` 噪声；
- 真实 Windows 原生目录选择对话框仍未验证（沿用既有事实，本轮不涉及）；
- `dev:ino` 双精度与 OS 级 TOCTOU 见 `docs/34` §十。
