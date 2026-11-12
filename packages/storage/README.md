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

## 路径安全（S4-R1/R2 加固后）

**信任边界**：项目根的**规范真实路径**是唯一授权边界。若项目根本身是重解析点
（junction / 符号链接），信任边界取其解析后的真实目录，这是显式策略，不做静默放宽。

### 根目录身份固定（S4-R1）

`createLocalProvider()` 在**构造时**一次性建立 `RootBoundary`，之后 read/stat/list/write
全部复用同一个边界，不再每次重新 realpath 根目录：

| 情形 | 边界取值 | `verified` |
|---|---|---|
| 根可解析 | `realpathSync.native(rootDir)` | `true` |
| 根尚不存在（ENOENT，且祖先链全部是普通缺失目录） | **最近可解析祖先的 realpath + 字面剩余段** | `false` |
| EPERM / EACCES / ENAMETOOLONG / 悬空重解析点（**含任意一级祖先**，F04） | **抛 `ERR_PATH_OUTSIDE_ROOT`**（fail closed，不回退字面路径） | — |

祖先回溯时，**每一级 ENOENT 都要判断它是否其实是悬空 junction/符号链接**：`realpath` 对二者
同样报 ENOENT，若直接当作普通缺失目录拼进 `canonicalRoot`，等于接受未经验证的边界。

写入过程在三个节点重建边界并与固定身份比对（fault 注入后、`mkdir` 后、`rename` 前）；
父级 junction 从 A 改向 B 时身份不一致 → `FAILED / ERR_PATH_OUTSIDE_ROOT`。

**边界的能力上限（D01）**：`RootBoundary` 固定的是**规范路径字符串**，靠「重新解析并比对」
来检测漂移，**并不持有 Windows 目录句柄、也不是不可替换的文件系统锚点**。因此：

- 本轮**已阻断**审计中那类确定性交错（在 `beforeCommit` 注入点内改向父级 junction）：
  检查点先于 `mkdir`，两侧都不会产生对象，且返回 `FAILED` 而不是 `COMMITTED`；
- **但最后一次校验与实际文件操作之间仍存在 TOCTOU**。若在该窗口内把固定路径的某级目录
  替换为重解析点，写入仍可能被重定向；此时不承诺「任何时刻 B 侧绝不产生副作用」。
  彻底消除需要基于目录句柄的 `openat`/`O_NOFOLLOW` 语义，Node 标准 API 未提供。

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
| `read` | 越界/重解析点/边界漂移 → 抛 `ERR_PATH_OUTSIDE_ROOT`；I/O 失败 → `ERR_STORAGE_IO`，权限失败 → `ERR_PERMISSION_DENIED` |
| `stat` | 同上，**抛错**而不是返回 `exists:false`（只有真正的 ENOENT 才是 `exists:false`） |
| `writeConditional` | **边界比对（先于版本比较，F06）** → 解析 → 版本校验 → **边界比对** → `mkdir` → **再次解析** → **边界比对** → 写临时文件 → **边界比对** → `rename`；任一步失败即 `FAILED` |
| `list` | 校验边界后遍历；跳过 dirent 标记为链接的条目；每级目录递归前再次校验是否为可信解析结果 |

## 文本安全（S5）

**定位**：`read()` 是 **UTF-8 文本接口**，不是通用二进制读取器。无法安全表示为文本的内容必须
拒绝，绝不返回“有损字符串”——否则下一次保存会把 U+FFFD 写回磁盘，原始字节永久丢失。

| 环节 | 规则 |
|---|---|
| 解码 | `TextDecoder('utf-8', { fatal: true, ignoreBOM: true })`：非法字节 → `ERR_ENCODING_UNSUPPORTED`；BOM 保留为内容首字符（不剥离）；CRLF 不规范化 |
| 二进制门禁 | NUL、不安全控制字节（`0x00-0x08`、`0x0B`、`0x0E-0x1F`、`0x7F`）、已知签名（PNG/JPEG/GIF/ZIP/PDF/ELF）→ `ERR_RESOURCE_NOT_TEXT` |
| 版本 | `contentVersion` 始终基于**原始磁盘字节** |
| 写入（内容） | 未配对 UTF-16 代理项 → `ERR_ENCODING_UNSUPPORTED`；含不安全控制字节 → `ERR_RESOURCE_NOT_TEXT`（不得用文本 API 造二进制） |
| 写入（目标） | 目标是已识别的非文本 → `FAILED`（`ERR_RESOURCE_NOT_TEXT` / `ERR_ENCODING_UNSUPPORTED`），不改写字节 |
| 会话打开 | 只有 `ERR_RESOURCE_NOT_FOUND`（真正不存在）才创建空会话；编码/二进制/权限/IO 失败直接抛出 |

