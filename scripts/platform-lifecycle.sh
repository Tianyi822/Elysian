#!/usr/bin/env bash
# 安装器自己的依赖收据；不 source 收据内容，不从收据接受任意包名或删除路径。
PLATFORM_RECEIPTS="${PLATFORM_RECEIPTS:-/var/lib/elysian-installer}"
PLATFORM_LIFECYCLE_LOCK="${PLATFORM_LIFECYCLE_LOCK:-/run/lock/elysian-installer.lock}"

platform_lifecycle_lock() {
  platform_no_links "$PLATFORM_LIFECYCLE_LOCK" || return 1
  if [ ! -e "$PLATFORM_LIFECYCLE_LOCK" ]; then
    (umask 077; set -C; : >"$PLATFORM_LIFECYCLE_LOCK") || return 1
  fi
  platform_private_file "$PLATFORM_LIFECYCLE_LOCK" || return 1
  exec 7>>"$PLATFORM_LIFECYCLE_LOCK"
  flock -w 25 -x 7
}

platform_packages() {
  case "$1" in
    caddy) printf '%s\n' caddy ;;
    docker) printf '%s\n' docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras ;;
    *) return 1 ;;
  esac
}

platform_asset_path() {
  case "$1" in
    caddy-list) printf '%s' "${CADDY_APT_LIST:-/etc/apt/sources.list.d/caddy-stable.list}" ;;
    caddy-key) printf '%s' "${CADDY_KEYRING:-/usr/share/keyrings/caddy-stable-archive-keyring.gpg}" ;;
    docker-list) printf '%s' /etc/apt/sources.list.d/docker.list ;;
    docker-sources) printf '%s' /etc/apt/sources.list.d/docker.sources ;;
    docker-key) printf '%s' /etc/apt/keyrings/docker.asc ;;
    docker-key-gpg) printf '%s' /etc/apt/keyrings/docker.gpg ;;
    *) return 1 ;;
  esac
}

platform_assets() {
  case "$1" in
    caddy) printf '%s\n' caddy-list caddy-key ;;
    docker) printf '%s\n' docker-list docker-sources docker-key docker-key-gpg ;;
    *) return 1 ;;
  esac
}

platform_no_links() {
  local path="$1"
  case "$path" in /*) : ;; *) return 1 ;; esac
  case "$path" in *'/../'*|*/..|*'/./'*|*/.) return 1 ;; esac
  while [ "$path" != / ]; do
    [ ! -L "$path" ] || return 1
    path="$(dirname "$path")"
  done
}

platform_private_dir() {
  platform_no_links "$1" && [ -d "$1" ] && [ "$(stat -c '%u:%a' "$1")" = 0:700 ]
}

platform_private_file() {
  platform_no_links "$1" && [ -f "$1" ] && [ "$(stat -c '%u:%a:%h' "$1")" = 0:600:1 ]
}

platform_package_installed() {
  [ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null)" = 'install ok installed' ]
}

platform_package_present() {
  case "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null)" in
    'install ok installed'|'deinstall ok config-files') return 0 ;;
    *) return 1 ;;
  esac
}

