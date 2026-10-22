#!/usr/bin/env bash
# 临时目录、命令桩和真实 Unix/TCP HTTP fixture；绝不调用宿主 systemctl/ufw/caddy。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

fixture_case() (
  source "$SCRIPT_DIR/install.sh"
  init_output 0 0
  FIXTURE="$(mktemp -d /tmp/elysian-platform-test.XXXXXX)"
  trap 'case_rc=$?; kill "${FIXTURE_PID:-}" 2>/dev/null || true; wait "${FIXTURE_PID:-}" 2>/dev/null || true; rm -rf "$FIXTURE"; exit "$case_rc"' EXIT
  STATE_DIR="$FIXTURE/state"
  PLATFORM_TXN="$FIXTURE/transaction"
  CADDYFILE_PATH="$FIXTURE/Caddyfile"
  CADDY_RUNTIME_DROPIN="$FIXTURE/dropins/elysian-runtime.conf"
  CADDY_TMPFILES="$FIXTURE/tmpfiles/elysian-caddy.conf"
  ENV_FILE="$FIXTURE/environment"
  CADDY_ADMIN_SOCKET="$FIXTURE/admin.sock"
  ELYSIAN_CADDY_SOCKET="$CADDY_ADMIN_SOCKET"
  unset ELYSIAN_DOCKER_SOCKET DOCKER_ENGINE_SOCKET
  CADDY_VERIFY_ATTEMPTS=2
  CADDY_VERIFY_INTERVAL=0.01
  printf 'normal\n' >"$FIXTURE/mode"
  printf '1\n' >"$FIXTURE/service-active"
  printf 'enabled\n' >"$FIXTURE/service-enabled"
  : >"$FIXTURE/systemctl.calls"
  printf '# preserve comment\nOTHER=value\nELYSIAN_CADDY_SOCKET=/old/admin.sock\n' >"$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  cp -p "$ENV_FILE" "$FIXTURE/environment.original"
  bun "$SCRIPT_DIR/test-caddy-api.mjs" "$FIXTURE" >"$FIXTURE/server.log" 2>&1 &
  FIXTURE_PID=$!
  for ((attempt=0; attempt<100; attempt++)); do
    [ -f "$FIXTURE/ready" ] && break
    sleep 0.02
  done
  [ -f "$FIXTURE/ready" ] || { cat "$FIXTURE/server.log"; exit 1; }
  cp -p "$CADDYFILE_PATH" "$FIXTURE/Caddyfile.original"

  systemctl() {
    printf '%s\n' "$*" >>"$FIXTURE/systemctl.calls"
    case "$1" in
      cat) [ ! -f "$FIXTURE/no-unit" ] ;;
      show)
        case "$3" in
          ExecStart) printf '{ path=/usr/bin/caddy ; argv[]=/usr/bin/caddy run --environ --config %s ; ignore_errors=no ; }\n' "$CADDYFILE_PATH" ;;
          User) echo caddy ;;
          Group) echo caddy ;;
          ActiveState) if [ "$(cat "$FIXTURE/service-active")" = 1 ]; then echo active; else echo inactive; fi ;;
          UnitFileState) cat "$FIXTURE/service-enabled" ;;
        esac ;;
      is-active) [ "$(cat "$FIXTURE/service-active")" = 1 ] ;;
      is-enabled) cat "$FIXTURE/service-enabled"; [ "$(cat "$FIXTURE/service-enabled")" = enabled ] ;;
      enable) printf 'enabled\n' >"$FIXTURE/service-enabled" ;;
      disable) printf 'disabled\n' >"$FIXTURE/service-enabled" ;;
      start|restart)
        [ ! -f "$FIXTURE/start-fail" ] || return 1
        printf '1\n' >"$FIXTURE/service-active"
        if grep -q "admin unix/" "$CADDYFILE_PATH"; then
          platform_helper connect "$FIXTURE/disk.json" "$CADDY_ADMIN_SOCKET" "$FIXTURE/runtime.current.json"
        else
          cp "$FIXTURE/disk.json" "$FIXTURE/runtime.current.json"
        fi ;;
      stop) printf '0\n' >"$FIXTURE/service-active" ;;
      daemon-reload) return 0 ;;
      *) return 1 ;;
    esac
  }
  caddy() {
    case "$1" in
      adapt)
        if grep -q 'admin unix/' "$3"; then
          if [ -f "$FIXTURE/adapt-alter" ]; then
            printf '{"apps":{}}' >"$FIXTURE/altered.json"
            platform_helper connect "$FIXTURE/altered.json" "$CADDY_ADMIN_SOCKET" "$FIXTURE/adapted.json"
          else platform_helper connect "$FIXTURE/disk.json" "$CADDY_ADMIN_SOCKET" "$FIXTURE/adapted.json"; fi
          bun -e '
            const config = JSON.parse(await Bun.file(process.argv[1]).text())
            const handler = config.apps?.http?.servers?.disk?.routes[0]?.handle[0]
            if (handler) {
              handler.hide[0] = process.argv[2]
              if (await Bun.file(process.argv[3]).exists()) handler.hide[1] = "/srv/public"
            }
            console.log(JSON.stringify(config))
          ' "$FIXTURE/adapted.json" "$3" "$FIXTURE/adapt-hide-alter"
        else cat "$FIXTURE/disk.json"; fi ;;
      validate)
        if [ -f "$FIXTURE/marker-fail" ]; then mkdir -p "$PLATFORM_TXN/changed/caddyfile"; fi
        [ ! -f "$FIXTURE/validate-fail" ] ;;
      version) echo v2.8.4 ;;
      *) return 1 ;;
    esac
  }
  runuser() { [ "$*" = "-u caddy -- test -w $FIXTURE" ]; }
  chown() { return 0; }
  flock() { printf '%s\n' "$*" >>"$FIXTURE/flock.calls"; }
  ufw() {
    printf '%s\n' "$*" >>"$FIXTURE/ufw.calls"
    case "$1" in
      show) cat "$FIXTURE/ufw.added" ;;
      allow) printf 'ufw allow 80,443/tcp\n' >>"$FIXTURE/ufw.added" ;;
      --force) : >"$FIXTURE/ufw.added" ;;
      *) return 1 ;;
    esac
  }
  "$1"
)

