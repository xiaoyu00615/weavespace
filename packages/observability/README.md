# observability（P0 探针）

## 职责
统一时间、追踪与日志底座：UTC 时间戳、trace/operation 上下文、单调耗时、JSONL 结构化日志。

## 公开接口（`index.ts`）
- `createLogger({ module, runId, sinks, minLevel?, clock? })` → `Logger`（`debug/info/warn/error/log/child`）
- `createJsonlFileSink(path)` / `createMemorySink()` → `LogSink`
- `runWithTrace({ runId, traceId? }, fn)` / `runWithOperation(operationId, fn)` / `currentTrace()`
- `startMonotonic()` → 耗时读取函数；`utcNow(clock?)` → UTC ISO 8601

## 数据所有权
只拥有「日志与追踪」这一类记录。**日志不是业务事实源**：不得以日志推断保存成功（docs/09）。

## 失败路径
- 日志文件写入失败：降级为 stderr 提示，**不抛出、不阻塞业务**（docs/09「日志 IO 失败受控降级」）。
- 无追踪上下文：记录 `traceId = "trace-unbound"`，便于用 grep 找出未纳入追踪的调用，而不是伪造 traceId。

## 已知限制
1. 无轮转、无保留期、无脱敏过滤器（docs/09 要求，未实现）。
2. 审计记录由 `kind:"AUDIT"` 字段区分，尚未在 sink 层强制分离（测试栈中已分流到 `audit-*.jsonl`）。
3. 无 Metrics/Trace 采样、无 Incident 诊断包生成。
4. 内存 sink 仅用于测试，无上限保护。

## 测试入口
`node tests/run-all.ts`（套件 `00-observability`：CT-12）。
