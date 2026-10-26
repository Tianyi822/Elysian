package config

import (
	"net/netip"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var imagePattern = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$`)
var idPattern = regexp.MustCompile(`^(profile|grant)-[a-f0-9]{32}$`)
var hostnameLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

func cleanText(value string, max int) bool {
	return value != "" && len(value) <= max && utf8.ValidString(value) && strings.IndexFunc(value, unicode.IsControl) < 0
}

func ValidateProfile(p Profile) error {
	if !cleanText(p.Name, 120) || !imagePattern.MatchString(p.Image) || len(p.Image) > 512 {
		return problem(400, "execution_invalid_profile", "执行配置名称或镜像无效，镜像必须固定为仓库名与完整 SHA-256 摘要")
	}
	if p.Runtime != "python" && p.Runtime != "node" && p.Runtime != "bash" {
		return problem(400, "execution_invalid_runtime", "执行环境只能为 Python、Node 或 Bash")
	}
	if len(p.Command) < 1 || len(p.Command) > 64 {
		return problem(400, "execution_invalid_command", "容器命令必须包含 1 至 64 个参数")
	}
	total := 0
	for i, arg := range p.Command {
		if len(arg) > 4096 || !utf8.ValidString(arg) || strings.ContainsRune(arg, 0) || (i == 0 && arg == "") {
			return problem(400, "execution_invalid_command", "容器命令参数无效")
		}
		total += len(arg)
	}
	if total > 16<<10 {
		return problem(400, "execution_invalid_command", "容器命令参数总长度超过上限")
	}
	if p.TimeoutSeconds < 1 || p.TimeoutSeconds > MaxTimeoutSeconds || p.CPUMillis < 1 || p.CPUMillis > MaxCPUMillis || p.MemoryBytes < 1 || p.MemoryBytes > MaxMemoryBytes || p.PIDs < 1 || p.PIDs > MaxPIDs {
		return problem(400, "execution_invalid_limits", "执行限额只能收紧，不能超过 5 分钟、1 CPU、512 MiB 内存与 128 个进程")
	}
	return nil
}

func fromProfile(in ProfileInput) (Profile, error) {
	p := Profile{Enabled: in.Enabled, Name: strings.TrimSpace(in.Name), Image: in.Image, Runtime: in.Runtime, Command: append([]string(nil), in.Command...), TimeoutSeconds: in.TimeoutSeconds, CPUMillis: in.CPUMillis, MemoryBytes: in.MemoryBytes, PIDs: in.PIDs}
	if p.TimeoutSeconds == 0 {
		p.TimeoutSeconds = MaxTimeoutSeconds
	}
	if p.CPUMillis == 0 {
		p.CPUMillis = MaxCPUMillis
	}
	if p.MemoryBytes == 0 {
		p.MemoryBytes = MaxMemoryBytes
	}
	if p.PIDs == 0 {
		p.PIDs = MaxPIDs
	}
	if len(p.Command) == 0 {
		switch p.Runtime {
		case "python":
			p.Command = []string{"python3"}
		case "node":
			p.Command = []string{"node"}
		case "bash":
			p.Command = []string{"bash"}
		}
	}
	return p, ValidateProfile(p)
}

func validateGrantShape(g Grant, mountRoot string) error {
	if !cleanText(g.Name, 120) || len(g.Directories) > 32 || len(g.Network) > 64 || len(g.PrivateCIDRs) > 32 || len(g.Resources) > 128 {
		return problem(400, "execution_invalid_grant", "授权名称无效或授权条目数量超过上限")
	}
	seen := make(map[string]bool)
	for _, resource := range g.Resources {
		switch resource.Domain {
		case "docker-container", "docker-image", "website", "container-app", "database", "system-user", "firewall", "panel", "platform":
		default:
			return problem(400, "execution_invalid_resource", "平台资源授权的领域无效")
		}
		if !cleanText(resource.ID, 256) || strings.TrimSpace(resource.ID) != resource.ID || strings.ContainsAny(resource.ID, "*?\\") || (resource.Access != "read" && resource.Access != "write") {
			return problem(400, "execution_invalid_resource", "平台资源授权必须固定精确标识和 read 或 write 权限")
		}
		key := "resource:" + resource.Domain + ":" + resource.ID
		if seen[key] {
			return problem(400, "execution_duplicate_resource", "平台资源授权存在重复目标")
		}
		seen[key] = true
	}
	for _, directory := range g.Directories {
		if err := validateDirectoryPath(directory, mountRoot); err != nil {
			return err
		}
		if seen[directory.Path] {
			return problem(400, "execution_duplicate_grant", "目录授权存在重复路径")
		}
		seen[directory.Path] = true
	}
	for _, endpoint := range g.Network {
		if err := validateEndpoint(endpoint); err != nil {
			return err
		}
		key := endpoint.Scheme + "://" + endpoint.Host + ":" + portString(endpoint.Port)
		if seen[key] {
			return problem(400, "execution_duplicate_grant", "网络授权存在重复目标")
		}
		seen[key] = true
	}
	for _, raw := range g.PrivateCIDRs {
		prefix, err := netip.ParsePrefix(raw)
		if err != nil || prefix != prefix.Masked() || prefix.Addr().Is4In6() || !privatePrefix(prefix) {
			return problem(400, "execution_invalid_cidr", "私网授权必须是规范的私有地址网段，不能包含回环、链路本地或元数据地址")
		}
		if seen[raw] {
			return problem(400, "execution_duplicate_grant", "私网授权存在重复网段")
		}
		seen[raw] = true
	}
	return nil
}

// ValidateGrant 同时检查格式与当前目录事实，派发前必须重新调用。
func ValidateGrant(g Grant, mountRoot string) error {
	if err := validateMountRoot(mountRoot); err != nil {
		return err
	}
	if err := validateGrantShape(g, mountRoot); err != nil {
		return err
	}
	for _, directory := range g.Directories {
		f, err := openDirectory(directory.Path, false)
		if err != nil {
			return problem(400, "execution_unsafe_directory", "授权目录不存在、含符号链接或无法安全访问")
		}
		f.Close()
	}
	return nil
}

func fromGrant(in GrantInput, mountRoot string) (Grant, error) {
	g := Grant{Enabled: in.Enabled, Name: strings.TrimSpace(in.Name), Directories: append([]Directory{}, in.Directories...), Network: append([]NetworkEndpoint{}, in.Network...), PrivateCIDRs: append([]string{}, in.PrivateCIDRs...), Resources: append([]Resource{}, in.Resources...)}
	for i := range g.Network {
		g.Network[i].Host = strings.ToLower(g.Network[i].Host)
	}
	return g, ValidateGrant(g, mountRoot)
}

func validateMountRoot(root string) error {
	if !filepath.IsAbs(root) || filepath.Clean(root) != root || root == "/" {
		return problem(400, "execution_invalid_mount_root", "业务挂载根必须是规范的绝对目录且不能是系统根目录")
	}
	return nil
}

func validateDirectoryPath(directory Directory, mountRoot string) error {
	if directory.Access != "ro" && directory.Access != "rw" {
		return problem(400, "execution_invalid_directory", "目录授权只能指定只读或读写")
	}
	p := directory.Path
	if !cleanText(p, 4096) || !filepath.IsAbs(p) || filepath.Clean(p) != p || !strings.HasPrefix(p, mountRoot+string(filepath.Separator)) {
		return problem(400, "execution_invalid_directory", "授权目录必须是业务挂载根下的真实子目录")
	}
	for _, forbidden := range []string{"/etc", "/proc", "/sys", "/dev", "/run", "/root", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/var/run", "/var/log", "/var/cache", "/var/spool", "/var/lib/docker", "/var/lib/containerd", "/var/lib/elysian", "/var/lib/apt", "/var/lib/dpkg", "/var/lib/systemd"} {
		if p == forbidden || strings.HasPrefix(p, forbidden+"/") || strings.HasPrefix(forbidden, p+"/") {
			return problem(400, "execution_unsafe_directory", "系统目录及包含它的上级目录不能授予执行容器")
		}
	}
	for _, component := range strings.Split(p, "/") {
		if component == ".Elysian" || component == ".ssh" || component == ".aws" || component == ".docker" {
			return problem(400, "execution_unsafe_directory", "凭据与面板状态目录不能授予执行容器")
		}
	}
	return nil
}

func validateEndpoint(endpoint NetworkEndpoint) error {
	if (endpoint.Scheme != "https" && endpoint.Scheme != "http") || endpoint.Port < 1 || endpoint.Port > 65535 || len(endpoint.Host) > 253 || endpoint.Host != strings.ToLower(endpoint.Host) {
		return problem(400, "execution_invalid_endpoint", "网络授权必须指定 HTTP 或 HTTPS、精确域名及有效端口")
	}
	if endpoint.Host == "localhost" || strings.HasSuffix(endpoint.Host, ".localhost") || endpoint.Host == "metadata.google.internal" {
		return problem(400, "execution_forbidden_endpoint", "回环与实例元数据地址禁止授权")
	}
	if _, err := netip.ParseAddr(endpoint.Host); err == nil {
		return problem(400, "execution_invalid_endpoint", "网络授权必须使用精确域名，不能直接指定 IP 地址")
	}
	parts := strings.Split(endpoint.Host, ".")
	if len(parts) < 2 {
		return problem(400, "execution_invalid_endpoint", "网络授权必须使用完整域名")
	}
	for _, part := range parts {
		if !hostnameLabel.MatchString(part) {
			return problem(400, "execution_invalid_endpoint", "网络授权域名无效，不允许通配符")
		}
	}
	return nil
}

var privateRanges = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("172.16.0.0/12"), netip.MustParsePrefix("192.168.0.0/16"), netip.MustParsePrefix("fc00::/7")}
var forbiddenRanges = []netip.Prefix{netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("168.63.129.16/32"), netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2002::/16"), netip.MustParsePrefix("64:ff9b::/96"), netip.MustParsePrefix("64:ff9b:1::/48"), netip.MustParsePrefix("2001::/32"), netip.MustParsePrefix("fd00:ec2::254/128")}

func privatePrefix(prefix netip.Prefix) bool {
	for _, forbidden := range forbiddenRanges {
		if prefix.Overlaps(forbidden) {
			return false
		}
	}
	for _, allowed := range privateRanges {
		if prefix.Bits() >= allowed.Bits() && allowed.Contains(prefix.Addr()) {
			return true
		}
	}
	return false
}

// CheckNetworkAddress 校验一次连接所使用的固定 DNS 结果。调用方必须逐个检查
// 解析结果并固定实际拨号地址；重定向与新连接须重新校验，不能随后再按域名拨号。
func CheckNetworkAddress(grant Grant, endpoint NetworkEndpoint, addr netip.Addr) error {
	if !grant.Enabled {
		return problem(403, "execution_grant_disabled", "执行授权已停用")
	}
	if err := validateEndpoint(endpoint); err != nil {
		return err
	}
	authorized := false
	for _, allowed := range grant.Network {
		if allowed == endpoint {
			authorized = true
			break
		}
	}
	if !authorized {
		return problem(403, "execution_network_denied", "目标域名、协议或端口未获得授权")
	}
	addr = addr.Unmap()
	if err := checkNetworkAddress(addr); err != nil {
		return err
	}
	if addr.IsPrivate() {
		for _, raw := range grant.PrivateCIDRs {
			prefix, err := netip.ParsePrefix(raw)
			if err == nil && privatePrefix(prefix) && prefix.Contains(addr) {
				return nil
			}
		}
		return problem(403, "execution_private_network_denied", "目标解析到未获授权的私网地址")
	}
	return nil
}

// CheckPublicNetworkAddress 与执行代理共用特殊地址禁区，但不接受私网授权。
// 调用方必须检查所有 DNS 结果，并固定实际拨号 IP，不能再次按域名解析。
func CheckPublicNetworkAddress(addr netip.Addr) error {
	addr = addr.Unmap()
	if err := checkNetworkAddress(addr); err != nil {
		return err
	}
	if addr.IsPrivate() {
		return problem(403, "execution_private_network_denied", "私网地址禁止访问")
	}
	// IsGlobalUnicast 也会接受废弃站点本地、IPv4 兼容等非公网 IPv6。
	// 公网读取保守限定到全球单播前缀，执行器已有的显式授权语义不变。
	if addr.Is6() && !netip.MustParsePrefix("2000::/3").Contains(addr) {
		return problem(403, "execution_network_denied", "非公网 IPv6 地址禁止访问")
	}
	return nil
}

func checkNetworkAddress(addr netip.Addr) error {
	if !addr.IsValid() || addr.Zone() != "" || !addr.IsGlobalUnicast() || addr.IsLoopback() || addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() {
		return problem(403, "execution_network_denied", "回环、链路本地、元数据与特殊网络地址禁止访问")
	}
	for _, forbidden := range forbiddenRanges {
		if forbidden.Contains(addr) {
			return problem(403, "execution_network_denied", "回环、链路本地、元数据与特殊网络地址禁止访问")
		}
	}
	return nil
}
