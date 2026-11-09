#!/usr/bin/env bash
# 私有临时目录和命令桩；不接触宿主 apt、systemd、Docker 或用户数据。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

fixture_case() (
  source "$SCRIPT_DIR/install.sh"
  source "$SCRIPT_DIR/uninstall.sh"
  init_output 0 0
  FIXTURE="$(mktemp -d /tmp/elysian-lifecycle-test.XXXXXX)"
  trap 'rm -rf "$FIXTURE"' EXIT
  PLATFORM_RECEIPTS="$FIXTURE/receipts"
  PLATFORM_LIFECYCLE_LOCK="$FIXTURE/lifecycle.lock"
  CADDYFILE_PATH="$FIXTURE/caddy/Caddyfile"
  CADDY_RUNTIME_DROPIN="$FIXTURE/dropins/runtime.conf"
  CADDY_TMPFILES="$FIXTURE/tmpfiles/caddy.conf"
  CADDY_APT_LIST="$FIXTURE/caddy.list"
  CADDY_KEYRING="$FIXTURE/caddy.key"
  CADDY_SOCKET="$FIXTURE/admin.sock"
  CADDY_ADMIN_SOCKET="$CADDY_SOCKET"
  BACKUP_ROOT="$FIXTURE/backups"
  BACKUP_DIR=""
  STATE_DIR="$FIXTURE/state"
  PURGE_GUARD="$STATE_DIR"
  DATA_ROOT="$STATE_DIR/.Elysian"
  ENV_FILE="$FIXTURE/environment"
  UNIT_FILE="$FIXTURE/elysian.service"
  PANEL_BIN="$FIXTURE/bin/elysian"
  CLI_BIN="$FIXTURE/bin/ely"
  INSTALL_ROOT="$FIXTURE/install"
  BUILD_HOME="$FIXTURE/build"
  MIRROR_PROFILE="$FIXTURE/mirrors"
  CLI_DATA_DIR="$FIXTURE/root-cli/cli"
  ARTIFACT_GLOBS=("$FIXTURE/artifacts/elysian-build.*")
  mkdir -p "$FIXTURE/caddy" "$FIXTURE/dropins" "$FIXTURE/tmpfiles"
  : >"$FIXTURE/packages"
  : >"$FIXTURE/apt.calls"
  printf 'inactive' >"$FIXTURE/active"
  printf '{\n\tadmin unix/%s\n}\n:8080 {\n\trespond "ok"\n}\n' "$CADDY_SOCKET" >"$CADDYFILE_PATH"
  chmod 0644 "$CADDYFILE_PATH"
  dpkg-query() {
    if [ "$2" = '-f=${Status}' ]; then
      grep -Fxq "$3" "$FIXTURE/packages" || return 1
      printf 'install ok installed'
    else return 1; fi
  }
  apt-get() {
    printf '%s\n' "$*" >>"$FIXTURE/apt.calls"
    if [ "$1" = --simulate ]; then
      shift 2
      printf 'Purg %s\n' "$@"
      if [ -f "$FIXTURE/apt-extra" ]; then printf 'Remv unrelated-service [1.0]\n'; fi
    else return 1; fi
  }
  dpkg() {
      printf '%s\n' "$*" >>"$FIXTURE/apt.calls"
      [ ! -f "$FIXTURE/apt-fail" ] || return 1
      shift 2
      local package
      for package in "$@"; do
        grep -Fxv "$package" "$FIXTURE/packages" >"$FIXTURE/packages.next" || true
        mv "$FIXTURE/packages.next" "$FIXTURE/packages"
      done
  }
  systemctl() {
    case "$1" in
      show)
        case "$3" in
          ActiveState) cat "$FIXTURE/active" ;;
          ExecStart) printf '{ path=/usr/bin/caddy ; argv[]=/usr/bin/caddy run --config %s ; }' "$CADDYFILE_PATH" ;;
        esac ;;
      is-active) [ "$(cat "$FIXTURE/active")" = active ] ;;
      *) return 0 ;;
    esac
  }
  uninstall_docker() {
    [ ! -f "$FIXTURE/docker-unavailable" ] || return 1
    case "$*" in
      info) : ;;
      'ps -aq') cat "$FIXTURE/containers" 2>/dev/null || true ;;
      'image ls -aq') cat "$FIXTURE/images" 2>/dev/null || true ;;
      'volume ls -q') cat "$FIXTURE/volumes" 2>/dev/null || true ;;
      'network ls --filter type=custom -q') cat "$FIXTURE/networks" 2>/dev/null || true ;;
      *) return 1 ;;
    esac
  }
  dependency_present() {
    local package
    while IFS= read -r package; do if platform_package_present "$package"; then return 0; fi; done < <(platform_packages "$1")
    [ -e "$PLATFORM_RECEIPTS/$1" ]
  }
  "$@"
)

