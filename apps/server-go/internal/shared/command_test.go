package shared

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestRunCapturePreservesOutputAndExitError(t *testing.T) {
	cmd := exec.Command("sh", "-c", "printf 'stdout\n'; printf '  stderr\n' >&2; exit 7")
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	stderr, err := RunCapture(cmd)
	var exit *exec.ExitError
	if stdout.String() != "stdout\n" || stderr != "  stderr\n" || !errors.As(err, &exit) || exit.ExitCode() != 7 {
		t.Fatalf("命令输出或退出状态改变：%q %q %v", stdout.String(), stderr, err)
	}
	if got := CommandErrorWithStderr(err, stderr); got.Error() != "stderr" {
		t.Fatalf("错误文案没有使用 stderr：%v", got)
	}
	if got := CommandErrorWithStderr(err, " \n"); got != err {
		t.Fatalf("没有错误详情时应保留原退出错误：%v", got)
	}
	_, err = exec.Command("sh", "-c", "printf '  随退出错误返回的详情\n' >&2; exit 8").Output()
	if got := CommandErrorWithStderr(err, ""); got == nil || got.Error() != "随退出错误返回的详情" {
		t.Fatalf("未保留 Output 随退出错误返回的详情：%v", got)
	}
}

func TestSystemCommandDeadlineEndsInheritedPipes(t *testing.T) {
	ctx, stop := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer stop()
	cmd, bounded, cancel := SystemCommand(ctx, "sh", "-c", "sleep 60 & wait")
	defer cancel()
	start := time.Now()
	_, err := cmd.Output()
	if err == nil || time.Since(start) > 2*time.Second {
		t.Fatal("系统命令或继承管道的子进程未被有界终止")
	}
	if err := SystemCommandError(bounded, err); !strings.Contains(err.Error(), "操作结果尚未确认") {
		t.Fatal(err)
	}
}

func TestSecurityProxyDeadlineCancelsBodyRead(t *testing.T) {
	done := make(chan struct{})
	proxy := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done(); close(done) })
	w := httptest.NewRecorder()
	boundedSecurityProxy(proxy, 20*time.Millisecond).ServeHTTP(w, httptest.NewRequest("GET", "/api/security/firewall", nil))
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "操作结果尚未确认") {
		t.Fatal(w.Code, w.Body.String())
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("代理响应体读取没有取消")
	}
}
