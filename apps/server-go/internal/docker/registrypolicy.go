package docker

import (
	"errors"
	"net/netip"
	"regexp"
	"strings"
)

// 自定义镜像源校验（registryPolicy.ts 逐字移植）：语法（协议、端口、标签、后缀
// 黑名单）＋ DNS 解析全部公网。私网拦截在解析之前（字面 IP/localhost/单标签/
// 保留后缀不发起解析）。

const (
	resolvePublicError = "镜像源无法解析为公网地址"
	httpNotAllowed     = "镜像源须使用 https 协议或省略协议"
	disallowedHost     = "镜像源主机名不合法"
)

var (
	registryCharsPattern = regexp.MustCompile(`^[a-zA-Z0-9.-]+(:\d{1,5})?$`)
	registryPortPattern  = regexp.MustCompile(`^\d{1,5}$`)
	registryBadChars     = regexp.MustCompile(`[/?#@\\]`)
	hostnameLabelPattern = regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$`)
)

var disallowedHostSuffixes = []string{".local", ".internal", ".lan", ".home.arpa"}

// 私网段表（registryPolicy.ts PRIVATE_IPV4_RANGES / PRIVATE_IPV6_RANGES）。
var privateIPv4Ranges = []struct {
	network string
	bits    int
}{
	{"0.0.0.0", 8}, {"10.0.0.0", 8}, {"100.64.0.0", 10}, {"127.0.0.0", 8},
	{"169.254.0.0", 16}, {"172.16.0.0", 12}, {"192.0.0.0", 24}, {"192.0.2.0", 24},
	{"192.168.0.0", 16}, {"198.18.0.0", 15}, {"224.0.0.0", 4}, {"240.0.0.0", 4},
}

var privateIPv6Ranges = []struct {
	network string
	bits    int
}{
	{"::1", 128}, {"fe80::", 10}, {"fc00::", 7}, {"ff00::", 8},
}

// isPublicAddress 公网判定：IPv4 按私网段表；IPv6 私网段表；::ffff:0:0/96 的
// 映射地址按其 IPv4 再查；非 IP 一律非公网。
func isPublicAddress(ip string) bool {
	addr, err := netip.ParseAddr(strings.TrimSpace(ip))
	if err != nil {
		return false
	}
	if addr.Is4In6() {
		addr = addr.Unmap()
	}
	if addr.Is4() {
		for _, r := range privateIPv4Ranges {
			net, err := netip.ParseAddr(r.network)
			if err != nil {
				continue
			}
			prefix := netip.PrefixFrom(net, r.bits)
			if prefix.Contains(addr) {
				return false
			}
		}
		return true
	}
	for _, r := range privateIPv6Ranges {
		net, err := netip.ParseAddr(r.network)
		if err != nil {
			continue
		}
		prefix := netip.PrefixFrom(net, r.bits)
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

// splitHostPort 按「最后一个冒号且其后全为数字」拆 hostname 与展示串。
func splitHostPort(hostWithOptionalPort string) (hostname string, display string) {
	lastColon := strings.LastIndexByte(hostWithOptionalPort, ':')
	if lastColon == -1 {
		return hostWithOptionalPort, hostWithOptionalPort
	}
	maybePort := hostWithOptionalPort[lastColon+1:]
	if registryPortPattern.MatchString(maybePort) {
		return hostWithOptionalPort[:lastColon], hostWithOptionalPort
	}
	return hostWithOptionalPort, hostWithOptionalPort
}

func hostnameLabelCount(hostname string) int {
	count := 0
	for _, label := range strings.Split(hostname, ".") {
		if len(label) > 0 {
			count++
		}
	}
	return count
}

func hasDisallowedHostnameSuffix(hostname string) bool {
	lower := strings.ToLower(hostname)
	for _, suffix := range disallowedHostSuffixes {
		if strings.HasSuffix(lower, suffix) {
			return true
		}
	}
	return false
}

func assertResolvableHostname(hostname string) error {
	if _, err := netip.ParseAddr(hostname); err == nil {
		return errors.New(disallowedHost)
	}
	lower := strings.ToLower(hostname)
	if lower == "localhost" || hostnameLabelCount(hostname) < 2 {
		return errors.New(disallowedHost)
	}
	if hasDisallowedHostnameSuffix(hostname) {
		return errors.New(disallowedHost)
	}
	return nil
}

// parseRegistryInput 校验镜像源语法并归一为 host（可含端口、无协议）。
func parseRegistryInput(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", errors.New(disallowedHost)
	}
	if strings.HasPrefix(trimmed, "http://") {
		return "", errors.New(httpNotAllowed)
	}
	rest := trimmed
	if strings.HasPrefix(rest, "https://") {
		rest = rest[len("https://"):]
	}
	rest = strings.TrimRight(rest, "/")
	if rest == "" {
		return "", errors.New(disallowedHost)
	}
	if registryBadChars.MatchString(rest) || !registryCharsPattern.MatchString(rest) {
		return "", errors.New(disallowedHost)
	}
	hostname, _ := splitHostPort(rest)
	if err := assertResolvableHostname(hostname); err != nil {
		return "", err
	}
	for _, label := range strings.Split(hostname, ".") {
		if !hostnameLabelPattern.MatchString(label) {
			return "", errors.New(disallowedHost)
		}
	}
	port := ""
	if len(rest) > len(hostname) {
		port = rest[len(hostname)+1:]
	}
	if port != "" {
		n, err := atoiOrZero(port)
		if err != nil || n < 1 || n > 65535 {
			return "", errors.New(disallowedHost)
		}
	}
	return rest, nil
}

// isOfficialImageRegistry 在语法校验后识别 Docker Hub 别名；留空使用官方源。
// 仅忽略默认 HTTPS 端口，其他端口仍须按自定义源校验和查询。
func isOfficialImageRegistry(raw string) bool {
	if strings.TrimSpace(raw) == "" {
		return true
	}
	host, err := parseRegistryInput(raw)
	if err != nil {
		return false
	}
	switch strings.TrimSuffix(strings.ToLower(host), ":443") {
	case "registry-1.docker.io", "docker.io", "index.docker.io":
		return true
	default:
		return false
	}
}

// validatedRegistryTarget 校验通过的镜像源目标：host 用于拼引用与 HTTPS URL，
// addresses 用于 HTTPS 建连钉 IP。
type validatedRegistryTarget struct {
	host      string
	addresses []string
}

// validateRegistryTarget 语法 + 解析全部公网。
func validateRegistryTarget(raw string, resolve func(hostname string) ([]string, error)) (validatedRegistryTarget, error) {
	host, err := parseRegistryInput(raw)
	if err != nil {
		return validatedRegistryTarget{}, err
	}
	hostname, _ := splitHostPort(host)
	addresses, err := resolve(hostname)
	if err != nil {
		return validatedRegistryTarget{}, errors.New(resolvePublicError)
	}
	if len(addresses) == 0 {
		return validatedRegistryTarget{}, errors.New(resolvePublicError)
	}
	for _, address := range addresses {
		if !isPublicAddress(address) {
			return validatedRegistryTarget{}, errors.New(resolvePublicError)
		}
	}
	return validatedRegistryTarget{host: host, addresses: addresses}, nil
}

// validateRegistry 校验并返回 host。
func validateRegistry(raw string, resolve func(hostname string) ([]string, error)) (string, error) {
	target, err := validateRegistryTarget(raw, resolve)
	return target.host, err
}
