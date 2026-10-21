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
# 设计依据：AGENTS.md（前端 IP 直连、后端回环、~/.Elysian 分类目录、首启初始密码打 stdout）、
# apps/server-go/go-plan §8（发布构建：bun run build → 清空并拷贝 dist → CGO_ENABLED=0 单二进制）。
set -euo pipefail

# ---------- 版本锁定（下载一律带官方校验，版本不随行漂移） ----------
GO_VERSION="1.23.12"   # 与 apps/server-go/go.mod 的 go 1.23 对齐；sha256 取自 go.dev 官方下载索引
BUN_VERSION="1.4.2"    # sha256 取自 GitHub Release（oven-sh/bun）官方 asset digest
GO_INDEX_URLS=(
  "https://go.dev/dl/?mode=json&include=all"
  "https://golang.google.cn/dl/?mode=json&include=all"
)
GO_DOWNLOAD_BASES=(
  "https://go.dev/dl"
  "https://golang.google.cn/dl"
  "https://mirrors.aliyun.com/golang"
)
BUN_RELEASE_API="https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v${BUN_VERSION}"
BUN_RELEASE_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"
BUN_MIRROR_URL="https://registry.npmmirror.com/-/binary/bun/bun-v${BUN_VERSION}"
# BUN_VERSION 固定时这两枚摘要同时作为 GitHub API 不可达时的校验回退。
BUN_SHA256_X64="36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913"
BUN_SHA256_AARCH64="54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7"

# ---------- 安装落点 ----------
SERVICE_NAME="elysian"
PANEL_BIN="/usr/local/bin/elysian"
UNIT_FILE="/etc/systemd/system/elysian.service"
STATE_DIR="/var/lib/elysian"
PANEL_PORT="48101"
FRONTEND_PORT="48100"
INSTALL_ROOT="/opt/elysian"
HEALTH_URL="http://127.0.0.1:${PANEL_PORT}/api/health"
ENV_FILE="/etc/default/elysian"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SMOKE="${ELYSIAN_SMOKE:-}"

# 构建依赖镜像：系统已预装 Go/Bun 时也强制传给构建进程；可显式覆盖。
GO_PROXY_DEFAULT="https://goproxy.cn|https://mirrors.aliyun.com/goproxy/|direct"
BUN_REGISTRY_DEFAULT="https://registry.npmmirror.com"
export GOPROXY="${ELYSIAN_GOPROXY:-${GOPROXY:-$GO_PROXY_DEFAULT}}"
export BUN_CONFIG_REGISTRY="${ELYSIAN_BUN_REGISTRY:-${BUN_CONFIG_REGISTRY:-$BUN_REGISTRY_DEFAULT}}"

STEP=0
if [ -n "$SMOKE" ]; then
  TOTAL_STEPS=7
else
  TOTAL_STEPS=9
fi

