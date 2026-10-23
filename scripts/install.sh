#!/usr/bin/env bash
# scripts/install.sh —— Elysian 源码一键部署（目标环境：Ubuntu/Debian 虚拟机，root 执行）。
#
# 用法：
#   bash scripts/install.sh             完整安装/升级（幂等，可重复执行）
#   ELYSIAN_SMOKE=1 bash scripts/install.sh
#                                       冒烟模式：跳过 systemd 与系统用户，仅装工具链、
#                                       构建、起进程、curl /api/health、清理（供
#                                       .zcode/go-migration/script-smoke.sh 在干净容器内调用）
#
# 卸载入口只有 scripts/uninstall.sh：默认保留面板数据，执行前会逐项询问 SQLite 数据、配置与凭据、
# 日志、备份/状态/临时文件是否删除，并可选移除 Elysian 写入的 Caddy 管理通道配置。
#
# 平台依赖：正式安装在「构建 Elysian」之后、安装切换事务之前自动检测并安装 Docker 与 Caddy——
# 已安装且可用则复用（不重装、不改动既有 daemon.json / Caddyfile），缺失则按经验证的官方命令
# 序列（Docker 官方 get.docker.com、Caddy 官方 cloudsmith apt 源）安装并真实验证（docker info、
# Engine API ≥ 1.41、systemctl is-active），失败打印中文原因与排查建议后非零退出；该阶段先于
# 切换事务，失败不回滚已部署面板。
#
# 终端输出：阶段计数由登记表自动派生；阶段头只显示编号与名称，双 TTY 下在终端底部维护
# 单条总体进度条，显示当前动作、转圈与实测耗时；标记统一为 ✓ 成功 / ✗ 失败 / ◉ 进行中 /
# ! 警告 / − 跳过；NO_COLOR 非空时只关颜色；重定向、非 TTY 或 TERM=dumb 自动退化为纯文本。
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
PLATFORM_TXN="${STATE_DIR}/.Elysian/backups/platform-install-active"
CADDY_RUNTIME_DROPIN="/etc/systemd/system/caddy.service.d/elysian-runtime.conf"
CADDY_TMPFILES="/etc/tmpfiles.d/elysian-caddy.conf"
UFW_DEFAULTS_FILE="/etc/default/ufw"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SMOKE="${ELYSIAN_SMOKE:-}"

# 构建依赖镜像：系统已预装 Go/Bun 时也强制传给构建进程；可显式覆盖。
GO_PROXY_DEFAULT="https://goproxy.cn|https://mirrors.aliyun.com/goproxy/|direct"
BUN_REGISTRY_DEFAULT="https://registry.npmmirror.com"
export GOPROXY="${ELYSIAN_GOPROXY:-${GOPROXY:-$GO_PROXY_DEFAULT}}"
export BUN_CONFIG_REGISTRY="${ELYSIAN_BUN_REGISTRY:-${BUN_CONFIG_REGISTRY:-$BUN_REGISTRY_DEFAULT}}"

# 终端渲染层（颜色、显示宽度、阶段进度、摘要排版）与卸载脚本共用。
if [ ! -r "$SCRIPT_DIR/tui.sh" ]; then
  printf '缺少 scripts/tui.sh，无法渲染安装界面。\n' >&2
  exit 1
fi
# shellcheck source=tui.sh
. "$SCRIPT_DIR/tui.sh"
TUI_FAIL_LABEL="安装失败"

STEP=0
STAGES=()
TOTAL_STEPS=0

section() { # section <阶段名>：计数来自登记表；名字与登记不符时提示而不中断
  tui_finish_stage
  STEP=$((STEP + 1))
  local registered="${STAGES[$((STEP - 1))]:-}"
  if [ -n "$registered" ] && [ "$registered" != "$1" ]; then
    warn "阶段名与登记表不一致：传入「$1」，登记为「$registered」（请同步 register_stages）"
  fi
  tui_stage "$STEP" "${TOTAL_STEPS:-0}" "$1"
  tui_begin_stage
}

# 阶段登记表：总数由此自动派生，新增阶段只改这里与 main 的调用序列，杜绝漏改计数的错位。
register_stages() {
  STAGES=(
    "检查运行环境"
    "安装系统依赖"
    "准备 Go 工具链"
    "准备 Bun 工具链"
    "配置国内镜像"
    "构建 Elysian"
  )
  if [ -n "$SMOKE" ]; then
    STAGES+=("冒烟验证")
  else
    STAGES+=(
      "检测并安装平台依赖"
      "安装并切换版本"
      "启用 SSH 与防火墙"
      "启动服务"
      "等待健康检查"
    )
  fi
  TOTAL_STEPS=${#STAGES[@]}
}

# 长命令统一出口：输出全部追加进日志文件；TTY 下在底部单条进度条中显示转圈与耗时，
# 非 TTY 保持静默，由调用方按结果打 ✓/✗ 行。退出码同时保留供失败摘要使用。
run_stage_command() { # run_stage_command <描述> <日志文件> <命令…>
  local desc="$1" log="$2" rc start=$SECONDS
  shift 2
  if [ "${SPINNER_ENABLED:-0}" != 1 ]; then
    if { "$@"; } >>"$log" 2>&1; then rc=0; else rc=$?; fi
    RUN_STAGE_EXIT_CODE="$rc"
    return "$rc"
  fi
  local pid frame_idx=0 spin='|/-\'
  "$@" >>"$log" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    tui_status_update "$desc … ${spin:$((frame_idx % 4)):1}  $(tui_duration $((SECONDS - start)))"
    frame_idx=$((frame_idx + 1))
    sleep 0.3
  done
  if wait "$pid" 2>>"$log"; then rc=0; else rc=$?; fi
  RUN_STAGE_EXIT_CODE="$rc"
  tui_status_update ""
  return "$rc"
}

stage_failure_reason() {
  local rc="${RUN_STAGE_EXIT_CODE:-1}" signal
  printf '退出码 %s' "$rc"
  if [ "$rc" -gt 128 ] && signal="$(kill -l "$((rc - 128))" 2>/dev/null)"; then
    printf '（信号 SIG%s）' "${signal#SIG}"
  fi
}

try_fetch() { # try_fetch <url> <输出文件> [policy]
  local policy="${3:-default}" rc
  local opts=(-fL --retry 3 --retry-delay 2 --connect-timeout 20)
  case "$policy" in
    bun-metadata) opts=(-fL --retry 0 --connect-timeout 5 --max-time 10 --speed-limit 1024 --speed-time 5) ;;
    bun-package) opts=(-fL --retry 0 --connect-timeout 10 --max-time 600 --speed-limit 102400 --speed-time 15) ;;
  esac
  # 所有下载静默进行，进度由安装阶段底部的单条进度条表示；-S 保留错误信息。
  opts+=(-sS)
  if curl "${opts[@]}" -o "$2" "$1"; then return 0; else rc=$?; fi
  # Bun 慢速、超时和 HTTP 错误直接交给镜像回退；仅连接类故障再尝试 IPv4。
  case "$policy" in
    bun-metadata) return "$rc" ;;
    bun-package) case "$rc" in 5|6|7|35) : ;; *) return "$rc" ;; esac ;;
  esac
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
    if try_fetch "$url" "$out"; then
      return 0
    fi
    info "下载源不可用，尝试下一个：$url"
  done
  return 1
}

fetch_bun_file() {
  local out="$1" url rc
  shift
  for url in "$@"; do
    info "尝试下载 bun：$url"
    if try_fetch "$url" "$out" bun-package; then return 0; else rc=$?; fi
    rm -f "$out" || return 1
    if [ "$rc" = 28 ]; then
      warn "bun 下载过慢或超时，切换下载源：$url"
    else
      warn "bun 下载源不可用（curl 退出码 ${rc}），切换下载源：$url"
    fi
  done
  return 1
}

# ---------- 环境检测 ----------

