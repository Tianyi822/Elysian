package docker

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"elysian/server/internal/config"
	"elysian/server/internal/seam"
)

// Assemble 对等测试（dockerHostDeps.test.ts 锚点）：三种运行时模式分支、
// 版本过低原因注入、探测失败含底层错误消息、自容器识别联动。

// probeEngineScript 按注入的 ApiVersion 应答 /version 与容器表。
func probeEngineScript(apiVersion string, containerID string) engineScript {
	return func(call engineCall) (int, string, bool) {
		if call.Method == "GET" && call.Path == "/version" {
			return 200, `{"ApiVersion":"` + apiVersion + `"}`, true
		}
		if call.Method == "GET" && call.Path == "/containers/json" {
			if containerID == "" {
				return 200, "[]", true
			}
			return 200, listOf(`{"Id":"` + containerID + `"}`), true
		}
		return 200, "[]", true
	}
}

// useEngine 注入传输器替身并注册恢复。
func useEngine(t *testing.T, engine seam.DockerTransport) {
	t.Helper()
	previous := assemblyTransportOverride
	assemblyTransportOverride = func(string) seam.DockerTransport { return engine }
	t.Cleanup(func() { assemblyTransportOverride = previous })
}

// useCgroup 注入 cgroup 文本与 hostname（自容器识别测试通道）。
func useCgroup(t *testing.T, cgroupText, hostname string) {
	t.Helper()
	previousCgroup, previousHostname := cgroupTextOverride, hostnameOverride
	cgroupTextOverride = func() string { return cgroupText }
	hostnameOverride = func() string { return hostname }
	t.Cleanup(func() {
		cgroupTextOverride, hostnameOverride = previousCgroup, previousHostname
	})
}

func TestAssembleLocalDemoFirstGate(t *testing.T) {
	stack, err := Assemble(Deps{Mode: config.ModeLocalDemo, SocketPath: "/nonexistent.sock"})
	if err != nil {
		t.Fatal(err)
	}
	if stack.Ready {
		t.Fatal("LocalDemo 不探测、恒 false")
	}
	recorder := doGet(stack.Router, "/status", nil)
	if recorder.Code != 503 || recorder.Body.String() != `{"error":"真实容器管理仅在 Docker 容器内可用"}` {
		t.Fatalf("第一段 503：%d %s", recorder.Code, recorder.Body.String())
	}
}

func TestAssembleVersionTooLowSecondGate(t *testing.T) {
	engine := newFakeEngine(probeEngineScript("1.40", ""))
	useEngine(t, engine)
	stack, err := Assemble(Deps{Mode: config.ModeDocker, SocketPath: "/nonexistent.sock", MountRoot: "/srv"})
	if err != nil {
		t.Fatal(err)
	}
	if stack.Ready {
		t.Fatal("版本过低 socketReady=false")
	}
	recorder := doGet(stack.Router, "/status", nil)
	if recorder.Code != 503 || recorder.Body.String() != `{"error":"Docker 服务未就绪：Docker Engine API 版本过低，需要 1.41 及以上"}` {
		t.Fatalf("原因注入：%d %s", recorder.Code, recorder.Body.String())
	}
}

func TestAssembleConnectionFailureReason(t *testing.T) {
	engine := &errEngine{err: fmt.Errorf("dial unix /missing.sock: connect: no such file or directory")}
	useEngine(t, engine)
	stack, err := Assemble(Deps{Mode: config.ModeDocker, SocketPath: "/missing.sock"})
	if err != nil {
		t.Fatal(err)
	}
	recorder := doGet(stack.Router, "/status", nil)
	if recorder.Code != 503 || !strings.Contains(recorder.Body.String(), "Docker 服务未就绪：dial unix /missing.sock") {
		t.Fatalf("探测失败原因含底层错误消息：%d %s", recorder.Code, recorder.Body.String())
	}
}

