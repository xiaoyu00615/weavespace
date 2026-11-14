# apps/shell — WeaveSpace 工作台 Shell（S9-A / S9-B / G2）

浏览器端的五区工作台外壳，支持两种模式：

- **演示（demo）**：内置演示数据，绝不读写磁盘；"保存（演示）"只清除未保存标记。
- **真实文件（live）**：通过本地 Client API（`apps/server`）读取授权的测试项目，
  编辑与保存全部经 Core 的 CommandBus + PermissionService。

## 运行

演示模式（无需后端）：

```bash
cd apps/shell
npm install      # 首次
npm run dev      # http://127.0.0.1:5178
```

真实文件模式（两个终端）：

```bash
# 终端 1：启动 localhost Client API（项目根由启动参数给出）
node apps/server/src/main.ts D:/tmp/weave-demo        # 端口默认 5177

# 终端 2：启动工作台
cd apps/shell && npm run dev                          # http://127.0.0.1:5178
```

进入页面后点工具栏的「真实文件」：资源树会替换为服务端返回的授权文件列表。
`/api` 由 Vite 同源代理到 `127.0.0.1:5177`，浏览器侧不需要任何 CORS。

其他命令：`npm run build`（产物 `apps/shell/dist`）、`npm run preview`（5179）、
`npm run typecheck`。根目录还提供 `npm run dev:shell` / `build:shell` / `start:server` /
`typecheck:apps`。

依赖版本在 `package.json` 中固定（非 `^` 范围），并由 `package-lock.json` 锁定。
`apps/shell` 不在根 `tsconfig.json` 的 `include` 范围内；只有纯逻辑模块（`client/edit-queue.ts`）
被 Core 的测试套件引用。

## 组件边界

```
src/
  main.tsx                 挂载入口
  App.tsx                  仅组合 Provider 与外壳
  layout/ShellLayout.tsx   五区网格：导航 | 项目树 | 主工作区 | 辅助面板 | 状态栏
  components/
    GlobalNav.tsx          左侧全局导航（项目/插件/诊断，可折叠）
    ProjectTree.tsx        演示文件树（展开、选择、打开）
    DocumentToolbar.tsx    顶部工具栏（布局切换、演示保存、辅助面板开关）
    TabStrip.tsx           文件标签（切换、关闭、脏标记）
    SplitWorkspace.tsx     单视图 / 左右分屏 + 可拖动分隔条
    DocumentViews.tsx      源码编辑视图与预览视图
    AuxPanel.tsx           右侧辅助面板（AI / 任务 / 诊断，预留）
    PluginPanel.tsx        插件与能力面板：读取真实 Runtime 状态，启用/停用插件
    StatusBar.tsx          底部状态栏
  state/                   纯数据层：types / workspace-reducer / WorkspaceContext
                           + DocumentActionsContext（打开/编辑/保存/关闭的编排）
  data/demo-project.ts     演示项目树与文档内容
  capabilities/            能力注册表（S10-A）：组合根 / 上下文 / 安全渲染 / 错误边界
  client/client-api.ts     Client API 边界：demo / live 两种实现
  client/edit-queue.ts     编辑请求串行队列（合并中间态，避免响应乱序回退）
  styles/shell.css         布局与主题
```

布局只由 CSS Grid 与一个 reducer 决定；调整某个区域不需要动其他组件。

## 能力注册表（S10-A）

Shell 不再 import 任何格式实现；预览按**扩展名**向能力注册表要 `file.viewer`：

```
组件 → useViewer(extension) → ShellCapabilityRegistry.resolveViewer()
       → packages/plugin-runtime.resolveCapability('file.viewer', { extension })
       → 某个已激活插件提供的 ViewerCapability.render()
```

- `capabilities/registry.ts` 是唯一 import 插件的地方（组合根），内置注册
  `weavespace.markdown` 与 `weavespace.plaintext`；注册顺序即优先级。
