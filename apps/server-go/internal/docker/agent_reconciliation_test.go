package docker

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"elysian/server/internal/seam"
)

func TestAcceptedContainerFailureWithoutEffectsDoesNotLeaveBarrier(t *testing.T) {
	a := &AgentFacade{operationRoot: filepath.Join(t.TempDir(), "tasks")}
	request := strings.Repeat("a", 64)
	task, err := a.submitContainerOperation(request, "target", nil, func(context.Context, string) (any, error) {
		return nil, &seam.AgentContainerError{Code: "database-container-operation-failed", Message: "数据库容器未运行，数据库变更未执行", NoBusinessEffect: true}
	})
	if err != nil {
		t.Fatal(err)
	}
	got := awaitContainerTask(t, a, task.ID)
	if got.State != "failed" || got.ErrorCode != "database-container-operation-failed" {
		t.Fatalf("%+v", got)
	}
	if err := a.CheckContainerMutation(context.Background(), "target", "", ""); err != nil {
		t.Fatal(err)
	}
}

func TestContainerReconciliationRetainsUnknownReceiptAcrossRestart(t *testing.T) {
	ctx := context.Background()
	root := filepath.Join(t.TempDir(), "tasks")
	a := &AgentFacade{operationRoot: root}
	task, err := a.submitContainerOperation(strings.Repeat("a", 64), "target", map[string]string{"input": "fixed"}, func(context.Context, string) (any, error) { return nil, errors.New("lost receipt") })
	if err != nil {
		t.Fatal(err)
	}
	got := awaitContainerTask(t, a, task.ID)
	a.operationWG.Wait()
	resolution := ContainerOperationResolution{ID: "barrier", TaskID: got.ID, RequestID: got.RequestID, Target: got.Target, Digest: got.Digest, Decision: "confirmed-stopped", Evidence: "外部核实执行已结束"}
	invalid := resolution
	invalid.Digest = strings.Repeat("b", 64)
	if err := a.ReconcileContainerOperation(ctx, invalid); err == nil {
		t.Fatal("changed digest accepted")
	}
	if err := a.CheckContainerMutation(ctx, "target", "", ""); err == nil {
		t.Fatal("unknown protection lost")
	}
	if err := a.ReconcileContainerOperation(ctx, resolution); err != nil {
		t.Fatal(err)
	}
	if err := a.updateContainerOperation(task.ID, func(task *ContainerOperationTask) { task.State = "running" }); err != nil {
		t.Fatal(err)
	}
	restarted := &AgentFacade{operationRoot: root}
	after, err := restarted.InspectContainerOperation(ctx, task.ID)
	if err != nil || after.State != "unknown" || after.ErrorCode != got.ErrorCode || after.Resolution == nil || *after.Resolution != resolution {
		t.Fatalf("receipt=%+v %v", after, err)
	}
	if err := restarted.ReconcileContainerOperation(ctx, resolution); err != nil {
		t.Fatal(err)
	}
	if err := restarted.CheckContainerMutation(ctx, "target", "", ""); err != nil {
		t.Fatal(err)
	}
	invalid = resolution
	invalid.Decision = "confirmed-completed"
	if err := restarted.ReconcileContainerOperation(ctx, invalid); err == nil {
		t.Fatal("decision overwritten")
	}
}

func TestContainerReconciliationRejectsActiveWorkerAndRunningExec(t *testing.T) {
	ctx := context.Background()
	for _, remoteRunning := range []bool{false, true} {
		t.Run(map[bool]string{false: "worker", true: "exec"}[remoteRunning], func(t *testing.T) {
			a, _ := execTaskFacade(t, `{"Running":true,"ContainerID":"`+strings.Repeat("c", 64)+`"}`, nil)
			if err := a.loadContainerOperations(); err != nil {
				t.Fatal(err)
			}
			task := ContainerOperationTask{ID: operationID(strings.Repeat("a", 64)), RequestID: strings.Repeat("a", 64), Target: strings.Repeat("c", 64), Digest: strings.Repeat("d", 64), State: "unknown"}
			if remoteRunning {
				task.ExecID = strings.Repeat("e", 64)
			} else {
				a.operationCancel[task.ID] = func() {}
			}
			a.operations[task.ID] = task
			resolution := ContainerOperationResolution{ID: "barrier", TaskID: task.ID, RequestID: task.RequestID, Target: task.Target, Digest: task.Digest, Decision: "confirmed-stopped", Evidence: "停止"}
			if err := a.ReconcileContainerOperation(ctx, resolution); err == nil {
				t.Fatal("active execution released")
			}
		})
	}
}

func TestContainerReconciliationCanFinishAfterObservationRecovered(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(map[bool]string{false: "succeeded", true: "failed"}[failed], func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "tasks")
			a := &AgentFacade{operationRoot: root}
			task, err := a.submitContainerOperation(strings.Repeat("a", 64), "target", nil, func(context.Context, string) (any, error) {
				if failed {
					return nil, &seam.AgentContainerError{Code: "no-effect", Message: "变更未执行", NoBusinessEffect: true}
				}
				return map[string]bool{"done": true}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			a.operationWG.Wait()
			got, err := a.InspectContainerOperation(context.Background(), task.ID)
			if err != nil {
				t.Fatal(err)
			}
			// Harness may have already saved an unknown observation timeout.
			resolution := ContainerOperationResolution{ID: "observation-timeout-barrier", TaskID: got.ID, RequestID: got.RequestID, Target: got.Target, Digest: got.Digest, Decision: "confirmed-stopped", Evidence: "恢复查询，核实真实结束回执"}
			if err := a.ReconcileContainerOperation(context.Background(), resolution); err != nil {
				t.Fatal(err)
			}
			restarted := &AgentFacade{operationRoot: root}
			after, err := restarted.InspectContainerOperation(context.Background(), task.ID)
			if err != nil || after.State != got.State || after.Resolution == nil || *after.Resolution != resolution {
				t.Fatalf("%+v %v", after, err)
			}
		})
	}
}
