# Elysian

**Agent 辅助的单机运维工作台。**

把容器、数据库、网站、文件与安全配置收进一个面板，内置 Ely 智能体辅助排障与执行。后端为 Go 单二进制（内嵌 Web 前端与 CLI），生产部署为 Ubuntu/Debian 上的 systemd 服务；容器、数据库与网站功能直连宿主 Docker Engine。

> 状态：活跃开发中（0.x）。接口、数据格式和部署脚本可能调整，升级前请备份面板数据目录。

## 安装

要求 Ubuntu/Debian + systemd、Linux amd64/arm64、root 权限与可访问 apt 和所选分发平台的网络。服务器无需安装 Go、Bun 或任何编译工具链，2 GiB 内存即可。

### 国内服务器：Gitee

```bash
curl --proto '=https' --proto-redir '=https' -fSL \
  https://gitee.com/Chentyit/Elysian/raw/main/scripts/install-release.sh -o install-release.sh
sudo env ELYSIAN_RELEASE_SOURCE=gitee bash install-release.sh
```

### 国外服务器：GitHub

```bash
curl --proto '=https' --proto-redir '=https' -fSL \
  https://raw.githubusercontent.com/Tianyi822/Elysian/main/scripts/install-release.sh -o install-release.sh
sudo env ELYSIAN_RELEASE_SOURCE=github bash install-release.sh
```

入口脚本、下载器和安装包均从所选平台获取，一次安装固定来源，不自动切换。

- 安装包由 GitHub Actions 与 Gitee Go 在推送 `v*` 标签时各自构建发布，安装器默认锁定所选来源最新已发布版本，全程校验整包 SHA256、发布清单与 ELF 架构，不回退源码构建；指定已发布提交时，在对应的 `sudo env` 命令中追加 `ELYSIAN_COMMIT=<40位SHA>`。
- 安装收尾摘要会直接显示本次生成的 `admin` 初始密码；事后回查用 `journalctl -u elysian -b --no-pager | grep '初始密码'`。
- 面板入口 `http://<服务器 IP 或域名>:48100`（后端固定回环 `127.0.0.1:48101`）；Docker、Caddy、OpenSSH 与 UFW 由安装器按需检测准备，已有配置不覆盖。

Gitee 每个版本仅发布一个正式发行版，双架构安装包直接附在该版本下。

在线更新同样按来源选择：国内用 `ely upgrade --source gitee`，国外用 `ely upgrade --source github`。`sudo ely resetpwd` 重置管理员密码（全部会话失效），`ely help` 查看全部命令。

## 卸载

```bash
sudo ely uninstall --dry-run    # 只预览计划与大小
sudo ely uninstall              # 展示彻底清理清单，确认后执行
sudo ely uninstall --keep-data  # 保留面板数据与凭据
```

卸载默认删除全部面板数据、凭据、程序与可确认归属且未使用的依赖；保留选项见 `ely help uninstall`。已有容器、镜像、卷及归属不明的组件不会盲删。

## 本地开发

Ely 智能体的新任务支持按执行证据纠错、只读暂时故障重试和两分钟自动核实。相同参数与错误在没有新进展时重复三次会停止并保存报告；未知操作保留保护，聊天中的「核实实际状态」用于读取回执或封存确定未受理的请求，通过后可「继续任务」。人工核实需要服务器上的真实证据；不要直接修改运行库或删除任务文件。执行边界与兼容规则见 [ADR-0078](docs/adr/0078-agent-evidence-recovery-and-run-reports.md)。

```bash
bun install && bun run dev              # 前端与 mock 数据
bash scripts/dev.sh up                  # Docker 开发栈（前端 + Go 后端）
bun run test                            # Vitest 全量测试
bash apps/server-go/dev-check.sh ./...  # Go 门禁（Docker 容器内运行）
```

本地执行 `bash scripts/configure-push-remotes.sh` 后，一次 `git push origin main` 同时推送两站；仅显式推送 `v*` 标签触发发包。Gitee Go 首次开通和发布凭据设置见部署指南。

完整安装、更新、恢复与验证说明见 [scripts/README-deploy.md](scripts/README-deploy.md)。

## License

仓库尚未附带 LICENSE 文件；若计划开源分发请先补充许可证，在此之前默认保留所有权利。
