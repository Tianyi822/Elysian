package platform

import (
	"encoding/base64"
	"errors"
	"regexp"
	"strings"
	"sync"
	"time"
)

// 安装步骤编排（dependencySetup.ts 逐字移植）：把「安装 Docker / 安装 Caddy」拆成
// 固定步骤，每一步要么短路由过（已经完成），要么在宿主上跑一段常量脚本。确认通道
// 不在这里：那一步只是重新探测。同时只允许一步在跑，避免两个 apt 叠在一起。

// caddySocketPathPattern configure 步骤的目标 socket 形状。
var caddySocketPathPattern = regexp.MustCompile(`^/run/caddy/[A-Za-z0-9._-]+\.sock$`)

// b64PayloadPattern 脚本回传的 base64 载荷（容忍空串）。
var b64PayloadPattern = regexp.MustCompile(`ELYSIAN_B64:([A-Za-z0-9+/=]*)`)

// 清洗用的控制字符与 ELYSIAN_ 哨兵（failureMessage）。
var (
	controlCharsPattern    = regexp.MustCompile(`[\x{0000}-\x{001f}\x{007f}]`)
	elysianSentinelPattern = regexp.MustCompile(`ELYSIAN_[A-Z0-9_]+`)
)

// 步骤超时（毫秒 → Go Duration）。
const (
	stepTimeoutInstallDocker = 240 * time.Second
	stepTimeoutInstallCaddy  = 180 * time.Second
	stepTimeoutConfigure     = 30 * time.Second
	stepTimeoutEnable        = 90 * time.Second
)

// 各步成功文案。
const (
	dockerInstallDone    = "Docker 已安装"
	dockerInstallAlready = "Docker 已经在运行"
	dockerEnableMessage  = "Docker 已设为开机自启"
	caddyInstallDone     = "Caddy 已安装"
	caddyInstallAlready  = "Caddy 已经装好"
	caddyEnableMessage   = "Caddy 已启动"
	configureDone        = "管理端点已写入"
	configureAlready     = "管理端点已是目标地址"
)

// setupResult 一步安装的结果（契约 DependencySetupResult）；键序即 JSON 序。失败也是
// 422 的中文原因，不携带宿主命令原文。
type setupResult struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

// setupService 安装编排入口（测试注入面）。
type setupService interface {
	Run(target, step string) setupResult
}

// hostCommandResult 宿主命令执行结果。
type hostCommandResult struct {
	Code   int
	Output string
}

// hostCommandError 宿主执行失败：message 原样透传（不追加「这一步没有完成」）。
type hostCommandError struct{ message string }

func (e *hostCommandError) Error() string { return e.message }

// hostCommandRunner 宿主命令执行器接口（测试注入面）。
type hostCommandRunner interface {
	run(script string, timeout time.Duration) (hostCommandResult, error)
}

// dependencySetupOptions 编排依赖：host 执行器与目标 socket 路径来源。
type dependencySetupOptions struct {
	host       hostCommandRunner
	socketPath func() string
}

type dependencySetup struct {
	opts dependencySetupOptions

	mu   sync.Mutex
	busy bool
}

func newDependencySetup(opts dependencySetupOptions) *dependencySetup {
	// socketPath 缺省回落部署缺省路径（对齐 TS options.socketPath ?? resolveCaddySocketPath）。
	if opts.socketPath == nil {
		opts.socketPath = func() string { return defaultCaddySocketPath }
	}
	return &dependencySetup{opts: opts}
}

// Run 执行一步安装。busy 单飞：占用期间新请求立即失败（对齐 TS 进程内标志）。
func (s *dependencySetup) Run(target, step string) setupResult {
	s.mu.Lock()
	if s.busy {
		s.mu.Unlock()
		return setupResult{OK: false, Message: setupFailureBusy}
	}
	s.busy = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.busy = false
		s.mu.Unlock()
	}()
	result, err := s.execute(target, step)
	if err != nil {
		var hce *hostCommandError
		if errors.As(err, &hce) {
			// HostCommandError 原样透传 message。
			return setupResult{OK: false, Message: hce.message}
		}
		// 意外异常不把宿主路径带回（dependencySetup.test.ts:112-118）。
		return setupResult{OK: false, Message: setupFailureGeneric}
	}
	return result
}

func (s *dependencySetup) execute(target, step string) (setupResult, error) {
	switch {
	case target == "docker" && step == "install":
		result, err := s.opts.host.run(dockerInstallScript, stepTimeoutInstallDocker)
		if err != nil {
			return setupResult{}, err
		}
		return interpret(result, dockerInstallDone, dockerInstallAlready), nil
	case target == "docker" && step == "enable":
		result, err := s.opts.host.run(dockerEnableScript, stepTimeoutEnable)
		if err != nil {
			return setupResult{}, err
		}
		return interpret(result, dockerEnableMessage, dockerEnableMessage), nil
	case target == "caddy" && step == "install":
		result, err := s.opts.host.run(caddyInstallScript, stepTimeoutInstallCaddy)
		if err != nil {
			return setupResult{}, err
		}
		return interpret(result, caddyInstallDone, caddyInstallAlready), nil
	case target == "caddy" && step == "configure":
		return s.configure()
	case target == "caddy" && step == "enable":
		result, err := s.opts.host.run(caddyEnableScript, stepTimeoutEnable)
		if err != nil {
			return setupResult{}, err
		}
		return interpret(result, caddyEnableMessage, caddyEnableMessage), nil
	default:
		return setupResult{OK: false, Message: setupFailureStep}, nil
	}
}

