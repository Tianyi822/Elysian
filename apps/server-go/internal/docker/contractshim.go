package docker

import (
	"errors"
	"regexp"
	"strings"

	"elysian/server/internal/contract"
)

// 契约判据的域内私有等价物（docker 盘点 §8.8：parseImageReference / parseShellWords /
// autoContainerName / isSensitiveEnvKey / 重启策略表 / 终端行列 / 面板端口 /
// Engine API 版本判据）。internal/contract 骨架阶段尚未预置这些判据（contract 包
// 只含容器视图与防火墙类型），本域不得改动公共层，故先以未导出函数在本包内逐字
// 重实现；错误消息是 API 契约的一部分，与 @elysian/contracts 原文逐字一致。
// 已登记 gaps：集成阶段应把它们上收到 internal/contract，供 platform 等域共用。

const (
	// terminalCols / terminalRows 容器终端的固定规格（契约 TERMINAL_COLS/ROWS）。
	terminalCols = 100
	terminalRows = 30
	// panelPort 面板端口（契约 PANEL_PORT）；serverPort 与 TS shared/ports.ts 同值。
	panelPort  = contract.PanelPort
	serverPort = 48101
	// maxShellWords 启动命令分词上限（契约 MAX_SHELL_WORDS）。
	maxShellWords = 256
)

// reservedPortsList 宿主保留端口表（dockerHostDeps.ts:51：22、面板、server）。
func reservedPortsList() []int {
	return []int{22, panelPort, serverPort}
}

// restartPolicyWhitelist 重启策略白名单（契约 RESTART_POLICIES）。
var restartPolicyWhitelist = map[string]bool{
	"no":             true,
	"always":         true,
	"on-failure":     true,
	"unless-stopped": true,
}

// Docker label 常量（go-plan §4.2：elysian.managed / elysian.database 等）。
const (
	labelManaged   = "elysian.managed"
	labelDatabase  = "elysian.database"
	labelTrueValue = "true"
)

