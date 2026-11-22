# UX-02C-03-P2-01-R2-Supplement-R1 · 定点修复证据

- 分支：`wip/ux-02c-03-p2-01-r1-trash-safety-20261122`
- 基线（本轮起点）：`0f5e1dffd73486365a1ca177878192ebd2b2ba5d`（R2-Supplement）
- 本轮性质：**定点修复**，不扩大功能范围；未改 UI、未启动 P2-02、未改 `main`
- 环境：Windows 11 / NTFS / Node v22.22.2

三项：R1-01 恢复前最终字节数复核；R1-02 统一安全整数边界；R1-03 修正 link 研究文档。

---

## 1. R1-01 恢复前的最终字节数复核

### 1.1 问题与修复

原实现在"目标占位建立之后"只复核 `dev:ino`（`objectMatchesIdentity`）。从第一次 size 核对
（占位之前）到这一步之间，payload 可以被**追加或截断**——`dev:ino` 完全不变，于是长度已经
变了的对象会被当成原对象搬到用户目录。

修复：新增 `payloadStillMatches()`（`packages/storage/local-provider.ts`），在占位建立后做一次
**三合一**复核——普通文件（非链接/非重解析点）、`dev:ino`、**实际字节数**；字节数必须同时等于
`expectedSize`（配置记录）与 `manifestSize`（清单）。失败时只释放**可证明属于自己**的目标占位
（`releaseReservation` 内部再比一次身份），payload 不动、目标不被写、回收记录不改。

**不宣称消除窗口**：代码注释里写明"这一步只是把窗口从'整个占位阶段'收缩到'这次 lstat 与
rename 之间'"，与 R2-05 的结论一致。

### 1.2 测试（套件 93，新增 3 例）

| 用例 | 注入 | 修复前 | 修复后 |
|---|---|---|---|
| R1-01a | `afterMoveReserve` 之后把 payload 追加 1 字节 | FAIL：`MOVED`（对象被搬走） | PASS：`REJECTED` / `ERR_TRASH_STATE_CONFLICT`，payload 留在回收区（8 字节原样），目标位置无任何文件 |
| R1-01b | 同一位置把 payload 截断到 3 字节 | FAIL：`MOVED` | PASS：同上，payload 保持 3 字节 |
| R1-01c | 不注入（正向对照） | PASS | PASS：`MOVED`，且断言注入点确实被执行过一次 |

用例都断言了：状态与错误码、payload 字节不变、目标位置不存在（占位已被释放）。
证据：`before-93.txt`（28 pass / 3 fail）、`before-93-messages.txt`（真实断言文本）、`after-93.txt`（31 pass / 0 fail）。

---

## 2. R1-02 统一安全整数边界

### 2.1 问题

写入侧（Provider）在 R2-Supplement 里已经用 `Number.isSafeInteger` 拒收超大对象，但**读配置侧**
（`parseTrash`）仍用 `Number.isInteger`：2^53 恰好是"仍然是整数、但已经不精确"的第一个值，
于是这样一条记录能被读进内存，却永远无法通过恢复时的三方核对——一条**注定救不回来**的垃圾记录。

### 2.2 修复

把"可接受的长度"收敛成**唯一一处**判定：`packages/storage/trash-size.ts`

```ts
export const MAX_TRASH_BYTES = Number.MAX_SAFE_INTEGER;
export function isTrashSizeSupported(value: unknown): value is number;
```

四处分发使用，两处（Provider 写入 / Store 读配置）口径因此不可能再分叉：

| 位置 | 用途 |
|---|---|
| `local-provider.ts#trashEntry` | 对象长度不在范围内 → `ERR_TRASH_KIND_UNSUPPORTED`（零副作用） |
| `local-provider.ts#restoreEntry` | `expectedSize` 不在范围内 → `ERR_COMMAND_INVALID` |
| `local-provider.ts#verifyRestoreSourceReadOnly` | 清单 `size` 不在范围内 → `ERR_TRASH_UNAVAILABLE` |
| `store/config.ts#parseTrash` | 记录 `size` 不在范围内 → 整份配置判为不可用 |

`ERR_TRASH_KIND_UNSUPPORTED` 的契约注释与公开文案同步补充了"长度"这一维
（"只有普通文件可以移入回收区（目录、链接与超大文件暂不支持）"），没有新增错误码。

