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
GO_DEV_DIR="$ROOT/apps/server-go"

die() { echo "dev.sh: $1" >&2; exit 1; }

docker info >/dev/null 2>&1 || die "Docker daemon 未就绪，请先启动 Docker Desktop（或宿主 dockerd）再重试。"

ENVARGS=()
if [ -f "$ROOT/.env" ]; then
  ENVARGS=(--env-file "$ROOT/.env")
fi

case "${1:-}" in
  up)
    cd "$ROOT"
    docker compose "${ENVARGS[@]}" up -d --build
    cd "$GO_DEV_DIR"
    docker compose "${ENVARGS[@]}" up -d --build
    echo
    echo "开发环境已就绪："
    echo "  面板    http://127.0.0.1:48100"
    echo "  Go API  http://127.0.0.1:48102（容器内 48101，e2e 与门禁用）"
    if [ "${ELYSIAN_AUTH_DEV:-0}" != "1" ]; then
      echo "  本次未显式开启开发账号：go 容器重建后 dev / dev-elysian 将不可登录，需要时执行 ELYSIAN_AUTH_DEV=1 bash scripts/dev.sh restart-go。"
    fi
    ;;
  down)
    cd "$GO_DEV_DIR"
    docker compose "${ENVARGS[@]}" down
    cd "$ROOT"
    docker compose "${ENVARGS[@]}" down
    ;;
  restart-go)
    cd "$GO_DEV_DIR"
    docker compose "${ENVARGS[@]}" up -d --force-recreate go
    ;;
  *)
    die "用法：bash scripts/dev.sh up | down | restart-go"
    ;;
esac
