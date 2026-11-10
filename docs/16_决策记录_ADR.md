# 决策登记簿（ADR）

**状态术语**：CONSENSUS（讨论共识） / PROPOSED（架构提案） / ACCEPTED（正式批准） / SUPERSEDED（被替代）。本包未获得用户对所有底层技术的正式 APPROVED。

| ADR | 主题 | 状态 | 说明 |
|---|---|---|---|
| ADR-001 | 本地优先、文件插件驱动工作台 | CONSENSUS | 首版默认本地使用 |
| ADR-002 | Shell + Headless Core 分离 | PROPOSED | 验证 UI/Host 状态边界 |
| ADR-003 | 一个扩展名支持多个处理器 | CONSENSUS | Parser/Viewer/Editor/Serializer 可拆 |
| ADR-004 | Document Session 共享、保存协调 | PROPOSED | P0 必测 |
| ADR-005 | 所有 AI 与 UI 统一命令与权限 | CONSENSUS | P0 做最小接口 |
| ADR-006 | Source/Derived/Authored/Presentation 分层 | PROPOSED | 防索引覆盖 |
| ADR-007 | 单主机状态权威，LAN 客户端 API 访问 | PROPOSED | LAN 实现前审查 |
| ADR-008 | UTC 时间/trace/审计/诊断不可缺 | CONSENSUS | 作为工程规范 |
| ADR-009 | Cordis 作为插件容器候选 | PROPOSED | 不能跳过探针 |
| ADR-010 | React + TypeScript + Node + SQLite 候选栈 | PROPOSED | 各层单独评估 |
| ADR-011 | 自定义画布 `.wcanvas` 候选格式 | PROPOSED | 文件版本与兼容性审查 |
| ADR-012 | GitHub 私有仓库、双电脑独立 SSH | PROPOSED | 用户自行创建账号/仓库 |
| ADR-013 | 正式使用「织界（WeaveSpace）」作为产品名与 `weavespace` 作为仓库名 | ACCEPTED | 用户已选择名称；自定义文件扩展名 `.wcanvas` / `.wproject` 仍为提案 |

## 变更记录模板

- ADR-ID / 变更日期（UTC）/ 参与决策者
- 背景 / 问题 / 候选方案 / 约束与风险
- 决定 / 影响模块 / 兼容策略 / 验证证据
- 状态变更 / 旧 ADR 的替代链接

**原则**：没有证据的技术断言标成假设，不“自动批准”。
