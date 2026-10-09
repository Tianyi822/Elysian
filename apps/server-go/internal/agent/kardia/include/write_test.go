// write_test.go 对应 include/tests/write.spec.ts 的 4 个用例。TS 经补丁
// CJS 内建模块注入 rename 失败；Go 侧以 FileOps 接缝注入等价失败（错误包
// 装对应 errno），退避等待走 Manual 时钟——advanceUntil 以微步推进虚拟时间
// 直到下一次 rename 尝试到达，替代真实等待。
package include

import (
	"context"
	"fmt"
	"math"
	"os"
	"sync"
	"syscall"
	"testing"
	"time"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/kardia/clock"
	"elysian/server/internal/agent/kardia/loader"
)

// renameOps 注入 rename 失败：failures 为剩余失败次数，code 为失败错误码；
// beforeFail 在拒绝前执行（模拟外部写者与写入竞态）；notify 在每次 rename
// 尝试时发信号。
type renameOps struct {
	osFileOps
	mu         sync.Mutex
	failures   int
	code       syscall.Errno
	beforeFail func() error
	calls      int
	notify     chan struct{}
}

func (o *renameOps) setFailures(n int) {
	o.mu.Lock()
	o.failures = n
	o.mu.Unlock()
}

func (o *renameOps) totalCalls() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.calls
}

func (o *renameOps) Rename(oldpath, newpath string) error {
	o.mu.Lock()
	o.calls++
	fail := o.failures > 0
	if fail {
		o.failures--
	}
	before := o.beforeFail
	code := o.code
	o.mu.Unlock()
	if o.notify != nil {
		// 非阻塞投递：测试只消费预期内的尝试（如销毁冲刷的补写不得卡住）
		select {
		case o.notify <- struct{}{}:
		default:
		}
	}
	if fail {
		if before != nil {
			if err := before(); err != nil {
				return err
			}
		}
		return fmt.Errorf("注入的 rename 失败: %w", code)
	}
	return os.Rename(oldpath, newpath)
}

// advanceUntil 通过时钟的状态通知等待退避登记，再精确推进虚拟时间。
func advanceUntil(t *testing.T, clk *clock.Manual, notify <-chan struct{}) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		pending, changed := clk.Pending()
		select {
		case <-notify:
			return
		default:
		}
		if pending > 0 {
			clk.Advance(time.Second)
			continue
		}
		select {
		case <-notify:
			return
		case <-changed:
		case <-ctx.Done():
			t.Fatal("等待文件重命名超时")
		}
	}
}

func TestWriteRetriesTransientRename(t *testing.T) {
	h := setupInclude(t, "tmp-write-retry.yml", []*loader.EntryOptions{cfgPlugin("a", 1)}, nil)
	ops := &renameOps{failures: 2, code: syscall.EBUSY, notify: make(chan struct{}, 32)}
	h.include().SetFileOps(ops)
	t.Cleanup(func() { ops.setFailures(0) })

	if err := h.update("a", loader.EntryOptions{Config: map[string]any{"tag": "a", "value": 2}}); err != nil {
		t.Fatalf("更新 a 失败：%v", err)
	}
	// 三次尝试：两次失败（各退避一次），第三次成功
	advanceUntil(t, h.clk, ops.notify)
	advanceUntil(t, h.clk, ops.notify)
	advanceUntil(t, h.clk, ops.notify)
	h.settle()

	if got := ops.totalCalls(); got != 3 {
		t.Fatalf("应尝试 rename 三次，实际 %d", got)
	}
	if got := mustConfigValue(t, readConfig(t, h.readEntries()[0]), "value"); got != 2 {
		t.Fatalf("文件应写入 2，实际 %v", got)
	}
	if logs := h.logs(kardia.LoggerTypeWarn); len(logs) != 0 {
		t.Fatalf("重试成功不应告警，实际 %v", logs)
	}
	if logs := h.logs(kardia.LoggerTypeError); len(logs) != 0 {
		t.Fatalf("不应有错误日志，实际 %v", logs)
	}
}

