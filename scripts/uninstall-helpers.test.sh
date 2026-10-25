#!/usr/bin/env bash
# scripts/uninstall-helpers.test.sh —— uninstall.sh 纯逻辑与文件操作自测。
# 所有路径指向临时目录，systemctl/ufw/userdel/caddy 等命令全部用函数桩，不触碰宿主系统。
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1090
source "${SCRIPT_DIR}/uninstall.sh"
set +u

PASS=0
FAIL=0
FIXTURES=""

pass() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$1" >&2; }
assert_eq() {
  if [ "$1" = "$2" ]; then pass "$3"; else fail "$3：期望 [$1]，实际 [$2]"; fi
}
assert_rc() {
  if [ "$2" = "$1" ]; then pass "$3"; else fail "$3：期望 rc=$1，实际 rc=$2"; fi
}

cleanup() {
  local dir
  for dir in $FIXTURES; do rm -rf "$dir"; done
}
trap cleanup EXIT

reset_flags() {
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
  FAILED=0
  BACKUP_DIR=""
  BACKUP_ROOT="$FIXTURE/backups"
  DELETED_ITEMS=()
  KEPT_ITEMS=()
  RESIDUE=()
}

new_fixture() {
  FIXTURE="$(mktemp -d)"
  FIXTURES="$FIXTURES $FIXTURE"
  STATE_DIR="$FIXTURE/state"
  PURGE_GUARD="$STATE_DIR"
  DATA_ROOT="$STATE_DIR/.Elysian"
  ENV_FILE="$FIXTURE/default-elysian"
  UNIT_FILE="$FIXTURE/elysian.service"
  PANEL_BIN="$FIXTURE/bin/elysian"
  CLI_BIN="$FIXTURE/bin/ely"
  INSTALL_ROOT="$FIXTURE/opt/elysian"
  MIRROR_PROFILE="$FIXTURE/profile.sh"
  BUILD_HOME="$FIXTURE/elysian-build"
  CLI_DATA_DIR="$FIXTURE/root-home/.elysian/cli"
  CADDYFILE_PATH="$FIXTURE/Caddyfile"
  CADDY_RUNTIME_DROPIN="$FIXTURE/dropin/elysian-runtime.conf"
  CADDY_TMPFILES="$FIXTURE/tmpfiles/elysian-caddy.conf"
  FRONTEND_PORT=48100
  CADDY_SOCKET=/run/caddy/admin.sock
  ARTIFACT_GLOBS=("$FIXTURE/artifacts/elysian-build.*")
  mkdir -p "$DATA_ROOT/data" "$DATA_ROOT/config" "$DATA_ROOT/logs" "$DATA_ROOT/backups" "$DATA_ROOT/state" "$DATA_ROOT/tmp"
  mkdir -p "$FIXTURE/bin" "$FIXTURE/dropin" "$FIXTURE/tmpfiles" "$FIXTURE/artifacts" "$CLI_DATA_DIR"
  printf 'metrics' >"$DATA_ROOT/data/metrics.sqlite"
  printf 'creds' >"$DATA_ROOT/config/panel-credentials.json"
  printf 'log' >"$DATA_ROOT/logs/panel.log"
  printf 'backup' >"$DATA_ROOT/backups/install-1"
  printf 'state' >"$DATA_ROOT/state/last"
  printf 'tmp' >"$DATA_ROOT/tmp/work"
  printf 'cli-state' >"$CLI_DATA_DIR/state.json"
  reset_flags
}

echo "== source guard 与参数 =="
if ( source "$SCRIPT_DIR/uninstall.sh"; type main >/dev/null 2>&1 && type parse_args >/dev/null 2>&1 ); then
  pass "source 后暴露 main 与 parse_args，不执行卸载"
else
  fail "source guard 异常"
fi
new_fixture
parse_args --purge-data --keep-tools --yes --dry-run
assert_eq 1 "$PURGE_DATA" "--purge-data 解析"
assert_eq 1 "$KEEP_TOOLS" "--keep-tools 解析"
assert_eq 1 "$ASSUME_YES" "--yes 解析"
assert_eq 1 "$DRY_RUN" "--dry-run 解析"
reset_flags
if ( parse_args --bogus ) >/dev/null 2>&1; then fail "未知参数应拒绝"; else pass "未知参数拒绝"; fi
if OUT="$( (parse_args --help) 2>&1 )"; then
  case "$OUT" in *用法*) pass "--help 输出用法" ;; *) fail "--help 输出异常" ;; esac
