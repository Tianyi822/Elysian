#!/usr/bin/env bash
# 安装缓存目录的真实文件系统测试；所有落点都在临时目录。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/install.sh"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
BUILD_HOME="$fixture/build-home"
test_uid="$(command id -u)"
test_gid="$(command id -g)"
if [ "$test_uid" = 0 ]; then test_uid=1001; test_gid=1001; fi
id() {
  case "$*" in
    '-u elysian-build') printf '%s\n' "$test_uid" ;;
    '-g elysian-build') printf '%s\n' "$test_gid" ;;
    *) command id "$@" ;;
  esac
}
prepare_build_cache >"$fixture/first.log"
[ "$BUILD_CACHE_INITIALIZED" = 1 ]
[ "$(build_cache_stat "$BUILD_HOME")" = "$(command id -u):$(command id -g):755" ]
for leaf in bun go-mod go-build; do
  [ "$(build_cache_stat "$BUILD_HOME/cache/$leaf")" = "$test_uid:$test_gid:700" ]
done
printf '已下载' >"$BUILD_HOME/cache/go-mod/sentinel"
chmod 400 "$BUILD_HOME/cache/go-mod/sentinel"
prepare_build_cache >"$fixture/second.log"
[ "$BUILD_CACHE_INITIALIZED" = 0 ]
[ "$(cat "$BUILD_HOME/cache/go-mod/sentinel")" = 已下载 ]
if grep -q '已初始化' "$fixture/second.log"; then echo '错误：已有缓存被重复初始化' >&2; exit 1; fi
printf '✓ 首次初始化、归属权限及缓存复用\n'
chmod 777 "$BUILD_HOME/cache/bun"
if prepare_build_cache >"$fixture/error.log" 2>&1; then echo '错误：开放写入权限未被拒绝' >&2; exit 1; fi
[ "$(build_cache_stat "$BUILD_HOME/cache/bun")" = "$test_uid:$test_gid:777" ]
chmod 700 "$BUILD_HOME/cache/bun"
if [ "$(command id -u)" = 0 ]; then
  chown 12345:12345 "$BUILD_HOME/cache/bun"
  if prepare_build_cache >"$fixture/error.log" 2>&1; then echo '错误：异常归属未被拒绝' >&2; exit 1; fi
  [ "$(build_cache_stat "$BUILD_HOME/cache/bun")" = 12345:12345:700 ]
  chown "$test_uid:$test_gid" "$BUILD_HOME/cache/bun"
fi
for target in "$BUILD_HOME/cache/bun" "$BUILD_HOME/cache" "$BUILD_HOME"; do
  saved="$fixture/saved"
  mv "$target" "$saved"
  ln -s "$saved" "$target"
  if prepare_build_cache >"$fixture/error.log" 2>&1; then echo "错误：符号链接未被拒绝：$target" >&2; exit 1; fi
  rm "$target"
  mv "$saved" "$target"
done
rmdir "$BUILD_HOME/cache/bun"
printf '不是目录' >"$BUILD_HOME/cache/bun"
if prepare_build_cache >"$fixture/error.log" 2>&1; then echo '错误：普通文件未被拒绝' >&2; exit 1; fi
printf '✓ 权限、归属、符号链接及非目录反例均拒绝，原内容保持\n'
