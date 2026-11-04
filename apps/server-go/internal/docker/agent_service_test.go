package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"elysian/server/internal/contract"
)

var (
	agentServiceImage  = "docker.io/library/mysql:8.4@sha256:" + strings.Repeat("a", 64)
	agentServiceDigest = strings.Repeat("a", 64)
)

// newServiceFacade 构造带凭据登记与端口开放桩的 AgentFacade。
func newServiceFacade(t *testing.T, script engineScript, opener *recordingPortOpener) *AgentFacade {
	t.Helper()
	return newServiceFacadeWithStore(t, script, filepath.Join(t.TempDir(), "agent-service-containers.json"), opener)
}

// newServiceFacadeWithStore 复用既有登记文件路径构造（失败重试共享凭据登记）。
func newServiceFacadeWithStore(t *testing.T, script engineScript, path string, opener *recordingPortOpener) *AgentFacade {
	t.Helper()
	service := newDockerService(serviceDeps{
		transport:       newFakeEngine(script),
		mountRoot:       "/srv",
		reservedPorts:   []int{22, 48100, 48101},
		selfContainerID: strings.Repeat("f", 64),
	})
	return &AgentFacade{
		service:     service,
		authorize:   func(context.Context) error { return nil },
		credentials: newAgentCredentialStore(path),
		portOpener:  opener,
	}
}

type recordingPortOpener struct {
	calls []int
}

func (p *recordingPortOpener) EnsurePortRule(_ context.Context, port int, _ string) contract.FirewallPortSync {
	p.calls = append(p.calls, port)
	return contract.FirewallPortSync{State: contract.FirewallPortSyncOpened, Port: port}
}

// serviceContainerInspectBody 成功创建并启动后的容器 inspect 应答；
// 字段集满足 mapContainer（含顶层 Image 与 Mounts）。
func serviceContainerInspectBody() string {
	body := map[string]any{
		"Id": strings.Repeat("c", 64), "Name": "/mysql-main", "Created": "2026-11-04T00:00:00Z",
		"Image": agentServiceImage,
		"State": map[string]any{"Status": "running"},
		"Config": map[string]any{"Image": agentServiceImage, "Labels": map[string]string{
			labelManaged: labelTrueValue, "elysian.agent.template": agentServiceTemplate,
		}},
		"HostConfig": map[string]any{"NetworkMode": "elysian-agent-net", "ReadonlyRootfs": false},
		"Mounts":     []any{map[string]any{"Type": "volume", "Name": "elysian-agent-v1", "Destination": "/var/lib/mysql"}},
	}
	raw, _ := json.Marshal(body)
	return string(raw)
}

// scriptServiceCreate 覆盖一次 any-host 成功创建所需的全部 Engine 应答；
// 创建后的容器 inspect（start 回读与回执）统一走 serviceContainerInspectBody。
func scriptServiceCreate(call engineCall) (int, string, bool) {
	containerID := strings.Repeat("c", 64)
	switch {
	case call.Method == http.MethodGet && call.Path == "/containers/mysql-main/json":
		return http.StatusNotFound, "", true
	case call.Method == http.MethodGet && call.Path == "/containers/"+containerID+"/json":
		return http.StatusOK, serviceContainerInspectBody(), true
	case call.Method == http.MethodGet && call.Path == "/images/"+url.PathEscape(agentServiceImage)+"/json":
		return http.StatusOK, fmt.Sprintf(`{"Id":"sha256:%s","Config":{}}`, agentServiceDigest), true
	case call.Method == http.MethodGet && call.Path == "/networks/elysian-agent-net":
		return http.StatusNotFound, "", true
	case call.Method == http.MethodPost && call.Path == "/networks/create":
		return http.StatusCreated, `{"Id":"net-1","Warning":""}`, true
	case call.Method == http.MethodPost && call.Path == "/volumes/create":
		return http.StatusCreated, `{"Name":"elysian-agent-v1"}`, true
	case call.Method == http.MethodPost && call.Path == "/containers/create":
		return http.StatusCreated, fmt.Sprintf(`{"Id":"%s","Warnings":[]}`, containerID), true
	case call.Method == http.MethodPost && call.Path == "/containers/"+containerID+"/start":
		return http.StatusNoContent, "", true
	default:
		return 0, "", false
	}
}

