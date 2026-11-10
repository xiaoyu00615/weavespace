# 插件 SDK / 运行生命周期设计

## 插件不是扩展名的独占者

- `.md` 可同时由文本编辑、阅读、结构分析插件处理。
- 一个插件提供 Parser、Viewer、Editor、Serializer、Command、UI Slot 等任意子集；声明能力≠获得授权。
- 扩展名 + MIME / 文件魔数 + 项目默认选择共同决定匹配；未知类型允许通用只读处理。

## Manifest 最小字段（候选）

`id`、`version`、`apiVersion`、`fileExtensions`、`provides`、`requires`、`requestedPermissions`、`activationEvents`、`entrypoints`。`contracts/schemas/plugin-manifest.schema.json` 给出 JSON Schema 示例；程序必须做运行时校验并检查 id 冲突、依赖与平台能力。

## 生命周期状态

DISCOVERED → VALIDATED → REGISTERED → ACTIVATING → ACTIVE → DEACTIVATING → INACTIVE。

失败状态包括 BLOCKED_DEPENDENCY / DENIED_PERMISSION / FAILED / QUARANTINED，状态必须有时间戳和可见错误原因。

- 安装：审查来源、依赖、版本与权限申请。
- 启动：按需激活，发布能力和 UI Slot；effect/cleanup 记录清理资源。
- 关闭：先处理未保存编辑、订阅、运行任务，再卸载；不要直接丢弃 Session。
- 故障：观察日志/trace、按策略隔离并可进入安全模式。
- 升级：API 兼容检查、数据迁移与必要时回退。

## DSH 参考与 WeaveSpace 特有约束

DeepSeek Harness/Cordis 提供 Context、`inject`、typed events、可撤销 effect、UI Slots 的参考实现；**候选技术，需要独立技术探针**，不直接复制 DSH 的 Agent Runtime 或全量插件树。

官方参考：
- https://deepseek-harness.github.io/deepseek-harness/en/reference/
- https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/slots
- https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/web-client

与 DSH 不同，WeaveSpace 插件还需通过 Document/Serializer 契约处理 dirty、冲突检测、原生文件保存与恢复。不同格式的内部 Model 可以不同。

## 隔离等级

- Trusted built-in：受测内置模块，可同进程启动（但不宣称强隔离）。
- Local developer：由用户手工启用、明确权限；首次开发先限制范围。
- Third party：未来采用隔离进程/Worker（取决于实际可隔离能力）、受控 RPC、资源限额、取消/超时。不要以 JSON Schema 代替安全沙箱。

## 插件必须提供的最低诊断

`pluginId/version/apiVersion/status/activatedAt/lastErrorCode/lastErrorAt`；允许 Core 在插件已崩溃时仍检索它的失败事件。独立测试覆盖：无依赖、不兼容、重复 ID、取消加载、卸载时脏文档、失败清理。