else
  fail "--help 应成功"
fi

echo "== 前端端口与 Caddy socket 解析 =="
new_fixture
mkdir -p "$DATA_ROOT/config"
printf '{"frontendPort": 49000}\n' >"$DATA_ROOT/config/panel-network.json"
assert_eq 49000 "$(panel_frontend_port)" "读取 panel-network.json"
printf '{"frontendPort": 70000}\n' >"$DATA_ROOT/config/panel-network.json"
assert_eq 48100 "$(panel_frontend_port)" "非法端口回落默认值"
assert_eq "/tmp/custom.sock" "$(ELYSIAN_CADDY_SOCKET=/tmp/custom.sock resolve_caddy_socket)" "环境变量覆盖"
printf 'ELYSIAN_CADDY_SOCKET="/custom/sock"\n' >"$ENV_FILE"
assert_eq "/custom/sock" "$(ELYSIAN_CADDY_SOCKET= resolve_caddy_socket)" "EnvironmentFile 覆盖并剥离引号"
if ELYSIAN_CADDY_SOCKET=relative.sock resolve_caddy_socket >/dev/null 2>&1; then fail "相对路径应拒绝"; else pass "相对路径拒绝"; fi

echo "== 四类数据路径与选择 =="
new_fixture
assert_eq "$DATA_ROOT/data" "$(data_category_paths data)" "data 路径"
assert_eq "$(printf '%s\n' "$DATA_ROOT/backups" "$DATA_ROOT/state" "$DATA_ROOT/tmp" "$CLI_DATA_DIR")" "$(data_category_paths state)" "状态类多路径（含 ely CLI 本地数据）"
if data_category_exists data; then pass "data 类别存在"; else fail "data 类别应存在"; fi
case "$(data_category_size data)" in *KiB|*MiB|*GiB) pass "data 大小可读" ;; *) fail "data 大小异常" ;; esac
rm -rf "$DATA_ROOT/logs"
if data_category_exists logs; then fail "logs 删除后不应存在"; else pass "logs 删除后不存在"; fi

new_fixture
printf 'y\nn\ny\nn\n' >"$FIXTURE/answers"
select_data_categories <"$FIXTURE/answers" >/dev/null 2>&1
assert_eq 1 "$DELETE_DATA" "选择删除 data"
assert_eq 0 "$DELETE_CONFIG" "选择保留 config"
assert_eq 1 "$DELETE_LOGS" "选择删除 logs"
assert_eq 0 "$DELETE_STATE" "选择保留 state"
reset_flags
ASSUME_YES=1
select_data_categories >/dev/null 2>&1
assert_eq 0 "$DELETE_DATA" "--yes 默认保留 data"
reset_flags
PURGE_DATA=1
select_data_categories >/dev/null 2>&1
assert_eq 1 "$DELETE_DATA" "--purge-data 全选 data"
assert_eq 1 "$DELETE_CONFIG" "--purge-data 全选 config"
assert_eq 1 "$DELETE_LOGS" "--purge-data 全选 logs"
assert_eq 1 "$DELETE_STATE" "--purge-data 全选 state"

echo "== safe_rm =="
new_fixture
printf 'x' >"$DATA_ROOT/tmp/remove-me"
safe_rm "$DATA_ROOT/tmp/remove-me"
if [ ! -e "$DATA_ROOT/tmp/remove-me" ]; then pass "删除 state 内路径"; else fail "safe_rm 未删除"; fi
if ( safe_rm "/" ) >/dev/null 2>&1; then fail "拒绝根路径"; else pass "拒绝根路径"; fi
if ( safe_rm "" ) >/dev/null 2>&1; then fail "拒绝空路径"; else pass "拒绝空路径"; fi
if ( safe_rm "$FIXTURE/outside" ) >/dev/null 2>&1; then fail "拒绝 state 外路径"; else pass "拒绝 state 外路径"; fi

