# UX-02C-04 证据：资源标注名、标签与文件树颜色

## 0. 基线与范围

| 项 | 值 |
|---|---|
| 仓库 | `xiaoyu00615/weavespace` |
| 基线提交 | `8143a379d07776aceb88b7eb451f447eca36fdc3`（本阶段开始时的 HEAD） |
| 分支 | `wip/ux-02c-04-resource-metadata-20261127` |
| `main` | `79b99e5`（未修改） |

本轮只做**工作台展示元数据**：标注名 / 标签 / 行颜色。不做搜索、筛选中心、批量标注、
新文件格式、主题系统与 UI 重构。

## 1. 架构调查结论（实施前实际读代码）

- 工作区配置是 `store/config.ts` 的 v4（checksum 按"文件声明版本"复算），元数据必须
  进这份配置并升 v5；
- 资源身份已经存在：`StorageProvider.identityOf()` → `dev:ino`，隐藏记录用的是
  `projectId + path + rootToken + identity` 四元组；
- 结构变更（改名/移动）有完整的事务结果 `APPLIED/REJECTED/UNKNOWN`；
- 回收区记录自带身份，恢复时三方核对。

因此**没有**新增数据库、没有第三套浏览器持久化、没有第二套资源身份。

## 2. 本次实现

### 2.1 存储（Host）

- `ConfigState` 升到 **v5**，新增 `metadata: ConfigMetadataEntry[]`；
  v1–v4 只读兼容（内存升级为 v5 视图，写回时才升版），校验和按声明版本复算；
- `MAX_METADATA_ENTRIES = 2000`，超限 → 409 `ERR_METADATA_LIMIT`（不静默淘汰）；
- 配置里"三个展示字段全空"的记录视为损坏（"没有标注"只有一种表示）。

### 2.2 服务（Host）

- `apps/server/src/metadata.ts`：请求解析（禁字段 / 路径 / 标注名 / 标签 / 颜色）、
  记录核验（`active|missing|rebound|unverified`）、给一层条目打标；
- 端点：`POST /api/metadata/set`（**增量**三态语义）、`POST /api/metadata/clear`、
  `GET /api/metadata`；
- `/api/tree` 的条目带 `meta`，根层带 `projectMeta`；**元数据不参与目录快照**
  （改颜色不该让正在进行的翻页作废）；
- 结构变更 `APPLIED` 后迁移路径（`commitMetadataMove`），失败不回滚磁盘、
  在响应里如实给 `metadataMigration: 'moved'|'none'|'failed'`；
- 回收/恢复**没有**任何新钩子：记录靠身份自动 `missing` → 恢复后重新 `active`。

### 2.3 共享契约

`packages/contracts/metadata.ts`：颜色 token、长度上限、`normalizeAliasText` /
`normalizeTagList`。Host 与 Shell 用**同一份实现**，避免"输入框允许、保存 400"。

### 2.4 Shell

- `state/resource-metadata.ts`（纯 TS）：草稿、只发改动字段的补丁、菜单可用性、
  颜色类名、标签摘要；
- `state/MetadataContext.tsx`：单飞提交 + 保存后只刷新该路径所在层 + UNKNOWN 处理；
- `components/ResourceMetadataDialog.tsx`：三段式编辑（标注名/标签/颜色）+ 清除全部；
- `components/FileTreeRow.tsx`：`名称（标注名）` + 标签胶囊 + 颜色类名；
- `components/TreeCommandsContext.tsx`：右键三个入口（焦点分派）；
- `ProjectList`：项目根行用根层 `projectMeta`。

## 3. 测试

| 套件 | 例数 | 覆盖 |
|---|---|---|
| 101 `metadata-host` | 33 | 配置 v5/校验和/迁移、增量语义、标签规范化、上限、保留路径、跨项目与同名隔离、改名/移动/目录改名迁移、失败不迁移、rebound、missing、根标注、回收/恢复、清除孤儿 |
| 102 `metadata-shell` | 19 | 层表穿透、根层 projectMeta、草稿差异、标签拒绝、菜单可用性、请求体形状、UNKNOWN、非法字段窄化 |

