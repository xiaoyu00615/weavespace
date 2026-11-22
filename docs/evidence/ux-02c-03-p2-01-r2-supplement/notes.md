# UX-02C-03-P2-01-R2-Supplement · 定点补充证据

- 分支：`wip/ux-02c-03-p2-01-r1-trash-safety-20261122`
- 基线（本轮起点）：`3bbb3070213dfb4f837d0e0d5d72c876c9523c62`（R2）
- R1 基线：`6668e3470090ec745dfaf4632a2798d9557e6b47`
- 本轮性质：**定点补充**，不重做 R2；未改 UI、未启动 P2-02、未改 `main`、未动 R2-02/04/06 的实现
- 环境：Windows 11 / NTFS / Node v22.22.2

三件事：A 补 manifest 的 `size`/`deletedAt` 完整核验（含测试）；B 研究 `link + unlink`（只研究，不实施）；
C 修正 R2-01 的测试注释与证据口径。

---

## 1. 任务 A：清单完整性核验

### 1.1 代码位置

| 内容 | 位置 |
|---|---|
| 严格时间戳判定 `ISO_UTC_MILLIS_RE` / `isSystemIsoTimestamp` | `packages/storage/local-provider.ts:816` |
| 清单↔**记录** 的 `size` 对照、`size` 形状（非负安全整数）、`deletedAt` 严格格式 | `packages/storage/local-provider.ts:905-933`（`verifyRestoreSourceReadOnly`） |
| 清单↔**磁盘** 的 `size` 对照 | `packages/storage/local-provider.ts:2580`（`restoreEntry`） |
| 记录大小进入 Provider 的入口（第 4 个参数） | `packages/storage/local-provider.ts:333`（接口）、`:2509`（实现）、`apps/server/src/server.ts:2746`（`fresh.size`） |

### 1.2 为什么把两项比较分开放

三方是 `manifest.size` / 记录 `size` / 磁盘真实大小。若把两项比较写在同一个 `if` 里，
删掉其中任何一项，另一项仍会兜住同一批用例——变异测试就测不出判别力（本轮实测踩到过：
初版把记录侧比较同时写在两处，探针 G2 直接 SURVIVED）。因此：

- **清单 ↔ 记录**：放在只读核验里（两者都在那个函数手上）；
- **清单 ↔ 磁盘**：放在 `restoreEntry` 拿到 `payloadStats` 之后。

每项比较只有一处，删哪一项，对应用例必然失败。

### 1.3 `deletedAt` 的规则与依据

先读生成代码：清单的 `deletedAt` 由 `new Date().toISOString()` 生成（`local-provider.ts:2382`），
即 `YYYY-MM-DDTHH:mm:ss.sssZ`（UTC、毫秒固定 3 位、`Z` 结尾）。据此定两条：

1. 正则必须精确匹配该写法（`+00:00`、省略毫秒、省略 `Z`、自然语言、纯日期一律拒绝）；
2. `new Date(v).toISOString() === v` 往返一致（拒绝 `2026-02-31` 这类"能解析但不存在"的日期）。

只靠 `Date.parse()` 不够：它接受 `November 22, 2026 00:00:00 UTC`、`2026-11-22`、`+00:00` 偏移等写法，
也接受会被规范化到别的日期的值。兼容性方面：系统只会写 `toISOString()` 的结果，
因此严格化不会影响任何由本系统生成的记录（`R2-03p` 用真实回收产物做正向验证）。

错误码分工：**形状不合契约** → `ERR_TRASH_UNAVAILABLE`（"清单不可信"）；
**取值与事实/记录不符** → `ERR_TRASH_STATE_CONFLICT`（"这不是同一次回收"）。

### 1.4 新增/变更用例（`tests/suites/93-...`，25 例）

