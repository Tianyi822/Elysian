#!/usr/bin/env bash
# scripts/install-helpers.test.sh —— install.sh 纯逻辑辅助的自测（source 待测脚本，不执行主流程；
# install.sh 末尾的执行守卫保证 source 时不安装任何东西）。覆盖：阶段登记自动计数、终端能力
# 降级（双 TTY / NO_COLOR / 非 TTY）、输出标记、架构与发行版判定、Docker Engine API 版本比较、
# Caddyfile 管理通道改写（含零写与拒绝分支）、Caddy 重启判定、管理通道路径解析、服务器地址探测与长命令日志出口。
# 落盘类用例全部指向临时目录，不触碰系统配置；本机 bash 3.2 可跑（不依赖 bash 4 特性）。
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1090
source "${SCRIPT_DIR}/install.sh"
# install.sh 顶部带 set -euo pipefail；测试框架改回显式判断。
set +e +u

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$1" >&2; }
assert_eq() { # <期望> <实际> <说明>
  if [ "$1" = "$2" ]; then pass "$3"; else fail "$3：期望 [$1]，实际 [$2]"; fi
}
assert_rc() { # <期望 rc> <实际 rc> <说明>
  if [ "$2" = "$1" ]; then pass "$3"; else fail "$3：期望 rc=$1，实际 rc=$2"; fi
}

echo "== 阶段登记与计数 =="
SMOKE=""
register_stages
assert_eq 11 "$TOTAL_STEPS" "正式安装阶段总数自动派生为 11"
assert_eq "检测并安装平台依赖" "${STAGES[6]}" "正式安装第 7 阶段为平台依赖"
SMOKE=1
register_stages
assert_eq 7 "$TOTAL_STEPS" "冒烟模式阶段总数保持 7"
assert_eq "冒烟验证" "${STAGES[6]}" "冒烟模式第 7 阶段为冒烟验证"
SMOKE=""

echo "== 终端能力降级 =="
if (
  set -e
  unset NO_COLOR
  TERM=xterm-256color
  init_output 1 1
  [ -n "$C_GREEN" ] && [ "$SPINNER_ENABLED" = 1 ] && [ -n "$TERM_COLS" ]
); then pass "双 TTY 开启颜色与单行刷新"; else fail "双 TTY 未开启颜色或单行刷新"; fi
if (
  set -e
  TERM=xterm-256color
  NO_COLOR=1 init_output 1 1
  [ -z "$C_GREEN" ] && [ "$SPINNER_ENABLED" = 1 ]
); then pass "NO_COLOR 只关颜色、不关单行刷新"; else fail "NO_COLOR 行为不符"; fi
if (
  set -e
  init_output 0 1
  [ -z "$C_GREEN" ] && [ "$SPINNER_ENABLED" = 0 ]
); then pass "非 TTY 纯文本降级（颜色与刷新全关）"; else fail "非 TTY 降级不符"; fi
if (
  set -e
  TERM=dumb init_output 1 1
  [ -z "$C_GREEN" ] && [ "$SPINNER_ENABLED" = 0 ]
); then pass "TERM=dumb 不输出 ANSI 或单行刷新"; else fail "TERM=dumb 未降级"; fi

if (
  set -e
  init_output 0 0
  clear_progress_line
  [ "$TUI_LIVE" = 0 ]
); then pass "非 TTY 擦除进度行不返回失败"; else fail "非 TTY 擦除进度行触发 set -e"; fi

echo "== 阶段行与输出标记 =="
# 计数与格式分开断言：命令替换 $() 会把 section 的 STEP 递增隔离在子 shell 内。
if (
  set -e
  SMOKE=""
  register_stages
  STEP=0
  section "检查运行环境" >/dev/null
  [ "$STEP" = 1 ]
); then pass "阶段计数随 section 递增"; else fail "阶段计数未递增"; fi
if (
  set -e
  SMOKE=""
  register_stages
  STEP=0
  out="$(section "检查运行环境")"
  [ "$out" = "$(printf '\n[ 1/11] 检查运行环境\n')" ]
); then pass "阶段行格式 [ n/N] 名称"; else fail "阶段行格式不符"; fi
if (
  set -e
  SMOKE=""
  register_stages
  STEP=0
  STAGE_FINISHED=0
  init_output 0 0
  section "检查运行环境" >/dev/null
  out="$(section "安装系统依赖")"
  printf '%s' "$out" | grep -q '└ 用时'
); then pass "阶段切换打印上一阶段耗时"; else fail "阶段耗时未打印"; fi
if (
  set -e
  init_output 0 0
  [ "$(ok "hi")" = "    ✓ hi" ] && [ "$(skip "s")" = "    − s" ] && [ "$(warn "w")" = "    ! w" ]
); then pass "✓ / − / ! 标记在纯文本下无 ANSI 转义"; else fail "输出标记异常"; fi

