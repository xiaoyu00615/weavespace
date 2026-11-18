# UX-02C-03-P1 · 工作台隐藏 / 取消隐藏 —— 验收记录

基线 `f603579`（R1.3 已关闭）→ 本轮提交见文末。
本轮**只做可见性**：没有任何磁盘删除、移动、写入项目内容的能力被新增或调用。

---

## 1. 结论摘要

| 项 | 结果 |
| --- | --- |
| `npm run test:p0` | 957 例 / **955 pass / 0 fail / 2 skip** |
| `npm run typecheck` / `typecheck:apps` | 通过 |
| `npm run build:shell` | 通过（408.93 kB / gzip 125.11 kB） |
| `git diff --check` | 通过 |
| 真实 Chrome | **20/20** 断言通过（6 张截图，含 1 张 3× 局部放大） |
| 磁盘副作用 | 隐藏/取消隐藏**零变更**；只有显式「保存」会写磁盘（逐字节断言） |
| `workspaceKey` | 隐藏前后、重启前后完全一致 |
| 未保存草稿 | 隐藏期间标签、草稿、保存、视图全部不受影响 |

---

## 2. ConfigState v3（P1-01）

```ts
interface ConfigHiddenEntry {
  projectId: string;   // 作用域：同名路径在别的项目不受影响
  path: string;        // 规范化项目内相对路径（正斜杠、无 ..、非空）
  rootToken: string;   // 隐藏时的项目根身份
  identity: string;    // 隐藏时的对象身份 `${dev}:${ino}`（lstat，不跟随链接）
  hiddenAt: string;    // ISO 时间，仅诊断用
}

interface ConfigState {
  version: 3;
  commitSeq: number;
  issuedIds: string[];
  revoked: ConfigRevokedEntry[];
  projects: ConfigProject[];
  hidden: ConfigHiddenEntry[];   // ← 新增
}
```

**迁移与兼容**

- `parseConfig` 继续接受 v1 / v2 / v3；内存里统一升级为 v3 视图（`hidden: []`）。
- **校验和按文件声明的版本计算**：v2 文件不含 `hidden` 字段参与哈希，否则升级那一刻所有
  历史配置会被判成损坏。`serializeConfig({version:2,...})` 仍写出 v2 + v2 校验和
  （既有夹具与测试不动）。
- 首次变更（添加/改名/隐藏）才写回 v3；只读路径不产生任何写盘。
- 解析期约束：路径必须与 `validateEntryPath()` 的结果完全一致（反斜杠 / `..` / 绝对路径
  一律视为损坏）；同一项目内同路径（Windows 大小写不敏感）重复即判损坏；上限
  `MAX_HIDDEN_ENTRIES = 2000`。
- 提交纪律沿用现有原子写：tmp → fsync → 备份 → rename；**配置写入就是唯一提交点**，
  写失败抛 `ERR_PERSIST_FAILED` 且内存投影不变（有 store 级用例）。
- 项目撤销时 `commitRevoke` 同步删掉该项目的隐藏记录；加载期投影也会丢弃已撤销项目的记录。
- `workspaceKey` 派生只吃 `projectId + canonicalRoot + rootToken`（`project-runtime.ts:978`），
  隐藏记录**不参与**，因此不会让恢复记录失配（用例 01l 断言前后一致）。

---

## 3. Host API 契约（P1-02）

```
POST /api/workspace/hide      { projectId, path }
  → 200 { status:'APPLIED', projectId, path, hidden:true, changed:boolean }
  → 400 ERR_COMMAND_INVALID      （路径形状不合法 / 项目根不可隐藏 / 记录超上限）
  → 403 ERR_PERMISSION_DENIED    （缺 T1 令牌 / 无显式 Origin / 无写授权）
  → 403 ERR_PATH_OUTSIDE_ROOT    （路径经过重解析点，例如链接节点）
  → 404 ERR_RESOURCE_NOT_FOUND   （对象不存在）
  → 409 ERR_PROJECT_BUSY         （结构变更进行中 / 项目不可用）
  → 501 ERR_COMMAND_UNSUPPORTED  （Demo / Legacy / 静态 Multi，或 Provider 无身份能力）
  → 500 ERR_PERSIST_FAILED       （配置写不进去；内存不变）

POST /api/workspace/unhide    { projectId, path }
  → 200 { status:'APPLIED', projectId, path, hidden:false, changed:boolean }
  → 不要求文件仍然存在（外部删除后必须能清掉记录）

GET  /api/workspace/hidden?projectId=...
  → 200 { status:'APPLIED', projectId, entries:[{ path, state }] }
    state ∈ active | missing | rebound | unverified
```

