package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"elysian/server/internal/seam"
)

// 非面板容器（用户自装或面板网页创建）的完整 64 位 ID。
const hostScopeID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// hostScopeInspect 构造一个非 Agent 模板容器的 inspect 应答：字段集满足 mapContainer，
// labels 为 nil 表示容器没有任何标签；configure 可覆盖宿主配置、挂载与状态。
func hostScopeInspect(id string, labels map[string]string, configure func(body map[string]any)) string {
	body := map[string]any{
		"Id": id, "Name": "/frp", "Created": "2026-11-01T00:00:00Z",
		"Image": "sha256:" + strings.Repeat("a", 64),
		"State": map[string]any{"Status": "running", "Running": true, "ExitCode": 0, "StartedAt": "2026-11-01T00:00:01Z"},
		"Config": map[string]any{
			"Image": "snowdreamtech/frp:0.61", "Env": []string{"TZ=Asia/Shanghai"}, "Labels": labels,
		},
		"HostConfig": map[string]any{"NetworkMode": "bridge", "RestartPolicy": map[string]any{"Name": "always"}},
		"Mounts":     []any{},
	}
	if configure != nil {
		configure(body)
	}
	raw, _ := json.Marshal(body)
	return string(raw)
}

func facadeWithEngine(t *testing.T, engine *fakeEngine) *AgentFacade {
	t.Helper()
	service := newDockerService(serviceDeps{
		transport:       engine,
		mountRoot:       "/srv",
		reservedPorts:   []int{22, 48100, 48101},
		selfContainerID: strings.Repeat("f", 64),
	})
	return &AgentFacade{
		service:       service,
		authorize:     func(context.Context) error { return nil },
		credentials:   newAgentCredentialStore(filepath.Join(t.TempDir(), "agent-service-containers.json")),
		operationRoot: filepath.Join(t.TempDir(), "tasks"),
	}
}

// 只应答读取类请求（inspect 与空日志）；其余请求未录制即报错，用来证明拒绝
// 发生在任何派发之前。
func readOnly(engine *fakeEngine, body string) {
	engine.script = func(call engineCall) (int, string, bool) {
		switch {
		case call.Method == http.MethodGet && strings.HasSuffix(call.Path, "/json"):
			return http.StatusOK, body, true
		case call.Method == http.MethodGet && strings.HasSuffix(call.Path, "/logs"):
			return http.StatusOK, "", true
		}
		return 0, "", false
	}
}

func TestAgentActionsReachContainersOutsideAgentTemplates(t *testing.T) {
	for name, labels := range map[string]map[string]string{
		"user-installed": nil,
		"panel-created":  {labelManaged: labelTrueValue},
	} {
		t.Run(name, func(t *testing.T) {
			id := hostScopeID
			engine := newFakeEngine(func(call engineCall) (int, string, bool) {
				switch {
				case call.Method == http.MethodGet && call.Path == "/containers/"+id+"/json":
					return http.StatusOK, hostScopeInspect(id, labels, nil), true
				case call.Method == http.MethodPost && call.Path == "/containers/"+id+"/restart":
					return http.StatusNoContent, "", true
				}
				return 0, "", false
			})
			facade := facadeWithEngine(t, engine)
			container, err := facade.Action(context.Background(), id, "restart")
			if err != nil || container.Name != "frp" {
				t.Fatalf("非 Agent 模板容器应可重启：name=%q err=%v", container.Name, err)
			}
			dispatched := false
			for _, call := range engine.Requests() {
				if call.Method == http.MethodPost && call.Path == "/containers/"+id+"/restart" {
					dispatched = true
				}
			}
			if !dispatched {
				t.Fatal("重启未派发到 Engine")
			}
		})
	}
}

