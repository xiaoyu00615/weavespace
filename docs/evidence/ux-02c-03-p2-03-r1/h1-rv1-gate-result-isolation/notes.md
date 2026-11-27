# UX-02C-03-P2-03-R1-H1-RV1：发送授权结果的完整运行时隔离

## 0. 基线

| 项 | 值 |
|---|---|
| 仓库 | `xiaoyu00615/weavespace` |
| 分支 | `wip/ux-02c-03-p2-03-r1-send-boundary-evidence-20261127` |
| 父提交 | `9d56c0dd9d2f154eef8470767ab8bd0005f3fd9f` |
| `main` | `79b99e53ed218e06ece85c49af70d4cd2385ac3a`（未修改） |

本目录只做一件事：把 `evaluateSendGate` 的异常保护从"只包住 `gate()` 调用"扩大到
"调用 + 判断对象 + 读四个字段 + 校验 + 生成裁决"这一整段，并去掉"把 gate 原始对象
直接当裁决传下去"的做法。

## 1. 缺陷与修法

H1 之后的实现（父提交）：

```ts
let raw: unknown;
try { raw = gate(); } catch { return threw; }
if (typeof raw !== 'object' || raw === null || typeof (raw as { ok?: unknown }).ok !== 'boolean') {
  return invalid;                       // ← 这一次属性读取已经在保护之外
}
return raw as TrashSendDecision;        // ← 原样透传 gate 的对象
```

两个后果：

1. **属性读取可以抛异常**：`ok` / `kind` / `message` / `reasons` 都可以是 getter，
   返回值还可以是 `Proxy`。异常从 `evaluateSendGate` 冒出去，`postTrashAction` 不接，
   一路到 Controller 的 `catch`，被记成 `UNKNOWN`——一笔**根本没发出去**的恢复进了「待核对」。
   这正是 H1 想消灭的那个坑，只是入口换成了"返回值"而不是"gate 本身"。
2. **裁决不是拷贝**：调用方拿到的是 gate 的同一个对象。gate 之后改自己的 `reasons`
   数组，等于改掉已经做出的裁决。

现在的实现：整段在同一个 `try` 里，逐字段校验，返回**新构造的普通对象**；
允许路径只读 `ok` 一个字段（`ok === true` 时其余字段可能是一读就炸的 getter，不碰）；
`reasons` 逐项检查类型并**拷贝**成新数组。

## 2. 红测（修复前失败证据）

- 旧实现（`git show HEAD:apps/shell/src/client/client-api.ts`，SHA-256
  `44f8e8130bd37cfba50760ad261735197379df936313c1c87d835be8da0c00f4`）跑新套件：
  **25 例 / 17 pass / 8 fail**，日志见 `red-before-fix.txt`。
- 失败用例：`H1-RV-T01`、`T02`、`T03`、`T04`、`T04b`、`T05`、`T05b`、`T05c`。
- `T01` 的失败栈直接指向旧实现：`Object.get [as ok]` → `evaluateSendGate (client-api.ts:903:83)`
  → `postTrashAction` —— 属性读取在保护之外，异常原样冒到调用方。
- 新实现（SHA-256 `b7d19eda53f86744376eddb22cefe3c532eb9edaf9ded50f5017604b3b4c6333`）
  跑同一套件：**25/25 通过**，日志见 `suite-100.txt`。

## 3. 用例与断言（套件 100，H1-RV 段）

每条都走两遍：①直达真实 `createLiveClient` 的 `restoreTrash`（真实 `sessionToken()`
await、真实 `postTrashAction`、`fetch` 是桩）；②走一遍真实 `createTrashController`。