echo "== TUI 显示宽度与阶段头 =="
assert_eq 8 "$(tui_width '面板服务')" "中文按双列计算"
assert_eq 6 "$(tui_width 'Docker')" "ASCII 按单列计算"
assert_eq 1 "$(tui_width '✓')" "状态符号按单列计算"
assert_eq 1 "$(tui_width '…')" "省略号按单列计算"
assert_eq 1 "$(tui_width '─')" "横线按单列计算"
assert_eq 2 "$(tui_width '█░')" "进度块各占一列"
assert_eq "Docker      " "$(tui_pad 'Docker' 12)" "补位到目标显示宽度"
if (
  set -e
  SMOKE=""
  register_stages
  STEP=0
  TERM=xterm-256color
  init_output 1 1
  out="$(section "检查运行环境")"
  printf '%s' "$out" | grep -q '\[ 1/11\]' &&
    printf '%s' "$out" | grep -q '█' &&
    printf '%s' "$out" | grep -q '░'
); then pass "TTY 底部状态行带进度条"; else fail "TTY 进度条缺失"; fi
if (
  set -e
  SMOKE=""
  register_stages
  STEP=0
  TERM=xterm-256color
  init_output 1 1
  out="$(section "检查运行环境")"
  header="$(printf '%s' "$out" | sed -n '2p')"
  ! printf '%s' "$header" | grep -q '█'
); then pass "阶段头不再重复画进度条"; else fail "阶段头仍带进度条"; fi
if (
  set -e
  SMOKE=""
  register_stages
  STEP=0
  init_output 0 0
  out="$(section "检查运行环境")"
  printf '%s' "$out" | grep -q '^\[ 1/11\] 检查运行环境$' &&
    ! printf '%s' "$out" | grep -q '█'
); then pass "非 TTY 阶段行无进度条"; else fail "非 TTY 阶段行异常"; fi

echo "== 轻量卸载入口已移除 =="
if ( source "$SCRIPT_DIR/install.sh"; ! type uninstall >/dev/null 2>&1 ); then
  pass "install.sh 不再定义 uninstall"
else
  fail "install.sh 仍定义 uninstall"
fi
if OUT="$( (source "$SCRIPT_DIR/install.sh"; init_output 0 0; main --uninstall) 2>&1 )"; then
  fail "main --uninstall 应拒绝"
else
  case "$OUT" in
    *"scripts/uninstall.sh"*) pass "main --uninstall 提示新的唯一入口" ;;
    *) fail "拒绝文案异常：$OUT" ;;
  esac
fi

echo "== 架构与发行版判定 =="
if (
  set -e
  map_arch x86_64 && [ "$GO_ARCH" = amd64 ] && [ "$BUN_ARCH" = x64 ]
  map_arch aarch64 && [ "$GO_ARCH" = arm64 ] && [ "$BUN_ARCH" = aarch64 ]
); then pass "x86_64 / aarch64 架构映射"; else fail "架构映射不符"; fi
if map_arch riscv64 2>/dev/null; then fail "不支持的架构应返回非零"; else pass "不支持的架构返回非零"; fi
if distro_family_supported "ubuntu"; then pass "ubuntu 判为支持"; else fail "ubuntu 应支持"; fi
if distro_family_supported "debian"; then pass "debian 判为支持"; else fail "debian 应支持"; fi
if distro_family_supported "centos rhel fedora" 2>/dev/null; then fail "redhat 系不应支持"; else pass "redhat 系不支持"; fi

echo "== Docker Engine API 版本比较（≥ 1.41） =="
for v in 1.41 1.43 1.51 2.0; do
  if docker_api_version_ok "$v"; then pass "$v 通过"; else fail "$v 应通过"; fi
done
for v in 1.40 1.24 1.12 "" 1 x.y; do
  if docker_api_version_ok "$v"; then fail "$v 不应通过"; else pass "$v 拒绝"; fi
