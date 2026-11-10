#!/usr/bin/env bash
# 临时路径、真实 GPG/GPGV 及软件包管理桩；不安装宿主软件，也不执行远端脚本。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(mktemp -d /tmp/elysian-docker-apt-test.XXXXXX)"
trap 'gpgconf --homedir "$ROOT/signing" --kill all >/dev/null 2>&1 || true; rm -rf "$ROOT"' EXIT
mkdir -m 0700 "$ROOT/signing"
gpg --batch --homedir "$ROOT/signing" --passphrase '' --quick-generate-key 'Docker apt test <fixture@example.invalid>' ed25519 sign 0 >"$ROOT/generate.log" 2>&1
FINGERPRINT="$(gpg --batch --homedir "$ROOT/signing" --with-colons --list-keys | awk -F: '$1 == "fpr" {print $10; exit}')"
gpg --batch --homedir "$ROOT/signing" --armor --export "$FINGERPRINT" >"$ROOT/key.asc"
printf 'Origin: Docker\nSuite: noble\nArchitectures: amd64 arm64\nComponents: stable\n' >"$ROOT/Release"
gpg --batch --homedir "$ROOT/signing" --clearsign --output "$ROOT/InRelease" "$ROOT/Release"
sed 's/noble/trixie/g' "$ROOT/Release" >"$ROOT/Release.debian"
gpg --batch --homedir "$ROOT/signing" --clearsign --output "$ROOT/InRelease.debian" "$ROOT/Release.debian"
PASS=0
FAIL=0

fixture_case() (
  source "$SCRIPT_DIR/install.sh"
  init_output 0 0
  FIXTURE="$(mktemp -d "$ROOT/case.XXXXXX")"
  PLATFORM_RECEIPTS="$FIXTURE/receipts"
  DOCKER_APT_SOURCES="$FIXTURE/etc/apt/sources.list.d/docker.sources"
  DOCKER_APT_LIST="$FIXTURE/etc/apt/sources.list.d/docker.list"
  DOCKER_APT_KEY="$FIXTURE/etc/apt/keyrings/docker.asc"
  DOCKER_OS_RELEASE="$FIXTURE/os-release"
  DOCKER_GPG_FINGERPRINT="$FINGERPRINT"
  printf 'ID=ubuntu\nVERSION_CODENAME=noble\n' >"$DOCKER_OS_RELEASE"
  : >"$FIXTURE/requests"
  : >"$FIXTURE/apt.calls"
  : >"$FIXTURE/packages"
  unset ELYSIAN_DOCKER_MIRROR
  dpkg() { [ "$1" = --print-architecture ] && printf amd64; }
  dpkg-query() {
    [ "$1" = -W ] && grep -Fxq "$3" "$FIXTURE/packages" || return 1
    printf 'install ok installed'
  }
  apt-get() {
    printf '%s\n' "$*" >>"$FIXTURE/apt.calls"
    [ ! -f "$FIXTURE/apt-fail" ] || return 1
    case " $* " in *' install '*)
      printf 'docker-ce\ndocker-ce-cli\ncontainerd.io\ndocker-buildx-plugin\ndocker-compose-plugin\n' >"$FIXTURE/packages"
      mkdir -p "$FIXTURE/bin"
      printf '#!/bin/sh\nexit 0\n' >"$FIXTURE/bin/docker"
      chmod +x "$FIXTURE/bin/docker" ;;
    esac
  }
  # run_stage_command 会通过 env 调用 apt；桩保持环境赋值参数，禁止宿主包管理器执行。
  run_stage_command() {
    local description="$1" log="$2"
    shift 2
    if [ "$1" = env ]; then shift 2; fi
    "$@" >>"$log" 2>&1
  }
  docker_repository_fetch() {
    printf '%s\n' "$1" >>"$FIXTURE/requests"
    if [[ "$1" = *mirrors.aliyun.com* ]] && [ -f "$FIXTURE/aliyun-fail" ]; then return 35; fi
    if [[ "$1" = *mirrors.tuna.tsinghua.edu.cn* ]] && [ -f "$FIXTURE/tuna-fail" ]; then return 7; fi
    if [ -f "$FIXTURE/all-fail" ]; then return 7; fi
    case "$1" in
      */gpg) cp "$ROOT/key.asc" "$2" ;;
      */InRelease)
        if [[ "$1" = *'/trixie/'* ]]; then cp "$ROOT/InRelease.debian" "$2"; else cp "$ROOT/InRelease" "$2"; fi
        [ ! -f "$FIXTURE/corrupt-release" ] || printf '\ntampered\n' >>"$2" ;;
      *) return 1 ;;
    esac
  }
  export PATH="$FIXTURE/bin:$PATH"
  "$@"
)