map_arch() { # map_arch <uname -m 串>：支持时设置 GO_ARCH/BUN_ARCH 并返回 0（纯判定，可 source 测试）
  case "$1" in
    x86_64)        GO_ARCH="amd64"; BUN_ARCH="x64" ;;
    aarch64|arm64) GO_ARCH="arm64"; BUN_ARCH="aarch64" ;;
    *) return 1 ;;
  esac
}

detect_arch() {
  if ! map_arch "$(uname -m)"; then
    die "不支持的 CPU 架构：$(uname -m)。本脚本仅支持 x86_64 与 aarch64（arm64）。"
  fi
  info "架构：$(uname -m)（Go linux/${GO_ARCH}，bun linux/${BUN_ARCH}）"
}

distro_family_supported() { # distro_family_supported <ID 与 ID_LIKE 拼接串>：Debian/Ubuntu 系返回 0
  case "$1" in
    *debian*|*ubuntu*) return 0 ;;
    *) return 1 ;;
  esac
}

detect_distro() {
  [ -r /etc/os-release ] || die "未找到 /etc/os-release，无法识别发行版。本脚本支持 Ubuntu/Debian。"
  # shellcheck disable=SC1091
  . /etc/os-release
  local family="${ID:-}${ID_LIKE:+ ${ID_LIKE}}"
  if ! distro_family_supported "$family"; then
    die "不支持的发行版：${PRETTY_NAME:-未知}。本脚本支持 Ubuntu/Debian（apt 系）。"
  fi
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
  [ -x /usr/sbin/sshd ] || need+=(openssh-server)
  command -v ss >/dev/null 2>&1 || need+=(iproute2)
  if ! command -v runuser >/dev/null 2>&1 || ! command -v flock >/dev/null 2>&1; then need+=(util-linux); fi
  if [ "${#need[@]}" -eq 0 ]; then
    ok "系统依赖（curl / ca-certificates / unzip / ufw / OpenSSH）已齐备"
    return 0
  fi
  local log
  log="$(mktemp /tmp/elysian-apt.XXXXXX)"
  info "安装系统依赖：${need[*]}（详细输出写入 ${log}，失败时回显并保留日志）"
  if ! apt-get update -qq >>"$log" 2>&1; then
    tail -n 40 "$log" >&2
    die "apt-get update 失败，请检查虚拟机的 apt 源与网络后重跑（完整日志：${log}）。"
  fi
  if ! run_stage_command "安装系统依赖" "$log" env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${need[@]}"; then
    tail -n 40 "$log" >&2
    die "apt-get install ${need[*]} 失败，请排查后重跑（完整日志：${log}）。"
  fi
  rm -f "$log"
  ok "系统依赖已就绪：${need[*]}"
}

# ---------- 平台依赖（Docker 与 Caddy；命令序列逐字移植自面板原依赖引导的宿主脚本） ----------
# 阶段位于切换事务（prepare_install_switch）之前：任一步失败直接 die 停止后续阶段，不会触发
# install_exit 对已部署面板的回滚；全部步骤幂等——已装且可用则复用、已是目标配置则零写，重跑
# 不破坏既有配置与数据。面板内的依赖探测仍在线，安装后缺口以探测结果为准。

DOCKER_INSTALL_URL="https://get.docker.com"
CADDY_GPG_KEY_URL="https://dl.cloudsmith.io/public/caddy/stable/gpg.key"
CADDY_APT_LIST_URL="https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt"
CADDY_KEYRING="/usr/share/keyrings/caddy-stable-archive-keyring.gpg"
CADDY_APT_LIST="/etc/apt/sources.list.d/caddy-stable.list"
CADDYFILE_PATH="/etc/caddy/Caddyfile"
CADDYFILE_MAX_BYTES=262144   # 与面板 readCaddyfileScript 的上限一致：超过即拒绝改写

docker_api_version_ok() { # docker_api_version_ok <Engine ApiVersion 串>：≥ 1.41 返回 0（面板 assertEngineAPI 同口径）
  local v="${1:-}" major minor
  [ -n "$v" ] || return 1
  major="${v%%.*}"
  minor="${v#*.}"; minor="${minor%%.*}"
  [ "$minor" != "$v" ] || minor=""
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  case "$minor" in ''|*[!0-9]*) return 1 ;; esac
  [ "$major" -gt 1 ] && return 0
  [ "$major" -eq 1 ] && [ "$minor" -ge 41 ] && return 0
  return 1
}

docker_engine_socket() {
  local sock="${ELYSIAN_DOCKER_SOCKET:-}"
  if [ -z "$sock" ] && [ -r "$ENV_FILE" ]; then
    sock="$(platform_helper env-read "$ENV_FILE" ELYSIAN_DOCKER_SOCKET)" || return 1
  fi
  platform_helper socket "${sock:-/var/run/docker.sock}"
}

docker_engine() {
  DOCKER_HOST= DOCKER_CONTEXT= DOCKER_TLS= DOCKER_TLS_VERIFY= DOCKER_CERT_PATH= DOCKER_API_VERSION= \
    docker --host "unix://${DOCKER_ENGINE_SOCKET:-/var/run/docker.sock}" "$@"
}

docker_install_or_reuse() {
  DOCKER_INSTALLED_THIS_RUN=0
  if command -v docker >/dev/null 2>&1; then
    if docker_engine info >/dev/null 2>&1; then
      ok "已安装 Docker（$(docker --version 2>/dev/null || echo 版本未知)），守护进程在响应，复用现有安装"
      return 0
    fi
    info "检测到 docker 命令但守护进程未响应，先尝试直接拉起服务（不改动既有安装）"
    systemctl start docker >/dev/null 2>&1 || true
    if docker_engine info >/dev/null 2>&1; then
      ok "已拉起既有 Docker 守护进程，复用现有安装（未改动任何配置）"
      return 0
    fi
    die "Docker 已安装但守护进程未响应（docker info 失败）。为不破坏既有安装，脚本不会在其上重装；请先排查：journalctl -u docker -n 50 --no-pager，修复后重跑本脚本。"
  fi
  command -v curl >/dev/null 2>&1 || die "缺少 curl，无法下载 Docker 官方安装脚本。"
  local log tmp
  tmp="$(mktemp /tmp/elysian-get-docker.XXXXXX)" || die "无法创建 Docker 安装脚本暂存文件。"
  log="$(mktemp /tmp/elysian-docker-install.XXXXXX)"
  info "经官方脚本安装 Docker（${DOCKER_INSTALL_URL}；详细输出写入 ${log}）"
  if ! curl -fsSL "$DOCKER_INSTALL_URL" -o "$tmp" >>"$log" 2>&1; then
    rm -f "$tmp"
    tail -n 40 "$log" >&2
    die "下载 Docker 官方安装脚本失败（${DOCKER_INSTALL_URL} 不可达），请检查出网后重跑（完整日志：${log}）。"
  fi
  if ! run_stage_command "安装 Docker（官方脚本）" "$log" env DEBIAN_FRONTEND=noninteractive sh "$tmp"; then
    rm -f "$tmp"
    tail -n 40 "$log" >&2
    die "Docker 安装失败，请查看上方日志排查（完整日志：${log}）。常见原因：网络中断、apt 源异常或磁盘空间不足；修复后重跑本脚本，已完成的步骤会自动跳过。"
  fi
  rm -f "$tmp" "$log"
  DOCKER_INSTALLED_THIS_RUN=1
  ok "Docker 官方安装脚本执行完成"
}

enable_docker() {
  command -v systemctl >/dev/null 2>&1 || die "当前系统没有 systemctl，无法设置 Docker 开机自启。"
  systemctl enable --now docker >/dev/null 2>&1 \
    || die "启用 Docker 服务（systemctl enable --now docker）失败。排查：journalctl -u docker -n 50 --no-pager。"
  systemctl is-active --quiet docker \
    || die "Docker 服务未处于 active 状态。排查：journalctl -u docker -n 50 --no-pager。"
  ok "Docker 已启动并设为开机自启（systemd active）"
}