done

echo "== Caddyfile 管理通道改写（caddyfile_ensure_admin） =="
SOCK="/run/caddy/admin.sock"
DIRECTIVE="admin unix//run/caddy/admin.sock"
# 内容比对统一用 %s 归一（命令替换会剥尾换行，实现按面板语义恒带尾换行）。
result_text() { printf '%s' "$CADDYFILE_RESULT"; }

caddyfile_ensure_admin "" "$SOCK"; rc=$?
assert_rc 0 "$rc" "空内容生成最小 Caddyfile"
assert_eq "$(printf '{\n\t%s\n}' "$DIRECTIVE")" "$(result_text)" "最小 Caddyfile 内容"

caddyfile_ensure_admin "$(printf 'example.com {\n\troot * /srv\n}')" "$SOCK"; rc=$?
assert_rc 0 "$rc" "无全局段时头部补全局段"
assert_eq "$(printf '{\n\t%s\n}\n\nexample.com {\n\troot * /srv\n}' "$DIRECTIVE")" "$(result_text)" "头部补段内容"

caddyfile_ensure_admin "$(printf '{\n\tadmin unix/old.sock\n\thttp_port 80\n}\nexample.com {\n\troot * /srv\n}')" "$SOCK"; rc=$?
assert_rc 0 "$rc" "已有别的 admin 时替换"
assert_eq "$(printf '{\n\t%s\n\thttp_port 80\n}\nexample.com {\n\troot * /srv\n}' "$DIRECTIVE")" "$(result_text)" "替换结果恰有一条目标 admin"

caddyfile_ensure_admin "$(printf '{\n\t%s\n}\nsite {\n\troot\n}' "$DIRECTIVE")" "$SOCK"; rc=$?
assert_rc 1 "$rc" "已是目标 admin 时返回零写"

caddyfile_ensure_admin "$(printf '{\n\tadmin unix/a.sock\n\tadmin unix/b.sock\n}\nsite {\n}')" "$SOCK"; rc=$?
assert_rc 0 "$rc" "多条 admin 收敛为一条"
assert_eq "$(printf '{\n\t%s\n}\nsite {\n}' "$DIRECTIVE")" "$(result_text)" "多条 admin 收敛内容"

caddyfile_ensure_admin "$(printf '{\n\thttp_port 80\n}\nsite {\n\tadmin internal\n}')" "$SOCK"; rc=$?
assert_rc 0 "$rc" "站点块内的 admin 行不改"
if [ "$(printf '%s\n' "$CADDYFILE_RESULT" | grep -c 'admin ')" = 2 ]; then
  pass "站点块 admin 原样保留（全局一条＋站点一条）"
else
  fail "站点块 admin 行数异常：$(printf '%s\n' "$CADDYFILE_RESULT" | grep -c 'admin ')"
fi

caddyfile_ensure_admin "$(printf '{\n\tdebug\n}')" "$SOCK"; rc=$?
assert_rc 0 "$rc" "全局段无 admin 时插入"
caddyfile_ensure_admin "$(printf '{\n\tdebug\n')" "$SOCK"; rc=$?
assert_rc 2 "$rc" "全局段未闭合时拒绝改写"
caddyfile_ensure_admin "$(printf '# note\n\n{\n\tdebug\n}\nsite {\n}')" "$SOCK"; rc=$?
assert_rc 0 "$rc" "注释与空行不影响全局段识别"
caddyfile_ensure_admin "$(printf '{\r\n\tadmin unix/old.sock\r\n}\r\nsite {\r\n}')" "$SOCK"; rc=$?
assert_rc 0 "$rc" "CRLF 输入按 LF 归一后替换"
assert_eq "$(printf '{\n\t%s\n}\nsite {\n}' "$DIRECTIVE")" "$(result_text)" "CRLF 归一结果"

echo "== Caddyfile 候选生成（不修改原文件） =="
TMPDIR_TEST="$(mktemp -d)"
CFG="$TMPDIR_TEST/Caddyfile"
prepare_caddy_admin_file "$SOCK" "$CFG" "$TMPDIR_TEST/candidate"; rc=$?
assert_rc 0 "$rc" "文件缺失时生成最小候选"
assert_eq "$(printf '{\n\t%s\n}' "$DIRECTIVE")" "$(cat "$TMPDIR_TEST/candidate")" "最小候选内容"
if [ ! -e "$CFG" ]; then pass "生成候选不创建原文件"; else fail "候选阶段写了原文件"; fi