make_receipt() {
  platform_receipt_begin "$1" || return 1
  printf '%s\n' "$2" >>"$FIXTURE/packages"
  platform_receipt_finish "$1"
}

test_default_and_keep_options() {
  [ "$PURGE_DATA:$CADDY_REMOVE:$KEEP_DEPENDENCIES" = 1:1:0 ] || return 1
  ASSUME_YES=1
  select_data_categories
  [ "$DELETE_DATA:$DELETE_CONFIG:$DELETE_LOGS:$DELETE_STATE" = 1:1:1:1 ] || return 1
  parse_args --keep-data --keep-dependencies --keep-caddy-config --keep-tools
  [ "$PURGE_DATA:$KEEP_DATA:$KEEP_DEPENDENCIES:$CADDY_REMOVE:$KEEP_TOOLS" = 0:1:1:0:1 ]
}

test_conflicting_flags_rejected_in_both_orders() {
  if (parse_args --keep-data --purge-data) >/dev/null 2>&1; then return 1; fi
  if (parse_args --purge-data --keep-data) >/dev/null 2>&1; then return 1; fi
}

test_receipt_excludes_existing_packages() {
  printf '%s\n' containerd.io >"$FIXTURE/packages"
  make_receipt docker docker-ce || return 1
  [ "$(cat "$PLATFORM_RECEIPTS/docker/packages")" = docker-ce ] || return 1
  platform_receipt_begin docker || return 1
  [ "$(cat "$PLATFORM_RECEIPTS/docker/packages")" = docker-ce ] && platform_receipt_valid docker
}

test_receipt_symlink_and_permissions_rejected() {
  mkdir "$FIXTURE/foreign"
  ln -s "$FIXTURE/foreign" "$PLATFORM_RECEIPTS"
  if platform_receipt_begin caddy; then return 1; fi
  [ -z "$(ls -A "$FIXTURE/foreign")" ] || return 1
  rm "$PLATFORM_RECEIPTS"
  make_receipt caddy caddy || return 1
  chmod 0644 "$PLATFORM_RECEIPTS/caddy/complete"
  if platform_receipt_valid caddy; then return 1; fi
  chmod 0600 "$PLATFORM_RECEIPTS/caddy/complete"
  ln "$PLATFORM_RECEIPTS/caddy/complete" "$FIXTURE/linked"
  ! platform_receipt_valid caddy
}

test_receipt_package_injection_rejected() {
  make_receipt caddy caddy || return 1
  printf 'openssh-server' >>"$PLATFORM_RECEIPTS/caddy/packages"
  if platform_purge_packages caddy "$FIXTURE/purge.log"; then return 1; fi
  [ ! -s "$FIXTURE/apt.calls" ]
}

