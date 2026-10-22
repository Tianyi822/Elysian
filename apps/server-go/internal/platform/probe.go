package platform

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
)

// 依赖探测（dependencyProbe.ts 逐字移植）：给定 socket 路径，现场探测 Docker Engine
// 与 Caddy 管理通道的就绪性。零新通道——docker 复用容器片的版本探针
// （assertEngineApi ≥1.41），caddy 复用网站片的通道探测（CurrentConfig）。纯读：
// 不执行安装、不写系统文件；每次探测都新建 transport 与 caddy 对象（两者只是
// socketPath 的闭包封装，无连接无状态），缓存结果反而会让「重新检测」拿不到新事实。

// Docker 连接类失败的固定中文 detail：未安装或未接通不逐码区分，唯一文案的唯一字面量。
const dockerUnavailableDetail = "Docker 未安装或未接通"

// 非连接类系统错误（errno 如 ENOTSOCK、ETIMEDOUT——socket 路径指向非 socket 文件、
// 连接中途系统级失败）的固定中文 detail：此类错误的消息形如
// `connect ENOTSOCK <宿主绝对路径>`，属于内嵌宿主路径的非受控文本，不逐字透传。
const dockerSystemErrorDetail = "Docker 连接异常"

// Caddy 侧同口径的系统错误固定文案（errno 经 CaddyChannelError.Code 辨别）。
const caddySystemErrorDetail = "Caddy 连接异常"

// engineAPIVersionTooLow assertEngineApi 的逐字契约文案。
// engineAPIVersionTooLow 版本过低逐字文案（唯一事实源在 contract，docker 探测共用）。
const engineAPIVersionTooLow = contract.EngineAPITooLowMessage

// 探测请求形状（dockerTransport.ts assertEngineApi：GET /version，3s / 1 MiB）。
const (
	probeVersionTimeout  = 3 * time.Second
	probeVersionMaxBytes = 1_048_576
)

const (
	minAPIMajor = 1
	minAPIMinor = 41
)

// 探测状态取值（契约 DEPENDENCY_PROBE_STATES）。
const (
	probeStateOK      = "ok"
	probeStateMissing = "missing"
	probeStateError   = "error"
)

// dependencyProbe 单通道探测结论（契约 DependencyProbe）；ok 时 detail 恒为 null。
type dependencyProbe struct {
	State  string  `json:"state"`
	Detail *string `json:"detail"`
}

// dependencyProbeReport 依赖探测报告（契约 DependencyProbeReport）；键序即 JSON 序。
type dependencyProbeReport struct {
	Docker dependencyProbe `json:"docker"`
	Caddy  dependencyProbe `json:"caddy"`
}

// probeService 探测入口（测试注入面）。
type probeService interface {
	Probe() dependencyProbeReport
}

// prober 探测实现：两探测并行（最坏耗时 5 秒，串行会放大到 8 秒）；报告只含事实，
// 探测结果只驱动前端状态展示与入口可见性，安装由安装脚本代为完成。
type prober struct {
	createTransport func(socketPath string) seam.DockerTransport
	createCaddy     func(socketPath string) seam.CaddyAdmin
	dockerSocket    string
	caddySocket     string
}

// Probe 现场探测一次：每次调用都经工厂新建 transport 与 caddy 对象。
func (p prober) Probe() dependencyProbeReport {
	var (
		wg     sync.WaitGroup
		docker dependencyProbe
		caddy  dependencyProbe
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		docker = probeDocker(context.Background(), p.createTransport(p.dockerSocket))
	}()
	go func() {
		defer wg.Done()
		caddy = probeCaddy(context.Background(), p.createCaddy(p.caddySocket))
	}()
	wg.Wait()
	return dependencyProbeReport{Docker: docker, Caddy: caddy}
}

// probeDocker 经版本探针就绪性判定；失败按错误形态归类为 missing/error。
func probeDocker(ctx context.Context, transport seam.DockerTransport) dependencyProbe {
	err := assertEngineAPI(ctx, transport)
	if err == nil {
		return dependencyProbe{State: probeStateOK}
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		if isConnectionErrno(errno) {
			return dependencyProbe{State: probeStateMissing, Detail: strPtr(dockerUnavailableDetail)}
		}
		return dependencyProbe{State: probeStateError, Detail: strPtr(dockerSystemErrorDetail)}
	}
	return dependencyProbe{State: probeStateError, Detail: strPtr(err.Error())}
}

