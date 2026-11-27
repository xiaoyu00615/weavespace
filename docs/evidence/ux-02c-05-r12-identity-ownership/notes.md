# UX-02C-05-R1.2 证据记录（阶段 A）

基线提交：`00695dea70fa855d4e44a7d2939b2743d8668783`（父提交）
分支：`wip/ux-02c-02-r2-resource-intent-20261127`
本目录只记录阶段 A；阶段 B（UX-02C-02-R2）使用相邻目录，不覆盖本目录。

---

## 一、红测（先红后绿）

命令：在**旧实现**（暂存 6 个已跟踪源码文件，保留新模块与新套件）上跑
`node --test tests/suites/109-...test.ts`。

结果落盘 `red-suite-109.txt`：

```
# tests 33
# pass 25
# fail 8
```

失败的 8 条正好覆盖 F01 / F02 两处缺陷，其余 25 条是"旧实现本来就对"的
回归护栏（它们同时证明新套件没有靠放宽断言来凑绿）：

| 用例 | 钉住的缺陷 |
|---|---|
| A01 unsupported → unverified | F01：旧实现把"目标无能力"当成放行凭据，不看当前状态 |
| A02 unsupported → verified | F01：当前已有锚，能力声明自相矛盾，旧实现仍放行 |
| A03 verified → unsupported | F01：目标有锚、当前声明无能力，旧实现只比锚不比状态 |
| A07 目标自称 unsupported 却带锚 | F01：声明自相矛盾，旧实现把它当成降级依据 |
| A08 当前声明 unsupported 却给出锚 | F01：同上，反向 |
| B01 首屏响应没有能力声明 | F02：首屏整层替换仍继承上一轮 `unsupported` |
| B04 续页能力声明与既有声明矛盾 | F02：新旧声明打架时旧实现直接混合使用 |
| B05 首屏没有根锚 | F02 第二处：首屏仍继承上一轮旧根锚 |

新套件最终 **34/34 pass**（比红测多 1 条：C06b 是在变异驱动下补的）。

---

## 二、变异探针（`mutate.mjs` → `mutations.json`）

每个探针：改源码 → 跑整套 109 → 记录 `not ok` → 还原 → SHA-256 逐字节比对。

| 探针 | 变异内容 | 咬住的用例 | 结论 |
|---|---|---|---|
| M12 | `unsupported` 目标无条件放行（还原 F01） | A01 A02 A07 A08 | BITTEN |
| M13 | 首屏整层替换仍继承旧能力声明（还原 F02） | B01 | BITTEN |
| M17 | 首屏仍继承旧根锚（F02 第二处） | B05 | BITTEN |
| M14 | 删除工作区归属检查 | C05 C13 | BITTEN |
| M15 | 删除加载代次检查 | C06b | BITTEN |
| M16 | 旧结果无条件当当前会话 | C12 C13 | BITTEN |

`restoreExact` 全部 `true`；6/6 BITTEN。

### M15 的判别力是被逼出来的

首轮 M15 是 **NOT_BITTEN**：C05（切工作区）与 C06（Live→Demo→Live）的拒绝
同时被 `workspaceKey` 变化和"项目表被清空"覆盖，代次检查删掉也看不出来。

处理方式不是放宽断言，而是把测试夹具拆开：

- `switchWorkspace()`：只改摘要里的 `workspaceKey`，**不推进代次**；
- `reconnect()`：只推进 `loadEpoch`，工作区与项目表都不变；
- 新增 **C06b** 只钉代次。

此后 M15 变 BITTEN。这说明"三条判据互相掩盖"是真实存在的测试盲区，
现在每条判据各有一条用例单独钉住。

---

## 三、真实浏览器验证（`verify-r12.mjs` → `browser-verification.json`）

真实 Chrome（CDP）+ 真实 Host + 真实磁盘目录
`D:/Workspace/projects/weavespace-test/c05-r12`，端口 5431 / 5432 / 9371。
**38/38 PASS。**

### 3.1 V 段：残响不得作用到新对象（E01 修正）

E01 的意思是上一版"没有真正比较文件修改前后的内容"。本轮改成三项逐项比较：

```
diskBefore   { sha256: 5c8360847cfd…, size: 59, ino: 1407374884766556 }
diskReplaced { sha256: 93e79082a262…, size: 82, ino: 1407374884767024 }
V-15 比较结果：sha256 / size / ino 三项逐项一致（残响后 = 替换后）
```

关键是 V-06 / V-07 拆成两条，分别证明两件不同的事（E01 附带要求）：

