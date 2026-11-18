# UX-02C-02-R1.3 验收记录（复审遗留的两项定点修复）

基线：`60791ff`（R1.2）。分支 `wip/ux-02c-02-r1-view-barrier-reservation-20261116`。
本轮只处理 R1.3-01 / R1.3-02，不进入 UX-02C-03，未改动 R1-05 的 rename 原子性问题。

---

## 一、R1.3-01 恢复失败时旧 View 遗留

### 缺陷（可复现）

R1.2 只把「被接管后**没处理完**」的标签交给回收通道（`pending`）。其余四类被跳过的标签
从来没有回收路径：

| 跳过原因 | R1.2 之后旧 View 的命运 |
| --- | --- |
| `open-rejected` | 永远留着。恢复不会再开它，文件回来后再也改不了名 |
| `file-missing` | 同上：文件/挂载回来后仍被 409 拦住 |
| `project-unavailable` | 同上：项目重新挂载后仍是 409 |
| `unsaved-changes` | 同上（但这里保留 View 是**正确**的，见下） |

根因不是"回收逻辑写错了"，而是**回收的输入集合选错了**：`pending` 回答的是
"哪些标签要结转进下一次写入"（存储语义），而回收关心的是"哪些文件这次没被重开"
（会话语义）。两者只在一部分情况下重合。

### 修复

1. `workspace-restore.ts`
   - `restoreTabs` 记录真正登记成标签的下标，新增 `TabOutcome.abandoned`
     （= 记录里有、界面里没有的全部标签，含四类跳过与未处理）。
   - 三条终态都据此回收：连接前被接管（全部标签）、恢复被中断（abandoned）、
     **恢复成功（abandoned）**。以前成功路径根本不回收。
   - `RestoreReport.reclaim: { closed, blocked, failed } | null` 把结果带出来：
     `null` = 本轮没尝试（无能力/非 live），`failed > 0` = 试过但没成功。
   - `buildNotice` 在 `blocked` / `failed` 非零时追加措辞，不再静默。
2. `open-document.ts`
   - `reclaimStaleViews` 返回 `ReclaimSummary`，并按 `MAX_RECLAIM_PATHS` 分批（见 R1.3-02）。
   - 单批失败只影响该批，计入 `failed`；不再 `catch {}` 静默吞掉。
3. `packages/protocol`（新模块）：`MAX_RECLAIM_PATHS` + `chunkReclaimPaths` 放在
   Host 与 Shell 都能引用的唯一位置，避免两侧各写一个"看起来一样"的数字。

### 边界逐条

| 要求 | 落点 | 证据 |
| --- | --- | --- |
| `open-rejected` 后有安全回收路径 | 成功终态也回收 `abandoned` | 80-01a（回收后文件重建 → 改名 200） |
| 调查 file-missing / project-unavailable 生命周期 | 同上，两类都进 `abandoned` | 80-01b / 80-01c |
| `unsaved-changes` 优先保护未保存内容 | 不绕过 `closeView`；被拒即保留 | 80-01d（正文 `UNSAVED-DRAFT` 仍在、磁盘零变更、改名仍 409） |
| 不擅自增加删除草稿行为 | 本轮**没有**新增任何 discard/删除 API | 代码 diff 无相关改动 |
| 当前有效标签的 View 不得回收 | `keepViewIds` = 执行时刻 `state.tabs[].viewId` | 80-01e、81-02f |
| 其它页面实例的 View 不得回收 | Host 四连核对（instance + actor + resourceId） | 80-01f（仍 200，且仍拦改名） |
| 回收被拒绝时保留 View 且失败可观察 | `blocked` 计数 + 通知文案 | 80-01d（`blocked: 1` + "未保存内容（已保留…）"） |
| 回收失败可观察 | `failed` 计数 + 通知文案 | 80-01h（Host 404 → `failed: 1` + "未能回收"） |
| 覆盖恢复中断 | abandoned 同时含 pending 与 skipped | 80-01g |

---

## 二、R1.3-02 超过 64 个路径的批量回收

### 缺陷（可复现）

`reclaimStaleViews` 把「每个项目的全部路径」塞进一个请求；Host 的上限是 64，
超出即 400，异常随后被 `catch {}` 吞掉 → **一条都没回收，且没有任何观察点**。
实测（修复前，65 条路径）：`closed = 0`（`81-02b` 红：期望 65，实际 0）。

### 修复

