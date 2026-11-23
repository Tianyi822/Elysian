package sessionstore_test

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/sessionstore"
	storesqlite "elysian/server/internal/agent/harness/sessionstore/sqlite"
)

var contractTime = time.Date(2026, 11, 17, 8, 0, 0, 0, time.UTC)

func openContractStore(t *testing.T, fault func(string, string) error) (sessionstore.SessionStore, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "harness.sqlite")
	store, err := storesqlite.Open(storesqlite.Options{Path: path, Now: func() time.Time { return contractTime }, Fault: fault})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return store, path
}

func acceptContractRun(t *testing.T, store sessionstore.SessionStore) (sessionstore.Task, sessionstore.Run) {
	t.Helper()
	now := contractTime.Format(time.RFC3339Nano)
	session := sessionstore.Session{ID: "session", CreatedAt: now, LastActivityAt: now, LastSeq: "0", ModelProfileID: "model", ModelRevision: 1}
	if err := store.CreateSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	task := sessionstore.Task{ID: "task", SessionID: session.ID, RequestID: "request", Kind: "agent", DriverVersion: "v2", CreatedAt: now, Goal: "验证存储边界"}
	run := sessionstore.Run{ID: "run", SessionID: session.ID, TaskID: task.ID, RequestID: task.RequestID, DriverVersion: "v2", Status: "queued", CreatedAt: now, LastSeq: "0", Input: task.Goal, BudgetPolicy: "resource-budget/v2", RecoveryPolicy: "evidence-recovery/v2", Limits: sessionstore.Limits{QueueCapacity: 8}, Model: &model.Profile{ID: "model", Revision: 1}}
	accepted, duplicate, err := store.AcceptAgent(context.Background(), task, run, "canonical", "message", true)
	if err != nil || duplicate {
		t.Fatalf("接受请求失败：%+v %t %v", accepted, duplicate, err)
	}
	return task, accepted
}

func TestSessionStoreAtomicFactsAndCheckpoint(t *testing.T) {
	store, _ := openContractStore(t, nil)
	_, run := acceptContractRun(t, store)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	before, err := store.CommittedWatermark(ctx)
	if err != nil {
		t.Fatal(err)
	}
	abort := errors.New("拒绝本次提交")
	receipt, err := store.Update(ctx, "rollback-contract", func(tx sessionstore.Tx) error {
		current, err := tx.Get(ctx, run.ID)
		if err != nil {
			return err
		}
		current.Status = "waiting-storage"
		if err = tx.Event(ctx, &current, "test/checkpoint", "", nil, nil); err != nil {
			return err
		}
		if err = tx.SaveCall(ctx, sessionstore.Call{ID: "rolled-back", RunID: run.ID, Status: "running"}); err != nil {
			return err
		}
		// 通用读取也必须看到当前事务的写入，不能另取 SQLite 连接。
		events, err := tx.Events(ctx, run.ID, "0", 100)
		if err != nil {
			return err
		}
		if len(events.Items) != 2 {
			t.Fatalf("事务内未读到待提交事件：%+v", events)
		}
		return abort
	})
	if !errors.Is(err, abort) || receipt.State != sessionstore.NotCommitted || receipt.Watermark != 0 {
		t.Fatalf("回滚语义错误：%+v %v", receipt, err)
	}
	after, err := store.CommittedWatermark(ctx)
	if err != nil || after != before {
		t.Fatalf("回滚留下 outbox：%d %d %v", before, after, err)
	}
	calls, err := store.Calls(ctx, run.ID, "0", 100)
	if err != nil || len(calls.Items) != 0 {
		t.Fatalf("回滚留下调用事实：%+v %v", calls, err)
	}
	receipt, err = store.Update(ctx, "commit-checkpoint", func(tx sessionstore.Tx) error {
		current, err := tx.ReadRun(ctx, run.ID)
		if err != nil {
			return err
		}
		current.Status = "waiting-model"
		current.Wait = &sessionstore.RunWait{Kind: "model", Attempts: 2, NextAt: contractTime.Add(time.Minute).Format(time.RFC3339Nano), RequestID: "original-model-request"}
		current.Plan = &sessionstore.RunPlan{Revision: 3, Steps: []sessionstore.PlanStep{{ID: "one", Title: "保留证据", Status: "in_progress"}}}
		return tx.Event(ctx, &current, "test/checkpoint", "", nil, current.Wait)
	})
	if err != nil || receipt.State != sessionstore.Committed || receipt.Watermark <= before {
		t.Fatalf("提交回执错误：%+v %v", receipt, err)
	}
	if err = store.AwaitReplicated(ctx, receipt.Watermark); err != nil {
		t.Fatal(err)
	}
	current, err := store.Get(ctx, run.ID)
	if err != nil || current.Status != "waiting-model" || current.Wait == nil || current.Wait.Attempts != 2 || current.Plan == nil || current.Plan.Revision != 3 {
		t.Fatalf("检查点未与事实提交：%+v %v", current, err)
	}
}

