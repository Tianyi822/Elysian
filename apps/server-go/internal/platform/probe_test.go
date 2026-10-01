package platform

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// 探测实现对等测试（platformDependencies.test.ts 探测段）：fake 注入锁行为与文案，
// 请求形状对齐既有探针（docker GET /version 3s/1MiB）；真实路径以不存在 socket 与
// 普通文件模拟（env 覆盖即模拟机制的 Go 落点是 Deps 的 socket 路径字段）。

func newTestProber(transport seam.DockerTransport, caddy seam.CaddyAdmin) prober {
	return prober{
		createTransport: func(string) seam.DockerTransport { return transport },
		createCaddy:     func(string) seam.CaddyAdmin { return caddy },
		dockerSocket:    "/var/run/docker.sock",
		caddySocket:     "/run/caddy/admin.sock",
	}
}

func TestProbeBothOK(t *testing.T) {
	transport := &fakeTransport{requestFn: func(seam.EngineRequest) (seam.EngineResponse, error) {
		return seam.EngineResponse{Status: http.StatusOK, Body: []byte(`{"ApiVersion":"1.44"}`)}, nil
	}}
	caddy := &fakeCaddyAdmin{}
	report := newTestProber(transport, caddy).Probe()
	if report.Docker.State != probeStateOK || report.Docker.Detail != nil {
		t.Fatalf("docker 探测应为 ok/null：%+v", report.Docker)
	}
	if report.Caddy.State != probeStateOK || report.Caddy.Detail != nil {
		t.Fatalf("caddy 探测应为 ok/null：%+v", report.Caddy)
	}
	if transport.requestCount() != 1 {
		t.Fatalf("docker 应恰好请求一次：%d", transport.requestCount())
	}
	req := transport.requests[0]
	if req.Method != http.MethodGet || req.Path != "/version" ||
		req.Timeout != 3*time.Second || req.MaxBytes != 1_048_576 {
		t.Fatalf("docker 请求形状不符：%+v", req)
	}
	if caddy.callCount() != 1 {
		t.Fatalf("caddy 应恰好探测一次：%d", caddy.callCount())
	}
}

func TestProbeDockerConnectionErrno(t *testing.T) {
	for _, code := range []string{"ENOENT", "ECONNREFUSED", "EACCES"} {
		transport := &fakeTransport{requestFn: func(seam.EngineRequest) (seam.EngineResponse, error) {
			return seam.EngineResponse{}, &errnoError{errno: mustErrno(code), msg: "connect " + code + " /var/run/docker.sock"}
		}}
		report := newTestProber(transport, &fakeCaddyAdmin{}).Probe()
		if report.Docker.State != probeStateMissing || *report.Docker.Detail != dockerUnavailableDetail {
			t.Fatalf("%s 应归 missing + 固定文案：%+v", code, report.Docker)
		}
	}
}

func TestProbeDockerVersionTooLow(t *testing.T) {
	transport := &fakeTransport{requestFn: func(seam.EngineRequest) (seam.EngineResponse, error) {
		return seam.EngineResponse{Status: http.StatusOK, Body: []byte(`{"ApiVersion":"1.24"}`)}, nil
	}}
	report := newTestProber(transport, &fakeCaddyAdmin{}).Probe()
	if report.Docker.State != probeStateError || *report.Docker.Detail != "Docker Engine API 版本过低，需要 1.41 及以上" {
		t.Fatalf("版本过低应逐字复用 assertEngineApi 文案：%+v", report.Docker)
	}
}

func TestProbeDockerMajorVersionPasses(t *testing.T) {
	// major > 1 直接过（对齐 TS isApiVersionSupported）。
	transport := &fakeTransport{requestFn: func(seam.EngineRequest) (seam.EngineResponse, error) {
		return seam.EngineResponse{Status: http.StatusOK, Body: []byte(`{"ApiVersion":"2.0"}`)}, nil
	}}
	report := newTestProber(transport, &fakeCaddyAdmin{}).Probe()
	if report.Docker.State != probeStateOK {
		t.Fatalf("major>1 应通过：%+v", report.Docker)
	}
}

func TestProbeCaddyUnavailable(t *testing.T) {
	caddy := &fakeCaddyAdmin{configErr: &seam.CaddyChannelError{Unavailable: true}}
	report := newTestProber(&fakeTransport{}, caddy).Probe()
	if report.Caddy.State != probeStateMissing || *report.Caddy.Detail != "宿主未提供 Caddy 管理通道" {
		t.Fatalf("连接类失败应归 missing + 既有固定文案：%+v", report.Caddy)
	}
}

func TestProbeCaddyEngineFailure(t *testing.T) {
	// 已装故障不归缺装类：HTTP 500 的引擎消息原样透出。
	caddy := &fakeCaddyAdmin{configErr: &seam.CaddyChannelError{Message: "x"}}
	report := newTestProber(&fakeTransport{}, caddy).Probe()
	if report.Caddy.State != probeStateError || *report.Caddy.Detail != "x" {
		t.Fatalf("引擎侧失败应归 error + 引擎消息：%+v", report.Caddy)
	}
}

