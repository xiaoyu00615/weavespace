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

## 路径安全（S4 加固后）

**信任边界**：项目根的**规范真实路径**（`realpathSync.native(rootDir)`）是唯一授权边界。
若项目根本身是重解析点（junction / 符号链接），信任边界取其解析后的真实目录，
这是显式策略，不做静默放宽。

**判定依据**：Windows 上 `lstatSync().isSymbolicLink()` 对 **junction 返回 `false`**，
且 JS 版 `realpathSync()` **不解析 junction**；只有 `realpathSync.native()` 会解析。
因此实现以 `realpathSync.native()` 为唯一权威：**逐级比较每个已存在前缀的真实路径与字面路径**，
不一致即判定为不可信重解析点并拒绝。

**输入拒绝规则**（一律 `ERR_PATH_OUTSIDE_ROOT`）：
- 绝对路径、盘符路径（含盘符相对 `C:foo.md`）
- UNC 与设备路径（`\\server\...`、`\\?\...`）
- `..` 越过项目根
- 任何一级经过重解析点（包含指向根内的 junction —— 保守策略）
- 路径解析失败或权限不足等无法确认的情形（fail closed）

**各操作的边界**：

| 操作 | 安全行为 |
|---|---|
| `read` | 越界/重解析点 → 抛 `ERR_PATH_OUTSIDE_ROOT`，不返回根外内容 |
| `stat` | 同上，**抛错**而不是返回 `exists:false`（避免把安全错误伪装成文件不存在） |
| `writeConditional` | 解析 → 版本校验 → `mkdir` → **再次解析** → 写临时文件 → `rename`；任一步失败即 `FAILED` |
| `list` | 跳过 dirent 标记为链接的条目；每级目录递归前再次校验是否为可信解析结果 |

## 失败路径
| 情形 | 返回 |
|---|---|
| 路径逃逸（`..`、绝对/盘符/UNC/设备路径） | `FAILED / ERR_PATH_OUTSIDE_ROOT`（`read`/`stat` 抛错） |
| 路径经过重解析点（junction / 符号链接） | `FAILED / ERR_PATH_OUTSIDE_ROOT`（`read`/`stat` 抛错） |
| 路径无法确认（EACCES/EPERM/解析失败） | `FAILED / ERR_PATH_OUTSIDE_ROOT`（fail closed） |
| 期望版本与磁盘不一致 | `CONFLICT / ERR_DOCUMENT_VERSION_CONFLICT` |
| 创建时目标已存在（`expectedVersion=null`） | `CONFLICT` |
| 写盘 IO 失败 | `FAILED / ERR_STORAGE_IO`，临时文件已清理 |
| 已落盘但确认链中断（注入 `afterCommit`） | `UNKNOWN / ERR_OUTCOME_UNKNOWN` |

## 已知限制（未批准，不视为完成）
1. 版本 token 用内容 SHA-256：大文件成本未测量（docs/18 RSK-06，ADR 待定）。
2. 未实现 `watch`（外部变更检测由 document 主动重读模拟）。
3. 原子性仅覆盖「同目录临时文件 + rename」；跨卷/网络盘的保证未验证。
4. **TOCTOU 未完全消除**：路径校验与实际文件操作之间仍有时间窗。攻击者在窗口内
   把已校验的普通目录替换为重解析点仍可能绕过。本轮只保证「校验时刻」的一致性
   （`writeConditional` 在 `mkdir` 之后重新校验），**不声称已消除所有竞争条件**。
   彻底消除需要基于目录句柄的打开方式（Node 标准 API 未提供 `openat`/`O_NOFOLLOW`）。
5. **Windows 8.3 短名**：若路径中出现 `PROGRA~1` 这类短名，可能被判定为「解析结果不一致」
   而拒绝（fail closed，方向安全，但属可用性限制）。
6. **NTFS 备用数据流**（`file.txt:stream`）与文件名中的冒号未做专门拦截，依赖上游
   授权层的规范化；后续需在路径规范中显式拒绝（当前不影响根边界）。
7. 符号链接用例在本机以 `NOT_RUN` 记录（普通用户创建 symlink 需要管理员或开发者模式）；
   junction 用例已真实执行。
8. **`stat` 语义变更的调用方影响**：唯一调用方是 `document.detectExternalChange`。
   安全拒绝现在会以 `ERR_PATH_OUTSIDE_ROOT` 冒泡（可识别），而不再返回 `exists:false`
   被误认为「文件不存在」；正常缺失仍返回 `exists:false`（S4-15 / S4-16 已覆盖）。
9. **`document.openSession` 仍会吞掉读取失败**（`catch(() => null)` → 空缓冲）。
   经 junction 打开时不会泄漏根外内容（read 已被拒），但会得到一个空会话；
   这是既有缺陷（审计 P1-8），修复需改 `packages/document/`，不在 S4 授权范围内。

## 测试入口
`node tests/run-all.ts`（套件 `storage-path`、`save-conflict`、`save-failure`、`s4-path-security`）。