func TestSessionStoreIdentityAndRecovery(t *testing.T) {
	store, path := openContractStore(t, nil)
	task, run := acceptContractRun(t, store)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	candidate := run
	candidate.ID = "new-generated-run"
	task.ID = "new-generated-task"
	candidate.TaskID = task.ID
	duplicate, repeated, err := store.AcceptAgent(ctx, task, candidate, "canonical", "new-message", true)
	if err != nil || !repeated || duplicate.ID != run.ID {
		t.Fatalf("精确重试丢失原身份：%+v %t %v", duplicate, repeated, err)
	}
	for _, mutate := range []func(*sessionstore.Run){func(r *sessionstore.Run) { r.SessionID = "other-session" }, func(r *sessionstore.Run) { r.TaskID = "other-task" }} {
		candidate := run
		mutate(&candidate)
		target := task
		target.ID = candidate.TaskID
		if _, _, err = store.AcceptAgent(ctx, target, candidate, "canonical", "conflict", false); err == nil {
			t.Fatal("requestId 允许更换原目标")
		}
	}
	if _, _, err = store.AcceptAgent(ctx, task, run, "different-canonical", "conflict", true); err == nil {
		t.Fatal("requestId 允许更换规范参数")
	}
	_, err = store.ChangeRun(ctx, run.ID, "wait-checkpoint", func(tx sessionstore.Tx, r *sessionstore.Run) error {
		r.Status = "waiting-model"
		r.Wait = &sessionstore.RunWait{Kind: "model", Attempts: 2, RequestID: "model-request", NextAt: contractTime.Add(time.Minute).Format(time.RFC3339Nano)}
		return tx.Event(ctx, r, "run/waiting-model", "", nil, r.Wait)
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Close(ctx); err != nil {
		t.Fatal(err)
	}
	restored, err := storesqlite.Open(storesqlite.Options{Path: path, Now: func() time.Time { return contractTime }})
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close(context.Background())
	if err = restored.Recover(ctx, false); err != nil {
		t.Fatal(err)
	}
	current, canonical, err := restored.Request(ctx, run.RequestID)
	if err != nil || canonical != "canonical" || current.ID != run.ID || current.TaskID != run.TaskID || current.Wait == nil || current.Wait.RequestID != "model-request" {
		t.Fatalf("重启丢失恢复身份：%+v %q %v", current, canonical, err)
	}
	messages, err := restored.Messages(ctx, run.SessionID, "0", 100)
	if err != nil || len(messages.Items) != 1 {
		t.Fatalf("重试重复追加消息：%+v %v", messages, err)
	}
}

func TestSessionStoreUnconfirmedCommitIsNeverRetried(t *testing.T) {
	for _, stage := range []string{"commit", "acknowledge", "rollback"} {
		t.Run(stage, func(t *testing.T) {
			injected := errors.New("回执故障")
			store, _ := openContractStore(t, func(point, op string) error {
				if op == "contract-fault" && point == stage {
					return injected
				}
				return nil
			})
			_, run := acceptContractRun(t, store)
			attempts := 0
			receipt, err := store.Update(context.Background(), "contract-fault", func(tx sessionstore.Tx) error {
				attempts++
				run.Phase = "checkpoint-written"
				if err := tx.SaveRun(context.Background(), &run); err != nil {
					return err
				}
				if stage == "rollback" {
					return errors.New("事务体拒绝")
				}
				return nil
			})
			var fault *sessionstore.Fault
			if attempts != 1 || receipt.State != sessionstore.CommitUnknown || receipt.Watermark != 0 || !errors.Is(err, sessionstore.ErrCommitUnknown) || !errors.As(err, &fault) || fault.Kind != sessionstore.UnconfirmedCommit {
				t.Fatalf("提交未知被重投或误报：%d %+v %v", attempts, receipt, err)
			}
			current, err := store.Get(context.Background(), run.ID)
			if err != nil || (current.Phase == "checkpoint-written") != (stage == "acknowledge") {
				t.Fatalf("故障后的事实错误：%+v %v", current, err)
			}
			if store.Health().Write != "unavailable" || store.DispatchError() == nil {
				t.Fatal("成功读取清除了提交保护")
			}
		})
	}
}

func TestSessionStoreReplicaWaitDoesNotBlockReceipts(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var slow atomic.Bool
	var once sync.Once
	store, _ := openContractStore(t, func(stage, point string) error {
		if stage == "record" && point == "append" && slow.Load() {
			once.Do(func() { close(entered); <-release })
		}
		return nil
	})
	// 失败退出时也先放开 worker，再关闭存储。
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	_, run := acceptContractRun(t, store)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	before, err := store.CommittedWatermark(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.AwaitReplicated(ctx, before); err != nil {
		t.Fatal(err)
	}
	slow.Store(true)
	receipt, err := store.Update(ctx, "slow-replica", func(tx sessionstore.Tx) error { return tx.Event(ctx, &run, "test/replica", "", nil, nil) })
	if err != nil || receipt.State != sessionstore.Committed {
		t.Fatalf("慢副本改变了提交结果：%+v %v", receipt, err)
	}
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("副本未开始同步")
	}
	waitCtx, stop := context.WithTimeout(ctx, 20*time.Millisecond)
	defer stop()
	if err = store.AwaitReplicated(waitCtx, receipt.Watermark); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("派发越过未同步水位：%v", err)
	}
	if _, err = store.Update(ctx, "inflight-receipt", func(tx sessionstore.Tx) error { return tx.Event(ctx, &run, "test/receipt", "", nil, nil) }); err != nil {
		t.Fatalf("副本等待阻塞回执入库：%v", err)
	}
	close(release)
	target, err := store.CommittedWatermark(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.AwaitReplicated(ctx, target); err != nil {
		t.Fatal(err)
	}
}
