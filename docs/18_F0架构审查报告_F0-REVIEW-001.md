# F0 只读架构审查报告 `F0-REVIEW-001`

- **任务**：`F0-REVIEW-001`（docs/17 第一步，只读）
- **审查者**：DSH 工程审查者
- **审查时间(UTC)**：见文末测试记录
- **仓库状态**：尚未 `git init`；无业务代码；本次未创建任何 Git 提交
- **阅读范围**：README、START_HERE、docs/00、02、03、04、05、06、07、08、09、11、12、14、15、16、17；contracts/schemas、examples/、tools/check_package.py、diagrams/01、02
- **审查性质**：静态设计审查。**未运行任何业务测试**，本文出现的"可实现/可行"均不是 PASS 证据。

## 0. 结论摘要

| 维度 | 评定 |
|---|---|
| 层次与依赖方向（02/03） | PASS（有明确禁止项） |
| 数据分层与权威唯一（02/04/15） | PASS（Authored/Derived 分离明确） |
| 防重复责任（保存/日志/命令/AI 入口） | PASS（15 有专门检查表） |
| 时间与可观测性规范（04/09/12） | PASS（字段与时间语义完整） |
| 安全默认（08/12 SEC/NET/AI） | PASS（默认 localhost、默认只读、默认关闭 LAN） |
| 契约机器可读性 | **ISSUES**（见 RSK-01/02/03/04/05） |
| 幂等/收据/事件序列所有权 | **ISSUES**（RSK-07/08/12） |
| 版本 token 实现方案 | **ISSUES**（RSK-06） |
| 资源 ID 稳定映射持久化 | **ISSUES**（RSK-09） |
| 权限 scope 语法 | **ISSUES**（RSK-10） |
| 图与文字一致性 | **ISSUES（低优先）**（RSK-14） |
| 同进程插件隔离 | 已诚实声明能力限制，不得标 VERIFIED（RSK-13） |

**总体裁定**：架构边界可进入 F0 签收与 P0 技术探针；**不具备**宣称"数据安全/插件隔离已实现"的任何依据。以下 ISSUES 均未擅自修改契约，全部登记为待决项。

## 1. PASS 项（有文档依据，非代码证据）

1. **四层分离与调用方向**（02）：Shell 不直连 SQLite/特权文件 API；插件不得 import 他人实现目录；安全检查在服务端操作边界执行。
2. **状态权威表**（02）：Source/Session/Derived/Authored/Presentation/Command-Receipt/Audit 七类状态各有唯一拥有者，且标注"可否重建"。
3. **不重复造服务**（06/15）：Serializer 编码、Document 会话冲突、Storage 落盘原语三者分工唯一；未出现第二个保存服务或第二套日志事实源。
4. **时间语义**（04/09）：`occurredAt/detectedAt/savedAt/startedAt/finishedAt` 分离；耗时用单调计时器；事件顺序用 `sequence` 而非墙钟。
5. **日志三分类**（09）：Operational Logs / Audit / Command-Receipt 分离，禁止从日志推断业务成功。
6. **失败语义**（04/06）：`UNKNOWN` 不与 `FAILED` 混同，不得自动重试副作用；dirty 不得静默丢弃。
7. **测试门槛**（12/14）：CT-01…CT-12 矩阵可执行；失败注入覆盖冲突、磁盘错误、插件异常、重复命令、越权写入。
8. **工程约束可检查**（12）：ARCH/ENG/TIME/OBS/DATA/SEC/NET/AI 编号完整，ENG-005 要求每模块 README（本次 P0 落实）。
9. **静态包检查**：`python tools/check_package.py` → `PACKAGE_STRUCTURE_CHECK: PASS`；examples/contracts 全部 JSON 合法。
10. **决策克制**（00/16）：技术栈均为 PROPOSED，`ADR-013` 仅产品名 ACCEPTED，未出现"自动批准"。

## 2. ISSUES（需裁决或需契约补充，未擅自变更）