func TestAssembleReadyWiresViews(t *testing.T) {
	selfID := strings.Repeat("a", 64)
	engine := newFakeEngine(probeEngineScript("1.44", selfID))
	useEngine(t, engine)
	useCgroup(t, "", selfID[:12])
	stack, err := Assemble(Deps{Mode: config.ModeDocker, SocketPath: "/nonexistent.sock", MountRoot: "/srv"})
	if err != nil {
		t.Fatal(err)
	}
	if !stack.Ready || stack.Engine != engine {
		t.Fatalf("Ready=%v", stack.Ready)
	}
	if stack.SelfID != selfID {
		t.Fatalf("cgroup 注入（hostname 通道回退）：%q", stack.SelfID)
	}
	if _, err := stack.Views.ListImages(context.Background()); err != nil {
		t.Fatalf("ListImages：%v", err)
	}
	if stack.Views.Policy().MountRoot != "/srv" {
		t.Fatalf("policy mountRoot")
	}
	if stack.Views.SelfContainerID() != selfID {
		t.Fatalf("views 自容器 id")
	}
}

func TestAssembleBareMetalSkipsContainerGate(t *testing.T) {
	engine := newFakeEngine(probeEngineScript("1.44", ""))
	useEngine(t, engine)
	stack, err := Assemble(Deps{Mode: config.ModeBareMetal, SocketPath: "/nonexistent.sock", MountRoot: "/srv"})
	if err != nil {
		t.Fatal(err)
	}
	if !stack.Ready {
		t.Fatal("BareMetal 跳过容器闸门，socket 就绪即整片可用")
	}
	recorder := doGet(stack.Router, "/status", nil)
	if recorder.Code != 200 {
		t.Fatalf("BareMetal 整片可用：%d", recorder.Code)
	}
}

func TestAssembleSelfContainerBlocksStop(t *testing.T) {
	selfID := strings.Repeat("b", 64)
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if call.Path == "/version" {
			return 200, `{"ApiVersion":"1.44"}`, true
		}
		if call.Path == "/containers/json" {
			return 200, listOf(`{"Id":"` + selfID + `"}`), true
		}
		if strings.HasSuffix(call.Path, "/json") {
			return 200, `{"Id":"` + selfID + `","Name":"/elysian","Created":"c","State":{"Status":"running"},"Config":{},"HostConfig":{},"Mounts":[],"Image":"i"}`, true
		}
		if call.Method == "POST" {
			t.Fatal("自容器 POST 不应发生")
		}
		return 0, "", false
	})
	useEngine(t, engine)
	useCgroup(t, "", selfID[:12])
	stack, err := Assemble(Deps{Mode: config.ModeDocker, SocketPath: "/nonexistent.sock"})
	if err != nil {
		t.Fatal(err)
	}
	if stack.SelfID != selfID {
		t.Fatalf("自容器识别（引擎 POST 不发生只拒动作）：%q", stack.SelfID)
	}
	recorder := doGet(stack.Router, "/containers", nil)
	if recorder.Code != 200 {
		t.Fatalf("只读接口不受自容器影响：%d", recorder.Code)
	}
}

func TestAssembleSelfIDEmptyWhenNoMatch(t *testing.T) {
	engine := newFakeEngine(probeEngineScript("1.44", ""))
	useEngine(t, engine)
	stack, err := Assemble(Deps{Mode: config.ModeDocker, SocketPath: "/nonexistent.sock"})
	if err != nil {
		t.Fatal(err)
	}
	if stack.SelfID != "" {
		t.Fatalf("无命中恒空：%q", stack.SelfID)
	}
}

type errEngine struct{ err error }

func (e *errEngine) Request(context.Context, seam.EngineRequest) (seam.EngineResponse, error) {
	return seam.EngineResponse{}, e.err
}

func (e *errEngine) Stream(context.Context, seam.EngineRequest, func([]byte)) (seam.EngineResponse, error) {
	return seam.EngineResponse{}, e.err
}
