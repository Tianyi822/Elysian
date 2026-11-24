package docker

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
)

func TestLiveRecreateStandaloneContainer(t *testing.T) {
	if os.Getenv("ELYSIAN_TEST_DOCKER_EXEC") != "1" {
		t.Skip("需要显式启用本地 Docker Engine 联调")
	}
	socket := os.Getenv("ELYSIAN_TEST_DOCKER_EXEC_SOCKET")
	if socket == "" {
		socket = "/var/run/docker.sock"
	}
	engine := newUnixTransport(socket)
	request := func(method, endpoint string, query url.Values, body any, expect int) []byte {
		t.Helper()
		var data []byte
		if body != nil {
			data, _ = json.Marshal(body)
		}
		r, err := engine.Request(t.Context(), seam.EngineRequest{Method: method, Path: endpoint, Query: query, Body: data, Timeout: 30 * time.Second})
		if err != nil || r.Status != expect {
			t.Fatalf("%s %s: %d %s %v", method, endpoint, r.Status, r.Body, err)
		}
		return r.Body
	}
	cleanup := func(endpoint string, query url.Values) {
		t.Helper()
		r, err := engine.Request(context.Background(), seam.EngineRequest{Method: "DELETE", Path: endpoint, Query: query, Timeout: 30 * time.Second})
		if err != nil || r.Status != 204 && r.Status != 404 && !(strings.HasPrefix(endpoint, "/images/") && r.Status == 200) {
			t.Errorf("清理测试资源 %s: %d %v", endpoint, r.Status, err)
		}
	}
	idFrom := func(body []byte) string {
		var identity struct{ ID string }
		if json.Unmarshal(body, &identity) != nil || identity.ID == "" {
			t.Fatalf("Engine identity missing: %s", body)
		}
		return identity.ID
	}
	execIn := func(target, script string) {
		t.Helper()
		execID := idFrom(request("POST", "/containers/"+target+"/exec", nil, map[string]any{"Cmd": []string{"sh", "-ec", script}}, 201))
		request("POST", "/exec/"+execID+"/start", nil, map[string]bool{"Detach": false, "Tty": false}, 200)
		var state struct {
			Running  bool
			ExitCode *int
		}
		if json.Unmarshal(request("GET", "/exec/"+execID+"/json", nil, nil, 200), &state) != nil || state.Running || state.ExitCode == nil || *state.ExitCode != 0 {
			t.Fatalf("volume data check did not succeed: %s", script)
		}
	}
	name := "ely-recreate-test-" + strings.ToLower(rand.Text())
	for _, volume := range []string{name, name + "-extra"} {
		request("POST", "/volumes/create", nil, map[string]any{"Name": volume}, 201)
		t.Cleanup(func() { cleanup("/volumes/"+volume, nil) })
	}
	original := idFrom(request("POST", "/containers/create", url.Values{"name": {name}}, map[string]any{
		"Image": "elysian-go-dev-go", "Cmd": []string{"sleep", "infinity"}, "Env": []string{"ELY_OLD=present", "TEST_TOKEN=unchanged"},
		"Healthcheck": map[string]any{"Test": []string{"CMD-SHELL", `test "$ELY_TEST_HEALTH" != fail`}, "Interval": int64(time.Second), "Retries": 1},
		"HostConfig":  map[string]any{"Binds": []string{name + ":/preserve:rw"}, "RestartPolicy": map[string]any{"Name": "always"}},
	}, 201))
	t.Cleanup(func() { cleanup("/containers/"+original, url.Values{"force": {"1"}}) })
	if len(original) != 64 {
		t.Fatal(original)
	}
	image := idFrom(request("POST", "/commit", url.Values{"container": {original}}, nil, 201))
	t.Cleanup(func() { cleanup("/images/"+image, nil) })
	request("POST", "/containers/"+original+"/start", nil, nil, 204)
	execIn(original, "printf retained > /preserve/marker")
	root := filepath.Join(t.TempDir(), "operations")
	a := &AgentFacade{service: newDockerService(serviceDeps{transport: engine, panelRuntime: "host"}), operationRoot: root, authorize: func(context.Context) error { return nil }}
	t.Cleanup(func() { _ = a.Close(context.Background()) })
	api := chi.NewRouter()
	registerRecreateRoutes(api, a)
	web := func(method, endpoint, session string, payload, out any, want int) {
		t.Helper()
		body, _ := json.Marshal(payload)
		req := httptest.NewRequestWithContext(t.Context(), method, endpoint, bytes.NewReader(body))
		req.Header.Set("Cookie", seam.SessionCookieName+"="+session)
		reply := httptest.NewRecorder()
		api.ServeHTTP(reply, req)
		if reply.Code != want {
			t.Fatalf("%s: status %d, want %d", endpoint, reply.Code, want)
		}
		if out != nil && json.Unmarshal(reply.Body.Bytes(), out) != nil {
			t.Fatalf("%s: invalid receipt", endpoint)
		}
	}
	value := "new-secret-value"
	hostPort := 54000 + os.Getpid()%10000
	ports := []contract.PortBindingView{
		{ContainerPort: 8000, HostPort: hostPort, HostIP: "127.0.0.1", Protocol: "tcp"},
		{ContainerPort: 8000, HostPort: hostPort, HostIP: "127.0.0.1", Protocol: "udp"},
	}
	mounts := []RecreateMount{{Kind: "volume", Source: name, Target: "/preserve"}, {Kind: "volume", Source: name + "-extra", Target: "/extra", ReadOnly: true}}
	patch := RecreatePatch{ImageID: image, Ports: &ports, Mounts: &mounts, Env: []RecreateEnvChange{{Key: "TEST_TOKEN", Value: &value}, {Key: "ELY_OLD", Remove: true}}}
	if _, err := a.previewRecreate(t.Context(), original, patch, "agent:run", false); err == nil {
		t.Fatal("Ely accepted a secret")
	}
	var plan RecreatePreview
	web("POST", "/containers/"+original+"/recreate/preview", "fixture", patch, &plan, 200)
	raw, _ := json.Marshal(plan)
	if strings.Contains(string(raw), value) || !plan.Running || len(plan.Changes) != 5 {
		t.Fatalf("preview: %s", raw)
	}
	in := RecreateInput{ID: original, PlanID: plan.PlanID, Revision: plan.Revision, RequestID: strings.Repeat("b", 64)}
	web("POST", "/containers/"+original+"/recreate", "other", in, nil, 409)
	var task ContainerOperationTask
	web("POST", "/containers/"+original+"/recreate", "fixture", in, &task, 202)
	await := func(task ContainerOperationTask) ContainerOperationTask {
		t.Helper()
		t.Cleanup(func() {
			_ = a.Close(context.Background())
			latest, err := a.InspectContainerOperation(context.Background(), task.ID)
			if err == nil && latest.Recreate != nil && latest.Recreate.CandidateID != "" {
				cleanup("/containers/"+latest.Recreate.CandidateID, url.Values{"force": {"1"}})
			}
		})
		result := task
		deadline := time.Now().Add(45 * time.Second)
		for result.State == "running" && time.Now().Before(deadline) {
			time.Sleep(100 * time.Millisecond)
			var err error
			result, err = a.InspectContainerOperation(t.Context(), task.ID)
			if err != nil {
				t.Fatal(err)
			}
		}
		return result
	}
	result := await(task)
	if result.State != "succeeded" {
		t.Fatalf("%+v", result)
	}
	var report ContainerOperationTask
	web("GET", "/recreate-tasks/"+in.RequestID, "fixture", nil, &report, 200)
	if report.State != result.State || !reflect.DeepEqual(report.Recreate.Changes, plan.Changes) {
		t.Fatal("Web task receipt does not match the approved diff")
	}
	old, err := a.recreateSource(t.Context(), original)
	if err != nil || old.running || old.name != result.Recreate.BackupName || old.restart != "no" {
		t.Fatalf("old not retained safely: %v %+v", err, old.name)
	}
	next, err := a.recreateSource(t.Context(), result.Recreate.CandidateID)
	if err != nil || !next.running || next.name != name || next.restart != "always" || next.image != image {
		t.Fatalf("replacement not committed: %v %v", err, next.name)
	}
	execIn(next.id, `test "$(cat /preserve/marker)" = retained`)
	config, err := a.RecreateConfiguration(t.Context(), next.id)
	if err != nil || config.Latest == nil || len(config.Container.Ports) != 2 || len(config.Mounts) != 2 {
		t.Fatalf("replacement projection: %+v %v", config, err)
	}
	actual := recreateEnvValues(next.config["Env"])
	if actual["TEST_TOKEN"] != value || actual["ELY_OLD"] != "" {
		t.Fatal("environment did not match")
	}
	raw, err = os.ReadFile(filepath.Join(root, task.ID+".json"))
	if err != nil || strings.Contains(string(raw), value) || strings.Contains(string(raw), "unchanged") {
		t.Fatal("task receipt contains environment values")
	}
	retry, err := a.submitRecreate(t.Context(), in, "web:fixture", true)
	if err != nil || retry.ID != task.ID {
		t.Fatalf("retry did not resolve original task: %v", err)
	}
	fail := "fail"
	healthPatch := RecreatePatch{Env: []RecreateEnvChange{{Key: "ELY_TEST_HEALTH", Value: &fail}}}
	healthPreview, err := a.PreviewAgentRecreate(t.Context(), next.id, healthPatch, "fixture")
	if err != nil || len(healthPreview.Changes) != 1 {
		t.Fatalf("Ely preview: %+v %v", healthPreview, err)
	}
	var webHealthPreview RecreatePreview
	web("POST", "/containers/"+next.id+"/recreate/preview", "fixture", healthPatch, &webHealthPreview, 200)
	if !reflect.DeepEqual(webHealthPreview.Changes, healthPreview.Changes) || !reflect.DeepEqual(webHealthPreview.RetainedMountTargets, healthPreview.RetainedMountTargets) || webHealthPreview.HealthWaitSeconds != healthPreview.HealthWaitSeconds {
		t.Fatal("Web and Ely projected different previews")
	}
	healthTask, err := a.SubmitAgentRecreate(t.Context(), RecreateInput{ID: next.id, PlanID: healthPreview.PlanID, Revision: healthPreview.Revision, RequestID: strings.Repeat("d", 64)}, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	failed := await(healthTask)
	if failed.State != "failed" || failed.ErrorCode != "docker-recreate-rolled-back" {
		t.Fatalf("health failure did not roll back: %+v", failed)
	}
	web("GET", "/recreate-tasks/"+healthTask.RequestID, "fixture", nil, &report, 200)
	if report.State != failed.State || report.ErrorCode != failed.ErrorCode {
		t.Fatal("Web and Ely projected different rollback outcomes")
	}
	restored, err := a.recreateSource(t.Context(), next.id)
	if err != nil || !restored.running || restored.restart != "always" || restored.name != name {
		t.Fatalf("health rollback did not restore original: %v", err)
	}
	originalStopped := idFrom(request("POST", "/containers/create", url.Values{"name": {name + "-stopped"}}, map[string]any{
		"Image": "elysian-go-dev-go", "Cmd": []string{"sleep", "infinity"},
	}, 201))
	t.Cleanup(func() { cleanup("/containers/"+originalStopped, url.Values{"force": {"1"}}) })
	stopped := originalStopped
	newMount := []RecreateMount{{Kind: "volume", Source: name, Target: "/data", ReadOnly: true}}
	for i, patch := range []RecreatePatch{{Mounts: &newMount}, {Ports: &ports}, {ImageID: image}} {
		// Port bindings are configured but never published for stopped containers.
		if i == 1 {
			for i := range ports {
				ports[i].HostPort--
			}
		}
		preview, err := a.previewRecreate(t.Context(), stopped, patch, "web:fixture", true)
		if err != nil || preview.Running || len(preview.Changes) != 1 {
			t.Fatalf("stopped preview %d: %+v %v", i, preview, err)
		}
		requestID, err := randomRecreateToken()
		if err != nil {
			t.Fatal(err)
		}
		task, err := a.submitRecreate(t.Context(), RecreateInput{ID: stopped, PlanID: preview.PlanID, Revision: preview.Revision, RequestID: requestID}, "web:fixture", true)
		if err != nil {
			t.Fatal(err)
		}
		report := await(task)
		if report.State != "succeeded" {
			t.Fatalf("stopped rebuild %d: %+v", i, report)
		}
		stopped = report.Recreate.CandidateID
		actual, err := a.recreateSource(t.Context(), stopped)
		if err != nil || actual.running || actual.name != name+"-stopped" {
			t.Fatalf("stopped rebuild started %d: %v", i, err)
		}
	}
}
