package panel

import (
	"context"
	"elysian/server/internal/config"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

type lifecycleHost struct {
	*fakeHost
	preflight func(context.Context, config.PanelNetwork, config.PanelNetwork) error
	dispatch  func(context.Context, string, string) error
	probe     func(context.Context, string) WorkerStatus
}

func (h *lifecycleHost) Preflight(ctx context.Context, old, next config.PanelNetwork) error {
	if h.preflight != nil {
		return h.preflight(ctx, old, next)
	}
	return h.fakeHost.Preflight(ctx, old, next)
}
func (h *lifecycleHost) Dispatch(ctx context.Context, worker, id string) error {
	if h.dispatch != nil {
		h.dispatched++
		return h.dispatch(ctx, worker, id)
	}
	return h.fakeHost.Dispatch(ctx, worker, id)
}
func (h *lifecycleHost) ProbeWorker(ctx context.Context, id string) WorkerStatus {
	if h.probe != nil {
		return h.probe(ctx, id)
	}
	return h.fakeHost.ProbeWorker(ctx, id)
}

func submitManager(t *testing.T) (Manager, Worker, *lifecycleHost) {
	t.Helper()
	w, r, base := setupWorker(t, "ports")
	if err := os.Remove(w.Store.taskPath(r.ID)); err != nil {
		t.Fatal(err)
	}
	h := &lifecycleHost{fakeHost: base}
	w.Host = h
	m := Manager{Store: w.Store, Host: h, Source: fakeSource{}, Ports: r.OldPorts, Enabled: true, Executable: filepath.Join(w.install(), "releases", "old", "elysian")}
	return m, w, h
}

func TestSubmitPersistsTaskBeforeWorkerPreflight(t *testing.T) {
	m, w, h := submitManager(t)
	started, release := make(chan time.Duration, 1), make(chan struct{})
	defer close(release)
	h.preflight = func(ctx context.Context, _, _ config.PanelNetwork) error {
		deadline, ok := ctx.Deadline()
		if !ok {
			started <- 0
		} else {
			started <- time.Until(deadline)
		}
		<-release
		return fmt.Errorf("宿主端口被占用")
	}
	input := submitInput{RequestID: "request-slow-preflight", FrontendPort: 49000, BackendPort: 49001}
	accepted := make(chan Task, 1)
	failed := make(chan error, 1)
	go func() {
		task, err := m.Submit(context.Background(), "ports", input, "")
		if err != nil {
			failed <- err
			return
		}
		accepted <- task
	}()
	var task Task
	select {
	case task = <-accepted:
	case err := <-failed:
		t.Fatal(err)
	case <-started:
		t.Fatal("受理请求不应执行宿主预检")
	case <-time.After(3 * time.Second):
		t.Fatal("受理请求未及时返回")
	}
	if task.State != "queued" || task.Phase != "checking" {
		t.Fatalf("任务未先入队：%+v", task)
	}
	done := make(chan error, 1)
	go func() { done <- w.Run(context.Background(), task.ID) }()
	select {
	case budget := <-started:
		if budget < preflightBudget-time.Second || budget > preflightBudget {
			t.Fatalf("worker 预检预算无效：%v", budget)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("worker 未启动预检")
	}
	rr := httptest.NewRecorder()
	m.Router().ServeHTTP(rr, httptest.NewRequest("GET", "/tasks/by-request/"+input.RequestID, nil))
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), task.ID) || !strings.Contains(rr.Body.String(), `"state":"running"`) {
		t.Fatalf("慢预检期间无法恢复任务：%d %s", rr.Code, rr.Body.String())
	}
	release <- struct{}{}
	if err := <-done; err == nil {
		t.Fatal("预检失败应转为任务失败")
	}
	row, err := w.Store.read(task.ID)
	if err != nil || row.State != "failed" || !strings.Contains(row.Error, "宿主端口被占用") || h.starts != 0 || h.stops != 0 {
		t.Fatalf("预检失败结果不正确：%+v %v", row, err)
	}
}

