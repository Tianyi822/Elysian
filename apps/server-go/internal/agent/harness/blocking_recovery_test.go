package harness

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/sessionstore"
	"elysian/server/internal/agent/tools"
)

func TestBlockedTimelineTracksLiveSourcesThroughHistoricalVerification(t *testing.T) {
	ctx := context.Background()
	s, _, _, blocked := budgetSourceFixture(t)
	m := &Manager{store: s, ctx: ctx, deps: Deps{Now: func() time.Time { return runtimeStoreTestTime }}, wake: make(chan struct{}, 1)}
	old := createRuntimeTestRun(t, s, "old-orphan", runtimeStoreTestTime)
	op := Operation{ID: "old-orphan-op", RunID: old.ID, TaskID: old.TaskID, Status: "unknown", CallID: "old-call", DispatchID: "original-dispatch", ArgumentsJSON: `{"name":"mysql84","requestId":"` + strings.Repeat("a", 64) + `"}`, Capability: Capability{Name: "docker_container_create_service", Source: "builtin", Metadata: tools.Metadata{Async: true, Version: "3"}}, Task: &tools.TaskReference{Domain: "docker-container-operation", RequestID: strings.Repeat("a", 64)}}
	waiter := Operation{ID: "blocked-op", RunID: blocked.ID, TaskID: blocked.TaskID, Status: StateWaitingResource, ResourceWait: &ResourceWait{Resource: "external:*", RunID: old.ID, OperationID: op.ID, Unknown: true}}
	err := s.write(ctx, "blocked-history-fixture", func(tx sessionstore.Tx) error {
		old.Status, old.EndReason, old.Error = StateInterrupted, "outcome-unknown", &Failure{Code: "outcome-unknown", Message: "原操作结果未知"}
		if err := saveRun(ctx, tx, &old); err != nil {
			return err
		}
		for _, o := range []Operation{op, waiter} {
			if err := saveOperation(ctx, tx, o); err != nil {
				return err
			}
		}
		// An already reconciled legacy operation may remain unknown for audit.
		// It must not make this Run's otherwise available verifier disappear.
		if err := saveOperation(ctx, tx, Operation{ID: "manually-reconciled", RunID: old.ID, TaskID: old.TaskID, CallIndex: 1, Status: "unknown"}); err != nil {
			return err
		}
		if err := saveBarrier(ctx, tx, ExecutionBarrier{ID: "settled-barrier", RunID: old.ID, OperationID: "manually-reconciled", Status: "reconciled"}); err != nil {
			return err
		}
		if err := saveCall(ctx, tx, Call{ID: op.CallID, RunID: old.ID, OperationID: op.ID, Tool: op.Capability.Name, Status: StateInterrupted}); err != nil {
			return err
		}
		if err := saveBarrier(ctx, tx, ExecutionBarrier{ID: "old-barrier", RunID: old.ID, OperationID: op.ID, Status: "unknown"}); err != nil {
			return err
		}
		return saveResourceLease(ctx, tx, ResourceLease{ID: op.ID, RunID: old.ID, OperationID: op.ID, State: "unknown"})
	})
	if err != nil {
		t.Fatal(err)
	}
	verifies := 0
	m.deps.VerifyTask = func(_ context.Context, v tools.TaskVerification) (tools.TaskReference, error) {
		verifies++
		persisted, err := readOperation(ctx, s, op.ID)
		if err != nil || persisted.Recovery == nil {
			t.Fatal("verification intent was not durable")
		}
		if v.DispatchID != op.DispatchID || v.ArgumentsJSON != op.ArgumentsJSON {
			t.Fatal("original identity changed")
		}
		return tools.TaskReference{Domain: v.Task.Domain, ID: "sealed-original", RequestID: v.Task.RequestID, Target: "name:mysql84", Digest: strings.Repeat("d", 64)}, nil
	}
	m.deps.InspectTask = func(context.Context, tools.TaskReference) (tools.TaskStatus, error) {
		return tools.TaskStatus{Outcome: tools.TaskFailed, ErrorCode: "docker-operation-not-accepted", Error: "原提交未受理，未执行业务变更", Evidence: &tools.ExecutionEvidence{Execution: "not-started", Changes: "none"}}, nil
	}
	snapshot, err := m.ChatSnapshot(ctx, blocked.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Timeline.BlockingRecovery) != 1 || !snapshot.Timeline.BlockingRecovery[0].Verifiable || snapshot.Timeline.BlockingRecovery[0].RunID != old.ID || snapshot.Timeline.Continuation.Allowed {
		t.Fatalf("missing actionable blocker: %+v", snapshot.Timeline)
	}
	if verifies != 0 {
		t.Fatal("read projection performed verification")
	}
	// A second unknown may appear after the first wait was recorded.
	other := createRuntimeTestRun(t, s, "second-unknown", runtimeStoreTestTime)
	if err := s.write(ctx, "second-fence", func(tx sessionstore.Tx) error {
		if err := saveOperation(ctx, tx, Operation{ID: "second-operation", RunID: other.ID, TaskID: other.TaskID, Status: "unknown"}); err != nil {
			return err
		}
		return saveBarrier(ctx, tx, ExecutionBarrier{ID: "second-barrier", RunID: other.ID, OperationID: "second-operation", Status: "unknown"})
	}); err != nil {
		t.Fatal(err)
	}
	after, err := m.VerifyRecovery(ctx, old.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != StateInterrupted || after.EndReason != old.EndReason || verifies != 1 {
		t.Fatalf("history revived or not verified: %+v", after)
	}
	snapshot, err = m.ChatSnapshot(ctx, blocked.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Timeline.BlockingRecovery) != 1 || snapshot.Timeline.BlockingRecovery[0].OperationID != "second-operation" || snapshot.Timeline.BlockingRecovery[0].Verifiable || snapshot.Timeline.Continuation.Allowed {
		t.Fatal("remaining fence hidden or continuation falsely allowed")
	}
	if err := s.write(ctx, "resolve-second", func(tx sessionstore.Tx) error {
		return saveBarrier(ctx, tx, ExecutionBarrier{ID: "second-barrier", RunID: other.ID, OperationID: "second-operation", Status: "reconciled"})
	}); err != nil {
		t.Fatal(err)
	}
	snapshot, err = m.ChatSnapshot(ctx, blocked.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Timeline.BlockingRecovery) != 0 || !snapshot.Timeline.Continuation.Allowed {
		t.Fatalf("resolved history still blocks: %+v", snapshot.Timeline)
	}
	raw, _ := json.Marshal(snapshot.Timeline)
	if !strings.Contains(string(raw), `"blockingRecovery":[]`) {
		t.Fatal("empty blockers omitted or null")
	}
	stored, _ := readOperation(ctx, s, waiter.ID)
	if stored.ResourceWait == nil || !stored.ResourceWait.Unknown {
		t.Fatal("historical wait was rewritten")
	}
	if _, err = m.VerifyRecovery(ctx, old.ID); err != nil || verifies != 1 {
		t.Fatal("verification not idempotent")
	}
}

func TestVerificationWithoutChannelFailsAndKeepsProtection(t *testing.T) {
	m, op, _ := domainOutcomeFixture(t, "no-channel")
	if err := m.settleDomainTask(op, tools.TaskStatus{Outcome: tools.TaskUnknown}); err != nil {
		t.Fatal(err)
	}
	_, err := m.VerifyRecovery(m.ctx, op.RunID)
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != "verification-unavailable" {
		t.Fatalf("missing verification falsely succeeded: %v", err)
	}
	assertDomainProtection(t, m, op, "unknown")
}

func TestRunVerificationPreflightsAllUnresolvedOperations(t *testing.T) {
	m, op, _ := domainOutcomeFixture(t, "mixed-channels")
	if err := m.settleDomainTask(op, tools.TaskStatus{Outcome: tools.TaskUnknown}); err != nil {
		t.Fatal(err)
	}
	if err := fixture(m).write(m.ctx, "unsupported-orphan", func(tx sessionstore.Tx) error {
		return saveOperation(m.ctx, tx, Operation{ID: "unsupported", RunID: op.RunID, TaskID: op.TaskID, CallIndex: op.CallIndex + 1, Status: "unknown"})
	}); err != nil {
		t.Fatal(err)
	}
	inspections := 0
	m.deps.InspectTask = func(context.Context, tools.TaskReference) (tools.TaskStatus, error) {
		inspections++
		return tools.TaskStatus{Outcome: tools.TaskSucceeded}, nil
	}
	if _, err := m.VerifyRecovery(m.ctx, op.RunID); err == nil || inspections != 0 {
		t.Fatalf("unsupported run partially verified or falsely succeeded: inspections=%d err=%v", inspections, err)
	}
	assertDomainProtection(t, m, op, "unknown")
}

func TestCurrentBlockingRecoveryKeepsGlobalAndScopedProtectionAligned(t *testing.T) {
	ctx := context.Background()
	s, _, _, blocked := budgetSourceFixture(t)
	claim := ResourceClaim{Kind: "docker-container", Authority: "local", Key: "target", Access: "write"}
	owner := createRuntimeTestRun(t, s, "scope-owner", runtimeStoreTestTime)
	other := createRuntimeTestRun(t, s, "unrelated-owner", runtimeStoreTestTime)
	waiter := Operation{ID: "scoped-waiter", RunID: blocked.ID, TaskID: blocked.TaskID, Status: StateWaitingResource,
		Capability: Capability{Source: "builtin", ReadOnly: true}, ResourceClaims: []ResourceClaim{claim},
		ResourceWait: &ResourceWait{Unknown: true, Resource: "docker-container:local:target", RunID: owner.ID, OperationID: "scope-source"}}
	if err := s.write(ctx, "scoped-blockers", func(tx sessionstore.Tx) error {
		for _, op := range []Operation{waiter, {ID: "scope-source", RunID: owner.ID, TaskID: owner.TaskID, Status: "unknown"}, {ID: "unrelated-source", RunID: other.ID, TaskID: other.TaskID, Status: "unknown"}} {
			if err := saveOperation(ctx, tx, op); err != nil {
				return err
			}
		}
		if err := saveResourceLease(ctx, tx, ResourceLease{ID: "scope-source", RunID: owner.ID, OperationID: "scope-source", State: "unknown", Claims: []ResourceClaim{claim}}); err != nil {
			return err
		}
		return saveBarrier(ctx, tx, ExecutionBarrier{ID: "unrelated-barrier", RunID: other.ID, OperationID: "unrelated-source", Status: "unknown"})
	}); err != nil {
		t.Fatal(err)
	}
	items, err := currentBlockingRecovery(ctx, s, blocked.ID)
	if err != nil || len(items) != 1 || items[0].OperationID != "scope-source" {
		t.Fatalf("scoped read exposed unrelated global protection: %+v %v", items, err)
	}
	// Old external waiters could store the concrete resource. They still obey
	// the global fence when their originally recorded source has been settled.
	waiter.Capability.ReadOnly = false
	if err := s.write(ctx, "legacy-concrete-global-wait", func(tx sessionstore.Tx) error {
		if err := saveOperation(ctx, tx, waiter); err != nil {
			return err
		}
		return settleResourceLease(ctx, tx, "scope-source", stamp(runtimeStoreTestTime), false, "confirmed stopped", "confirmed-stopped")
	}); err != nil {
		t.Fatal(err)
	}
	items, err = currentBlockingRecovery(ctx, s, blocked.ID)
	state, stateErr := continuation(ctx, s, blocked)
	if err != nil || stateErr != nil || len(items) != 1 || items[0].OperationID != "unrelated-source" || state.Allowed {
		t.Fatalf("legacy global waiter lost remaining protection: %+v %+v %v %v", items, state, err, stateErr)
	}
	if err := s.write(ctx, "independent-probe", func(tx sessionstore.Tx) error {
		return saveResourceLease(ctx, tx, ResourceLease{ID: "probe-lease", Source: "mcp-probe", State: "unknown"})
	}); err != nil {
		t.Fatal(err)
	}
	m := &Manager{store: s}
	items, err = m.blockingRecovery(ctx, blocked)
	if err != nil || len(items) != 2 || items[0].LeaseID != "probe-lease" || items[0].Verifiable || items[0].Message == "" {
		t.Fatalf("independent protection lost its display identity: %+v %v", items, err)
	}
}
