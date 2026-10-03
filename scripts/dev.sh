#!/usr/bin/env bash
# Elysian 本机开发启动器：把 web 与 go 两个 compose project 收敛成一条命令。
# 栈顺序有讲究：web 栈先起（它创建 elysian-db-local / elysian-db-shared 两张共享网，
# go 栈把它们声明为 external）；停则反序，先 go 后 web。
#
# 用法：
#   bash scripts/dev.sh up          起两个栈（始终 --build，Dockerfile 变更无需单独记）
#   bash scripts/dev.sh down        停两个栈（数据卷保留）
#   bash scripts/dev.sh restart-go  重建 go 容器，使 Go 代码与环境变量变更生效（首次请先 up）
#
# 开发账号 dev / dev-elysian 需显式开启：ELYSIAN_AUTH_DEV=1 bash scripts/dev.sh up
# （缺省恒关）。ELYSIAN_DOCKER_MOUNT_ROOT 等其余变量经仓库根 .env 透传给两个栈，
# shell 环境变量优先于 .env；Linux 无 .env 时按 compose 缺省 /srv。
set -eo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

die() { echo "dev.sh: $1" >&2; exit 1; }

docker info >/dev/null 2>&1 || die "Docker daemon 未就绪，请先启动 Docker Desktop（或宿主 dockerd）再重试。"

ENVARGS=()
if [ -f "$ROOT/.env" ]; then
  ENVARGS=(--env-file "$ROOT/.env")
fi

web_compose() { docker compose "${ENVARGS[@]}" -f "$ROOT/docker-compose.yml" "$@"; }
go_compose() { docker compose "${ENVARGS[@]}" -p elysian-go-dev -f "$ROOT/apps/server-go/docker-compose.go-dev.yml" "$@"; }

# 容器 Up 仅说明入口进程运行，Go 仍可能在下载模块或编译。
# 从 web 容器探测同源 API，把 Vite、共享网络和 Go 后端一起纳入就绪判断。
wait_ready() {
  local deadline=$((SECONDS + 180))
  echo "等待前端与 Go API 就绪（首次编译可能需要几分钟）…"
  until web_compose exec -T web curl -fsS --max-time 2 http://127.0.0.1:48100/api/health 2>/dev/null | grep -q '"ok":true'; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      web_compose logs --tail 20 web >&2 || true
      go_compose logs --tail 20 go >&2 || true
      die "前端或 Go API 在 180 秒内未就绪，请检查上述容器日志后重试。"
    fi
    sleep 1
  done
}

case "${1:-}" in
  up)
    web_compose up -d --build
    go_compose up -d --build
    wait_ready
    echo
    echo "开发环境已就绪："
    echo "  面板    http://127.0.0.1:48100"
    echo "  Go API  http://127.0.0.1:48102（容器内 48101，e2e 与门禁用）"
    if [ "${ELYSIAN_AUTH_DEV:-0}" != "1" ]; then
      echo "  本次未显式开启开发账号：go 容器重建后 dev / dev-elysian 将不可登录，需要时执行 ELYSIAN_AUTH_DEV=1 bash scripts/dev.sh restart-go。"
    fi
    ;;
  down)
    go_compose down
    web_compose down
    ;;
  restart-go)
    go_compose up -d --force-recreate go
    wait_ready
    echo "Go API 已重启，面板入口 http://127.0.0.1:48100"
    ;;
  *)
    die "用法：bash scripts/dev.sh up | down | restart-go"
    ;;
esac