test_legacy_dependency_reports_incomplete() {
  printf 'caddy\n' >"$FIXTURE/packages"
  remove_dependencies
  [ "$FAILED" = 1 ] && [ ! -s "$FIXTURE/apt.calls" ] || return 1
  print_summary >"$FIXTURE/summary"
  grep -q '卸载未全部完成' "$FIXTURE/summary" && ! grep -q '✓ Elysian 已卸载' "$FIXTURE/summary"
}

test_explicit_keep_does_not_claim_failure() {
  printf 'caddy\n' >"$FIXTURE/packages"
  KEEP_DEPENDENCIES=1
  remove_dependencies
  [ "$FAILED" = 0 ] && [ "${#KEPT_ITEMS[@]}" -gt 0 ] && [ ! -s "$FIXTURE/apt.calls" ]
}

test_pending_install_recovery() {
  platform_receipt_begin caddy || return 1
  printf 'caddy\n' >"$FIXTURE/packages"
  platform_receipt_finish caddy || return 1
  platform_receipt_valid caddy && [ ! -e "$PLATFORM_RECEIPTS/caddy/pending" ]
}

test_apt_dependency_expansion_refused() {
  make_receipt caddy caddy || return 1
  : >"$FIXTURE/apt-extra"
  if platform_purge_packages caddy "$FIXTURE/purge.log"; then return 1; fi
  [ "$(wc -l <"$FIXTURE/apt.calls")" -eq 1 ] && platform_package_installed caddy
}

test_package_purge_and_owned_sources() {
  platform_receipt_begin caddy || return 1
  printf 'caddy\n' >"$FIXTURE/packages"
  printf 'source' >"$CADDY_APT_LIST"
  printf 'key' >"$CADDY_KEYRING"
  platform_receipt_finish caddy || return 1
  platform_purge_packages caddy "$FIXTURE/purge.log" || return 1
  platform_remove_assets caddy || return 1
  [ ! -e "$CADDY_APT_LIST" ] && [ ! -e "$CADDY_KEYRING" ] && ! platform_package_installed caddy
}

test_changed_or_existing_source_preserved() {
  printf 'existing' >"$CADDY_APT_LIST"
  platform_receipt_begin caddy || return 1
  printf 'caddy\n' >"$FIXTURE/packages"
  printf 'new key' >"$CADDY_KEYRING"
  platform_receipt_finish caddy || return 1
  printf 'changed key' >"$CADDY_KEYRING"
  if platform_remove_assets caddy; then return 1; fi
  [ "$(cat "$CADDY_APT_LIST")" = existing ] && [ "$(cat "$CADDY_KEYRING")" = 'changed key' ]
}

test_docker_business_resources_prevent_removal() {
  make_receipt docker docker-ce || return 1
  local kind
  for kind in containers images volumes networks; do
    printf 'resource\n' >"$FIXTURE/$kind"
    if dependency_unused docker; then return 1; fi
    rm "$FIXTURE/$kind"
  done
  : >"$FIXTURE/docker-unavailable"
  if dependency_unused docker; then return 1; fi
  [ ! -s "$FIXTURE/apt.calls" ]
}

test_unused_docker_cleanup() {
  make_receipt docker docker-ce || return 1
  remove_dependencies
  [ "$FAILED" = 0 ] && [ ! -e "$PLATFORM_RECEIPTS/docker" ] && ! platform_package_installed docker-ce
}

test_purge_failure_preserves_receipt_and_reports() {
  make_receipt docker docker-ce || return 1
  : >"$FIXTURE/apt-fail"
  remove_dependencies
  [ "$FAILED" = 1 ] && [ "${#UNFINISHED_ITEMS[@]}" -gt 0 ] && platform_receipt_valid docker
}

test_caddy_metadata_preserved() {
  CADDYFILE_ADMIN_FOUND=1
  remove_caddy
  [ "$FAILED" = 0 ] && [ "$(stat -c '%a' "$CADDYFILE_PATH")" = 644 ] && ! grep -q 'admin unix/' "$CADDYFILE_PATH"
}

