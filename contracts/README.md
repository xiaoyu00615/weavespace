# 提案级契约

- `schemas/plugin-manifest.schema.json`：验证插件清单字段和基础格式。
- `schemas/command-envelope.schema.json`：验证可请求命令的外壳形状。
- 当前只约束输入形状，不实现权限检查、资源身份鉴定、信任验证或逻辑规则。
- JSON Schema 文件的 `$id` 使用 `example.invalid` 占位，以明确不是可访问的线上标准地址；P0 应改为仓库内部规范 URI。
