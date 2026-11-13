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
| 写入（内容） | 未配对 UTF-16 代理项 → `ERR_ENCODING_UNSUPPORTED`；**与读取同一套**控制字节/二进制签名规则 → `ERR_RESOURCE_NOT_TEXT`（不得用文本 API 造二进制，F03） |
| 写入（目标） | 目标是已识别的非文本 → `FAILED`（`ERR_RESOURCE_NOT_TEXT` / `ERR_ENCODING_UNSUPPORTED`），不改写字节 |
| 会话打开 | 只有 `ERR_RESOURCE_NOT_FOUND`（真正不存在）才创建空会话；编码/二进制/**路径安全**/权限/IO 失败直接抛出 |

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

## 根目录连续性（S11-A1-G0）

`assertBoundaryStable` 只能证明"现在解析出的规范根与创建时相同"，**根被删除时它会重新
锚定最近可解析祖先，算出相同的 `canonicalRoot`，于是"稳定"判定通过**——根消失因此不可检测，
写链路会把它重建出来（已复现：新建文件会话 + 根被删除 → `COMMITTED` 且根被重建）。

因此增加**根身份令牌**与分阶段检查：

| 概念 | 语义 |
|---|---|
| 令牌 | `dev:ino:birthtimeNs`，全部来自 `statSync(path, { bigint: true })`，只做字符串拼接 |
| INITIALIZABLE | Provider 构造时根不存在（`boundary.verified === false`）：允许**首次**合法写入创建根 |
| ESTABLISHED | 已捕获根身份；根消失/被同名目录替换后**一律拒绝**，绝不重建 |
| 受控初始化 | 首次创建必须由本 Provider **逐级非递归** `mkdir` 完成并当场认领，竞争失败即 fail-closed |
| C0 | 目标路径解析后、版本读取前 |
| C1 | `mkdir` 之前（ESTABLISHED 根失效时必须在此拦截，否则就是重建） |
| C2 | `mkdir` 之后、写临时文件之前（含"目标父目录仍在授权根内"复核） |
| C3 | 最终 `rename` 之前 |
| C4 | `rename` 之后、确认提交结果之前（失败只能报 `UNKNOWN`） |

`INITIALIZABLE` **不等于**"根可以被别人创建"：只要根出现在 Provider 构造之后，就说明它不是
本次受控初始化的产物，`read`/`stat`/`list`/`writeConditional` 一律 `ERR_ROOT_CHANGED`。
因此 `recursive mkdir` 不能用于首次创建——它对"已存在"静默成功，无法区分"我刚建"与
"别人早建"。`claimRootDirectory` 逐级 `mkdirSync`，`EEXIST` 即判定为竞争失败并回滚本次
已创建的空目录。

首次初始化在进程内**串行**（`serializeFirstInit`），并发首写不会各自认领根身份；
初始化失败不会残留"已建立"状态，但**一旦根由本 Provider 创建并认领，后续写入失败也不会
退回 INITIALIZABLE**（否则等于允许重新认领另一个根）。

`read`/`stat`/`list` 同样先做连续性断言：已建立根消失时抛 `ERR_ROOT_CHANGED`，
**不得**伪装成"文件不存在"或"空目录"。

版本读取（`inspectExisting`）是异步的，期间根可能失效：完成后会**再断一次连续性**，
且该判定优先于 `CONFLICT` 返回。

## 失败路径
| 情形 | 返回 |
|---|---|
| 路径逃逸（`..`、绝对/盘符/UNC/设备路径） | `FAILED / ERR_PATH_OUTSIDE_ROOT`（`read`/`stat` 抛错） |
| 路径经过重解析点（junction / 符号链接 / 悬空 junction） | `FAILED / ERR_PATH_OUTSIDE_ROOT`（`read`/`stat` 抛错） |
| 路径或根目录无法确认（EACCES/EPERM/ENAMETOOLONG/解析失败） | `FAILED / ERR_PATH_OUTSIDE_ROOT`（fail closed） |
| **根目录身份漂移**（父级 junction 改写目标） | `FAILED / ERR_PATH_OUTSIDE_ROOT`；`beforeCommit` 注入的交错下两侧均无对象（窗口内竞争见限制 4） |
| **已建立的根目录被删除/移动/被同名目录替换**（G0） | `FAILED / ERR_ROOT_CHANGED`（`read`/`stat`/`list` 抛错，`writeConditional` 返回 `FAILED`）；根不被重建 |
| 根身份无法建立（`ino === 0`、根不是目录，G0） | 构造即拒绝：`ERR_ROOT_IDENTITY_UNSUPPORTED` / `ERR_PATH_OUTSIDE_ROOT` |
| **受控初始化前根已被外部创建**（G0-R1） | `read`/`stat`/`list` 抛 `ERR_ROOT_CHANGED`；`writeConditional` 返回 `FAILED / ERR_ROOT_CHANGED`，不写入、不认领 |
| **版本读取期间根失效**（G0-R1） | `FAILED / ERR_ROOT_CHANGED`（优先于 `CONFLICT`） |
| `rename` 之后根身份发生变化（C4，G0） | `UNKNOWN / ERR_OUTCOME_UNKNOWN`（副作用可能已发生，不得报 `COMMITTED`） |
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
6. **边界漂移后需重建 provider**：根目录被删除/移动/被同名目录替换时返回 `ERR_ROOT_CHANGED`
   （不是 `ERR_RESOURCE_NOT_FOUND`），junction 被改向时返回 `ERR_PATH_OUTSIDE_ROOT`；
   两者都会持续拒绝直到重新创建 provider（刻意的 fail closed，且**不重建根**）。
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
    **该 `NOT_RUN` 不能通过删除 `skip` 转为 PASS**——授权后必须补真正的 ACL 断言。