| 编号 | 构造 | 期望 |
|---|---|---|
| H1-RV-T01 | `ok` getter 抛异常 | `NOT_SENT` + `blocked` + threw 文案；0 POST |
| H1-RV-T02 | `kind` getter 抛异常 | 同上 |
| H1-RV-T03 | `message` getter 抛异常 | 同上 |
| H1-RV-T04 | `reasons` getter 抛异常 | 同上 |
| H1-RV-T04b | `Proxy` 的 `get` / `has` 陷阱抛异常 | 同上 |
| H1-RV-T05 | `kind: 'nope'` | `NOT_SENT` + `blocked` + **invalid** 文案；0 POST |
| H1-RV-T05b | 13 种不可识别形状（`null` / `undefined` / 数字 / 字符串 / `Promise` / `{}` / `ok` 非布尔 / `kind` 缺失或 `null` / `message` 非字符串 / `reasons` 非数组或含非字符串） | 全部 `NOT_SENT` + `blocked` + invalid 文案；0 POST |
| H1-RV-T05c | 合法拒绝 + 之后改 `original.reasons` | 裁决里的 `reasons` 是拷贝，不受影响 |
| H1-RV-T06 | `ok` 为 true，其余三个字段是一读就炸的 getter | `applied`，POST **恰好 1 次**，不读多余字段 |

`T01`～`T05` 的共同断言（`expectGateRefused()` 里）：

1. `status === 'NOT_SENT'`；
2. `reason === 'blocked'`（fail-closed，与"没有授权"同性质）；
3. `net.posts === 0` 且事件里没有 `post:restore`；
4. `calls.query === 0` 且没有 `query:op` —— 不进入 UNKNOWN 的只读核对；
5. Controller 返回 `rejected` 且台账为空 —— 预留正常释放；
6. `actions` 里没有 `TRASH_UNCONFIRMED` —— 不标「待核对」。

## 4. 变异探针（`mutations.json`）

| 编号 | 变异 | 结论 | 咬住的用例 |
|---|---|---|---|
| RV-A | 把字段读取移出 `try`（只保护 `gate()` 调用），删掉外层 catch | **BITTEN** | T01 / T02 / T03 / T04 / T04b |
| RV-B | 去掉 `kind` 合法性校验，非法/缺失的 kind 当成 `blocked` 放行 | **BITTEN** | T05 / T05b |

两次都满足：写入后 SHA-256 变了 → 跑套件出现指名道姓的失败用例 → 还原后 SHA-256
与基线**逐字节一致**（`restoreExact: true`，基线 `b7d19eda…`）。

RV-A 是成对的两处 edit 同时应用：只改一处会写成语法错误（整份模块加载失败），
那种"红"不算咬住，这里刻意避免。

## 5. 门禁（本目录内为原始日志）

| 命令 | 结果 |
|---|---|
| 套件 100 | 25 / 25 通过（`suite-100.txt`） |
| `npm run test:p0` | **1261 例 / 1259 pass / 0 fail / 2 skip**（`gate-test-p0.txt`） |
| `npx tsc -p tsconfig.json` | exit 0 |
| `npm run typecheck:apps` | exit 0 |
| `npm run build:shell` | exit 0（`index-CBlbbzY1.js 455.51 kB`） |
| `git diff --check` | exit 0（`gate-checks.txt`） |

与父提交相比 +9 例（1261 − 1252），全部来自 H1-RV 段；R1 的 6 例与 H1 的 10 例无回归。

## 6. 未做的与遗留

- 未重跑 238 项真实浏览器验证：发送时序没变（仍是"令牌 → 裁决 → POST"），
  改的是裁决**返回值**的处理；原证据（`../` 与 `../..` 两个目录）一字未动。
- gate 仍是"必填参数"而不是"不可伪造"：JS 调用方传一个恒 `{ ok: true }` 的假 gate
  属于故意绕过授权，这一层不防御（真正权威在 Host）。
- 返回值若是"看起来很合法但语义撒谎"的对象（例如 `ok: false, kind: 'stale'` 用来掩盖
  一次真实的阻断），本层无法识别——它只保证**形状**合法且**不抛**。
- Controller 的 `catch` 仍把"第三方端口在发送前抛异常"当 UNKNOWN：Client API 已保证
  裁决类异常不再抛出，剩下的与"fetch 真发出后的网络异常"在本层无法区分。
