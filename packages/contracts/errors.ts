/**
 * 错误码注册表（P0 草案，非冻结契约）。
 * 依据 docs/09「错误分类」整理为机器可读常量，供契约测试与日志复用。
 * 决策状态：待 ADR 冻结（见 docs/18 RSK-01）。
 */
export const ERROR_CODES = {
  ERR_COMMAND_INVALID: 'ERR_COMMAND_INVALID',
  ERR_COMMAND_UNSUPPORTED: 'ERR_COMMAND_UNSUPPORTED',
  ERR_COMMAND_INTERNAL: 'ERR_COMMAND_INTERNAL',
  ERR_PERMISSION_DENIED: 'ERR_PERMISSION_DENIED',
  ERR_RESOURCE_NOT_FOUND: 'ERR_RESOURCE_NOT_FOUND',
  ERR_PATH_OUTSIDE_ROOT: 'ERR_PATH_OUTSIDE_ROOT',
  /**
   * 内容无法按 UTF-8 无损解码（非法字节序列）。
   * 文本接口不得替换后返回，否则保存会把原始字节永久破坏（S5-01）。
   */
  ERR_ENCODING_UNSUPPORTED: 'ERR_ENCODING_UNSUPPORTED',
  /**
   * 内容是已识别的非文本（含 NUL/不安全控制字节/已知二进制签名）。
   * 文本接口必须拒绝，不得把它当普通文本打开或覆盖（S5-02）。
   */
  ERR_RESOURCE_NOT_TEXT: 'ERR_RESOURCE_NOT_TEXT',
  /**
   * 同一 resourceId 命中已有会话，但 Provider 身份或规范路径不一致（S8-01）。
   * 不得静默复用；本轮不提供隐式重绑定。
   */
  ERR_RESOURCE_IDENTITY_CONFLICT: 'ERR_RESOURCE_IDENTITY_CONFLICT',
  /**
   * 目录在当前时刻**读不出来**（`EPERM` / `EACCES` / `EBUSY` / `EIO` 等）。
   *
   * 与 `ERR_PERMISSION_DENIED` 严格区分（UX-02B-TREE / 契约 B.6）：
   * - 本码是"环境事实"——磁盘不让读这个目录，与 WeaveSpace 的授权状态无关；
   * - `ERR_PERMISSION_DENIED` 是"策略事实"——WeaveSpace 的授权判定拒绝。
   *
   * 两者都映射 403，但**不得**互相替代：把前者说成"权限不足"会诱导用户去重新授权一个
   * 其实已授权的项目；把后者说成"读不出来"则会掩盖一次真实的越权尝试。
   */
  ERR_DIR_UNREADABLE: 'ERR_DIR_UNREADABLE',
  /**
   * 请求展开的路径本身是符号链接 / junction / 其他重解析点。
   *
   * 链接只作为 `kind: 'link'` 叶子**显示**，不展开、不读取（契约 B.5）：
   * 跟随它可能越过项目根，而项目根是唯一授权单元。
   */
  ERR_DIR_IS_LINK: 'ERR_DIR_IS_LINK',
  /**
   * 目录在这一轮**分页期间**发生了变化（UX-02B-TREE-R1）。
   *
   * 数字偏移游标只保证"位置"，不保证两页看到的是同一份条目集合：第一页之后
   * 插入/删除/重命名都可能让第二页静默漏项。客户端必须把首轮的
   * 目录快照标识原样回传；服务端一旦发现集合变化，用本码 + 409 要求刷新整层，
   * 绝不返回可能不完整的结果。它不是授权失败，也不是路径越界。
   */
  ERR_DIR_CHANGED: 'ERR_DIR_CHANGED',
  ERR_DOCUMENT_NOT_FOUND: 'ERR_DOCUMENT_NOT_FOUND',
  ERR_DOCUMENT_DIRTY: 'ERR_DOCUMENT_DIRTY',
  ERR_DOCUMENT_VERSION_CONFLICT: 'ERR_DOCUMENT_VERSION_CONFLICT',
  ERR_SAVE_FAILED: 'ERR_SAVE_FAILED',
  ERR_OUTCOME_UNKNOWN: 'ERR_OUTCOME_UNKNOWN',
  ERR_STORAGE_IO: 'ERR_STORAGE_IO',
  /**
   * 已建立的根目录身份发生变化：根消失、被移动，或被同名目录替换（G0）。
   * 这是「项目根不可用」，不得映射为文件不存在或版本冲突，也不得据此重建根。
   */
  ERR_ROOT_CHANGED: 'ERR_ROOT_CHANGED',
  /**
   * 文件系统未提供可用的根身份（如 `ino === 0`），无法建立连续性校验（G0）。
   * 必须 fail-closed 拒绝，而不是退化为仅按路径比较。
   */
  ERR_ROOT_IDENTITY_UNSUPPORTED: 'ERR_ROOT_IDENTITY_UNSUPPORTED',
  /**
   * 多项目（G1）：请求未声明 `projectId`。
   * Multi 模式不得回落默认项目，否则等于隐式选择磁盘根。
   */
  ERR_PROJECT_REQUIRED: 'ERR_PROJECT_REQUIRED',
  /** 多项目（G1）：`projectId` 不在可信配置中。 */
  ERR_PROJECT_NOT_FOUND: 'ERR_PROJECT_NOT_FOUND',
  /** 多项目（G1）：项目存在但当前不可用（根缺失/被替换/不可读等）。 */
  ERR_PROJECT_UNAVAILABLE: 'ERR_PROJECT_UNAVAILABLE',
  /** 多项目（G1）：工作区配置本身非法（版本/字段/路径形态）。 */
  ERR_PROJECT_CONFIG_INVALID: 'ERR_PROJECT_CONFIG_INVALID',
  /** 多项目（G1）：两个项目指向同一根目录（含 Windows 大小写等价）。 */
  ERR_PROJECT_DUPLICATE_ROOT: 'ERR_PROJECT_DUPLICATE_ROOT',
  /** 多项目（G1）：项目根互相嵌套。 */
  ERR_PROJECT_NESTED_ROOT: 'ERR_PROJECT_NESTED_ROOT',
  /**
   * 多项目（UX-02B）：该项目正处在移除屏障内（QUIESCING/REMOVING），
   * 期间所有 G-DISK 操作一律拒绝，防止把新的字节写进一个正在撤销的项目。
   */
  ERR_PROJECT_QUIESCING: 'ERR_PROJECT_QUIESCING',
  /**
   * 多项目（UX-02B）：项目级互斥未获取，或移除前置条件不满足
   * （仍有活动 View / dirty / SAVING / OUTCOME_UNKNOWN / CONFLICT / FAILED / 在途磁盘操作）。
   */
  ERR_PROJECT_BUSY: 'ERR_PROJECT_BUSY',
  /**
   * 多项目（UX-02B-01-R1）：撤销提交点**明确未写入**（打开失败 / 写入 0 字节即报错）。
   * 零变更、可安全重试；不得据此断言"撤销失败等于什么都没发生"以外的任何结论。
   */
  ERR_PERSIST_FAILED: 'ERR_PERSIST_FAILED',
  /**
   * 多项目（UX-02B-01-R1）：撤销提交点的写入结果**不确定**（fsync 报错 / 部分写入 / 崩溃边缘）。
   * 该项立即进入 `REVOKE_UNKNOWN`：G-DISK 一律 403，G-DRAFT 与关闭视图不受影响。
   */
  ERR_PROJECT_REVOKE_UNKNOWN: 'ERR_PROJECT_REVOKE_UNKNOWN',
  /**
   * 多项目（UX-02B-02）：工作区存储目录已被另一个实例持有（`workspace.lock`）。
   * 不得并行写同一份配置；第二个实例必须拒绝启动托管模式。
   */
  ERR_STORE_LOCKED: 'ERR_STORE_LOCKED',
  /**
   * 多项目（UX-02B-02）：存储处于受限状态（`RECOVERY_RESTRICTED` / `DEGRADED`），
   * 变更一律拒绝；G-DISK 是否可用由 `diskTrusted` 单独决定。
   */
  ERR_STORE_RESTRICTED: 'ERR_STORE_RESTRICTED',
  /**
   * 多项目（UX-02B-02）：`projectId` 已签发过（含已撤销）。id 永不复用，
   * 调用方必须重新签发而不是复用旧标识。
   */
  ERR_STORE_ID_REUSED: 'ERR_STORE_ID_REUSED',
  /**
   * 多项目（UX-02B-04B-R1）：变更编号 `opId` 已被**另一个事件**占用。
   *
   * `opId` 是事务的唯一身份，不是可复用的关联字段：同一个 `opId` 既不能撤销
   * 两个项目，也不能在已有持久证据（添加/撤销）之后再提交一次撤销。拒绝时
   * 零变更——不写第二条墓碑，也不会让 A 的证据被 B 认领。
   */
  ERR_OP_ID_CONFLICT: 'ERR_OP_ID_CONFLICT',
  /**
   * 多项目（G1）：会话已失效（所属项目根不可用），磁盘访问被拒绝。
   * 草稿仍保留，可经授权读取；不得自动迁移或丢弃。
   */
  ERR_SESSION_STALE: 'ERR_SESSION_STALE',
  /**
   * 托管模式（UX-02B-03）：本机目录选择器不可用（无 GUI / 被策略拦截 / 超时 / 找不到
   * PowerShell）。**绝不**退化成"让网页输入路径"，只能改用静态模式或重试。
   */
  ERR_PICKER_UNAVAILABLE: 'ERR_PICKER_UNAVAILABLE',
  /** 已有一次目录选择在进行中（选择器单飞）：同一时刻只允许一个系统对话框。 */
  ERR_PICKER_BUSY: 'ERR_PICKER_BUSY',
  /** 变更意图 `intentId` 已过期（默认 120s），需要重新申请。 */
  ERR_INTENT_EXPIRED: 'ERR_INTENT_EXPIRED',
  /** 变更意图 `intentId` 已被消费过：一次性，禁止重放。 */
  ERR_INTENT_CONSUMED: 'ERR_INTENT_CONSUMED',
  /** 变更意图不存在或不属于当前 actor（不区分两者，避免探测）。 */
  ERR_INTENT_INVALID: 'ERR_INTENT_INVALID',
  /** 目录选择请求的 `requestId` 已不存在（Host 重启 / 记录过期）。 */
  ERR_PICK_REQUEST_GONE: 'ERR_PICK_REQUEST_GONE',
  ERR_PLUGIN_INVALID_MANIFEST: 'ERR_PLUGIN_INVALID_MANIFEST',
  ERR_PLUGIN_DUPLICATE_ID: 'ERR_PLUGIN_DUPLICATE_ID',
  ERR_PLUGIN_NOT_REGISTERED: 'ERR_PLUGIN_NOT_REGISTERED',
  ERR_PLUGIN_INCOMPATIBLE: 'ERR_PLUGIN_INCOMPATIBLE',
  ERR_PLUGIN_CRASHED: 'ERR_PLUGIN_CRASHED',
  ERR_PLUGIN_DEACTIVATE_BLOCKED: 'ERR_PLUGIN_DEACTIVATE_BLOCKED',
  /** 插件声明的能力契约版本与宿主不兼容（S10-A）。 */
  ERR_CAPABILITY_INCOMPATIBLE: 'ERR_CAPABILITY_INCOMPATIBLE',
  /** 宿主请求的能力没有任何已激活的提供者（S10-A）。 */
  ERR_CAPABILITY_MISSING: 'ERR_CAPABILITY_MISSING',
  /** 插件 `requires` 中的依赖未注册或未激活（S10-A）。 */
  ERR_PLUGIN_DEPENDENCY_MISSING: 'ERR_PLUGIN_DEPENDENCY_MISSING',
  /**
   * 新建条目（UX-02C-01）：单段名称不合法（非法字符、保留设备名、尾随空格/句点、
   * 绝对路径形态等）。必须在**任何磁盘访问之前**判完，输入框随即保留原值供修正。
   */
  ERR_ENTRY_NAME_INVALID: 'ERR_ENTRY_NAME_INVALID',
  /**
   * 新建条目：目标位置已经有同名文件或目录。
   *
   * 创建是排他语义（`wx` / 非递归 `mkdir`），因此本码代表"零变更、绝不覆盖"，
   * 不表示"发现了同名文件 = 本次操作成功"。
   */
  ERR_ENTRY_EXISTS: 'ERR_ENTRY_EXISTS',
  /**
   * 新建条目：父目录不存在、不是普通目录，或是不可信的重解析点。
   * 绝不静默递归创建缺失父目录。
   */
  ERR_ENTRY_PARENT_INVALID: 'ERR_ENTRY_PARENT_INVALID',
  /**
   * 结构变更（UX-02C-02）：源路径 / 目标路径下仍有活动编辑 View、未保存草稿，
   * 或处于 SAVING / OUTCOME_UNKNOWN / CONFLICT 等危险会话；也可能是结构变更屏障
   * 正忙（在途磁盘操作未排空）。零磁盘副作用。
   */
  ERR_STRUCTURE_SESSION_BUSY: 'ERR_STRUCTURE_SESSION_BUSY',
  /** 结构变更：把目录移动到自身或自己的后代目录，或目标父链经过不可信链接。 */
  ERR_MOVE_INTO_DESCENDANT: 'ERR_MOVE_INTO_DESCENDANT',
  /** 结构变更：跨卷 / 跨设备移动（EXDEV），首版不提供复制+删除的部分成功链路。 */
  ERR_MOVE_CROSS_VOLUME: 'ERR_MOVE_CROSS_VOLUME',
  /** 结构变更：Windows 上目录被占用（EPERM/EBUSY），无法改名或移动。 */
  ERR_ENTRY_DIR_BUSY: 'ERR_ENTRY_DIR_BUSY',
  /** 结构变更：源不存在、不是普通文件/目录、或是链接 / 重解析点。 */
  ERR_ENTRY_SOURCE_INVALID: 'ERR_ENTRY_SOURCE_INVALID',
  /**
   * 请求路径落在工作台**内部保留命名空间**（项目根下的 `.weavespace/`）。
   *
   * 该目录归 Host 自己使用（回收区）。它必须对普通接口**不可见也不可达**：
   * - 展示层：`readDir` / `list` 在根层过滤，文件树与递归清单都看不到；
   * - 访问层：open / create / rename / move / hide / tree(dir) / resources 一律拒绝。
   *
   * 不能靠"路径不在授权范围内"间接拒绝——那会让"放宽普通路径授权"成为打开
   * 内部目录的旁路（UX-02C-03-P2-01 约束 4）。
   */
  ERR_PATH_RESERVED: 'ERR_PATH_RESERVED',
  /**
   * 回收区只接受"普通文件 + 可用 Number 精确表示的长度"（UX-02C-03-P2-01；
   * UX-02C-03-P2-01-R2-Supplement-R1 起补上长度维度）。
   *
   * 目录 / 符号链接 / junction / 其他重解析点一律拒绝：本阶段不做目录递归回收，
   * 也绝不跟随链接（否则删除的可能是链接指向的根外对象）。
   * 长度超出安全整数范围时同样拒绝：那样的记录注定无法通过恢复时的三方核对。
   * 两种情况都是零磁盘副作用。
   */
  ERR_TRASH_KIND_UNSUPPORTED: 'ERR_TRASH_KIND_UNSUPPORTED',
  /** 回收区不可用：内部目录被用户占用/是链接/标记不符，或无权写入。 */
  ERR_TRASH_UNAVAILABLE: 'ERR_TRASH_UNAVAILABLE',
  /** 回收区已达容量上限（未解决记录数），必须先恢复，不静默丢弃旧记录。 */
  ERR_TRASH_FULL: 'ERR_TRASH_FULL',
  /** 该 opId 没有回收记录（或已不属于当前项目）。 */
  ERR_TRASH_RECORD_NOT_FOUND: 'ERR_TRASH_RECORD_NOT_FOUND',
  /** 记录状态不允许该操作，或对象身份与记录不符（conflicted / missing / 已被外部替换）。 */
  ERR_TRASH_STATE_CONFLICT: 'ERR_TRASH_STATE_CONFLICT',
  /**
   * 意图中记录的对象身份与磁盘上实际对象不一致：用户要删的那一个已经不是
   * 现在路径上的这一个（外部删除/重建）。拒绝移动，绝不"删掉占着路径的陌生人"。
   */
  ERR_ENTRY_SOURCE_CHANGED: 'ERR_ENTRY_SOURCE_CHANGED',
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ALL_ERROR_CODES: readonly ErrorCode[] = Object.freeze(
  Object.keys(ERROR_CODES) as ErrorCode[],
);