**这是有限启发式，不是通用二进制识别器**：未建签名的私有格式不会被识别，仍须靠插件声明
（docs/06「文件格式特性」）。合法文本中包含字面 U+FFFD 不受影响（按字节往返判定，不看字符）。

调用方：`DocumentService.save()` 与直接调用 `writeConditional()` 走同一门禁。

## 错误语义（S4-R2）

| OS 错误 | 注册错误码 | 语义 |
|---|---|---|
| `ENOENT` | `ERR_RESOURCE_NOT_FOUND` / `stat` 的 `exists:false` | 目标确实不存在 |
| `EPERM`、`EACCES` | `ERR_PERMISSION_DENIED` | 权限不足（可能文件存在） |
| `EBUSY`、`EIO`、`ENOSPC`、`EMFILE` 等 | `ERR_STORAGE_IO` | 无法确认的存储 I/O 故障 |

**不再发生的行为**：把 `EBUSY/EPERM/EACCES` 折叠成 `exists:false`；或把版本读取失败
当作「可以创建」而覆盖已存在文件。`document.detectExternalChange` 因此在无法确认磁盘状态时
抛出可识别错误，而不是返回 `changed:false`。

### 「允许缺失」与「已确认存在」两种版本读取（F01）

`stat()` 先 `stat()` 再读内容算版本，两步之间目标可能被删除。因此版本读取被拆成两种语义：

| 语义 | 使用位置 | ENOENT 时 |
|---|---|---|
| 允许缺失（`versionIfPresent`） | `writeConditional` 的创建语义（`expectedVersion=null`） | 返回 `null` → 允许「仅当不存在时创建」 |
| 已确认存在（`versionOfConfirmedFile`） | `stat()` 确认目标是普通文件之后 | **不得返回 null**：重试 + 重新 `stat` 核验；确认已消失 → 返回一致的 `exists:false`；持续矛盾 → 抛 `ERR_STORAGE_IO` |

因此 `stat()` 不再可能返回 `{ exists:true, contentVersion:null }`（目录等非普通文件的
`contentVersion:null` 属于明确语义，不在此列）；`EBUSY/EPERM/EACCES` 在任何一步都不当作不存在。

## 失败路径
| 情形 | 返回 |
|---|---|
| 路径逃逸（`..`、绝对/盘符/UNC/设备路径） | `FAILED / ERR_PATH_OUTSIDE_ROOT`（`read`/`stat` 抛错） |
| 路径经过重解析点（junction / 符号链接 / 悬空 junction） | `FAILED / ERR_PATH_OUTSIDE_ROOT`（`read`/`stat` 抛错） |
| 路径或根目录无法确认（EACCES/EPERM/ENAMETOOLONG/解析失败） | `FAILED / ERR_PATH_OUTSIDE_ROOT`（fail closed） |
| **根目录身份漂移**（父级 junction 改写目标） | `FAILED / ERR_PATH_OUTSIDE_ROOT`；`beforeCommit` 注入的交错下两侧均无对象（窗口内竞争见限制 4） |
| 期望版本与磁盘不一致 | `CONFLICT / ERR_DOCUMENT_VERSION_CONFLICT` |
| 创建时目标已存在（`expectedVersion=null`） | `CONFLICT` |
| 版本无法读取（EPERM/EACCES/EBUSY） | `FAILED / ERR_PERMISSION_DENIED` 或 `ERR_STORAGE_IO`（不覆盖） |
| 内容不是合法 UTF-8（GBK/Latin-1…） | `FAILED / ERR_ENCODING_UNSUPPORTED`（`read` 抛错），字节不变 |
| 内容是二进制（NUL/签名/控制字节） | `FAILED / ERR_RESOURCE_NOT_TEXT`（`read` 抛错），字节不变 |
| 写入目标已是非文本 | `FAILED`（同上错误码），不覆盖、不产生临时文件残留 |
| 写入内容含未配对代理项 | `FAILED / ERR_ENCODING_UNSUPPORTED`，磁盘不变 |
| **边界漂移 + 版本冲突同时成立**（F06） | 优先 `FAILED / ERR_PATH_OUTSIDE_ROOT`，不返回普通 `CONFLICT` |
| `stat` 确认存在后目标消失（窗口内被删除） | `exists:false`（一致结果），绝不 `exists:true/contentVersion:null` |
| `stat` 确认存在后目标变为非普通文件（F05） | 抛 `ERR_STORAGE_IO`（不当作不存在） |
| 写盘 IO 失败 | `FAILED / ERR_STORAGE_IO`，临时文件已清理 |
| 已落盘但确认链中断（注入 `afterCommit`） | `UNKNOWN / ERR_OUTCOME_UNKNOWN` |

