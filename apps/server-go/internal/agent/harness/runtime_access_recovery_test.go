package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/execution"
	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness/worker"
)

func pullingRuntimeFixture(t *testing.T, s *store, suffix string) (Run, Operation, Approval) {
	t.Helper()
	_, task, input := sessionStoreFixture(t, s, suffix, runtimeStoreTestTime)
	task.DriverVersion, input.DriverVersion = "v2", "v2"
	input.Snapshot = &CapabilitySnapshot{AuthorizationMode: AuthorizationOnDemand, Digest: "frozen-snapshot"}
	input.ActiveMilliseconds = 1245
	run := acceptSessionTestRun(t, s, task, input, true)
	image := "docker.io/library/bash@sha256:" + strings.Repeat("a", 64)
	o := Operation{ID: "operation-" + suffix, RunID: run.ID, TaskID: task.ID, ModelRequestID: "response-" + suffix, CallIndex: 2, ModelCallID: "bash-call", CallID: "call-" + suffix, ArgumentsJSON: `{"command":"echo approved"}`, SnapshotDigest: input.Snapshot.Digest, Status: StateWaitingApproval, ApprovalID: "approval-" + suffix, CreatedAt: stamp(s.now()), Capability: Capability{Name: BashExec, Source: BashSource}, Policy: "approval-required", DecisionSource: "human-approval"}
	o.Access = &AccessRequest{Revision: 1, Kind: "script", SessionAllowed: true, Runtime: &AccessRuntime{Name: "bash", Image: image, Platform: "linux/amd64", RequiresDownload: true}}
	o.Execution = &ExecutionPlan{Profile: execconfig.Profile{ID: "runtime-bash", Revision: 1, Name: "bash", Image: image, Runtime: "bash", Command: []string{"bash"}, TimeoutSeconds: 30, CPUMillis: 500, MemoryBytes: 256 << 20, PIDs: 64, Enabled: true}}
	o.Access.ScopeKey, o.Access.Digest = accessScopeKey(o), ""
	o.Access.Digest = accessDigest(o)
	approved := Approval{ID: o.ApprovalID, Kind: "operation", RunID: run.ID, OperationID: o.ID, Status: "approved", Decision: "approved", CreatedAt: stamp(s.now()), DecidedAt: stamp(s.now()), ExpiresAt: stamp(s.now().Add(time.Hour)), Access: o.Access, Operation: o}
	decision := accessInput(approved, "once", "approve-"+suffix)
	approved.AccessDecision = &decision
	o.Authorization = &OperationAuthorization{ID: o.ID, Digest: o.Access.Digest, Decision: "once", CreatedAt: stamp(s.now())}
	o.Preparation = &RuntimePreparation{State: "pulling", Current: 4, Total: 12}
	var err error
	run, err = s.change(context.Background(), run.ID, "fixture-runtime-pulling", func(tx *sql.Tx, r *Run) error {
		r.Status, r.Phase = StateRunning, "preparing-runtime"
		r.Resume = &RecoveryCursor{ResponseID: o.ModelRequestID, CallIndex: o.CallIndex}
		if err := saveOperation(context.Background(), tx, o); err != nil {
			return err
		}
		if err := saveApproval(context.Background(), tx, approved); err != nil {
			return err
		}
		return s.event(context.Background(), tx, r, "runtime/pulling", "", nil, nil)
	})
	if err != nil {
		t.Fatal(err)
	}
	return run, o, approved
}

func readRecoveryApproval(t *testing.T, s *store, id string) Approval {
	t.Helper()
	var raw string
	if err := s.db.QueryRow("SELECT document FROM approvals WHERE id=?", id).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var a Approval
	if err := json.Unmarshal([]byte(raw), &a); err != nil {
		t.Fatal(err)
	}
	return a
}