func TestDispatchUncertaintyPreservesTaskAndIdempotency(t *testing.T) {
	for _, status := range []WorkerStatus{WorkerAlive, WorkerUnknown, WorkerDead} {
		t.Run(string(status), func(t *testing.T) {
			m, _, h := submitManager(t)
			h.dispatch = func(ctx context.Context, worker, id string) error {
				if ctx.Err() != nil {
					t.Fatal("派发沿用了失效的客户端上下文")
				}
				row, err := m.Store.read(id)
				if err != nil || row.State != "queued" || row.Worker != worker {
					t.Fatalf("派发前任务未持久化：%+v %v", row, err)
				}
				return context.DeadlineExceeded
			}
			h.probe = func(context.Context, string) WorkerStatus { return status }
			input := submitInput{RequestID: "request-dispatch", FrontendPort: 49000, BackendPort: 49001}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			one, err := m.Submit(ctx, "ports", input, "")
			if err != nil || one.WorkerStatus != status {
				t.Fatalf("派发结果未正确保留：%+v %v", one, err)
			}
			row, err := m.Store.read(one.ID)
			if err != nil {
				t.Fatal(err)
			}
			_, fileErr := os.Stat(row.Worker)
			if status == WorkerDead {
				if row.State != "failed" || !os.IsNotExist(fileErr) {
					t.Fatalf("明确未启动的任务未失败：%+v %v", row, fileErr)
				}
			} else if row.State != "queued" || fileErr != nil {
				t.Fatalf("存活或结果未知时删除了任务：%+v %v", row, fileErr)
			}
			two, err := m.Submit(context.Background(), "ports", input, "")
			if err != nil || two.ID != one.ID || h.dispatched != 1 {
				t.Fatalf("同一请求重复派发：%+v %v %d", two, err, h.dispatched)
			}
			input.FrontendPort++
			if _, err := m.Submit(context.Background(), "ports", input, ""); err == nil {
				t.Fatal("相同编号的不同输入未被拒绝")
			}
			if status == WorkerUnknown {
				reached := false
				rr := httptest.NewRecorder()
				m.WriteGuard(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true })).ServeHTTP(rr, httptest.NewRequest("PUT", "/api/example", nil))
				if reached || rr.Code != http.StatusConflict {
					t.Fatalf("未知派发结果解除了维护保护：%d", rr.Code)
				}
			}
		})
	}
}

func TestTaskByRequestFindsHistoryAndRejectsInvalidIDs(t *testing.T) {
	w, old, h := setupWorker(t, "update")
	old.State = "failed"
	if err := w.Store.save(old); err != nil {
		t.Fatal(err)
	}
	newer := old
	newer.ID, newer.RequestID, newer.CreatedAt = strings.Repeat("b", 32), "request-newer", old.CreatedAt.Add(time.Minute)
	if err := w.Store.save(newer); err != nil {
		t.Fatal(err)
	}
	m := Manager{Store: w.Store, Host: h}
	for _, tc := range []struct {
		id   string
		code int
	}{{old.RequestID, 200}, {"request-missing", 404}, {"bad", 400}} {
		rr := httptest.NewRecorder()
		m.Router().ServeHTTP(rr, httptest.NewRequest("GET", "/tasks/by-request/"+tc.id, nil))
		if rr.Code != tc.code || (tc.code == 200 && !strings.Contains(rr.Body.String(), old.ID)) {
			t.Fatalf("请求查询不准确：%s %d %s", tc.id, rr.Code, rr.Body.String())
		}
	}
}