printf '{\n\t%s\n}\n' "$DIRECTIVE" >"$CFG"
BEFORE="$(cat "$CFG")"
prepare_caddy_admin_file "$SOCK" "$CFG" "$TMPDIR_TEST/candidate"; rc=$?
assert_rc 0 "$rc" "已是目标时正常返回"
assert_eq "$BEFORE" "$(cat "$CFG")" "已是目标时零写（内容不变）"

printf '{\n\tadmin unix/old.sock\n}\n' >"$CFG"
prepare_caddy_admin_file "$SOCK" "$CFG" "$TMPDIR_TEST/candidate"; rc=$?
assert_rc 0 "$rc" "替换改写成功"
assert_eq "$(printf '{\n\t%s\n}' "$DIRECTIVE")" "$(cat "$TMPDIR_TEST/candidate")" "替换后的候选内容"
assert_eq "$(printf '{\n\tadmin unix/old.sock\n}')" "$(cat "$CFG")" "原配置保留到事务发布阶段"

head -c 262145 /dev/zero | tr '\0' 'x' >"$CFG"
BEFORE="$(cat "$CFG")"
prepare_caddy_admin_file "$SOCK" "$CFG" "$TMPDIR_TEST/candidate" >"$TMPDIR_TEST/out.txt" 2>&1; rc=$?
OUT="$(cat "$TMPDIR_TEST/out.txt")"
assert_rc 1 "$rc" "超过 256 KiB 拒绝自动接入"
assert_eq "$BEFORE" "$(cat "$CFG")" "超大文件零改动"
if printf '%s' "$OUT" | grep -q 'Caddyfile 过大'; then pass "超大文件输出中文警告"; else fail "缺少「Caddyfile 过大」警告"; fi

echo "== ely CLI 链接归属判定（cli_link_owned） =="
TMPCLI="$TMPDIR_TEST/cli"
mkdir -p "$TMPCLI/bin" "$TMPCLI/opt/elysian/releases/r1" "$TMPCLI/foreign"
CLI_BIN="$TMPCLI/bin/ely"
INSTALL_ROOT="$TMPCLI/opt/elysian"
printf 'foreign' >"$TMPCLI/foreign/ely"
ln -sfn "$INSTALL_ROOT/releases/r1" "$INSTALL_ROOT/current"
ln -s "$INSTALL_ROOT/current/elysian" "$CLI_BIN"
if cli_link_owned; then pass "指向 INSTALL_ROOT 的符号链接判为本面板"; else fail "自家链接被误判为外部"; fi
ln -sfn "$TMPCLI/foreign/ely" "$CLI_BIN"
if cli_link_owned; then fail "外部链接误判为本面板"; else pass "指向外部的符号链接不属本面板"; fi
rm -f "$CLI_BIN"
printf 'foreign' >"$CLI_BIN"
if cli_link_owned; then fail "普通文件误判为本面板"; else pass "普通文件不属本面板"; fi
rm -f "$CLI_BIN"
if cli_link_owned; then fail "不存在时误判"; else pass "落点不存在不属本面板"; fi
ln -sfn "$INSTALL_ROOT/../foreign/ely" "$CLI_BIN"
if cli_link_owned; then fail "「..」逃逸安装根的目标误判为本面板"; else pass "「..」逃逸安装根的目标不属本面板"; fi
ln -s "$TMPCLI/foreign/ely" "$INSTALL_ROOT/escape-link"
ln -sfn "$INSTALL_ROOT/escape-link" "$CLI_BIN"
if cli_link_owned; then fail "经安装根内符号链接跳向外部的目标误判为本面板"; else pass "经安装根符号链接外跳的目标不属本面板"; fi
rm -f "$INSTALL_ROOT/escape-link"
ln -sfn "../foreign/ely" "$CLI_BIN"
if cli_link_owned; then fail "相对「..」目标误判为本面板"; else pass "相对「..」目标不属本面板"; fi
printf 'bin' >"$INSTALL_ROOT/releases/r1/elysian"
ln -sfn "$INSTALL_ROOT/releases/r1/elysian" "$CLI_BIN"
if cli_link_owned; then pass "指向 releases 产物的绝对链接判为本面板"; else fail "releases 产物链接被误判为外部"; fi
ln -sfn "$INSTALL_ROOT/current/elysian" "$CLI_BIN"
rm -f "$INSTALL_ROOT/current"
if cli_link_owned; then pass "断链的精确受管文本形态判为本面板"; else fail "断链受管形态被误判为外部"; fi
ln -sfn "$INSTALL_ROOT/releases/r1" "$INSTALL_ROOT/current"
rm -f "$CLI_BIN"

