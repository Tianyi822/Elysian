#!/usr/bin/env bash
# 使用 gh 命令桩验证发布边界，不访问 GitHub。
set -euo pipefail
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
export RELEASE_PUBLISH_FIXTURE="$test_root"
export RELEASE_PUBLISH_MODE=success
mkdir -p "$test_root/assets" "$test_root/state"
for arch in amd64 arm64; do
  printf 'fixture-%s' "$arch" >"$test_root/assets/elysian-linux-$arch.tar.gz"
  (cd "$test_root/assets" && sha256sum "elysian-linux-$arch.tar.gz" >"elysian-linux-$arch.tar.gz.sha256")
done
gh() {
  local tag="$3" state="$RELEASE_PUBLISH_FIXTURE/state/$3"
  printf '%s\n' "$*" >>"$RELEASE_PUBLISH_FIXTURE/calls"
  case "$2" in
    view)
      [ -f "$state" ] || return 1
      if [ "$5" = isDraft ]; then cat "$state"; else
        printf '%s\n' elysian-linux-amd64.tar.gz elysian-linux-amd64.tar.gz.sha256
        if [ "$RELEASE_PUBLISH_MODE" != incomplete ]; then
          printf '%s\n' elysian-linux-arm64.tar.gz elysian-linux-arm64.tar.gz.sha256
        fi
      fi ;;
    create) printf true >"$state" ;;
    upload) [ "$RELEASE_PUBLISH_MODE" != upload-failure ] ;;
    edit) printf false >"$state" ;;
    *) return 1 ;;
  esac
}
export -f gh
commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
bash scripts/publish-release.sh "$test_root/assets" "$commit" v1-test >/dev/null
[ "$(cat "$test_root/state/build-$commit")" = false ]
[ "$(cat "$test_root/state/v1-test")" = false ]
[ "$(grep -c '^release upload ' "$test_root/calls")" = 2 ]
bash scripts/publish-release.sh "$test_root/assets" "$commit" v1-test >/dev/null
[ "$(grep -c '^release upload ' "$test_root/calls")" = 2 ]
RELEASE_PUBLISH_MODE=upload-failure
if bash scripts/publish-release.sh "$test_root/assets" bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb '' >/dev/null 2>&1; then exit 1; fi
[ "$(cat "$test_root/state/build-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")" = true ]
RELEASE_PUBLISH_MODE=incomplete
if bash scripts/publish-release.sh "$test_root/assets" "$commit" '' >/dev/null 2>&1; then exit 1; fi
[ "$(grep -c '^release upload ' "$test_root/calls")" = 3 ]
printf '发布事务：首次双架构发布、精确重跑、上传失败保留草稿、已发布缺失拒绝覆盖，全部通过\n'