## 已知限制（未批准，不视为完成）
1. 版本 token 用内容 SHA-256：大文件成本未测量（docs/18 RSK-06，ADR 待定）。
2. 未实现 `watch`（外部变更检测由 document 主动重读模拟）。
3. 原子性仅覆盖「同目录临时文件 + rename」；跨卷/网络盘的保证未验证。
4. **TOCTOU 未完全消除**：边界比对是「重新解析 + 比对」，不是原子锁，也不持有目录句柄。
   检查与随后的 `mkdir`/`writeFile`/`rename` 之间仍有时间窗；攻击者若在该窗口内把路径上的
   某级目录替换为重解析点，落点仍可能被影响——**不承诺任何时刻目标侧绝对零副作用**。
   本轮已把窗口从「每次操作重算边界（且失败回退字面路径）」收紧为「固定边界 + 三处比对」，
   并阻断 `beforeCommit` 注入点上的确定性交错，但彻底消除需要 `openat`/`O_NOFOLLOW` 语义
   （Node 标准 API 未提供），属后续专项。
5. **`stat` 的「存在性/版本一致性」同样是检查而非原子操作**（F01）：`stat()` 与随后的内容
   读取之间目标仍可能变化。实现用「有限次数重试 + 重新 `stat` 核验」把结果收敛到一致状态
   （有效版本 / `exists:false` / `ERR_STORAGE_IO`），但无法覆盖目标持续抖动（反复创建删除）
   的情形；`faults.afterStat` 只是测试注入点，不改变这一事实。
6. **边界漂移后需重建 provider**：根目录被移动/改名或 junction 被改向后，既有 provider
   会持续以 `ERR_PATH_OUTSIDE_ROOT` 拒绝，直到重新创建（这是刻意的 fail closed）。
7. **每次操作多一次边界重建开销**（一次 `realpath` 或祖先回溯），对万级文件遍历的影响未测量。
8. **Windows 8.3 短名**：若路径中出现 `PROGRA~1` 这类短名，可能被判定为「解析结果不一致」
   而拒绝（fail closed，方向安全，但属可用性限制）。
9. **NTFS 备用数据流**（`file.txt:stream`）与文件名中的冒号未做专门拦截，依赖上游
   授权层的规范化；后续需在路径规范中显式拒绝（当前不影响根边界）。
10. 符号链接用例在本机以 `NOT_RUN` 记录（普通用户创建 symlink 需要管理员或开发者模式）；
    junction 用例已真实执行。
11. **`stat` 语义变更的调用方影响**：唯一调用方是 `document.detectExternalChange`。
    安全拒绝、不可读状态与「确认存在后消失」现在都以可识别错误或一致的 `exists:false` 表达，
    不再返回 `changed:false`；正常缺失仍返回 `exists:false`（S4-15 / S4-16 / S4R2-01 / S4R2-09 已覆盖）。
12. **EPERM/EACCES 集成用例未执行**：构造该状态需要修改临时文件 ACL，本轮未获授权，
    以 `NOT_RUN` 记录；分类逻辑由 `mapStorageError` 的单元测试覆盖，`EBUSY` 集成用例已真实执行。
13. **二进制识别是有限启发式**（S5）：只覆盖 NUL、常见控制字节与少量魔数签名。DOCX/PSD/BLEND
    等容器格式若没有命中签名（例如被截断），仍可能被当作“含非法字节的文本”拒绝（方向安全），
    或需要插件层显式声明；不宣称能识别任意二进制。
14. **控制字节可能误伤**：含 ANSI 转义（`0x1B`）等控制字符的文本会被判为非文本而拒绝。
    这是刻意的保守取舍；如确有需要，应在插件层声明编码/转义策略，而不是放宽核心门禁。
15. **编码判定为全量内存操作**：`read` 需要对整个 Buffer 做严格解码与逐字节扫描，
    `writeConditional` 也会整块解码既有目标以判定是否可覆盖；大文件成本未测量。
16. **路径安全拒绝仍会产生空会话**：`document.openSession` 对 `ERR_PATH_OUTSIDE_ROOT` 沿用 S4
    契约（不读入内容、返回空会话），该 P1-8 遗留不在 S5 范围内修改。
    **该 `NOT_RUN` 不能通过删除 `skip` 转为 PASS**——授权后必须补真正的 ACL 断言。
13. **`document.openSession` 仍会吞掉读取失败**（`catch(() => null)` → 空缓冲）。
    经 junction 打开时不会泄漏根外内容（read 已被拒），但会得到一个空会话；
    这是既有缺陷（审计 P1-8），修复需改 `packages/document/`，不在 S4 授权范围内。

## 测试入口
`node tests/run-all.ts`。S4 相关套件：`01-storage-path`、`13-p0-1a`（路径授权一致性）、
`14-s4-path-security`（junction/符号链接）、`15-s4r-root-identity`（根身份固定）、
`16-s4r-stat-semantics`（stat 与版本读取错误语义）。
