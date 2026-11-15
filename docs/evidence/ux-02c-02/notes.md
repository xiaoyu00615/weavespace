# UX-02C-02 真实重命名与移动 · 验收记录

基线：`ba99168`（02C-01-R1）。分支 `wip/s11-ux-02c-02-rename-move-20261115`。
夹具：`weavespace-test/ux02c02-{red,green}-projA|projB` + 独立 store，红绿各一套；
Host 5221（每轮由 e2e 脚本 spawn，fake-picker），Vite 5220，Chrome headless + CDP。

## Windows `fs.rename` 语义（实测，Node 22.22.2 / win32）

本机实验 + libuv 源码确认：Node 在 Windows 上用
`MoveFileExW(MOVEFILE_REPLACE_EXISTING)`——

| 组合 | 行为 |
| --- | --- |
| file → 已存在 file | **静默覆盖**（不报错） |
| file → 已存在 dir | **静默覆盖**（目录被替换成文件！） |
| dir → 已存在 dir | `EPERM` |
| 任意 → 不存在目标 | 正常移动 |

结论：`fs.rename` **不能**当作"绝不覆盖"的原语。防覆盖策略：目标存在性检查 +
**`open(target,'wx')` 排他占位**（0 字节，属本次操作自己）→ rename 只覆盖自己的
占位；占位 `EEXIST` 即 `ERR_ENTRY_EXISTS`。占位还顺带挡住了"检查与执行之间外部
进程创建同名目标"的竞争窗口（套件 72 用例 6b + 变异探针 P2 证明）。

大小写仅变化（`notes.md → NOTES.MD`）：Windows 上源/目标是同一对象，`wx` 会
`EEXIST`——单独分支放行（实测真实改变目录项名称，套件 72 用例 7）。

## 红测（基线，`red/browser-verification.json`：ok=false，13 项断言 12 false）

临时 `git stash` 还原到基线后跑同一脚本：菜单无「重命名/移动到」，无输入行，
无移动选择器，B 项目隔离仍 true（既有行为）。截图见 `red/`。

## 实现

Host：`packages/storage/local-provider.ts` 新增 `moveEntry` 原语（rename+move 同一
实现）；`apps/server/src/structure-change.ts` 编排（会话屏障 + Runtime 结构变更
屏障 `withStructureChange` + withDiskOp + 根连续性 + UNKNOWN 收敛）；
`POST /api/files/rename`、`POST /api/files/move`（托管 Multi 501 → T1 令牌 →
同源 Origin → 形状 → 写授权）；`DocumentService.projectStructureBlockers` 按路径
前缀枚举活动 View 与六态危险会话（ACTIVE_VIEWS/DIRTY/SAVING/OUTCOME_UNKNOWN/
CONFLICT）。

Shell：`state/structure-change.ts`（目标规则、移动候选、本地草稿门禁、单飞
runner、UNKNOWN 恰好一次只读核对）；client `renameEntry/moveEntry`；
reducer `TREE_STRUCTURE_CHANGED`（旧路径前缀作废层/展开/选择，不动其它项目与
workspaceKey）；tree-load `invalidateLevel`；UI 复用 ContextMenu/TreeCommands/
InlineCreateRow，新增 `MoveEntryDialog`（portal、源/目标相对路径、下拉候选、
Esc/外部点击关闭）。

## 浏览器绿测（`green/browser-verification.json`：ok=true，13/13）

右键菜单含重命名/移动到；改名输入框预填 `a.md`、聚焦、选中主名 [0,1]；
Enter 真实改名 `数学笔记.md` 且 SHA-256 不变；Esc 零磁盘变更；`CON.txt` 行内
错误且零落盘；移动选择器展示源/目标相对路径、候选排除后代与链接；确认后
`archive/数学笔记.md` 字节一致；**打开 guide.md 后改名被拦且输入行保留显示原因**
；B 项目不受影响；2 次 POST 请求体只有 `{projectId,sourcePath,name}` /
`{projectId,sourcePath,targetParentDir,name}`。截图 `00–06`。

## 单测与变异探针

- 套件 72（Host，16 例）/ 73（Shell，11 例）全绿。
- 探针 P1（输入行去留判定恒 false）→ 73#8 红；P2（占位 EEXIST 放行）→ 72#7
  竞争用例红；P3（Host 会话屏障失效）→ 72#11 红；P4（UNKNOWN 自动重发）→
  73#6 红。均已还原（源码无 PROBE 残留）。
- 探针过程中发现的测试缺口：同名冲突的常规用例咬不住占位防线（第一道 lstat
  检查先拒绝），补 `beforeMoveReserve` 仅测试注入钩子 + 用例 6b 确定性覆盖
  竞争窗口。
- UI 层缺陷（本轮绿测发现并修复）：blocked/busy/rejected 时输入行被收起，
  onNotice 刚写入的原因被抹掉。修复为 `inputSurvivesStructureResult()`：
  applied/unknown 收起，blocked/busy/rejected 保留并显示原因（brief §3）。
