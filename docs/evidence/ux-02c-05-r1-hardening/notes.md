# UX-02C-05-R1 证据目录

父提交 `847f9eb`（UX-02C-05 首轮），本轮只做四处 hardening，不新增文件系统能力。

| 文件 | 说明 |
|---|---|
| `red-suite-107.txt` | **先红后绿**里的"红"：新套件 107 在**未修改的实现**上跑，31 例中 22 例失败；另外 9 例是既有正确行为的回归保护 |
| `mutations.json` | 六个定向变异（`mutate.mjs`）：全部 BITTEN，`sourceChanged` / `restoreExact` 全 true |
| `mutate.mjs` | 变异脚本：改坏一处 → 跑套件 107 → 记录失败用例 → 逐字节还原并比对 SHA |
| `verify-tree-r1.mjs` | 真实浏览器取证脚本（真实 Chrome headless + 真实 Host + 独立 Workspace `weavespace-test/c05-r1`） |
| `cdp.mjs` | CDP 最小客户端（与 UX-02C-04-R1-H1 / UX-02C-05 同一份，未修改） |
| `browser-verification.json` | 21/21 检查 + 真实点击序列（`clickSequence300/450`、`gap300ms/450ms`） |
| `01-slow-dblclick-300ms.png` | 间隔 300ms 的真实双击 → 只进入改名，文件未打开 |
| `02-same-path-replaced.png` | 在途单击期间同路径文件被删除重建（锚变）+ 刷新 → 没有打开任何东西 |
| `03-single-click-opens.png` | 正常单击仍然打开文件（回归） |
| `04-project-rename-draft.png` | 项目A 显示名编辑中（草稿已输入） |
| `05-project-rename-collapsed.png` | 切到项目B 后旧编辑会话已收起，且零 `/api/projects/rename` |
| `gate-test-p0.txt` | `npm run test:p0` 原始输出：1421 例 / 1419 pass / 0 fail / 2 skip |
| `gate-typecheck-build.txt` | `typecheck` / `typecheck:apps` / `build:shell` / `git diff --check` 原始输出 |

## 取证时踩到的两个坑（写下来避免下次重犯）

1. **"同路径替换"不能原地覆盖写**：原地写是同一个 inode，锚不变，打开它是**正确行为**。
   必须删除后重建（换 ino）才算"对象被替换"。第一次跑 R-04 就是因此失败，
   改了场景之后才真正验到"在途点击作废"。
2. **上一轮的 `realDoubleClick()` 是连发**（clickCount 1 → 2，间隔趋近 0），
   恰好绕过了"窗口太短"这个问题。本轮改为两次真实点击之间真的等 300/450ms，
   并用捕获阶段监听器把 `click(detail)` → `dblclick` 的真实序列与间隔记进 JSON。
