package websites

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/seam"
)

func TestAgentWebsiteTaskProjectionAndTargetIsolation(t *testing.T) {
	f := fixture(t, nil, nil, nil, nil)
	m := newDeploymentManager(f.service, deploymentEngine{limits: defaultDeploymentLimits()}, t.TempDir(), t.TempDir(), t.TempDir())
	f.service.deployments = m
	task := deploymentTask{ID: newDeploymentID(), Name: "new-site", ProjectID: "created-project", State: "failed", Error: "SECRET_RAW", CreatedAt: "created", UpdatedAt: "updated", Input: deploymentInput{RequestID: newDeploymentID()}, Config: buildConfig{Command: "TOKEN=SECRET_RAW"}}
	m.tasks[task.ID] = &task
	facade := &AgentFacade{service: f.service, authorize: func(context.Context) error { return nil }}
	value, err := facade.Call(context.Background(), "task_logs", json.RawMessage(`{"id":"new-site","taskId":"`+task.ID+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(value)
	if strings.Contains(string(raw), "SECRET_RAW") || !strings.Contains(string(raw), "rawWithheld") {
		t.Fatalf("unsafe projection %s", raw)
	}
	if _, err = facade.Call(context.Background(), "task", json.RawMessage(`{"id":"other","taskId":"`+task.ID+`"}`)); err == nil {
		t.Fatal("foreign project task accepted")
	}
	if _, err = facade.Call(context.Background(), "deploy", json.RawMessage(`{"id":"ungranted","deployment":{"name":"new-site"}}`)); err == nil {
		t.Fatal("unmatched new project accepted")
	}
}

func TestAgentWebsiteCleanupUncertaintySurvivesRestart(t *testing.T) {
	f := fixture(t, nil, nil, nil, nil)
	root, sourceRoot, logs := t.TempDir(), t.TempDir(), t.TempDir()
	cleanupOK := false
	transport := &fakeTransport{response: func(request seam.EngineRequest) seam.EngineResponse {
		if request.Path == "/containers/json" {
			return seam.EngineResponse{Status: 200, Body: []byte("[]")}
		}
		if cleanupOK {
			if request.Method == "DELETE" {
				return seam.EngineResponse{Status: 204}
			}
			return seam.EngineResponse{Status: 404}
		}
		return seam.EngineResponse{Status: 500}
	}}
	engine := deploymentEngine{transport: transport, limits: defaultDeploymentLimits()}
	m := newDeploymentManager(f.service, engine, root, sourceRoot, logs)
	f.service.deployments = m
	task := deploymentTask{ID: newDeploymentID(), Name: "site", State: "building", BuildContainer: testContainerID, CreatedAt: time.Now().UTC().Format(time.RFC3339), Input: deploymentInput{RequestID: newDeploymentID()}}
	m.tasks[task.ID] = &task
	m.fail(task.ID, context.Canceled, true)
	facade := &AgentFacade{service: f.service}
	status, err := facade.InspectTask(context.Background(), task.ID)
	if err != nil || status.Terminal || status.State != "unknown" {
		t.Fatalf("cleanup uncertainty released task: %#v %v", status, err)
	}
	if !activeDeployment(status.State) {
		t.Fatal("unconfirmed task must block another deployment")
	}
	if _, err = os.Stat(filepath.Join(root, task.ID+".json")); err != nil {
		t.Fatal(err)
	}
	f.service.deployments = newDeploymentManager(f.service, engine, root, sourceRoot, logs)
	status, err = facade.InspectTask(context.Background(), task.ID)
	if err != nil || status.Terminal || status.State != "unknown" {
		t.Fatalf("restart released unconfirmed task: %#v %v", status, err)
	}
	cleanupOK = true
	f.service.deployments = newDeploymentManager(f.service, engine, root, sourceRoot, logs)
	status, err = facade.InspectTask(context.Background(), task.ID)
	if err != nil || !status.Terminal || status.State != "interrupted" {
		t.Fatalf("confirmed restart cleanup did not resolve task: %#v %v", status, err)
	}
}

func TestAgentWebsitePendingRecoveryNeverReportsTerminal(t *testing.T) {
	f := fixture(t, nil, nil, nil, nil)
	m := newDeploymentManager(f.service, deploymentEngine{limits: defaultDeploymentLimits()}, t.TempDir(), t.TempDir(), t.TempDir())
	f.service.deployments = m
	for _, state := range []string{"succeeded", "failed", "cancelled", "interrupted"} {
		task := deploymentTask{ID: newDeploymentID(), State: state, Pending: &WebsiteRecord{ID: "unconfirmed"}}
		m.tasks[task.ID] = &task
		status, err := (&AgentFacade{service: f.service}).InspectTask(context.Background(), task.ID)
		if err != nil || status.Terminal {
			t.Fatalf("%s with recovery pending is terminal: %#v %v", state, status, err)
		}
	}
}