echo "== ely CLI 注册（register_cli_link） =="
cat >"$INSTALL_ROOT/releases/r1/elysian" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  --version) printf 'Elysian CLI（ely）\n版本：deadbeef\n构建时间：2026-10-25T00:00:00Z\n' ;;
esac
STUB
chmod +x "$INSTALL_ROOT/releases/r1/elysian"
BUILD_COMMIT="deadbeef"
OUT="$(register_cli_link 2>&1)"; rc=$?
assert_rc 0 "$rc" "落点不存在时注册成功"
if [ "$(readlink "$CLI_BIN")" = "$INSTALL_ROOT/current/elysian" ]; then pass "ely 链接指向 current/elysian"; else fail "ely 链接目标异常：$(readlink "$CLI_BIN")"; fi
if printf '%s' "$OUT" | grep -q 'CLI 命令已注册'; then pass "注册成功输出确认信息"; else fail "缺少注册确认：$OUT"; fi

OUT="$(register_cli_link 2>&1)"; rc=$?
assert_rc 0 "$rc" "幂等重跑对自家链接放行刷新"
commit_cli_registration

mkdir -p "$INSTALL_ROOT/releases/r0"
cp "$INSTALL_ROOT/releases/r1/elysian" "$INSTALL_ROOT/releases/r0/elysian"
rm -f "$CLI_BIN"
ln -s "$INSTALL_ROOT/releases/r0/elysian" "$CLI_BIN"
OUT="$(register_cli_link 2>&1)"; rc=$?
assert_rc 0 "$rc" "旧版本自家链接刷新通过"
if [ "$(readlink "$CLI_BIN")" = "$INSTALL_ROOT/current/elysian" ]; then pass "刷新后指向当前版本"; else fail "刷新后链接目标异常"; fi
restore_cli_registration
if [ "$(readlink "$CLI_BIN")" = "$INSTALL_ROOT/releases/r0/elysian" ]; then pass "中断恢复精确旧目标"; else fail "中断恢复没有还原旧目标"; fi
register_cli_link >/dev/null 2>&1
commit_cli_registration

rm -f "$CLI_BIN"
printf 'foreign' >"$CLI_BIN"
OUT="$(register_cli_link 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$OUT" | grep -q '已被其他软件占用'; then
  pass "外部同名普通文件拒绝安装并中文报错"
else
  fail "外部普通文件分支行为不符（rc=$rc）"
fi
if [ "$(cat "$CLI_BIN")" = "foreign" ]; then pass "拒绝时外部文件原样保留"; else fail "外部文件被覆盖"; fi

rm -f "$CLI_BIN"
ln -s "$TMPCLI/foreign/ely" "$CLI_BIN"
OUT="$(register_cli_link 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && [ "$(readlink "$CLI_BIN")" = "$TMPCLI/foreign/ely" ]; then
  pass "外部同名符号链接拒绝安装且原样保留"
else
  fail "外部链接分支行为不符（rc=$rc）"
fi

rm -f "$CLI_BIN"
BUILD_COMMIT="cafebab1"
OUT="$(register_cli_link 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$OUT" | grep -q '构建标识'; then
  pass "--version 不含构建标识时拒绝"
else
  fail "版本校验分支行为不符（rc=$rc）"
fi
BUILD_COMMIT="deadbeef"

echo "== ely CLI 冒烟（smoke_verify_cli） =="
SMOKE_BUILD="$TMPDIR_TEST/smoke-build"
mkdir -p "$SMOKE_BUILD"
cat >"$SMOKE_BUILD/elysian" <<'STUB'
#!/usr/bin/env bash
if [ "$#" -eq 0 ]; then
  printf '%s\n' 'ely 需要交互式终端，请在服务器终端直接运行；脚本场景请使用 elysian 子命令。' >&2
  exit 1
fi
case "$1" in
  --version) printf 'Elysian CLI（ely）\n版本：deadbeef\n' ;;
