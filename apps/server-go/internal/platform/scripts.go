package platform

import "encoding/base64"

// 宿主安装脚本（dependencySetupScripts.ts 逐字移植）：全部是服务端常量，请求体里
// 没有命令、没有路径。成功时往 stdout 打 ELYSIAN_ALREADY / ELYSIAN_DONE；可预期的
// 失败往 stderr 打固定中文句子后以 42 退出。解释输出时只认这些句子，其余原文不进
// 浏览器。常量体与 TS 版逐字节一致（对等测试以 sh -n 与来源断言锚定）。

// 失败句字面量（原文逐字）。
const (
	setupFailureNoApt            = "当前系统没有 apt-get，只能在 Debian 或 Ubuntu 上代为安装。"
	setupFailureNoSystemctl      = "当前系统没有 systemctl，面板无法代为设置开机自启。"
	setupFailureNoCurl           = "缺少 curl，无法下载 Docker 官方安装脚本。"
	setupFailureCaddyfileHuge    = "Caddyfile 过大，面板不改写。"
	setupFailureCaddyfileInvalid = "Caddyfile 校验没有通过，已恢复原文件。"
	setupFailureSocketPath       = "管理通道路径无效"
	setupFailureBusy             = "已有安装步骤在执行"
	setupFailureGeneric          = "这一步没有完成"
	setupFailureStep             = "安装步骤无效"
	setupFailureTimeout          = "这一步超时"
	setupFailureEngine           = "连不上宿主引擎。面板在容器内需要引擎 socket 才能代为操作宿主；请先在宿主装好 Docker，确认 /var/run/docker.sock 已挂进面板容器，然后重启面板再重试。"
	setupFailureHost             = "无法在本机执行安装命令。"
	setupFailureImage            = "无法准备宿主执行环境"

	// caddyfileEncodeInvalid writeCaddyfileScript 的编码校验句；Go 的
	// base64.StdEncoding 恒产合法字母表，此分支不可达，保留字面量以对齐契约表。
	caddyfileEncodeInvalid = "Caddyfile 编码无效"
)

// setupKnownFailures 脚本会原样打出的失败句（SETUP_KNOWN_FAILURES）：命中则界面只
// 显示这一句，不附命令输出。
var setupKnownFailures = []string{
	setupFailureNoApt,
	setupFailureNoSystemctl,
	setupFailureNoCurl,
	setupFailureCaddyfileHuge,
	setupFailureCaddyfileInvalid,
}

// caddyInstallScript 安装 Caddy：已装短路；无 apt-get 拒绝；cloudsmith 官方源。
const caddyInstallScript = `set -eu
export DEBIAN_FRONTEND=noninteractive
trap 'rm -f /tmp/elysian-caddy.gpg' EXIT
if command -v caddy >/dev/null 2>&1; then
  echo ELYSIAN_ALREADY
  exit 0
fi
if ! command -v apt-get >/dev/null 2>&1; then
  echo '当前系统没有 apt-get，只能在 Debian 或 Ubuntu 上代为安装。' >&2
  exit 42
fi
apt-get update
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg
install -d -m 0755 /usr/share/keyrings
rm -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' -o /tmp/elysian-caddy.gpg
test -s /tmp/elysian-caddy.gpg
gpg --batch --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg /tmp/elysian-caddy.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
test -s /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy
command -v caddy >/dev/null 2>&1
echo ELYSIAN_DONE
`

// caddyEnableScript 启用并常驻 Caddy：runtime 目录、tmpfiles、systemctl 三连。
const caddyEnableScript = `set -eu
if ! command -v systemctl >/dev/null 2>&1; then
  echo '当前系统没有 systemctl，面板无法代为设置开机自启。' >&2
  exit 42
fi
mkdir -p /etc/systemd/system/caddy.service.d /etc/tmpfiles.d
printf '%s\n' '[Service]' 'RuntimeDirectory=caddy' 'RuntimeDirectoryMode=0755' > /etc/systemd/system/caddy.service.d/elysian-runtime.conf
printf '%s\n' 'd /run/caddy 0755 caddy caddy -' > /etc/tmpfiles.d/elysian-caddy.conf
if command -v systemd-tmpfiles >/dev/null 2>&1; then
  systemd-tmpfiles --create /etc/tmpfiles.d/elysian-caddy.conf || true
fi
systemctl daemon-reload
systemctl enable caddy
systemctl restart caddy
systemctl is-active --quiet caddy
echo ELYSIAN_DONE
`

// dockerInstallScript 安装 Docker：已在跑短路；无 curl 拒绝；官方 get.docker.com 脚本。
const dockerInstallScript = `set -eu
export DEBIAN_FRONTEND=noninteractive
trap 'rm -f /tmp/elysian-get-docker.sh' EXIT
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo ELYSIAN_ALREADY
  exit 0
fi
if ! command -v curl >/dev/null 2>&1; then
  echo '缺少 curl，无法下载 Docker 官方安装脚本。' >&2
  exit 42
fi
curl -fsSL https://get.docker.com -o /tmp/elysian-get-docker.sh
sh /tmp/elysian-get-docker.sh
echo ELYSIAN_DONE
`

// dockerEnableScript 启用并常驻 Docker。
const dockerEnableScript = `set -eu
if ! command -v systemctl >/dev/null 2>&1; then
  echo '当前系统没有 systemctl，面板无法代为设置开机自启。' >&2
  exit 42
fi
systemctl enable --now docker
systemctl is-active --quiet docker
echo ELYSIAN_DONE
`

// readCaddyfileScript 读现有 Caddyfile：没有文件打 ELYSIAN_EMPTY；有则一行 ELYSIAN_B64。
const readCaddyfileScript = `set -eu
if [ ! -f /etc/caddy/Caddyfile ]; then
  echo ELYSIAN_EMPTY
  exit 0
fi
bytes=$(wc -c < /etc/caddy/Caddyfile | tr -d ' ')
if [ "$bytes" -gt 262144 ]; then
  echo 'Caddyfile 过大，面板不改写。' >&2
  exit 42
fi
printf 'ELYSIAN_B64:%s\n' "$(base64 -w 0 /etc/caddy/Caddyfile)"
`

// writeCaddyfileScript 把已经生成好的 Caddyfile 写回宿主。内容只以 base64 进入脚本，
// 避免引号打断 shell。
func writeCaddyfileScript(content string) string {
	encoded := base64.StdEncoding.EncodeToString([]byte(content))
	return `set -eu
mkdir -p /etc/caddy
if [ -f /etc/caddy/Caddyfile ]; then
  cp -f /etc/caddy/Caddyfile /etc/caddy/Caddyfile.elysian.bak
fi
printf '%s' '` + encoded + `' | base64 -d > /etc/caddy/Caddyfile
if command -v caddy >/dev/null 2>&1; then
  if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
    if [ -f /etc/caddy/Caddyfile.elysian.bak ]; then
      mv -f /etc/caddy/Caddyfile.elysian.bak /etc/caddy/Caddyfile
    fi
    echo 'Caddyfile 校验没有通过，已恢复原文件。' >&2
    exit 42
  fi
fi
rm -f /etc/caddy/Caddyfile.elysian.bak
echo ELYSIAN_DONE
`
}
