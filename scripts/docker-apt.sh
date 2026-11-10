#!/usr/bin/env bash
# Docker CE 软件包安装；仅在 Docker 缺失时调用，不下载或执行远端安装脚本。
DOCKER_APT_SOURCES="/etc/apt/sources.list.d/docker.sources"
DOCKER_APT_LIST="/etc/apt/sources.list.d/docker.list"
DOCKER_APT_KEY="/etc/apt/keyrings/docker.asc"
DOCKER_OS_RELEASE="/etc/os-release"
# Docker 官方 Debian/Ubuntu 发布公钥的主指纹，镜像不能自行提供新的信任根。
DOCKER_GPG_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"

docker_repository_candidates() {
  case "${ELYSIAN_DOCKER_MIRROR:-auto}" in
    auto) printf '%s\n' aliyun tuna official ;;
    aliyun|tuna|official) printf '%s\n' "$ELYSIAN_DOCKER_MIRROR" ;;
    *) printf 'ELYSIAN_DOCKER_MIRROR 只接受 auto、aliyun、tuna 或 official\n' >&2; return 1 ;;
  esac
}

docker_repository_base() {
  case "$1" in
    aliyun) printf '%s' https://mirrors.aliyun.com/docker-ce ;;
    tuna) printf '%s' https://mirrors.tuna.tsinghua.edu.cn/docker-ce ;;
    official) printf '%s' https://download.docker.com ;;
    *) return 1 ;;
  esac
}

docker_repository_platform() {
  local ID="" VERSION_CODENAME="" UBUNTU_CODENAME=""
  [ -r "$DOCKER_OS_RELEASE" ] || return 1
  # 只读取宿主系统发行版声明，随后严格校验进入 URL 与 apt 文件的字段。
  . "$DOCKER_OS_RELEASE"
  case "$ID" in ubuntu|debian) DOCKER_APT_DISTRO="$ID" ;; *) printf 'Docker 自动安装仅支持 Ubuntu/Debian\n' >&2; return 1 ;; esac
  DOCKER_APT_CODENAME="${UBUNTU_CODENAME:-$VERSION_CODENAME}"
  [[ "$DOCKER_APT_CODENAME" =~ ^[a-z][a-z0-9]*$ ]] || { printf '无法安全识别 Docker 仓库的发行版代号\n' >&2; return 1; }
  DOCKER_APT_ARCH="$(dpkg --print-architecture)" || return 1
  case "$DOCKER_APT_ARCH" in amd64|arm64) : ;; *) printf '不支持的 Docker 架构：%s\n' "$DOCKER_APT_ARCH" >&2; return 1 ;; esac
}

docker_repository_fetch() {
  curl -fLsS --retry 0 --connect-timeout 5 --max-time 12 --max-filesize 1048576 -o "$2" "$1"
}

docker_verify_repository_key() {
  local key="$1" home="$2" fingerprint
  fingerprint="$(gpg --batch --homedir "$home" --show-keys --with-colons --fingerprint "$key" |
    awk -F: '$1 == "pub" {primary=1} $1 == "fpr" && primary {print $10; primary=0}')" || return 1
  [ "$fingerprint" = "$DOCKER_GPG_FINGERPRINT" ] || { printf 'Docker 发布公钥主指纹不匹配\n' >&2; return 1; }
}

docker_verify_repository_release() {
  local release="$1" codename
  codename="$(awk '$1 == "Codename:" {codename=$2} $1 == "Suite:" {suite=$2} END {print codename ? codename : suite}' "$release")"
  [ "$codename" = "$DOCKER_APT_CODENAME" ] || { printf 'Docker 签名索引发行版不匹配：%s\n' "$codename" >&2; return 1; }
  awk -v architecture="$DOCKER_APT_ARCH" '$1 == "Architectures:" {for(i=2;i<=NF;i++) if($i==architecture) found=1} END {exit !found}' "$release" ||
    { printf 'Docker 签名索引不包含目标架构：%s\n' "$DOCKER_APT_ARCH" >&2; return 1; }
  awk '$1 == "Components:" {for(i=2;i<=NF;i++) if($i=="stable") found=1} END {exit !found}' "$release" ||
    { printf 'Docker 签名索引不包含 stable 频道\n' >&2; return 1; }
}

docker_select_repository() {
  local work="$1" candidates mirror base
  candidates="$(docker_repository_candidates)" || return 1
  mkdir -m 0700 "$work/gnupg" || return 1
  while IFS= read -r mirror; do
    base="$(docker_repository_base "$mirror")/linux/$DOCKER_APT_DISTRO"
    info "检测 Docker apt 源：$mirror（$base）"
    rm -f "$work/docker.asc" "$work/InRelease" "$work/docker.gpg" "$work/Release"
    if docker_repository_fetch "$base/gpg" "$work/docker.asc" >>"$work/probe.log" 2>&1 &&
       docker_verify_repository_key "$work/docker.asc" "$work/gnupg" >>"$work/probe.log" 2>&1 &&
       docker_repository_fetch "$base/dists/$DOCKER_APT_CODENAME/InRelease" "$work/InRelease" >>"$work/probe.log" 2>&1 &&
       gpg --batch --yes --homedir "$work/gnupg" --dearmor --output "$work/docker.gpg" "$work/docker.asc" >>"$work/probe.log" 2>&1 &&
       gpgv --homedir "$work/gnupg" --keyring "$work/docker.gpg" --output "$work/Release" "$work/InRelease" >>"$work/probe.log" 2>&1 &&
       docker_verify_repository_release "$work/Release" >>"$work/probe.log" 2>&1; then
      DOCKER_REPOSITORY_URL="$base"
      DOCKER_REPOSITORY_NAME="$mirror"
      return 0
    fi
    warn "Docker apt 源不可用或签名校验失败：$mirror"
  done <<<"$candidates"
  return 1
}

