# UX-02C-03-P2-01 · 单文件可恢复删除（Host 侧）

基线 `246146ca`（P1-R1 复审通过版）。本轮只做 **P2-01**：存储 + 配置 v4 + Host API + 启动对账 + 测试。
**未做**：UI、目录递归删除、项目根删除、永久删除、自动清理、批量。契约见 `docs/27_UX-02C-03-P2_回收区契约.md`。

## 1. 落地形态

```
<项目根>/.weavespace/             ← 保留命名空间（树里看不到、普通接口不可达）
  .ws-internal                    ← 所有权标记（magic + 目录 dev:ino）
  .gitignore                      ← "*"（自忽略，避免污染用户仓库）
  trash/<opId>/
    manifest.json                 ← 自描述清单（opId/原路径/身份/大小/时间）
    payload                       ← 被移入的对象本体（固定名，规避长路径）
workspace.json (v4)               ← trash[] 状态机（唯一提交点，tmp→fsync→备份→rename）
```

## 2. 事务：意图先于磁盘

删除（`POST /api/trash/entry`）：

```
T1 + Origin + 形状 + 写授权
→ withStructureChange（准入独占 + waitForZeroOps）
→ 屏障内 sessionsUnder(path) → 有 View/草稿即 409
→ entryFacts(path)：只接受普通文件（目录/链接/junction 一律 400，零副作用）
→ beginTrash(pending, identity=I1)      ← 意图落盘（失败=零磁盘变化）
→ provider.trashEntry(opId, path, I1)   ← 排他占位 + rename + 双重身份复核
→ MOVED ? commit(stored) : UNKNOWN → 202
```

恢复（`POST /api/trash/restore`）：对账到 `stored` → 屏障 → `commit(restoring)` → `provider.restoreEntry`
（目标已存在即 409，绝不覆盖）→ `commit(restored)`。

## 3. 为什么这不是 try/catch 原子性

| 中断点 | 磁盘 | 配置 | 重启后判定 |
|---|---|---|---|
| 意图已写、未移动 | 源在 | pending | `aborted`（文件安全在原处） |
| 移动成功、未提交 | 源无、payload 在 | pending | `stored`（补记，可恢复） |
| 恢复已移回、未提交 | payload 无、目标在 | restoring | `restored` |
| 恢复未发生 | payload 在、目标无 | restoring | 回退 `stored` |
| 回收区被替换 | payload 身份≠记录 | stored | `conflicted`（**不判 missing**） |

对账是纯函数 `trash.ts#reconcileTrash`，输入只有磁盘事实（三处身份 + 两个"看不清"标志），
输出目标状态与动作；动作白名单里**没有删除**。启动时扫 pending/stored/restoring，`GET /api/trash` 再对账一次。

## 4. 身份与并发

- 复用 `withStructureChange` / `withStructureDiskOp` / `structureSessionBlockers`（与改名/移动同一套）。
- Provider 在 rename **前**再核 `expectedIdentity`；不符 → `ERR_ENTRY_SOURCE_CHANGED`，替换对象毫发无损。
- 目标用 `open(...,'wx')` 排他占位，只覆盖自己的占位（Windows rename 会覆盖）。
- **未消除**：最后一次身份复核与 rename 之间的竞争（与 moveEntry 同源），占位可能被外部替换；
  已在契约 §6 披露，不宣称原子。

## 5. 保留命名空间

- 展示：`readDir`/`list` 根层过滤（树、`total`、快照哈希、`hiddenCount` 均不含）。
- 访问：`open`、`tree(dir)`、`files/directories/create`、`files/rename|move`（源+目标）、
  `workspace/hide|unhide`、`trash/entry`（源）→ `403 ERR_PATH_RESERVED`。
- 所有权：`.weavespace` 已存在但无标记 / 非空 / 是链接 → `ERR_TRASH_UNAVAILABLE`，绝不接管；
  唯一例外是空目录（上次崩在 mkdir 与写标记之间）。

## 6. 配置 v4

`trash[]` 只在 v4 参与 checksum（按声明版本计算），v1/v2/v3 仍可读、可复算；变更时写回 v4。
上限：未解决 500（满则 `ERR_TRASH_FULL`，不静默丢弃）／总记录 2000（只淘汰不占文件的终态记录）。

项目撤销：**记录保留**（文件还在 `.weavespace/trash`），撤销响应追加 `trashRetained` + 提示文案；
应用内恢复入口随项目失效。

## 7. 测试

新增 3 套件、20 例（全部真实 Host + 真实磁盘 + 真实 HTTP）：

| 套件 | 例数 | 覆盖 |
|---|---|---|
| 87 | 10 | 回收/恢复、二进制字节不变、链接与 junction 拒绝、目录拒绝、恢复冲突不覆盖、回收区目标冲突、opId 幂等与冲突、容量 500、撤销保留 |
| 88 | 4 | 内部目录不出现在树/递归清单、六个公开入口 403、活动 View 409、未保存草稿 409 且草稿保留 |
| 89 | 6 | 意图写失败零副作用、移动成功但提交失败→重启对账 stored→可恢复、意图后崩溃→aborted、恢复中断→重启 restored、回收区被替换→conflicted 且拒绝恢复、Provider 按 expectedIdentity 拒绝 |

修前（红）：22 例全部失败（端点 404 / Provider 方法不存在）。
修后：87 10/10、88 4/4、89 6/6。

既有套件因 v3→v4 版本号变更更新 4 处断言（44-S-23、82-P1-01j/k/k2），语义不变。

## 8. 变异探针（跑完自动还原）

| 探针 | 退回的行为 | 结果 |
|---|---|---|
| A | open 去掉保留路径守卫 | BITTEN（88-P2-01l） |
| B | 回收区身份不符判成 missing | BITTEN（89-P2-01s） |
| C | beginTrash 去掉容量检查 | BITTEN（87-P2-01i） |
| D | trashEntry 去掉第一道身份核对 | SURVIVED（第二道仍拦住，属纵深防御） |
| E | 两道身份核对同时删除 | BITTEN（89-P2-01t） |

结论：D 的存活是**预期**的（同一不变量有两道独立核对），E 证明测试本身判别力足够。

## 9. 剩余风险

| 级别 | 项 |
|---|---|
| P2 | 无永久删除/无清理：满 500 条后必须先恢复（本版本容量是硬约束） |
| P2 | `git clean -xdf` 会清掉 `.weavespace`（`.gitignore` 只防提交） |
| P2 | 撤销项目后记录保留但无应用内入口；重新添加同项目（新 id）不会认领旧记录 |
| P3 | 恢复成功后留下只含 manifest 的空 op 目录（不做自动清理） |
| P3 | 目录回收 / 项目根回收 / 永久删除仍属 P2-02/P3 |
| P3 | v3 二进制无法读取 v4 配置（与 v2→v3 相同的单向升级） |

## 10. 边界

- 未修改 `main`，未建 Worktree/Clone，未生成 ZIP；`package-lock.json` 噪声未提交。
- 未实现任何 UI：`/api/trash*` 目前只有契约与测试，没有菜单/面板。
