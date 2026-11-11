#!/usr/bin/env bash
# scripts/uninstall.sh —— Elysian 彻底卸载；root 执行，先展示清单再确认。
# 正式机器的直达命令是 sudo ely uninstall（等价于 sudo bash /opt/elysian/current/scripts/uninstall.sh）；
# 源码克隆内仍可按相对路径执行本脚本。
#
# 用法：
#   sudo ely uninstall                            展示彻底清理清单，再确认执行
#   sudo ely uninstall --keep-data                保留面板数据
#   sudo ely uninstall --keep-tools               保留 Go 与 bun 工具链
#   sudo ely uninstall --yes                      免交互，默认删除全部面板数据
#   sudo ely uninstall --dry-run                  只展示计划与大小，不做任何修改
#
# 默认删除：systemd 服务与自启、/usr/local/bin/elysian、/opt/elysian、/etc/default/elysian、
# /etc/profile.d/elysian-mirrors.sh、构建残留、面板自己加的 UFW 前端端口规则，以及本脚本安装
# 路径上的 Go(/usr/local/go) 与 bun(/usr/local/bin/bun)。/etc/default/elysian 删除前会备份到
# /var/backups/elysian-uninstall-<时间戳>。CLI 命令 /usr/local/bin/ely 仅在它是本面板注册的
# 符号链接（指向 /opt/elysian 内）时删除；其他软件的同名普通文件或链接一律保留并提示。
#
# 面板数据 /var/lib/elysian/.Elysian 按四类展示，默认全部删除；--keep-data 全部保留：
#   数据（SQLite 与 Agent 记录）、配置与凭据、日志、备份/状态/临时。
# 「备份/状态/临时」类同时包含 root 的 ely CLI 本地数据 /root/.elysian/cli；其他用户主目录下
# 的 ~/.elysian/cli 无法由 root 代为清理，摘要中注明由各用户自行删除。
# 只要保留任一数据类别，就保留 elysian 账号；保留「数据」时同时保留 elysian-sqlite 账号，
# 避免文件属主退化为数字 UID、重装无法直接复用。
#
# Caddy 接入默认精确移除：内容与 Elysian 写入完全一致的 drop-in/tmpfiles，
# 以及 Caddyfile 全局段中精确的 admin unix/<socket> 行。Caddyfile 先备份、caddy validate 通过
# 才原子替换，reload 失败会恢复原文件。
#
# Docker/Caddy 仅凭 root 私有安装收据认领，再核验未使用及 apt 模拟清单后移除；未知归属与业务
# 资源保留并非零退出。源码、SSH、用户 UFW 规则和其他软件不认领。恢复备份单独列出。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SERVICE_NAME="elysian"
PANEL_BIN="/usr/local/bin/elysian"
# CLI 命令 ely：与面板同一单二进制的 argv0 别名链接，归属判定见 cli_link_owned。
CLI_BIN="/usr/local/bin/ely"
UNIT_FILE="/etc/systemd/system/elysian.service"
STATE_DIR="/var/lib/elysian"
PURGE_GUARD="/var/lib/elysian"
INSTALL_ROOT="/opt/elysian"
ENV_FILE="/etc/default/elysian"
MIRROR_PROFILE="/etc/profile.d/elysian-mirrors.sh"
BUILD_HOME="/var/lib/elysian-build"
# root 运行 ely 的本地数据（Cookie、指针与草稿）；归入「备份/状态/临时」类询问。
CLI_DATA_DIR="/root/.elysian/cli"
DEFAULT_FRONTEND_PORT="48100"
CADDYFILE_PATH="/etc/caddy/Caddyfile"
CADDY_APT_LIST="/etc/apt/sources.list.d/caddy-stable.list"
CADDY_KEYRING="/usr/share/keyrings/caddy-stable-archive-keyring.gpg"
DOCKER_APT_SOURCES="/etc/apt/sources.list.d/docker.sources"
DOCKER_APT_LIST="/etc/apt/sources.list.d/docker.list"
DOCKER_APT_KEY="/etc/apt/keyrings/docker.asc"
CADDY_RUNTIME_DROPIN="/etc/systemd/system/caddy.service.d/elysian-runtime.conf"
CADDY_TMPFILES="/etc/tmpfiles.d/elysian-caddy.conf"
BACKUP_ROOT="/var/backups"
ARTIFACT_GLOBS=(
  "/var/tmp/elysian-install-source.*"
  "/tmp/elysian-build.*"
  "/tmp/elysian-caddy-check.*"
  "/tmp/elysian-caddy-install.*"
  "/tmp/elysian-caddy-gpg.*"
  "/tmp/elysian-caddy-probe.*"
  "/tmp/elysian-apt.*"
  "/tmp/elysian-get-docker.*"
  "/tmp/elysian-docker-install.*"
  "/tmp/elysian-docker-apt.*"
)

PURGE_DATA=1
PURGE_DATA_REQUESTED=0
KEEP_DATA=0
KEEP_DEPENDENCIES=0
KEEP_CADDY_CONFIG=0
UNINSTALL_LEGACY_COMPONENTS=""
KEEP_TOOLS=0
ASSUME_YES=0
DRY_RUN=0

DELETE_DATA=0
DELETE_CONFIG=0
DELETE_LOGS=0
DELETE_STATE=0

CADDY_RUNTIME_MATCH=0
CADDY_TMPFILES_MATCH=0
CADDYFILE_ADMIN_FOUND=0
CADDY_REMOVE=1
CADDY_PACKAGE_REMOVED=0
ENV_KEPT=0

EXPECT_DELETE_ELYSIAN_BUILD=0
EXPECT_DELETE_ELYSIAN=0
EXPECT_DELETE_SQLITE=0
EXPECT_DELETE_GO=0
EXPECT_DELETE_BUN=0

STAGE=0
TOTAL_STAGES=9
FAILED=0
BACKUP_DIR=""
DATA_ROOT=""
FRONTEND_PORT="$DEFAULT_FRONTEND_PORT"
CADDY_SOCKET=""

DELETED_ITEMS=()
KEPT_ITEMS=()
RESIDUE=()
UNFINISHED_ITEMS=()

if [ ! -r "$SCRIPT_DIR/tui.sh" ]; then
  printf '缺少 scripts/tui.sh，无法渲染卸载界面。\n' >&2
  exit 1
fi
# shellcheck source=tui.sh
. "$SCRIPT_DIR/tui.sh"
# shellcheck source=platform-lifecycle.sh
. "$SCRIPT_DIR/platform-lifecycle.sh"
TUI_FAIL_LABEL="卸载失败"

usage() {
  cat <<'EOF'
用法：sudo ely uninstall [选项]
（等价于 sudo bash /opt/elysian/current/scripts/uninstall.sh）
默认彻底清理面板数据、缓存、账号、管理配置及本脚本新增且未使用的 Docker/Caddy。
已有容器、镜像、卷或归属不明的组件不会盲删；无法清理时列出原因并非零退出。
  --keep-data    保留全部面板数据和凭据
  --keep-dependencies  保留 Docker/Caddy（仍核验服务完整性）
  --keep-caddy-config  保留 Caddy 管理通道配置
  --remove-legacy-components caddy,docker,go,bun
                 显式指定要清理的旧组件；无需旧收据，不自动认领，仍核验业务使用情况
  --purge-data   删除全部面板数据（兼容参数，也是默认行为）
  --keep-tools   保留 Go 与 bun 工具链
  --yes, -y      按展示的清单直接执行，包含默认删除全部面板数据
  --dry-run      只展示计划与大小，不做任何修改
  --help         显示本帮助
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --purge-data) PURGE_DATA=1; PURGE_DATA_REQUESTED=1 ;;
      --keep-data) KEEP_DATA=1; PURGE_DATA=0 ;;
      --keep-dependencies) KEEP_DEPENDENCIES=1 ;;
      --keep-caddy-config) KEEP_CADDY_CONFIG=1; CADDY_REMOVE=0 ;;
      --remove-legacy-components)
        [ "$#" -ge 2 ] || die "--remove-legacy-components 需要逗号分隔的组件名称。"
        local value="$2" component
        case "$value" in ''|,*|*,|*,,*) die "旧组件清单不能为空或包含空项。" ;; esac
        local -a legacy_components=()
        IFS=, read -r -a legacy_components <<<"$value"
        for component in "${legacy_components[@]}"; do
          case "$component" in caddy|docker|go|bun) : ;; *) die "不支持清理的旧组件：$component" ;; esac
        done
        UNINSTALL_LEGACY_COMPONENTS="${UNINSTALL_LEGACY_COMPONENTS:+$UNINSTALL_LEGACY_COMPONENTS,}$value"
        shift ;;
      --keep-tools) KEEP_TOOLS=1 ;;
      --yes|-y) ASSUME_YES=1 ;;
      --dry-run) DRY_RUN=1 ;;
      -h|--help) usage; exit 0 ;;
      *) printf '未知参数：%s\n' "$1" >&2; usage >&2; exit 1 ;;
    esac
    shift
  done
  [ "$KEEP_DATA" = 0 ] || [ "$PURGE_DATA_REQUESTED" = 0 ] || die "--keep-data 与 --purge-data 不能同时使用。"
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "请以 root 执行（sudo ely uninstall，或 sudo bash /opt/elysian/current/scripts/uninstall.sh）。"
}

