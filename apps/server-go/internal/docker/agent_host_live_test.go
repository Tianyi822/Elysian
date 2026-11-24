package docker

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/seam"
)

func TestLiveAgentHostContainerLifecycle(t *testing.T) {
	if os.Getenv("ELYSIAN_TEST_DOCKER_EXEC") != "1" {
		t.Skip("需要显式启用本地 Docker Engine 联调")
	}
	socket := os.Getenv("ELYSIAN_TEST_DOCKER_EXEC_SOCKET")
	if socket == "" {
		socket = "/var/run/docker.sock"
	}
	ctx := t.Context()
	engine := newUnixTransport(socket)
	request := func(ctx context.Context, method, path string, query url.Values, body []byte, expected int) seam.EngineResponse {
		t.Helper()
		response, err := engine.Request(ctx, seam.EngineRequest{Method: method, Path: path, Query: query, Body: body, Timeout: 20 * time.Second})
		if err != nil || response.Status != expected {
			t.Fatalf("Engine %s %s: status=%d body=%s error=%v", method, path, response.Status, response.Body, err)
		}
		return response
	}
	name := "elysian-host-scope-test-" + strings.ToLower(rand.Text())
	t.Cleanup(func() {
		response, err := engine.Request(context.Background(), seam.EngineRequest{Method: http.MethodDelete, Path: "/volumes/" + name, Timeout: 15 * time.Second})
		if err != nil || response.Status != http.StatusNoContent && response.Status != http.StatusNotFound {
			t.Errorf("清理临时测试卷失败: status=%d err=%v", response.Status, err)
		}
	})
	body, err := json.Marshal(map[string]any{
		"Image": "elysian-go-dev-go", "Cmd": []string{"/bin/sh", "-c", "echo elysian-host-scope-log; exec sleep infinity"},
		"HostConfig": map[string]any{"NetworkMode": "none", "Memory": 128 * mib, "PidsLimit": 64, "Binds": []string{name + ":/agent-host-test"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	created := request(ctx, http.MethodPost, "/containers/create", url.Values{"name": {name}}, body, http.StatusCreated)
	var identity struct{ ID string }
	if json.Unmarshal(created.Body, &identity) != nil || !agentOperationIDPattern.MatchString(identity.ID) {
		t.Fatalf("测试容器身份无效: %s", created.Body)
	}
	id := identity.ID
	t.Cleanup(func() {
		response, err := engine.Request(context.Background(), seam.EngineRequest{
			Method: http.MethodDelete, Path: "/containers/" + id, Query: url.Values{"force": {"1"}}, Timeout: 15 * time.Second,
		})
		if err != nil || response.Status != http.StatusNoContent && response.Status != http.StatusNotFound {
			t.Errorf("清理临时测试容器失败: status=%d err=%v", response.Status, err)
		}
	})
	facade := &AgentFacade{
		service:       newDockerService(serviceDeps{transport: engine, panelRuntime: "host"}),
		authorize:     func(context.Context) error { return nil },
		operationRoot: filepath.Join(t.TempDir(), "operations"),
	}
	t.Cleanup(func() {
		if err := facade.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})

	if _, err := facade.Action(ctx, id, "start"); err != nil {
		t.Fatal(err)
	}
	value, err := facade.ContainerStats(ctx, id)
	stats, ok := value.(agentContainerStats)
	if err != nil || !ok || stats.CPUPercent == nil || stats.MemoryMiB == nil || stats.PIDs == nil {
		t.Fatalf("真实 Engine 未返回有效 CPU、内存或 PID 统计: %+v %v", value, err)
	}
	logs, err := facade.Logs(ctx, id, 5)
	rawLogs, _ := json.Marshal(logs)
	if err != nil || !strings.Contains(string(rawLogs), "elysian-host-scope-log") {
		t.Fatalf("日志未读取: %s %v", rawLogs, err)
	}
	exec, err := facade.SubmitExec(ctx, ContainerExecInput{ID: id, RequestID: strings.Repeat("1", 64), Argv: []string{"/bin/echo", "elysian-host-scope-exec"}})
	if err != nil {
		t.Fatal(err)
	}
	if task := awaitContainerTask(t, facade, exec.ID); task.State != "succeeded" || !strings.Contains(string(task.Result), "elysian-host-scope-exec") {
		t.Fatalf("用户容器 exec 失败: %+v %s", task, task.Result)
	}
	policy, retries, cpu, memory, pids := "on-failure", 3, 500, 96, 0
	update, err := facade.SubmitUpdate(ctx, ContainerUpdateInput{
		ID: id, RequestID: strings.Repeat("2", 64), RestartPolicy: &policy, RestartMaxRetries: &retries,
		CPUMillis: &cpu, MemoryMiB: &memory, PIDsLimit: &pids,
	})
	if err != nil {
		t.Fatal(err)
	}
	if task := awaitContainerTask(t, facade, update.ID); task.State != "succeeded" {
		t.Fatalf("用户容器更新未确认: %+v", task)
	}
	if _, err := facade.Action(ctx, id, "stop"); err != nil {
		t.Fatal(err)
	}
	if err := facade.Remove(ctx, id); err != nil {
		t.Fatal(err)
	}
	request(ctx, http.MethodGet, "/volumes/"+name, nil, nil, http.StatusOK)
}
