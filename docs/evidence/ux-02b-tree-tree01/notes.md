# TREE-01 真实首次加载修复 · 浏览器验证记录

- **日期**：2026-11-15
- **阶段**：TREE-01（在 `D:\Workspace\projects\weavespace` 原目录完成，基线 `404f89b`）
- **性质**：**真实浏览器复现 + 修复后复核**，不是截图桩。

## 环境

| 项 | 值 |
|---|---|
| 页面 | Vite dev server（源码，非构建替身），同源代理到 Host |
| Host | `node --experimental-strip-types tree01-host*.ts <port>` → `createShellServer({ managedStore })` |
| 浏览器 | Google Chrome headless（CDP 驱动、真实点击、`Page.captureScreenshot`） |
| 夹具 | 两个真实目录 `tree01-proj1` / `tree01-proj2`，各含 `docs/` `src/` 子目录与文件 |
| 托管方式 | ①**预置**两项目 store（首次连接）②**空 store + 可编程选择器**（添加项目） |

> 选择器用 `apps/server/src/folder-picker/fake-picker.ts` 替换"用户在系统窗口点了什么"；
> Host 侧协议、逐层读取、持久提交全部是生产实现。**Windows 原生对话框仍未验证**，如实保留。

## 复现（`01-repro-before-fix-stuck-loading.png`、`repro-before-fix.json`）

空托管工作区 → 切真实文件 → 连续添加 proj1、proj2。结果：两个项目的一级子目录
`docs` / `src` **全部停在「正在加载…」**（DOM `loadingCount = 4`），手动刷新根目录才恢复。

抓取的归属探针（`__treeStale`）给出唯一差异维度：

```text
proj1/docs  tKey=null      nKey=82de…  （其余维度全部相等）
proj1/src   tKey=null      nKey=82de…
proj2/docs  tKey=82de…     nKey=eca4…  （其余维度全部相等）
proj2/src   tKey=82de…     nKey=eca4…
```

即：**4 个"意外完成、自动展开的子目录"请求，都因 `workspaceKey` 变化被归属守卫判为
stale**，而 stale 分支一个 dispatch 都不发，层永久停在 `loading`。

## 根因

添加项目时 `settleApplied` 先 `loadRoot`（根层），再 `onWorkspaceKey`。根层落定时
`withInitialExpansion` 让一级目录展开，`TreeBranch` 的 `useEffect` **立刻用当前（旧的、
尚未更新的）`workspaceKey`** 发起子目录请求；随后 `onWorkspaceKey` 合法地把摘要改成新值。
等子目录响应回来，`TreeOwnershipGuard.isCurrent` 发现 `workspaceKey` 不等 → stale →
不派发任何状态 → 层永远「正在加载…」。这与 `add-project.ts` 里早已写下的结论一致
（"不能用 workspaceKey 比对… 正常的添加会被误判成 stale 而丢失"），只是逐层加载器
当时没有同步这一结论。

## 修复

`tree-load.ts`：

1. 新增 `TreeOwnershipGuard.keyChangedWithinSession(ticket)`：**除 `workspaceKey` 外**
   （模式 / 同步模式 / 加载代次 / 全局作废序号 / 项目作废序号 / 该层请求序号）全部一致、
   且 key 确实变了 → 判定为"同一会话内自己提交造成的摘要转移"，不是外部切换。
2. 逐层加载命中 stale 时：
   - 属上述情形 → **用新 key 重发一次**（有上界 `MAX_KEY_REISSUE`），取回本层；
   - 重发用尽仍同会话 → 把 `loading` 收敛为**可重试错误**（绝不永久「正在加载…」）；
   - 真正切走（mode / 代次 / 作废序号变化）→ 维持 `stale`，一个 dispatch 都不发
     （避免把已被 `SET_MODE` 清空的 `treeByProject` 重新长出来）。

`add-project.ts`（要求 8）：`ResyncHost.loadRoot` 返回真实 `TreeLoadOutcome`，
resync 把 `rejected` / `failed` / `changed` / `stale` 记为失败，**不再把根层失败
当成"已重新读取项目列表"**（返回 `ok:false` 并给出项目名）。

## 修复后复核（`02-after-fix-both-projects-loaded.png`、`verification-after-fix.json`）

同一流程（空 store → 添加 proj1、proj2）：

```text
loadingCount = 0                                  （修复前 = 4）
每个项目 childRows = docs / guide.md / src / index.js / readme.md
每个项目状态 = 已加载 5 个条目
treeRequests = 每个子目录出现两次（原始 stale 请求 + 新 key 重发）
```

截图肉眼确认：两个项目均展开、`docs` 下 `guide.md`、`src` 下 `index.js`（proj2 为
`app.py`），**全程没有「正在加载…」**，无需任何刷新。

## 未覆盖 / 边界

- 本记录只验证"添加项目 → 自动展开子目录"与"预置两项目首次连接"两条链路；
- **真实 Windows 原生对话框仍未人工验证**（安全策略禁止从脚本拉起），本记录不能代替它；
- 连续 key 抖动的上界收敛由套件 55 `TREE-01-05` 覆盖（真实环境不会持续抖动 key）。
