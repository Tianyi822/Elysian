#!/usr/bin/env bash
# 首次安装及旧源码更新器的迁移入口。下载文件后运行，禁止经管道直接执行。
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo '请使用 sudo bash install-release.sh' >&2; exit 1; }
case "$(uname -m)" in x86_64) release_arch=amd64 ;; aarch64|arm64) release_arch=arm64 ;; *) echo '仅支持 Linux amd64／arm64' >&2; exit 1 ;; esac
[ "$(uname -s)" = Linux ] && command -v apt-get >/dev/null || { echo '安装器仅支持 Debian／Ubuntu Linux' >&2; exit 1; }
release_need=()
command -v python3 >/dev/null || release_need+=(python3)
command -v curl >/dev/null || release_need+=(curl)
[ -f /etc/ssl/certs/ca-certificates.crt ] || release_need+=(ca-certificates)
if [ "${#release_need[@]}" -gt 0 ]; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${release_need[@]}"
fi
release_work="$(mktemp -d /var/tmp/elysian-release-bootstrap.XXXXXX)"
trap 'rm -rf "$release_work"' EXIT
curl --proto '=https' --proto-redir '=https' -fSL --connect-timeout 15 --max-time 60 https://raw.githubusercontent.com/Tianyi822/Elysian/main/scripts/release-download.py -o "$release_work/download.py"
release_commit="$(python3 "$release_work/download.py" download "$release_work/bundle" "$release_arch" "${ELYSIAN_COMMIT:-}")"
ELYSIAN_COMMIT="$release_commit" bash "$release_work/bundle/scripts/install.sh" "$@"