// probeCaddy 经通道就绪性判定；CaddyChannelError.Unavailable → missing（缺装），
// Code 带系统 errno（非连接类）→ 固定文案不透传宿主路径，其余 → 引擎消息原样。
func probeCaddy(ctx context.Context, caddy seam.CaddyAdmin) dependencyProbe {
	_, err := caddy.CurrentConfig(ctx)
	if err == nil {
		return dependencyProbe{State: probeStateOK}
	}
	if err.Unavailable {
		return dependencyProbe{State: probeStateMissing, Detail: strPtr(seam.CaddyChannelUnavailableDetail)}
	}
	if err.Code != "" {
		return dependencyProbe{State: probeStateError, Detail: strPtr(caddySystemErrorDetail)}
	}
	return dependencyProbe{State: probeStateError, Detail: strPtr(err.Message)}
}

// isConnectionErrno 连接类错误码集合（与 websitesCaddy 的 CONNECTION_ERROR_CODES
// 同集，不逐码对外区分）。
func isConnectionErrno(errno syscall.Errno) bool {
	switch errno {
	case syscall.ENOENT, syscall.EACCES, syscall.ECONNREFUSED:
		return true
	}
	return false
}

// assertEngineAPI GET /version 并校验 ApiVersion ≥ 1.41（dockerTransport.ts
// assertEngineApi 逐字移植）。
func assertEngineAPI(ctx context.Context, transport seam.DockerTransport) error {
	response, err := transport.Request(ctx, seam.EngineRequest{
		Method:   http.MethodGet,
		Path:     "/version",
		Timeout:  probeVersionTimeout,
		MaxBytes: probeVersionMaxBytes,
	})
	if err != nil {
		return err
	}
	apiVersion, err := apiVersionOf(response.Body)
	if err != nil {
		return err
	}
	// 缺字段或非字符串同判过低（TS typeof apiVersion !== 'string' 分支）。
	if apiVersion == "" || !isAPIVersionSupported(apiVersion) {
		return errors.New(engineAPIVersionTooLow)
	}
	return nil
}

// apiVersionOf 从 /version 响应体取 ApiVersion：空体按 null 处理（缺字段 → 版本过低），
// 非 JSON 体以「Docker 响应不是有效 JSON」收口（TS transport 层同文案）。
func apiVersionOf(body []byte) (string, error) {
	if len(body) == 0 {
		return "", nil
	}
	var parsed any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", errors.New("Docker 响应不是有效 JSON")
	}
	record, ok := parsed.(map[string]any)
	if !ok {
		return "", nil
	}
	if value, ok := record["ApiVersion"].(string); ok {
		return value, nil
	}
	return "", nil
}

// isAPIVersionSupported major.minor ≥ 1.41 数字比较：major > 1 直接过，缺字段或
// 非数字同判过低。
func isAPIVersionSupported(apiVersion string) bool {
	major, minor := parseAPIVersion(apiVersion)
	if major > minAPIMajor {
		return true
	}
	if major < minAPIMajor {
		return false
	}
	return minor >= minAPIMinor
}

// parseAPIVersion 复刻 JS 解析：按首个 `.` 取 major/minor，Number() 不可解析（含
// Infinity）同判 {0, 0}。
func parseAPIVersion(version string) (float64, float64) {
	parts := strings.Split(version, ".")
	minor := 0.0
	if len(parts) > 1 {
		minor = jsNumber(parts[1])
	}
	return jsNumber(parts[0]), minor
}

// jsNumber JS Number() 的宽松数字语义：空串/纯空白 = 0；不可解析或越界为无穷 → 0。
func jsNumber(value string) float64 {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0
	}
	return parsed
}

// strPtr 取字符串指针（detail 非空；nil 序列化为 null）。
func strPtr(value string) *string { return &value }
