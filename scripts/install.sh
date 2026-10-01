#!/usr/bin/env bash
# scripts/install.sh —— Elysian 源码一键部署（目标环境：Ubuntu/Debian 虚拟机，root 执行）。
#
# 用法：
#   bash scripts/install.sh             完整安装/升级（幂等，可重复执行）
#   bash scripts/install.sh --uninstall 卸载服务与二进制（保留 /var/lib/elysian 数据）
#   ELYSIAN_SMOKE=1 bash scripts/install.sh
#                                       冒烟模式：跳过 systemd 与系统用户，仅装工具链、
#                                       构建、起进程、curl /api/health、清理（供
#                                       .zcode/go-migration/script-smoke.sh 在干净容器内调用）
#
# 设计依据：AGENTS.md（只绑回环、~/.Elysian 分类目录、首启初始密码打 stdout）、
# apps/server-go/go-plan §8（发布构建：bun run build → 清空并拷贝 dist → CGO_ENABLED=0 单二进制）。
set -euo pipefail

# ---------- 版本锁定（下载一律带官方校验，版本不随行漂移） ----------
GO_VERSION="1.23.12"   # 与 apps/server-go/go.mod 的 go 1.23 对齐；sha256 取自 go.dev 官方下载索引
BUN_VERSION="1.4.2"    # sha256 取自 GitHub Release（oven-sh/bun）官方 asset digest
GO_RELEASE_HOST="https://go.dev/dl/?mode=json&include=all"
BUN_RELEASE_API="https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v${BUN_VERSION}"
BUN_RELEASE_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"

# ---------- 安装落点 ----------
SERVICE_NAME="elysian"
PANEL_BIN="/usr/local/bin/elysian"
UNIT_FILE="/etc/systemd/system/elysian.service"
STATE_DIR="/var/lib/elysian"
PANEL_PORT="48101"
HEALTH_URL="http://127.0.0.1:${PANEL_PORT}/api/health"
ENV_FILE="/etc/default/elysian"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SMOKE="${ELYSIAN_SMOKE:-}"

info() { echo "==> $*"; }
die()  { echo "安装失败：$*" >&2; exit 1; }

fetch() { # fetch <url> <输出文件>
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 -sS -o "$2" "$1" \
    || die "下载失败：$1（请检查虚拟机出网；重跑本脚本即可续装）"
}

# ---------- 环境检测 ----------

detect_arch() {
  case "$(uname -m)" in
    x86_64)  GO_ARCH="amd64";  BUN_ARCH="x64" ;;
    aarch64|arm64) GO_ARCH="arm64"; BUN_ARCH="aarch64" ;;
    *) die "不支持的 CPU 架构：$(uname -m)。本脚本仅支持 x86_64 与 aarch64（arm64）。" ;;
  esac
  info "架构：$(uname -m)（Go linux/${GO_ARCH}，bun linux/${BUN_ARCH}）"
}

detect_distro() {
  [ -r /etc/os-release ] || die "未找到 /etc/os-release，无法识别发行版。本脚本支持 Ubuntu/Debian。"
  # shellcheck disable=SC1091
  . /etc/os-release
  local family="${ID:-}${ID_LIKE:+ ${ID_LIKE}}"
  case "$family" in
    *debian*|*ubuntu*) : ;;
    *) die "不支持的发行版：${PRETTY_NAME:-未知}。本脚本支持 Ubuntu/Debian（apt 系）。" ;;
  esac
  command -v apt-get >/dev/null 2>&1 || die "未找到 apt-get，无法安装系统依赖。"
  info "发行版：${PRETTY_NAME:-Debian 系}"
}

require_preflight() {
  detect_arch
  detect_distro
  [ "$(id -u)" -eq 0 ] || die "请以 root 执行本脚本（sudo bash scripts/install.sh）。"
  [ -f "$REPO_ROOT/package.json" ] && [ -d "$REPO_ROOT/apps/web" ] && [ -f "$REPO_ROOT/apps/server-go/go.mod" ] \
    || die "源码不完整：$REPO_ROOT 下缺少 package.json / apps/web / apps/server-go。请在克隆（或解包）的仓库根运行本脚本。"
  if [ -z "$SMOKE" ]; then
    command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] \
      || die "未检测到 systemd。本脚本以 systemd 管理面板服务；容器等无 systemd 环境请改用 ELYSIAN_SMOKE=1 冒烟模式。"
  fi
}

