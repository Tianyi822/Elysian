package worker

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// 测试自举当前测试二进制，真实验证管道、进程退出和取消，不启动面板与任何域。
func TestWorkerSubprocess(t *testing.T) {
	mode := os.Getenv("ELYSIAN_WORKER_TEST_MODE")
	if mode == "" {
		return
	}
	var err error
	if mode == "normal" || mode == "stderr" {
		if mode == "stderr" {
			_, _ = io.WriteString(os.Stderr, strings.Repeat("诊断", 512*1024))
		}
		err = Serve(os.Stdin, os.Stdout, os.Stderr)
	} else {
		err = maliciousWorker(mode)
	}
	if err != nil {
		os.Exit(7)
	}
	os.Exit(0)
}

func maliciousWorker(mode string) error {
	r := bufio.NewReader(os.Stdin)
	hello, err := readFrame(r)
	if err != nil {
		return err
	}
	if mode == "hang-handshake" {
		_, err := readFrame(r)
		return err
	}
	ready := frame{Type: "ready", Version: protocolVersion, Generation: hello.Generation}
	if mode == "wrong-version" {
		ready.Version++
	}
	if mode == "oversized" {
		_, err := io.WriteString(os.Stdout, strings.Repeat("x", MaxFrameBytes+2)+"\n")
		return err
	}
	if err := writeFrame(os.Stdout, ready); err != nil {
		return err
	}
	start, err := readFrame(r)
	if err != nil || start.Type == "shutdown" {
		return err
	}
	if mode == "crash" {
		os.Exit(19)
	}
	index := 0
	call := frame{Version: protocolVersion, Generation: hello.Generation, Type: "tool/call", RunID: start.RunID, RequestID: start.RequestID, Index: &index, Tool: start.Steps[0].Tool, Args: start.Steps[0].Args}
	switch mode {
	case "bad-step":
		index = 1
	case "bad-args":
		call.Args = json.RawMessage(`{"changed":true}`)
	case "bad-run":
		call.RunID = "another-run"
	case "bad-generation":
		call.Generation = "another-generation"
	case "early-success":
		call = frame{Version: protocolVersion, Generation: hello.Generation, Type: "run/finished", RunID: start.RunID, RequestID: start.RequestID, Status: "succeeded"}
	}
	if err := writeFrame(os.Stdout, call); err != nil {
		return err
	}
	if mode == "duplicate" {
		if err := writeFrame(os.Stdout, call); err != nil {
			return err
		}
	}
	for {
		f, err := readFrame(r)
		if err != nil || f.Type == "shutdown" {
			return nil
		}
	}
}

func testOptions(mode string) Options {
	return Options{Path: os.Args[0], Args: []string{"-test.run=^TestWorkerSubprocess$"}, Env: []string{"ELYSIAN_WORKER_TEST_MODE=" + mode}, HandshakeTimeout: 3 * time.Second}
}

func startTestWorker(t *testing.T, mode string) *process {
	t.Helper()
	worker, err := Spawn(context.Background(), testOptions(mode))
	if err != nil {
		t.Fatalf("启动测试工作进程失败：%v", err)
	}
	p := worker.(*process)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		defer cancel()
		if err := p.Close(ctx); err != nil {
			t.Errorf("工作进程未被回收：%v", err)
		}
	})
	return p
}

func noTool(context.Context, int, string, json.RawMessage) (json.RawMessage, error) {
	return json.RawMessage(`{"ok":true}`), nil
}