func TestRuntimePreparationCrashRestoresUnknownWithNewApproval(t *testing.T) {
	ctx := context.Background()
	s, path := openRuntimeTestStore(t)
	run, operation, approved := pullingRuntimeFixture(t, s, "crash")
	if err := s.close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := openStore(path, func() time.Time { return runtimeStoreTestTime.Add(time.Minute) })
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.close()
	if err := reopened.recover(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := reopened.get(ctx, run.ID)
	if err != nil || got.Status != StateWaitingApproval || got.Phase != StateWaitingApproval || got.ActiveMilliseconds != run.ActiveMilliseconds || digestJSON(got.Resume) != digestJSON(run.Resume) || got.Snapshot.Digest != run.Snapshot.Digest || got.EndedAt != "" {
		t.Fatalf("crash lost exact continuation or budget: %+v %v", got, err)
	}
	current, err := readOperation(ctx, reopened.db, operation.ID)
	if err != nil || current.Preparation == nil || current.Preparation.State != "unknown" || current.Preparation.Current != 4 || current.Authorization != nil || current.DispatchID != "" || current.Access.Revision != operation.Access.Revision+1 || current.ApprovalID == approved.ID {
		t.Fatalf("preparation was replayed or its authority retained: %+v %v", current, err)
	}
	if current.Access.Digest == approved.Access.Digest || accessDigest(current) != current.Access.Digest {
		t.Fatal("recovery request did not get its own valid digest")
	}
	previous := readRecoveryApproval(t, reopened, approved.ID)
	if previous.Status != "revoked" || digestJSON(previous.AccessDecision) != digestJSON(approved.AccessDecision) || previous.DecidedAt != approved.DecidedAt {
		t.Fatalf("original decision was overwritten: %+v", previous)
	}
	next := readRecoveryApproval(t, reopened, current.ApprovalID)
	if next.Status != "pending" || next.AccessDecision != nil || !approvedOperationMatches(next.Operation, current) {
		t.Fatalf("recovery approval does not match pending operation: %+v", next)
	}
	session, err := readSession(ctx, reopened.db, run.SessionID)
	if err != nil || session.ActiveRunID != run.ID {
		t.Fatalf("preparation recovery released session: %+v %v", session, err)
	}
	if runtimeStoreCount(t, reopened, "execution_barriers") != 0 || runtimeStoreCount(t, reopened, "calls") != 0 {
		t.Fatal("image preparation created a command dispatch or barrier")
	}
	beforeSeq := got.LastSeq
	if err := reopened.recover(ctx); err != nil {
		t.Fatal(err)
	}
	again, _ := reopened.get(ctx, run.ID)
	if again.LastSeq != beforeSeq || runtimeStoreCount(t, reopened, "approvals") != 2 {
		t.Fatal("repeated recovery created another approval")
	}
	if dirty := runtimeStoreCount(t, reopened, "agent_record_dirty"); dirty != 0 {
		t.Fatal("recovery facts not flushed to JSONL", dirty)
	}
}

func TestRuntimePreparationRecoveryDoesNotReviveCancelledOrDispatchedRuns(t *testing.T) {
	for _, state := range []string{"cancelled", "cancel-requested", "succeeded", "interrupted", "dispatched", "barrier", "legacy", "changed-authorization"} {
		t.Run(state, func(t *testing.T) {
			ctx := context.Background()
			s, _ := openRuntimeTestStore(t)
			run, operation, _ := pullingRuntimeFixture(t, s, state)
			_, err := s.change(ctx, run.ID, "fixture-no-runtime-recovery", func(tx *sql.Tx, r *Run) error {
				switch state {
				case "cancelled", "succeeded", "interrupted":
					r.Status, r.EndedAt = state, stamp(s.now())
				case "cancel-requested":
					r.CancelRequestedAt = stamp(s.now())
				case "legacy":
					r.Snapshot.AuthorizationMode = ""
				case "dispatched":
					operation.DispatchID = "dispatched-external-command"
					operation.Status = "dispatched"
				case "barrier":
					if err := saveBarrier(ctx, tx, ExecutionBarrier{ID: "prior-barrier", RunID: r.ID, OperationID: operation.ID, Status: "unknown", CreatedAt: stamp(s.now())}); err != nil {
						return err
					}
				case "changed-authorization":
					operation.Authorization.Digest = "wrong"
				}
				if err := saveOperation(ctx, tx, operation); err != nil {
					return err
				}
				return saveRun(ctx, tx, r)
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := s.recover(ctx); err != nil {
				t.Fatal(err)
			}
			got, err := s.get(ctx, run.ID)
			if err != nil || !terminal(got.Status) || runtimeStoreCount(t, s, "approvals") != 1 {
				t.Fatalf("unsafe recovery revived %s: %+v %v", state, got, err)
			}
			if state == "dispatched" || state == "barrier" {
				if runtimeStoreCount(t, s, "execution_barriers") != 1 {
					t.Fatal("unknown execution lost its barrier")
				}
			}
		})
	}
}

func TestRuntimePreparationRecoveryConfirmationOnlyInspectsImage(t *testing.T) {
	for _, installed := range []bool{false, true} {
		t.Run(map[bool]string{false: "missing", true: "installed"}[installed], func(t *testing.T) {
			ctx := context.Background()
			s, _ := openRuntimeTestStore(t)
			run, operation, _ := pullingRuntimeFixture(t, s, "inspect")
			if err := s.recover(ctx); err != nil {
				t.Fatal(err)
			}
			current, err := readOperation(ctx, s.db, operation.ID)
			if err != nil {
				t.Fatal(err)
			}
			approval := readRecoveryApproval(t, s, current.ApprovalID)
			root := t.TempDir()
			socket := filepath.Join(root, "engine.sock")
			listener, err := net.Listen("unix", socket)
			if err != nil {
				t.Fatal(err)
			}
			var requests atomic.Int32
			server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				requests.Add(1)
				if req.Method != http.MethodGet || !strings.HasPrefix(req.URL.Path, "/v1.41/images/") {
					t.Errorf("recovered preparation mutated Docker or re-resolved an image: %s %s", req.Method, req.URL.Path)
					w.WriteHeader(400)
					return
				}
				if !installed {
					w.WriteHeader(404)
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"Os": "linux", "Architecture": "amd64", "RepoDigests": []string{operation.Execution.Profile.Image}, "Config": map[string]any{}})
			})}
			go server.Serve(listener)
			t.Cleanup(func() { _ = server.Close() })
			executor, err := execution.New(execution.Options{SocketPath: socket, MountRoot: root, SupervisorPath: "/test-supervisor"})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = executor.Close(ctx) })
			m := &Manager{ctx: ctx, store: s, deps: Deps{Now: s.now, NewID: randomID, Catalog: &Extensions{Executor: executor}}, wake: make(chan struct{}, 1)}
			if _, err := m.DecideAccess(ctx, approval.ID, accessInput(approval, "once", "confirm-inspect")); err != nil {
				t.Fatal(err)
			}
			run, err = s.change(ctx, run.ID, "fixture-start-confirmed-recovery", func(tx *sql.Tx, r *Run) error { r.Status = StateRunning; return saveRun(ctx, tx, r) })
			if err != nil {
				t.Fatal(err)
			}
			current, err = readOperation(ctx, s.db, operation.ID)
			if err != nil {
				t.Fatal(err)
			}
			prepared, err := m.prepareAuthorizedRuntime(ctx, run, current)
			if installed {
				if err != nil || prepared.Preparation.State != "ready" {
					t.Fatalf("installed approved image not confirmed: %+v %v", prepared.Preparation, err)
				}
			} else {
				if !errors.Is(err, worker.ErrSuspended) || prepared.Preparation.State != "unknown" {
					t.Fatalf("missing image restarted download or ended the run: %+v %v", prepared.Preparation, err)
				}
				got, _ := s.get(ctx, run.ID)
				if got.Status != StateWaitingApproval {
					t.Fatalf("unresolved image did not remain a manual recovery request: %+v", got)
				}
			}
			if requests.Load() != 1 {
				t.Fatalf("recovery must perform exactly one local image inspection, got %d", requests.Load())
			}
		})
	}
}

