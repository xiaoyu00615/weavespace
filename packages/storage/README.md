# storage（P0 探针）

## 职责
本地文件内容的读写原语，以及「项目根即授权边界」的路径校验。

## 公开接口（`index.ts`）
- `createLocalProvider({ rootDir, faults? })` → `StorageProvider`
- `StorageProvider.stat(path)` / `read(path)` / `writeConditional(path, content, expectedVersion)` / `list(dir?)`
- `resolveInsideRoot(rootDir, requestedPath)` → 路径边界判定
- `contentVersionOf(content)` → `sha256:<hex>`

## 数据所有权
只拥有「磁盘字节」这一事实。不拥有文档会话、不决定冲突处理策略、不做授权。

## 失败路径
| 情形 | 返回 |
|---|---|
| 路径逃逸（`..`、绝对路径、符号链接指向根外） | `FAILED / ERR_PATH_OUTSIDE_ROOT` |
| 期望版本与磁盘不一致 | `CONFLICT / ERR_DOCUMENT_VERSION_CONFLICT` |
| 创建时目标已存在（`expectedVersion=null`） | `CONFLICT` |
| 写盘 IO 失败 | `FAILED / ERR_STORAGE_IO`，临时文件已清理 |
| 已落盘但确认链中断（注入 `afterCommit`） | `UNKNOWN / ERR_OUTCOME_UNKNOWN` |

## 已知限制（未批准，不视为完成）
1. 版本 token 用内容 SHA-256：大文件成本未测量（docs/18 RSK-06，ADR 待定）。
2. 未实现 `watch`（外部变更检测由 document 主动重读模拟）。
3. 原子性仅覆盖「同目录临时文件 + rename」；跨卷/网络盘的保证未验证。
4. 符号链接逃逸只在目标已存在时可判定；新建路径的父目录链接未做递进校验。

## 测试入口
`node tests/run-all.ts`（套件 `storage-path`、`save-conflict`、`save-failure`）。
