#!/usr/bin/env bash
# apps/server-go/dev-check.sh —— Go 侧门禁脚本（go-plan §7 契约）。
# 一切 Go 侧检查（gofmt/vet/build/test）只在 elysian-go-dev 容器内执行，宿主机不得
# 直跑 go 命令。用法：bash apps/server-go/dev-check.sh [目标...]（缺省 ./...）。
# 域实现者口径：bash apps/server-go/dev-check.sh ./internal/<域> ./internal/app
# （必须连带 ./internal/app，让每轮交付都编译装配层并跑跨域 import 守卫测试）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/apps/server-go/docker-compose.go-dev.yml"
PROJECT=elysian-go-dev

cd "$REPO_ROOT"

# 绑定挂载根缺省回落：macOS Docker Desktop 不共享 /srv，未显式设置时回落到仓库根
#（compose 的 ../..:/app 绑定已要求仓库根位于共享路径，故此缺省在能跑门禁的环境必然
# 可用，否则 mounts denied）。真实联调（compose up 起服务）仍建议按总纲 §6.2 显式设
# ELYSIAN_DOCKER_MOUNT_ROOT 指向专用共享目录，与现有栈同法。
export ELYSIAN_DOCKER_MOUNT_ROOT="${ELYSIAN_DOCKER_MOUNT_ROOT:-$REPO_ROOT}"

fail() {
  echo "门禁失败：$*" >&2
  exit 1
}

# 1. 解析目标列表（缺省 ./...），只作用于给定目标。
if [ "$#" -eq 0 ]; then
  set -- ./...
fi

# 2. 幂等确保外部网络存在（database 域真实联调需要；现有栈已建则直接复用）。
echo "==> 幂等确保外部网络存在（elysian-db-local / elysian-db-shared）"
for net in elysian-db-local elysian-db-shared; do
  if ! docker network inspect "$net" >/dev/null 2>&1; then
    docker network create "$net" >/dev/null || fail "无法创建外部网络 $net"
  fi
done

# 3. 构建镜像（源码未变时走缓存）。
echo "==> 构建 go-dev 镜像"
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" build go || fail "go-dev 镜像构建失败"

# 4+5. 容器内执行门禁：run 不映射端口、不与运行中的服务冲突；setup 片段先建
# ~/.Elysian 目录与符号链接，再预热模块缓存，随后依次跑四道门禁，任一步失败即
# 非零退出并打印中文失败原因。目标经位置参数传入（$0 占位为 gate）。
echo "==> 容器内执行 gofmt / go vet / go build / go test：$*"
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" run --rm go \
  bash -lc '
    set -euo pipefail
    # 登录 shell 的 /etc/profile 会重置 PATH（丢掉 /usr/local/go/bin 与 /go/bin），
    # 先显式恢复工具链路径再执行门禁。
    export PATH="/usr/local/go/bin:/go/bin:$PATH"
    mkdir -p /var/lib/elysian/data /var/lib/elysian/logs /var/lib/elysian/state \
             /var/lib/elysian/backups /var/lib/elysian/tmp /var/lib/elysian/config
    ln -sfn /var/lib/elysian /root/.Elysian
    cd /app/apps/server-go
    echo "==> 预热模块缓存（go mod download）"
    go mod download

    echo "==> gofmt -l（输出非空即失败）"
    # 目录式扫描天然覆盖 GoFiles/TestGoFiles/XTestGoFiles 全部 .go 文件
    #（逐文件模板 .GoFiles 不含测试文件，会漏检 *_test.go）。
    dirs="$(go list -f "{{.Dir}}" "$@")" || { echo "go list 解析目标失败" >&2; exit 1; }
    unformatted=""
    for dir in $dirs; do
      found="$(gofmt -l "$dir" || true)"
      if [ -n "$found" ]; then
        unformatted="$unformatted$found
"
      fi
    done
    if [ -n "$unformatted" ]; then
      echo "以下文件未通过 gofmt：" >&2
      printf "%s" "$unformatted" >&2
      exit 1
    fi

    echo "==> go vet"
    go vet "$@" || { echo "go vet 未通过" >&2; exit 1; }
    echo "==> go build"
    go build "$@" || { echo "go build 未通过" >&2; exit 1; }
    echo "==> go test"
    go test "$@" || { echo "go test 未通过" >&2; exit 1; }
    echo "全部门禁通过。"
  ' gate "$@"