test_aliyun_default_and_complete_install() {
  docker_install_from_repository || return 1
  [ "$DOCKER_REPOSITORY_NAME" = aliyun ] && grep -q 'URIs: https://mirrors.aliyun.com/docker-ce/linux/ubuntu' "$DOCKER_APT_SOURCES" || return 1
  grep -q 'Suites: noble' "$DOCKER_APT_SOURCES" && grep -q 'Architectures: amd64' "$DOCKER_APT_SOURCES" || return 1
  grep -q -- '--no-remove --no-install-recommends' "$FIXTURE/apt.calls" && platform_receipt_valid docker || return 1
  [ -f "$PLATFORM_RECEIPTS/docker/docker-sources.sha256" ] && [ -f "$PLATFORM_RECEIPTS/docker/docker-key.sha256" ] && ! grep -q 'get.docker.com' "$FIXTURE/requests"
}

test_auto_falls_back_to_tuna() {
  : >"$FIXTURE/aliyun-fail"
  docker_install_from_repository || return 1
  [ "$DOCKER_REPOSITORY_NAME" = tuna ] && grep -q 'mirrors.tuna.tsinghua.edu.cn/docker-ce/linux/ubuntu' "$DOCKER_APT_SOURCES" &&
    [ "$(wc -l <"$FIXTURE/requests")" -eq 3 ] && ! grep -q 'download.docker.com' "$FIXTURE/requests"
}

test_auto_falls_back_to_official() {
  : >"$FIXTURE/aliyun-fail"
  : >"$FIXTURE/tuna-fail"
  docker_install_from_repository || return 1
  [ "$DOCKER_REPOSITORY_NAME" = official ] && grep -q 'https://download.docker.com/linux/ubuntu' "$DOCKER_APT_SOURCES" &&
    [ "$(wc -l <"$FIXTURE/requests")" -eq 4 ]
}

test_all_sources_fail_before_mutation() {
  : >"$FIXTURE/all-fail"
  if (docker_install_from_repository); then return 1; fi
  [ "$(wc -l <"$FIXTURE/requests")" -eq 3 ] && [ ! -e "$PLATFORM_RECEIPTS" ] &&
    [ ! -e "$DOCKER_APT_SOURCES" ] && [ ! -e "$DOCKER_APT_KEY" ] && [ ! -s "$FIXTURE/apt.calls" ]
}

test_explicit_source_does_not_switch() {
  ELYSIAN_DOCKER_MIRROR=aliyun
  : >"$FIXTURE/aliyun-fail"
  if (docker_install_from_repository); then return 1; fi
  [ "$(wc -l <"$FIXTURE/requests")" -eq 1 ] && [ ! -e "$DOCKER_APT_SOURCES" ] && [ ! -e "$DOCKER_APT_KEY" ] && [ ! -s "$FIXTURE/apt.calls" ]
}

test_bad_key_fingerprint_never_becomes_trusted() {
  DOCKER_GPG_FINGERPRINT=0000000000000000000000000000000000000000
  if (docker_install_from_repository); then return 1; fi
  [ ! -e "$DOCKER_APT_KEY" ] && [ ! -e "$DOCKER_APT_SOURCES" ] && [ ! -s "$FIXTURE/apt.calls" ]
}

test_tampered_repository_signature_is_rejected() {
  # 在签名正文内部改字节，gpgv 必须失败。
  docker_repository_fetch() {
    case "$1" in
      */gpg) cp "$ROOT/key.asc" "$2" ;;
      *) sed 's/Origin: Docker/Origin: attacker/' "$ROOT/InRelease" >"$2" ;;
    esac
  }
  if (docker_install_from_repository); then return 1; fi
  [ ! -e "$DOCKER_APT_SOURCES" ] && [ ! -s "$FIXTURE/apt.calls" ]
}

