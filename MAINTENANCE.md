# 模板版维护

此目录维护可复用的通用相册代码，`origin` 指向既有 GitHub 仓库。不要在模板中加入个人配置、素材、业务数据或只适用于实际使用版的功能。

本机模板目录为 `D:\projecets\photoAlbum-template`；日常开发使用版位于 `D:\projecets\photoAlbum`。`usage` 远程读取本机使用版，其推送地址已禁用。使用版的默认推送目标由它自己的仓库配置管理。

## 安装与推送保护

```powershell
npm ci
npm run repo:setup -- template
```

新克隆需执行 setup 才能启用推送检查。检查只允许推送到本目录固定的 `origin`，会拦截私人路径和常见凭据格式；仍需人工检查差异，不要用 `--no-verify` 绕过。

## 从使用版挑选通用修改

```powershell
Set-Location D:\projecets\photoAlbum-template
git switch main
git pull --ff-only origin main
git fetch usage main
git switch -c codex/common-fix
git cherry-pick <使用版中的纯通用提交号>
git diff origin/main --name-status
git diff origin/main
npm test
npm run build
git push -u origin codex/common-fix
```

然后在 GitHub 提交 PR，审核后合并到 main。换电脑时，如果尚未配置 `usage`，在本机使用版存在后执行：

```powershell
git remote add usage D:\projecets\photoAlbum
git remote set-url --push usage DISABLED://usage-fetch-only
```

使用版的早期历史经过清理，提交号与模板不同，但后续纯通用提交可继续 cherry-pick。遇到冲突时根据模板结构解决；混合提交须先整理通用部分，不要整体 merge 使用版分支，也不要镜像推送。

真实 `.env`、运行数据库、日志、备份、个人素材、生成清单与文案不纳入代码仓库。项目当前不需要 API 密钥或数据库凭据；可公开的环境配置说明见 `.env.example`。`VITE_*` 会进入浏览器构建产物，不能用于保存秘密。
