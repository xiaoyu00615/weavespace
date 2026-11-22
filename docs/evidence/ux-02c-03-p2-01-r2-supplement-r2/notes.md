# UX-02C-03-P2-01-R2-Supplement-R2 证据

**基线**：`5ee30aeb8a977a2050e19eaea0f7b65663e98d39`（R2-Supplement-R1）
**分支**：`wip/ux-02c-03-p2-01-r1-trash-safety-20261122`
**性质**：最后一轮定点修正，不扩大功能范围

---

## 1. R2-01：最终 payload 复核移到最靠近 `rename` 的位置

### 原因

R1 把字节数复核放在"目标占位建立之后"，但它**后面**还有三步异步操作：

1. `ensureReservationOwned()`——会 `lstat`，占位丢失时还会重新 `open('wx')` 占位；
2. C1 检查点 + `assertRootContinuity()`；
3. 之后才 `rename`。

也就是说，字节数核验与实际搬移之间隔着一整段可被外部改写的窗口。`dev:ino` 不变时（追加 / 截断）
只核身份发现不了，复核也就白做了。

### 改动

`packages/storage/local-provider.ts`（`restoreEntry`）顺序调整为：

| 序号 | 步骤 |
|---|---|
| 1 | `reservePlaceholderOwned`（目标占位） |
| 2 | `ensureReservationOwned`（占位归属复核） |
| 3 | C1 检查点 |
| 4 | `assertRootContinuity` |
| 5 | `payloadStillMatches`（类型 + 身份 + 字节数） |
| 6 | `rename` |

失败语义未变：只 `releaseReservation`（且只释放 `dev:ino` 可证明属于自己的占位）、
payload 不动、目标不被写、记录不改、返回 `ERR_TRASH_STATE_CONFLICT`。
`UNKNOWN` / `REJECTED` 的判定条件一个都没动。

**未消除的限制**：最后一次 `lstat` 与 `rename` 之间仍然存在竞争窗口。这需要
`RENAME_NOREPLACE` / `unlinkat` 之类本层拿不到的原语，本轮不引入原生依赖、不重写文件层。
代码注释与 `docs/27` §6.3 第 6 条都按此口径写，不宣称消除 TOCTOU。

---

## 2. R2-02：C1 检查点的竞争测试（红 → 绿）

用现有 `StorageFaultHooks.atCheckpoint` 在恢复任务里只针对 `C1` 注入改动。
C1 位于 `ensureReservationOwned` 之后、最终 `payloadStillMatches` 之前——正是本轮要堵的窗口。

| 用例 | 注入 | 命中位置 | 修复前 | 修复后 |
|---|---|---|---|---|
| R2-02a | `appendFileSync(payload, 'x')` | C1 | `MOVED`（payload 被搬出回收区） | `REJECTED` / `ERR_TRASH_STATE_CONFLICT` |
| R2-02b | `truncateSync(payload, 3)` | C1 | `MOVED` | `REJECTED` / `ERR_TRASH_STATE_CONFLICT` |
| R2-02c | 只记录不改动 | C1 | `MOVED` | `MOVED`（顺序调整不误伤） |

断言（两个拒绝用例完全一致）：
- `fired === 1`：注入点必须真的执行到，否则测的不是最终位置；
- payload 仍在回收区，内容与注入结果逐字节一致（`# a.md\nx` / `# a`）；
- 原目标位置 `exists() === false`（占位也必须被释放）。

R1-01a/b/c 三例**原样保留、断言未放宽**，修复前后均通过；它们的注入点在
`afterMoveReserve`（更早），与本轮顺序调整正交。

修复前证据：`before-93.txt`（32 pass / 2 fail）、`before-93-messages.txt`
（`expected: 'REJECTED' / actual: 'MOVED'`）。
修复后：`after-93.txt`（34 / 34）。

---

## 3. R2-03：安全整数测试数据修正

`R1-02a` 原来写成：