func TestProcessRunsSerialStepsAndReusesProcess(t *testing.T) {
	p := startTestWorker(t, "normal")
	steps := []Step{{Tool: "first", Args: json.RawMessage(` { "text": "<x>", "n":9007199254740993 } `)}, {Tool: "second"}}
	var calls []int
	invoke := func(_ context.Context, index int, tool string, args json.RawMessage) (json.RawMessage, error) {
		calls = append(calls, index)
		if index == 0 && !strings.Contains(string(args), "9007199254740993") {
			t.Errorf("参数中的大整数被损坏：%s", args)
		}
		if tool != steps[index].Tool {
			t.Errorf("调用了错误工具：%s", tool)
		}
		// 处理器持有自己的参数副本，不能污染下一次运行的计划。
		args[0] = '!'
		return json.RawMessage(`{"result":"<完成>"}`), nil
	}
	for i := 0; i < 2; i++ {
		if err := p.Run(context.Background(), "repeatable-run", steps, invoke); err != nil {
			t.Fatal(err)
		}
	}
	if fmt.Sprint(calls) != "[0 1 0 1]" || p.sequence != 2 {
		t.Fatalf("步骤未按顺序执行或请求身份未更新：%v，%d", calls, p.sequence)
	}
	if err := p.Run(context.Background(), "empty-run", nil, noTool); err != nil {
		t.Fatal(err)
	}
}

func TestToolErrorPreservesCauseAndWorkerRemainsReusable(t *testing.T) {
	p := startTestWorker(t, "normal")
	want := errors.New("域操作失败")
	err := p.Run(context.Background(), "failed-run", []Step{{Tool: "first"}, {Tool: "second"}}, func(_ context.Context, index int, _ string, _ json.RawMessage) (json.RawMessage, error) {
		if index != 0 {
			t.Error("失败后不应继续执行")
		}
		return nil, want
	})
	var toolErr *ToolError
	if !errors.As(err, &toolErr) || !errors.Is(err, want) || toolErr.Index != 0 || toolErr.Tool != "first" {
		t.Fatalf("工具错误未保留原始原因：%v", err)
	}
	if err := p.Run(context.Background(), "next-run", []Step{{Tool: "first"}}, noTool); err != nil {
		t.Fatalf("工具失败后进程应继续可用：%v", err)
	}
}

func TestInvalidAndOversizedResultsFailRunWithoutBreakingProcess(t *testing.T) {
	p := startTestWorker(t, "normal")
	for _, result := range []json.RawMessage{json.RawMessage(`oops`), json.RawMessage(`"` + strings.Repeat("x", MaxFrameBytes) + `"`)} {
		err := p.Run(context.Background(), "bad-result", []Step{{Tool: "read"}}, func(context.Context, int, string, json.RawMessage) (json.RawMessage, error) { return result, nil })
		var toolErr *ToolError
		if !errors.As(err, &toolErr) {
			t.Fatalf("无效工具结果必须形成工具错误：%v", err)
		}
	}
	if err := p.Run(context.Background(), "next-run", nil, noTool); err != nil {
		t.Fatal(err)
	}
}

func TestProcessRejectsConcurrentRunAndCancelsCooperatively(t *testing.T) {
	p := startTestWorker(t, "normal")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		result <- p.Run(ctx, "cancel-run", []Step{{Tool: "wait"}}, func(ctx context.Context, _ int, _ string, _ json.RawMessage) (json.RawMessage, error) {
			close(entered)
			<-ctx.Done()
			return nil, ctx.Err()
		})
	}()
	<-entered
	if err := p.Run(context.Background(), "other-run", nil, noTool); !errors.Is(err, ErrBusy) {
		t.Fatalf("同一进程必须拒绝并发运行：%v", err)
	}
	cancel()
	select {
	case err := <-result:
		var interrupted *InterruptedError
		if !errors.Is(err, context.Canceled) || errors.As(err, &interrupted) {
			t.Fatalf("协作取消不应中断工作进程：%v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("工作进程未及时响应取消")
	}
	if err := p.Run(context.Background(), "after-cancel", []Step{{Tool: "read"}}, noTool); err != nil {
		t.Fatal(err)
	}
}

func TestUnresponsiveCancellationKillsAndReapsWorker(t *testing.T) {
	p := startTestWorker(t, "ignore-cancel")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		result <- p.Run(ctx, "cancel-run", []Step{{Tool: "wait"}}, func(ctx context.Context, _ int, _ string, _ json.RawMessage) (json.RawMessage, error) {
			close(entered)
			<-ctx.Done()
			return nil, ctx.Err()
		})
	}()
	<-entered
	cancel()
	select {
	case err := <-result:
		var interrupted *InterruptedError
		if !errors.As(err, &interrupted) || !errors.Is(err, context.Canceled) {
			t.Fatalf("强制取消应保留中断与取消原因：%v", err)
		}
	case <-time.After(7 * time.Second):
		t.Fatal("强制取消未按时完成")
	}
	select {
	case <-p.exited:
	default:
		t.Fatal("返回中断前必须 Wait 回收子进程")
	}
}

