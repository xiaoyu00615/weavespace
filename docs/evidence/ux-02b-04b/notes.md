# UX-02B-04B 项目移除 · 真实浏览器验证记录

- **日期**：2026-11-15
- **阶段**：UX-02B-04B（基线 `59ee2ab`，分支 `wip/s11-ux-02b-04b-remove-project-20261115`）
- **性质**：**真实 Host + 真实 Chrome** 的端到端验证（不是桩）。

## 环境

| 项 | 值 |
|---|---|
| Host | `node --experimental-strip-types tree01-host-add.ts 5201` → `createShellServer({ managedStore })`，空托管工作区 + 可编程选择器（proj1 / proj2） |
| Shell | `WS_API_TARGET=http://127.0.0.1:5201 vite --port 5195`（源码） |
| 浏览器 | Chrome headless + CDP，真实点击 + `Page.captureScreenshot` |
| 夹具 | `D:\Workspace\projects\weavespace-test\tree01-proj1` / `tree01-proj2`（各含 docs/ src/ readme.md） |

> 选择器用 `fake-picker` 替换"用户在系统窗口点了什么"；移除链路（T1 令牌、Origin、确认字段、
> Runtime 事务、墓碑、配置）全部是生产实现。**Windows 原生对话框仍未验证**，本记录不代替它。

## 操作序列与实测（`browser-verification.json`）

1. 切真实模式 → 添加 proj1、proj2（两次 pick）→ `twoProjects=[tree01-proj1, tree01-proj2]`。
2. 打开 proj1 的 `readme.md`（`tabOpened=1`）。
3. 直接移除 proj1 → 模态 `data-remove-project="blocked"`，`blockedHasConfirm=false`（**没有**强制移除按钮），
   文案："该项目下还有文件正打开着。请先关闭这些文件，再移除项目。" + "不提供"强制移除"。"，
   项目数仍为 2（**零变更**）。截图 `02-blocked-active-views.png`。
4. 关闭文件标签 → 再次移除 → 模态 `ready`，正文含
   **"移除只会从 WeaveSpace 工作台移除该项目，不会删除磁盘上的任何文件。"**（PB-10），
   按钮 `取消 / 确认移除`。截图 `03-ready-disclosure.png`。
5. 点「确认移除」→ 项目立即从列表消失（组件卸载，`unmountedOnSuccess=true`），
   `projectsAfterRemove=[tree01-proj2]`。
6. **磁盘逐字节不变**：`diskUnchanged=true`（proj1 的 readme.md / docs/guide.md 与 proj2 的 readme.md
   三个 SHA-256 前后完全一致）。
7. 刷新页面 → `afterReload=[tree01-proj2]`（已移除项目不复活，列表正确）。截图 `06-after-reload.png`。

## Host 重启后（补充，控制台实测）

停止并重启 Host（同一 store）后 `GET /api/projects` 仍只返回 `tree01-proj2`；
`tree01-proj1/` 目录与文件仍在磁盘上；`revocations.jsonl` 含 proj1 的墓碑（1 行）。
与套件 56 `PB-07`（重启不复活）一致。

## 关键读数

```text
blockedPhase=blocked, blockedHasConfirm=false, projectCountAfterBlocked=2
readyPhase=ready, readyText 含"不会删除磁盘上的任何文件"
projectsAfterRemove=[tree01-proj2], diskUnchanged=true, afterReload=[tree01-proj2]
```

## 复现注意

- 移除模态原始渲染在树行内（`.tree__root{overflow:auto}` + `.tree{overflow:hidden}`），
  `position:fixed` 的背板被裁掉、用户看不到阻断/确认框——已改为 `createPortal(..., document.body)`。
  本证据是 portal 修复后的复核（模态可见）。
- `TMP/TEMP/TMPDIR` 必须指向长路径，否则 `inspectProjectRoot` 判 REPARSE_POINT。

## 未覆盖 / 边界

- 真实 Windows 原生对话框（添加项目选择器）仍未验证；
- 不可读目录三态、网络中断下的 op 查询 UI 分支由套件 56/57 的故障注入覆盖，未在浏览器里逐一造出。
