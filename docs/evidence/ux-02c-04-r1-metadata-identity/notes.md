# UX-02C-04-R1 证据：资源元数据身份一致性

## 0. 基线与范围

| 项 | 值 |
|---|---|
| 分支 | `wip/ux-02c-04-resource-metadata-20261127` |
| 父提交（基线） | `8c073bc8ffbba34ae40108843c56e5304c075250` |
| `main` | `79b99e5`（未修改、未合并） |
| 范围 | 只修独立复审提出的四项身份一致性问题，不加新功能 |

四项修复：

| 编号 | 问题 | 结论 |
|---|---|---|
| R1-01 | 元数据按"项目 + 路径"唯一 → 同名新文件继承旧标注 | 唯一性改为**身份四元组**，同路径多身份共存，旧对象历史不丢 |
| R1-02 | 改名/移动按路径前缀无条件迁移 | 迁移输入改为**逐条核验过的移动清单**，只迁移真实移动的对象 |
| R1-03 | 编辑会话不绑定归属 → 切工作区/换对象后旧草稿可写到新对象 | 会话冻结绑定 + 前后两次归属判定 + 资源锚只作前置条件 |
| R1-04 | 界面拿不到真实迁移结果 | 严格窄化 `metadataMigration` / `metadataMoved`，失败与磁盘成功分开表述 |

## 1. 关键设计（实施事实）

- **身份四元组** `(projectId, path, rootToken, identity)`：记录唯一键、去重判据、
  校验和排序键三者统一到同一口径（`store/config.ts`）；
- **同路径多记录**是合法状态，不是损坏；`canonicalMetadata` 补 `identity`/`rootToken`
  两维后，既有 v5 配置（每路径至多一条）的校验和逐字节不变 —— 有独立复算的用例（R1-A06）
  与变异探针（R1-H）证明；
- **资源锚** `SHA-256("ws-meta-anchor-v1\n"+projectId+"\n"+pathKey+"\n"+rootToken+"\n"+identity)` 前 32 位：
  不透明、不作身份、不作授权，只让 Host 用自己刚核验的身份**重算一遍**再比对；
- 锚放在**页级** `anchors` / `projectAnchor`，不进条目：保存是"临时文件 + rename"，
  必然换 inode，锚每次保存都变；放进条目会让"别的操作不该改变这棵树"变成假失败
  （这一条是被套件 86 的既有用例逼出来的）；
- **保存后的身份再绑定**：复用 `decideHiddenRefresh` 的三份证据，COMMITTED 后按
  `commitMetadataUpdateIdentity`（update-only CAS）把标注绑到新 inode。这是本轮
  发现的真实缺陷：不改的话文件**编辑一次标注就消失**（变 `rebound`）；
- **会话归属**：`metadata-session.ts`（纯 TS，可被 `node:test` 直接 import）冻结
  `工作区身份键 + projectId + path + anchor`，提交前后各判一次；四类 stale
  （`workspace-switched` / `target-changed` / `target-missing` / `target-unverified`）
  与 `failed` 分离——前者重试会写错对象，不能提示"重试"。

## 2. 新增/修改文件

服务端：

- `apps/server/src/store/config.ts` — 四元组去重、`canonicalMetadata` 排序键
- `apps/server/src/store/file-store.ts` — `commitMetadata` 全等匹配、
  `commitMetadataRelocate({moves})`、`commitMetadataClearStale`、
  `commitMetadataUpdateIdentity`（CAS）
- `apps/server/src/metadata.ts` — `metadataAnchorOf`、按路径分组打标、`scope` 解析
- `apps/server/src/tree.ts` — 页级 `anchors` / `projectAnchor`（条目不带锚）
- `apps/server/src/server.ts` — 409 `ERR_METADATA_TARGET_CHANGED`、锚比对、
  逐条核验的迁移、`prepareMetadataRefresh` / `applyMetadataRefresh`

共享契约：

- `packages/contracts/metadata.ts` — `METADATA_ANCHOR_RE` / `isMetadataAnchor`
- `packages/contracts/errors.ts` — 新错误码

Shell：

- `apps/shell/src/state/metadata-session.ts`（新）
- `apps/shell/src/state/MetadataContext.tsx`（重写）
- `apps/shell/src/state/DocumentActionsContext.tsx`
- `apps/shell/src/client/client-api.ts`（锚、`scope`、严格窄化）
- `apps/shell/src/state/resource-metadata.ts` / `structure-change.ts`（stale 与
  "文件已移动但标注未迁移"文案）
- `apps/shell/src/components/tree-model.ts` + `state/{types,workspace-reducer,tree-load,
  workspace-load,refresh-project}.ts`（锚随层传递）

测试：

- `tests/suites/103-…-host.test.ts`（18 例）、`tests/suites/104-…-shell.test.ts`（18 例）

文档与证据：

- `docs/28_UX-02C-04_资源元数据契约.md`（§3.1 唯一性、§4.1/4.2/4.5、§7.1–7.3、§8.1、§9、§11、§12 能力边界）
- 本目录

## 3. 红测 → 修复

每个修复点都先写用例、在实现缺失时确认它失败，再改实现转绿。下发前逐项观察到的
失败形态（按用例设计意图记录，未单独留存当时的终端输出；**判别力的正式证据是
第 4 节的变异探针**，那里有逐字节还原的日志）：