test_caddy_dynamic_routes_block_reload() {
  printf 'active' >"$FIXTURE/active"
  CADDYFILE_ADMIN_FOUND=1
  CADDY_RUNTIME_MATCH=1
  printf 'keep' >"$CADDY_RUNTIME_DROPIN"
  cp "$CADDYFILE_PATH" "$FIXTURE/original"
  caddy_runtime_matches_disk() { return 1; }
  remove_caddy
  [ "$FAILED" = 1 ] && cmp -s "$CADDYFILE_PATH" "$FIXTURE/original" && [ -f "$CADDY_RUNTIME_DROPIN" ]
}

test_missing_config_reported_when_retained() {
  rm "$CADDYFILE_PATH"
  verify_retained_services
  [ "$FAILED" = 1 ] && [ "${#UNFINISHED_ITEMS[@]}" -gt 0 ]
}

test_restore_missing_caddyfile_only() {
  cp "$CADDYFILE_PATH" "$FIXTURE/trusted"
  RESTORE_CADDYFILE="$FIXTURE/trusted"
  rm "$CADDYFILE_PATH"
  restore_missing_caddyfile || return 1
  cmp -s "$CADDYFILE_PATH" "$FIXTURE/trusted" && [ "$(stat -c '%a' "$CADDYFILE_PATH")" = 644 ] || return 1
  if (restore_missing_caddyfile) >/dev/null 2>&1; then return 1; fi
  cmp -s "$CADDYFILE_PATH" "$FIXTURE/trusted"
}

test_restore_active_or_invalid_refused() {
  printf ':8080 { broken directive }\n' >"$FIXTURE/trusted"
  RESTORE_CADDYFILE="$FIXTURE/trusted"
  rm "$CADDYFILE_PATH"
  if (restore_missing_caddyfile) >/dev/null 2>&1; then return 1; fi
  [ ! -e "$CADDYFILE_PATH" ] || return 1
  printf 'active' >"$FIXTURE/active"
  if (restore_missing_caddyfile) >/dev/null 2>&1; then return 1; fi
  [ ! -e "$CADDYFILE_PATH" ]
}

test_lifecycle_lock_rejects_links() {
  : >"$FIXTURE/foreign"
  ln -s "$FIXTURE/foreign" "$PLATFORM_LIFECYCLE_LOCK"
  ! platform_lifecycle_lock
}

test_service_stop_failure_preserves_data() {
  mkdir -p "$DATA_ROOT/data"
  printf 'database' >"$DATA_ROOT/data/harness.sqlite"
  : >"$UNIT_FILE"
  systemctl() { return 1; }
  run_uninstall
  [ "$FAILED" = 1 ] && [ -f "$UNIT_FILE" ] && [ "$(cat "$DATA_ROOT/data/harness.sqlite")" = database ] && [ ! -s "$FIXTURE/apt.calls" ]
}

test_full_cleanup_removes_panel_and_owned_dependency() {
  make_receipt docker docker-ce || return 1
  mkdir -p "$DATA_ROOT/data" "$INSTALL_ROOT" "$BUILD_HOME/cache" "$FIXTURE/bin" "$CLI_DATA_DIR"
  printf 'database' >"$DATA_ROOT/data/harness.sqlite"
  printf 'binary' >"$PANEL_BIN"
  : >"$UNIT_FILE"
  : >"$ENV_FILE"
  KEEP_TOOLS=1
  remove_accounts() { :; }
  detect_caddy
  select_data_categories
  run_uninstall
  [ "$FAILED" = 0 ] && [ ! -e "$STATE_DIR" ] && [ ! -e "$PANEL_BIN" ] && [ ! -e "$INSTALL_ROOT" ] &&
    [ ! -e "$BUILD_HOME" ] && [ ! -e "$PLATFORM_RECEIPTS/docker" ] && ! platform_package_installed docker-ce
}

