# plugins/ — 格式插件

每个子目录是一个**独立插件**：`manifest.json`（契约）+ 入口模块。

```
plugins/
  markdown/   manifest.json + index.ts（解析/序列化）+ client.tsx（客户端入口）+ blocks.ts + viewer.tsx
  plaintext/  manifest.json + client.tsx + viewer.tsx（通用文本回退）
  image-viewer/ manifest.json + index.ts（只读查看器探针）
```

## 边界（S10-A）

- 插件**不得**直接访问文件系统、网络或数据库；读写一律经 Core 的
  `CommandBus → Permission → Document → Storage` 链路（`tests/suites/11-architecture` 与
  `21-s10a-capability` 有静态断言）。
- 插件之间不得互相 import；插件不 import `apps/` 下的任何代码。
- 插件的访问授权**不来自** `requestedPermissions`（那只是声明）；权限只由 Core 判定。

## React 是宿主提供的 peer 依赖

`plugins/*/viewer.tsx` 会 `import type` / `import` `react`，但 **react 只安装在
`apps/shell/node_modules`**。`plugins/` 与 `apps/` 平级，Node/TypeScript 默认从导入方目录
向上查找，永远找不到宿主的副本——这是"插件不能反向依赖宿主代码"的直接后果。

因此由**宿主**声明解析目标，而不是让插件指向宿主路径：

| 场景 | 宿主的声明位置 |
|---|---|
| TypeScript 类型 | `apps/shell/tsconfig.json` 的 `paths`（指向 `@types/react`） |
| Vite 运行时/构建 | `apps/shell/vite.config.ts` 的 `resolve.alias` + `dedupe`（指向真实实现） |
| 开发服务器读文件 | 同一配置的 `server.fs.allow`（允许读仓库根） |

新增使用 React 的插件无需改这些配置；只有引入**另一个** peer 依赖（如 `react-dom/server`）
才需要在宿主侧补一条映射。

## 新增一个查看器插件

1. `plugins/<name>/manifest.json`：`provides: ["file.viewer"]`、`fileExtensions`、`requires`。
2. `plugins/<name>/viewer.tsx`：实现 `ViewerCapability`（`apiVersion` / `extensions` / `render`）。
3. `plugins/<name>/client.tsx`：`createXxxClientModule()` 返回 `{ capabilities: { 'file.viewer': … } }`。
4. 在 Shell 的**组合根** `apps/shell/src/capabilities/registry.ts` 里加入注册（唯一需要改宿主的地方）。

`render` 抛错不会传播到工作台：`renderViewerSafely` + `ViewerBoundary` 把它收敛为局部错误提示，
文档缓冲、dirty 标记与保存链路都不受影响。

## 已知限制

1. **同进程，无沙箱**：插件可访问全局对象；`try/catch` 与错误边界不是隔离。
2. 没有热更新、安装流程与签名校验。
3. 能力解析顺序 = 注册顺序，没有优先级字段；替换实现目前靠 `preferPluginId` 或停用前者。
4. `.tsx` 入口无法被 Node 直接加载，因此 Node 侧测试只覆盖 `manifest`/纯函数/注册表，
   渲染结果由 Chrome 端到端验证（见 `apps/shell/README.md`）。