require_interactive() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] && return 0
  die "当前不是交互终端；请先 --dry-run 核对清单，再使用 --yes（默认删除全部面板数据）；需要保留时加 --keep-data。"
}

cli_link_owned() { # cli_link_owned：CLI_BIN 为本面板注册的受管符号链接时返回 0
  # 受管形态仅两种：链接文本精确等于 $INSTALL_ROOT/current/elysian；或文本不含「..」
  # 逃逸成分、且经 readlink -f 解析（与 INSTALL_ROOT 自身规范化同基）后的真实路径
  # 精确为 current/elysian 或位于 releases/ 之下。仅按原始文本前缀匹配会把
  # /opt/elysian/../foreign 或经安装根内符号链接跳向外部的目标误判为自家（安装将
  # 覆盖、卸载将误删外部入口），故除精确 current 形态外先拒「..」成分再核对真实
  # 路径；断链只接受精确受管文本形态。
  [ -L "$CLI_BIN" ] || return 1
  local target root
  target="$(readlink "$CLI_BIN" 2>/dev/null)" || return 1
  case "$target" in
    "$INSTALL_ROOT/current/elysian") return 0 ;;
  esac
  case "$target" in
    ..|../*|*/../*|*/..) return 1 ;;
  esac
  root="$(readlink -f "$INSTALL_ROOT" 2>/dev/null)" || return 1
  target="$(readlink -f "$CLI_BIN" 2>/dev/null)" || return 1
  case "$target" in
    "$root/current/elysian") return 0 ;;
  esac
  case "$target" in
    "$root/releases/"*) return 0 ;;
  esac
  return 1
}

panel_frontend_port() {
  local cfg="$STATE_DIR/.Elysian/config/panel-network.json" port
  if [ -r "$cfg" ]; then
    port="$(grep -o '"frontendPort"[[:space:]]*:[[:space:]]*[0-9]*' "$cfg" | grep -o '[0-9]*$' || true)"
    case "$port" in
      ''|*[!0-9]*) : ;;
      *) if [ "$port" -ge 1 ] && [ "$port" -le 65535 ]; then printf '%s' "$port"; return 0; fi ;;
    esac
  fi
  printf '%s' "$DEFAULT_FRONTEND_PORT"
}

