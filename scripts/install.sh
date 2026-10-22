#!/usr/bin/env bash
# scripts/install.sh —— Elysian 源码一键部署（目标环境：Ubuntu/Debian 虚拟机，root 执行）。
#
# 用法：
#   bash scripts/install.sh             完整安装/升级（幂等，可重复执行）
#   bash scripts/uninstall.sh           整机卸载（独立脚本：服务、账号、工具链与面板规则；--purge-data 连数据一并删）
#   bash scripts/install.sh --uninstall 轻量卸载：仅服务与二进制（保留工具链与数据）
#   ELYSIAN_SMOKE=1 bash scripts/install.sh
#                                       冒烟模式：跳过 systemd 与系统用户，仅装工具链、
#                                       构建、起进程、curl /api/health、清理（供
#                                       .zcode/go-migration/script-smoke.sh 在干净容器内调用）
#
# 平台依赖：正式安装在「构建 Elysian」之后、安装切换事务之前自动检测并安装 Docker 与 Caddy——
# 已安装且可用则复用（不重装、不改动既有 daemon.json / Caddyfile），缺失则按经验证的官方命令
# 序列（Docker 官方 get.docker.com、Caddy 官方 cloudsmith apt 源）安装并真实验证（docker info、
# Engine API ≥ 1.41、systemctl is-active），失败打印中文原因与排查建议后非零退出；该阶段先于
# 切换事务，失败不回滚已部署面板。
#
# 终端输出：阶段计数由登记表自动派生；状态标记统一为 ✓ 成功 / ✗ 失败 / ◉ 进行中 / ! 警告 /
# − 跳过；同时满足 stdout 与 stderr 为 TTY 才启用颜色与单行进度，NO_COLOR 非空时关闭颜色；
# 重定向或非 TTY 自动退化为纯文本逐行日志。
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
STAGES=()
TOTAL_STEPS=0

# ---------- 终端输出层（唯一的能力判定出口；颜色、单行进度与纯文本降级都从这里派生） ----------

init_output() { # init_output <stdout 是否 TTY 0|1> <stderr 是否 TTY 0|1>
  local out_tty="$1" err_tty="$2"
  if [ "$out_tty" = 1 ] && [ "$err_tty" = 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
    C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_CYAN=$'\033[36m'; C_YELLOW=$'\033[33m'; C_GRAY=$'\033[90m'
  else
    C_RESET=''; C_BOLD=''; C_GREEN=''; C_RED=''; C_CYAN=''; C_YELLOW=''; C_GRAY=''
  fi
  # 单行刷新（转圈、秒表）只在双 TTY 下启用；NO_COLOR 只关颜色，不关进度指示。
  if [ "$out_tty" = 1 ] && [ "$err_tty" = 1 ]; then
    SPINNER_ENABLED=1
  else
    SPINNER_ENABLED=0
  fi
  TERM_COLS="$(tput cols 2>/dev/null || printf '72')"
  case "$TERM_COLS" in ''|*[!0-9]*) TERM_COLS=72 ;; esac
  [ "$TERM_COLS" -ge 20 ] || TERM_COLS=72
}

info() { printf '%s==>%s %s\n' "${C_BOLD:-}" "${C_RESET:-}" "$*"; }
ok()   { printf '%s✓%s %s\n' "${C_GREEN:-}" "${C_RESET:-}" "$*"; }
skip() { printf '%s−%s %s\n' "${C_GRAY:-}" "${C_RESET:-}" "$*"; }
warn() { printf '%s!%s %s\n' "${C_YELLOW:-}" "${C_RESET:-}" "$*"; }
die()  { printf '%s✗ 安装失败：%s%s\n' "${C_RED:-}" "$*" "${C_RESET:-}" >&2; exit 1; }

