package harness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/worker"
	"elysian/server/internal/agent/tools"
)

type runtimeTestTools struct {
	execute func(context.Context, string) (any, error)
	count   atomic.Int32
}

func (*runtimeTestTools) Available() bool               { return true }
func (*runtimeTestTools) Schemas() []tools.PublicSchema { return nil }
func (b *runtimeTestTools) Execute(ctx context.Context, name string, _ map[string]any) (any, error) {
	b.count.Add(1)
	if b.execute != nil {
		return b.execute(ctx, name)
	}
	return map[string]any{"tool": name}, nil
}

type runtimeTestProcess struct {
	run  func(context.Context, string, []worker.Step, worker.Invoker) error
	done chan struct{}
}

func (p *runtimeTestProcess) Run(ctx context.Context, id string, steps []worker.Step, invoke worker.Invoker) error {
	if p.run != nil {
		return p.run(ctx, id, steps, invoke)
	}
	for i, step := range steps {
		if _, err := invoke(ctx, i, step.Tool, step.Args); err != nil {
			return &worker.ToolError{Index: i, Tool: step.Tool, Err: err}
		}
	}
	return nil
}
func (*runtimeTestProcess) Close(context.Context) error { return nil }
func (p *runtimeTestProcess) Done() <-chan struct{}     { return p.done }

