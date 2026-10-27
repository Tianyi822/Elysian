//go:build linux || darwin

package cli

import (
	"bytes"
	"context"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/cli/client"
	"github.com/creack/pty"
)

func TestUpgradeMonitorPTYExitAndResume(t *testing.T) {
	master, tty, err := pty.Open()
	if err != nil {
		t.Skip(err)
	}
	defer master.Close()
	defer tty.Close()
	f := &fakeMaintenance{}
	runtime, state := upgradeFixture(t, f)
	runtime.pause = pauseUpgrade
	f.report = func(string, int64) (client.PanelTaskReport, error) {
		task := completedUpgrade()
		task.State = "running"
		task.Phase = "building"
		return client.PanelTaskReport{Task: task, Logs: "构建仍在执行\n"}, nil
	}
	out := &signalWriter{first: make(chan struct{})}
	done := make(chan int, 1)
	go func() { code, _ := monitorUpgrade(context.Background(), tty, out, true, runtime, state); done <- code }()
	waitFor(t, out, "构建进度", func(s string) bool { return strings.Contains(s, "构建新版本") })
	if _, err := master.Write([]byte{3}); err != nil {
		t.Fatal(err)
	}
	select {
	case code := <-done:
		if code != 130 {
			t.Fatalf("Ctrl+C code=%d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("退出监控没有收敛")
	}
	if strings.Contains(out.String(), "\x1b[?1049h") {
		t.Fatal("不应进入全屏替代缓冲区")
	}
	saved, err := runtime.store.read(state.BaseURL, state.PanelHome)
	if err != nil || saved == nil || saved.TaskID == "" {
		t.Fatalf("恢复指针=%+v err=%v", saved, err)
	}
	f.report = nil
	var resumed bytes.Buffer
	code, err := monitorUpgrade(context.Background(), nil, &resumed, false, runtime, *saved)
	if code != 0 || err != nil || f.submits != 1 {
		t.Fatalf("恢复结果 code=%d err=%v submits=%d", code, err, f.submits)
	}
	if !strings.Contains(resumed.String(), "运行版本已核对") {
		t.Fatalf("缺少最终核对：%s", &resumed)
	}
}

func TestAgentDirectCommandDoesNotOpenMenu(t *testing.T) {
	master, tty, err := pty.Open()
	if err != nil {
		t.Skip(err)
	}
	defer master.Close()
	defer tty.Close()
	d := fakeDeps()
	called := 0
	d.runAgent = func(in *os.File, out io.Writer) error { called++; return nil }
	var out bytes.Buffer
	if code := runWithDeps(testInfo, []string{"agent"}, tty, &out, &out, d); code != 0 || called != 1 || out.Len() != 0 {
		t.Fatalf("直接入口 code=%d calls=%d output=%s", code, called, &out)
	}
}
