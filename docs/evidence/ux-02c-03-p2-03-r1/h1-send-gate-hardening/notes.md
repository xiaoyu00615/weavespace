# R1-H1 · Client API 最终发送授权强制化（证据）

> 父提交：`5a612ebb4226951fca85d2842a5b8b2fe89d0d31`
> 分支：`wip/ux-02c-03-p2-03-r1-send-boundary-evidence-20261127`
> 只修 H1 两件事：gate 必填 + gate 异常与 UNKNOWN 隔离。
> 上一轮（R1）的 238 项浏览器证据**未重跑、未修改**，仍在本目录上一级。

## 1. 改了什么

| 接口 | 之前 | 现在 |
|---|---|---|
| `WeaveSpaceClient.restoreTrash` | `gate?: TrashSendGate` | `gate: TrashSendGate`（必填） |
| `TrashPort.restore` | `gate?: TrashSendGate` | `gate: TrashSendGate`（必填） |
| `DocumentActions.restoreTrash` | `gate?: TrashSendGate` | `gate: TrashSendGate`（必填） |
| `postTrashAction`（内部） | `gate?` | `sendGuard: { gate } \| null`：恢复传 `{ gate }`，移入传 `null` |

运行时保护（`client-api.ts#evaluateSendGate`，**同步**）：

| 情况 | 结果 |
|---|---|
| `gate` 不是函数（JS 调用方/旧适配层漏传） | `NOT_SENT` + `blocked` + `发送前授权检查不可用，已取消恢复（未发送请求）。` |
| `gate()` 抛异常 | `NOT_SENT` + `blocked` + `发送前授权检查执行失败，已取消恢复（未发送请求）。` |
| `gate()` 返回无法识别的形状 | `NOT_SENT` + `blocked` + `发送前授权检查返回了无法识别的结果，已取消恢复（未发送请求）。` |

三者都在 `await sessionToken()` 之后、`request()`（第一句即 `fetch()`）之前同步完成，
中间**没有**新增任何 `await`。

Demo client：签名接收 gate 但**不执行**（没有请求要发），仍然返回 `ERR_COMMAND_UNSUPPORTED`。

## 2. TypeScript 真的挡住了漏传

把三个签名改成必填、其余不动时，根 `tsc` 立刻报出 8 处漏传（完整输出见
`typecheck-required-gate.txt`）：

```
tests/suites/96-...-trash-orchestration.test.ts(217,22): error TS2554: Expected 3 arguments, but got 2.
tests/suites/97-...-trash-shell-e2e.test.ts(184,35): error TS2554: Expected 3 arguments, but got 2.
…（共 8 处：96 的端口包装 1 处、97 的 7 处调用/适配层）
```

这些点已全部改为显式传 gate（97 用 `allowGate = () => ({ ok: true })`，因为该套件证明的是
传输链路、不是授权）。

## 3. 测试（套件 100，16 例全绿）

`suite-100.txt` 是完整输出。H1 编号与实测对应：

| 编号 | 用例 | 结果 |
|---|---|---|
| H1-T01 | 正常传入有效 gate | `applied`，POST 恰好 1 次，无 `TRASH_UNCONFIRMED` |
| H1-T02 | 运行时缺少 gate（`undefined as unknown as TrashSendGate`） | `NOT_SENT` + `blocked`，POST 0，令牌请求 1 次（证明保护在真正的边界上） |
| H1-T02b | gate 不是函数（字符串） | 同上 |
| H1-T03 | gate 抛异常 | `NOT_SENT` + `blocked`，POST 0，**无** `query:op` |
| H1-T03b | gate 返回 `undefined` | `NOT_SENT` + `blocked`（invalid 文案） |
| H1-T04 | gate 明确拒绝 | `NOT_SENT`，原因文案原样上抛，POST 0 |
| H1-T05 | 适配层换掉 gate（总是拒绝） | 控制器 `rejected`，POST 0，`query` 0，台账空，无 `TRASH_UNCONFIRMED` |
| H1-T06 | 最终裁决内部抛异常（`verifyPending` 第 2 次调用） | `rejected`（threw 文案），POST 0，`query` 0，**预留已释放**，台账仍可用 |
| H1-T07 | Demo 恢复 | `REJECTED` + `ERR_COMMAND_UNSUPPORTED` + 501，POST 0，令牌请求 0 |
| H1-T08 | 最终发送顺序 | `token:resolve → gate:verify → post:restore`（`gate:verify` 共 2 次） |

R1 原有 6 例（A/B/C/D + 顺序）仍在同一套件里全部通过。

## 4. 变异探针（2/2 BITTEN）

| 编号 | 撤销的保护 | 咬住的用例 |
|---|---|---|
| H1-A | 运行时保护退化：漏传/非函数时跳过检查、异常直接冒泡 | T02、T02b、T03、T03b、T06 |
| H1-B | 只把"异常转 blocked"改回 `throw error` | T03、T06 |

每次都是：写入变异 → SHA 变化 → 跑套件 → 记录失败用例 → 还原 → SHA 回到基线 → 复跑全绿
（`mutations.json` 里有 `shaBefore` / `shaMutated` / `shaAfterRestore`）。

## 5. 门禁

| 命令 | 结果 |
|---|---|
| 套件 100 | 16/16 |
| `npm run test:p0` | **1252 例 / 1250 pass / 0 fail / 2 skip**（+10，来自 H1 新增用例） |
| 根 `tsc -p tsconfig.json` | 通过 |
| `npm run typecheck:apps` | 通过 |
| `npm run build:shell` | 通过（`index-C1f_JqXM.js 455.12 kB`） |
| `git diff --check` | 通过（退出码 0） |

## 6. 遗留问题

1. **Controller 的 `catch` 仍然把所有 `port.restore()` 抛出的异常当成 UNKNOWN**。
   现在 Client API 保证 gate 类异常不会抛出，但**第三方端口实现**（非本仓库的适配层）
   若在发送前抛异常，仍会得到 UNKNOWN。没有改成"一律 NOT_SENT"：因为网络栈在
   `fetch` 真正发出后抛出的异常确实是 UNKNOWN，两者在 Controller 这一层无法区分。
2. **`gate` 只是"必填参数"，不是"类型不可伪造"**：JS 调用方仍然可以传一个恒返回
   `{ok:true}` 的假 gate——那属于**故意**绕过授权，不在本层防御范围内（真正的权威在 Host）。
3. 上一轮 R1 的真实浏览器 238 项证据未重跑（本轮未改发送时序，只加必填与异常收敛）；
   若复审要求，可完整复跑 §0 的六段脚本。