section() { # section <阶段名>：计数来自登记表；名字与登记不符时提示而不中断
  STEP=$((STEP + 1))
  local registered="${STAGES[$((STEP - 1))]:-}"
  if [ -n "$registered" ] && [ "$registered" != "$1" ]; then
    warn "阶段名与登记表不一致：传入「$1」，登记为「$registered」（请同步 register_stages）"
  fi
  printf '\n%s[%s/%s] %s%s\n' "${C_BOLD:-}" "$STEP" "${TOTAL_STEPS:-?}" "$1" "${C_RESET:-}"
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

# 长命令统一出口：输出全部追加进日志文件；TTY 下用单行转圈表示进行中（同一时刻只有这一行在
# 刷新），非 TTY 保持静默，由调用方按结果打 ✓/✗ 行。调用方须以 if ! run_stage_command … 形式接住返回码。
run_stage_command() { # run_stage_command <描述> <日志文件> <命令…>
  local desc="$1" log="$2"
  shift 2
  if [ "${SPINNER_ENABLED:-0}" != 1 ]; then
    "$@" >>"$log" 2>&1
    return
  fi
  local pid rc frame_idx=0 spin='|/-\'
  "$@" >>"$log" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    printf '\r  %s◉%s %s … %s' "${C_CYAN:-}" "${C_RESET:-}" "$desc" "${spin:$((frame_idx % 4)):1}"
    frame_idx=$((frame_idx + 1))
    sleep 0.3
  done
  wait "$pid"
  rc=$?
  clear_progress_line
  return "$rc"
}

clear_progress_line() { # 擦掉当前单行进度（按终端宽度回车覆盖），非 TTY 不输出
  if [ "${SPINNER_ENABLED:-0}" = 1 ]; then
    printf '\r%*s\r' "${TERM_COLS:-72}" ''
  fi
}

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
  command -v runuser >/dev/null 2>&1 || need+=(util-linux)
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
  if ! run_stage_command "安装系统依赖 ${need[*]}" "$log" env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${need[@]}"; then
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

docker_install_or_reuse() {
  if command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
      ok "已安装 Docker（$(docker --version 2>/dev/null || echo 版本未知)），守护进程在响应，复用现有安装"
      return 0
    fi
    info "检测到 docker 命令但守护进程未响应，先尝试直接拉起服务（不改动既有安装）"
    systemctl start docker >/dev/null 2>&1 || true
    if docker info >/dev/null 2>&1; then
      ok "已拉起既有 Docker 守护进程，复用现有安装（未改动任何配置）"
      return 0
    fi
    die "Docker 已安装但守护进程未响应（docker info 失败）。为不破坏既有安装，脚本不会在其上重装；请先排查：journalctl -u docker -n 50 --no-pager，修复后重跑本脚本。"
  fi
  command -v curl >/dev/null 2>&1 || die "缺少 curl，无法下载 Docker 官方安装脚本。"
  local log tmp="/tmp/elysian-get-docker.sh"
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
  docker info >/dev/null 2>&1 \
    || die "Docker 守护进程未响应（docker info 失败）。排查：journalctl -u docker -n 50 --no-pager；确认 /var/run/docker.sock 存在后重跑。"
  local api
  api="$(docker version --format '{{.Server.APIVersion}}' 2>/dev/null || true)"
  if ! docker_api_version_ok "$api"; then
    die "Docker Engine API 版本过低（${api:-未知}），面板要求 ≥ 1.41；请升级 Docker 后重跑本脚本。"
  fi
  ok "Docker 验证通过：$(docker --version 2>/dev/null || echo 已安装)，Engine API ${api}（≥ 1.41）"
}

caddy_admin_socket() { # 面板同款覆盖次序：环境变量 → /etc/default/elysian（EnvironmentFile）→ 缺省 /run/caddy/admin.sock
  local sock="${ELYSIAN_CADDY_SOCKET:-}"
  if [ -z "$sock" ] && [ -r "$ENV_FILE" ]; then
    sock="$(sed -n 's/^ELYSIAN_CADDY_SOCKET=//p' "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
    sock="${sock%\"}"; sock="${sock#\"}"
    sock="${sock%\'}"; sock="${sock#\'}"
  fi
  printf '%s' "${sock:-/run/caddy/admin.sock}"
}

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

configure_caddy_admin() { # configure_caddy_admin <socket 绝对路径> [Caddyfile 路径，缺省 /etc/caddy/Caddyfile]
  local socket="$1"
  local file="${2:-$CADDYFILE_PATH}"
  local bytes content rc tmp backup log
  # 本次是否实际改写了 Caddyfile（新建或替换都算）：enable_caddy 只在必要时重启服务。
  CADDYFILE_REWRITTEN=0
  if [ ! -f "$file" ]; then
    info "未发现 ${file}，创建仅含管理通道指令的最小 Caddyfile"
    tmp="$(mktemp)"
    printf '{\n\tadmin unix/%s\n}\n' "$socket" >"$tmp"
    if command -v caddy >/dev/null 2>&1 && ! caddy validate --config "$tmp" --adapter caddyfile >/dev/null 2>&1; then
      rm -f "$tmp"
      die "新生成的最小 Caddyfile 未通过 caddy validate（管理通道：unix/${socket}），请检查路径后重跑。"
    fi
    mkdir -p "$(dirname "$file")"
    install -m 0644 "$tmp" "$file" || { rm -f "$tmp"; die "写入 ${file} 失败。"; }
    rm -f "$tmp"
    CADDYFILE_REWRITTEN=1
    ok "已创建 ${file}（管理通道：unix/${socket}）"
    return 0
  fi
  bytes="$(wc -c <"$file" | tr -d '[:space:]')"
  case "$bytes" in ''|*[!0-9]*) bytes=0 ;; esac
  if [ "$bytes" -gt "$CADDYFILE_MAX_BYTES" ]; then
    warn "Caddyfile 过大（${bytes} 字节 > ${CADDYFILE_MAX_BYTES}），拒绝改写，保持原样；如需面板管理通道请人工在全局段声明 admin unix/${socket}"
    return 0
  fi
  content="$(cat "$file")"
  rc=0
  caddyfile_ensure_admin "$content" "$socket" || rc=$?
  if [ "$rc" -eq 1 ]; then
    ok "Caddyfile 已声明管理通道（admin unix/${socket}），零改动"
    return 0
  fi
  if [ "$rc" -ge 2 ]; then
    warn "Caddyfile 全局段没有结束括号，拒绝改写，保持原样；请人工修复后重跑本脚本"
    return 0
  fi
  info "改写 Caddyfile：全局段收成恰好一条 admin unix/${socket}（先备份，校验失败恢复原文件）"
  backup="${file}.elysian.bak"
  tmp="$(mktemp)"
  printf '%s' "$CADDYFILE_RESULT" >"$tmp"
  cp -f "$file" "$backup" || { rm -f "$tmp"; die "备份 ${file} 到 ${backup} 失败。"; }
  install -m 0644 "$tmp" "$file" || { rm -f "$tmp"; die "写入 ${file} 失败（原文件备份：${backup}）。"; }
  rm -f "$tmp"
  if command -v caddy >/dev/null 2>&1; then
    log="$(mktemp /tmp/elysian-caddy-validate.XXXXXX)"
    if ! caddy validate --config "$file" --adapter caddyfile >"$log" 2>&1; then
      mv -f "$backup" "$file"
      tail -n 40 "$log" >&2
      die "Caddyfile 校验没有通过，已恢复原文件（校验日志：${log}）。"
    fi
    rm -f "$log"
  fi
  rm -f "$backup"
  CADDYFILE_REWRITTEN=1
  ok "Caddyfile 已更新（管理通道：unix/${socket}），caddy validate 通过"
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
  if command -v caddy >/dev/null 2>&1; then
    ok "已安装 Caddy（$(caddy version 2>/dev/null || echo 版本未知)），复用现有安装"
    CADDY_INSTALLED_THIS_RUN=0
    return 0
  fi
  command -v apt-get >/dev/null 2>&1 || die "当前系统没有 apt-get，只能在 Debian 或 Ubuntu 上代为安装 Caddy。"
  CADDY_DEPS_LOG="$(mktemp /tmp/elysian-caddy-install.XXXXXX)"
  CADDY_DEPS_GPG="/tmp/elysian-caddy.gpg"
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

caddy_needs_restart() { # caddy_needs_restart <本次新装 0/1> <Caddyfile 实际改写 0/1> <服务当前 active 0/1>
  # 复用中的 Caddy 可能正在对外服务网站 HTTPS：只有新装、配置改写或服务未运行时才允许重启。
  if [ "$1" = 1 ] || [ "$2" = 1 ] || [ "$3" != 1 ]; then return 0; else return 1; fi
}

enable_caddy() { # runtime 目录 drop-in、tmpfiles、daemon-reload、enable；restart 仅在必要时发生
  command -v systemctl >/dev/null 2>&1 || die "当前系统没有 systemctl，无法设置 Caddy 开机自启。"
  if ! systemctl cat caddy.service >/dev/null 2>&1; then
    # 没有 caddy.service 单元：本次新装属异常必须停；复用的手工部署不接管也不中止安装。
    if [ "${CADDY_INSTALLED_THIS_RUN:-0}" = 1 ]; then
      die "Caddy 已安装但找不到 caddy.service 系统单元，无法设置开机自启。排查：dpkg -L caddy | grep service 后重跑。"
    fi
    if [ "${CADDYFILE_REWRITTEN:-0}" = 1 ]; then
      warn "复用的 Caddy 无 systemd 单元且 Caddyfile 已改写：请用既有管理方式重启或 caddy reload 使管理通道生效"
    else
      skip "复用非 systemd 管理的 Caddy，不接管服务（开机自启与重启由既有方式负责）"
    fi
    return 0
  fi
  mkdir -p /etc/systemd/system/caddy.service.d /etc/tmpfiles.d
  printf '%s\n' '[Service]' 'RuntimeDirectory=caddy' 'RuntimeDirectoryMode=0755' >/etc/systemd/system/caddy.service.d/elysian-runtime.conf
  printf '%s\n' 'd /run/caddy 0755 caddy caddy -' >/etc/tmpfiles.d/elysian-caddy.conf
  if command -v systemd-tmpfiles >/dev/null 2>&1; then
    systemd-tmpfiles --create /etc/tmpfiles.d/elysian-caddy.conf || true
  fi
  systemctl daemon-reload || die "systemctl daemon-reload 失败。"
  systemctl enable caddy >/dev/null 2>&1 || die "设置 Caddy 开机自启失败（systemctl enable caddy）。"
  local active=0
  systemctl is-active --quiet caddy && active=1
  if caddy_needs_restart "${CADDY_INSTALLED_THIS_RUN:-0}" "${CADDYFILE_REWRITTEN:-0}" "$active"; then
    systemctl restart caddy >/dev/null 2>&1 || die "重启 Caddy 服务失败。排查：journalctl -u caddy -n 50 --no-pager。"
    systemctl is-active --quiet caddy || die "Caddy 服务未处于 active 状态。排查：journalctl -u caddy -n 50 --no-pager。"
    ok "Caddy 已启动并设为开机自启（管理通道目录 /run/caddy 由 systemd RuntimeDirectory 与 tmpfiles 维护）"
  else
    ok "复用已有 Caddy：服务保持运行未重启，开机自启已确认（drop-in 与 tmpfiles 幂等就位）"
  fi
}

install_platform_deps() {
  info "Docker：容器、数据库与网站功能的运行时依赖"
  docker_install_or_reuse
  enable_docker
  verify_docker
  info "Caddy：网站域名 HTTPS 的反代依赖"
  local socket
  socket="$(caddy_admin_socket)"
  install_caddy
  case "$socket" in
    /*) configure_caddy_admin "$socket" ;;
    *) warn "管理通道路径无效（ELYSIAN_CADDY_SOCKET=${socket}，须为绝对路径），已跳过 Caddyfile 改写；修正后重跑本脚本" ;;
  esac
  CADDY_ADMIN_SOCKET="$socket"
  # 安装时默认声明口径：仅本次新装 Caddy 时放行域名 HTTPS 端口；复用已有 Caddy 不动任何 UFW 规则。
  if [ "${CADDY_INSTALLED_THIS_RUN:-0}" = 1 ]; then
    command -v ufw >/dev/null 2>&1 || die "未找到 ufw，无法声明 Caddy 网站 HTTPS 端口放行。"
    ufw allow 80,443/tcp >/dev/null 2>&1 \
      || die "放行 Caddy 网站 HTTPS 端口（80,443/tcp）失败，请检查 UFW 后重跑。"
    CADDY_HTTPS_DECLARED=1
    ok "已放行 Caddy 网站 HTTPS 端口 80,443/tcp（安装时默认声明；已有规则不受影响）"
  else
    skip "复用已有 Caddy，未改动任何 UFW 规则（域名 HTTPS 需自行确认 80,443/tcp 可达）"
  fi
  enable_caddy
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
      clear_progress_line
      ok "健康检查通过（/api/health 200，用时 ${i} 秒）"
      return 0
    fi
    if [ -n "$SMOKE" ]; then
      kill -0 "$SMOKE_PID" 2>/dev/null || { clear_progress_line; tail -n 40 "$SMOKE_LOG" >&2 || true; die "面板进程已退出，详见上方日志。"; }
    else
      systemctl is-active --quiet "$SERVICE_NAME" || { clear_progress_line; journalctl -u "$SERVICE_NAME" -n 40 --no-pager >&2 || true; die "服务已退出，详见上方日志。"; }
    fi
    # TTY 下单行秒表刷新；非 TTY 每 5 秒落一行纯文本。
    if [ "${SPINNER_ENABLED:-0}" = 1 ]; then
      printf '\r  %s◉%s 等待健康检查 %d/60 秒' "${C_CYAN:-}" "${C_RESET:-}" "$i"
    elif [ $((i % 5)) -eq 0 ]; then
      printf '  等待健康检查 %d/60 秒\n' "$i"
    fi
    sleep 1
  done
  clear_progress_line
  die "等待 ${HEALTH_URL} 就绪超时（60 秒）。排查：journalctl -u $SERVICE_NAME -n 50 --no-pager（或确认 ${PANEL_PORT} 端口未被占用）。"
}

detect_server_ip() { # 真实地址探测：hostname -I 首地址 → ip route get 1 的 src → 保留占位符
  local ip=""
  if command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  if [ -z "$ip" ] && command -v ip >/dev/null 2>&1; then
    ip="$(ip route get 1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true)"
  fi
  if [ -n "$ip" ]; then
    printf '%s' "$ip"
  else
    printf '%s' "<服务器 IP>"
  fi
}

summary_section() { # 摘要分区标题：对齐的短分隔线，窄终端可读
  printf '\n%s── %s ──────────────────────%s\n' "${C_BOLD:-}" "$1" "${C_RESET:-}"
}

print_summary() {
  # 事实全部现场实测；未验证或不可得的一律如实标注，绝不把占位写成「已启用」。
  local server_ip svc_state svc_enabled ssh_state ufw_out ufw_state https_state
  local docker_line caddy_line
  server_ip="$(detect_server_ip)"
  svc_state="$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)"
  svc_enabled="$(systemctl is-enabled "$SERVICE_NAME" 2>/dev/null || true)"
  ssh_state="$(systemctl is-active ssh 2>/dev/null || true)"
  [ -n "$ssh_state" ] || ssh_state="$(systemctl is-active sshd 2>/dev/null || true)"
  if command -v docker >/dev/null 2>&1; then
    docker_line="$(docker --version 2>/dev/null || echo 已安装)；服务 $(systemctl is-active docker 2>/dev/null || echo 未知)"
  else
    docker_line="未安装"
  fi
  if command -v caddy >/dev/null 2>&1; then
    caddy_line="$(caddy version 2>/dev/null || echo 已安装)；服务 $(systemctl is-active caddy 2>/dev/null || echo 未知)"
  else
    caddy_line="未安装"
  fi
  ufw_out="$(ufw status 2>/dev/null || true)"
  ufw_state="$(printf '%s\n' "$ufw_out" | sed -n 's/^Status: //p')"
  ufw_state="${ufw_state:-未知}"
  if printf '%s\n' "$ufw_out" | grep -Eq '^(80,443/tcp|80/tcp|443/tcp)( \(v6\))?[[:space:]]+ALLOW'; then
    https_state="80,443/tcp 已放行（ufw status 实测）"
  elif [ "${CADDY_HTTPS_DECLARED:-0}" = 1 ]; then
    https_state="安装时已声明放行 80,443/tcp，但 ufw status 未见该规则，请人工核对：ufw status | grep -E '80|443'"
  else
    https_state="本脚本未放行（复用已有 Caddy 时不动 UFW 规则）；域名 HTTPS 需 80/443 可达"
  fi

  printf '\n%s%s✓ Elysian 部署完成%s（构建版本：%s）\n' "${C_GREEN:-}" "${C_BOLD:-}" "${C_RESET:-}" "${BUILD_COMMIT:-unknown}"
  summary_section "部署状态"
  printf '  面板服务：systemd %s（自启：%s）\n' "${svc_state:-未知}" "${svc_enabled:-未知}"
  printf '  Docker：%s\n' "$docker_line"
  printf '  Caddy：%s\n' "$caddy_line"
  summary_section "访问地址"
  printf '  面板地址：%shttp://%s:%s%s（前端入口，浏览器打开）\n' "${C_BOLD:-}" "$server_ip" "$FRONTEND_PORT" "${C_RESET:-}"
  printf '  后端地址：127.0.0.1:%s（仅本机回环，不对外开放）\n' "$PANEL_PORT"
  summary_section "管理员账户"
  echo "  首启初始密码只在第一次启动打印一次，查看："
  printf '    %s\n' "journalctl -u $SERVICE_NAME -b --no-pager | grep '初始密码'"
  echo "  忘记密码时重置（全部会话失效）："
  printf '    %s\n' "HOME=$STATE_DIR $PANEL_BIN resetpwd"
  summary_section "运行与维护"
  printf '  服务管理：systemctl status/restart/stop %s\n' "$SERVICE_NAME"
  echo "  面板更新与改端口：登录面板后进入「系统设置」"
  printf '  数据目录：%s/.Elysian（data/logs/state/backups/tmp/config 分类目录）\n' "$STATE_DIR"
  printf '  进程日志：%s/.Elysian/logs/panel.log（失败请求与 panic 栈；也可 journalctl -u %s）\n' "$STATE_DIR" "$SERVICE_NAME"
  summary_section "网络与镜像源"
  printf '  Go 模块代理：%s\n' "$GOPROXY"
  printf '  Bun registry：%s\n' "$BUN_CONFIG_REGISTRY"
  echo "  全局镜像配置文件：/etc/profile.d/elysian-mirrors.sh（新登录 shell 生效）"
  printf '  Caddy 管理通道：unix socket %s\n' "${CADDY_ADMIN_SOCKET:-未配置}"
  summary_section "安全状态"
  printf '  SSH 服务：%s（端口 %s）；后续启停与规则在面板安全页管理\n' "${ssh_state:-未知}" "${SSH_PORTS:-22}"
  printf '  防火墙：UFW %s；已放行 SSH 与面板前端端口 %s/tcp\n' "$ufw_state" "$FRONTEND_PORT"
  printf '  网站 HTTPS 端口：%s\n' "$https_state"
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
  echo "安装脚本代装的 Docker 与 Caddy 属系统组件，此轻量卸载不触碰。"
  echo "如需整机卸载（含系统账号、工具链与 UFW 面板规则），请执行：sudo bash scripts/uninstall.sh"
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
  local out_tty=0 err_tty=0
  if [ -t 1 ]; then out_tty=1; fi
  if [ -t 2 ]; then err_tty=1; fi
  init_output "$out_tty" "$err_tty"
  register_stages
  if [ "${1:-}" = "--uninstall" ]; then
    uninstall
    return 0
  fi
  [ "${1:-}" = "" ] || die "未知参数：$1。用法：bash scripts/install.sh [--uninstall]（环境变量 ELYSIAN_SMOKE=1 进入冒烟模式）。"
  trap install_exit EXIT
  printf '\n%sElysian 安装程序%s\n  源码目录：%s\n' "${C_BOLD:-}" "${C_RESET:-}" "$REPO_ROOT"
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
    section "检测并安装平台依赖"
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
