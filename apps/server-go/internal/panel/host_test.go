package panel

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSystemHostCommandDeadlineClosesChildOutput(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	started := time.Now()
	out, err := (SystemHost{}).command(ctx, "sh", "-c", "sleep 3 & printf '已启动'; wait")
	if err == nil || out != "已启动" || ctx.Err() != context.DeadlineExceeded {
		t.Fatalf("未取得已启动后超时的回执：%q %v %v", out, err, ctx.Err())
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("控制命令超时后仍被子进程继承的输出管道阻塞：%s", elapsed)
	}
}

func TestEnsureSshdPrivSepDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "run", "sshd")
	if err := ensureSshdPrivSepDir(dir); err != nil {
		t.Fatalf("首次创建：%v", err)
	}
	if err := ensureSshdPrivSepDir(dir); err != nil {
		t.Fatalf("已存在应幂等：%v", err)
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		t.Fatalf("应为目录：%v", err)
	}
}