platform_explicit_legacy() {
  case ",${UNINSTALL_LEGACY_COMPONENTS:-}," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

platform_removal_packages() {
  local package
  if platform_explicit_legacy "$1"; then
    while IFS= read -r package; do
      if platform_package_present "$package"; then printf '%s\n' "$package"; fi
    done < <(platform_packages "$1")
  else
    platform_receipt_valid "$1" || return 1
    cat "$PLATFORM_RECEIPTS/$1/packages"
  fi
}

platform_legacy_path_removable() {
  platform_explicit_legacy "$1" && platform_no_links "$2" && [ -e "$2" ] &&
    [ "$(stat -c '%u' "$2")" = 0 ] && [ -z "$(find "$2" -maxdepth 0 -perm /022 -print)" ]
}

platform_remove_receipt() {
  local dir="$PLATFORM_RECEIPTS/$1"
  [ -e "$dir" ] || [ -L "$dir" ] || return 0
  platform_private_dir "$PLATFORM_RECEIPTS" && platform_private_dir "$dir" || return 1
  rm -rf "$dir" || return 1
  rmdir "$PLATFORM_RECEIPTS" 2>/dev/null || true
}

platform_receipt_valid() {
  platform_packages "$1" >/dev/null || return 1
  local dir="$PLATFORM_RECEIPTS/$1" package
  platform_private_dir "$PLATFORM_RECEIPTS" && platform_private_dir "$dir" &&
    platform_private_file "$dir/complete" && [ "$(cat "$dir/complete")" = elysian-platform/v1 ] &&
    platform_private_file "$dir/packages" || return 1
  [ "$(wc -c <"$dir/packages")" -le 1024 ] || return 1
  [ -s "$dir/packages" ] || return 1
  while IFS= read -r package || [ -n "$package" ]; do
    platform_packages "$1" | grep -Fxq "$package" || return 1
  done <"$dir/packages"
}

platform_receipt_begin() {
  local component="$1" dir="$PLATFORM_RECEIPTS/$1" package asset path
  platform_packages "$component" >/dev/null || return 1
  platform_no_links "$PLATFORM_RECEIPTS" || return 1
  if [ ! -e "$PLATFORM_RECEIPTS" ]; then (umask 077; mkdir "$PLATFORM_RECEIPTS") || return 1; fi
  platform_private_dir "$PLATFORM_RECEIPTS" || return 1
  if [ -e "$dir" ] || [ -L "$dir" ]; then
    # 旧收据绝不覆盖：避免重装把后加的业务配置收编为可删除的初始配置。
    platform_receipt_valid "$component" || return 1
    return 0
  fi
  (umask 077; mkdir "$dir" && : >"$dir/before" && : >"$dir/pending") || return 1
  while IFS= read -r package; do
    if platform_package_installed "$package"; then printf '%s\n' "$package" >>"$dir/before" || return 1; fi
  done < <(platform_packages "$component")
  while IFS= read -r asset; do
    path="$(platform_asset_path "$asset")"
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then (umask 077; : >"$dir/$asset.absent") || return 1; fi
  done < <(platform_assets "$component")
}

platform_record_tool() {
  local tool="$1" binary="$2" dir="$PLATFORM_RECEIPTS/$1"
  case "$tool:$binary" in go:/usr/local/go/bin/go|bun:/usr/local/bin/bun) : ;; *) return 1 ;; esac
  platform_no_links "$PLATFORM_RECEIPTS" && platform_no_links "$binary" || return 1
  if [ ! -e "$PLATFORM_RECEIPTS" ]; then (umask 077; mkdir "$PLATFORM_RECEIPTS") || return 1; fi
  platform_private_dir "$PLATFORM_RECEIPTS" || return 1
  if [ ! -e "$dir" ]; then (umask 077; mkdir "$dir") || return 1; fi
  platform_private_dir "$dir" || return 1
  if [ -e "$dir/binary.sha256" ] || [ -L "$dir/binary.sha256" ]; then platform_private_file "$dir/binary.sha256" || return 1; fi
  (umask 077; sha256sum "$binary" | cut -d ' ' -f 1 >"$dir/binary.sha256")
}

platform_tool_owned() {
  local dir="$PLATFORM_RECEIPTS/$1" binary="$2"
  platform_private_dir "$PLATFORM_RECEIPTS" && platform_private_dir "$dir" &&
    platform_private_file "$dir/binary.sha256" && platform_no_links "$binary" && [ -f "$binary" ] &&
    [ "$(sha256sum "$binary" | cut -d ' ' -f 1)" = "$(cat "$dir/binary.sha256")" ]
}

