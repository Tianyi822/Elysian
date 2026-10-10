package harness

import (
	"context"
	"testing"
	"time"
)

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
