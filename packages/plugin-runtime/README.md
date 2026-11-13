# plugin-runtime（P0 探针）

## 职责
插件清单校验与生命周期管理：注册、激活、停用、故障隔离、诊断状态查询。

## 公开接口（`index.ts`）
- `createPluginRuntime({ logger?, clock?, hasDirtyState? })` → `PluginRuntime`
- `register(manifest, module?)` / `activate(id)` / `deactivate(id, {force?})` / `status(id)` / `list()`
- `candidatesForExtension('.md')` → 候选处理插件（同一扩展名可以有多个）
- `validateManifest(manifest)` / `isApiVersionSupported(v)`

### 能力维度（S10-A）
- `providersOf(capability)` → 该能力的**已激活**提供者（按注册顺序）
- `capabilities()` → `[{ capability, providers, active }]`，用于诊断面板
- `resolveCapability(name, { extension?, preferPluginId? })` → `{ ok, provider, value }` 或
  `{ ok:false, errorCode:'ERR_CAPABILITY_MISSING', reason }`（不抛）
- `requireCapability(name, …)` → 同上，但缺失时抛错，供依赖方**拒绝启动**
- 能力名可带主版本后缀：`file.viewer@1`；缺省即宿主主版本（`CAPABILITY_API_MAJOR = 1`）
- 插件把实现放在 `PluginModule.capabilities`（能力名 → 实现），只有 `provides` 声明过的能力会被解析

## 生命周期与失败状态
`DISCOVERED → VALIDATED → REGISTERED → ACTIVATING → ACTIVE → DEACTIVATING → INACTIVE`，
失败为 `BLOCKED_DEPENDENCY`（apiVersion 不支持 / 依赖缺失）、`QUARANTINED`（激活抛错）、`FAILED`（停用抛错）。

**生命周期串行化（S10-A-R2）**：每个插件一条串行链，同一插件的 `activate`/`deactivate`
不会交叉——并发的第二次 `activate` 排到第一次之后，看到 `ACTIVE` 直接返回，钩子只执行一次；
仍在 `ACTIVATING` 时发来的 `deactivate` 会等初始化结束再按真实状态处理。
链按 `pluginId` 分开，**没有全局锁**，不同插件互不阻塞。

| 情形 | 结果 |
|---|---|
| 清单非法 | `ERR_PLUGIN_INVALID_MANIFEST` + violations |
| 重复 id | `ERR_PLUGIN_DUPLICATE_ID` |
| apiVersion 不支持 | `BLOCKED_DEPENDENCY / ERR_PLUGIN_INCOMPATIBLE` |
| 能力版本不兼容（如 `file.viewer@9`） | 注册即拒绝：`ERR_CAPABILITY_INCOMPATIBLE` |
| `requires` 缺失（非 Core 模块） | `BLOCKED_DEPENDENCY / ERR_PLUGIN_DEPENDENCY_MISSING`，**不调用 activate** |
| 能力无人提供 | `resolveCapability` → `ERR_CAPABILITY_MISSING`；`requireCapability` 抛同名错误 |
| 激活抛错 | `QUARANTINED / ERR_PLUGIN_CRASHED`，Core 与其他插件不受影响 |
| 存在 dirty 时停用 | `ERR_PLUGIN_DEACTIVATE_BLOCKED`，插件保持 ACTIVE |

## 已知限制（必须如实标注，禁止标 VERIFIED）
1. **同进程执行，无沙箱、无资源限额、无超时终止**。`try/catch` 不是隔离（docs/02「容错限制」）。
2. Cordis **未做探针**：本实现不构成对 ADR-009 的选择或否决。
3. 依赖只做**一层**校验：`requires` 命中 Core 可信模块（`DEFAULT_CORE_DEPENDENCIES`）或已激活插件即可，
   未做传递依赖与版本区间求解；也不会因为依赖被停用而级联停用下游插件。
   能力**不要求唯一**：同一能力可以有多个提供者（docs/05「扩展名不是独占」），
   解析顺序 = 注册顺序，可用 `preferPluginId` 指定首选。
4. 未实现 UI Slot、热重载、升级迁移。
5. `requestedPermissions` 仅记录；真正授权在 permission 模块。
6. **本模块不 import Node 内建模块**（时间/计时在本地实现），因此 Core 与浏览器宿主可共用同一注册表；
   但沙箱能力仍不存在——同进程、无资源限额。

## 测试入口
`node tests/run-all.ts`（套件 `plugin-lifecycle`、`plugin-crash`、`architecture-boundary`、`s10a-capability`）。
