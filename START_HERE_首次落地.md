# 织界 WeaveSpace 首次落地指南（Windows / PowerShell）

## 0. 先确认

- Git 已安装：`git --version`；PowerShell 能正常使用 `ssh`。
- 如打算连接 GitHub，先阅读 `docs/13_GitHub双电脑配置.md`，设置 Git 提交身份及 SSH 或 HTTPS 认证。
- 建议暂时选 GitHub **Private**，待明确开源许可、图片授权后再决定公开。
- 选择目录：`D:\Workspace\projects\weavespace`（可自定义，但两台电脑不必同路径）。

## 1. 解压与核查

将本包**内部文件**复制到新目录。PowerShell：

```powershell
cd D:\Workspace\projects\weavespace
python .\tools\check_package.py
```

检查脚本只读，不会修改文件、运行测试服务或访问网络。检查通过代表工程包基本结构完整，**不是业务功能测试 PASS**。

## 2. 本地 Git 初始化

在确认目录尚无 `.git` 后执行：

```powershell
cd D:\Workspace\projects\weavespace
git init -b main
git status
git add .
git diff --cached --stat
git commit -m "docs: WeaveSpace F0 architecture proposal v0.1"
```

`git add .` 只适用于首次创建且已核对 `.gitignore` 的**新空工程目录**。若复制了私人项目数据，必须先检查 staged 文件后再提交。

## 3. GitHub 新建空私有仓库

在 GitHub 网页中新建 `weavespace`，**不要勾选自动创建 README / .gitignore / license**（本包已有）。把网页提供的 SSH URL 填入命令：

```powershell
git remote add origin git@github.com:YOUR_ACCOUNT/weavespace.git
git remote -v
git push -u origin main
```

`YOUR_ACCOUNT` 替换为自己的 GitHub 用户名；如果使用 HTTPS，改为 `https://github.com/YOUR_ACCOUNT/weavespace.git`。

## 4. 另一台电脑

在另一台电脑单独配置 Git 身份和 SSH 公钥（如选择 SSH），再执行：

```powershell
cd D:\Workspace\projects
git clone git@github.com:YOUR_ACCOUNT/weavespace.git
cd .\weavespace
python .\tools\check_package.py
```

后续：工作前确认本地无未提交冲突，执行 `git pull --ff-only`；工作后检查差异、提交、`git push`。两台电脑**不要同时对同一分支做相互覆盖式提交**；遇到分叉先停止并确认。

## 5. 交给 AI 研发时的首条指令

> 这是独立新项目「织界 WeaveSpace」。先阅读 README、docs/00、02、03、04、12、14、15、17。先执行只读架构审查和 P0 技术探针，不直接实现全部功能，不移植 Work Relay/Local Agent Hub 代码。模块必须独立目录、公开接口、时间戳日志与失败测试；所有未批准决策保持待定。交付小步可验证结果和简洁文本测试记录。未经明确授权，不访问真实私人资产、不上传文件、不开放局域网服务。