echo "== 删除选定数据与彻底删除 =="
new_fixture
DELETE_DATA=1
DELETE_LOGS=1
remove_data >/dev/null 2>&1
if [ ! -e "$DATA_ROOT/data" ] && [ ! -e "$DATA_ROOT/logs" ]; then pass "选定类别已删除"; else fail "选定类别未删除"; fi
if [ -e "$DATA_ROOT/config" ] && [ -e "$DATA_ROOT/backups" ]; then pass "未选类别保留"; else fail "未选类别被误删"; fi
case "${DELETED_ITEMS[*]}" in *数据*日志*) pass "记录删除项" ;; *) fail "删除项记录缺失：${DELETED_ITEMS[*]}" ;; esac
case "${KEPT_ITEMS[*]}" in *配置*备份*) pass "记录保留项" ;; *) fail "保留项记录缺失：${KEPT_ITEMS[*]}" ;; esac

new_fixture
printf 'unknown' >"$STATE_DIR/unknown.txt"
PURGE_DATA=1
remove_data >/dev/null 2>&1
if [ ! -e "$STATE_DIR" ]; then pass "--purge-data 删除整个 state 目录"; else fail "--purge-data 未删净"; fi

echo "== Caddy 期望文件与 Caddyfile 精确移除 =="
new_fixture
printf '[Service]\nRuntimeDirectory=caddy\nRuntimeDirectoryMode=0755\n' >"$CADDY_RUNTIME_DROPIN"
printf 'd /run/caddy 0755 caddy caddy -\n' >"$CADDY_TMPFILES"
cat >"$CADDYFILE_PATH" <<'EOF'
{
	admin unix//run/caddy/admin.sock
	http_port 80
}

example.com {
	admin unix//run/caddy/admin.sock
	root * /srv
}
EOF
detect_caddy
assert_eq 1 "$CADDY_RUNTIME_MATCH" "drop-in 精确匹配"
assert_eq 1 "$CADDY_TMPFILES_MATCH" "tmpfiles 精确匹配"
assert_eq 1 "$CADDYFILE_ADMIN_FOUND" "找到全局 admin 指令"

printf '[Service]\nRuntimeDirectory=caddy\nRuntimeDirectoryMode=0755\nextra\n' >"$CADDY_RUNTIME_DROPIN"
detect_caddy
assert_eq 0 "$CADDY_RUNTIME_MATCH" "多一行不匹配"

candidate="$FIXTURE/candidate"
caddyfile_admin_scan "$CADDYFILE_PATH" "$candidate"; rc=$?
assert_rc 0 "$rc" "候选生成成功"
assert_eq 1 "$(grep -c 'admin unix' "$candidate")" "只删全局 admin，站点块保留"
grep -q 'example.com' "$candidate" || fail "站点块丢失"

printf 'example.com {\n\tadmin unix//run/caddy/admin.sock\n}\n' >"$FIXTURE/no-global"
caddyfile_admin_scan "$FIXTURE/no-global" "$FIXTURE/no-global.out"; rc=$?
assert_rc 3 "$rc" "无全局段时不改动"

new_fixture
printf '[Service]\nRuntimeDirectory=caddy\nRuntimeDirectoryMode=0755\n' >"$CADDY_RUNTIME_DROPIN"
printf 'd /run/caddy 0755 caddy caddy -\n' >"$CADDY_TMPFILES"
cat >"$CADDYFILE_PATH" <<'EOF'
{
	admin unix//run/caddy/admin.sock
}

example.com {
	root * /srv
}
EOF
cp "$CADDYFILE_PATH" "$FIXTURE/Caddyfile.original"
detect_caddy
CADDY_REMOVE=1
caddy() { return 0; }
systemctl() { return 1; }
remove_caddy >/dev/null 2>&1
if [ "$(grep -c 'admin unix' "$CADDYFILE_PATH")" = 0 ]; then pass "Caddyfile admin 行已移除"; else fail "Caddyfile admin 行仍在"; fi
if [ ! -e "$CADDY_RUNTIME_DROPIN" ] && [ ! -e "$CADDY_TMPFILES" ]; then pass "drop-in/tmpfiles 已移除"; else fail "drop-in/tmpfiles 仍在"; fi
if [ -n "$BACKUP_DIR" ] && [ -f "$BACKUP_DIR/Caddyfile" ]; then pass "Caddyfile 已备份"; else fail "Caddyfile 未备份"; fi