test_tool_identity_must_match_record() {
  mkdir -m 0700 "$PLATFORM_RECEIPTS" "$PLATFORM_RECEIPTS/go"
  printf 'go' >"$FIXTURE/go"
  (umask 077; sha256sum "$FIXTURE/go" | cut -d ' ' -f 1 >"$PLATFORM_RECEIPTS/go/binary.sha256")
  platform_tool_owned go "$FIXTURE/go" || return 1
  printf 'replacement' >"$FIXTURE/go"
  ! platform_tool_owned go "$FIXTURE/go"
}

test_real_dpkg_exact_package_scope() {
  # 真实 dpkg 使用独立安装根与数据库，不操作测试容器自己的软件包。
  local root="$FIXTURE/package-root" database="$FIXTURE/dpkg" package
  mkdir -p "$root" "$database"
  : >"$database/status"
  dpkg-query() { command dpkg-query --admindir="$database" "$@"; }
  dpkg() { command dpkg --root="$root" --admindir="$database" "$@"; }
  apt-get() { command apt-get -o "Dir::State::status=$database/status" "$@"; }
  for package in caddy elysian-unrelated-fixture; do
    mkdir -p "$FIXTURE/$package/DEBIAN" "$FIXTURE/$package/etc/$package"
    printf 'Package: %s\nVersion: 1.0\nArchitecture: all\nMaintainer: Fixture <fixture@example.invalid>\nDescription: isolated lifecycle fixture\n' "$package" >"$FIXTURE/$package/DEBIAN/control"
    printf 'preserve config\n' >"$FIXTURE/$package/etc/$package/config"
    printf '/etc/%s/config\n' "$package" >"$FIXTURE/$package/DEBIAN/conffiles"
    command dpkg-deb --build "$FIXTURE/$package" "$FIXTURE/$package.deb" >/dev/null || return 1
  done
  platform_receipt_begin caddy || return 1
  dpkg --install "$FIXTURE/caddy.deb" "$FIXTURE/elysian-unrelated-fixture.deb" >"$FIXTURE/dpkg-install.log" 2>&1 || return 1
  platform_receipt_finish caddy || return 1
  platform_purge_packages caddy "$FIXTURE/dpkg-purge.log" || { cat "$FIXTURE/dpkg-purge.log"; return 1; }
  ! platform_package_present caddy && platform_package_installed elysian-unrelated-fixture &&
    [ ! -e "$root/etc/caddy/config" ] && [ -f "$root/etc/elysian-unrelated-fixture/config" ]
}

for test in test_default_and_keep_options test_conflicting_flags_rejected_in_both_orders test_receipt_excludes_existing_packages test_receipt_symlink_and_permissions_rejected test_receipt_package_injection_rejected test_legacy_dependency_reports_incomplete test_explicit_keep_does_not_claim_failure test_pending_install_recovery test_apt_dependency_expansion_refused test_package_purge_and_owned_sources test_changed_or_existing_source_preserved test_docker_business_resources_prevent_removal test_unused_docker_cleanup test_purge_failure_preserves_receipt_and_reports test_caddy_metadata_preserved test_caddy_dynamic_routes_block_reload test_missing_config_reported_when_retained test_restore_missing_caddyfile_only test_restore_active_or_invalid_refused test_lifecycle_lock_rejects_links test_service_stop_failure_preserves_data test_full_cleanup_removes_panel_and_owned_dependency test_tool_identity_must_match_record test_real_dpkg_exact_package_scope; do
  if fixture_case "$test" > /tmp/elysian-lifecycle-case-$$.log 2>&1; then
    PASS=$((PASS + 1)); printf 'PASS %s\n' "$test"
  else
    FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$test"; cat /tmp/elysian-lifecycle-case-$$.log
  fi
done
rm -f /tmp/elysian-lifecycle-case-$$.log
printf '安装卸载生命周期：%s 通过，%s 失败\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]
