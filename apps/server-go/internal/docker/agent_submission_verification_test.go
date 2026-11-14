package docker

import (
	"context"
	"elysian/server/internal/config"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestSubmissionFenceRefusesMissingCachedReceipt(t *testing.T) {
	a := &AgentFacade{operationRoot: filepath.Join(t.TempDir(), "tasks")}
	input := AgentServiceCreateInput{Name: "first", RequestID: strings.Repeat("a", 64)}
	task, err := a.SealUnacceptedOperation(context.Background(), input.RequestID, "name:first", input)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(a.operationRoot, task.ID+".json")); err != nil {
		t.Fatal(err)
	}
	input.Name, input.RequestID = "second", strings.Repeat("b", 64)
	if _, err := a.SealUnacceptedOperation(context.Background(), input.RequestID, "name:second", input); err == nil {
		t.Fatal("missing ledger entry was treated as non-acceptance")
	}
}

func TestUnacceptedSubmissionFenceSurvivesRestartAndRejectsLateDispatch(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tasks")
	a := &AgentFacade{operationRoot: root}
	input := AgentServiceCreateInput{Name: "mysql84", RequestID: strings.Repeat("a", 64), Image: "mysql:8.4"}
	task, err := a.SealUnacceptedOperation(context.Background(), input.RequestID, "name:mysql84", input)
	if err != nil || task.State != "failed" || task.Stage != "not-accepted" {
		t.Fatalf("%+v %v", task, err)
	}
	reloaded := &AgentFacade{operationRoot: root}
	var executed atomic.Int32
	late, err := reloaded.submitContainerOperation(input.RequestID, "name:mysql84", input, func(context.Context, string) (any, error) { executed.Add(1); return true, nil })
	if err != nil || late.State != "failed" || executed.Load() != 0 {
		t.Fatalf("late submission crossed fence: %+v %v", late, err)
	}
	input.Name = "other"
	if _, err := reloaded.SealUnacceptedOperation(context.Background(), input.RequestID, "name:other", input); err == nil {
		t.Fatal("changed identity accepted")
	}
}

func TestExecObservationRequiresRunningEvidenceAndKeepsUnknownReceipt(t *testing.T) {
	var running atomic.Bool
	target, execID := strings.Repeat("c", 64), strings.Repeat("e", 64)
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		return 200, fmt.Sprintf(`{"Running":%t,"ExitCode":0,"ContainerID":%q}`, running.Load(), target), true
	})
	root := filepath.Join(t.TempDir(), "tasks")
	a := &AgentFacade{operationRoot: root, service: newService(engine, nil)}
	if err := a.loadContainerOperations(); err != nil {
		t.Fatal(err)
	}
	task := ContainerOperationTask{ID: operationID(strings.Repeat("a", 64)), RequestID: strings.Repeat("a", 64), Target: target, Digest: strings.Repeat("d", 64), State: "unknown", Stage: "exec-start-dispatched", ExecID: execID, ErrorCode: "original-unknown", Message: "原输出未确认"}
	a.operations[task.ID] = task
	if err := config.AtomicJSON(filepath.Join(root, task.ID+".json"), task); err != nil {
		t.Fatal(err)
	}
	initial, err := a.ObserveContainerOperation(context.Background(), task.ID)
	if err != nil || initial.Observation != nil {
		t.Fatalf("unstarted exec was assumed completed: %+v %v", initial, err)
	}
	running.Store(true)
	observed, err := a.ObserveContainerOperation(context.Background(), task.ID)
	if err != nil || !observed.ExecObservedRunning || observed.Observation != nil {
		t.Fatalf("running evidence %+v %v", observed, err)
	}
	running.Store(false)
	finished, err := a.ObserveContainerOperation(context.Background(), task.ID)
	if err != nil || finished.Observation == nil || finished.State != "unknown" || finished.ErrorCode != "original-unknown" || finished.Observation.OutputRecovered {
		t.Fatalf("original receipt changed: %+v %v", finished, err)
	}
	reloaded, err := (&AgentFacade{operationRoot: root}).InspectContainerOperation(context.Background(), task.ID)
	if err != nil || reloaded.Observation == nil {
		t.Fatalf("evidence not durable %+v %v", reloaded, err)
	}
	if err := a.updateContainerOperation(task.ID, func(t *ContainerOperationTask) { t.State = "running" }); err != nil {
		t.Fatal(err)
	}
	unchanged, _ := a.InspectContainerOperation(context.Background(), task.ID)
	if unchanged.State != "unknown" {
		t.Fatal("late update reopened observed execution")
	}
	if err := a.CheckContainerMutation(context.Background(), target, "", ""); err != nil {
		t.Fatalf("successful observation left a stale barrier: %v", err)
	}
	failed := unchanged
	failed.Observation = &ContainerOperationObservation{TaskID: task.ID, RequestID: task.RequestID, Target: task.Target, Digest: task.Digest, ExecID: task.ExecID, ExitCode: 1, ObservedAt: "observed"}
	if !containerOperationBlocks(failed) {
		t.Fatal("failed exec with possible partial changes lost protection")
	}
}

func TestSubmissionAndFenceRaceNeverReportsNotAcceptedAfterDispatch(t *testing.T) {
	for i := 0; i < 30; i++ {
		a := &AgentFacade{operationRoot: filepath.Join(t.TempDir(), "tasks")}
		input := AgentServiceCreateInput{Name: "mysql84", RequestID: strings.Repeat("b", 64)}
		var executed atomic.Int32
		var sealed ContainerOperationTask
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, err := a.submitContainerOperation(input.RequestID, "name:mysql84", input, func(context.Context, string) (any, error) { executed.Add(1); return true, nil })
			if err != nil {
				t.Error(err)
			}
		}()
		go func() {
			defer wg.Done()
			var err error
			sealed, err = a.SealUnacceptedOperation(context.Background(), input.RequestID, "name:mysql84", input)
			if err != nil {
				t.Error(err)
			}
		}()
		wg.Wait()
		a.operationWG.Wait()
		if sealed.Stage == "not-accepted" && executed.Load() != 0 {
			t.Fatal("fence claimed no execution after a dispatched worker")
		}
		if sealed.Stage != "not-accepted" && executed.Load() != 1 {
			t.Fatalf("unexpected dispatch count %d", executed.Load())
		}
	}
}