new_fixture
printf '[Service]\nRuntimeDirectory=caddy\nRuntimeDirectoryMode=0755\n' >"$CADDY_RUNTIME_DROPIN"
printf 'd /run/caddy 0755 caddy caddy -\n' >"$CADDY_TMPFILES"
cat >"$CADDYFILE_PATH" <<'EOF'
{
	admin unix//run/caddy/admin.sock
}
EOF
cp "$CADDYFILE_PATH" "$FIXTURE/Caddyfile.original"
detect_caddy
CADDY_REMOVE=1
caddy() { return 1; }
systemctl() { return 1; }
remove_caddy >/dev/null 2>&1
if cmp -s "$CADDYFILE_PATH" "$FIXTURE/Caddyfile.original"; then pass "validate 失败时 Caddyfile 不变"; else fail "validate 失败却改了 Caddyfile"; fi
if [ -e "$CADDY_RUNTIME_DROPIN" ]; then pass "Caddyfile 失败时不删 drop-in"; else fail "Caddyfile 失败却删了 drop-in"; fi
assert_eq 1 "$FAILED" "validate 失败记录 FAILED"

new_fixture
rm -f "$CADDYFILE_PATH"
printf '{\n\tadmin unix//run/caddy/admin.sock\n}\n' >"$FIXTURE/Caddyfile.real"
cp "$FIXTURE/Caddyfile.real" "$FIXTURE/Caddyfile.expected"
ln -s "$FIXTURE/Caddyfile.real" "$CADDYFILE_PATH"
detect_caddy
CADDY_REMOVE=1
caddy() { return 0; }
systemctl() { return 1; }
remove_caddy >/dev/null 2>&1
if [ -L "$CADDYFILE_PATH" ] && cmp -s "$FIXTURE/Caddyfile.real" "$FIXTURE/Caddyfile.expected"; then
  pass "Caddyfile 为符号链接时拒绝改写"
else
  fail "符号链接 Caddyfile 被改写"
fi
assert_eq 1 "$FAILED" "符号链接拒绝记录 FAILED"
unset -f caddy systemctl

echo "== UFW 精确规则 =="
new_fixture
UFW_RULES="$FIXTURE/ufw-rules"
UFW_LOG="$FIXTURE/ufw.log"
cat >"$UFW_RULES" <<'EOF'
allow 22/tcp
allow 48100/tcp comment 'Elysian 面板'
allow 48100/tcp
allow 48100/tcp comment '其他服务'
allow 48000:49000/tcp
EOF
ufw() {
  case "$1" in
    status) printf 'Status: active\n' ;;
    show)
      sed 's/^/ufw /' "$UFW_RULES" ;;
    --force)
      printf '%s\n' "$*" >>"$UFW_LOG"
      if [ "${6:-}" ]; then
        grep -vxF "allow $4 comment '$6'" "$UFW_RULES" >"$UFW_RULES.tmp" || true
      else
        grep -vxF "allow $4" "$UFW_RULES" >"$UFW_RULES.tmp" || true
      fi
      mv "$UFW_RULES.tmp" "$UFW_RULES"
      ;;
  esac
}
RULES="$(ufw_managed_rules)"
case "$RULES" in
  *"Elysian 面板"*) pass "识别带注释面板规则" ;;
  *) fail "未识别带注释面板规则：$RULES" ;;
esac
case "$RULES" in
  *"48100/tcp"*) pass "识别无注释面板规则" ;;
  *) fail "未识别无注释面板规则：$RULES" ;;
esac
case "$RULES" in
  *"其他服务"*|*"48000"*) fail "误选用户规则" ;;
  *) pass "不误选用户规则" ;;
esac
remove_ufw >/dev/null 2>&1
if grep -q "Elysian 面板" "$UFW_RULES"; then fail "面板注释规则未删除"; else pass "面板注释规则已删除"; fi
if grep -qx 'allow 48100/tcp' "$UFW_RULES"; then fail "无注释面板规则未删除"; else pass "无注释面板规则已删除"; fi
if grep -q '其他服务' "$UFW_RULES" && grep -q '48000:49000' "$UFW_RULES"; then pass "用户规则保留"; else fail "用户规则被误删"; fi
unset -f ufw

