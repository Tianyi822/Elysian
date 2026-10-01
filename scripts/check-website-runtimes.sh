#!/usr/bin/env bash
# scripts/check-website-runtimes.sh —— 运行时版本目录在线诊断（原 TS 脚本的 Go 对等）。
# 走生产同一条路径抓一次官方源并打印各类型的正式版本数；不生成或维护固定版本文件。
# 宿主机不需要 Go 工具链：诊断在 go-dev 容器内执行（Go 侧一律容器内跑的既有约定），
# compose run 起一次性容器，不打扰正在运行的 go-dev 服务。
#
# 用法：bun run check:website-runtimes（或 bash scripts/check-website-runtimes.sh）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/apps/server-go/docker-compose.go-dev.yml"

command -v docker >/dev/null 2>&1 || { echo "未找到 docker 命令。本诊断在 go-dev 容器内执行，请先启动 Docker。" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker 守护进程不可用，请启动 Docker 后重试。" >&2; exit 1; }

echo "==> 在 go-dev 容器内核对官方发布记录与 Docker 官方镜像库（首次需构建镜像，可能较慢）"
exec docker compose -f "$COMPOSE_FILE" run --rm go go run ./cmd/websiteruntimecheck