func TestCreateServiceAnyHostCreatesVolumeNetworkCredentialsAndOpensFirewall(t *testing.T) {
	opener := &recordingPortOpener{}
	facade := newServiceFacade(t, scriptServiceCreate, opener)
	result, err := facade.CreateService(context.Background(), AgentServiceCreateInput{
		Name: "mysql-main", Image: agentServiceImage, RequestID: "req-1",
		ResourceTier: "medium", NetworkScope: "any-host", Port: 3306, HostPort: 13306,
		Credentials: []string{"MYSQL_ROOT_PASSWORD"}, Volumes: []string{"/var/lib/mysql"},
	})
	if err != nil {
		t.Fatal(err)
	}
	container, _ := result["container"].(ContainerSummary)
	if container.ID != strings.Repeat("c", 64) {
		t.Fatalf("回执容器 ID 不符：%+v", container)
	}
	if names, _ := result["credentials"].([]string); len(names) != 1 || names[0] != "MYSQL_ROOT_PASSWORD" {
		t.Fatalf("回执只应报凭据变量名：%v", result["credentials"])
	}
	if result["networkScope"] != "any-host" || result["hostPort"] != 13306 {
		t.Fatalf("回执档位不符：%v %v", result["networkScope"], result["hostPort"])
	}
	record, err := facade.credentials.find("mysql-main")
	if err != nil || record == nil || len(record.Credentials["MYSQL_ROOT_PASSWORD"]) != 48 {
		t.Fatalf("凭据登记缺失：%+v %v", record, err)
	}
	if len(opener.calls) != 1 || opener.calls[0] != 13306 {
		t.Fatalf("any-host 应联动防火墙开口：%v", opener.calls)
	}
}

func TestCreateServiceRejectsBadInputs(t *testing.T) {
	facade := newServiceFacade(t, func(engineCall) (int, string, bool) { return 0, "", false }, &recordingPortOpener{})
	base := AgentServiceCreateInput{Name: "x", Image: agentServiceImage, RequestID: "req-1",
		ResourceTier: "medium", NetworkScope: "container-net"}
	cases := map[string]func(*AgentServiceCreateInput){
		"镜像必须摘要":          func(in *AgentServiceCreateInput) { in.Image = "mysql:8.4" },
		"资源档枚举":           func(in *AgentServiceCreateInput) { in.ResourceTier = "huge" },
		"网络档枚举":           func(in *AgentServiceCreateInput) { in.NetworkScope = "public" },
		"宿主端口保留":          func(in *AgentServiceCreateInput) { in.NetworkScope = "any-host"; in.Port = 3306; in.HostPort = 48100 },
		"any-host 缺端口":    func(in *AgentServiceCreateInput) { in.NetworkScope = "any-host"; in.Port = 3306 },
		"localhost 缺容器端口": func(in *AgentServiceCreateInput) { in.NetworkScope = "localhost" },
		"凭据变量名格式":         func(in *AgentServiceCreateInput) { in.Credentials = []string{"mysql-password"} },
		"凭据变量去重上限": func(in *AgentServiceCreateInput) {
			in.Credentials = []string{"A_1", "A_2", "A_3", "A_4", "A_5", "A_6", "A_7", "A_8", "A_9"}
		},
		"env 格式": func(in *AgentServiceCreateInput) { in.Env = []string{"TZ"} },
		"卷绝对路径":  func(in *AgentServiceCreateInput) { in.Volumes = []string{"var/lib/mysql"} },
		"卷数量上限":  func(in *AgentServiceCreateInput) { in.Volumes = []string{"/a", "/b", "/c"} },
	}
	for name, mutate := range cases {
		input := base
		mutate(&input)
		if _, err := facade.CreateService(context.Background(), input); err == nil {
			t.Fatalf("%s：应被拒绝", name)
		}
	}
}