test_active_preserves_runtime() {
  connect_caddy_safely || return 1
  platform_helper connect "$FIXTURE/runtime.original.json" "$CADDY_ADMIN_SOCKET" "$FIXTURE/expected.json" || return 1
  platform_helper equal "$FIXTURE/expected.json" "$FIXTURE/runtime.current.json" || return 1
  grep -q '^OTHER=value$' "$ENV_FILE" && grep -q '^# preserve comment$' "$ENV_FILE" || return 1
  [ "$(platform_helper env-read "$ENV_FILE")" = "$CADDY_ADMIN_SOCKET" ] || return 1
  local mode
  if stat -c %a "$ENV_FILE" >/dev/null 2>&1; then mode="$(stat -c %a "$ENV_FILE")"; else mode="$(stat -f %Lp "$ENV_FILE")"; fi
  [ "$mode" = 640 ] || return 1
  ! grep -Eq '^(start|restart)' "$FIXTURE/systemctl.calls" || return 1
  commit_platform_transaction || return 1
  [ ! -e "$PLATFORM_TXN" ]
}

test_ready_manual_reuse() {
  platform_helper connect "$FIXTURE/runtime.original.json" "$CADDY_ADMIN_SOCKET" "$FIXTURE/runtime.current.json" || return 1
  : >"$FIXTURE/no-unit"
  connect_caddy_safely || return 1
  cmp -s "$CADDYFILE_PATH" "$FIXTURE/Caddyfile.original" || return 1
  [ ! -e "$CADDY_RUNTIME_DROPIN" ] && [ ! -e "$CADDY_TMPFILES" ] || return 1
  ! grep -Eq '^(start|restart|enable)' "$FIXTURE/systemctl.calls" || return 1
  commit_platform_transaction
}

test_manual_unready_refused() {
  : >"$FIXTURE/no-unit"
  if connect_caddy_safely; then return 1; fi
  [ ! -d "$PLATFORM_TXN" ] && cmp -s "$ENV_FILE" "$FIXTURE/environment.original" && cmp -s "$CADDYFILE_PATH" "$FIXTURE/Caddyfile.original"
}

test_failed_target_rolls_back() {
  printf 'target-fail\n' >"$FIXTURE/mode"
  if connect_caddy_safely; then return 1; fi
  restore_platform_transaction || return 1
  cmp -s "$CADDYFILE_PATH" "$FIXTURE/Caddyfile.original" && cmp -s "$ENV_FILE" "$FIXTURE/environment.original" || return 1
  [ ! -e "$CADDY_RUNTIME_DROPIN" ] && [ ! -e "$CADDY_TMPFILES" ] || return 1
  platform_helper equal "$FIXTURE/runtime.original.json" "$FIXTURE/runtime.current.json" || return 1
  [ ! -d "$PLATFORM_TXN" ]
}