apt_install_deps() {
  local need=()
  command -v curl >/dev/null 2>&1 || need+=(curl)
  [ -e /etc/ssl/certs/ca-certificates.crt ] || need+=(ca-certificates)
  command -v unzip >/dev/null 2>&1 || need+=(unzip)
  if [ "${#need[@]}" -eq 0 ]; then
    info "系统依赖（curl / ca-certificates / unzip）已齐备"
    return 0
  fi
  info "安装系统依赖：${need[*]}"
  apt-get update -qq || die "apt-get update 失败，请检查虚拟机的 apt 源与网络后重跑。"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${need[@]}" \
    || die "apt-get install ${need[*]} 失败，请排查后重跑。"
}

# ---------- 工具链（缺则官方渠道安装；已有且满足版本则复用） ----------

install_go() {
  if command -v go >/dev/null 2>&1 || [ -x /usr/local/go/bin/go ]; then
    local go_bin
    go_bin="$(command -v go 2>/dev/null || echo /usr/local/go/bin/go)"
    export PATH="$(dirname "$go_bin"):$PATH"
    local v minor
    v="$("$go_bin" env GOVERSION 2>/dev/null || true)"
    [ -n "$v" ] || v="$("$go_bin" version 2>/dev/null | awk '{print $3}' || true)"
    minor="${v#go1.}"; minor="${minor%%.*}"
    if [ "${v#go1.}" != "$v" ] && [ "${minor:-0}" -ge 23 ] 2>/dev/null; then
      info "复用现有 Go：$v（$go_bin）"
      return 0
    fi
    info "现有 Go（${v:-未知版本}）低于 1.23，改用官方锁定版本 ${GO_VERSION}"
  fi
  local tgz="go${GO_VERSION}.linux-${GO_ARCH}.tar.gz"
  local work index want digest
  work="$(mktemp -d)"
  index="$work/index.json"
  info "下载 Go ${GO_VERSION}（linux/${GO_ARCH}）并按 go.dev 官方索引校验 sha256"
  fetch "$GO_RELEASE_HOST" "$index"
  want="\"filename\": \"${tgz}\""
  digest="$(grep -A8 "$want" "$index" | grep -m1 -o '"sha256": "[0-9a-f]*"' | grep -o '[0-9a-f]\{64\}')"
  [ -n "$digest" ] || die "未在 go.dev 官方索引中找到 ${tgz} 的 sha256（版本可能已归档，请更新脚本内 GO_VERSION）。"
  fetch "https://go.dev/dl/${tgz}" "$work/$tgz"
  echo "$digest  $work/$tgz" | sha256sum -c --quiet - \
    || die "Go 安装包 sha256 校验失败，已中止。请重跑本脚本重新下载。"
  rm -rf /usr/local/go
  tar -C /usr/local -xzf "$work/$tgz" || die "解压 Go 到 /usr/local 失败。"
  rm -rf "$work"
  export PATH="/usr/local/go/bin:$PATH"
  info "Go 就绪：$(go env GOVERSION)"
}