esac
STUB
chmod +x "$SMOKE_BUILD/elysian"
BUILD_DIR="$SMOKE_BUILD"
OUT="$(smoke_verify_cli 2>&1)"; rc=$?
assert_rc 0 "$rc" "ely 冒烟通过（--version 含构建标识、非 TTY 非零退出）"
if printf '%s' "$OUT" | grep -q 'CLI 冒烟通过'; then pass "冒烟输出确认信息"; else fail "缺少冒烟确认：$OUT"; fi

cat >"$SMOKE_BUILD/elysian" <<'STUB'
#!/usr/bin/env bash
if [ "$#" -eq 0 ]; then
  printf '%s\n' 'ely 需要交互式终端，请在服务器终端直接运行；脚本场景请使用 elysian 子命令。' >&2
  exit 0
fi
case "$1" in
  --version) printf '版本：deadbeef\n' ;;
esac
STUB
OUT="$(smoke_verify_cli 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$OUT" | grep -q '非零退出'; then
  pass "非 TTY 退出码为 0 时冒烟失败"
else
  fail "非 TTY 退出码分支行为不符（rc=$rc）"
fi

cat >"$SMOKE_BUILD/elysian" <<'STUB'
#!/usr/bin/env bash
if [ "$#" -eq 0 ]; then
  printf '%s\n' '别的错误' >&2
  exit 1
fi
case "$1" in
  --version) printf '版本：deadbeef\n' ;;
esac
STUB
OUT="$(smoke_verify_cli 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$OUT" | grep -q '提示缺失'; then
  pass "非 TTY 提示缺失时冒烟失败"
else
  fail "提示缺失分支行为不符（rc=$rc）"
fi

echo "== 管理通道路径解析 =="
assert_eq "/run/caddy/admin.sock" "$(caddy_admin_socket)" "缺省路径"
GOT="$(ELYSIAN_CADDY_SOCKET=/tmp/custom.sock caddy_admin_socket)"
assert_eq "/tmp/custom.sock" "$GOT" "环境变量覆盖"
DEFAULTS_FILE="$TMPDIR_TEST/default"
printf 'ELYSIAN_CADDY_SOCKET="/custom/sock"\n' >"$DEFAULTS_FILE"
GOT="$(ENV_FILE="$DEFAULTS_FILE" caddy_admin_socket)"
assert_eq "/custom/sock" "$GOT" "EnvironmentFile 覆盖（含引号剥离）"
GOT="$(ENV_FILE="$DEFAULTS_FILE" ELYSIAN_CADDY_SOCKET=/env/wins.sock caddy_admin_socket)"
assert_eq "/env/wins.sock" "$GOT" "环境变量优先于 EnvironmentFile"
if ELYSIAN_CADDY_SOCKET=relative.sock caddy_admin_socket >/dev/null 2>&1; then fail "相对路径应拒绝"; else pass "相对路径明确拒绝"; fi
assert_eq '/var/run/docker.sock' "$(ELYSIAN_DOCKER_SOCKET= ENV_FILE="$TMPDIR_TEST/absent" docker_engine_socket)" "Docker 缺省本机通道"
printf 'ELYSIAN_DOCKER_SOCKET="/custom/docker.sock"\n' >"$DEFAULTS_FILE"
assert_eq '/custom/docker.sock' "$(ELYSIAN_DOCKER_SOCKET= ENV_FILE="$DEFAULTS_FILE" docker_engine_socket)" "Docker 读取 EnvironmentFile 覆盖"
assert_eq '/override/docker.sock' "$(ELYSIAN_DOCKER_SOCKET=/override/docker.sock ENV_FILE="$DEFAULTS_FILE" docker_engine_socket)" "Docker 显式环境覆盖优先"
if ELYSIAN_DOCKER_SOCKET=tcp://remote:2375 docker_engine_socket >/dev/null 2>&1; then fail "Docker 远端地址误通过"; else pass "Docker 通道拒绝远端地址"; fi

