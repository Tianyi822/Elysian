#!/usr/bin/env bash
# Runs in Gitee Go's Ubuntu GCC build environment, not on an installed panel host.
set -euo pipefail
[ "$(uname -s)/$(uname -m)" = Linux/x86_64 ] || { echo 'Gitee 构建需要 Linux x64 执行环境' >&2; exit 1; }
: "${ELYSIAN_GITEE_TOKEN:?请在流水线安全设置中注入 ELYSIAN_GITEE_TOKEN，不要写入 YAML}"
: "${GITEE_COMMIT:?缺少 Gitee 触发提交}"
: "${GITEE_BRANCH:?缺少 Gitee 触发标签}"
commit="$(git rev-parse HEAD)"
tag="${GITEE_BRANCH#refs/tags/}"
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] && [ "$commit" = "$GITEE_COMMIT" ] || { echo '源码与触发提交不符' >&2; exit 1; }
[[ "$tag" == v* ]] && git check-ref-format "refs/tags/$tag" || { echo '仅允许 v* 标签发布' >&2; exit 1; }
if ! git rev-parse --verify "refs/tags/$tag^{commit}" >/dev/null 2>&1; then
  git fetch --no-tags https://gitee.com/Chentyit/Elysian.git "refs/tags/$tag:refs/tags/$tag"
fi
[ "$(git rev-parse "refs/tags/$tag^{commit}")" = "$commit" ] || { echo '发版标签与完整提交不符' >&2; exit 1; }
source_dir="$PWD"
tools_dir="$(mktemp -d /tmp/elysian-ci-tools.XXXXXX)"
trap 'rm -rf "$tools_dir"' EXIT
if [ "$(id -u)" = 0 ]; then ci_root=(); else ci_root=(sudo); fi
"${ci_root[@]}" apt-get update -qq
"${ci_root[@]}" apt-get install -y --no-install-recommends ca-certificates curl unzip python3 jq qemu-user-static
fetch_checked() {
  local url="$1" file="$2" digest="$3"
  curl --proto '=https' --proto-redir '=https' -fsSL --connect-timeout 15 --max-time 300 "$url" -o "$file"
  printf '%s  %s\n' "$digest" "$file" | sha256sum -c -
}
# Digests are pinned to the official Go index and Bun release, shared with install.sh.
fetch_checked https://golang.google.cn/dl/go1.23.12.linux-amd64.tar.gz "$tools_dir/go.tar.gz" d3847fef834e9db11bf64e3fb34db9c04db14e068eeb064f49af747010454f90
tar -xzf "$tools_dir/go.tar.gz" -C "$tools_dir"
fetch_checked https://registry.npmmirror.com/-/binary/bun/bun-v1.4.2/bun-linux-x64.zip "$tools_dir/bun.zip" 36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913
unzip -q "$tools_dir/bun.zip" -d "$tools_dir"
export PATH="$tools_dir/go/bin:$tools_dir/bun-linux-x64:$PATH"
export ELYSIAN_GOPROXY='https://goproxy.cn|https://mirrors.aliyun.com/goproxy/|direct'
export ELYSIAN_BUN_REGISTRY=https://registry.npmmirror.com
export GOTOOLCHAIN=local
output="$source_dir/out/gitee-release"
mkdir -p "$output"
(cd apps/server-go && go test ./internal/platformhelper ./internal/panel ./internal/cli/...)
python3 -B scripts/release-download.test.py
python3 -B scripts/publish-gitee.test.py
for arch in amd64 arm64; do
  GOOS=linux GOARCH="$arch" bash scripts/build-release.sh "$source_dir" "$output/$arch" "$commit"
  bun scripts/package-release.mjs "$source_dir" "$output/$arch" "$commit" "$arch"
  if [ "$arch" = amd64 ]; then
    bash scripts/test-release-package.sh "$output/$arch/elysian-linux-$arch"
  else
    # Both binaries are static Go ELF; QEMU needs no ARM libc or privileged binfmt.
    python3 scripts/release-download.py verify "$output/$arch/elysian-linux-$arch" "$arch" "$commit"
    [ "$(qemu-aarch64-static "$output/$arch/elysian" release-info | jq -r .commit)" = "$commit" ]
    [ "$(qemu-aarch64-static "$output/$arch/platform-helper" socket /run/caddy/admin.sock)" = /run/caddy/admin.sock ]
  fi
  cp "$output/$arch/elysian-linux-$arch.tar.gz" "$output/$arch/elysian-linux-$arch.tar.gz.sha256" "$output/"
done
python3 -B scripts/publish-gitee.py "$output" "$commit" "$tag"