```ts
assert.equal(isTrashSizeSupported(MAX_TRASH_BYTES + 1), false, '2^53 必须被拒绝');
assert.equal(isTrashSizeSupported(Number.MAX_SAFE_INTEGER + 2), false);
```

`Number.MAX_SAFE_INTEGER === MAX_TRASH_BYTES === 2^53-1`，所以第二行实际是 **2^53+1**，
不是注释暗示的 2^53+2；两个表达式共用同一基底，第三个边界值从未被覆盖。

改为显式算式并先自证取值：

```ts
const SAFE_MAX = 2 ** 53 - 1;       // 9007199254740991
const FIRST_UNSAFE = 2 ** 53;       // 9007199254740992
const SECOND_UNSAFE = 2 ** 53 + 2;  // 9007199254740994

assert.equal(SAFE_MAX, MAX_TRASH_BYTES);
assert.equal(FIRST_UNSAFE, MAX_TRASH_BYTES + 1);
assert.equal(SECOND_UNSAFE, MAX_TRASH_BYTES + 3);
assert.notEqual(FIRST_UNSAFE, SECOND_UNSAFE);
```

三条边界各自断言：`SAFE_MAX`（2^53-1）与 `SAFE_MAX-1`（2^53-2）接受；
`FIRST_UNSAFE`（2^53）与 `SECOND_UNSAFE`（2^53+2）拒绝。
`isTrashSizeSupported` 的实现**未改**——这是测试数据缺陷，不是实现缺陷。

---

## 4. 变异探针

只对新增的竞争测试做单点变异，R2 / Supplement / Supplement-R1 的 A–K 证据原样保留、不重跑。

| 探针 | 变异 | 预期 | 结果 |
|---|---|---|---|
| L | 把最终复核整段移回 `ensureReservationOwned` 之前（顺序退回修复前） | R2-02a / R2-02b 失败 | **BITTEN**（恰好 2 例失败，R1-01a/b 仍通过） |

脚本：`run-probe-l.py`；输出：`probe-L.txt`。脚本读回校验变异已落盘并断言
"复核位置 < 归属复核位置"，跑完立即按字节还原。

**第一次运行踩的坑（如实记录）**：`afterMoveReserve` 在 `trashEntry` 里也有一处，
从文件开头 `index()` 会把代码块塞进回收路径，导致 R1-01a/b 一并失败（4 例）。
那不是判别力，是变异范围不干净；脚本改为先在 `async restoreEntry(` 之后限定作用域，
并要求失败集合**恰好等于** `{R2-02a, R2-02b}`（多咬或少咬都判失败）。

---

## 5. 门禁（`gate.txt`）

| 项 | 结果 |
|---|---|
| 套件 93 | 34 例 / 34 pass / 0 fail |
| `npm run test:p0` | 1076 例 / 1074 pass / 0 fail / 2 skip（`S4R2-08`、`C-04`，均为既有） |
| `npm run typecheck` | 通过 |
| `npm run typecheck:apps` | 通过 |
| `npm run build:shell` | 通过（built in 1.53s） |
| `git diff --check` | 干净 |

---

## 6. 剩余风险与未覆盖项

1. **最后一次 `lstat` → `rename` 的窗口仍在**（本轮只把它压到最小，未消除）。
   Node 无 `RENAME_NOREPLACE` / 句柄级 rename，本阶段不引原生依赖。
2. **`trashEntry` 的超大对象分支仍无端到端用例**：造不出真实 >2^53 字节文件，
   只能靠 R1-02a（判定表）与 R1-02b（读配置）间接覆盖。
3. **只在本机 Windows/NTFS 实测**；SMB/NFS 上 `dev:ino`/`nlink` 语义无保证。
4. **对账是时点行为**（启动 / 列表 / 恢复），不是持续监控。
5. 本轮未改 UI、未启动 P2-02、未实现永久删除 / 自动清理、未改容量策略、未改 `main`。