resolve_caddy_socket() {
  local sock="${ELYSIAN_CADDY_SOCKET:-}" value
  if [ -z "$sock" ] && [ -r "$ENV_FILE" ]; then
    value="$(sed -n 's/^[[:space:]]*ELYSIAN_CADDY_SOCKET=//p' "$ENV_FILE" | tail -n 1 || true)"
    value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
    sock="$value"
  fi
  [ -n "$sock" ] || sock="/run/caddy/admin.sock"
  case "$sock" in
    /*) printf '%s' "$sock" ;;
    *) return 1 ;;
  esac
}

load_state() {
  DATA_ROOT="$STATE_DIR/.Elysian"
  FRONTEND_PORT="$(panel_frontend_port)"
  CADDY_SOCKET="$(resolve_caddy_socket 2>/dev/null || true)"
  if [ -z "$CADDY_SOCKET" ]; then
    warn "无法解析 Caddy socket 路径，跳过 Caddy 配置清理"
  fi
}

check_maintenance() {
  command -v systemctl >/dev/null 2>&1 || return 0
  local units
  units="$(systemctl list-units --type=service --state=running 'elysian-maintenance-*' --no-legend 2>/dev/null | awk '{print $1}' || true)"
  [ -n "$units" ] || return 0
  units="$(printf '%s' "$units" | tr '\n' ' ')"
  if [ "$DRY_RUN" = 1 ]; then
    warn "存在运行中的维护任务：$units"
    warn "真实卸载会被拒绝，请等待任务完成或先停止对应单元"
  else
    die "存在运行中的维护任务：$units。请等待完成或先停止后再卸载。"
  fi
}

unfinished() {
  warn "$1"
  UNFINISHED_ITEMS+=("$1")
  FAILED=1
}

platform_helper_available() { [ -x "$SCRIPT_DIR/../platform-helper" ] || [ -x "$INSTALL_ROOT/current/platform-helper" ] || command -v bun >/dev/null 2>&1; }
uninstall_platform_helper() {
 if [ -x "$SCRIPT_DIR/../platform-helper" ]; then "$SCRIPT_DIR/../platform-helper" "$@"
 elif [ -x "$INSTALL_ROOT/current/platform-helper" ]; then "$INSTALL_ROOT/current/platform-helper" "$@"
 else bun "$SCRIPT_DIR/install-platform.mjs" "$@"; fi
}

caddy_api_snapshot() { # 仅本机 Unix socket；配置可能含凭据，调用方提供私有路径。
  local socket="$1" output="$2" status
  uninstall_platform_helper socket "$socket" >/dev/null || return 1
  status="$(curl -sS --noproxy '*' --connect-timeout 2 --max-time 5 --max-filesize 4194304 \
    --unix-socket "$socket" -o "$output" -w '%{http_code}' http://localhost/config/ 2>/dev/null)" || return 1
  [ "$status" = 200 ] && uninstall_platform_helper validate "$output"
}

caddy_runtime_matches_disk() {
  platform_helper_available || return 1
  ensure_backup_dir || return 1
  local work
  work="$(mktemp -d "$BACKUP_DIR/caddy-check.XXXXXX")" || return 1
  CADDY_UNINSTALL_RUNTIME_FILE="$work/runtime.json"
  (umask 077
    caddy adapt --config "$CADDYFILE_PATH" --adapter caddyfile >"$work/disk.json" 2>"$work/check.log" &&
    caddy_api_snapshot "$CADDY_SOCKET" "$work/runtime.json" >>"$work/check.log" 2>&1 &&
    uninstall_platform_helper equal "$work/disk.json" "$work/runtime.json" >>"$work/check.log" 2>&1
  )
}

dependency_present() {
  local package
  command -v "$1" >/dev/null 2>&1 && return 0
  while IFS= read -r package; do if platform_package_present "$package"; then return 0; fi; done < <(platform_packages "$1")
  [ -e "$PLATFORM_RECEIPTS/$1" ] || [ -L "$PLATFORM_RECEIPTS/$1" ]
}

uninstall_docker() {
  timeout 15s env DOCKER_HOST= DOCKER_CONTEXT= DOCKER_TLS= DOCKER_TLS_VERIFY= DOCKER_CERT_PATH= DOCKER_API_VERSION= \
    docker --host unix:///var/run/docker.sock "$@"
}

dependency_unused() { # 原因不含业务配置原文；失败不能被解释成空实例。
  local component="$1" kind inventory dir="$PLATFORM_RECEIPTS/$1" state socket work command_line package installed=0 selected
  selected="$(platform_removal_packages "$component")" || { printf '没有可信安装收据；如需清理该旧组件，请显式添加 --remove-legacy-components %s' "$component"; return 1; }
  [ -n "$selected" ] || { printf '该组件没有可核对的 Debian 软件包，不能按包清理'; return 1; }
  while IFS= read -r package; do if platform_package_installed "$package"; then installed=1; fi; done <<<"$selected"
  # 软件包已移除时仅处理残留配置、源和收据，不再依赖已不存在的服务 API。
  [ "$installed" = 1 ] || return 0
  if [ "$component" = docker ]; then
    uninstall_docker info >/dev/null 2>&1 || { printf 'Docker 未响应，无法确认是否仍有业务资源'; return 1; }
    for kind in containers images volumes networks; do
      case "$kind" in
        containers) inventory="$(uninstall_docker ps -aq 2>/dev/null)" ;;
        images) inventory="$(uninstall_docker image ls -aq 2>/dev/null)" ;;
        volumes) inventory="$(uninstall_docker volume ls -q 2>/dev/null)" ;;
        networks) inventory="$(uninstall_docker network ls --filter type=custom -q 2>/dev/null)" ;;
      esac || { printf '无法读取 Docker %s 清单' "$kind"; return 1; }
      [ -z "$inventory" ] || { printf '仍存在 Docker %s，先明确处置业务资源再卸载' "$kind"; return 1; }
    done
    if command -v ctr >/dev/null 2>&1; then
      inventory="$(timeout 5s ctr namespaces list -q 2>/dev/null)" || { printf '无法核对 containerd 的其他使用方'; return 1; }
      inventory="$(printf '%s\n' "$inventory" | grep -Ev '^(moby|plugins.moby)?$' || true)"
      [ -z "$inventory" ] || { printf 'containerd 存在 Docker 之外的命名空间'; return 1; }
    fi
  else
    platform_helper_available || { printf '缺少平台配置辅助程序，无法核验 Caddy 完整配置'; return 1; }
    if platform_explicit_legacy caddy; then
      legacy_caddy_unused
      return "$?"
    fi
    platform_private_file "$dir/baseline.complete" && platform_private_file "$dir/caddyfile.sha256" &&
      platform_private_file "$dir/runtime.json" && platform_private_file "$dir/socket" || { printf '没有可证明未使用的 Caddy 默认配置基线'; return 1; }
    platform_no_links "$CADDYFILE_PATH" && [ -f "$CADDYFILE_PATH" ] &&
      [ "$(sha256sum "$CADDYFILE_PATH" | cut -d ' ' -f 1)" = "$(cat "$dir/caddyfile.sha256")" ] || { printf 'Caddyfile 已修改、缺失或路径异常'; return 1; }
    command_line="$(systemctl show -p ExecStart --value caddy)" &&
      uninstall_platform_helper service "$command_line" "$CADDYFILE_PATH" >/dev/null 2>&1 || { printf 'Caddy 使用了不同的启动方式'; return 1; }
    state="$(systemctl show -p ActiveState --value caddy)" || { printf '无法确认 Caddy 状态'; return 1; }
    [ "$state" = active ] || { printf 'Caddy 未运行，无法核验是否仍有动态业务路由'; return 1; }
    socket="$(cat "$dir/socket")"
    ensure_backup_dir || { printf '无法创建卸载备份'; return 1; }
    work="$(mktemp -d "$BACKUP_DIR/caddy-unused.XXXXXX")" || return 1
    (umask 077; caddy_api_snapshot "$socket" "$work/runtime.json" >"$work/check.log" 2>&1 &&
      uninstall_platform_helper equal "$dir/runtime.json" "$work/runtime.json" >>"$work/check.log" 2>&1) || { printf 'Caddy 运行配置发生改变或管理 API 不可核验'; return 1; }
  fi
}

legacy_caddy_unused() {
  local command_line state work endpoint
  platform_no_links "$CADDYFILE_PATH" && [ -f "$CADDYFILE_PATH" ] || { printf '旧 Caddy 启动配置缺失或路径异常'; return 1; }
  command_line="$(systemctl show -p ExecStart --value caddy)" &&
    uninstall_platform_helper service "$command_line" "$CADDYFILE_PATH" >/dev/null 2>&1 || { printf '旧 Caddy 启动方式无法安全识别'; return 1; }
  state="$(systemctl show -p ActiveState --value caddy)" || return 1
  [ "$state" = active ] || { printf '旧 Caddy 未运行，无法排除尚未落盘的动态路由'; return 1; }
  ensure_backup_dir || return 1
  work="$(mktemp -d "$BACKUP_DIR/caddy-legacy.XXXXXX")" || return 1
  if ! (umask 077
    printf ':80 {\n\troot * /usr/share/caddy\n\tfile_server\n}\n' >"$work/default.Caddyfile" &&
    caddy adapt --config "$CADDYFILE_PATH" --adapter caddyfile >"$work/disk.json" 2>"$work/check.log" &&
    caddy adapt --config "$work/default.Caddyfile" --adapter caddyfile >"$work/default.json" 2>>"$work/check.log" &&
    uninstall_platform_helper legacy-caddy-default "$work/disk.json" "$work/default.json" "$CADDYFILE_PATH" "$work/default.Caddyfile" "$CADDY_SOCKET" >>"$work/check.log" 2>&1 &&
    endpoint="$(uninstall_platform_helper endpoint "$work/disk.json")" &&
    uninstall_platform_helper wait "$endpoint" "$work/runtime.json" "$work/disk.json" 1 0 5 >>"$work/check.log" 2>&1
  ); then
    printf '旧 Caddy 存在业务配置、动态路由或 API 不可核验，拒绝清理；私有诊断：%s' "$work/check.log"
    return 1
  fi
}

remove_dependencies() {
  local component reason log
  for component in caddy docker; do
    dependency_present "$component" || continue
    if [ "$KEEP_DEPENDENCIES" = 1 ] || { [ "$component" = caddy ] && [ "$KEEP_CADDY_CONFIG" = 1 ]; }; then
      KEPT_ITEMS+=("$component（按保留选项）")
      continue
    fi
    if ! reason="$(dependency_unused "$component" 2>&1)"; then
      unfinished "$component 未清理：$reason"
      continue
    fi
    ensure_backup_dir || { unfinished "$component 卸载备份目录创建失败"; continue; }
    if platform_receipt_valid "$component"; then
      if ! cp -a "$PLATFORM_RECEIPTS/$component" "$BACKUP_DIR/$component-receipt"; then
        unfinished "$component 安装收据备份失败，未移除软件包"
        continue
      fi
    else
      (umask 077; printf '%s\n' "$component" >"$BACKUP_DIR/$component-explicit-legacy") || { unfinished "$component 显式旧组件清理记录保存失败"; continue; }
    fi
    if [ "$component" = caddy ] && ! backup_file "$CADDYFILE_PATH" Caddyfile; then
      unfinished "Caddyfile 备份失败，未移除 Caddy"
      continue
    fi
    log="$BACKUP_DIR/$component-purge.log"
    (umask 077; : >"$log")
    if ! platform_purge_packages "$component" "$log"; then
      unfinished "$component 包清理未完成或会影响其他软件；私有日志：$log"
      continue
    fi
    if systemctl is-active --quiet "$component" 2>/dev/null; then
      unfinished "$component 软件包已移除，但服务仍在运行，请先核对 systemctl status $component；收据及辅助配置保留"
      continue
    fi
    if [ "$component" = docker ] && [ -e /run/docker.sock ]; then
      if systemctl is-active --quiet docker.socket 2>/dev/null ||
         ! uninstall_platform_helper remove-stale-socket /run/docker.sock >>"$log" 2>&1; then
        unfinished "Docker 软件包已移除，但 /run/docker.sock 的状态无法确认，未清理；私有日志：$log"
        continue
      fi
    fi
    if [ "$component" = caddy ]; then CADDY_PACKAGE_REMOVED=1; fi
    if ! platform_remove_assets "$component"; then
      unfinished "$component 已卸载，但部分源或公钥已被修改，已保留并记录：$PLATFORM_RECEIPTS/$component"
      continue
    fi
    platform_remove_receipt "$component" || { unfinished "$component 安装记录异常，未清理"; continue; }
    DELETED_ITEMS+=("$component 软件包及清单内的源与公钥")
  done
}

verify_retained_services() {
  local command_line state
  command -v caddy >/dev/null 2>&1 || return 0
  command_line="$(systemctl show -p ExecStart --value caddy 2>/dev/null || true)"
  case "$command_line" in
    *"$CADDYFILE_PATH"*)
      if [ ! -f "$CADDYFILE_PATH" ] || [ -L "$CADDYFILE_PATH" ]; then
        unfinished "保留的 Caddy 启动配置缺失或路径异常：$CADDYFILE_PATH"
        return 0
      fi
      if [ "$(systemctl show -p User --value caddy)" = caddy ] && ! runuser -u caddy -- test -r "$CADDYFILE_PATH"; then
        unfinished "保留的 Caddy 服务用户无法读取配置：$CADDYFILE_PATH"
      fi ;;
  esac
  state="$(systemctl show -p ActiveState --value caddy 2>/dev/null || true)"
  if [ "$state" = failed ]; then unfinished "保留的 Caddy 服务处于 failed，请查看 journalctl -u caddy -n 50 --no-pager"; fi
}

data_category_paths() {
  case "$1" in
    data) printf '%s\n' "$DATA_ROOT/data" ;;
    config) printf '%s\n' "$DATA_ROOT/config" ;;
    logs) printf '%s\n' "$DATA_ROOT/logs" ;;
    state) printf '%s\n' "$DATA_ROOT/backups" "$DATA_ROOT/state" "$DATA_ROOT/tmp" "$CLI_DATA_DIR" ;;
  esac
}

data_category_label() {
  case "$1" in
    data) printf '数据' ;;
    config) printf '配置' ;;
    logs) printf '日志' ;;
    state) printf '备份/状态' ;;
  esac
}

data_category_note() {
  case "$1" in
    data) printf 'metrics/firewall/logs/harness.sqlite、data/sqlite 托管实例、Agent 记录' ;;
    config) printf '凭据、端口、数据库/网站/容器登记、SSO 白名单、站点证书、Agent 配置' ;;
    logs) printf 'panel.log 等面板日志' ;;
    state) printf 'backups、state、tmp、ely CLI 本地数据（%s）' "$CLI_DATA_DIR" ;;
  esac
}

get_data_flag() {
  case "$1" in
    data) printf '%s' "$DELETE_DATA" ;;
    config) printf '%s' "$DELETE_CONFIG" ;;
    logs) printf '%s' "$DELETE_LOGS" ;;
    state) printf '%s' "$DELETE_STATE" ;;
  esac
}

set_data_flag() {
  case "$1" in
    data) DELETE_DATA="$2" ;;
    config) DELETE_CONFIG="$2" ;;
    logs) DELETE_LOGS="$2" ;;
    state) DELETE_STATE="$2" ;;
  esac
}

data_category_exists() {
  local path
  while IFS= read -r path; do
    { [ -e "$path" ] || [ -L "$path" ]; } && return 0
  done <<EOF
$(data_category_paths "$1")
EOF
  return 1
}

data_category_size() {
  local path total=0 found=0 size
  while IFS= read -r path; do
    { [ -e "$path" ] || [ -L "$path" ]; } || continue
    found=1
    size="$(du -sk "$path" 2>/dev/null | awk '{print $1}' || true)"
    case "$size" in ''|*[!0-9]*) size=0 ;; esac
    total=$((total + size))
  done <<EOF
$(data_category_paths "$1")
EOF
  if [ "$found" = 0 ]; then
    printf '不存在'
  elif [ "$total" -ge 1048576 ]; then
    printf '%s GiB' "$((total / 1048576))"
  elif [ "$total" -ge 1024 ]; then
    printf '%s MiB' "$((total / 1024))"
  else
    printf '%s KiB' "$total"
  fi
}

caddy_parent_dir() {
  dirname "$CADDY_SOCKET"
}

caddy_runtime_expected() {
  local parent
  parent="$(caddy_parent_dir)"
  case "$parent" in
    /run/*) printf '[Service]\nRuntimeDirectory=%s\nRuntimeDirectoryMode=0755\n' "${parent#/run/}" ;;
    *) return 1 ;;
  esac
}

caddy_tmpfiles_expected() {
  printf 'd %s 0755 caddy caddy -\n' "$(caddy_parent_dir)"
}

caddyfile_admin_line() {
  printf 'admin unix/%s' "$CADDY_SOCKET"
}

caddyfile_admin_scan() { # <源文件> [候选文件]：只在全局段删除精确 admin 行；找到返回 0
  local source="$1" candidate="${2:-}" target
  target="$(caddyfile_admin_line)"
  awk -v target="$target" -v candidate="$candidate" '
    BEGIN { depth=0; global=0; done=0; removed=0 }
    {
      line=$0
      trimmed=line
      gsub(/^[ \t]+|[ \t]+$/, "", trimmed)
      if (!global && !done) {
        if (trimmed == "{") {
          global=1; depth=1
          if (candidate != "") print > candidate
          next
        }
        if (trimmed == "" || trimmed ~ /^#/) {
          if (candidate != "") print > candidate
          next
        }
        done=1
      }
      if (global && !done) {
        if (depth == 1 && trimmed == target) { removed=1; next }
        if (candidate != "") print > candidate
        open_count=gsub(/\{/, "{", line)
        close_count=gsub(/\}/, "}", line)
        depth += open_count - close_count
        if (depth <= 0) { done=1; global=0 }
        next
      }
      if (candidate != "") print > candidate
    }
    END {
      if (candidate != "") close(candidate)
      exit (removed ? 0 : 3)
    }
  ' "$source"
}

detect_caddy() {
  CADDY_RUNTIME_MATCH=0
  CADDY_TMPFILES_MATCH=0
  CADDYFILE_ADMIN_FOUND=0
  [ -n "$CADDY_SOCKET" ] || return 0
  local expected_file
  if [ -f "$CADDY_RUNTIME_DROPIN" ]; then
    expected_file="$(mktemp)"
    if caddy_runtime_expected >"$expected_file" 2>/dev/null && cmp -s "$expected_file" "$CADDY_RUNTIME_DROPIN"; then
      CADDY_RUNTIME_MATCH=1
    fi
    rm -f "$expected_file"
  fi
  if [ -f "$CADDY_TMPFILES" ]; then
    expected_file="$(mktemp)"
    caddy_tmpfiles_expected >"$expected_file"
    if cmp -s "$expected_file" "$CADDY_TMPFILES"; then CADDY_TMPFILES_MATCH=1; fi
    rm -f "$expected_file"
  fi
  if [ -f "$CADDYFILE_PATH" ] && caddyfile_admin_scan "$CADDYFILE_PATH" 2>/dev/null; then
    CADDYFILE_ADMIN_FOUND=1
  fi
}

ufw_installed() {
  command -v ufw >/dev/null 2>&1
}

ufw_managed_rules() { # 只输出面板前端端口的精确规则，去掉 "ufw " 前缀
  ufw show added 2>/dev/null | sed -n 's/^[[:space:]]*ufw //p' | while IFS= read -r rule; do
    normalized="$(printf '%s' "$rule" | tr -d "'\"")"
    case "$normalized" in
      "allow ${FRONTEND_PORT}/tcp"|\
      "allow ${FRONTEND_PORT}/tcp comment Elysian 面板"|\
      "allow ${FRONTEND_PORT}/tcp comment 面板保底")
        printf '%s\n' "$rule" ;;
    esac
  done
}

delete_ufw_rule() {
  local rule="$1" comment
  case "$rule" in
    "allow ${FRONTEND_PORT}/tcp")
      ufw --force delete allow "${FRONTEND_PORT}/tcp" >/dev/null 2>&1 ;;
    "allow ${FRONTEND_PORT}/tcp comment "*)
      comment="${rule#* comment }"
      comment="${comment#\'}"; comment="${comment%\'}"
      comment="${comment#\"}"; comment="${comment%\"}"
      ufw --force delete allow "${FRONTEND_PORT}/tcp" comment "$comment" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

print_plan() {
  tui_banner "Elysian 卸载计划" "数据目录  $STATE_DIR/.Elysian"
  if [ "$PURGE_DATA" = 1 ]; then warn "彻底卸载：面板数据库、凭据、日志与缓存均会删除；需要保留请加 --keep-data。"; fi
  tui_section "将删除"
  tui_kv "服务" "systemd 单元与自启（$SERVICE_NAME）"
  tui_kv "程序" "$PANEL_BIN、$INSTALL_ROOT"
  tui_kv "CLI 命令" "${CLI_BIN}（仅删除本面板注册的符号链接；其他软件的同名文件保留）"
  tui_kv "安装配置" "$ENV_FILE、$MIRROR_PROFILE"
  tui_kv "构建残留" "$BUILD_HOME、/var/tmp/elysian-install-source.*、/tmp/elysian-build.*"
  if [ -n "$(ufw_managed_rules)" ]; then
    tui_kv "防火墙" "面板前端端口 ${FRONTEND_PORT}/tcp 的 Elysian 规则"
  else
    tui_kv "防火墙" "未发现面板前端规则"
  fi
  tui_kv "系统账号" "elysian-build 总是删除；elysian/elysian-sqlite 视数据保留情况"
  if [ "$KEEP_TOOLS" = 0 ]; then
    if platform_explicit_legacy go || platform_explicit_legacy bun; then
      tui_kv "工具链" "显式旧组件按标准路径清理（Go：/usr/local/go；Bun：/usr/local/bin/bun）；未指定组件仍核对收据"
    else
      tui_kv "工具链" "有可信收据且未被替换的 /usr/local/go、/usr/local/bin/bun；其他归属报告未清理"
    fi
  else
    tui_kv "工具链" "按 --keep-tools 保留"
  fi

  if [ "$PURGE_DATA" = 1 ]; then tui_section "面板数据（全部删除）"; else tui_section "面板数据（保留）"; fi
  local key
  for key in data config logs state; do
    if data_category_exists "$key"; then
      tui_kv "$(data_category_label "$key")" "$(data_category_size "$key")；$(data_category_note "$key")"
    else
      tui_kv "$(data_category_label "$key")" "不存在"
    fi
  done

  tui_section "系统依赖"
  local component
  for component in docker caddy; do
    if ! dependency_present "$component"; then
      tui_kv "$component" "未安装，无需清理"
    elif [ "$KEEP_DEPENDENCIES" = 1 ]; then
      tui_kv "$component" "按 --keep-dependencies 保留"
    elif platform_explicit_legacy "$component"; then
      tui_kv "$component" "按显式旧组件清单清理固定软件包、源与公钥；仍要求无业务资源"
    elif platform_receipt_valid "$component"; then
      tui_kv "$component" "由本安装器新增；核验未使用后清理软件包、未变更的新增 apt 源与公钥"
    else
      tui_kv "$component" "没有可信安装归属；可用 --remove-legacy-components $component 显式清理"
    fi
  done
  tui_kv "业务资源" "容器、镜像、卷不自动删除；存在业务资源时拒绝移除 Docker"
  tui_section "Caddy 接入"
  local caddyfile_label runtime_label tmpfiles_label
  if [ -z "$CADDY_SOCKET" ]; then
    tui_kv "Caddy" "socket 路径无法解析，跳过"
    return 0
  fi
  if [ "$CADDYFILE_ADMIN_FOUND" = 1 ]; then
    caddyfile_label="已找到 admin unix/$CADDY_SOCKET"
  else
    caddyfile_label="未找到 Elysian 指令"
  fi
  if [ "$CADDY_RUNTIME_MATCH" = 1 ]; then runtime_label="内容一致，可移除"; else runtime_label="未匹配，保留"; fi
  if [ "$CADDY_TMPFILES_MATCH" = 1 ]; then tmpfiles_label="内容一致，可移除"; else tmpfiles_label="未匹配，保留"; fi
  tui_kv "Caddyfile" "$caddyfile_label"
  tui_kv "drop-in" "$runtime_label"
  tui_kv "tmpfiles" "$tmpfiles_label"
}

select_data_categories() {
  if [ "$PURGE_DATA" = 1 ]; then
    DELETE_DATA=1; DELETE_CONFIG=1; DELETE_LOGS=1; DELETE_STATE=1
    return 0
  fi
  [ "$KEEP_DATA" = 0 ] || return 0
  [ "$DRY_RUN" = 0 ] || return 0
  if [ "$ASSUME_YES" = 1 ]; then
    return 0
  fi
  local key answer
  for key in data config logs state; do
    if ! data_category_exists "$key"; then
      skip "$(data_category_label "$key")：路径不存在，跳过"
      continue
    fi
    printf '  删除%s（%s）？[y/N] ' "$(data_category_label "$key")" "$(data_category_note "$key")"
    if ! read -r answer; then die "输入结束，未做任何变更。"; fi
    case "$answer" in
      y|Y|yes|YES)
        set_data_flag "$key" 1
        ok "将删除$(data_category_label "$key")" ;;
      *)
        skip "保留$(data_category_label "$key")" ;;
    esac
  done
}

select_caddy() {
  [ "$KEEP_CADDY_CONFIG" = 0 ] || CADDY_REMOVE=0
}

accounts_summary() {
  local keep_panel=0 keep_sqlite=0 key
  for key in data config logs state; do
    if [ "$(get_data_flag "$key")" = 0 ] && data_category_exists "$key"; then keep_panel=1; fi
  done
  if [ "$DELETE_DATA" = 0 ] && data_category_exists data; then keep_sqlite=1; fi
  if [ "$keep_panel" = 0 ] && [ "$keep_sqlite" = 0 ]; then
    printf '删除 elysian、elysian-build、elysian-sqlite'
  elif [ "$keep_panel" = 1 ] && [ "$keep_sqlite" = 1 ]; then
    printf '删除 elysian-build；保留 elysian、elysian-sqlite（数据仍存在）'
  elif [ "$keep_panel" = 1 ]; then
    printf '删除 elysian-build、elysian-sqlite；保留 elysian（配置/日志仍存在）'
  else
    printf '删除 elysian、elysian-build；保留 elysian-sqlite（SQLite 数据仍存在）'
  fi
}

print_final_plan() {
  tui_section "执行摘要"
  if [ "$PURGE_DATA" = 1 ]; then
    tui_kv "面板数据" "全部删除（$STATE_DIR，含未分类文件）"
  else
    local key deleted="" kept=""
    for key in data config logs state; do
      if [ "$(get_data_flag "$key")" = 1 ]; then
        deleted+="${deleted:+、}$(data_category_label "$key")"
      else
        kept+="${kept:+、}$(data_category_label "$key")"
      fi
    done
    tui_kv "删除数据" "${deleted:-无}"
    tui_kv "保留数据" "${kept:-无}"
  fi
  if [ "$CADDY_REMOVE" = 1 ]; then
    tui_kv "Caddy 配置" "移除 Elysian 管理通道接入"
  else
    tui_kv "Caddy 配置" "保留"
  fi
  tui_kv "系统账号" "$(accounts_summary)"
  if [ "$KEEP_DEPENDENCIES" = 1 ]; then tui_kv "依赖" "保留 Docker/Caddy"; else tui_kv "依赖" "清理有可信归属且未使用的 Docker/Caddy；其余明确报告"; fi
  if [ -n "$UNINSTALL_LEGACY_COMPONENTS" ]; then tui_kv "显式清理旧组件" "$UNINSTALL_LEGACY_COMPONENTS（不会伪造安装收据，保留选项优先）"; fi
  if [ "$KEEP_TOOLS" = 1 ]; then
    tui_kv "工具链" "保留"
  else
    tui_kv "工具链" "删除本面板安装路径"
  fi
}

confirm_plan() {
  [ "$ASSUME_YES" = 1 ] && return 0
  local answer
  printf '  确认执行以上卸载？[y/N] '
  if ! read -r answer; then return 1; fi
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

ensure_backup_dir() {
  [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ] && return 0
  BACKUP_DIR="$BACKUP_ROOT/elysian-uninstall-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$BACKUP_DIR" && chmod 0700 "$BACKUP_DIR" || {
    warn "无法创建备份目录 $BACKUP_DIR"
    BACKUP_DIR=""
    return 1
  }
}

backup_file() { # <文件> <备份名>
  local file="$1" name="$2"
  [ -e "$file" ] || return 0
  ensure_backup_dir || return 1
  cp -p "$file" "$BACKUP_DIR/$name" || return 1
}

usection() {
  tui_finish_stage
  STAGE=$((STAGE + 1))
  tui_stage "$STAGE" "$TOTAL_STAGES" "$1"
  tui_begin_stage
}

stop_service() {
  if [ -e "$UNIT_FILE" ] || systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    info "停止并注销服务 $SERVICE_NAME"
    if ! systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
      unfinished "无法确认面板服务已停止，未删除程序或数据；请检查 systemctl status $SERVICE_NAME"
      return 1
    fi
    if rm -f "$UNIT_FILE"; then
      systemctl daemon-reload || true
      systemctl reset-failed "$SERVICE_NAME" >/dev/null 2>&1 || true
      ok "服务已停止、禁用并移除"
      DELETED_ITEMS+=("systemd 服务与自启")
    else
      warn "删除 $UNIT_FILE 失败"
      FAILED=1
    fi
  else
    skip "未发现 systemd 单元，跳过"
  fi
}

remove_ufw() {
  if ! ufw_installed; then
    skip "UFW 未安装"
    return 0
  fi
  local rules rule count=0
  rules="$(ufw_managed_rules)"
  if [ -z "$rules" ]; then
    skip "未发现面板前端 UFW 规则"
    return 0
  fi
  while IFS= read -r rule; do
    [ -n "$rule" ] || continue
    info "删除 UFW 规则：$rule"
    if delete_ufw_rule "$rule"; then
      count=$((count + 1))
    else
      warn "删除 UFW 规则失败：$rule"
      FAILED=1
    fi
  done <<EOF
$rules
EOF
  if [ "$count" -gt 0 ]; then
    ok "已删除 $count 条面板前端 UFW 规则"
    DELETED_ITEMS+=("UFW 面板前端规则")
  fi
  if [ -n "$(ufw_managed_rules)" ]; then
    warn "仍有面板 UFW 规则残留，请手工检查：ufw show added"
    FAILED=1
  fi
}

remove_caddy() {
  if [ "$CADDY_PACKAGE_REMOVED" = 1 ]; then
    remove_managed_caddy_auxiliary
    return 0
  fi
  if [ "$CADDY_REMOVE" != 1 ]; then
    skip "保留 Caddy 管理通道配置"
    KEPT_ITEMS+=("Caddy 管理通道配置")
    return 0
  fi
  if [ -z "$CADDY_SOCKET" ]; then
    skip "Caddy socket 路径无法解析，跳过"
    return 0
  fi
  if [ "$CADDYFILE_ADMIN_FOUND" = 0 ] && { [ "$CADDY_RUNTIME_MATCH" = 1 ] || [ "$CADDY_TMPFILES_MATCH" = 1 ]; }; then
    unfinished "Caddyfile 未确认脱离管理 socket，保留目录辅助配置，避免破坏既有服务"
    return 0
  fi
  local caddyfile_removed=0 candidate
  if [ -f "$CADDYFILE_PATH" ] && [ "$CADDYFILE_ADMIN_FOUND" = 1 ]; then
    if [ -L "$CADDYFILE_PATH" ]; then
      warn "Caddyfile 是符号链接，拒绝自动改写"
      FAILED=1
      return 0
    fi
    if ! backup_file "$CADDYFILE_PATH" "Caddyfile"; then
      warn "Caddyfile 备份失败，未改动"
      FAILED=1
      return 0
    fi
    # reload 会以磁盘文件替换运行配置；有动态业务路由时拒绝这样做。
    if systemctl is-active --quiet caddy 2>/dev/null; then
      if ! caddy_runtime_matches_disk; then
        unfinished "Caddy 管理配置：运行配置与磁盘不同或无法核验，保留路由与管理通道；备份：$BACKUP_DIR"
        return 0
      fi
    fi
    candidate="$(mktemp "$(dirname "$CADDYFILE_PATH")/.elysian-uninstall.XXXXXX")" || {
      warn "无法创建 Caddyfile 候选文件"
      FAILED=1
      return 0
    }
    if ! caddyfile_admin_scan "$CADDYFILE_PATH" "$candidate"; then
      rm -f "$candidate"
      warn "未能精确移除 Caddyfile admin 指令，原文件保留"
      FAILED=1
      return 0
    fi
    if ! command -v caddy >/dev/null 2>&1; then
      rm -f "$candidate"
      warn "未找到 caddy CLI，无法校验候选配置，Caddyfile 保留"
      FAILED=1
      return 0
    fi
    if ! caddy validate --config "$candidate" --adapter caddyfile >/dev/null 2>&1; then
      rm -f "$candidate"
      warn "Caddyfile 候选校验失败，原文件保留"
      FAILED=1
      return 0
    fi
    if ! chmod --reference="$CADDYFILE_PATH" "$candidate" || ! chown --reference="$CADDYFILE_PATH" "$candidate"; then
      rm -f "$candidate"
      unfinished "Caddyfile 元数据无法保留，原文件与管理通道保持完整"
      return 0
    fi
    if ! cmp -s "$CADDYFILE_PATH" "$BACKUP_DIR/Caddyfile"; then
      rm -f "$candidate"
      unfinished "Caddyfile 在卸载预检后发生变化，未发布候选配置"
      return 0
    fi
    if ! mv -f "$candidate" "$CADDYFILE_PATH"; then
      rm -f "$candidate"
      warn "Caddyfile 替换失败，原文件保留"
      FAILED=1
      return 0
    fi
    caddyfile_removed=1
    ok "已移除 Caddyfile 中的 Elysian admin 指令"
  fi

  # reload 必须在旧管理端点及其目录仍在时执行，失败则只恢复配置并保留辅助文件。
  if [ "$caddyfile_removed" = 1 ] && systemctl is-active --quiet caddy 2>/dev/null; then
    if ! caddy reload --config "$CADDYFILE_PATH" --adapter caddyfile --address "unix/$CADDY_SOCKET" >/dev/null 2>&1 ||
       ! (umask 077
          caddy adapt --config "$CADDYFILE_PATH" --adapter caddyfile >"$BACKUP_DIR/caddy-after.json" 2>"$BACKUP_DIR/caddy-after.log" &&
          uninstall_platform_helper wait tcp:localhost:2019 "$BACKUP_DIR/caddy-verified.json" "$BACKUP_DIR/caddy-after.json" 3 0.1 10 >>"$BACKUP_DIR/caddy-after.log" 2>&1); then
      if cp -p "$BACKUP_DIR/Caddyfile" "$CADDYFILE_PATH" &&
         { caddy reload --config "$CADDYFILE_PATH" --adapter caddyfile --address "unix/$CADDY_SOCKET" >/dev/null 2>&1 ||
           caddy reload --config "$CADDYFILE_PATH" --adapter caddyfile --address localhost:2019 >/dev/null 2>&1; } &&
         (umask 077; uninstall_platform_helper wait "unix:$CADDY_SOCKET" "$BACKUP_DIR/caddy-restored.json" "${CADDY_UNINSTALL_RUNTIME_FILE:-}" 3 0.1 10 >/dev/null 2>&1); then
        unfinished "Caddy reload 失败，原文件与运行配置已核验恢复，管理通道辅助文件保留；备份：$BACKUP_DIR"
      else
        unfinished "Caddy reload 失败且恢复结果未确认，管理通道辅助文件保留；请先检查私有备份及 Caddy 服务：$BACKUP_DIR"
      fi
      return 0
    fi
  fi
  if [ "$caddyfile_removed" = 1 ]; then DELETED_ITEMS+=("Caddyfile admin 指令"); fi
  remove_managed_caddy_auxiliary
  rmdir "$(caddy_parent_dir)" 2>/dev/null || true
}

remove_managed_caddy_auxiliary() {
  if [ "$CADDY_RUNTIME_MATCH" = 1 ]; then
    backup_file "$CADDY_RUNTIME_DROPIN" "elysian-runtime.conf" || { unfinished "Caddy runtime drop-in 备份失败，原文件保留"; return 0; }
    if rm -f "$CADDY_RUNTIME_DROPIN"; then
      DELETED_ITEMS+=("Caddy runtime drop-in")
    else
      warn "删除 Caddy runtime drop-in 失败"
      FAILED=1
    fi
  elif [ -f "$CADDY_RUNTIME_DROPIN" ]; then
    KEPT_ITEMS+=("Caddy runtime drop-in（内容不匹配）")
    unfinished "Caddy runtime drop-in 内容已改变，未清理：$CADDY_RUNTIME_DROPIN"
  fi

  if [ "$CADDY_TMPFILES_MATCH" = 1 ]; then
    backup_file "$CADDY_TMPFILES" "elysian-caddy.conf" || { unfinished "Caddy tmpfiles 备份失败，原文件保留"; return 0; }
    if rm -f "$CADDY_TMPFILES"; then
      DELETED_ITEMS+=("Caddy tmpfiles")
    else
      warn "删除 Caddy tmpfiles 失败"
      FAILED=1
    fi
  elif [ -f "$CADDY_TMPFILES" ]; then
    KEPT_ITEMS+=("Caddy tmpfiles（内容不匹配）")
    unfinished "Caddy tmpfiles 内容已改变，未清理：$CADDY_TMPFILES"
  fi
  systemctl daemon-reload >/dev/null 2>&1 || true
  rmdir "$(dirname "$CADDY_RUNTIME_DROPIN")" 2>/dev/null || true

}

remove_artifacts() {
  local item
  # ely 链接先于 INSTALL_ROOT 删除：仅删本面板注册的符号链接，其他软件的同名文件保留并提示。
  if [ -e "$CLI_BIN" ] || [ -L "$CLI_BIN" ]; then
    if cli_link_owned; then
      if rm -f -- "$CLI_BIN"; then
        ok "已删除 $CLI_BIN"
      else
        warn "删除失败：$CLI_BIN"
        FAILED=1
      fi
    else
      warn "$CLI_BIN 非本面板注册的符号链接（其他软件的同名文件），已保留"
      KEPT_ITEMS+=("${CLI_BIN}（非本面板安装，已保留）")
    fi
  else
    skip "$CLI_BIN 不存在，跳过"
  fi
  for item in "$PANEL_BIN" "$INSTALL_ROOT"; do
    if [ -e "$item" ] || [ -L "$item" ]; then
      if rm -rf -- "$item"; then
        ok "已删除 $item"
      else
        warn "删除失败：$item"
        FAILED=1
      fi
    fi
  done
  if [ -e "$ENV_FILE" ]; then
    if backup_file "$ENV_FILE" "default-elysian"; then
      if rm -f "$ENV_FILE"; then ok "已删除 $ENV_FILE"; else warn "删除失败：$ENV_FILE"; FAILED=1; fi
    else
      unfinished "备份 $ENV_FILE 失败，原文件未清理"
      ENV_KEPT=1
      KEPT_ITEMS+=("$ENV_FILE（备份失败）")
    fi
  fi
  if [ -e "$MIRROR_PROFILE" ]; then
    if rm -f "$MIRROR_PROFILE"; then ok "已删除 $MIRROR_PROFILE"; else warn "删除失败：$MIRROR_PROFILE"; FAILED=1; fi
  fi
  if [ -d "$BUILD_HOME" ]; then
    if rm -rf -- "$BUILD_HOME"; then ok "已删除 $BUILD_HOME"; else warn "删除失败：$BUILD_HOME"; FAILED=1; fi
  fi
  local item pattern
  for pattern in "${ARTIFACT_GLOBS[@]}"; do
    for item in $pattern; do
      [ -e "$item" ] || continue
      if rm -rf -- "$item"; then
        DELETED_ITEMS+=("$item")
      else
        warn "删除失败：$item"
        FAILED=1
      fi
    done
  done
  local remaining=0
  for item in "$PANEL_BIN" "$INSTALL_ROOT" "$MIRROR_PROFILE" "$BUILD_HOME"; do
    if [ -e "$item" ] || [ -L "$item" ]; then remaining=1; fi
  done
  if [ "$ENV_KEPT" = 0 ] && { [ -e "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; }; then remaining=1; fi
  if [ "$remaining" = 0 ]; then
    ok "安装产物已清理"
    DELETED_ITEMS+=("程序、安装配置与构建残留")
  else unfinished "安装产物未全部清理，请按残留检查中的路径处理"; fi
}

remove_tools() {
  if [ "$KEEP_TOOLS" = 1 ]; then
    skip "按 --keep-tools 保留 Go 与 bun"
    KEPT_ITEMS+=("Go/bun 工具链")
    return 0
  fi
  if [ -d /usr/local/go ]; then
    if platform_tool_owned go /usr/local/go/bin/go || platform_legacy_path_removable go /usr/local/go; then
      EXPECT_DELETE_GO=1
      /usr/local/go/bin/go env -u GOPROXY >/dev/null 2>&1 || true
      if rm -rf -- /usr/local/go; then
        ok "已删除指定 Go 安装目录"
        platform_remove_receipt go || unfinished "Go 安装收据未清理"
        DELETED_ITEMS+=("Go 工具链")
      else unfinished "删除 /usr/local/go 失败"; fi
    else unfinished "Go 未清理：没有可信安装归属或工具已改变；用 --remove-legacy-components go 显式清理，或 --keep-tools 保留"; fi
  fi
  if [ -e /usr/local/bin/bun ] || [ -L /usr/local/bin/bun ]; then
    if platform_tool_owned bun /usr/local/bin/bun || platform_legacy_path_removable bun /usr/local/bin/bun; then
      EXPECT_DELETE_BUN=1
      if rm -f -- /usr/local/bin/bun; then
        ok "已删除指定 Bun 安装文件"
        platform_remove_receipt bun || unfinished "Bun 安装收据未清理"
        DELETED_ITEMS+=("Bun 工具链")
      else unfinished "删除 /usr/local/bin/bun 失败"; fi
    else unfinished "Bun 未清理：没有可信安装归属或工具已改变；用 --remove-legacy-components bun 显式清理，或 --keep-tools 保留"; fi
  fi
  hash -r
  command -v go >/dev/null 2>&1 && warn "检测到其它位置的 Go（$(command -v go)），非本面板安装路径，已保留"
  command -v bun >/dev/null 2>&1 && warn "检测到其它位置的 bun（$(command -v bun)），非本面板安装路径，已保留"
  rmdir "$PLATFORM_RECEIPTS" 2>/dev/null || true
}

safe_rm() {
  local path="$1"
  case "$path" in
    ''|'/'|'.'|'..'|*'/../'*|*/..) die "拒绝删除危险路径：$path" ;;
  esac
  case "$path" in
    "$STATE_DIR"/*) : ;;
    "$CLI_DATA_DIR"|"$CLI_DATA_DIR"/*) : ;;
    *) die "拒绝删除面板数据目录之外的路径：$path" ;;
  esac
  [ -e "$path" ] || [ -L "$path" ] || return 0
  rm -rf -- "$path"
}

remove_data() {
  if [ "$PURGE_DATA" = 1 ]; then
    [ "$STATE_DIR" = "$PURGE_GUARD" ] || die "STATE_DIR 非预期，拒绝彻底删除：$STATE_DIR"
    if [ -e "$STATE_DIR" ]; then
      if rm -rf -- "$STATE_DIR"; then
        ok "已删除整个 $STATE_DIR（含未分类文件）"
      else
        warn "删除 $STATE_DIR 失败"
        FAILED=1
      fi
    else
      skip "$STATE_DIR 不存在"
    fi
    if [ -e "$CLI_DATA_DIR" ] || [ -L "$CLI_DATA_DIR" ]; then
      if rm -rf -- "$CLI_DATA_DIR"; then
        ok "已删除 root 的 ely CLI 本地数据 $CLI_DATA_DIR"
      else
        warn "删除 $CLI_DATA_DIR 失败"
        FAILED=1
      fi
    fi
    rmdir "${CLI_DATA_DIR%/cli}" 2>/dev/null || true
    if [ ! -e "$STATE_DIR" ] && [ ! -L "$STATE_DIR" ] && [ ! -e "$CLI_DATA_DIR" ] && [ ! -L "$CLI_DATA_DIR" ]; then
      DELETED_ITEMS+=("全部面板数据")
    else unfinished "面板数据未全部删除，请按残留检查中的路径处理"; fi
    return 0
  fi

  local key path deleted_any
  for key in data config logs state; do
    [ "$(get_data_flag "$key")" = 1 ] || continue
    deleted_any=0
    while IFS= read -r path; do
      { [ -e "$path" ] || [ -L "$path" ]; } || continue
      deleted_any=1
      if safe_rm "$path"; then :; else warn "删除失败：$path"; FAILED=1; fi
    done <<EOF
$(data_category_paths "$key")
EOF
    if [ "$deleted_any" = 1 ]; then
      DELETED_ITEMS+=("$(data_category_label "$key")")
    else
      skip "$(data_category_label "$key") 路径不存在"
    fi
  done

  local dir
  for dir in "$DATA_ROOT/data" "$DATA_ROOT/config" "$DATA_ROOT/logs" "$DATA_ROOT/backups" "$DATA_ROOT/state" "$DATA_ROOT/tmp" "$DATA_ROOT" "$STATE_DIR" "$CLI_DATA_DIR" "${CLI_DATA_DIR%/cli}"; do
    [ -d "$dir" ] && rmdir "$dir" 2>/dev/null || true
  done

  for key in data config logs state; do
    if [ "$(get_data_flag "$key")" = 0 ] && data_category_exists "$key"; then
      KEPT_ITEMS+=("$(data_category_label "$key")")
    fi
  done

  if [ -d "$STATE_DIR" ] && [ -n "$(ls -A "$STATE_DIR" 2>/dev/null | sed -n '1p')" ]; then
    warn "以下未分类内容仍保留在 $STATE_DIR："
    ls -A "$STATE_DIR" 2>/dev/null | sed 's/^/      /' || true
    KEPT_ITEMS+=("$STATE_DIR 中的未分类内容")
  fi
}

remove_account_and_group() {
  local account="$1"
  if ! userdel "$account" >/dev/null 2>&1 || id -u "$account" >/dev/null 2>&1; then
    unfinished "$account 账号未删除，请检查仍在运行的进程或账号管理错误"
    return 0
  fi
  if ! groupdel "$account" >/dev/null 2>&1 && getent group "$account" >/dev/null 2>&1; then
    unfinished "$account 账号已删除，但同名组仍被使用或无法删除"
  fi
  DELETED_ITEMS+=("$account 账号")
}

remove_accounts() {
  local keep_panel=0 keep_sqlite=0 home key
  for key in data config logs state; do
    if data_category_exists "$key"; then keep_panel=1; fi
  done
  if [ "$keep_panel" = 0 ] && [ -d "$STATE_DIR" ] && [ -n "$(ls -A "$STATE_DIR" 2>/dev/null | sed -n '1p')" ]; then
    keep_panel=1
  fi
  if data_category_exists data; then keep_sqlite=1; fi

  if id -u elysian-build >/dev/null 2>&1; then
    EXPECT_DELETE_ELYSIAN_BUILD=1
    remove_account_and_group elysian-build
  fi

  if [ "$keep_panel" = 1 ]; then
    skip "保留 elysian 账号（面板数据仍存在，避免属主退化为数字 UID）"
    KEPT_ITEMS+=("elysian 账号")
  elif id -u elysian >/dev/null 2>&1; then
    home="$(getent passwd elysian 2>/dev/null | cut -d: -f6 || true)"
    if [ -n "$home" ] && [ "$home" != "$STATE_DIR" ]; then
      warn "elysian 账号主目录为 $home，疑似非本面板创建，保留"
      KEPT_ITEMS+=("elysian 账号（主目录不匹配）")
    else
      EXPECT_DELETE_ELYSIAN=1
      remove_account_and_group elysian
    fi
  fi

  if [ "$keep_sqlite" = 1 ]; then
    skip "保留 elysian-sqlite 账号（SQLite 数据仍存在）"
    KEPT_ITEMS+=("elysian-sqlite 账号")
  elif id -u elysian-sqlite >/dev/null 2>&1; then
    EXPECT_DELETE_SQLITE=1
    remove_account_and_group elysian-sqlite
  fi
  local account
  for account in elysian elysian-build elysian-sqlite; do
    if ! id -u "$account" >/dev/null 2>&1 && getent group "$account" >/dev/null 2>&1; then
      unfinished "$account 同名组仍存在，缺少可安全删除的账号归属或仍被其他账号使用"
    fi
  done
  info "账号处理已结束，实际结果见清单和残留检查"
}

check_absent() { # <路径> <说明>
  if [ -e "$1" ] || [ -L "$1" ]; then
    RESIDUE+=("$2：$1")
    FAILED=1
  fi
}

verify_clean() {
  RESIDUE=()
  check_absent "$UNIT_FILE" "systemd 单元"
  check_absent "$PANEL_BIN" "面板二进制"
  # 自家 ely 链接未删净才算残留；保留的外部同名文件是预期行为，不在此列。
  if { [ -e "$CLI_BIN" ] || [ -L "$CLI_BIN" ]; } && cli_link_owned; then
    RESIDUE+=("CLI 命令链接：$CLI_BIN")
    FAILED=1
  fi
  check_absent "$INSTALL_ROOT" "版本目录"
  if [ "$ENV_KEPT" = 0 ]; then check_absent "$ENV_FILE" "环境文件"; fi
  check_absent "$MIRROR_PROFILE" "镜像 profile"
  check_absent "$BUILD_HOME" "构建账号目录"
  if [ "$EXPECT_DELETE_GO" = 1 ]; then check_absent /usr/local/go "Go 工具链"; fi
  if [ "$EXPECT_DELETE_BUN" = 1 ]; then check_absent /usr/local/bin/bun "bun"; fi

  local key path
  for key in data config logs state; do
    [ "$(get_data_flag "$key")" = 1 ] || continue
    while IFS= read -r path; do
      check_absent "$path" "$(data_category_label "$key")"
    done <<EOF
$(data_category_paths "$key")
EOF
  done
  if [ "$PURGE_DATA" = 1 ]; then check_absent "$STATE_DIR" "面板数据目录"; fi

  if [ "$CADDY_REMOVE" = 1 ]; then
    if [ "$CADDY_RUNTIME_MATCH" = 1 ]; then check_absent "$CADDY_RUNTIME_DROPIN" "Caddy runtime drop-in"; fi
    if [ "$CADDY_TMPFILES_MATCH" = 1 ]; then check_absent "$CADDY_TMPFILES" "Caddy tmpfiles"; fi
    if [ "$CADDYFILE_ADMIN_FOUND" = 1 ] && [ -f "$CADDYFILE_PATH" ] && caddyfile_admin_scan "$CADDYFILE_PATH" 2>/dev/null; then
      RESIDUE+=("Caddyfile admin 指令：$CADDYFILE_PATH")
      FAILED=1
    fi
  fi

  if ufw_installed && [ -n "$(ufw_managed_rules)" ]; then
    RESIDUE+=("UFW 面板前端规则仍存在")
    FAILED=1
  fi
  if [ "$EXPECT_DELETE_ELYSIAN_BUILD" = 1 ] && id -u elysian-build >/dev/null 2>&1; then
    RESIDUE+=("elysian-build 账号仍存在")
    FAILED=1
  fi
  if [ "$EXPECT_DELETE_ELYSIAN" = 1 ] && id -u elysian >/dev/null 2>&1; then
    RESIDUE+=("elysian 账号仍存在")
    FAILED=1
  fi
  if [ "$EXPECT_DELETE_SQLITE" = 1 ] && id -u elysian-sqlite >/dev/null 2>&1; then
    RESIDUE+=("elysian-sqlite 账号仍存在")
    FAILED=1
  fi

  if [ "${#RESIDUE[@]}" -eq 0 ]; then
    ok "未发现预期删除项的残留"
  else
    warn "发现 ${#RESIDUE[@]} 项残留"
  fi
}

run_uninstall() {
  STAGE=0
  usection "停止并注销服务"
  if ! stop_service; then tui_finish_stage; return 0; fi
  usection "移除面板 UFW 规则"
  remove_ufw
  usection "清理未使用的安装依赖"
  remove_dependencies
  usection "处理 Caddy 接入"
  remove_caddy
  usection "删除安装产物"
  remove_artifacts
  usection "清理工具链"
  remove_tools
  usection "删除面板数据"
  remove_data
  usection "删除系统账号"
  remove_accounts
  usection "检查残留"
  verify_clean
  verify_retained_services
  tui_finish_stage
}

print_summary() {
  local elapsed=0 item
  [ -n "${UNINSTALL_STARTED_AT:-}" ] && elapsed=$((SECONDS - UNINSTALL_STARTED_AT))
  if [ "$FAILED" = 0 ]; then
    tui_banner "✓ Elysian 计划清理项已完成" "用时 $(tui_duration "$elapsed")"
  else
    tui_banner "! Elysian 卸载未全部完成" "用时 $(tui_duration "$elapsed")"
  fi

  tui_section "已删除"
  if [ "${#DELETED_ITEMS[@]}" -eq 0 ]; then
    printf '  无\n'
  else
    for item in "${DELETED_ITEMS[@]}"; do printf '  · %s\n' "$item"; done
  fi

  tui_section "已保留"
  if [ "${#KEPT_ITEMS[@]}" -eq 0 ]; then
    printf '  无\n'
  else
    for item in "${KEPT_ITEMS[@]}"; do printf '  · %s\n' "$item"; done
  fi

  tui_section "未改动"
  printf '  · 源码仓库\n'
  printf '  · 系统 SSH 与面板自管 sshd\n'
  printf '  · UFW 服务状态与用户自加规则\n'
  printf '  · 已有容器、镜像、数据库卷及 /var/lib/docker、/var/lib/containerd、/var/lib/caddy 业务数据（不盲删）\n'
  printf '  · 其他用户主目录下的 ~/.elysian/cli（ely 本地数据，由各用户自行删除）\n'
  if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
    tui_kv "备份" "$BACKUP_DIR（0700）"
  fi
  if [ "${#UNFINISHED_ITEMS[@]}" -gt 0 ]; then
    tui_section "未清理或保留服务异常"
    for item in "${UNFINISHED_ITEMS[@]}"; do printf '  · %s\n' "$item"; done
    printf '  如需主动保留组件，请使用对应 --keep-* 选项；业务资源须先明确处置。\n'
  fi

  tui_section "残留检查"
  if [ "${#RESIDUE[@]}" -eq 0 ]; then
    ok "未发现预期删除项的残留"
  else
    warn "发现 ${#RESIDUE[@]} 项残留："
    for item in "${RESIDUE[@]}"; do printf '      %s\n' "$item"; done
  fi
  if [ "$FAILED" = 0 ]; then
    ok "卸载完成"
  else
    warn "卸载未完成，请按上方未清理项及残留原因处理"
  fi
}

main() {
  parse_args "$@"
  require_root
  local out_tty=0 err_tty=0
  if [ -t 1 ]; then out_tty=1; fi
  if [ -t 2 ]; then err_tty=1; fi
  init_output "$out_tty" "$err_tty"
  load_state
  check_maintenance
  detect_caddy
  select_data_categories
  select_caddy
  print_plan
  print_final_plan

  if [ "$DRY_RUN" = 1 ]; then
    tui_section "预览结束"
    printf '  未做任何修改。去掉 --dry-run 后执行真实卸载。\n'
    return 0
  fi

  require_interactive
  if ! confirm_plan; then
    info "已取消，未做任何变更"
    return 0
  fi

  platform_lifecycle_lock || die "另一项安装或卸载正在执行，或安装互斥文件异常。"
  platform_no_links "$STATE_DIR" || die "面板数据路径经过符号链接，拒绝清理。"
  local locks="$STATE_DIR/.Elysian/state/panel-maintenance"
  platform_no_links "$locks" || die "维护锁路径经过符号链接，拒绝清理。"
  mkdir -p "$locks"
  platform_no_links "$locks/worker.lock" && platform_no_links "$locks/operations.lock" || die "维护锁文件经过符号链接，拒绝卸载。"
  exec 9>>"$locks/worker.lock"
  flock -w 25 -x 9 || die "维护任务仍在执行，未进行卸载。"
  exec 8>>"$locks/operations.lock"
  flock -w 90 -x 8 || die "业务操作仍在执行，未进行卸载。"
  check_maintenance
  UNINSTALL_STARTED_AT=$SECONDS
  run_uninstall
  print_summary
  [ "$FAILED" = 0 ]
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  main "$@"
fi