echo "== HTTPS 规则摘要 =="
printf 'IPV6=yes\n' >"$TMPDIR_TEST/ufw-defaults"
UFW_DEFAULTS_FILE="$TMPDIR_TEST/ufw-defaults"
OUT="$(ufw_port_summary "$(printf '80/tcp ALLOW Anywhere\n80/tcp (v6) ALLOW Anywhere (v6)\n')" 80)"
case "$OUT" in *'IPv4 已放行、IPv6 已放行'*) pass "仅80不误报443" ;; *) fail "单端口摘要错误：$OUT" ;; esac
OUT="$(ufw_port_summary "$(printf '443/tcp ALLOW Anywhere\n443/tcp (v6) ALLOW Anywhere (v6)\n')" 443)"
case "$OUT" in *'IPv4 已放行、IPv6 已放行'*) pass "仅443不误报80" ;; *) fail "单端口摘要错误：$OUT" ;; esac
OUT="$(ufw_port_summary '80,443/tcp ALLOW Anywhere' 80)"
case "$OUT" in *'IPv4 已放行、IPv6 未确认公开放行'*) pass "IPv4放行不误报IPv6" ;; *) fail "IPv6缺失摘要错误：$OUT" ;; esac
OUT="$(ufw_port_summary '443/tcp ALLOW 10.0.0.1' 443)"
case "$OUT" in *'IPv4 未确认公开放行'*) pass "受限来源不误报公开放行" ;; *) fail "受限来源摘要错误：$OUT" ;; esac
OUT="$(ufw_port_summary "$(printf '80,443/tcp ALLOW Anywhere\n80,443/tcp (v6) ALLOW Anywhere (v6)\n')" 443)"
case "$OUT" in *'IPv4 已放行、IPv6 已放行'*) pass "组合规则分别核对IPv4和IPv6" ;; *) fail "组合规则摘要错误：$OUT" ;; esac

echo "== 安装摘要不输出内网 IP =="
if (
  set -e
  init_output 0 0
  TMP_UFW="$(mktemp)"
  trap 'rm -f "$TMP_UFW"' EXIT
  printf 'IPV6=yes\n' >"$TMP_UFW"
  UFW_DEFAULTS_FILE="$TMP_UFW"
  BUILD_COMMIT=b3bf628
  FRONTEND_PORT=48100
  PANEL_PORT=48101
  STATE_DIR=/var/lib/elysian
  PANEL_BIN=/usr/local/bin/elysian
  CLI_BIN=/usr/local/bin/ely
  GOPROXY='https://goproxy.cn|direct'
  BUN_CONFIG_REGISTRY='https://registry.npmmirror.com'
  CADDY_ADMIN_SOCKET=/run/caddy/admin.sock
  SSH_PORTS=22
  STAGE_STARTED_AT=$SECONDS
  STAGE_FINISHED=0
  hostname() { echo "172.17.47.162"; }
  systemctl() { case "$1" in is-active|is-enabled) echo active ;; esac; }
  docker() { echo "Docker version 29.9.2, build abc"; }
  caddy() { echo "v2.11.7 h1:abc"; }
  ufw() { printf 'Status: active\n'; }
  out="$(print_summary)"
  printf '%s' "$out" | grep -q '面板端口' &&
    printf '%s' "$out" | grep -q '48100' &&
    printf '%s' "$out" | grep -Fq 'http://<服务器公网 IP 或域名>:48100' &&
    printf '%s' "$out" | grep -Fq 'sudo /usr/local/bin/ely（菜单内「重置密码」）' &&
    printf '%s' "$out" | grep -Fq 'HOME=/var/lib/elysian /usr/local/bin/elysian resetpwd' &&
    printf '%s' "$out" | grep -Fq 'ely — 服务器本地终端（Agent 终端／重置密码），任意目录可用' &&
    ! printf '%s' "$out" | grep -Eq '(^|[^0-9])(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)'
); then pass "摘要只报端口且不含 RFC1918 地址"; else fail "摘要仍输出内网 IP 或缺少端口"; fi

echo "== 长命令日志出口（非 TTY 路径） =="
LOG="$TMPDIR_TEST/run.log"
SPINNER_ENABLED=0
run_stage_command "测试命令" "$LOG" sh -c 'echo hello'; rc=$?
assert_rc 0 "$rc" "成功命令返回 0"
if grep -q hello "$LOG"; then pass "stdout 收进日志"; else fail "stdout 未收进日志"; fi
run_stage_command "测试命令" "$LOG" sh -c 'echo boom >&2; exit 3'; rc=$?
assert_rc 3 "$rc" "失败命令透传退出码"
assert_eq 3 "$RUN_STAGE_EXIT_CODE" "失败摘要保留真实退出码"
assert_eq '退出码 3' "$(stage_failure_reason)" "失败原因显示实际退出码"
if run_stage_command "被信号终止" "$LOG" sh -c 'kill -KILL $$'; then fail "信号终止误报成功"; else
  assert_eq 137 "$RUN_STAGE_EXIT_CODE" "信号终止保留退出码"
  assert_eq '退出码 137（信号 SIGKILL）' "$(stage_failure_reason)" "失败原因显示终止信号"