if [ -t 1 ] && [ -t 2 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'
else
  C_RESET=''; C_BOLD=''; C_GREEN=''; C_RED=''
fi

info() { printf '%s==>%s %s\n' "$C_BOLD" "$C_RESET" "$*"; }
ok() { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
section() {
  STEP=$((STEP + 1))
  printf '\n%s[%d/%d] %s%s\n' "$C_BOLD" "$STEP" "$TOTAL_STEPS" "$*" "$C_RESET"
}
die() { printf '%s安装失败：%s%s\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }

try_fetch() { # try_fetch <url> <输出文件> [progress]；IPv6 异常时再强制 IPv4 试一次
  local opts=(-fL --retry 3 --retry-delay 2 --connect-timeout 20)
  # 元数据静默下载；大文件在交互终端显示进度条，重定向日志时仍保持安静。
  if [ "${3:-}" = progress ] && [ -t 2 ]; then
    opts+=(--progress-bar)
  else
    opts+=(-sS)
  fi
  curl "${opts[@]}" -o "$2" "$1" && return 0
  curl -4 "${opts[@]}" -o "$2" "$1"
}

fetch_from() { # fetch_from <输出文件> <url>...
  local out="$1" url
  shift
  for url in "$@"; do
    if try_fetch "$url" "$out"; then
      return 0
    fi
    info "下载源不可用，尝试下一个：$url"
  done
  return 1
}

fetch_file() { # fetch_file <输出文件> <url>...
  local out="$1" url
  shift
  for url in "$@"; do
    if try_fetch "$url" "$out" progress; then
      return 0
    fi
    info "下载源不可用，尝试下一个：$url"
  done
  return 1
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
  command -v ufw >/dev/null 2>&1 || need+=(ufw)
  command -v ss >/dev/null 2>&1 || need+=(iproute2)
  command -v runuser >/dev/null 2>&1 || need+=(util-linux)
  if [ "${#need[@]}" -eq 0 ]; then
    ok "系统依赖（curl / ca-certificates / unzip）已齐备"
    return 0
  fi
  local log
  log="$(mktemp /tmp/elysian-apt.XXXXXX)"
  info "安装系统依赖：${need[*]}（详细输出写入 ${log}，失败时回显并保留日志）"
  if ! apt-get update -qq >"$log" 2>&1; then
    tail -n 40 "$log" >&2
    die "apt-get update 失败，请检查虚拟机的 apt 源与网络后重跑（完整日志：${log}）。"
  fi
  if ! DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${need[@]}" >>"$log" 2>&1; then
    tail -n 40 "$log" >&2
    die "apt-get install ${need[*]} 失败，请排查后重跑（完整日志：${log}）。"
  fi
  rm -f "$log"
  ok "系统依赖已就绪：${need[*]}"
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
      ok "复用现有 Go：$v（$go_bin）"
      return 0
    fi
    info "现有 Go（${v:-未知版本}）低于 1.23，改用官方锁定版本 ${GO_VERSION}"
  fi
  local tgz="go${GO_VERSION}.linux-${GO_ARCH}.tar.gz"
  local work index want digest base tgz_urls=()
  work="$(mktemp -d)"
  index="$work/index.json"
  info "下载 Go ${GO_VERSION}（linux/${GO_ARCH}）版本索引并按官方 sha256 校验"
  fetch_from "$index" "${GO_INDEX_URLS[@]}" \
    || die "无法下载 Go 版本索引（已尝试 go.dev 与 golang.google.cn），请检查出网后重跑。"
  want="\"filename\": \"${tgz}\""
  digest="$(grep -A8 "$want" "$index" | grep -m1 -o '"sha256": "[0-9a-f]*"' | grep -o '[0-9a-f]\{64\}')"
  [ -n "$digest" ] || die "未在官方索引中找到 ${tgz} 的 sha256（版本可能已归档，请更新脚本内 GO_VERSION）。"
  for base in "${GO_DOWNLOAD_BASES[@]}"; do tgz_urls+=("$base/$tgz"); done
  info "下载 Go 安装包（约 70 MiB）；官方源失败时自动切换国内镜像，仍按官方 sha256 校验"
  fetch_file "$work/$tgz" "${tgz_urls[@]}" \
    || die "Go 安装包下载失败（已尝试 go.dev、golang.google.cn 与阿里云镜像），请检查出网后重跑。"
  echo "$digest  $work/$tgz" | sha256sum -c --quiet - \
    || die "Go 安装包 sha256 校验失败，已中止。请重跑本脚本重新下载。"
  ok "Go 安装包校验通过"
  rm -rf /usr/local/go
  tar -C /usr/local -xzf "$work/$tgz" || die "解压 Go 到 /usr/local 失败。"
  rm -rf "$work"
  export PATH="/usr/local/go/bin:$PATH"
  ok "Go 就绪：$(go env GOVERSION)"
}

install_bun() {
  if command -v bun >/dev/null 2>&1; then
    local v major minor
    v="$(bun --version 2>/dev/null || true)"
    major="${v%%.*}"; minor="$(echo "$v" | awk -F. '{print $2}')"
    if [ "${major:-0}" -ge 2 ] || { [ "$major" = 1 ] && [ "${minor:-0}" -ge 2 ]; } 2>/dev/null; then
      ok "复用现有 bun：${v}"
      return 0
    fi
    info "现有 bun（${v:-未知版本}）低于 1.2（读不了 bun.lock 文本格式），改用官方锁定版本 ${BUN_VERSION}"
  fi
  local asset="bun-linux-${BUN_ARCH}.zip"
  local work meta digest
  work="$(mktemp -d)"
  meta="$work/release.json"
  info "下载 bun ${BUN_VERSION}（linux/${BUN_ARCH}）元数据并按官方 digest 校验 sha256"
  # GitHub API 不可达时使用脚本内固定的同版本官方摘要，仍保持完整性校验。
  if try_fetch "$BUN_RELEASE_API" "$meta"; then
    # digest 字段在 uploader 对象之后，与所属 asset 的 "name" 相距数十行：按「最近的 name」配对提取。
    digest="$(awk -v asset="$asset" '
      /"name": "/ { line=$0; sub(/^.*"name": "/, "", line); sub(/".*$/, "", line); name=line }
      /"digest": "sha256:/ && name == asset { line=$0; sub(/^.*"digest": "sha256:/, "", line); sub(/".*$/, "", line); print line; exit }
    ' "$meta")"
  fi
  if [ -z "$digest" ]; then
    case "$BUN_ARCH" in
      x64) digest="$BUN_SHA256_X64" ;;
      aarch64) digest="$BUN_SHA256_AARCH64" ;;
    esac
    info "GitHub API 不可用或缺少摘要，改用脚本内固定的 bun ${BUN_VERSION} 官方摘要"
  fi
  [ -n "$digest" ] || die "未取得 ${asset} 的官方 sha256 digest（请更新脚本内 BUN_VERSION 与固定摘要）。"
  info "下载 bun 安装包（约 35 MiB）；GitHub 失败时切换 npmmirror 镜像"
  fetch_file "$work/$asset" "${BUN_RELEASE_URL}/${asset}" "${BUN_MIRROR_URL}/${asset}" \
    || die "bun 安装包下载失败（已尝试 GitHub 与 npmmirror 镜像），请检查出网后重跑。"
  echo "$digest  $work/$asset" | sha256sum -c --quiet - \
    || die "bun 安装包 sha256 校验失败，已中止。请重跑本脚本重新下载。"
  ok "bun 安装包校验通过"
  unzip -q -o "$work/$asset" -d "$work/unzipped" || die "解压 bun 失败（缺 unzip？）。"
  install -m 0755 "$work/unzipped/bun-linux-${BUN_ARCH}/bun" /usr/local/bin/bun \
    || die "安装 bun 到 /usr/local/bin 失败。"
  rm -rf "$work"
  ok "bun 就绪：$(bun --version)"
}

# ---------- 全局镜像配置 ----------

configure_mirrors() {
  if [ -n "$SMOKE" ]; then
    ok "冒烟模式跳过全局镜像配置"
    return 0
  fi
  local profile="/etc/profile.d/elysian-mirrors.sh" tmp
  tmp="$(mktemp)"
  cat >"$tmp" <<EOF
# 由 Elysian 安装脚本生成；仅在未显式设置时提供国内镜像默认值。
export GOPROXY="\${GOPROXY:-$GOPROXY}"
export BUN_CONFIG_REGISTRY="\${BUN_CONFIG_REGISTRY:-$BUN_CONFIG_REGISTRY}"
EOF
  install -m 0644 "$tmp" "$profile" || { rm -f "$tmp"; die "写入 ${profile} 失败。"; }
  rm -f "$tmp"
  if command -v go >/dev/null 2>&1; then
    go env -w GOPROXY="$GOPROXY" \
      || info "警告：写入 Go 全局 GOPROXY 失败；构建仍使用当前环境变量"
  fi
  ok "全局镜像配置已写入 ${profile}（新登录 shell 生效）"
}

# ---------- 构建与版本安装 ----------

build_release() {
  info "构建需要下载依赖并编译前后端，可能需要几分钟"
  BUILD_DIR="$(mktemp -d)"
  BUILD_COMMIT="unknown"
  if command -v git >/dev/null 2>&1; then
    BUILD_COMMIT="$(git -c safe.directory="$REPO_ROOT" -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
    if [ "$BUILD_COMMIT" != unknown ] && ! git -c safe.directory="$REPO_ROOT" -C "$REPO_ROOT" diff --quiet HEAD --; then
      BUILD_COMMIT="${BUILD_COMMIT}-dirty"
    fi
  fi
  if [ -n "$SMOKE" ]; then
    bash "$REPO_ROOT/scripts/build-release.sh" "$REPO_ROOT" "$BUILD_DIR" "$BUILD_COMMIT" || die "源码构建失败，原面板未停服。"
  else
    ensure_accounts
    BUILD_SOURCE="$(mktemp -d /var/tmp/elysian-install-source.XXXXXX)"
    tar -C "$REPO_ROOT" --exclude=.git --exclude=node_modules --exclude=dist --exclude=.env --exclude='.env.*' --exclude=.codex --exclude=.zcode --exclude=.agents --exclude=.Elysian -cf - . | tar -C "$BUILD_SOURCE" -xf -
    install -m 0644 "$REPO_ROOT/scripts/build-release.sh" "$BUILD_DIR/build-release.sh"
    chown -R elysian-build:elysian-build "$BUILD_SOURCE" "$BUILD_DIR"
    runuser -u elysian-build -- env HOME="$BUILD_SOURCE" PATH=/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin \
      GOPROXY="$GOPROXY" BUN_CONFIG_REGISTRY="$BUN_CONFIG_REGISTRY" \
      bash "$BUILD_DIR/build-release.sh" "$BUILD_SOURCE" "$BUILD_DIR" "$BUILD_COMMIT" || die "源码构建失败，原面板未停服。"
  fi
  ok "构建完成"
}

install_binary() {
  mkdir -p "$INSTALL_ROOT/releases" "$INSTALL_ROOT/maintenance" "$STATE_DIR/.Elysian/config" "$STATE_DIR/.Elysian/state/panel-maintenance"
  chmod 0755 "$INSTALL_ROOT" "$INSTALL_ROOT/releases" "$INSTALL_ROOT/maintenance"
  chmod 0700 "$STATE_DIR/.Elysian" "$STATE_DIR/.Elysian/config" "$STATE_DIR/.Elysian/state" "$STATE_DIR/.Elysian/state/panel-maintenance"
  RELEASE_DIR="$INSTALL_ROOT/releases/${BUILD_COMMIT}-${INSTALL_STAMP}"
  mkdir -p "$RELEASE_DIR"
  install -m 0755 "$BUILD_DIR/elysian" "$RELEASE_DIR/elysian"
  install -m 0755 "$BUILD_DIR/elysian" "$INSTALL_ROOT/maintenance/elysian"
  install -m 0644 "$REPO_ROOT/scripts/build-release.sh" "$INSTALL_ROOT/maintenance/build-release.sh"
  ln -s "$RELEASE_DIR" "$INSTALL_ROOT/.current-$INSTALL_STAMP"
  mv -Tf "$INSTALL_ROOT/.current-$INSTALL_STAMP" "$INSTALL_ROOT/current"
  ln -sfn "$INSTALL_ROOT/current/elysian" "$PANEL_BIN"
  HOME="$STATE_DIR" "$PANEL_BIN" panel-init || die "面板端口配置损坏，安装已中止。"
  read -r FRONTEND_PORT PANEL_PORT < <(HOME="$STATE_DIR" "$PANEL_BIN" panel-ports)
  HEALTH_URL="http://127.0.0.1:${PANEL_PORT}/api/health"
  ok "当前版本已切换到 ${BUILD_COMMIT}"
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
  if ! id -u elysian-build >/dev/null 2>&1; then
    useradd --system --user-group --home-dir /var/lib/elysian-build --no-create-home --shell /usr/sbin/nologin elysian-build || die "创建无特权构建账号失败。"
  fi
  info "系统账号就绪：elysian、elysian-sqlite（2001）、elysian-build"
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
# 后端固定回环，正式前端对外监听；端口由 panel-network.json 管理。
Environment=ELYSIAN_LISTEN_HOST=127.0.0.1
# 可选环境覆盖（如 ELYSIAN_DOCKER_SOCKET / ELYSIAN_CADDY_SOCKET），文件缺省不报错。
EnvironmentFile=-${ENV_FILE}
ExecStartPre=${INSTALL_ROOT}/maintenance/elysian maintenance-recover
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
  ok "服务进程已启动"
}

wait_health() {
  info "等待就绪：$HEALTH_URL"
  local i
  for i in $(seq 1 60); do
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1 && curl -fsS --max-time 3 "http://127.0.0.1:${FRONTEND_PORT}/" | grep -q '<title>Elysian</title>'; then
      ok "健康检查通过（/api/health 200）"
      return 0
    fi
    if [ -n "$SMOKE" ]; then
      kill -0 "$SMOKE_PID" 2>/dev/null || { tail -n 40 "$SMOKE_LOG" >&2 || true; die "面板进程已退出，详见上方日志。"; }
    else
      systemctl is-active --quiet "$SERVICE_NAME" || { journalctl -u "$SERVICE_NAME" -n 40 --no-pager >&2 || true; die "服务已退出，详见上方日志。"; }
    fi
    if [ $((i % 5)) -eq 0 ]; then
      printf '    等待健康检查… %d/60 秒\n' "$i"
    fi
    sleep 1
  done
  die "等待 ${HEALTH_URL} 就绪超时（60 秒）。排查：journalctl -u $SERVICE_NAME -n 50 --no-pager（或确认 ${PANEL_PORT} 端口未被占用）。"
}

print_summary() {
  printf '\n%sElysian 部署完成%s\n' "$C_BOLD$C_GREEN" "$C_RESET"
  echo "  面板地址：http://<服务器 IP>:${FRONTEND_PORT}（前端入口）"
  echo "  后端地址：127.0.0.1:${PANEL_PORT}（不对外开放）"
  echo "  面板更新与改端口：登录后进入系统设置"
  echo "  Go 模块代理：${GOPROXY}"
  echo "  Bun registry：${BUN_CONFIG_REGISTRY}"
  echo "  全局镜像配置文件：/etc/profile.d/elysian-mirrors.sh（新登录 shell 生效）"
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
  rm -f /etc/profile.d/elysian-mirrors.sh
  systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  rm -f "$UNIT_FILE"
  systemctl daemon-reload || true
  systemctl reset-failed "$SERVICE_NAME" >/dev/null 2>&1 || true
  if [ -f "$PANEL_BIN" ]; then
    info "删除二进制 $PANEL_BIN"
    rm -f "$PANEL_BIN"
  fi
  rm -rf "$INSTALL_ROOT"
  info "删除系统账号 elysian / elysian-sqlite（数据文件属主将退化为纯数字 UID，属正常现象）"
  userdel elysian-build >/dev/null 2>&1 || true
  groupdel elysian-build >/dev/null 2>&1 || true
  userdel elysian >/dev/null 2>&1 || true
  userdel elysian-sqlite >/dev/null 2>&1 || true
  groupdel elysian-sqlite >/dev/null 2>&1 || true
  echo
  echo "已卸载。面板数据目录 ${STATE_DIR}（凭据、SQLite、日志）已保留；"
  echo "彻底清除请执行：rm -rf ${STATE_DIR}。Go 与 bun 工具链一并保留。"
  echo "全局镜像 profile 已移除；root 的 go env GOPROXY 如需恢复，请执行 go env -u GOPROXY。"
}

# ---------- 冒烟模式（干净容器内：装工具链 → 构建 → 起进程 → 健康检查 → 清理） ----------

smoke_run() {
  # 与生产同 HOME 语义（跳过系统用户，目录手动创建）。
  mkdir -p "$STATE_DIR"
  SMOKE_LOG="$(mktemp)"
  HOME="$STATE_DIR" "$BUILD_DIR/elysian" panel-init
  read -r FRONTEND_PORT PANEL_PORT < <(HOME="$STATE_DIR" "$BUILD_DIR/elysian" panel-ports)
  HEALTH_URL="http://127.0.0.1:${PANEL_PORT}/api/health"
  info "后台启动面板进程（HOME=${STATE_DIR} ELYSIAN_BARE_METAL=1）"
  env HOME="$STATE_DIR" ELYSIAN_BARE_METAL=1 "$BUILD_DIR/elysian" >"$SMOKE_LOG" 2>&1 &
  SMOKE_PID=$!
  trap 'kill "$SMOKE_PID" 2>/dev/null || true; wait "$SMOKE_PID" 2>/dev/null || true; rm -f "$SMOKE_LOG"; install_exit' EXIT
  wait_health
  curl -fsS --max-time 5 "http://127.0.0.1:${FRONTEND_PORT}/" | grep -q '<title>Elysian</title>' \
    || die "首页未返回嵌入的前端产物（缺 <title>Elysian</title>），嵌入 dist 可能失败。"
  grep -q '初始密码' "$SMOKE_LOG" || die "首启凭据横幅未打印（应输出「初始密码：…」）。"
  info "冒烟检查通过：健康端点 200、嵌入首页可访问、首启初始密码已打印"
}

# ---------- 安装切换事务（在线更新由独立维护 worker 执行） ----------

install_exit() {
  local result=$?
  if [ "${INSTALL_ACTIVATED:-0}" = 1 ] && [ "${INSTALL_COMMITTED:-0}" != 1 ]; then
    info "安装未完成，恢复原程序、数据与本次涉及的面板规则"
    systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    local item
    for item in config data state; do
      rm -rf "$STATE_DIR/.Elysian/$item"
      if [ -e "$INSTALL_BACKUP/data/$item" ]; then cp -a "$INSTALL_BACKUP/data/$item" "$STATE_DIR/.Elysian/$item" || result=1; fi
    done
    HOME="$STATE_DIR" "$BUILD_DIR/elysian" maintenance-bootstrap-restore "$INSTALL_BACKUP/firewall.json" || result=1
    if [ -n "${PREVIOUS_RELEASE:-}" ]; then
      ln -s "$PREVIOUS_RELEASE" "$INSTALL_ROOT/.restore-$$"
      mv -Tf "$INSTALL_ROOT/.restore-$$" "$INSTALL_ROOT/current"
      ln -sfn "$INSTALL_ROOT/current/elysian" "$PANEL_BIN"
    else
      rm -f "$INSTALL_ROOT/current" "$PANEL_BIN"
    fi
    rm -f "$UNIT_FILE"
    if [ -e "$INSTALL_BACKUP/unit" ]; then cp -a "$INSTALL_BACKUP/unit" "$UNIT_FILE" || result=1; fi
    rm -f "$INSTALL_ROOT/maintenance/elysian" "$INSTALL_ROOT/maintenance/build-release.sh"
    if [ -d "$INSTALL_BACKUP/maintenance" ]; then cp -a "$INSTALL_BACKUP/maintenance/." "$INSTALL_ROOT/maintenance/" || result=1; fi
    systemctl daemon-reload || result=1
    if [ "${WAS_ACTIVE:-0}" = 1 ]; then systemctl start "$SERVICE_NAME" || result=1; fi
    if [ "${WAS_ENABLED:-0}" != 1 ]; then systemctl disable "$SERVICE_NAME" >/dev/null 2>&1 || true; fi
    info "恢复记录与备份：$INSTALL_BACKUP"
  fi
  if [ -n "${BUILD_SOURCE:-}" ]; then rm -rf "$BUILD_SOURCE"; fi
  if [ -n "${BUILD_DIR:-}" ]; then rm -rf "$BUILD_DIR"; fi
  return "$result"
}

prepare_install_switch() {
  local tasks="$STATE_DIR/.Elysian/state/panel-maintenance"
  mkdir -p "$tasks" "$INSTALL_ROOT/releases"
  chmod 0700 "$tasks"
  exec 9>"$tasks/worker.lock"
  flock -n 9 || die "另一项面板维护任务正在执行。"
  exec 8>"$tasks/operations.lock"
  flock -x 8
  HOME="$STATE_DIR" "$BUILD_DIR/elysian" maintenance-install-check || die "安装切换预检失败，原面板继续运行。"
  INSTALL_BACKUP="$STATE_DIR/.Elysian/backups/install-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$INSTALL_BACKUP/data"
  chmod 0700 "$INSTALL_BACKUP"
  HOME="$STATE_DIR" "$BUILD_DIR/elysian" maintenance-bootstrap-save "$INSTALL_BACKUP/firewall.json"
  if [ -e "$UNIT_FILE" ]; then cp -a "$UNIT_FILE" "$INSTALL_BACKUP/unit"; fi
  if [ -d "$INSTALL_ROOT/maintenance" ]; then cp -a "$INSTALL_ROOT/maintenance" "$INSTALL_BACKUP/maintenance"; fi
  INSTALL_STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  PREVIOUS_RELEASE=""
  if [ -L "$INSTALL_ROOT/current" ]; then
    PREVIOUS_RELEASE="$(readlink -f "$INSTALL_ROOT/current")"
  elif [ -f "$PANEL_BIN" ]; then
    PREVIOUS_RELEASE="$INSTALL_ROOT/releases/legacy-$INSTALL_STAMP"
    mkdir -p "$PREVIOUS_RELEASE"
    install -m 0755 "$PANEL_BIN" "$PREVIOUS_RELEASE/elysian"
  fi
  WAS_ACTIVE=0; WAS_ENABLED=0
  if systemctl is-active --quiet "$SERVICE_NAME"; then WAS_ACTIVE=1; fi
  if systemctl is-enabled --quiet "$SERVICE_NAME"; then WAS_ENABLED=1; fi
  if [ -e "$UNIT_FILE" ] || [ "$WAS_ACTIVE" = 1 ]; then
    systemctl stop "$SERVICE_NAME" || die "无法停止原服务，安装切换已中止。"
  fi
  HOME="$STATE_DIR" "$BUILD_DIR/elysian" maintenance-install-check || { [ "$WAS_ACTIVE" = 0 ] || systemctl start "$SERVICE_NAME"; die "实际切换前预检失败，原版本已恢复启动。"; }
  local item
  for item in config data state; do
    if [ -e "$STATE_DIR/.Elysian/$item" ]; then cp -a "$STATE_DIR/.Elysian/$item" "$INSTALL_BACKUP/data/$item" || { [ "$WAS_ACTIVE" = 0 ] || systemctl start "$SERVICE_NAME"; die "备份失败，原版本已重新启动。"; }; fi
  done
  INSTALL_ACTIVATED=1
}

# ---------- 主流程 ----------

main() {
  if [ "${1:-}" = "--uninstall" ]; then
    uninstall
    return 0
  fi
  [ "${1:-}" = "" ] || die "未知参数：$1。用法：bash scripts/install.sh [--uninstall]（环境变量 ELYSIAN_SMOKE=1 进入冒烟模式）。"
  trap install_exit EXIT
  printf '\n%sElysian 安装程序%s\n  源码目录：%s\n' "$C_BOLD" "$C_RESET" "$REPO_ROOT"
  section "检查运行环境"
  require_preflight
  section "安装系统依赖"
  apt_install_deps
  section "准备 Go 工具链"
  install_go
  section "准备 Bun 工具链"
  install_bun
  section "配置国内镜像"
  configure_mirrors
  section "构建 Elysian"
  build_release
  if [ -n "$SMOKE" ]; then
    section "冒烟验证"
    smoke_run
  else
    section "安装并切换版本"
    prepare_install_switch
    install_binary
    write_unit
    HOME="$STATE_DIR" "$PANEL_BIN" maintenance-bootstrap || die "前端防火墙规则核对失败，请处理冲突后重跑安装脚本。"
    ok "面板前端防火墙规则已核对"
    section "启动服务"
    start_service
    section "等待健康检查"
    wait_health
    INSTALL_COMMITTED=1
    print_summary
  fi
}

main "$@"
