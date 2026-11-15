# UX-02B-04A 浏览器验证证据

## 这份证据证明什么、不证明什么

| 证明 | 不证明 |
|---|---|
| 界面链路：披露模态 → T1/T2 → 选择结果 → 持久注册 → 树立即可见 → 重命名 | **真实 Windows 原生对话框**（PA-12 仍为未验证） |
| Host 侧协议：`acknowledgeScope` 形状校验、单飞、202/200 语义、重命名只改显示名 | 真实用户手速下的极端交互 |

选择器用 `apps/server/src/folder-picker/fake-picker.ts`（可编程序列）与
`createDeferredFakePicker()`（"窗口一直开着"）替换。**这只替换了"用户在系统窗口里点了什么"，
链路其余部分（令牌、意图、复核、持久提交、逐层读取）都是生产实现。**

## 环境

- Host：`node --experimental-strip-types host.ts <store> <projA> <projB> 5199`
  → `createShellServer({ managedStore: { dir, picker } })`，即 `--workspace-store` 托管模式。
- Shell：`WS_API_TARGET=http://127.0.0.1:5199 npm --prefix apps/shell run dev -- --port 5198`。
- 浏览器：真实 Chrome（`--headless=new`，1280×900），CDP 驱动点击与截图。
- 被选目录：`%TEMP%/ws04a/projA`（含 `README.md`、`docs/guide.md`）。

## 截图

| 文件 | 场景 |
|---|---|
| `09-add-empty-workspace.png` | 空工作区：标题栏「添加项目」+ 空态说明 |
| `10-add-disclosure.png` | 信任披露模态：三句披露原文 + 取消 / 继续选择文件夹 |
| `11-add-cancelled.png` | 系统窗口取消 → 「已取消选择」，项目数 0 |
| `12-add-applied.png` | 选择成功 → 「已添加「projA」」 |
| `13-add-tree.png` | 不需要重启：根行 + `docs` + `README.md` 已在树里 |
| `14-rename-editing.png` | 行内重命名编辑器（Enter 提交 / Esc 取消） |
| `15-renamed.png` | 改名为「研发资料」，磁盘目录名仍为 `projA` |
| `16-rename-rejected.png` | 空名被拒：错误在上方、名称保持「研发资料」 |
| `17-demo-unsupported.png` | 演示模式：明确说明 + 「继续选择文件夹」禁用 |
| `18-add-picking.png` | 等待系统窗口期间：无按钮、无假取消 |
| `19-add-pending-settled.png` | 202 PENDING 多轮后收敛为「已取消选择」 |

## 关键读数

- `browser-verification.json`：披露三句原文、取消后 `projectRows=0`、添加后
  `rows=["projA","docs","README.md"]`、`leaksAbsolutePath=false`、
  重命名后 `rootRowText=研发资料`、空名 `hint=项目名称不能为空`、演示模式
  `继续选择文件夹.disabled=true`。
- `browser-verification-pending.json`：`pick` 请求 `202 → 202 … → 200` 的完整序列，
  以及连点两次「继续选择文件夹」后 Host 侧 `PICK_CALLS=1`（单飞在编排层，不靠按钮 disabled）。

## 复现注意

- 必须把 `TMP`/`TEMP`/`TMPDIR` 指向长路径（`C:/Users/Administrator/AppData/Local/Temp`）；
  8.3 短路径会让 `inspectProjectRoot` 判成重解析点（`REPARSE_POINT`）。
- 浏览器对 POST 自动带 `Origin`，Node 的 `fetch` 不带；用 Node 驱动真实客户端时需补该头，
  这不是放宽校验，而是还原浏览器的协议条件。