func TestAgentRefusesPanelOwnedContainersBeforeDispatch(t *testing.T) {
	selfID := strings.Repeat("f", 64)
	managed := func(extra map[string]string) map[string]string {
		return mergeLabels(map[string]string{labelManaged: labelTrueValue}, extra)
	}
	cases := map[string]struct {
		id           string
		labels       map[string]string
		message      string
		logsReadable bool
	}{
		"panel-self":    {id: selfID, labels: nil, message: "面板自身容器"},
		"execution":     {id: hostScopeID, labels: map[string]string{"elysian.agent.execution": "true"}, message: "Agent 执行环境容器"},
		"website-probe": {id: hostScopeID, labels: managed(map[string]string{"elysian.website.probe": "true"}), message: "面板内部容器"},
		"website-build": {id: hostScopeID, labels: managed(map[string]string{"elysian.website.build": "true"}), message: "面板内部容器"},
		"app-build":     {id: hostScopeID, labels: map[string]string{"elysian.build.task": "task-1"}, message: "面板内部容器"},
		"unknown-panel": {id: hostScopeID, labels: map[string]string{"elysian.future.label": "x"}, message: "面板内部容器"},
		// 数据库与网站容器不归通用入口变更，但日志可读（排查面板纳管的服务）。
		"database": {id: hostScopeID, labels: managed(map[string]string{"elysian.database": "true"}), message: "所属领域", logsReadable: true},
		"website":  {id: hostScopeID, labels: managed(map[string]string{"elysian.website": "true"}), message: "所属领域", logsReadable: true},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			body := hostScopeInspect(tc.id, tc.labels, nil)
			engine := newFakeEngine(nil)
			readOnly(engine, body)
			facade := facadeWithEngine(t, engine)
			input := ContainerExecInput{ID: tc.id, RequestID: strings.Repeat("a", 64), Argv: []string{"true"}}
			mutations := []struct {
				tool string
				err  error
			}{
				{"power", firstError(facade.Action(context.Background(), tc.id, "stop"))},
				{"remove", facade.Remove(context.Background(), tc.id)},
				{"exec", firstError(facade.SubmitExec(context.Background(), input))},
			}
			for _, item := range mutations {
				if item.err == nil || !strings.Contains(item.err.Error(), tc.message) {
					t.Fatalf("%s 应拒绝 %s：%v", item.tool, name, item.err)
				}
			}
			if err := firstError(facade.Logs(context.Background(), tc.id, 10)); (err == nil) != tc.logsReadable {
				t.Fatalf("logs 对 %s 的可读性应为 %v：%v", name, tc.logsReadable, err)
			}
			for _, call := range engine.Requests() {
				if call.Method != http.MethodGet {
					t.Fatalf("拒绝前派发了变更：%+v", call)
				}
			}
		})
	}
}

func mergeLabels(base, extra map[string]string) map[string]string {
	for key, value := range extra {
		base[key] = value
	}
	return base
}

func TestAgentLogsReadContainersOutsidePanelManagement(t *testing.T) {
	id := hostScopeID
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		switch {
		case call.Method == http.MethodGet && strings.HasSuffix(call.Path, "/json"):
			return http.StatusOK, hostScopeInspect(id, map[string]string{"com.docker.compose.project": "frp"}, nil), true
		case call.Method == http.MethodGet && strings.HasSuffix(call.Path, "/logs"):
			return http.StatusOK, string(frame(1, "2026-11-20T08:00:00.000000000Z login to server success\n")), true
		}
		return 0, "", false
	})
	result, err := facadeWithEngine(t, engine).Logs(context.Background(), id, 50)
	if err != nil {
		t.Fatalf("用户自装容器的日志应可读取：%v", err)
	}
	lines, _ := result["lines"].([]agentLogFrame)
	if len(lines) != 1 || lines[0].Line != "login to server success" {
		t.Fatalf("日志行不符：%+v", lines)
	}
}

func TestAgentExecRunsInContainersOutsideAgentTemplates(t *testing.T) {
	id, execID := hostScopeID, strings.Repeat("e", 64)
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		switch {
		case call.Method == http.MethodGet && call.Path == "/containers/"+id+"/json":
			return http.StatusOK, hostScopeInspect(id, nil, func(body map[string]any) {
				body["HostConfig"] = map[string]any{"NetworkMode": "host", "Privileged": true, "CapAdd": []string{"NET_ADMIN"}}
			}), true
		case call.Method == http.MethodPost && call.Path == "/containers/"+id+"/exec":
			return http.StatusCreated, `{"Id":"` + execID + `"}`, true
		case call.Method == http.MethodGet && call.Path == "/exec/"+execID+"/json":
			return http.StatusOK, fmt.Sprintf(`{"Running":false,"ExitCode":0,"ContainerID":%q}`, id), true
		}
		return 0, "", false
	})
	engine.streamFn = func(_ context.Context, _ engineCall, consume func([]byte)) (seam.EngineResponse, error) {
		consume(execFrame(1, "frpc running\n"))
		return seam.EngineResponse{Status: http.StatusOK}, nil
	}
	facade := facadeWithEngine(t, engine)
	task, err := facade.SubmitExec(context.Background(), ContainerExecInput{ID: id, RequestID: strings.Repeat("a", 64), Argv: []string{"echo", "hi"}})
	if err != nil {
		t.Fatalf("用户自装容器应可执行命令：%v", err)
	}
	got := awaitContainerTask(t, facade, task.ID)
	var result struct {
		ExitCode  int      `json:"exitCode"`
		Stdout    string   `json:"stdout"`
		Ownership string   `json:"ownership"`
		Exposure  []string `json:"exposure"`
	}
	if got.State != "succeeded" || json.Unmarshal(got.Result, &result) != nil {
		t.Fatalf("任务未成功：%+v", got)
	}
	if result.ExitCode != 0 || result.Stdout != "frpc running\n" || result.Ownership != "user" {
		t.Fatalf("回执不符：%+v", result)
	}
	if fmt.Sprint(result.Exposure) != "[privileged host-network cap-add root-user]" {
		t.Fatalf("风险标注不符：%v", result.Exposure)
	}
}