func TestWorkerProtocolCannotInvokeUnplannedSteps(t *testing.T) {
	for _, mode := range []string{"bad-step", "bad-args", "bad-run", "bad-generation", "early-success", "crash"} {
		t.Run(mode, func(t *testing.T) {
			p := startTestWorker(t, mode)
			var called atomic.Int32
			err := p.Run(context.Background(), "guarded-run", []Step{{Tool: "read"}, {Tool: "next"}}, func(context.Context, int, string, json.RawMessage) (json.RawMessage, error) {
				called.Add(1)
				return nil, nil
			})
			var interrupted *InterruptedError
			if !errors.As(err, &interrupted) || called.Load() != 0 {
				t.Fatalf("非法消息不得触达工具：调用 %d 次，错误 %v", called.Load(), err)
			}
		})
	}
}

func TestDuplicateCallCannotRepeatTool(t *testing.T) {
	p := startTestWorker(t, "duplicate")
	var called atomic.Int32
	err := p.Run(context.Background(), "guarded-run", []Step{{Tool: "read"}}, func(context.Context, int, string, json.RawMessage) (json.RawMessage, error) {
		called.Add(1)
		return nil, nil
	})
	var interrupted *InterruptedError
	if !errors.As(err, &interrupted) || called.Load() > 1 {
		t.Fatalf("重复调用必须中断且最多触达工具一次：%d，%v", called.Load(), err)
	}
}

func TestHandshakeRejectsVersionOversizeAndTimeout(t *testing.T) {
	for _, mode := range []string{"wrong-version", "oversized", "hang-handshake"} {
		t.Run(mode, func(t *testing.T) {
			opts := testOptions(mode)
			opts.HandshakeTimeout = 100 * time.Millisecond
			p, err := Spawn(context.Background(), opts)
			if p != nil || err == nil {
				t.Fatalf("无效握手应启动失败：%v", err)
			}
			var interrupted *InterruptedError
			if !errors.As(err, &interrupted) {
				t.Fatalf("握手错误缺少中断类型：%v", err)
			}
		})
	}
}

func TestEOFStopsWorkerAndCloseIsIdempotent(t *testing.T) {
	p := startTestWorker(t, "normal")
	if err := p.stdin.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.exited:
	case <-time.After(2 * time.Second):
		t.Fatal("父管道 EOF 后工作进程必须退出")
	}
	if err := p.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := p.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := p.Run(context.Background(), "closed", nil, noTool); err == nil {
		t.Fatal("关闭后不能运行任务")
	}
}

func TestDoneNotifiesIdleWorkerExit(t *testing.T) {
	var child Process = startTestWorker(t, "normal")
	observer, ok := child.(interface{ Done() <-chan struct{} })
	if !ok {
		t.Fatal("真实工作进程必须提供可选的退出通知")
	}
	select {
	case <-observer.Done():
		t.Fatal("就绪的空闲进程不应已退出")
	default:
	}
	if err := child.(*process).stdin.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-observer.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("空闲进程退出没有通知监督器")
	}
}

func TestStderrIsDrainedWithBoundedMemory(t *testing.T) {
	p := startTestWorker(t, "stderr")
	if err := p.Run(context.Background(), "stderr-run", nil, noTool); err != nil {
		t.Fatal(err)
	}
	p.stderr.mu.Lock()
	defer p.stderr.mu.Unlock()
	if len(p.stderr.data) != 4096 {
		t.Fatalf("stderr 缓冲必须固定上限：%d", len(p.stderr.data))
	}
}