| 断言 | 证明什么 |
|---|---|
| V-06 `treesBefore=0 → treesAfter=1`，锚 `23d04565…` → `6402dd4d…` | **Host 真的重读了目录**，返回的是新锚 |
| V-07 行上 `data-resource-anchor` == Host 的新锚，且 != 旧锚 | **Shell 真的消费了新锚**（不是 Host 单方面换了、界面还拿旧的） |

没有 V-07，V-06 只能证明服务端对，不能证明界面拿到的身份是对的。

真实点击序列（CDP `Input.dispatchMouseEvent`，`clickCount` 1→2）：

```
click(detail=1) @3457ms → click(detail=2) @3849ms → dblclick(detail=2)
gapMs = 392（墙钟 511ms，真实双击窗口内）
残响后：未进活动 View、未进改名、改名请求 0 次、打开请求 0 次
```

`gapMs` 曾经失败过（≥500）：原因是两次点击之间插了一次 Host `/api/tree` 往返，
把窗口顶穿了。修法是把往返挪到第二下点击**之后**，窗口内只留页面内读
`data-resource-anchor`（几毫秒）。

### 3.2 Y 段：项目根单击必须真的切项目（E02 修正）

E02 的问题是上一版"容许 null"。本轮改为严格要求：

```
Y-00b 点击前活动项目 = 项目B（先确认起点是 B）
Y-03  点击后 activeProject = 项目A，actual === expected，不接受 null
      requestsBefore=4 → requestsAfter=6（确实走了 Host）
```

先切到 B 再点 A，是为了排除"本来就在 A，点了也没变"的假通过。

### 3.3 Z 段：真实异步改名（E03 修正）

用 CDP `Fetch.enable` 在 **Request 阶段**真的把 `POST /api/projects/rename`
按住，在途期间切活动项目，再放行：

```
Z-00 改名开始时活动项目 = 项目A
Z-04 pausedRequests = 1（真的在途，不是伪造顺序）
Z-05 在途期间活动项目 = 项目B
Z-10 顺序 [paused, switched, released]
Z-07 项目列表 ["项目A-新名", "项目B"]（Host 的真实改名照样回填）
Z-08 notice =「项目A-新名」的显示名称已更新（原编辑会话已收起）
Z-09 改名请求 0 → 1（绝不自动重发）
```

Z-06 / Z-08 合起来就是 F03 要的两层表达：**全局层照实回填**
（Host 确实改了名），**会话层不写**（那个编辑会话已经不是当前会话）。
旧实现用 `modeRef` 粗判，会把这种情况整条丢弃或整条回填，两种都错。

### 3.4 浏览器脚本踩过的坑（记录以便复现）

1. Z-06/Z-08 首次失败：脚本改的是"项目B"的名、却在途切到"项目A"，
   而活动项目本来就是 A → 切换是 no-op，会话自然没失效。
   改成"改 A 的名、在途切到 B"，并新增 Z-00 前置断言。
2. V-10 首次失败：见 3.1 末尾，Host 往返把 500ms 窗口顶穿。

---

## 四、门禁

| 门禁 | 结果 | 证据 |
|---|---|---|
| `npm run test:p0` | **1479 例 / 1477 pass / 0 fail / 2 skip** | `gate-test-p0.txt` |
| `npm run typecheck` | EXIT=0 | `gate-typecheck-build.txt` |
| `npm run typecheck:apps` | EXIT=0（shell + server 双端） | 同上 |
| `npm run build:shell` | EXIT=0，101 modules，492.04 kB | 同上 |
| `git diff --check` | EXIT=0（仅 CRLF 提示，非错误） | 同上 |
| `git diff --cached --check` | EXIT=0 | 同上 |

> 第一次跑 `test:p0` 时忘了带 `TMP`/`TEMP`/`TMPDIR`，`os.tmpdir()` 返回 8.3 短路径，
> 101 套件起 Host 全部 `ERR_PROJECT_UNAVAILABLE`（88 条失败）。带环境变量重跑即全绿。
> 这一步与代码无关，但记下来，避免下次误判成回归。

---

## 五、本轮没有做的事

- 没有新增任何文件系统能力，没有改 Host 授权与身份核验机制；
- 没有改正常分页与缓存语义（B02/B03/B06/B07 是护栏）；
- `projectMeta` 仍然"第一页带回、续页沿用"，与锚/能力刻意不同（纯展示，
  且有 `applyMetadata` 作为权威来源）——这个例外写在 `tree-model.ts` 注释里；
- 没有把 `unsupported` 整体废掉：真·两台都不支持身份的 Provider 仍可正常
  走路径身份，只是必须**两侧都是明确 unsupported**。
