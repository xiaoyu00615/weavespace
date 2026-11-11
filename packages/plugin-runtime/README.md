# plugin-runtime（P0 探针）

## 职责
插件清单校验与生命周期管理：注册、激活、停用、故障隔离、诊断状态查询。

## 公开接口（`index.ts`）
- `createPluginRuntime({ logger?, clock?, hasDirtyState? })` → `PluginRuntime`
- `register(manifest, module?)` / `activate(id)` / `deactivate(id, {force?})` / `status(id)` / `list()`
- `candidatesForExtension('.md')` → 候选处理插件（同一扩展名可以有多个）
- `validateManifest(manifest)` / `isApiVersionSupported(v)`

## 生命周期与失败状态
`DISCOVERED → VALIDATED → REGISTERED → ACTIVATING → ACTIVE → DEACTIVATING → INACTIVE`，
失败为 `BLOCKED_DEPENDENCY`（apiVersion 不支持）、`QUARANTINED`（激活抛错）、`FAILED`（停用抛错）。

| 情形 | 结果 |
|---|---|
| 清单非法 | `ERR_PLUGIN_INVALID_MANIFEST` + violations |
| 重复 id | `ERR_PLUGIN_DUPLICATE_ID` |
| apiVersion 不支持 | `BLOCKED_DEPENDENCY / ERR_PLUGIN_INCOMPATIBLE` |
| 激活抛错 | `QUARANTINED / ERR_PLUGIN_CRASHED`，Core 与其他插件不受影响 |
| 存在 dirty 时停用 | `ERR_PLUGIN_DEACTIVATE_BLOCKED`，插件保持 ACTIVE |

## 已知限制（必须如实标注，禁止标 VERIFIED）
1. **同进程执行，无沙箱、无资源限额、无超时终止**。`try/catch` 不是隔离（docs/02「容错限制」）。
2. Cordis **未做探针**：本实现不构成对 ADR-009 的选择或否决。
3. 依赖解析仅记录 `requires`，未做传递依赖与版本区间求解。
4. 未实现 UI Slot、热重载、升级迁移。
5. `requestedPermissions` 仅记录；真正授权在 permission 模块。

## 测试入口
`node tests/run-all.ts`（套件 `plugin-lifecycle`、`plugin-crash`、`architecture-boundary`）。
