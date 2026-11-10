# 织界 WeaveSpace — F0 完整工程启动包 v0.2

> **名称：织界（WeaveSpace） · 仓库：`weavespace` · 状态：F0 架构提案 / 待正式审查与签收；尚未编写、编译或验证业务系统。** 生成日：2026-11-10（Asia/Taipei）。
> **产品定位**：本地优先、文件驱动、模块化插件、分屏工作台、AI 可操作，未来支持局域网和远程存储。

**GitHub 仓库描述建议：** WeaveSpace — A modular, AI-ready workspace for exploring, editing, visualizing, and connecting files across projects. Extensible through plugins, with local-first design and remote collaboration.

## 首次落地从这里开始

1. 阅读 [`START_HERE_首次落地.md`](START_HERE_首次落地.md) 和 [`docs/00_基线状态与裁决.md`](docs/00_基线状态与裁决.md)。
2. 打开 `diagrams/01_系统全景.png` 和 `diagrams/05_工程路线.png` 看架构和阶段路径。
3. 在自己的 Windows 电脑建立空目录 `D:\Workspace\projects\weavespace`，把**本工程包文件夹内**所有文件复制进去（**不是**把 zip 文件整体当作 Git 源代码提交）。
4. 阅读 `docs/13_GitHub双电脑配置.md`，先本地 Git 初始化，再建立 GitHub **空私有仓库**并添加 `origin`。不要混入 Work Relay 或 Local Agent Hub 的代码。
5. 先执行 F0 架构审查与 P0 验证；目前不应视为可运行产品。

## 目录导航（每份资料仅负责一种问题）

| 文档 | 解决的问题 |
|---|---|
| [`docs/00_基线状态与裁决.md`](docs/00_基线状态与裁决.md) | 哪些已形成共识、哪些只是候选、哪些尚未决定？ |
| [`docs/01_产品范围与场景.md`](docs/01_产品范围与场景.md) | 第一版做什么，不做什么？ |
| [`docs/02_总体架构.md`](docs/02_总体架构.md) | 层次、方向、信任边界和完整数据流是什么？ |
| [`docs/03_模块职责与接口清单.md`](docs/03_模块职责与接口清单.md) | 各模块由谁负责，如何调用？ |
| [`docs/04_核心数据契约.md`](docs/04_核心数据契约.md) | Resource、Document、Command、Event 的不变量是什么？ |
| [`docs/05_插件SDK与生命周期.md`](docs/05_插件SDK与生命周期.md) | 如何添加一种格式或一种能力而不改 Core？ |
| [`docs/06_文件编辑保存与恢复.md`](docs/06_文件编辑保存与恢复.md) | 如何处理分屏、并发、冲突、崩溃、写入？ |
| [`docs/07_AI上下文与外部控制.md`](docs/07_AI上下文与外部控制.md) | 如何让内置及外部 AI 安全操作局部 / 单文件 / 全项目？ |
| [`docs/08_存储网络与权限.md`](docs/08_存储网络与权限.md) | GitHub、云盘、LAN 与 ACL 如何预留？ |
| [`docs/09_日志监控诊断规范.md`](docs/09_日志监控诊断规范.md) | 如何用时间戳、日志、Trace、故障现场排障？ |
| [`docs/10_工作区UI与分屏.md`](docs/10_工作区UI与分屏.md) | 用户草图、布局管理、视图插槽如何设计？ |
| [`docs/11_工程阶段时间线.md`](docs/11_工程阶段时间线.md) | 按什么依赖顺序研发、何时验收？ |
| [`docs/12_工程硬约束与验收.md`](docs/12_工程硬约束与验收.md) | 不可破坏的工程约束和验收门槛？ |
| [`docs/13_GitHub双电脑配置.md`](docs/13_GitHub双电脑配置.md) | Git 身份、SSH、初始化和切换设备？ |
| [`docs/14_测试策略与故障注入.md`](docs/14_测试策略与故障注入.md) | 如何证明核心边界有效？ |
| [`docs/15_架构审查与剩余风险.md`](docs/15_架构审查与剩余风险.md) | 有哪些遗漏、重复建设与未验证假设？ |
| [`docs/16_决策记录_ADR.md`](docs/16_决策记录_ADR.md) | 哪些决策可以追溯、改变时如何管理？ |
| [`docs/17_首轮开发任务交接.md`](docs/17_首轮开发任务交接.md) | 交给 DSH / WorkBuddy / GPT 开始研发的任务单 |

## 配套物料

- `diagrams/*.dot`：完整可编辑架构图 Graphviz 源码；`*.svg`、`*.png` 为可直接查看的导出。
- `references/user-ui-wireframe.png`：用户提供的原始 UI 草图，仅供设计参考（是否上传公开仓库由用户决定）。
- `contracts/schemas/*.json`：**提案级**的 JSON Schema，不是运行时 SDK 的最终承诺。
- `examples/*.json`：示意数据；无真实密钥或项目文件。
- `tools/check_package.py`：仅使用 Python 标准库的文件、JSON 与参考检查脚本。
- `.gitignore` / `.editorconfig` / `.gitattributes`：跨设备基础文件配置。

## 重要说明

1. 本工程包是**架构启动资料**，不是已经实现的完整软件。`P0` 原型验收前不得声称数据安全与隔离能力已经实现。
2. 文件格式、接口名、扩展名（如 `.wcanvas`）属于候选。冻结前需做技术探针和冲突检查。
3. 不默认授权 AI 或插件读取整个硬盘；不默认开启 LAN；不默认向任何外部模型上传原文件。
4. 对已有 Work Relay / Local Agent Hub 项目无修改、无合并或代码依赖。
5. 工程包不包含商业许可文本；公开仓库前需单独确定开源许可及所含参考图的再发布许可。
