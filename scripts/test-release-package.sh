#!/usr/bin/env bash
# CI 的真实安装包冒烟：不安装任何依赖，不修改系统配置。
set -euo pipefail
bundle="$1"
[ "$("$bundle/elysian" release-info | jq -r .commit)" = "$(jq -r .commit "$bundle/release.json")" ]
"$bundle/platform-helper" socket /run/caddy/admin.sock >/dev/null
(cd "$bundle" && jq -r '.files | to_entries[] | "\(.value)  \(.key)"' release.json | sha256sum -c -)
# 固定用预编译分支；Go/Bun 准备入口被替换为失败哨兵，防止服务器隐式回退源码构建。
bash -c '
  source "$1/scripts/install.sh"
  install_go() { exit 91; }
  install_bun() { exit 92; }
  bun() { exit 93; }
  detect_arch
  prepare_release
  "$BUILD_DIR/elysian" release-info
  platform_helper socket /run/caddy/admin.sock
  test_install="$(mktemp -d /tmp/elysian-install-package.XXXXXX)"
  INSTALL_ROOT="$test_install/opt"
  STATE_DIR="$test_install/state"
  INSTALL_STAMP=smoke
  PANEL_BIN="$test_install/elysian"
  register_cli_link() { :; }
  install_binary
  [ -r "$INSTALL_ROOT/current/scripts/uninstall.sh" ]
  python3 "$INSTALL_ROOT/current/scripts/release-download.py" verify "$INSTALL_ROOT/current" "$GO_ARCH" "$BUILD_COMMIT"
  (
    installed_root="$INSTALL_ROOT"
    source "$INSTALL_ROOT/current/scripts/uninstall.sh"
    INSTALL_ROOT="$installed_root"
    SCRIPT_DIR="$test_install/no-source-scripts"
    uninstall_platform_helper socket /run/caddy/admin.sock
  )
  rm -rf "$test_install"
  rm -rf "$BUILD_DIR"
' release-test "$bundle"