install_bun() {
  if command -v bun >/dev/null 2>&1; then
    local v major minor
    v="$(bun --version 2>/dev/null || true)"
    major="${v%%.*}"; minor="$(echo "$v" | awk -F. '{print $2}')"
    if [ "${major:-0}" -ge 2 ] || { [ "$major" = 1 ] && [ "${minor:-0}" -ge 2 ]; } 2>/dev/null; then
      info "复用现有 bun：${v}"
      return 0
    fi
    info "现有 bun（${v:-未知版本}）低于 1.2（读不了 bun.lock 文本格式），改用官方锁定版本 ${BUN_VERSION}"
  fi
  local asset="bun-linux-${BUN_ARCH}.zip"
  local work meta digest
  work="$(mktemp -d)"
  meta="$work/release.json"
  info "下载 bun ${BUN_VERSION}（linux/${BUN_ARCH}）并按 GitHub Release 官方 digest 校验 sha256"
  fetch "$BUN_RELEASE_API" "$meta"
  # digest 字段在 uploader 对象之后，与所属 asset 的 "name" 相距数十行：按「最近的 name」配对提取。
  digest="$(awk -v asset="$asset" '
    /"name": "/ { line=$0; sub(/^.*"name": "/, "", line); sub(/".*$/, "", line); name=line }
    /"digest": "sha256:/ && name == asset { line=$0; sub(/^.*"digest": "sha256:/, "", line); sub(/".*$/, "", line); print line; exit }
  ' "$meta")"
  [ -n "$digest" ] || die "未在 GitHub Release 元数据中找到 ${asset} 的 sha256 digest（请更新脚本内 BUN_VERSION）。"
  fetch "${BUN_RELEASE_URL}/${asset}" "$work/$asset"
  echo "$digest  $work/$asset" | sha256sum -c --quiet - \
    || die "bun 安装包 sha256 校验失败，已中止。请重跑本脚本重新下载。"
  unzip -q -o "$work/$asset" -d "$work/unzipped" || die "解压 bun 失败（缺 unzip？）。"
  install -m 0755 "$work/unzipped/bun-linux-${BUN_ARCH}/bun" /usr/local/bin/bun \
    || die "安装 bun 到 /usr/local/bin 失败。"
  rm -rf "$work"
  info "bun 就绪：$(bun --version)"
}

# ---------- 构建（go-plan §8 发布构建流） ----------

build_frontend() {
  info "安装前端依赖（bun install --frozen-lockfile）"
  (cd "$REPO_ROOT" && bun install --frozen-lockfile) \
    || die "bun install 失败。请确认 bun >= 1.2 且能访问 npm registry；修复后重跑。"
  info "构建前端（vite build；注入 ELYSIAN_DOCKER=1 使面板走 HTTP 适配层）"
  # ELYSIAN_DOCKER 在构建期经 vite define 固化进产物（apps/web/vite.build.config.ts），
  # 决定浏览器侧适配层走 HTTP 还是 mock：VM 部署是真实执行，必须与 compose 同法注入。
  (cd "$REPO_ROOT" && ELYSIAN_DOCKER=1 bun run build) \
    || die "前端构建失败（bun run build）。请先在本机排除构建错误后重跑。"
  [ -f "$REPO_ROOT/apps/web/dist/index.html" ] || die "前端构建产物缺 index.html，构建可能未完成。"
}

build_server() {
  info "嵌入前端产物并构建 Go 单二进制（CGO_ENABLED=0）"
  # 清空再拷贝，防旧产物残留（go-plan §8）；dist 入库占位 .gitkeep 不参与发布。
  rm -rf "$REPO_ROOT/apps/server-go/web/dist"
  mkdir -p "$REPO_ROOT/apps/server-go/web/dist"
  cp -a "$REPO_ROOT/apps/web/dist/." "$REPO_ROOT/apps/server-go/web/dist/"
  # -buildvcs=false：导出/克隆目录的属主与执行者（root）不一致时，git 的 dubious ownership
  # 会令 VCS 状态探测报错；部署构建无需版本号烙印，直接关掉。
  (cd "$REPO_ROOT/apps/server-go" && CGO_ENABLED=0 go build -buildvcs=false -ldflags="-s -w" -o elysian ./cmd/elysian) \
    || die "Go 后端构建失败。请确认 Go >= 1.23 且能访问 Go 模块代理；修复后重跑。"
  [ -x "$REPO_ROOT/apps/server-go/elysian" ] || die "未找到构建产物 elysian。"
}

install_binary() {
  info "安装二进制到 $PANEL_BIN"
  install -m 0755 "$REPO_ROOT/apps/server-go/elysian" "$PANEL_BIN" \
    || die "写入 $PANEL_BIN 失败。"
}

# ---------- 系统账号与 systemd 单元 ----------