func TestCloseCancelsActiveInvoker(t *testing.T) {
	p := startTestWorker(t, "normal")
	entered, exited := make(chan struct{}), make(chan struct{})
	result := make(chan error, 1)
	go func() {
		result <- p.Run(context.Background(), "active-close", []Step{{Tool: "wait"}}, func(ctx context.Context, _ int, _ string, _ json.RawMessage) (json.RawMessage, error) {
			close(entered)
			<-ctx.Done()
			close(exited)
			return nil, ctx.Err()
		})
	}()
	<-entered
	if err := p.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-exited:
	case <-time.After(time.Second):
		t.Fatal("关闭未取消父进程中的工具上下文")
	}
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("活动运行被关闭不能成功")
		}
	case <-time.After(time.Second):
		t.Fatal("关闭后活动运行没有返回")
	}
}

func TestUncooperativeInvokerDoesNotReportCancellationBeforeGrace(t *testing.T) {
	p := startTestWorker(t, "normal")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered, release, returned := make(chan struct{}), make(chan struct{}), make(chan struct{})
	defer close(release)
	result := make(chan error, 1)
	go func() {
		result <- p.Run(ctx, "slow-broker", []Step{{Tool: "wait"}}, func(context.Context, int, string, json.RawMessage) (json.RawMessage, error) {
			close(entered)
			<-release
			close(returned)
			return nil, nil
		})
	}()
	<-entered
	cancel()
	select {
	case err := <-result:
		t.Fatalf("尚未收尾的真实工具不得被立即报为已取消：%v", err)
	case <-time.After(100 * time.Millisecond):
	}
	select {
	case err := <-result:
		var interrupted *InterruptedError
		if !errors.As(err, &interrupted) || !errors.Is(err, context.Canceled) {
			t.Fatalf("工具超出收尾时间必须明确报中断：%v", err)
		}
	case <-time.After(7 * time.Second):
		t.Fatal("未响应取消的工具阻塞了调用方")
	}
}

func TestEOFInterruptsActiveRunAndCancelsBroker(t *testing.T) {
	p := startTestWorker(t, "normal")
	entered, brokerExited := make(chan struct{}), make(chan struct{})
	result := make(chan error, 1)
	go func() {
		result <- p.Run(context.Background(), "eof-active", []Step{{Tool: "wait"}}, func(ctx context.Context, _ int, _ string, _ json.RawMessage) (json.RawMessage, error) {
			close(entered)
			<-ctx.Done()
			close(brokerExited)
			return nil, ctx.Err()
		})
	}()
	<-entered
	if err := p.stdin.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		var interrupted *InterruptedError
		if !errors.As(err, &interrupted) {
			t.Fatalf("活动运行遇 EOF 必须中断：%v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("EOF 未结束活动运行")
	}
	select {
	case <-brokerExited:
	case <-time.After(time.Second):
		t.Fatal("EOF 未取消父进程工具")
	}
}

func TestRejectedPlanDoesNotPoisonWorker(t *testing.T) {
	p := startTestWorker(t, "normal")
	for _, steps := range [][]Step{
		{{Tool: "bad/tool"}},
		{{Tool: "read", Args: json.RawMessage(`null`)}},
		{{Tool: "read", Args: json.RawMessage(`[]`)}},
		{{Tool: "read", Args: json.RawMessage(`{"content":"` + strings.Repeat("x", MaxFrameBytes) + `"}`)}},
	} {
		if err := p.Run(context.Background(), "bad-plan", steps, noTool); err == nil {
			t.Fatal("无效计划必须被拒绝")
		}
	}
	if err := p.Run(context.Background(), "valid-plan", []Step{{Tool: "read"}}, noTool); err != nil {
		t.Fatal(err)
	}
}

// 外部门禁先在容器临时目录构建真实 elysian，再显式注入路径；普通单测不递归构建。
func TestRealBinaryProtocol(t *testing.T) {
	path := os.Getenv("ELYSIAN_WORKER_REAL_BINARY")
	if path == "" {
		t.Skip("未指定真实二进制验收路径")
	}
	p, err := Spawn(context.Background(), Options{Path: path, Args: []string{"__agent-worker"}})
	if err != nil {
		t.Fatalf("真实二进制握手失败：%v", err)
	}
	defer p.Close(context.Background())
	if err := p.Run(context.Background(), "real-binary", []Step{{Tool: "read"}}, noTool); err != nil {
		t.Fatal(err)
	}
}
