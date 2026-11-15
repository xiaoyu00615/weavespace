# UX-02C-01 文件创建与右键菜单基础框架 · 验收记录

基线：`92ec479a0cfa1ada94e8ddba27a38b205541091b`（UX-02B-05 已通过 GPT 复审并关闭）
分支：`wip/s11-ux-02c-01-file-create-20261115`。只在原开发目录工作，未新建 Worktree / Clone，未动 `main`。

## 一、红 → 绿

| 套件 | 内容 | 红（基线 Host） | 绿（本轮） |
|---|---|---|---|
| 69 | Host 真实创建与安全（17 例） | 15 fail / 2 pass（端点未接线，404/501） | **17 pass / 0 fail** |
| 70 | Shell 编排、能力注册表、请求体形状（13 例） | 与实现同期落地，判别力由 4 个变异探针证明 | **13 pass / 0 fail** |

红测做法：把 `apps/server/src/server.ts` 临时替换为基线版本（其余新模块保留），
套件 69 的 C-01/C-02/C-04 等全部因端点不存在而失败；恢复实现后全绿。

变异探针（每条都咬住自己的用例，不夸大判别力）：

| 探针 | 变异 | 结果 |
|---|---|---|
| P1 | 去掉 `createEntryRunner` 的单飞锁 | C-11b 红 |
| P2 | UNKNOWN 分支偷偷再发一次 `create` | C-11 红 |
| P3 | 文件夹右键误判成"父目录" | C-03 红 |
| P4 | 能力注册表未就绪也列出扩展名 | C-13b 红 |

## 二、实现边界（只做 02C-01）

- **Host**：`packages/storage/entry-name.ts`（纯名称/父目录校验）、
  `local-provider.createEntry()`（`wx` 排他空文件 / 非递归 `mkdir` 空目录、
  C0/C1/C4 根连续性、副作用后确认失败 → `UNKNOWN`）、
  `apps/server/src/create-entry.ts`（请求形状 + 写授权 + `withDiskOp` 编排）、
  `server.ts` 的 `POST /api/files/create`、`POST /api/directories/create`。
- **Shell**：`client-api.ts` 增加 `createEntry`（UNKNOWN 独立结论）、
  `state/create-entry.ts`（目标解析 + 行内命名初值/选区 + 单飞 runner）、
  `DocumentActionsContext` 增加 `createEntry` 与 `refreshTreeLevel`（只失效目标层、
  幂等展开目标文件夹、不递归、不动其它项目 / 标签 / 草稿 / workspaceKey）。
- **UI**：`ContextMenu.tsx`（portal、视口夹取、Esc/外部点击、鼠标与键盘子菜单、
  未来命令占位但不渲染假菜单）、`TreeCommandsContext.tsx`（菜单与工具栏共用编排）、
  `InlineCreateRow.tsx`、`TreeToolbar.tsx`；`ProjectList` / `TreeBranch` /
  `ProjectTree` / `FileTreeRow` 只挂事件与渲染槽，不复制业务逻辑。
- **能力注册表**：两个 manifest 增加 `displayName`；`supported-extensions.ts`
  从**当前 ACTIVE 且能解析查看器**的插件推导二级菜单，没有硬编码扩展名清单。
- 未改：`document.save`、`/api/resources`、项目移除/撤销事务、授权规则。

## 三、真实 Chrome（headless + CDP）操作结果

环境：真实托管 Host（managedStore 在 `weavespace-test`）+ Vite dev（5210 → Host 5211）
+ Chrome headless（CDP 端口 9365/9366）。选择器是 fake-picker，**不是** Windows 原生对话框。

`browser-verification.json` 关键结果：

| 步骤 | 结果 |
|---|---|
| 添加两个项目 | `ux02c01e-projA` / `ux02c01e-projB` |
| 右键项目根 | 菜单四项：新建文件 / 新建文件夹 / 创建已支持的扩展文件 / 刷新项目根 |
| 二级菜单 | `Markdown (.md)`、`Markdown (.markdown)`、`纯文本 (.txt)` |
| 键盘操作子菜单 | ↓ ↓ → Enter 打开行内命名：`keyboardOpenedNaming: true` |
| 真实鼠标悬停 | `Input.dispatchMouseEvent` 悬停父项 → 3 项二级菜单（`09-real-mouse-hover-submenu.png`） |
| 预设扩展名 | 输入初值 `.md`，选区 `[0,0]`（只选中主文件名，扩展名保留） |
| Enter 创建 | `123.md` 真实存在、**0 字节**，树中出现 |
| Esc 取消 | 输入行消失、目录条目集合不变、`should-not-exist.md` 不存在 |
| 顶部按钮 | 新建文件夹 → 磁盘目录真实存在且树中可见；刷新当前目录后 `123.md` 仍在 |
| 非法名 / 重名 | `CON.txt` 行内报"系统保留名"、磁盘零写入；重复 `123.md` 报"已有同名…未覆盖"且 SHA-256 不变 |
| 右键文件夹 | 菜单显示"刷新此目录"（上下文正确） |
| 项目隔离 | B 项目仍只有 `b.md`，没有 `123.md` |
| 请求体 | 3 次 POST 全部只有 `{projectId,parentDir,name}`，无任何绝对路径 / rootDir / rootToken / providerId |

截图：`01-two-projects.png` … `09-real-mouse-hover-submenu.png`（共 10 张）。

## 四、磁盘与重名保护

- 新建 `123.md`：`statSync().size === 0`（无标题、无模板）。
- 新建 `新建文件夹`：`isDirectory() === true`，文件树可展开。
- 重复创建 `123.md` 前后 SHA-256 一致；同名目录 `docs` 也拒绝（409 `ERR_ENTRY_EXISTS`）。
- 并发同名最多成功一次（真实 `wx` 排他，C-07）。
- 非法路径 / 保留设备名 / 尾随空格句点 / junction 父目录 / 缺失父目录全部零副作用拒绝。

## 五、五项门禁

`npm run test:p0` 833 tests（832 pass / 0 fail / 1 skip）、`npm run typecheck`、
`npm run typecheck:apps`、`npm run build:shell`、`git diff --check` 全绿。

## 六、尚未解决的边界

1. **Windows 原生目录对话框**仍未由自动化验证（沿用 fake-picker；此前由用户人工验收）。
2. 创建成功后若目标层还有未加载分页，新节点可能不在当前页；实现**不伪造可见性**，
   只提示"刷新该目录后可见；未加载到的分页不声明已显示"。后续阶段可考虑按名称定位续页。
3. `UNKNOWN` 只做一次只读层刷新 + 人工核对提示，没有像移除操作那样的持久 `opId`
   证据链（创建阶段没有独立事务编号）；本契约明确禁止以"发现同名"推断成功。
4. 未来命令（rename / move / delete-local / hide-from-workspace / set-alias /
   set-tags / set-row-color）只在注册表占位，未实现、未渲染。
5. 自由输入 `.json` 等扩展名允许创建，但不代表查看器已支持；点击仍按能力注册表拦截。
6. 链接节点只允许显示，不允许沿链接创建；Windows junction 的父链校验已在 Host 落地，
   但"检查与系统调用之间"仍是分阶段检查（非目录句柄原子锁），与既有写入链路同一限制。