- **构造只登记、启动是显式步骤**：`createShellCapabilityRegistry()` 不激活任何插件，
  `registry.start()` 由 `CapabilityProvider` 在 effect 中调用一次；`start()` 缓存 Promise，
  StrictMode 重放 effect 不会重复初始化插件。
- 停用 Markdown → `.md` 自动回退到通用文本查看器；文件树、会话、草稿、保存链路均不受影响。
- 两种故障都只影响预览窗格：`renderViewerSafely`（兜同步抛错）+ `ViewerBoundary`（兜渲染期错误）。
- 仍存在的边界：**同进程，无沙箱**；错误边界不等于隔离。

## Markdown 解析约定（实现已迁至 `plugins/markdown/`）

解析与渲染是两层：`plugins/markdown/blocks.ts` 是纯函数（无 React / 无 DOM），
`plugins/markdown/viewer.tsx` 只把 AST 映射成 React 节点。解析逻辑因此可以被 Node 直接加载
并回归测试，不需要浏览器或 JSX 转换：`node tests/suites/19-s9a-markdown.test.ts`。

**块级识别与段落终止共用同一个分类器**（`classifyBlock`）。这是为了避免
「块级分支不接受某行、段落循环却把它当作块级起点」导致 `index` 不前进、
渲染死循环的情况（`#没有空格`、`##`、`|普通文本`、单独的 `|` 曾触发该问题）。
分类器的兜底是 `text`，段落循环只在 `text` 上继续，因此**每轮至少消费一行**；
不认识的语法一律按普通文本输出。

**链接协议白名单**：只放行 `http:` / `https:` / `mailto:` 以及不带协议的相对路径、
锚点、查询串。`javascript:` / `data:` / `vbscript:` / `file:` 等其他显式协议，
以及协议相对写法 `//host`，在解析期就会被判定为不可信：`href` 置 `null`，
渲染层输出原文（纯文本），**不产出任何锚点**。规范化会先剔除 ASCII 控制字符与空格，
避免 `java\tscript:` 这类伪装绕过判断。渲染层始终不调用 `dangerouslySetInnerHTML`。

## 多项目工作区（G2）

- 进入「真实文件」模式时先用 `GET /api/health` 读 `workspaceMode`，**不假定**服务端一定是 Multi：
  - `legacy` → 左列仍是单项目树（`ProjectTree`）；
  - `multi` → 左列是多项目列表（`ProjectList`），`GET /api/projects` 拿项目与状态。
- 多个项目**同时可见**，各自独立的资源树 / 展开状态 / 选中项 / 加载状态，刷新只作用于目标项目。
- 文档 id 使用项目命名空间 `doc:<projectId>/<relativePath>`（`state/doc-identity.ts`），
  `DocTab` 显式记录 `projectId`；A/a.md 与 B/a.md 是不同文档，标签上标注项目名。
- 会话类请求（edit/save/read/disk/reload/close）一律带 `viewId`；`projectId` 由服务端从会话解析，
  前端不会重新声明，也不会据此切换项目。
- 异步响应归属：每个动作发起时固定捕获 `{projectId, docId, sessionId}`，响应回来先比对
  （`isResponseOwnerCurrent`），过期回填直接丢弃，因此晚到的 A 响应不会污染 B。
- 回填磁盘刷新还要多两道判定（`canApplyDiskRefresh`）：**本地编辑代次**未变、且
  `revision`/`baseVersion` 未推进。请求期间用户继续输入时，旧读取结果一律丢弃——
  不允许覆盖缓冲、不允许把 `dirty` 重置为 false、不允许回退版本。
- 打开流程集中在 `state/open-document.ts`：同一 (模式, 文档) 的并发打开合并为一次请求；
  重新打开干净标签时为了核对磁盘会临时 `open` 一次，它返回的 View 不属于任何标签，
  **用完立即 `close`**，标签自己的 `viewId` 始终是唯一受管的那个。
