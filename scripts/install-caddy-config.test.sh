#!/usr/bin/env bash
# 用真实 Caddy 验证临时文件适配与严格配置比对。正式门禁在一次性 Docker 容器内运行
# （scripts/README-deploy.md）；宿主缺少 caddy 或 bun 时明确 SKIP 并以 0 退出，
# 不伪造任何验证结果。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v caddy >/dev/null 2>&1 || ! command -v bun >/dev/null 2>&1; then
  missing=""
  command -v caddy >/dev/null 2>&1 || missing="caddy"
  command -v bun >/dev/null 2>&1 || missing="${missing:+$missing 与 }bun"
  printf 'SKIP 本测试需要真实 %s；请在一次性容器内运行（见 scripts/README-deploy.md 部署测试节）。\n' "${missing:-caddy 与 bun}"
  exit 0
fi
source "$SCRIPT_DIR/install.sh"
init_output 0 0
FIXTURE="$(mktemp -d /tmp/elysian-caddy-config-test.XXXXXX)"
CADDY_PID=""
cleanup() {
  if [ -n "$CADDY_PID" ]; then
    kill "$CADDY_PID" 2>/dev/null || true
    wait "$CADDY_PID" 2>/dev/null || true
  fi
  rm -rf "$FIXTURE"
}
trap cleanup EXIT
CADDYFILE_PATH="$FIXTURE/Caddyfile"
CADDY_ADMIN_SOCKET="$FIXTURE/admin.sock"

check_candidate() {
  local temporary="$FIXTURE/.elysian-validate.candidate"
  caddy adapt --config "$CADDYFILE_PATH" --adapter caddyfile >"$FIXTURE/original.json" 2>"$FIXTURE/adapt.log"
  prepare_caddy_admin_file "$CADDY_ADMIN_SOCKET" "$CADDYFILE_PATH" "$temporary"
  caddy validate --config "$temporary" --adapter caddyfile >"$FIXTURE/validate.log" 2>&1
  caddy adapt --config "$temporary" --adapter caddyfile >"$FIXTURE/candidate.json" 2>>"$FIXTURE/adapt.log"
  platform_helper connect "$FIXTURE/original.json" "$CADDY_ADMIN_SOCKET" "$FIXTURE/expected.json"
  if platform_helper equal "$FIXTURE/expected.json" "$FIXTURE/candidate.json" 2>/dev/null; then
    printf 'FAIL 未复现 Caddy 自动隐藏配置文件路径的差异\n' >&2
    return 1
  fi
  platform_helper equal-caddyfile "$FIXTURE/expected.json" "$FIXTURE/candidate.json" "$CADDYFILE_PATH" "$temporary"
}

printf ':8080 {\n\troot * /srv\n\tfile_server\n}\n' >"$CADDYFILE_PATH"
check_candidate
printf 'PASS 默认静态站点候选通过真实 Caddy 校验与配置保留核对\n'

mkdir "$FIXTURE/assets" "$FIXTURE/www"
printf 'existing website' >"$FIXTURE/www/index.html"
printf 'existing asset' >"$FIXTURE/assets/check.txt"
printf '{\n\tadmin 127.0.0.1:2019\n}\n:8080 {\n\thandle_path /assets/* {\n\t\troot * %s/assets\n\t\tfile_server {\n\t\t\thide /srv/private *.secret\n\t\t}\n\t}\n\thandle {\n\t\troot * %s/www\n\t\tfile_server\n\t}\n}\n' "$FIXTURE" "$FIXTURE" >"$CADDYFILE_PATH"
check_candidate
printf 'PASS 嵌套路由与多个 file_server 保留显式隐藏规则\n'

bun -e '
  const config = JSON.parse(await Bun.file(process.argv[1]).text())
  function change(value) {
    if (!value || typeof value !== "object") return
    if (value.handler === "file_server") value.hide = value.hide.filter(entry => entry !== "/srv/private")
    for (const entry of Object.values(value)) change(entry)
  }
  change(config)
  await Bun.write(process.argv[2], JSON.stringify(config))
' "$FIXTURE/candidate.json" "$FIXTURE/changed.json"
if platform_helper equal-caddyfile "$FIXTURE/expected.json" "$FIXTURE/changed.json" "$CADDYFILE_PATH" "$FIXTURE/.elysian-validate.candidate" 2>/dev/null; then
  printf 'FAIL 显式隐藏规则丢失必须拒绝\n' >&2
  exit 1
fi
printf 'PASS 拒绝丢失显式隐藏规则\n'

if platform_helper equal "$FIXTURE/expected.json" "$FIXTURE/candidate.json" 2>/dev/null; then
  printf 'FAIL 运行配置比对不得放宽\n' >&2
  exit 1
fi
printf 'PASS 运行配置仍按完整 JSON 严格核对\n'

caddy run --config "$CADDYFILE_PATH" --adapter caddyfile >"$FIXTURE/caddy.log" 2>&1 &
CADDY_PID=$!
wait_caddy_api tcp:127.0.0.1:2019 "$FIXTURE/runtime.original.json"
platform_helper connect "$FIXTURE/runtime.original.json" "$CADDY_ADMIN_SOCKET" "$FIXTURE/runtime.candidate.json"
platform_caddy_request tcp:127.0.0.1:2019 POST "$FIXTURE/load-response" "$FIXTURE/runtime.candidate.json"
wait_caddy_api "unix:$CADDY_ADMIN_SOCKET" "$FIXTURE/runtime.actual.json" "$FIXTURE/runtime.candidate.json"
[ "$(curl -fsS --noproxy '*' --max-time 3 http://127.0.0.1:8080/)" = 'existing website' ]
[ "$(curl -fsS --noproxy '*' --max-time 3 http://127.0.0.1:8080/assets/check.txt)" = 'existing asset' ]
printf 'PASS 真实 Caddy 热迁移到 Unix socket 后网站与嵌套路由仍可访问\n'

platform_caddy_request "unix:$CADDY_ADMIN_SOCKET" POST "$FIXTURE/restore-response" "$FIXTURE/runtime.original.json"
wait_caddy_api tcp:127.0.0.1:2019 "$FIXTURE/runtime.restored.json" "$FIXTURE/runtime.original.json"
[ "$(curl -fsS --noproxy '*' --max-time 3 http://127.0.0.1:8080/)" = 'existing website' ]
printf 'PASS 真实 Caddy 原管理端点与完整运行配置可恢复\n'
