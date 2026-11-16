# UX-02C-02-R1 验收记录（View 生命周期 / 结构变更屏障 / 占位归属）

基线：`cba7a27`。分支 `wip/ux-02c-02-r1-view-barrier-reservation-20261116`。

## 一、View 生命周期

**缺陷**：04A/02C 期间 `/api/open` 每调用一次就新建一个 View，而旧 View 只有
"客户端主动 /api/close"才会消失。页面刷新后旧页面上下文已销毁，永远不会关闭它 →
该项目永远 `activeViews > 0`，改名/移动被永久拦住（实战中表现为"刷新一次就再也
改不了名"）。

**修复**：
- Shell 用 `sessionStorage['weavespace.clientInstanceId']` 维护页面实例 UUID
  （刷新后不变、新标签页各不相同；无 sessionStorage 时返回 `null` 并省略字段）。
  每次 `/api/open` 携带 `clientInstanceId`。
- Host `ViewRecord` 增加 `clientInstanceId`（形状校验 `^[A-Za-z0-9._-]{8,64}$`，
  **不参与任何授权判定**，actor/session/viewId 校验原样保留）。
- 新 View 登记成功后，遍历 `views` 释放"同 clientInstanceId + 同 resourceId"的旧
  View；只在该 `document.closeView` 真的返回 `closed: true` 时删除 Host 记录，
  失败一律保留、不伪造成功。
- `document.open` 的磁盘版本复核逻辑未改；DIRTY 会话仍走"不回填 buffer"分支。

**测试**（套件 74 A-01…A-03）：同页重开旧 View 被释放且可读性变 403、不同页面
互不影响、DIRTY 正文在重开后仍是脏内容且继续拦住结构变更。

## 二、结构变更屏障

**缺陷**：`withDiskOp` 在 `structureBusy` 期间仍放行，屏障只挡住了 `assertUsable`
和 `isAcceptingViews`；结构变更自身又复用 `withDiskOp`，所以不能简单加一条拒绝。

**修复**：
- `withDiskOp`：新增 `structureBusy` → `ERR_PROJECT_BUSY`（与既有
  REVOKE_UNKNOWN / QUIESCING / REMOVING 判定并列，顺序保持"撤销优先"）。
- 新增 `withStructureDiskOp`：唯一额外前置是"必须正持有屏障"，其余门禁一条不放宽
  （全局磁盘信任 → 项目生命周期 → 根身份刷新 → `activeOps` 增减）。
- `runManagedStructureChange` 改走 `withStructureDiskOp`；`withStructureChange`
  仍是"先关门 → 再排空 → 再查会话 → 最后执行"。

**测试**：B-01（在途普通操作 + 排空 + 屏障期普通通道 409 + 结构通道可用 + 完成后
成功，且 HTTP `/api/tree` 也是 409 `ERR_PROJECT_BUSY`）、B-02（屏障外调用结构通道
被拒）。

## 三、排他占位归属

**缺陷**：`verify()` 与失败清理都用 `isFile() && size === 0` 判断"目标是不是我的
占位"。外部进程删掉占位再放一个同名 0 字节文件，旧实现会把它当自己的占位并
`unlink`——误删外部文件，且可能把结果误判成"零变更"。

**修复**：
- 新增 `EntryIdentity = { dev, ino }`（按字符串比较，兼容 number/bigint）。
- `open(target,'wx')` 成功后立刻 `handle.stat()` 记录身份（`afterMoveReserve`
  仅测试钩子在其后触发）。
- rename 前复核：`foreign` → `ERR_ENTRY_EXISTS`（不覆盖、不删除）；`missing`
  → 重新占位一次（目标名空着，重新收紧窗口）。
- `verify()` 只有在"源还在且目标仍属本次占位"时才判 `unchanged`；清理时只有
  `owned` 才 `unlink`，`foreign` → UNKNOWN，绝不删除外部对象。
- 剩余竞争窗口如实保留：`rename` 本身仍无原子 no-replace 保证（Windows
  `MoveFileExW + REPLACE_EXISTING`），现在只是把它夹在"占位 + 身份复核"之间，
  **不宣称绝对防覆盖**。

**测试**：C-01（占位被换成同名 0 字节文件 → 409 `ERR_ENTRY_EXISTS`、外部文件
仍在且 0 字节、源文件内容不变）。

## 四、红绿与探针

- 套件 74：基线上 6 项中 5 红（A-01/A-02/B-01/B-02/C-01；A-03 是"草稿不得丢失"
  的回归护栏，基线本就通过，如实记录）→ 修复后 6/6 绿。
- 探针：P1 去掉旧 View 释放 → A-01/A-02 红；P2 去掉 `withDiskOp` 屏障拒绝 →
  B-01 红；P3 去掉结构通道前置 → B-02 红；P4a 去掉 rename 前归属复核 → C-01 红
  （实际 200：外部文件被覆盖）。均还原，源码无 PROBE 残留。
- 说明：`verify()` / 清理处的身份核对是纵深防御——P4a 已证明"前复核"是主防线；
  在它存在的前提下单独回退 verify 不会红，不夸大其判别力。

## 五、真实 Chrome（headless + CDP，Vite 5220 → Host 5221，fake-picker）

- `red/browser-verification.json`（基线代码）：`clientInstanceId: null`、
  刷新后旧 View 仍可读（200）、关闭标签后改名失败（磁盘仍未改名）。
- `green/browser-verification.json`：5/5
  - 刷新前后 `clientInstanceId` 相同（`1676ce0a-…`）；
  - 刷新后新建 `view-2`，旧 `view-1` 读取 403（已释放）；
  - 标签仍开着时改名被拦且磁盘零变更（保护未被削弱）；
  - 关闭标签后改名成功（`after-refresh.md`）。
