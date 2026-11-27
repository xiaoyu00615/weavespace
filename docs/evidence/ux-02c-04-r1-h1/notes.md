# UX-02C-04-R1-H1 证据：元数据发送边界与四元组一致性收尾

父提交 `764ea77`（R1 交付），分支 `wip/ux-02c-04-resource-metadata-20261127`。
本轮只修两个**已确认**的问题，不重构元数据系统。

## 1. 两个问题

| 编号 | 问题 | 根因 |
|---|---|---|
| H1-01 | Client API 内部 `await sessionToken()` 期间切换工作区，POST 照发 | 最后一次归属核验在**调用 Client API 之前**，与真正的 `fetch()` 之间隔着取令牌的 await |
| H1-02 | 迁移去重只按 `path + identity` | `commitMetadataRelocate` 的 `seen` 键漏了 `projectId` 与 `rootToken`：另一个项目（硬链接/嵌套授权）或另一份根令牌下的同路径同身份记录，会把本次真实迁移的记录当成"重复"丢掉 |

## 2. 修复

### H1-01 发送前最终裁决

- `client-api.ts`：新增 `MetadataSendGate` / `MetadataSendDecision` / `MetadataSendRefusalReason`；
  `postMetadata(endpoint, payload, gate)` 在 `sessionToken()` 返回后、`request()` 之前**同步**执行
  `evaluateMetadataSendGate`。从那一行到 `request(...)` 之间没有任何 `await`。
- 裁决结果是 `MetadataOutcome` 的新成员 `{ status: 'NOT_SENT', reason }`，与 `UNKNOWN` 分开。
- `evaluateMetadataSendGate` fail-closed：gate 漏传 / 抛异常 / 返回非法形状 → 拒绝
  （`target-unverified`），绝不"假装检查过"，也不会冒泡成 `UNKNOWN`。
- `metadata-session.ts`：`sendGateOf(host, binding)` 用**与提交前完全相同的判据**
  （`metadataOwnershipOf`）构造 gate；`MetadataRunnerHost.set/clear` 必须接收并透传 gate。
- `DocumentActionsContext` / `MetadataContext` 只负责把 gate 原样透传，**不在组件层提前调用**。
- `NOT_SENT` 的处理：同一工作区内给出"没有保存"的 stale 文案；工作区已切走则**静默丢弃**
  （不刷新、不提示，避免落在别人的工作区）。
- 保留 Host 自己的资源锚核验（`assertMetadataAnchorMatches` → 409），gate 只是前置条件。
- 保留正常调用与"明确清理失效记录"（`scope: 'stale'`）的能力：两条路径都走同一段 `postMetadata`。

### H1-02 完整四元组

- `commitMetadataRelocate`：去重键改为 `projectId + rootToken + pathKey(path) + identity`；
  `pathKey` 与 `sameEntryPath` 同一口径（Windows 大小写不敏感）。别的项目、别的根令牌、
  别的身份的记录一律保留。
- `commitMetadataUpdateIdentity`：改身份前检查**目标四元组**是否已存在；存在则
  `{ changed:false, outcome:'skipped-conflict' }`，零写入。不覆盖目标记录、不删旧记录、
  不抛错（调用方是已成功的正文保存），因此也不会写出下次启动无法解析的配置。
- 配置版本不变（仍 v5），校验和规则不变（`canonicalMetadata` 排序键未动）。

## 3. 红测 → 修复

新增套件 105（5 例，Shell）与套件 103 的 H1-B 组（4 例，Host）。