// configure 配置管理通道：读现有 Caddyfile → 收全局段 admin 指令 → 已是目标地址则
// 零写，否则写回（写入脚本只携带 base64）。
func (s *dependencySetup) configure() (setupResult, error) {
	socketPath := s.opts.socketPath()
	// 路径校验先行：非法路径不碰宿主。
	if strings.Contains(socketPath, "..") || !caddySocketPathPattern.MatchString(socketPath) {
		return setupResult{OK: false, Message: setupFailureSocketPath}, nil
	}
	current, err := s.readCaddyfile()
	if err != nil {
		return setupResult{}, err
	}
	next, err := ensureCaddyAdminSocket(current, socketPath)
	if err != nil {
		if errors.Is(err, errCaddyfileGlobalUnclosed) {
			return setupResult{OK: false, Message: caddyfileGlobalUnclosed}, nil
		}
		return setupResult{OK: false, Message: setupFailureGeneric}, nil
	}
	if next == withTrailingNewline(strings.ReplaceAll(current, "\r\n", "\n")) {
		return setupResult{OK: true, Message: configureAlready}, nil
	}
	written, err := s.opts.host.run(writeCaddyfileScript(next), stepTimeoutConfigure)
	if err != nil {
		return setupResult{}, err
	}
	return interpret(written, configureDone, configureAlready), nil
}

// readCaddyfile 读回宿主 Caddyfile：非零退出按 failureMessage 归因；输出含
// ELYSIAN_B64 载荷则解码，含 ELYSIAN_EMPTY 则空串，都对不上按通用失败收口。
func (s *dependencySetup) readCaddyfile() (string, error) {
	result, err := s.opts.host.run(readCaddyfileScript, stepTimeoutConfigure)
	if err != nil {
		return "", err
	}
	if result.Code != 0 {
		return "", &hostCommandError{failureMessage(result.Output)}
	}
	if matched := b64PayloadPattern.FindStringSubmatch(result.Output); matched != nil {
		payload, err := decodeBase64Lenient(matched[1])
		if err != nil {
			return "", &hostCommandError{setupFailureGeneric}
		}
		return payload, nil
	}
	if strings.Contains(result.Output, "ELYSIAN_EMPTY") {
		return "", nil
	}
	return "", &hostCommandError{setupFailureGeneric}
}

// decodeBase64Lenient 解码脚本回传的 base64 载荷：标准编码优先，无 padding 时容忍
// raw 解码（对齐 Buffer.from 的宽松语义）。
func decodeBase64Lenient(payload string) (string, error) {
	if data, err := base64.StdEncoding.DecodeString(payload); err == nil {
		return string(data), nil
	}
	data, err := base64.RawStdEncoding.DecodeString(payload)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// failureMessage 把脚本输出折叠成一句中文失败原因：已知失败句子串命中即原样返回；
// 否则剥控制字符与 ELYSIAN_ 哨兵、空白折叠、trim 后取尾部 180 字符（rune 语义，
// 等价 JS 按字符截断），空则通用失败句。
func failureMessage(output string) string {
	for _, known := range setupKnownFailures {
		if strings.Contains(output, known) {
			return known
		}
	}
	cleaned := controlCharsPattern.ReplaceAllString(output, " ")
	cleaned = elysianSentinelPattern.ReplaceAllString(cleaned, " ")
	collapsed := strings.Join(strings.Fields(cleaned), " ")
	tail := truncateTailRunes(collapsed, 180)
	if tail == "" {
		return setupFailureGeneric
	}
	return setupFailureGeneric + "：" + tail
}

// truncateTailRunes 取字符串尾部最多 n 个字符（rune 语义；按字节会切碎中文）。
func truncateTailRunes(value string, n int) string {
	runes := []rune(value)
	if len(runes) <= n {
		return value
	}
	return string(runes[len(runes)-n:])
}

// interpret 脚本输出解释：ELYSIAN_ALREADY → already 文案；退出码 0 → done 文案；
// 其余按 failureMessage 归因。
func interpret(result hostCommandResult, done, already string) setupResult {
	if strings.Contains(result.Output, "ELYSIAN_ALREADY") {
		return setupResult{OK: true, Message: already}
	}
	if result.Code == 0 {
		return setupResult{OK: true, Message: done}
	}
	return setupResult{OK: false, Message: failureMessage(result.Output)}
}

// withTrailingNewline 空串或已以换行结尾原样返回，否则补一个尾换行。
func withTrailingNewline(value string) string {
	if value == "" || strings.HasSuffix(value, "\n") {
		return value
	}
	return value + "\n"
}