ensure_accounts() {
  # elysian-sqlite（uid/gid 2001）：SQLite 托管子进程的降权身份，服务端以
  # syscall.Credential 硬编码 2001 降权，账号缺失即建库失败（go-plan：安装脚本负责建号）。
  if ! getent group elysian-sqlite >/dev/null 2>&1; then
    getent group 2001 >/dev/null 2>&1 && die "GID 2001 已被其他组占用（$(getent group 2001)），无法创建 elysian-sqlite 组。请先腾出该 GID。"
    groupadd -g 2001 elysian-sqlite || die "创建 elysian-sqlite 组（GID 2001）失败。"
  fi
  if ! id -u elysian-sqlite >/dev/null 2>&1; then
    getent passwd 2001 >/dev/null 2>&1 && die "UID 2001 已被其他用户占用（$(getent passwd 2001)），无法创建 elysian-sqlite 用户。请先腾出该 UID。"
    useradd -u 2001 -g 2001 -M -s /usr/sbin/nologin elysian-sqlite || die "创建 elysian-sqlite 用户（UID 2001）失败。"
  fi
  # elysian：面板数据目录（/var/lib/elysian）的归属账号，供运维以该身份检查数据；
  # 服务本身以 root 运行（见单元注释），此账号不用于登录。
  if ! id -u elysian >/dev/null 2>&1; then
    useradd --system --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin elysian \
      || die "创建 elysian 系统用户失败。"
  fi
  info "系统账号就绪：elysian、elysian-sqlite（2001）"
}

write_unit() {
  info "写 systemd 单元 $UNIT_FILE"
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<UNIT
[Unit]
Description=Elysian 运维工作台（Go 后端）
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# 面板在裸机模式直接执行 ufw/sshd/账号等宿主操作，并为 SQLite 托管子进程降权到
# uid 2001（syscall.Credential 要求 root 父进程），因此必须以 root 运行；
# elysian 账号是数据目录归属账号，不承载服务进程。
User=root
# HOME 指向 StateDirectory：~/.Elysian 即 /var/lib/elysian/.Elysian，data/logs/state/
# backups/tmp/config 分类目录语义与容器内符号链接方案一致。
Environment=HOME=${STATE_DIR}
Environment=ELYSIAN_BARE_METAL=1
# 红线：面板只绑回环，对外服务由用户自行反代；脚本不开防火墙端口、不申请证书。
Environment=ELYSIAN_LISTEN_HOST=127.0.0.1
# 可选环境覆盖（如 ELYSIAN_DOCKER_SOCKET / ELYSIAN_CADDY_SOCKET），文件缺省不报错。
EnvironmentFile=-${ENV_FILE}
ExecStart=${PANEL_BIN}
Restart=always
RestartSec=5
StateDirectory=elysian
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
  install -m 0644 "$tmp" "$UNIT_FILE" || die "写入 $UNIT_FILE 失败。"
  rm -f "$tmp"
  systemctl daemon-reload || die "systemctl daemon-reload 失败。"
}

start_service() {
  info "启动并使能服务（systemctl enable + restart）"
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || die "systemctl enable $SERVICE_NAME 失败。"
  systemctl restart "$SERVICE_NAME" || die "systemctl restart $SERVICE_NAME 失败，请查看：journalctl -u $SERVICE_NAME -n 50 --no-pager"
}

wait_health() {
  info "等待就绪：$HEALTH_URL"
  local i
  for i in $(seq 1 60); do
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
      info "健康检查通过（/api/health 200）"
      return 0
    fi
    if [ -n "$SMOKE" ]; then
      kill -0 "$SMOKE_PID" 2>/dev/null || { tail -n 40 "$SMOKE_LOG" >&2 || true; die "面板进程已退出，详见上方日志。"; }
    else
      systemctl is-active --quiet "$SERVICE_NAME" || { journalctl -u "$SERVICE_NAME" -n 40 --no-pager >&2 || true; die "服务已退出，详见上方日志。"; }
    fi
    sleep 1
  done
  die "等待 ${HEALTH_URL} 就绪超时（60 秒）。排查：journalctl -u $SERVICE_NAME -n 50 --no-pager（或确认 ${PANEL_PORT} 端口未被占用）。"
}