docker_write_repository_candidate() {
  cat <<EOF
Types: deb
URIs: $DOCKER_REPOSITORY_URL
Suites: $DOCKER_APT_CODENAME
Components: stable
Architectures: $DOCKER_APT_ARCH
Signed-By: $DOCKER_APT_KEY
EOF
}

docker_prepare_repository() {
  local work="$1" file parent asset
  docker_write_repository_candidate >"$work/docker.sources" || return 1
  # 不覆盖未知来源的旧配置，也不制造 Signed-By 冲突。
  if [ -e "$DOCKER_APT_LIST" ] || [ -L "$DOCKER_APT_LIST" ]; then
    printf '存在旧 Docker apt 配置，请先核对后重跑：%s\n' "$DOCKER_APT_LIST" >&2
    return 1
  fi
  for asset in docker-sources docker-key; do
    file="$(platform_asset_path "$asset")"
    platform_no_links "$file" || return 1
    if [ -e "$file" ]; then
      [ -f "$file" ] && [ "$(stat -c '%u' "$file")" = 0 ] &&
        [ -z "$(find "$file" -maxdepth 0 -perm /022 -print)" ] || return 1
      if [ "$asset" = docker-sources ]; then
        cmp -s "$work/docker.sources" "$file" || { printf '既有 Docker apt 源与选择不符，原文件保留：%s\n' "$file" >&2; return 1; }
      else
        docker_verify_repository_key "$file" "$work/gnupg" || return 1
      fi
    fi
  done
  # 两个候选均预检通过后才发布；收据保留安装前不存在的文件及其真实摘要。
  for asset in docker-key docker-sources; do
    file="$(platform_asset_path "$asset")"
    parent="$(dirname "$file")"
    platform_no_links "$parent" || return 1
    if [ ! -e "$parent" ]; then install -d -m 0755 "$parent" || return 1; fi
    [ -d "$parent" ] && [ "$(stat -c '%u' "$parent")" = 0 ] &&
      [ -z "$(find "$parent" -maxdepth 0 -perm /022 -print)" ] || return 1
    if [ ! -e "$file" ]; then
      local source="$work/docker.asc" temporary
      [ "$asset" != docker-sources ] || source="$work/docker.sources"
      temporary="$(mktemp "$parent/.elysian-docker.XXXXXX")" || return 1
      if ! install -m 0644 "$source" "$temporary" || ! ln -T "$temporary" "$file"; then
        rm -f "$temporary"; return 1
      fi
      rm -f "$temporary"
      if platform_private_file "$PLATFORM_RECEIPTS/docker/$asset.absent"; then
        (umask 077; sha256sum "$file" | cut -d ' ' -f 1 >"$PLATFORM_RECEIPTS/docker/$asset.sha256") || return 1
      fi
    fi
  done
}

docker_install_from_repository() {
  local work conflict
  docker_repository_platform || die "无法识别 Docker apt 安装环境。"
  docker_repository_candidates >/dev/null || die "Docker 镜像源配置无效。"
  for conflict in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
    if platform_package_installed "$conflict"; then die "检测到既有运行时软件包 $conflict；请先核对依赖，安装器不会自动删除。"; fi
  done
  command -v gpg >/dev/null 2>&1 && command -v gpgv >/dev/null 2>&1 || die "Docker apt 安装缺少 GPG 校验工具，请安装 gnupg 后重跑。"
  work="$(mktemp -d /tmp/elysian-docker-apt.XXXXXX)" || return 1
  chmod 0700 "$work"
  if ! docker_select_repository "$work"; then
    die "Docker 软件仓库均不可用或校验失败，未修改系统仓库。请检查网络及发行版支持（私有日志：$work/probe.log）。"
  fi
  platform_receipt_begin docker || die "Docker 安装归属记录异常：$PLATFORM_RECEIPTS/docker"
  if ! docker_prepare_repository "$work" >>"$work/install.log" 2>&1; then
    die "Docker apt 配置准备失败，未覆盖既有配置；私有日志：$work/install.log。"
  fi
  info "通过 Docker CE apt 源安装：$DOCKER_REPOSITORY_NAME（$DOCKER_REPOSITORY_URL）"
  if ! run_stage_command "刷新 Docker apt 索引" "$work/install.log" apt-get -o APT::Update::Error-Mode=any -o Acquire::Retries=1 -o Acquire::https::Timeout=15 update ||
     ! run_stage_command "安装 Docker CE" "$work/install.log" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-remove --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; then
    die "Docker apt 安装失败，保留配置和安装记录，不重投或自动换源；请排查后重跑（私有日志：$work/install.log）。"
  fi
  command -v docker >/dev/null 2>&1 || die "软件包安装后仍找不到 docker；私有日志：$work/install.log。"
  platform_receipt_finish docker || die "无法保存 Docker 安装归属记录：$PLATFORM_RECEIPTS/docker"
  rm -rf "$work"
}