| ID | 问题 | 归属（不新建模块） | 影响 | 建议处置 |
|---|---|---|---|---|
| RSK-01 | 错误码只存在于 docs/09 正文，`contracts/` 无机器可读注册表，契约测试无法枚举校验 | contracts | CT-05/06/09/12 断言弱化 | P0 先建 `packages/contracts` 内的错误码常量（草案，非冻结），后续定 ADR 是否转为 schema 文件 |
| RSK-02 | `contracts/schemas/` 只有 command-envelope 与 plugin-manifest；缺 `DocumentState`、`EventEnvelope`、保存结果、日志事件 schema | contracts | CT-03/04 的 `SAVE_COMMITTED` 无契约文件依据 | P0 只定义 TypeScript 草案类型 + 运行时校验；**不**新增冻结 schema，待签收 |
| RSK-03 | plugin-manifest `additionalProperties:false` 与 docs/04"未知字段优先保留"的向前兼容原则冲突：新增字段即被判不合法 | contracts + plugin-runtime | 第三方插件升级易被拒收 | 明确区分：**清单严格 / 数据格式宽松**；需 ADR 决定清单是否允许 `x-` 扩展字段 |
| RSK-04 | CommandEnvelope 无 `actorId`；docs/04 要求 actor 由 Gateway 绑定、不可信客户端自述 | command + gateway | 越权判定可能落到客户端字段 | P0 采用 `dispatch(envelope, ctx{actorId,traceId})` 双参数，envelope 不携带可信身份；需 ADR 固化 |
| RSK-05 | `expectedVersion` 在 schema 中可选，但 DATA-001 要求写入前版本校验 | command + document | 无条件覆盖风险 | 写命令强制 `expectedVersion`；缺失即 `REJECTED/ERR_COMMAND_INVALID`；由 ADR 确认 |
| RSK-06 | `contentVersion` 实现方案未定（hash vs mtime+size）；06 禁止单凭 mtime | storage + resource | 冲突检测可信度、大文件成本 | P0 用内容 sha256 探针测量成本，方案入 ADR |
| RSK-07 | `gateway.subscribe` 与 `jobs-events.subscribe` 两个订阅面，事件序列权威未定 | gateway / jobs-events | 双事件源风险 | ADR 明确：Gateway 仅传输，序列权威在 jobs-events |
| RSK-08 | 命令收据（`command.getResult`）持久化位置未定；重启后 idempotencyKey 去重失效 | command + jobs-events | CT-07/CT-10 跨重启不成立 | P0 先内存收据并在报告标注"进程内有效"；持久化收据待 ADR |
| RSK-09 | `resourceId` 稳定映射的存储位置未定（Resource 拥有映射但无持久化） | resource + storage | 重命名后链接失效 | P0 内存注册表，明确标记"重启不保持"；持久化方案待 E01 |
| RSK-10 | 权限 scope 语法未定（project/folder/file 的表示形式） | permission | 授权边界不可测试 | P0 用根目录 + 相对前缀规则作探针语法；ADR 待定 |
| RSK-11 | 日志必填字段含 `runId`，但 `runId` 生命周期（谁创建/何时轮换）未定义 | observability | 字段可能形同虚设 | P0 以 Host 进程启动时间为 runId；ADR 待定 |
| RSK-12 | `UNKNOWN` 之后的重试与收据查询流程未定义 | command + document | 可能重复副作用 | P0 提供 `reconcile`：重读磁盘版本判定，禁止盲目重放；流程待 ADR |
| RSK-13 | 同进程插件无强隔离（02/05 已声明）；CT-08 只能证明"未保存内容受保护 + Core 可诊断" | plugin-runtime | 不能对外宣称隔离 | 报告能力标签须写 `PROBE/同进程`，禁止标 VERIFIED；第三方隔离后置 |
| RSK-14 | 图 02 缺 `Command→Permission`、`Document→Storage`、`Jobs/Observability` 交叉边；图 02 把 Command/Permission 合为一个节点，与 03 的模块清单不完全对应 | diagrams + 03 | 图与文字轻微不一致 | 低优先；图属 F0 提案资产，等契约冻结后一并修订，本次不改图 |
| RSK-15 | docs/01 未定义 Derived/Authored 的存储介质；`knowledge-index` 接口已列出但无持久化契约 | knowledge(后期) | E05 前必须解决 | 保持待定，不在 P0 范围内 |
| RSK-16 | CT-11"新增查看器插件不改已有实现源文件"缺自动化保障 | plugin-runtime + CI | 回归靠人工 | P0 以静态 import 边界检查近似实现（架构测试） |
| RSK-17 | Windows 专项：大小写不敏感、UNC/长路径、CRLF/BOM、符号链接权限 | resource + storage | 路径边界判断偏差 | P0 覆盖路径规范化/越界/符号链接（能创建则测，否则记 NOT_RUN） |
| RSK-18 | 无 Health/readiness 契约文件；诊断包字段仅在正文 | observability | OBS-002 不可测 | 待 E01/E09，保持待定 |

## 3. 未决 ADR 清单（保持 PROPOSED/待批，不擅自锁定）

| ADR | 主题 | 本审查意见 |
|---|---|---|
| ADR-002 | Shell + Headless Core 分离 | P0 只探针 Headless Core；UI 边界未验证 |
| ADR-004 | Document Session 共享、保存协调 | P0 探针覆盖（多视图共享 + 冲突），仍需 UI 侧验证 |
| ADR-006 | Source/Derived/Authored 分层 | 无 Deriv​ed 实现，未验证 |
| ADR-007 | 单主机权威 | 未验证（无 LAN、无多客户端） |
| ADR-009 | Cordis 作为插件容器 | **未探针**；P0 用自研极简 runtime，结论不构成对 Cordis 的否决或背书 |
| ADR-010 | React+TS+Node+SQLite | 仅用到 Node/TypeScript 运行时；SQLite/React 全部未验证 |
| ADR-011 | `.wcanvas` 候选格式 | 未涉及 |
| ADR-012 | GitHub 私有仓库 | 仓库未初始化，未涉及 |
| 新增候选 | RSK-03/04/05/06/07/08/10/11/12 所述 8 个细项 | 建议合并为 2–3 个 ADR：契约严格度、身份与版本、收据与事件所有权 |

## 4. 建议的 P0 探针范围（本次执行，见 docs/19）

- 形态：**Headless、同进程、零第三方依赖**（Node 24 原生 TypeScript 类型剥离 + node:test）。
- 覆盖：CT-01、CT-02、CT-03、CT-04、CT-05/09、CT-06、CT-07、CT-08（仅限"不拖垮 Core"）、CT-10、CT-11、CT-12。
- 明确 **NOT_RUN**：HTTP/localhost 服务、任何 UI、SQLite、Cordis、LAN、MCP、Docling、大文件性能。

## 5. 交付记录（模板 docs/14）

```text
Task: F0-REVIEW-001
Commit: 无（仓库未 git init，未经授权不创建提交）
Environment: Windows / Node v24.14.1 / pnpm 11.20.0 / Python 3.11.9
StartedAt(UTC): 2026-05-19T00:00:00Z（近似，见 docs/19 实测时间戳）
FinishedAt(UTC): 见 docs/19 末尾
Result: PASS（只读审查完成，ISSUES 已登记 18 项，无契约改动）
Evidence: python tools/check_package.py -> PACKAGE_STRUCTURE_CHECK: PASS
Notes: 未访问任何真实私人资产、未上传文件、未开启任何网络服务；未移植 Work Relay / Local Agent Hub 代码。
```
