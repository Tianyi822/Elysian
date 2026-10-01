package platform

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"syscall"
	"testing"
	"time"

	"elysian/server/internal/seam"
)

// 宿主执行器对等测试（hostShell.test.ts）：裸机固定参数与最小环境（进程环境不传入、
// PATH 含 /usr/bin）；非零退出带回输出；killed/超时 → 固定中文；容器内连不上引擎不
// 透传 socket 路径；镜像已在（不触发 pull）→ 创建 nsenter 容器、跑完必删、退出码与
// 日志原样返回。

func TestRunOnHostFixedArgsAndEnv(t *testing.T) {
	t.Setenv("ELYSIAN_SECRET", "hunter2")
	var gotFile string
	var gotArgs []string
	var gotEnv []string
	var gotTimeout time.Duration
	execFn := func(file string, args []string, env []string, timeout time.Duration) (string, string, error) {
		gotFile, gotArgs, gotEnv, gotTimeout = file, args, env, timeout
		return "ELYSIAN_DONE\n", "", nil
	}
	runner := newHostRunner(hostRunnerOptions{inContainer: false, exec: execFn})
	result, err := runner.run("echo hi", 1000*time.Millisecond)
	if err != nil {
		t.Fatalf("run 不应失败：%v", err)
	}
	if result.Code != 0 || result.Output != "ELYSIAN_DONE\n\n" {
		t.Fatalf("成功结果不符：%+v", result)
	}
	if gotFile != "/bin/sh" || len(gotArgs) != 2 || gotArgs[0] != "-c" || gotArgs[1] != "echo hi" {
		t.Fatalf("固定参数不符：file=%q args=%v", gotFile, gotArgs)
	}
	if gotTimeout != 1000*time.Millisecond {
		t.Fatalf("超时应透传：%v", gotTimeout)
	}
	if len(gotEnv) != 3 {
		t.Fatalf("环境应恰为最小三项：%v", gotEnv)
	}
	envText := strings.Join(gotEnv, "\n")
	if !strings.Contains(envText, "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin") {
		t.Fatalf("PATH 不符：%v", gotEnv)
	}
	if strings.Contains(envText, "ELYSIAN_SECRET") {
		t.Fatalf("进程环境不得传入宿主脚本：%v", gotEnv)
	}
}

func TestRunOnHostNonZeroExitCarriesOutput(t *testing.T) {
	execFn := func(string, []string, []string, time.Duration) (string, string, error) {
		return "", "", &hostExecExit{Code: 42, Stdout: "", Stderr: "E: no\n"}
	}
	runner := newHostRunner(hostRunnerOptions{inContainer: false, exec: execFn})
	result, err := runner.run("apt", time.Second)
	if err != nil {
		t.Fatalf("非零退出应作为结果带回：%v", err)
	}
	if result.Code != 42 || result.Output != "\nE: no\n" {
		t.Fatalf("非零退出结果不符：%+v", result)
	}
}

func TestRunOnHostTimeout(t *testing.T) {
	execFn := func(string, []string, []string, time.Duration) (string, string, error) {
		return "", "", &hostExecTimeout{}
	}
	runner := newHostRunner(hostRunnerOptions{inContainer: false, exec: execFn})
	_, err := runner.run("apt", time.Second)
	var hce *hostCommandError
	if !errors.As(err, &hce) || hce.message != setupFailureTimeout {
		t.Fatalf("超时应变固定中文：%v", err)
	}
}

func TestRunOnHostSpawnFailure(t *testing.T) {
	execFn := func(string, []string, []string, time.Duration) (string, string, error) {
		return "", "", errors.New("fork/exec /bin/sh: no such file or directory")
	}
	runner := newHostRunner(hostRunnerOptions{inContainer: false, exec: execFn})
	_, err := runner.run("apt", time.Second)
	var hce *hostCommandError
	if !errors.As(err, &hce) || hce.message != setupFailureHost {
		t.Fatalf("启动失败应收口「无法在本机执行」：%v", err)
	}
}

func TestRunViaEngineConnErrorNoPathLeak(t *testing.T) {
	transport := &fakeTransport{requestFn: func(seam.EngineRequest) (seam.EngineResponse, error) {
		return seam.EngineResponse{}, &errnoError{
			errno: syscall.ENOENT,
			msg:   "dial unix /secret/sock: connect: no such file or directory",
		}
	}}
	runner := newHostRunner(hostRunnerOptions{
		inContainer:     true,
		createTransport: func() seam.DockerTransport { return transport },
	})
	_, err := runner.run("echo hi", time.Second)
	var hce *hostCommandError
	if !errors.As(err, &hce) {
		t.Fatalf("应归为 HostCommandError：%v", err)
	}
	if hce.message != setupFailureEngine {
		t.Fatalf("连不上引擎应逐字报引擎文案：%q", hce.message)
	}
	if strings.Contains(hce.message, "/secret/sock") {
		t.Fatalf("引擎文案不得透传 socket 路径：%q", hce.message)
	}
}