### 2.3 测试（新增 3 例）

- **R1-02a**：共用判定的边界表——0 / 7 / 2^53-1 接受；2^53、2^53+2、-1、1.5、NaN、Infinity、
  字符串、null、undefined 全部拒绝。
- **R1-02b**：把 `size = 2^53` 写进 v4 配置（`serializeConfig` 生成合法校验和）→ `parseConfig`
  返回 `undefined`；`size = 2^53-1` 仍能正常解析并保留原值。修复前此用例失败（旧实现放行）。
- **R1-02c**：`restoreEntry` 传入 2^53、-1、1.5、NaN → `ERR_COMMAND_INVALID`，且零副作用。
  （注：该保护在 R2-Supplement 已存在，本例是回归锁定，修复前即通过。）

---

## 3. R1-03 link 研究文档修正

`../ux-02c-03-p2-01-r2-supplement/link-unlink-analysis.md` 修正了"`link` 对符号链接"的描述：

- **原文错误**："POSIX 的 `link(2)` 默认跟随符号链接"、表格里 ext4/APFS 均写"跟随目标（POSIX）"。
- **修正后**（标准与实现分开写）：
  - **POSIX**：自 POSIX.1-2008 起，`path1` 是符号链接时"是否解引用"被写成 **implementation-defined**；
    POSIX.1-2001 曾要求解引用。可移植的显式控制只有 `linkat()` + `AT_SYMLINK_FOLLOW`。
  - **Linux**：自内核 2.0 起**不**解引用（man-pages 明确记录这是对 POSIX.1-2001 的偏离），
    ext4/xfs/btrfs 不改变该语义（由 VFS 决定）。
  - **macOS / APFS**：`link(2)` man page 写明**穿透**——硬链接指向链接的目标对象。
  - **Windows / NTFS**：本机实测**不穿透**，`dst` 与链接本身同 `dev:ino`。
- 证据分级表下新增一段"标准与实现必须分开读"，明确凡标【文档】的跨平台结论都来自对应平台 man page，
  不是从 POSIX 推断。
- `§6 未验证事项` 相应改写：Linux/macOS 行为按 man page 记录但**未在对应平台实测**，
  且 Node `fs.link` 在两地是否与 man page 完全一致也未实测。

来源：POSIX.1-2008 `link()` 规范文本、Linux `link(2)` man-pages、macOS `link(2)` man page
（本轮通过检索核对，仓库内不复制原文）。

---

## 4. 变异探针（I / J / K）

脚本 `run-probes-r1.py`：变异 → 读回校验已落盘 → 跑套件 93 → 立即还原。

| 探针 | 撤销的保护 | 期望 | 结论 |
|---|---|---|---|
| I | 最终复核里的字节数比较（`return true`） | R1-01a / R1-01b | **BITTEN**（2/2） |
| J | 配置解析退回 `Number.isInteger` | R1-02b | **BITTEN**（1/1） |
| K | 共用判定退回 `Number.isInteger` | R1-02a | **BITTEN**（1/1） |

上一轮 A–F、G–H 的证据与脚本原样保留，本轮未重跑、未修改。

---

## 5. 门禁（`gate.txt`）

| 门禁 | 结果 |
|---|---|
| `npm run test:p0` | **1073 例：1071 pass / 0 fail / 2 skip**（skip 为既有 `S4R2-08`、`C-04`） |
| `npm run typecheck` | 通过 |
| `npm run typecheck:apps` | 通过（shell + server） |
| `npm run build:shell` | 通过（`built in 1.46s`） |
| `git diff --check` | 干净 |

定向：套件 93 = 31/31。

---

## 6. 未覆盖 / 需要复审注意

1. **`trashEntry` 的超大对象分支没有端到端用例**：构造一个真实 >2^53 字节的文件不可行，因此该
   分支只由共用判定（R1-02a）与读配置侧（R1-02b）间接覆盖，调用点本身没有直接红测。
   它的行为是"零副作用地拒绝"，代码路径与类型不支持同一条（同一返回点）。
2. R1-01 的最终复核仍然是"复核后 rename"：这次 lstat 与 rename 之间的窗口**未消除**，
   只是比原先窄得多。
3. `MAX_TRASH_BYTES` 只是读出常量，没有"回收区总量上限"的含义；容量策略本轮未动。
