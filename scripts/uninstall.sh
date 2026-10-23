#!/usr/bin/env bash
# scripts/uninstall.sh —— Elysian 卸载（install.sh 的完整逆操作；root 执行）。
#
# 用法：
#   sudo bash scripts/uninstall.sh                交互式卸载：先展示计划，再逐项询问四类数据
#   sudo bash scripts/uninstall.sh --purge-data   删除全部面板数据（含未分类文件）
#   sudo bash scripts/uninstall.sh --keep-tools   保留 Go 与 bun 工具链
#   sudo bash scripts/uninstall.sh --yes          免交互（默认保留数据与 Caddy 配置）
#   sudo bash scripts/uninstall.sh --dry-run      只展示计划与大小，不做任何修改
#
# 默认删除：systemd 服务与自启、/usr/local/bin/elysian、/opt/elysian、/etc/default/elysian、
# /etc/profile.d/elysian-mirrors.sh、构建残留、面板自己加的 UFW 前端端口规则，以及本脚本安装
# 路径上的 Go(/usr/local/go) 与 bun(/usr/local/bin/bun)。/etc/default/elysian 删除前会备份到
# /var/backups/elysian-uninstall-<时间戳>。
#
# 面板数据 /var/lib/elysian/.Elysian 分四类逐项询问，默认全部保留：
#   数据（SQLite 与 Agent 记录）、配置与凭据、日志、备份/状态/临时。
# 只要保留任一数据类别，就保留 elysian 账号；保留「数据」时同时保留 elysian-sqlite 账号，
# 避免文件属主退化为数字 UID、重装无法直接复用。
#
# Caddy 接入默认保留；交互确认后才精确移除：内容与 Elysian 写入完全一致的 drop-in/tmpfiles，
# 以及 Caddyfile 全局段中精确的 admin unix/<socket> 行。Caddyfile 先备份、caddy validate 通过
# 才原子替换，reload 失败会恢复原文件。
#
# 明确不动：源码仓库、系统 SSH 与面板自管 sshd、Docker/Caddy 系统包与已有容器、UFW 服务
# 状态、用户自加的 UFW 规则、其它位置的 Go/bun。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SERVICE_NAME="elysian"
PANEL_BIN="/usr/local/bin/elysian"
UNIT_FILE="/etc/systemd/system/elysian.service"
STATE_DIR="/var/lib/elysian"
PURGE_GUARD="/var/lib/elysian"
INSTALL_ROOT="/opt/elysian"
ENV_FILE="/etc/default/elysian"
MIRROR_PROFILE="/etc/profile.d/elysian-mirrors.sh"
BUILD_HOME="/var/lib/elysian-build"
DEFAULT_FRONTEND_PORT="48100"
CADDYFILE_PATH="/etc/caddy/Caddyfile"
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
)

PURGE_DATA=0
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
CADDY_REMOVE=0
ENV_KEPT=0

EXPECT_DELETE_ELYSIAN_BUILD=0
EXPECT_DELETE_ELYSIAN=0
EXPECT_DELETE_SQLITE=0

STAGE=0
TOTAL_STAGES=8
FAILED=0
BACKUP_DIR=""
DATA_ROOT=""
FRONTEND_PORT="$DEFAULT_FRONTEND_PORT"
CADDY_SOCKET=""

DELETED_ITEMS=()
KEPT_ITEMS=()
RESIDUE=()

if [ ! -r "$SCRIPT_DIR/tui.sh" ]; then
  printf '缺少 scripts/tui.sh，无法渲染卸载界面。\n' >&2
  exit 1
fi
# shellcheck source=tui.sh
. "$SCRIPT_DIR/tui.sh"
TUI_FAIL_LABEL="卸载失败"

usage() {
  cat <<'EOF'
用法：sudo bash scripts/uninstall.sh [选项]
  --purge-data   删除全部面板数据（含未分类文件）
  --keep-tools   保留 Go 与 bun 工具链
  --yes, -y      免交互（默认保留数据与 Caddy 配置）
  --dry-run      只展示计划与大小，不做任何修改
  --help         显示本帮助
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --purge-data) PURGE_DATA=1 ;;
      --keep-tools) KEEP_TOOLS=1 ;;
      --yes|-y) ASSUME_YES=1 ;;
      --dry-run) DRY_RUN=1 ;;
      -h|--help) usage; exit 0 ;;
      *) printf '未知参数：%s\n' "$1" >&2; usage >&2; exit 1 ;;
    esac
    shift
  done
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "请以 root 执行（sudo bash scripts/uninstall.sh）。"
}

require_interactive() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] && return 0
  die "当前不是交互终端；请加 --yes（默认保留数据）或 --yes --purge-data（彻底删除数据）。"
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