- 模式切换与旧响应：切到 Demo 时在途的 live 打开会直接丢弃并释放新 View，
  不得向 Demo 工作区插入 live 标签；切换项目时标签可以出现，但不会抢走当前焦点。
- 项目失效（UNAVAILABLE）：不再允许打开新的磁盘文件，但既有标签、缓冲与 dirty 标记全部保留；
  保存失败时服务端可能不返回 `document.content`，UI **不会**把它当成空文档——buffer 只由本地编辑驱动。
- 草稿备份键为 `ws:draft-backup:<projectId|local>:<path>`，A/a.md 与 B/a.md 不会互相覆盖。
- 本阶段**不做**：Quick File、工作区持久化、Registry 动态刷新/重绑定、自动会话恢复。

## 手动刷新已打开文件（S11-UX-01A）

用户点刷新（`reloadResources`）时做两件事：重载目标项目的文件树，**并**检查该项目下
已打开文档的磁盘变化。两者都只作用于目标项目；Legacy 的标签没有项目身份（`projectId === null`）。

| 标签状态 | 磁盘变化 | 行为 |
|---|---|---|
| 干净 | 无 | 什么都不做：不建临时 View、不发提示 |
| 干净 | 有 | 经 `open` 重新核对后回填正文 + `baseVersion` + `revision`，仍是干净状态 |
| 有草稿 | 无 | 不误报（判据是 `baseVersion`，不是 `buffer`——自己改的不算外部改） |
| 有草稿 | 有 | **只提示**"存在未保存草稿，未自动覆盖"；草稿 / dirty / 队列 / 版本一律不动 |
| 任意 | 读不到（删除 / 权限 / Host 不可用） | 记为检查失败，标签原样保留 |

约束：

- 编排在 `state/refresh-project.ts`（`reloadResources` 只转发）：文件树与文档层两段，
  以及**生命周期判定**都在那里，测试驱动的是同一条链路。
- **生命周期取消（UX-01A-R1）**：刷新开始即捕获「load 代次令牌 + 工作区身份 + 模式」，
  每段 `await` 返回后都要重新校验；切到 Demo、重新连接或代次推进后，旧刷新不再写资源树、
  项目管理状态、加载标记或提示。判定必须比对**令牌**而不是只比 `mode === 'live'`——
  Demo → Live 切回来模式相同，但请求已属于上一代。
- 刷新**只读**代次令牌（`loadEpoch.current()/isCurrent()`），从不 `start()` / `cancel()`，
  因此不会打断 S11-C 正在进行的恢复；`loadProjectResources` 沿用既有 `isCancelled` 机制。
- 只切换活动项目不会取消已发起的刷新（标签照常同步），但完成时不再写提示，
  避免覆盖用户当前更关心的信息，也绝不夺回焦点。
- 绝不调用 `/api/reload`（它会丢草稿），也绝不把草稿写盘；冲突仍由既有条件保存报告。
- 不伪造保存结论：外部变化只是 `NOTICE`，不写 `lastStatus`，因此不会与真实的 `CONFLICT` 混淆。
- 刷新不改变活动文档、焦点窗格与分屏结构。
- 迟到结果按 `canApplyDiskRefresh` 丢弃：期间发生编辑 / 保存 / 关闭 / 切模式 / 切项目，一律不回写。
- `readDisk` 快照若在读取期间被保存 / 重载推进了基线，直接作废：既不据此报"外部修改"，
  也不触发多余的 `open`。
- 临时 View 在成功、失败、取消（标签已关闭）所有分支都会释放；同一文档已在刷新时，重复点击直接让位。

用户可见的提示合并为一条：`已刷新项目 X 的文件树；N 个已打开文件已同步磁盘变化；a.md 在磁盘上已被修改，但存在未保存草稿，未自动覆盖`。

## Quick File（S11-B）

左列项目树**下方**的独立区域，用于临时查看一个本机文件。它和项目文档是两类东西：