`GET /api/tree` 扩展：

- 查询参数 `includeHidden=1`（默认不返回隐藏条目）；
- 条目新增 `hidden:true`（自身记录）与 `hiddenBy:'docs'`（被上级隐藏）；
- `page.hiddenCount` = 本层隐藏条目数（**过滤前**统计，默认视图下仍然给出）；
- 过滤发生在 `buildTreePage` **之前**，所以 `total / nextCursor / snapshot` 与返回集合自洽；
  `hiddenCount` 参与 `directorySnapshotOf` 哈希 → 隐藏集合变化必然让旧游标续页 409。

---

## 4. 执行流程（隐藏）

```
右键行「从文件树隐藏」
 → TreeCommandsContext.toggleVisibility（单飞）
 → DocumentActions.hideEntry
 → POST /api/workspace/hide
     模式(501) → T1(403) → Origin(403) → 体/路径(400，零 IO)
     → requireProjectHandle（G-DISK：ACTIVE / 未 QUIESCING）
     → permission.authorize(write, path)
     → withDiskOp: provider.identityOf(path)      ← 只读 lstat，不跟随链接
     → store.commitHidden（原子写 workspace.json）
 → APPLIED → applyVisibilityChange：
     invalidateLevel(父层) + 重新加载父层；
     若该路径下已加载过子层，一并作废重取（让子行带上「随上级隐藏」）
 → 提示：「已从文件树隐藏「x」（磁盘文件未删除、内容未改动；可用「显示隐藏项」找回）」
```

取消隐藏走同一条链路，只是提交 `hidden:false`（不需要 `identityOf`，因为文件可能已不存在）。

`src` 侧状态：`state.showHidden` + `showHiddenRef`（同步镜像，避免 dispatch 与紧随其后的
重新拉取之间读到旧值——真实浏览器里复现过"点了开关没变化"）。切换时对所有项目
`TREE_RESET` 并重取当前项目根层；展开态保留，因此子层会按需自动重取。

---

## 5. 四种记录状态（P1-05）

| 状态 | 判定 | 对默认视图 | 说明 |
| --- | --- | --- | --- |
| `active` | 当前 `dev:ino` == 记录 | 隐藏 | 正常 |
| `missing` | `lstat` 返回不存在 | **不隐藏**（也没东西可隐藏） | 文件被外部删除 / 被工作台改名移动后旧路径失效 |
| `rebound` | 身份不同 | **不隐藏** | 同名路径被换成另一个对象；旧记录保留但不再生效 |
| `unverified` | 无法核验（Provider 无身份能力 / IO 异常） | 仍然隐藏 | 见下 |

**关键设计决定 1：保存会换 inode。** 工作区的保存是"临时文件 + rename 覆盖"，必然产生
新对象。若不处理，用户隐藏一个文件后编辑保存，记录会立刻被判成 `rebound`，文件从默认
视图里"复活"。因此 `/api/save` 在 `COMMITTED` 之后刷新同路径隐藏记录的身份
（`refreshHiddenIdentityAfterSave`）：只刷新**已有记录**的路径，失败不影响保存结论，
记录会停在 `rebound` 并在查询接口里如实可见（用例 85-04c，探针 P2 咬住）。

**关键设计决定 2：`unverified` 继续隐藏。** 核验失败不是"换了对象"的证据；在拿不准时
把用户明确隐藏过的内容重新暴露出来，比暂时保持隐藏更糟。这是一个显式的、写在注释里的
取舍，而不是"默认值恰好如此"。

**链接节点不支持隐藏。** `resolveInBoundary` 对"路径经过重解析点"一律拒绝
（`ERR_PATH_OUTSIDE_ROOT`），与"链接打不开/不展开"是同一条边界。右键菜单对链接不渲染该项。

**改名/移动不迁移记录。** 旧路径的记录变成 `missing`，新名字下可见。这是明确的取舍：
隐藏是路径级元数据，跟随移动需要额外的身份映射与冲突语义，留给 P2/P3 讨论。

---

## 6. 测试

| 套件 | 内容 | 用例 |
| --- | --- | --- |
| 82 | Host API + 持久化（真实 `FileProjectStore` + 真磁盘） | 17 |
| 83 | 分页/快照/链接/根路径（多页遍历） | 6 |
| 84 | Shell 客户端 + 层表模型 + 菜单判定（真实 HTTP） | 8 |
| 85 | 草稿/会话保护 + 保存换 inode + 路径失效 | 5 |