data_category_paths() {
  case "$1" in
    data) printf '%s\n' "$DATA_ROOT/data" ;;
    config) printf '%s\n' "$DATA_ROOT/config" ;;
    logs) printf '%s\n' "$DATA_ROOT/logs" ;;
    state) printf '%s\n' "$DATA_ROOT/backups" "$DATA_ROOT/state" "$DATA_ROOT/tmp" ;;
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
    state) printf 'backups、state、tmp' ;;
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
  tui_section "将删除"
  tui_kv "服务" "systemd 单元与自启（$SERVICE_NAME）"
  tui_kv "程序" "$PANEL_BIN、$INSTALL_ROOT"
  tui_kv "安装配置" "$ENV_FILE、$MIRROR_PROFILE"
  tui_kv "构建残留" "$BUILD_HOME、/var/tmp/elysian-install-source.*、/tmp/elysian-build.*"
  if [ -n "$(ufw_managed_rules)" ]; then
    tui_kv "防火墙" "面板前端端口 ${FRONTEND_PORT}/tcp 的 Elysian 规则"
  else
    tui_kv "防火墙" "未发现面板前端规则"
  fi
  tui_kv "系统账号" "elysian-build 总是删除；elysian/elysian-sqlite 视数据保留情况"
  if [ "$KEEP_TOOLS" = 0 ]; then
    tui_kv "工具链" "/usr/local/go、/usr/local/bin/bun、go env GOPROXY"
  else
    tui_kv "工具链" "按 --keep-tools 保留"
  fi

  tui_section "面板数据（默认保留，逐项询问）"
  local key
  for key in data config logs state; do
    if data_category_exists "$key"; then
      tui_kv "$(data_category_label "$key")" "$(data_category_size "$key")；$(data_category_note "$key")"
    else
      tui_kv "$(data_category_label "$key")" "不存在"
    fi
  done

  tui_section "Caddy 接入（可选）"
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
  if [ "$ASSUME_YES" = 1 ]; then
    return 0
  fi
  if [ "$CADDY_RUNTIME_MATCH$CADDY_TMPFILES_MATCH$CADDYFILE_ADMIN_FOUND" = "000" ]; then
    skip "未发现 Elysian 写入的 Caddy 管理通道配置"
    return 0
  fi
  local answer
  printf '  移除 Elysian 写入的 Caddy 管理通道配置（admin 指令/drop-in/tmpfiles）？[y/N] '
  if ! read -r answer; then die "输入结束，未做任何变更。"; fi
  case "$answer" in
    y|Y|yes|YES) CADDY_REMOVE=1 ;;
    *) CADDY_REMOVE=0 ;;
  esac
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
  if systemctl list-unit-files "$SERVICE_NAME.service" >/dev/null 2>&1 && [ -e "$UNIT_FILE" ]; then
    info "停止并注销服务 $SERVICE_NAME"
    systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
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
  if [ "$CADDY_REMOVE" != 1 ]; then
    skip "保留 Caddy 管理通道配置"
    KEPT_ITEMS+=("Caddy 管理通道配置")
    return 0
  fi
  if [ -z "$CADDY_SOCKET" ]; then
    skip "Caddy socket 路径无法解析，跳过"
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
    if ! mv -f "$candidate" "$CADDYFILE_PATH"; then
      rm -f "$candidate"
      warn "Caddyfile 替换失败，原文件保留"
      FAILED=1
      return 0
    fi
    caddyfile_removed=1
    ok "已移除 Caddyfile 中的 Elysian admin 指令"
    DELETED_ITEMS+=("Caddyfile admin 指令")
  fi

  if [ "$CADDY_RUNTIME_MATCH" = 1 ]; then
    backup_file "$CADDY_RUNTIME_DROPIN" "elysian-runtime.conf" || true
    if rm -f "$CADDY_RUNTIME_DROPIN"; then
      DELETED_ITEMS+=("Caddy runtime drop-in")
    else
      warn "删除 Caddy runtime drop-in 失败"
      FAILED=1
    fi
  elif [ -f "$CADDY_RUNTIME_DROPIN" ]; then
    KEPT_ITEMS+=("Caddy runtime drop-in（内容不匹配）")
  fi

  if [ "$CADDY_TMPFILES_MATCH" = 1 ]; then
    backup_file "$CADDY_TMPFILES" "elysian-caddy.conf" || true
    if rm -f "$CADDY_TMPFILES"; then
      DELETED_ITEMS+=("Caddy tmpfiles")
    else
      warn "删除 Caddy tmpfiles 失败"
      FAILED=1
    fi
  elif [ -f "$CADDY_TMPFILES" ]; then
    KEPT_ITEMS+=("Caddy tmpfiles（内容不匹配）")
  fi
  systemctl daemon-reload >/dev/null 2>&1 || true
  rmdir "$(dirname "$CADDY_RUNTIME_DROPIN")" 2>/dev/null || true

  if [ "$caddyfile_removed" = 1 ] && systemctl is-active --quiet caddy 2>/dev/null; then
    if systemctl reload caddy >/dev/null 2>&1; then
      ok "Caddy 已 reload，原路由保持运行"
    else
      warn "Caddy reload 失败，正在恢复原 Caddyfile"
      if [ -n "$BACKUP_DIR" ] && [ -f "$BACKUP_DIR/Caddyfile" ]; then
        cp -p "$BACKUP_DIR/Caddyfile" "$CADDYFILE_PATH" 2>/dev/null || true
      fi
      systemctl reload caddy >/dev/null 2>&1 || warn "恢复后仍未能 reload Caddy，请手工检查"
      FAILED=1
    fi
  fi
}