fi
if grep -q boom "$LOG"; then pass "stderr 收进日志"; else fail "stderr 未收进日志"; fi
SPINNER_ENABLED=0

echo "== 已装依赖的复用短路（函数桩模拟 docker / caddy / systemctl，不写系统） =="
docker() {
  if [ "${1:-}" = --host ]; then shift 2; fi
  case "$1" in
    info) return 0 ;;
    --version) echo "Docker version 26.1.4, build stub" ;;
    version) echo "1.44" ;;   # docker version --format '{{.Server.APIVersion}}'
  esac
}
caddy() { echo "v2.8.4"; }
systemctl() {
  case "$1 $2" in
    "enable --now"|'enable '*|'is-active '*|daemon-reload|restart*|start*) return 0 ;;
  esac
  return 0
}
OUT="$(docker_install_or_reuse)"; rc=$?
assert_rc 0 "$rc" "Docker 复用分支返回成功"
if printf '%s' "$OUT" | grep -q '复用现有安装'; then pass "Docker 复用分支输出「复用现有安装」"; else fail "Docker 复用分支缺少复用提示"; fi
DOCKER_INSTALLED_THIS_RUN=1
docker_install_or_reuse >/dev/null
assert_eq 0 "$DOCKER_INSTALLED_THIS_RUN" "既有 Docker 不进入新装自启分支"
if enable_docker >/dev/null; then pass "enable_docker（stub active）通过"; else fail "enable_docker 异常"; fi
if OUT="$(verify_docker)" && printf '%s' "$OUT" | grep -q 'Engine API 1.44'; then
  pass "verify_docker 实测 API 版本 1.44（≥ 1.41）"
else
  fail "verify_docker 未输出实测 Engine API"
fi
docker() { printf '%s|%s|%s|%s\n' "${DOCKER_HOST:-}" "${DOCKER_CONTEXT:-}" "${DOCKER_TLS_VERIFY:-}" "$*"; }
assert_eq '|||--host unix:///custom/docker.sock info' "$(DOCKER_ENGINE_SOCKET=/custom/docker.sock DOCKER_HOST=tcp://remote:2375 DOCKER_CONTEXT=remote DOCKER_TLS_VERIFY=1 docker_engine info)" "Docker 固定本机目标并忽略远端 context 与 TLS 环境"
OUT="$(install_caddy)"; rc=$?
assert_rc 0 "$rc" "Caddy 复用分支返回成功"
install_caddy >/dev/null   # 不经命令替换，让标记落在当前 shell
assert_eq 0 "${CADDY_INSTALLED_THIS_RUN:-1}" "复用时不标记新装（UFW 80/443 不声明）"
if printf '%s' "$OUT" | grep -q '复用现有安装'; then pass "Caddy 复用分支输出「复用现有安装」"; else fail "Caddy 复用分支缺少复用提示"; fi
# docker 已装但守护进程不响应：拉起失败必须 die（不在既有安装上重装）
docker() {
  if [ "${1:-}" = --host ]; then shift 2; fi
  case "$1" in
    info) return 1 ;;
    --version) echo "Docker version 20.10.0, build broken" ;;
  esac
  return 1
}
systemctl() { return 1; }
if OUT="$(docker_install_or_reuse 2>&1)"; rc=$?; [ "$rc" -ne 0 ] && printf '%s' "$OUT" | grep -q '不会在其上重装'; then
  pass "守护进程无响应时中文报错且拒绝重装（非零退出）"
else
  fail "守护进程无响应分支行为不符（rc=$rc）"
fi
unset -f docker caddy systemctl

if platform_helper socket '/run/caddy:admin/api.sock' >/dev/null 2>&1; then fail "socket 冒号路径误通过"; else pass "拒绝 systemd RuntimeDirectory 有歧义的冒号路径"; fi

rm -rf "$TMPDIR_TEST"
printf '\n结果：%d 通过，%d 失败\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
