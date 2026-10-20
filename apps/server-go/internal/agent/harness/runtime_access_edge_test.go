package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
)

func TestRuntimeAccessCancellationAndDecisionCannotDispatchTwice(t *testing.T) {
	ctx := context.Background()
	var calls atomic.Int32
	cat := &demandTestCatalog{operationCatalog{execute: func(ctx context.Context, _ Operation) (CapabilityResult, error) {
		calls.Add(1)
		<-ctx.Done()
		return CapabilityResult{}, ctx.Err()
	}}}
	m, session, _ := agentManager(t, operationClient(), func(d *Deps) { d.Catalog = cat })
	run := submitDemand(t, m, session, "decision-cancel-race")
	a := waitingApproval(t, m, run.ID)
	in := accessInput(a, "once", "race-decision")
	start := make(chan struct{})
	decided, cancelled := make(chan error, 1), make(chan error, 1)
	go func() { <-start; _, err := m.DecideAccess(ctx, a.ID, in); decided <- err }()
	go func() { <-start; _, err := m.Cancel(ctx, run.ID); cancelled <- err }()
	close(start)
	decisionErr := <-decided
	if err := <-cancelled; err != nil {
		t.Fatal(err)
	}
	if decisionErr != nil {
		var typed *Error
		if !errors.As(decisionErr, &typed) || typed.Status != 409 {
			t.Fatalf("decision lost cancellation race with unexpected error: %v", decisionErr)
		}
	}
	if got := runtimeFinished(t, m, run.ID); got.Status != StateCancelled || calls.Load() > 1 {
		t.Fatalf("cancel race replayed or resumed execution: %+v calls=%d", got, calls.Load())
	}
	before := calls.Load()
	_, retryErr := m.DecideAccess(ctx, a.ID, in)
	if decisionErr == nil && retryErr != nil {
		t.Fatalf("committed decision lost idempotent receipt after cancellation: %v", retryErr)
	}
	if decisionErr != nil && retryErr == nil {
		t.Fatal("decision rejected by cancellation became accepted on retry")
	}
	got, err := m.Get(ctx, run.ID)
	if err != nil || got.Status != StateCancelled || calls.Load() != before {
		t.Fatalf("decision retry revived cancelled run: %+v %v", got, err)
	}
}

func TestRuntimeAccessQueueFullPreservesPendingRequest(t *testing.T) {
	ctx := context.Background()
	entered := make(chan struct{})
	var block atomic.Bool
	baseClient := operationClient()
	cat := &demandTestCatalog{}
	m, session, _ := agentManager(t, func(ctx context.Context, p model.Profile, r model.Request) (model.Response, error) {
		if block.CompareAndSwap(true, false) {
			close(entered)
			<-ctx.Done()
			return model.Response{}, ctx.Err()
		}
		return baseClient(ctx, p, r)
	}, func(d *Deps) { d.Catalog = cat; d.Limits.QueueCapacity = 1; d.AgentLimits.QueueCapacity = 1 })
	run := submitDemand(t, m, session, "waiting-for-capacity")
	a := waitingApproval(t, m, run.ID)
	in := accessInput(a, "session", "capacity-decision")
	newSession := func() Session {
		s, err := m.CreateSession(ctx, CreateSessionInput{ModelProfileID: session.ModelProfileID, ModelRevision: session.ModelRevision})
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	block.Store(true)
	busy := submitDemand(t, m, newSession(), "occupy-executor")
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("waiting authorization retained the execution slot")
	}
	queued := submitDemand(t, m, newSession(), "occupy-authorization-queue")
	_, err := m.DecideAccess(ctx, a.ID, in)
	runtimeErrorCode(t, err, "queue-full")
	still := waitingApproval(t, m, run.ID)
	if still.AccessDecision != nil || digestJSON(still.Access) != digestJSON(a.Access) || still.Status != "pending" {
		t.Fatalf("queue rejection modified pending request: %+v", still)
	}
	remembered, err := m.SessionAuthorizations(ctx, session.ID)
	if err != nil || len(remembered) != 0 {
		t.Fatalf("queue rejection granted session access: %+v %v", remembered, err)
	}
	for _, pending := range []Run{queued, busy} {
		if _, err := m.Cancel(ctx, pending.ID); err != nil {
			t.Fatal(err)
		}
		runtimeFinished(t, m, pending.ID)
	}
	if _, err := m.DecideAccess(ctx, a.ID, in); err != nil {
		t.Fatal("exact request could not be retried after capacity returned", err)
	}
	if got := runtimeFinished(t, m, run.ID); got.Status != StateSucceeded {
		t.Fatal(got.Error)
	}
}

func TestRuntimeAccessRecordsFaultBlocksDecisionsAndDispatch(t *testing.T) {
	for _, stage := range []string{"before-decision", "decision-replica"} {
		t.Run(stage, func(t *testing.T) {
			ctx := context.Background()
			var calls atomic.Int32
			cat := &demandTestCatalog{operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
				calls.Add(1)
				return CapabilityResult{Value: json.RawMessage(`{"ok":true}`)}, nil
			}}}
			m, session, _ := agentManager(t, operationClient(), func(d *Deps) { d.Catalog = cat })
			run := submitDemand(t, m, session, "record-fault-"+stage)
			a := waitingApproval(t, m, run.ID)
			m.mu.Lock()
			m.store.recordHook = func(string) error { return errors.New("record disk unavailable") }
			if stage == "before-decision" {
				_, err := m.store.change(ctx, run.ID, "test-record-failure", func(tx *sql.Tx, r *Run) error {
					return m.store.event(ctx, tx, r, "test/replica-failed", "", nil, nil)
				})
				if err != nil {
					m.mu.Unlock()
					t.Fatal(err)
				}
			}
			m.mu.Unlock()
			_, err := m.DecideAccess(ctx, a.ID, accessInput(a, "session", "fault-decision"))
			if stage == "before-decision" {
				runtimeErrorCode(t, err, "storage-unavailable")
				still := waitingApproval(t, m, run.ID)
				if still.AccessDecision != nil {
					t.Fatal("faulted replica accepted a new decision")
				}
			} else if err != nil {
				t.Fatal("committed decision receipt was discarded after replica failure", err)
			}
			if m.store.recordsFault() == nil || m.Info().Available || calls.Load() != 0 {
				t.Fatalf("record failure did not freeze dispatch: fault=%v calls=%d", m.store.recordsFault(), calls.Load())
			}
			o, err := readOperation(ctx, m.store.db, a.OperationID)
			if err != nil || o.DispatchID != "" || o.Status == "dispatched" {
				t.Fatalf("operation dispatched despite failed replica: %+v %v", o, err)
			}
			remembered, err := m.SessionAuthorizations(ctx, session.ID)
			if err != nil {
				t.Fatal(err)
			}
			if stage == "before-decision" && len(remembered) != 0 || stage == "decision-replica" && len(remembered) != 1 {
				t.Fatalf("durable decision fact mismatch after %s: %+v", stage, remembered)
			}
		})
	}
}