- `packages/protocol/reclaim.ts`：`MAX_RECLAIM_PATHS = 64` + `chunkReclaimPaths()`
  （只切分，不排序/不去重/不改写，顺序确定）。
- `open-document.ts`：逐项目、逐批**顺序**发出，每批带同一份 `projectId` /
  `keepViewIds`（`clientInstanceId` 由 `client.reclaimPageViews` 逐请求注入）；
  单批失败继续下一批，`failed += chunk.length`；全部在同一个
  `enqueueMaintenance` 任务内，因此打开与回收的串行语义不变。
- `server.ts`：删除本地常量，改用共享常量（拒绝逻辑不变）。

### 边界逐条

| 要求 | 证据 |
| --- | --- |
| 按上限分批（64 / 65 / 128 / 129） | 81-02a/b/c/d：请求体路径数依次 `[64] [64,1] [64,64] [64,64,1]` |
| 每批正确的 projectId / instanceId / keepViewIds | 81-02b、81-02f（逐次断言三个字段） |
| 某批失败不影响其它批次且有记录 | 81-02e（中间批 400 → `closed 65` / `failed 64`，后续批仍执行） |
| 不重复回收、不误关当前 View | 81-02f（70 条含重复 → 去重 65 → 保持的 tab View 仍 200） |
| 保持维护队列串行 | 全部批次在同一个 `enqueueMaintenance` 任务内顺序 await；套件 79 仍全绿 |

---

## 三、红测 / 绿测

**修复前（把实现退回 R1.2 形态：不分批 + 成功路径只回收 `pending`）**

```
80-s11ux02c02r13-restore-reclaim.test.ts   fail=7  (01a 01b 01c 01d 01e 01f 01h)
81-s11ux02c02r13-reclaim-batching.test.ts   fail=5  (02b 02c 02d 02e 02f)
```

两条保持绿，且都是**预期的边界守卫**：

- `80-01g`：恢复中断路径 R1.2 就已回收，本轮只把输入从 `pending` 换成 `abandoned`
  （两者在该场景下相等），它是回归守卫而不是新缺陷。
- `81-02a`：64 条正好等于上限，分批前后都是"一次请求"，行为不变。

**修复后**：80 = 8 pass / 0 fail；81 = 6 pass / 0 fail。

## 四、变异探针（改坏实现，确认用例真的会红）

| 探针 | 改动 | 结果 |
| --- | --- | --- |
| P1 | 取消分批（`[paths]`） | 81 红 5 条（02b/02c/02d/02e/02f） |
| P2 | 成功路径退回只回收 `pending` | 80 红 7 条（除 01g） |
| P3 | 删除 `failed += chunk.length` | 81-02e 红 |
| P4 | 删除恢复成功提示里的 `reclaimNotice` | 80-01h 红 |

四个探针均已还原（`git diff --numstat` 与探针前一致，无 `probe` 残留）。

## 五、是否仍有"无法释放的 View"

| 场景 | 现状 | 是否阻塞功能 |
| --- | --- | --- |
| `unsaved-changes` 且是最后一个脏视图 | **故意保留**（`blocked`）。生产者的显式释放路径：打开该文件（新 View 能看到 Host 草稿）→ 保存或放弃 → 刷新一次，恢复会把它回收 | 不阻塞：这是保护未保存内容的代价，改名被 409 拦住是正确行为 |
| 回收请求失败（项目已被撤销 404 / QUIESCING 409） | 计入 `failed` 并在提示里出现 | 不阻塞：项目不存在时没有任何可改名的对象；QUIESCING 期间改名本身也被挡 |
| 页面身份缺失（sessionStorage 不可用）时建立的 View | 无法匹配回收（没有 `clientInstanceId`），只能重启 Host / 移除项目 | 既有约束（R1.2 已记录），本轮未扩大 |
| 本轮其它 | 无 | — |

## 六、门禁

`npm run test:p0` → tests 921 / pass 919 / fail 0 / skip 2（新增 14 条）。
`typecheck`、`typecheck:apps`、`build:shell`、`git diff --check` 全绿。
套件 30 / 72–79 全部原样通过。未改 `main`，未建 Worktree，未生成 ZIP。

本轮无 UI/渲染改动（新增字段只进通知文案），因此未重跑浏览器验收；真实 Host +
真实 HTTP + 真实磁盘的集成测试已覆盖全部改动路径。这一条是范围判断，不是遗漏。
