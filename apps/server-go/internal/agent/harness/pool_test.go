package harness

import (
	"context"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/worker"
)

func TestWorkerPoolStartsOnlyForClaimedRuns(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	var starts atomic.Int32
	m := runtimeManager(t, &runtimeTestTools{}, func(d *Deps) {
		d.Limits.Concurrency = 2
		d.Spawn = func(ctx context.Context) (worker.Process, error) {
			if starts.Add(1) == 1 {
				close(entered)
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-release:
				}
			}
			return &runtimeTestProcess{}, nil
		}
	})
	defer unblock()
	if starts.Load() != 0 {
		t.Fatal("empty queue spawned workers")
	}
	first := runtimeSubmit(t, m, "cold-first", "docker_images_list")
	awaitDeleteSignal(t, entered)
	second := runtimeSubmit(t, m, "cold-second", "docker_containers_list")
	if got := runtimeFinished(t, m, second.ID); got.Status != StateSucceeded {
		t.Fatalf("second run: %+v", got)
	}
	got, err := m.Get(context.Background(), first.ID)
	if err != nil || got.Status != StateQueued || got.StartedAt != "" || starts.Load() != 2 {
		t.Fatalf("handshake claim lost: %+v, starts=%d, err=%v", got, starts.Load(), err)
	}
	if _, err := m.Cancel(context.Background(), first.ID); err != nil {
		t.Fatal(err)
	}
	unblock()
	if got := runtimeFinished(t, m, first.ID); got.Status != StateCancelled || got.StartedAt != "" {
		t.Fatalf("cancelled cold run was dispatched: %+v", got)
	}
}

func TestWorkerPoolRetiresIdleProcessAndStartsAgain(t *testing.T) {
	starts := make(chan worker.Process, 2)
	m := runtimeManager(t, &runtimeTestTools{}, func(d *Deps) {
		d.workerIdleTimeout = 50 * time.Millisecond
		d.Spawn = func(ctx context.Context) (worker.Process, error) {
			p, err := worker.Spawn(ctx, worker.Options{Path: os.Args[0], Args: []string{"-test.run=^TestRuntimeWorkerHelper$"}, Env: []string{"HOME=/tmp", "ELYSIAN_RUNTIME_TEST_CHILD=1"}})
			if err == nil {
				starts <- p
			}
			return p, err
		}
	})
	for _, id := range []string{"before-idle-timeout", "after-idle-timeout"} {
		run := runtimeSubmit(t, m, id, "docker_images_list")
		if got := runtimeFinished(t, m, run.ID); got.Status != StateSucceeded || got.Usage.Calls != 1 {
			t.Fatalf("run: %+v", got)
		}
		awaitDeleteSignal(t, processDone(<-starts))
		if !m.Info().Available || len(starts) != 0 {
			t.Fatal("idle retirement disabled admission or respawned a process")
		}
	}
}

func TestWorkerPoolRetriesFailedHandshakeWithoutStartingRun(t *testing.T) {
	var starts atomic.Int32
	var tools runtimeTestTools
	m := runtimeManager(t, &tools, func(d *Deps) {
		d.Spawn = func(context.Context) (worker.Process, error) {
			if starts.Add(1) == 1 {
				return nil, errors.New("fixture handshake failure")
			}
			return &runtimeTestProcess{}, nil
		}
	})
	run := runtimeSubmit(t, m, "failed-handshake", "docker_images_list")
	runtimeEventually(t, func() bool { return m.Info().Worker == "unavailable" })
	got, err := m.Get(context.Background(), run.ID)
	if err != nil || got.Status != StateQueued || got.StartedAt != "" || tools.count.Load() != 0 {
		t.Fatalf("failed handshake started run: %+v, err=%v", got, err)
	}
	if got = runtimeFinished(t, m, run.ID); got.Status != StateSucceeded || tools.count.Load() != 1 || starts.Load() != 2 {
		t.Fatalf("retry did not run exactly once: %+v, starts=%d", got, starts.Load())
	}
}

func TestWorkerPoolRunsIndependentTasksAndCancelsOnlyTarget(t *testing.T) {
	entered := make(chan string, 2)
	releaseSecond := make(chan struct{})
	tools := &runtimeTestTools{execute: func(ctx context.Context, name string) (any, error) {
		entered <- name
		if name == "docker_images_list" {
			<-ctx.Done()
			return nil, ctx.Err()
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-releaseSecond:
			return map[string]bool{"ok": true}, nil
		}
	}}
	m := runtimeManager(t, tools, func(d *Deps) { d.Limits.Concurrency = 2 })
	first := runtimeSubmit(t, m, "pool-first", "docker_images_list")
	second := runtimeSubmit(t, m, "pool-second", "docker_containers_list")
	for i := 0; i < 2; i++ {
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("two worker slots did not run concurrently")
		}
	}
	if _, err := m.Cancel(context.Background(), first.ID); err != nil {
		t.Fatal(err)
	}
	if got := runtimeFinished(t, m, first.ID); got.Status != StateCancelled {
		t.Fatalf("target not cancelled: %+v", got)
	}
	got, err := m.Get(context.Background(), second.ID)
	if err != nil || got.Status != StateRunning || got.CancelRequestedAt != "" {
		t.Fatalf("cancel affected another run: %+v %v", got, err)
	}
	close(releaseSecond)
	if got := runtimeFinished(t, m, second.ID); got.Status != StateSucceeded || got.Usage.Calls != 1 {
		t.Fatalf("second run lost its execution state: %+v", got)
	}
}

func TestWorkerPoolCapsTwoExecutionsPerRoot(t *testing.T) {
	m := &Manager{executions: map[string]*executionState{
		"a": {rootID: "workflow:root"},
		"b": {rootID: "workflow:root"},
	}}
	if m.rootHasCapacityLocked(Run{ID: "c", WorkflowID: "root"}) {
		t.Fatal("one root received more than two execution slots")
	}
	if !m.rootHasCapacityLocked(Run{ID: "c", WorkflowID: "other"}) {
		t.Fatal("busy root blocked independent work")
	}
}