func TestWriteNeverOverwritesChangeLandingDuringRetry(t *testing.T) {
	h := setupInclude(t, "tmp-write-race.yml", []*loader.EntryOptions{cfgPlugin("a", 1), cfgPlugin("b", 1)}, nil)
	ops := &renameOps{failures: 1, code: syscall.EBUSY, notify: make(chan struct{}, 32)}
	ops.beforeFail = func() error {
		return os.WriteFile(h.filename, []byte(mustDumpYAML(t, []*loader.EntryOptions{cfgPlugin("a", 1), cfgPlugin("b", 2)})), 0o644)
	}
	h.include().SetFileOps(ops)
	t.Cleanup(func() { ops.setFailures(0) })

	if err := h.update("a", loader.EntryOptions{Config: map[string]any{"tag": "a", "value": 2}}); err != nil {
		t.Fatalf("更新 a 失败：%v", err)
	}
	// 第一次失败（外部写入已发生）；重试前的陈旧检查看到外部编辑，运行时
	// 变更并入后重写一次
	advanceUntil(t, h.clk, ops.notify)
	advanceUntil(t, h.clk, ops.notify)
	h.settle()

	entries := h.readEntries()
	if got := mustConfigValue(t, readConfig(t, entries[0]), "value"); got != 2 {
		t.Fatalf("文件 a 应为 2，实际 %v", got)
	}
	if got := mustConfigValue(t, readConfig(t, entries[1]), "value"); got != 2 {
		t.Fatalf("文件 b 应为 2，实际 %v", got)
	}
	if got := mustConfigValue(t, h.configValue("b"), "value"); got != 2 {
		t.Fatalf("树侧 b 应为 2，实际 %v", got)
	}
	if got := ops.totalCalls(); got != 2 {
		t.Fatalf("应尝试 rename 两次，实际 %d", got)
	}
	if logs := h.logs(kardia.LoggerTypeError); len(logs) != 0 {
		t.Fatalf("不应有错误日志，实际 %v", logs)
	}
}

func TestWriteDoesNotRetryOtherErrorsButFlushesOnDispose(t *testing.T) {
	h := setupInclude(t, "tmp-write-fatal.yml", []*loader.EntryOptions{cfgPlugin("a", 1)}, nil)
	text := h.text()
	ops := &renameOps{failures: 1, code: syscall.ENOSPC, notify: make(chan struct{}, 32)}
	h.include().SetFileOps(ops)
	t.Cleanup(func() { ops.setFailures(0) })

	if err := h.update("a", loader.EntryOptions{Config: map[string]any{"tag": "a", "value": 2}}); err != nil {
		t.Fatalf("更新 a 失败：%v", err)
	}
	advanceUntil(t, h.clk, ops.notify)
	if err := h.include().Flush(context.Background()); err == nil {
		t.Fatal("Flush 应报告磁盘写入错误")
	}
	h.settle()

	if got := ops.totalCalls(); got != 1 {
		t.Fatalf("非瞬态错误不应重试，实际尝试 %d 次", got)
	}
	if got := h.text(); got != text {
		t.Fatalf("文件不应被改写，实际 %q", got)
	}
	if !logsContain(h.logs(kardia.LoggerTypeWarn), "写入配置文件") {
		t.Fatalf("应告警写入失败，实际 %v", h.logs(kardia.LoggerTypeWarn))
	}
	if got := mustConfigValue(t, h.configValue("a"), "value"); got != 2 {
		t.Fatalf("运行时变更应保留，实际 %v", got)
	}

	// 锁释放后，账本随销毁冲刷落盘
	ops.setFailures(0)
	h.dispose()
	if got := mustConfigValue(t, readConfig(t, h.readEntries()[0]), "value"); got != 2 {
		t.Fatalf("销毁冲刷应写入 2，实际 %v", got)
	}
}

func TestWriteGivesUpAfterBoundedAttempts(t *testing.T) {
	h := setupInclude(t, "tmp-write-bounded.yml", []*loader.EntryOptions{cfgPlugin("a", 1)}, nil)
	text := h.text()
	ops := &renameOps{failures: math.MaxInt32, code: syscall.EBUSY, notify: make(chan struct{}, 32)}
	h.include().SetFileOps(ops)
	t.Cleanup(func() { ops.setFailures(0) })

	if err := h.update("a", loader.EntryOptions{Config: map[string]any{"tag": "a", "value": 2}}); err != nil {
		t.Fatalf("更新 a 失败：%v", err)
	}
	// 1 次首试 + 10 次重试
	for i := 0; i < 11; i++ {
		advanceUntil(t, h.clk, ops.notify)
	}
	if err := h.include().Flush(context.Background()); err == nil {
		t.Fatal("Flush 应报告重试耗尽")
	}
	h.settle()

	if got := ops.totalCalls(); got != 11 {
		t.Fatalf("应有界尝试 11 次，实际 %d", got)
	}
	if got := h.text(); got != text {
		t.Fatalf("文件不应被改写，实际 %q", got)
	}
	if !logsContain(h.logs(kardia.LoggerTypeWarn), "写入配置文件") {
		t.Fatalf("应告警写入失败，实际 %v", h.logs(kardia.LoggerTypeWarn))
	}
	if got := mustConfigValue(t, h.configValue("a"), "value"); got != 2 {
		t.Fatalf("运行时变更应保留，实际 %v", got)
	}

	// 锁释放后，账本随销毁冲刷落盘
	ops.setFailures(0)
	h.dispose()
	if got := mustConfigValue(t, readConfig(t, h.readEntries()[0]), "value"); got != 2 {
		t.Fatalf("销毁冲刷应写入 2，实际 %v", got)
	}
}