| 用例 | 先红时的实际结果 | 修复后 |
|---|---|---|
| H1-A01 设置 + 令牌在途切工作区 | 发出 1 次 `metadata/set`（提示"已保存"） | 零 POST、零刷新、零提示 |
| H1-A02 清除 + 同一窗口 | 发出 1 次 `metadata/clear` | 零 POST |
| H1-A04 发送前拒绝 | 返回 APPLIED（成功） | `stale` + "目标资源已被替换…没有保存"，不是 UNKNOWN |
| H1-A05 gate 缺失 | 照常发出 POST | `NOT_SENT`，零 POST |
| H1-B01 别的项目同路径同身份 | `metadataMigration: 'none'`，A 的记录被 B 的记录挤掉 | `moved` + 1，两条记录各自保留 |
| H1-B02 同项目不同根令牌 | 同上（真实记录被旧根令牌记录挤掉） | 两条都保留 |
| H1-B03 迁移后同一四元组 | 已通过（防"过度修正"的守门用例） | 仍只留一条，配置可解析 |
| H1-B04 再绑定撞上已有四元组 | 写出重复四元组 → `parseConfig` 失败（重启即损坏） | `skipped-conflict`，重启 `integrity: OK` |

A 组全部经**真实 `createMetadataRunner` → 真实 `createLiveClient` → 受控 `fetch`**，令牌响应
可挂起；断言的是"有没有真的发出 metadata/set|clear"，不是 Port 的返回值。

## 4. 变异探针（`mutate.mjs` → `mutations.json`）

| 探针 | 改坏什么 | 咬住的用例 | 还原 |
|---|---|---|---|
| H1-M1 | 去掉令牌到手后的最终复核 | H1-A01、A02、A04、A05 | 逐字节一致 |
| H1-M2 | `NOT_SENT` 当 `UNKNOWN` 处理 | H1-A04 | 逐字节一致 |
| H1-M3 | 去重退回 `path + identity` | H1-B01、B02 | 逐字节一致 |
| H1-M4 | 不检查目标四元组 | H1-B04 | 逐字节一致 |

四个探针全部 **BITTEN**，`restoreExact: true`。

## 5. 门禁

原始输出见 `gate-test-p0.txt` 与 `gate-typecheck-build.txt`。

- `npm run test:p0`：**1358 例 / 1356 pass / 0 fail / 2 skip**
- `npm run typecheck`、`npm run typecheck:apps`、`npm run build:shell`、`git diff --check`：全部 exit 0

## 6. 真实浏览器（`verify-send-gate.mjs` → `browser-verification.json`）

真实 Chrome（CDP 9348）+ 真实 Vite（5400，`WS_API_TARGET` 指向 Host）+ 真实 Host（5399，
`--workspace-store`），fixture `weavespace-test/h1`，**17/17 通过**：

1. **S2 正常保存**：右键 → 设置标注名 → 保存：恰好 1 次 `POST /api/metadata/set`，
   行上显示 `note.md（令牌窗口外）`，配置落一条记录。
2. **S1 令牌在途切工作区**：用 CDP `Fetch.requestPaused` 把 `/api/session-token` 挂住
   （证明 runner 的提交前核验已通过、正处窗口内）→ 窗口内点「演示」（identity key 的 `mode` 变了）
   → 放行令牌 → **`POST /api/metadata/set` 仍是 0 次**（全轮只有 S2 那一次），配置未被改动。
3. 回到真实模式：标注仍是原来那条，接口只承认一条 `active` 记录，正文 SHA-256 未变。

截图：`01-normal-save.png`、`02-token-paused-and-switched.png`（对话框"正在保存…"、
工具栏已切到演示）、`03-back-to-live.png`。

## 7. 未解决（与 R1 一致，本轮没有扩大）

- **inode 复用**：`dev:ino` 在文件删除后可能被新文件拿到，极端情况下新文件被判 `active`；
  本轮不新增防御（那需要每文件 sidecar 标记，会污染用户目录）。
- **TOCTOU**：核验与读写之间始终有时间窗。本轮把"最后一次核验"压到 POST 边的同步片段，
  窗口不是零。
- **跨进程/跨设备替换**：别的程序在窗口内换文件，本进程无从知晓。
- 真实 Windows 原生目录对话框仍未验证（不在本轮范围）。

旧证据目录（`ux-02c-04-resource-metadata/`、`ux-02c-04-r1-metadata-identity/`）**未改动**。