func TestRunViaEngineHappyPath(t *testing.T) {
	transport := &fakeTransport{}
	transport.requestFn = func(req seam.EngineRequest) (seam.EngineResponse, error) {
		switch {
		case strings.Contains(req.Path, "/images/"):
			return seam.EngineResponse{Status: http.StatusOK, Body: []byte(`{"Id":"img"}`)}, nil
		case strings.Contains(req.Path, "/containers/create"):
			var body struct {
				Image      string   `json:"Image"`
				Tty        bool     `json:"Tty"`
				Entrypoint []string `json:"Entrypoint"`
				Cmd        []string `json:"Cmd"`
				HostConfig struct {
					Privileged  bool   `json:"Privileged"`
					PidMode     string `json:"PidMode"`
					NetworkMode string `json:"NetworkMode"`
					AutoRemove  bool   `json:"AutoRemove"`
				} `json:"HostConfig"`
			}
			if err := json.Unmarshal(req.Body, &body); err != nil {
				t.Fatalf("创建体不是 JSON：%v", err)
			}
			if body.Image != "alpine:3.20" || !body.Tty {
				t.Fatalf("镜像与 Tty 不符：%+v", body)
			}
			wantEntrypoint := []string{"nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "/bin/sh", "-c"}
			if strings.Join(body.Entrypoint, " ") != strings.Join(wantEntrypoint, " ") {
				t.Fatalf("Entrypoint 不符：%v", body.Entrypoint)
			}
			if len(body.Cmd) != 1 || body.Cmd[0] != "echo hi" {
				t.Fatalf("Cmd 不符：%v", body.Cmd)
			}
			if !body.HostConfig.Privileged || body.HostConfig.PidMode != "host" ||
				body.HostConfig.NetworkMode != "host" || body.HostConfig.AutoRemove {
				t.Fatalf("HostConfig 不符：%+v", body.HostConfig)
			}
			return seam.EngineResponse{Status: http.StatusCreated, Body: []byte(`{"Id":"` + strings.Repeat("a", 64) + `"}`)}, nil
		case strings.HasSuffix(req.Path, "/start"):
			return seam.EngineResponse{Status: http.StatusNoContent}, nil
		case strings.HasSuffix(req.Path, "/wait"):
			return seam.EngineResponse{Status: http.StatusOK, Body: []byte(`{"StatusCode":0}`)}, nil
		case req.Method == http.MethodDelete:
			return seam.EngineResponse{Status: http.StatusNoContent}, nil
		}
		return seam.EngineResponse{}, errors.New("unexpected " + req.Method + " " + req.Path)
	}
	transport.streamFn = func(req seam.EngineRequest) (seam.EngineResponse, error) {
		if !strings.Contains(req.Path, "/logs") {
			t.Fatalf("不应有其它流式请求：%s", req.Path)
		}
		return seam.EngineResponse{Status: http.StatusOK, Body: []byte("ELYSIAN_DONE\n")}, nil
	}
	runner := newHostRunner(hostRunnerOptions{
		inContainer:     true,
		createTransport: func() seam.DockerTransport { return transport },
	})
	result, err := runner.run("echo hi", 5*time.Second)
	if err != nil {
		t.Fatalf("run 不应失败：%v", err)
	}
	if result.Code != 0 || result.Output != "ELYSIAN_DONE\n" {
		t.Fatalf("退出码与日志应原样返回：%+v", result)
	}
	if !transport.hasDeleteCall() {
		t.Fatal("跑完必须删除一次性容器")
	}
	transport.mu.Lock()
	defer transport.mu.Unlock()
	for _, req := range transport.streams {
		if strings.Contains(req.Path, "/images/create") {
			t.Fatal("镜像已在时不应触发 pull")
		}
	}
}

func TestRunViaEngineCreateConflictRetries(t *testing.T) {
	// 409（重名残留）→ 强删 → 重试一次成功。
	createCalls := 0
	transport := &fakeTransport{}
	transport.requestFn = func(req seam.EngineRequest) (seam.EngineResponse, error) {
		switch {
		case strings.Contains(req.Path, "/images/"):
			return seam.EngineResponse{Status: http.StatusOK, Body: []byte(`{"Id":"img"}`)}, nil
		case strings.Contains(req.Path, "/containers/create"):
			createCalls++
			if createCalls == 1 {
				return seam.EngineResponse{Status: http.StatusConflict, Body: []byte(`{"message":"Conflict"}`)}, nil
			}
			return seam.EngineResponse{Status: http.StatusCreated, Body: []byte(`{"Id":"` + strings.Repeat("b", 40) + `"}`)}, nil
		case req.Method == http.MethodDelete && strings.Contains(req.Path, setupName):
			return seam.EngineResponse{Status: http.StatusNoContent}, nil
		case strings.HasSuffix(req.Path, "/start"):
			return seam.EngineResponse{Status: http.StatusNoContent}, nil
		case strings.HasSuffix(req.Path, "/wait"):
			return seam.EngineResponse{Status: http.StatusOK, Body: []byte(`{"StatusCode":3}`)}, nil
		case req.Method == http.MethodDelete:
			return seam.EngineResponse{Status: http.StatusNoContent}, nil
		}
		return seam.EngineResponse{}, errors.New("unexpected " + req.Method + " " + req.Path)
	}
	transport.streamFn = func(seam.EngineRequest) (seam.EngineResponse, error) {
		return seam.EngineResponse{Status: http.StatusOK, Body: []byte("done")}, nil
	}
	runner := newHostRunner(hostRunnerOptions{
		inContainer:     true,
		createTransport: func() seam.DockerTransport { return transport },
	})
	result, err := runner.run("echo hi", 5*time.Second)
	if err != nil {
		t.Fatalf("409 重试后应成功：%v", err)
	}
	if result.Code != 3 {
		t.Fatalf("退出码应取自 wait：%+v", result)
	}
	if createCalls != 2 {
		t.Fatalf("应重试创建一次：%d", createCalls)
	}
}

func TestRunViaEngineStartFailure(t *testing.T) {
	transport := &fakeTransport{}
	transport.requestFn = func(req seam.EngineRequest) (seam.EngineResponse, error) {
		switch {
		case strings.Contains(req.Path, "/images/"):
			return seam.EngineResponse{Status: http.StatusOK, Body: []byte(`{"Id":"img"}`)}, nil
		case strings.Contains(req.Path, "/containers/create"):
			return seam.EngineResponse{Status: http.StatusCreated, Body: []byte(`{"Id":"` + strings.Repeat("c", 32) + `"}`)}, nil
		case strings.HasSuffix(req.Path, "/start"):
			return seam.EngineResponse{Status: http.StatusInternalServerError, Body: []byte(`{"message":"boom"}`)}, nil
		case req.Method == http.MethodDelete:
			return seam.EngineResponse{Status: http.StatusNoContent}, nil
		}
		return seam.EngineResponse{}, errors.New("unexpected " + req.Method + " " + req.Path)
	}
	runner := newHostRunner(hostRunnerOptions{
		inContainer:     true,
		createTransport: func() seam.DockerTransport { return transport },
	})
	_, err := runner.run("echo hi", time.Second)
	var hce *hostCommandError
	if !errors.As(err, &hce) || hce.message != setupFailureImage {
		t.Fatalf("start 失败应报环境准备失败：%v", err)
	}
	if !transport.hasDeleteCall() {
		t.Fatal("失败也必须删容器")
	}
}

// 真实本机执行（容器内跑门禁，/bin/sh 恒可用）：成功、环境隔离、maxBuffer 溢出归超时。
func TestRealExecSuccess(t *testing.T) {
	stdout, _, err := realExecCommand("/bin/sh", []string{"-c", "echo hi"}, minimalEnv(), 10*time.Second)
	if err != nil {
		t.Fatalf("不应失败：%v", err)
	}
	if stdout != "hi\n" {
		t.Fatalf("输出不符：stdout=%q", stdout)
	}
}

func TestRealExecEnvIsolation(t *testing.T) {
	t.Setenv("ELYSIAN_SECRET", "hunter2")
	stdout, _, err := realExecCommand("/bin/sh", []string{"-c", "env"}, minimalEnv(), 10*time.Second)
	if err != nil {
		t.Fatalf("不应失败：%v", err)
	}
	if !strings.Contains(stdout, "DEBIAN_FRONTEND=noninteractive") {
		t.Fatalf("最小环境应传入：%q", stdout)
	}
	if strings.Contains(stdout, "ELYSIAN_SECRET") {
		t.Fatalf("进程环境不得传入宿主脚本：%q", stdout)
	}
}

func TestRealExecOutputOverflowBecomesTimeout(t *testing.T) {
	// maxBuffer 溢出被归为「这一步超时」（platform 盘点 §11.2 的显式复刻要求）。
	_, _, err := realExecCommand("/bin/sh", []string{"-c", "head -c 2097152 /dev/zero"}, minimalEnv(), 30*time.Second)
	var timedOut *hostExecTimeout
	if !errors.As(err, &timedOut) {
		t.Fatalf("输出超 1 MiB 应归为超时：%v", err)
	}
}

func TestRealExecNonZeroExit(t *testing.T) {
	_, _, err := realExecCommand("/bin/sh", []string{"-c", "echo E: no >&2; exit 7"}, minimalEnv(), 10*time.Second)
	var exited *hostExecExit
	if !errors.As(err, &exited) {
		t.Fatalf("非零退出应报 hostExecExit：%v", err)
	}
	if exited.Code != 7 || !strings.Contains(exited.Stderr, "E: no") {
		t.Fatalf("退出码与输出应带回：%+v", exited)
	}
}

func TestRealExecTimeout(t *testing.T) {
	_, _, err := realExecCommand("/bin/sh", []string{"-c", "sleep 5"}, minimalEnv(), 200*time.Millisecond)
	var timedOut *hostExecTimeout
	if !errors.As(err, &timedOut) {
		t.Fatalf("超时应报 hostExecTimeout：%v", err)
	}
}
