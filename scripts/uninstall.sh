#!/usr/bin/env bash
# scripts/uninstall.sh —— Elysian 整机卸载（install.sh 的完整逆操作；root 执行）。
#
# 用法：
#   sudo bash scripts/uninstall.sh                交互确认后卸载（保留面板数据与源码）
#   sudo bash scripts/uninstall.sh --purge-data   连面板数据目录 /var/lib/elysian 一并删除
#   sudo bash scripts/uninstall.sh --keep-tools   保留 Go 与 bun 工具链
#   sudo bash scripts/uninstall.sh --yes          免交互（配合 CI / 云初始化脚本）
#
# 卸载范围（与 scripts/install.sh 的全部落点一一对应）：
#   systemd 服务与自启、/usr/local/bin/elysian、/opt/elysian 构建产物、系统账号
#   elysian / elysian-build / elysian-sqlite(2001)、构建残留 /var/tmp/elysian-install-source.*、
#   /var/lib/elysian-build、/etc/profile.d/elysian-mirrors.sh、/etc/default/elysian、
#   面板自己加的 UFW 前端端口规则、Go 工具链(/usr/local/go)与 bun(/usr/local/bin/bun)、
#   root 的 go env GOPROXY 镜像写入。
#
# 明确不动的东西：
#   - 源码仓库（本脚本不感知克隆位置，绝不删除）
#   - 面板数据 /var/lib/elysian（默认保留；--purge-data 才删）
#   - install.sh 顺带安装的系统包（curl/ufw/iproute2 等，属系统基件）
#   - 面板自管的 sshd 进程与系统 SSH 配置（卸载不该断运维的登录通道）
#   - 用户经面板为业务端口自加的 UFW 规则
set -euo pipefail

SERVICE_NAME="elysian"
PANEL_BIN="/usr/local/bin/elysian"
UNIT_FILE="/etc/systemd/system/elysian.service"
STATE_DIR="/var/lib/elysian"
INSTALL_ROOT="/opt/elysian"
ENV_FILE="/etc/default/elysian"
MIRROR_PROFILE="/etc/profile.d/elysian-mirrors.sh"
DEFAULT_FRONTEND_PORT="48100"

PURGE_DATA=0
KEEP_TOOLS=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --purge-data) PURGE_DATA=1 ;;
    --keep-tools) KEEP_TOOLS=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（支持 --purge-data / --keep-tools / --yes）" >&2; exit 1 ;;
  esac
done