echo "== 账号条件删除 =="
new_fixture
DATA_ROOT="$FIXTURE/data"
mkdir -p "$DATA_ROOT/data"
printf 'db' >"$DATA_ROOT/data/metrics.sqlite"
USERS="$FIXTURE/users"
printf 'elysian\nelysian-build\nelysian-sqlite\n' >"$USERS"
id() {
  if [ "$1" = "-u" ]; then grep -qx "$2" "$USERS"; else command id "$@"; fi
}
getent() { printf 'elysian:x:999:999::%s:/usr/sbin/nologin\n' "$STATE_DIR"; }
userdel() { grep -vx "$1" "$USERS" >"$USERS.tmp" || true; mv "$USERS.tmp" "$USERS"; printf 'userdel %s\n' "$1" >>"$FIXTURE/users.log"; }
groupdel() { printf 'groupdel %s\n' "$1" >>"$FIXTURE/users.log"; }
DELETE_CONFIG=1; DELETE_LOGS=1; DELETE_STATE=1
remove_accounts >/dev/null 2>&1
if grep -qx 'elysian' "$USERS" && grep -qx 'elysian-sqlite' "$USERS"; then pass "保留数据时保留 elysian/elysian-sqlite"; else fail "保留数据却删了账号"; fi
if grep -qx 'elysian-build' "$USERS"; then fail "elysian-build 未删除"; else pass "elysian-build 删除"; fi

new_fixture
rm -rf "$STATE_DIR" "$CLI_DATA_DIR"
DATA_ROOT="$FIXTURE/data"
mkdir -p "$DATA_ROOT"
printf 'elysian\nelysian-build\nelysian-sqlite\n' >"$USERS"
DELETE_DATA=1; DELETE_CONFIG=1; DELETE_LOGS=1; DELETE_STATE=1
remove_accounts >/dev/null 2>&1
if [ ! -s "$USERS" ]; then pass "全删数据时删除三个账号"; else fail "仍有账号残留：$(cat "$USERS")"; fi
if grep -q 'groupdel elysian' "$FIXTURE/users.log"; then pass "补删 elysian 组"; else fail "未删 elysian 组"; fi

new_fixture
rm -rf "$DATA_ROOT"
printf 'unknown' >"$STATE_DIR/unknown.txt"
USERS="$FIXTURE/users"
printf 'elysian\nelysian-build\nelysian-sqlite\n' >"$USERS"
DELETE_DATA=1; DELETE_CONFIG=1; DELETE_LOGS=1; DELETE_STATE=1
remove_accounts >/dev/null 2>&1
if grep -qx 'elysian' "$USERS" && ! grep -qx 'elysian-sqlite' "$USERS"; then
  pass "数据目录仍有未分类内容时保留 elysian、删除 elysian-sqlite"
else
  fail "未分类内容场景账号处理异常：$(cat "$USERS")"
fi
unset -f id getent userdel groupdel

echo "== 安装产物清理 =="
new_fixture
printf 'bin' >"$PANEL_BIN"
mkdir -p "$INSTALL_ROOT"
printf 'env' >"$ENV_FILE"
printf 'profile' >"$MIRROR_PROFILE"
mkdir -p "$BUILD_HOME"
printf 'art' >"$FIXTURE/artifacts/elysian-build.123"
printf 'keep' >"$FIXTURE/artifacts/keep.txt"
remove_artifacts >/dev/null 2>&1
if [ ! -e "$PANEL_BIN" ] && [ ! -e "$INSTALL_ROOT" ] && [ ! -e "$ENV_FILE" ] && [ ! -e "$MIRROR_PROFILE" ] && [ ! -e "$BUILD_HOME" ]; then
  pass "安装产物已删除"
else
  fail "安装产物未删净"
fi
if [ -e "$FIXTURE/artifacts/keep.txt" ] && [ ! -e "$FIXTURE/artifacts/elysian-build.123" ]; then
  pass "临时残留按命名模式清理"
else
  fail "临时残留清理范围异常"
fi
if [ -n "$BACKUP_DIR" ] && [ -f "$BACKUP_DIR/default-elysian" ]; then pass "环境文件已备份"; else fail "环境文件未备份"; fi