新增/更新：82–85 为新套件；`44`（S-23 迁移目标版本 2→3）与 `80`（层状态夹具补
`hiddenCount: 0`）各改一行断言/夹具，用例本身保留。

**实现前红测**（真实记录）：82 的 17 条全部失败（端点当时是 501 / `ConfigState` 无
`hidden`）、83 的 6 条全红、84 因 `apps/shell/src/state/visibility.ts` 不存在而无法加载。

**变异探针**（`ws-p1-probes.py`，跑完自动还原）：

| 探针 | 变异 | 咬住的用例 |
| --- | --- | --- |
| P1 | `/api/tree` 不做隐藏过滤 | 82 ×7、83 ×3、84 ×1 |
| P2 | 保存后不刷新隐藏身份 | 85-04c |
| P4 | `rebound` 也当作仍隐藏 | 82-01m、85-05b |

---

## 7. 真实浏览器（`green/browser-verification.json`，20/20）

| 断言 | 证据 |
| --- | --- |
| 隐藏后默认树不再显示 | `treeHasA=false` |
| 隐藏不改动磁盘内容 | 前后都是 `# a.md\n` |
| 隐藏不关闭标签 / 不丢草稿 | tabs 1→1；编辑器内容仍是 `# DRAFT-BEFORE-HIDE` |
| 提示说明文件未被删除 | 通知原文含「磁盘文件未删除、内容未改动」 |
| 隐藏中的文件可以正常保存 | 磁盘变成 `# DRAFT-BEFORE-HIDE\n` |
| "显示隐藏项"是真实交互 | `aria-pressed` false→true，条目回来并带徽标 |
| 隐藏项有明确标记 | `badgeA='隐藏'`，几何 32×16 @10px，局部放大图可读 |
| 取消隐藏后标记消失 | `badgeA=''` |
| 隐藏目录从默认树消失 | 默认视图 `docs` 消失 |
| 子项标记"随上级隐藏" | `guide.md` 徽标 `随上级隐藏` |
| 取消父目录不清子记录 | `docs` 徽标空、`sub` 徽标仍为 `隐藏` |
| 默认视图恢复 | `docs` 可见、`sub` 仍隐藏、开关回到 false |
| 记录持久化在 Host 配置 | `/api/workspace/hidden` 返回 `docs/sub: active` |

截图：`00-initial-tree.png`、`01-hidden-draft-kept.png`、`02-show-hidden-on.png`、
`02b-tree-zoom.png`（3× 局部放大）、`03-dir-hidden-with-subtree.png`、
`04-parent-child-independent.png`、`05-default-view-restored.png`。

浏览器阶段发现并修掉的两个真实问题：

1. **保存后隐藏失效**（上方"关键设计决定 1"）——第一次跑就在 `stage3` 暴露：徽标消失、
   条目复活。
2. **开关首次点击不生效**：`dispatch` 后立刻重新拉取，`stateRef` 仍是旧值。改为
   `showHiddenRef` 同步镜像。
3. 视觉：带文字的胶囊按钮在 260px 侧栏里把工具栏挤到换行（已复现），改为图标按钮 + 计数；
   `.tree__meta` 被挤成"一个字一行"，改为单行截断。

---

## 8. 剩余风险与未做项

| 级别 | 项 | 说明 |
| --- | --- | --- |
| P3 | 外部编辑器以"新建 + rename"方式保存时，隐藏记录会变 `rebound`，文件重新可见 | 与"不把新对象当旧对象"是同一个判据的两面；查询接口可见 `rebound`，取消隐藏即可清理 |
| P3 | `identityOf` 与后续 `readDir`/`save` 之间仍有竞争窗口 | 与 R1-05 同源（无原子 no-replace），只影响"隐藏是否正好赶上一次替换" |
| P3 | 隐藏记录上限 2000/工作区，超过后 `ERR_COMMAND_INVALID` | 明确拒绝而不是静默截断；P1 未做分批/分项目配额 |
| P3 | 移动/改名不迁移记录 | 旧路径记录变 `missing`，新名字可见（见 §5） |
| — | 删除 / 回收站 / 项目根真实删除 | **本轮未实现**，属 P2/P3 |

---

## 9. 交付边界

- 未修改 `main`（仍 `79b99e5`），未新建 Worktree/Clone，未生成 ZIP。
- `apps/shell/package-lock.json` 的版本噪声**未处理**（基线既有）。
- 未实现任何磁盘删除能力；`packages/storage` 只新增了一个只读的 `identityOf()`。
