package harness

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/sessionstore"
	"elysian/server/internal/agent/harness/state"
)

func TestOperationDispatchGuard(t *testing.T) {
	for _, tc := range []struct {
		name      string
		check     int32
		action    string
		errorCode string
	}{
		{"策略前允许取消", 1, "cancel", ""},
		{"审批前允许取消", 2, "cancel", ""},
		{"外部派发前允许取消", 3, "cancel", "outcome-unknown"},
		{"票据签发时允许取消", 4, "cancel", "outcome-unknown"},
		{"外部派发前保留守卫拒绝", 3, "deny", "maintenance-active"},
		{"票据签发时重新检查撤销", 4, "revoke", "capability-revoked"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := openRuntimeTestStore(t)
			run := createRuntimeTestRun(t, s, "dispatch-guard", runtimeStoreTestTime)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			run, err := s.change(ctx, run.ID, "start", func(tx sessionstore.Tx, run *Run) error {
				run.Status = StateRunning
				return saveRun(ctx, tx, run)
			})
			if err != nil {
				t.Fatal(err)
			}
			entered, release := make(chan struct{}), make(chan struct{})
			unblock := sync.OnceFunc(func() { close(release) })
			var checks, invoked atomic.Int32
			catalog := &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
				invoked.Add(1)
				return CapabilityResult{}, nil
			}}
			snapshot, err := catalog.Snapshot(ctx, Environment{TrustedReadOnly: []string{"test_read"}})
			if err != nil {
				t.Fatal(err)
			}
			snapshot.Digest = "guard-test-snapshot"
			run.DriverVersion, run.Snapshot = "v2", &snapshot
			m := &Manager{
				store:      s,
				executions: map[string]*executionState{run.ID: {cancel: cancel}},
				deps: Deps{Now: s.now, NewID: state.RandomID, Catalog: catalog, DispatchGuard: func() error {
					if checks.Add(1) == tc.check {
						close(entered)
						<-release
						if tc.action == "deny" {
							return bad("maintenance-active", "维护中")
						}
					}
					return nil
				}},
			}
			if err := m.initializeToolRuntime(); err != nil {
				t.Fatal(err)
			}
			defer func() { _ = m.toolRuntime.Close(context.Background()) }()
			a := &agentExecution{manager: m, run: run}
			result := make(chan error, 1)
			finished := make(chan struct{})
			go func() {
				defer close(finished)
				args := json.RawMessage(`{}`)
				result <- a.executeOperation(ctx, 0, model.ToolCall{ID: "call", Name: "test_read", Arguments: args}, args)
			}()
			defer func() { unblock(); <-finished }()
			select {
			case <-entered:
			case err := <-result:
				t.Fatalf("未到达派发守卫：%v", err)
			case <-time.After(5 * time.Second):
				t.Fatal("未到达派发守卫")
			}
			if !m.mu.TryLock() {
				t.Fatal("慢守卫占用了 Manager 锁，取消无法推进")
			}
			m.mu.Unlock()
			switch tc.action {
			case "cancel":
				cancelled, err := m.Cancel(context.Background(), run.ID)
				if err != nil || cancelled.CancelRequestedAt == "" {
					t.Fatalf("未保存取消事实：%+v %v", cancelled, err)
				}
			case "revoke":
				if err = m.Revoke(context.Background(), "mcp", "fixture-server", 1, "测试撤销"); err != nil {
					t.Fatal(err)
				}
			}
			unblock()
			err = <-result
			if tc.errorCode != "" {
				runtimeErrorCode(t, err, tc.errorCode)
			} else if !errors.Is(err, context.Canceled) {
				t.Fatalf("守卫返回后应拒绝已取消的操作：%v", err)
			}
			if invoked.Load() != 0 {
				t.Fatal("未获准的操作进入了工具后端")
			}
			if tc.errorCode == "outcome-unknown" {
				barriers, err := m.Barriers(context.Background())
				if err != nil || len(barriers) != 1 || barriers[0].Status != "unknown" {
					t.Fatalf("取消后未保留已落盘的派发保护：%+v %v", barriers, err)
				}
			}
		})
	}
}