echo "== ely CLI 链接归属判定（cli_link_owned） =="
new_fixture
mkdir -p "$INSTALL_ROOT/releases/r1" "$FIXTURE/foreign"
printf 'bin' >"$INSTALL_ROOT/releases/r1/elysian"
ln -sfn "$INSTALL_ROOT/releases/r1" "$INSTALL_ROOT/current"
ln -s "$INSTALL_ROOT/current/elysian" "$CLI_BIN"
if cli_link_owned; then pass "指向 INSTALL_ROOT 的符号链接判为本面板"; else fail "自家链接被误判为外部"; fi
printf 'foreign' >"$FIXTURE/foreign/ely"
ln -sfn "$FIXTURE/foreign/ely" "$CLI_BIN"
if cli_link_owned; then fail "外部链接误判为本面板"; else pass "指向外部的符号链接不属本面板"; fi
rm -f "$CLI_BIN"
printf 'foreign' >"$CLI_BIN"
if cli_link_owned; then fail "普通文件误判为本面板"; else pass "普通文件不属本面板"; fi
rm -f "$CLI_BIN"
if cli_link_owned; then fail "不存在时误判"; else pass "落点不存在不属本面板"; fi

echo "== ely CLI 链接三态清理（remove_artifacts） =="
new_fixture
mkdir -p "$INSTALL_ROOT/releases/r1"
printf 'bin' >"$INSTALL_ROOT/releases/r1/elysian"
ln -sfn "$INSTALL_ROOT/releases/r1" "$INSTALL_ROOT/current"
ln -s "$INSTALL_ROOT/current/elysian" "$CLI_BIN"
remove_artifacts >/dev/null 2>&1
if [ ! -e "$CLI_BIN" ] && [ ! -L "$CLI_BIN" ]; then pass "自家 ely 链接已删除"; else fail "自家 ely 链接未删除"; fi

new_fixture
printf 'foreign' >"$CLI_BIN"
remove_artifacts >/dev/null 2>&1
if [ -f "$CLI_BIN" ] && [ "$(cat "$CLI_BIN")" = "foreign" ]; then pass "外部同名普通文件保留"; else fail "外部普通文件被误删"; fi
case "${KEPT_ITEMS[*]}" in *"非本面板安装"*) pass "保留项记录 ely 外部占用" ;; *) fail "KEPT 缺少 ely 记录：${KEPT_ITEMS[*]}" ;; esac
assert_eq 0 "$FAILED" "保留外部 ely 不算卸载失败"

new_fixture
printf 'other' >"$FIXTURE/foreign-ely"
ln -s "$FIXTURE/foreign-ely" "$CLI_BIN"
remove_artifacts >/dev/null 2>&1
if [ -L "$CLI_BIN" ]; then pass "外部同名符号链接保留"; else fail "外部符号链接被误删"; fi

new_fixture
remove_artifacts >/dev/null 2>&1
if [ ! -e "$CLI_BIN" ] && [ ! -L "$CLI_BIN" ]; then pass "ely 不存在时跳过"; else fail "ely 落点异常"; fi
case "${KEPT_ITEMS[*]}" in *"ely"*) fail "不存在的 ely 不应记入保留项" ;; *) pass "不存在的 ely 不记保留项" ;; esac

echo "== ely CLI 本地数据归入状态类 =="
new_fixture
DELETE_STATE=1
remove_data >/dev/null 2>&1
if [ ! -e "$CLI_DATA_DIR" ]; then pass "删除状态类时清理 ely CLI 本地数据"; else fail "ely CLI 本地数据未清理"; fi
if [ ! -e "${CLI_DATA_DIR%/cli}" ]; then pass "ely 数据父目录空则一并移除"; else fail "ely 数据父目录残留"; fi
if [ -e "$DATA_ROOT/config" ]; then pass "未选类别不受 ely 数据影响"; else fail "未选类别被误删"; fi

new_fixture
remove_data >/dev/null 2>&1
if [ -e "$CLI_DATA_DIR" ] && [ -f "$CLI_DATA_DIR/state.json" ]; then pass "保留状态类时保留 ely CLI 本地数据"; else fail "ely 本地数据被误删"; fi