func staleLifecycleTask(t *testing.T) (Manager, Worker, taskRecord, *lifecycleHost) {
	t.Helper()
	w, row, base := setupWorker(t, "update")
	row.State, row.Phase = "running", "building"
	row.UpdatedAt = time.Now().UTC().Add(-11 * time.Minute)
	row.Worker = filepath.Join(w.Store.tasksDir(), row.ID+".worker")
	if err := os.WriteFile(row.Worker, []byte("worker"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := w.Store.save(row); err != nil {
		t.Fatal(err)
	}
	h := &lifecycleHost{fakeHost: base}
	w.Host = h
	return Manager{Store: w.Store, Host: h, Ports: row.OldPorts, Enabled: true}, w, row, h
}

func TestSuperviseUnknownOrAliveKeepsMaintenanceProtection(t *testing.T) {
	for _, status := range []WorkerStatus{WorkerAlive, WorkerUnknown} {
		t.Run(string(status), func(t *testing.T) {
			m, _, row, h := staleLifecycleTask(t)
			calls := 0
			h.probe = func(context.Context, string) WorkerStatus { calls++; return status }
			got := m.superviseActive(row)
			stored, err := m.Store.read(row.ID)
			if err != nil || got.State != "running" || got.WorkerStatus != status || got.WorkerDead || stored.State != "running" || calls != 1 {
				t.Fatalf("存活或未知被判失败：%+v %+v %v", got, stored, err)
			}
			if _, err := os.Stat(row.Worker); err != nil {
				t.Fatal("删除了仍可能运行的 worker", err)
			}
		})
	}
}

func TestProbeWorkerCancelledContextCannotConfirmDeath(t *testing.T) {
	_, _, _, h := staleLifecycleTask(t)
	h.probe = func(ctx context.Context, _ string) WorkerStatus {
		<-ctx.Done()
		return WorkerDead
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	if got := probeWorker(ctx, h, "worker"); got != WorkerUnknown {
		t.Fatalf("过期探测被当成明确退出：%s", got)
	}
}

func TestSuperviseRechecksWithIndependentProbeBudget(t *testing.T) {
	m, _, row, h := staleLifecycleTask(t)
	var first context.Context
	calls := 0
	h.probe = func(ctx context.Context, _ string) WorkerStatus {
		calls++
		if calls == 1 {
			first = ctx
			return WorkerDead
		}
		if first.Err() == nil || ctx.Err() != nil {
			t.Fatal("第二次探测未使用独立预算")
		}
		return WorkerAlive
	}
	got := m.superviseActive(row)
	if calls != 2 || got.State != "running" || got.WorkerStatus != WorkerAlive || got.WorkerDead {
		t.Fatalf("复核存活后仍判失败：%+v %d", got, calls)
	}
}

func TestSuperviseRechecksLatestProgressBeforeFinalizing(t *testing.T) {
	for _, terminal := range []bool{false, true} {
		t.Run(fmt.Sprint(terminal), func(t *testing.T) {
			m, _, row, h := staleLifecycleTask(t)
			calls := 0
			h.probe = func(context.Context, string) WorkerStatus {
				calls++
				fresh := row
				fresh.UpdatedAt = time.Now().UTC()
				if terminal {
					fresh.State = "succeeded"
				}
				if err := m.Store.lock(func() error { return m.Store.save(fresh) }); err != nil {
					t.Fatal(err)
				}
				return WorkerDead
			}
			got := m.superviseActive(row)
			want := "running"
			if terminal {
				want = "succeeded"
			}
			if calls != 1 || got.State != want {
				t.Fatalf("覆盖了最新进展：%+v %d", got, calls)
			}
		})
	}
}

func TestSuperviseCannotFinalizeWhileWorkerLockIsHeld(t *testing.T) {
	m, _, row, _ := staleLifecycleTask(t)
	lock, err := m.Store.tryWorkerLock()
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	got := m.superviseActive(row)
	if got.State != "running" || got.WorkerDead || got.WorkerStatus != WorkerUnknown {
		t.Fatalf("持锁 worker 被判退出：%+v", got)
	}
	if _, err := os.Stat(row.Worker); err != nil {
		t.Fatal(err)
	}
}

func TestSuperviseConfirmedDeathReleasesProtectionAndWorker(t *testing.T) {
	m, _, row, _ := staleLifecycleTask(t)
	info, err := m.Info()
	if err != nil || info.ActiveTask != nil || info.LastTask == nil || info.LastTask.State != "failed" || info.LastTask.WorkerStatus != WorkerDead {
		t.Fatalf("确认退出后未收敛维护状态：%+v %v", info, err)
	}
	if _, err := os.Stat(row.Worker); !os.IsNotExist(err) {
		t.Fatalf("确认终态后未清理 worker：%v", err)
	}
}

func TestRecoveryUnknownDoesNotRollbackOrRemoveWorker(t *testing.T) {
	_, w, row, h := staleLifecycleTask(t)
	h.probe = func(context.Context, string) WorkerStatus { return WorkerUnknown }
	err := w.Recover(context.Background())
	if err == nil || !strings.Contains(err.Error(), "检查 systemd 后重试") {
		t.Fatalf("未知进程状态未阻止恢复：%v", err)
	}
	stored, err := w.Store.read(row.ID)
	if err != nil || stored.State != "running" || h.starts != 0 || h.stops != 0 {
		t.Fatalf("未知时执行了恢复：%+v %v", stored, err)
	}
	if _, err := os.Stat(row.Worker); err != nil {
		t.Fatal(err)
	}
}
