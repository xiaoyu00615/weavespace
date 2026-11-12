# apps/shell — WeaveSpace 工作台 Shell（S9-A / S9-B）

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
    StatusBar.tsx          底部状态栏
  state/                   纯数据层：types / workspace-reducer / WorkspaceContext
                           + DocumentActionsContext（打开/编辑/保存/关闭的编排）
  data/demo-project.ts     演示项目树与文档内容
  lib/markdown-parser.ts   块级/行内解析 + 链接协议白名单（纯 TS，无 React）
  lib/markdown.tsx         仅做 AST → React 映射（无 dangerouslySetInnerHTML）
  client/client-api.ts     Client API 边界：demo / live 两种实现
  client/edit-queue.ts     编辑请求串行队列（合并中间态，避免响应乱序回退）
  styles/shell.css         布局与主题
```

布局只由 CSS Grid 与一个 reducer 决定；调整某个区域不需要动其他组件。

## Markdown 解析约定

解析与渲染是两层：`markdown-parser.ts` 是纯函数（无 React / 无 DOM），`markdown.tsx` 只把
AST 映射成 React 节点。解析逻辑因此可以被 Node 直接加载并回归测试，
不需要浏览器或 JSX 转换：`node tests/suites/19-s9a-markdown.test.ts`。

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

## 与 Core 的边界

- 浏览器**不访问**文件系统或 SQLite；真实读写必须经 Core 的 CommandBus + PermissionService。
- `client/client-api.ts` 定义了 Shell 依赖的最小接口：`demo`（内存）与 `live`（HTTP）同构，
  组件不区分模式，只调 `DocumentActionsContext` 的动作。
- **保存的权威是 Core**：`COMMITTED / CONFLICT / FAILED / UNKNOWN` 都按服务端返回值展示，
  UI 不会自行判定成功；`UNKNOWN` 不自动重试。
- 编辑缓冲是本地即时草稿；live 模式下由 `client/edit-queue.ts` 串行提交，
  在途期间的中间态被合并为最后一次输入，服务端返回的内容**不会回填**到编辑器。
- 关闭有未保存修改的 live 标签会被**拒绝**（暂无安全 discard 契约，不虚构成功）。
- 本阶段**未接入**插件系统、AI、多用户权限。

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
6. live 模式没有"另存为/强制覆盖/丢弃未保存"的入口：冲突与失败时只能保留编辑内容。
7. 未做多用户与并发编辑：单进程、单 actor（`local-user`）。