原始输出：`suite-101.txt`、`suite-102.txt`；全量：`gate-test-p0.txt`。

## 4. 真实浏览器验收

环境：真实 Host（5297）+ 真实 Vite（5298）+ 真实 Chrome（headless，CDP 9347）+
真实文件系统 `D:/Workspace/projects/weavespace-test/c04`（两个项目）。

两段（Host 真的重启过）：

1. `PHASE=1`（`phase1.log`，19 项）：给 `projA/note.md` 设标注名 → 两个标签 → blue 颜色；
   每步断言行上展示、文件 SHA-256 不变、目录结构不变；随后断言接口记录 `active`、
   配置升到 v5 且旧字段仍在；最后刷新浏览器仍显示三项。
2. `PHASE=2`（`phase2.log`，22 项）：重启 Host 后三项仍在 → 真实改名（标注跟随）→
   真实移动到 `docs/`（标注跟随）→ 回收（记录不丢）→ 在同路径放一个同名新文件
   （**不继承**，`rebound`）→ 恢复原文件（标注重新生效、SHA 一致）→ 跨项目同名文件
   互不影响 → 清除全部标注后恢复默认、配置里没有记录、文件本身未变。

汇总：`browser-verification.json`（41/41），截图 `06-tree-annotated.png`、
`07-metadata-dialog.png`。

### 4.1 过程中被真实浏览器逼出来的两处修正

1. **文件名被挤没**：`.tree__name { flex: 1 }` 的 `flex-basis: 0` 让标注名与标签把
   文件名压成 `note...`。改成 `flex: 1 1 auto` + `min-width: 5em`，并让标注名
   （收缩系数 2）先让位。
2. **三样放不下**：260px 侧栏里"名称 + 标注名 + 两枚标签"必然互相挤。定下规则：
   **有标注名时行内标签折成 `+N`**（内容进 `title` 与对话框）；没有标注名时最多两枚。
   这条规则是产品决定，已写进契约 §6.1。

## 5. 变异探针（`mutations.json`）

| 编号 | 变异 | 结论 | 咬住 |
|---|---|---|---|
| C04-A | 读取侧不再区分 `rebound` | **BITTEN** | M-B08、M-C01 |
| C04-B | 改名/移动后不迁移路径 | **BITTEN** | M-B04、M-B05、M-B06 |
| C04-C | 去掉标签大小写不敏感去重 | **BITTEN** | M-A06、M-D01 |
| C04-D | 颜色接受任意字符串 | **BITTEN** | M-A08 |

四次都 SHA-256 变化 → 跑套件出现指名道姓的失败 → 还原后与基线逐字节一致。

## 6. 门禁

见 `gate-test-p0.txt` 与 `gate-checks.txt`（本轮实跑）。

## 7. 未解决 / 有意的边界

1. **没有全局标签表**：同名标签在不同资源上是独立字符串；搜索/筛选中心是后续阶段。
2. **没有自动清理失效记录**：文件在外部被删除后记录保留（`missing`），
   直到用户清除或达到上限。理由是自动清理无法区分"暂时移走"与"真的没了"。
3. **根标注只到展示层**：项目根不能被改名/移动/回收，标注只是给它一个别名。
4. **标签行内折叠**：有标注名时只显示 `+N`（见 §4.1），完整列表在 `title` 与对话框。
5. **`metadataMigration: 'failed'` 没有自动重试**：磁盘确实变了，重试会重复一次真实操作；
   界面只提示"标注未能写入配置，请重新设置"。
6. **未做**：跨标签页实时同步（另一个标签页改标注后，本页要刷新才看到）。
   与隐藏/回收同一现状，未在本轮扩大范围。