func runtimeEventually(t *testing.T, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !f() {
		if time.Now().After(deadline) {
			t.Fatal("等待运行状态超时")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
func runtimeManager(t *testing.T, b *runtimeTestTools, change func(*Deps)) *Manager {
	t.Helper()
	deps := Deps{Path: filepath.Join(t.TempDir(), "harness.sqlite"), Tools: b,
		Spawn: func(context.Context) (worker.Process, error) { return &runtimeTestProcess{}, nil }, Limits: DefaultLimits()}
	deps.Limits.Concurrency = 1
	if change != nil {
		change(&deps)
	}
	m, err := New(deps)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := m.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	runtimeEventually(t, func() bool { return m.Info().Available })
	return m
}
func runtimeInput(key string, names ...string) SubmitInput {
	steps := make([]Step, len(names))
	for i, name := range names {
		steps[i] = Step{Tool: name, Args: map[string]any{}}
	}
	return SubmitInput{RequestID: key, Kind: "tool-batch", Steps: steps}
}
func runtimeSubmit(t *testing.T, m *Manager, key string, names ...string) Run {
	t.Helper()
	r, duplicate, err := m.Submit(context.Background(), runtimeInput(key, names...))
	if err != nil || duplicate {
		t.Fatalf("提交失败 duplicate=%v err=%v", duplicate, err)
	}
	return r
}
func runtimeFinished(t *testing.T, m *Manager, id string) Run {
	t.Helper()
	var got Run
	runtimeEventually(t, func() bool {
		var err error
		got, err = m.Get(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		return terminal(got.Status)
	})
	return got
}
func runtimeErrorCode(t *testing.T, err error, code string) {
	t.Helper()
	var typed *Error
	if !errors.As(err, &typed) || typed.Code != code {
		t.Fatalf("错误=%v，期望 %s", err, code)
	}
}

// 此测试进程实际运行同一套 Worker 服务，覆盖数据库→IPC→父工具→数据库闭环。
func TestRuntimeWorkerHelper(t *testing.T) {
	if os.Getenv("ELYSIAN_RUNTIME_TEST_CHILD") != "1" {
		return
	}
	if err := worker.Serve(os.Stdin, os.Stdout, os.Stderr); err != nil {
		os.Exit(2)
	}
	os.Exit(0)
}
func TestManagerRealWorkerPersistsResultsAndEventSequence(t *testing.T) {
	b := &runtimeTestTools{}
	m := runtimeManager(t, b, func(d *Deps) {
		d.Spawn = func(ctx context.Context) (worker.Process, error) {
			return worker.Spawn(ctx, worker.Options{Path: os.Args[0], Args: []string{"-test.run=^TestRuntimeWorkerHelper$"}, Env: []string{"HOME=/tmp", "ELYSIAN_RUNTIME_TEST_CHILD=1"}})
		}
	})
	r := runtimeSubmit(t, m, "real-worker", "docker_containers_list", "docker_images_list")
	got := runtimeFinished(t, m, r.ID)
	if got.Status != StateSucceeded || got.Usage.Calls != 2 || got.Usage.ResultBytes == 0 {
		t.Fatalf("运行错误: %+v", got)
	}
	calls, err := m.Calls(context.Background(), r.ID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(calls.Items) != 2 || calls.Items[0].Status != StateSucceeded || !json.Valid(calls.Items[1].Result) {
		t.Fatalf("调用未持久化: %+v", calls)
	}
	page, err := m.Events(context.Background(), r.ID, "0", 100)
	if err != nil {
		t.Fatal(err)
	}
	for i, event := range page.Items {
		if event.Seq != fmt.Sprint(i+1) {
			t.Fatalf("事件乱序: %+v", page)
		}
	}
	if page.Items[len(page.Items)-1].Type != "run/succeeded" {
		t.Fatalf("无成功事实: %+v", page)
	}
	before := got.LastSeq
	got, err = m.Cancel(context.Background(), r.ID)
	if err != nil || got.Status != StateSucceeded || got.LastSeq != before {
		t.Fatalf("终态被取消重写: %+v %v", got, err)
	}
}

func TestManagerIdempotencyIsAtomicAndInputIsImmutable(t *testing.T) {
	b := &runtimeTestTools{}
	m := runtimeManager(t, b, nil)
	input := runtimeInput("same-key", "docker_policy_view")
	var wg sync.WaitGroup
	ids := make(chan string, 20)
	errs := make(chan error, 20)
	var fresh atomic.Int32
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, dup, err := m.Submit(context.Background(), input)
			if err != nil {
				errs <- err
				return
			}
			if !dup {
				fresh.Add(1)
			}
			ids <- r.ID
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	var id string
	for got := range ids {
		if id != "" && id != got {
			t.Fatalf("重复创建 %s / %s", id, got)
		}
		id = got
	}
	if fresh.Load() != 1 {
		t.Fatalf("新建次数=%d", fresh.Load())
	}
	input.Steps[0].Tool = "docker_self_container"
	input.Steps[0].Args["changed"] = true
	_, _, err := m.Submit(context.Background(), input)
	runtimeErrorCode(t, err, "request-conflict")
	got := runtimeFinished(t, m, id)
	if got.Task.Steps[0].Tool != "docker_policy_view" || len(got.Task.Steps[0].Args) != 0 || b.count.Load() != 1 {
		t.Fatalf("输入快照或单次执行失效: %+v", got)
	}
	_, _, err = m.Submit(context.Background(), runtimeInput("bad-tool", "docker_container_delete"))
	runtimeErrorCode(t, err, "tool-denied")
	badArgs := runtimeInput("bad-args", "docker_policy_view")
	badArgs.Steps[0].Args["limit"] = 2
	_, _, err = m.Submit(context.Background(), badArgs)
	runtimeErrorCode(t, err, "invalid-arguments")
}

func TestManagerQueueBoundFIFOAndQueuedCancel(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	var mu sync.Mutex
	var names []string
	b := &runtimeTestTools{execute: func(ctx context.Context, name string) (any, error) {
		mu.Lock()
		names = append(names, name)
		mu.Unlock()
		if name == "docker_containers_list" {
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return []string{}, nil
	}}
	m := runtimeManager(t, b, func(d *Deps) { d.Limits.QueueCapacity = 2 })
	a := runtimeSubmit(t, m, "first", "docker_containers_list")
	<-entered
	x := runtimeSubmit(t, m, "cancel-queued", "docker_images_list")
	y := runtimeSubmit(t, m, "last", "docker_policy_view")
	_, _, err := m.Submit(context.Background(), runtimeInput("overflow", "docker_self_container"))
	runtimeErrorCode(t, err, "queue-full")
	if _, err = m.Cancel(context.Background(), x.ID); err != nil {
		t.Fatal(err)
	}
	once.Do(func() { close(release) })
	if runtimeFinished(t, m, a.ID).Status != StateSucceeded || runtimeFinished(t, m, x.ID).Status != StateCancelled || runtimeFinished(t, m, y.ID).Status != StateSucceeded {
		t.Fatal("FIFO 或取消失败")
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(names, ",") != "docker_containers_list,docker_policy_view" {
		t.Fatalf("派发=%v", names)
	}
}

func TestManagerCancellationStopsActiveBatchAndPreservesIntent(t *testing.T) {
	entered := make(chan struct{})
	b := &runtimeTestTools{execute: func(ctx context.Context, _ string) (any, error) { close(entered); <-ctx.Done(); return nil, ctx.Err() }}
	m := runtimeManager(t, b, nil)
	r := runtimeSubmit(t, m, "active-cancel", "docker_images_list", "docker_policy_view")
	<-entered
	requested, err := m.Cancel(context.Background(), r.ID)
	if err != nil || requested.CancelRequestedAt == "" {
		t.Fatalf("取消意图未提交: %+v %v", requested, err)
	}
	got := runtimeFinished(t, m, r.ID)
	if got.Status != StateCancelled || b.count.Load() != 1 {
		t.Fatalf("取消后继续执行: %+v", got)
	}
}

func TestManagerCallerCancellationDoesNotDisableStorage(t *testing.T) {
	b := &runtimeTestTools{}
	m := runtimeManager(t, b, nil)
	m.mu.Lock()
	m.store.beforeWrite = func(op string) error {
		if op == "submit" || op == "cancel" {
			return context.Canceled
		}
		return nil
	}
	m.mu.Unlock()
	_, _, err := m.Submit(context.Background(), runtimeInput("cancel-request", "docker_images_list"))
	runtimeErrorCode(t, err, "request-cancelled")
	if !m.Info().Available {
		t.Fatal("HTTP 请求取消误伤存储")
	}
	m.mu.Lock()
	m.store.beforeWrite = nil
	m.mu.Unlock()
	r := runtimeSubmit(t, m, "accepted", "docker_images_list")
	runtimeFinished(t, m, r.ID)
	m.mu.Lock()
	m.store.beforeWrite = func(string) error { return context.Canceled }
	m.mu.Unlock()
	_, err = m.Cancel(context.Background(), r.ID)
	runtimeErrorCode(t, err, "request-cancelled")
	if !m.Info().Available {
		t.Fatal("取消 HTTP 请求误伤存储")
	}
	m.mu.Lock()
	m.store.beforeWrite = nil
	m.mu.Unlock()
}

func TestManagerCallDeadlineRejectsLateSuccess(t *testing.T) {
	b := &runtimeTestTools{execute: func(ctx context.Context, _ string) (any, error) { <-ctx.Done(); return "late-success", nil }}
	m := runtimeManager(t, b, func(d *Deps) { d.Limits.CallTimeoutSeconds = 1; d.Limits.CancelGraceSeconds = 1 })
	r := runtimeSubmit(t, m, "late-success", "docker_images_list", "docker_policy_view")
	got := runtimeFinished(t, m, r.ID)
	if got.Status != StateFailed || got.EndReason != "call-timeout" || b.count.Load() != 1 {
		t.Fatalf("超时仍推进: %+v", got)
	}
}

func TestManagerRunDeadlineIsDistinctFromCallDeadline(t *testing.T) {
	b := &runtimeTestTools{execute: func(ctx context.Context, _ string) (any, error) { <-ctx.Done(); return nil, ctx.Err() }}
	m := runtimeManager(t, b, func(d *Deps) { d.Limits.RunTimeoutSeconds = 1 })
	r := runtimeSubmit(t, m, "run-timeout", "docker_images_list")
	got := runtimeFinished(t, m, r.ID)
	if got.Status != StateFailed || got.EndReason != "run-timeout" {
		t.Fatalf("总运行超时分类错误: %+v", got)
	}
}

func TestManagerUnresponsiveToolRetainsOnlyExecutionSlot(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{})
	var once sync.Once
	b := &runtimeTestTools{execute: func(context.Context, string) (any, error) { close(entered); <-release; return "late", nil }}
	m := runtimeManager(t, b, func(d *Deps) { d.Limits.CallTimeoutSeconds = 1; d.Limits.CancelGraceSeconds = 1 })
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	r := runtimeSubmit(t, m, "stuck", "docker_images_list")
	<-entered
	next := runtimeSubmit(t, m, "must-stay-queued", "docker_policy_view")
	got := runtimeFinished(t, m, r.ID)
	if got.Status != StateInterrupted || got.EndReason != "tool-unresponsive" {
		t.Fatalf("假报完成: %+v", got)
	}
	if m.Info().Available {
		t.Fatal("工具未停止却宣称可用")
	}
	m.mu.Lock()
	active := m.activeID
	m.mu.Unlock()
	if active != r.ID {
		t.Fatal("提前释放执行槽")
	}
	once.Do(func() { close(release) })
	queued, err := m.Get(context.Background(), next.ID)
	if err != nil || queued.Status != StateQueued || b.count.Load() != 1 {
		t.Fatalf("错误重派发: %+v %v", queued, err)
	}
}

func TestManagerWorkerCrashWaitsForParentToolBeforeNextRun(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	var spawn atomic.Int32
	b := &runtimeTestTools{execute: func(ctx context.Context, name string) (any, error) {
		if name == "docker_images_list" {
			close(entered)
			<-ctx.Done()
			<-release
			return nil, ctx.Err()
		}
		return "next", nil
	}}
	m := runtimeManager(t, b, func(d *Deps) {
		d.Spawn = func(context.Context) (worker.Process, error) {
			if spawn.Add(1) != 1 {
				return &runtimeTestProcess{}, nil
			}
			return &runtimeTestProcess{run: func(ctx context.Context, _ string, steps []worker.Step, invoke worker.Invoker) error {
				go invoke(ctx, 0, steps[0].Tool, steps[0].Args)
				<-entered
				return &worker.InterruptedError{Err: errors.New("worker crashed")}
			}}, nil
		}
	})
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	r := runtimeSubmit(t, m, "crash", "docker_images_list")
	<-entered
	next := runtimeSubmit(t, m, "after-crash", "docker_policy_view")
	runtimeEventually(t, func() bool { m.mu.Lock(); defer m.mu.Unlock(); return m.finishing })
	if b.count.Load() != 1 {
		t.Fatal("父工具退出前执行第二项任务")
	}
	once.Do(func() { close(release) })
	if got := runtimeFinished(t, m, r.ID); got.Status != StateInterrupted || got.EndReason != "worker-lost" {
		t.Fatalf("崩溃状态错误: %+v", got)
	}
	if got := runtimeFinished(t, m, next.ID); got.Status != StateSucceeded {
		t.Fatalf("后续任务未恢复: %+v", got)
	}
}

func TestManagerStorageFailureStopsBeforeEffectOrNextStep(t *testing.T) {
	for _, op := range []string{"call-intent", "call-result"} {
		t.Run(op, func(t *testing.T) {
			b := &runtimeTestTools{}
			m := runtimeManager(t, b, nil)
			m.mu.Lock()
			m.store.beforeWrite = func(operation string) error {
				if operation == op {
					return errors.New("disk full secret-marker")
				}
				return nil
			}
			m.mu.Unlock()
			r := runtimeSubmit(t, m, "disk-failure", "docker_images_list", "docker_policy_view")
			runtimeEventually(t, func() bool { return m.Info().Storage == "unavailable" })
			want := int32(0)
			if op == "call-result" {
				want = 1
			}
			if b.count.Load() != want {
				t.Fatalf("存储失败后执行了工具 count=%d", b.count.Load())
			}
			got, err := m.Get(context.Background(), r.ID)
			if err != nil || got.Status == StateSucceeded {
				t.Fatalf("错误成功: %+v %v", got, err)
			}
			if strings.Contains(m.Info().Reason, "secret-marker") {
				t.Fatal("泄漏底层错误")
			}
			if err = m.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
			s, err := openStore(m.deps.Path, time.Now)
			if err != nil {
				t.Fatal(err)
			}
			defer s.close()
			if err = s.recover(context.Background()); err != nil {
				t.Fatal(err)
			}
			got, err = s.get(context.Background(), r.ID)
			if err != nil || got.Status != StateInterrupted {
				t.Fatalf("重启未保留不确定性: %+v %v", got, err)
			}
		})
	}
}

func TestManagerResultBudgetsAndFailureAreFailFast(t *testing.T) {
	for _, mode := range []string{"total", "single", "error", "panic", "truncated"} {
		t.Run(mode, func(t *testing.T) {
			b := &runtimeTestTools{execute: func(context.Context, string) (any, error) {
				switch mode {
				case "error":
					return nil, errors.New("password=secret-marker")
				case "panic":
					panic("secret-marker")
				case "truncated":
					return []string{strings.Repeat("x", 40), strings.Repeat("y", 40)}, nil
				}
				return strings.Repeat("x", 40), nil
			}}
			m := runtimeManager(t, b, func(d *Deps) {
				d.Limits.ResultBytes = 64
				if mode == "single" {
					d.Limits.ResultBytes = 16
				}
				if mode == "total" {
					d.Limits.RunResultBytes = 60
				}
			})
			r := runtimeSubmit(t, m, "budget", "docker_images_list", "docker_policy_view", "docker_self_container")
			got := runtimeFinished(t, m, r.ID)
			calls, err := m.Calls(context.Background(), r.ID, "", 50)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "truncated" {
				if got.Status != StateSucceeded || !calls.Items[0].Truncated || !json.Valid(calls.Items[0].Result) {
					t.Fatalf("截断错误: %+v %+v", got, calls)
				}
				return
			}
			want := int32(1)
			if mode == "total" {
				want = 2
			}
			if got.Status != StateFailed || b.count.Load() != want {
				t.Fatalf("未停止后续调用: %+v count=%d", got, b.count.Load())
			}
			raw, _ := json.Marshal(calls)
			if strings.Contains(string(raw), "secret-marker") {
				t.Fatal("持久结果泄露工具错误")
			}
		})
	}
}

func TestManagerRestartDispatchesQueuedButNeverReplaysRunning(t *testing.T) {
	path := filepath.Join(t.TempDir(), "harness.sqlite")
	s, err := openStore(path, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	queued := createRuntimeTestRun(t, s, "queued-restart", time.Now())
	running := createRuntimeTestRun(t, s, "running-restart", time.Now())
	startRuntimeTestRun(t, s, running.ID)
	if err = s.close(); err != nil {
		t.Fatal(err)
	}
	b := &runtimeTestTools{}
	m := runtimeManager(t, b, func(d *Deps) { d.Path = path })
	if got := runtimeFinished(t, m, queued.ID); got.Status != StateSucceeded {
		t.Fatalf("排队任务未恢复: %+v", got)
	}
	if got := runtimeFinished(t, m, running.ID); got.Status != StateInterrupted {
		t.Fatalf("运行被重放: %+v", got)
	}
	if b.count.Load() != 1 {
		t.Fatalf("执行次数=%d", b.count.Load())
	}
}

func TestManagerObservesIdleWorkerExitAndRestarts(t *testing.T) {
	dead := make(chan struct{})
	var starts atomic.Int32
	m := runtimeManager(t, &runtimeTestTools{}, func(d *Deps) {
		d.Spawn = func(context.Context) (worker.Process, error) {
			if starts.Add(1) == 1 {
				return &runtimeTestProcess{done: dead}, nil
			}
			return &runtimeTestProcess{}, nil
		}
	})
	close(dead)
	runtimeEventually(t, func() bool { return starts.Load() >= 2 && m.Info().Available })
}

func TestManagerCancelCommittedBeforeFinishWinsOverLastToolSuccess(t *testing.T) {
	completed := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	m := runtimeManager(t, &runtimeTestTools{}, func(d *Deps) {
		d.Spawn = func(context.Context) (worker.Process, error) {
			return &runtimeTestProcess{run: func(ctx context.Context, _ string, steps []worker.Step, invoke worker.Invoker) error {
				_, err := invoke(ctx, 0, steps[0].Tool, steps[0].Args)
				close(completed)
				select {
				case <-release:
				case <-ctx.Done():
				}
				return err
			}}, nil
		}
	})
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	r := runtimeSubmit(t, m, "finish-race", "docker_images_list")
	<-completed
	if _, err := m.Cancel(context.Background(), r.ID); err != nil {
		t.Fatal(err)
	}
	once.Do(func() { close(release) })
	got := runtimeFinished(t, m, r.ID)
	if got.Status != StateCancelled {
		t.Fatalf("取消先落盘却被完成覆盖: %+v", got)
	}
	calls, err := m.Calls(context.Background(), r.ID, "", 50)
	if err != nil || calls.Items[0].Status != StateSucceeded {
		t.Fatalf("已经确认的工具成功事实丢失: %+v %v", calls, err)
	}
}

func TestManagerCloseInterruptsActiveAndKeepsQueuedForRestart(t *testing.T) {
	entered := make(chan struct{})
	b := &runtimeTestTools{execute: func(ctx context.Context, _ string) (any, error) { close(entered); <-ctx.Done(); return nil, ctx.Err() }}
	m := runtimeManager(t, b, nil)
	r := runtimeSubmit(t, m, "stop-active", "docker_images_list")
	<-entered
	queued := runtimeSubmit(t, m, "keep-queue", "docker_policy_view")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := m.Close(ctx); err != nil {
		t.Fatal(err)
	}
	s, err := openStore(m.deps.Path, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	got, err := s.get(context.Background(), r.ID)
	if err != nil || got.Status != StateInterrupted {
		t.Fatalf("停服未确认中断: %+v %v", got, err)
	}
	got, err = s.get(context.Background(), queued.ID)
	if err != nil || got.Status != StateQueued {
		t.Fatalf("排队输入未保留: %+v %v", got, err)
	}
}

func TestManagerListProjectionCapsRecordsAndBytesAtWholeEntries(t *testing.T) {
	rows := make([]map[string]string, 201)
	for i := range rows {
		rows[i] = map[string]string{"id": fmt.Sprint(i)}
	}
	result, truncated, err := projectResult(rows, 262144)
	if err != nil || !truncated {
		t.Fatalf("缺少数量截断: %v %v", truncated, err)
	}
	var got []map[string]string
	if err = json.Unmarshal(result, &got); err != nil || len(got) != 200 {
		t.Fatalf("截断破坏记录: count=%d err=%v", len(got), err)
	}
	result, truncated, err = projectResult(rows, 16)
	if err != nil || !truncated || len(result) > 16 || !json.Valid(result) {
		t.Fatalf("字节边界错误: %s %v", result, err)
	}
}