if [ -t 1 ] && [ -t 2 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
else
  C_RESET=''; C_BOLD=''; C_GREEN=''; C_YELLOW=''; C_RED=''
fi
info() { printf '%s==>%s %s\n' "$C_BOLD" "$C_RESET" "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s注意：%s%s\n' "$C_YELLOW" "$C_RESET" "$*"; }
die()  { printf '%s卸载失败：%s%s\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请以 root 执行（sudo bash scripts/uninstall.sh）。"

# ---------- 读取面板配置的前端端口（删 UFW 规则用；数据目录将保留时文件仍在） ----------
panel_frontend_port() {
  local cfg="$STATE_DIR/.Elysian/config/panel-network.json"
  if [ -r "$cfg" ]; then
    local port
    port="$(grep -o '"frontendPort"[[:space:]]*:[[:space:]]*[0-9]*' "$cfg" | grep -o '[0-9]*$' || true)"
    if [ -n "$port" ]; then
      echo "$port"
      return 0
    fi
  fi
  echo "$DEFAULT_FRONTEND_PORT"
}

FRONTEND_PORT="$(panel_frontend_port)"

# ---------- 卸载计划确认 ----------
printf '%sElysian 卸载计划%s\n' "$C_BOLD" "$C_RESET"
echo "  将删除：systemd 服务（$SERVICE_NAME）与自启、$PANEL_BIN、$INSTALL_ROOT（构建产物，非源码）、"
echo "          系统账号 elysian / elysian-build / elysian-sqlite、/etc/profile.d/elysian-mirrors.sh、"
if [ "$KEEP_TOOLS" = 0 ]; then
  echo "          工具链 /usr/local/go 与 /usr/local/bin/bun、root 的 go env GOPROXY、"
else
  echo "          （工具链 Go/bun 按参数保留）、"
fi
echo "          UFW 面板前端端口规则（${FRONTEND_PORT}/tcp）"
if [ "$PURGE_DATA" = 1 ]; then
  echo "  将删除：面板数据目录 $STATE_DIR（含凭据、SQLite、日志与备份）"
else
  echo "  将保留：面板数据目录 $STATE_DIR（--purge-data 可一并删除）"
fi
echo "  绝不动：源码仓库、系统包（curl/ufw 等）、系统 SSH 与面板自管 sshd、用户自加的 UFW 规则"
echo

if [ "$ASSUME_YES" != 1 ]; then
  read -r -p "确认执行以上卸载？[y/N] " answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) info "已取消，未做任何变更"; exit 0 ;;
  esac
fi

# ---------- 1. 停止并注销服务 ----------
if systemctl list-unit-files "$SERVICE_NAME.service" >/dev/null 2>&1 && [ -e "$UNIT_FILE" ]; then
  info "停止并注销服务 $SERVICE_NAME"
  systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  rm -f "$UNIT_FILE"
  systemctl daemon-reload || true
  systemctl reset-failed "$SERVICE_NAME" >/dev/null 2>&1 || true
  ok "服务已停止、禁用并移除"
else
  ok "未发现 systemd 单元，跳过"
fi

# ---------- 2. 删除 UFW 面板前端规则（精确端口，不动其他规则） ----------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qE "^Status: active"; then
  info "移除 UFW 面板前端端口规则（${FRONTEND_PORT}/tcp）"
  if ufw status | grep -qE "[[:space:]]${FRONTEND_PORT}/tcp[[:space:]]+ALLOW"; then
    ufw delete allow "${FRONTEND_PORT}/tcp" >/dev/null 2>&1 \
      || warn "UFW 规则删除失败，请手动检查：ufw status | grep ${FRONTEND_PORT}"
    ok "规则已移除（或本就不存在）"
  else
    ok "UFW 中无面板规则，跳过"
  fi
else
  ok "UFW 未安装或未启用，跳过"
fi

# ---------- 3. 删除安装产物 ----------
info "删除安装产物"
rm -f "$PANEL_BIN"
rm -rf "$INSTALL_ROOT"
rm -f "$ENV_FILE"
rm -f "$MIRROR_PROFILE"
rm -rf /var/lib/elysian-build
rm -rf /var/tmp/elysian-install-source.* 2>/dev/null || true
ok "已删除：$PANEL_BIN、$INSTALL_ROOT、$ENV_FILE、$MIRROR_PROFILE、构建残留"

# ---------- 4. 工具链与 go env ----------
if [ "$KEEP_TOOLS" = 0 ]; then
  info "清理工具链"
  # configure_mirrors 写入过 root 的 go env GOPROXY：先复位再删工具链。
  if [ -x /usr/local/go/bin/go ]; then
    /usr/local/go/bin/go env -u GOPROXY >/dev/null 2>&1 || true
    ok "已复位 go env GOPROXY"
  fi
  if [ -d /usr/local/go ]; then
    rm -rf /usr/local/go
    ok "已删除 /usr/local/go"
  fi
  if [ -e /usr/local/bin/bun ]; then
    rm -f /usr/local/bin/bun
    ok "已删除 /usr/local/bin/bun"
  fi
  # 工具链若在别处（apt/snap/自装），不在本脚本安装路径上，保持不动。
  command -v go >/dev/null 2>&1 && warn "检测到其它位置的 Go（$(command -v go)），非本面板安装路径，已保留"
  command -v bun >/dev/null 2>&1 && warn "检测到其它位置的 bun（$(command -v bun)），非本面板安装路径，已保留"
else
  ok "按参数保留 Go 与 bun 工具链（go env GOPROXY 亦未复位）"
fi

# ---------- 5. 系统账号 ----------
info "删除系统账号 elysian / elysian-build / elysian-sqlite"
userdel elysian-build  >/dev/null 2>&1 || true
groupdel elysian-build >/dev/null 2>&1 || true
userdel elysian        >/dev/null 2>&1 || true
userdel elysian-sqlite >/dev/null 2>&1 || true
groupdel elysian-sqlite >/dev/null 2>&1 || true
ok "账号已删除（数据文件属主退化为纯数字 UID 属正常现象）"

# ---------- 6. 面板数据 ----------
if [ "$PURGE_DATA" = 1 ]; then
  info "删除面板数据目录 $STATE_DIR"
  rm -rf "$STATE_DIR"
  ok "数据目录已删除"
else
  warn "面板数据目录已保留：$STATE_DIR（凭据、SQLite、日志与备份；彻底清除可重跑 --purge-data 或手动 rm -rf）"
fi

printf '\n%sElysian 已卸载%s\n' "$C_BOLD$C_GREEN" "$C_RESET"
echo "  源码仓库未做任何改动；install.sh 顺带安装的系统包（curl/ufw/iproute2 等）按惯例保留。"
echo "  面板自管的 sshd 与系统 SSH 配置未触碰；如需停用请自行处理。"