func TestRuntimePreparationShutdownCancellation(t *testing.T) {
	for _, tc := range []struct {
		name         string
		shutdown     bool
		userCanceled bool
	}{
		{name: "shutdown", shutdown: true},
		{name: "user-cancel", userCanceled: true},
		{name: "user-cancel-and-shutdown", shutdown: true, userCanceled: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			s, _ := openRuntimeTestStore(t)
			run, operation, approved := pullingRuntimeFixture(t, s, tc.name)
			originalRevision := operation.Access.Revision
			root := t.TempDir()
			socket := filepath.Join(root, "engine.sock")
			listener, err := net.Listen("unix", socket)
			if err != nil {
				t.Fatal(err)
			}
			pullStarted := make(chan struct{}, 1)
			var inspections, pulls atomic.Int32
			server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				switch {
				case req.Method == http.MethodGet && strings.HasPrefix(req.URL.Path, "/v1.41/images/"):
					inspections.Add(1)
					w.WriteHeader(http.StatusNotFound)
				case req.Method == http.MethodPost && req.URL.Path == "/v1.41/images/create":
					pulls.Add(1)
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusOK)
					w.(http.Flusher).Flush()
					pullStarted <- struct{}{}
					<-req.Context().Done()
				default:
					t.Errorf("preparation cancellation dispatched an unexpected Docker operation: %s %s", req.Method, req.URL.Path)
					w.WriteHeader(http.StatusBadRequest)
				}
			})}
			go server.Serve(listener)
			t.Cleanup(func() { _ = server.Close() })
			executor, err := execution.New(execution.Options{SocketPath: socket, MountRoot: root, SupervisorPath: "/test-supervisor"})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = executor.Close(ctx) })
			managerCtx, stopManager := context.WithCancel(ctx)
			defer stopManager()
			callCtx, stopCall := context.WithCancel(ctx)
			defer stopCall()
			m := &Manager{ctx: managerCtx, store: s, deps: Deps{Now: s.now, NewID: randomID, Catalog: &Extensions{Executor: executor}}, wake: make(chan struct{}, 1)}
			result := make(chan error, 1)
			go func() {
				_, prepareErr := m.prepareAuthorizedRuntime(callCtx, run, operation)
				result <- prepareErr
			}()
			select {
			case <-pullStarted:
			case <-time.After(5 * time.Second):
				t.Fatal("approved image preparation never reached the download stream")
			}
			// Persist explicit cancellation first, then interrupt the stream. This
			// also deterministically covers cancellation concurrent with shutdown.
			if tc.userCanceled {
				if _, err := m.Cancel(ctx, run.ID); err != nil {
					t.Fatal(err)
				}
			}
			if tc.shutdown {
				m.mu.Lock()
				m.closed = true
				m.mu.Unlock()
				stopManager()
			}
			stopCall()
			select {
			case err = <-result:
			case <-time.After(5 * time.Second):
				t.Fatal("interrupted preparation did not finish")
			}
			got, readErr := s.get(ctx, run.ID)
			if readErr != nil {
				t.Fatal(readErr)
			}
			current, readErr := readOperation(ctx, s.db, operation.ID)
			if readErr != nil {
				t.Fatal(readErr)
			}
			previous := readRecoveryApproval(t, s, approved.ID)
			if digestJSON(previous.AccessDecision) != digestJSON(approved.AccessDecision) || previous.DecidedAt != approved.DecidedAt {
				t.Fatal("stream interruption overwrote the original authorization decision")
			}
			if tc.userCanceled {
				if err == nil || errors.Is(err, worker.ErrSuspended) || got.CancelRequestedAt == "" || got.Status == StateWaitingApproval || current.ApprovalID != approved.ID || runtimeStoreCount(t, s, "approvals") != 1 {
					t.Fatalf("explicit cancellation was revived as a permission wait: %+v %+v %v", got, current, err)
				}
			} else {
				if !errors.Is(err, worker.ErrSuspended) || got.Status != StateWaitingApproval || got.CancelRequestedAt != "" || current.Preparation == nil || current.Preparation.State != "unknown" || current.Authorization != nil || current.ApprovalID == approved.ID || current.Access.Revision != originalRevision+1 || previous.Status != "revoked" {
					t.Fatalf("shutdown lost the durable verification-only wait: %+v %+v %v", got, current, err)
				}
				if digestJSON(got.Resume) != digestJSON(run.Resume) || got.ActiveMilliseconds != run.ActiveMilliseconds || accessDigest(current) != current.Access.Digest {
					t.Fatal("shutdown changed the original continuation, budget, or approved operation")
				}
			}
			if err := s.recover(ctx); err != nil {
				t.Fatal(err)
			}
			afterRecovery, _ := s.get(ctx, run.ID)
			if tc.userCanceled && !terminal(afterRecovery.Status) || !tc.userCanceled && afterRecovery.Status != StateWaitingApproval {
				t.Fatalf("restart changed cancellation or wait semantics: %+v", afterRecovery)
			}
			if pulls.Load() != 1 || inspections.Load() != 1 || current.DispatchID != "" || runtimeStoreCount(t, s, "execution_barriers") != 0 || runtimeStoreCount(t, s, "calls") != 0 {
				t.Fatal("interruption replayed image preparation or dispatched a command")
			}
		})
	}
}