print_summary() {
  echo
  echo "Elysian 部署完成。"
  echo "  面板地址：http://127.0.0.1:${PANEL_PORT}（仅回环；对外访问请自行配置反向代理，脚本不申请证书、不开防火墙端口）"
  echo "  查看首启初始密码（仅第一次启动打印）：journalctl -u $SERVICE_NAME -b --no-pager | grep '初始密码'"
  echo "  忘记密码时重置：HOME=${STATE_DIR} $PANEL_BIN resetpwd"
  echo "  服务管理：systemctl status/restart/stop $SERVICE_NAME"
  echo "  数据目录：${STATE_DIR}/.Elysian（data/logs/state/backups/tmp/config 分类目录）"
}

# ---------- 卸载 ----------

uninstall() {
  [ "$(id -u)" -eq 0 ] || die "请以 root 执行卸载（sudo bash scripts/install.sh --uninstall）。"
  if [ -n "$SMOKE" ]; then
    info "冒烟模式无系统安装物，跳过卸载"
    return 0
  fi
  info "停止并注销服务"
  systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  rm -f "$UNIT_FILE"
  systemctl daemon-reload || true
  systemctl reset-failed "$SERVICE_NAME" >/dev/null 2>&1 || true
  if [ -f "$PANEL_BIN" ]; then
    info "删除二进制 $PANEL_BIN"
    rm -f "$PANEL_BIN"
  fi
  info "删除系统账号 elysian / elysian-sqlite（数据文件属主将退化为纯数字 UID，属正常现象）"
  userdel elysian >/dev/null 2>&1 || true
  userdel elysian-sqlite >/dev/null 2>&1 || true
  groupdel elysian-sqlite >/dev/null 2>&1 || true
  echo
  echo "已卸载。面板数据目录 ${STATE_DIR}（凭据、SQLite、日志）已保留；"
  echo "彻底清除请执行：rm -rf ${STATE_DIR}。Go 与 bun 工具链一并保留。"
}

# ---------- 冒烟模式（干净容器内：装工具链 → 构建 → 起进程 → 健康检查 → 清理） ----------

smoke_run() {
  # 与生产同 HOME 语义（跳过系统用户，目录手动创建）。
  mkdir -p "$STATE_DIR"
  SMOKE_LOG="$(mktemp)"
  info "后台启动面板进程（HOME=${STATE_DIR} ELYSIAN_BARE_METAL=1）"
  env HOME="$STATE_DIR" ELYSIAN_BARE_METAL=1 "$REPO_ROOT/apps/server-go/elysian" >"$SMOKE_LOG" 2>&1 &
  SMOKE_PID=$!
  trap 'kill "$SMOKE_PID" 2>/dev/null || true; wait "$SMOKE_PID" 2>/dev/null || true; rm -f "$SMOKE_LOG"' EXIT
  wait_health
  curl -fsS --max-time 5 "http://127.0.0.1:${PANEL_PORT}/" | grep -q '<title>Elysian</title>' \
    || die "首页未返回嵌入的前端产物（缺 <title>Elysian</title>），嵌入 dist 可能失败。"
  grep -q '初始密码' "$SMOKE_LOG" || die "首启凭据横幅未打印（应输出「初始密码：…」）。"
  info "冒烟检查通过：健康端点 200、嵌入首页可访问、首启初始密码已打印"
}

# ---------- 主流程 ----------

main() {
  if [ "${1:-}" = "--uninstall" ]; then
    uninstall
    return 0
  fi
  [ "${1:-}" = "" ] || die "未知参数：$1。用法：bash scripts/install.sh [--uninstall]（环境变量 ELYSIAN_SMOKE=1 进入冒烟模式）。"
  require_preflight
  apt_install_deps
  install_go
  install_bun
  build_frontend
  build_server
  if [ -n "$SMOKE" ]; then
    smoke_run
  else
    if [ -f "$UNIT_FILE" ]; then
      info "检测到已有安装，先停服再升级（数据不受影响）"
      systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    fi
    install_binary
    ensure_accounts
    write_unit
    start_service
    wait_health
    print_summary
  fi
}

main "$@"