verify_docker() { # 真实验证：守护进程响应 + Engine API ≥ 1.41（面板探测同口径），只认命令存在不算通过
  docker_engine info >/dev/null 2>&1 \
    || die "Docker 守护进程未响应（目标 ${DOCKER_ENGINE_SOCKET:-/var/run/docker.sock} 的 docker info 失败）。排查：journalctl -u docker -n 50 --no-pager；确认目标 socket 存在后重跑。"
  local api
  api="$(docker_engine version --format '{{.Server.APIVersion}}' 2>/dev/null || true)"
  if ! docker_api_version_ok "$api"; then
    die "Docker Engine API 版本过低（${api:-未知}），面板要求 ≥ 1.41；请升级 Docker 后重跑本脚本。"
  fi
  ok "Docker 验证通过：$(docker --version 2>/dev/null || echo 已安装)，Engine API ${api}（≥ 1.41）"
}

caddy_admin_socket() { # 面板同款覆盖次序：环境变量 → /etc/default/elysian（EnvironmentFile）→ 缺省 /run/caddy/admin.sock
  local sock="${ELYSIAN_CADDY_SOCKET:-}"
  if [ -z "$sock" ] && [ -r "$ENV_FILE" ]; then
    sock="$(platform_helper env-read "$ENV_FILE")" || return 1
  fi
  platform_helper socket "${sock:-/run/caddy/admin.sock}"
}

platform_helper() { bun "$REPO_ROOT/scripts/install-platform.mjs" "$@"; }

trim_line() { # 去除首尾空白（空格与制表符）
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

caddyfile_ensure_admin() { # caddyfile_ensure_admin <文件内容> <socket 路径>
  # 面板 ensureCaddyAdminSocket 的 bash 移植：只改全局段，把 admin 指令收成恰好一条目标值，站点块原样。
  # 结果放 CADDYFILE_RESULT；返回 0=需要写盘，1=已满足（零写），2=拒绝改写（全局段括号不配对）。
  local content="$1" socket="$2"
  local directive="admin unix/${socket}"
  local TAB=$'\t'
  content="${content//$'\r\n'/$'\n'}"
  local -a lines=()
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    lines+=("$line")
  done <<<"$content"
  # 全局段起始：跳过空行与 # 注释，首个非跳过行必须是单独的“{”，否则视为没有全局段。
  local i trimmed start=-1
  for i in "${!lines[@]}"; do
    trimmed="$(trim_line "${lines[$i]}")"
    if [ -z "$trimmed" ] || [ "${trimmed#\#}" != "$trimmed" ]; then
      continue
    fi
    if [ "$trimmed" = "{" ]; then
      start=$i
    fi
    break
  done
  local body
  if [ "$start" -eq -1 ]; then
    body="$(trim_line "$content")"
    if [ -z "$body" ]; then
      CADDYFILE_RESULT="{"$'\n'"${TAB}${directive}"$'\n'"}"$'\n'
    else
      CADDYFILE_RESULT="{"$'\n'"${TAB}${directive}"$'\n'"}"$'\n\n'"${body}"$'\n'
    fi
    return 0
  fi
  # 按括号深度配对找全局段结束行（从“{”行起算，之后首个深度归零的行即结束）。
  local depth=0 end=-1 idx opens closes
  for ((idx = start; idx < ${#lines[@]}; idx++)); do
    opens="$(grep -o '{' <<<"${lines[$idx]}" | wc -l)"
    closes="$(grep -o '}' <<<"${lines[$idx]}" | wc -l)"
    depth=$((depth + opens - closes))
    if [ "$idx" -gt "$start" ] && [ "$depth" -eq 0 ]; then
      end=$idx
      break
    fi
  done
  if [ "$end" -eq -1 ]; then
    return 2
  fi
  local -a admin_indexes=()
  for ((idx = start + 1; idx < end; idx++)); do
    if [[ "${lines[$idx]}" =~ ^[[:space:]]*admin[[:space:]]+ ]]; then
      admin_indexes+=("$idx")
    fi
  done
  if [ "${#admin_indexes[@]}" -eq 1 ] && [ "$(trim_line "${lines[${admin_indexes[0]}]}")" = "$directive" ]; then
    return 1
  fi
  local -a kept=() out=()
  local j is_admin
  for i in "${!lines[@]}"; do
    is_admin=0
    for j in ${admin_indexes[@]+"${admin_indexes[@]}"}; do
      if [ "$i" = "$j" ]; then is_admin=1; break; fi
    done
    if [ "$is_admin" = 0 ]; then kept+=("${lines[$i]}"); fi
  done
  # 在段首“{”之后插恰好一条目标 admin（对齐 kept.splice(start+1, 0, …)）。
  for i in "${!kept[@]}"; do
    out+=("${kept[$i]}")
    if [ "$i" -eq "$start" ]; then out+=("${TAB}${directive}"); fi
  done
  CADDYFILE_RESULT=""
  for i in "${!out[@]}"; do
    CADDYFILE_RESULT+="${out[$i]}"$'\n'
  done
  return 0
}

prepare_caddy_admin_file() { # 只生成候选文件；发布与恢复由平台依赖事务负责。
  local socket="$1" file="$2" output="$3" content="" bytes rc=0
  if [ -L "$file" ]; then
    warn "Caddyfile 是符号链接，无法保证只修改预期文件；请用既有方式配置管理通道后重试"
    return 1
  fi
  if [ -e "$file" ]; then
    bytes="$(wc -c <"$file" | tr -d '[:space:]')" || return 1
    if [ "$bytes" -gt "$CADDYFILE_MAX_BYTES" ]; then
      warn "Caddyfile 过大（${bytes} 字节），拒绝自动改写"
      return 1
    fi
    content="$(cat "$file")" || return 1
  fi
  caddyfile_ensure_admin "$content" "$socket" || rc=$?
  if [ "$rc" -ge 2 ]; then
    warn "Caddyfile 全局段无法可靠解析，拒绝自动改写"
    return 1
  fi
  if [ "$rc" = 1 ]; then
    cp -p "$file" "$output"
  else
    printf '%s' "$CADDYFILE_RESULT" >"$output"
  fi
}

caddy_install_step() { # caddy_install_step <描述> <命令…>：输出并入 Caddy 安装日志，失败回显后停止
  local desc="$1"
  shift
  if ! run_stage_command "$desc" "$CADDY_DEPS_LOG" "$@"; then
    rm -f "$CADDY_DEPS_GPG"
    tail -n 40 "$CADDY_DEPS_LOG" >&2
    die "Caddy 安装在「${desc}」一步失败，请查看上方日志排查（完整日志：${CADDY_DEPS_LOG}）。常见原因：网络中断或 apt 源异常；修复后重跑本脚本即可续装。"
  fi
}

install_caddy() {
  local existing_probe
  if [ -n "${CADDY_ADMIN_SOCKET:-}" ]; then
    existing_probe="$(mktemp /tmp/elysian-caddy-probe.XXXXXX)" || return 1
    if platform_caddy_request "unix:$CADDY_ADMIN_SOCKET" GET "$existing_probe"; then
      rm -f "$existing_probe"
      CADDY_INSTALLED_THIS_RUN=0
      ok "既有 Caddy 管理 API 可用，复用已有运行时"
      return 0
    fi
    rm -f "$existing_probe"
  fi
  if command -v caddy >/dev/null 2>&1; then
    ok "已安装 Caddy（$(caddy version 2>/dev/null || echo 版本未知)），复用现有安装"
    CADDY_INSTALLED_THIS_RUN=0
    return 0
  fi
  command -v apt-get >/dev/null 2>&1 || die "当前系统没有 apt-get，只能在 Debian 或 Ubuntu 上代为安装 Caddy。"
  CADDY_DEPS_LOG="$(mktemp /tmp/elysian-caddy-install.XXXXXX)"
  CADDY_DEPS_GPG="$(mktemp /tmp/elysian-caddy-gpg.XXXXXX)" || die "无法创建 Caddy 公钥暂存文件。"
  info "经 Caddy 官方 cloudsmith apt 源安装（详细输出写入 ${CADDY_DEPS_LOG}）"
  caddy_install_step "刷新 apt 索引" apt-get update
  caddy_install_step "安装签名与传输工具（debian-keyring / gpg 等）" env DEBIAN_FRONTEND=noninteractive apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg
  install -d -m 0755 /usr/share/keyrings || die "创建 /usr/share/keyrings 失败。"
  rm -f "$CADDY_KEYRING"
  caddy_install_step "下载 Caddy 官方 GPG 公钥" curl -1sLf "$CADDY_GPG_KEY_URL" -o "$CADDY_DEPS_GPG"
  caddy_install_step "校验公钥文件非空" test -s "$CADDY_DEPS_GPG"
  caddy_install_step "导入公钥到 keyring" gpg --batch --dearmor -o "$CADDY_KEYRING" "$CADDY_DEPS_GPG"
  caddy_install_step "写入 Caddy 官方 apt 源" curl -1sLf "$CADDY_APT_LIST_URL" -o "$CADDY_APT_LIST"
  caddy_install_step "校验源文件非空" test -s "$CADDY_APT_LIST"
  caddy_install_step "刷新 apt 索引（含 Caddy 源）" apt-get update
  caddy_install_step "安装 caddy" env DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
  rm -f "$CADDY_DEPS_GPG"
  command -v caddy >/dev/null 2>&1 \
    || { tail -n 40 "$CADDY_DEPS_LOG" >&2; die "Caddy 安装后仍未找到 caddy 命令，请查看日志排查（完整日志：${CADDY_DEPS_LOG}）。"; }
  rm -f "$CADDY_DEPS_LOG"
  CADDY_INSTALLED_THIS_RUN=1
  ok "Caddy 安装完成：$(caddy version 2>/dev/null || echo 版本未知)"
}

acquire_install_locks() {
  [ "${INSTALL_LOCKS_HELD:-0}" = 1 ] && return 0
  local tasks="$STATE_DIR/.Elysian/state/panel-maintenance"
  mkdir -p "$tasks" || return 1
  chmod 0700 "$tasks" || return 1
  exec 9>"$tasks/worker.lock"
  flock -w 25 -x 9 || { warn "另一项面板维护任务正在执行（等待已达 25 秒）"; return 1; }
  exec 8>"$tasks/operations.lock"
  if ! flock -w 90 -x 8; then
    exec 9>&-
    warn "面板业务写操作仍在执行（等待已达 90 秒）"
    return 1
  fi
  INSTALL_LOCKS_HELD=1
}

release_install_locks() {
  exec 8>&- 9>&-
  INSTALL_LOCKS_HELD=0
}

platform_file_path() {
  case "$1" in
    caddyfile) printf '%s' "$CADDYFILE_PATH" ;;
    runtime) printf '%s' "$CADDY_RUNTIME_DROPIN" ;;
    tmpfiles) printf '%s' "$CADDY_TMPFILES" ;;
    environment) printf '%s' "$ENV_FILE" ;;
    *) return 1 ;;
  esac
}

