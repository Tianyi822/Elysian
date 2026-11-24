package docker

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
)

func TestRecreateRestoresOriginalWhenReplacementIsUnhealthy(t *testing.T) {
	id, candidate := hostScopeID, strings.Repeat("d", 64)
	oldName, nextName := "original", ""
	oldRunning, nextRunning := true, false
	oldPolicy, nextPolicy := "always", "no"
	deleted := false
	var mu sync.Mutex
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		mu.Lock()
		defer mu.Unlock()
		switch call.Path {
		case "/containers/" + id + "/json", "/containers/" + candidate + "/json":
			old := strings.Contains(call.Path, id)
			if !old && deleted {
				return 404, "{}", true
			}
			target, name, policy, running := candidate, nextName, nextPolicy, nextRunning
			value := "new"
			if old {
				target, name, policy, running, value = id, oldName, oldPolicy, oldRunning, "old"
			}
			return 200, hostScopeInspect(target, nil, func(row map[string]any) {
				row["Name"] = "/" + name
				row["Path"] = "sleep"
				row["Args"] = []string{"infinity"}
				config := row["Config"].(map[string]any)
				config["Env"] = []string{"VAR=" + value}
				config["Healthcheck"] = map[string]any{"Test": []string{"CMD", "true"}}
				row["HostConfig"].(map[string]any)["RestartPolicy"] = map[string]any{"Name": policy}
				status := "exited"
				if running {
					status = "running"
				}
				health := "healthy"
				if !old {
					health = "unhealthy"
				}
				row["State"] = map[string]any{"Status": status, "Running": running, "Health": map[string]any{"Status": health}}
			}), true
		case "/containers/" + id + "/changes":
			return 200, "[]", true
		case "/containers/create":
			nextName = call.Query.Get("name")
			return 201, fmt.Sprintf(`{"Id":%q}`, candidate), true
		case "/containers/" + id + "/update", "/containers/" + candidate + "/update":
			var body struct{ RestartPolicy struct{ Name string } }
			_ = json.Unmarshal([]byte(call.Body), &body)
			if strings.Contains(call.Path, id) {
				oldPolicy = body.RestartPolicy.Name
			} else {
				nextPolicy = body.RestartPolicy.Name
			}
			return 200, "{}", true
		case "/containers/" + id + "/stop":
			oldRunning = false
			return 204, "", true
		case "/containers/" + candidate + "/stop":
			nextRunning = false
			return 204, "", true
		case "/containers/" + id + "/start":
			oldRunning = true
			return 204, "", true
		case "/containers/" + candidate + "/start":
			nextRunning = true
			return 204, "", true
		case "/containers/" + id + "/rename":
			oldName = call.Query.Get("name")
			return 204, "", true
		case "/containers/" + candidate + "/rename":
			nextName = call.Query.Get("name")
			return 204, "", true
		case "/containers/" + candidate:
			if call.Method != http.MethodDelete || call.Query.Has("v") || call.Query.Has("force") {
				t.Errorf("unsafe cleanup: %#v", call)
			}
			deleted = true
			return 204, "", true
		default:
			return 0, "", false
		}
	})
	a := facadeWithEngine(t, engine)
	value := "new"
	plan, err := a.previewRecreate(t.Context(), id, RecreatePatch{Env: []RecreateEnvChange{{Key: "VAR", Value: &value}}}, "agent:fixture", false)
	if err != nil {
		t.Fatal(err)
	}
	task, err := a.submitRecreate(t.Context(), RecreateInput{ID: id, PlanID: plan.PlanID, Revision: plan.Revision, RequestID: strings.Repeat("e", 64)}, "agent:fixture", false)
	if err != nil {
		t.Fatal(err)
	}
	done := awaitContainerTask(t, a, task.ID)
	if done.State != "failed" || done.ErrorCode != "docker-recreate-rolled-back" {
		t.Fatalf("%+v", done)
	}
	mu.Lock()
	defer mu.Unlock()
	if oldName != "original" || oldPolicy != "always" || !oldRunning || !deleted {
		t.Fatal("original container was not restored")
	}
}

func TestRecreateObservesKnownResultAfterRestart(t *testing.T) {
	id, candidate, requestID := hostScopeID, strings.Repeat("d", 64), strings.Repeat("e", 64)
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		target, name, policy, running := id, "original-backup", "no", false
		if strings.Contains(call.Path, candidate) {
			target, name, policy, running = candidate, "original", "always", true
		}
		return 200, hostScopeInspect(target, map[string]string{"site.elysian.recreate-request": requestID}, func(row map[string]any) {
			row["Name"] = "/" + name
			row["HostConfig"].(map[string]any)["RestartPolicy"] = map[string]any{"Name": policy}
			row["State"] = map[string]any{"Status": "exited", "Running": running}
		}), true
	})
	a := facadeWithEngine(t, engine)
	task := ContainerOperationTask{ID: operationID(requestID), RequestID: requestID, Target: id, Digest: strings.Repeat("a", 64), State: "running", Stage: "recreate-committing",
		Recreate: &RecreateRecord{Name: "original", BackupName: "original-backup", CandidateName: "candidate", CandidateID: candidate, ImageID: "sha256:" + strings.Repeat("a", 64), RestartPolicy: json.RawMessage(`{"Name":"always"}`), Running: true}}
	if err := a.loadContainerOperations(); err != nil {
		t.Fatal(err)
	}
	if err := a.publishContainerOperationLocked(task.ID, task); err != nil {
		t.Fatal(err)
	}
	reopened := &AgentFacade{service: a.service, operationRoot: a.operationRoot}
	if err := reopened.CheckContainerMutation(t.Context(), candidate, "original", ""); err == nil {
		t.Fatal("candidate write protection lost at restart")
	}
	fact, err := reopened.ObserveContainerOperation(t.Context(), task.ID)
	if err != nil || fact.State != "unknown" || RecreateTaskStatus(fact).State != "succeeded" {
		t.Fatalf("unexpected observation: %+v %v", fact, err)
	}
	if err := reopened.CheckContainerMutation(t.Context(), candidate, "original", ""); err != nil {
		t.Fatal(err)
	}
	for _, call := range engine.Requests() {
		if call.Method != http.MethodGet {
			t.Fatalf("reconciliation dispatched %+v", call)
		}
	}
}

func TestComposeRuntimeLabelsDistinguishImageProvenance(t *testing.T) {
	labels := map[string]json.RawMessage{"com.docker.compose.project": json.RawMessage(`"fixture"`), "com.docker.compose.service": json.RawMessage(`"api"`)}
	if recreateCompose(labels) {
		t.Fatal("image build labels are insufficient")
	}
	labels["com.docker.compose.config-hash"] = json.RawMessage(`"definition"`)
	if !recreateCompose(labels) {
		t.Fatal("Compose runtime ownership not recognized")
	}
}