| | Project Document | Quick File |
|---|---|---|
| 身份 | `projectId` + `resourceId` + Core Session | 无项目身份、无 `resourceId`、无 Session |
| 数据来源 | Host → Registry → Provider → 磁盘 | 用户选择的 `File`（浏览器内存） |
| 能力 | 可编辑、可条件保存 | **只读**预览，无保存入口 |
| 生命周期 | 标签 + 草稿 + 冲突恢复 | 单个当前文件，刷新页面即消失 |

- 入口只有两个：拖入单个文件、点击「选择文件」。不扫描目录、不自动加载、不接受文件夹。
- 格式与大小门禁在 `state/quick-file.ts`：仅 `.md` / `.markdown` / `.txt`，单文件 ≤ 2 MiB，
  读取前先判大小；严格 UTF-8 解码 + 二进制签名/控制字节筛查，乱码与二进制直接拒绝。
- 预览**复用 S10-A 能力注册表**：`useViewer(extension)` → `renderViewerSafely` → `ViewerBoundary`，
  没有第二套格式路由；查看器被停用时显示明确降级提示，不影响项目标签与草稿。
- 全程不发 HTTP、不写盘、不改原文件、不进入项目树；`/api/save`、`/api/edit`、`/api/reload`
  与它无关。
- 迟到的读取用代次丢弃：读 A 期间又选了 B，A 的结果整份丢弃，绝不覆盖 B。
- 打开项目文件或点击标签会离开 Quick File 预览（文件仍保留在左列），Quick File 从不关闭任何文档视图。

## 工作区持久化与恢复（S11-C）

刷新浏览器后恢复"界面 + 可验证的文件位置"，**不是**恢复运行期状态。

| 存 | 不存 |
|---|---|
| 折叠状态、导航项、辅助面板、单/分屏、分屏比例、查看模式、焦点窗格 | `buffer` 正文、`sessionId` / `viewId`、`baseVersion` / `revision` |
| 当前项目、各项目展开状态、标签顺序（`projectId` + 相对路径） | `rootDir` / `canonicalRoot` / `rootToken`、Provider、权限 |
| "曾经有未确认内容"这一布尔提示（`hadUnsavedChanges`） | 草稿正文、编辑队列、保存锁、在途请求、Quick File |

- **工作区身份**：Host 在 `/api/health` 返回 `workspaceKey`（项目组合 + 规范根 + 根身份令牌
  的 SHA-256 摘要）。它**只用于匹配恢复记录**，不是授权凭据；浏览器拿不到任何路径或令牌。
  摘要不一致（换根、根被同名目录替换、项目组合变化）→ 只恢复界面，绝不自动打开文件。
  无法确认（Host 离线、旧版服务端）→ 同样 fail-closed。
- **存储**：`ws:workspace:v1:record:<workspaceKey>` + `ws:workspace:v1:last`（指针）。
  写入前走白名单序列化，读取时先判长度（≤64 KiB）再判 JSON 再判结构；版本/枚举/路径/
  数量任何一项不合法就整体丢弃。Storage 不可用或 Quota 满只降级，不影响编辑与保存。
- **恢复顺序**（`state/workspace-restore.ts`）：①连接 Host 并拿摘要 → ②套用界面局部 →
  ③逐项核对（项目存在且 READY、相对路径合法、文件在当前树里）→ ④走 `openDocument` 取得
  **新的** Session/View → ⑤全部完成且用户没动过焦点时才把窗格指回原位。
  标签一律 `OPEN_TAB_BACKGROUND`：恢复不抢焦点（继承 G2-R2），单个文件失败只跳过它。
- **草稿**：不写正文。上次有未确认内容时只记录布尔标记；恢复后如果 Core 里那份会话还在，
  内容会**从服务端会话**取回并如实说"由服务端会话重新取得"，否则明确提示"未保存内容未自动恢复"。
  另外挂 `beforeunload` 原生提醒（dirty / 保存中 / 结果未知），但崩溃或强制退出仍可能丢草稿。
