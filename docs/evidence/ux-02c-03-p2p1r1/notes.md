# UX-02C-03-P2-01-R1 回收区安全缺陷修复 · 证据

基线 `52cc2a25`（父 `246146ca`），分支 `wip/ux-02c-03-p2-01-r1-trash-safety-20261122`。
本轮只做 Host/存储层安全修复，不含 UI，不进入 P2-02。

## 1. 红测 → 绿测

| 套件 | 修前 | 修后 | 说明 |
|---|---|---|---|
| 90 Provider 占位/内部路径 | 16 例，**8 例红**（01a/01c/01d/02a–02e） | **17/17 绿** | 占位被 0 字节对象替换、marker 链接/硬链接/目录、`.gitignore` 链接、marker 更新方式 |
| 91 并发/CAS/授权/重放 | **无法加载**（`trashOutcomeOf` 未导出）→ 全红 | **14/14 绿** | 判别力由探针 D/E/H 证明（见 §2） |
| 92 对账异常对象 | 12 例，**6 例红**（表驱动 4 例 + 06k/06l） | **12/12 绿** | `unsafe` 不得落到 `missing` |

典型修前行为（真磁盘）：

- `R1-01a`：回收时占位被外部 0 字节文件替换 → 修前 `MOVED`（把 a.md 覆盖掉外部文件）；修后 `REJECTED/ERR_ENTRY_EXISTS`，外部文件 inode 与字节都不变。
- `R1-02a`：`.ws-internal` 是指向根外 sentinel 的符号链接且内容伪装成合法标记 → 修前"更新标记"把**根外文件改写**并继续回收；修后 `ERR_TRASH_UNAVAILABLE`，sentinel 一字节不变。
- `R1-06k`：payload 被换成符号链接且原位置为空 → 修前判 `missing`（用户以为文件丢了）；修后 `conflicted`。

## 2. 变异探针（跑完自动还原，`survived=0`）

| 探针 | 变异 | 结果 | 咬住的用例 |
|---|---|---|---|
| A | 删除 `trashEntry` 的占位归属复核 | BITTEN | 91: R1-01f |
| B | 删除 `restoreEntry` 的占位归属复核 | BITTEN | 91: R1-01e |
| C | marker 改回 `readFile` + `writeFile`（跟随链接） | BITTEN | 90: R1-02a/02b/02d |
| D | 删除 `beginTrash` 的重放归属核对 | BITTEN | 91: R1-03a/03e |
| E | 删除 `commitTrashState` 的项目身份核对 | BITTEN | 91: R1-03f |
| F | 把 `unsafe` 改回 `missing` | BITTEN | 92: R1-06a/06d |
| G | 删除 `restoring` 的 payload 身份比较 | BITTEN | 92: R1-06c |
| H | 把 `UNKNOWN` 强行映射成 `trashed` | BITTEN | 91: R1-04a/04b/04e |

## 3. 门禁

- `npm run test:p0`：**1037 / 1035 pass / 0 fail / 2 skip**（两个 skip 为既有：改 ACL 未授权、POSIX-only ino 语义）。
- `npm run typecheck`、`npm run typecheck:apps`、`npm run build:shell`（409.91 kB / gzip 125.37 kB）、`git diff --check`：全绿。

## 4. 未消除的风险（如实披露）

1. **归属复核与 `rename` 之间仍有竞争窗口**。本轮补齐了整段缺失的复核（原先完全没有），但没有、也不能宣称消除该窗口：Windows `rename` = `MoveFileExW(REPLACE_EXISTING)`，Node 无原子 no-replace。窗口内被换上的对象仍可能被覆盖。
2. `trashPayloadFacts` 的父链逐级 `lstat` 与后续 `lstat(payload)` 之间同样有 TOCTOU；因此它只把"明显异常"判为 `unsafe`，不声称是原子快照。
3. marker 的 `lstat → open → fstat` 身份比对把替换窗口压到极小，但仍非原子；`rename` 本身不会写穿链接，因此最坏情况是"替换掉目录项"，根外文件内容不受影响。
4. `nlink > 1` 的判定依赖 `lstat().nlink`；部分网络文件系统可能不提供可靠计数（本机 NTFS 实测可用）。
5. 列表对账仍是"读取时逐条核验"，不是持续监控：外部改动在两次读取之间不会被发现。

## 5. 与产品规则的关系

- 未新增永久删除、未自动清理、未改 UI、未改容量上限（500）。
- 项目撤销仍保留回收记录（`trashRetained`），只是入口消失。
- 回收/恢复的产品语义（不覆盖、可恢复、拒绝链接/目录）未变。