| 用例 | 场景 | 修复前 | 修复后 |
|---|---|---|---|
| R2-03j | payload 被**追加**字节（清单 size 小于实际大小） | FAIL：`MOVED` | PASS：`REJECTED` / `ERR_TRASH_STATE_CONFLICT` |
| R2-03k | payload 被**截断**（清单 size 大于实际大小） | FAIL：`MOVED` | PASS：同上 |
| R2-03l | 清单 size 为负数 | PASS（R2 已有形状检查） | PASS：`ERR_TRASH_UNAVAILABLE` |
| R2-03m | 清单 size 为非整数（1.5）/字符串/null/布尔 | FAIL：`MOVED`（1.5 当时能过） | PASS：`ERR_TRASH_UNAVAILABLE` |
| R2-03n | `deletedAt` 为非法日期（含 `2026-02-31`、`2026-13-45…`） | FAIL：`MOVED` | PASS：`ERR_TRASH_UNAVAILABLE` |
| R2-03o | `deletedAt` 可被 `Date.parse` 解析但非约定格式（4 种写法） | FAIL：`MOVED` | PASS：`ERR_TRASH_UNAVAILABLE` |
| R2-03p | 系统生成的 ISO + 正确 size（正向对照） | PASS | PASS：`MOVED`，且断言 `toISOString()` 往返一致 |
| R2-03q | **记录** size 与清单不一致（清单与磁盘都是 7，记录说 107） | FAIL：`MOVED` | PASS：`ERR_TRASH_STATE_CONFLICT` |

修复前结果：`before-93.txt`（19 pass / 6 fail）、`before-93-messages.txt`（真实断言文本）。
修复后：`after-93.txt`（25 pass / 0 fail）。

每个拒绝用例都断言了：状态 `REJECTED`、错误码符合契约、payload 字节不变、目标位置不存在，
且不产生额外磁盘副作用（陌生对象/清单不被改写）。

**测试写法上的一处修正**：R2-03m/n/o 需要多个变体，初版把变体循环写在同一个 `withProvider`
里，第一轮就把 `a.md` 移进回收区、后续变体取不到源文件身份（`身份` 断言失败）。
改为"每个变体一个独立临时项目"，失败原因才与变体本身对应。

---

## 2. 任务 C：R2-01 证据口径修正

- `tests/suites/94-...` 中 R2-01a 的注释原写"修复前 → 200 APPLIED"，**不准确**，已改。
- 实际行为（`../ux-02c-03-p2-01-r2/before-94.txt`）：
  `expected: 'ERR_OP_ID_CONFLICT'` / `actual: 'ERR_TRASH_STATE_CONFLICT'`，
  即旧实现仍走重放分支，只是按 `conflicted` 状态回 409。
- `200 APPLIED` 在该夹具下**不可达**：`rootToken` 不一致的记录会被启动对账先改成 `conflicted`；
  本轮没有复现该行为，因此不写成事实。
- 已在 `../ux-02c-03-p2-01-r2/notes.md` 新增 §2.1，说明"实际错误码 + 为什么仍要加 `rootToken` 比较"；
  原始 `before-94.txt` 未改动。
- 套件 94 的用例标题保留"不得返回 APPLIED"（那是对**修复后**行为的断言，不是对修复前行为的描述）。

---

## 3. 任务 B：`link + unlink` 研究结论（不实施）

完整分析见 `link-unlink-analysis.md`，原始实测输出见 `link-unlink-raw.txt`。要点：

- `link` 对已存在目标返回 `EEXIST`（本机实测，含"目标是空文件""目标被打开"两种情形），
  这是 `rename` 没有的**排他创建**语义；
- 但 `link + unlink` **不是原子移动**：中间态是两个名字、`nlink=2`，崩溃后需要新状态与清理动作，
  而当前 `reconcileTrash` 不表达"两个名字同时存在"；
- `link` 不能用于目录（`EPERM`）、不能跨卷（`EXDEV`），所以它**无法**替换 `moveEntry` 的统一实现；
- `nlink` 是当前内部文件"独占"判据（R2-04 依赖 `nlink === 1`），引入硬链接会让这个判据失效；
- 结论：**本轮保留 `rename + 排他占位 + fail-closed`**，不引入原生依赖，不改移动实现。

本文把"实测 / 官方文档 / 推断 / 未验证"四类分开标注，未验证项（SMB/NFS、只读父目录、
APFS/ext4 细节、POSIX `link` 是否穿透符号链接）在文末单列。

---

## 4. 变异探针（G / G2 / H）

