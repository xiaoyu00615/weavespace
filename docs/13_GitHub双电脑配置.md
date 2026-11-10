# 两台 Windows 电脑共用 GitHub：身份、SSH、提交和切换

## 几个直接答案

- **一个 GitHub 账号可以在两台电脑上使用**，且通常更适合统一个人开发；GitHub 账号不是按设备分配。
- Git 本地提交身份需要 `user.name` 与 `user.email`，通常**不需要手机号**；手机号/2FA 属于 GitHub 账号安全问题而非 Git 提交身份。
- GitHub 私有邮箱设置可用 `noreply` 提交地址，具体地址到 GitHub **Settings → Emails** 查看；`user.name` 不一定等于 GitHub 登录名。
- **SSH 每台电脑建议独立密钥对**，只上传各自公钥到同一 GitHub 账号；绝不提交私钥或互相复制私钥。
- GitHub 也支持 HTTPS + Credential Manager，若不想管理 SSH 可以选 HTTPS。

官方参考：
- https://docs.github.com/en/get-started/git-basics/set-up-git
- https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address
- https://docs.github.com/en/authentication/connecting-to-github-with-ssh/generating-a-new-ssh-key-and-adding-it-to-the-ssh-agent
- https://docs.github.com/en/authentication/connecting-to-github-with-ssh/adding-a-new-ssh-key-to-your-github-account
- https://docs.github.com/en/authentication/connecting-to-github-with-ssh/testing-your-ssh-connection

## 两台机器分别运行一次（PowerShell）

```powershell
git --version
git config --global user.name "你的提交显示名称"
git config --global user.email "你的GitHub提交邮箱或noreply地址"
git config --global init.defaultBranch main
git config --global user.name
git config --global user.email
Get-ChildItem "$env:USERPROFILE\.ssh" -ErrorAction SilentlyContinue
```

**已有密钥**：先确认 SSH 密钥属于本人，仍可使用，不要不经检查就覆盖。**没有密钥**：

```powershell
ssh-keygen -t ed25519 -C "weavespace-home" -f "$env:USERPROFILE\.ssh\id_ed25519_weavespace_home"
```

若换在电脑 B，请修改密钥文件名与注释，例如 `id_ed25519_weavespace_day`；密钥可设 passphrase。建立后按本机环境启用 `ssh-agent` 并添加对应私钥，例如：

```powershell
ssh-add "$env:USERPROFILE\.ssh\id_ed25519_weavespace_home"
Get-Content "$env:USERPROFILE\.ssh\id_ed25519_weavespace_home.pub"
```

如果 `ssh-add` 提示无法连接 agent，先配置 Windows 的 OpenSSH Authentication Agent 服务（可能需要管理员权限），或依照 Git for Windows/Git Bash 的 ssh-agent 指引操作。使用自定义密钥文件名时，可能还需在**各自电脑的** `~/.ssh/config` 配置：

```text
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_weavespace_home
  IdentitiesOnly yes
```

这份配置仅适用于个人 GitHub 账号且没有与现有 SSH Host 冲突的情形；不要无检查覆盖已有 `config`。分别复制 `.pub` 内容，网页 GitHub → Settings → SSH and GPG keys → New SSH key，给钥匙命名 “WeaveSpace-Home” / “WeaveSpace-Day”。测试：

```powershell
ssh -T git@github.com
```

首次连接仔细核对官方 GitHub 主机指纹，连接成功消息包含账号名。`ssh -T` 无 Shell 权限是正常的。

## 初建仓库

在自己的电脑把工程包复制进全新目录后：

```powershell
cd D:\Workspace\projects\weavespace
python .\tools\check_package.py
git init -b main
git status
git add .
git diff --cached --stat
git commit -m "docs: initial F0 architecture proposal"
```

Github 网页建立 **空的 Private 仓库** `weavespace`，不要网页自动创建 README/.gitignore/License；之后：

```powershell
git remote add origin git@github.com:YOUR_ACCOUNT/weavespace.git
git remote -v
git push -u origin main
```

若你选择 HTTPS，则 remote 地址改为 `https://github.com/YOUR_ACCOUNT/weavespace.git`，使用 Git Credential Manager / GitHub CLI 认证即可，不必 SSH。

## 晚间/日间换设备的最小步骤

**电脑 B 第一次**：`git clone git@github.com:YOUR_ACCOUNT/weavespace.git`。

**开始工作前**：

```powershell
git status
git branch --show-current
git pull --ff-only
```

**结束工作前**：

```powershell
git status
git diff
git add <你确认需要提交的文件>
git diff --cached
git commit -m "feat: 描述本次改动"
git push
```

注意：`git add <...>` 是占位写法，不要照字面运行；使用具体路径。已有工作区修改或分支分叉时不要强行 `pull --rebase`、`reset --hard` 或 force push；先检查原因。

## 日常开发注意

- 同一账号 ≠ 同一台电脑的 Git 配置、Node 依赖、DSH 聊天会话或 AI API 缓存自动同步。
- 同步源代码、文档、合适的便携配置；**不提交** `.env`、密钥、运行日志、缓存、SQLite 运行库、未获授权的原始影视资产。
- 使用小分支 `feat/<topic>` / `fix/<topic>`，验收后合入 `main`；不要让未通过测试的实现直接覆盖主线。
- 项目交接使用 `docs/17_首轮开发任务交接.md` 或后续精简状态文件，而非上传巨型聊天上下文。
- 临时跨电脑继续工作前必须 commit/push；未提交文件不会自动出现另一台电脑上。
