# contracts（P0 探针草案）

## 职责
跨模块共享的**类型、错误码与协议常量**。零运行时依赖、零业务逻辑、不访问数据库或文件系统。

## 公开接口（`index.ts`）
- `ERROR_CODES` / `ALL_ERROR_CODES` / `ErrorCode`：稳定错误码注册表
- 类型：`CommandEnvelope`、`CommandResult`、`EventEnvelope`、`ResourceRef`、`DocumentStateView`、`SaveResult`、`PluginManifest`、`LogRecord` 等

## 数据所有权
不拥有数据，只定义形状。`contracts/schemas/*.json` 是提案级 JSON Schema；本目录的 TS 类型是**运行时草案**，两者尚未做自动一致性校验（待 ADR）。

## 状态与限制
1. **DRAFT，未冻结**。新增/修改字段必须留 ADR（ENG-003）。
2. 错误码来自 docs/09 正文的人工整理（RSK-01）；尚无机器可读 schema。
3. `DocumentState`/`EventEnvelope`/保存结果暂无对应 JSON Schema 文件（RSK-02）。
4. 无 API 版本号与迁移机制（`apiVersion` 目前是字符串常量比较）。

## 测试入口
`node tests/run-all.ts`（套件 `CONTRACT-01…07`）。