脚本：`run-probes-supplement.py`（每个探针施加变异 → 跑套件 93 → 立即还原，并读回校验变异已落盘）。

| 探针 | 撤销的保护 | 期望咬住 | 结论 |
|---|---|---|---|
| G | 清单 size ↔ 磁盘实际大小 | R2-03j / R2-03k | **BITTEN**（2/2） |
| G2 | 清单 size ↔ 配置记录 size | R2-03q | **BITTEN**（1/1） |
| H | 严格 ISO 校验退回 `Date.parse` | R2-03n / R2-03o | **BITTEN**（2/2） |

无未解释的 SURVIVED。上一轮 A–F 的证据原样保留（`../ux-02c-03-p2-01-r2/probe-*.txt`），本轮未重跑、未修改。

**过程中如实记录的一件事**：G2 第一次跑出 SURVIVED。原因不是保护缺失，而是我初版把"清单↔记录"
同时写在两处，删掉一处后另一处仍拒绝 → 用例照样通过。修法是每项比较只留一处（§1.2）。
这条也是"变异测试能发现冗余保护掩盖判别力"的实例。

---

## 5. 附带的测试稳定性修正（R2-04a）

- 现象：第一次取"修复前"证据时，`R2-04a` 偶发失败一次；随后连续 15 次运行均未复现（稳定 25 例里 5 fail）。
- 排查：`R2-04a` 的夹具原本用"删掉临时文件再新建同名文件"来构造替换对象。若文件系统复用刚释放的
  编号，替换对象会与临时文件**同身份**，那测的就不是"另一个对象"了。
- 实测：在本机 NTFS 上做 20 轮"删除→重建同路径"，`dev:ino` **0/20 复用**（`inode-reuse-probe.txt`），
  因此没能把那次偶发归因于此，也不宣称已经定位。
- 处理：把夹具改成"用 `rename` 把事先建好的文件覆盖到临时文件名字上"，替换对象的身份**必然不同**，
  并新增断言 `assert.notEqual(forgedInode, tmpInode)` 锁定这个前提。断言内容没有放宽，
  只是让夹具真的代表"另一个对象"。

---

## 6. 全量门禁（`gate.txt`）

| 门禁 | 结果 |
|---|---|
| `npm run test:p0` | **1067 例：1065 pass / 0 fail / 2 skip**（skip 为既有 `S4R2-08`、`C-04`） |
| `npm run typecheck` | 通过（无输出） |
| `npm run typecheck:apps` | 通过（shell + server） |
| `npm run build:shell` | 通过（`✓ built in 1.35s`） |
| `git diff --check` | 干净 |

定向与回归（`regression-suites.txt`）：87 = 10/10、89 = 6/6、90 = 17/17、91 = 15/15、92 = 12/12、
93 = 25/25、94 = 4/4，全部 0 fail。

---

## 7. 回归与影响面

- `restoreEntry` 增加第 4 个参数（记录字节数）：调用点 9 处（`apps/server/src/server.ts:2746` ×1、
  套件 90 ×3、套件 93 ×5，其中 1 处是测试内部辅助函数）。HTTP 恢复路径由既有套件 87/89 覆盖，
  证明 `server.ts` 传的是 `fresh.size`。
- 未修改 `reservePlaceholderOwned`（R2-02）、`tmpFileStillOwned`（R2-04）、`managedTrashBarrier`（R2-06）。
- 未修改 UI、未新增接口、未改容量上限、未改用户可见文案。

---

## 8. 未解决 / 未验证

1. 记录 `size` 与清单不一致的**端到端**（HTTP）路径没有专门用例：本轮的 R2-03q 是在 Provider 层
   直接传入错误的记录大小；HTTP 侧依赖既有恢复用例证明"server 传的是真实记录大小"。
   要构造端到端夹具需要"改写内存中 Store 的记录并重启 Host"，本轮未做。
2. `R2-04a` 那次偶发失败没有复现、也没能定位根因（§5）；已通过夹具加固消除"同身份替换"这一可能。
3. 硬链接方案的未验证项见 `link-unlink-analysis.md` §6。
4. `docs/27` §7 的 TOCTOU 结论本轮不变。
