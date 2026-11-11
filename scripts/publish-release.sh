#!/usr/bin/env bash
# 只有全部架构上传成功才发布；已发布的固定提交安装包不可覆盖。
set -euo pipefail
[ "$#" = 3 ] || exit 1
output="$1"; commit="$2"; version_tag="$3"
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] || exit 1
(cd "$output" && sha256sum -c ./*.sha256)
publish() {
  local tag="$1" prerelease="$2" state
  if state="$(gh release view "$tag" --json isDraft --jq .isDraft 2>/dev/null)"; then
    if [ "$state" = false ]; then
      # 重跑不能修改已发布产物；同时确认首次发布确实完整。
      gh release view "$tag" --json assets --jq '.assets[].name' >"$output/existing-assets"
      for arch in amd64 arm64; do
        grep -Fxq "elysian-linux-$arch.tar.gz" "$output/existing-assets" || { echo '已发布版本缺少架构产物，拒绝覆盖' >&2; return 1; }
        grep -Fxq "elysian-linux-$arch.tar.gz.sha256" "$output/existing-assets" || { echo '已发布版本缺少 SHA256 文件，拒绝覆盖' >&2; return 1; }
      done
      return 0
    fi
  else
    gh release create "$tag" --target "$commit" --title "${tag}" --notes "Linux amd64 / arm64 预编译安装包，内嵌 Web 与 CLI。提交：${commit}" --draft --prerelease="$prerelease" --latest=false
  fi
  gh release upload "$tag" "$output"/*.tar.gz "$output"/*.sha256 --clobber
  if [ "$prerelease" = true ]; then
    gh release edit "$tag" --draft=false --prerelease --latest=false
  else
    gh release edit "$tag" --draft=false --prerelease=false --latest
  fi
}
publish "build-$commit" true
if [ -n "$version_tag" ]; then publish "$version_tag" false; fi