platform_receipt_finish() {
  local component="$1" dir="$PLATFORM_RECEIPTS/$1" package asset path
  if platform_receipt_valid "$component"; then return 0; fi
  platform_private_dir "$PLATFORM_RECEIPTS" && platform_private_dir "$dir" &&
    platform_private_file "$dir/before" && platform_private_file "$dir/pending" || return 1
  local name
  for name in packages complete; do
    if [ -e "$dir/$name" ] || [ -L "$dir/$name" ]; then platform_private_file "$dir/$name" || return 1; fi
  done
  (umask 077; : >"$dir/packages") || return 1
  while IFS= read -r package; do
    if ! grep -Fxq "$package" "$dir/before" && platform_package_installed "$package"; then
      printf '%s\n' "$package" >>"$dir/packages" || return 1
    fi
  done < <(platform_packages "$component")
  while IFS= read -r asset; do
    path="$(platform_asset_path "$asset")"
    if platform_private_file "$dir/$asset.absent" && platform_no_links "$path" && [ -f "$path" ]; then
      if [ -e "$dir/$asset.sha256" ] || [ -L "$dir/$asset.sha256" ]; then platform_private_file "$dir/$asset.sha256" || return 1; fi
      (umask 077; sha256sum "$path" | cut -d ' ' -f 1 >"$dir/$asset.sha256") || return 1
    fi
  done < <(platform_assets "$component")
  (umask 077; printf '%s\n' elysian-platform/v1 >"$dir/complete") || return 1
  rm -f "$dir/pending" || return 1
  # 无新增包表示这是修复系统原有包，不能取得卸载归属。
  if [ ! -s "$dir/packages" ]; then rm -rf "$dir"; rmdir "$PLATFORM_RECEIPTS" 2>/dev/null || true; fi
}

platform_purge_packages() { # 先模拟；依赖求解若还会移除其它包则拒绝，不使用 autoremove。
  local component="$1" log="$2" package removed simulation selected
  local -a packages=()
  selected="$(platform_removal_packages "$component")" || return 1
  while IFS= read -r package; do
    [ -n "$package" ] || continue
    if platform_package_present "$package"; then packages+=("$package"); fi
  done <<<"$selected"
  [ "${#packages[@]}" -gt 0 ] || return 0
  simulation="$(LC_ALL=C apt-get --simulate purge "${packages[@]}" 2>"$log")" || return 1
  printf '%s\n' "$simulation" >>"$log"
  while IFS= read -r removed; do
    [ -z "$removed" ] && continue
    printf '%s\n' "${packages[@]}" | grep -Fxq "${removed%%:*}" || return 1
  done < <(printf '%s\n' "$simulation" | awk '$1 == "Remv" || $1 == "Purg" {print $2}')
  # dpkg 只操作精确清单，依赖冲突会拒绝；避免模拟与执行之间其他 apt 事务扩大移除范围。
  LC_ALL=C DEBIAN_FRONTEND=noninteractive dpkg --purge -- "${packages[@]}" >>"$log" 2>&1 || return 1
  for package in "${packages[@]}"; do if platform_package_present "$package"; then return 1; fi; done
}

platform_remove_assets() {
  local component="$1" asset path digest result=0
  platform_receipt_valid "$component" || platform_explicit_legacy "$component" || return 1
  while IFS= read -r asset; do
    path="$(platform_asset_path "$asset")"
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then continue; fi
    if platform_explicit_legacy "$component"; then
      if platform_legacy_path_removable "$component" "$path" && [ -f "$path" ]; then
        rm -f "$path" || result=1
      else
        warn "旧组件源或公钥路径、归属或权限异常，保留：$path"
        result=1
      fi
    # 普通卸载仅删安装前不存在且内容未被别人改动的源与公钥。
    elif platform_private_file "$PLATFORM_RECEIPTS/$component/$asset.sha256"; then
      digest="$(cat "$PLATFORM_RECEIPTS/$component/$asset.sha256")"
      if platform_no_links "$path" && [ -f "$path" ] && [ "$(sha256sum "$path" | cut -d ' ' -f 1)" = "$digest" ]; then
        rm -f "$path" || result=1
      else
        warn "依赖源或公钥已改变，保留：$path"
        result=1
      fi
    fi
  done < <(platform_assets "$component")
  return "$result"
}