func TestProbeDockerNonConnectionErrnoNoPathLeak(t *testing.T) {
	transport := &fakeTransport{requestFn: func(seam.EngineRequest) (seam.EngineResponse, error) {
		return seam.EngineResponse{}, &errnoError{errno: mustErrno("ENOTSOCK"), msg: "connect ENOTSOCK /var/run/docker.sock"}
	}}
	report := newTestProber(transport, &fakeCaddyAdmin{}).Probe()
	if report.Docker.State != probeStateError || *report.Docker.Detail != dockerSystemErrorDetail {
		t.Fatalf("ENOTSOCK 应归 error + 固定文案：%+v", report.Docker)
	}
	if strings.Contains(*report.Docker.Detail, "/var/run/docker.sock") {
		t.Fatalf("固定文案不得透传宿主路径：%q", *report.Docker.Detail)
	}
}

func TestProbeCaddyNonConnectionErrnoNoPathLeak(t *testing.T) {
	caddy := &fakeCaddyAdmin{configErr: &seam.CaddyChannelError{
		Code:    "ENOTSOCK",
		Message: "connect ENOTSOCK /run/caddy/admin.sock",
	}}
	report := newTestProber(&fakeTransport{}, caddy).Probe()
	if report.Caddy.State != probeStateError || *report.Caddy.Detail != caddySystemErrorDetail {
		t.Fatalf("ENOTSOCK 应归 error + 固定文案：%+v", report.Caddy)
	}
	if strings.Contains(*report.Caddy.Detail, "/run/caddy/admin.sock") {
		t.Fatalf("固定文案不得透传宿主路径：%q", *report.Caddy.Detail)
	}
}

func TestProbeVersionCheckEdgeCases(t *testing.T) {
	cases := []struct {
		apiVersion string
		supported  bool
	}{
		{"1.41", true},
		{"1.44", true},
		{"1.40", false},
		{"2.0", true},
		{"0.9", false},
		{"1", false},   // minor 缺失 → 0
		{"abc", false}, // 不可解析 → {0,0}
		{"", false},
		{"1.x", false},
	}
	for _, tc := range cases {
		if got := isAPIVersionSupported(tc.apiVersion); got != tc.supported {
			t.Fatalf("isAPIVersionSupported(%q) = %v，want %v", tc.apiVersion, got, tc.supported)
		}
	}
}

// env 覆盖模拟的真实拨号路径：不存在 socket → missing；普通文件 → ENOTSOCK error。
func TestProbeRealDialMissingSocket(t *testing.T) {
	report := newTestDialProber(filepath.Join(t.TempDir(), "no-docker.sock")).Probe()
	if report.Docker.State != probeStateMissing || *report.Docker.Detail != dockerUnavailableDetail {
		t.Fatalf("真实 ENOENT 应落 missing + 固定文案：%+v", report.Docker)
	}
}

func TestProbeRealDialNotSocketFile(t *testing.T) {
	dir := t.TempDir()
	notSocket := filepath.Join(dir, "notsock-docker.txt")
	if err := os.WriteFile(notSocket, []byte("not a socket"), 0o644); err != nil {
		t.Fatalf("准备普通文件失败：%v", err)
	}
	report := newTestDialProber(notSocket).Probe()
	if report.Docker.State != probeStateError || *report.Docker.Detail != dockerSystemErrorDetail {
		t.Fatalf("真实 ENOTSOCK 应落 error + 固定文案：%+v", report.Docker)
	}
	if strings.Contains(*report.Docker.Detail, notSocket) {
		t.Fatalf("固定文案不得透传宿主绝对路径：%q", *report.Docker.Detail)
	}
}

func TestProbeReportJSONShape(t *testing.T) {
	// 键序即 JSON 序：docker 在前、caddy 在后；ok 时 detail 为 null。
	data, err := shared.MarshalJSON(okReport())
	if err != nil {
		t.Fatalf("编码失败：%v", err)
	}
	if string(data) != `{"docker":{"state":"ok","detail":null},"caddy":{"state":"ok","detail":null}}` {
		t.Fatalf("报告 JSON 形状不符：%s", data)
	}
	missing := dependencyProbeReport{
		Docker: dependencyProbe{State: probeStateMissing, Detail: strPtr(dockerUnavailableDetail)},
		Caddy:  dependencyProbe{State: probeStateError, Detail: strPtr(caddySystemErrorDetail)},
	}
	data, err = shared.MarshalJSON(missing)
	if err != nil {
		t.Fatalf("编码失败：%v", err)
	}
	want := `{"docker":{"state":"missing","detail":"Docker 未安装或未接通"},"caddy":{"state":"error","detail":"Caddy 连接异常"}}`
	if string(data) != want {
		t.Fatalf("报告 JSON 形状不符：%s", data)
	}
}

// mustErrno errno 名转 syscall.Errno（测试表驱动用）。
func mustErrno(name string) syscall.Errno {
	switch name {
	case "ENOENT":
		return syscall.ENOENT
	case "EACCES":
		return syscall.EACCES
	case "ECONNREFUSED":
		return syscall.ECONNREFUSED
	case "ENOTSOCK":
		return syscall.ENOTSOCK
	}
	panic("未知 errno " + name)
}