| 用例 | 修复前的实际结果 | 修复后 |
|---|---|---|
| R1-A01 B 只设颜色 | B 继承 A 的标注名与标签（同路径只有一条记录被改写） | 两条记录，B 只有颜色 |
| R1-A04 保存换 inode | 标注变 `rebound`，行上标注消失 | 标注绑到新身份，行上不变 |
| R1-B01 同名新对象改名 | 旧对象标注跟随新对象 | 旧记录原位不动 |
| R1-C01 过期锚 | 200 且写到新对象 | 409，零写入 |
| R1-C13/C14 在途结果 | 刷新/提示落在新工作区 | 结果丢弃，零刷新零提示 |
| R1-D05/D06 结构变更响应 | `metadataMigration` 丢失 | `moved/none/failed` 如实传递 |

## 4. 变异探针

`mutate.mjs`（8 个探针，改坏 → 跑套件 → 还原 → 逐字节比对 SHA）：

| 探针 | 改坏什么 | 咬住的用例 |
|---|---|---|
| R1-A | 增量合并退回"项目 + 路径" | A01/A02/A03/C03/C04 |
| R1-B | 迁移不核验目标身份 | A02/B01/B02 |
| R1-C | 设置端点忽略资源锚 | C01/C02 |
| R1-D | 清除一律走"清理失效" | C03 |
| R1-E | 返回后不核对工作区 | C14 |
| R1-F | client 丢弃真实 `metadataMigration` | D05/D06 |
| R1-G | 保存后不做身份再绑定 | A04 |
| R1-H | 校验和投影多带一个字段 | A06 |

结果：**8/8 BITTEN**，`restoreExact: true`（还原后源文件 SHA-256 与基线一致）。
详见 `mutations.json`。

## 5. 门禁

| 门禁 | 结果 |
|---|---|
| `npm run test:p0` | 1349 例 / **1347 pass** / 0 fail / 2 skip（`gate-test-p0.txt`） |
| `npm run typecheck` | 通过 |
| `npm run typecheck:apps` | 通过 |
| `npm run build:shell` | 通过 |
| `git diff --check` | 无空白错误（`gate-typecheck-build.txt`） |

## 6. 真实浏览器复验

脚本：`verify-identity.mjs`（自己拉起 Host / Vite / Chrome，自己重启 Host；
`cdp.mjs` 是 CDP 客户端；`reset-fixture.mjs` 重建只属于本轮的测试 Workspace）。

环境：真实 Chrome headless（CDP 9347）+ 真实 Host（5397，`--workspace-store`）+
真实 Vite（5398），磁盘为 `D:/Workspace/projects/weavespace-test/c04r1`（用户真实文件未触碰）。

链路与断言（**41/41 通过**，`browser-verification.json`）：

| 阶段 | 断言 |
|---|---|
| 原文件 A 标注 | 标注名/标签/颜色落到行上；配置一条记录且身份 = 磁盘 `dev:ino` |
| 回收 A | 文件离开原路径；**记录仍在**（A 的历史不丢） |
| 同名新文件 B | 身份与 A 不同；**不继承** A 的标注名/标签/颜色 |
| 给 B 打不同标注 | 同路径**两条记录共存**；接口只把 B 判 `active`，A 如实 `rebound` |
| 移动 B | 身份不变、路径更新；A 的记录原位不动；没有伪造第三条 |
| 恢复 A | 同一对象（身份与 SHA-256 一致）回到原路径，标注重新生效 |
| 两者并存 | 根下 `same.md` = 原文件A/red，`dir/same.md` = 新文件B/blue |
| 重启 Host | 配置逐字段一致；两行各自仍正确；接口两条 `active` |

截图：

- `01-object-a-labeled.png` — A 标注后
- `02-b-labeled-same-path.png` — 同名新文件 B 拿到自己的标注（4 个条目）
- `03-both-kept.png` — 恢复 A 后两者并存（`dir/same.md` 新文件B、根 `same.md` 原文件A）
- `04-after-host-restart.png` — 重启后仍一致

取证过程中修掉的两个**脚本自身**问题（记下来，避免下次再踩）：

1. 树行只有 `.tree__name` 可定位，两个同名 `same.md` 同时可见时 `find` 会命中 DOM
   靠前的那一份（`dir` 字母序在前）→ 断言看起来像"A 显示了 B 的标注"。
   做法改为**先收窄可见范围**（折叠全部目录）再断言；
2. 项目根行同样是 `button.tree__row--folder` + `aria-expanded`，折叠全部目录时
   点它等于折叠整棵树（所有行消失）→ 必须跳过 `ul.tree__root` 下的那一行。

## 7. 兼容性与剩余风险

- v1–v4 只读兼容不变；既有 v5 配置零迁移、零重写（R1-A06 + 变异 R1-H）；
- 2000 条上限不变，仍然**不自动淘汰**；
- `dev:ino` 的能力边界与 inode 复用 / TOCTOU 未解决部分写在
  `docs/28 …§12`（不声称解决）；
- 真实 Windows 原生目录选择对话框仍未验证（与上一轮相同，不在本轮范围）。

## 8. 证据索引

| 文件 | 内容 |
|---|---|
| `browser-verification.json` | 41 项断言 + 每步的磁盘身份/SHA/配置快照 |
| `host-logs.txt` | 两次 Host 启动的完整输出 |
| `mutate.mjs` / `mutations.json` | 8 个变异探针与逐字节还原证据 |
| `verify-identity.mjs` / `cdp.mjs` / `reset-fixture.mjs` | 可复跑的复验脚本 |
| `gate-test-p0.txt` / `gate-typecheck-build.txt` | 门禁原始输出 |
| `01..04-*.png` | 四个关键界面状态 |