- **不做什么**：不写 `/api/edit`、`/api/save`、`/api/reload`；不重建 STALE 会话；不自动新建
  缺失文件；不迁移根；不持久化 Quick File。恢复出来的标签走正常的编辑/保存链路。

## 与 Core 的边界

- 浏览器**不访问**文件系统或 SQLite；真实读写必须经 Core 的 CommandBus + PermissionService。
- `client/client-api.ts` 定义了 Shell 依赖的最小接口：`demo`（内存）与 `live`（HTTP）同构，
  组件不区分模式，只调 `DocumentActionsContext` 的动作。
- **保存的权威是 Core**：`COMMITTED / CONFLICT / FAILED / UNKNOWN` 都按服务端返回值展示，
  UI 不会自行判定成功；`UNKNOWN` 不自动重试。
- 编辑缓冲是本地即时草稿；live 模式下由 `client/edit-queue.ts` 串行提交，
  在途期间的中间态被合并为最后一次输入，服务端返回的内容**不会回填**到编辑器。
- 关闭有未保存修改的 live 标签会被**拒绝**（暂无安全 discard 契约，不虚构成功）。
- **保存前必须确认草稿已同步到 Core**：若 `applyEdit` 被拒绝或网络失败，保存不会发起，
  草稿与脏标记保留（`client/save-flow.ts`）。保存期间锁定该文档输入，解锁在 `finally` 中，
  不依赖 React 状态是否已刷新；请求另有 20s 超时，避免挂住的请求让保存永久锁死。
- 插件只提供「如何显示」；权限、会话、版本冲突与落盘仍由 Core 强制（`S10A-07` 覆盖）。
- 本阶段**未接入** AI、多用户权限、插件安装/热更新。

## 已知限制

1. 演示数据写死在 `data/demo-project.ts`，刷新即恢复初始内容（live 模式刷新后需重新打开文件；
   Core 会话仍在服务端，重开会复用同一会话）。
2. 演示模式下关闭有未保存修改的标签仍用 `window.confirm`；live 模式直接拒绝关闭。
3. 分屏固定为「左源码 / 右预览」两窗格，不支持嵌套、上下分屏与拖拽停靠。
4. Markdown 渲染只覆盖标题/列表/引用/代码/强调/链接/简单表格，不是完整 CommonMark；
   链接只支持白名单协议，`[x](javascript:…)` 这类写法按纯文本显示（刻意降级）。
5. UI 验证方式：`tsc` + `vite build` + 解析器回归套件（`tests/suites/19-s9a-markdown.test.ts`）
   + 端到端接口测试（`tests/suites/20-s9b-live-file.test.ts`）+ 真实 Chrome（CDP）冒烟；
   仓库内未引入 playwright/puppeteer，浏览器冒烟脚本不随仓库分发。
6. 插件面板只支持启用/停用内置插件；没有安装、来源校验与签名。
7. 多项目下**没有**项目切换器的"下拉"形态：项目列表常驻左列；分区折叠是纯 UI 状态，刷新页面即恢复默认展开。
8. 冲突恢复：出现 `CONFLICT` 时工具栏下方出现恢复面板，可「查看磁盘版本」「复制草稿」
   「重新加载（丢弃草稿）」。重新加载需要 `window.confirm` 明确确认；确认前会把草稿备份到
   `sessionStorage`（`ws:draft-backup:<path>`）并尽力复制到剪贴板；
   **两条备份都失败时不会发起重载**，只提示用户手动复制（`client/draft-backup.ts`）。
   重载失败或取消时草稿保持不变。
   仍没有"另存为/强制覆盖"入口。
9. 未做多用户与并发编辑：单进程、单 actor（`local-user`）；`viewId` 是归属校验标识，不是认证凭据。
