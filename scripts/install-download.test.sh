#!/usr/bin/env bash
# 仅在一次性 Docker 容器内运行；以真实低速 HTTP 响应验证 Bun 下载回退。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/install.sh"
init_output 0 0
FIXTURE="$(mktemp -d /tmp/elysian-download-test.XXXXXX)"
FIXTURE_PID=""
cleanup() {
  if [ -n "$FIXTURE_PID" ]; then
    kill "$FIXTURE_PID" 2>/dev/null || true
    wait "$FIXTURE_PID" 2>/dev/null || true
  fi
  rm -rf "$FIXTURE"
}
trap cleanup EXIT
bun "$SCRIPT_DIR/test-download-server.mjs" "$FIXTURE" >"$FIXTURE/server.log" 2>&1 &
FIXTURE_PID=$!
for ((attempt=0; attempt<100; attempt++)); do
  [ ! -f "$FIXTURE/url" ] || break
  sleep 0.02
done
[ -f "$FIXTURE/url" ] || { cat "$FIXTURE/server.log" >&2; exit 1; }
BASE_URL="$(cat "$FIXTURE/url")"
export NO_PROXY='*' no_proxy='*'

started=$SECONDS
fetch_bun_file "$FIXTURE/package.zip" "$BASE_URL/slow" "$BASE_URL/fast" >"$FIXTURE/slow.log" 2>&1
elapsed=$((SECONDS - started))
[ "$elapsed" -ge 14 ] && [ "$elapsed" -le 25 ]
cmp -s "$FIXTURE/package.zip" "$FIXTURE/expected.bin"
[ "$(cat "$FIXTURE/requests")" = "$(printf '/slow\n/fast\n')" ]
grep -q '下载过慢或超时' "$FIXTURE/slow.log"
printf 'PASS 持续低速时切换镜像，不重复等待或拼接残留文件（%s 秒）\n' "$elapsed"

: >"$FIXTURE/requests"
fetch_bun_file "$FIXTURE/package.zip" "$BASE_URL/fast" "$BASE_URL/unused" >"$FIXTURE/fast.log" 2>&1
[ "$(cat "$FIXTURE/requests")" = '/fast' ]
cmp -s "$FIXTURE/package.zip" "$FIXTURE/expected.bin"
printf 'PASS 快速下载不访问备用镜像\n'

: >"$FIXTURE/requests"
fetch_bun_file "$FIXTURE/package.zip" "$BASE_URL/error" "$BASE_URL/fast" >"$FIXTURE/error.log" 2>&1
[ "$(cat "$FIXTURE/requests")" = "$(printf '/error\n/fast\n')" ]
cmp -s "$FIXTURE/package.zip" "$FIXTURE/expected.bin"
printf 'PASS HTTP 错误直接切换镜像，不重试同一源\n'

if fetch_bun_file "$FIXTURE/package.zip" "$BASE_URL/error" "$BASE_URL/also-error" >"$FIXTURE/all-failed.log" 2>&1; then exit 1; fi
[ ! -e "$FIXTURE/package.zip" ]
printf 'PASS 所有源失败时清除残留并返回失败\n'

started=$SECONDS
if try_fetch "$BASE_URL/metadata-hang" "$FIXTURE/metadata.json" bun-metadata >"$FIXTURE/metadata.log" 2>&1; then exit 1; else rc=$?; fi
elapsed=$((SECONDS - started))
[ "$rc" = 28 ] && [ "$elapsed" -le 14 ]
printf 'PASS GitHub 元数据挂起时在预算内退出（%s 秒）\n' "$elapsed"

(
  curl() { printf '%s\n' "$*" >>"$FIXTURE/connection.calls"; [ -f "$FIXTURE/connected" ] && return 0; : >"$FIXTURE/connected"; return 7; }
  try_fetch https://fixture.invalid/package "$FIXTURE/retry.zip" bun-package
  [ "$(wc -l <"$FIXTURE/connection.calls")" = 2 ]
  tail -n 1 "$FIXTURE/connection.calls" | grep -q -- '^-4 '
  grep -q -- '--max-time 600 --speed-limit 102400 --speed-time 15' "$FIXTURE/connection.calls"
)
printf 'PASS 连接故障保留一次 IPv4 回退及安装包时间限制\n'

(
  curl() { printf '%s\n' "$*" >>"$FIXTURE/metadata.calls"; return 7; }
  if try_fetch https://fixture.invalid/metadata "$FIXTURE/metadata.json" bun-metadata; then exit 1; else rc=$?; fi
  [ "$rc" = 7 ] && [ "$(wc -l <"$FIXTURE/metadata.calls")" = 1 ]
  grep -q -- '--connect-timeout 5 --max-time 10' "$FIXTURE/metadata.calls"
)
printf 'PASS 元数据连接失败不重复请求，不放大十秒预算\n'

(
  curl() { printf '%s\n' "$*" >>"$FIXTURE/default.calls"; [ -f "$FIXTURE/default-connected" ] && return 0; : >"$FIXTURE/default-connected"; return 7; }
  try_fetch https://fixture.invalid/default "$FIXTURE/default.bin"
  [ "$(wc -l <"$FIXTURE/default.calls")" = 2 ]
  grep -q -- '--retry 3 --retry-delay 2 --connect-timeout 20' "$FIXTURE/default.calls"
)
printf 'PASS Go 等其他下载保持既有重试策略\n'

(
  BUN_ARCH=x64
  BUN_SHA256_X64="$(sha256sum "$FIXTURE/expected.bin" | awk '{print $1}')"
  bun() { echo 1.0.0; }
  try_fetch() { [ "$3" = bun-metadata ] || return 1; return 28; }
  fetch_bun_file() { cp "$FIXTURE/expected.bin" "$1"; }
  unzip() { :; }
  install() { : >"$FIXTURE/installed"; }
  install_bun >"$FIXTURE/fallback.log" 2>&1
  [ -f "$FIXTURE/installed" ]
  grep -q '固定的 bun' "$FIXTURE/fallback.log"
)
printf 'PASS 元数据超时后使用固定摘要继续安装\n'

(
  BUN_ARCH=x64
  BUN_SHA256_X64="$(sha256sum "$FIXTURE/expected.bin" | awk '{print $1}')"
  bun() { echo 1.0.0; }
  try_fetch() { return 28; }
  fetch_bun_file() { printf 'invalid package' >"$1"; }
  unzip() { : >"$FIXTURE/unpacked-invalid"; }
  install() { : >"$FIXTURE/installed-invalid"; }
  if (install_bun >"$FIXTURE/checksum.log" 2>&1); then exit 1; fi
  [ ! -e "$FIXTURE/unpacked-invalid" ] && [ ! -e "$FIXTURE/installed-invalid" ]
  grep -q 'sha256 校验失败' "$FIXTURE/checksum.log"
)
printf 'PASS 镜像安装包摘要不符时禁止解压和安装\n'