begin_platform_transaction() {
  [ ! -e "$PLATFORM_TXN" ] || { warn "平台依赖事务尚未恢复：$PLATFORM_TXN"; return 1; }
  (umask 077; mkdir -p "$PLATFORM_TXN/snapshots" "$PLATFORM_TXN/changed") || return 1
  chmod 0700 "$PLATFORM_TXN" || return 1
  local active="unknown" enabled="unknown"
  if [ "${1:-1}" = 1 ]; then
    active="$(systemctl show -p ActiveState --value caddy)" || return 1
    enabled="$(systemctl show -p UnitFileState --value caddy)" || return 1
    case "$active" in active|inactive|failed) : ;; *) warn "Caddy 服务处于过渡或未知状态，暂不接入"; return 1 ;; esac
    case "$enabled" in
      enabled|disabled|enabled-runtime) : ;;
      *) warn "Caddy 自启状态 ${enabled:-未知} 无法精确恢复，暂不自动接入；请先手工准备管理 API"; return 1 ;;
    esac
  fi
  if [ "$active" = active ]; then active=1; elif [ "$active" != unknown ]; then active=0; fi
  printf '%s\n' "$active" >"$PLATFORM_TXN/was-active" || return 1
  printf '%s\n' "$enabled" >"$PLATFORM_TXN/was-enabled" || return 1
  printf '%s\n' "$CADDY_ADMIN_SOCKET" >"$PLATFORM_TXN/target-socket" || return 1
  : >"$PLATFORM_TXN/pending" || return 1
}

platform_make_directory() {
  local directory="$1"
  [ -d "$directory" ] && return 0
  [ ! -e "$directory" ] && [ ! -L "$directory" ] && [ -d "$(dirname "$directory")" ] || return 1
  printf '%s\n' "$directory" >>"$PLATFORM_TXN/new-directories" || return 1
  mkdir -m 0755 "$directory"
}

platform_write_file() { # 原文件快照先于变更标记，标记先于原子发布，便于任意中断点恢复。
  local key="$1" source="$2" mode="$3" file snapshot temporary
  file="$(platform_file_path "$key")" || return 1
  if [ -f "$file" ] && cmp -s "$file" "$source"; then return 0; fi
  [ ! -L "$file" ] && { [ ! -e "$file" ] || [ -f "$file" ]; } || return 1
  snapshot="$PLATFORM_TXN/snapshots/$key"
  mkdir -p "$snapshot" || return 1
  if [ ! -f "$snapshot/ready" ]; then
    if [ -f "$file" ]; then
      cp -p "$file" "$snapshot/original" || return 1
      : >"$snapshot/present" || return 1
    fi
    : >"$snapshot/ready" || return 1
  fi
  platform_make_directory "$(dirname "$file")" || return 1
  temporary="$(mktemp "$(dirname "$file")/.elysian-platform.XXXXXX")" || return 1
  if [ -f "$file" ]; then
    cp -p "$file" "$temporary" || { rm -f "$temporary"; return 1; }
  else
    chmod "$mode" "$temporary" || { rm -f "$temporary"; return 1; }
  fi
  if ! cat "$source" >"$temporary"; then rm -f "$temporary"; return 1; fi
  if ! : >"$PLATFORM_TXN/changed/$key"; then rm -f "$temporary"; return 1; fi
  mv -f "$temporary" "$file" || { rm -f "$temporary"; return 1; }
}