func TestAgentRemoveKeepsStoppedOnlyAndNeverRemovesVolumes(t *testing.T) {
	id := hostScopeID
	stopped := hostScopeInspect(id, nil, func(body map[string]any) {
		body["State"] = map[string]any{"Status": "exited", "Running": false, "ExitCode": 137}
	})
	running := hostScopeInspect(id, nil, nil)
	engine := newFakeEngine(nil)
	readOnly(engine, running)
	facade := facadeWithEngine(t, engine)
	if err := facade.Remove(context.Background(), id); err == nil {
		t.Fatal("运行中的用户容器不应被直接删除")
	}
	for _, call := range engine.Requests() {
		if call.Method == http.MethodDelete {
			t.Fatalf("运行中的容器被派发了删除：%+v", call)
		}
	}
	engine.script = func(call engineCall) (int, string, bool) {
		switch {
		case call.Method == http.MethodGet && strings.HasSuffix(call.Path, "/json"):
			return http.StatusOK, stopped, true
		case call.Method == http.MethodDelete && call.Path == "/containers/"+id:
			return http.StatusNoContent, "", true
		}
		return 0, "", false
	}
	if err := facade.Remove(context.Background(), id); err != nil {
		t.Fatalf("停止态的用户容器应可删除：%v", err)
	}
	for _, call := range engine.Requests() {
		if call.Method == http.MethodDelete && (call.Query.Get("force") != "" || call.Query.Get("v") != "") {
			t.Fatalf("删除不得带 force 或删卷参数：%v", call.Query)
		}
	}
}

// 冻结在旧版本的入口保持原范围：升级前已接受的 Run 不获得非面板容器。
func TestFrozenScopesKeepTemplateOnlyTargets(t *testing.T) {
	id := hostScopeID
	engine := newFakeEngine(nil)
	readOnly(engine, hostScopeInspect(id, nil, nil))
	facade := facadeWithEngine(t, engine)
	input := ContainerExecInput{ID: id, RequestID: strings.Repeat("a", 64), Argv: []string{"true"}}
	frozen := map[string]error{
		"power-v1":         firstError(facade.ManagedAction(context.Background(), id, "stop")),
		"power-retired-v1": firstError(facade.LegacyAction(context.Background(), id, "stop")),
		"remove-v3":        facade.ManagedRemove(context.Background(), id),
		"remove-v1":        facade.LegacyRemove(context.Background(), id),
		"exec-v3":          firstError(facade.ManagedSubmitExec(context.Background(), input)),
		"logs-v1":          firstError(facade.LegacyLogs(context.Background(), id, 10)),
	}
	for entry, err := range frozen {
		if err == nil {
			t.Fatalf("%s 不应放开非面板容器：%v", entry, err)
		}
	}
	for _, call := range engine.Requests() {
		if call.Method != http.MethodGet {
			t.Fatalf("旧版本入口派发了变更：%+v", call)
		}
	}
}

func TestDescribeContainerReportsNameOwnershipAndExposure(t *testing.T) {
	id := hostScopeID
	for name, tc := range map[string]struct {
		labels    map[string]string
		configure func(body map[string]any)
		ownership string
		exposure  string
		notes     string
	}{
		"user":  {labels: nil, ownership: "user", exposure: "[root-user]", notes: "[非面板创建的用户容器 容器内以 root 运行]"},
		"panel": {labels: map[string]string{labelManaged: labelTrueValue}, ownership: "panel", exposure: "[root-user]", notes: "[面板创建的容器 容器内以 root 运行]"},
		"exposed": {labels: nil, configure: func(body map[string]any) {
			body["HostConfig"] = map[string]any{"NetworkMode": "host", "Privileged": true}
			body["Mounts"] = []any{map[string]any{"Type": "bind", "Source": "/var/run/docker.sock", "Destination": "/var/run/docker.sock"}}
		}, ownership: "user", exposure: "[privileged host-network docker-socket root-user]",
			notes: "[非面板创建的用户容器 特权 共享宿主网络命名空间 挂载 Docker socket 容器内以 root 运行]"},
	} {
		t.Run(name, func(t *testing.T) {
			engine := newFakeEngine(nil)
			readOnly(engine, hostScopeInspect(id, tc.labels, tc.configure))
			got, err := facadeWithEngine(t, engine).DescribeContainer(context.Background(), id)
			if err != nil || got.Name != "frp" || got.Ownership != tc.ownership {
				t.Fatalf("描述不符：%+v %v", got, err)
			}
			if fmt.Sprint(got.Exposure) != tc.exposure || fmt.Sprint(got.Notes) != tc.notes {
				t.Fatalf("标注不符：%v %v", got.Exposure, got.Notes)
			}
		})
	}
}

func TestDescribeContainerRequiresExactIdentity(t *testing.T) {
	facade := facadeWithEngine(t, newFakeEngine(func(engineCall) (int, string, bool) { return 0, "", false }))
	if _, err := facade.DescribeContainer(context.Background(), "frp"); err == nil {
		t.Fatal("按名称寻址不应被接受")
	}
	if _, err := facade.DescribeContainer(context.Background(), hostScopeID); err == nil {
		t.Fatal("Engine 无应答时不应编造描述")
	}
}

func firstError(_ any, err error) error { return err }