test_invalid_source_and_platform_before_mutation() {
  ELYSIAN_DOCKER_MIRROR='https://unexpected.invalid'
  if (docker_install_from_repository); then return 1; fi
  [ ! -s "$FIXTURE/requests" ] || return 1
  unset ELYSIAN_DOCKER_MIRROR
  printf 'ID=ubuntu\nVERSION_CODENAME="noble extra"\n' >"$DOCKER_OS_RELEASE"
  if (docker_install_from_repository); then return 1; fi
  [ ! -s "$FIXTURE/requests" ] && [ ! -s "$FIXTURE/apt.calls" ]
}

test_debian_arm64_and_official_selection() {
  printf 'ID=debian\nVERSION_CODENAME=trixie\n' >"$DOCKER_OS_RELEASE"
  dpkg() { printf arm64; }
  ELYSIAN_DOCKER_MIRROR=official
  docker_install_from_repository || return 1
  grep -q 'https://download.docker.com/linux/debian' "$DOCKER_APT_SOURCES" &&
    grep -q 'Suites: trixie' "$DOCKER_APT_SOURCES" && grep -q 'Architectures: arm64' "$DOCKER_APT_SOURCES"
}

test_existing_foreign_repository_is_preserved() {
  mkdir -p "$(dirname "$DOCKER_APT_SOURCES")"
  printf 'foreign repository' >"$DOCKER_APT_SOURCES"
  if (docker_install_from_repository); then return 1; fi
  [ "$(cat "$DOCKER_APT_SOURCES")" = 'foreign repository' ] && [ ! -e "$DOCKER_APT_KEY" ] && [ ! -s "$FIXTURE/apt.calls" ]
}

test_existing_symlink_is_preserved() {
  mkdir -p "$(dirname "$DOCKER_APT_KEY")"
  printf 'foreign key' >"$FIXTURE/foreign"
  ln -s "$FIXTURE/foreign" "$DOCKER_APT_KEY"
  if (docker_install_from_repository); then return 1; fi
  [ -L "$DOCKER_APT_KEY" ] && [ "$(cat "$FIXTURE/foreign")" = 'foreign key' ] && [ ! -e "$DOCKER_APT_SOURCES" ]
}

test_failed_apt_retries_preserve_owned_repository() {
  : >"$FIXTURE/apt-fail"
  if (docker_install_from_repository); then return 1; fi
  [ -f "$DOCKER_APT_SOURCES" ] && [ -f "$DOCKER_APT_KEY" ] && [ "$(wc -l <"$FIXTURE/apt.calls")" -eq 1 ] || return 1
  platform_receipt_finish docker || return 1
  [ -f "$PLATFORM_RECEIPTS/docker/pending" ] && [ ! -e "$PLATFORM_RECEIPTS/docker/complete" ] || return 1
  local digest
  digest="$(cat "$PLATFORM_RECEIPTS/docker/docker-sources.sha256")"
  rm "$FIXTURE/apt-fail"
  docker_install_from_repository || return 1
  platform_receipt_valid docker && [ "$(cat "$PLATFORM_RECEIPTS/docker/docker-sources.sha256")" = "$digest" ]
}

test_existing_runtime_dependency_is_not_removed() {
  printf 'containerd\n' >"$FIXTURE/packages"
  if (docker_install_from_repository); then return 1; fi
  [ ! -s "$FIXTURE/requests" ] && [ ! -s "$FIXTURE/apt.calls" ]
}

for test in test_aliyun_default_and_complete_install test_auto_falls_back_to_tuna test_auto_falls_back_to_official test_all_sources_fail_before_mutation test_explicit_source_does_not_switch test_bad_key_fingerprint_never_becomes_trusted test_tampered_repository_signature_is_rejected test_invalid_source_and_platform_before_mutation test_debian_arm64_and_official_selection test_existing_foreign_repository_is_preserved test_existing_symlink_is_preserved test_failed_apt_retries_preserve_owned_repository test_existing_runtime_dependency_is_not_removed; do
  if fixture_case "$test" >"$ROOT/case.log" 2>&1; then
    PASS=$((PASS+1)); printf 'PASS %s\n' "$test"
  else
    FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$test"; cat "$ROOT/case.log"
  fi
done
printf 'Docker apt 镜像：%s 通过，%s 失败\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]