remove_artifacts() {
  local item
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
      warn "备份 $ENV_FILE 失败，保留原文件"
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
  ok "安装产物已清理"
  DELETED_ITEMS+=("程序、安装配置与构建残留")
}

remove_tools() {
  if [ "$KEEP_TOOLS" = 1 ]; then
    skip "按 --keep-tools 保留 Go 与 bun"
    KEPT_ITEMS+=("Go/bun 工具链")
    return 0
  fi
  if [ -x /usr/local/go/bin/go ]; then
    /usr/local/go/bin/go env -u GOPROXY >/dev/null 2>&1 || true
    ok "已复位 go env GOPROXY"
  fi
  if [ -d /usr/local/go ]; then
    if rm -rf -- /usr/local/go; then ok "已删除 /usr/local/go"; else warn "删除 /usr/local/go 失败"; FAILED=1; fi
  fi
  if [ -e /usr/local/bin/bun ]; then
    if rm -f -- /usr/local/bin/bun; then ok "已删除 /usr/local/bin/bun"; else warn "删除 /usr/local/bin/bun 失败"; FAILED=1; fi
  fi
  command -v go >/dev/null 2>&1 && warn "检测到其它位置的 Go（$(command -v go)），非本面板安装路径，已保留"
  command -v bun >/dev/null 2>&1 && warn "检测到其它位置的 bun（$(command -v bun)），非本面板安装路径，已保留"
  DELETED_ITEMS+=("Go/bun 工具链（本面板安装路径）")
}

safe_rm() {
  local path="$1"
  case "$path" in
    ''|'/'|'.'|'..'|*'/../'*|*/..) die "拒绝删除危险路径：$path" ;;
  esac
  case "$path" in
    "$STATE_DIR"/*) : ;;
    *) die "拒绝删除 $STATE_DIR 之外的路径：$path" ;;
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
    DELETED_ITEMS+=("全部面板数据")
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
  for dir in "$DATA_ROOT/data" "$DATA_ROOT/config" "$DATA_ROOT/logs" "$DATA_ROOT/backups" "$DATA_ROOT/state" "$DATA_ROOT/tmp" "$DATA_ROOT" "$STATE_DIR"; do
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
    userdel elysian-build >/dev/null 2>&1 || true
    groupdel elysian-build >/dev/null 2>&1 || true
    DELETED_ITEMS+=("elysian-build 账号")
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
      userdel elysian >/dev/null 2>&1 || true
      groupdel elysian >/dev/null 2>&1 || true
      DELETED_ITEMS+=("elysian 账号")
    fi
  fi

  if [ "$keep_sqlite" = 1 ]; then
    skip "保留 elysian-sqlite 账号（SQLite 数据仍存在）"
    KEPT_ITEMS+=("elysian-sqlite 账号")
  elif id -u elysian-sqlite >/dev/null 2>&1; then
    EXPECT_DELETE_SQLITE=1
    userdel elysian-sqlite >/dev/null 2>&1 || true
    groupdel elysian-sqlite >/dev/null 2>&1 || true
    DELETED_ITEMS+=("elysian-sqlite 账号")
  fi
  ok "账号处理完成"
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
  check_absent "$INSTALL_ROOT" "版本目录"
  if [ "$ENV_KEPT" = 0 ]; then check_absent "$ENV_FILE" "环境文件"; fi
  check_absent "$MIRROR_PROFILE" "镜像 profile"
  check_absent "$BUILD_HOME" "构建账号目录"
  if [ "$KEEP_TOOLS" = 0 ]; then
    check_absent /usr/local/go "Go 工具链"
    check_absent /usr/local/bin/bun "bun"
  fi

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
  stop_service
  usection "移除面板 UFW 规则"
  remove_ufw
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
  tui_finish_stage
}

print_summary() {
  local elapsed=0 item
  [ -n "${UNINSTALL_STARTED_AT:-}" ] && elapsed=$((SECONDS - UNINSTALL_STARTED_AT))
  tui_banner "✓ Elysian 已卸载" "用时 $(tui_duration "$elapsed")"

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
  printf '  · Docker、Caddy 系统包、apt 源与已有容器（如需卸载请按安装方式自行处理）\n'
  if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
    tui_kv "备份" "$BACKUP_DIR（0700）"
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
    warn "卸载完成，但有项目未清理干净，请按上方残留处理"
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
  print_plan

  if [ "$DRY_RUN" = 1 ]; then
    tui_section "预览结束"
    printf '  未做任何修改。去掉 --dry-run 后执行真实卸载。\n'
    return 0
  fi

  require_interactive
  select_data_categories
  select_caddy
  print_final_plan
  if ! confirm_plan; then
    info "已取消，未做任何变更"
    return 0
  fi

  UNINSTALL_STARTED_AT=$SECONDS
  run_uninstall
  print_summary
  [ "$FAILED" = 0 ]
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  main "$@"
fi