platform_caddy_request() { # 响应正文可能含证书，永不写入终端或普通安装日志。
  local endpoint="$1" method="$2" output="$3" input="${4:-}" status
  local -a options=(-sS --noproxy '*' --connect-timeout 2 --max-time 5 --max-filesize 4194304 -X "$method" -o "$output" -w '%{http_code}')
  case "$endpoint" in
    unix:/*) options+=(--unix-socket "${endpoint#unix:}" 'http://localhost/config/') ;;
    tcp:*) options+=("http://${endpoint#tcp:}/config/") ;;
    *) return 1 ;;
  esac
  if [ "$method" = POST ]; then
    options[${#options[@]}-1]="${options[${#options[@]}-1]%config/}load"
    options+=(-H 'Content-Type: application/json' --data-binary "@$input")
  fi
  status="$(curl "${options[@]}" 2>/dev/null)" || return 1
  if [ "$method" = GET ]; then
    [ "$status" = 200 ] || return 1
    platform_helper validate "$output" 2>/dev/null
  else
    case "$status" in 2??) return 0 ;; *) return 1 ;; esac
  fi
}

wait_caddy_api() {
  platform_helper wait "$1" "$2" "${3:-}" "${CADDY_VERIFY_ATTEMPTS:-10}" "${CADDY_VERIFY_INTERVAL:-1}" "${CADDY_VERIFY_TIMEOUT:-30}"
}

restore_platform_transaction() {
  [ -d "$PLATFORM_TXN" ] || return 0
  if [ -f "$PLATFORM_TXN/committed" ] || [ ! -f "$PLATFORM_TXN/pending" ]; then
    rm -rf "$PLATFORM_TXN"
    return 0
  fi
  warn "恢复未提交的平台依赖配置事务：$PLATFORM_TXN"
  local key file snapshot temporary result=0 old_endpoint target_socket was_enabled directory
  for key in caddyfile runtime tmpfiles environment; do
    [ -f "$PLATFORM_TXN/changed/$key" ] || continue
    file="$(platform_file_path "$key")" || { result=1; continue; }
    snapshot="$PLATFORM_TXN/snapshots/$key"
    if [ ! -f "$snapshot/ready" ]; then result=1; continue; fi
    if [ -f "$snapshot/present" ]; then
      temporary="$(mktemp "$(dirname "$file")/.elysian-restore.XXXXXX")" || { result=1; continue; }
      if cp -p "$snapshot/original" "$temporary" && mv -f "$temporary" "$file"; then :; else rm -f "$temporary"; result=1; fi
    else
      rm -f "$file" || result=1
    fi
  done
  if [ -f "$PLATFORM_TXN/changed/runtime" ] || [ -f "$PLATFORM_TXN/changed/tmpfiles" ]; then
    systemctl daemon-reload || result=1
  fi
  if [ -f "$PLATFORM_TXN/runtime-changed" ]; then
    old_endpoint="$(cat "$PLATFORM_TXN/old-endpoint")"
    target_socket="$(cat "$PLATFORM_TXN/target-socket")"
    if ! platform_caddy_request "$old_endpoint" POST "$PLATFORM_TXN/restore-response" "$PLATFORM_TXN/runtime.original.json" &&
       ! platform_caddy_request "unix:$target_socket" POST "$PLATFORM_TXN/restore-response" "$PLATFORM_TXN/runtime.original.json"; then
      systemctl restart caddy >/dev/null 2>&1 || result=1
      if ! wait_caddy_api "$old_endpoint" "$PLATFORM_TXN/restored.json" ||
         ! platform_caddy_request "$old_endpoint" POST "$PLATFORM_TXN/restore-response" "$PLATFORM_TXN/runtime.original.json"; then result=1; fi
    fi
    wait_caddy_api "$old_endpoint" "$PLATFORM_TXN/restored.json" "$PLATFORM_TXN/runtime.original.json" || result=1
  fi
  if [ -f "$PLATFORM_TXN/service-changed" ]; then
    if [ "$(cat "$PLATFORM_TXN/was-active")" = 0 ]; then systemctl stop caddy >/dev/null 2>&1 || result=1; fi
    was_enabled="$(cat "$PLATFORM_TXN/was-enabled")"
    case "$was_enabled" in
      enabled) systemctl enable caddy >/dev/null 2>&1 || result=1 ;;
      enabled-runtime) systemctl disable caddy >/dev/null 2>&1 && systemctl enable --runtime caddy >/dev/null 2>&1 || result=1 ;;
      disabled) systemctl disable caddy >/dev/null 2>&1 || result=1 ;;
      *) result=1 ;;
    esac
  fi
  if [ -f "$PLATFORM_TXN/new-https-rule" ]; then
    local current_rules
    if current_rules="$(ufw show added)"; then
      if printf '%s\n' "$current_rules" | grep -Eq '^ufw allow 80,443/tcp( comment .*)?$'; then
        ufw --force delete allow 80,443/tcp >/dev/null 2>&1 || result=1
      fi
    else
      result=1
    fi
  fi
  if [ -f "$PLATFORM_TXN/new-directories" ]; then
    while IFS= read -r directory; do rmdir "$directory" 2>/dev/null || true; done <"$PLATFORM_TXN/new-directories"
  fi
  if [ "$result" != 0 ]; then
    warn "平台依赖恢复未完成；备份已保留。请核对 Caddy 日志与 ${PLATFORM_TXN}，修复后重跑安装程序"
    return 1
  fi
  local restored_record="${PLATFORM_TXN}-restored-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mv "$PLATFORM_TXN" "$restored_record" || return 1
  ok "原 Caddy 配置、运行路由与环境设置已恢复（私有恢复记录：${restored_record}）"
}

commit_platform_transaction() {
  : >"$PLATFORM_TXN/committed" || return 1
  rm -rf "$PLATFORM_TXN"
}

persist_platform_sockets() {
  local key value
  for key in ELYSIAN_DOCKER_SOCKET ELYSIAN_CADDY_SOCKET; do
    value="${!key:-}"
    [ -n "$value" ] || continue
    platform_helper env-write "$ENV_FILE" "$value" "$PLATFORM_TXN/environment.candidate" "$key" || return 1
    platform_write_file environment "$PLATFORM_TXN/environment.candidate" 0600 || return 1
  done
}

connect_caddy_safely() {
  local work exec_start service_user service_group old_endpoint parent temporary active
  work="$(mktemp -d /tmp/elysian-caddy-check.XXXXXX)" || return 1
  chmod 0700 "$work" || { rm -rf "$work"; return 1; }
  if platform_caddy_request "unix:$CADDY_ADMIN_SOCKET" GET "$work/ready.json"; then
    rm -rf "$work"
    begin_platform_transaction 0 || return 1
    persist_platform_sockets || return 1
    CADDY_API_VERIFIED=1
    ok "Caddy 管理 API 已可用，复用现有运行配置（未改写 Caddyfile、未重启）"
    return 0
  fi
  if ! systemctl cat caddy.service >/dev/null 2>&1; then
    rm -rf "$work"
    warn "Caddy 目标管理 API 未就绪，且没有可核对的 systemd 单元；请用既有管理方式配置并启动 unix/${CADDY_ADMIN_SOCKET} 后重跑"
    return 1
  fi
  if [ -L "$CADDY_ADMIN_SOCKET" ] || { [ -e "$CADDY_ADMIN_SOCKET" ] && [ ! -S "$CADDY_ADMIN_SOCKET" ]; }; then
    rm -rf "$work"
    warn "目标 Caddy socket 路径已被其他文件或符号链接占用，拒绝覆盖"
    return 1
  fi
  exec_start="$(systemctl show -p ExecStart --value caddy)" || { rm -rf "$work"; return 1; }
  service_user="$(systemctl show -p User --value caddy)" || { rm -rf "$work"; return 1; }
  service_group="$(systemctl show -p Group --value caddy)" || { rm -rf "$work"; return 1; }
  if [ "$service_user" != caddy ] || { [ -n "$service_group" ] && [ "$service_group" != caddy ]; } ||
     ! platform_helper service "$exec_start" "$CADDYFILE_PATH"; then
    rm -rf "$work"
    warn "无法保证既有 Caddy 的启动方式、运行身份与配置文件一致，未改动任何配置；请先手工准备管理 API"
    return 1
  fi
  if [ -L "$CADDYFILE_PATH" ] || [ ! -f "$CADDYFILE_PATH" ] ||
     [ "$(wc -c <"$CADDYFILE_PATH" | tr -d '[:space:]')" -gt "$CADDYFILE_MAX_BYTES" ] ||
     ! caddy adapt --config "$CADDYFILE_PATH" --adapter caddyfile >"$work/disk.json" 2>"$work/adapt.log" ||
     ! old_endpoint="$(platform_helper endpoint "$work/disk.json")"; then
    rm -rf "$work"
    warn "无法安全识别磁盘 Caddyfile 的旧管理端点，拒绝自动接入"
    return 1
  fi
  active="$(systemctl show -p ActiveState --value caddy)" || { rm -rf "$work"; return 1; }
  case "$active" in active|inactive|failed) : ;; *) rm -rf "$work"; return 1 ;; esac
  if [ "$active" = active ]; then
    if ! platform_caddy_request "$old_endpoint" GET "$work/runtime.json"; then
      rm -rf "$work"
      warn "无法读取已有 Caddy 的真实运行配置，不能保证保留路由及证书；请先修复旧管理 API 后重试"
      return 1
    fi
  fi
  begin_platform_transaction || { rm -rf "$work"; return 1; }
  if { [ "$active" = active ] && [ "$(cat "$PLATFORM_TXN/was-active")" != 1 ]; } ||
     { [ "$active" != active ] && [ "$(cat "$PLATFORM_TXN/was-active")" != 0 ]; }; then
    rm -rf "$work"
    warn "Caddy 服务状态在预检期间发生变化，请稍后重试"
    return 1
  fi
  mv "$work" "$PLATFORM_TXN/preflight" || return 1
  printf '%s\n' "$old_endpoint" >"$PLATFORM_TXN/old-endpoint" || return 1
  if [ -f "$PLATFORM_TXN/preflight/runtime.json" ]; then
    cp -p "$PLATFORM_TXN/preflight/runtime.json" "$PLATFORM_TXN/runtime.original.json" || return 1
    platform_helper connect "$PLATFORM_TXN/runtime.original.json" "$CADDY_ADMIN_SOCKET" "$PLATFORM_TXN/runtime.candidate.json" || return 1
  fi
  prepare_caddy_admin_file "$CADDY_ADMIN_SOCKET" "$CADDYFILE_PATH" "$PLATFORM_TXN/Caddyfile.candidate" || return 1
  temporary="$(mktemp "$(dirname "$CADDYFILE_PATH")/.elysian-validate.XXXXXX")" || return 1
  if ! cp "$PLATFORM_TXN/Caddyfile.candidate" "$temporary" ||
     ! caddy validate --config "$temporary" --adapter caddyfile >"$PLATFORM_TXN/validate.log" 2>&1 ||
     ! caddy adapt --config "$temporary" --adapter caddyfile >"$PLATFORM_TXN/disk.candidate.json" 2>>"$PLATFORM_TXN/validate.log" ||
     ! platform_helper connect "$PLATFORM_TXN/preflight/disk.json" "$CADDY_ADMIN_SOCKET" "$PLATFORM_TXN/disk.expected.json" ||
     ! platform_helper equal-caddyfile "$PLATFORM_TXN/disk.expected.json" "$PLATFORM_TXN/disk.candidate.json" "$CADDYFILE_PATH" "$temporary" >>"$PLATFORM_TXN/validate.log" 2>&1; then
    rm -f "$temporary"
    warn "Caddy 候选配置校验或配置保留核对失败；原文件与运行配置未改动，诊断记录：$PLATFORM_TXN/validate.log"
    return 1
  fi
  rm -f "$temporary"
  parent="$(dirname "$CADDY_ADMIN_SOCKET")"
  if [ ! -d "$parent" ]; then
    platform_make_directory "$parent" || return 1
    chown caddy:caddy "$parent" || return 1
  fi
  runuser -u caddy -- test -w "$parent" || { warn "Caddy 无权写入目标 socket 目录：$parent"; return 1; }
  if [[ "$parent" == /run/* ]]; then
    printf '[Service]\nRuntimeDirectory=%s\nRuntimeDirectoryMode=0755\n' "${parent#/run/}" >"$PLATFORM_TXN/runtime.candidate" || return 1
    if [ -f "$CADDY_RUNTIME_DROPIN" ] && ! cmp -s "$CADDY_RUNTIME_DROPIN" "$PLATFORM_TXN/runtime.candidate" &&
       [ "$(cat "$CADDY_RUNTIME_DROPIN")" != "$(printf '[Service]\nRuntimeDirectory=caddy\nRuntimeDirectoryMode=0755\n')" ]; then
      warn "既有 Elysian Caddy drop-in 包含自定义内容，拒绝覆盖：$CADDY_RUNTIME_DROPIN"
      return 1
    fi
    platform_write_file runtime "$PLATFORM_TXN/runtime.candidate" 0644 || return 1
  fi
  printf 'd %s 0755 caddy caddy -\n' "$parent" >"$PLATFORM_TXN/tmpfiles.candidate" || return 1
  if [ -f "$CADDY_TMPFILES" ] && ! cmp -s "$CADDY_TMPFILES" "$PLATFORM_TXN/tmpfiles.candidate" &&
     [ "$(cat "$CADDY_TMPFILES")" != 'd /run/caddy 0755 caddy caddy -' ]; then
    warn "既有 Elysian Caddy tmpfiles 包含自定义内容，拒绝覆盖：$CADDY_TMPFILES"
    return 1
  fi
  platform_write_file tmpfiles "$PLATFORM_TXN/tmpfiles.candidate" 0644 || return 1
  platform_write_file caddyfile "$PLATFORM_TXN/Caddyfile.candidate" 0644 || return 1
  persist_platform_sockets || return 1
  systemctl daemon-reload || return 1
  : >"$PLATFORM_TXN/service-changed" || return 1
  if [ -f "$PLATFORM_TXN/runtime.original.json" ]; then
    : >"$PLATFORM_TXN/runtime-changed" || return 1
    platform_caddy_request "$old_endpoint" POST "$PLATFORM_TXN/load-response" "$PLATFORM_TXN/runtime.candidate.json" || return 1
    wait_caddy_api "unix:$CADDY_ADMIN_SOCKET" "$PLATFORM_TXN/verified.json" "$PLATFORM_TXN/runtime.candidate.json" || return 1
  else
    systemctl start caddy >/dev/null 2>&1 || return 1
    wait_caddy_api "unix:$CADDY_ADMIN_SOCKET" "$PLATFORM_TXN/verified.json" || return 1
  fi
  systemctl enable caddy >/dev/null 2>&1 || return 1
  systemctl is-active --quiet caddy || return 1
  CADDY_API_VERIFIED=1
  ok "Caddy 管理 API 验证通过，原运行路由与证书保持完整，已确认开机自启"
}

install_platform_deps() {
  HOME="$STATE_DIR" "$BUILD_DIR/elysian" maintenance-install-check || die "平台依赖安装预检失败，原服务与平台依赖未改动。"
  info "Docker：容器、数据库与网站功能的运行时依赖"
  DOCKER_ENGINE_SOCKET="$(docker_engine_socket)" || die "无法解析 Docker socket，请检查 ELYSIAN_DOCKER_SOCKET 与 $ENV_FILE。"
  docker_install_or_reuse
  if [ "${DOCKER_INSTALLED_THIS_RUN:-0}" = 1 ]; then
    enable_docker
  else
    info "既有 Docker 自启状态：$(systemctl is-enabled docker 2>/dev/null || true)（仅核对，未修改）"
  fi
  verify_docker
  info "Caddy：网站域名 HTTPS 的反代依赖"
  CADDY_ADMIN_SOCKET="$(caddy_admin_socket)" || die "无法解析 Caddy 管理 socket，请检查 ELYSIAN_CADDY_SOCKET 与 $ENV_FILE。"
  install_caddy
  if ! connect_caddy_safely; then
    restore_platform_transaction || die "Caddy 接入失败且恢复未完成，请先按上方备份指引修复。"
    die "Caddy 接入或真实 API 验证失败，已恢复原配置；请检查上方私有恢复记录中的 validate.log 及 journalctl -u caddy -n 50 --no-pager 后重跑。"
  fi
  # 安装时默认声明口径：仅本次新装 Caddy 时放行域名 HTTPS 端口；复用已有 Caddy 不动任何 UFW 规则。
  if [ "${CADDY_INSTALLED_THIS_RUN:-0}" = 1 ]; then
    command -v ufw >/dev/null 2>&1 || die "未找到 ufw，无法声明 Caddy 网站 HTTPS 端口放行。"
    local added_rules
    added_rules="$(ufw show added)" || die "无法读取既有 UFW 规则，拒绝未经备份地放行 Caddy 端口。"
    printf '%s\n' "$added_rules" >"$PLATFORM_TXN/ufw.added.original" || die "无法保存 Caddy 端口规则核对记录。"
    if ! printf '%s\n' "$added_rules" | grep -Eq '^ufw allow 80,443/tcp( comment .*)?$'; then
      : >"$PLATFORM_TXN/new-https-rule" || die "无法保存 Caddy 端口规则变更记录。"
    fi
    ufw allow 80,443/tcp >/dev/null 2>&1 \
      || die "放行 Caddy 网站 HTTPS 端口（80,443/tcp）失败，请检查 UFW 后重跑。"
    CADDY_HTTPS_DECLARED=1
    ok "已放行 Caddy 网站 HTTPS 端口 80,443/tcp（安装时默认声明；已有规则不受影响）"
  else
    skip "复用已有 Caddy，未改动任何 UFW 规则（域名 HTTPS 需自行确认 80,443/tcp 可达）"
  fi
  commit_platform_transaction || die "提交平台依赖配置事务失败。"
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
  local work meta digest=""
  work="$(mktemp -d)"
  meta="$work/release.json"
  info "下载 bun ${BUN_VERSION}（linux/${BUN_ARCH}）元数据并按官方 digest 校验 sha256"
  # GitHub API 不可达时使用脚本内固定的同版本官方摘要，仍保持完整性校验。
  if try_fetch "$BUN_RELEASE_API" "$meta" bun-metadata; then
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
  info "下载 bun 安装包（约 35 MiB）；连续 15 秒低于 100 KiB/s、超时或失败时切换 npmmirror 镜像"
  fetch_bun_file "$work/$asset" "${BUN_RELEASE_URL}/${asset}" "${BUN_MIRROR_URL}/${asset}" \
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
  BUILD_LOG="$(mktemp /tmp/elysian-build.XXXXXX)"
  BUILD_DIR="$(mktemp -d)"
  BUILD_COMMIT="unknown"
  if command -v git >/dev/null 2>&1; then
    BUILD_COMMIT="$(git -c safe.directory="$REPO_ROOT" -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
    if [ "$BUILD_COMMIT" != unknown ] && ! git -c safe.directory="$REPO_ROOT" -C "$REPO_ROOT" diff --quiet HEAD --; then
      BUILD_COMMIT="${BUILD_COMMIT}-dirty"
    fi
  fi
  if [ -n "$SMOKE" ]; then
    if ! run_stage_command "构建 Elysian" "$BUILD_LOG" bash "$REPO_ROOT/scripts/build-release.sh" "$REPO_ROOT" "$BUILD_DIR" "$BUILD_COMMIT"; then
      tail -n 40 "$BUILD_LOG" >&2
      die "源码构建失败，$(stage_failure_reason)，原面板未停服（完整日志：$BUILD_LOG）。"
    fi
  else
    ensure_accounts
    BUILD_SOURCE="$(mktemp -d /var/tmp/elysian-install-source.XXXXXX)"
    tar -C "$REPO_ROOT" --exclude=.git --exclude=node_modules --exclude=dist --exclude=.env --exclude='.env.*' --exclude=.codex --exclude=.zcode --exclude=.agents --exclude=.Elysian -cf - . | tar -C "$BUILD_SOURCE" -xf -
    install -m 0644 "$REPO_ROOT/scripts/build-release.sh" "$BUILD_DIR/build-release.sh"
    chown -R elysian-build:elysian-build "$BUILD_SOURCE" "$BUILD_DIR"
    if ! run_stage_command "构建 Elysian" "$BUILD_LOG" runuser -u elysian-build -- env HOME="$BUILD_SOURCE" PATH=/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin \
      GOPROXY="$GOPROXY" BUN_CONFIG_REGISTRY="$BUN_CONFIG_REGISTRY" \
      bash "$BUILD_DIR/build-release.sh" "$BUILD_SOURCE" "$BUILD_DIR" "$BUILD_COMMIT"; then
      tail -n 40 "$BUILD_LOG" >&2
      die "源码构建失败，$(stage_failure_reason)，原面板未停服（完整日志：$BUILD_LOG）。"
    fi
  fi
  ok "构建完成（完整日志：$BUILD_LOG）"
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

# ---------- 默认开启 SSH 与防火墙 ----------

# 安装时声明默认值：启用 sshd 开机自启，放行 SSH 实际端口与面板前端端口后启用 UFW。
# 只在安装时生效；之后面板安全页的启停开关与规则是权威，重启不会把用户关掉的再拉起来。
enable_ssh_and_firewall() {
  info "启用 SSH 服务（systemctl enable --now）"
  mkdir -p /run/sshd
  if ! systemctl enable --now ssh >/dev/null 2>&1; then
    systemctl enable --now sshd >/dev/null 2>&1 \
      || die "启用 SSH 服务失败，请检查 openssh-server 安装与 sshd 配置。"
  fi
  local port status_out
  # 实际端口来自 sshd -T，保存为全局供最终摘要如实输出。
  SSH_PORTS="$( { /usr/sbin/sshd -T 2>/dev/null || true; } | awk '$1 == "port" { print $2 }' | sort -u | tr '\n' ' ')"
  SSH_PORTS="${SSH_PORTS% }"
  [ -n "$SSH_PORTS" ] || SSH_PORTS="22"
  for port in $SSH_PORTS; do
    ufw allow "${port}/tcp" >/dev/null || die "放行 SSH 端口 ${port}/tcp 失败。"
  done
  ok "SSH 已启用（端口：${SSH_PORTS}）"

  info "启用系统防火墙（UFW）"
  ufw --force enable >/dev/null || die "启用 UFW 失败，请检查 /etc/ufw 配置。"
  status_out="$(ufw status)" || die "读取 UFW 状态失败。"
  printf '%s\n' "$status_out" | grep -q '^Status: active' \
    || die "UFW 未处于激活状态，请检查 /etc/ufw 配置后重跑安装脚本。"
  printf '%s\n' "$status_out" | grep -Eq "^${FRONTEND_PORT}/tcp[[:space:]]+ALLOW" \
    || die "面板前端端口 ${FRONTEND_PORT}/tcp 未在 UFW 中放行。"
  for port in $SSH_PORTS; do
    printf '%s\n' "$status_out" | grep -Eq "^${port}/tcp[[:space:]]+ALLOW" \
      || die "SSH 端口 ${port}/tcp 未在 UFW 中放行。"
  done
  systemctl enable ufw >/dev/null 2>&1 || true
  ok "防火墙已启用，已放行 SSH 与面板端口 ${FRONTEND_PORT}/tcp"
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
      tui_status_update ""
      ok "健康检查通过（/api/health 200，用时 ${i} 秒）"
      return 0
    fi
    if [ -n "$SMOKE" ]; then
      kill -0 "$SMOKE_PID" 2>/dev/null || { tui_status_erase; tail -n 40 "$SMOKE_LOG" >&2 || true; die "面板进程已退出，详见上方日志。"; }
    else
      systemctl is-active --quiet "$SERVICE_NAME" || { tui_status_erase; journalctl -u "$SERVICE_NAME" -n 40 --no-pager >&2 || true; die "服务已退出，详见上方日志。"; }
    fi
    # TTY 下在底部单条进度条中刷新秒表；非 TTY 每 5 秒落一行纯文本。
    if [ "${SPINNER_ENABLED:-0}" = 1 ]; then
      tui_status_update "等待健康检查 ${i}/60 秒"
    elif [ $((i % 5)) -eq 0 ]; then
      tui_write_line "    等待健康检查 ${i}/60 秒"
    fi
    sleep 1
  done
  die "等待 ${HEALTH_URL} 就绪超时（60 秒）。排查：journalctl -u $SERVICE_NAME -n 50 --no-pager（或确认 ${PANEL_PORT} 端口未被占用）。"
}

ufw_public_tcp_rule() { # 只认明确公开入站规则；受限来源、范围或未知格式不推断为全网放行。
  local status="$1" port="$2" family="$3"
  printf '%s\n' "$status" | awk -v port="$port" -v family="$family" '
    {
      ipv6 = ($2 == "(v6)")
      if ((family == "6") != ipv6) next
      action = ipv6 ? 3 : 2
      if ($action != "ALLOW" || $(action + 1) == "OUT") next
      source = action + 1
      if ($source == "IN") source++
      if ($source != "Anywhere") next
      split($1, target, "/")
      if (target[2] != "tcp") next
      count = split(target[1], ports, ",")
      for (entry = 1; entry <= count; entry++) if (ports[entry] == port) found = 1
    }
    END { exit !found }
  '
}

ufw_port_summary() { # <ufw status 输出> <端口>
  local status="$1" port="$2" state ipv6=""
  if [ -r "$UFW_DEFAULTS_FILE" ]; then
    ipv6="$(sed -n 's/^[[:space:]]*IPV6=//p' "$UFW_DEFAULTS_FILE" | tail -n 1)"
  fi
  state="IPv4 "
  if ufw_public_tcp_rule "$status" "$port" 4; then state+="已放行"; else state+="未确认公开放行"; fi
  case "$ipv6" in
    yes)
      if ufw_public_tcp_rule "$status" "$port" 6; then state+="、IPv6 已放行"; else state+="、IPv6 未确认公开放行"; fi ;;
    no) state+="、UFW IPv6 未启用" ;;
    *) state+="、UFW IPv6 配置未知" ;;
  esac
  printf '%s' "$state"
}

print_summary() {
  # 事实全部现场实测；未验证或不可得的一律如实标注，绝不把占位写成「已启用」。
  local svc_state svc_enabled ssh_state ufw_out ufw_state elapsed=0
  local docker_line caddy_line docker_ver caddy_ver
  tui_finish_stage
  [ -n "${INSTALL_STARTED_AT:-}" ] && elapsed=$((SECONDS - INSTALL_STARTED_AT))
  svc_state="$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)"
  svc_enabled="$(systemctl is-enabled "$SERVICE_NAME" 2>/dev/null || true)"
  ssh_state="$(systemctl is-active ssh 2>/dev/null || true)"
  [ -n "$ssh_state" ] || ssh_state="$(systemctl is-active sshd 2>/dev/null || true)"
  if command -v docker >/dev/null 2>&1; then
    docker_ver="$(docker --version 2>/dev/null | sed -n 's/^Docker version \([^,]*\).*/\1/p' || true)"
    docker_line="${docker_ver:-已安装}；服务 $(systemctl is-active docker 2>/dev/null || echo 未知)"
  else
    docker_line="未安装"
  fi
  if command -v caddy >/dev/null 2>&1; then
    caddy_ver="$(caddy version 2>/dev/null | awk '{print $1}' || true)"
    caddy_line="${caddy_ver:-已安装}；服务 $(systemctl is-active caddy 2>/dev/null || echo 未知)"
  elif [ "${CADDY_API_VERIFIED:-0}" = 1 ]; then
    caddy_line="管理 API 已验证可用（外部管理，未发现 caddy CLI）"
  else
    caddy_line="未安装"
  fi
  ufw_out="$(ufw status 2>/dev/null || true)"
  ufw_state="$(printf '%s\n' "$ufw_out" | sed -n 's/^Status: //p')"
  ufw_state="${ufw_state:-未知}"

  tui_banner "✓ Elysian 部署完成" "构建版本 ${BUILD_COMMIT:-unknown} · 用时 $(tui_duration "$elapsed")"
  tui_section "部署状态"
  tui_kv "面板服务" "systemd ${svc_state:-未知}（自启 ${svc_enabled:-未知}）"
  tui_kv "Docker" "$docker_line"
  tui_kv "Caddy" "$caddy_line"
  tui_section "访问地址"
  tui_kv "面板端口" "$FRONTEND_PORT"
  tui_kv "访问方式" "http://<服务器公网 IP 或域名>:${FRONTEND_PORT}"
  tui_kv "后端地址" "127.0.0.1:${PANEL_PORT}（仅本机回环，不对外开放）"
  tui_section "管理员账户"
  tui_kv "初始密码" "仅首启打印一次：journalctl -u ${SERVICE_NAME} -b --no-pager | grep '初始密码'"
  tui_kv "重置密码" "全部会话失效：HOME=${STATE_DIR} ${PANEL_BIN} resetpwd"
  tui_section "运行与维护"
  tui_kv "服务管理" "systemctl status/restart/stop ${SERVICE_NAME}"
  tui_kv "面板更新" "登录面板 → 系统设置"
  tui_kv "数据目录" "${STATE_DIR}/.Elysian（data/logs/state/backups/tmp/config）"
  tui_kv "进程日志" "${STATE_DIR}/.Elysian/logs/panel.log"
  tui_section "网络与镜像源"
  tui_kv "Go 代理" "$GOPROXY"
  tui_kv "Bun 源" "$BUN_CONFIG_REGISTRY"
  tui_kv "镜像配置" "/etc/profile.d/elysian-mirrors.sh（新登录 shell 生效）"
  tui_kv "Caddy 通道" "unix socket ${CADDY_ADMIN_SOCKET:-未配置}"
  tui_section "安全状态"
  tui_kv "SSH" "${ssh_state:-未知}（端口 ${SSH_PORTS:-22}）；后续启停与规则在面板安全页管理"
  tui_kv "防火墙" "UFW ${ufw_state}；已放行 SSH 与面板端口 ${FRONTEND_PORT}/tcp"
  tui_kv "80/tcp" "$(ufw_port_summary "$ufw_out" 80)"
  tui_kv "443/tcp" "$(ufw_port_summary "$ufw_out" 443)"
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
  if [ "${INSTALL_LOCKS_HELD:-0}" = 1 ] && [ -d "$PLATFORM_TXN" ]; then
    restore_platform_transaction || result=1
  fi
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
  acquire_install_locks || die "无法取得安装切换维护锁。"
  mkdir -p "$INSTALL_ROOT/releases"
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
  local out_tty=0 err_tty=0
  if [ -t 1 ]; then out_tty=1; fi
  if [ -t 2 ]; then err_tty=1; fi
  init_output "$out_tty" "$err_tty"
  if [ "${1:-}" = "--uninstall" ]; then
    printf '%s✗ install.sh 不再提供卸载入口。%s\n  请执行：sudo bash scripts/uninstall.sh\n' "${C_RED:-}" "${C_RESET:-}" >&2
    exit 1
  fi
  register_stages
  [ "${1:-}" = "" ] || die "未知参数：$1。用法：bash scripts/install.sh（环境变量 ELYSIAN_SMOKE=1 进入冒烟模式）。"
  trap install_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  tui_banner "Elysian 安装程序" "源码目录  $REPO_ROOT"
  INSTALL_STARTED_AT=$SECONDS
  section "检查运行环境"
  require_preflight
  section "安装系统依赖"
  apt_install_deps
  if [ -z "$SMOKE" ]; then
    acquire_install_locks || die "无法取得平台依赖恢复维护锁。"
    if [ -d "$PLATFORM_TXN" ]; then
      command -v bun >/dev/null 2>&1 || die "存在待恢复的平台依赖事务，但找不到 Bun；请先恢复原 Bun 后重跑（备份：$PLATFORM_TXN）。"
      restore_platform_transaction || die "平台依赖事务恢复未完成，请先按备份指引修复。"
    fi
    release_install_locks
  fi
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
    section "检测并安装平台依赖"
    acquire_install_locks || die "无法取得平台依赖安装维护锁。"
    install_platform_deps
    section "安装并切换版本"
    prepare_install_switch
    install_binary
    write_unit
    HOME="$STATE_DIR" "$PANEL_BIN" maintenance-bootstrap || die "前端防火墙规则核对失败，请处理冲突后重跑安装脚本。"
    ok "面板前端防火墙规则已核对"
    section "启用 SSH 与防火墙"
    enable_ssh_and_firewall
    section "启动服务"
    start_service
    section "等待健康检查"
    wait_health
    INSTALL_COMMITTED=1
    print_summary
  fi
}

# 直接执行进入主流程；被 source（scripts/install-helpers.test.sh 自测纯逻辑）时不执行。
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