var (
	imageRefNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9:_.\-/]*$`)
	imageRefTagPattern  = regexp.MustCompile(`^[a-zA-Z0-9_.\-]+$`)
)

// parsedImageReference 解析成功的镜像引用。
type parsedImageReference struct {
	name string
	tag  string
}

// parseImageReference 把 "redis:8-alpine" 拆成名称与标签（契约 imageReference.ts
// 逐字移植）：名称统一小写，按最后一个冒号拆标签（其后含 / 时视为 registry 端口），
// 缺标签默认 latest。
func parseImageReference(raw string) (parsedImageReference, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return parsedImageReference{}, errors.New("请输入镜像引用，例如 redis:8-alpine")
	}

	lastColon := strings.LastIndex(trimmed, ":")
	afterColon := ""
	if lastColon != -1 {
		afterColon = trimmed[lastColon+1:]
	}
	colonIsTagSeparator := lastColon != -1 && !strings.Contains(afterColon, "/")
	namePart := trimmed
	if colonIsTagSeparator {
		namePart = trimmed[:lastColon]
	}
	name := strings.ToLower(strings.TrimSpace(namePart))
	tag := "latest"
	if colonIsTagSeparator {
		if t := strings.TrimSpace(afterColon); t != "" {
			tag = t
		}
	}

	if name == "" {
		return parsedImageReference{}, errors.New("镜像名称不能为空")
	}
	if !imageRefNamePattern.MatchString(name) {
		return parsedImageReference{}, errors.New("名称仅限小写字母、数字与 : _ . / -，且以字母或数字开头")
	}
	if !imageRefTagPattern.MatchString(tag) {
		return parsedImageReference{}, errors.New("标签仅限字母、数字与 _ . -")
	}
	return parsedImageReference{name: name, tag: tag}, nil
}

// parseShellWords 按 shell 字面规则拆 argv（契约 shellWords.ts 逐字移植）：
// 单引号不转义、双引号支持 \" 转义、反斜杠转义下一字符；未闭合引号与换行报错。
func parseShellWords(input string) ([]string, error) {
	if strings.Contains(input, "\n") || strings.Contains(input, "\r") {
		return nil, errors.New("启动命令不能包含换行")
	}

	isWhitespace := func(ch byte) bool {
		return ch == '\t' || ch == '\n' || ch == '\r' || ch == ' '
	}

	var args []string
	i := 0
	length := len(input)
	for i < length {
		for i < length && isWhitespace(input[i]) {
			i++
		}
		if i >= length {
			break
		}

		word := &strings.Builder{}
		for i < length && !isWhitespace(input[i]) {
			ch := input[i]
			switch ch {
			case '\'':
				i++
				for i < length && input[i] != '\'' {
					word.WriteByte(input[i])
					i++
				}
				if i >= length {
					return nil, errors.New("启动命令含有未闭合的引号")
				}
				i++
			case '"':
				i++
				closed := false
				for i < length {
					inner := input[i]
					if inner == '\\' && i+1 < length {
						word.WriteByte(input[i+1])
						i += 2
						continue
					}
					if inner == '"' {
						i++
						closed = true
						break
					}
					word.WriteByte(inner)
					i++
				}
				if !closed {
					return nil, errors.New("启动命令含有未闭合的引号")
				}
			case '\\':
				if i+1 < length {
					word.WriteByte(input[i+1])
					i += 2
				} else {
					// 末尾孤立反斜杠：TS 循环里 \\ 分支要求 i+1 < len，
					// 不满足时落入默认分支把 '\' 当普通字符。
					word.WriteByte(ch)
					i++
				}
			default:
				word.WriteByte(ch)
				i++
			}
		}

		args = append(args, word.String())
		if len(args) > maxShellWords {
			return nil, errors.New("启动命令参数不能超过 256 个")
		}
	}
	return args, nil
}

// autoContainerName 自动容器名（契约 containers.ts 逐字移植）：镜像名中的 / 换成 -，
// 冲突时追加 -2、-3…（从 2 起）。
func autoContainerName(existing []string, imageName string) string {
	base := strings.ReplaceAll(imageName, "/", "-")
	seq := 2
	name := base
	taken := make(map[string]bool, len(existing))
	for _, e := range existing {
		taken[e] = true
	}
	for taken[name] {
		name = base + "-" + itoa(seq)
		seq++
	}
	return name
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := ""
	for n > 0 {
		digits = string(rune('0'+n%10)) + digits
		n /= 10
	}
	return digits
}

var sensitiveEnvWords = []string{"PASSWORD", "PASSWD", "SECRET", "TOKEN", "CREDENTIAL", "KEY"}

// isSensitiveEnvKey 敏感环境变量键判定（契约 containerFields.ts 逐字移植）。
func isSensitiveEnvKey(key string) bool {
	upper := strings.ToUpper(key)
	for _, word := range sensitiveEnvWords {
		if strings.Contains(upper, word) {
			return true
		}
	}
	return false
}

// checkEngineAPIVersion 按数字比较判定 Engine API 版本 ≥ 1.41
// （dockerTransport.ts isApiVersionSupported 逐字移植；失败文案供 /version 探测
// 与 platform 域共用，上收 internal/contract 后收敛）。
func checkEngineAPIVersion(apiVersion string) bool {
	major, minor, ok := parseVersionPair(apiVersion)
	if !ok {
		return false
	}
	if major > 1 {
		return true
	}
	if major < 1 {
		return false
	}
	return minor >= 41
}

// parseVersionPair 把 "1.44" 拆成 (1, 44)；非数字段按 0 处理（TS NaN 语义）。
func parseVersionPair(version string) (int, int, bool) {
	parts := strings.Split(version, ".")
	major, err := atoiOrZero(parts[0])
	if err != nil {
		return 0, 0, false
	}
	minorPart := "0"
	if len(parts) > 1 {
		minorPart = parts[1]
	}
	minor, err := atoiOrZero(minorPart)
	if err != nil {
		return 0, 0, false
	}
	return major, minor, true
}

func atoiOrZero(s string) (int, error) {
	if s == "" {
		return 0, errors.New("empty")
	}
	n := 0
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ch < '0' || ch > '9' {
			return 0, errors.New("not a number")
		}
		n = n*10 + int(ch-'0')
	}
	return n, nil
}
