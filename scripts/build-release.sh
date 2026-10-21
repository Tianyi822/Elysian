#!/usr/bin/env bash
# 安装器和在线维护共用的构建入口，不安装服务，不修改系统配置。
set -euo pipefail
# Go 模块默认走国内镜像；部署者可用 ELYSIAN_GOPROXY 或已有 GOPROXY 覆盖。
export GOPROXY="${ELYSIAN_GOPROXY:-${GOPROXY:-https://goproxy.cn|https://mirrors.aliyun.com/goproxy/|direct}}"
# Bun 依赖默认走 npmmirror；可用 ELYSIAN_BUN_REGISTRY 或已有 BUN_CONFIG_REGISTRY 覆盖。
export BUN_CONFIG_REGISTRY="${ELYSIAN_BUN_REGISTRY:-${BUN_CONFIG_REGISTRY:-https://registry.npmmirror.com}}"
[ "$#" -eq 3 ] || { echo '用法：build-release.sh <源码目录> <产物目录> <提交标识>' >&2; exit 1; }
SOURCE_DIR="$1"
OUTPUT_DIR="$2"
BUILD_COMMIT="$3"
[ -f "$SOURCE_DIR/package.json" ] && [ -f "$SOURCE_DIR/bun.lock" ] && [ -f "$SOURCE_DIR/apps/server-go/go.mod" ] || { echo '源码缺少构建文件或锁文件' >&2; exit 1; }
mkdir -p "$OUTPUT_DIR"
cd "$SOURCE_DIR"
bun install --frozen-lockfile --registry="$BUN_CONFIG_REGISTRY"
ELYSIAN_DOCKER=1 bun run build
[ -f apps/web/dist/index.html ] || { echo '前端产物缺少 index.html' >&2; exit 1; }
rm -rf apps/server-go/web/dist
mkdir -p apps/server-go/web/dist
cp -a apps/web/dist/. apps/server-go/web/dist/
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cd apps/server-go
CGO_ENABLED=0 go build -mod=readonly -buildvcs=false -ldflags="-s -w -X elysian/server/internal/panel.Commit=${BUILD_COMMIT} -X elysian/server/internal/panel.BuildTime=${BUILD_TIME}" -o "$OUTPUT_DIR/elysian" ./cmd/elysian