new_fixture
printf 'unknown' >"$STATE_DIR/unknown.txt"
PURGE_DATA=1
remove_data >/dev/null 2>&1
if [ ! -e "$STATE_DIR" ] && [ ! -e "$CLI_DATA_DIR" ]; then pass "--purge-data 同时删除 ely CLI 本地数据"; else fail "--purge-data 未删净 ely 数据"; fi

new_fixture
if safe_rm "$CLI_DATA_DIR/state.json" 2>/dev/null; then pass "safe_rm 允许 ely 数据目录内路径"; else fail "safe_rm 误拒 ely 数据路径"; fi
if [ ! -e "$CLI_DATA_DIR/state.json" ]; then pass "safe_rm 删除 ely 数据文件"; else fail "safe_rm 未删除 ely 数据文件"; fi
if ( safe_rm "${CLI_DATA_DIR%/cli}" ) >/dev/null 2>&1; then fail "safe_rm 不应放行 ely 数据父目录"; else pass "safe_rm 拒绝 ely 数据父目录"; fi

echo "== ely 残留断言（verify_clean） =="
new_fixture
ufw() { case "$1" in status) printf 'Status: inactive\n' ;; esac; }
id() { return 1; }
mkdir -p "$INSTALL_ROOT/releases/r1"
printf 'bin' >"$INSTALL_ROOT/releases/r1/elysian"
ln -sfn "$INSTALL_ROOT/releases/r1" "$INSTALL_ROOT/current"
ln -s "$INSTALL_ROOT/current/elysian" "$CLI_BIN"
rm -rf "$INSTALL_ROOT"
verify_clean >/dev/null 2>&1
case "${RESIDUE[*]}" in *"CLI 命令链接"*) pass "自家 ely 链接残留被标记" ;; *) fail "自家 ely 链接残留未标记：${RESIDUE[*]}" ;; esac
rm -f "$CLI_BIN"
RESIDUE=()
FAILED=0
verify_clean >/dev/null 2>&1
case "${RESIDUE[*]}" in *"CLI"*) fail "ely 已清理仍报残留" ;; *) pass "ely 清理后无残留" ;; esac
printf 'foreign' >"$CLI_BIN"
RESIDUE=()
FAILED=0
verify_clean >/dev/null 2>&1
case "${RESIDUE[*]}" in *"CLI"*) fail "保留的外部 ely 被误报残留" ;; *) pass "外部 ely 保留不算残留" ;; esac
unset -f ufw id

echo "== 残留检查 =="
new_fixture
KEEP_TOOLS=1
: >"$PANEL_BIN" 2>/dev/null || { mkdir -p "$(dirname "$PANEL_BIN")"; : >"$PANEL_BIN"; }
ufw() { case "$1" in status) printf 'Status: inactive\n' ;; esac; }
id() { return 1; }
verify_clean >/dev/null 2>&1
if [ "${#RESIDUE[@]}" -gt 0 ] && [ "$FAILED" = 1 ]; then pass "发现残留并标记失败"; else fail "未发现残留"; fi
rm -f "$PANEL_BIN"
FAILED=0
verify_clean >/dev/null 2>&1
if [ "${#RESIDUE[@]}" -eq 0 ] && [ "$FAILED" = 0 ]; then pass "无残留时通过"; else fail "无残留仍报错：${RESIDUE[*]}" ; fi
unset -f ufw id

echo "== dry-run 不修改 =="
if (
  set -e
  new_fixture
  id() { echo 0; }
  systemctl() { [ "$1" = "list-units" ] && return 1; return 0; }
  ufw() {
    case "$1" in
      status) printf 'Status: active\n' ;;
      show) printf 'ufw allow 48100/tcp comment '\''Elysian 面板'\''\n' ;;
    esac
  }
  out="$(main --dry-run)"
  printf '%s' "$out" | grep -q 'Elysian 卸载计划' &&
    printf '%s' "$out" | grep -q '面板数据' &&
    printf '%s' "$out" | grep -q 'CLI 命令' &&
    printf '%s' "$out" | grep -Fq '仅删除本面板注册的符号链接' &&
    printf '%s' "$out" | grep -q '预览结束' &&
    [ -f "$DATA_ROOT/data/metrics.sqlite" ]
); then pass "dry-run 输出计划且不改文件"; else fail "dry-run 行为异常"; fi

echo
printf '结果：%d 通过，%d 失败\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
