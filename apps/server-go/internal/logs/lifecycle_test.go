package logs

import (
	"errors"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestOpenedServiceClosesSQLite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "logs.sqlite")
	svc := OpenService(path, nil)
	store := svc.store.(*sqliteStore)
	t.Cleanup(func() { _ = svc.Close() })
	svc.Runtime("info", "test.lifecycle", "关停前的记录")
	for i := 0; i < 2; i++ {
		if err := svc.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.db.Ping(); err == nil {
		t.Fatal("服务关闭后原 SQLite 连接仍可用")
	}
	reopened, err := openLogStore(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	report, err := reopened.QueryRuntime(logListQuery{Q: "关停前的记录", HasQ: true})
	if err != nil || len(report.Entries) != 1 || report.Entries[0].Message != "关停前的记录" {
		t.Fatalf("关闭后重新打开未读到原记录：%+v %v", report, err)
	}
}

func TestLogServiceClosesSQLiteAfterActiveTimer(t *testing.T) {
	sqlite, err := openLogStore(filepath.Join(t.TempDir(), "logs.sqlite"), nil)
	if err != nil {
		t.Fatal(err)
	}
	ticks := make(chan time.Time, 1)
	entered, release, tickerStopped := make(chan struct{}), make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	store := &timerTestStore{logStore: sqlite, entered: entered, release: release, tickerStopped: tickerStopped}
	svc := NewService(store, nil, func(time.Duration) (<-chan time.Time, func()) {
		return ticks, func() { close(tickerStopped) }
	})
	t.Cleanup(func() { unblock(); _ = svc.Close() })
	svc.RunSweep(categoryRuntime, sweepReasonManual)
	ticks <- time.Now()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("定时巡检未开始")
	}
	closed := make(chan error, 1)
	go func() { closed <- svc.Close() }()
	select {
	case <-svc.stop:
	case <-time.After(5 * time.Second):
		t.Fatal("关闭未停止巡检调度")
	}
	ticks <- time.Now() // 关闭期间到达的 tick 不得启动下一轮巡检。
	unblock()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("退出巡检后 SQLite 未关闭")
	}
	if calls := store.calls.Load(); calls != 2 {
		t.Fatalf("仅允许初始巡检和已在途的一次定时巡检，实际 %d 次", calls)
	}
	if err := sqlite.db.Ping(); err == nil {
		t.Fatal("定时器退出后原 SQLite 连接仍可用")
	}
}

type timerTestStore struct {
	logStore
	entered                chan<- struct{}
	release, tickerStopped <-chan struct{}
	calls                  atomic.Int32
}

func (s *timerTestStore) Sweep(category string, now time.Time) logSweepResult {
	if s.calls.Add(1) == 2 {
		// entered 只由定时巡检发出。
		close(s.entered)
		<-s.release
	}
	return s.logStore.Sweep(category, now)
}

func (s *timerTestStore) Close() error {
	select {
	case <-s.tickerStopped:
		return s.logStore.Close()
	default:
		return errors.Join(errors.New("定时巡检退出前就尝试关闭 SQLite"), s.logStore.Close())
	}
}