test_missing_socket_restores_runtime() {
  CADDY_ADMIN_SOCKET="$FIXTURE/absent.sock"
  ELYSIAN_CADDY_SOCKET="$CADDY_ADMIN_SOCKET"
  if connect_caddy_safely; then return 1; fi
  restore_platform_transaction || return 1
  platform_helper equal "$FIXTURE/runtime.original.json" "$FIXTURE/runtime.current.json" || return 1
  cmp -s "$CADDYFILE_PATH" "$FIXTURE/Caddyfile.original" && cmp -s "$ENV_FILE" "$FIXTURE/environment.original"
}

test_apply_failure_restores_runtime() {
  printf 'load-fail\n' >"$FIXTURE/mode"
  if connect_caddy_safely; then return 1; fi
  restore_platform_transaction || return 1
  platform_helper equal "$FIXTURE/runtime.original.json" "$FIXTURE/runtime.current.json" || return 1
  cmp -s "$CADDYFILE_PATH" "$FIXTURE/Caddyfile.original" && cmp -s "$ENV_FILE" "$FIXTURE/environment.original"
}

test_validation_keeps_original() {
  : >"$FIXTURE/validate-fail"
  if connect_caddy_safely; then return 1; fi
  restore_platform_transaction || return 1
  cmp -s "$CADDYFILE_PATH" "$FIXTURE/Caddyfile.original" && cmp -s "$ENV_FILE" "$FIXTURE/environment.original" || return 1
  ! grep -q '^POST ' "$FIXTURE/requests"
}

test_restart_failure_restores_stopped() {
  printf '0\n' >"$FIXTURE/service-active"
  printf 'disabled\n' >"$FIXTURE/service-enabled"
  : >"$FIXTURE/start-fail"
  if connect_caddy_safely; then return 1; fi
  restore_platform_transaction || return 1
  [ "$(cat "$FIXTURE/service-active")" = 0 ] && [ "$(cat "$FIXTURE/service-enabled")" = disabled ] || return 1
  cmp -s "$CADDYFILE_PATH" "$FIXTURE/Caddyfile.original" && cmp -s "$ENV_FILE" "$FIXTURE/environment.original"
}

test_fresh_invocation_recovers() {
  connect_caddy_safely || return 1
  export FIXTURE
  export -f systemctl caddy runuser chown
  bash -c '
    source "$1/install.sh"
    FIXTURE="$2"
    PLATFORM_TXN="$FIXTURE/transaction"
    CADDYFILE_PATH="$FIXTURE/Caddyfile"
    CADDY_RUNTIME_DROPIN="$FIXTURE/dropins/elysian-runtime.conf"
    CADDY_TMPFILES="$FIXTURE/tmpfiles/elysian-caddy.conf"
    ENV_FILE="$FIXTURE/environment"
    CADDY_VERIFY_ATTEMPTS=2
    CADDY_VERIFY_INTERVAL=0.01
    restore_platform_transaction
  ' fixture-recovery "$SCRIPT_DIR" "$FIXTURE" || return 1
  platform_helper equal "$FIXTURE/runtime.original.json" "$FIXTURE/runtime.current.json"
}

test_restore_failure_retains_backup() {
  printf 'restore-fail\n' >"$FIXTURE/mode"
  : >"$FIXTURE/start-fail"
  if connect_caddy_safely; then return 1; fi
  if restore_platform_transaction; then return 1; fi
  [ -f "$PLATFORM_TXN/pending" ] && [ -f "$PLATFORM_TXN/runtime.original.json" ]
}

test_corrupt_json_rejected() {
  printf 'invalid-json\n' >"$FIXTURE/mode"
  if connect_caddy_safely; then return 1; fi
  restore_platform_transaction || return 1
  platform_helper equal "$FIXTURE/runtime.original.json" "$FIXTURE/runtime.current.json"
}

test_environment_parser_preserves_multiline() {
  printf 'OTHER="first\nELYSIAN_CADDY_SOCKET=embedded-text\nlast"\n# keep\nELYSIAN_CADDY_SOCKET="/old/admin.sock"\n' >"$ENV_FILE"
  platform_helper env-write "$ENV_FILE" "$CADDY_ADMIN_SOCKET" "$FIXTURE/env.candidate" || return 1
  grep -q '^ELYSIAN_CADDY_SOCKET=embedded-text$' "$FIXTURE/env.candidate" || return 1
  grep -q '^# keep$' "$FIXTURE/env.candidate" || return 1
  [ "$(platform_helper env-read "$FIXTURE/env.candidate")" = "$CADDY_ADMIN_SOCKET" ]
}

