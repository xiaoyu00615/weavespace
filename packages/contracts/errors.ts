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
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ALL_ERROR_CODES: readonly ErrorCode[] = Object.freeze(
  Object.keys(ERROR_CODES) as ErrorCode[],
);