13. **二进制识别是有限启发式**（S5）：只覆盖 NUL、常见控制字节与少量魔数签名。DOCX/PSD/BLEND
    等容器格式若没有命中签名（例如被截断），仍可能被当作「含非法字节的文本」拒绝（方向安全），
    或需要插件层显式声明；不宣称能识别任意二进制。
14. **控制字节可能误伤**：含 ANSI 转义（`0x1B`）等控制字符的文本会被判为非文本而拒绝。
    这是刻意的保守取舍；如确有需要，应在插件层声明编码/转义策略，而不是放宽核心门禁。
15. **编码判定为全量内存操作**：`read` 需要对整个 Buffer 做严格解码与逐字节扫描，
    `writeConditional` 也会整块解码既有目标以判定是否可覆盖；大文件成本未测量。
16. **根身份令牌不是唯一性证明**（G0）：`dev:ino:birthtimeNs` 只是**检测**手段。
    NTFS/ext4 会复用 inode；加入 `birthtimeNs` 可以区分"同名目录被重建"，但**无法排除**
    卷级回滚/快照恢复导致三者全部复现的极端情形。补偿控制是"校验失败即拒绝 + 草稿永不
    自动落盘 + 首次初始化串行"，而不是"令牌保证唯一"。
17. **令牌依赖文件系统能力**（G0）：`ino === 0`（部分 FAT/exFAT、部分网络 FS）时拒绝建立
    根身份（`ERR_ROOT_IDENTITY_UNSUPPORTED`）；`birthtimeNs === 0` 时令牌退化为 `dev:ino`，
    仍可用但强度下降。**exFAT 移动盘等场景未实测**，属已知兼容性缺口。
18. **C0–C4 之间仍有竞争窗口**（G0）：检查不是原子事务。若根在 C2 与 C3 之间被移走，
    临时文件会随目录一起被移走，**路径型 API 无法再定位并回收它**（无 `openat`/句柄删除语义）。
    已保证的是：不会提交到任何仍被授权的根、不累积、且错误报告为 `ERR_ROOT_CHANGED`；
    被移走目录中可能留下一个 `.ws-tmp-*`，属已知残余。
19. **每次操作多一次 bigint `stat`**（G0）：`read`/`stat`/`list`/写入各检查点都要读根令牌。
    对万级文件遍历与慢盘的 p95 延迟尚未测量。
20. **INITIALIZABLE 不能跟随外部创建的根**（G0-R1）：若项目根由用户/外部程序先创建，
    Provider 不会认领它，会持续以 `ERR_ROOT_CHANGED` 拒绝，直到重新创建 Provider。
    这是刻意的 fail-closed：无法证明该根属于本次受控初始化时不得使用。
21. **受控初始化按"从锚点逐级非递归创建"实现**（G0-R1）：若中间某级在创建瞬间被外部
    同时创建，`EEXIST` 会判定为竞争失败并回滚本次已建的空目录（回滚是 best effort，
    目录非空时保留现场）。跨进程竞争不做重试，直接失败。
16. **文本接口只支持 UTF-8**：GBK/Big5/Latin-1 等编码的文件当前只能被拒绝（只读）。
    支持其他编码需要插件声明 + 受控转码，而不是放宽核心门禁。
17. **写入侧同样拒绝已识别签名**（F03）：以 `GIF8`/`%PDF-`/`PK\x03\x04` 等魔数开头的文本
    无法通过文本接口创建；这类内容应走插件 serializer，而不是当作纯文本保存。

## 测试入口
`node tests/run-all.ts`。S4 相关套件：`01-storage-path`、`13-p0-1a`（路径授权一致性）、
`14-s4-path-security`（junction/符号链接）、`15-s4r-root-identity`（根身份固定）、
`16-s4r-stat-semantics`（stat 与版本读取错误语义）。
