# UX-02B-05-E · 身份交错边界验证

复审基线：`abe4551af32288dac16bd5eb8ad8a480fb330614`（05 主体集成测试）
本轮**只**验证一个时序风险，不重做项目管理功能。

## 结论

**缺陷真实存在**（两条用例在修复前都是红的），已按"只调整 Shell 身份同步的归属/
失效机制"修复。`ProjectRuntime`、`ProjectStore`、撤销事务、授权规则**零改动**。

## 缺陷机理

`createWorkspaceIdentitySync.refresh()` 原本只有两道归属判定：

| 判定 | 含义 | 为什么不够 |
|------|------|-----------|
| `isCurrent(epoch)` | 期间没切模式 / 重连 / 换工作区 | 04A 添加流程**不推进** `loadEpoch`，代次仍为真 |
| `ticket === issued` | 期间没发起更晚的 `refresh()` | 添加流程**不经过** `refresh()`，序号不增长 |

于是"移除 A 时发起的`刷新`"在"C 添加成功、摘要已写成 `keyBC`"之后返回时，
两道判定都为真，它写下了 `keyB`（只剩 B 那一刻的结构）：

- 成功分支：`keyBC` 被覆盖成 `keyB` → 界面是 `{B,C}`，恢复记录挂在"只剩 B"的摘要上，
  下次启动必然认错工作区（或丢标签）；
- 失败分支：把已经确认的 `keyBC` 重新置 `null`（待同步）→ 自动保存无故停摆。

## 修复（Shell 身份同步的归属机制）

新增**身份修订号**（`createWorkspaceKeyRevision`），语义是"身份落定的次数"：

- `createWorkspaceKeyApplier`（添加项目 / 只读 resync 的唯一落地入口）在写摘要前 `bump()`；
- `createWorkspaceIdentitySync` 在自己的探测结论落地时也 `bump()`（不变量：任何写入都计数）；
- `refresh()` 在发起时记下 `revisionAtStart`，**成功与失败两条分支**都要求
  "修订号仍是发起时那个"，否则返回 `stale`——一个 dispatch 都不发。

因此**添加、移除、只读重新同步可以共同使旧身份检查失效**，不再依赖 `loadEpoch` 是否推进。
`stale` 结论在 `settleIdentitySync` 里是 `ignored`：不动门禁（此时门禁已由落地器放开），
也不会误报"工作区身份待同步"。

## 两个时序测试

`tests/suites/68-s11ux02b05e-identity-interleave.test.ts`（全部走真实生产模块：
writeGate / identitySync / removeAction / projectAdder / autosave / reducer）

| 用例 | 场景 | 断言 |
|------|------|------|
| E-01-01 | 移除 A（探测在飞）→ 添加 C 写入 `keyBC` → 旧探测返回 `keyB` | 摘要仍是 `keyBC`；不产生 `keyB` 记录；tick 后写入的全部是 `keyBC`；`keyBC` 记录可被下次启动认领 |
| E-01-02 | 移除 A（探测在飞）→ 添加 C 写入 `keyBC` → 旧探测抛错 | 摘要仍是 `keyBC`；门禁保持放开；自动保存只写 `keyBC` |

### 红（修复前，按 Provider 现有装配逐行复刻）

```
not ok 1 - E-01-01 旧身份检查在添加成功后返回 keyB：不得覆盖已确认的 keyBC
  error: 旧探测属于已被取代的结构：不得把摘要改回"只剩 B"
    + actual   'bbbb…bbbb'   (keyB)
    - expected 'cccc…cccc'   (keyBC)

not ok 2 - E-01-02 旧身份检查在添加成功后抛错：不得把已确认的 keyBC 置回 null
  error: 失败的是已被取代的探测：不能据此把已确认的身份打回"待同步"
    + actual   null
    - expected 'cccc…cccc'   (keyBC)

# pass 0
# fail 2
```

### 绿（修复后，走生产落地器 + 修订号）

```
ok 1 - E-01-01 旧身份检查在添加成功后返回 keyB：不得覆盖已确认的 keyBC
ok 2 - E-01-02 旧身份检查在添加成功后抛错：不得把已确认的 keyBC 置回 null
# pass 2
# fail 0
```

## 变异探针（证明两条用例各自咬住自己的分支）

| 探针 | 变异 | 结果 |
|------|------|------|
| A | 只回退**成功分支**的 `superseded` 判定 | E-01-01 红、E-01-02 绿 —— 咬住成功分支 |
| B | 只回退**失败分支**的 `superseded` 判定 | E-01-02 红、E-01-01 绿 —— 咬住失败分支 |
| C | 落地器不再 `revision.bump()`（添加 / resync 无法使旧探测失效） | 两条全红 —— 咬住"添加也能作废旧探测"这条入口 |
| D | 移除 `refresh()` 自身写入后的 `bump()` | 两条仍绿 —— **同模块先后已由 `issued` 兜住**，此处仅为"所有写入都计数"的不变量，如实记录，不宣称判别力 |

## 归属边界（未改动的部分）

- `loadWorkspace()` 连接新工作区时直接派发 `SET_WORKSPACE_KEY`，它**不**经过落地器，
  但连接点会 `loadEpoch.start()` 推进代次，在途探测由 `isCurrent` 判为 `stale`；
- 移除动作的 `syncIdentity(epoch)` 仍用动作开始时的代次；`stale` 不再产生"身份待同步"提示；
- Host 侧事务、`opId` 单飞、墓碑、`RECOVERY_RESTRICTED`、授权与撤销规则一律未触碰。

## 门禁

| 门禁 | 结果 |
|------|------|
| `npm run test:p0` | 803 tests / **802 pass** / 0 fail / 1 skip（127→128 套件，新增 68） |
| `npm run typecheck` | 通过 |
| `npm run typecheck:apps` | 通过（shell + server） |
| `npm run build:shell` | 通过（73 modules，368.88 kB） |
| `git diff --check` | 通过 |

回归范围：套件 56–67 全绿（移除 API / 编排 / 身份同步 / 身份窗口 / 本地守卫与单飞 /
R2E 边界 / 05 六项集成），套件 61、62 的装配同步改为调用生产落地器，不再保留第二份规则。

环境说明：测试必须用**长路径**临时目录，且四个变量要分别赋值（`export TMP=… TEMP=… TMPDIR=…`）；
写成 `export TMP=TEMP=TMPDIR=…` 会让 `TMP` 变成字面量 `TEMP=TMPDIR=…`，
`os.tmpdir()` 退回 `ADMINI~1` 8.3 短路径，套件 25/29 等真实目录夹具会假报 `UNAVAILABLE`。