test_environment_failure_restores_files() {
  rm "$ENV_FILE"
  ln -s "$FIXTURE/environment.original" "$ENV_FILE"
  if connect_caddy_safely; then return 1; fi
  restore_platform_transaction || return 1
  [ -L "$ENV_FILE" ] && cmp -s "$CADDYFILE_PATH" "$FIXTURE/Caddyfile.original" || return 1
  ! grep -q '^POST ' "$FIXTURE/requests"
}

test_disk_route_changes_refused() {
  : >"$FIXTURE/adapt-alter"
  if connect_caddy_safely; then return 1; fi
  restore_platform_transaction || return 1
  cmp -s "$CADDYFILE_PATH" "$FIXTURE/Caddyfile.original" || return 1
  ! grep -q '^POST ' "$FIXTURE/requests"
}

test_hidden_path_changes_refused() {
  : >"$FIXTURE/adapt-hide-alter"
  if connect_caddy_safely; then return 1; fi
  restore_platform_transaction || return 1
  cmp -s "$CADDYFILE_PATH" "$FIXTURE/Caddyfile.original" || return 1
  ! grep -q '^POST ' "$FIXTURE/requests"
}

test_failed_marker_prevents_publish() {
  : >"$FIXTURE/marker-fail"
  if connect_caddy_safely; then return 1; fi
  cmp -s "$CADDYFILE_PATH" "$FIXTURE/Caddyfile.original" || return 1
  ! grep -q '^POST ' "$FIXTURE/requests" || return 1
  restore_platform_transaction || return 1
  cmp -s "$ENV_FILE" "$FIXTURE/environment.original" || return 1
  [ ! -e "$CADDY_RUNTIME_DROPIN" ] && [ ! -e "$CADDY_TMPFILES" ]
}

test_linked_unit_refused() {
  printf 'linked\n' >"$FIXTURE/service-enabled"
  if connect_caddy_safely; then return 1; fi
  restore_platform_transaction || return 1
  [ "$(cat "$FIXTURE/service-enabled")" = linked ] || return 1
  ! grep -Eq '^(enable|disable|start|restart)' "$FIXTURE/systemctl.calls" || return 1
  cmp -s "$CADDYFILE_PATH" "$FIXTURE/Caddyfile.original"
}

test_total_verification_deadline() {
  printf 'slow\n' >"$FIXTURE/mode"
  local started elapsed endpoint
  endpoint="$(platform_helper endpoint "$FIXTURE/disk.json")" || return 1
  started="$(bun -e 'console.log(Date.now())')"
  CADDY_VERIFY_TIMEOUT=0.15
  if wait_caddy_api "$endpoint" "$FIXTURE/slow-response.json"; then return 1; fi
  elapsed=$(( $(bun -e 'console.log(Date.now())') - started ))
  [ "$elapsed" -lt 1500 ]
}

test_pending_maintenance_prevents_dependency_mutation() {
  BUILD_DIR="$FIXTURE/build"
  mkdir "$BUILD_DIR"
  printf '#!/bin/sh\nexit 1\n' >"$BUILD_DIR/elysian"
  chmod +x "$BUILD_DIR/elysian"
  docker_install_or_reuse() { : >"$FIXTURE/docker-mutated"; }
  install_caddy() { : >"$FIXTURE/caddy-mutated"; }
  if (install_platform_deps); then return 1; fi
  [ ! -e "$FIXTURE/docker-mutated" ] && [ ! -e "$FIXTURE/caddy-mutated" ]
}

test_both_socket_overrides_persist_and_restore() {
  ELYSIAN_DOCKER_SOCKET="$FIXTURE/docker.sock"
  connect_caddy_safely || return 1
  [ "$(platform_helper env-read "$ENV_FILE" ELYSIAN_DOCKER_SOCKET)" = "$ELYSIAN_DOCKER_SOCKET" ] || return 1
  [ "$(platform_helper env-read "$ENV_FILE" ELYSIAN_CADDY_SOCKET)" = "$CADDY_ADMIN_SOCKET" ] || return 1
  grep -q '^OTHER=value$' "$ENV_FILE" || return 1
  restore_platform_transaction || return 1
  cmp -s "$ENV_FILE" "$FIXTURE/environment.original"
}

test_failed_docker_leaves_caddy_and_environment() {
  BUILD_DIR="$FIXTURE/build"
  mkdir "$BUILD_DIR"
  printf '#!/bin/sh\nexit 0\n' >"$BUILD_DIR/elysian"
  chmod +x "$BUILD_DIR/elysian"
  ELYSIAN_DOCKER_SOCKET="$FIXTURE/docker.sock"
  docker() { return 1; }
  install_caddy() { : >"$FIXTURE/caddy-mutated"; }
  if (install_platform_deps); then return 1; fi
  [ ! -e "$FIXTURE/caddy-mutated" ] && [ ! -d "$PLATFORM_TXN" ] || return 1
  cmp -s "$ENV_FILE" "$FIXTURE/environment.original" && cmp -s "$CADDYFILE_PATH" "$FIXTURE/Caddyfile.original"
}

test_local_caddy_ignores_proxy_environment() {
  export HTTP_PROXY=http://127.0.0.1:1 http_proxy=http://127.0.0.1:1
  export ALL_PROXY=http://127.0.0.1:1 all_proxy=http://127.0.0.1:1
  unset NO_PROXY no_proxy
  connect_caddy_safely || return 1
  restore_platform_transaction || return 1
  platform_helper equal "$FIXTURE/runtime.original.json" "$FIXTURE/runtime.current.json"
}

test_all_configuration_snapshots() {
  mkdir "$FIXTURE/dropins" "$FIXTURE/tmpfiles"
  printf 'original runtime\n' >"$CADDY_RUNTIME_DROPIN"
  printf 'original tmpfiles\n' >"$CADDY_TMPFILES"
  printf 'candidate\n' >"$FIXTURE/candidate"
  begin_platform_transaction 0 || return 1
  local key
  for key in caddyfile runtime tmpfiles environment; do platform_write_file "$key" "$FIXTURE/candidate" 0644 || return 1; done
  restore_platform_transaction || return 1
  [ "$(cat "$CADDY_RUNTIME_DROPIN")" = 'original runtime' ] && [ "$(cat "$CADDY_TMPFILES")" = 'original tmpfiles' ] || return 1
  cmp -s "$CADDYFILE_PATH" "$FIXTURE/Caddyfile.original" && cmp -s "$ENV_FILE" "$FIXTURE/environment.original"
}

test_ufw_rollback_keeps_existing_rule() {
  printf 'ufw allow 80,443/tcp\n' >"$FIXTURE/ufw.added"
  begin_platform_transaction 0 || return 1
  restore_platform_transaction || return 1
  grep -q '^ufw allow 80,443/tcp$' "$FIXTURE/ufw.added"
}

test_ufw_rollback_removes_only_new_rule() {
  printf 'ufw allow 80,443/tcp\n' >"$FIXTURE/ufw.added"
  begin_platform_transaction 0 || return 1
  : >"$PLATFORM_TXN/new-https-rule"
  restore_platform_transaction || return 1
  [ ! -s "$FIXTURE/ufw.added" ]
}

test_lock_order() {
  acquire_install_locks || return 1
  acquire_install_locks || return 1
  [ "$(cat "$FIXTURE/flock.calls")" = "$(printf '%s\n' '-w 25 -x 9' '-w 90 -x 8')" ] || return 1
  release_install_locks
}

for test in test_active_preserves_runtime test_ready_manual_reuse test_manual_unready_refused test_failed_target_rolls_back test_missing_socket_restores_runtime test_apply_failure_restores_runtime test_validation_keeps_original test_restart_failure_restores_stopped test_fresh_invocation_recovers test_restore_failure_retains_backup test_corrupt_json_rejected test_environment_parser_preserves_multiline test_environment_failure_restores_files test_disk_route_changes_refused test_hidden_path_changes_refused test_failed_marker_prevents_publish test_linked_unit_refused test_total_verification_deadline test_pending_maintenance_prevents_dependency_mutation test_both_socket_overrides_persist_and_restore test_failed_docker_leaves_caddy_and_environment test_local_caddy_ignores_proxy_environment test_all_configuration_snapshots test_ufw_rollback_keeps_existing_rule test_ufw_rollback_removes_only_new_rule test_lock_order; do
  if fixture_case "$test"; then
    PASS=$((PASS + 1)); printf 'PASS %s\n' "$test"
  else
    FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$test" >&2
  fi
done
printf '平台依赖事务：%d 通过，%d 失败\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]
